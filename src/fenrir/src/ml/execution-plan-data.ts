/**
 * 処刑プラン事前学習用の教師データ自動生成
 *
 * CO状況→処刑プラン→正解投票先のラベルを合成的に生成する。
 * パターン: ローラー(30%), 決め打ち(20%), 吊り先指定(20%), グレラン(30%)
 */

import type { DecisionContext, ExecutionPlan } from '../agents/agent.ts'
import type { SystemRole } from '../../../types/index.ts'
import type { GameEvent } from '../../../lupa/types.ts'
import { resolveRules } from '../../../howl/ruleset.ts'
import { Rng } from '../../../lupa/random.ts'
import { encodeObservation, SEATS, CO_ROLES } from '../observation.ts'
import { maskVote } from '../action.ts'
import { PLAN_VOCAB } from '../plan/plan-vocab.ts'

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

const ALL_ROLES: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'werewolf', 'fanatic', 'werehamster', 'immoralist']
const VILLAGE_ONLY: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata']
const WOLF_NO_FOX: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'werewolf', 'fanatic']
const FOX_NO_WOLF: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'werehamster', 'immoralist']

/**
 * 合成 Retar possibilities を生成
 * 席を4種に分類: 確定白 / 狐可能(狼不可) / 狼可能(狐不可) / 両方可能
 * foxSeats: 狐可能席、wolfSeats: 狼可能席（狐含まない）
 */
function generateSyntheticRetar(
  aliveSeats: number[],
  mySeat: number,
  claims: Map<number, SystemRole>,
  rng: Rng,
): { possibilities: Map<number, Set<SystemRole>>, foxSeats: number[], wolfSeats: number[] } {
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

  // 残りの席を分類
  const foxSeats: number[] = []
  const wolfSeats: number[] = []
  const remaining = aliveSeats.filter(s => !confirmedWhites.has(s))
  const shuffled = shuffleArray(remaining, rng)

  // 30% の確率で狐/狼分離あり、70% は全員 ALL_ROLES
  const hasFoxWolfSplit = rng.next() < 0.3 && shuffled.length >= 3

  if (hasFoxWolfSplit) {
    // 1〜2 席を狐可能(狼不可)に
    const numFoxOnly = 1 + Math.floor(rng.next() * Math.min(2, shuffled.length - 1))
    for (let i = 0; i < shuffled.length; i++) {
      const seat = shuffled[i]
      if (i < numFoxOnly) {
        possibilities.set(seat, new Set(FOX_NO_WOLF))
        foxSeats.push(seat)
      } else if (rng.next() < 0.3) {
        // 一部を狼可能(狐不可)に
        possibilities.set(seat, new Set(WOLF_NO_FOX))
        wolfSeats.push(seat)
      } else {
        // 両方可能
        possibilities.set(seat, new Set(ALL_ROLES))
        foxSeats.push(seat)
        wolfSeats.push(seat)
      }
    }
  } else {
    // 全員 ALL_ROLES（狐も狼も可能）
    for (const seat of shuffled) {
      possibilities.set(seat, new Set(ALL_ROLES))
      foxSeats.push(seat)
      wolfSeats.push(seat)
    }
  }

  return { possibilities, foxSeats, wolfSeats }
}

const PATTERNS: PatternType[] = [
  'tsumi', 'roller', 'decision', 'designated', 'grayran', 'retar_suspect',
  'multi_day_seats', 'multi_day_mixed', 'roller_then_seat',
]
const PATTERN_WEIGHTS = [
  0.06, 0.08, 0.06, 0.06, 0.08, 0.12,  // single-day: 46%
  0.18, 0.18, 0.18,                      // multi-day (NEXT): 54%
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
  /** Endgame plan token labels: vocab index per token */
  endgameLabels: number[]    // [numEndgameTokens]
  /** 各トークンが有効か (学習対象か) */
  endgameMask: boolean[]     // [numEndgameTokens]
}

const NUM_FORWARD_TOKENS = 8
const NUM_ENDGAME_TOKENS = 4

/**
 * 最初の STOP の直後 1 トークンだけ mask=true + label=STOP に設定。
 * 「STOP の次も STOP」を教えるが、全パディングを mask すると
 * STOP が過剰になり position 0 まで STOP を出すように崩壊する。
 */
function fillStopPadding(labels: number[], mask: boolean[]): void {
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === PLAN_VOCAB.STOP) {
      // 次の位置だけ STOP を強制
      if (i + 1 < labels.length) {
        labels[i + 1] = PLAN_VOCAB.STOP
        mask[i + 1] = true
      }
      break
    }
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
 * 人外候補を NEXT 区切りで列挙する plan token 列を生成。
 * 狐候補を先に、狼候補を後に配置（狐→狼の処刑順序を教える）。
 */
function buildSuspectLabels(
  foxSeats: number[],
  wolfSeats: number[],
  numTokens: number,
  rng: Rng,
): { labels: number[], mask: boolean[] } {
  // 狐候補 → 狼候補（狐にいない席のみ）の順で連結
  const foxSet = new Set(foxSeats)
  const wolfOnly = wolfSeats.filter(s => !foxSet.has(s))
  const ordered = [...shuffleArray(foxSeats, rng), ...shuffleArray(wolfOnly, rng)]

  if (ordered.length === 0) {
    return { labels: new Array(numTokens).fill(PLAN_VOCAB.STOP), mask: new Array(numTokens).fill(false) }
  }

  // n席 = n + (n-1) + 1 = 2n トークン → 最大 n = floor(numTokens / 2)
  const maxTargets = Math.min(ordered.length, Math.floor(numTokens / 2))
  const numTargets = Math.max(1, Math.ceil(rng.next() * maxTargets))
  const targets = ordered.slice(0, numTargets)

  const labels = new Array(numTokens).fill(PLAN_VOCAB.STOP)
  const mask = new Array(numTokens).fill(false)
  let pos = 0
  for (let i = 0; i < targets.length && pos < numTokens - 1; i++) {
    labels[pos] = targets[i] - 1; mask[pos++] = true
    if (i < targets.length - 1 && pos < numTokens - 1) {
      labels[pos] = PLAN_VOCAB.NEXT; mask[pos++] = true
    }
  }
  if (pos < numTokens) {
    labels[pos] = PLAN_VOCAB.STOP; mask[pos++] = true
  }
  fillStopPadding(labels, mask)
  return { labels, mask }
}

/**
 * 人外候補列挙 pretrain: Retar の狼可能席をなるべく多く plan token で指定する。
 * observation 内の Retar 情報を読んで人外候補を列挙する能力を教える。
 *
 * forward (8トークン): 通常盤面 (7〜13人生存)、最大4席
 * endgame (4トークン): 終盤盤面 (4〜6人生存)、最大2席
 */
export function generatePlanTokenTrainingBatch(
  count: number,
  seed: number = 42,
  tsumiSamples?: PlanTokenTrainingSample[],
  tsumiRatio: number = 0,
): PlanTokenTrainingSample[] {
  const rng = new Rng(seed)
  const samples: PlanTokenTrainingSample[] = []

  while (samples.length < count) {
    // tsumi サンプルを混合
    if (tsumiSamples && tsumiSamples.length > 0 && rng.next() < tsumiRatio) {
      const idx = Math.floor(rng.next() * tsumiSamples.length)
      samples.push(tsumiSamples[idx])
      continue
    }
    const day = 2 + Math.floor(rng.next() * 4)
    // forward 用は通常盤面、endgame 用は終盤盤面を別々に生成
    const fwdAliveCount = 7 + Math.floor(rng.next() * 7)  // 7-13人
    const egAliveCount = 4 + Math.floor(rng.next() * 3)   // 4-6人
    const allSeats = Array.from({ length: SEATS }, (_, i) => i + 1)

    // Forward 盤面
    const fwdAliveSeats = shuffleArray(allSeats, rng).slice(0, fwdAliveCount)
    const fwdMySeat = fwdAliveSeats[Math.floor(rng.next() * fwdAliveSeats.length)]
    const fwdMyRole = VILLAGE_ROLES[Math.floor(rng.next() * VILLAGE_ROLES.length)]
    const fwdCO = generateCOSituation(fwdAliveSeats, rng)
    const fwdRetar = generateSyntheticRetar(fwdAliveSeats, fwdMySeat, fwdCO.claims, rng)
    const fwdFox = fwdRetar.foxSeats.filter(s => s !== fwdMySeat)
    const fwdWolf = fwdRetar.wolfSeats.filter(s => s !== fwdMySeat)
    if (fwdFox.length === 0 && fwdWolf.length === 0) continue

    // パターン混合: role tokens (roller, decision等) と seat tokens (suspect列挙) を両方教える
    const pattern = pickPattern(rng)
    const suspectSeats = [...fwdFox, ...fwdWolf.filter(s => !fwdFox.includes(s))]
    const patternResult = patternToForwardLabels(pattern, fwdCO.claims, fwdAliveSeats, fwdMySeat, rng, suspectSeats)
    const fwd = patternResult ?? buildSuspectLabels(fwdFox, fwdWolf, NUM_FORWARD_TOKENS, rng)

    // Endgame 盤面（別の盤面で生成）
    const egAliveSeats = shuffleArray(allSeats, rng).slice(0, egAliveCount)
    const egMySeat = egAliveSeats[Math.floor(rng.next() * egAliveSeats.length)]
    const egCO = generateCOSituation(egAliveSeats, rng)
    const egRetar = generateSyntheticRetar(egAliveSeats, egMySeat, egCO.claims, rng)
    const egFox = egRetar.foxSeats.filter(s => s !== egMySeat)
    const egWolf = egRetar.wolfSeats.filter(s => s !== egMySeat)
    const eg = (egFox.length > 0 || egWolf.length > 0)
      ? buildSuspectLabels(egFox, egWolf, NUM_ENDGAME_TOKENS, rng)
      : { labels: new Array(NUM_ENDGAME_TOKENS).fill(PLAN_VOCAB.STOP), mask: new Array(NUM_ENDGAME_TOKENS).fill(false) }

    // observation は forward 盤面から生成
    const plan: ExecutionPlan = { targets: [], type: 'grayran' }
    const ctx = buildSyntheticContext({
      day, mySeat: fwdMySeat, myRole: fwdMyRole, aliveSeats: fwdAliveSeats,
      events: fwdCO.events, plan, rng,
      retarPossibilities: fwdRetar.possibilities,
    })
    const observation = encodeObservation(ctx)

    samples.push({
      observation,
      forwardLabels: fwd.labels,
      forwardMask: fwd.mask,
      endgameLabels: eg.labels,
      endgameMask: eg.mask,
    })
  }

  return samples
}
