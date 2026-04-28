/**
 * BaseSkollZeroModule — SkollZeroModule の共通実装 abstract class。
 *
 * 役職ごとに異なる 2 点だけサブクラスで差し替える:
 *   - `captureObs(ctx)`: observation encoder (individual / mason_collective / wolf_collective / fanatic)
 *   - `faction()`: MCTS value backup 視点 ('village' / 'wolf' / 'hamster')
 *
 * 共通ロジック (Determinizer 構築、MCTS 実行、Phase 2 forward、buffer 記録) はここに集約。
 *
 * ## 責務境界
 *
 * - **Module 側** (ここ): obs 生成、NN forward、MCTS 実行、buffer 蓄積
 * - **Agent 側** (別ファイル): lupa decide\* interface 実装、super (heuristic) との merge、
 *   selectionMode (sample/argmax) による action 選択
 */

import type { SystemRole } from '../../types/index.ts'
import type { FinalOutcome } from '../network/config.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { buildPossibilitiesFromRetar } from '../../skoll/unified.ts'
import type { SimState } from '../simulator/world-state.ts'
import { Determinizer } from '../mcts/determinize.ts'
import {
  runMCTS, DEFAULT_MCTS_CONFIG,
  type Faction, type MCTSConfig, type MCTSResult,
} from '../mcts/ISMCTS.ts'
import type { MasonZeroNN, HeadName, NNOutput } from '../mcts/nn.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import type { RootObs } from '../selfplay/observation.ts'
import { normalizeVisits } from '../selfplay/policy-utils.ts'
import type { ObservationMode } from '../../fenrir/src/observation.ts'
import { encodeFromSimState, type RolloutInvariants } from '../observation/from-sim-state.ts'
import { buildInitialSimState, buildInvariants } from '../observation/from-ctx.ts'
import type { ModuleBundle } from '../mcts/dispatch.ts'
import { BENCH_ENABLED, benchEnd } from '../bench/profiler.ts'
import type { SkollZeroModule, McctsProposal } from './skoll-zero-module.ts'

export type BaseSkollZeroModuleOptions = {
  /** 形勢判断 NN (MCTS node expand 用 policy/value)。MasonZeroNetwork 等 */
  nn: MasonZeroNN
  /** 役職分布 (配役) — retar / determinizer の入力 */
  setup: Map<SystemRole, number>
  /** 学習データ buffer。Module が所有、trainer が sample */
  buffer: TrainingBuffer
  /** MCTS hyperparams (省略時 DEFAULT_MCTS_CONFIG) */
  mctsConfig?: MCTSConfig
  /** Determinizer の世界数上限 (overflow 時は fallback) */
  determinizerMaxWorlds?: number
}

/**
 * SkollZeroModule の abstract 基底。
 *
 * サブクラスは `captureObs(ctx)` と `faction()` を override する。
 * 他のメソッドはここで提供される共通実装を使う。
 */
export abstract class BaseSkollZeroModule implements SkollZeroModule {
  readonly buffer: TrainingBuffer
  mctsCalls = 0
  fallbackCalls = 0

  /** 直近の MCTS 結果 (fallback 時は null)。Adapter から読まれる */
  private _lastMCTSResult: MCTSResult | null = null

  get lastMCTSResult(): MCTSResult | null { return this._lastMCTSResult }

  protected readonly nn: MasonZeroNN
  protected readonly setup: Map<SystemRole, number>
  protected readonly mctsConfig: MCTSConfig | undefined
  protected readonly determinizerMaxWorlds: number

  constructor(opts: BaseSkollZeroModuleOptions) {
    this.nn = opts.nn
    this.setup = opts.setup
    this.buffer = opts.buffer
    this.mctsConfig = opts.mctsConfig
    this.determinizerMaxWorlds = opts.determinizerMaxWorlds ?? 100000
  }

  /** 役職別 obs encoder (DecisionContext 経由、root snapshot 用)。サブクラスで実装 */
  abstract captureObs(ctx: DecisionContext): RootObs

  /** MCTS value backup の faction 視点。Stage 2 で public 化 (interface 露出) */
  abstract faction(): Faction

  /**
   * SimState 経路の観測モード。サブクラスで指定:
   * - mason: 'mason_collective'
   * - wolf: 'wolf_collective'
   * - village/individual: 'individual'
   * - fanatic: 'fanatic'
   */
  protected abstract observationMode(): ObservationMode

  /** SimState + actor 視点で動的に観測を生成 (Stage 2 ModuleBundle 用) */
  encodeStateObs(
    state: SimState,
    actorSeat: number,
    actorRole: SystemRole,
    invariants: RolloutInvariants,
  ): RootObs {
    return encodeFromSimState(state, actorSeat, actorRole, this.observationMode(), invariants)
  }

  /** SimState から動的に encode した obs で NN forward */
  forwardAt(
    state: SimState,
    actorSeat: number,
    actorRole: SystemRole,
    headName: HeadName,
    invariants: RolloutInvariants,
  ): NNOutput {
    const t0 = BENCH_ENABLED ? performance.now() : 0
    const obs = this.encodeStateObs(state, actorSeat, actorRole, invariants)
    if (BENCH_ENABLED) benchEnd('obs_encode', t0)
    const t1 = BENCH_ENABLED ? performance.now() : 0
    const result = this.nn.forward(obs, state, actorSeat, headName)
    if (BENCH_ENABLED) benchEnd('nn_forward', t1)
    return result
  }

  /**
   * Batched forward (batched MCTS 用)。NN が `forwardBatch` を持つなら 1 回にまとめ、
   * 持たなければ forwardAt を N 回呼ぶ fallback。
   */
  forwardBatchAt(
    states: SimState[],
    actorSeats: number[],
    actorRoles: SystemRole[],
    headName: HeadName,
    invariants: RolloutInvariants,
  ): NNOutput[] {
    const N = states.length
    if (N === 0) return []
    if (!this.nn.forwardBatch) {
      // fallback: forwardAt を順次
      const outputs: NNOutput[] = []
      for (let i = 0; i < N; i++) {
        outputs.push(this.forwardAt(states[i], actorSeats[i], actorRoles[i], headName, invariants))
      }
      return outputs
    }
    const t0 = BENCH_ENABLED ? performance.now() : 0
    const obsList: Float32Array[] = []
    for (let i = 0; i < N; i++) {
      obsList.push(this.encodeStateObs(states[i], actorSeats[i], actorRoles[i], invariants))
    }
    if (BENCH_ENABLED) benchEnd('obs_encode', t0)
    const t1 = BENCH_ENABLED ? performance.now() : 0
    const result = this.nn.forwardBatch(obsList, states, actorSeats, headName)
    if (BENCH_ENABLED) benchEnd('nn_forward_batch', t1)
    return result
  }

  /**
   * Stage 2: 役職 Module 集合 (bundle) を受け取り、phase ごとに dispatch する MCTS。
   * bundle が省略された場合は「自身の Module を全 bucket に充てる」フォールバックで動作 (Stage 1 互換)。
   */
  proposeVote(
    ctx: DecisionContext,
    opts?: { record?: boolean, bundle?: ModuleBundle },
  ): McctsProposal | null {
    const bundle = opts?.bundle ?? this.singletonBundle()
    return this.runMctsProposal(ctx, bundle, 'execute', 0, opts?.record ?? true)
  }

  proposeNightAction(
    ctx: DecisionContext,
    mode: 'divine' | 'guard' | 'attack',
    opts?: { record?: boolean, bundle?: ModuleBundle },
  ): McctsProposal | null {
    // 夜行動の除外席: 自席は常に除外、wolf の attack は teammates も除外
    let excludedMask = 1 << ctx.mySeat
    if (mode === 'attack') {
      for (const s of ctx.wolfTeammates ?? []) excludedMask |= 1 << s
    }
    const bundle = opts?.bundle ?? this.singletonBundle()
    return this.runMctsProposal(ctx, bundle, mode, excludedMask, opts?.record ?? true)
  }

  /**
   * Bundle 省略時のフォールバック: 自身を全 bucket に充てる。
   * Stage 1 互換維持用 (mason だけで rollout 全部回す等)。
   */
  protected singletonBundle(): ModuleBundle {
    return {
      mason: this, wolf: this, standard: this,
      fanatic: this, hamster: this, immoralist: this,
    }
  }

  finalize(outcome: FinalOutcome): void {
    this.buffer.finalize(outcome)
  }

  reset(): void {
    // pending だけクリア (finalized は保持、次 round の学習用)
    // TrainingBuffer に reset() はあるが finalized も消すため、
    // pending だけクリアする API が無い → finalize(NaN) で捨てるのは不正確
    // 今は pending を空にする API が buffer に無いので、buffer.reset() は慎重に使う。
  }

  // ============================================================
  // 共通 MCTS 実行ロジック
  // ============================================================

  /**
   * proposeVote / proposeNightAction の共通実装。
   *
   * @param actionMode vote / divine / guard / attack のどれか
   * @param excludedMask NN policy から除外する席 bitmask (自席 + wolf teammates 等)
   * @param record buffer に蓄積するか
   */
  private runMctsProposal(
    ctx: DecisionContext,
    bundle: ModuleBundle,
    actionMode: 'execute' | 'divine' | 'guard' | 'attack',
    excludedMask: number,
    record: boolean,
  ): McctsProposal | null {
    this._lastMCTSResult = null
    if (!ctx.globalRetarPossibilities) {
      this.fallbackCalls++
      return null
    }

    const possibilities = buildPossibilitiesFromRetar(ctx.globalRetarPossibilities, this.setup)
    // viewer 自身の seat-role は無条件で assumption に入れる (memory:
    // feedback_viewer_role_assumption)。これを忘れると determinizer が viewer 役職と
    // 矛盾する世界を sample し、`night_guard` 等 actor 不在の世界が混じって advancePhase
    // が次 phase へ skip → root が想定外 phase で expand される。
    if (!possibilities.fixRole(ctx.mySeat, ctx.myRole)) {
      this.fallbackCalls++
      return null
    }
    const determinizer = new Determinizer(possibilities, this.setup, this.determinizerMaxWorlds)
    if (determinizer.isOverflow() || determinizer.size() === 0) {
      this.fallbackCalls++
      return null
    }

    // sampleWorld は SimState 構築用のプレースホルダ。runMCTS 内の makeRolloutState で
    // 各 rollout ごとに別 world に差し替えられる。
    const sampleWorld = determinizer.sample(() => ctx.rng.next())
    if (!sampleWorld) {
      this.fallbackCalls++
      return null
    }

    // root SimState (ctx 由来の claims/divineLog/deathLog/guardLog 等を埋めた SimState) と
    // rollout 不変情報 (signal counts / retar / tsumi 等) を構築。
    const rootSimState = buildInitialSimState(ctx, sampleWorld)
    const invariants = buildInvariants(ctx)
    // root snapshot 用の obs (buffer 記録に使う、現状は決定者の Module の captureObs)
    const rootObs = this.captureObs(ctx)
    const alive = aliveBitmask(ctx.alivePlayers)

    const mctsConfig: MCTSConfig = this.mctsConfig
      ? { ...this.mctsConfig, rng: () => ctx.rng.next() }
      : { ...DEFAULT_MCTS_CONFIG, rng: () => ctx.rng.next() }

    const result = runMCTS(
      rootSimState, ctx.mySeat, determinizer, bundle, invariants, mctsConfig,
      { actionMode, excludedMask: actionMode === 'execute' ? 0 : excludedMask },
    )

    if (result.visits.size === 0) {
      this.fallbackCalls++
      return null
    }

    this.mctsCalls++
    this._lastMCTSResult = result

    const pi = normalizeVisits(result.visits)
    const headName: HeadName = actionMode

    if (record) {
      this.buffer.appendPending({
        obs: rootObs,
        visits: result.visits,
        pi,
        day: ctx.day,
        masonSeat: ctx.mySeat,
        alive,
        headName,
      })
    }

    return {
      visits: result.visits,
      pi,
      value: 0,
      obs: rootObs,
    }
  }
}

function aliveBitmask(alivePlayers: number[]): number {
  let mask = 0
  for (const seat of alivePlayers) mask |= (1 << seat)
  return mask
}
