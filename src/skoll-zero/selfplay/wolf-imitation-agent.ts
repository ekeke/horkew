/**
 * WolfImitationRoleAgent — Wolf Imitation 用の Role Agent (A 案)。
 *
 * SkollZeroRoleAgent を継承し、内部に WolfImitationModule を持つ。WolfRoleAgent と同様に
 * decideNightAction (襲撃) は execute MCTS を使い、加えて decideDayClaim を override して
 * 以下の 2 経路を NN-MCTS 化する:
 *
 * 1. **未 CO 状態の偽 CO 種別 + claimer 選択** (A案、proposeClaimDecision)
 *    - 57-action 空間 (skip + 4 役職 × 14 claimer) で MCTS、joint distribution として学習
 *    - 自席が claimer に選ばれた場合のみ自身が CO、別 seat なら super (heuristic) に委譲
 *    - 偽 seer 選択時は results=[] の seer_co を返し、翌朝の morning で結果生成へ続く
 *
 * 2. **偽 seer 騙り中の翌朝結果報告** (B案維持、proposeMorning)
 *    - 既 CO 状態かつ claimedRole='seer' で werewolf/fanatic のとき
 *    - 28-action 空間 (target × {white, black}) で MCTS、wolf NN の morning_* head を学習
 *
 * ## fakeDivineHistory の整合性
 *
 * morning result (seer 結果報告) は `myPlayer.fakeDivineHistory` に登録してから DayClaim を
 * 返す。これを忘れると後続日の retar 整合性チェックや観測 encoding で乖離が生じる。
 */

import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { DayClaim, NightAction } from '../../lupa/types.ts'
import type { EnumSpecies } from '../../types/index.ts'
import { SkollZeroRoleAgent, type SkollZeroRoleAgentOptions } from './role-zero-agent.ts'
import { argmaxFromVisits, sampleFromVisits, temperatureForAlive } from './policy-utils.ts'
import { WolfImitationModule } from '../module/wolf-imitation-module.ts'
import { WolfImitationNetwork } from '../network/wolf-imitation-network.ts'
import { decodeClaimDecisionAction } from '../simulator/rollout-sim.ts'

const SEATS = 14

/** WolfImitationRoleAgent 専用の constructor opts。nn は WolfImitationNetwork に narrow。 */
export type WolfImitationRoleAgentOptions =
  Omit<SkollZeroRoleAgentOptions, 'nn'> & { nn: WolfImitationNetwork }

export class WolfImitationRoleAgent extends SkollZeroRoleAgent {
  /** type-narrowed module (constructor で同じインスタンスを再格納) */
  private readonly imitationModule: WolfImitationModule

  constructor(opts: WolfImitationRoleAgentOptions) {
    const module = new WolfImitationModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
    })
    super(module, opts.selectionMode ?? 'sample')
    this.imitationModule = module
  }

  /**
   * 夜の襲撃先 (WolfRoleAgent と同じ、execute MCTS 経由)。
   */
  override decideNightAction(ctx: DecisionContext): NightAction {
    if (this.selectionMode === 'policy_argmax') {
      const policy = this.module.proposePolicyOnly(ctx, 'attack')
      if (!policy) return super.decideNightAction(ctx)
      return { type: 'attack', target: argmaxFromVisits(policy) }
    }
    const r = this.module.proposeNightAction(ctx, 'attack', this.proposeOpts())
    if (!r) return super.decideNightAction(ctx)
    const target = this.selectionMode === 'argmax'
      ? argmaxFromVisits(r.visits)
      : sampleFromVisits(
          r.visits,
          () => ctx.rng.next(),
          temperatureForAlive(ctx.alivePlayers.length),
        )
    return { type: 'attack', target }
  }

  /**
   * 偽 CO 判断 (未 CO 状態、A案) と偽 seer 騙り中の翌朝結果 (既 CO 状態、B案維持) を
   * NN-MCTS で生成。それ以外は super (heuristic) に委譲。
   */
  override decideDayClaim(ctx: DecisionContext): DayClaim {
    const myPlayer = ctx.myPlayer
    if (!myPlayer) return super.decideDayClaim(ctx)
    const debug = process.env.SKOLLZ_WOLF_IMITATION_DEBUG === '1'

    // 既 CO 状態: 偽 seer 騙り中なら proposeMorning、それ以外は super
    if (myPlayer.claimedRole !== null) {
      const isFakeSeerActive = myPlayer.claimedRole === 'seer'
        && (ctx.myRole === 'werewolf' || ctx.myRole === 'fanatic')
      if (debug) {
        process.stderr.write(`[wolf-imitation] decideDayClaim (post-CO) day=${ctx.day} seat=${ctx.mySeat} role=${ctx.myRole} claimed=${myPlayer.claimedRole} fakeSeerActive=${isFakeSeerActive}\n`)
      }
      if (!isFakeSeerActive) return super.decideDayClaim(ctx)
      return this.decideMorningResult(ctx, myPlayer)
    }

    // 未 CO 状態 (A案): proposeClaimDecision で 57-action 空間を MCTS
    const isWolfFaction = ctx.myRole === 'werewolf' || ctx.myRole === 'fanatic'
    if (!isWolfFaction) return super.decideDayClaim(ctx)

    const r = this.imitationModule.proposeClaimDecision(ctx, this.proposeOpts())
    if (debug) {
      process.stderr.write(`[wolf-imitation] proposeClaimDecision day=${ctx.day} seat=${ctx.mySeat} result=${r ? `visits=${r.visits.size}` : 'null (fallback to heuristic)'}\n`)
    }
    if (!r) return super.decideDayClaim(ctx)

    const action = this.selectionMode === 'argmax' || this.selectionMode === 'policy_argmax'
      ? argmaxFromVisits(r.visits)
      : sampleFromVisits(
          r.visits,
          () => ctx.rng.next(),
          temperatureForAlive(ctx.alivePlayers.length),
        )

    if (debug) {
      process.stderr.write(`[wolf-imitation] proposeClaimDecision selected action=${action}\n`)
    }

    // action 0 = skip → super (潜伏 or 別判断は heuristic)
    if (action === 0) return super.decideDayClaim(ctx)

    const decoded = decodeClaimDecisionAction(action)
    if (!decoded) return super.decideDayClaim(ctx)

    // claimer != mySeat → 別 wolf に任せる (super 経由で heuristic で潜伏 or その wolf が自分で CO)
    if (decoded.claimerSeat !== ctx.mySeat) return super.decideDayClaim(ctx)

    // claimer == mySeat → 自分が role 騙り
    switch (decoded.role) {
      case 'seer':
        // 初回偽 seer CO: results=[] で返す。翌朝の morning で proposeMorning が偽結果を生成。
        return { type: 'seer_co', results: [] }
      case 'medium':
        return { type: 'medium_co', pastResults: [] }
      case 'bodyguard':
        return { type: 'bodyguard_co', targets: [] }
      case 'nekomata':
        return { type: 'nekomata_co' }
      default:
        return super.decideDayClaim(ctx)
    }
  }

  /**
   * 偽 seer 騙り中の翌朝結果生成 (B案、proposeMorning 経由)。
   *
   * action = target_idx × 2 + color (0=human, 1=wolf)。fakeDivineHistory に登録した上で
   * `seer_result` DayClaim を返す。失敗時は super (heuristic) に委譲。
   */
  private decideMorningResult(
    ctx: DecisionContext,
    myPlayer: NonNullable<DecisionContext['myPlayer']>,
  ): DayClaim {
    const debug = process.env.SKOLLZ_WOLF_IMITATION_DEBUG === '1'
    const r = this.imitationModule.proposeMorning(ctx, this.proposeOpts())
    if (debug) {
      process.stderr.write(`[wolf-imitation] proposeMorning result=${r ? `visits=${r.visits.size}` : 'null (fallback to heuristic)'}\n`)
    }
    if (!r) return super.decideDayClaim(ctx)

    const action = this.selectionMode === 'argmax' || this.selectionMode === 'policy_argmax'
      ? argmaxFromVisits(r.visits)
      : sampleFromVisits(
          r.visits,
          () => ctx.rng.next(),
          temperatureForAlive(ctx.alivePlayers.length),
        )
    const targetSeat = (action >> 1) + 1
    const color: EnumSpecies = (action & 1) === 0 ? 'human' : 'wolf'

    // fakeDivineHistory に登録 (lupa engine の applyClaim と後続日の整合性確保)
    const night = ctx.day - 1
    if (targetSeat >= 1 && targetSeat <= SEATS && color !== null) {
      myPlayer.fakeDivineHistory.set(night, { target: targetSeat, result: color })
    }
    return { type: 'seer_result', target: targetSeat, result: color as 'human' | 'wolf' }
  }
}
