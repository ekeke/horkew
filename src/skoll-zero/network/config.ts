/**
 * skoll-zero の NN 構成。
 *
 * Phase 1 では fenrir の mason_brain 互換 config を使う:
 * - Seat Transformer trunk (dModel=64, 3+2 layers, numPlanTokens=0)
 * - 14-dim per-seat `vote` head（= skoll-zero の policy head）
 * - scalar value head（= TransformerNetwork 標準、skoll-zero では zero init）
 *
 * trunk + vote head は skoll-supervised で事前学習済み (`src/skoll/models/mason.json`)。
 * warm start でこれを引き継ぐ。
 *
 * NOTE: ブラウザ (demo) でも import できるよう、training.ts (TF.js 依存) には依存しない。
 * TF.js 版 factory は tf-config.ts を参照。
 */

import type { NetworkConfig } from '../../fenrir/src/ml/nn.ts'
import { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import {
  MASON_COLLECTIVE_OBSERVATION_SIZE, MASON_COLLECTIVE_SEAT_FEATURES, MASON_COLLECTIVE_CLS_FEATURES,
  WOLF_COLLECTIVE_OBSERVATION_SIZE, WOLF_COLLECTIVE_SEAT_FEATURES, WOLF_COLLECTIVE_CLS_FEATURES,
  OBSERVATION_SIZE, SEAT_TOKEN_FEATURES, CLS_FEATURES,
  NUM_ROLE_TOKENS, ROLE_TOKEN_FEATURES,
  SEATS, NUM_ROLES,
} from '../../fenrir/src/observation.ts'
import { HEAD_SIZES } from '../../fenrir/src/action.ts'

/**
 * Phase 2 で追加される共通 head 群 (claim/comm/leader/target/propose/predict)。
 * 3 config 共通でこれらを含め、role 別の agent が必要な head だけ参照する。
 *
 * - softmax heads (categorical 1-of-K): claim (10), comm (119), leader (3), target (14)
 *   - target は per-seat 選択 (forecast/defensiveClaim の対象指定)
 * - sigmoid heads (multi-label): propose (14), predict (154 = 14 × 11 roles)
 */
const PHASE2_HEADS = {
  claim: HEAD_SIZES.claim,         // 10
  comm: HEAD_SIZES.comm,           // 119
  leader: HEAD_SIZES.leader,       // 3
  target: HEAD_SIZES.target,       // 14 (per-seat)
} as const

const PHASE2_SIGMOID_HEADS = {
  propose: HEAD_SIZES.propose,     // 14 (per-seat sigmoid)
  predict: SEATS * NUM_ROLES,      // 154 (per-seat sigmoid)
} as const

const PHASE2_PER_SEAT_HEADS = ['target'] as const
const PHASE2_PER_SEAT_SIGMOID_HEADS = ['propose', 'predict'] as const

/**
 * mason_brain と互換の MasonZeroNetwork 用 TransformerNetwork config。
 * training.ts の MASON_BRAIN_TRANSFORMER_CONFIG と同一内容。
 */
export const SKOLL_ZERO_NETWORK_CONFIG: NetworkConfig = {
  inputSize: MASON_COLLECTIVE_OBSERVATION_SIZE,
  heads: {
    vote: HEAD_SIZES.vote,
    ...PHASE2_HEADS,
  },
  sigmoidHeads: { ...PHASE2_SIGMOID_HEADS },
  transformer: {
    dModel: 64,
    numHeads: 4,
    dFf: 128,
    planFeatures: 0,
    maxPlanTokens: 0,
    roleFeatures: ROLE_TOKEN_FEATURES,
    numRoleTokens: NUM_ROLE_TOKENS,
    seatLayers: 3,
    strategyLayers: 2,
    numPlanTokens: 0,
    planVocabSize: 0,
    seatFeatures: MASON_COLLECTIVE_SEAT_FEATURES,
    clsFeatures: MASON_COLLECTIVE_CLS_FEATURES,
    perSeatHeads: ['vote', ...PHASE2_PER_SEAT_HEADS],
    perSeatSigmoidHeads: [...PHASE2_PER_SEAT_SIGMOID_HEADS],
  },
}

/** Pure JS (推論用)。ブラウザ可。 */
export function createSkollZeroNetwork(): TransformerNetwork {
  return new TransformerNetwork(SKOLL_ZERO_NETWORK_CONFIG, 'mason_collective')
}

/**
 * Standard individual 観測 (1029 dims) 用 config — village/fanatic/hamster/immoralist で共用。
 *
 * Heads:
 * - `vote`: 昼投票 (全役職で使用)
 * - `divine`: seer の夜占い先 (seer 以外は使わない、shared trunk 上の独立 head)
 * - `guard`: bodyguard の夜護衛先 (bodyguard 以外は使わない)
 * - Phase 2 共通: claim, comm, leader, target (per-seat), propose (per-seat sigmoid), predict (per-seat sigmoid)
 */
export const STANDARD_ZERO_NETWORK_CONFIG: NetworkConfig = {
  inputSize: OBSERVATION_SIZE,
  heads: {
    vote: HEAD_SIZES.vote,
    divine: HEAD_SIZES.vote,
    guard: HEAD_SIZES.vote,
    ...PHASE2_HEADS,
  },
  sigmoidHeads: { ...PHASE2_SIGMOID_HEADS },
  transformer: {
    dModel: 64,
    numHeads: 4,
    dFf: 128,
    planFeatures: 0,
    maxPlanTokens: 0,
    roleFeatures: ROLE_TOKEN_FEATURES,
    numRoleTokens: NUM_ROLE_TOKENS,
    seatLayers: 3,
    strategyLayers: 2,
    numPlanTokens: 0,
    planVocabSize: 0,
    seatFeatures: SEAT_TOKEN_FEATURES,
    clsFeatures: CLS_FEATURES,
    perSeatHeads: ['vote', 'divine', 'guard', ...PHASE2_PER_SEAT_HEADS],
    perSeatSigmoidHeads: [...PHASE2_PER_SEAT_SIGMOID_HEADS],
  },
}

/**
 * Wolf collective 観測 (1212 dims) 用 config。
 *
 * Heads:
 * - `vote`: 昼投票
 * - `attack`: 夜の噛み先 (vote とは別 head、policy 汚染を防ぐ)
 * - Phase 2 共通: claim, comm, leader, target (per-seat), propose (per-seat sigmoid), predict (per-seat sigmoid)
 */
export const WOLF_ZERO_NETWORK_CONFIG: NetworkConfig = {
  inputSize: WOLF_COLLECTIVE_OBSERVATION_SIZE,
  heads: {
    vote: HEAD_SIZES.vote,
    attack: HEAD_SIZES.vote,
    ...PHASE2_HEADS,
  },
  sigmoidHeads: { ...PHASE2_SIGMOID_HEADS },
  transformer: {
    dModel: 64,
    numHeads: 4,
    dFf: 128,
    planFeatures: 0,
    maxPlanTokens: 0,
    roleFeatures: ROLE_TOKEN_FEATURES,
    numRoleTokens: NUM_ROLE_TOKENS,
    seatLayers: 3,
    strategyLayers: 2,
    numPlanTokens: 0,
    planVocabSize: 0,
    seatFeatures: WOLF_COLLECTIVE_SEAT_FEATURES,
    clsFeatures: WOLF_COLLECTIVE_CLS_FEATURES,
    perSeatHeads: ['vote', 'attack', ...PHASE2_PER_SEAT_HEADS],
    perSeatSigmoidHeads: [...PHASE2_PER_SEAT_SIGMOID_HEADS],
  },
}

export function createStandardZeroNetwork(): TransformerNetwork {
  return new TransformerNetwork(STANDARD_ZERO_NETWORK_CONFIG, 'individual')
}

export function createWolfZeroNetwork(): TransformerNetwork {
  return new TransformerNetwork(WOLF_ZERO_NETWORK_CONFIG, 'wolf_collective')
}
