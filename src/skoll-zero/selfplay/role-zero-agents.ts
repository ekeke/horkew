/**
 * Village / Wolf / Fanatic / Hamster / Immoralist 用の zero agent。
 *
 * いずれも RoleZeroAgent を継承し、faction と captureObservation だけ差し替える。
 *
 * 観測エンコーダ:
 *   - Village / Fanatic / Hamster / Immoralist: standard encodeObservation (1029 dims)
 *   - Wolf: encodeCollectiveWolfObservation (1212 dims, TeamDecisionContext 要)
 *
 * ※ Wolf は本質的にチーム(TeamDecisionContext)単位だが、fullAdapter は個別 agent に
 *    DecisionContext を渡すため、ここでは「個々の wolf 席が独立に MCTS を回す」
 *    近似とする。厳密なチーム協調は Phase 3 で検討。
 */

import type { DecisionContext, TeamDecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { DayClaim, NightAction } from '../../lupa/types.ts'
import {
  encodeObservation,
  encodeCollectiveWolfObservation,
} from '../../fenrir/src/observation.ts'
import { buildPossibilitiesFromRetar } from '../../skoll/unified.ts'
import { createSimState } from '../simulator/world-state.ts'
import { Determinizer } from '../mcts/determinize.ts'
import { runMCTS, DEFAULT_MCTS_CONFIG, type Faction, type MCTSConfig } from '../mcts/ismcts.ts'
import { argmaxFromVisits, sampleFromVisits, normalizeVisits } from './policy-utils.ts'
import { RoleZeroAgent } from './role-zero-agent.ts'
import type { RootObs } from './observation.ts'
import { argmaxIndex, claimTypeFromIdx, mergeClaimTypeWithSuper } from '../../skoll/phase2/action-decoders.ts'

/** Village 視点 (villager/seer/medium/bodyguard/nekomata): standard obs、village faction */
export class VillageZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'village' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }

  /**
   * 昼 CO: phase2Nets に `${ctx.myRole}-claim` checkpoint があれば NN claim head で type を
   * 決定し、補助情報 (target/result 等) は super の heuristic 結果から借用してマージ。
   * 該当 checkpoint 無しは super (RuleBasedAgent) に委譲。
   */
  override decideDayClaim(ctx: DecisionContext): DayClaim {
    const superDecision = super.decideDayClaim(ctx)
    const claimNet = this.zeroOpts.phase2Nets?.get(`${ctx.myRole}-claim`)
    if (!claimNet) return superDecision
    const obs = encodeObservation(ctx)
    const logits = claimNet.forward(obs).policies.get('claim')
    if (!logits) return superDecision
    const argmax = argmaxIndex(logits)
    const merged = mergeClaimTypeWithSuper(argmax, superDecision)
    // eslint-disable-next-line no-console
    console.log(`[phase2-village seat=${ctx.mySeat} role=${ctx.myRole}] claim argmax=${argmax} (${claimTypeFromIdx(argmax)}) super=${superDecision.type} → ${merged.type}`)
    return merged
  }

  /**
   * 夜行動: seer は divine head、bodyguard は guard head で ISMCTS を実行。
   * 他役職 (villager/medium/nekomata) は super (RuleBasedAgent) に委譲。
   */
  override decideNightAction(ctx: DecisionContext): NightAction {
    if (ctx.myRole === 'seer') {
      return this.decideVillageNightWithMCTS(ctx, 'divine')
    }
    if (ctx.myRole === 'bodyguard') {
      return this.decideVillageNightWithMCTS(ctx, 'guard')
    }
    return super.decideNightAction(ctx)
  }

  private decideVillageNightWithMCTS(
    ctx: DecisionContext,
    mode: 'divine' | 'guard',
  ): NightAction {
    if (!ctx.globalRetarPossibilities) {
      this.fallbackCalls++
      return super.decideNightAction(ctx)
    }
    const possibilities = buildPossibilitiesFromRetar(ctx.globalRetarPossibilities, this.zeroOpts.setup)
    const determinizer = new Determinizer(possibilities, this.zeroOpts.setup, this.zeroOpts.determinizerMaxWorlds)
    if (determinizer.isOverflow() || determinizer.size() === 0) {
      this.fallbackCalls++
      return super.decideNightAction(ctx)
    }
    const sampleWorld = determinizer.sample(() => ctx.rng.next())
    if (!sampleWorld) {
      this.fallbackCalls++
      return super.decideNightAction(ctx)
    }
    const alive = aliveBitmask(ctx.alivePlayers)
    const infoState = createSimState(sampleWorld, alive, ctx.day, 'night')
    const rootObs = encodeObservation(ctx)
    const excludedMask = 1 << ctx.mySeat

    const mctsConfig: MCTSConfig = this.zeroOpts.mctsConfig
      ? { ...this.zeroOpts.mctsConfig, rng: () => ctx.rng.next() }
      : { ...DEFAULT_MCTS_CONFIG, rng: () => ctx.rng.next() }

    const result = runMCTS(
      rootObs, infoState, ctx.mySeat, determinizer, this.zeroOpts.nn, mctsConfig, 'village',
      { actionMode: mode, excludedMask },
    )
    if (result.visits.size === 0) {
      this.fallbackCalls++
      return super.decideNightAction(ctx)
    }
    this.mctsCalls++

    const pi = normalizeVisits(result.visits)
    this.zeroOpts.buffer.appendPending({
      obs: rootObs,
      visits: result.visits,
      pi,
      day: ctx.day,
      masonSeat: ctx.mySeat,
      alive,
      headName: mode,
    })

    const target = this.zeroOpts.selectionMode === 'argmax'
      ? argmaxFromVisits(result.visits)
      : sampleFromVisits(result.visits, () => ctx.rng.next())

    return { type: mode, target }
  }
}

/** Wolf 視点: wolf_collective obs、wolf faction。各 wolf 席が独立に MCTS を回す近似 */
export class WolfZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'wolf' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return buildWolfTeamObs(ctx)
  }

  /**
   * 夜の噛み先を ISMCTS + NN で決定する。
   *
   * - 観測: encodeCollectiveWolfObservation (team scope)
   * - Determinizer: village 視点 retar の世界列挙
   * - action space: 非狼生存席 (wolf team は除外)
   * - rollout: night → attack apply → day/night cycle heuristic → terminal → wolf faction value
   *
   * Retar 無効 / Determinizer overflow 時は super (SkollMasterAgent → heuristic) に委譲。
   */
  override decideNightAction(ctx: DecisionContext): NightAction {
    if (!ctx.globalRetarPossibilities) {
      this.fallbackCalls++
      return super.decideNightAction(ctx)
    }

    const possibilities = buildPossibilitiesFromRetar(ctx.globalRetarPossibilities, this.zeroOpts.setup)
    const determinizer = new Determinizer(possibilities, this.zeroOpts.setup, this.zeroOpts.determinizerMaxWorlds)
    if (determinizer.isOverflow() || determinizer.size() === 0) {
      this.fallbackCalls++
      return super.decideNightAction(ctx)
    }

    const sampleWorld = determinizer.sample(() => ctx.rng.next())
    if (!sampleWorld) {
      this.fallbackCalls++
      return super.decideNightAction(ctx)
    }
    const alive = aliveBitmask(ctx.alivePlayers)
    const infoState = createSimState(sampleWorld, alive, ctx.day, 'night')

    // wolf team (自席 + teammates) を除外 mask (1-based seat bit)
    let excludedMask = 1 << ctx.mySeat
    for (const s of ctx.wolfTeammates ?? []) excludedMask |= 1 << s

    const rootObs = buildWolfTeamObs(ctx)
    const mctsConfig: MCTSConfig = this.zeroOpts.mctsConfig
      ? { ...this.zeroOpts.mctsConfig, rng: () => ctx.rng.next() }
      : { ...DEFAULT_MCTS_CONFIG, rng: () => ctx.rng.next() }

    const result = runMCTS(
      rootObs, infoState, ctx.mySeat, determinizer, this.zeroOpts.nn, mctsConfig, 'wolf',
      { actionMode: 'attack', excludedMask },
    )
    if (result.visits.size === 0) {
      this.fallbackCalls++
      return super.decideNightAction(ctx)
    }
    this.mctsCalls++

    // attack 専用 head に (obs, visits, π) を記録 — vote policy と分離。
    const pi = normalizeVisits(result.visits)
    this.zeroOpts.buffer.appendPending({
      obs: rootObs,
      visits: result.visits,
      pi,
      day: ctx.day,
      masonSeat: ctx.mySeat,
      alive,
      headName: 'attack',
    })

    const target = this.zeroOpts.selectionMode === 'argmax'
      ? argmaxFromVisits(result.visits)
      : sampleFromVisits(result.visits, () => ctx.rng.next())

    // 個別 Agent の NightAction は lupa 型 (attacker は team agent が決める)
    return { type: 'attack', target }
  }
}

/** 個別 wolf の DecisionContext から team obs を復元 */
function buildWolfTeamObs(ctx: DecisionContext): RootObs {
  const teamSeats = [...(ctx.wolfTeammates ?? [])]
  if (!teamSeats.includes(ctx.mySeat)) teamSeats.unshift(ctx.mySeat)
  const teamPlayers = teamSeats
    .map(s => ctx.gameState.players.find(p => p.seat === s))
    .filter((p): p is NonNullable<typeof p> => !!p)
  const teamCtx: TeamDecisionContext = {
    ...ctx,
    teamSeats,
    teamPlayers,
    currentActorSeat: ctx.mySeat,
  }
  return encodeCollectiveWolfObservation(teamCtx)
}

function aliveBitmask(alivePlayers: number[]): number {
  let mask = 0
  for (const seat of alivePlayers) mask |= (1 << seat)
  return mask
}

/** Fanatic 視点: standard obs、wolf faction (狼勝ち = +1) */
export class FanaticZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'wolf' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
}

/** Hamster 視点: standard obs、hamster faction */
export class HamsterZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'hamster' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
}

/** Immoralist 視点: standard obs、hamster faction (狐勝ち = +1) */
export class ImmoralistZeroAgent extends RoleZeroAgent {
  protected override faction(): Faction { return 'hamster' }
  protected override captureObservation(ctx: DecisionContext): RootObs {
    return encodeObservation(ctx)
  }
}
