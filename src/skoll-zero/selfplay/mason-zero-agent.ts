import type { SystemRole } from '../../types/index.ts'
import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { buildPossibilitiesFromRetar } from '../../skoll/unified.ts'
import { createSimState } from '../simulator/world-state.ts'
import { Determinizer } from '../mcts/determinize.ts'
import { runMCTS, DEFAULT_MCTS_CONFIG } from '../mcts/ismcts.ts'
import type { MCTSConfig } from '../mcts/ismcts.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import { TrainingBuffer } from './buffer.ts'
import { captureObs } from './observation.ts'
import { normalizeVisits, sampleFromVisits, argmaxFromVisits } from './policy-utils.ts'

export type MasonZeroAgentOptions = {
  /** Phase 1 NN（dummy or 本物）。policy + value 推論器 */
  nn: MasonZeroNN
  /** 配役（Determinizer 用） */
  setup: Map<SystemRole, number>
  /** (obs, π) を記録する buffer */
  buffer: TrainingBuffer
  /** MCTS hyperparams */
  mctsConfig?: MCTSConfig
  /** action 選択モード: sample (training) or argmax (eval) */
  selectionMode?: 'sample' | 'argmax'
  /** Determinizer の world 列挙上限 */
  determinizerMaxWorlds?: number
}

/**
 * mason 用エージェント（vote 決定のみ MCTS、それ以外は SkollMasterAgent 継承）。
 *
 * - decideVote: ISMCTS で投票先を決定し、(obs, π) を buffer に蓄積
 * - decideDayClaim / decideNightAction 等は super (SkollMasterAgent) に委譲
 *
 * Fallback 条件 (skoll heuristic に委譲):
 * - globalRetarPossibilities が null（Retar 無効）
 * - Determinizer overflow / 整合 world 0 件
 * - MCTS visits が空（理論上は起きないはず）
 */
export class MasonZeroAgent extends SkollMasterAgent {
  private readonly mzOpts: Required<Omit<MasonZeroAgentOptions, 'nn' | 'setup' | 'buffer' | 'mctsConfig'>>
    & Pick<MasonZeroAgentOptions, 'nn' | 'setup' | 'buffer' | 'mctsConfig'>

  /** デバッグ用カウンタ */
  mctsCalls = 0
  fallbackCalls = 0

  constructor(opts: MasonZeroAgentOptions) {
    super({})
    this.mzOpts = {
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      selectionMode: opts.selectionMode ?? 'sample',
      determinizerMaxWorlds: opts.determinizerMaxWorlds ?? 100000,
    }
  }

  override decideVote(ctx: DecisionContext): number {
    if (!ctx.globalRetarPossibilities) {
      this.fallbackCalls++
      return super.decideVote(ctx)
    }

    const possibilities = buildPossibilitiesFromRetar(ctx.globalRetarPossibilities, this.mzOpts.setup)
    const determinizer = new Determinizer(possibilities, this.mzOpts.setup, this.mzOpts.determinizerMaxWorlds)
    if (determinizer.isOverflow() || determinizer.size() === 0) {
      this.fallbackCalls++
      return super.decideVote(ctx)
    }

    // MCTS には初期 world が必要（rollout ごとに上書きされる）
    const sampleWorld = determinizer.sample(() => ctx.rng.next())
    if (!sampleWorld) {
      this.fallbackCalls++
      return super.decideVote(ctx)
    }
    const alive = aliveBitmask(ctx.alivePlayers)
    const infoState = createSimState(sampleWorld, alive, ctx.day, 'day')

    const mctsConfig: MCTSConfig = this.mzOpts.mctsConfig
      ? { ...this.mzOpts.mctsConfig, rng: () => ctx.rng.next() }
      : { ...DEFAULT_MCTS_CONFIG, rng: () => ctx.rng.next() }

    const result = runMCTS(infoState, ctx.mySeat, determinizer, this.mzOpts.nn, mctsConfig)
    if (result.visits.size === 0) {
      this.fallbackCalls++
      return super.decideVote(ctx)
    }

    this.mctsCalls++

    const pi = normalizeVisits(result.visits)
    this.mzOpts.buffer.appendPending({
      obs: captureObs(alive, ctx.day, ctx.mySeat),
      visits: result.visits,
      pi,
      day: ctx.day,
      masonSeat: ctx.mySeat,
    })

    return this.mzOpts.selectionMode === 'argmax'
      ? argmaxFromVisits(result.visits)
      : sampleFromVisits(result.visits, () => ctx.rng.next())
  }
}

function aliveBitmask(alivePlayers: number[]): number {
  let mask = 0
  for (const seat of alivePlayers) mask |= (1 << seat)
  return mask
}
