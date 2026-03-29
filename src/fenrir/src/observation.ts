/**
 * 観測ベクトルエンコーダ
 *
 * DecisionContextから固定長のFloat32Arrayを構築する。
 * 情報隔壁: gameState.players[].roleは直接参照しない。
 * 初期知識はDecisionContextの専用フィールド(wolfTeammates, knownWolves, knownHamster)経由で取得。
 * 公開情報(publicEvents, signals)と自分の秘密情報(myPlayer)のみからエンコード。
 */

import type { DecisionContext, TeamDecisionContext } from '../../lupa/strategy.ts'
import type { SystemRole } from '../../types/index.ts'

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
const ROLE_INDEX = new Map(ROLES.map((r, i) => [r, i]))
export const NUM_ROLES = ROLES.length

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

// 処刑プラン: per-seat(included, position) + global(length, is_grayran, active)
const PLAN_PER_SEAT_SIZE = 2
const PLAN_GLOBAL_SIZE = 3
const PLAN_SIZE = SEATS * PLAN_PER_SEAT_SIZE + PLAN_GLOBAL_SIZE  // 31

export const OBSERVATION_SIZE = GLOBAL_SIZE + SEAT_SECTION_SIZE + PRIVATE_SIZE + REVOTE_SIZE + HISTORY_SIZE + RETAR_POSSIBILITIES_SIZE + PLAN_SIZE

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
const PLAN_START = RETAR_START + RETAR_POSSIBILITIES_SIZE
const PLAN_INCLUDED_START = PLAN_START
const PLAN_POSITION_START = PLAN_START + SEATS
const PLAN_GLOBAL_START = PLAN_START + SEATS * PLAN_PER_SEAT_SIZE

// チーム拡張オフセット (OBSERVATION_SIZE基準)
const TEAM_SIZE_START = OBSERVATION_SIZE
const TEAM_IS_MY_TEAM_START = TEAM_SIZE_START + 1
const TEAM_IS_CURRENT_ACTOR_START = TEAM_IS_MY_TEAM_START + SEATS
const TEAM_FAKE_DIVINE_START = TEAM_IS_CURRENT_ACTOR_START + SEATS

// トークン特徴量次元
/** CLSトークンの特徴量次元 (individual) */
export const CLS_FEATURES = 25
/** CLSトークンの特徴量次元 (team) */
export const TEAM_CLS_FEATURES = 26
/** 席トークンの特徴量次元 (individual) */
export const SEAT_TOKEN_FEATURES = 57
/** 席トークンの特徴量次元 (team) */
export const TEAM_SEAT_TOKEN_FEATURES = 60
/** プラントークンの特徴量次元 (Phase D用) */
export const PLAN_TOKEN_FEATURES = 20
/** プラントークンの最大数 */
export const MAX_PLAN_TOKENS = 8

/** トークン化されたobservation */
export type TokenizedObservation = {
  /** CLSトークン [clsFeatures] */
  cls: Float32Array
  /** 席トークン [SEATS * seatFeatures] — flat, stride = seatFeatures */
  seats: Float32Array
  /** プラントークン [planCount * PLAN_TOKEN_FEATURES] — flat */
  plans: Float32Array
  /** プラントークン数 (0 = プランなし) */
  planCount: number
  /** 席特徴量次元 */
  seatFeatures: number
  /** CLS特徴量次元 */
  clsFeatures: number
}

/**
 * フラットobservationをTransformer用トークンに分割
 * @param obs フラットobservation (OBSERVATION_SIZE or TEAM_OBSERVATION_SIZE)
 * @param isTeam チーム観測かどうか
 */
export function tokenize(obs: Float32Array, isTeam: boolean = false): TokenizedObservation {
  const sf = isTeam ? TEAM_SEAT_TOKEN_FEATURES : SEAT_TOKEN_FEATURES
  const cf = isTeam ? TEAM_CLS_FEATURES : CLS_FEATURES

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
  // plan_global (3)
  cls[co++] = obs[PLAN_GLOBAL_START]
  cls[co++] = obs[PLAN_GLOBAL_START + 1]
  cls[co++] = obs[PLAN_GLOBAL_START + 2]
  // team extension
  if (isTeam) {
    cls[co++] = obs[TEAM_SIZE_START]
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

    // retar possibilities (11)
    const rOff = RETAR_START + s * NUM_ROLES
    for (let i = 0; i < NUM_ROLES; i++) seats[so++] = obs[rOff + i]

    // plan per-seat (2)
    seats[so++] = obs[PLAN_INCLUDED_START + s]
    seats[so++] = obs[PLAN_POSITION_START + s]

    // team extension per-seat (3)
    if (isTeam) {
      seats[so++] = obs[TEAM_IS_MY_TEAM_START + s]
      seats[so++] = obs[TEAM_IS_CURRENT_ACTOR_START + s]
      seats[so++] = obs[TEAM_FAKE_DIVINE_START + s]
    }
  }

  // ========== Plan tokens (Phase D: 現時点では空) ==========
  return {
    cls,
    seats,
    plans: new Float32Array(0),
    planCount: 0,
    seatFeatures: sf,
    clsFeatures: cf,
  }
}

export function encodeObservation(ctx: DecisionContext): Float32Array {
  const obs = new Float32Array(OBSERVATION_SIZE)
  let offset = 0

  // ========== Global features ==========
  obs[offset++] = ctx.day / MAX_DAYS                    // normalized day
  obs[offset++] = ctx.phase === 'night' ? 0 : 1         // phase
  obs[offset++] = ctx.alivePlayers.length / SEATS        // alive ratio

  // my_role one-hot
  const roleIdx = ROLE_INDEX.get(ctx.myRole) ?? 0
  for (let i = 0; i < NUM_ROLES; i++) {
    obs[offset++] = i === roleIdx ? 1 : 0
  }

  obs[offset++] = ctx.commander !== null ? ctx.commander / SEATS : 0  // commander
  obs[offset++] = ctx.day / MAX_DAYS  // game progress

  // demand_wolf_co_count: 当日のdemand_wolf_coシグナル数
  let demandWolfCoCount = 0
  for (const event of ctx.publicEvents) {
    if (event.type === 'signal' && event.signal.type === 'demand_wolf_co') {
      demandWolfCoCount++
    }
  }
  obs[offset++] = Math.min(demandWolfCoCount / 5, 1)

  // rope_margin: 縄余裕 = 残り処刑回数 - maxSurvivingNV
  // 正 = 村有利、0 = ギリギリ、負 = 村不利
  if (ctx.maxSurvivingNV !== null) {
    const aliveCount = ctx.alivePlayers.length
    const remainingExecutions = (aliveCount - 1) / 2
    const ropeMargin = remainingExecutions - ctx.maxSurvivingNV
    obs[offset++] = ropeMargin / SEATS  // normalized
  } else {
    obs[offset++] = 0
  }

  // alive_parity: 生存者数の偶奇 (0=偶数, 1=奇数)
  // 処刑後のパリティが勝敗に直結するため明示的に入れる
  obs[offset++] = ctx.alivePlayers.length % 2

  // ========== Per-seat features ==========
  const aliveSet = new Set(ctx.alivePlayers)

  // Build public knowledge from events
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

  for (const event of ctx.publicEvents) {
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
      case 'medium_claim':
        claimedRoles.set(event.actor, 'medium')
        break
      case 'bodyguard_claim':
        claimedRoles.set(event.actor, 'bodyguard')
        break
      case 'mason_claim':
        claimedRoles.set(event.actor, 'mason')
        break
      case 'nekomata_claim':
        claimedRoles.set(event.actor, 'nekomata')
        break
      case 'wolf_claim':
        claimedRoles.set(event.actor, event.claimedRole)
        break
      case 'vote':
        voteCounts.set(event.target, (voteCounts.get(event.target) ?? 0) + 1)
        break
      case 'signal': {
        const sig = event.signal
        if ('target' in sig) {
          const t = sig.target
          switch (sig.type) {
            case 'suspicion': suspicionCounts.set(t, (suspicionCounts.get(t) ?? 0) + 1); break
            case 'trust': trustCounts.set(t, (trustCounts.get(t) ?? 0) + 1); break
            case 'accuse_wolf': accuseWolfCounts.set(t, (accuseWolfCounts.get(t) ?? 0) + 1); break
            case 'accuse_fox': accuseFoxCounts.set(t, (accuseFoxCounts.get(t) ?? 0) + 1); break
            case 'vote_intent': voteIntentCounts.set(t, (voteIntentCounts.get(t) ?? 0) + 1); break
            case 'nominate_commander': nominateCommanderCounts.set(t, (nominateCommanderCounts.get(t) ?? 0) + 1); break
          }
        }
        break
      }
      case 'execute_proposals':
        for (const t of event.targets) {
          executeCounts.set(t, (executeCounts.get(t) ?? 0) + 1)
        }
        break
    }
  }

  for (let seat = 1; seat <= SEATS; seat++) {
    const base = offset + (seat - 1) * PER_SEAT_SIZE
    let o = base

    obs[o++] = aliveSet.has(seat) ? 1 : 0

    // claimed_role one-hot (11 roles + none)
    const claimed = claimedRoles.get(seat)
    for (let i = 0; i < NUM_ROLES; i++) {
      obs[o++] = claimed !== undefined && ROLE_INDEX.get(claimed) === i ? 1 : 0
    }
    obs[o++] = claimed === undefined ? 1 : 0  // no claim

    obs[o++] = seat === ctx.mySeat ? 1 : 0
    obs[o++] = Math.min((blackCounts.get(seat) ?? 0) / 3, 1)
    obs[o++] = Math.min((whiteCounts.get(seat) ?? 0) / 3, 1)
    obs[o++] = Math.min((voteCounts.get(seat) ?? 0) / 10, 1)
    obs[o++] = Math.min((suspicionCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = Math.min((trustCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = Math.min((executeCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = ctx.commander === seat ? 1 : 0
    obs[o++] = Math.min((accuseWolfCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = Math.min((accuseFoxCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = Math.min((voteIntentCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = Math.min((nominateCommanderCounts.get(seat) ?? 0) / 3, 1)
  }
  offset += SEAT_SECTION_SIZE

  // ========== Private knowledge ==========
  const privateBase = offset

  // Seer divine results: per seat (0=unknown, 0.5=human, 1.0=wolf)
  if (ctx.myRole === 'seer') {
    for (const [, result] of ctx.myPlayer.divineHistory) {
      const seat = result.target
      if (seat >= 1 && seat <= SEATS) {
        obs[privateBase + (seat - 1)] = result.result === 'human' ? 0.5 : 1.0
      }
    }
  }
  offset += SEATS

  // Wolf teammates mask (人狼: 仲間の狼, 狂信者: 狼の位置)
  if (ctx.wolfTeammates) {
    for (const seat of ctx.wolfTeammates) {
      if (seat >= 1 && seat <= SEATS) {
        obs[offset + (seat - 1)] = 1
      }
    }
  } else if (ctx.knownWolves) {
    for (const seat of ctx.knownWolves) {
      if (seat >= 1 && seat <= SEATS) {
        obs[offset + (seat - 1)] = 1
      }
    }
  }
  offset += SEATS

  // Mason partner
  if (ctx.masonPartner !== null && ctx.masonPartner >= 1 && ctx.masonPartner <= SEATS) {
    obs[offset] = ctx.masonPartner / SEATS
  }
  offset += 1

  // Bodyguard guard history: per seat (1 if ever guarded)
  if (ctx.myRole === 'bodyguard') {
    for (const [, target] of ctx.myPlayer.guardHistory) {
      if (target >= 1 && target <= SEATS) {
        obs[offset + (target - 1)] = 1
      }
    }
  }
  offset += SEATS

  // Immoralist: known hamster seat
  if (ctx.knownHamster !== null && ctx.knownHamster >= 1 && ctx.knownHamster <= SEATS) {
    obs[offset] = ctx.knownHamster / SEATS
  }
  offset += 1

  // ========== Revote information ==========
  if (ctx.revoteRound !== null && ctx.revoteRound > 0) {
    obs[offset] = Math.min(ctx.revoteRound / 3, 1)  // normalized revote round (0..1)
  }
  offset += 1

  // Revote candidates mask
  if (ctx.revoteCandidates) {
    for (const seat of ctx.revoteCandidates) {
      if (seat >= 1 && seat <= SEATS) {
        obs[offset + (seat - 1)] = 1
      }
    }
  }
  offset += SEATS

  // ========== History window (last 3 days) ==========
  const currentDay = ctx.day
  for (let w = 0; w < HISTORY_WINDOW; w++) {
    const histDay = currentDay - HISTORY_WINDOW + w + 1
    if (histDay < 1) continue

    const dayBase = offset + w * HISTORY_DAY_SIZE

    // Collect events for this day
    for (const event of ctx.publicEvents) {
      switch (event.type) {
        case 'vote': {
          // Record who voted for whom as one-hot-ish per seat
          const voterSlot = event.voter - 1
          if (voterSlot >= 0 && voterSlot < SEATS) {
            obs[dayBase + voterSlot * 5 + 0] = event.target / SEATS
          }
          break
        }
        case 'execution': {
          const slot = event.target - 1
          if (slot >= 0 && slot < SEATS) {
            obs[dayBase + slot * 5 + 1] = 1
          }
          break
        }
        case 'night_kill':
        case 'fox_kill': {
          const slot = event.target - 1
          if (slot >= 0 && slot < SEATS) {
            obs[dayBase + slot * 5 + 2] = 1
          }
          break
        }
        case 'seer_claim':
        case 'medium_claim':
        case 'bodyguard_claim':
        case 'mason_claim':
        case 'nekomata_claim': {
          const slot = event.actor - 1
          if (slot >= 0 && slot < SEATS) {
            obs[dayBase + slot * 5 + 3] = 1
          }
          break
        }
        case 'signal': {
          const slot = event.actor - 1
          if (slot >= 0 && slot < SEATS) {
            obs[dayBase + slot * 5 + 4] = 1
          }
          break
        }
      }
    }
  }
  offset += HISTORY_SIZE

  // ========== Retar possibilities ==========
  if (ctx.retarPossibilities) {
    for (let seat = 1; seat <= SEATS; seat++) {
      const roles = ctx.retarPossibilities.get(seat)
      if (!roles) continue
      for (const role of roles) {
        const rIdx = ROLE_INDEX.get(role)
        if (rIdx !== undefined) {
          obs[offset + (seat - 1) * NUM_ROLES + rIdx] = 1
        }
      }
    }
  }
  offset += RETAR_POSSIBILITIES_SIZE

  // ========== Execution Plan ==========
  if (ctx.executionPlan) {
    const plan = ctx.executionPlan
    // per-seat: plan_included (14次元)
    for (let seat = 1; seat <= SEATS; seat++) {
      obs[offset + seat - 1] = plan.targets.includes(seat) ? 1 : 0
    }
    offset += SEATS
    // per-seat: plan_position (14次元, normalized by plan length)
    const len = plan.targets.length
    for (let seat = 1; seat <= SEATS; seat++) {
      const idx = plan.targets.indexOf(seat)
      obs[offset + seat - 1] = idx >= 0 && len > 0 ? (idx + 1) / len : 0
    }
    offset += SEATS
    // global: plan_length, plan_is_grayran, plan_active
    obs[offset++] = len / SEATS
    obs[offset++] = plan.isGrayran ? 1 : 0
    obs[offset++] = 1  // plan_active
  } else {
    offset += PLAN_SIZE  // all zeros
  }

  return obs
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
