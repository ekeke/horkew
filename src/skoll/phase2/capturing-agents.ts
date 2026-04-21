/**
 * Phase 2 pretrain 用の data collector。
 * RuleBasedAgent / WolfTeamRuleAgent / MasonTeamRuleAgent を包み、各 decide* の
 * 結果を (obs, action) サンプルとして SampleCollector に記録する。
 *
 * 観測エンコード:
 *   - 個別 Agent: encodeObservation (1029 dims)
 *   - Wolf team:  encodeCollectiveWolfObservation (1212 dims)
 *   - Mason team: encodeCollectiveMasonObservation (1030 dims)
 */
import type { DecisionContext, TeamDecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { Proposal } from '../../fenrir/src/leadership.ts'
import type { DayClaim } from '../../lupa/types.ts'
import type { CommunicationAction } from '../../fenrir/src/communication.ts'
import {
  encodeObservation,
  encodeCollectiveWolfObservation,
  encodeCollectiveMasonObservation,
} from '../../fenrir/src/observation.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../../fenrir/src/agents/rule-based-agent.ts'
import {
  encodeClaim, encodeTargetSeat, encodeSeatMultiHot,
  encodeCommSignal, encodeLeader, encodePredict,
} from './action-encoders.ts'
import type { SampleCollector, SampleMeta } from './sample-collector.ts'

/** Capturing 共通の記録ルート */
type CaptureCtx = {
  collector: SampleCollector
  gameId: number
}

function aliveBitmask(alivePlayers: number[]): number {
  let mask = 0
  for (const s of alivePlayers) mask |= (1 << s)
  return mask
}

function buildMeta(gameId: number, ctx: DecisionContext | TeamDecisionContext, seat: number): SampleMeta {
  return {
    gameId,
    day: ctx.day,
    seat,
    alive: aliveBitmask(ctx.alivePlayers),
  }
}

/**
 * 共通 capture logic: ctx と decision を取り、encoder で action を作って collector に記録。
 * obs は caller 側で encode してから渡す (role によって使う encode が違うため)。
 */
function captureClaim(
  cc: CaptureCtx, role: string, seat: number, obs: Float32Array,
  ctx: DecisionContext | TeamDecisionContext, decision: DayClaim, method: 'claim' | 'forecast' | 'defensive_claim',
): void {
  const action = encodeClaim(decision)
  if (action < 0) return
  cc.collector.add(role, method, obs, action, buildMeta(cc.gameId, ctx, seat))
  // target head も同時に記録 (forecast / mason_co)
  const tgt = encodeTargetSeat(decision)
  if (tgt !== null && tgt >= 1 && tgt <= 14) {
    cc.collector.add(role, 'target', obs, tgt - 1, buildMeta(cc.gameId, ctx, seat))
  }
  // bodyguard_co の targets[] は multi-hot で propose 形式記録 (decision.type='bodyguard_co')
  if (decision.type === 'bodyguard_co' && decision.targets.length > 0) {
    cc.collector.add(role, 'bodyguard_targets', obs, encodeSeatMultiHot(decision.targets), buildMeta(cc.gameId, ctx, seat))
  }
}

function captureComm(
  cc: CaptureCtx, role: string, seat: number, obs: Float32Array,
  ctx: DecisionContext | TeamDecisionContext, comm: CommunicationAction,
): void {
  // signal → comm head
  const sigIdx = encodeCommSignal(comm.signal)
  if (sigIdx >= 0) {
    cc.collector.add(role, 'comm', obs, sigIdx, buildMeta(cc.gameId, ctx, seat))
  }
  // proposals → propose head (multi-hot)
  if (comm.proposals.length > 0) {
    cc.collector.add(role, 'propose', obs, encodeSeatMultiHot(comm.proposals), buildMeta(cc.gameId, ctx, seat))
  }
  // predictions → predict head (multi-hot)
  if (comm.predictions && comm.predictions.size > 0) {
    cc.collector.add(role, 'predict', obs, encodePredict(comm.predictions), buildMeta(cc.gameId, ctx, seat))
  }
}

function captureLeader(
  cc: CaptureCtx, role: string, seat: number, obs: Float32Array,
  ctx: DecisionContext | TeamDecisionContext, resp: ReturnType<RuleBasedAgent['decideLeadershipResponse']>,
): void {
  const action = encodeLeader(resp)
  cc.collector.add(role, 'leader', obs, action, buildMeta(cc.gameId, ctx, seat))
}

// ============================================================================
// Individual agent wrapper (villager/seer/medium/bodyguard/nekomata/fanatic/hamster/immoralist)
// ============================================================================

export class CapturingRuleBasedAgent extends RuleBasedAgent {
  private cc: CaptureCtx
  constructor(cc: CaptureCtx) { super(); this.cc = cc }

  override decideDayClaim(ctx: DecisionContext): DayClaim {
    const decision = super.decideDayClaim(ctx)
    const obs = encodeObservation(ctx)
    captureClaim(this.cc, ctx.myRole, ctx.mySeat, obs, ctx, decision, 'claim')
    return decision
  }

  override decideForecast(ctx: DecisionContext): DayClaim {
    const decision = super.decideForecast(ctx)
    // forecast は type='forecast' or 'none' のみ。none は学習対象として情報量薄いが一応記録
    const obs = encodeObservation(ctx)
    captureClaim(this.cc, ctx.myRole, ctx.mySeat, obs, ctx, decision, 'forecast')
    return decision
  }

  override decideDefensiveClaim(ctx: DecisionContext): DayClaim {
    const decision = super.decideDefensiveClaim(ctx)
    const obs = encodeObservation(ctx)
    captureClaim(this.cc, ctx.myRole, ctx.mySeat, obs, ctx, decision, 'defensive_claim')
    return decision
  }

  override decideCommunication(ctx: DecisionContext): CommunicationAction {
    const comm = super.decideCommunication(ctx)
    const obs = encodeObservation(ctx)
    captureComm(this.cc, ctx.myRole, ctx.mySeat, obs, ctx, comm)
    return comm
  }

  override decideLeadershipResponse(ctx: DecisionContext, proposal: Proposal) {
    const resp = super.decideLeadershipResponse(ctx, proposal)
    const obs = encodeObservation(ctx)
    captureLeader(this.cc, ctx.myRole, ctx.mySeat, obs, ctx, resp)
    return resp
  }
}

// ============================================================================
// Wolf team wrapper
// ============================================================================

export class CapturingWolfTeamAgent extends WolfTeamRuleAgent {
  private cc: CaptureCtx
  constructor(cc: CaptureCtx) { super(); this.cc = cc }

  override decideDayClaim(ctx: TeamDecisionContext): DayClaim {
    const decision = super.decideDayClaim(ctx)
    const obs = encodeCollectiveWolfObservation(ctx)
    captureClaim(this.cc, 'werewolf', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, decision, 'claim')
    return decision
  }

  override decideForecast(ctx: TeamDecisionContext): DayClaim {
    const decision = super.decideForecast(ctx)
    const obs = encodeCollectiveWolfObservation(ctx)
    captureClaim(this.cc, 'werewolf', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, decision, 'forecast')
    return decision
  }

  override decideDefensiveClaim(ctx: TeamDecisionContext): DayClaim {
    const decision = super.decideDefensiveClaim(ctx)
    const obs = encodeCollectiveWolfObservation(ctx)
    captureClaim(this.cc, 'werewolf', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, decision, 'defensive_claim')
    return decision
  }

  override decideCommunication(ctx: TeamDecisionContext): CommunicationAction {
    const comm = super.decideCommunication(ctx)
    const obs = encodeCollectiveWolfObservation(ctx)
    captureComm(this.cc, 'werewolf', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, comm)
    return comm
  }

  override decideLeadershipResponse(ctx: TeamDecisionContext, proposal: Proposal) {
    const resp = super.decideLeadershipResponse(ctx, proposal)
    const obs = encodeCollectiveWolfObservation(ctx)
    captureLeader(this.cc, 'werewolf', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, resp)
    return resp
  }
}

// ============================================================================
// Mason team wrapper
// ============================================================================

export class CapturingMasonTeamAgent extends MasonTeamRuleAgent {
  private cc: CaptureCtx
  constructor(cc: CaptureCtx) { super(); this.cc = cc }

  override decideDayClaim(ctx: TeamDecisionContext): DayClaim {
    const decision = super.decideDayClaim(ctx)
    const obs = encodeCollectiveMasonObservation(ctx)
    captureClaim(this.cc, 'mason', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, decision, 'claim')
    return decision
  }

  override decideForecast(ctx: TeamDecisionContext): DayClaim {
    const decision = super.decideForecast(ctx)
    const obs = encodeCollectiveMasonObservation(ctx)
    captureClaim(this.cc, 'mason', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, decision, 'forecast')
    return decision
  }

  override decideDefensiveClaim(ctx: TeamDecisionContext): DayClaim {
    const decision = super.decideDefensiveClaim(ctx)
    const obs = encodeCollectiveMasonObservation(ctx)
    captureClaim(this.cc, 'mason', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, decision, 'defensive_claim')
    return decision
  }

  override decideCommunication(ctx: TeamDecisionContext): CommunicationAction {
    const comm = super.decideCommunication(ctx)
    const obs = encodeCollectiveMasonObservation(ctx)
    captureComm(this.cc, 'mason', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, comm)
    return comm
  }

  override decideLeadershipResponse(ctx: TeamDecisionContext, proposal: Proposal) {
    const resp = super.decideLeadershipResponse(ctx, proposal)
    const obs = encodeCollectiveMasonObservation(ctx)
    captureLeader(this.cc, 'mason', ctx.currentActorSeat ?? ctx.teamSeats[0], obs, ctx, resp)
    return resp
  }
}
