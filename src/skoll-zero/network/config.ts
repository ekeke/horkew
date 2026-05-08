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

// ============================================================
// Stage 4: Outcome distribution value head
// ============================================================

/**
 * skoll-zero が学習目標とする「終局時の結果」4 種。
 *
 * hati GameOutcome (village_win/wolf_win/hamster_win/ongoing) と異なり、
 * - 'ongoing' は除外 (終局していない)
 * - 'draw' は含む (lupa の引き分け結果に対応)
 */
export type FinalOutcome = 'village_win' | 'wolf_win' | 'hamster_win' | 'draw'

/** outcome distribution head の outcome 順序 (config.outcomeDistOutputs = 4 に対応) */
export const OUTCOME_ORDER: ReadonlyArray<FinalOutcome> = [
  'village_win', 'wolf_win', 'hamster_win', 'draw',
] as const

/** outcome distribution head のサイズ (4 = 上記 OUTCOME_ORDER の長さ) */
export const OUTCOME_DIST_SIZE = OUTCOME_ORDER.length  // 4

/** outcome → OUTCOME_ORDER の index */
export const OUTCOME_INDEX = new Map<FinalOutcome, number>(
  OUTCOME_ORDER.map((o, i) => [o, i] as const),
)

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
  outcomeDistOutputs: OUTCOME_DIST_SIZE,
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
  outcomeDistOutputs: OUTCOME_DIST_SIZE,
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
  outcomeDistOutputs: OUTCOME_DIST_SIZE,
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
  outcomeDistOutputs: OUTCOME_DIST_SIZE,
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

// ============================================================
// Wolf Imitation: 真占い base からの deviation を学習する狼 NN
// ============================================================

/**
 * Wolf Imitation 用 config。観測は既存 Wolf Collective (1212 dims) と同形。
 *
 * Heads:
 * - `execute`         (per-seat 14): 昼投票 — 純 wolf
 * - `attack`          (per-seat 14): 夜の噛み先 — 純 wolf
 * - `claim_fake_dev`  (global 15):   偽 CO 判断の deviation (mix で claim_true と合成)
 * - `alpha_claim`     (global 2):    binary softmax、σ_claim = policies['alpha_claim'][1]
 * - `morning_tgt_dev` (per-seat 14): 偽占い対象の deviation (mix で divine と合成)
 * - `alpha_morning`   (global 2):    binary softmax、σ_morning = policies['alpha_morning'][1]
 * - `morning_res`     (per-seat 14): 偽占い結果 (white/black 配分) — 純 wolf
 *
 * 推論時に WolfImitationNetwork.mixForward が:
 *   - `claim_fake[skip]` ← σ_claim と claim_true を凸結合
 *   - `morning[target]` ← σ_morning と divine を凸結合
 * の 2 箇所 mix を行い、最終 policy として既存 wolf NN 互換 (claim_fake 15 + morning 28) を出力。
 *
 * 学習時は raw logits + α を生で出力し、PPO 損失は最終 mix policy で計算する。
 */
export const WOLF_IMITATION_ZERO_NETWORK_CONFIG: NetworkConfig = {
  inputSize: WOLF_COLLECTIVE_OBSERVATION_SIZE,
  heads: {
    execute: HEAD_SIZES.vote,
    attack: HEAD_SIZES.vote,
    claim_fake_dev: CLAIM_FAKE_HEAD_SIZE,
    alpha_claim: 2,
    morning_tgt_dev: HEAD_SIZES.vote,
    alpha_morning: 2,
    morning_res: HEAD_SIZES.vote,
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
    perSeatHeads: ['execute', 'attack', 'morning_tgt_dev', 'morning_res'],
  },
  outcomeDistOutputs: OUTCOME_DIST_SIZE,
}

export function createWolfImitationZeroNetwork(): TransformerNetwork {
  return new TransformerNetwork(WOLF_IMITATION_ZERO_NETWORK_CONFIG, 'wolf_collective')
}
