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

type PatternType = 'tsumi' | 'roller' | 'decision' | 'designated' | 'grayran' | 'retar_suspect'
  | 'multi_day_seats' | 'multi_day_mixed' | 'roller_then_seat'

/** パターンに応じてプランと正解ラベルを生成 */
function generatePlanAndLabel(
  pattern: PatternType,
  claims: Map<number, SystemRole>,
  aliveSeats: number[],
  mySeat: number,
  rng: Rng,
): { plan: ExecutionPlan, label: Float32Array, tsumiTarget?: number } | null {
  const label = new Float32Array(SEATS)
  const claimants = [...claims.keys()]
  const grays = aliveSeats.filter(s => s !== mySeat && !claims.has(s))

  switch (pattern) {
    case 'tsumi': {
      // 詰み: 自分以外のランダムな生存席を詰み対象に
      const candidates = aliveSeats.filter(s => s !== mySeat)
      if (candidates.length === 0) return null
      const target = candidates[Math.floor(rng.next() * candidates.length)]
      const plan: ExecutionPlan = { targets: [], type: 'grayran' }  // プランは空（tsumi優先）
      label[target - 1] = 1
      return { plan, label, tsumiTarget: target }
    }
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
    case 'multi_day_seats':
    case 'multi_day_mixed':
    case 'roller_then_seat':
      // これらは patternToForwardLabels 専用。旧形式では生成しない
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
  tsumiTarget?: number
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
    tsumiTarget: params.tsumiTarget ?? null,
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

const PATTERNS: PatternType[] = [
  'tsumi', 'roller', 'decision', 'designated', 'grayran', 'retar_suspect',
  'multi_day_seats', 'multi_day_mixed', 'roller_then_seat',
]
const PATTERN_WEIGHTS = [
  0.08, 0.10, 0.08, 0.08, 0.10, 0.16,
  0.15, 0.15, 0.10,
]

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

    // パターン選択（旧形式は vote label 対応パターンのみ）
    let pattern = pickPattern(rng)
    while (pattern === 'multi_day_seats' || pattern === 'multi_day_mixed' || pattern === 'roller_then_seat') {
      pattern = pickPattern(rng)
    }

    // プランとラベルを生成
    const result = generatePlanAndLabel(pattern, claims, aliveSeats, mySeat, rng)
    if (!result) continue  // 条件に合わなければリトライ

    const { plan, label, tsumiTarget } = result

    // DecisionContext構築 → observation
    const ctx = buildSyntheticContext({
      day, mySeat, myRole, aliveSeats, events, plan, rng,
      tsumiTarget,
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

/** STOP 以降の全位置を STOP + mask=true に強制。「STOP後はSTOP」を教える */
function fillStopPadding(labels: number[], mask: boolean[]): void {
  let seenStop = false
  for (let i = 0; i < labels.length; i++) {
    if (seenStop) {
      labels[i] = PLAN_VOCAB.STOP
      mask[i] = true
    }
    if (labels[i] === PLAN_VOCAB.STOP) seenStop = true
  }
}

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
): { labels: number[], mask: boolean[], tsumiTarget?: number } | null {
  const labels = new Array(NUM_FORWARD_TOKENS).fill(PLAN_VOCAB.STOP)
  const mask = new Array(NUM_FORWARD_TOKENS).fill(false)
  const claimants = [...claims.keys()].filter((s: number) => s !== mySeat)
  const claimedRole = claims.size > 0 ? [...claims.values()][0] : null

  // CO役職のvocab index
  const roleVocabIdx = claimedRole ? PLAN_VOCAB.ROLE_START + CO_ROLES.indexOf(claimedRole) : -1

  switch (pattern) {
    case 'tsumi': {
      // 詰み: [target_seat, stop, ...]
      const candidates = aliveSeats.filter((s: number) => s !== mySeat)
      if (candidates.length === 0) return null
      const target = candidates[Math.floor(rng.next() * candidates.length)]
      let pos = 0
      labels[pos] = target - 1; mask[pos++] = true  // seat idx = seat - 1
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      fillStopPadding(labels, mask)
      return { labels, mask, tsumiTarget: target }
    }
    case 'roller': {
      // [role, next, role, stop, ...]
      if (claimants.length < 2 || roleVocabIdx < 0) return null
      let pos = 0
      labels[pos] = roleVocabIdx; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.NEXT; mask[pos++] = true
      labels[pos] = roleVocabIdx; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      fillStopPadding(labels, mask)
      return { labels, mask }
    }
    case 'decision': {
      // [role, stop, ...]
      if (claimants.length === 0 || roleVocabIdx < 0) return null
      let pos = 0
      labels[pos] = roleVocabIdx; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      fillStopPadding(labels, mask)
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
      fillStopPadding(labels, mask)
      return { labels, mask }
    }
    case 'grayran': {
      // [grayran, stop, ...]
      let pos = 0
      labels[pos] = PLAN_VOCAB.GRAYRAN; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      fillStopPadding(labels, mask)
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
      fillStopPadding(labels, mask)
      return { labels, mask }
    }
    case 'multi_day_seats': {
      // 複数日の異なる席指定: [seat_a, NEXT, seat_b, NEXT, seat_c, STOP, ...]
      const candidates = aliveSeats.filter((s: number) => s !== mySeat)
      if (candidates.length < 2) return null
      const shuffled = shuffleArray(candidates, rng)
      const numDays = 2 + Math.floor(rng.next() * 2) // 2〜3日
      let pos = 0
      for (let d = 0; d < numDays && pos < NUM_FORWARD_TOKENS - 1; d++) {
        const target = shuffled[d % shuffled.length]
        labels[pos] = target - 1; mask[pos++] = true
        if (d < numDays - 1 && pos < NUM_FORWARD_TOKENS - 1) {
          labels[pos] = PLAN_VOCAB.NEXT; mask[pos++] = true
        }
      }
      if (pos < NUM_FORWARD_TOKENS) {
        labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      }
      fillStopPadding(labels, mask)
      return { labels, mask }
    }
    case 'multi_day_mixed': {
      // 席+役職+グレランの混合: [seat, NEXT, ROLE, NEXT, GRAYRAN, STOP, ...]
      const candidates = aliveSeats.filter((s: number) => s !== mySeat)
      if (candidates.length === 0) return null
      const grays = aliveSeats.filter(s => s !== mySeat && !claims.has(s))

      // 2〜3日分のターゲットをランダムに種別混合で生成
      type TokenGen = () => number
      const generators: TokenGen[] = []
      // seat
      generators.push(() => candidates[Math.floor(rng.next() * candidates.length)] - 1)
      // grayran
      if (grays.length > 0) generators.push(() => PLAN_VOCAB.GRAYRAN)
      // role (CO者がいれば)
      if (roleVocabIdx >= 0 && claimants.length > 0) generators.push(() => roleVocabIdx)

      const numDays = 2 + Math.floor(rng.next() * 2) // 2〜3日
      let pos = 0
      const usedTokens = new Set<number>()
      for (let d = 0; d < numDays && pos < NUM_FORWARD_TOKENS - 1; d++) {
        // ランダムに種別を選択（できれば重複を避ける）
        let token: number
        let attempts = 0
        do {
          const gen = generators[Math.floor(rng.next() * generators.length)]
          token = gen()
          attempts++
        } while (usedTokens.has(token) && attempts < 5)
        usedTokens.add(token)

        labels[pos] = token; mask[pos++] = true
        if (d < numDays - 1 && pos < NUM_FORWARD_TOKENS - 1) {
          labels[pos] = PLAN_VOCAB.NEXT; mask[pos++] = true
        }
      }
      if (pos < NUM_FORWARD_TOKENS) {
        labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      }
      fillStopPadding(labels, mask)
      return { labels, mask }
    }
    case 'roller_then_seat': {
      // ローラー後に席指定: [ROLE, NEXT, ROLE, NEXT, seat, STOP, ...]
      if (claimants.length < 2 || roleVocabIdx < 0) return null
      const grays = aliveSeats.filter(s => s !== mySeat && !claims.has(s))
      const afterRollerCandidates = grays.length > 0 ? grays : aliveSeats.filter(s => s !== mySeat)
      if (afterRollerCandidates.length === 0) return null

      let pos = 0
      // ローラー 2日分
      labels[pos] = roleVocabIdx; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.NEXT; mask[pos++] = true
      labels[pos] = roleVocabIdx; mask[pos++] = true
      labels[pos] = PLAN_VOCAB.NEXT; mask[pos++] = true
      // 3日目: 席指定 or グレラン
      if (rng.next() < 0.3 && grays.length > 0) {
        labels[pos] = PLAN_VOCAB.GRAYRAN; mask[pos++] = true
      } else {
        const target = afterRollerCandidates[Math.floor(rng.next() * afterRollerCandidates.length)]
        labels[pos] = target - 1; mask[pos++] = true
      }
      labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
      fillStopPadding(labels, mask)
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
      tsumiTarget: result.tsumiTarget,
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
