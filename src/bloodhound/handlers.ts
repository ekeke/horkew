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
import { buildPlayerView } from '../lupa/player-view.ts'
import { formatHowl } from '../lupa/format.ts'

import { AnthropicClient, type RunTurnOptions } from './anthropic-client.ts'
import { legalActions } from './legal-actions.ts'
import { getPersona } from './personas.ts'
import { buildPrompts, type PrivateInfo } from './prompt-builder.ts'
import { precomputeViewerRetar } from './retar-precompute.ts'
import { decodeToolCalls, type DecodeResult } from './action-decoder.ts'
import { renameSeatNames } from './rename-seats.ts'
import { allTools } from './tools.ts'
import type {
  BloodhoundEvent, BloodhoundPhase, SpeechEvent, ToolCall,
} from './types.ts'

const DEFAULT_MAX_DISCUSSION_ROUNDS = 3

export type LLMExchange = {
  seat: number
  phase: BloodhoundPhase
  system: string
  user: string
  thinking: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number; outputTokens: number }
}

export type BloodhoundHandlersOptions = {
  client: AnthropicClient
  config: { roles: LupaConfig['roles']; seed?: number }
  maxDiscussionRounds?: number
  onLLMExchange?: (info: LLMExchange) => void
  onSpeechEvent?: (event: SpeechEvent) => void
  /** Forwarded as the engine's onEvent? — fires for every GameEvent | BloodhoundEvent. */
  onEvent?: (event: GameEvent | BloodhoundEvent) => void
}

export function createBloodhoundHandlers(
  opts: BloodhoundHandlersOptions,
): GameHandlers<BloodhoundEvent> {
  const lupaConfig = opts.config as LupaConfig
  const maxRounds = opts.maxDiscussionRounds ?? DEFAULT_MAX_DISCUSSION_ROUNDS

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

    const howlText = renameSeatNames(formatHowl(ctx.events, state, lupaConfig), state.players)

    const { system, user } = buildPrompts({
      phase, role, selfSeat: seat, persona, howlText, retar, legal,
      privateInfo: derivePrivateInfo(player, state),
      discussionRound: extra.discussionRound,
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
    }

    const result = await opts.client.runTurn(
      { system, user, tools, toolChoice: 'any' },
      runOptions,
    )

    opts.onLLMExchange?.({
      seat, phase, system, user,
      thinking: result.thinking,
      toolCalls: result.toolCalls,
      usage: result.usage,
    })

    return decodeToolCalls(result.toolCalls, phase)
  }

  // ----- GameHandlers ---------------------------------------------------

  return {
    onSetup(_roles, _state) {
      // No setup state needed beyond what lupa tracks.
    },

    onEvent: opts.onEvent,

    async onNight(ctx) {
      const map = new Map<number, NightAction>()
      const state = ctx.state as GameState
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

    async onDayClaims(ctx) {
      // Day-of-game CO opportunity: we ask each alive seat to optionally
      // emit a CO/report via the same discussion tool set. Unlike onPreVote,
      // this is a one-shot per seat (no round-robin) and the result is
      // mapped to a DayClaim if the LLM emitted one.
      const map = new Map<number, DayClaim>()
      for (const seat of ctx.alivePlayers) {
        const decoded = await callLLM(seat, 'discussion', ctx, { discussionRound: 0 })
        if (decoded.finalAction?.kind === 'discussion' && decoded.finalAction.claim) {
          map.set(seat, decoded.finalAction.claim)
        }
      }
      return map
    },

    async onPreVote(ctx): Promise<PreVoteResult<BloodhoundEvent>> {
      // β + pass + II discussion mini-loop.
      // `events` is the cumulative output we hand back to the engine.
      const events: BloodhoundEvent[] = []
      let round = 1
      while (round <= maxRounds) {
        let allPassed = true
        for (const seat of ctx.alivePlayers) {
          // Build a temporary ctx that includes our in-progress speech events
          // so subsequent seats see prior utterances this round.
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
          // claim from `*_co` / `report_*` tools during pre-vote is not
          // routed into DayClaim here (DayClaim was already collected via
          // onDayClaims). In a future iteration we can let CO during
          // pre-vote append additionalClaims; MVP keeps it simple.
        }
        if (allPassed) break
        round += 1
      }
      return { events, continueDiscussion: false }
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
