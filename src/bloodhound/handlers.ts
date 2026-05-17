/**
 * Bloodhound GameHandlers — plugs the LLM agent into the lupa engine.
 *
 * One AnthropicClient is shared across all 14 seats. Per-turn work is:
 *   1. Read this seat's role + private view from the lupa state.
 *   2. Run flat retar (viewer perspective).
 *   3. Build system + user prompts.
 *   4. Call the LLM with the legal tool subset; tool-use loop handles
 *      retar follow-ups internally.
 *   5. Decode the final tool calls into a lupa-shaped action.
 *
 * Speech (discussion utterances) is emitted via the `BloodhoundEvent`
 * extension type passed through lupa's `E` parameter; lupa's format.ts
 * has a `speech` case to render it in the Howl log.
 */

import type {
  GameHandlers, PhaseContext, VoteContext, PreVoteResult,
} from '../lupa/handlers.ts'
import type {
  GameState, GameEvent, NightAction, DayClaim, LupaConfig, PlayerState,
} from '../lupa/types.ts'
import type { SystemRole } from '../types/index.ts'
import { buildPlayerView } from '../lupa/player-view.ts'
import { formatHowl } from '../lupa/format.ts'
import { Rng } from '../lupa/random.ts'
import { buildAssumptions } from '../fenrir/src/retar-bridge.ts'

import { AnthropicClient, type RunTurnOptions } from './anthropic-client.ts'
import { legalActions } from './legal-actions.ts'
import { getPersona } from './personas.ts'
import { buildPrompts, type PrivateInfo } from './prompt-builder.ts'
import { precomputeViewerRetar, precomputePublicRetar } from './retar-precompute.ts'
import { injectViewerClaims } from './inject-viewer-claims.ts'
import { precomputeSkoll, type SkollResult } from './skoll-precompute.ts'
import { precomputeHati, type HatiResult } from './hati-precompute.ts'
import { decodeToolCalls, type DecodeResult, type FinalAction } from './action-decoder.ts'
import { rewriteSetupLine, stripPrivateComments } from './rename-seats.ts'
import { allTools } from './tools.ts'
import type {
  BloodhoundEvent, BloodhoundPhase, SpeechEvent, ToolCall,
} from './types.ts'

const DEFAULT_MAX_DISCUSSION_ROUNDS = 3

export type LLMExchange = {
  seat: number
  phase: BloodhoundPhase
  /** Discussion round (1-indexed) when phase === 'discussion'; otherwise undefined. */
  discussionRound?: number
  system: string
  user: string
  thinking: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  /** Per-iteration trace (thinking + tool names) of the auxiliary tool-use loop. */
  iterations?: Array<{ thinking: string; toolNames: string[] }>
  /** Counts of auxiliary tool invocations during the loop. */
  auxiliaryCalls?: { retar: number; skoll: number; hati: number; craft_deception: number }
}

/** Replay record for one historical LLM call. */
export type ReplayRecord = {
  thinking: string
  toolCalls: ToolCall[]
}

export type BloodhoundHandlersOptions = {
  client: AnthropicClient
  config: { roles: LupaConfig['roles']; seed?: number }
  maxDiscussionRounds?: number
  onLLMExchange?: (info: LLMExchange) => void
  onSpeechEvent?: (event: SpeechEvent) => void
  /** Forwarded as the engine's onEvent? — fires for every GameEvent | BloodhoundEvent. */
  onEvent?: (event: GameEvent | BloodhoundEvent) => void
  /**
   * Replay map keyed by `seat{NN}-{phase}-{turn}` (matches logger filename
   * stem). When a key matches, the LLM is NOT called and the historical
   * toolCalls are replayed verbatim. Used for resume.
   */
  replayMap?: Map<string, ReplayRecord>
  /**
   * Called right after the prompt is built and before the LLM is invoked.
   * Useful for debugging the prompt contents without spending API budget.
   * If the callback throws or calls process.exit, the LLM call is skipped.
   */
  onPromptBuilt?: (info: {
    seat: number
    phase: BloodhoundPhase
    discussionRound?: number
    system: string
    user: string
  }) => void
  /**
   * When true, every callLLM builds the prompt (firing onPromptBuilt) but
   * skips the actual API call and substitutes a minimal valid action so
   * the engine can advance. Lets us walk through seats in dry-run mode.
   */
  dryRun?: boolean
  /**
   * Fires once during onSetup with the engine state, so the caller can
   * capture seat→name mapping for downstream rendering (live howl stream,
   * cost summary, etc.).
   */
  onState?: (state: GameState) => void
}

export function createBloodhoundHandlers(
  opts: BloodhoundHandlersOptions,
): GameHandlers<BloodhoundEvent> {
  const lupaConfig = opts.config as LupaConfig
  const maxRounds = opts.maxDiscussionRounds ?? DEFAULT_MAX_DISCUSSION_ROUNDS

  // Deterministic RNG for handler-side random choices (Night 0 random actions).
  // Seeded from the game seed so the same seed reproduces identical handler
  // randomness, which makes replay deterministic.
  const rng = new Rng(opts.config.seed)

  // Per-(seat, phase) turn counter, mirroring the logger's filename scheme.
  // Used to build replay keys.
  const seatPhaseCounters = new Map<string, number>()
  function nextTurn(seat: number, phase: BloodhoundPhase): number {
    const key = `${seat}-${phase}`
    const turn = (seatPhaseCounters.get(key) ?? 0) + 1
    seatPhaseCounters.set(key, turn)
    return turn
  }
  function replayKey(seat: number, phase: BloodhoundPhase, turn: number): string {
    return `seat${String(seat).padStart(2, '0')}-${phase}-${String(turn).padStart(2, '0')}`
  }

  // ----- per-seat tracking that lupa doesn't store for us ---------------
  // The lupa engine fills in state.players[seer].divineHistory / guardHistory
  // automatically after our onNight return. medium results are derivable
  // from execution history + state (see deriveMediumHistory).

  function derivePrivateInfo(player: PlayerState, state: GameState): PrivateInfo {
    const view = buildPlayerView(state, player.seat)
    const info: PrivateInfo = {}
    if (view.masonPartner !== null) info.masonPartner = view.masonPartner
    if (view.wolfTeammates !== null && view.wolfTeammates.length > 0) {
      info.fellowWolves = view.wolfTeammates
    }
    if (view.knownWolves !== null && view.knownWolves.length > 0) {
      info.fanaticKnownWolves = view.knownWolves
    }
    if (view.knownHamster !== null) info.immoralistKnownFox = view.knownHamster

    if (player.role === 'seer' && player.divineHistory.size > 0) {
      info.divineHistory = [...player.divineHistory.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([day, r]) => ({
          day,
          target: r.target,
          result: r.result === 'wolf' ? 'wolf' : 'human',
        }))
    }
    if (player.role === 'bodyguard' && player.guardHistory.size > 0) {
      info.guardHistory = [...player.guardHistory.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([day, target]) => ({ day, target }))
    }
    if (player.role === 'medium') {
      const history = deriveMediumHistory(player, state)
      if (history.length > 0) info.mediumHistory = history
    }
    return info
  }

  function deriveMediumHistory(
    _medium: PlayerState, state: GameState,
  ): Array<{ day: number; result: 'human' | 'wolf' }> {
    const out: Array<{ day: number; result: 'human' | 'wolf' }> = []
    for (const [day, seat] of state.executionHistory.entries()) {
      const executed = state.players.find(p => p.seat === seat)
      if (!executed) continue
      const isWolf = executed.role === 'werewolf'
      out.push({ day, result: isWolf ? 'wolf' : 'human' })
    }
    return out.sort((a, b) => a.day - b.day)
  }

  // ----- LLM call helper -----------------------------------------------

  async function callLLM(
    seat: number,
    phase: BloodhoundPhase,
    ctx: PhaseContext<BloodhoundEvent>,
    extra: {
      voteCandidates?: readonly number[] | null
      discussionRound?: number
    } = {},
  ): Promise<DecodeResult> {
    // Determine this call's replay key BEFORE doing any expensive setup
    // (retar, prompt building). If a replay record exists, skip the LLM
    // entirely and decode the historical toolCalls.
    const turn = nextTurn(seat, phase)
    const key = replayKey(seat, phase, turn)
    const replay = opts.replayMap?.get(key)
    if (replay) {
      return decodeToolCalls(replay.toolCalls, phase)
    }

    const state = ctx.state as GameState
    const player = state.players.find(p => p.seat === seat)
    if (!player) throw new Error(`No player at seat ${seat}`)
    const role = player.role
    const persona = getPersona(seat)
    const view = buildPlayerView(state, seat)

    const allSeats = state.players.map(p => p.seat)
    const legal = legalActions({
      phase, role, selfSeat: seat,
      alivePlayers: ctx.alivePlayers, allSeats,
      voteCandidates: extra.voteCandidates ?? null,
      fellowWolves: view.wolfTeammates ?? undefined,
    })

    // Viewer-private knowledge feeds retar via two channels:
    //  1. CO + result events appended to the event list (for village roles
    //     where the howl pipeline already knows how to interpret them —
    //     this is the only way to express "seat-X is human" from a ○).
    //  2. assumption pairs (for wolf-team / hamster-team facts where no
    //     public CO exists, e.g. fellow wolves, known werehamster).
    // Both channels are applied; refix reconciles any overlap (mason CO
    // and mason partner assumption produce the same constraint).
    const eventsWithSelfCo = injectViewerClaims(
      ctx.events as readonly GameEvent[], player, state,
    )
    const baseAssumptions = buildAssumptions(state, player)

    // Public retar: what every seat can derive from the bare event log,
    // no viewer-private knowledge applied. Embedded alongside the viewer
    // retar so the LLM can see "what others see" vs "what I privately know".
    const retarPublic = precomputePublicRetar({
      events: ctx.events as readonly GameEvent[],
      state, config: lupaConfig,
    })

    const retar = precomputeViewerRetar({
      events: eventsWithSelfCo,
      state, config: lupaConfig,
      viewerSeat: seat, viewerRole: role,
      extraAssumptions: baseAssumptions,
    })

    // Skoll / Hati piggy-back on the same vs/setup/Possibilities. Both are
    // null when the Howl log isn't cleanly parseable yet (e.g. early-game
    // edge cases the howl parser stumbles on); the prompt-builder renders
    // nothing in that case.
    let skoll: SkollResult | null = null
    let hati: HatiResult | null = null
    if (retar.vs && retar.setup && retar.possibilitiesBitmask) {
      try {
        skoll = precomputeSkoll({
          possibilities: retar.possibilitiesBitmask,
          vs: retar.vs, setup: retar.setup,
        })
      } catch { skoll = null }
      try {
        hati = precomputeHati({
          possibilities: retar.possibilitiesBitmask,
          vs: retar.vs, setup: retar.setup,
        })
      } catch { hati = null }
    }

    const howlText = stripPrivateComments(
      rewriteSetupLine(formatHowl(ctx.events, state, lupaConfig)),
    )

    const { system, user } = buildPrompts({
      phase, role, selfSeat: seat, persona, howlText,
      publicVs: retarPublic.vs,
      retarPublic, retar, skoll, hati, legal,
      privateInfo: derivePrivateInfo(player, state),
      discussionRound: extra.discussionRound,
      maxDiscussionRounds: maxRounds,
      voteCandidates: extra.voteCandidates ?? null,
    })

    opts.onPromptBuilt?.({
      seat, phase, discussionRound: extra.discussionRound, system, user,
    })

    // Dry-run: skip the API call entirely and synthesise a minimal action
    // so the engine advances to the next seat / phase. Used by play.ts to
    // inspect prompt contents without spending API budget.
    if (opts.dryRun) {
      return {
        retarQueries: [],
        finalAction: dryRunFinalAction(phase, legal),
        invalid: [],
      }
    }

    const tools = legal.toolNames.map(name => allTools[name])

    // Aux tool runners: merge base private-knowledge assumptions with whatever
    // the LLM passed in. LLM-supplied entries win on key conflict so the LLM
    // can ask "what if seat-X is wolf?" even when base says otherwise.
    const mergedAssumptions = (extra: Map<number, SystemRole>): Map<number, SystemRole> => {
      const out = new Map(baseAssumptions)
      for (const [s, r] of extra) out.set(s, r)
      return out
    }

    const runOptions: RunTurnOptions = {
      retarRunner: (assumptions) => precomputeViewerRetar({
        events: eventsWithSelfCo,
        state, config: lupaConfig,
        viewerSeat: seat, viewerRole: role,
        extraAssumptions: mergedAssumptions(assumptions),
      }),
      skollRunner: (assumptions) => {
        const r = precomputeViewerRetar({
          events: eventsWithSelfCo,
          state, config: lupaConfig,
          viewerSeat: seat, viewerRole: role,
          extraAssumptions: mergedAssumptions(assumptions),
        })
        if (!r.vs || !r.setup || !r.possibilitiesBitmask) return null
        return precomputeSkoll({
          possibilities: r.possibilitiesBitmask,
          vs: r.vs, setup: r.setup,
        })
      },
      hatiRunner: (assumptions) => {
        const r = precomputeViewerRetar({
          events: eventsWithSelfCo,
          state, config: lupaConfig,
          viewerSeat: seat, viewerRole: role,
          extraAssumptions: mergedAssumptions(assumptions),
        })
        if (!r.vs || !r.setup || !r.possibilitiesBitmask) return null
        return precomputeHati({
          possibilities: r.possibilitiesBitmask,
          vs: r.vs, setup: r.setup,
        })
      },
      craftDeceptionRunner: (input) => opts.client.craftDeception(input, persona),
    }

    const result = await opts.client.runTurn(
      { system, user, tools, toolChoice: 'any' },
      runOptions,
    )

    opts.onLLMExchange?.({
      seat, phase,
      discussionRound: extra.discussionRound,
      system, user,
      thinking: result.thinking,
      toolCalls: result.toolCalls,
      usage: result.usage,
      iterations: result.iterations,
      auxiliaryCalls: result.auxiliaryCalls,
    })

    return decodeToolCalls(result.toolCalls, phase)
  }

  // ----- GameHandlers ---------------------------------------------------

  return {
    onSetup(_roles, state) {
      // Standardise display names to "seat-N" for the LLM-visible layer:
      // - retar / skoll / hati and the prompt all use "seat-N" uniformly
      // - tool calls take seat-number integers (target_seat: 7) so seat-N
      //   is the most direct surface form
      // Lupa's nameStyle:'seat' actually produces "<role-abbrev><seat>"
      // (e.g. "占1") which would leak every role, so we still overwrite —
      // just to seat-N instead of persona names.
      //
      // Character names are surfaced to the master ONLY at the log
      // boundary (play.ts substitutes seat-N → name in stdout/stderr).
      for (const player of state.players) {
        player.name = `seat-${player.seat}`
      }
      opts.onState?.(state)
    },

    onEvent: opts.onEvent,

    async onNight(ctx) {
      const map = new Map<number, NightAction>()
      const state = ctx.state as GameState

      // Day 0 (initial night, before the first victim): no information is
      // available, so any LLM reasoning is pure waste. Pick random targets
      // using the seeded RNG so the choice is deterministic per seed.
      if (ctx.day === 0) {
        for (const seat of ctx.alivePlayers) {
          const player = state.players.find(p => p.seat === seat)!
          const action = randomNightAction(seat, player.role, state, ctx.alivePlayers, rng)
          if (action) map.set(seat, action)
        }
        return map
      }

      for (const seat of ctx.alivePlayers) {
        const player = state.players.find(p => p.seat === seat)!
        let phase: BloodhoundPhase
        if (player.role === 'seer') phase = 'night_seer'
        else if (player.role === 'bodyguard') phase = 'night_bodyguard'
        else if (player.role === 'werewolf') phase = 'night_wolf'
        else continue

        const decoded = await callLLM(seat, phase, ctx)
        if (decoded.finalAction?.kind === 'night') {
          map.set(seat, decoded.finalAction.action)
        } else {
          map.set(seat, { type: 'none' })
        }
      }
      return map
    },

    onDayClaims(_ctx) {
      // No-op: Bloodhound consolidates CO into the discussion phase so that
      // CO + accompanying utterance go through onPreVote together (CO via
      // additionalClaims, utterance via events). This keeps the Howl log in
      // chronological order and makes both visible to later seats.
      return new Map<number, DayClaim>()
    },

    async onPreVote(ctx): Promise<PreVoteResult<BloodhoundEvent>> {
      // β + pass + II discussion mini-loop.
      // Both utterances (speech events) and CO/reports (DayClaim) collected
      // here are forwarded to the engine: speech via `events`, claims via
      // `additionalClaims`. A seat may only CO once per game; later CO calls
      // by the same seat are ignored.
      const events: BloodhoundEvent[] = []
      const additionalClaims = new Map<number, DayClaim>()
      let round = 1
      while (round <= maxRounds) {
        let allPassed = true
        for (const seat of ctx.alivePlayers) {
          // Build a temporary ctx that includes our in-progress events so
          // subsequent seats see prior utterances and CO within this round.
          // additionalClaims are still pending engine commit (the engine
          // only applies them after onPreVote returns); synthesize the
          // matching claim events here so retar/skoll/hati downstream see
          // the CO during the same-day discussion rather than only on the
          // next day. Without this, Day-1 round-2+ prompts show "No CO yet."
          // while every seat has actually been told who COed via speech.
          const synthClaimEvents = synthesizeClaimEvents(additionalClaims)
          const localCtx: PhaseContext<BloodhoundEvent> = {
            ...ctx,
            events: [...ctx.events, ...synthClaimEvents, ...events],
          }
          const decoded = await callLLM(seat, 'discussion', localCtx, { discussionRound: round })
          const action = decoded.finalAction
          if (action?.kind !== 'discussion') {
            // Unexpected; treat as pass and continue
            continue
          }
          if (action.speech) {
            const ev: SpeechEvent = { type: 'speech', actor: seat, text: action.speech }
            events.push(ev)
            opts.onSpeechEvent?.(ev)
            allPassed = false
          }
          if (action.claim) {
            const merged = mergeClaim(additionalClaims.get(seat), action.claim)
            additionalClaims.set(seat, merged)
            allPassed = false
          }
        }
        if (allPassed) break
        round += 1
      }
      return { events, additionalClaims, continueDiscussion: false }
    },

    async onVote(ctx: VoteContext<BloodhoundEvent>) {
      const map = new Map<number, number>()
      for (const seat of ctx.alivePlayers) {
        const decoded = await callLLM(seat, ctx.revoteRound > 0 ? 'revote' : 'vote', ctx, {
          voteCandidates: ctx.candidates,
        })
        if (decoded.finalAction?.kind === 'vote') {
          map.set(seat, decoded.finalAction.target)
        } else {
          // Fallback: vote for first legal candidate other than self
          const candidates = ctx.candidates ?? ctx.alivePlayers
          const fallback = candidates.find(s => s !== seat)
          if (fallback !== undefined) map.set(seat, fallback)
        }
      }
      return map
    },
  }
}

/**
 * Convert pending DayClaim entries (held in our discussion-loop buffer
 * before the engine has committed them) into the matching GameEvent
 * shapes so retar / skoll / hati / CO-table see the CO information as
 * soon as it happens inside the same day's discussion.
 *
 * Mirrors the engine's `applyClaim` switch in lupa/engine.ts; keep in
 * sync if new claim shapes are introduced.
 */
function synthesizeClaimEvents(claims: ReadonlyMap<number, DayClaim>): GameEvent[] {
  const out: GameEvent[] = []
  for (const [seat, claim] of claims) {
    switch (claim.type) {
      case 'seer_co':
        out.push({ type: 'seer_claim', actor: seat, results: claim.results })
        break
      case 'medium_co':
        out.push({ type: 'medium_claim', actor: seat, pastResults: claim.pastResults })
        break
      case 'bodyguard_co':
        out.push({ type: 'bodyguard_claim', actor: seat, targets: claim.targets })
        break
      case 'mason_co':
        out.push({ type: 'mason_claim', actor: seat, partner: claim.partner })
        break
      case 'nekomata_co':
        out.push({ type: 'nekomata_claim', actor: seat })
        break
      case 'seer_result':
      case 'medium_result':
      case 'forecast':
      case 'none':
        break
    }
  }
  return out
}

// Build a minimal valid finalAction for dry-run mode so the engine advances.
// Discussion → pass; vote → first legal candidate; night → first legal target.
function dryRunFinalAction(
  phase: BloodhoundPhase,
  legal: ReturnType<typeof legalActions>,
): FinalAction | null {
  switch (phase) {
    case 'discussion':
    case 'last_will':
      return { kind: 'discussion', pass: true }
    case 'vote':
    case 'revote': {
      const t = legal.targets.vote?.[0]
      return t === undefined ? null : { kind: 'vote', target: t }
    }
    case 'night_seer': {
      const t = legal.targets.divine?.[0]
      return t === undefined ? null : { kind: 'night', action: { type: 'divine', target: t } }
    }
    case 'night_bodyguard': {
      const t = legal.targets.guard?.[0]
      return t === undefined ? null : { kind: 'night', action: { type: 'guard', target: t } }
    }
    case 'night_wolf': {
      const t = legal.targets.attack?.[0]
      return t === undefined ? null : { kind: 'night', action: { type: 'attack', target: t } }
    }
  }
}

// Pick a uniformly random night action for the given role. Used for Night 0
// when there is no information yet, so any LLM reasoning would be wasted.
// Uses the supplied seeded RNG so the choice is deterministic.
function randomNightAction(
  seat: number,
  role: SystemRole,
  state: GameState,
  alivePlayers: readonly number[],
  rng: Rng,
): NightAction | null {
  const view = buildPlayerView(state, seat)
  const aliveExceptSelf = alivePlayers.filter(s => s !== seat)
  switch (role) {
    case 'seer':
      return { type: 'divine', target: rng.pick(aliveExceptSelf as number[]) }
    case 'bodyguard':
      return { type: 'guard', target: rng.pick(aliveExceptSelf as number[]) }
    case 'werewolf': {
      const allies = new Set([seat, ...(view.wolfTeammates ?? [])])
      const targets = alivePlayers.filter(s => !allies.has(s))
      return { type: 'attack', target: rng.pick(targets as number[]) }
    }
    default:
      return null
  }
}

/**
 * Merge a fresh DayClaim into an existing one from the same seat. The
 * onPreVote loop calls callLLM multiple times per seat (one per round), and
 * the engine accepts a single DayClaim per seat in additionalClaims. Without
 * merging, a seat that COed in round 1 and reported a fresh result in round 2
 * would have round-2 silently dropped. Merge rules:
 *
 * - seer_co + seer_co       → append results (dedupe by day+target)
 * - medium_co + medium_co   → append pastResults
 * - bodyguard_co + bodyguard_co → append targets (dedupe)
 * - mason_co / nekomata_co  → first claim wins (subsequent are no-ops)
 * - role mismatch           → first claim wins (a seat cannot change role)
 */
function mergeClaim(existing: DayClaim | undefined, fresh: DayClaim): DayClaim {
  if (!existing) return fresh

  if (existing.type === 'seer_co' && fresh.type === 'seer_co') {
    const seen = new Set(existing.results.map(r => `${r.day}-${r.target}`))
    const added = fresh.results.filter(r => !seen.has(`${r.day}-${r.target}`))
    return { ...existing, results: [...existing.results, ...added] }
  }
  if (existing.type === 'medium_co' && fresh.type === 'medium_co') {
    const exPast = existing.pastResults ?? []
    const frPast = fresh.pastResults ?? []
    return { ...existing, pastResults: [...exPast, ...frPast] }
  }
  if (existing.type === 'bodyguard_co' && fresh.type === 'bodyguard_co') {
    const seen = new Set(existing.targets)
    const added = fresh.targets.filter(t => !seen.has(t))
    return { ...existing, targets: [...existing.targets, ...added] }
  }
  return existing
}
