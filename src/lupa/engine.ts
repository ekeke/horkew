import type { LupaConfig, GameState, GameEvent, NightAction, DayClaim } from './types.ts'
import type { SystemRole } from '../types/index.ts'
import { Rng } from './random.ts'
import { RANDOM_NAMES, generateRoleNames } from './names.ts'
import {
  assignRoles, alivePlayers, getSeerResult,
  killPlayer, checkWinCondition,
} from './roles.ts'
import { decideNightAction, decideDayClaim, forceTrueRoleCO, decideVote, resolveVotes } from './ai.ts'

export type GameResult = {
  events: GameEvent[]
  state: GameState
  config: LupaConfig
}

export function runGame(config: LupaConfig): GameResult {
  const rng = new Rng(config.seed)
  const totalPlayers = Array.from(config.roles.values()).reduce((a, b) => a + b, 0)

  const shuffledIndices = rng.shuffle(Array.from({ length: totalPlayers }, (_, i) => i))

  const roleArray: SystemRole[] = []
  for (const [role, count] of config.roles) {
    for (let i = 0; i < count; i++) roleArray.push(role)
  }
  const assignedRoles = shuffledIndices.map(i => roleArray[i])

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

      const actions: Array<{ player: typeof players[0], action: NightAction }> = []
      for (const player of alivePlayers(state)) {
        const action = decideNightAction(state, player, night, rng)
        actions.push({ player, action })
      }

      for (const { player, action } of actions) {
        applyNightAction(state, player, night, action)
      }

      resolveNight(state, actions, events, rng)

      checkWinCondition(state)
      if (state.finished) {
        events.push({ type: 'game_over', result: state.result! })
        break
      }
    }

    // ==== 昼フェーズ ====
    state.phase = 'day'

    // COフェーズ
    for (const player of alivePlayers(state)) {
      const claim = decideDayClaim(state, player, day, lastExecutedSeat, rng)
      applyClaim(state, player, day, claim, events)
    }

    // 対抗が出た真役職の強制CO（2パス目）
    for (const player of alivePlayers(state)) {
      if (player.claimedRole !== null) continue
      const hasClaimer = alivePlayers(state).some(p =>
        p.seat !== player.seat && p.claimedRole === player.role
      )
      if (!hasClaimer) continue
      const forced = forceTrueRoleCO(state, player, day, lastExecutedSeat)
      applyClaim(state, player, day, forced, events)
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

    // 霊能結果コメント
    const executedPlayer = state.players.find(p => p.seat === executedSeat)!
    const medResult = getSeerResult(executedPlayer.role)
    events.push({ type: 'comment', text: `霊能: ${executedPlayer.name} = ${medResult === 'human' ? '○' : '●'}` })

    // 処刑後: 猫又道連れ
    if (executedPlayer.role === 'nekomata') {
      const curseCandidates = alivePlayers(state)
      if (curseCandidates.length > 0) {
        const curseTarget = rng.pick(curseCandidates)
        killPlayer(state, curseTarget.seat)
        events.push({ type: 'curse_kill', target: curseTarget.seat })
      }
    }

    // 処刑後: 背徳者後追いチェック (妖狐が処刑された場合)
    if (executedPlayer.role === 'werehamster') {
      checkImmoralistFollow(state, events)
    }

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

/** 夜アクションを状態に適用（記録のみ） */
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

/** 夜の結果を解決 */
function resolveNight(
  state: GameState,
  actions: Array<{ player: typeof state.players[0], action: NightAction }>,
  events: GameEvent[],
  _rng: Rng,
): void {
  const name = (seat: number) => state.players.find(p => p.seat === seat)!.name
  const speciesLabel = (r: 'human' | 'wolf' | null) => r === 'human' ? '○' : r === 'wolf' ? '●' : '?'

  // 夜行動コメント
  for (const { player, action } of actions) {
    switch (action.type) {
      case 'divine': {
        const result = player.divineHistory.get(state.day - 1)
        const resultStr = result ? speciesLabel(result.result) : ''
        events.push({ type: 'comment', text: `占い: ${name(player.seat)} → ${name(action.target)} ${resultStr}` })
        break
      }
      case 'guard':
        events.push({ type: 'comment', text: `護衛: ${name(player.seat)} → ${name(action.target)}` })
        break
      case 'attack':
        events.push({ type: 'comment', text: `襲撃: ${name(player.seat)} → ${name(action.target)}` })
        break
    }
  }

  // 占い呪殺チェック
  const foxKilled = new Set<number>()
  for (const { action } of actions) {
    if (action.type !== 'divine') continue
    const target = state.players.find(p => p.seat === action.target)!
    if (target.role === 'werehamster' && target.alive) {
      killPlayer(state, action.target)
      foxKilled.add(action.target)
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
  for (const { player: attacker, action } of actions) {
    if (action.type !== 'attack') continue
    const target = state.players.find(p => p.seat === action.target)!

    if (target.role === 'werehamster') {
      // 妖狐は襲撃されても死なない
    } else if (guardTarget === action.target) {
      // 護衛成功
    } else if (target.role === 'nekomata') {
      // 猫又襲撃: 猫又は死亡、襲撃した人狼を道連れ
      killPlayer(state, action.target)
      events.push({ type: 'night_kill', target: action.target })
      // 襲撃元の人狼 (最小seat狼) を道連れ
      const attackingWolf = alivePlayers(state).find(p => p.role === 'werewolf')
        ?? attacker // フォールバック
      killPlayer(state, attackingWolf.seat)
      events.push({ type: 'curse_kill', target: attackingWolf.seat })
    } else {
      killPlayer(state, action.target)
      events.push({ type: 'night_kill', target: action.target })
    }
  }

  // 妖狐死亡による背徳者後追い
  if (foxKilled.size > 0) {
    checkImmoralistFollow(state, events)
  }

  // 夜の死者がいなければ平和
  if (!hasNightDeaths(events)) {
    events.push({ type: 'peace' })
  }
}

/** 妖狐死亡時の背徳者後追いチェック */
function checkImmoralistFollow(state: GameState, events: GameEvent[]): void {
  // 生存妖狐がいるかチェック
  const aliveHamsters = state.players.filter(p => p.role === 'werehamster' && p.alive)
  if (aliveHamsters.length > 0) return

  // 全妖狐が死亡 → 生存背徳者を後追い
  const aliveImmoralists = state.players.filter(p => p.role === 'immoralist' && p.alive)
  for (const imm of aliveImmoralists) {
    killPlayer(state, imm.seat)
    events.push({ type: 'follow_kill', target: imm.seat })
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
    case 'mason_co':
      player.claimedRole = 'mason'
      player.claimedDay = day
      events.push({ type: 'mason_claim', actor: player.seat, partner: claim.partner })
      break
    case 'nekomata_co':
      player.claimedRole = 'nekomata'
      player.claimedDay = day
      events.push({ type: 'nekomata_claim', actor: player.seat })
      break
    case 'none':
      break
  }
}

function hasNightDeaths(events: GameEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'night_kill' || e.type === 'fox_kill' || e.type === 'curse_kill' || e.type === 'follow_kill') return true
    if (e.type === 'execution' || e.type === 'game_over') return false
  }
  return false
}
