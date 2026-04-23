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
import type { DayClaim } from '../../lupa/types.ts'
import type { LeadershipResponse, Proposal } from '../../fenrir/src/leadership.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import type { MCTSConfig, MCTSResult } from '../mcts/ismcts.ts'
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import { mergeClaimTypeWithSuper, leaderFromIdx } from '../../skoll/phase2/action-decoders.ts'
import type { TrainingBuffer } from './buffer.ts'
import { argmaxFromVisits, sampleFromVisits } from './policy-utils.ts'
import type { SkollZeroModule, ActionMethod } from '../module/skoll-zero-module.ts'

/**
 * Agent コンストラクタに渡す options。
 *
 * Module を直接渡す (`module` フィールド) 形と、legacy に Module 生成に必要な
 * 原材料を渡す形の両方をサポートする。サブクラスは内部で Module を構築する
 * 方針を取るため `module` フィールドは通常使わない。
 */
export type SkollZeroRoleAgentOptions = {
  /** 形勢判断 NN (MCTS node expand 用)。Module が受け取る */
  nn: MasonZeroNN
  /** 役職分布 */
  setup: Map<SystemRole, number>
  /** 学習データ buffer。Module が所有 */
  buffer: TrainingBuffer
  /** MCTS hyperparams */
  mctsConfig?: MCTSConfig
  /** 行動選択モード: 'sample' (training) or 'argmax' (eval) */
  selectionMode?: 'sample' | 'argmax'
  /** Determinizer の世界数上限 */
  determinizerMaxWorlds?: number
  /** Phase 2 pretrained heads: key は `${role}-${method}` */
  phase2Nets?: Map<string, TransformerNetwork>
}

/**
 * ISMCTS ベースの zero agent 基底。
 * サブクラスは対応する Module を init して super に渡す。
 */
export abstract class SkollZeroRoleAgent extends SkollMasterAgent {
  /** skoll-zero Module (NN + MCTS + buffer の塊) */
  protected readonly module: SkollZeroModule
  /** 行動選択モード */
  protected readonly selectionMode: 'sample' | 'argmax'

  constructor(module: SkollZeroModule, selectionMode: 'sample' | 'argmax' = 'sample') {
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

  /**
   * phase2Nets に `${role}-${method}` checkpoint が登録されているか。
   * SkollCommandAgent 等の外部 consumer が NN 経路の発火可否を duck-type 判定するのに使う。
   */
  hasPhase2Head(method: string, role: SystemRole): boolean {
    return this.module.hasPhase2Head(method, role)
  }

  // ========== lupa decide\* interface ==========

  override decideVote(ctx: DecisionContext): number {
    const result = this.module.proposeVote(ctx)
    if (!result) return super.decideVote(ctx)
    return this.selectionMode === 'argmax'
      ? argmaxFromVisits(result.visits)
      : sampleFromVisits(result.visits, () => ctx.rng.next())
  }

  override decideDayClaim(ctx: DecisionContext): DayClaim {
    return this.decideWithClaimHead(ctx, 'claim', () => super.decideDayClaim(ctx))
  }

  override decideForecast(ctx: DecisionContext): DayClaim {
    return this.decideWithClaimHead(ctx, 'forecast', () => super.decideForecast(ctx))
  }

  override decideDefensiveClaim(ctx: DecisionContext): DayClaim {
    return this.decideWithClaimHead(ctx, 'defensive_claim', () => super.decideDefensiveClaim(ctx))
  }

  override decideLeadershipResponse(ctx: DecisionContext, proposal: Proposal): LeadershipResponse {
    const superDecision = super.decideLeadershipResponse(ctx, proposal)
    const r = this.module.predictAction('leader', ctx, { record: this.shouldRecord() })
    if (!r || r.actionIdx === undefined) return superDecision
    return leaderFromIdx(r.actionIdx) ?? superDecision
  }

  override decideProposal(ctx: DecisionContext): Proposal | null {
    const superDecision = super.decideProposal(ctx)
    if (!superDecision) return null
    // propose head は per-seat sigmoid (14 次元)。最もスコアが高い alive/非自席 を target に
    const r = this.module.predictAction('propose', ctx, { record: this.shouldRecord() })
    if (!r) return superDecision
    const aliveSet = new Set(ctx.alivePlayers)
    let bestSeat = superDecision.target
    let bestScore = -Infinity
    for (let i = 0; i < r.logits.length; i++) {
      const seat = i + 1
      if (!aliveSet.has(seat) || seat === ctx.mySeat) continue
      if (r.logits[i] > bestScore) { bestScore = r.logits[i]; bestSeat = seat }
    }
    return { ...superDecision, target: bestSeat }
  }

  // ========== internal helper ==========

  /** training (selectionMode='sample') 時のみ buffer 記録。eval 時は capture しない */
  protected shouldRecord(): boolean {
    return this.selectionMode === 'sample'
  }

  /** claim / forecast / defensive_claim を claim head の argmax → mergeClaimTypeWithSuper */
  private decideWithClaimHead(
    ctx: DecisionContext,
    method: ActionMethod,
    superFn: () => DayClaim,
  ): DayClaim {
    const superDecision = superFn()
    const r = this.module.predictAction(method, ctx, { record: this.shouldRecord() })
    if (!r || r.actionIdx === undefined) return superDecision
    return mergeClaimTypeWithSuper(r.actionIdx, superDecision)
  }
}
