/**
 * 報酬関数
 */

import type { GameState, GameEvent } from '../../lupa/types.ts'

export type RewardConfig = {
  /** 勝利報酬 */
  win: number
  /** 敗北報酬 */
  lose: number
  /** 中間報酬: 狼処刑成功 (村側) */
  wolfExecuted: number
  /** 中間報酬: 村人誤処刑 (狼側) */
  villagerExecuted: number
  /** 中間報酬: 占い師が狼を発見 */
  seerDivineWolf: number
  /** 中間報酬: 護衛成功 */
  bodyguardSave: number
  /** 中間報酬: 指揮者の指示で狼処刑 */
  commanderSuccess: number
  /** 中間報酬: 妖狐生存日数 */
  foxSurvived: number
  /** 引き分け報酬 (村側) */
  drawVillage: number
  /** 引き分け報酬 (狼側) */
  drawWolf: number
  /** 引き分け報酬 (狐側) */
  drawHamster: number
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  win: 1.0,
  lose: -1.0,
  wolfExecuted: 0.05,
  villagerExecuted: 0.02,
  seerDivineWolf: 0.03,
  bodyguardSave: 0.03,
  commanderSuccess: 0.05,
  foxSurvived: 0.01,
  drawVillage: -0.5,
  drawWolf: -0.5,
  drawHamster: 0.3,
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
 * 中間報酬: イベントごとに各プレイヤーに与える小さな報酬
 * returns: Map<seat, reward>
 */
export function intermediateReward(
  event: GameEvent,
  state: GameState,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): Map<number, number> {
  const rewards = new Map<number, number>()

  switch (event.type) {
    case 'execution': {
      const executed = state.players.find(p => p.seat === event.target)
      if (!executed) break

      if (executed.role === 'werewolf') {
        // 狼が処刑された → 村側にボーナス
        for (const p of state.players) {
          if (p.alive && getAlignment(p.role) === 'village') {
            rewards.set(p.seat, (rewards.get(p.seat) ?? 0) + config.wolfExecuted)
          }
        }
      } else if (getAlignment(executed.role) === 'village') {
        // 村人が処刑された → 狼側にボーナス
        for (const p of state.players) {
          if (p.alive && getAlignment(p.role) === 'wolf') {
            rewards.set(p.seat, (rewards.get(p.seat) ?? 0) + config.villagerExecuted)
          }
        }
      }
      break
    }

    case 'peace': {
      // 平和 = 護衛成功の可能性 → 狩人にボーナス
      for (const p of state.players) {
        if (p.alive && p.role === 'bodyguard') {
          rewards.set(p.seat, (rewards.get(p.seat) ?? 0) + config.bodyguardSave)
        }
      }
      break
    }
  }

  // 妖狐生存ボーナス（毎日）
  for (const p of state.players) {
    if (p.alive && p.role === 'werehamster') {
      rewards.set(p.seat, (rewards.get(p.seat) ?? 0) + config.foxSurvived)
    }
  }

  return rewards
}
