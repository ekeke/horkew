/**
 * プレイヤー視点ユーティリティ
 *
 * 役職の trait に応じた秘密知識を構築する。
 * ハンドラーが個別プレイヤーのコンテキストを作る際に使用。
 */

import type { GameState } from './types.ts'
import type { PlayerView } from './handlers.ts'
import { hasTrait, isHamster } from './role-traits.ts'

/**
 * 指定席のプレイヤーが持つ秘密知識を構築する
 * エンジンのbuildContextから抽出した秘密知識注入ロジック
 */
export function buildPlayerView(state: GameState, seat: number): PlayerView {
  const player = state.players.find(p => p.seat === seat)
  if (!player) return { wolfTeammates: null, knownWolves: null, knownHamster: null, masonPartner: null }

  let wolfTeammates: number[] | null = null
  let knownWolves: number[] | null = null
  let knownHamster: number | null = null
  let masonPartner: number | null = null

  if (hasTrait(player.role, 'knowledge', 'know-werewolves')) {
    // 人狼 (襲撃能力持ち) を全て知っている
    const wolves = state.players.filter(p => hasTrait(p.role, 'action', 'attack'))
    if (hasTrait(player.role, 'action', 'attack')) {
      // 自身も狼: 自分を除いて wolfTeammates
      wolfTeammates = wolves.filter(p => p.seat !== seat).map(p => p.seat)
    } else {
      // 自身は狼ではない (狂信者等): knownWolves
      knownWolves = wolves.map(p => p.seat)
    }
  }

  if (hasTrait(player.role, 'knowledge', 'know-foxes')) {
    const hamster = state.players.find(p => isHamster(p.role))
    knownHamster = hamster?.seat ?? null
  }

  if (hasTrait(player.role, 'knowledge', 'know-masons')) {
    const partner = state.players.find(p => p.seat !== seat && hasTrait(p.role, 'knowledge', 'know-masons'))
    masonPartner = partner?.seat ?? null
  }

  return { wolfTeammates, knownWolves, knownHamster, masonPartner }
}
