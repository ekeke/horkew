/**
 * RoleZeroAgent — 役職汎用 zero エージェント抽象基底。
 *
 * 設計:
 *   - decideVote で ISMCTS + NN、(obs, π) を buffer に蓄積
 *   - 役職ごとに違うのは (a) 観測エンコード、(b) 陣営 (faction)、(c) 除外席
 *   - それ以外 (Determinizer, MCTS, fallback) は共通
 *
 * サブクラス例: MasonZeroAgent / VillageZeroAgent / WolfZeroTeamAgent 等。
 */

import type { SystemRole } from '../../types/index.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { buildPossibilitiesFromRetar } from '../../skoll/unified.ts'
import { createSimState } from '../simulator/world-state.ts'
import { Determinizer } from '../mcts/determinize.ts'
import { runMCTS, DEFAULT_MCTS_CONFIG, type Faction, type MCTSConfig } from '../mcts/ismcts.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import { TrainingBuffer } from './buffer.ts'
import type { RootObs } from './observation.ts'
import { normalizeVisits, sampleFromVisits, argmaxFromVisits } from './policy-utils.ts'

export type RoleZeroAgentOptions = {
  nn: MasonZeroNN
  setup: Map<SystemRole, number>
  buffer: TrainingBuffer
  mctsConfig?: MCTSConfig
  selectionMode?: 'sample' | 'argmax'
  determinizerMaxWorlds?: number
}

/**
 * ISMCTS ベースの zero agent 基底。サブクラスは `faction` と `captureObservation()`
 * をオーバーライドするだけ。
 */
export abstract class RoleZeroAgent extends SkollMasterAgent {
  protected readonly zeroOpts: Required<Omit<RoleZeroAgentOptions, 'nn' | 'setup' | 'buffer' | 'mctsConfig'>>
    & Pick<RoleZeroAgentOptions, 'nn' | 'setup' | 'buffer' | 'mctsConfig'>

  /** 何度 MCTS を実行したか (debug) */
  mctsCalls = 0
  /** 何度 fallback に落ちたか (debug) */
  fallbackCalls = 0

  constructor(opts: RoleZeroAgentOptions) {
    super({})
    this.zeroOpts = {
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      selectionMode: opts.selectionMode ?? 'sample',
      determinizerMaxWorlds: opts.determinizerMaxWorlds ?? 100000,
    }
  }

  /** この役職の所属陣営 (value 符号計算に使う) */
  protected abstract faction(): Faction

  /** DecisionContext → NN 入力観測 (役職ごとに encodeObservation のバリアントを使う) */
  protected abstract captureObservation(ctx: DecisionContext): RootObs

  override decideVote(ctx: DecisionContext): number {
    if (!ctx.globalRetarPossibilities) {
      this.fallbackCalls++
      return super.decideVote(ctx)
    }

    const possibilities = buildPossibilitiesFromRetar(ctx.globalRetarPossibilities, this.zeroOpts.setup)
    const determinizer = new Determinizer(possibilities, this.zeroOpts.setup, this.zeroOpts.determinizerMaxWorlds)
    if (determinizer.isOverflow() || determinizer.size() === 0) {
      this.fallbackCalls++
      return super.decideVote(ctx)
    }

    const sampleWorld = determinizer.sample(() => ctx.rng.next())
    if (!sampleWorld) {
      this.fallbackCalls++
      return super.decideVote(ctx)
    }
    const alive = aliveBitmask(ctx.alivePlayers)
    const infoState = createSimState(sampleWorld, alive, ctx.day, 'day')
    const rootObs = this.captureObservation(ctx)

    const mctsConfig: MCTSConfig = this.zeroOpts.mctsConfig
      ? { ...this.zeroOpts.mctsConfig, rng: () => ctx.rng.next() }
      : { ...DEFAULT_MCTS_CONFIG, rng: () => ctx.rng.next() }

    const result = runMCTS(
      rootObs, infoState, ctx.mySeat, determinizer, this.zeroOpts.nn, mctsConfig, this.faction(),
    )
    if (result.visits.size === 0) {
      this.fallbackCalls++
      return super.decideVote(ctx)
    }

    this.mctsCalls++

    const pi = normalizeVisits(result.visits)
    this.zeroOpts.buffer.appendPending({
      obs: rootObs,
      visits: result.visits,
      pi,
      day: ctx.day,
      masonSeat: ctx.mySeat,  // PendingRecord の masonSeat フィールドは「決定者の席」として流用
      alive,
    })

    return this.zeroOpts.selectionMode === 'argmax'
      ? argmaxFromVisits(result.visits)
      : sampleFromVisits(result.visits, () => ctx.rng.next())
  }
}

function aliveBitmask(alivePlayers: number[]): number {
  let mask = 0
  for (const seat of alivePlayers) mask |= (1 << seat)
  return mask
}
