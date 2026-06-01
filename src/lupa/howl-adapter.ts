/**
 * Lupa-Howl adapter
 *
 * Howl 解析結果 (spoiler 経由の役職 + 秘匿行動、公開 statement の CO/投票)
 * から lupa engine を駆動するための GameConfig + GameHandlers を生成する。
 *
 * 設計原則:
 * - onNight は `spoilerActions` のみを情報源とする (公開発言から推論しない)
 * - onDayClaims は `vs.statuses[seat]` の claiming/assertions のみを情報源とする
 * - 両者は完全に独立 (真役職が嘘 CO を出すシナリオが書ける)
 */

import type { SystemRole, VillageStatus } from '../types/index.ts'
import type { SpoilerActionRecord } from '../howl/bridge.ts'
import type { GameConfig, GameHandlers } from './handlers.ts'
import type { DayClaim, NightAction, RevoteConfig } from './types.ts'

export type AdapterInput = {
  assumptions: Map<number, SystemRole>
  spoilerActions: SpoilerActionRecord[]
  vs: VillageStatus
  setup: Map<SystemRole, number>
  players: Map<number, string>
  /** Howl frontmatter (meta). frontmatter.rules を engine config に反映するため optional で受ける */
  meta?: { rules?: Record<string, unknown> }
}

export type AdapterOutput = {
  config: GameConfig
  handlers: GameHandlers
}

export function buildLupaScenario(input: AdapterInput): AdapterOutput {
  const { assumptions, spoilerActions, vs, setup, meta } = input

  const config: GameConfig = {
    roles: setup,
    seed: 0,
    hasFirstGhost: false,
    nameStyle: 'seat',
  }

  // Howl frontmatter の vote.final / vote.tiebreaker を engine の revoteConfig に変換。
  // 完全 mapping ではなく spec で必要な分のみ:
  //   vote.final='final'  → maxRevotes=0 (revote せず即 tiebreaker)
  //   vote.tiebreaker='draw' → tiebreaker='draw' (引き分けで終局)
  const metaRules = meta?.rules ?? {}
  const voteFinal = metaRules['vote.final']
  const voteTiebreaker = metaRules['vote.tiebreaker']
  if (voteFinal === 'final' || voteTiebreaker === 'draw') {
    const revoteConfig: RevoteConfig = {
      maxRevotes: voteFinal === 'final' ? 0 : 3,
      style: 'random_tied',
      tiebreaker: voteTiebreaker === 'draw' ? 'draw' : 'lowest_seat',
    }
    config.revoteConfig = revoteConfig
  }

  // Howl の `N夜` (SpoilerStatement.day=N) は lupa night=N に相当する慣例で扱う。
  // - day=0 = 初夜 (lupa night 0、ctx.day=0)
  // - day=1 = Day 1 終わりの夜 (lupa night 1、ctx.day=2)
  // - day=N (N>=1) = Day N 終わりの夜 (lupa night N、ctx.day=N+1)
  // 初夜 attack は ruleset `first-victim: 'none'` のときだけ engine が resolve する。
  // default の `first-victim: 'random'` のときは初夜の死者は random で決まり、
  // 0夜 襲撃の spoiler 指定は engine に無視される。
  function ctxDayToActionDay(ctxDay: number): number {
    return ctxDay === 0 ? 0 : ctxDay - 1
  }

  const handlers: GameHandlers = {
    onSetup(seatRoles, state) {
      // spoiler 役職を engine の seatRoles + state.players[].role に強制反映
      for (const [seat, role] of assumptions) {
        seatRoles.set(seat, role)
        const player = state.players.find(p => p.seat === seat)
        if (player) player.role = role
      }
    },

    onNight(ctx) {
      const actionDay = ctxDayToActionDay(ctx.day)
      const actions = new Map<number, NightAction>()
      for (const sa of spoilerActions) {
        if (sa.day !== actionDay) continue
        if (sa.action === 'divine') actions.set(sa.by, { type: 'divine', target: sa.target })
        else if (sa.action === 'guard') actions.set(sa.by, { type: 'guard', target: sa.target })
        else if (sa.action === 'attack') actions.set(sa.by, { type: 'attack', target: sa.target })
      }
      return actions
    },

    onDayClaims(ctx) {
      const day = ctx.day
      const claims = new Map<number, DayClaim>()
      for (const [seat, status] of vs.statuses) {
        if (!status.claiming) continue
        if (status.claimedAt !== day) continue

        const role = status.claimingRole
        if (role === 'seer') {
          const results: Array<{ day: number, target: number, result: 'human' | 'wolf' }> = []
          for (const [night, a] of status.assertions) {
            if (night < 0) continue
            if (a.species !== 'human' && a.species !== 'wolf') continue
            results.push({ day: night, target: a.target, result: a.species })
          }
          claims.set(seat, { type: 'seer_co', results })
        } else if (role === 'medium') {
          const pastResults: ('human' | 'wolf')[] = []
          for (const [, a] of status.assertions) {
            if (a.species === 'human' || a.species === 'wolf') pastResults.push(a.species)
          }
          claims.set(seat, { type: 'medium_co', pastResults: pastResults.length > 0 ? pastResults : undefined })
        } else if (role === 'bodyguard') {
          const targets: number[] = []
          for (const [, t] of status.actions) targets.push(t)
          claims.set(seat, { type: 'bodyguard_co', targets })
        } else if (role === 'mason') {
          // mason の相方は status.assertions に { target, species: 'human' } として記録される
          let partner = -1
          for (const [, a] of status.assertions) { partner = a.target; break }
          if (partner >= 0) claims.set(seat, { type: 'mason_co', partner })
        } else if (role === 'nekomata') {
          claims.set(seat, { type: 'nekomata_co' })
        }
      }
      return claims
    },

    onVote(ctx) {
      const votes = new Map<number, number>()
      const dayVotes = vs.voteHistory.get(ctx.day) ?? []
      for (const v of dayVotes) {
        // 生存者かつ candidates 制約があれば内側
        if (ctx.candidates !== null && !ctx.candidates.includes(v.target)) continue
        votes.set(v.voter, v.target)
      }
      // 票記録のない生存者は alivePlayers の先頭に投票 (engine の制約: 投票必須)
      for (const seat of ctx.alivePlayers) {
        if (votes.has(seat)) continue
        const target = ctx.candidates && ctx.candidates.length > 0
          ? ctx.candidates[0]
          : ctx.alivePlayers.find(s => s !== seat) ?? seat
        votes.set(seat, target)
      }
      return votes
    },
  }

  return { config, handlers }
}
