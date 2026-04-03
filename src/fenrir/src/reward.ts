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
import type { SystemRole } from '../../types/index.ts'
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
  /** 推理中間報酬: 未知席の正解1席あたり */
  predictAccuracyReward: number
  /** 既知席の推理報酬の減衰率 (既知席の正解 = predictAccuracyReward × この値) */
  predictKnownSeatDiscount: number
  /** 中間報酬: 護衛成功 (bodyguard, peace時) */
  guardSuccess: number
  /** 中間報酬: 占い呪殺 (seer, fox_kill時) */
  foxKillReward: number
  /** 中間報酬: 最終日前日に狐候補を処刑 (村陣営) */
  endgamePreFinalFoxTarget: number
  /** 中間報酬: 最終日前日にLW候補を処刑 (村陣営、負値) */
  endgamePreFinalLWTarget: number
  /** 中間報酬: 最終日に狐候補を処刑 (村陣営、負値) */
  endgameFinalFoxTarget: number
  /** 中間報酬: 最終日に狼候補(狐なし)を処刑 (村陣営) */
  endgameFinalWolfTarget: number
  /** 中間報酬: 最終日に確定狼を処刑 (村陣営) */
  endgameFinalConfirmedWolf: number
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
  predictKnownSeatDiscount: 0.25,
  guardSuccess: 0,     // TODO: Lupa改修後に正確なイベント判定で有効化
  foxKillReward: 0,    // TODO: 同上
  endgamePreFinalFoxTarget: 0.08,
  endgamePreFinalLWTarget: -0.06,
  endgameFinalFoxTarget: -0.12,
  endgameFinalWolfTarget: 0.08,
  endgameFinalConfirmedWolf: 0.15,
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

  if (event.type === 'execution') {
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
  }

  // TODO: 護衛成功・占い呪殺の中間報酬は、Lupa改修後に正確なイベント判定で追加
  // 現状のpeace/fox_killイベントでは帰属が不正確（狐噛み平和、初日占い呪殺を区別できない）

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
 * 全陣営対象。既知席（自席・仲間等）は低い報酬、未知席は高い報酬。
 *
 * @param predictActions sigmoid出力 (154次元, 0/1)
 * @param trueRoles 実際の役職 one-hot (154次元)
 * @param playerRole プレイヤーの役職
 * @param config 報酬設定
 * @param knownSeats 既知の席（自席、狼仲間、共有相方等）。0-indexed seat番号
 * @returns 報酬
 */
export function predictAccuracyReward(
  predictActions: Float32Array,
  trueRoles: Float32Array,
  _playerRole: string,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
  knownSeats?: Set<number>,
): number {
  let reward = 0
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
    if (predIdx === trueIdx) {
      const isKnown = knownSeats?.has(seat) ?? false
      reward += isKnown
        ? config.predictAccuracyReward * config.predictKnownSeatDiscount
        : config.predictAccuracyReward
    }
  }

  return reward / SEATS
}

/** プレイヤーが初期知識として知っている席のセットを構築 (0-indexed seat番号) */
export function buildKnownSeats(seat: number, role: string, state: GameState): Set<number> {
  const known = new Set<number>()
  known.add(seat)  // 自席
  if (role === 'werewolf') {
    for (const p of state.players) if (p.role === 'werewolf' && p.seat !== seat) known.add(p.seat)
  } else if (role === 'fanatic') {
    for (const p of state.players) if (p.role === 'werewolf') known.add(p.seat)
  } else if (role === 'mason') {
    for (const p of state.players) if (p.role === 'mason' && p.seat !== seat) known.add(p.seat)
  } else if (role === 'immoralist') {
    for (const p of state.players) if (p.role === 'werehamster') known.add(p.seat)
  }
  return known
}

/**
 * エンドゲーム投票報酬: 投票先の Retar 可能性集合に基づく中間報酬
 *
 * - 最終日前日 (4 < alive <= 6): 狐候補処刑 → +, LW候補処刑 → -
 * - 最終日 (alive <= 4): 狐候補処刑 → --, 狼候補(狐なし)処刑 → +, 確定狼 → ++
 */
export function endgameVoteReward(
  aliveCount: number,
  targetPossibilities: Set<SystemRole> | undefined,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): number {
  if (!targetPossibilities || aliveCount > 6) return 0

  const hasWolf = targetPossibilities.has('werewolf')
  const hasFox = targetPossibilities.has('werehamster')

  if (aliveCount <= 4) {
    // 最終日
    if (targetPossibilities.size === 1 && hasWolf) return config.endgameFinalConfirmedWolf
    if (hasFox) return config.endgameFinalFoxTarget
    if (hasWolf) return config.endgameFinalWolfTarget
    return 0
  }

  // 最終日前日 (4 < alive <= 6)
  if (hasFox) return config.endgamePreFinalFoxTarget
  if (targetPossibilities.size === 1 && hasWolf) return config.endgamePreFinalLWTarget
  return 0
}
