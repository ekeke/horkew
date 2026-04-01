/**
 * 処刑プラン事前学習用の教師データ自動生成
 *
 * CO状況→処刑プラン→正解投票先のラベルを合成的に生成する。
 * パターン: ローラー(30%), 決め打ち(20%), 吊り先指定(20%), グレラン(30%)
 */

import type { DecisionContext, ExecutionPlan } from '../../../lupa/strategy.ts'
import type { SystemRole } from '../../../types/index.ts'
import type { GameEvent } from '../../../lupa/types.ts'
import { resolveRules } from '../../../howl/ruleset.ts'
import { Rng } from '../../../lupa/random.ts'
import { encodeObservation, SEATS, CO_ROLES, ROLE_INDEX } from '../observation.ts'
import { maskVote } from '../action.ts'
import { PLAN_VOCAB } from '../rule-action.ts'

export type PlanTrainingSample = {
  observation: Float32Array
  /** one-hot or soft label (uniform over valid targets for grayran) */
  voteLabel: Float32Array  // [SEATS]
  voteMask: Float32Array   // [SEATS] from maskVote
}

const VILLAGE_ROLES: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata']

/**
 * 合成 CO 状況を生成
 * @returns CO map (seat → role) と対応するpublicEvents
 */
function generateCOSituation(
  aliveSeats: number[],
  rng: Rng,
): { claims: Map<number, SystemRole>, events: GameEvent[] } {
  const claims = new Map<number, SystemRole>()
  const events: GameEvent[] = []

  // CO役職をランダムに選ぶ
  const role = CO_ROLES[Math.floor(rng.next() * CO_ROLES.length)]

  // CO者数: 2-3人（ローラー・決め打ちの素材）
  const numClaimants = rng.next() < 0.6 ? 2 : 3
  const shuffled = shuffleArray(aliveSeats, rng)
  const claimants = shuffled.slice(0, Math.min(numClaimants, shuffled.length))

  for (const seat of claimants) {
    claims.set(seat, role)
    switch (role) {
      case 'seer':
        events.push({ type: 'seer_claim', actor: seat, results: [] })
        break
      case 'medium':
        events.push({ type: 'medium_claim', actor: seat })
        break
      case 'bodyguard':
        events.push({ type: 'bodyguard_claim', actor: seat, targets: [] })
        break
      case 'mason':
        events.push({ type: 'mason_claim', actor: seat, partner: 0 })
        break
      case 'nekomata':
        events.push({ type: 'nekomata_claim', actor: seat })
        break
    }
  }

  return { claims, events }
}

type PatternType = 'roller' | 'decision' | 'designated' | 'grayran' | 'retar_suspect'

/** パターンに応じてプランと正解ラベルを生成 */
function generatePlanAndLabel(
  pattern: PatternType,
  claims: Map<number, SystemRole>,
  aliveSeats: number[],
  mySeat: number,
  rng: Rng,
): { plan: ExecutionPlan, label: Float32Array } | null {
  const label = new Float32Array(SEATS)
  const claimants = [...claims.keys()]
  const grays = aliveSeats.filter(s => s !== mySeat && !claims.has(s))

  switch (pattern) {
    case 'roller': {
      if (claimants.length < 2) return null
      const targets = claimants.filter(s => s !== mySeat)
      if (targets.length < 2) return null
      const plan: ExecutionPlan = { targets, type: 'roller' }
      // 正解: targets[0] (先頭)
      label[targets[0] - 1] = 1
      return { plan, label }
    }
    case 'decision': {
      if (claimants.length < 2) return null
      // 1人だけ選ぶ
      const candidates = claimants.filter(s => s !== mySeat)
      if (candidates.length === 0) return null
      const target = candidates[Math.floor(rng.next() * candidates.length)]
      const plan: ExecutionPlan = { targets: [target], type: 'decision' }
      label[target - 1] = 1
      return { plan, label }
    }
    case 'designated': {
      // CO者以外のランダムな席を指定
      const candidates = aliveSeats.filter(s => s !== mySeat)
      if (candidates.length === 0) return null
      const target = candidates[Math.floor(rng.next() * candidates.length)]
      const plan: ExecutionPlan = { targets: [target], type: 'designated' }
      label[target - 1] = 1
      return { plan, label }
    }
    case 'grayran': {
      if (grays.length === 0) return null
      const plan: ExecutionPlan = { targets: [], type: 'grayran' }
      // soft label: CO者以外の生存者に均等確率
      const prob = 1 / grays.length
      for (const s of grays) {
        label[s - 1] = prob
      }
      return { plan, label }
    }
    case 'retar_suspect':
      // この関数には来ない（呼び出し元で 'designated' に変換済み）
      return null
  }
}

/** 最小限の合成DecisionContextを構築 */
function buildSyntheticContext(params: {
  day: number
  mySeat: number
  myRole: SystemRole
  aliveSeats: number[]
  events: GameEvent[]
  plan: ExecutionPlan
  rng: Rng
  retarPossibilities?: Map<number, Set<SystemRole>>
}): DecisionContext {
  return {
    mySeat: params.mySeat,
    myRole: params.myRole,
    myPlayer: {
      seat: params.mySeat, role: params.myRole, alive: true,
      divineHistory: new Map(), guardHistory: new Map(),
      claimed: null, fakeDivineHistory: null,
    } as any,
    day: params.day,
    phase: 'day',
    alivePlayers: params.aliveSeats,
    publicEvents: params.events,
    signals: [],
    commander: null,
    proposals: [],
    rng: params.rng,
    gameState: { day: params.day, phase: 'day', players: [], commander: null } as any,
    lastExecutedSeat: null,
    retarPossibilities: params.retarPossibilities ?? null,
    maxSurvivingNV: null,
    globalRetarPossibilities: params.retarPossibilities ?? null,
    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: null,
    revoteRound: null,
    revoteCandidates: null,
    executionPlans: [params.plan],
    tsumiTarget: null,
    rules: resolveRules(),
  }
}

function shuffleArray<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1))
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp
  }
  return a
}

/**
 * 合成 Retar possibilities を生成
 * 数席を「狼不可能（確定白）」に、残りを「狼可能」にする。
 * 狼可能席のうちランダムに選んだ席を suspectSeats として返す。
 */
function generateSyntheticRetar(
  aliveSeats: number[],
  mySeat: number,
  claims: Map<number, SystemRole>,
  rng: Rng,
): { possibilities: Map<number, Set<SystemRole>>, suspectSeats: number[] } {
  const ALL_ROLES: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'werewolf', 'fanatic', 'werehamster', 'immoralist']
  const VILLAGE_ONLY: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata']
  const possibilities = new Map<number, Set<SystemRole>>()

  // 自分は村側確定
  possibilities.set(mySeat, new Set(VILLAGE_ONLY))

  // CO者のうちランダムに1人を確定白に
  const claimants = [...claims.keys()].filter(s => s !== mySeat)
  const confirmedWhites = new Set<number>([mySeat])
  if (claimants.length > 0 && rng.next() < 0.5) {
    const confirmed = claimants[Math.floor(rng.next() * claimants.length)]
    possibilities.set(confirmed, new Set(VILLAGE_ONLY))
    confirmedWhites.add(confirmed)
  }

  // 残りの席: 全役職可能（狼含む）
  const wolfPossibleSeats: number[] = []
  for (const seat of aliveSeats) {
    if (confirmedWhites.has(seat)) continue
    possibilities.set(seat, new Set(ALL_ROLES))
    wolfPossibleSeats.push(seat)
  }

  // suspect: 狼可能席からランダムに 1〜3 席
  const shuffled = shuffleArray(wolfPossibleSeats, rng)
  const numSuspects = Math.min(1 + Math.floor(rng.next() * 3), shuffled.length)
  const suspectSeats = shuffled.slice(0, numSuspects)

  return { possibilities, suspectSeats }
}

const PATTERNS: PatternType[] = ['roller', 'decision', 'designated', 'grayran', 'retar_suspect']
const PATTERN_WEIGHTS = [0.2, 0.15, 0.15, 0.2, 0.3]

function pickPattern(rng: Rng): PatternType {
  const r = rng.next()
  let cum = 0
  for (let i = 0; i < PATTERNS.length; i++) {
    cum += PATTERN_WEIGHTS[i]
    if (r < cum) return PATTERNS[i]
  }
  return PATTERNS[PATTERNS.length - 1]
}

/**
 * 教師データを一括生成する
 * @param count 生成するサンプル数
 * @param seed 乱数シード（再現性のため）
 */
export function generatePlanTrainingBatch(count: number, seed: number = 42): PlanTrainingSample[] {
  const rng = new Rng(seed)
  const samples: PlanTrainingSample[] = []

  while (samples.length < count) {
    // ランダムなゲーム状況
    const day = 2 + Math.floor(rng.next() * 4)  // day 2-5
    const aliveCount = 7 + Math.floor(rng.next() * 7)  // 7-13人生存
    const allSeats = Array.from({ length: SEATS }, (_, i) => i + 1)
    const aliveSeats = shuffleArray(allSeats, rng).slice(0, aliveCount)
    const mySeat = aliveSeats[Math.floor(rng.next() * aliveSeats.length)]
    const myRole = VILLAGE_ROLES[Math.floor(rng.next() * VILLAGE_ROLES.length)]

    // CO状況を生成
    const { claims, events } = generateCOSituation(aliveSeats, rng)

    // パターン選択
    const pattern = pickPattern(rng)

    // プランとラベルを生成
    const result = generatePlanAndLabel(pattern, claims, aliveSeats, mySeat, rng)
    if (!result) continue  // 条件に合わなければリトライ

    const { plan, label } = result

    // DecisionContext構築 → observation
    const ctx = buildSyntheticContext({
      day, mySeat, myRole, aliveSeats, events, plan, rng,
    })
    const observation = encodeObservation(ctx)
    const voteMask = maskVote(ctx)

    // ラベルの検証: マスクで無効な席のラベルが0であることを確認
    let valid = true
    for (let i = 0; i < SEATS; i++) {
      if (label[i] > 0 && voteMask[i] === -Infinity) {
        valid = false
        break
      }
    }
    if (!valid) continue

    samples.push({ observation, voteLabel: label, voteMask })
  }

  return samples
}

// ============================================================
// Pointer token 教師データ生成 (Step 4: 新アーキテクチャ用)
// ============================================================

export type PlanTokenTrainingSample = {
  observation: Float32Array
  /** Forward plan token labels: vocab index per token */
  forwardLabels: number[]    // [numForwardTokens]
  /** 各トークンが有効か (学習対象か) */
  forwardMask: boolean[]     // [numForwardTokens]
}

const NUM_FORWARD_TOKENS = 8

/**
 * パターンからForward plan tokenの教師ラベル列を生成
 * 語彙: 14 seats + 5 roles + grayran + next + stop = 22
 */
function patternToForwardLabels(
  pattern: PatternType,
  claims: Map<number, SystemRole>,
  aliveSeats: number[],
  mySeat: number,
  rng: Rng,
  suspectSeats?: number[],
): { labels: number[], mask: boolean[] } | null {
  const labels = new Array(NUM_FORWARD_TOKENS).fill(PLAN_VOCAB.STOP)
  const mask = new Array(NUM_FORWARD_TOKENS).fill(false)
  const claimants = [...claims.keys()].filter((s: number) => s !== mySeat)
  const claimedRole = claims.size > 0 ? [...claims.values()][0] : null

  // CO役職のvocab index
  const roleVocabIdx = claimedRole ? PLAN_VOCAB.ROLE_START + CO_ROLES.indexOf(claimedRole) : -1

  switch (pattern) {
    case 'roller': {
      // [role, next, role, stop, ...]
      if (claimants.length < 2 || roleVocabIdx < 0) return null
      let pos = 0
      labels[pos] = roleVocabIdx; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.NEXT; mask[pos++] = true
      labels[pos] = roleVocabIdx; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      return { labels, mask }
    }
    case 'decision': {
      // [role, stop, ...]
      if (claimants.length === 0 || roleVocabIdx < 0) return null
      let pos = 0
      labels[pos] = roleVocabIdx; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      return { labels, mask }
    }
    case 'designated': {
      // [seat_i, stop, ...]
      const candidates = aliveSeats.filter((s: number) => s !== mySeat)
      if (candidates.length === 0) return null
      const target = candidates[Math.floor(rng.next() * candidates.length)]
      let pos = 0
      labels[pos] = target - 1; mask[pos++] = true  // seat idx = seat - 1
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      return { labels, mask }
    }
    case 'grayran': {
      // [grayran, stop, ...]
      let pos = 0
      labels[pos] = PLAN_VOCAB.GRAYRAN; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      return { labels, mask }
    }
    case 'retar_suspect': {
      // Retar で狼候補の席を直接指定: [suspect_seat, stop, ...]
      if (!suspectSeats || suspectSeats.length === 0) return null
      const target = suspectSeats[Math.floor(rng.next() * suspectSeats.length)]
      if (target === mySeat) return null
      let pos = 0
      labels[pos] = target - 1; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      return { labels, mask }
    }
  }
}

/**
 * Pointer token 教師データを一括生成
 */
export function generatePlanTokenTrainingBatch(count: number, seed: number = 42): PlanTokenTrainingSample[] {
  const rng = new Rng(seed)
  const samples: PlanTokenTrainingSample[] = []

  while (samples.length < count) {
    const day = 2 + Math.floor(rng.next() * 4)
    const aliveCount = 7 + Math.floor(rng.next() * 7)
    const allSeats = Array.from({ length: SEATS }, (_, i) => i + 1)
    const aliveSeats = shuffleArray(allSeats, rng).slice(0, aliveCount)
    const mySeat = aliveSeats[Math.floor(rng.next() * aliveSeats.length)]
    const myRole = VILLAGE_ROLES[Math.floor(rng.next() * VILLAGE_ROLES.length)]

    const { claims, events } = generateCOSituation(aliveSeats, rng)
    const pattern = pickPattern(rng)

    // Retar 合成データ (retar_suspect パターン時は必須、他でも50%の確率で付与)
    const needsRetar = pattern === 'retar_suspect' || rng.next() < 0.5
    const retar = needsRetar ? generateSyntheticRetar(aliveSeats, mySeat, claims, rng) : null

    const result = patternToForwardLabels(pattern, claims, aliveSeats, mySeat, rng, retar?.suspectSeats)
    if (!result) continue

    // 旧形式のプランも生成（observation encodingで使用）
    const planResult = generatePlanAndLabel(
      pattern === 'retar_suspect' ? 'designated' : pattern,
      claims, aliveSeats, mySeat, rng,
    )
    const plan: ExecutionPlan = planResult?.plan ?? { targets: [], type: 'grayran' }

    const ctx = buildSyntheticContext({
      day, mySeat, myRole, aliveSeats, events, plan, rng,
      retarPossibilities: retar?.possibilities,
    })
    const observation = encodeObservation(ctx)

    samples.push({
      observation,
      forwardLabels: result.labels,
      forwardMask: result.mask,
    })
  }

  return samples
}
