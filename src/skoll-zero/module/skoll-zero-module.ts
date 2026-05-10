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
import type { ModuleBundle } from '../mcts/dispatch.ts'
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
   * - bundle: Stage 3+ の cross-module dispatch 用。省略時は singletonBundle にフォールバック (Stage 1 互換)
   */
  proposeVote(
    ctx: DecisionContext,
    opts?: { record?: boolean, bundle?: ModuleBundle },
  ): McctsProposal | null

  /**
   * 夜行動 (占い / 護衛 / 噛み) を ISMCTS で提案。
   *
   * mode は 'divine' (seer) / 'guard' (bodyguard) / 'attack' (wolf)。
   * 対応する head (divine/guard/attack) に buffer 蓄積する。
   * bundle: cross-module dispatch 用 (proposeVote と同じ)。
   */
  proposeNightAction(
    ctx: DecisionContext,
    mode: 'divine' | 'guard' | 'attack',
    opts?: { record?: boolean, bundle?: ModuleBundle },
  ): McctsProposal | null

  /**
   * MCTS を介さず NN forward 1 回で policy 分布を返す (eval / pure-policy 評価用)。
   *
   * - mode は 'execute' / 'divine' / 'guard' / 'attack' のいずれか
   * - 戻り値 Map<actionId, prob>: NN の policy head から取った per-seat 確率分布
   *   (mode に応じた除外マスク = 自席 + (attack なら) 狼 teammates 適用済)
   * - retar 無効 / determinizer overflow / fixRole 失敗時は null (caller は heuristic fallback)
   * - buffer に書き込まない (eval は学習に影響しない)
   */
  proposePolicyOnly(
    ctx: DecisionContext,
    mode: 'execute' | 'divine' | 'guard' | 'attack',
  ): Map<number, number> | null

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

  /**
   * 直近 reset 以降に成功した MCTS 呼び出しでの root visit エントロピー比の累積。
   * Dirichlet ε 自動減衰の判定に使う。
   * - sum: visitEntropyRatio の総和
   * - count: 集計対象の MCTS 呼び出し数 (= 成功 mctsCalls の subset)
   */
  readonly entropyStats: { sum: number, count: number }

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

  /**
   * Batched forward (optional)。同じ headName / Module で複数 leaf の forward を
   * 1 回にまとめる。batched MCTS (`SKOLLZ_BATCH_INFER>1`) で呼ばれる。
   *
   * 入力配列は同順、長さ等しい。obs は `encodeStateObs` を内部で呼ぶ前提。
   * NN が `forwardBatch` を持たなければ、Module 側で forwardAt を N 回呼ぶ fallback で良い。
   */
  forwardBatchAt?(
    states: SimState[],
    actorSeats: number[],
    actorRoles: SystemRole[],
    headName: HeadName,
    invariants: RolloutInvariants,
  ): NNOutput[]

  /**
   * Wolf imitation A案 を要求する Module か (optional、default false)。
   *
   * true を返すと、当該 Module を `bundle.wolf` に持つ MCTS rollout 全体で
   * `state.wolfImitation = true` が設定される。これにより:
   *   - claim_decision phase が active になる (root actor=mySeat 固定で WolfImitationModule.forwardAt
   *     が mixForward 経由で 4 viewer 別 claim_true と合成した 57-dim を返す)
   *   - 旧 claim_*_fake phase は state.claims に書込済 (claim_decision 経由) → 自動 skip
   *
   * これを設定しないと、claim_*_fake phase で WolfImitationNetwork.forward('claim_fake') が
   * 要求され、新 head 名 (claim_decision_dev) しか持たない WolfImitationNetwork が throw する。
   *
   * 実装: WolfImitationModule のみ override で true、他の Module は default false。
   */
  requiresWolfImitationMode?(): boolean
}
