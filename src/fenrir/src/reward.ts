/**
 * 報酬関数
 *
 * 設計原則 (ActionAndReward.md 参照):
 * 1. 勝利条件との整合: 報酬は陣営の勝利条件に直結する行動を強化すべき
 * 2. 帰属の明確さ: 「誰の行動が原因か」が曖昧な報酬は避ける
 * 3. スケール: 中間報酬の累計が終端報酬 (±1.0) を圧倒しないこと
 * 4. 負の中間報酬は慎重に: 探索を過度に制限するリスク
 */

import type { GameState, GameEvent } from '../../lupa/types.ts'

export type RewardConfig = {
  /** 勝利報酬 */
  win: number
  /** 敗北報酬 */
  lose: number
  /** 引き分け報酬 (村側) */
  drawVillage: number
  /** 引き分け報酬 (狼側) */
  drawWolf: number
  /** 引き分け報酬 (狐側) */
  drawHamster: number
  /** 中間報酬: LW(ラストウルフ)生存 (狼陣営、1日あたり) */
  lwSurvival: number
  /** 中間報酬: 妖狐生存 (狐陣営、1日あたり) */
  foxSurvival: number
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  win: 1.0,
  lose: -1.0,
  drawVillage: -0.5,
  drawWolf: -0.5,
  drawHamster: 0.3,
  lwSurvival: 0.05,
  foxSurvival: 0.07,
}

type Alignment = 'village' | 'wolf' | 'hamster'

function getAlignment(role: string): Alignment {
  switch (role) {
    case 'werewolf':
    case 'possessed':
    case 'fanatic':
      return 'wolf'
    case 'werehamster':
    case 'immoralist':
      return 'hamster'
    default:
      return 'village'
  }
}

/** 終端報酬: ゲーム終了時に各プレイヤーに与える */
export function terminalReward(
  playerRole: string, gameResult: string,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): number {
  const alignment = getAlignment(playerRole)

  switch (gameResult) {
    case 'villager_won':
      return alignment === 'village' ? config.win : config.lose
    case 'werewolf_won':
      return alignment === 'wolf' ? config.win : config.lose
    case 'werehamster_won':
      return alignment === 'hamster' ? config.win : config.lose
    case 'draw':
      switch (alignment) {
        case 'village': return config.drawVillage
        case 'wolf': return config.drawWolf
        case 'hamster': return config.drawHamster
      }
    default:
      return 0
  }
}

/**
 * 中間報酬: イベントごとに呼ばれ、該当イベント時に報酬を付与
 *
 * トリガー: execution イベント (各日1回発生)
 * - LW生存: 狼が1匹でも生きていれば狼陣営に +lwSurvival
 * - 狐生存: 妖狐が生きていれば狐陣営に +foxSurvival
 *
 * returns: Map<seat, reward>
 */
export function intermediateReward(
  event: GameEvent,
  state: GameState,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): Map<number, number> {
  const rewards = new Map<number, number>()

  // execution を日ごとのトリガーとして使用
  if (event.type !== 'execution') return rewards

  // LW生存: 狼が1匹でも生きていれば狼陣営にボーナス
  const hasAliveWolf = state.players.some(p => p.alive && p.role === 'werewolf')
  if (hasAliveWolf) {
    for (const p of state.players) {
      if (p.alive && getAlignment(p.role) === 'wolf') {
        rewards.set(p.seat, (rewards.get(p.seat) ?? 0) + config.lwSurvival)
      }
    }
  }

  // 妖狐生存: 妖狐が生きていれば狐陣営にボーナス
  const hasAliveFox = state.players.some(p => p.alive && p.role === 'werehamster')
  if (hasAliveFox) {
    for (const p of state.players) {
      if (p.alive && getAlignment(p.role) === 'hamster') {
        rewards.set(p.seat, (rewards.get(p.seat) ?? 0) + config.foxSurvival)
      }
    }
  }

  return rewards
}
