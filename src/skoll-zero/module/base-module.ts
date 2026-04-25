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
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { buildPossibilitiesFromRetar } from '../../skoll/unified.ts'
import { createSimState } from '../simulator/world-state.ts'
import { Determinizer } from '../mcts/determinize.ts'
import {
  runMCTS, DEFAULT_MCTS_CONFIG,
  type Faction, type MCTSConfig, type MCTSResult,
} from '../mcts/ISMCTS.ts'
import type { MasonZeroNN, HeadName } from '../mcts/nn.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import type { RootObs } from '../selfplay/observation.ts'
import { normalizeVisits } from '../selfplay/policy-utils.ts'
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

  /** 役職別 obs encoder。サブクラスで実装 */
  abstract captureObs(ctx: DecisionContext): RootObs

  /** MCTS value backup の faction 視点。サブクラスで実装 */
  protected abstract faction(): Faction

  proposeVote(ctx: DecisionContext, opts?: { record?: boolean }): McctsProposal | null {
    return this.runMctsProposal(ctx, 'execute', 0, opts?.record ?? true)
  }

  proposeNightAction(
    ctx: DecisionContext,
    mode: 'divine' | 'guard' | 'attack',
    opts?: { record?: boolean },
  ): McctsProposal | null {
    // 夜行動の除外席: 自席は常に除外、wolf の attack は teammates も除外
    let excludedMask = 1 << ctx.mySeat
    if (mode === 'attack') {
      for (const s of ctx.wolfTeammates ?? []) excludedMask |= 1 << s
    }
    return this.runMctsProposal(ctx, mode, excludedMask, opts?.record ?? true)
  }

  finalize(z: number): void {
    this.buffer.finalize(z)
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
    const determinizer = new Determinizer(possibilities, this.setup, this.determinizerMaxWorlds)
    if (determinizer.isOverflow() || determinizer.size() === 0) {
      this.fallbackCalls++
      return null
    }

    const sampleWorld = determinizer.sample(() => ctx.rng.next())
    if (!sampleWorld) {
      this.fallbackCalls++
      return null
    }

    const alive = aliveBitmask(ctx.alivePlayers)
    // phase は ISMCTS 側 (makeRolloutState) で actionMode から決定するので、
    // ここで指定しても上書きされる。createSimState の default ('morning') のまま渡す。
    const infoState = createSimState(sampleWorld, alive, ctx.day)
    const rootObs = this.captureObs(ctx)

    const mctsConfig: MCTSConfig = this.mctsConfig
      ? { ...this.mctsConfig, rng: () => ctx.rng.next() }
      : { ...DEFAULT_MCTS_CONFIG, rng: () => ctx.rng.next() }

    const result = runMCTS(
      rootObs, infoState, ctx.mySeat, determinizer, this.nn, mctsConfig, this.faction(),
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
      value: 0,  // MCTS root value は result に持たせる設計ではないので 0 固定。将来必要なら result.root の Q 平均から取得
      obs: rootObs,
    }
  }
}

function aliveBitmask(alivePlayers: number[]): number {
  let mask = 0
  for (const seat of alivePlayers) mask |= (1 << seat)
  return mask
}
