/**
 * DecisionContext + determinized world から SimState + RolloutInvariants を構築する。
 *
 * MCTS rollout の root 時に 1 度だけ呼ばれる。これ以降の rollout は SimState 経路で
 * 動的観測を生成し、invariants を共有する。
 *
 * ## 責務
 *
 * - ctx.publicEvents から claims / fakeDivineHistory / deathLog / voteLog を逆構築
 * - viewer (= ctx.mySeat) が seer なら divineHistory から divineLog を、
 *   bodyguard なら guardHistory から guardLog を埋める
 * - ctx.signals 等から signal カウンターを集計し RolloutInvariants に詰める
 * - retar / tsumi / commander / planIndices などは ctx から直接コピー
 *
 * ## 観測の整合性
 *
 * `buildInitialSimState` で構築した SimState を `encodeFromSimState` で encode した
 * 結果は、`encodeObservation(ctx)` の結果と (Stage 2 で観測に乗せる範囲で) 一致する。
 * 完全一致しないフィールド (Stage 2 範囲外):
 * - signal カウンターのうち comm phase で発生する種類は、ctx から逆構築で渡る
 * - revote 関連は Stage 2 範囲外で 0 固定
 */

import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { FenrirEvent } from '../../fenrir/src/events.ts'
import { createSimState } from '../simulator/world-state.ts'
import type { SimState, Phase } from '../simulator/world-state.ts'
import {
  zeroSignalCounts, type RolloutInvariants, type SignalCountsPerSeat,
} from './from-sim-state.ts'

/**
 * DecisionContext から SimState を構築。viewer (ctx.mySeat) の私的情報も埋める。
 *
 * @param ctx 元の DecisionContext (root で渡される)
 * @param world determinized World (rollout ごとに異なる)
 */
export function buildInitialSimState(ctx: DecisionContext, world: World): SimState {
  const alive = aliveBitmaskFromList(ctx.alivePlayers)
  const phase: Phase = ctx.phase === 'night' ? 'night_attack' : 'day'
  const state = createSimState(world, alive, ctx.day, phase)

  // publicEvents 走査で claims / fakeDivineHistory / deathLog / voteLog を再構築
  const events = ctx.publicEvents as readonly FenrirEvent[]
  for (const event of events) {
    switch (event.type) {
      case 'seer_claim': {
        const isFake = world.roles[event.actor] !== 'seer'
        state.claims.set(event.actor, { role: 'seer', isFake })
        // 偽 seer の場合、results を fakeDivineHistory に蓄積
        if (isFake) {
          const list = state.fakeDivineHistory.get(event.actor) ?? []
          for (const r of event.results) {
            list.push({
              day: r.day, target: r.target,
              color: r.result === 'wolf' ? 'wolf' : 'human',
            })
          }
          state.fakeDivineHistory.set(event.actor, list)
        }
        break
      }
      case 'seer_result': {
        const isFake = world.roles[event.actor] !== 'seer'
        if (isFake) {
          const list = state.fakeDivineHistory.get(event.actor) ?? []
          list.push({
            day: ctx.day, target: event.target,
            color: event.result === 'wolf' ? 'wolf' : 'human',
          })
          state.fakeDivineHistory.set(event.actor, list)
        }
        break
      }
      case 'medium_claim': {
        const isFake = world.roles[event.actor] !== 'medium'
        state.claims.set(event.actor, { role: 'medium', isFake })
        break
      }
      case 'bodyguard_claim': {
        const isFake = world.bodyguardSeat !== event.actor
        state.claims.set(event.actor, { role: 'bodyguard', isFake })
        break
      }
      case 'mason_claim': {
        const isFake = world.roles[event.actor] !== 'mason'
        state.claims.set(event.actor, { role: 'mason', isFake })
        break
      }
      case 'nekomata_claim': {
        const isFake = world.roles[event.actor] !== 'nekomata'
        state.claims.set(event.actor, { role: 'nekomata', isFake })
        break
      }
      case 'wolf_claim': {
        // wolf_claim は偽 CO (FenrirExtEvent)、claimedRole が指定される
        state.claims.set(event.actor, { role: event.claimedRole, isFake: true })
        break
      }
      case 'execution':
        state.deathLog.push({ day: ctx.day, seat: event.target, cause: 'execute' })
        break
      case 'night_kill':
        state.deathLog.push({ day: ctx.day, seat: event.target, cause: 'night_kill' })
        break
      case 'curse_kill':
        state.deathLog.push({ day: ctx.day, seat: event.target, cause: 'curse' })
        break
      case 'follow_kill':
        state.deathLog.push({ day: ctx.day, seat: event.target, cause: 'follow' })
        break
      case 'fox_kill':
        // fox_kill は spec の余録イベント。Stage 2 では curse 同等扱いで OK
        state.deathLog.push({ day: ctx.day, seat: event.target, cause: 'curse' })
        break
      case 'vote':
        state.voteLog.push({ day: ctx.day, voter: event.voter, target: event.target })
        break
      // 他のイベントは SimState には影響しない (signal は invariants へ)
    }
  }

  // viewer の私的情報: seer の divine history、bodyguard の guard history
  if (ctx.myRole === 'seer' && ctx.myPlayer.divineHistory) {
    for (const [day, entry] of ctx.myPlayer.divineHistory) {
      const log = state.divineLog.get(ctx.mySeat) ?? []
      log.push({
        day, target: entry.target,
        color: entry.result === 'wolf' ? 'wolf' : 'human',
      })
      state.divineLog.set(ctx.mySeat, log)
    }
  }
  if (ctx.myRole === 'bodyguard' && ctx.myPlayer.guardHistory) {
    for (const [day, target] of ctx.myPlayer.guardHistory) {
      state.guardLog.push({ day, target })
    }
  }

  return state
}

/**
 * DecisionContext から RolloutInvariants を構築。
 *
 * - signal カウンターを ctx.publicEvents から集計
 * - retar / tsumi / commander / planIndices / rope margin は ctx から
 */
export function buildInvariants(ctx: DecisionContext): RolloutInvariants {
  const signalCounts = zeroSignalCounts()
  let demandWolfCoCount = 0

  const events = ctx.publicEvents as readonly FenrirEvent[]
  for (const event of events) {
    switch (event.type) {
      case 'vote':
        bumpSig(signalCounts, event.target, 'voteReceived')
        break
      case 'execute_proposals':
        for (const t of event.targets) bumpSig(signalCounts, t, 'executeProposal')
        break
      case 'signal': {
        const sig = event.signal
        if (sig.type === 'demand_wolf_co') { demandWolfCoCount++; break }
        if ('target' in sig) {
          const t = sig.target
          switch (sig.type) {
            case 'suspicion': bumpSig(signalCounts, t, 'suspicion'); break
            case 'trust': bumpSig(signalCounts, t, 'trust'); break
            case 'accuse_wolf': bumpSig(signalCounts, t, 'accuseWolf'); break
            case 'accuse_fox': bumpSig(signalCounts, t, 'accuseFox'); break
            case 'vote_intent': bumpSig(signalCounts, t, 'voteIntent'); break
            case 'nominate_commander': bumpSig(signalCounts, t, 'nominateCommander'); break
            case 'agree': bumpSig(signalCounts, t, 'planApproved', +1); break
            case 'disagree': bumpSig(signalCounts, t, 'planApproved', -1); break
            case 'confirm_human': bumpSig(signalCounts, t, 'confirmHuman'); break
            case 'confirm_wolf': bumpSig(signalCounts, t, 'confirmWolf'); break
            case 'vote_for': bumpSig(signalCounts, t, 'voteFor'); break
            case 'vote_against': bumpSig(signalCounts, t, 'voteAgainst'); break
          }
        }
        break
      }
    }
  }

  // rope margin
  let ropeMargin: number | null = null
  if (ctx.maxSurvivingNV !== null) {
    const remainingExecutions = (ctx.alivePlayers.length - 1) / 2
    ropeMargin = remainingExecutions - ctx.maxSurvivingNV
  }

  return {
    signalCounts,
    retarPossibilities: ctx.retarPossibilities,
    globalRetarPossibilities: ctx.globalRetarPossibilities,
    tsumiTarget: ctx.tsumiTarget,
    ropeMargin,
    commander: ctx.commander,
    demandWolfCoCount,
    planIndices: ctx.planIndices,
    villageNNOutput: undefined,
  }
}

/** signal counter の数値フィールドを増加 */
function bumpSig(
  counts: SignalCountsPerSeat[],
  seat: number,
  field: keyof SignalCountsPerSeat,
  delta: number = 1,
): void {
  if (seat < 1 || seat > counts.length) return
  const c = counts[seat - 1]
  const cur = c[field]
  if (typeof cur === 'number') {
    (c as unknown as Record<string, number>)[field] = cur + delta
  }
}

/** alive 配列 (number[]) → bitmask */
function aliveBitmaskFromList(seats: readonly number[]): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

/**
 * viewer の SystemRole を ctx から取得 (myRole がそのまま使える)。
 * MCTS dispatch で他 actor の Module を呼ぶ際は world.roles[actorSeat] を使う。
 */
export function viewerRoleFromCtx(ctx: DecisionContext): SystemRole {
  return ctx.myRole
}
