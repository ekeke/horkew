/**
 * ModuleBundle dispatch — phase + state から「どの Module の どの head を呼ぶか」を決める。
 *
 * MCTS rollout が phase ごとに actor 役職を判定し、対応する Module の policy/value head を
 * 呼ぶための機構。Stage 2 で `runMCTS` がこれを使って Module を切り替える。
 */

import type { SystemRole } from '../../types/index.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import type { SimState, Phase } from '../simulator/world-state.ts'
import type { SkollZeroModule } from '../module/skoll-zero-module.ts'
import type { HeadName } from './nn.ts'

/**
 * 役職 Module の集合。MCTS は phase に応じてこのうちの 1 つを選んで forward を呼ぶ。
 *
 * - mason: mason 役職 (mason_collective 観測)
 * - wolf: werewolf (wolf_collective 観測)
 * - standard: villager / seer / medium / bodyguard / nekomata 共有 (individual 観測)
 * - fanatic: fanatic (fanatic 観測、village_predict/trust 注入)
 * - hamster: werehamster (individual 観測、hamster faction)
 * - immoralist: immoralist (individual 観測、hamster faction)
 *
 * Stage 2 では各 Module が独自の NN + buffer を持つ前提。Module 不在 (undefined) の場合は
 * fallback として decisionSeat の Module で代用する (近似)。
 */
export type ModuleBundle = {
  mason?: SkollZeroModule
  wolf?: SkollZeroModule
  standard?: SkollZeroModule
  fanatic?: SkollZeroModule
  hamster?: SkollZeroModule
  immoralist?: SkollZeroModule
}

/** 役職 → Module bucket */
export type ModuleBucket = keyof ModuleBundle

/** SystemRole → Module bucket の mapping */
export function bucketForRole(role: SystemRole): ModuleBucket | null {
  switch (role) {
    case 'mason': return 'mason'
    case 'werewolf': return 'wolf'
    case 'villager':
    case 'seer':
    case 'medium':
    case 'bodyguard':
    case 'nekomata':
      return 'standard'
    case 'fanatic': return 'fanatic'
    case 'werehamster': return 'hamster'
    case 'immoralist': return 'immoralist'
    default: return null  // possessed 等は Stage 2 では学習対象外
  }
}

/**
 * dispatch 結果: どの Module / actor / head で expand するか + viewer 視点。
 */
export type DispatchResult = {
  module: SkollZeroModule
  actorSeat: number
  actorRole: SystemRole
  headName: HeadName
}

/**
 * 現在の phase と state から actor 役職を決定し、対応 Module を返す。
 *
 * Stage 3 で claim_* と morning も実 dispatch する。actor 選択ロジック:
 * - day: decisionSeat (集団意思決定の代理、Stage 5 で per-actor 集約に拡張)
 * - night_attack: 生存 wolf の lowest seat
 * - night_divine: 生存 真 seer の lowest seat
 * - night_guard: 生存 真 bg seat
 * - claim_*_true: 該当真役職の lowest 未 CO 生存 seat (1 actor / step、複数日かけて消費)
 * - claim_*_fake: 該当偽 CO 候補 (wolf/fanatic) の lowest 未 CO 生存 seat。
 *   Module は wolf 集中 (Stage 3 簡素化、fanatic も wolf module で扱う)
 * - morning: morningPending[0] (FIFO 先頭、1 actor / step、wolf module)
 *
 * @param state rollout state (world / alive を参照)
 * @param decisionSeat MCTS の root 決定者
 * @param bundle 役職 Module 集合
 * @returns dispatch 可能なら結果、不可能なら null (skip 扱い)
 */
export function dispatchForPhase(
  state: SimState,
  decisionSeat: number,
  bundle: ModuleBundle,
): DispatchResult | null {
  const world = state.world
  switch (state.phase) {
    case 'day': {
      const role = world.roles[decisionSeat]
      const module = pickModule(bundle, role)
      if (!module) return null
      return { module, actorSeat: decisionSeat, actorRole: role, headName: 'execute' }
    }
    case 'night_attack': {
      const wolfSeat = lowestSeat(world.wolfMask & state.alive)
      if (wolfSeat < 0) return null
      const module = bundle.wolf
      if (!module) return null
      return { module, actorSeat: wolfSeat, actorRole: 'werewolf', headName: 'attack' }
    }
    case 'night_divine': {
      const seerSeat = lowestSeat(world.seerMask & state.alive)
      if (seerSeat < 0) return null
      const module = bundle.standard
      if (!module) return null
      return { module, actorSeat: seerSeat, actorRole: 'seer', headName: 'divine' }
    }
    case 'night_guard': {
      const bgSeat = world.bodyguardSeat
      if (bgSeat < 0 || (state.alive & (1 << bgSeat)) === 0) return null
      const module = bundle.standard
      if (!module) return null
      return { module, actorSeat: bgSeat, actorRole: 'bodyguard', headName: 'guard' }
    }
    case 'claim_seer_true':
    case 'claim_medium_true':
    case 'claim_bg_true':
    case 'claim_nekomata_true':
    case 'claim_mason': {
      const actorSeat = lowestUnclaimedTrueRoleSeat(state, state.phase)
      if (actorSeat < 0) return null
      const role = world.roles[actorSeat]
      const module = pickModule(bundle, role)
      if (!module) return null
      return { module, actorSeat, actorRole: role, headName: 'claim_true' }
    }
    case 'claim_seer_fake':
    case 'claim_medium_fake':
    case 'claim_bg_fake':
    case 'claim_nekomata_fake': {
      // 候補は wolf ∪ fanatic の未 CO 生存席。Stage 3 では wolf module に集約。
      // bundle.wolf 不在時は fanatic にフォールバック。
      const actorSeat = lowestUnclaimedFakeActorSeat(state)
      if (actorSeat < 0) return null
      const module = bundle.wolf ?? bundle.fanatic
      if (!module) return null
      const role = world.roles[actorSeat]
      return { module, actorSeat, actorRole: role, headName: 'claim_fake' }
    }
    case 'morning': {
      if (state.morningPending.length === 0) return null
      const actorSeat = state.morningPending[0]
      const module = bundle.wolf ?? bundle.fanatic
      if (!module) return null
      const role = world.roles[actorSeat]
      return { module, actorSeat, actorRole: role, headName: 'morning' }
    }
    case 'terminal':
      return null
  }
}

// ============================================================
// claim/morning 用 actor 選択ヘルパー
// ============================================================

/** phase ごとの真役職 mask を返す (claim_*_true 用)。bodyguard は単一席 */
function trueRoleMask(state: SimState, phase: Phase): number {
  const w = state.world
  switch (phase) {
    case 'claim_seer_true': return w.seerMask & state.alive
    case 'claim_medium_true': return w.mediumMask & state.alive
    case 'claim_bg_true':
      return w.bodyguardSeat >= 0 && (state.alive & (1 << w.bodyguardSeat))
        ? (1 << w.bodyguardSeat) : 0
    case 'claim_nekomata_true': return w.nekomataMask & state.alive
    case 'claim_mason': {
      let mask = 0
      for (let s = 1; s < w.roleIds.length; s++) {
        if (w.roleIds[s] === RoleBitIndex.mason) mask |= (1 << s)
      }
      return mask & state.alive
    }
    default: return 0
  }
}

/** wolf + fanatic の生存 mask (claim_*_fake / morning 用 actor 候補) */
function fakeActorMask(state: SimState): number {
  const w = state.world
  let fanaticMask = 0
  for (let s = 1; s < w.roleIds.length; s++) {
    if (w.roleIds[s] === RoleBitIndex.fanatic) fanaticMask |= (1 << s)
  }
  return (w.wolfMask | fanaticMask) & state.alive
}

/** claim_*_true 用: 該当真役職で未 CO の最低位生存 seat (なければ -1) */
function lowestUnclaimedTrueRoleSeat(state: SimState, phase: Phase): number {
  let mask = trueRoleMask(state, phase)
  for (const seat of state.claims.keys()) mask &= ~(1 << seat)
  return lowestSeat(mask)
}

/** claim_*_fake 用: 未 CO の wolf/fanatic 最低位生存 seat (なければ -1) */
function lowestUnclaimedFakeActorSeat(state: SimState): number {
  let mask = fakeActorMask(state)
  for (const seat of state.claims.keys()) mask &= ~(1 << seat)
  return lowestSeat(mask)
}

/** 役職に対応する Module を bundle から取り出す (null 安全) */
function pickModule(bundle: ModuleBundle, role: SystemRole): SkollZeroModule | undefined {
  const bucket = bucketForRole(role)
  if (!bucket) return undefined
  return bundle[bucket]
}

/** mask の最下位 set bit に対応する seat (なければ -1) */
function lowestSeat(mask: number): number {
  if (mask === 0) return -1
  const bit = mask & (-mask)
  return 31 - Math.clz32(bit)
}

/**
 * faction 変換: actor faction で得た value を decision faction で評価する value に変換。
 *
 * 3 陣営 ゲームでは「actor 視点の +1」が「decision 視点の何になるか」を決める。
 * 現時点 (Stage 2 暫定) は単純な符号変換:
 * - 同一 faction → そのまま
 * - 異 faction → 符号反転 (zero-sum 近似)
 *
 * Stage 4 で per-phase faction 動的切替に拡張する際、ここを「世界・状態を見た正確な変換」に
 * 置換する。
 */
export function convertValueAcrossFaction(
  value: number,
  actorFaction: 'village' | 'wolf' | 'hamster',
  decisionFaction: 'village' | 'wolf' | 'hamster',
): number {
  if (actorFaction === decisionFaction) return value
  // 異 faction: 単純な符号反転 (Stage 2 暫定)
  return -value
}
