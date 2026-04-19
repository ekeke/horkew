/**
 * MCTS root で一度だけキャプチャする観測（mason_collective エンコード済み 1030-dim Float32Array）。
 *
 * skoll-supervised 済み trunk と shape を揃えるため `encodeCollectiveMasonObservation`
 * をそのまま使う。
 *
 * buffer に蓄積する record の obs 型もここで定義。M5 の学習ループが z を後貼りして
 * TrainingRecord になる流れは buffer.ts 参照。
 */

import type { DecisionContext, TeamDecisionContext } from '../../fenrir/src/agents/agent.ts'
import { encodeCollectiveMasonObservation } from '../../fenrir/src/observation.ts'

/** NN forward への入力（1030-dim mason_collective 観測） */
export type RootObs = Float32Array

/**
 * Individual DecisionContext + masonPartner から TeamDecisionContext を構築し、
 * mason_collective 観測を返す。
 *
 * - teamSeats: 自席 + masonPartner（partner が null なら自席のみ）
 * - teamPlayers: gameState.players から seat で lookup
 * - currentActorSeat: 観測では未使用（集団オーバーライドに影響しない）
 */
export function captureObs(ctx: DecisionContext): RootObs {
  const teamSeats: number[] = [ctx.mySeat]
  if (ctx.masonPartner !== null) teamSeats.push(ctx.masonPartner)

  const teamPlayers = teamSeats.map(seat => {
    const p = ctx.gameState.players.find(pl => pl.seat === seat)
    if (!p) throw new Error(`captureObs: player not found for seat ${seat}`)
    return p
  })

  const teamCtx: TeamDecisionContext = {
    ...ctx,
    teamSeats,
    teamPlayers,
  }

  return encodeCollectiveMasonObservation(teamCtx)
}
