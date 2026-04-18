/**
 * Unified vote-analysis interface: skoll / NN / hybrid を同一型で扱う。
 *
 * 各 perspective (village/mason/wolf/fanatic/hamster/immoralist) は
 * 独自の生 skoll 戻り値型を持つが、このモジュールでは共通の
 * UnifiedVoteAnalysis に正規化する。
 *
 * 設計:
 *   - 生 skoll の戻り値 → `unify*Analysis(raw, ...args)` で変換
 *   - NN 推論 → `nnInferVote(net, obs, alive, excluded)` で生成
 *   - hybrid は呼び出し側で estimateWorldCount ベースに切替え
 *
 * TF.js 非依存 (Pure JS 推論のみ)。
 */

import type { Seat, SystemRole } from '../types/index.ts'
import type { AnyNetwork } from '../fenrir/src/ml/nn.ts'
import { SEATS } from '../fenrir/src/observation.ts'
import { Possibilities, possibilityFromRoles, RoleBitIndex } from '../retar/possibilities.ts'
import type { WorldExecutionAnalysis } from './world-analysis.ts'
import type { WolfVoteAnalysis } from './wolf-vote-analysis.ts'
import type { HamsterVoteAnalysis } from './hamster-analysis.ts'

export type PerspectiveId = 'village' | 'mason' | 'wolf' | 'fanatic' | 'hamster' | 'immoralist'

export type UnifiedSource = 'skoll-exact' | 'skoll-truncated' | 'nn'

export type UnifiedCandidate = {
  seat: Seat
  /** 主観勝率 (自陣営が勝つ確率, 0..1)。NN では softmax 確率 */
  score: number
  /** bestVote 候補から除外される (teammate/self 等) */
  excluded: boolean
}

export type UnifiedVoteAnalysis = {
  source: UnifiedSource
  bestVote: Seat | null
  candidates: UnifiedCandidate[]
  /** skoll のときのみ設定 */
  totalWorlds?: number
  /** wolf/fanatic のときのみ設定 (PP 既達) */
  ppAlreadyAchieved?: boolean
}

// ═══════════════════════════════════════════════════════════
// Skoll → Unified 変換
// ═══════════════════════════════════════════════════════════

/**
 * Village 視点 (villager/seer/medium/bodyguard/nekomata/mason): analyzeExecutionsByWorld の結果を正規化。
 * - score = winRate (村勝率)
 * - excluded = mySeat, partnerSeat (mason 時)
 */
export function unifyVillageAnalysis(
  a: WorldExecutionAnalysis,
  mySeat: Seat,
  partnerSeat: Seat | null,
): UnifiedVoteAnalysis {
  const excl = new Set<Seat>([mySeat])
  if (partnerSeat !== null) excl.add(partnerSeat)
  const candidates: UnifiedCandidate[] = a.executions.map(e => ({
    seat: e.seat,
    score: e.winRate,
    excluded: excl.has(e.seat),
  }))
  const bestVote = excl.has(a.bestExecution)
    ? pickBestNonExcluded(candidates)
    : a.bestExecution
  return {
    source: a.truncated ? 'skoll-truncated' : 'skoll-exact',
    bestVote,
    candidates,
    totalWorlds: a.totalWorlds,
  }
}

/** Wolf / Fanatic 視点: analyzeWolfVotesByWorld の結果を正規化。 */
export function unifyWolfAnalysis(a: WolfVoteAnalysis): UnifiedVoteAnalysis {
  const candidates: UnifiedCandidate[] = a.candidates.map(c => ({
    seat: c.seat,
    score: c.wolfWinRate,
    excluded: c.isTeammate,
  }))
  return {
    source: a.truncated ? 'skoll-truncated' : 'skoll-exact',
    bestVote: a.bestVote,
    candidates,
    totalWorlds: a.totalWorlds,
    ppAlreadyAchieved: a.ppAlreadyAchieved,
  }
}

/** Hamster / Immoralist 視点: analyzeHamsterVotesByWorld の結果を正規化。 */
export function unifyHamsterAnalysis(a: HamsterVoteAnalysis): UnifiedVoteAnalysis {
  const candidates: UnifiedCandidate[] = a.candidates.map(c => ({
    seat: c.seat,
    score: c.hamsterWinRate,
    excluded: c.isSelf,
  }))
  return {
    source: a.truncated ? 'skoll-truncated' : 'skoll-exact',
    bestVote: a.bestVote,
    candidates,
    totalWorlds: a.totalWorlds,
  }
}

// ═══════════════════════════════════════════════════════════
// NN → Unified
// ═══════════════════════════════════════════════════════════

/**
 * 観測を NN に通して vote 候補を算出。
 * network / observation encoder は perspective ごとに異なるため、
 * 呼び出し側が観測配列を作って渡す (encodeObservation / encodeCollectiveMasonObservation 等)。
 *
 * @param aliveSeats 生存席 (候補の母集合)
 * @param excluded  除外席 (teammate/self 等)
 */
export function nnInferVote(
  network: AnyNetwork,
  observation: Float32Array,
  aliveSeats: Seat[],
  excluded: Set<Seat>,
): UnifiedVoteAnalysis {
  const result = network.forward(observation)
  const logits = result.policies.get('vote')
  if (!logits) {
    return { source: 'nn', bestVote: null, candidates: [] }
  }

  // aliveSeats を候補集合とし、除外外の最大 logit を bestVote とする
  // candidates の score は softmax 確率 (aliveSeats 内で正規化)
  const aliveLogits: number[] = aliveSeats.map(seat => {
    if (seat < 1 || seat > SEATS) return -Infinity
    return logits[seat - 1]
  })
  let maxLogit = -Infinity
  for (const l of aliveLogits) if (l > maxLogit) maxLogit = l
  let expSum = 0
  const expVals: number[] = aliveLogits.map(l => {
    const v = Math.exp(l - maxLogit)
    expSum += v
    return v
  })
  const candidates: UnifiedCandidate[] = aliveSeats.map((seat, i) => ({
    seat,
    score: expSum > 0 ? expVals[i] / expSum : 0,
    excluded: excluded.has(seat),
  }))

  let bestSeat: Seat | null = null
  let bestLogit = -Infinity
  for (let i = 0; i < aliveSeats.length; i++) {
    const seat = aliveSeats[i]
    if (excluded.has(seat)) continue
    if (aliveLogits[i] > bestLogit) {
      bestLogit = aliveLogits[i]
      bestSeat = seat
    }
  }

  return { source: 'nn', bestVote: bestSeat, candidates }
}

// ═══════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════

function pickBestNonExcluded(candidates: UnifiedCandidate[]): Seat | null {
  let best: Seat | null = null
  let bestScore = -Infinity
  for (const c of candidates) {
    if (c.excluded) continue
    if (c.score > bestScore) {
      bestScore = c.score
      best = c.seat
    }
  }
  return best
}

/**
 * Retar の globalPossibilities と setup から skoll 用の Possibilities インスタンスを構築。
 * 3 つの skoll エージェント (master / mason / wolf) で共通に使う。
 */
export function buildPossibilitiesFromRetar(
  globalPoss: Map<number, Set<SystemRole>>,
  setup: Map<SystemRole, number>,
): Possibilities {
  let maxSeat = 0
  for (const seat of globalPoss.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  const possibilities = new Possibilities(maxSeat)
  for (const [role, count] of setup) {
    const idx = RoleBitIndex[role]
    if (idx !== undefined) possibilities.setup[idx] = count
  }
  possibilities.setupOriginal = new Uint8Array(possibilities.setup)
  for (const [seat, roles] of globalPoss) {
    possibilities.possibilities[seat] = possibilityFromRoles(roles)
  }
  return possibilities
}
