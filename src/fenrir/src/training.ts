/**
 * PPO Training Loop
 *
 * 自己対戦でゲームを生成し、PPOで重みを更新する。
 */

import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig, RevoteConfig } from '../../lupa/types.ts'
import type { Agent } from './agents/agent.ts'
import { runGame, resumeGame } from '../../lupa/engine.ts'
import { formatHowl } from '../../lupa/format.ts'
import { MasonTrainingAdapter } from './adapters/mason-training-adapter.ts'
import { fullAdapter } from './adapters/full-adapter.ts'
import { initRetarWorkerPool, terminateRetarWorkerPool } from './retar-node-bridge.ts'
import { NeuralNetwork } from './ml/nn.ts'
import type { NetworkConfig, AnyNetwork, AnyTfNetwork } from './ml/nn.ts'
import { TfNeuralNetwork } from './ml/nn-tf.ts'
import { TransformerNetwork } from './ml/transformer-network.ts'
import { TfTransformerNetwork } from './ml/nn-tf-transformer.ts'
import { OBSERVATION_SIZE, TEAM_OBSERVATION_SIZE,
  WOLF_COLLECTIVE_OBSERVATION_SIZE, MASON_COLLECTIVE_OBSERVATION_SIZE,
  FANATIC_OBSERVATION_SIZE,
  CLS_FEATURES, TEAM_CLS_FEATURES, SEAT_TOKEN_FEATURES, TEAM_SEAT_TOKEN_FEATURES,
  WOLF_COLLECTIVE_CLS_FEATURES, WOLF_COLLECTIVE_SEAT_FEATURES,
  MASON_COLLECTIVE_CLS_FEATURES, MASON_COLLECTIVE_SEAT_FEATURES,
  FANATIC_CLS_FEATURES, FANATIC_SEAT_FEATURES,
  ROLE_TOKEN_FEATURES, NUM_ROLE_TOKENS } from './observation.ts'
import { HEAD_SIZES, TEAM_HEAD_SIZES } from './action.ts'
import { encodeTrueRoles } from './observation.ts'
import { NeuralAgent } from './agents/neural-agent.ts'
import { FanaticAgent } from './agents/fanatic-agent.ts'
import { WolfTeamAgent, WolfCollective } from './agents/wolf-collective.ts'
import { MasonTeamAgent, MasonCollective } from './agents/mason-collective.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from './agents/rule-based-agent.ts'
import { terminalReward, intermediateReward, type RewardConfig, DEFAULT_REWARD_CONFIG } from './reward.ts'
import { processTrajectories, normalizeAdvantages, computeGAE, type TrajectoryStep, type ProcessedStep } from './ml/trajectory.ts'
import { saveCheckpoint, loadCheckpoint } from './ml/checkpoint.ts'
import { packWeights, initGameWorkerPool, terminateGameWorkerPool, gameWorkerPoolSize, generateGamesParallel, deserializeStep, type SharedWeights } from './parallel.ts'

// ============================================================
// Model Groups (Phase 2 マルチモデル)
// ============================================================

export type ModelGroupName = 'village' | 'wolf' | 'third'

export const MODEL_GROUP_DEFS: Record<ModelGroupName, { roles: SystemRole[], teamType?: 'wolf_team' | 'mason_team' }> = {
  village:  { roles: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata', 'mason'], teamType: 'mason_team' },
  wolf:     { roles: ['werewolf', 'fanatic'], teamType: 'wolf_team' },
  third:    { roles: ['werehamster', 'immoralist'] },
}

export const MODEL_GROUP_NAMES: ModelGroupName[] = ['village', 'wolf', 'third']

/** role → ModelGroupName の逆引き */
const ROLE_TO_GROUP_NAME = new Map<SystemRole, ModelGroupName>()
for (const [name, def] of Object.entries(MODEL_GROUP_DEFS) as [ModelGroupName, { roles: SystemRole[] }][]) {
  for (const role of def.roles) ROLE_TO_GROUP_NAME.set(role, name)
}

type ModelGroup = {
  name: ModelGroupName
  roles: SystemRole[]
  network: AnyNetwork
  tfNetwork: AnyTfNetwork
  /** チェックポイント未発見 → heuristic フォールバック、PPO更新スキップ */
  heuristicOnly: boolean
}

// ============================================================
// Training Config
// ============================================================

export type TrainingConfig = {
  /** ゲーム構成 */
  roles: Record<string, number>
  /** バッチあたりのゲーム数 */
  gamesPerBatch: number
  /** PPOエポック数 */
  ppoEpochs: number
  /** ミニバッチサイズ */
  miniBatchSize: number
  /** PPOクリッピング */
  clipEpsilon: number
  /** Value loss係数 */
  valueLossCoeff: number
  /** Entropy bonus係数 */
  entropyCoeff: number
  /** Predict補助損失係数 (0でオフ) */
  predictLossCoeff?: number
  /** 戦略NNのみ学習（行動はルールベース、Step 1 bootstrap） */
  strategyOnly?: boolean
  /** 割引率 */
  gamma: number
  /** GAE lambda */
  lambda: number
  /** 総イテレーション数 */
  totalIterations: number
  /** 評価間隔 */
  evalInterval: number
  /** チェックポイント保存間隔 */
  checkpointInterval: number
  /** チェックポイント保存先 */
  checkpointDir: string
  /** 報酬設定 */
  rewardConfig: RewardConfig
  /** カリキュラムフェーズ切替 */
  phase1End: number   // ヒューリスティック相手フェーズ終了
  phase2End: number   // 自己対戦フェーズ終了
  /** 学習率 */
  learningRate: number
  /** Retar論理推論を有効化 */
  enableRetar: boolean
  /** 初日犠牲者あり (rules['first-victim'] で代替可) */
  hasFirstGhost: boolean
  /** 再投票設定 */
  revoteConfig?: RevoteConfig
  /** オプションルール */
  rules?: Partial<import('../../types/index.ts').ResolvedRules>
  /** ゲーム生成の並列ワーカー数（0で直列、未指定でauto） */
  numWorkers?: number
  /** Phase 1でMLにする役職（未指定時は偶数seat） */
  mlRoles?: SystemRole[]
  /** Transformerアーキテクチャを使用 */
  useTransformer?: boolean
  /** Phase 2マルチモデル: 3モデルのチェックポイントDir (village,wolf,third順) */
  phase2ModelDirs?: string[]
  /** 目標勝率 (0-1)。eval でこの勝率を超えたら早期終了 */
  targetWinRate?: number
  /** チェックする陣営 ('villageWin' | 'wolfWin' | 'hamsterWin') */
  targetFaction?: string
  /** KL penalty coefficient (β). >0 で plan token の KL(π_new || π_ref) を loss に加算 */
  klCoeff?: number
  /** Frozen reference network for KL penalty */
  refNetwork?: AnyNetwork
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  // 14D猫: 14人、初日犠牲者あり、完全再投票→引き分け
  roles: {
    werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
    mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
  },
  hasFirstGhost: true,
  revoteConfig: { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' },
  gamesPerBatch: 64,
  ppoEpochs: 4,
  miniBatchSize: 256,
  clipEpsilon: 0.2,
  valueLossCoeff: 0.5,
  entropyCoeff: 0.01,
  gamma: 0.99,
  lambda: 0.95,
  totalIterations: 100000,
  evalInterval: 1000,
  checkpointInterval: 5000,
  checkpointDir: './checkpoints',  // CLI側で ./checkpoints/nn or ./checkpoints/transformer に自動変更
  rewardConfig: DEFAULT_REWARD_CONFIG,
  phase1End: 10000,
  phase2End: 50000,
  learningRate: 3e-4,
  enableRetar: true,
}

// ============================================================
// Network Configuration
// ============================================================

const NETWORK_CONFIG = {
  inputSize: OBSERVATION_SIZE,
  hiddenSizes: [512, 256],
  heads: {
    night: HEAD_SIZES.night,
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
}

// 狼チームネットワーク: attack_target + attacker + 昼行動ヘッド
const WOLF_TEAM_NETWORK_CONFIG = {
  inputSize: TEAM_OBSERVATION_SIZE,
  hiddenSizes: [512, 256],
  heads: {
    attack_target: TEAM_HEAD_SIZES.attack_target,
    attacker: TEAM_HEAD_SIZES.attacker,
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
}

// 共有者チームネットワーク: 昼行動ヘッドのみ
const MASON_TEAM_NETWORK_CONFIG = {
  inputSize: TEAM_OBSERVATION_SIZE,
  hiddenSizes: [512, 256],
  heads: {
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
}

// ============================================================
// Transformer Network Configuration
// ============================================================

/** 戦略NN共通設定 */
const TRANSFORMER_COMMON = {
  dModel: 64,
  numHeads: 4,
  dFf: 128,
  planFeatures: 0,    // 旧互換: raw plan indices 方式では不要
  maxPlanTokens: 0,   // 旧互換: raw plan indices 方式では不要
  roleFeatures: ROLE_TOKEN_FEATURES,
  numRoleTokens: NUM_ROLE_TOKENS,
  seatLayers: 3,
  strategyLayers: 2,
  numForwardTokens: 8,
  numEndgameTokens: 4,
  planVocabSize: 22,  // 14 seats + 5 roles + grayran + next + stop = PLAN_VOCAB.SIZE
}

const TRANSFORMER_NETWORK_CONFIG: NetworkConfig = {
  inputSize: OBSERVATION_SIZE,
  hiddenSizes: [],
  heads: {
    night: HEAD_SIZES.night,
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
  transformer: {
    ...TRANSFORMER_COMMON,
    seatFeatures: SEAT_TOKEN_FEATURES,
    clsFeatures: CLS_FEATURES,
    perSeatHeads: ['vote', 'target'],
    perSeatSigmoidHeads: ['propose', 'predict'],
  },
}

const WOLF_TEAM_TRANSFORMER_CONFIG: NetworkConfig = {
  inputSize: TEAM_OBSERVATION_SIZE,
  hiddenSizes: [],
  heads: {
    attack_target: TEAM_HEAD_SIZES.attack_target,
    attacker: TEAM_HEAD_SIZES.attacker,
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
  transformer: {
    ...TRANSFORMER_COMMON,
    seatFeatures: TEAM_SEAT_TOKEN_FEATURES,
    clsFeatures: TEAM_CLS_FEATURES,
    perSeatHeads: ['vote', 'target', 'attack_target'],
    perSeatSigmoidHeads: ['propose', 'predict'],
  },
}

const MASON_TEAM_TRANSFORMER_CONFIG: NetworkConfig = {
  inputSize: TEAM_OBSERVATION_SIZE,
  hiddenSizes: [],
  heads: {
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
  transformer: {
    ...TRANSFORMER_COMMON,
    seatFeatures: TEAM_SEAT_TOKEN_FEATURES,
    clsFeatures: TEAM_CLS_FEATURES,
    perSeatHeads: ['vote', 'target'],
    perSeatSigmoidHeads: ['propose', 'predict'],
  },
}

// ============================================================
// Collective Network Configurations (Transformer only)
// ============================================================

const WOLF_COLLECTIVE_TRANSFORMER_CONFIG: NetworkConfig = {
  inputSize: WOLF_COLLECTIVE_OBSERVATION_SIZE,
  hiddenSizes: [],
  heads: {
    attack_target: TEAM_HEAD_SIZES.attack_target,
    attacker: TEAM_HEAD_SIZES.attacker,
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
    co_policy: 8,  // per-member output (読み出しはper-seat headとして)
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
  transformer: {
    ...TRANSFORMER_COMMON,
    seatFeatures: WOLF_COLLECTIVE_SEAT_FEATURES,
    clsFeatures: WOLF_COLLECTIVE_CLS_FEATURES,
    perSeatHeads: ['vote', 'target', 'attack_target', 'co_policy'],
    perSeatSigmoidHeads: ['propose', 'predict'],
  },
}

const MASON_COLLECTIVE_TRANSFORMER_CONFIG: NetworkConfig = {
  inputSize: MASON_COLLECTIVE_OBSERVATION_SIZE,
  hiddenSizes: [],
  heads: {
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
    co_policy: 8,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
  transformer: {
    ...TRANSFORMER_COMMON,
    seatFeatures: MASON_COLLECTIVE_SEAT_FEATURES,
    clsFeatures: MASON_COLLECTIVE_CLS_FEATURES,
    perSeatHeads: ['vote', 'target', 'co_policy'],
    perSeatSigmoidHeads: ['propose', 'predict'],
  },
}

// ============================================================
// Fanatic Network Configuration (Transformer only)
// ============================================================

const FANATIC_TRANSFORMER_CONFIG: NetworkConfig = {
  inputSize: FANATIC_OBSERVATION_SIZE,
  hiddenSizes: [],
  heads: {
    night: HEAD_SIZES.night,
    claim: HEAD_SIZES.claim,
    vote: HEAD_SIZES.vote,
    comm: HEAD_SIZES.comm,
    leader: HEAD_SIZES.leader,
    target: HEAD_SIZES.target,
  },
  sigmoidHeads: {
    propose: HEAD_SIZES.propose,
    predict: HEAD_SIZES.predict,
  },
  transformer: {
    ...TRANSFORMER_COMMON,
    seatFeatures: FANATIC_SEAT_FEATURES,
    clsFeatures: FANATIC_CLS_FEATURES,
    perSeatHeads: ['vote', 'target'],
    perSeatSigmoidHeads: ['propose', 'predict'],
  },
}

// ============================================================
// Factory Functions
// ============================================================

/** 推論用（ゲーム内、ピュアJS — 単一forward が速い） */
export function createNetwork(): NeuralNetwork {
  return new NeuralNetwork(NETWORK_CONFIG)
}

export function createWolfTeamNetwork(): NeuralNetwork {
  return new NeuralNetwork(WOLF_TEAM_NETWORK_CONFIG)
}

export function createMasonTeamNetwork(): NeuralNetwork {
  return new NeuralNetwork(MASON_TEAM_NETWORK_CONFIG)
}

/** 学習用（PPOバッチ更新、tf.js GPU加速） */
export function createTfNetwork(lr: number = 3e-4): TfNeuralNetwork {
  return new TfNeuralNetwork(NETWORK_CONFIG, lr)
}

export function createWolfTeamTfNetwork(lr: number = 3e-4): TfNeuralNetwork {
  return new TfNeuralNetwork(WOLF_TEAM_NETWORK_CONFIG, lr)
}

export function createMasonTeamTfNetwork(lr: number = 3e-4): TfNeuralNetwork {
  return new TfNeuralNetwork(MASON_TEAM_NETWORK_CONFIG, lr)
}

// ---- Transformer variants ----

/** Transformer推論用（ピュアJS） */
export function createTransformerNetwork(): TransformerNetwork {
  return new TransformerNetwork(TRANSFORMER_NETWORK_CONFIG)
}

export function createWolfTeamTransformerNetwork(): TransformerNetwork {
  return new TransformerNetwork(WOLF_TEAM_TRANSFORMER_CONFIG, true)
}

export function createMasonTeamTransformerNetwork(): TransformerNetwork {
  return new TransformerNetwork(MASON_TEAM_TRANSFORMER_CONFIG, true)
}

/** Transformer学習用（tf.js GPU） */
export function createTransformerTfNetwork(lr: number = 3e-4): TfTransformerNetwork {
  return new TfTransformerNetwork(TRANSFORMER_NETWORK_CONFIG, lr)
}

export function createWolfTeamTransformerTfNetwork(lr: number = 3e-4): TfTransformerNetwork {
  return new TfTransformerNetwork(WOLF_TEAM_TRANSFORMER_CONFIG, lr, true)
}

export function createMasonTeamTransformerTfNetwork(lr: number = 3e-4): TfTransformerNetwork {
  return new TfTransformerNetwork(MASON_TEAM_TRANSFORMER_CONFIG, lr, true)
}

// ---- Collective variants (Transformer only) ----

export function createWolfCollectiveNetwork(): TransformerNetwork {
  return new TransformerNetwork(WOLF_COLLECTIVE_TRANSFORMER_CONFIG, 'wolf_collective')
}

export function createMasonCollectiveNetwork(): TransformerNetwork {
  return new TransformerNetwork(MASON_COLLECTIVE_TRANSFORMER_CONFIG, 'mason_collective')
}

export function createWolfCollectiveTfNetwork(lr: number = 3e-4): TfTransformerNetwork {
  return new TfTransformerNetwork(WOLF_COLLECTIVE_TRANSFORMER_CONFIG, lr, 'wolf_collective')
}

export function createMasonCollectiveTfNetwork(lr: number = 3e-4): TfTransformerNetwork {
  return new TfTransformerNetwork(MASON_COLLECTIVE_TRANSFORMER_CONFIG, lr, 'mason_collective')
}

// ---- Fanatic variants (Transformer only) ----

export function createFanaticNetwork(): TransformerNetwork {
  return new TransformerNetwork(FANATIC_TRANSFORMER_CONFIG, 'fanatic')
}

export function createFanaticTfNetwork(lr: number = 3e-4): TfTransformerNetwork {
  return new TfTransformerNetwork(FANATIC_TRANSFORMER_CONFIG, lr, 'fanatic')
}

// ============================================================
// Game Generation
// ============================================================

type GameTrajectories = {
  /** 個人エージェントのトラジェクトリ: seat → steps */
  steps: Map<number, TrajectoryStep[]>
  /** 狼チームのトラジェクトリ (チーム全体で1つ) */
  wolfTeamSteps: TrajectoryStep[]
  /** 共有者チームのトラジェクトリ (チーム全体で1つ) */
  masonTeamSteps: TrajectoryStep[]
  result: string
}

type GameAgents = {
  neuralAgents: Map<number, NeuralAgent>
  defaultAgent?: Agent
  onRolesAssigned?: (seatRoles: Map<number, SystemRole>) => void
  wolfTeamAgent?: WolfTeamAgent
  masonTeamAgent?: MasonTeamAgent
}

async function generateGame(
  config: TrainingConfig,
  agents: GameAgents,
  seed: number,
): Promise<GameTrajectories> {
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])

  const agentsMap = new Map<number, Agent>(agents.neuralAgents)

  // Reset trajectories
  for (const s of agents.neuralAgents.values()) s.resetTrajectory?.()
  agents.wolfTeamAgent?.resetTrajectory()
  agents.masonTeamAgent?.resetTrajectory()

  let state: import('../../lupa/types.ts').GameState
  let events: (import('../../lupa/types.ts').GameEvent | import('./events.ts').FenrirExtEvent)[]

  if (config.strategyOnly) {
    const handlers = new MasonTrainingAdapter({
      agents: agentsMap,
      defaultAgent: agents.defaultAgent,
      wolfTeamAgent: agents.wolfTeamAgent,
      masonTeamAgent: agents.masonTeamAgent,
      onRolesAssigned: agents.onRolesAssigned ? (seatRoles: Map<number, SystemRole>) => {
        agents.onRolesAssigned!(seatRoles)
        for (const [seat, s] of agents.neuralAgents) {
          if (!agentsMap.has(seat)) agentsMap.set(seat, s)
        }
      } : undefined,
      seed,
    })
    const result = await runGame(
      { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules },
      handlers,
    )
    state = result.state
    events = result.events
  } else {
    const handlers = fullAdapter({
      agents: agentsMap,
      defaultAgent: agents.defaultAgent ?? new RuleBasedAgent(),
      wolfTeamAgent: agents.wolfTeamAgent,
      masonTeamAgent: agents.masonTeamAgent,
      enableRetar: config.enableRetar,
      onRolesAssigned: agents.onRolesAssigned ? (seatRoles: Map<number, SystemRole>) => {
        agents.onRolesAssigned!(seatRoles)
        for (const [seat, s] of agents.neuralAgents) {
          if (!agentsMap.has(seat)) agentsMap.set(seat, s)
        }
      } : undefined,
      seed,
      roles,
      rules: config.rules,
    })
    const result = await runGame(
      { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules },
      handlers,
    )
    state = result.state
    events = result.events
  }

  // Collect individual trajectories and add terminal rewards
  const allSteps = new Map<number, TrajectoryStep[]>()
  for (const [seat, agent] of agents.neuralAgents) {
    const steps = agent.trajectory
    if (steps.length > 0) {
      steps[steps.length - 1].done = true
      const player = state.players.find(p => p.seat === seat)!
      const reward = terminalReward(player.role, state.result ?? '', config.rewardConfig)
      steps[steps.length - 1].reward += reward
    }
    allSteps.set(seat, steps)
  }

  // Collect wolf team trajectories
  const wolfTeamSteps = agents.wolfTeamAgent?.trajectory ?? []
  if (wolfTeamSteps.length > 0) {
    wolfTeamSteps[wolfTeamSteps.length - 1].done = true
    // 狼チーム報酬: 狼陣営の結果
    const wolfReward = terminalReward('werewolf', state.result ?? '', config.rewardConfig)
    wolfTeamSteps[wolfTeamSteps.length - 1].reward += wolfReward
  }

  // Collect mason team trajectories
  const masonTeamSteps = agents.masonTeamAgent?.trajectory ?? []
  if (masonTeamSteps.length > 0) {
    masonTeamSteps[masonTeamSteps.length - 1].done = true
    // 共有者チーム報酬: 村陣営の結果
    const masonReward = terminalReward('mason', state.result ?? '', config.rewardConfig)
    masonTeamSteps[masonTeamSteps.length - 1].reward += masonReward
  }

  // Add intermediate rewards
  for (const event of events) {
    const rewards = intermediateReward(event as import('../../lupa/types.ts').GameEvent, state, config.rewardConfig)
    for (const [seat, reward] of rewards) {
      // Individual agents
      const steps = allSteps.get(seat)
      if (steps && steps.length > 0) {
        steps[steps.length - 1].reward += reward
      }
      // Wolf team: aggregate wolf rewards
      const player = state.players.find(p => p.seat === seat)
      if (player && (player.role === 'werewolf') && wolfTeamSteps.length > 0) {
        wolfTeamSteps[wolfTeamSteps.length - 1].reward += reward
      }
      // Mason team: aggregate mason rewards
      if (player && (player.role === 'mason') && masonTeamSteps.length > 0) {
        masonTeamSteps[masonTeamSteps.length - 1].reward += reward
      }
    }
  }

  // trueRoles注入 + 推理精度報酬
  const trueRoles = encodeTrueRoles(state.players)
  for (const [, steps] of allSteps) {
    for (const step of steps) {
      step.trueRoles = trueRoles
    }
  }

  return {
    steps: allSteps,
    wolfTeamSteps,
    masonTeamSteps,
    result: state.result ?? 'unknown',
  }
}

/** 非同期版: full-adapter + Retarを使用 */
async function generateGameAsync(
  config: TrainingConfig,
  agents: GameAgents,
  seed: number,
): Promise<GameTrajectories> {
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])

  const agentsMap = new Map<number, Agent>(agents.neuralAgents)
  const handlers = fullAdapter({
    agents: agentsMap,
    defaultAgent: agents.defaultAgent ?? new RuleBasedAgent(),
    wolfTeamAgent: agents.wolfTeamAgent,
    masonTeamAgent: agents.masonTeamAgent,
    enableRetar: config.enableRetar,
    onRolesAssigned: agents.onRolesAssigned ? (seatRoles: Map<number, SystemRole>) => {
      agents.onRolesAssigned!(seatRoles)
      for (const [seat, s] of agents.neuralAgents) {
        if (!agentsMap.has(seat)) agentsMap.set(seat, s)
      }
    } : undefined,
    seed,
    roles,
    rules: config.rules,
  })

  for (const s of agents.neuralAgents.values()) s.resetTrajectory?.()
  agents.wolfTeamAgent?.resetTrajectory()
  agents.masonTeamAgent?.resetTrajectory()

  const { state, events } = await runGame(
    { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules },
    handlers,
  )

  // 以降はgenerateGameと同一のトラジェクトリ収集
  const allSteps = new Map<number, TrajectoryStep[]>()
  for (const [seat, agent] of agents.neuralAgents) {
    const steps = agent.trajectory
    if (steps.length > 0) {
      steps[steps.length - 1].done = true
      const player = state.players.find(p => p.seat === seat)!
      steps[steps.length - 1].reward += terminalReward(player.role, state.result ?? '', config.rewardConfig)
    }
    allSteps.set(seat, steps)
  }
  const wolfTeamSteps = agents.wolfTeamAgent?.trajectory ?? []
  if (wolfTeamSteps.length > 0) {
    wolfTeamSteps[wolfTeamSteps.length - 1].done = true
    wolfTeamSteps[wolfTeamSteps.length - 1].reward += terminalReward('werewolf', state.result ?? '', config.rewardConfig)
  }
  const masonTeamSteps = agents.masonTeamAgent?.trajectory ?? []
  if (masonTeamSteps.length > 0) {
    masonTeamSteps[masonTeamSteps.length - 1].done = true
    masonTeamSteps[masonTeamSteps.length - 1].reward += terminalReward('mason', state.result ?? '', config.rewardConfig)
  }
  for (const event of events) {
    const rewards = intermediateReward(event as import('../../lupa/types.ts').GameEvent, state, config.rewardConfig)
    for (const [seat, reward] of rewards) {
      const steps = allSteps.get(seat)
      if (steps && steps.length > 0) steps[steps.length - 1].reward += reward
      const player = state.players.find(p => p.seat === seat)
      if (player?.role === 'werewolf' && wolfTeamSteps.length > 0) wolfTeamSteps[wolfTeamSteps.length - 1].reward += reward
      if (player?.role === 'mason' && masonTeamSteps.length > 0) masonTeamSteps[masonTeamSteps.length - 1].reward += reward
    }
  }
  return { steps: allSteps, wolfTeamSteps, masonTeamSteps, result: state.result ?? 'unknown' }
}

// ============================================================
// PPO Update (tf.js GPU バッチ)
// ============================================================

function ppoUpdate(
  tfNetwork: AnyTfNetwork,
  batch: ProcessedStep[],
  config: TrainingConfig,
  precomputedRefLogits?: Map<ProcessedStep, { fwd?: Float32Array, eg?: Float32Array }>,
): { policyLoss: number, valueLoss: number, entropy: number, predictLoss: number, klLoss: number, klForwardLoss: number, klEndgameLoss: number } {
  if (batch.length === 0) return { policyLoss: 0, valueLoss: 0, entropy: 0, predictLoss: 0, klLoss: 0, klForwardLoss: 0, klEndgameLoss: 0 }

  let totalPolicyLoss = 0
  let totalValueLoss = 0
  let totalEntropy = 0
  let totalPredictLoss = 0
  let totalKlLoss = 0
  let totalKlForwardLoss = 0
  let totalKlEndgameLoss = 0
  let batchCount = 0

  // Shuffle batch
  for (let i = batch.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[batch[i], batch[j]] = [batch[j], batch[i]]
  }

  // Mini-batches → tf.js GPU
  for (let start = 0; start < batch.length; start += config.miniBatchSize) {
    const end = Math.min(start + config.miniBatchSize, batch.length)
    const miniBatch = batch.slice(start, end)

    // Reference logits lookup (precomputed per iteration)
    let refFwdLogits: (Float32Array | undefined)[] | undefined
    let refEgLogits: (Float32Array | undefined)[] | undefined
    if (precomputedRefLogits && config.klCoeff && config.klCoeff > 0) {
      refFwdLogits = miniBatch.map(s => precomputedRefLogits.get(s)?.fwd)
      refEgLogits = miniBatch.map(s => precomputedRefLogits.get(s)?.eg)
    }

    const result = tfNetwork.trainBatch({
      observations: miniBatch.map(s => s.observation),
      actionHeads: miniBatch.map(s => s.actionHead),
      actionIndices: miniBatch.map(s => s.actionIdx),
      oldLogProbs: miniBatch.map(s => s.logProb),
      advantages: miniBatch.map(s => s.advantage),
      returns: miniBatch.map(s => s.returnValue),
      sigmoidActions: miniBatch.map(s => s.sigmoidActions),
      trueRoles: miniBatch.map(s => s.trueRoles),
      planForwardActions: miniBatch.map(s => s.planForwardActions),
      planForwardLogProbs: miniBatch.map(s => s.planForwardLogProbs),
      planEndgameActions: miniBatch.map(s => s.planEndgameActions),
      planEndgameLogProbs: miniBatch.map(s => s.planEndgameLogProbs),
      predictLossCoeff: config.predictLossCoeff ?? 0.1,
      clipEpsilon: config.clipEpsilon,
      valueLossCoeff: config.valueLossCoeff,
      entropyCoeff: config.entropyCoeff,
      refPlanForwardLogits: refFwdLogits,
      refPlanEndgameLogits: refEgLogits,
      klCoeff: config.klCoeff,
    })

    totalPolicyLoss += result.policyLoss
    totalValueLoss += result.valueLoss
    totalEntropy += result.entropy
    totalPredictLoss += result.predictLoss
    totalKlLoss += result.klLoss
    totalKlForwardLoss += result.klForwardLoss
    totalKlEndgameLoss += result.klEndgameLoss
    batchCount++
  }

  const n = Math.max(batchCount, 1)
  return {
    policyLoss: totalPolicyLoss / n,
    valueLoss: totalValueLoss / n,
    entropy: totalEntropy / n,
    predictLoss: totalPredictLoss / n,
    klLoss: totalKlLoss / n,
    klForwardLoss: totalKlForwardLoss / n,
    klEndgameLoss: totalKlEndgameLoss / n,
  }
}

// ============================================================
// Evaluation
// ============================================================

export type EvaluateOptions = {
  wolfCollectiveNet?: AnyNetwork
  masonCollectiveNet?: AnyNetwork
  fanaticNet?: AnyNetwork
  frozenVillageNet?: AnyNetwork
  /** role → network の個別マッピング（Phase 1' で全5モデル同時評価用） */
  individualNets?: Map<string, AnyNetwork>
  /** スナップショットからリプレイで eval（Seed Bank 用） */
  snapshots?: import('../../lupa/types.ts').GameSnapshot[]
  /** mason を個人戦略で処理する（Phase 0: mason individual 用） */
  masonAsIndividual?: boolean
  /** eval シードの変動用 iteration 番号（後半ゲームのシードを iter 依存にする） */
  evalIter?: number
  /** frozen mason 個人NN（Phase 1: mason席にfrozen戦略を注入） */
  frozenMasonNet?: AnyNetwork
  /** eval ゲームの howl テキストを返す */
  saveHowl?: boolean
}

export async function evaluate(
  network: AnyNetwork,
  config: TrainingConfig,
  numGames: number = 50,
  wolfTeamNet?: AnyNetwork,
  masonTeamNet?: AnyNetwork,
  mlMaxSeats?: number,
  options?: EvaluateOptions,
): Promise<{ winRates: Record<string, number>, avgGameLength: number, avgElapsedMs: number, howlGames?: Array<{ seed: number, howl: string, result: string, gameLength: number }> }> {
  const heuristic = new RuleBasedAgent()
  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  let totalGames = 0
  let totalLength = 0
  let totalElapsed = 0
  const resultCounts: Record<string, number> = {}
  const howlGames: Array<{ seed: number, howl: string, result: string, gameLength: number }> = []

  const mlRolesSet = config.mlRoles ? new Set(config.mlRoles) : null

  for (let i = 0; i < numGames; i++) {
    const evalAgents = new Map<number, any>()

    // mlRoles未指定: 従来の偶数seat方式
    if (!mlRolesSet) {
      for (let seat = 1; seat <= totalPlayers; seat++) {
        if (seat % 2 === 0) {
          evalAgents.set(seat, new NeuralAgent(network, { explore: false }))
        } else {
          evalAgents.set(seat, heuristic)
        }
      }
    }

    // 前半は固定シード（安定ベースライン）、後半は iter 依存（変動を検出）
    const halfN = Math.floor(numGames / 2)
    const seed = i < halfN ? 10000 + i : (options?.evalIter ?? 0) * 10000 + 50000 + i
    const onRolesAssigned = mlRolesSet ? (seatRoles: Map<number, SystemRole>) => {
      // frozen mason NN: mason 席に frozen 戦略を注入
      if (options?.frozenMasonNet) {
        for (const [seat, role] of seatRoles) {
          if (role === 'mason') {
            evalAgents.set(seat, new NeuralAgent(options.frozenMasonNet, { explore: false, strategyOnly: config.strategyOnly }))
          }
        }
      }
      const candidates = [...seatRoles].filter(([_, role]) => mlRolesSet.has(role))
      if (mlMaxSeats !== undefined && mlMaxSeats < candidates.length) {
        for (let j = candidates.length - 1; j > 0; j--) {
          const k = (seed * 7 + j * 13) % (j + 1)
          ;[candidates[j], candidates[k]] = [candidates[k], candidates[j]]
        }
        candidates.length = mlMaxSeats
      }
      for (const [seat, role] of candidates) {
        // individualNets があれば role 別にネットワークを解決
        if (options?.individualNets?.has(role)) {
          const roleNet = options.individualNets.get(role)!
          if (role === 'fanatic' && options?.fanaticNet) {
            const fs = new FanaticAgent(options.fanaticNet, { explore: false, strategyOnly: config.strategyOnly })
            if (options?.frozenVillageNet) fs.frozenVillageNetwork = options.frozenVillageNet
            evalAgents.set(seat, fs)
          } else {
            evalAgents.set(seat, new NeuralAgent(roleNet, { explore: false, strategyOnly: config.strategyOnly }))
          }
        } else if (role === 'fanatic' && options?.fanaticNet) {
          const fs = new FanaticAgent(options.fanaticNet, { explore: false, strategyOnly: config.strategyOnly })
          if (options?.frozenVillageNet) fs.frozenVillageNetwork = options.frozenVillageNet
          evalAgents.set(seat, fs)
        } else {
          evalAgents.set(seat, new NeuralAgent(network, { explore: false, strategyOnly: config.strategyOnly }))
        }
      }
    } : undefined

    // Wolf team agent: collective > legacy team > heuristic
    let wolfTeamAgent: any
    if (options?.wolfCollectiveNet) {
      const ws = new WolfCollective(options.wolfCollectiveNet, { explore: false })
      if (options?.frozenVillageNet) ws.frozenVillageNetwork = options.frozenVillageNet
      wolfTeamAgent = ws
    } else if (wolfTeamNet) {
      wolfTeamAgent = new WolfTeamAgent(wolfTeamNet, { explore: false })
    } else {
      wolfTeamAgent = new WolfTeamRuleAgent()
    }

    // Mason team agent: frozenMason > individual(Phase0) > collective > legacy team > heuristic
    let masonTeamAgent: any
    if (options?.frozenMasonNet || options?.masonAsIndividual) {
      masonTeamAgent = undefined  // 個人戦略にフォールバック
    } else if (options?.masonCollectiveNet) {
      masonTeamAgent = new MasonCollective(options.masonCollectiveNet, { explore: false })
    } else if (masonTeamNet) {
      masonTeamAgent = new MasonTeamAgent(masonTeamNet, { explore: false })
    } else {
      masonTeamAgent = new MasonTeamRuleAgent()
    }

    const lupaConfig: LupaConfig = {
      roles,
      seed,
      agents: evalAgents,
      defaultAgent: heuristic,
      onRolesAssigned,
      enableRetar: config.enableRetar,
      hasFirstGhost: config.hasFirstGhost,
      revoteConfig: config.revoteConfig,
      rules: config.rules,
      wolfTeamAgent,
      masonTeamAgent,
    }
    const snapshot = options?.snapshots?.[i]
    const t0 = performance.now()
    let state: import('../../lupa/types.ts').GameState
    let events: (import('../../lupa/types.ts').GameEvent | import('./events.ts').FenrirExtEvent)[] | undefined
    if (snapshot) {
      // Seed Bank リプレイ
      const handlers = config.strategyOnly
        ? new MasonTrainingAdapter({
            agents: evalAgents,
            defaultAgent: heuristic,
            wolfTeamAgent: lupaConfig.wolfTeamAgent,
            masonTeamAgent: lupaConfig.masonTeamAgent,
            onRolesAssigned,
            seed,
          })
        : fullAdapter({
            agents: evalAgents,
            defaultAgent: heuristic,
            wolfTeamAgent: lupaConfig.wolfTeamAgent,
            masonTeamAgent: lupaConfig.masonTeamAgent,
            enableRetar: config.enableRetar,
            onRolesAssigned,
            seed,
            roles,
            rules: config.rules,
          })
      const gameResult = await resumeGame(snapshot, handlers)
      state = gameResult.state
      if (options?.saveHowl) events = gameResult.events
    } else if (config.strategyOnly) {
      const handlers = new MasonTrainingAdapter({
        agents: evalAgents,
        defaultAgent: heuristic,
        wolfTeamAgent: lupaConfig.wolfTeamAgent,
        masonTeamAgent: lupaConfig.masonTeamAgent,
        onRolesAssigned,
        seed,
      })
      const gameResult = await runGame(
        { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules },
        handlers,
      )
      state = gameResult.state
      if (options?.saveHowl) events = gameResult.events
    } else {
      const handlers = fullAdapter({
        agents: evalAgents,
        defaultAgent: heuristic,
        wolfTeamAgent: lupaConfig.wolfTeamAgent,
        masonTeamAgent: lupaConfig.masonTeamAgent,
        enableRetar: config.enableRetar,
        onRolesAssigned,
        seed,
        roles,
        rules: config.rules,
      })
      const gameResult = await runGame(
        { roles, seed, hasFirstGhost: config.hasFirstGhost, revoteConfig: config.revoteConfig, rules: config.rules },
        handlers,
      )
      state = gameResult.state
      if (options?.saveHowl) events = gameResult.events
    }
    totalElapsed += performance.now() - t0

    const result = state.result ?? 'unknown'
    resultCounts[result] = (resultCounts[result] ?? 0) + 1
    totalLength += state.day
    if (events) {
      howlGames.push({ seed, howl: formatHowl(events as import('../../lupa/types.ts').GameEvent[], state, lupaConfig), result, gameLength: state.day })
    }
    totalGames++
  }

  return {
    winRates: Object.fromEntries(
      Object.entries(resultCounts).map(([k, v]) => [k, v / totalGames])
    ),
    avgGameLength: totalLength / totalGames,
    avgElapsedMs: totalElapsed / totalGames,
    ...(howlGames.length > 0 ? { howlGames } : {}),
  }
}

// ============================================================
// Main Training Loop
// ============================================================

function log(msg: string): void {
  process.stderr.write(msg + '\n')
}

import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'

/** eval結果を checkpointDir/eval_log.jsonl に追記 */
export function appendEvalLog(
  checkpointDir: string,
  iteration: number,
  evalResult: { winRates: Record<string, number>, avgGameLength: number, avgElapsedMs: number },
  label?: string,
  ppoMetrics?: { klLoss: number, klCoeff: number, policyLoss: number, valueLoss: number, entropy: number },
): void {
  mkdirSync(checkpointDir, { recursive: true })
  const entry = {
    iter: iteration,
    winRates: evalResult.winRates,
    avgLen: Math.round(evalResult.avgGameLength * 10) / 10,
    ms: Math.round(evalResult.avgElapsedMs),
    ts: new Date().toISOString(),
    ...(label != null ? { label } : {}),
    ...(ppoMetrics != null ? { kl: ppoMetrics.klLoss, beta: ppoMetrics.klCoeff, pol: ppoMetrics.policyLoss, vLoss: ppoMetrics.valueLoss, ent: ppoMetrics.entropy } : {}),
  }
  appendFileSync(`${checkpointDir}/eval_log.jsonl`, JSON.stringify(entry) + '\n')
}

/**
 * チェックポイントディレクトリから最新のイテレーション番号を検出し、
 * 3ネットワークのパスを返す。見つからなければnull。
 */
function findLatestCheckpoint(dir: string): {
  iteration: number
  individual: string
  wolfTeam: string
  masonTeam: string
} | null {
  if (!existsSync(dir)) return null

  const files = readdirSync(dir)

  // final があればそれを優先
  if (files.includes('final.json') && files.includes('wolf_team_final.json') && files.includes('mason_team_final.json')) {
    // finalのiterationを読む
    const raw = JSON.parse(readFileSync(`${dir}/final.json`, 'utf-8'))
    return {
      iteration: raw.metadata?.iteration ?? 0,
      individual: `${dir}/final.json`,
      wolfTeam: `${dir}/wolf_team_final.json`,
      masonTeam: `${dir}/mason_team_final.json`,
    }
  }

  // checkpoint_<iter>.json から最大iterを探す
  let maxIter = 0
  for (const f of files) {
    const m = f.match(/^checkpoint_(\d+)\.json$/)
    if (m) {
      const iter = parseInt(m[1])
      if (iter > maxIter) maxIter = iter
    }
  }

  if (maxIter === 0) return null

  const individual = `${dir}/checkpoint_${maxIter}.json`
  const wolfTeam = `${dir}/wolf_team_${maxIter}.json`
  const masonTeam = `${dir}/mason_team_${maxIter}.json`

  if (!existsSync(individual) || !existsSync(wolfTeam) || !existsSync(masonTeam)) {
    return null
  }

  return { iteration: maxIter, individual, wolfTeam, masonTeam }
}

/**
 * マルチモデルのチェックポイントディレクトリから最新のイテレーション番号を検出。
 * mason_N.json 形式のファイルを探す。
 */
function findLatestCheckpointMulti(dir: string): {
  iteration: number
  groups: Record<string, string>
  wolfTeam: string
  masonTeam: string
} | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)

  // final を探す
  const hasFinals = MODEL_GROUP_NAMES.every(n => files.includes(`${n}_final.json`))
    && files.includes('wolf_team_final.json') && files.includes('mason_team_final.json')
  if (hasFinals) {
    const raw = JSON.parse(readFileSync(`${dir}/${MODEL_GROUP_NAMES[0]}_final.json`, 'utf-8'))
    const groups: Record<string, string> = {}
    for (const n of MODEL_GROUP_NAMES) groups[n] = `${dir}/${n}_final.json`
    return {
      iteration: raw.metadata?.iteration ?? 0,
      groups,
      wolfTeam: `${dir}/wolf_team_final.json`,
      masonTeam: `${dir}/mason_team_final.json`,
    }
  }

  // {groupName}_{iter}.json から最大iterを探す
  let maxIter = 0
  for (const f of files) {
    const m = f.match(/^mason_(\d+)\.json$/)
    if (m) {
      const iter = parseInt(m[1])
      if (iter > maxIter) maxIter = iter
    }
  }
  if (maxIter === 0) return null

  const groups: Record<string, string> = {}
  for (const n of MODEL_GROUP_NAMES) {
    const path = `${dir}/${n}_${maxIter}.json`
    if (!existsSync(path)) return null
    groups[n] = path
  }
  const wolfTeam = `${dir}/wolf_team_${maxIter}.json`
  const masonTeam = `${dir}/mason_team_${maxIter}.json`
  if (!existsSync(wolfTeam) || !existsSync(masonTeam)) return null

  return { iteration: maxIter, groups, wolfTeam, masonTeam }
}

export async function train(config: TrainingConfig = DEFAULT_TRAINING_CONFIG, resumeDir?: string): Promise<void> {
  const useTransformer = config.useTransformer ?? false
  const multiModel = config.phase2ModelDirs != null

  log('Fenrir Training Started')
  log(`Architecture: ${useTransformer ? 'Transformer' : 'MLP'}`)
  log(`Observation size: individual=${OBSERVATION_SIZE}, team=${TEAM_OBSERVATION_SIZE}`)

  // === マルチモデル用 ===
  const modelGroups = new Map<ModelGroupName, ModelGroup>()

  // === ファクトリ関数 (MLP / Transformer 切り替え) ===
  const makeNetwork = (): AnyNetwork => useTransformer ? createTransformerNetwork() : createNetwork()
  const makeTfNetwork = (lr: number): AnyTfNetwork => useTransformer ? createTransformerTfNetwork(lr) : createTfNetwork(lr)
  const makeWolfTeamNetwork = (): AnyNetwork => useTransformer ? createWolfTeamTransformerNetwork() : createWolfTeamNetwork()
  const makeWolfTeamTfNetwork = (lr: number): AnyTfNetwork => useTransformer ? createWolfTeamTransformerTfNetwork(lr) : createWolfTeamTfNetwork(lr)
  const makeMasonTeamNetwork = (): AnyNetwork => useTransformer ? createMasonTeamTransformerNetwork() : createMasonTeamNetwork()
  const makeMasonTeamTfNetwork = (lr: number): AnyTfNetwork => useTransformer ? createMasonTeamTransformerTfNetwork(lr) : createMasonTeamTfNetwork(lr)

  // === 個人エージェント (単一モデルモード用) ===
  const network = multiModel ? undefined! as AnyNetwork : makeNetwork()
  const tfNetwork = multiModel ? undefined! as AnyTfNetwork : makeTfNetwork(config.learningRate)

  // === 狼チームエージェント ===
  const wolfTeamNet = makeWolfTeamNetwork()
  const wolfTeamTf = makeWolfTeamTfNetwork(config.learningRate)

  // === 共有者チームエージェント ===
  const masonTeamNet = makeMasonTeamNetwork()
  const masonTeamTf = makeMasonTeamTfNetwork(config.learningRate)

  if (multiModel) {
    // Phase 2 マルチモデル: 3グループ初期化 + チェックポイント読込
    const dirs = config.phase2ModelDirs!
    if (dirs.length !== MODEL_GROUP_NAMES.length) {
      throw new Error(`--phase2-models requires exactly ${MODEL_GROUP_NAMES.length} directories, got ${dirs.length}`)
    }
    for (let i = 0; i < MODEL_GROUP_NAMES.length; i++) {
      const name = MODEL_GROUP_NAMES[i]
      const def = MODEL_GROUP_DEFS[name]
      // チェックポイント読込
      const ckpt = findLatestCheckpoint(dirs[i])
      if (ckpt) {
        const net = makeNetwork()
        const tf = makeTfNetwork(config.learningRate)
        loadCheckpoint(net, ckpt.individual)
        log(`  ${name}: loaded from ${ckpt.individual} (iter ${ckpt.iteration})`)
        // チームネットワークも読込
        if (def.teamType === 'wolf_team') {
          loadCheckpoint(wolfTeamNet, ckpt.wolfTeam)
          log(`  wolf_team: loaded from ${ckpt.wolfTeam}`)
        } else if (def.teamType === 'mason_team') {
          loadCheckpoint(masonTeamNet, ckpt.masonTeam)
          log(`  mason_team: loaded from ${ckpt.masonTeam}`)
        }
        modelGroups.set(name, { name, roles: def.roles, network: net, tfNetwork: tf, heuristicOnly: false })
      } else {
        log(`  ${name}: no checkpoint in ${dirs[i]} → heuristic fallback`)
        // network/tfNetwork は不要だが型を満たすためダミー。heuristicOnly=true で参照されない。
        modelGroups.set(name, { name, roles: def.roles, network: undefined!, tfNetwork: undefined!, heuristicOnly: true })
      }
    }
    const mlCount = [...modelGroups.values()].filter(g => !g.heuristicOnly).length
    log(`Multi-model mode: ${mlCount}/${modelGroups.size} groups with ML, rest heuristic`)
  } else {
    log(`Individual network: ${network.totalParams} params`)
    log(`Wolf team network: ${wolfTeamNet.totalParams} params`)
    log(`Mason team network: ${masonTeamNet.totalParams} params`)
  }

  // === Retarワーカープール ===
  if (config.enableRetar) {
    initRetarWorkerPool()
    log('Retar worker pool initialized')
  }

  // === ゲーム生成ワーカープール ===
  if (config.numWorkers !== undefined) {
    initGameWorkerPool(config.numWorkers === -1 ? undefined : config.numWorkers)
  }

  // === Resume ===
  let startIter = 1
  if (resumeDir && !multiModel) {
    const ckpt = findLatestCheckpoint(resumeDir)
    if (ckpt) {
      loadCheckpoint(network, ckpt.individual)
      loadCheckpoint(wolfTeamNet, ckpt.wolfTeam)
      loadCheckpoint(masonTeamNet, ckpt.masonTeam)
      startIter = ckpt.iteration + 1
      log(`Resumed from iteration ${ckpt.iteration} (${resumeDir})`)
    } else {
      log(`Warning: no checkpoint found in ${resumeDir}, starting from scratch`)
    }
  } else if (resumeDir && multiModel) {
    const ckpt = findLatestCheckpointMulti(resumeDir)
    if (ckpt) {
      for (const [name, group] of modelGroups) {
        if (ckpt.groups[name]) loadCheckpoint(group.network, ckpt.groups[name])
      }
      loadCheckpoint(wolfTeamNet, ckpt.wolfTeam)
      loadCheckpoint(masonTeamNet, ckpt.masonTeam)
      startIter = ckpt.iteration + 1
      log(`Resumed multi-model from iteration ${ckpt.iteration} (${resumeDir})`)
    } else {
      log(`Warning: no multi-model checkpoint found in ${resumeDir}`)
    }
  }

  // Pool for self-play (past checkpoints)
  const pool: Map<string, Float32Array>[] = []

  const roles = new Map(Object.entries(config.roles) as [SystemRole, number][])
  const totalPlayers = Array.from(roles.values()).reduce((a, b) => a + b, 0)

  const trainingStart = performance.now()

  for (let iter = startIter; iter <= config.totalIterations; iter++) {
    const iterStart = performance.now()

    const useHeuristic = iter <= config.phase1End
    const usePool = iter > config.phase2End
    const phase = useHeuristic ? 1 : usePool ? 3 : 2

    const allIndividualTrajectories: ProcessedStep[] = []
    const allWolfTeamTrajectories: ProcessedStep[] = []
    const allMasonTeamTrajectories: ProcessedStep[] = []

    // マルチモデル: グループ別トラジェクトリバッファ
    const groupTrajectories = new Map<ModelGroupName, ProcessedStep[]>(
      multiModel ? MODEL_GROUP_NAMES.map(n => [n, []] as [ModelGroupName, ProcessedStep[]]) : []
    )

    // === タイミング計測 ===
    const tGameStart = performance.now()

    const seeds = Array.from({ length: config.gamesPerBatch }, (_, g) => iter * config.gamesPerBatch + g)

    if (gameWorkerPoolSize() > 0) {
      // === 並列パス: worker_threads でゲーム生成 ===
      const firstMlGroup = multiModel ? [...modelGroups.values()].find(g => !g.heuristicOnly) : undefined
      const sharedWeights = multiModel ? packWeights(firstMlGroup!.network) : packWeights(network)
      const sharedWolfWeights = (!useHeuristic || multiModel) ? packWeights(wolfTeamNet) : undefined
      const sharedMasonWeights = (!useHeuristic || multiModel) ? packWeights(masonTeamNet) : undefined
      const poolSharedWeights = (usePool && pool.length > 0)
        ? pool.map(w => { const net = makeNetwork(); net.loadWeights(w); return packWeights(net) })
        : undefined

      // マルチモデル: グループ別の重みをパック (heuristicOnly は除外)
      let modelGroupWeights: Record<string, SharedWeights> | undefined
      let heuristicGroups: string[] | undefined
      if (multiModel) {
        modelGroupWeights = {}
        heuristicGroups = []
        for (const [name, group] of modelGroups) {
          if (group.heuristicOnly) {
            heuristicGroups.push(name)
          } else {
            modelGroupWeights[name] = packWeights(group.network)
          }
        }
      }

      const serializedResults = await generateGamesParallel(
        {
          weights: sharedWeights,
          wolfTeamWeights: sharedWolfWeights,
          masonTeamWeights: sharedMasonWeights,
          poolWeights: poolSharedWeights,
          modelGroupWeights,
          heuristicGroups,
          trainingConfig: config,
          phase,
          mlRoles: config.mlRoles,
        },
        seeds,
      )

      for (const game of serializedResults) {
        if (multiModel) {
          // マルチモデル: role でグループ分けしてトラジェクトリをルーティング
          for (const { seat, role, steps } of game.individualSteps) {
            const groupName = ROLE_TO_GROUP_NAME.get(role as SystemRole)
            if (groupName && !modelGroups.get(groupName)!.heuristicOnly) {
              const deserialized = steps.map(deserializeStep)
              const stepsMap = new Map([[seat, deserialized]])
              const grouped = groupTrajectories.get(groupName)!
              grouped.push(...processTrajectories(stepsMap, config.gamma, config.lambda))
            }
          }
        } else {
          // 単一モデル: 既存パス
          const stepsMap = new Map<number, TrajectoryStep[]>()
          for (const { seat, steps } of game.individualSteps) {
            stepsMap.set(seat, steps.map(deserializeStep))
          }
          allIndividualTrajectories.push(
            ...processTrajectories(stepsMap, config.gamma, config.lambda)
          )
        }

        // Wolf team
        if (game.wolfTeamSteps.length > 0) {
          const wolfSteps = game.wolfTeamSteps.map(deserializeStep)
          allWolfTeamTrajectories.push(...computeGAE(wolfSteps, config.gamma, config.lambda, 0))
        }

        // Mason team
        if (game.masonTeamSteps.length > 0) {
          const masonSteps = game.masonTeamSteps.map(deserializeStep)
          allMasonTeamTrajectories.push(...computeGAE(masonSteps, config.gamma, config.lambda, 0))
        }
      }
    } else {
      // === 直列フォールバック ===
      const useAsync = config.enableRetar
      const gamePromises: Array<Promise<{ game: GameTrajectories, neuralAgents: Map<number, NeuralAgent>, wolfTeamAgent?: WolfTeamAgent, masonTeamAgent?: MasonTeamAgent }>> = []

      for (const seed of seeds) {
        const neuralAgents = new Map<number, NeuralAgent>()
        const mlRolesSet = config.mlRoles ? new Set(config.mlRoles) : null

        let onRolesAssigned: ((seatRoles: Map<number, SystemRole>) => void) | undefined
        let defaultAgent: Agent | undefined

        if (multiModel) {
          // マルチモデル: onRolesAssigned で role に応じたグループ network を割り当て
          defaultAgent = new RuleBasedAgent()
          onRolesAssigned = (seatRoles: Map<number, SystemRole>) => {
            for (const [seat, role] of seatRoles) {
              const groupName = ROLE_TO_GROUP_NAME.get(role)
              const group = groupName ? modelGroups.get(groupName) : undefined
              if (group && !group.heuristicOnly) {
                neuralAgents.set(seat, new NeuralAgent(group.network, { explore: true, strategyOnly: config.strategyOnly }))
              }
            }
          }
        } else {
          if (!useHeuristic || !mlRolesSet) {
            for (let seat = 1; seat <= totalPlayers; seat++) {
              if (useHeuristic && seat % 2 !== 0) continue

              if (usePool && pool.length > 0 && seat % 3 === 0) {
                const pastWeights = pool[Math.floor(Math.random() * pool.length)]
                const pastNet = makeNetwork()
                pastNet.loadWeights(pastWeights)
                neuralAgents.set(seat, new NeuralAgent(pastNet, { explore: true, strategyOnly: config.strategyOnly }))
              } else {
                neuralAgents.set(seat, new NeuralAgent(network, { explore: true, strategyOnly: config.strategyOnly }))
              }
            }
          }
          defaultAgent = useHeuristic ? new RuleBasedAgent() : undefined
          onRolesAssigned = (useHeuristic && mlRolesSet) ? (seatRoles: Map<number, SystemRole>) => {
            for (const [seat, role] of seatRoles) {
              if (mlRolesSet.has(role)) {
                neuralAgents.set(seat, new NeuralAgent(network, { explore: true, strategyOnly: config.strategyOnly }))
              }
            }
          } : undefined
        }

        let wolfTeamAgent: WolfTeamAgent | undefined
        let masonTeamAgent: MasonTeamAgent | undefined
        if (!useHeuristic || multiModel) {
          wolfTeamAgent = new WolfTeamAgent(wolfTeamNet, { explore: true })
          masonTeamAgent = new MasonTeamAgent(masonTeamNet, { explore: true })
        }

        const agents: GameAgents = { neuralAgents, defaultAgent, onRolesAssigned, wolfTeamAgent, masonTeamAgent }

        if (useAsync) {
          gamePromises.push(
            generateGameAsync(config, agents, seed).then(game => ({ game, neuralAgents, wolfTeamAgent, masonTeamAgent }))
          )
        } else {
          const gamePromise = generateGame(config, agents, seed).then(game => ({ game, neuralAgents, wolfTeamAgent, masonTeamAgent }))
          gamePromises.push(gamePromise)
        }
      }

      const gameResults = await Promise.all(gamePromises)

      for (const { game, neuralAgents, wolfTeamAgent, masonTeamAgent } of gameResults) {
        if (multiModel) {
          // マルチモデル: agent.network の参照一致でグループを特定
          for (const [seat, steps] of game.steps) {
            const agent = neuralAgents.get(seat)
            if (!agent) continue
            for (const [name, group] of modelGroups) {
              if (agent.network === group.network) {
                const stepsMap = new Map([[seat, steps]])
                groupTrajectories.get(name)!.push(
                  ...processTrajectories(stepsMap, config.gamma, config.lambda)
                )
                break
              }
            }
          }
        } else {
          const currentNetSteps = new Map<number, TrajectoryStep[]>()
          for (const [seat, steps] of game.steps) {
            const agent = neuralAgents.get(seat)
            if (agent && agent.network === network) {
              currentNetSteps.set(seat, steps)
            }
          }
          allIndividualTrajectories.push(
            ...processTrajectories(currentNetSteps, config.gamma, config.lambda)
          )
        }
        if (wolfTeamAgent && game.wolfTeamSteps.length > 0) {
          allWolfTeamTrajectories.push(...computeGAE(game.wolfTeamSteps, config.gamma, config.lambda, 0))
        }
        if (masonTeamAgent && game.masonTeamSteps.length > 0) {
          allMasonTeamTrajectories.push(...computeGAE(game.masonTeamSteps, config.gamma, config.lambda, 0))
        }
      }
    }
    const tGameEnd = performance.now()

    // === PPO更新 ===
    const tPpoStart = performance.now()
    let totalPolicyLoss = 0
    let totalPredictLoss = 0

    if (multiModel) {
      // マルチモデル: グループ別に PPO update
      for (const [name, group] of modelGroups) {
        const steps = groupTrajectories.get(name)!
        if (steps.length === 0) continue
        normalizeAdvantages(steps)
        group.tfNetwork.loadWeights(group.network.cloneWeights())
        for (let epoch = 0; epoch < config.ppoEpochs; epoch++) {
          const { policyLoss, predictLoss } = ppoUpdate(group.tfNetwork, steps, config)
          totalPolicyLoss += policyLoss
          totalPredictLoss += predictLoss
        }
        group.network.loadWeights(group.tfNetwork.cloneWeights())
      }
      // 平均化: グループ数で割る
      const activeGroups = [...groupTrajectories.values()].filter(s => s.length > 0).length
      if (activeGroups > 0) {
        totalPolicyLoss /= activeGroups
        totalPredictLoss /= activeGroups
      }
    } else {
      // 単一モデル: 既存パス
      normalizeAdvantages(allIndividualTrajectories)
      tfNetwork.loadWeights(network.cloneWeights())
      for (let epoch = 0; epoch < config.ppoEpochs; epoch++) {
        const { policyLoss, predictLoss } = ppoUpdate(tfNetwork, allIndividualTrajectories, config)
        totalPolicyLoss += policyLoss
        totalPredictLoss += predictLoss
      }
      network.loadWeights(tfNetwork.cloneWeights())
    }

    // 狼チーム
    if (allWolfTeamTrajectories.length > 0) {
      normalizeAdvantages(allWolfTeamTrajectories)
      wolfTeamTf.loadWeights(wolfTeamNet.cloneWeights())
      for (let epoch = 0; epoch < config.ppoEpochs; epoch++) {
        ppoUpdate(wolfTeamTf, allWolfTeamTrajectories, config)
      }
      wolfTeamNet.loadWeights(wolfTeamTf.cloneWeights())
    }

    // 共有者チーム
    if (allMasonTeamTrajectories.length > 0) {
      normalizeAdvantages(allMasonTeamTrajectories)
      masonTeamTf.loadWeights(masonTeamNet.cloneWeights())
      for (let epoch = 0; epoch < config.ppoEpochs; epoch++) {
        ppoUpdate(masonTeamTf, allMasonTeamTrajectories, config)
      }
      masonTeamNet.loadWeights(masonTeamTf.cloneWeights())
    }

    const tPpoEnd = performance.now()

    // タイミング
    const gameMs = tGameEnd - tGameStart
    const ppoMs = tPpoEnd - tPpoStart

    // Progress bar
    const iterMs = performance.now() - iterStart
    const elapsed = performance.now() - trainingStart
    const pct = iter / config.totalIterations
    const barWidth = 30
    const filled = Math.round(pct * barWidth)
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
    const pctStr = (pct * 100).toFixed(1).padStart(5)
    const etaSec = iter > 0 ? ((elapsed / iter) * (config.totalIterations - iter) / 1000) : 0
    const etaStr = etaSec < 60 ? `${etaSec.toFixed(0)}s`
      : etaSec < 3600 ? `${(etaSec / 60).toFixed(1)}m`
      : `${(etaSec / 3600).toFixed(1)}h`
    const avgPL = totalPolicyLoss / config.ppoEpochs
    const avgPredL = totalPredictLoss / config.ppoEpochs
    const individualStepCount = multiModel
      ? [...groupTrajectories.values()].reduce((sum, s) => sum + s.length, 0)
      : allIndividualTrajectories.length
    const totalSteps = individualStepCount + allWolfTeamTrajectories.length + allMasonTeamTrajectories.length
    const phaseLabel = phase === 1 ? 'heuristic' : phase === 2 ? 'self-play' : 'pool'
    const gamePct = (gameMs / iterMs * 100).toFixed(0)
    const ppoPct = (ppoMs / iterMs * 100).toFixed(0)
    process.stderr.write(
      `\r\x1b[K  ${bar} ${pctStr}% ${iter}/${config.totalIterations} | ` +
      `${iterMs.toFixed(0)}ms (game${gamePct}% ppo${ppoPct}%) ETA ${etaStr} | ` +
      `loss=${avgPL.toFixed(4)} pred=${avgPredL.toFixed(4)} steps=${totalSteps} | ` +
      `phase ${phase} (${phaseLabel})`
    )

    // Evaluation
    let targetReached = false
    if (iter % config.evalInterval === 0) {
      process.stderr.write('\r\x1b[K')
      if (multiModel) {
        // TODO: マルチモデル用の evaluate (全グループのモデルを使った対heuristic評価)
        log(`[${iter}] Eval: skipped (multi-model eval not yet implemented)`)
      } else {
        const evalResult = await evaluate(network, config, 30, wolfTeamNet, masonTeamNet)
        appendEvalLog(config.checkpointDir, iter, evalResult)
        log(
          `[${iter}] Eval: ${Object.entries(evalResult.winRates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(' ')} ` +
          `avgLen=${evalResult.avgGameLength.toFixed(1)} ${evalResult.avgElapsedMs.toFixed(0)}ms/game`
        )

        // 早期終了判定
        if (config.targetWinRate != null && config.targetFaction) {
          const factionRate = evalResult.winRates[config.targetFaction] ?? 0
          if (factionRate >= config.targetWinRate) {
            log(`Target reached: ${config.targetFaction}=${(factionRate * 100).toFixed(0)}% >= ${(config.targetWinRate * 100).toFixed(0)}%`)
            targetReached = true
          }
        }
      }
    }

    if (targetReached) break

    // Checkpoint
    if (iter % config.checkpointInterval === 0) {
      process.stderr.write('\r\x1b[K')
      if (multiModel) {
        for (const [name, group] of modelGroups) {
          if (!group.heuristicOnly) {
            saveCheckpoint(group.network, `${config.checkpointDir}/${name}_${iter}.json`, { iteration: iter, winRate: 0 })
          }
        }
      } else {
        saveCheckpoint(network, `${config.checkpointDir}/checkpoint_${iter}.json`, { iteration: iter, winRate: 0 })
        pool.push(network.cloneWeights())
        if (pool.length > 5) pool.shift()
      }
      saveCheckpoint(wolfTeamNet, `${config.checkpointDir}/wolf_team_${iter}.json`, { iteration: iter, winRate: 0 })
      saveCheckpoint(masonTeamNet, `${config.checkpointDir}/mason_team_${iter}.json`, { iteration: iter, winRate: 0 })
      log(`[${iter}] Checkpoints saved`)
    }
  }

  process.stderr.write('\r\x1b[K')

  // Final save
  if (multiModel) {
    for (const [name, group] of modelGroups) {
      if (!group.heuristicOnly) {
        saveCheckpoint(group.network, `${config.checkpointDir}/${name}_final.json`, { iteration: config.totalIterations, winRate: 0 })
      }
    }
  } else {
    saveCheckpoint(network, `${config.checkpointDir}/final.json`, { iteration: config.totalIterations, winRate: 0 })
  }
  saveCheckpoint(wolfTeamNet, `${config.checkpointDir}/wolf_team_final.json`, { iteration: config.totalIterations, winRate: 0 })
  saveCheckpoint(masonTeamNet, `${config.checkpointDir}/mason_team_final.json`, { iteration: config.totalIterations, winRate: 0 })
  const totalSec = (performance.now() - trainingStart) / 1000
  const timeStr = totalSec < 60 ? `${totalSec.toFixed(1)}s`
    : totalSec < 3600 ? `${(totalSec / 60).toFixed(1)}m`
    : `${(totalSec / 3600).toFixed(1)}h`
  if (multiModel) {
    for (const group of modelGroups.values()) {
      if (!group.heuristicOnly) group.tfNetwork.dispose()
    }
  } else {
    tfNetwork.dispose()
  }
  wolfTeamTf.dispose()
  masonTeamTf.dispose()
  if (config.enableRetar) terminateRetarWorkerPool()
  terminateGameWorkerPool()
  log(`Training complete! (${timeStr})`)
}
