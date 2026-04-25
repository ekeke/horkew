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
  FANATIC_OBSERVATION_SIZE, FANATIC_SEAT_FEATURES, FANATIC_CLS_FEATURES,
  OBSERVATION_SIZE, SEAT_TOKEN_FEATURES, CLS_FEATURES,
  NUM_ROLE_TOKENS, ROLE_TOKEN_FEATURES, SEATS,
} from '../../fenrir/src/observation.ts'
import { HEAD_SIZES } from '../../fenrir/src/action.ts'

// ============================================================
// Stage 3 で追加した skoll-zero 専用 head のサイズ
// ============================================================

/** claim_*_true: 2 dim (skip / CO) — global head */
export const CLAIM_TRUE_HEAD_SIZE = 2
/** claim_*_fake: 1 + SEATS dim (skip + claimer seat) — global head */
export const CLAIM_FAKE_HEAD_SIZE = 1 + SEATS  // 15
/** morning: SEATS × 2 dim (target_idx × {human, wolf}) — global head, B-combined */
export const MORNING_HEAD_SIZE = SEATS * 2  // 28

/**
 * mason_brain と互換の MasonZeroNetwork 用 TransformerNetwork config。
 *
 * Heads:
 * - `execute` (per-seat): 昼投票
 * - `claim_true` (global, 2-dim): mason の真 CO 判断 (skip / CO)
 */
export const SKOLL_ZERO_NETWORK_CONFIG: NetworkConfig = {
  inputSize: MASON_COLLECTIVE_OBSERVATION_SIZE,
  heads: {
    execute: HEAD_SIZES.vote,
    claim_true: CLAIM_TRUE_HEAD_SIZE,
  },
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
    perSeatHeads: ['execute'],
  },
}

/** Pure JS (推論用)。ブラウザ可。 */
export function createSkollZeroNetwork(): TransformerNetwork {
  return new TransformerNetwork(SKOLL_ZERO_NETWORK_CONFIG, 'mason_collective')
}

/**
 * Standard individual 観測 (1029 dims) 用 config — village 系 (villager / seer /
 * medium / bodyguard / nekomata) と third 系 (werehamster / immoralist) で共用。
 *
 * Heads:
 * - `execute` (per-seat): 昼投票
 * - `divine` (per-seat): 真 seer の夜占い先 (seer 以外は使わない、shared trunk 上の独立 head)
 * - `guard` (per-seat): 真 bodyguard の夜護衛先
 * - `claim_true` (global, 2-dim): village 系の真 CO 判断 (skip / CO)
 */
export const STANDARD_ZERO_NETWORK_CONFIG: NetworkConfig = {
  inputSize: OBSERVATION_SIZE,
  heads: {
    execute: HEAD_SIZES.vote,
    divine: HEAD_SIZES.vote,
    guard: HEAD_SIZES.vote,
    claim_true: CLAIM_TRUE_HEAD_SIZE,
  },
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
    perSeatHeads: ['execute', 'divine', 'guard'],
  },
}

/**
 * Wolf collective 観測 (1212 dims) 用 config。
 *
 * Heads:
 * - `execute` (per-seat): 昼投票
 * - `attack` (per-seat): 夜の噛み先 (execute とは別 head、policy 汚染を防ぐ)
 * - `claim_fake` (global, 15-dim): 偽 CO 判断 (skip + claimer seat)
 * - `morning` (global, 28-dim): 偽占い報告 (target_idx × {human, wolf})
 */
export const WOLF_ZERO_NETWORK_CONFIG: NetworkConfig = {
  inputSize: WOLF_COLLECTIVE_OBSERVATION_SIZE,
  heads: {
    execute: HEAD_SIZES.vote,
    attack: HEAD_SIZES.vote,
    claim_fake: CLAIM_FAKE_HEAD_SIZE,
    morning: MORNING_HEAD_SIZE,
  },
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
    perSeatHeads: ['execute', 'attack'],
  },
}

/**
 * Fanatic 観測 (1197 dims) 用 config。
 *
 * Heads:
 * - `execute` (per-seat): 昼投票
 * - `claim_fake` (global, 15-dim): 偽 CO 判断 (skip + claimer seat)
 * - `morning` (global, 28-dim): 偽占い報告 (target_idx × {human, wolf})
 *
 * 狼集団とは別 NN (個人観測ベース、village_predict/trust 注入)。
 * Stage 3 では MCTS の claim_fake/morning dispatch は wolf module に集約 (簡素化)。
 * fanatic Module の claim_fake/morning head は将来 fanatic-specific シナリオで活用。
 */
export const FANATIC_ZERO_NETWORK_CONFIG: NetworkConfig = {
  inputSize: FANATIC_OBSERVATION_SIZE,
  heads: {
    execute: HEAD_SIZES.vote,
    claim_fake: CLAIM_FAKE_HEAD_SIZE,
    morning: MORNING_HEAD_SIZE,
  },
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
    seatFeatures: FANATIC_SEAT_FEATURES,
    clsFeatures: FANATIC_CLS_FEATURES,
    perSeatHeads: ['execute'],
  },
}

export function createStandardZeroNetwork(): TransformerNetwork {
  return new TransformerNetwork(STANDARD_ZERO_NETWORK_CONFIG, 'individual')
}

export function createWolfZeroNetwork(): TransformerNetwork {
  return new TransformerNetwork(WOLF_ZERO_NETWORK_CONFIG, 'wolf_collective')
}

export function createFanaticZeroNetwork(): TransformerNetwork {
  return new TransformerNetwork(FANATIC_ZERO_NETWORK_CONFIG, 'fanatic')
}
