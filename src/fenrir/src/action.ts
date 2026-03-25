/**
 * アクション空間定義 + マスキング + デコード
 *
 * 14D猫専用 (SEATS=14)
 *
 * 8つのアクションヘッド:
 * - night:    SEATS+1 (target seats + none)
 * - claim:    10 (CO種別)
 * - vote:     SEATS (投票先)
 * - comm:     SEATS*7+7 (softmax: シグナル種別×対象 + 宣言系)
 * - propose:  SEATS (sigmoid: 処刑提案、複数同時選択可)
 * - predict:  SEATS*11 (sigmoid: 配役予想、submit_prediction時のみ)
 * - leader:   3 (follow/defy/no_response)
 * - target:   SEATS (対象選択: 占い先、護衛先、共有相方等)
 */

import type { DecisionContext } from '../../lupa/strategy.ts'
import type { NightAction, DayClaim } from '../../lupa/types.ts'
import type { Signal, RolePrediction } from '../../lupa/communication.ts'
import type { LeadershipResponse } from '../../lupa/leadership.ts'
import type { SystemRole } from '../../types/index.ts'
import { SEATS, NUM_ROLES } from './observation.ts'
import { softmax } from './ml/nn.ts'

// ============================================================
// ヘッドサイズ定義
// ============================================================

export const HEAD_SIZES = {
  night: SEATS + 1,            // seat 1..SEATS + none
  claim: 10,                   // seer_co, medium_co, bodyguard_co, mason_co, nekomata_co, seer_result, medium_result, forecast, villager_co(fake), none
  vote: SEATS,                 // seat 1..SEATS
  comm: SEATS * 7 + 7,        // suspicion(14) + trust(14) + vote_intent(14) + accuse_wolf(14) + accuse_fox(14) + agree(14) + disagree(14) + demand_wolf_co + werewolf_co + fanatic_co + werehamster_co + immoralist_co + submit_prediction + no_signal
  propose: SEATS,              // sigmoid: 処刑提案 (複数同時選択可)
  predict: SEATS * NUM_ROLES,  // sigmoid: 配役予想 (submit_prediction時のみ)
  leader: 3,                   // follow, defy, no_response
  target: SEATS,               // seat 1..SEATS
} as const

// Claim indices
const CLAIM = {
  SEER_CO: 0,
  MEDIUM_CO: 1,
  BODYGUARD_CO: 2,
  MASON_CO: 3,
  NEKOMATA_CO: 4,
  SEER_RESULT: 5,
  MEDIUM_RESULT: 6,
  FORECAST: 7,
  FAKE_CO: 8,
  NONE: 9,
} as const

// ============================================================
// アクションマスキング
// ============================================================

// Comm head index layout
const COMM = {
  SUSPICION: 0,                          // 0..SEATS-1
  TRUST: SEATS,                          // SEATS..SEATS*2-1
  VOTE_INTENT: SEATS * 2,               // SEATS*2..SEATS*3-1
  ACCUSE_WOLF: SEATS * 3,               // SEATS*3..SEATS*4-1
  ACCUSE_FOX: SEATS * 4,                // SEATS*4..SEATS*5-1
  AGREE: SEATS * 5,                     // SEATS*5..SEATS*6-1
  DISAGREE: SEATS * 6,                  // SEATS*6..SEATS*7-1
  DEMAND_WOLF_CO: SEATS * 7,            // SEATS*7
  WEREWOLF_CO: SEATS * 7 + 1,           // SEATS*7+1
  FANATIC_CO: SEATS * 7 + 2,            // SEATS*7+2
  WEREHAMSTER_CO: SEATS * 7 + 3,        // SEATS*7+3
  IMMORALIST_CO: SEATS * 7 + 4,         // SEATS*7+4
  SUBMIT_PREDICTION: SEATS * 7 + 5,     // SEATS*7+5
  NO_SIGNAL: SEATS * 7 + 6,             // SEATS*7+6
} as const

// Roles ordered for prediction head (must match NUM_ROLES)
const ROLE_ORDER: SystemRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason',
  'nekomata', 'werewolf', 'possessed', 'fanatic',
  'werehamster', 'immoralist',
]

export function maskNightAction(ctx: DecisionContext): Float32Array {
  const mask = new Float32Array(HEAD_SIZES.night).fill(-Infinity)

  switch (ctx.myRole) {
    case 'seer':
      for (const seat of ctx.alivePlayers) {
        if (seat !== ctx.mySeat && seat <= SEATS) {
          mask[seat - 1] = 0
        }
      }
      break
    case 'bodyguard':
      for (const seat of ctx.alivePlayers) {
        if (seat !== ctx.mySeat && seat <= SEATS) {
          mask[seat - 1] = 0
        }
      }
      break
    case 'werewolf': {
      const wolves = new Set(
        ctx.gameState.players.filter(p => p.role === 'werewolf').map(p => p.seat)
      )
      const minWolf = Math.min(...ctx.alivePlayers.filter(s => wolves.has(s)))
      if (ctx.mySeat === minWolf) {
        for (const seat of ctx.alivePlayers) {
          if (!wolves.has(seat) && seat <= SEATS) {
            mask[seat - 1] = 0
          }
        }
      } else {
        mask[SEATS] = 0  // none
      }
      break
    }
    default:
      mask[SEATS] = 0  // none
  }

  return mask
}

export function maskClaim(ctx: DecisionContext): Float32Array {
  const mask = new Float32Array(HEAD_SIZES.claim).fill(-Infinity)
  const player = ctx.myPlayer

  // 全員 none は選べる
  mask[CLAIM.NONE] = 0

  if (player.claimedRole === 'seer') {
    mask[CLAIM.SEER_RESULT] = 0
    mask[CLAIM.FORECAST] = 0
  } else if (player.claimedRole === 'medium') {
    mask[CLAIM.MEDIUM_RESULT] = 0
  } else if (player.claimedRole === null) {
    // まだCOしていない → CO可能
    mask[CLAIM.SEER_CO] = 0
    mask[CLAIM.MEDIUM_CO] = 0
    mask[CLAIM.BODYGUARD_CO] = 0
    mask[CLAIM.MASON_CO] = 0
    mask[CLAIM.NEKOMATA_CO] = 0
  }

  return mask
}

export function maskVote(ctx: DecisionContext): Float32Array {
  const mask = new Float32Array(HEAD_SIZES.vote).fill(-Infinity)
  for (const seat of ctx.alivePlayers) {
    if (seat !== ctx.mySeat && seat <= SEATS) {
      mask[seat - 1] = 0
    }
  }
  return mask
}

export function maskComm(ctx: DecisionContext): Float32Array {
  const mask = new Float32Array(HEAD_SIZES.comm).fill(-Infinity)

  // target系シグナル (7種): 生存者+非自分に制限
  const targetOffsets = [
    COMM.SUSPICION, COMM.TRUST, COMM.VOTE_INTENT,
    COMM.ACCUSE_WOLF, COMM.ACCUSE_FOX, COMM.AGREE, COMM.DISAGREE,
  ]
  for (const offset of targetOffsets) {
    for (const seat of ctx.alivePlayers) {
      if (seat !== ctx.mySeat && seat <= SEATS) {
        mask[offset + seat - 1] = 0
      }
    }
  }

  // 宣言系: 常に許可 (ノーマスク)
  mask[COMM.DEMAND_WOLF_CO] = 0
  mask[COMM.WEREWOLF_CO] = 0
  mask[COMM.FANATIC_CO] = 0
  mask[COMM.WEREHAMSTER_CO] = 0
  mask[COMM.IMMORALIST_CO] = 0
  mask[COMM.SUBMIT_PREDICTION] = 0
  mask[COMM.NO_SIGNAL] = 0

  return mask
}

export function maskPropose(ctx: DecisionContext): Float32Array {
  // sigmoid: 0 = no bias, -Infinity = masked out
  const mask = new Float32Array(HEAD_SIZES.propose).fill(-Infinity)
  for (const seat of ctx.alivePlayers) {
    if (seat !== ctx.mySeat && seat <= SEATS) {
      mask[seat - 1] = 0
    }
  }
  return mask
}

export function maskPredict(commActionIdx: number): Float32Array {
  // submit_prediction 選択時のみ全有効、それ以外は全マスク
  if (commActionIdx === COMM.SUBMIT_PREDICTION) {
    return new Float32Array(HEAD_SIZES.predict).fill(0)
  }
  return new Float32Array(HEAD_SIZES.predict).fill(-Infinity)
}

export function maskLeader(_ctx: DecisionContext): Float32Array {
  return new Float32Array(HEAD_SIZES.leader).fill(0)
}

export function maskTarget(ctx: DecisionContext): Float32Array {
  const mask = new Float32Array(HEAD_SIZES.target).fill(-Infinity)
  for (const seat of ctx.alivePlayers) {
    if (seat !== ctx.mySeat && seat <= SEATS) {
      mask[seat - 1] = 0
    }
  }
  return mask
}

// ============================================================
// マスク付きサンプリング
// ============================================================

export function sampleMasked(logits: Float32Array, mask: Float32Array): { action: number, logProb: number } {
  const masked = new Float32Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    masked[i] = logits[i] + mask[i]
  }
  const probs = softmax(masked)

  // Categorical sampling
  const r = Math.random()
  let cumulative = 0
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i]
    if (r < cumulative) {
      return { action: i, logProb: Math.log(probs[i] + 1e-8) }
    }
  }
  // Fallback (numerical edge case)
  const last = probs.length - 1
  return { action: last, logProb: Math.log(probs[last] + 1e-8) }
}

// ============================================================
// アクションデコード
// ============================================================

export function decodeNightAction(actionIdx: number): NightAction {
  if (actionIdx === SEATS) return { type: 'none' }
  return { type: 'divine', target: actionIdx + 1 }
}

export function decodeNightActionWithRole(actionIdx: number, role: string): NightAction {
  if (actionIdx === SEATS) return { type: 'none' }
  const target = actionIdx + 1
  switch (role) {
    case 'seer': return { type: 'divine', target }
    case 'bodyguard': return { type: 'guard', target }
    case 'werewolf': return { type: 'attack', target }
    default: return { type: 'none' }
  }
}

export function decodeClaim(
  claimIdx: number, _targetIdx: number, ctx: DecisionContext,
): DayClaim {
  const player = ctx.myPlayer
  const targetSeat = _targetIdx + 1

  switch (claimIdx) {
    case CLAIM.SEER_CO: {
      const results = Array.from(player.divineHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ target: v.target, result: v.result }))
      // 偽占いの場合
      if (player.fakeDivineHistory.size > 0) {
        const fakeResults = Array.from(player.fakeDivineHistory.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => ({ target: v.target, result: v.result }))
        return { type: 'seer_co', results: fakeResults.length > 0 ? fakeResults : results }
      }
      return { type: 'seer_co', results }
    }
    case CLAIM.MEDIUM_CO:
      return { type: 'medium_co' }
    case CLAIM.BODYGUARD_CO: {
      const targets = Array.from(player.guardHistory.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, seat]) => seat)
      return { type: 'bodyguard_co', targets }
    }
    case CLAIM.MASON_CO:
      return { type: 'mason_co', partner: targetSeat }
    case CLAIM.NEKOMATA_CO:
      return { type: 'nekomata_co' }
    case CLAIM.SEER_RESULT: {
      const latest = player.divineHistory.get(ctx.day - 1)
        ?? player.fakeDivineHistory.get(ctx.day - 1)
      if (!latest) return { type: 'none' }
      return { type: 'seer_result', target: latest.target, result: latest.result }
    }
    case CLAIM.MEDIUM_RESULT: {
      // MLは霊能結果の真偽を直接は知らない
      return { type: 'none' }
    }
    case CLAIM.FORECAST:
      return { type: 'forecast', target: targetSeat }
    default:
      return { type: 'none' }
  }
}

export function decodeComm(actionIdx: number): Signal {
  // target系シグナル (7種 × SEATS)
  if (actionIdx < SEATS * 7) {
    const signalType = Math.floor(actionIdx / SEATS)
    const target = (actionIdx % SEATS) + 1
    const types: Signal['type'][] = [
      'suspicion', 'trust', 'vote_intent',
      'accuse_wolf', 'accuse_fox', 'agree', 'disagree',
    ]
    return { type: types[signalType], target } as Signal
  }
  // 宣言系シグナル
  const declIdx = actionIdx - SEATS * 7
  const declTypes: Signal['type'][] = [
    'demand_wolf_co', 'werewolf_co', 'fanatic_co',
    'werehamster_co', 'immoralist_co', 'submit_prediction', 'no_signal',
  ]
  return { type: declTypes[declIdx] ?? 'no_signal' } as Signal
}

/** sigmoid出力から処刑提案対象リストをデコード */
export function decodePropose(sigmoidOutput: Float32Array, threshold = 0.5): number[] {
  const targets: number[] = []
  for (let i = 0; i < SEATS; i++) {
    if (sigmoidOutput[i] >= threshold) {
      targets.push(i + 1) // seat番号は1-indexed
    }
  }
  return targets
}

/** sigmoid出力から配役予想をデコード */
export function decodePredict(sigmoidOutput: Float32Array, threshold = 0.5): RolePrediction {
  const predictions: RolePrediction = new Map()
  for (let seat = 0; seat < SEATS; seat++) {
    const roles: SystemRole[] = []
    for (let role = 0; role < NUM_ROLES; role++) {
      if (sigmoidOutput[seat * NUM_ROLES + role] >= threshold) {
        roles.push(ROLE_ORDER[role])
      }
    }
    if (roles.length > 0) {
      predictions.set(seat + 1, roles)
    }
  }
  return predictions
}

export function decodeLeader(actionIdx: number): LeadershipResponse {
  switch (actionIdx) {
    case 0: return 'follow'
    case 1: return 'defy'
    default: return 'no_response'
  }
}
