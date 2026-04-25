/**
 * SkollZeroModule — skoll-zero NN + ISMCTS + buffer の塊。
 *
 * ## 位置づけ
 *
 * Agent / Module / Adapter 3 層分離 (`tasks/skoll-zero-module-extraction.md` 参照) の
 * Module 層。Agent (1 seat 1 instance) から呼ばれ、形勢判断 NN の結果を返す。
 * 自分の TrainingBuffer を所有し、学習データ収集も担当する。
 *
 * ## 責務
 *
 * - Day action の policy 提案 (ISMCTS + vote head)
 * - Night action の policy 提案 (ISMCTS + divine/guard/attack head)
 * - 学習データ (obs, visits, π) を buffer に蓄積
 * - ゲーム終了時の finalize (z を全 pending に貼る)
 *
 * ## 非責務
 *
 * - lupa engine の decide* interface → Agent 層
 * - 複数 agent の情報集約 → Adapter 層
 * - huginn 投票交渉 → HuginnModule (Phase 4 以降)
 *
 * ## 実装バリエーション
 *
 * 役職ごとに観測エンコーダと faction が異なるため、Module は abstract 基底 +
 * role 別 subclass で実装する (MasonSkollZeroModule / VillageSkollZeroModule 等)。
 * interface 自体は role 非依存なので、Agent は「どの role の Module か」を
 * 知らずに呼べる。
 */

import type { SystemRole } from '../../types/index.ts'
import type { FinalOutcome } from '../network/config.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { Faction, MCTSResult } from '../mcts/ISMCTS.ts'
import type { HeadName, NNOutput } from '../mcts/nn.ts'
import type { TrainingBuffer } from '../selfplay/buffer.ts'
import type { RootObs } from '../selfplay/observation.ts'
import type { SimState } from '../simulator/world-state.ts'
import type { RolloutInvariants } from '../observation/from-sim-state.ts'

/** proposeVote / proposeNightAction の返り値 — MCTS 結果の共通型 */
export type McctsProposal = {
  /** action (seat) → MCTS 訪問回数 */
  visits: Map<number, number>
  /** 正規化済み policy target π = N(a) / Σ N(b) */
  pi: Map<number, number>
  /** Module 所有者の faction 視点の value */
  value: number
  /** キャプチャされた obs (Agent が再利用するため返す、Module は内部で buffer 記録済み) */
  obs: RootObs
}

/**
 * skoll-zero Module の公開 interface。
 *
 * Agent は通常これをフィールドに持ち、decide* 内で呼び出す。
 * Adapter (HuginnVoteAdapter 等) は `lastMCTSResult` だけ参照する。
 */
export interface SkollZeroModule {
  /**
   * 昼の投票先を ISMCTS で提案。
   *
   * - retar 無効 / determinizer overflow 時は null を返す (Agent は heuristic にフォールバック)
   * - record=true (default) なら buffer に (obs, visits, π) を 'execute' head で蓄積
   * - record=false なら buffer に書かない (eval モード用)
   */
  proposeVote(ctx: DecisionContext, opts?: { record?: boolean }): McctsProposal | null

  /**
   * 夜行動 (占い / 護衛 / 噛み) を ISMCTS で提案。
   *
   * mode は 'divine' (seer) / 'guard' (bodyguard) / 'attack' (wolf)。
   * 対応する head (divine/guard/attack) に buffer 蓄積する。
   */
  proposeNightAction(
    ctx: DecisionContext,
    mode: 'divine' | 'guard' | 'attack',
    opts?: { record?: boolean },
  ): McctsProposal | null

  /**
   * ゲーム終了時に pending records に outcome one-hot を貼って finalized へ移送。
   * Adapter / self-play runner が呼ぶ (Stage 4: outcome distribution 学習用)。
   */
  finalize(outcome: FinalOutcome): void

  /** 新しいゲーム開始時に pending をクリア (既存 buffer の finalized は保持) */
  reset(): void

  /** 学習データ buffer (trainer が batch sampling する) */
  readonly buffer: TrainingBuffer

  /** 直近の MCTS 結果 — huginn-adapter 等の外部 consumer 向け。fallback 時は null */
  readonly lastMCTSResult: MCTSResult | null

  /** debug: MCTS を実行した回数 */
  readonly mctsCalls: number

  /** debug: MCTS fallback 回数 (retar 無効 / overflow 等) */
  readonly fallbackCalls: number

  // ============================================================
  // Stage 2: ModuleBundle dispatch 用 interface
  // ============================================================

  /**
   * Module の faction (value backup の符号変換に使用)。
   *
   * - village: mason / villager / seer / medium / bodyguard / nekomata
   * - wolf: werewolf / fanatic
   * - hamster: werehamster / immoralist
   */
  faction(): Faction

  /**
   * SimState + actor 視点で動的に観測を encode (rollout 中に呼ばれる)。
   *
   * 各 Module は自身の観測モード (mason_collective / wolf_collective / individual / fanatic)
   * を知っているので、encoderType を引数で取らない。
   *
   * @param state rollout dynamic state (alive / claims / divineLog 等が SimState に乗ってる)
   * @param actorSeat 観測の主体 (Module dispatch で決まる、必ずしも root の決定者ではない)
   * @param actorRole actor の SystemRole (世界由来)
   * @param invariants rollout 不変情報 (signal counts / retar / tsumi / etc.)
   */
  encodeStateObs(
    state: SimState,
    actorSeat: number,
    actorRole: SystemRole,
    invariants: RolloutInvariants,
  ): RootObs

  /**
   * SimState から動的に encode した obs で NN forward を呼ぶ。
   *
   * @param state rollout dynamic state
   * @param actorSeat 観測の主体
   * @param actorRole actor の SystemRole
   * @param headName 呼び出す head (phase に対応)
   * @param invariants rollout 不変情報
   */
  forwardAt(
    state: SimState,
    actorSeat: number,
    actorRole: SystemRole,
    headName: HeadName,
    invariants: RolloutInvariants,
  ): NNOutput
}
