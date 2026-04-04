/**
 * 観測ベクトルエンコーダ
 *
 * DecisionContextから固定長のFloat32Arrayを構築する。
 * 情報隔壁: gameState.players[].roleは直接参照しない。
 * 初期知識はDecisionContextの専用フィールド(wolfTeammates, knownWolves, knownHamster)経由で取得。
 * 公開情報(publicEvents, signals)と自分の秘密情報(myPlayer)のみからエンコード。
 */

import type { DecisionContext, TeamDecisionContext } from './agents/agent.ts'
import type { SystemRole } from '../../types/index.ts'
import type { FenrirEvent } from './events.ts'


/** 14D猫専用: 席数固定 */
export const SEATS = 14
/** @deprecated MAX_SEATS は SEATS に移行中 */
export const MAX_SEATS = SEATS
export const MAX_DAYS = 50
export const HISTORY_WINDOW = 3

// 役職インデックス
const ROLES: SystemRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  'werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist',
]
export const ROLE_INDEX = new Map(ROLES.map((r, i) => [r, i]))
export const NUM_ROLES = ROLES.length

/** 全席の実際の役職をone-hotエンコード (SEATS × NUM_ROLES = 154次元) */
export function encodeTrueRoles(players: Array<{ seat: number, role: string }>): Float32Array {
  const result = new Float32Array(SEATS * NUM_ROLES)
  for (const player of players) {
    const rIdx = ROLE_INDEX.get(player.role as SystemRole)
    if (rIdx !== undefined && player.seat >= 1 && player.seat <= SEATS) {
      result[(player.seat - 1) * NUM_ROLES + rIdx] = 1
    }
  }
  return result
}

// セクションサイズ
const GLOBAL_SIZE = 2 + 1 + NUM_ROLES + 1 + 1 + 1 + 1 + 1  // day, phase, alive_ratio, role_onehot, commander, progress, demand_wolf_co_count, rope_margin, alive_parity = 19
const PER_SEAT_SIZE = 1 + (NUM_ROLES + 1) + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 // alive, claimed_role, is_me, black_count, white_count, vote_received, suspicion, trust, execute_proposal, is_commander, accuse_wolf, accuse_fox, vote_intent, nominate_commander = 25
const SEAT_SECTION_SIZE = SEATS * PER_SEAT_SIZE  // 336
const PRIVATE_SIZE = SEATS + SEATS + 1 + SEATS + 1  // divine_results + wolf_teammates + mason_partner + guard_history + known_hamster = 43
const REVOTE_SIZE = 1 + SEATS  // revote_round + revote_candidates_mask = 15
const HISTORY_DAY_SIZE = SEATS * 5  // per day: voted_for, executed, killed, claimed, signaled = 70
const HISTORY_SIZE = HISTORY_WINDOW * HISTORY_DAY_SIZE  // 210

// Retar可能性: per-seat × roles (0/1)
const RETAR_POSSIBILITIES_SIZE = SEATS * NUM_ROLES  // 154
// グローバルRetar: 公開情報のみで計算した可能性 (Step 6)
const GLOBAL_RETAR_SIZE = SEATS * NUM_ROLES  // 154
// 騙り前提Retar: 廃止 — 村NN出力注入で代替（Architecture.md参照）

// プラン賛否: per-seat (Step 6)
const PLAN_APPROVED_SIZE = SEATS  // 14
// 新シグナル: per-seat × 4 (confirm_human, confirm_wolf, vote_for, vote_against) (Step 6)
const NEW_SIGNALS_PER_SEAT = 4
const NEW_SIGNALS_SIZE = SEATS * NEW_SIGNALS_PER_SEAT  // 56

// Raw plan token indices: forward(8) + endgame(4) vocab indices (0-21)
/** forward plan token 数 */
export const NUM_PLAN_FORWARD = 8
/** endgame plan token 数 */
export const NUM_PLAN_ENDGAME = 4
const RAW_PLAN_SIZE = NUM_PLAN_FORWARD + NUM_PLAN_ENDGAME  // 12

// 詰み情報: tsumi_target_seat スカラー (0=詰みなし, seat/SEATS=詰み対象席)
const TSUMI_SIZE = 1

export const OBSERVATION_SIZE = GLOBAL_SIZE + SEAT_SECTION_SIZE + PRIVATE_SIZE + REVOTE_SIZE + HISTORY_SIZE + RETAR_POSSIBILITIES_SIZE + GLOBAL_RETAR_SIZE + PLAN_APPROVED_SIZE + NEW_SIGNALS_SIZE + RAW_PLAN_SIZE + TSUMI_SIZE

// ============================================================
// Transformer用トークン化
// ============================================================

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
const REVOTE_ROUND_START = REVOTE_START
const REVOTE_CANDIDATES_START = REVOTE_START + 1
const HISTORY_START = REVOTE_START + REVOTE_SIZE
const RETAR_START = HISTORY_START + HISTORY_SIZE
const GLOBAL_RETAR_START = RETAR_START + RETAR_POSSIBILITIES_SIZE
const PLAN_APPROVED_START = GLOBAL_RETAR_START + GLOBAL_RETAR_SIZE
const NEW_SIGNALS_START = PLAN_APPROVED_START + PLAN_APPROVED_SIZE

// Raw plan token indices セクション
export const RAW_PLAN_START = NEW_SIGNALS_START + NEW_SIGNALS_SIZE

// 詰みセクション
const TSUMI_START = RAW_PLAN_START + RAW_PLAN_SIZE

// チーム拡張オフセット (OBSERVATION_SIZE基準)
const TEAM_SIZE_START = OBSERVATION_SIZE
const TEAM_IS_MY_TEAM_START = TEAM_SIZE_START + 1
const TEAM_IS_CURRENT_ACTOR_START = TEAM_IS_MY_TEAM_START + SEATS
const TEAM_FAKE_DIVINE_START = TEAM_IS_CURRENT_ACTOR_START + SEATS

// トークン特徴量次元
/** CLSトークンの特徴量次元 (individual) */
export const CLS_FEATURES = 23  // global(19) + mason_partner(1) + known_hamster(1) + revote_round(1) + tsumi(1)
/** CLSトークンの特徴量次元 (team) */
export const TEAM_CLS_FEATURES = 24  // CLS_FEATURES + team_size(1)
/** 席トークンの特徴量次元 (individual) */
export const SEAT_TOKEN_FEATURES = 71  // per_seat(25) + private(4) + history(15) + retar(11) + globalRetar(11) + plan_approved(1) + new_signals(4)
/** 席トークンの特徴量次元 (team) */
export const TEAM_SEAT_TOKEN_FEATURES = 74  // SEAT_TOKEN_FEATURES + team(3)

/** CO可能役職 (Role token対象) */
export const CO_ROLES: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']
/** Role token数 */
export const NUM_ROLE_TOKENS = CO_ROLES.length  // 5
/** Role tokenの特徴量次元: co_count(1) + co_seats(14) = 15 */
export const ROLE_TOKEN_FEATURES = 1 + SEATS  // 15

/** トークン化されたobservation */
export type TokenizedObservation = {
  /** CLSトークン [clsFeatures] */
  cls: Float32Array
  /** 席トークン [SEATS * seatFeatures] — flat, stride = seatFeatures */
  seats: Float32Array
  /** Forward plan token raw indices [NUM_PLAN_FORWARD] (vocab 0-21) */
  planForward: Float32Array
  /** Endgame plan token raw indices [NUM_PLAN_ENDGAME] (vocab 0-21) */
  planEndgame: Float32Array
  /** Role tokens [NUM_ROLE_TOKENS * ROLE_TOKEN_FEATURES] — flat */
  roles: Float32Array
  /** 席特徴量次元 */
  seatFeatures: number
  /** CLS特徴量次元 */
  clsFeatures: number
}

/** 観測モード */
export type ObservationMode = 'individual' | 'team' | 'wolf_collective' | 'mason_collective' | 'fanatic'

/**
 * フラットobservationをTransformer用トークンに分割
 * @param obs フラットobservation
 * @param mode 観測モード (default: 'individual')。後方互換のためbooleanも受付（true='team', false='individual'）
 */
export function tokenize(obs: Float32Array, mode: ObservationMode | boolean = 'individual'): TokenizedObservation {
  // 後方互換: boolean → mode
  if (typeof mode === 'boolean') mode = mode ? 'team' : 'individual'
  const sf = mode === 'wolf_collective' ? WOLF_COLLECTIVE_SEAT_FEATURES
    : mode === 'mason_collective' ? MASON_COLLECTIVE_SEAT_FEATURES
    : mode === 'fanatic' ? FANATIC_SEAT_FEATURES
    : mode === 'team' ? TEAM_SEAT_TOKEN_FEATURES
    : SEAT_TOKEN_FEATURES
  const cf = mode === 'wolf_collective' ? WOLF_COLLECTIVE_CLS_FEATURES
    : mode === 'mason_collective' ? MASON_COLLECTIVE_CLS_FEATURES
    : mode === 'fanatic' ? FANATIC_CLS_FEATURES
    : mode === 'team' ? TEAM_CLS_FEATURES
    : CLS_FEATURES
  const isTeam = mode === 'team'

  const cls = new Float32Array(cf)
  const seats = new Float32Array(SEATS * sf)

  // ========== CLS token ==========
  let co = 0
  // global features (19)
  for (let i = 0; i < GLOBAL_SIZE; i++) cls[co++] = obs[GLOBAL_START + i]
  // mason_partner (1)
  cls[co++] = obs[MASON_PARTNER_START]
  // known_hamster (1)
  cls[co++] = obs[KNOWN_HAMSTER_START]
  // revote_round (1)
  cls[co++] = obs[REVOTE_ROUND_START]
  // tsumi is_tsumi (1)
  cls[co++] = obs[TSUMI_START]
  // team/collective extension
  if (isTeam) {
    cls[co++] = obs[TEAM_SIZE_START]
  } else if (mode === 'wolf_collective' || mode === 'mason_collective') {
    cls[co++] = obs[COLLECTIVE_TEAM_SIZE_START]
  }

  // ========== Seat tokens ==========
  for (let s = 0; s < SEATS; s++) {
    let so = s * sf

    // per_seat features (25)
    const psOff = PER_SEAT_START + s * PER_SEAT_SIZE
    for (let i = 0; i < PER_SEAT_SIZE; i++) seats[so++] = obs[psOff + i]

    // private per-seat (4)
    seats[so++] = obs[DIVINE_START + s]
    seats[so++] = obs[WOLF_TEAM_START + s]
    seats[so++] = obs[GUARD_HISTORY_START + s]
    seats[so++] = obs[REVOTE_CANDIDATES_START + s]

    // history (3 windows × 5 features = 15)
    for (let w = 0; w < HISTORY_WINDOW; w++) {
      const hOff = HISTORY_START + w * HISTORY_DAY_SIZE + s * 5
      for (let i = 0; i < 5; i++) seats[so++] = obs[hOff + i]
    }

    // retar possibilities (11) — 自分視点
    const rOff = RETAR_START + s * NUM_ROLES
    for (let i = 0; i < NUM_ROLES; i++) seats[so++] = obs[rOff + i]

    // global retar possibilities (11) — 公開情報のみ
    const grOff = GLOBAL_RETAR_START + s * NUM_ROLES
    for (let i = 0; i < NUM_ROLES; i++) seats[so++] = obs[grOff + i]

    // plan_approved (1)
    seats[so++] = obs[PLAN_APPROVED_START + s]

    // new signals (4): confirm_human, confirm_wolf, vote_for, vote_against
    const nsOff = NEW_SIGNALS_START + s * NEW_SIGNALS_PER_SEAT
    for (let i = 0; i < NEW_SIGNALS_PER_SEAT; i++) seats[so++] = obs[nsOff + i]

    // team extension per-seat (3)
    if (isTeam) {
      seats[so++] = obs[TEAM_IS_MY_TEAM_START + s]
      seats[so++] = obs[TEAM_IS_CURRENT_ACTOR_START + s]
      seats[so++] = obs[TEAM_FAKE_DIVINE_START + s]
    }

    // wolf collective extension per-seat (+13: village_predict(11) + village_trust(1) + fake_divine(1))
    if (mode === 'wolf_collective') {
      const vpOff = WOLF_VILLAGE_PREDICT_START + s * NUM_ROLES
      for (let i = 0; i < NUM_ROLES; i++) seats[so++] = obs[vpOff + i]
      seats[so++] = obs[WOLF_VILLAGE_TRUST_START + s]
      seats[so++] = obs[WOLF_FAKE_DIVINE_START + s]
    }

    // fanatic extension per-seat (+12: village_predict(11) + village_trust(1))
    if (mode === 'fanatic') {
      const vpOff = FANATIC_VILLAGE_PREDICT_START + s * NUM_ROLES
      for (let i = 0; i < NUM_ROLES; i++) seats[so++] = obs[vpOff + i]
      seats[so++] = obs[FANATIC_VILLAGE_TRUST_START + s]
    }
  }

  // ========== Raw plan indices ==========
  const planForward = new Float32Array(NUM_PLAN_FORWARD)
  for (let i = 0; i < NUM_PLAN_FORWARD; i++) planForward[i] = obs[RAW_PLAN_START + i]
  const planEndgame = new Float32Array(NUM_PLAN_ENDGAME)
  for (let i = 0; i < NUM_PLAN_ENDGAME; i++) planEndgame[i] = obs[RAW_PLAN_START + NUM_PLAN_FORWARD + i]

  // ========== Role tokens ==========
  // CO可能5役職それぞれについて、seat tokensのclaimed_roleからCO者情報を集約
  // claimed_role one-hot は各seat token内のoffset 1..11 (PER_SEAT_SIZE = 25, claimed_role starts at index 1)
  const roles = new Float32Array(NUM_ROLE_TOKENS * ROLE_TOKEN_FEATURES)
  for (let ri = 0; ri < NUM_ROLE_TOKENS; ri++) {
    const roleIdx = ROLE_INDEX.get(CO_ROLES[ri])!
    const ro = ri * ROLE_TOKEN_FEATURES
    let coCount = 0
    for (let s = 0; s < SEATS; s++) {
      // claimed_role one-hot: seat token offset 1 + roleIdx
      const claimedVal = seats[s * sf + 1 + roleIdx]
      if (claimedVal > 0) {
        coCount++
        roles[ro + 1 + s] = 1  // co_seats[s] = 1
      }
    }
    roles[ro] = coCount / SEATS  // co_count normalized
  }

  return {
    cls,
    seats,
    planForward,
    planEndgame,
    roles,
    seatFeatures: sf,
    clsFeatures: cf,
  }
}

// ============================================================
// Observation 中間データ型
// ============================================================

/** per-seat の公開情報（イベントから収集） */
export type SeatPublicData = {
  alive: boolean
  claimedRole: SystemRole | undefined
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
  /** plan 賛否 (agree - disagree) */
  planApproved: number
  /** 新シグナル: 人間確認、狼確認、投票先、投票反対 */
  confirmHuman: number
  confirmWolf: number
  voteFor: number
  voteAgainst: number
}

/**
 * encodeObservation の中間データ。この型を見れば observation の内容が分かる。
 * JSON-serializable: inspect データとしてそのまま出力可能。
 */
export type CollectedObservation = {
  global: {
    day: number
    phase: 'night' | 'day'
    aliveCount: number
    myRole: SystemRole
    commander: number | null
    demandWolfCoCount: number
    /** 縄余裕 = 残り処刑回数 - maxSurvivingNV（null = Retar 未実行） */
    ropeMargin: number | null
    aliveParity: number
  }
  /** 14席分の公開情報 (index 0 = seat 1) */
  seats: SeatPublicData[]
  private: {
    /** 占い結果: [seat, human/wolf] (占い師のみ) */
    divineResults: Array<[number, 'human' | 'wolf']>
    /** 人狼の仲間 or 狂信者が知る狼の席 */
    wolfTeamSeats: number[]
    masonPartner: number | null
    /** 護衛済み席 (狩人のみ) */
    guardedSeats: number[]
    knownHamster: number | null
  }
  revote: {
    round: number
    candidates: number[]
  }
  /** 直近3日分の履歴: per-window, per-seat の [votedFor, executed, killed, claimed, signaled] */
  history: number[]
  retar: {
    /** seat(string key) → 可能役職リスト */
    self: Record<string, SystemRole[]> | null
    global: Record<string, SystemRole[]> | null
  }
  plan: {
    forwardIndices: number[] | null
    endgameIndices: number[] | null
  }
  tsumiTarget: number | null
}

/** Map<number, Set<SystemRole>> → Record<string, SystemRole[]> (JSON-serializable) */
function mapOfSetsToRecord(
  map: Map<number, Set<SystemRole>> | null | undefined,
): Record<string, SystemRole[]> | null {
  if (!map) return null
  const rec: Record<string, SystemRole[]> = {}
  for (const [seat, roles] of map) {
    rec[String(seat)] = [...roles]
  }
  return rec
}

// ============================================================
// 意味的な収集
// ============================================================

/** DecisionContext から意味的なデータを収集（ドメインロジック） */
export function collectObservation(ctx: DecisionContext): CollectedObservation {
  const events = ctx.publicEvents as readonly FenrirEvent[]
  const aliveSet = new Set(ctx.alivePlayers)

  // per-seat カウンタ（イベント1回走査で全部集める）
  const claimedRoles = new Map<number, SystemRole>()
  const blackCounts = new Map<number, number>()
  const whiteCounts = new Map<number, number>()
  const voteCounts = new Map<number, number>()
  const suspicionCounts = new Map<number, number>()
  const trustCounts = new Map<number, number>()
  const executeCounts = new Map<number, number>()
  const accuseWolfCounts = new Map<number, number>()
  const accuseFoxCounts = new Map<number, number>()
  const voteIntentCounts = new Map<number, number>()
  const nominateCommanderCounts = new Map<number, number>()
  const agreeCounts = new Map<number, number>()
  const disagreeCounts = new Map<number, number>()
  const confirmHumanCounts = new Map<number, number>()
  const confirmWolfCounts = new Map<number, number>()
  const voteForCounts = new Map<number, number>()
  const voteAgainstCounts = new Map<number, number>()
  let demandWolfCoCount = 0

  // 履歴: 直近3日分
  const history = new Float32Array(HISTORY_SIZE)
  const currentDay = ctx.day

  for (const event of events) {
    switch (event.type) {
      case 'seer_claim':
        claimedRoles.set(event.actor, 'seer')
        for (const r of event.results) {
          if (r.result === 'wolf') blackCounts.set(r.target, (blackCounts.get(r.target) ?? 0) + 1)
          else whiteCounts.set(r.target, (whiteCounts.get(r.target) ?? 0) + 1)
        }
        break
      case 'seer_result':
        if (event.result === 'wolf') blackCounts.set(event.target, (blackCounts.get(event.target) ?? 0) + 1)
        else whiteCounts.set(event.target, (whiteCounts.get(event.target) ?? 0) + 1)
        break
      case 'medium_claim': claimedRoles.set(event.actor, 'medium'); break
      case 'bodyguard_claim': claimedRoles.set(event.actor, 'bodyguard'); break
      case 'mason_claim': claimedRoles.set(event.actor, 'mason'); break
      case 'nekomata_claim': claimedRoles.set(event.actor, 'nekomata'); break
      case 'wolf_claim': claimedRoles.set(event.actor, event.claimedRole); break
      case 'vote':
        voteCounts.set(event.target, (voteCounts.get(event.target) ?? 0) + 1)
        break
      case 'signal': {
        const sig = event.signal
        if (sig.type === 'demand_wolf_co') { demandWolfCoCount++; break }
        if ('target' in sig) {
          const t = sig.target
          switch (sig.type) {
            case 'suspicion': suspicionCounts.set(t, (suspicionCounts.get(t) ?? 0) + 1); break
            case 'trust': trustCounts.set(t, (trustCounts.get(t) ?? 0) + 1); break
            case 'accuse_wolf': accuseWolfCounts.set(t, (accuseWolfCounts.get(t) ?? 0) + 1); break
            case 'accuse_fox': accuseFoxCounts.set(t, (accuseFoxCounts.get(t) ?? 0) + 1); break
            case 'vote_intent': voteIntentCounts.set(t, (voteIntentCounts.get(t) ?? 0) + 1); break
            case 'nominate_commander': nominateCommanderCounts.set(t, (nominateCommanderCounts.get(t) ?? 0) + 1); break
            case 'agree': agreeCounts.set(t, (agreeCounts.get(t) ?? 0) + 1); break
            case 'disagree': disagreeCounts.set(t, (disagreeCounts.get(t) ?? 0) + 1); break
            case 'confirm_human': confirmHumanCounts.set(t, (confirmHumanCounts.get(t) ?? 0) + 1); break
            case 'confirm_wolf': confirmWolfCounts.set(t, (confirmWolfCounts.get(t) ?? 0) + 1); break
            case 'vote_for': voteForCounts.set(t, (voteForCounts.get(t) ?? 0) + 1); break
            case 'vote_against': voteAgainstCounts.set(t, (voteAgainstCounts.get(t) ?? 0) + 1); break
          }
        }
        break
      }
      case 'execute_proposals':
        for (const t of event.targets) executeCounts.set(t, (executeCounts.get(t) ?? 0) + 1)
        break
    }

    // 履歴 (直近3日分) — 同じイベントループ内で処理
    for (let w = 0; w < HISTORY_WINDOW; w++) {
      const histDay = currentDay - HISTORY_WINDOW + w + 1
      if (histDay < 1) continue
      const dayBase = w * HISTORY_DAY_SIZE
      switch (event.type) {
        case 'vote': {
          const slot = event.voter - 1
          if (slot >= 0 && slot < SEATS) history[dayBase + slot * 5 + 0] = event.target / SEATS
          break
        }
        case 'execution': {
          const slot = event.target - 1
          if (slot >= 0 && slot < SEATS) history[dayBase + slot * 5 + 1] = 1
          break
        }
        case 'night_kill':
        case 'fox_kill': {
          const slot = event.target - 1
          if (slot >= 0 && slot < SEATS) history[dayBase + slot * 5 + 2] = 1
          break
        }
        case 'seer_claim':
        case 'medium_claim':
        case 'bodyguard_claim':
        case 'mason_claim':
        case 'nekomata_claim': {
          const slot = event.actor - 1
          if (slot >= 0 && slot < SEATS) history[dayBase + slot * 5 + 3] = 1
          break
        }
        case 'signal': {
          const slot = event.actor - 1
          if (slot >= 0 && slot < SEATS) history[dayBase + slot * 5 + 4] = 1
          break
        }
      }
    }
  }

  // per-seat データ構築
  const seats: SeatPublicData[] = []
  for (let seat = 1; seat <= SEATS; seat++) {
    seats.push({
      alive: aliveSet.has(seat),
      claimedRole: claimedRoles.get(seat),
      isMe: seat === ctx.mySeat,
      blackCount: blackCounts.get(seat) ?? 0,
      whiteCount: whiteCounts.get(seat) ?? 0,
      voteReceived: voteCounts.get(seat) ?? 0,
      suspicion: suspicionCounts.get(seat) ?? 0,
      trust: trustCounts.get(seat) ?? 0,
      executeProposal: executeCounts.get(seat) ?? 0,
      isCommander: ctx.commander === seat,
      accuseWolf: accuseWolfCounts.get(seat) ?? 0,
      accuseFox: accuseFoxCounts.get(seat) ?? 0,
      voteIntent: voteIntentCounts.get(seat) ?? 0,
      nominateCommander: nominateCommanderCounts.get(seat) ?? 0,
      planApproved: (agreeCounts.get(seat) ?? 0) - (disagreeCounts.get(seat) ?? 0),
      confirmHuman: confirmHumanCounts.get(seat) ?? 0,
      confirmWolf: confirmWolfCounts.get(seat) ?? 0,
      voteFor: voteForCounts.get(seat) ?? 0,
      voteAgainst: voteAgainstCounts.get(seat) ?? 0,
    })
  }

  // private 情報
  const divineResults: Array<[number, 'human' | 'wolf']> = []
  if (ctx.myRole === 'seer') {
    for (const [, result] of ctx.myPlayer.divineHistory) {
      if (result.target >= 1 && result.target <= SEATS) {
        divineResults.push([result.target, result.result as 'human' | 'wolf'])
      }
    }
  }

  const guardedSeats: number[] = []
  if (ctx.myRole === 'bodyguard') {
    const seen = new Set<number>()
    for (const [, target] of ctx.myPlayer.guardHistory) {
      if (target >= 1 && target <= SEATS && !seen.has(target)) {
        seen.add(target)
        guardedSeats.push(target)
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
    global: {
      day: ctx.day,
      phase: ctx.phase,
      aliveCount: ctx.alivePlayers.length,
      myRole: ctx.myRole,
      commander: ctx.commander,
      demandWolfCoCount,
      ropeMargin,
      aliveParity: ctx.alivePlayers.length % 2,
    },
    seats,
    private: {
      divineResults,
      wolfTeamSeats: ctx.wolfTeammates ?? ctx.knownWolves ?? [],
      masonPartner: ctx.masonPartner,
      guardedSeats,
      knownHamster: ctx.knownHamster,
    },
    revote: {
      round: ctx.revoteRound ?? 0,
      candidates: ctx.revoteCandidates ?? [],
    },
    history: Array.from(history),
    retar: {
      self: mapOfSetsToRecord(ctx.retarPossibilities),
      global: mapOfSetsToRecord(ctx.globalRetarPossibilities),
    },
    plan: {
      forwardIndices: ctx.planForwardIndices,
      endgameIndices: ctx.planEndgameIndices,
    },
    tsumiTarget: ctx.tsumiTarget,
  }
}

// ============================================================
// 機械的な obs 配列への収納
// ============================================================

/** CollectedObservation を固定長 Float32Array に詰める（機械的エンコーディング） */
export function packObservation(data: CollectedObservation): Float32Array {
  const obs = new Float32Array(OBSERVATION_SIZE)
  const g = data.global

  // ========== Global features ==========
  let offset = 0
  obs[offset++] = g.day / MAX_DAYS
  obs[offset++] = g.phase === 'night' ? 0 : 1
  obs[offset++] = g.aliveCount / SEATS
  const roleIdx = ROLE_INDEX.get(g.myRole) ?? 0
  for (let i = 0; i < NUM_ROLES; i++) obs[offset++] = i === roleIdx ? 1 : 0
  obs[offset++] = g.commander !== null ? g.commander / SEATS : 0
  obs[offset++] = g.day / MAX_DAYS
  obs[offset++] = Math.min(g.demandWolfCoCount / 5, 1)
  obs[offset++] = g.ropeMargin !== null ? g.ropeMargin / SEATS : 0
  obs[offset++] = g.aliveParity

  // ========== Per-seat features ==========
  for (let i = 0; i < SEATS; i++) {
    const s = data.seats[i]
    let o = offset + i * PER_SEAT_SIZE
    obs[o++] = s.alive ? 1 : 0
    const cr = s.claimedRole
    for (let r = 0; r < NUM_ROLES; r++) obs[o++] = cr !== undefined && ROLE_INDEX.get(cr) === r ? 1 : 0
    obs[o++] = cr === undefined ? 1 : 0
    obs[o++] = s.isMe ? 1 : 0
    obs[o++] = Math.min(s.blackCount / 3, 1)
    obs[o++] = Math.min(s.whiteCount / 3, 1)
    obs[o++] = Math.min(s.voteReceived / 10, 1)
    obs[o++] = Math.min(s.suspicion / 5, 1)
    obs[o++] = Math.min(s.trust / 5, 1)
    obs[o++] = Math.min(s.executeProposal / 5, 1)
    obs[o++] = s.isCommander ? 1 : 0
    obs[o++] = Math.min(s.accuseWolf / 5, 1)
    obs[o++] = Math.min(s.accuseFox / 5, 1)
    obs[o++] = Math.min(s.voteIntent / 5, 1)
    obs[o++] = Math.min(s.nominateCommander / 3, 1)
  }
  offset += SEAT_SECTION_SIZE

  // ========== Private knowledge ==========
  for (const [seat, result] of data.private.divineResults) {
    obs[offset + (seat - 1)] = result === 'human' ? 0.5 : 1.0
  }
  offset += SEATS
  for (const seat of data.private.wolfTeamSeats) {
    if (seat >= 1 && seat <= SEATS) obs[offset + (seat - 1)] = 1
  }
  offset += SEATS
  if (data.private.masonPartner !== null && data.private.masonPartner >= 1 && data.private.masonPartner <= SEATS) {
    obs[offset] = data.private.masonPartner / SEATS
  }
  offset += 1
  for (const seat of data.private.guardedSeats) {
    if (seat >= 1 && seat <= SEATS) obs[offset + (seat - 1)] = 1
  }
  offset += SEATS
  if (data.private.knownHamster !== null && data.private.knownHamster >= 1 && data.private.knownHamster <= SEATS) {
    obs[offset] = data.private.knownHamster / SEATS
  }
  offset += 1

  // ========== Revote ==========
  if (data.revote.round > 0) obs[offset] = Math.min(data.revote.round / 3, 1)
  offset += 1
  for (const seat of data.revote.candidates) {
    if (seat >= 1 && seat <= SEATS) obs[offset + (seat - 1)] = 1
  }
  offset += SEATS

  // ========== History ==========
  for (let i = 0; i < HISTORY_SIZE; i++) obs[offset + i] = data.history[i] ?? 0
  offset += HISTORY_SIZE

  // ========== Retar ==========
  if (data.retar.self) {
    for (let seat = 1; seat <= SEATS; seat++) {
      const roles = data.retar.self[String(seat)]
      if (!roles) continue
      for (const role of roles) {
        const rIdx = ROLE_INDEX.get(role)
        if (rIdx !== undefined) obs[offset + (seat - 1) * NUM_ROLES + rIdx] = 1
      }
    }
  }
  offset += RETAR_POSSIBILITIES_SIZE
  if (data.retar.global) {
    for (let seat = 1; seat <= SEATS; seat++) {
      const roles = data.retar.global[String(seat)]
      if (!roles) continue
      for (const role of roles) {
        const rIdx = ROLE_INDEX.get(role)
        if (rIdx !== undefined) obs[offset + (seat - 1) * NUM_ROLES + rIdx] = 1
      }
    }
  }
  offset += GLOBAL_RETAR_SIZE

  // ========== Plan Approved + New Signals ==========
  for (let i = 0; i < SEATS; i++) {
    obs[offset + i] = Math.max(-1, Math.min(1, data.seats[i].planApproved / 5))
  }
  offset += PLAN_APPROVED_SIZE
  for (let i = 0; i < SEATS; i++) {
    const base = offset + i * NEW_SIGNALS_PER_SEAT
    obs[base + 0] = Math.min(data.seats[i].confirmHuman / 5, 1)
    obs[base + 1] = Math.min(data.seats[i].confirmWolf / 5, 1)
    obs[base + 2] = Math.min(data.seats[i].voteFor / 5, 1)
    obs[base + 3] = Math.min(data.seats[i].voteAgainst / 5, 1)
  }
  offset += NEW_SIGNALS_SIZE

  // ========== Raw Plan Indices ==========
  const fwd = data.plan.forwardIndices
  for (let i = 0; i < NUM_PLAN_FORWARD; i++) obs[offset++] = fwd?.[i] ?? 21
  const eg = data.plan.endgameIndices
  for (let i = 0; i < NUM_PLAN_ENDGAME; i++) obs[offset++] = eg?.[i] ?? 21

  // ========== Tsumi ==========
  if (data.tsumiTarget !== null && data.tsumiTarget >= 1 && data.tsumiTarget <= SEATS) {
    obs[TSUMI_START] = data.tsumiTarget / SEATS
  }

  return obs
}

/** encodeObservation: collect → pack のショートカット */
export function encodeObservation(ctx: DecisionContext): Float32Array {
  return packObservation(collectObservation(ctx))
}

// ============================================================
// チームエージェント用観測エンコーダ
// ============================================================

// チーム追加セクション:
//   global: +1 (my_team_size)
//   per-seat: +1 (is_my_team) + 1 (is_current_actor) = +2 per seat
//   private: +SEATS (全チームメンバーの偽占い結果統合)
const TEAM_GLOBAL_EXTRA = 1
const TEAM_PER_SEAT_EXTRA = 2
const TEAM_PRIVATE_EXTRA = SEATS

export const TEAM_OBSERVATION_SIZE =
  OBSERVATION_SIZE + TEAM_GLOBAL_EXTRA + SEATS * TEAM_PER_SEAT_EXTRA + TEAM_PRIVATE_EXTRA

// ============================================================
// 集団エージェント用定数
// ============================================================

// 集団共通拡張: team_size(1)
const COLLECTIVE_GLOBAL_EXTRA = 1

// 狼集団拡張: fake_divine(14) + village_predict(14×11) + village_trust(14)
const WOLF_COLLECTIVE_FAKE_DIVINE_SIZE = SEATS       // 14
const WOLF_COLLECTIVE_VILLAGE_PREDICT_SIZE = SEATS * NUM_ROLES  // 154
const WOLF_COLLECTIVE_VILLAGE_TRUST_SIZE = SEATS     // 14
const WOLF_COLLECTIVE_EXTRA = COLLECTIVE_GLOBAL_EXTRA
  + WOLF_COLLECTIVE_FAKE_DIVINE_SIZE
  + WOLF_COLLECTIVE_VILLAGE_PREDICT_SIZE
  + WOLF_COLLECTIVE_VILLAGE_TRUST_SIZE  // 1 + 14 + 154 + 14 = 183

export const WOLF_COLLECTIVE_OBSERVATION_SIZE = OBSERVATION_SIZE + WOLF_COLLECTIVE_EXTRA

// 共有集団拡張: team_size(1) のみ
export const MASON_COLLECTIVE_OBSERVATION_SIZE = OBSERVATION_SIZE + COLLECTIVE_GLOBAL_EXTRA

// 集団用オフセット (OBSERVATION_SIZE基準)
const COLLECTIVE_TEAM_SIZE_START = OBSERVATION_SIZE
const WOLF_FAKE_DIVINE_START = COLLECTIVE_TEAM_SIZE_START + 1
const WOLF_VILLAGE_PREDICT_START = WOLF_FAKE_DIVINE_START + WOLF_COLLECTIVE_FAKE_DIVINE_SIZE
const WOLF_VILLAGE_TRUST_START = WOLF_VILLAGE_PREDICT_START + WOLF_COLLECTIVE_VILLAGE_PREDICT_SIZE

/** 狼集団 Seat token特徴量次元: individual(71) + village_predict(11) + village_trust(1) + fake_divine(1) */
export const WOLF_COLLECTIVE_SEAT_FEATURES = SEAT_TOKEN_FEATURES + NUM_ROLES + 1 + 1  // 84
/** 狼集団 CLS token特徴量次元: individual(23) + team_size(1) — my_role(11)は0埋め */
export const WOLF_COLLECTIVE_CLS_FEATURES = CLS_FEATURES + 1  // 24
/** 共有集団 Seat token特徴量次元: individual(71) — is_meがis_my_teamになるだけ */
export const MASON_COLLECTIVE_SEAT_FEATURES = SEAT_TOKEN_FEATURES  // 71
/** 共有集団 CLS token特徴量次元: individual(23) + team_size(1) */
export const MASON_COLLECTIVE_CLS_FEATURES = CLS_FEATURES + 1  // 24

// 狂信者拡張: village_predict(14×11=154) + village_trust(14) = 168
const FANATIC_VILLAGE_PREDICT_SIZE = SEATS * NUM_ROLES  // 154
const FANATIC_VILLAGE_TRUST_SIZE = SEATS               // 14
const FANATIC_EXTRA = FANATIC_VILLAGE_PREDICT_SIZE + FANATIC_VILLAGE_TRUST_SIZE  // 168
export const FANATIC_OBSERVATION_SIZE = OBSERVATION_SIZE + FANATIC_EXTRA

// 狂信者オフセット (OBSERVATION_SIZE基準)
const FANATIC_VILLAGE_PREDICT_START = OBSERVATION_SIZE
const FANATIC_VILLAGE_TRUST_START = FANATIC_VILLAGE_PREDICT_START + FANATIC_VILLAGE_PREDICT_SIZE

/** 狂信者 Seat token特徴量次元: individual(71) + village_predict(11) + village_trust(1) */
export const FANATIC_SEAT_FEATURES = SEAT_TOKEN_FEATURES + NUM_ROLES + 1  // 83
/** 狂信者 CLS token特徴量次元: individual(23) — team_sizeなし */
export const FANATIC_CLS_FEATURES = CLS_FEATURES  // 23

/** 村NN出力の注入データ */
export type VillageNNOutput = {
  /** predict: 14席×11役職のsoftmax出力 (flat) */
  predict: Float32Array
  /** trust: 14席のscalar */
  trust: Float32Array
}

// per-seat内のis_meフィールドのオフセット (alive(1) + claimed_role(12) = 13)
const IS_ME_OFFSET_IN_SEAT = 1 + (NUM_ROLES + 1)  // 13
// global内のmy_roleフィールドのオフセット (day, phase, alive_ratio = 3)
const MY_ROLE_OFFSET_IN_GLOBAL = 3

/**
 * チームエージェント用の観測エンコード
 *
 * 個人観測をベースに、チーム固有の情報を末尾に追加:
 * 1. my_team_size (global)
 * 2. is_my_team per seat (14-dim)
 * 3. is_current_actor per seat (14-dim)
 * 4. 全チームメンバーの偽占い結果統合 (14-dim)
 */
export function encodeTeamObservation(ctx: TeamDecisionContext): Float32Array {
  const obs = new Float32Array(TEAM_OBSERVATION_SIZE)

  // 個人観測をベースにコピー
  const base = encodeObservation(ctx)
  obs.set(base)

  let offset = OBSERVATION_SIZE

  // ========== Team global ==========
  obs[offset++] = ctx.teamSeats.length / SEATS  // normalized team size

  // ========== Team per-seat flags ==========
  const teamSet = new Set(ctx.teamSeats)

  // is_my_team (14-dim)
  for (let seat = 1; seat <= SEATS; seat++) {
    obs[offset++] = teamSet.has(seat) ? 1 : 0
  }

  // is_current_actor (14-dim) — 昼行動で今誰の番か
  for (let seat = 1; seat <= SEATS; seat++) {
    obs[offset++] = ctx.currentActorSeat === seat ? 1 : 0
  }

  // ========== Team unified private info ==========
  // 全チームメンバーの偽占い結果を統合 (狼チーム用)
  // seat → 0=unknown, 0.5=human偽報告, 1.0=wolf偽報告
  for (let seat = 1; seat <= SEATS; seat++) {
    let fakeResult = 0
    for (const tp of ctx.teamPlayers) {
      const fake = tp.fakeDivineHistory
      if (fake) {
        for (const [, entry] of fake) {
          if (entry.target === seat) {
            fakeResult = entry.result === 'human' ? 0.5 : 1.0
          }
        }
      }
    }
    obs[offset++] = fakeResult
  }

  return obs
}

// ============================================================
// 集団エージェント用観測エンコーダ
// ============================================================

/**
 * 集団観測の共通処理: 個人観測をベースに is_me→is_my_team, my_role→zeros に変換
 */
function overrideForCollective(obs: Float32Array, teamSeats: number[]): void {
  const teamSet = new Set(teamSeats)

  // my_role(11) をゼロ化 — 集団は単一役職を持たない
  for (let i = 0; i < NUM_ROLES; i++) {
    obs[GLOBAL_START + MY_ROLE_OFFSET_IN_GLOBAL + i] = 0
  }

  // is_me → is_my_team: 全メンバー席を1にする
  for (let seat = 1; seat <= SEATS; seat++) {
    const seatOffset = PER_SEAT_START + (seat - 1) * PER_SEAT_SIZE + IS_ME_OFFSET_IN_SEAT
    obs[seatOffset] = teamSet.has(seat) ? 1 : 0
  }
}

/**
 * 狼集団エージェント用の観測エンコード
 *
 * 個人観測ベース + 集団オーバーライド + 狼集団拡張:
 * 1. team_size (global)
 * 2. fake_divine per seat (14)
 * 3. village_predict per seat (154)
 * 4. village_trust per seat (14)
 */
export function encodeCollectiveWolfObservation(
  ctx: TeamDecisionContext,
  villageNNOutput?: VillageNNOutput,
): Float32Array {
  const obs = new Float32Array(WOLF_COLLECTIVE_OBSERVATION_SIZE)

  // 個人観測をベースにコピー（primary memberの視点）
  const base = encodeObservation(ctx)
  obs.set(base)

  // 集団共通オーバーライド
  overrideForCollective(obs, ctx.teamSeats)

  // ========== 狼集団拡張 ==========
  // team_size
  obs[COLLECTIVE_TEAM_SIZE_START] = ctx.teamSeats.length / SEATS

  // fake_divine: 全メンバーの偽占い結果を統合
  for (let seat = 1; seat <= SEATS; seat++) {
    let fakeResult = 0
    for (const tp of ctx.teamPlayers) {
      const fake = tp.fakeDivineHistory
      if (fake) {
        for (const [, entry] of fake) {
          if (entry.target === seat) {
            fakeResult = entry.result === 'human' ? 0.5 : 1.0
          }
        }
      }
    }
    obs[WOLF_FAKE_DIVINE_START + seat - 1] = fakeResult
  }

  // village NN output injection
  if (villageNNOutput) {
    obs.set(villageNNOutput.predict, WOLF_VILLAGE_PREDICT_START)
    obs.set(villageNNOutput.trust, WOLF_VILLAGE_TRUST_START)
  }

  return obs
}

/**
 * 共有集団エージェント用の観測エンコード
 *
 * 個人観測ベース + 集団オーバーライド + team_size
 */
export function encodeCollectiveMasonObservation(ctx: TeamDecisionContext): Float32Array {
  const obs = new Float32Array(MASON_COLLECTIVE_OBSERVATION_SIZE)

  // 個人観測をベースにコピー（primary memberの視点）
  const base = encodeObservation(ctx)
  obs.set(base)

  // 集団共通オーバーライド
  overrideForCollective(obs, ctx.teamSeats)

  // team_size
  obs[COLLECTIVE_TEAM_SIZE_START] = ctx.teamSeats.length / SEATS

  return obs
}

/**
 * 狂信者エージェント用の観測エンコード
 *
 * 個人観測ベース + 村NN出力注入:
 * 1. village_predict per seat (154)
 * 2. village_trust per seat (14)
 *
 * 集団overrideなし（my_role維持、is_me維持、team_sizeなし）
 */
export function encodeFanaticObservation(
  ctx: DecisionContext,
  villageNNOutput?: VillageNNOutput,
): Float32Array {
  const obs = new Float32Array(FANATIC_OBSERVATION_SIZE)

  const base = encodeObservation(ctx)
  obs.set(base)

  // village NN output injection
  if (villageNNOutput) {
    obs.set(villageNNOutput.predict, FANATIC_VILLAGE_PREDICT_START)
    obs.set(villageNNOutput.trust, FANATIC_VILLAGE_TRUST_START)
  }

  return obs
}
