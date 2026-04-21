/**
 * DayClaim / CommunicationAction / LeadershipResponse を NN head の action index に変換。
 *
 * Phase 2 の SL pretrain で、heuristic (RuleBasedAgent) の判断を教師ラベルとして
 * NN head に distill する際、decode* の逆向き変換が必要になる。
 *
 * 対応表:
 *   - claim head (10): CLAIM.SEER_CO..NONE
 *   - comm head (119): 8 × SEATS + 7 signals
 *   - leader head (3): follow / defy / no_response
 *   - target head (14): seat 1..14 (forecast / mason_co / etc の対象)
 *   - propose head (14 sigmoid): 処刑提案席集合 (multi-hot)
 *   - predict head (154 sigmoid): 配役予想 (multi-hot per seat × role)
 */
import type { DayClaim } from '../../lupa/types.ts'
import type { Signal, RolePrediction } from '../../fenrir/src/communication.ts'
import type { LeadershipResponse } from '../../fenrir/src/leadership.ts'
import { CLAIM } from '../../fenrir/src/action.ts'
import { SEATS, NUM_ROLES, ROLE_INDEX } from '../../fenrir/src/observation.ts'

/**
 * DayClaim → claim head index (0..9)。
 * 該当する CLAIM enum に対応。none 返却で encode 不能 (-1) を表現。
 */
export function encodeClaim(claim: DayClaim): number {
  switch (claim.type) {
    case 'seer_co': return CLAIM.SEER_CO
    case 'medium_co': return CLAIM.MEDIUM_CO
    case 'bodyguard_co': return CLAIM.BODYGUARD_CO
    case 'mason_co': return CLAIM.MASON_CO
    case 'nekomata_co': return CLAIM.NEKOMATA_CO
    case 'seer_result': return CLAIM.SEER_RESULT
    case 'medium_result': return CLAIM.MEDIUM_RESULT
    case 'forecast': return CLAIM.FORECAST
    case 'none': return CLAIM.NONE
  }
}

/**
 * DayClaim → target seat (1..14) or null。
 * forecast, mason_co で target が 1 つに定まる claim のみ非 null を返す。
 * bodyguard_co の targets[] は multi-seat なので別 encoder (encodeTargetMultiHot) を使う。
 */
export function encodeTargetSeat(claim: DayClaim): number | null {
  switch (claim.type) {
    case 'forecast': return claim.target
    case 'mason_co': return claim.partner
    default: return null
  }
}

/**
 * bodyguard_co.targets[] 等の multi-seat claim を propose 形式の multi-hot にエンコード。
 * targets は 1..SEATS の seat 番号配列。
 */
export function encodeSeatMultiHot(targets: number[]): Float32Array {
  const out = new Float32Array(SEATS)
  for (const seat of targets) {
    if (seat >= 1 && seat <= SEATS) out[seat - 1] = 1
  }
  return out
}

/** comm signal → 0..118 の index、未対応 signal は -1 */
export function encodeCommSignal(signal: Signal): number {
  switch (signal.type) {
    case 'suspicion':          return 0 * SEATS + (signal.target - 1)
    case 'trust':              return 1 * SEATS + (signal.target - 1)
    case 'vote_intent':        return 2 * SEATS + (signal.target - 1)
    case 'accuse_wolf':        return 3 * SEATS + (signal.target - 1)
    case 'accuse_fox':         return 4 * SEATS + (signal.target - 1)
    case 'agree':              return 5 * SEATS + (signal.target - 1)
    case 'disagree':           return 6 * SEATS + (signal.target - 1)
    case 'nominate_commander': return 7 * SEATS + (signal.target - 1)
    case 'demand_wolf_co':     return 8 * SEATS + 0
    case 'werewolf_co':        return 8 * SEATS + 1
    case 'fanatic_co':         return 8 * SEATS + 2
    case 'werehamster_co':     return 8 * SEATS + 3
    case 'immoralist_co':      return 8 * SEATS + 4
    case 'submit_prediction':  return 8 * SEATS + 5
    case 'no_signal':          return 8 * SEATS + 6
    // 非 head signal: confirm_*, vote_for/against — comm head には存在しない、-1 で skip
    default: return -1
  }
}

/** LeadershipResponse → 0..2 */
export function encodeLeader(resp: LeadershipResponse): number {
  switch (resp) {
    case 'follow': return 0
    case 'defy': return 1
    case 'no_response': return 2
  }
}

/**
 * RolePrediction → 154 dim multi-hot。
 * key: 1..SEATS、value: role 配列。複数 role 予想でも同時に 1 にできる。
 */
export function encodePredict(predictions: RolePrediction): Float32Array {
  const out = new Float32Array(SEATS * NUM_ROLES)
  for (const [seat, roles] of predictions) {
    if (seat < 1 || seat > SEATS) continue
    for (const role of roles) {
      const roleIdx = ROLE_INDEX.get(role)
      if (roleIdx === undefined) continue
      out[(seat - 1) * NUM_ROLES + roleIdx] = 1
    }
  }
  return out
}
