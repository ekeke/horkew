/**
 * SkollZeroRoleAgent — 役職汎用 zero エージェント抽象基底。
 *
 * ## Agent / Module 3 層分離 (2026-04-23 リファクタ、M0.5)
 *
 * 旧 SkollZeroRoleAgent は NN / MCTS / buffer 記録も直接抱えていた。リファクタ後:
 * - **Agent 層 (このファイル)**: lupa decide\* interface 実装、super (heuristic) との merge、
 *   selectionMode (sample/argmax) による action 選択
 * - **Module 層 (`../module/`)**: NN forward / MCTS 実行 / buffer 蓄積 / phase2 head 管理
 *
 * Agent はコンストラクタで Module を受け取り、decide\* 内で呼び出すだけ。
 * 詳細は `tasks/skoll-zero-module-extraction.md` 参照。
 *
 * ## サブクラスの作り方
 *
 * subclass は `super(module, selectionMode)` を呼ぶだけ。abstract method は無い。
 * 役職別の obs encoding と faction は Module 側 (MasonSkollZeroModule 等) に寄せる。
 */

import type { SystemRole } from '../../types/index.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import type { MCTSConfig, MCTSResult } from '../mcts/ISMCTS.ts'
import type { ModuleBundle } from '../mcts/dispatch.ts'
import type { TrainingBuffer } from './buffer.ts'
import { argmaxFromVisits, sampleFromVisits, temperatureForAlive } from './policy-utils.ts'
import type { SkollZeroModule } from '../module/skoll-zero-module.ts'

/**
 * Agent コンストラクタに渡す options。
 *
 * Module を直接渡す (`module` フィールド) 形と、legacy に Module 生成に必要な
 * 原材料を渡す形の両方をサポートする。サブクラスは内部で Module を構築する
 * 方針を取るため `module` フィールドは通常使わない。
 */
/**
 * 行動選択モード:
 *   - 'sample': MCTS visit 分布から温度付き sampling (training)
 *   - 'argmax': MCTS visit 分布から argmax (eval、search 込みの greedy 評価)
 *   - 'policy_argmax': MCTS スキップ、NN policy 分布の argmax (eval、純粋な NN-only 性能評価)
 */
export type SelectionMode = 'sample' | 'argmax' | 'policy_argmax'

export type SkollZeroRoleAgentOptions = {
  /** 形勢判断 NN (MCTS node expand 用)。Module が受け取る */
  nn: MasonZeroNN
  /** 役職分布 */
  setup: Map<SystemRole, number>
  /** 学習データ buffer。Module が所有 */
  buffer: TrainingBuffer
  /** MCTS hyperparams */
  mctsConfig?: MCTSConfig
  /** 行動選択モード */
  selectionMode?: SelectionMode
  /** Determinizer の世界数上限 */
  determinizerMaxWorlds?: number
}

/**
 * ISMCTS ベースの zero agent 基底。
 * サブクラスは対応する Module を init して super に渡す。
 */
export abstract class SkollZeroRoleAgent extends SkollMasterAgent {
  /** skoll-zero Module (NN + MCTS + buffer の塊) */
  protected readonly module: SkollZeroModule
  /** 行動選択モード */
  protected readonly selectionMode: SelectionMode
  /**
   * cross-module dispatch 用 ModuleBundle (multi-runner が注入)。
   * 未注入時は base-module が singletonBundle にフォールバック (Stage 1 互換)。
   */
  protected bundle: ModuleBundle | undefined

  constructor(module: SkollZeroModule, selectionMode: SelectionMode = 'sample') {
    super({})
    this.module = module
    this.selectionMode = selectionMode
  }

  // ========== Module への passthrough (debug / adapter 向け公開) ==========

  get mctsCalls(): number { return this.module.mctsCalls }
  get fallbackCalls(): number { return this.module.fallbackCalls }

  /** 直近の MCTS 結果を取得 (fallback 時は null) — huginn-adapter 等が参照 */
  getLastMCTSResult(): MCTSResult | null {
    return this.module.lastMCTSResult
  }

  /** 内部 Module を返す (multi-runner が ModuleBundle 構築時に取り出す) */
  getModule(): SkollZeroModule {
    return this.module
  }

  /** cross-module dispatch 用 ModuleBundle を注入する (multi-runner が呼ぶ) */
  setBundle(bundle: ModuleBundle): void {
    this.bundle = bundle
  }

  /** propose* に渡す opts。bundle 注入済なら載せる、未注入なら undefined */
  protected proposeOpts(): { bundle: ModuleBundle } | undefined {
    return this.bundle ? { bundle: this.bundle } : undefined
  }

  // ========== lupa decide\* interface ==========

  override decideVote(ctx: DecisionContext): number {
    if (this.selectionMode === 'policy_argmax') {
      const policy = this.module.proposePolicyOnly(ctx, 'execute')
      if (!policy) return super.decideVote(ctx)
      return argmaxFromVisits(policy)
    }
    const result = this.module.proposeVote(ctx, this.proposeOpts())
    if (!result) return super.decideVote(ctx)
    return this.selectionMode === 'argmax'
      ? argmaxFromVisits(result.visits)
      : sampleFromVisits(
          result.visits,
          () => ctx.rng.next(),
          temperatureForAlive(ctx.alivePlayers.length),
        )
  }
}
