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

import { AnthropicClient, type RunTurnOptions } from './anthropic-client.ts'
import { legalActions } from './legal-actions.ts'
import { getPersona } from './personas.ts'
import { buildPrompts, type PrivateInfo } from './prompt-builder.ts'
import { precomputeViewerRetar } from './retar-precompute.ts'
import { decodeToolCalls, type DecodeResult } from './action-decoder.ts'
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
  auxiliaryCalls?: { retar: number; craft_deception: number }
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

    const retar = precomputeViewerRetar({
      events: [...ctx.events] as GameEvent[],
      state, config: lupaConfig,
      viewerSeat: seat, viewerRole: role,
    })

    const howlText = stripPrivateComments(
      rewriteSetupLine(formatHowl(ctx.events, state, lupaConfig)),
    )

    const { system, user } = buildPrompts({
      phase, role, selfSeat: seat, persona, howlText, retar, legal,
      privateInfo: derivePrivateInfo(player, state),
      discussionRound: extra.discussionRound,
      maxDiscussionRounds: maxRounds,
      voteCandidates: extra.voteCandidates ?? null,
    })

    const tools = legal.toolNames.map(name => allTools[name])

    const runOptions: RunTurnOptions = {
      retarRunner: (assumptions) => precomputeViewerRetar({
        events: [...ctx.events] as GameEvent[],
        state, config: lupaConfig,
        viewerSeat: seat, viewerRole: role,
        extraAssumptions: assumptions,
      }),
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
      // Overwrite each player's display name to "seat-N" right at setup.
      // Lupa's nameStyle:'seat' actually produces "<role-abbrev><seat>" (e.g.
      // "占1"), which leaks every role through formatHowl's player list and
      // looks confusingly similar to seat references like "seat-1".
      // By overriding name here, every downstream rendering (formatHowl,
      // events, etc.) is already seat-N from the start.
      for (const player of state.players) {
        player.name = `seat-${player.seat}`
      }
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
          const localCtx: PhaseContext<BloodhoundEvent> = {
            ...ctx,
            events: [...ctx.events, ...events],
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
