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

/** assignment を1行の読みやすい文字列にフォーマット */
export function formatAssignment(assignment: AgentAssignment): string {
  return MODEL_NAMES.map(name => `${name}=${MODE_SYMBOL[assignment[name]]}`).join('  ')
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
export type NetworkName = ModelName | 'mason_individual'

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
  adapter: 'mason-training' | 'full'
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
}

export type PhaseStep = PretrainStep | TransferStep | TrainingStep

// ============================================================
// Curriculum Builder
// ============================================================

export type CurriculumOptions = {
  phase1Only?: boolean
  phase2Only?: boolean
  skeleton?: boolean
}

const VILLAGE_ROLES: SystemRole[] = ['villager', 'seer', 'medium', 'bodyguard', 'nekomata']

/**
 * Build the full training curriculum as a flat list of PhaseSteps.
 *
 * The sequence mirrors orchestrate.ts phases:
 *   Pretrain B2+B+D → Phase 0 (mason) → transfer → Phase 1 (village)
 *   → Phase 1' (non-village) → Phase 2 (self-play)
 */
export function buildCurriculum(options: CurriculumOptions = {}): PhaseStep[] {
  const { phase1Only = false, phase2Only = false } = options

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
