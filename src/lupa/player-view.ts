/**
 * プレイヤー視点ユーティリティ
 *
 * 役職に応じた秘密知識を構築する。
 * ハンドラーが個別プレイヤーのコンテキストを作る際に使用。
 */

import type { GameState } from './types.ts'
import type { PlayerView } from './handlers.ts'

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

  switch (player.role) {
    case 'werewolf':
      wolfTeammates = state.players
        .filter(p => p.role === 'werewolf' && p.seat !== seat)
        .map(p => p.seat)
      break
    case 'fanatic':
      knownWolves = state.players
        .filter(p => p.role === 'werewolf')
        .map(p => p.seat)
      break
    case 'immoralist': {
      const hamster = state.players.find(p => p.role === 'werehamster')
      knownHamster = hamster?.seat ?? null
      break
    }
    case 'mason': {
      const partner = state.players.find(p => p.role === 'mason' && p.seat !== seat)
      masonPartner = partner?.seat ?? null
      break
    }
  }

  return { wolfTeammates, knownWolves, knownHamster, masonPartner }
}
