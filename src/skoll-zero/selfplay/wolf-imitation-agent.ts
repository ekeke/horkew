/**
 * WolfImitationRoleAgent — Wolf Imitation 用の Role Agent (B 案)。
 *
 * SkollZeroRoleAgent を継承し、内部に WolfImitationModule を持つ。WolfRoleAgent と同様に
 * decideNightAction (襲撃) は execute MCTS を使うが、加えて decideDayClaim を override して
 * **偽 seer 騙り中の翌朝結果報告** を proposeMorning (NN-MCTS) 経由で生成する。
 *
 * ## B 案 (現状) vs A 案 (将来)
 *
 * - **B 案**: claim 種別 (どの役職を騙るか、未 CO 1 日目の判断) は heuristic 維持
 *   (`RuleBasedAgent.decideWerewolfClaim` 経由)、偽 seer 中の朝結果のみ NN-MCTS 化。
 *   morning record だけが学習対象、wolf NN の `claim_fake_dev` / `alpha_claim` head は
 *   random init のまま使われない。
 * - **A 案** (Future Work): claim 種別も 4 phase MCTS (`proposeFakeCO`) で決める。
 *   `claim_fake_dev` / `alpha_claim` head も学習対象になる。memory `project_skoll_zero_wolf_imitation`
 *   参照。
 *
 * ## fakeDivineHistory の整合性
 *
 * 既存 `reportFakeSeerResult` は `generateStrategicFakeResult` で fakeDivineHistory に
 * 登録してから DayClaim を返す。本 override も同等に MCTS の結果 (target × color) を
 * fakeDivineHistory に登録する。これを忘れると後続日の retar 整合性チェックや観測 encoding
 * (state.fakeDivineHistory 参照) で乖離が生じる。
 */

import type { DecisionContext } from '../../fenrir/src/agents/agent.ts'
import type { DayClaim, NightAction } from '../../lupa/types.ts'
import type { EnumSpecies } from '../../types/index.ts'
import { SkollZeroRoleAgent, type SkollZeroRoleAgentOptions } from './role-zero-agent.ts'
import { argmaxFromVisits, sampleFromVisits, temperatureForAlive } from './policy-utils.ts'
import { WolfImitationModule } from '../module/wolf-imitation-module.ts'
import { WolfImitationNetwork } from '../network/wolf-imitation-network.ts'

const SEATS = 14

/** WolfImitationRoleAgent 専用の constructor opts。nn は WolfImitationNetwork に narrow。 */
export type WolfImitationRoleAgentOptions =
  Omit<SkollZeroRoleAgentOptions, 'nn'> & { nn: WolfImitationNetwork }

export class WolfImitationRoleAgent extends SkollZeroRoleAgent {
  constructor(opts: WolfImitationRoleAgentOptions) {
    const module = new WolfImitationModule({
      nn: opts.nn,
      setup: opts.setup,
      buffer: opts.buffer,
      mctsConfig: opts.mctsConfig,
      determinizerMaxWorlds: opts.determinizerMaxWorlds,
    })
    super(module, opts.selectionMode ?? 'sample')
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
   * 偽 seer 騙り中の翌朝結果報告のみ NN-MCTS で生成 (B 案)。
   *
   * - 偽 seer CO 中 (myPlayer.claimedRole === 'seer' && myRole が wolf 系):
   *   proposeMorning で 28-action 空間を MCTS、(target × color) を action として返す。
   *   fakeDivineHistory に登録した上で `{ type: 'seer_result' }` を返す。
   * - それ以外 (未 CO / 偽 medium 中 / 偽 mason 中 / 偽 bg 中 等):
   *   super (RuleBasedAgent.decideWerewolfClaim) に委譲。
   */
  override decideDayClaim(ctx: DecisionContext): DayClaim {
    const myPlayer = ctx.myPlayer
    const isFakeSeerActive = myPlayer?.claimedRole === 'seer'
      && (ctx.myRole === 'werewolf' || ctx.myRole === 'fanatic')
    if (!isFakeSeerActive) return super.decideDayClaim(ctx)

    const r = this.module.proposeMorning(ctx, this.proposeOpts())
    if (!r) return super.decideDayClaim(ctx)

    const action = this.selectionMode === 'argmax' || this.selectionMode === 'policy_argmax'
      ? argmaxFromVisits(r.visits)
      : sampleFromVisits(
          r.visits,
          () => ctx.rng.next(),
          temperatureForAlive(ctx.alivePlayers.length),
        )
    // action = target_idx × 2 + color (0=human, 1=wolf)
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
