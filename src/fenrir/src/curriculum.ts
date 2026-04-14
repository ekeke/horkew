/**
 * Fenrir Training Curriculum — 宣言的フェーズ定義
 *
 * 各 PhaseStep は orchestrate.ts のメインループが順次実行する。
 * ランタイムロジック (PPO ループ、ネットワーク管理) は phase-runner.ts が担当。
 */

import type { SystemRole } from '../../types/index.ts'

// ============================================================
// Model Group Definitions
// ============================================================

export const MODEL_GROUPS = {
  village:          { roles: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata'] as SystemRole[], faction: 'villager_won' as const, collective: false, teamType: undefined as 'wolf_team' | 'mason_team' | undefined },
  wolf_collective:  { roles: ['werewolf'] as SystemRole[], faction: 'werewolf_won' as const, collective: true, teamType: 'wolf_team' as const },
  mason_collective: { roles: ['mason'] as SystemRole[], faction: 'villager_won' as const, collective: true, teamType: 'mason_team' as const },
  fanatic:          { roles: ['fanatic'] as SystemRole[], faction: 'werewolf_won' as const, collective: false, teamType: undefined as 'wolf_team' | 'mason_team' | undefined },
  third:            { roles: ['werehamster', 'immoralist'] as SystemRole[], faction: 'werehamster_won' as const, collective: false, teamType: undefined as 'wolf_team' | 'mason_team' | undefined },
} as const

export type ModelName = keyof typeof MODEL_GROUPS
export const MODEL_NAMES = Object.keys(MODEL_GROUPS) as ModelName[]

// ============================================================
// Agent Assignment (declarative per-group agent type)
// ============================================================

/** エージェント種別: neural=学習対象NN, heuristic=ルールベース, frozen=固定重みNN */
export type AgentMode = 'neural' | 'heuristic' | 'frozen'

/** 各モデルグループのエージェント種別を宣言的に指定 */
export type AgentAssignment = Record<ModelName, AgentMode>

const MODE_SYMBOL: Record<AgentMode, string> = { neural: 'NN', heuristic: 'heu', frozen: 'frz' }

/** assignment を1行の読みやすい文字列にフォーマット
 *
 * @param wolfBrainMode BB フェーズなど wolf_brain 独立経路で狼を制御するとき、
 *   wolf_collective スロットの代わりに wolf_brain=<mode> を表示する
 */
export function formatAssignment(assignment: AgentAssignment, wolfBrainMode?: AgentMode): string {
  return MODEL_NAMES.map(name => {
    if (name === 'wolf_collective' && wolfBrainMode != null) {
      return `wolf_brain=${MODE_SYMBOL[wolfBrainMode]}`
    }
    return `${name}=${MODE_SYMBOL[assignment[name]]}`
  }).join('  ')
}

/** role → モデルグループ名の逆引きマップ (MODEL_GROUPSから自動構築) */
export const ROLE_TO_GROUP: Record<string, ModelName> = (() => {
  const map: Record<string, ModelName> = {}
  for (const [name, group] of Object.entries(MODEL_GROUPS) as [ModelName, (typeof MODEL_GROUPS)[ModelName]][]) {
    for (const role of group.roles) map[role] = name
  }
  return map
})()

// ============================================================
// Baseline win rates (14D猫 heuristic vs heuristic)
// ============================================================

/** Heuristic vs Heuristic の勝率ベースライン (14D猫) */
export const BASELINE_RATES: Record<string, number> = {
  villager_won: 0.55,
  werehamster_won: 0.27,
  werewolf_won: 0.15,
  draw: 0.03,
}

// ============================================================
// KL Configuration
// ============================================================

export type KLConfig = {
  /** Initial KL coefficient (β) */
  initialBeta: number
  /** KL target warmup: starting target (high to avoid β floor pinning) */
  warmupFrom: number
  /** KL target warmup: final target */
  warmupTarget: number
  /** Number of iterations over which target linearly decays from warmupFrom to warmupTarget */
  warmupIters: number
  /** Multiplicative band for adaptive adjustment (e.g. 1.2 means ×1.2 / ÷1.2) */
  band: number
  /** Multiplicative rate for coefficient adjustment */
  adjustRate: number
  /** [min, max] clamp range for β */
  range: [number, number]
}

export const DEFAULT_KL_CONFIG: KLConfig = {
  initialBeta: 0.2,
  warmupFrom: 2.0,
  warmupTarget: 0.15,
  warmupIters: 2000,
  band: 1.2,
  adjustRate: 1.5,
  range: [0.01, 1.5],
}

/** Compute KL target for a given iteration (linear warmup decay) */
export function klTargetForIter(iter: number, config: KLConfig = DEFAULT_KL_CONFIG): number {
  if (iter >= config.warmupIters) return config.warmupTarget
  return config.warmupFrom + (config.warmupTarget - config.warmupFrom) * (iter / config.warmupIters)
}

// ============================================================
// Curriculum Configuration (progressive difficulty)
// ============================================================

export type SeatCurriculum = {
  initial: number
  cap: number
}

export type CurriculumConfig = {
  /** Max NN-controlled seats (village only); advances when win rate hits threshold */
  maxSeats?: SeatCurriculum
  /** Win-rate fraction of target required to advance curriculum (e.g. 0.9 = 90% of target) */
  advanceThreshold: number
}

// ============================================================
// Graduation Configuration
// ============================================================

export type GraduationConfig =
  | { type: 'faction_winrate', faction: string, defaultTarget: number, minIter?: number, requireMinDay?: boolean }
  | { type: 'min_iter', minIter: number }
  | { type: 'none' }

// ============================================================
// Game Generation Modes
// ============================================================

export type SingleModelGen = {
  mode: 'single_model'
  /** Roles to control with NN in this phase */
  mlRoles: SystemRole[]
  /** Base offset for seed generation (to avoid seed collision across phases) */
  seedOffsetBase?: number
}

export type MultiModelGen = {
  mode: 'multi_model'
  /** Base offset for seed generation */
  seedOffsetBase: number
}

// ============================================================
// Frozen Model Configuration
// ============================================================

export type FrozenConfig = {
  /** Networks whose weights are frozen (sent to workers as frozen weights) */
  frozenModels: NetworkName[]
  /** Whether to inject frozen village NN outputs (predict, trust) into fanatic/wolf */
  injectVillageNN?: boolean
}

// ============================================================
// PhaseStep discriminated union
// ============================================================

/**
 * activeModels / frozenModels に使える名前:
 * - ModelName ('village', 'wolf_collective', ...) — MODEL_GROUPS のキー
 * - 'mason_individual' — Phase 0 専用。village と同一アーキテクチャの独立ネットワーク
 */
export type NetworkName = ModelName | 'mason_individual' | 'wolf_brain'

export type PretrainStep = {
  type: 'pretrain'
  /** Pretrain stages to run in order */
  stages: ('B2' | 'B' | 'D')[]
}

export type TransferStep = {
  type: 'transfer'
  /** Source model name (e.g. 'mason_individual') */
  from: string
  /** Target model names (e.g. ['village']) */
  to: string[]
  /** Whether to update the KL reference network from source */
  updateRef?: boolean
  /** Whether to update the TF (GPU) network from source */
  updateTf?: boolean
}

export type TrainingStep = {
  type: 'training'
  /** Internal phase name (used for checkpoints, progress keys) */
  name: string
  /** Human-readable display name */
  displayName: string
  /** Models actively being trained in this phase */
  activeModels: NetworkName[]
  /** Whether to use strategy-only mode (plan tokens only) */
  strategyOnly: boolean
  /** Which adapter to use for game generation */
  adapter: 'mason-training' | 'full' | 'brain-battle'
  /** PPO configuration overrides */
  ppo: { klConfig?: KLConfig, freezePlan?: boolean }
  /** Progressive difficulty curriculum (optional) */
  curriculum?: CurriculumConfig
  /** When to graduate from this phase */
  graduation: GraduationConfig
  /** Frozen models injected during game generation */
  frozen?: FrozenConfig
  /** Game generation configuration */
  gameGen: SingleModelGen | MultiModelGen
  /** 各モデルグループのエージェント種別 (宣言的割り当て) */
  agentAssignment: AgentAssignment
  /** Enable mason takeover (partner inherits agent on death) */
  enableMasonTakeover?: boolean
  /** Which config field controls max iterations for this phase */
  maxIterations: 'phase2Iterations' | 'iterations'
  /** Worker phase number sent to game-worker */
  workerPhase: number
  /** Checkpoint subdirectory override (default: ckpt-{name}) */
  checkpointDir?: string
  /** Eval configuration overrides for phase-runner */
  evalConfig?: {
    /** Phase 0: mason を個人戦略で eval する */
    masonAsIndividual?: boolean
  }
}

export type PhaseStep = PretrainStep | TransferStep | TrainingStep

// ============================================================
// Curriculum Builder
// ============================================================

/** カリキュラム名: 'default' = 本流, 'brain-battle' = BB, 'bb-plus' = BB+個別役職学習 */
export type CurriculumName = 'default' | 'brain-battle' | 'bb-plus'

export type CurriculumOptions = {
  phase1Only?: boolean
  phase2Only?: boolean
  skeleton?: boolean
  curriculum?: CurriculumName
}

const VILLAGE_ROLES: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'nekomata']

/**
 * Build the training curriculum as a flat list of PhaseSteps.
 *
 * curriculum='default':
 *   Pretrain B2+B+D → Phase 0 (mason) → transfer → Phase 1 (village)
 *   → Phase 1' (non-village) → Phase 2 (self-play)
 *
 * curriculum='brain-battle':
 *   Phase BB: Brain Battle (wolf brain vs frozen mason)
 */
export function buildCurriculum(options: CurriculumOptions = {}): PhaseStep[] {
  const { phase1Only = false, phase2Only = false, curriculum = 'default' } = options

  if (curriculum === 'brain-battle') {
    return buildBrainBattleCurriculum()
  }
  if (curriculum === 'bb-plus') {
    return buildBBPlusCurriculum()
  }

  const steps: PhaseStep[] = []

  if (!phase2Only) {
    // --- Pretrain B2 + B + D ---
    steps.push({
      type: 'pretrain',
      stages: ['B2', 'B', 'D'],
    })

    // --- Phase 0: Mason Individual ---
    steps.push({
      type: 'training',
      name: 'mason_individual',
      displayName: 'Phase 0: Mason Individual',
      activeModels: ['mason_individual'],
      strategyOnly: true,
      adapter: 'mason-training',
      ppo: {
        klConfig: { ...DEFAULT_KL_CONFIG },
        freezePlan: false,
      },
      graduation: {
        type: 'min_iter',
        minIter: 300,
      },
      gameGen: {
        mode: 'single_model',
        mlRoles: ['mason'],
        seedOffsetBase: 0,
      },
      agentAssignment: {
        village: 'heuristic',
        wolf_collective: 'heuristic',
        mason_collective: 'heuristic',
        fanatic: 'heuristic',
        third: 'heuristic',
      },
      enableMasonTakeover: true,
      maxIterations: 'iterations',
      workerPhase: 1,
      checkpointDir: 'ckpt-mason-individual',
      evalConfig: { masonAsIndividual: true },
    })

    // --- Backbone transfer: mason_individual → village ---
    steps.push({
      type: 'transfer',
      from: 'mason_individual',
      to: ['village'],
      updateRef: true,
      updateTf: true,
    })

    // --- Phase 1: Village Round-Robin ---
    steps.push({
      type: 'training',
      name: 'village',
      displayName: 'Phase 1: Village',
      activeModels: ['village'],
      strategyOnly: true,
      adapter: 'mason-training',
      ppo: {
        klConfig: { ...DEFAULT_KL_CONFIG },
        freezePlan: false,
      },
      curriculum: {
        maxSeats: { initial: 1, cap: 6 },
        advanceThreshold: 0.9,
      },
      graduation: {
        type: 'min_iter',
        minIter: 300,
      },
      frozen: {
        frozenModels: ['mason_individual'],
        injectVillageNN: false,
      },
      gameGen: {
        mode: 'single_model',
        mlRoles: VILLAGE_ROLES,
        seedOffsetBase: 0,
      },
      agentAssignment: {
        village: 'neural',
        wolf_collective: 'heuristic',
        mason_collective: 'frozen',
        fanatic: 'heuristic',
        third: 'heuristic',
      },
      maxIterations: 'iterations',
      workerPhase: 1,
    })

    // --- Phase 1': Non-Village Training (collective + fanatic + third) ---
    steps.push({
      type: 'training',
      name: 'non_village',
      displayName: "Phase 1': Non-Village",
      activeModels: ['wolf_collective', 'mason_collective', 'fanatic', 'third'],
      strategyOnly: true,
      adapter: 'mason-training',
      ppo: {
        freezePlan: false,
      },
      graduation: {
        type: 'min_iter',
        minIter: 300,
      },
      frozen: {
        frozenModels: ['village'],
        injectVillageNN: true,
      },
      gameGen: {
        mode: 'multi_model',
        seedOffsetBase: 10000,
      },
      agentAssignment: {
        village: 'frozen',
        wolf_collective: 'neural',
        mason_collective: 'neural',
        fanatic: 'neural',
        third: 'neural',
      },
      maxIterations: 'iterations',
      workerPhase: 1,
    })
  }

  // --- Phase 2: Self-Play (all 5 models) ---
  if (!phase1Only) {
    steps.push({
      type: 'training',
      name: 'self_play',
      displayName: 'Phase 2: Self-Play',
      activeModels: ['village', 'wolf_collective', 'mason_collective', 'fanatic', 'third'],
      strategyOnly: true,
      adapter: 'mason-training',
      ppo: {
        freezePlan: false,
      },
      graduation: { type: 'none' },
      gameGen: {
        mode: 'multi_model',
        seedOffsetBase: 20000,
      },
      agentAssignment: {
        village: 'neural',
        wolf_collective: 'neural',
        mason_collective: 'neural',
        fanatic: 'neural',
        third: 'neural',
      },
      maxIterations: 'phase2Iterations',
      workerPhase: 2,
    })
  }

  return steps
}

// ============================================================
// Brain Battle Curriculum
// ============================================================

function buildBBPlusCurriculum(): PhaseStep[] {
  // BB → BB+1..5 unified curriculum
  // BB trains wolf_brain + mason_brain; BB+ trains individual role agents on frozen brains
  const bbPlusBase = {
    type: 'training' as const,
    strategyOnly: false,
    adapter: 'brain-battle' as const,
    ppo: { freezePlan: false },
    gameGen: { mode: 'multi_model' as const, seedOffsetBase: 50000 },
    maxIterations: 'iterations' as const,
    workerPhase: 4,
  }

  return [
    // Phase BB: Brain Battle (wolf_brain + mason_brain 学習)
    {
      type: 'training' as const,
      name: 'brain_battle',
      displayName: 'Phase BB: Brain Battle',
      activeModels: ['wolf_brain', 'mason_collective'],
      strategyOnly: false,
      adapter: 'brain-battle' as const,
      ppo: { freezePlan: false },
      graduation: { type: 'min_iter' as const, minIter: 1500 },
      gameGen: { mode: 'multi_model' as const, seedOffsetBase: 40000 },
      agentAssignment: {
        village: 'heuristic',
        wolf_collective: 'heuristic',
        mason_collective: 'neural',
        fanatic: 'heuristic',
        third: 'heuristic',
      },
      maxIterations: 'iterations' as const,
      workerPhase: 3,
    },
    // BB+ Stage 1: per-role village — 占い先・CO 学習
    {
      ...bbPlusBase,
      name: 'bb_plus_village_1',
      displayName: 'Phase BB+ Stage 1: Village (1 seat)',
      activeModels: ['village'],
      graduation: { type: 'min_iter' as const, minIter: 300 },
      agentAssignment: {
        village: 'neural',
        wolf_collective: 'heuristic',
        mason_collective: 'neural',  // frozen mason_brain
        fanatic: 'heuristic',
        third: 'heuristic',
      },
    },
    // Stage 2: village NN × 全席 — 全村役職の夜行動・CO
    {
      ...bbPlusBase,
      name: 'bb_plus_village_full',
      displayName: 'Phase BB+ Stage 2: Village (full)',
      activeModels: ['village'],
      graduation: { type: 'min_iter' as const, minIter: 300 },
      agentAssignment: {
        village: 'neural',
        wolf_collective: 'heuristic',
        mason_collective: 'neural',
        fanatic: 'heuristic',
        third: 'heuristic',
      },
    },
    // Stage 3: fanatic NN — 村 frozen, 騙り戦略学習
    {
      ...bbPlusBase,
      name: 'bb_plus_fanatic',
      displayName: 'Phase BB+ Stage 3: Fanatic',
      activeModels: ['fanatic'],
      graduation: { type: 'min_iter' as const, minIter: 300 },
      agentAssignment: {
        village: 'frozen',
        wolf_collective: 'heuristic',
        mason_collective: 'neural',
        fanatic: 'neural',
        third: 'heuristic',
      },
      frozen: {
        frozenModels: ['village'],
        injectVillageNN: true,
      },
    },
    // Stage 4: werehamster + immoralist NN — 狐/背徳の生存・護衛戦略
    {
      ...bbPlusBase,
      name: 'bb_plus_third',
      displayName: 'Phase BB+ Stage 4: Werehamster + Immoralist',
      activeModels: ['third'],  // trajectory keys: 'werehamster', 'immoralist'
      graduation: { type: 'min_iter' as const, minIter: 300 },
      agentAssignment: {
        village: 'frozen',
        wolf_collective: 'heuristic',
        mason_collective: 'neural',
        fanatic: 'frozen',
        third: 'neural',
      },
      frozen: {
        frozenModels: ['village'],
        injectVillageNN: true,
      },
    },
    // Stage 5: wolf_brain 追学習 — village/fanatic/third/mason を全部 neural (frozen) で回し、
    //          強くなった相手の中で wolf_brain だけ PPO 更新
    {
      ...bbPlusBase,
      name: 'bb_plus_wolf',
      displayName: 'Phase BB+ Stage 5: Wolf Brain Refinement',
      activeModels: ['wolf_brain'],
      graduation: { type: 'min_iter' as const, minIter: 500 },
      agentAssignment: {
        village: 'neural',
        wolf_collective: 'heuristic',
        mason_collective: 'neural',
        fanatic: 'neural',
        third: 'neural',
      },
      frozen: {
        frozenModels: ['village'],
        injectVillageNN: true,
      },
    },
    // Stage 6: 全個別エージェント NN — 共進化（wolf_brain も含む）
    {
      ...bbPlusBase,
      name: 'bb_plus_all',
      displayName: 'Phase BB+ Stage 6: All Individual Agents',
      activeModels: ['wolf_brain', 'village', 'fanatic', 'third'],
      graduation: { type: 'none' as const },
      agentAssignment: {
        village: 'neural',
        wolf_collective: 'heuristic',
        mason_collective: 'neural',
        fanatic: 'neural',
        third: 'neural',
      },
      frozen: {
        frozenModels: [],
        injectVillageNN: true,
      },
    },
  ]
}

// ============================================================
// Brain Battle Curriculum
// ============================================================

function buildBrainBattleCurriculum(): PhaseStep[] {
  return [{
    type: 'training',
    name: 'brain_battle',
    displayName: 'Phase BB: Brain Battle',
    activeModels: ['wolf_brain', 'mason_collective'],
    strategyOnly: false,
    adapter: 'brain-battle',
    ppo: { freezePlan: false },
    graduation: { type: 'none' },
    gameGen: {
      mode: 'multi_model',
      seedOffsetBase: 40000,
    },
    agentAssignment: {
      village: 'heuristic',
      wolf_collective: 'heuristic',
      mason_collective: 'neural',
      fanatic: 'heuristic',
      third: 'heuristic',
    },
    maxIterations: 'iterations',
    workerPhase: 3,
  }]
}
