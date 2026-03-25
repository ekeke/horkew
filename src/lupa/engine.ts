import type { LupaConfig, GameState, GameEvent, NightAction, DayClaim } from './types.ts'
import type { SystemRole } from '../types/index.ts'
import type { Strategy, DecisionContext, TeamStrategy, TeamDecisionContext, WolfNightAction } from './strategy.ts'
import type { SignalRecord, CommunicationAction } from './communication.ts'
import type { Proposal } from './leadership.ts'
import { Rng } from './random.ts'
import { RANDOM_NAMES, generateRoleNames } from './names.ts'
import {
  assignRoles, alivePlayers, getSeerResult,
  killPlayer, checkWinCondition,
} from './roles.ts'
import { HeuristicStrategy, forceTrueRoleCO, resolveVotes } from './heuristic.ts'
import { detectCommander } from './leadership.ts'
import { analyzeFromEvents as retarAnalyze } from './retar-bridge.ts'

export type GameResult = {
  events: GameEvent[]
  state: GameState
  config: LupaConfig
}

const defaultStrategy = new HeuristicStrategy()

function getStrategy(config: LupaConfig, seat: number): Strategy {
  return config.strategies?.get(seat) ?? defaultStrategy
}

/** チーム戦略を使うべきか判定し、TeamDecisionContext を構築 */
function getTeamStrategy(
  config: LupaConfig, state: GameState, player: typeof state.players[0],
): TeamStrategy | null {
  if (player.role === 'werewolf' && config.wolfTeamStrategy) {
    return config.wolfTeamStrategy
  }
  if (player.role === 'mason' && config.masonTeamStrategy) {
    return config.masonTeamStrategy
  }
  return null
}

function buildTeamContext(
  baseCtx: DecisionContext, state: GameState, role: SystemRole,
  currentActorSeat?: number,
): TeamDecisionContext {
  const teamPlayers = state.players.filter(p => p.role === role && p.alive)
  return {
    ...baseCtx,
    teamSeats: teamPlayers.map(p => p.seat),
    teamPlayers,
    currentActorSeat,
  }
}

/** 昼行動のチーム/個人ルーティングヘルパー */
type DayDecisionFn<T> = (strategy: Strategy, ctx: DecisionContext) => T
type TeamDayDecisionFn<T> = (strategy: TeamStrategy, ctx: TeamDecisionContext) => T

function decideForPlayer<T>(
  config: LupaConfig, state: GameState, player: typeof state.players[0],
  baseCtx: DecisionContext,
  individualFn: DayDecisionFn<T>,
  teamFn: TeamDayDecisionFn<T>,
): T {
  const team = getTeamStrategy(config, state, player)
  if (team) {
    const teamCtx = buildTeamContext(baseCtx, state, player.role, player.seat)
    return teamFn(team, teamCtx)
  }
  const strategy = getStrategy(config, player.seat)
  return individualFn(strategy, baseCtx)
}

function buildContext(
  state: GameState, player: typeof state.players[0],
  events: GameEvent[], rng: Rng,
  signals: SignalRecord[], proposals: Proposal[],
  lastExecutedSeat: number | null,
  retarPossibilities: Map<number, Set<SystemRole>> | null = null,
  revoteRound: number | null = null,
  revoteCandidates: number[] | null = null,
): DecisionContext {
  // 初期知識の注入
  let wolfTeammates: number[] | null = null
  let knownWolves: number[] | null = null
  let knownHamster: number | null = null
  let masonPartner: number | null = null

  if (player.role === 'werewolf') {
    wolfTeammates = state.players
      .filter(p => p.role === 'werewolf' && p.seat !== player.seat)
      .map(p => p.seat)
  } else if (player.role === 'fanatic') {
    knownWolves = state.players
      .filter(p => p.role === 'werewolf')
      .map(p => p.seat)
  } else if (player.role === 'immoralist') {
    const hamster = state.players.find(p => p.role === 'werehamster')
    knownHamster = hamster?.seat ?? null
  } else if (player.role === 'mason') {
    const partner = state.players.find(p => p.role === 'mason' && p.seat !== player.seat)
    masonPartner = partner?.seat ?? null
  }

  return {
    mySeat: player.seat,
    myRole: player.role,
    myPlayer: player,
    day: state.day,
    phase: state.phase,
    alivePlayers: alivePlayers(state).map(p => p.seat),
    publicEvents: events,
    signals,
    commander: state.commander,
    proposals,
    rng,
    gameState: state,
    lastExecutedSeat,
    retarPossibilities,
    wolfTeammates,
    knownWolves,
    knownHamster,
    masonPartner,
    revoteRound,
    revoteCandidates,
  }
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
    executionHistory: new Map(),
    commander: null,
    masonPartners: new Map(),
  }

  const events: GameEvent[] = []
  const signals: SignalRecord[] = []
  const proposals: Proposal[] = []

  // Night 0: 全員に夜アクションを問い合わせ
  for (const player of players) {
    const strategy = getStrategy(config, player.seat)
    const ctx = buildContext(state, player, events, rng, signals, proposals, null)
    const action = strategy.decideNightAction(ctx)
    applyNightAction(state, player, 0, action)
  }

  // Night 0: 占い呪殺チェック（初日占いで狐を占った場合）
  for (const player of players) {
    const divine = player.divineHistory.get(0)
    if (!divine) continue
    const target = players.find(p => p.seat === divine.target)!
    if (target.role === 'werehamster' && target.alive) {
      killPlayer(state, target.seat)
      events.push({ type: 'fox_kill', target: target.seat })
      checkImmoralistFollow(state, events)
    }
  }

  // 初日犠牲者（人狼・猫又・妖狐以外からランダムに選出）
  if (config.hasFirstGhost) {
    const immuneRoles: SystemRole[] = ['werewolf', 'nekomata', 'werehamster']
    const candidates = alivePlayers(state).filter(p => !immuneRoles.includes(p.role))
    if (candidates.length > 0) {
      const victim = rng.pick(candidates)
      killPlayer(state, victim.seat)
      events.push({ type: 'night_kill', target: victim.seat })
      checkImmoralistFollow(state, events)
    }
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
      let chosenAttacker: number | null = null  // 狼チームが選んだ襲撃者

      // 狼チーム夜行動
      if (config.wolfTeamStrategy) {
        const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
        if (aliveWolves.length > 0) {
          const leader = aliveWolves[0]
          const ctx = buildContext(state, leader, events, rng, signals, proposals, lastExecutedSeat)
          const teamCtx = buildTeamContext(ctx, state, 'werewolf')
          const wolfAction = config.wolfTeamStrategy.decideNightAction(teamCtx) as WolfNightAction
          chosenAttacker = wolfAction.attacker
          // 襲撃者が attack、他の狼は none
          for (const wolf of aliveWolves) {
            if (wolf.seat === wolfAction.attacker) {
              actions.push({ player: wolf, action: { type: 'attack', target: wolfAction.target } })
            } else {
              actions.push({ player: wolf, action: { type: 'none' } })
            }
          }
        }
      }

      // 個別プレイヤー夜行動（狼チーム以外）
      for (const player of alivePlayers(state)) {
        if (config.wolfTeamStrategy && player.role === 'werewolf') continue  // 既に処理済み
        const strategy = getStrategy(config, player.seat)
        const ctx = buildContext(state, player, events, rng, signals, proposals, lastExecutedSeat)
        const action = strategy.decideNightAction(ctx)
        actions.push({ player, action })
      }

      for (const { player, action } of actions) {
        applyNightAction(state, player, night, action)
        player.forecastTarget = null
      }

      resolveNight(state, actions, events, rng, chosenAttacker)

      checkWinCondition(state)
      if (state.finished) {
        events.push({ type: 'game_over', result: state.result! })
        break
      }
    }

    // ==== 昼フェーズ ====
    state.phase = 'day'

    // ==== CO前Retar分析 ====
    let preCoRetar: Map<number, Set<SystemRole>> | null = null
    if (config.enableRetar) {
      preCoRetar = retarAnalyze(events, state, config)
    }

    // COフェーズ
    for (const player of alivePlayers(state)) {
      const ctx = buildContext(state, player, events, rng, signals, proposals, lastExecutedSeat, preCoRetar)
      const claim = decideForPlayer(config, state, player, ctx,
        (s, c) => s.decideDayClaim(c),
        (s, c) => s.decideDayClaim(c),
      )
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

    // ==== CO後Retar分析（シグナル/投票用） ====
    let retarPossibilities: Map<number, Set<SystemRole>> | null = null
    if (config.enableRetar) {
      retarPossibilities = retarAnalyze(events, state, config)
    }

    // ==== シグナルフェーズ ====
    // 指揮者判定
    state.commander = detectCommander(state)
    if (state.commander !== null) {
      events.push({ type: 'commander_appointed', seat: state.commander })
    }

    // 当日シグナルをリセット
    const daySignals: SignalRecord[] = []
    let signalIdCounter = signals.length

    // 指揮者提案
    const dayProposals: Proposal[] = []
    if (state.commander !== null) {
      const commander = state.players.find(p => p.seat === state.commander)!
      if (commander.alive) {
        const ctx = buildContext(state, commander, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities)
        const proposal = decideForPlayer(config, state, commander, ctx,
          (s, c) => s.decideProposal(c),
          (s, c) => s.decideProposal(c),
        )
        if (proposal) {
          dayProposals.push(proposal)
          events.push({ type: 'proposal', actor: commander.seat, proposal })

          // 他プレイヤーの応答
          for (const player of alivePlayers(state)) {
            if (player.seat === state.commander) continue
            const pCtx = buildContext(state, player, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities)
            const response = decideForPlayer(config, state, player, pCtx,
              (s, c) => s.decideLeadershipResponse(c, proposal),
              (s, c) => s.decideLeadershipResponse(c, proposal),
            )
            events.push({ type: 'leadership_response', actor: player.seat, response })
          }
        }
      }
    }

    // シグナルラウンド (3ラウンド)
    for (let round = 0; round < 3; round++) {
      for (const player of alivePlayers(state)) {
        const ctx = buildContext(state, player, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities)
        const commAction = decideForPlayer(config, state, player, ctx,
          (s, c) => s.decideCommunication(c),
          (s, c) => s.decideCommunication(c),
        )
        applyCommAction(state, player, day, commAction, events, daySignals, signals, signalIdCounter)
        signalIdCounter += 1
      }
    }

    // 予告フェーズ
    for (const player of alivePlayers(state)) {
      const ctx = buildContext(state, player, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities)
      const forecast = decideForPlayer(config, state, player, ctx,
        (s, c) => s.decideForecast(c),
        (s, c) => s.decideForecast(c),
      )
      if (forecast.type === 'forecast') {
        player.forecastTarget = forecast.target
        events.push({ type: 'forecast', actor: player.seat, target: forecast.target })
      }
    }

    // グレラン/指定の決定
    const isGrelan = rng.next() < 0.3
    if (isGrelan) {
      events.push({ type: 'grelan' })
    }

    // 投票フェーズ
    const revoteStyle = config.revoteConfig?.style ?? 'random_tied'
    const revoteTiebreaker = config.revoteConfig?.tiebreaker ?? 'lowest_seat'
    const maxRevotes = config.revoteConfig?.maxRevotes ?? 3
    let executedSeat: number | null = null
    let revoteCount = 0
    let revoteCandidates: number[] | null = null

    while (true) {
      const votes = new Map<number, number>()
      const voters = alivePlayers(state)
      for (const voter of voters) {
        let target: number
        if (revoteCandidates && revoteStyle === 'random_tied') {
          // 現行方式: 候補者限定ランダム
          target = revoteCandidates[Math.floor(rng.next() * revoteCandidates.length)]
        } else {
          // 初回投票 or full_revote: Strategyに委任
          const ctx = buildContext(state, voter, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities, revoteCount, revoteCandidates)
          target = decideForPlayer(config, state, voter, ctx,
            (s, c) => s.decideVote(c),
            (s, c) => s.decideVote(c),
          )
        }
        votes.set(voter.seat, target)
        events.push({ type: 'vote', voter: voter.seat, target })
      }

      const result = resolveVotes(votes)
      if ('decided' in result) {
        executedSeat = result.decided
        break
      }

      revoteCount++
      if (revoteCount > maxRevotes) {
        if (revoteTiebreaker === 'draw') {
          // 引き分け: 即座にゲーム終了
          state.finished = true
          state.result = 'draw'
          events.push({ type: 'game_over', result: 'draw' })
          break
        } else {
          // 現行方式: 最小seatで処刑
          executedSeat = result.tied[0]
          break
        }
      }

      events.push({ type: 'revote', targets: result.tied })
      revoteCandidates = result.tied
    }

    // 引き分けの場合は後続処理をすべてスキップ
    if (state.finished) break

    // 指定の場合: 処刑対象が未COの村役職ならCOさせる
    if (!isGrelan && config.allowPostVoteCO !== false) {
      const target = state.players.find(p => p.seat === executedSeat!)!
      const villageRoles: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']
      if (villageRoles.includes(target.role) && target.claimedRole === null) {
        const claim = forceTrueRoleCO(state, target, day, lastExecutedSeat)
        applyClaim(state, target, day, claim, events)
      }
    }

    killPlayer(state, executedSeat!)
    events.push({ type: 'execution', target: executedSeat! })
    lastExecutedSeat = executedSeat!
    state.executionHistory.set(day, executedSeat!)

    // 霊能結果コメント
    const executedPlayer = state.players.find(p => p.seat === executedSeat!)!
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

    // 処刑後: 背徳者後追いチェック
    checkImmoralistFollow(state, events)

    // 指揮者が死亡した場合のリセット
    if (state.commander !== null) {
      const cmd = state.players.find(p => p.seat === state.commander)
      if (cmd && !cmd.alive) state.commander = null
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

/**
 * 非同期版 runGame — Retar分析をawaitで呼ぶ。
 * worker_threads並列Retarと併用する場合に使用。
 * 複数ゲームをPromise.allで同時起動すると、Retarの待ち時間に他ゲームが進む。
 */
export async function runGameAsync(config: LupaConfig): Promise<GameResult> {
  const retarFn = config.retarFn ?? ((e, s, c) => Promise.resolve(retarAnalyze(e, s, c)))
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
    if (totalPlayers > RANDOM_NAMES.length) throw new Error(`プレイヤー名が足りません`)
    names = RANDOM_NAMES.slice(0, totalPlayers)
  } else {
    names = generateRoleNames(assignedRoles)
  }
  const players = assignRoles(config.roles, names, shuffledIndices)
  const state: GameState = { players, day: 0, phase: 'night', finished: false, result: null, executionHistory: new Map(), commander: null, masonPartners: new Map() }
  const events: GameEvent[] = []
  const signals: SignalRecord[] = []
  const proposals: Proposal[] = []

  // Night 0
  for (const player of players) {
    const strategy = getStrategy(config, player.seat)
    const ctx = buildContext(state, player, events, rng, signals, proposals, null)
    applyNightAction(state, player, 0, strategy.decideNightAction(ctx))
  }
  for (const player of players) {
    const divine = player.divineHistory.get(0)
    if (!divine) continue
    const target = players.find(p => p.seat === divine.target)!
    if (target.role === 'werehamster' && target.alive) {
      killPlayer(state, target.seat)
      events.push({ type: 'fox_kill', target: target.seat })
      checkImmoralistFollow(state, events)
    }
  }
  if (config.hasFirstGhost) {
    const immuneRoles: SystemRole[] = ['werewolf', 'nekomata', 'werehamster']
    const candidates = alivePlayers(state).filter(p => !immuneRoles.includes(p.role))
    if (candidates.length > 0) {
      const victim = rng.pick(candidates)
      killPlayer(state, victim.seat)
      events.push({ type: 'night_kill', target: victim.seat })
      checkImmoralistFollow(state, events)
    }
  }

  let lastExecutedSeat: number | null = null
  const MAX_DAYS = 50

  for (let day = 1; day <= MAX_DAYS && !state.finished; day++) {
    state.day = day

    // 夜フェーズ (day 2+)
    if (day > 1) {
      state.phase = 'night'
      const night = day - 1
      const actions: Array<{ player: typeof players[0], action: NightAction }> = []
      let chosenAttacker: number | null = null
      if (config.wolfTeamStrategy) {
        const aliveWolves = alivePlayers(state).filter(p => p.role === 'werewolf')
        if (aliveWolves.length > 0) {
          const leader = aliveWolves[0]
          const ctx = buildContext(state, leader, events, rng, signals, proposals, lastExecutedSeat)
          const teamCtx = buildTeamContext(ctx, state, 'werewolf')
          const wolfAction = config.wolfTeamStrategy.decideNightAction(teamCtx) as WolfNightAction
          chosenAttacker = wolfAction.attacker
          for (const wolf of aliveWolves) {
            if (wolf.seat === wolfAction.attacker) {
              actions.push({ player: wolf, action: { type: 'attack', target: wolfAction.target } })
            } else {
              actions.push({ player: wolf, action: { type: 'none' } })
            }
          }
        }
      }
      for (const player of alivePlayers(state)) {
        if (config.wolfTeamStrategy && player.role === 'werewolf') continue
        const strategy = getStrategy(config, player.seat)
        const ctx = buildContext(state, player, events, rng, signals, proposals, lastExecutedSeat)
        actions.push({ player, action: strategy.decideNightAction(ctx) })
      }
      for (const { player, action } of actions) {
        applyNightAction(state, player, night, action)
        player.forecastTarget = null
      }
      resolveNight(state, actions, events, rng, chosenAttacker)
      checkWinCondition(state)
      if (state.finished) { events.push({ type: 'game_over', result: state.result! }); break }
    }

    // 昼フェーズ
    state.phase = 'day'

    // CO前Retar (async)
    let preCoRetar: Map<number, Set<SystemRole>> | null = null
    if (config.enableRetar) {
      preCoRetar = await retarFn(events, state, config)
    }

    // COフェーズ
    for (const player of alivePlayers(state)) {
      const ctx = buildContext(state, player, events, rng, signals, proposals, lastExecutedSeat, preCoRetar)
      const claim = decideForPlayer(config, state, player, ctx, (s, c) => s.decideDayClaim(c), (s, c) => s.decideDayClaim(c))
      applyClaim(state, player, day, claim, events)
    }
    for (const player of alivePlayers(state)) {
      if (player.claimedRole !== null) continue
      if (!alivePlayers(state).some(p => p.seat !== player.seat && p.claimedRole === player.role)) continue
      applyClaim(state, player, day, forceTrueRoleCO(state, player, day, lastExecutedSeat), events)
    }

    // CO後Retar (async)
    let retarPossibilities: Map<number, Set<SystemRole>> | null = null
    if (config.enableRetar) {
      retarPossibilities = await retarFn(events, state, config)
    }

    // シグナルフェーズ
    state.commander = detectCommander(state)
    if (state.commander !== null) events.push({ type: 'commander_appointed', seat: state.commander })
    const daySignals: SignalRecord[] = []
    let signalIdCounter = signals.length
    const dayProposals: Proposal[] = []
    if (state.commander !== null) {
      const commander = state.players.find(p => p.seat === state.commander)!
      if (commander.alive) {
        const ctx = buildContext(state, commander, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities)
        const proposal = decideForPlayer(config, state, commander, ctx, (s, c) => s.decideProposal(c), (s, c) => s.decideProposal(c))
        if (proposal) {
          dayProposals.push(proposal)
          events.push({ type: 'proposal', actor: commander.seat, proposal })
          for (const player of alivePlayers(state)) {
            if (player.seat === state.commander) continue
            const pCtx = buildContext(state, player, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities)
            events.push({ type: 'leadership_response', actor: player.seat, response: decideForPlayer(config, state, player, pCtx, (s, c) => s.decideLeadershipResponse(c, proposal), (s, c) => s.decideLeadershipResponse(c, proposal)) })
          }
        }
      }
    }
    for (let round = 0; round < 3; round++) {
      for (const player of alivePlayers(state)) {
        const ctx = buildContext(state, player, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities)
        applyCommAction(state, player, day, decideForPlayer(config, state, player, ctx, (s, c) => s.decideCommunication(c), (s, c) => s.decideCommunication(c)), events, daySignals, signals, signalIdCounter)
        signalIdCounter += 1
      }
    }
    for (const player of alivePlayers(state)) {
      const ctx = buildContext(state, player, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities)
      const forecast = decideForPlayer(config, state, player, ctx, (s, c) => s.decideForecast(c), (s, c) => s.decideForecast(c))
      if (forecast.type === 'forecast') { player.forecastTarget = forecast.target; events.push({ type: 'forecast', actor: player.seat, target: forecast.target }) }
    }

    // 投票
    const isGrelan = rng.next() < 0.3
    if (isGrelan) events.push({ type: 'grelan' })
    const revoteStyle = config.revoteConfig?.style ?? 'random_tied'
    const revoteTiebreaker = config.revoteConfig?.tiebreaker ?? 'lowest_seat'
    const maxRevotes = config.revoteConfig?.maxRevotes ?? 3
    let executedSeat: number | null = null
    let revoteCount = 0
    let revoteCandidates: number[] | null = null
    while (true) {
      const votes = new Map<number, number>()
      for (const voter of alivePlayers(state)) {
        let target: number
        if (revoteCandidates && revoteStyle === 'random_tied') {
          target = revoteCandidates[Math.floor(rng.next() * revoteCandidates.length)]
        } else {
          const ctx = buildContext(state, voter, events, rng, daySignals, dayProposals, lastExecutedSeat, retarPossibilities, revoteCount, revoteCandidates)
          target = decideForPlayer(config, state, voter, ctx, (s, c) => s.decideVote(c), (s, c) => s.decideVote(c))
        }
        votes.set(voter.seat, target)
        events.push({ type: 'vote', voter: voter.seat, target })
      }
      const result = resolveVotes(votes)
      if ('decided' in result) { executedSeat = result.decided; break }
      revoteCount++
      if (revoteCount > maxRevotes) {
        if (revoteTiebreaker === 'draw') { state.finished = true; state.result = 'draw'; events.push({ type: 'game_over', result: 'draw' }); break }
        else { executedSeat = result.tied[0]; break }
      }
      events.push({ type: 'revote', targets: result.tied })
      revoteCandidates = result.tied
    }
    if (state.finished) break

    // 処刑後
    if (!isGrelan && config.allowPostVoteCO !== false) {
      const target = state.players.find(p => p.seat === executedSeat!)!
      const villageRoles: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']
      if (villageRoles.includes(target.role) && target.claimedRole === null) {
        applyClaim(state, target, day, forceTrueRoleCO(state, target, day, lastExecutedSeat), events)
      }
    }
    killPlayer(state, executedSeat!)
    events.push({ type: 'execution', target: executedSeat! })
    lastExecutedSeat = executedSeat!
    state.executionHistory.set(day, executedSeat!)
    const executedPlayer = state.players.find(p => p.seat === executedSeat!)!
    const medResult = getSeerResult(executedPlayer.role)
    events.push({ type: 'comment', text: `霊能: ${executedPlayer.name} = ${medResult === 'human' ? '○' : '●'}` })
    if (executedPlayer.role === 'nekomata') {
      const curseCandidates = alivePlayers(state)
      if (curseCandidates.length > 0) { const ct = rng.pick(curseCandidates); killPlayer(state, ct.seat); events.push({ type: 'curse_kill', target: ct.seat }) }
    }
    checkImmoralistFollow(state, events)
    if (state.commander !== null) { const cmd = state.players.find(p => p.seat === state.commander); if (cmd && !cmd.alive) state.commander = null }
    checkWinCondition(state)
    if (state.finished) { events.push({ type: 'game_over', result: state.result! }); break }
  }

  for (const player of state.players) events.push({ type: 'reveal', seat: player.seat, role: player.role })
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
  chosenAttacker: number | null = null,
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
      // 襲撃者を道連れ (チーム選択 or 襲撃実行者)
      const curseTarget = chosenAttacker ?? attacker.seat
      killPlayer(state, curseTarget)
      events.push({ type: 'curse_kill', target: curseTarget })
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
  const aliveHamsters = state.players.filter(p => p.role === 'werehamster' && p.alive)
  if (aliveHamsters.length > 0) return

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
      events.push({ type: 'medium_claim', actor: player.seat, pastResults: claim.pastResults })
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
      // masonPartnersを記録
      if (!state.masonPartners) state.masonPartners = new Map()
      state.masonPartners.set(player.seat, claim.partner)
      break
    case 'nekomata_co':
      player.claimedRole = 'nekomata'
      player.claimedDay = day
      events.push({ type: 'nekomata_claim', actor: player.seat })
      break
    case 'forecast':
    case 'none':
      break
  }
}

const ROLE_CO_SIGNALS: Map<string, SystemRole> = new Map([
  ['werewolf_co', 'werewolf'],
  ['fanatic_co', 'fanatic'],
  ['werehamster_co', 'werehamster'],
  ['immoralist_co', 'immoralist'],
])

/** CommunicationAction を状態に適用 */
function applyCommAction(
  state: GameState, player: typeof state.players[0], day: number,
  commAction: CommunicationAction, events: GameEvent[],
  daySignals: SignalRecord[], signals: SignalRecord[], signalId: number,
): void {
  const { signal, proposals, predictions } = commAction

  // シグナル記録
  const record: SignalRecord = { id: signalId, sender: player.seat, day, signal }
  daySignals.push(record)
  signals.push(record)
  if (signal.type !== 'no_signal') {
    events.push({ type: 'signal', actor: player.seat, signal })
  }

  // 役職COシグナルの処理
  const coRole = ROLE_CO_SIGNALS.get(signal.type)
  if (coRole) {
    player.claimedRole = coRole
    player.claimedDay = day
    events.push({ type: 'wolf_claim', actor: player.seat, claimedRole: coRole })
  }

  // 処刑提案イベント
  if (proposals.length > 0) {
    events.push({ type: 'execute_proposals', actor: player.seat, targets: proposals })
  }

  // 配役予想イベント
  if (signal.type === 'submit_prediction' && predictions) {
    events.push({ type: 'prediction', actor: player.seat, predictions })
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
