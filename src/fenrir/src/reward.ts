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
import { SEATS, NUM_ROLES } from './observation.ts'

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
  /** 中間報酬: Hati 詰み (村陣営、詰み後の1日あたり) */
  tsumiVillagePerDay: number
  /** 中間報酬: Hati 被詰み (狼陣営、詰み後の1日あたり) */
  tsumiWolfPerDay: number
  /** 推理中間報酬: 村陣営のみ、正解席数/14 × この値 */
  predictAccuracyReward: number
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  win: 1.0,
  lose: -1.0,
  drawVillage: -0.5,
  drawWolf: -0.5,
  drawHamster: 0.3,
  lwSurvival: 0.05,
  foxSurvival: 0.07,
  tsumiVillagePerDay: 0.1,
  tsumiWolfPerDay: -0.2,
  predictAccuracyReward: 0.02,
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

/**
 * 詰み報酬: ゲーム終了後に遡って付与
 * 詰み開始日からゲーム終了日までの日数 × 1日あたりの報酬
 * 村陣営に +tsumiVillagePerDay/日、狼陣営に +tsumiWolfPerDay/日 (負値)
 * returns: Map<seat, reward>
 */
export function tsumiReward(
  state: GameState,
  tsumiDays: number,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): Map<number, number> {
  const rewards = new Map<number, number>()
  if (tsumiDays <= 0) return rewards
  for (const p of state.players) {
    const alignment = getAlignment(p.role)
    if (alignment === 'village') {
      rewards.set(p.seat, config.tsumiVillagePerDay * tsumiDays)
    } else if (alignment === 'wolf') {
      rewards.set(p.seat, config.tsumiWolfPerDay * tsumiDays)
    }
  }
  return rewards
}

/**
 * 推理精度報酬: predict headの出力と実際の役職を比較
 * 村陣営のみ、正解席数/14 × predictAccuracyReward
 *
 * @param predictActions sigmoid出力 (154次元, 0/1)
 * @param trueRoles 実際の役職 one-hot (154次元)
 * @param playerRole プレイヤーの役職
 * @returns 報酬 (村陣営以外は0)
 */
export function predictAccuracyReward(
  predictActions: Float32Array,
  trueRoles: Float32Array,
  playerRole: string,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): number {
  if (getAlignment(playerRole) !== 'village') return 0

  let correct = 0
  for (let seat = 0; seat < SEATS; seat++) {
    // 各席でargmaxの役職が一致しているか
    let predMax = 0, predIdx = 0
    let trueIdx = 0
    for (let r = 0; r < NUM_ROLES; r++) {
      const idx = seat * NUM_ROLES + r
      if (predictActions[idx] > predMax) {
        predMax = predictActions[idx]
        predIdx = r
      }
      if (trueRoles[idx] > 0) trueIdx = r
    }
    if (predIdx === trueIdx) correct++
  }

  return (correct / SEATS) * config.predictAccuracyReward
}
