import type { World } from '../../hati/types.ts'
import { hasSeat, popCount32 } from '../../hati/types.ts'
import { validBiteTargetsMask } from '../../hati/simulate.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import type { NightDecisions } from './actions.ts'

const VILLAGER = RoleBitIndex.villager
const SEER = RoleBitIndex.seer
const MEDIUM = RoleBitIndex.medium
const BODYGUARD = RoleBitIndex.bodyguard
const MASON = RoleBitIndex.mason
const NEKOMATA = RoleBitIndex.nekomata
const WEREWOLF = RoleBitIndex.werewolf
const POSSESSED = RoleBitIndex.possessed
const FANATIC = RoleBitIndex.fanatic
const WEREHAMSTER = RoleBitIndex.werehamster
const IMMORALIST = RoleBitIndex.immoralist

/**
 * 投票先決定（Option B: 真 role 知っている前提の heuristic）。
 *
 * 各陣営が「処刑したい優先順位」で alive 候補を走査する:
 * - 村陣営: 狼 → 狐 → 狂信者 → 背徳者 → 狂人 → 村人
 * - 狼陣営: 占 → 霊 → 狩 → 共 → 猫 → 村
 * - 狐陣営: 狼 → 狂信者 → 占 → 霊 → 村
 *
 * 同優先度内では最小席番。ties は決定論で進めて test を再現可能にする。
 *
 * 戻り値: 投票先 seat。alive に自分以外の生存者がいなければ -1（abstain）。
 */
export function decideVoteHeuristic(world: World, alive: number, voter: number): number {
  const candidates = alive & ~(1 << voter)
  if (candidates === 0) return -1

  const voterRole = world.roleIds[voter]
  const priority = votePriorityFor(voterRole)
  return pickByRolePriority(world, candidates, priority)
}

const VILLAGE_PRIORITY = [WEREWOLF, WEREHAMSTER, FANATIC, IMMORALIST, POSSESSED]
const WOLF_PRIORITY = [SEER, MEDIUM, BODYGUARD, MASON, NEKOMATA, VILLAGER]
const FOX_PRIORITY = [WEREWOLF, FANATIC, SEER, MEDIUM, BODYGUARD, MASON, NEKOMATA, VILLAGER]

function votePriorityFor(roleId: number): number[] {
  switch (roleId) {
    case WEREWOLF:
    case FANATIC:
    case POSSESSED:
      return WOLF_PRIORITY
    case WEREHAMSTER:
    case IMMORALIST:
      return FOX_PRIORITY
    default:
      return VILLAGE_PRIORITY
  }
}

function pickByRolePriority(world: World, candidates: number, priority: number[]): number {
  for (const targetRole of priority) {
    let mask = candidates
    while (mask !== 0) {
      const bit = mask & (-mask)
      const seat = 31 - Math.clz32(bit)
      mask ^= bit
      if (world.roleIds[seat] === targetRole) return seat
    }
  }
  // 該当役職が候補にない → 最小席番（fallback）
  const fallbackBit = candidates & (-candidates)
  return 31 - Math.clz32(fallbackBit)
}

/**
 * 1 day の全座席の vote を集計し、majority 処刑対象を決める。
 *
 * - voter ごとに `decideVoteHeuristic` を呼ぶ。`masonVoteOverride` が指定された
 *   席はそれを採用（MCTS の root action 注入用）
 * - 同票時は最小席番が処刑される（決定論）
 *
 * 戻り値: 処刑対象 seat。投票が 1 件もなければ -1（実質的にスキップ）。
 */
export function tallyVotes(
  world: World,
  alive: number,
  masonVoteOverride: Map<number, number> | null = null,
): number {
  const voteCount = new Map<number, number>()
  let mask = alive
  while (mask !== 0) {
    const bit = mask & (-mask)
    const voter = 31 - Math.clz32(bit)
    mask ^= bit
    const override = masonVoteOverride?.get(voter)
    const target = override !== undefined ? override : decideVoteHeuristic(world, alive, voter)
    if (target < 0) continue
    voteCount.set(target, (voteCount.get(target) ?? 0) + 1)
  }

  let bestSeat = -1
  let bestCount = 0
  for (const [seat, count] of voteCount) {
    if (count > bestCount || (count === bestCount && (bestSeat < 0 || seat < bestSeat))) {
      bestSeat = seat
      bestCount = count
    }
  }
  return bestSeat
}

/**
 * 1 night 分の全座席の night action を heuristic で決定。
 *
 * - 占い師（生存）: 未占既知狼などの戦略は持たず、最小席番の生存非自席を占う
 *   （rollout 内の bias 許容）
 * - 狩人: 占 CO 想定がないので、最小席番の生存非自席を護衛
 * - 狼: validBiteTargetsMask の中から、占 → 霊 → 狩 → 共 → 村 の順で選択
 *
 * 狼が生きていない（= ゲーム終了済み）場合は呼び出してはいけない（caller が
 * checkOutcome で先に検出する想定）。
 */
export function decideNightHeuristic(world: World, alive: number): NightDecisions {
  return {
    wolfBiteTarget: pickWolfBite(world, alive),
    bodyguardTarget: pickBodyguardTarget(world, alive),
    seerTargets: pickSeerTargets(world, alive),
  }
}

function pickWolfBite(world: World, alive: number): number {
  const targets = validBiteTargetsMask(world, alive)
  if (targets === 0) return -1
  // 狼陣営の vote priority と同じ序列で噛み先を選ぶ
  return pickByRolePriority(world, targets, WOLF_PRIORITY)
}

function pickBodyguardTarget(world: World, alive: number): number | null {
  const bg = world.bodyguardSeat
  if (bg < 0 || !hasSeat(alive, bg)) return null
  // 自分以外の生存者を最小席番で護衛
  const candidates = alive & ~(1 << bg)
  if (candidates === 0) return null
  // 占い師 → 霊媒師 → 共有 → 猫又 → 村人 の順で守る
  return pickByRolePriority(world, candidates, [SEER, MEDIUM, MASON, NEKOMATA, VILLAGER])
}

function pickSeerTargets(world: World, alive: number): number[] {
  const aliveSeers = world.seerMask & alive
  if (aliveSeers === 0) return []
  const targets: number[] = []
  let mask = aliveSeers
  while (mask !== 0) {
    const bit = mask & (-mask)
    const seer = 31 - Math.clz32(bit)
    mask ^= bit
    const candidates = alive & ~(1 << seer)
    if (candidates === 0) {
      targets.push(-1)
      continue
    }
    // 狐を最優先（呪殺で確実に排除）→ 次に狼。神視点 heuristic では vote で狼を
    // 捌けるが狐は seer の curse でしか倒せないため、seer の最適は狐占い。
    targets.push(pickByRolePriority(world, candidates, [
      WEREHAMSTER, WEREWOLF, FANATIC, IMMORALIST, POSSESSED, VILLAGER,
    ]))
  }
  return targets
}

/** デバッグ・テスト用: 生存席数 */
export function aliveCount(alive: number): number {
  return popCount32(alive)
}
