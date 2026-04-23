/**
 * SkollZeroModule — skoll-zero NN + ISMCTS + buffer の塊。
 *
 * ## 位置づけ
 *
 * Agent / Module / Adapter 3 層分離 (`tasks/skoll-zero-module-extraction.md` 参照) の
 * Module 層。Agent (1 seat 1 instance) から呼ばれ、形勢判断 NN と行動影響予測 NN の
 * 結果を返す。自分の TrainingBuffer を所有し、学習データ収集も担当する。
 *
 * ## 責務
 *
 * - Day action の policy 提案 (ISMCTS + vote head)
 * - Night action の policy 提案 (ISMCTS + divine/guard/attack head)
 * - Phase 2 pretrained head の forward (claim/comm/leader/target/propose/predict)
 * - 学習データ (obs, visits/π, or actionIdx) を buffer に蓄積
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

import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { MCTSResult } from '../mcts/ismcts.ts'
import type { HeadName } from '../mcts/nn.ts'
import type { TrainingBuffer } from '../selfplay/buffer.ts'
import type { RootObs } from '../selfplay/observation.ts'

/** Phase 2 pretrained head の method 名 (action-encoders.ts / METHOD_HEAD_MAP と対応) */
export type ActionMethod =
  | 'claim'
  | 'forecast'
  | 'defensive_claim'
  | 'comm'
  | 'leader'
  | 'propose'
  | 'predict'
  | 'target'

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

/** predictAction の返り値 — Phase 2 head forward 結果 */
export type ActionPrediction = {
  /** head の生 logits (softmax 前、sigmoid 前) */
  logits: Float32Array
  /** softmax head の argmax index。sigmoid head では undefined */
  actionIdx?: number
  /** キャプチャされた obs */
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
   * - record=true (default) なら buffer に (obs, visits, π) を 'vote' head で蓄積
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
   * Phase 2 pretrained head の forward。
   *
   * - method は claim/forecast/defensive_claim/comm/leader/propose/predict/target
   * - role に対応する Phase 2 checkpoint が未登録なら null を返す (Agent は heuristic に)
   * - record=true なら (obs, actionIdx | actionMultiHot) を buffer に蓄積 (Phase 3 で有効化)
   */
  predictAction(
    method: ActionMethod,
    ctx: DecisionContext,
    opts?: { record?: boolean },
  ): ActionPrediction | null

  /**
   * ゲーム終了時に pending records に z を貼って finalized へ移送。
   * Adapter / self-play runner が呼ぶ。
   */
  finalize(z: number): void

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

  /**
   * Phase 2 pretrained head が登録済みかを role × method で問い合わせる。
   * SkollCommandAgent の duck-type 判定 (hasPhase2Head) 用。
   */
  hasPhase2Head(method: string, role: string): boolean
}

/** head 名から action method に変換。buffer 記録時の headName として使う */
export function headNameForActionMethod(method: ActionMethod): HeadName {
  switch (method) {
    case 'claim':
    case 'forecast':
    case 'defensive_claim':
      return 'claim'  // forecast / defensive_claim も claim head (10 dim) を共有
    case 'comm': return 'comm'
    case 'leader': return 'leader'
    case 'propose': return 'propose'
    case 'predict': return 'predict'
    case 'target': return 'target'
  }
}
