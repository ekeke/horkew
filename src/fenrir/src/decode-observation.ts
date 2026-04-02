/**
 * Observation デコーダ
 *
 * encodeObservation() が生成する 1209 次元 Float32Array を
 * 人間可読な構造体に逆変換する。
 *
 * オフセット計算は observation.ts のセクションサイズ定数から再導出。
 */

import {
  SEATS, MAX_DAYS, HISTORY_WINDOW, NUM_ROLES,
  MAX_PLAN_TOKENS, PLAN_TOKEN_FEATURES,
} from './observation.ts'

import type { SystemRole } from '../../types/index.ts'

// observation.ts の ROLES 配列と同一（非export のためここに複製）
const ROLES: SystemRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  'werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist',
]

// ============================================================
// セクションサイズ（observation.ts と同一の算術）
// ============================================================

const GLOBAL_SIZE = 2 + 1 + NUM_ROLES + 1 + 1 + 1 + 1 + 1  // 19
const PER_SEAT_SIZE = 1 + (NUM_ROLES + 1) + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1  // 25
const SEAT_SECTION_SIZE = SEATS * PER_SEAT_SIZE  // 350
const PRIVATE_SIZE = SEATS + SEATS + 1 + SEATS + 1  // 43
const REVOTE_SIZE = 1 + SEATS  // 15
const HISTORY_DAY_SIZE = SEATS * 5  // 70
const HISTORY_SIZE = HISTORY_WINDOW * HISTORY_DAY_SIZE  // 210
const RETAR_POSSIBILITIES_SIZE = SEATS * NUM_ROLES  // 154
const GLOBAL_RETAR_SIZE = SEATS * NUM_ROLES  // 154
const PLAN_SIZE = SEATS * 2 + 3  // 31
const PLAN_APPROVED_SIZE = SEATS  // 14
const NEW_SIGNALS_PER_SEAT = 4
const NEW_SIGNALS_SIZE = SEATS * NEW_SIGNALS_PER_SEAT  // 56
const PLAN_TOKENS_COUNT_SIZE = 1
const PLAN_TOKENS_DATA_SIZE = MAX_PLAN_TOKENS * PLAN_TOKEN_FEATURES  // 160
const PLAN_TOKENS_SIZE = PLAN_TOKENS_COUNT_SIZE + PLAN_TOKENS_DATA_SIZE  // 161
// セクション開始オフセット
const GLOBAL_START = 0
const PER_SEAT_START = GLOBAL_SIZE
const PRIVATE_START = PER_SEAT_START + SEAT_SECTION_SIZE
const DIVINE_START = PRIVATE_START
const WOLF_TEAM_START = DIVINE_START + SEATS
const MASON_PARTNER_START = WOLF_TEAM_START + SEATS
const GUARD_HISTORY_START = MASON_PARTNER_START + 1
const KNOWN_HAMSTER_START = GUARD_HISTORY_START + SEATS
const REVOTE_START = PRIVATE_START + PRIVATE_SIZE
const HISTORY_START = REVOTE_START + REVOTE_SIZE
const RETAR_START = HISTORY_START + HISTORY_SIZE
const GLOBAL_RETAR_START = RETAR_START + RETAR_POSSIBILITIES_SIZE
const PLAN_START = GLOBAL_RETAR_START + GLOBAL_RETAR_SIZE
const PLAN_APPROVED_START = PLAN_START + PLAN_SIZE
const NEW_SIGNALS_START = PLAN_APPROVED_START + PLAN_APPROVED_SIZE
const PLAN_TOKENS_START = NEW_SIGNALS_START + NEW_SIGNALS_SIZE
const PLAN_TOKEN_DATA_START = PLAN_TOKENS_START + 1
const TSUMI_START = PLAN_TOKENS_START + PLAN_TOKENS_SIZE

// ============================================================
// 型定義
// ============================================================

export type DecodedGlobal = {
  day: number
  phase: 'night' | 'day'
  aliveRatio: number
  myRole: string
  commander: number | null
  progress: number
  demandWolfCoCount: number
  ropeMargin: number
  aliveParity: number
}

export type DecodedSeat = {
  seat: number
  alive: boolean
  claimedRole: string | null
  isMe: boolean
  blackCount: number
  whiteCount: number
  voteReceived: number
  suspicion: number
  trust: number
  executeProposal: number
  isCommander: boolean
  accuseWolf: number
  accuseFox: number
  voteIntent: number
  nominateCommander: number
  retarPossibilities: string[]
  globalRetarPossibilities: string[]
  planIncluded: boolean
  planPosition: number
  planApproved: number
  newSignals: { confirmHuman: number, confirmWolf: number, voteFor: number, voteAgainst: number }
}

export type DecodedPrivate = {
  divineResults: Array<{ seat: number, result: 'unknown' | 'human' | 'wolf' }>
  wolfTeammates: number[]
  masonPartner: number | null
  guardHistory: number[]
  knownHamster: number | null
}

export type DecodedRevote = {
  round: number
  candidates: number[]
}

export type DecodedHistoryDay = {
  window: number
  perSeat: Array<{
    seat: number
    votedFor: number
    executed: boolean
    killed: boolean
    claimed: boolean
    signaled: boolean
  }>
}

export type DecodedObservation = {
  global: DecodedGlobal
  seats: DecodedSeat[]
  private: DecodedPrivate
  revote: DecodedRevote
  history: DecodedHistoryDay[]
  planTokens: { count: number, tokens: Array<{ targetMask: number[], typeOneHot: number[], priority: number }> }
  tsumi: number | null
}

// ============================================================
// デコード関数
// ============================================================

export function decodeObservation(obs: Float32Array): DecodedObservation {
  // ---------- Global ----------
  let o = GLOBAL_START
  const dayNorm = obs[o++]
  const phaseVal = obs[o++]
  const aliveRatio = obs[o++]

  // my_role one-hot
  let myRoleIdx = 0
  let maxVal = -1
  for (let i = 0; i < NUM_ROLES; i++) {
    if (obs[o + i] > maxVal) { maxVal = obs[o + i]; myRoleIdx = i }
  }
  o += NUM_ROLES

  const commanderVal = obs[o++]
  const progress = obs[o++]
  const demandWolfCoNorm = obs[o++]
  const ropeMarginNorm = obs[o++]
  const aliveParity = obs[o++]

  const global: DecodedGlobal = {
    day: Math.round(dayNorm * MAX_DAYS),
    phase: phaseVal === 0 ? 'night' : 'day',
    aliveRatio,
    myRole: ROLES[myRoleIdx],
    commander: commanderVal > 0 ? Math.round(commanderVal * SEATS) : null,
    progress,
    demandWolfCoCount: Math.round(demandWolfCoNorm * 5),
    ropeMargin: ropeMarginNorm * SEATS,
    aliveParity,
  }

  // ---------- Per-seat ----------
  const seats: DecodedSeat[] = []
  for (let seat = 1; seat <= SEATS; seat++) {
    let s = PER_SEAT_START + (seat - 1) * PER_SEAT_SIZE

    const alive = obs[s++] > 0.5

    // claimed_role one-hot (11 roles + 1 none)
    let claimedIdx = -1
    let claimedMax = -1
    for (let i = 0; i < NUM_ROLES; i++) {
      if (obs[s + i] > claimedMax) { claimedMax = obs[s + i]; claimedIdx = i }
    }
    const noClaim = obs[s + NUM_ROLES]
    s += NUM_ROLES + 1

    const isMe = obs[s++] > 0.5
    const blackCount = obs[s++] * 3
    const whiteCount = obs[s++] * 3
    const voteReceived = obs[s++] * 10
    const suspicion = obs[s++] * 5
    const trust = obs[s++] * 5
    const executeProposal = obs[s++] * 5
    const isCommander = obs[s++] > 0.5
    const accuseWolf = obs[s++] * 5
    const accuseFox = obs[s++] * 5
    const voteIntent = obs[s++] * 5
    const nominateCommander = obs[s++] * 3

    // Retar possibilities
    const retarBase = RETAR_START + (seat - 1) * NUM_ROLES
    const retarPoss: string[] = []
    for (let i = 0; i < NUM_ROLES; i++) {
      if (obs[retarBase + i] > 0.5) retarPoss.push(ROLES[i])
    }

    const globalRetarBase = GLOBAL_RETAR_START + (seat - 1) * NUM_ROLES
    const globalRetarPoss: string[] = []
    for (let i = 0; i < NUM_ROLES; i++) {
      if (obs[globalRetarBase + i] > 0.5) globalRetarPoss.push(ROLES[i])
    }

    // Plan
    const planIncluded = obs[PLAN_START + (seat - 1)] > 0.5
    const planPosition = obs[PLAN_START + SEATS + (seat - 1)]

    // Plan approved
    const planApproved = obs[PLAN_APPROVED_START + (seat - 1)]

    // New signals
    const sigBase = NEW_SIGNALS_START + (seat - 1) * NEW_SIGNALS_PER_SEAT
    const newSignals = {
      confirmHuman: obs[sigBase + 0] * 5,
      confirmWolf: obs[sigBase + 1] * 5,
      voteFor: obs[sigBase + 2] * 5,
      voteAgainst: obs[sigBase + 3] * 5,
    }

    seats.push({
      seat, alive,
      claimedRole: noClaim > claimedMax ? null : ROLES[claimedIdx],
      isMe, blackCount, whiteCount, voteReceived,
      suspicion, trust, executeProposal, isCommander,
      accuseWolf, accuseFox, voteIntent, nominateCommander,
      retarPossibilities: retarPoss,
      globalRetarPossibilities: globalRetarPoss,
      planIncluded, planPosition, planApproved,
      newSignals,
    })
  }

  // ---------- Private ----------
  const divineResults: DecodedPrivate['divineResults'] = []
  for (let seat = 1; seat <= SEATS; seat++) {
    const val = obs[DIVINE_START + (seat - 1)]
    if (val > 0) {
      divineResults.push({ seat, result: val >= 0.75 ? 'wolf' : 'human' })
    }
  }

  const wolfTeammates: number[] = []
  for (let seat = 1; seat <= SEATS; seat++) {
    if (obs[WOLF_TEAM_START + (seat - 1)] > 0.5) wolfTeammates.push(seat)
  }

  const masonPartnerVal = obs[MASON_PARTNER_START]
  const masonPartner = masonPartnerVal > 0 ? Math.round(masonPartnerVal * SEATS) : null

  const guardHistory: number[] = []
  for (let seat = 1; seat <= SEATS; seat++) {
    if (obs[GUARD_HISTORY_START + (seat - 1)] > 0.5) guardHistory.push(seat)
  }

  const knownHamsterVal = obs[KNOWN_HAMSTER_START]
  const knownHamster = knownHamsterVal > 0 ? Math.round(knownHamsterVal * SEATS) : null

  // ---------- Revote ----------
  const revoteRound = obs[REVOTE_START] * 3
  const revoteCandidates: number[] = []
  for (let seat = 1; seat <= SEATS; seat++) {
    if (obs[REVOTE_START + 1 + (seat - 1)] > 0.5) revoteCandidates.push(seat)
  }

  // ---------- History ----------
  const history: DecodedHistoryDay[] = []
  for (let w = 0; w < HISTORY_WINDOW; w++) {
    const dayBase = HISTORY_START + w * HISTORY_DAY_SIZE
    const perSeat: DecodedHistoryDay['perSeat'] = []
    for (let seat = 1; seat <= SEATS; seat++) {
      const b = dayBase + (seat - 1) * 5
      perSeat.push({
        seat,
        votedFor: obs[b + 0] * SEATS,
        executed: obs[b + 1] > 0.5,
        killed: obs[b + 2] > 0.5,
        claimed: obs[b + 3] > 0.5,
        signaled: obs[b + 4] > 0.5,
      })
    }
    history.push({ window: w, perSeat })
  }

  // ---------- Plan tokens ----------
  const planCount = Math.round(obs[PLAN_TOKENS_START])
  const tokens: DecodedObservation['planTokens']['tokens'] = []
  for (let p = 0; p < Math.min(planCount, MAX_PLAN_TOKENS); p++) {
    const base = PLAN_TOKEN_DATA_START + p * PLAN_TOKEN_FEATURES
    const targetMask: number[] = []
    for (let i = 0; i < SEATS; i++) targetMask.push(obs[base + i])
    const typeOneHot: number[] = []
    for (let i = 0; i < 5; i++) typeOneHot.push(obs[base + SEATS + i])
    const priority = obs[base + SEATS + 5]
    tokens.push({ targetMask, typeOneHot, priority })
  }

  // ---------- Tsumi ----------
  const tsumiVal = obs[TSUMI_START]
  const tsumi = tsumiVal > 0 ? Math.round(tsumiVal * SEATS) : null

  return { global, seats, private: { divineResults, wolfTeammates, masonPartner, guardHistory, knownHamster }, revote: { round: revoteRound, candidates: revoteCandidates }, history, planTokens: { count: planCount, tokens }, tsumi }
}
