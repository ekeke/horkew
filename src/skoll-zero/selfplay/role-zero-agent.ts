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
import type { DayClaim } from '../../lupa/types.ts'
import type { LeadershipResponse, Proposal } from '../../fenrir/src/leadership.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { buildPossibilitiesFromRetar } from '../../skoll/unified.ts'
import { createSimState } from '../simulator/world-state.ts'
import { Determinizer } from '../mcts/determinize.ts'
import { runMCTS, DEFAULT_MCTS_CONFIG, type Faction, type MCTSConfig, type MCTSResult } from '../mcts/ismcts.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import { argmaxIndex, mergeClaimTypeWithSuper, leaderFromIdx } from '../../skoll/phase2/action-decoders.ts'
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
  /**
   * Phase 2 pretrained heads: key は `${role}-${method}` (例 'villager-claim', 'werewolf-comm')。
   * 役職別 checkpoint を実行時に ctx.myRole で切り替える用途。未登録の key は undefined が返り、
   * 呼び出し側は super の heuristic にフォールバックする。
   */
  phase2Nets?: Map<string, TransformerNetwork>
}

/**
 * ISMCTS ベースの zero agent 基底。サブクラスは `faction` と `captureObservation()`
 * をオーバーライドするだけ。
 */
export abstract class RoleZeroAgent extends SkollMasterAgent {
  protected readonly zeroOpts: Required<Omit<RoleZeroAgentOptions, 'nn' | 'setup' | 'buffer' | 'mctsConfig' | 'phase2Nets'>>
    & Pick<RoleZeroAgentOptions, 'nn' | 'setup' | 'buffer' | 'mctsConfig' | 'phase2Nets'>

  /** 何度 MCTS を実行したか (debug) */
  mctsCalls = 0
  /** 何度 fallback に落ちたか (debug) */
  fallbackCalls = 0

  /**
   * 直近の decideVote で得た MCTS 結果。fallback 経路では null。
   * huginn-adapter 等の外部 consumer が policy (visits) を取得するために使う。
   */
  protected lastMCTSResult: MCTSResult | null = null

  /** 直近の MCTS 結果を取得 (fallback 時は null) */
  getLastMCTSResult(): MCTSResult | null {
    return this.lastMCTSResult
  }

  constructor(opts: RoleZeroAgentOptions) {
    super({})
    this.zeroOpts = {
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      selectionMode: opts.selectionMode ?? 'sample',
      determinizerMaxWorlds: opts.determinizerMaxWorlds ?? 100000,
      phase2Nets: opts.phase2Nets,
    }
  }

  /** この役職の所属陣営 (value 符号計算に使う) */
  protected abstract faction(): Faction

  /** DecisionContext → NN 入力観測 (役職ごとに encodeObservation のバリアントを使う) */
  protected abstract captureObservation(ctx: DecisionContext): RootObs

  override decideVote(ctx: DecisionContext): number {
    this.lastMCTSResult = null
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
    this.lastMCTSResult = result

    const pi = normalizeVisits(result.visits)
    this.zeroOpts.buffer.appendPending({
      obs: rootObs,
      visits: result.visits,
      pi,
      day: ctx.day,
      masonSeat: ctx.mySeat,  // PendingRecord の masonSeat フィールドは「決定者の席」として流用
      alive,
      headName: 'vote',
    })

    return this.zeroOpts.selectionMode === 'argmax'
      ? argmaxFromVisits(result.visits)
      : sampleFromVisits(result.visits, () => ctx.rng.next())
  }

  // ============================================================
  // Phase 2 pretrained head hooks
  //
  // 各 decide* は NN head 出力があれば argmax を採用、無ければ super (heuristic) に
  // 委譲。`phase2Nets` は key `${role}-${method}` で lookup する。captureObservation を
  // 使って観測を作るので wolf は team obs、他は individual obs になる。
  // ============================================================

  /** phase2Nets から `${role}-${method}` checkpoint の forward 結果を取得。無ければ null。 */
  protected forwardPhase2(method: string, ctx: DecisionContext): ReturnType<TransformerNetwork['forward']> | null {
    const net = this.zeroOpts.phase2Nets?.get(`${ctx.myRole}-${method}`)
    if (!net) return null
    const obs = this.captureObservation(ctx)
    return net.forward(obs)
  }

  override decideDayClaim(ctx: DecisionContext): DayClaim {
    const superDecision = super.decideDayClaim(ctx)
    const logits = this.forwardPhase2('claim', ctx)?.policies.get('claim')
    if (!logits) return superDecision
    return mergeClaimTypeWithSuper(argmaxIndex(logits), superDecision)
  }

  override decideForecast(ctx: DecisionContext): DayClaim {
    const superDecision = super.decideForecast(ctx)
    // forecast は claim head (10 次元 softmax) を共有する設計 (METHOD_HEAD_MAP 参照)
    const logits = this.forwardPhase2('forecast', ctx)?.policies.get('claim')
    if (!logits) return superDecision
    return mergeClaimTypeWithSuper(argmaxIndex(logits), superDecision)
  }

  override decideDefensiveClaim(ctx: DecisionContext): DayClaim {
    const superDecision = super.decideDefensiveClaim(ctx)
    const logits = this.forwardPhase2('defensive_claim', ctx)?.policies.get('claim')
    if (!logits) return superDecision
    return mergeClaimTypeWithSuper(argmaxIndex(logits), superDecision)
  }

  override decideLeadershipResponse(ctx: DecisionContext, proposal: Proposal): LeadershipResponse {
    const superDecision = super.decideLeadershipResponse(ctx, proposal)
    const logits = this.forwardPhase2('leader', ctx)?.policies.get('leader')
    if (!logits) return superDecision
    return leaderFromIdx(argmaxIndex(logits)) ?? superDecision
  }

  override decideProposal(ctx: DecisionContext): Proposal | null {
    const superDecision = super.decideProposal(ctx)
    if (!superDecision) return null
    // propose head は per-seat sigmoid (14 次元)。最もスコアが高い alive/非自席 を target に。
    // type は super の heuristic (decideCommanderProposal) の判断を継承する。
    const logits = this.forwardPhase2('propose', ctx)?.policies.get('propose')
    if (!logits) return superDecision
    const aliveSet = new Set(ctx.alivePlayers)
    let bestSeat = superDecision.target
    let bestScore = -Infinity
    for (let i = 0; i < logits.length; i++) {
      const seat = i + 1  // observation.ts の per-seat layout: index i → seat i+1
      if (!aliveSet.has(seat) || seat === ctx.mySeat) continue
      if (logits[i] > bestScore) { bestScore = logits[i]; bestSeat = seat }
    }
    return { ...superDecision, target: bestSeat }
  }
}

function aliveBitmask(alivePlayers: number[]): number {
  let mask = 0
  for (const seat of alivePlayers) mask |= (1 << seat)
  return mask
}
