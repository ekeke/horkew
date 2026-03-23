import type { LupaConfig, GameState, GameEvent, NightAction, DayClaim } from './types.ts'
import type { SystemRole } from '../types/index.ts'
import { Rng } from './random.ts'
import { RANDOM_NAMES, generateRoleNames } from './names.ts'
import {
  assignRoles, alivePlayers, getSeerResult,
  killPlayer, checkWinCondition,
} from './roles.ts'
import { decideNightAction, decideDayClaim, decideVote, resolveVotes } from './ai.ts'

export type GameResult = {
  events: GameEvent[]
  state: GameState
  config: LupaConfig
}

export function runGame(config: LupaConfig): GameResult {
  const rng = new Rng(config.seed)
  const totalPlayers = Array.from(config.roles.values()).reduce((a, b) => a + b, 0)

  const shuffledIndices = rng.shuffle(Array.from({ length: totalPlayers }, (_, i) => i))

  // 役職配列を構築してシャッフル結果から割り当て順を決定
  const roleArray: SystemRole[] = []
  for (const [role, count] of config.roles) {
    for (let i = 0; i < count; i++) roleArray.push(role)
  }
  const assignedRoles = shuffledIndices.map(i => roleArray[i])

  // 名前生成
  let names: string[]
  if (config.useRandomNames) {
    if (totalPlayers > RANDOM_NAMES.length) {
      throw new Error(`プレイヤー名が足りません (必要: ${totalPlayers}, 利用可能: ${RANDOM_NAMES.length})`)
    }
    names = RANDOM_NAMES.slice(0, totalPlayers)
  } else {
    names = generateRoleNames(assignedRoles)
  }

  const players = assignRoles(config.roles, names, shuffledIndices)
  const state: GameState = {
    players,
    day: 0,
    phase: 'night',
    finished: false,
    result: null,
  }

  const events: GameEvent[] = []

  // Night 0: 全員に夜アクションを問い合わせ
  for (const player of players) {
    const action = decideNightAction(state, player, 0, rng)
    applyNightAction(state, player, 0, action)
  }

  // メインループ
  let lastExecutedSeat: number | null = null
  const MAX_DAYS = 50

  for (let day = 1; day <= MAX_DAYS && !state.finished; day++) {
    state.day = day

    // ==== 夜フェーズ (day 2+) ====
    if (day > 1) {
      state.phase = 'night'
      const night = day - 1

      // 全生存者に夜アクションを問い合わせ
      const actions: Array<{ player: typeof players[0], action: NightAction }> = []
      for (const player of alivePlayers(state)) {
        const action = decideNightAction(state, player, night, rng)
        actions.push({ player, action })
      }

      // アクション適用
      for (const { player, action } of actions) {
        applyNightAction(state, player, night, action)
      }

      // 夜の結果解決
      resolveNight(state, actions, events)

      // 勝利判定
      checkWinCondition(state)
      if (state.finished) {
        events.push({ type: 'game_over', result: state.result! })
        break
      }
    }

    // ==== 昼フェーズ ====
    state.phase = 'day'

    // COフェーズ: 全生存者にCO判断を問い合わせ
    for (const player of alivePlayers(state)) {
      const claim = decideDayClaim(state, player, day, lastExecutedSeat, rng)
      applyClaim(state, player, day, claim, events)
    }

    // 投票フェーズ
    const votes = new Map<number, number>()
    for (const voter of alivePlayers(state)) {
      const target = decideVote(state, voter, rng)
      votes.set(voter.seat, target)
      events.push({ type: 'vote', voter: voter.seat, target })
    }

    const executedSeat = resolveVotes(votes)
    killPlayer(state, executedSeat)
    events.push({ type: 'execution', target: executedSeat })
    lastExecutedSeat = executedSeat

    // 勝利判定
    checkWinCondition(state)
    if (state.finished) {
      events.push({ type: 'game_over', result: state.result! })
      break
    }
  }

  // 役職リビール
  for (const player of state.players) {
    events.push({ type: 'reveal', seat: player.seat, role: player.role })
  }

  return { events, state, config }
}

/** 夜アクションを状態に適用（記録のみ、kill処理はresolveNightで） */
function applyNightAction(
  state: GameState, player: typeof state.players[0], night: number, action: NightAction,
): void {
  switch (action.type) {
    case 'divine': {
      const target = state.players.find(p => p.seat === action.target)!
      const result = getSeerResult(target.role)
      player.divineHistory.set(night, { target: action.target, result })
      break
    }
    case 'guard':
      player.guardHistory.set(night, action.target)
      break
    case 'attack':
    case 'none':
      break
  }
}

/** 夜の結果を解決（呪殺、襲撃、護衛） */
function resolveNight(
  state: GameState,
  actions: Array<{ player: typeof state.players[0], action: NightAction }>,
  events: GameEvent[],
): void {
  // 占い呪殺チェック
  for (const { action } of actions) {
    if (action.type !== 'divine') continue
    const target = state.players.find(p => p.seat === action.target)!
    if (target.role === 'werehamster' && target.alive) {
      killPlayer(state, action.target)
      events.push({ type: 'fox_kill', target: action.target })
    }
  }

  // 護衛先を取得
  let guardTarget: number | null = null
  for (const { action } of actions) {
    if (action.type === 'guard') {
      guardTarget = action.target
      break
    }
  }

  // 襲撃処理
  for (const { action } of actions) {
    if (action.type !== 'attack') continue
    const target = state.players.find(p => p.seat === action.target)!

    if (target.role === 'werehamster') {
      // 妖狐は襲撃されても死なない
    } else if (guardTarget === action.target) {
      // 護衛成功
    } else {
      killPlayer(state, action.target)
      events.push({ type: 'night_kill', target: action.target })
    }
  }

  // 夜の死者がいなければ平和
  if (!hasNightDeaths(events)) {
    events.push({ type: 'peace' })
  }
}

/** COアクションをイベントに変換 */
function applyClaim(
  state: GameState, player: typeof state.players[0], day: number,
  claim: DayClaim, events: GameEvent[],
): void {
  switch (claim.type) {
    case 'seer_co':
      player.claimedRole = 'seer'
      player.claimedDay = day
      events.push({ type: 'seer_claim', actor: player.seat, results: claim.results })
      break
    case 'seer_result':
      events.push({ type: 'seer_result', actor: player.seat, target: claim.target, result: claim.result })
      break
    case 'medium_co':
      player.claimedRole = 'medium'
      player.claimedDay = day
      events.push({ type: 'medium_claim', actor: player.seat })
      break
    case 'medium_result':
      events.push({ type: 'medium_result', actor: player.seat, result: claim.result })
      break
    case 'bodyguard_co':
      player.claimedRole = 'bodyguard'
      player.claimedDay = day
      events.push({ type: 'bodyguard_claim', actor: player.seat, targets: claim.targets })
      break
    case 'none':
      break
  }
}

function hasNightDeaths(events: GameEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'night_kill' || e.type === 'fox_kill') return true
    if (e.type === 'execution' || e.type === 'game_over') return false
  }
  return false
}
