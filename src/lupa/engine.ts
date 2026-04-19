/**
 * Lupa Next Engine — 最小限の非同期ゲームエンジン
 *
 * コアの責務:
 *   - 役職割当、夜解決、投票解決、処刑、勝利判定
 *   - イベント記録
 *
 * 全ての意思決定はハンドラーコールバック経由で外部に委譲。
 * 議論フェーズ（シグナル、指揮者、予告、防御CO）はオプション。
 */

import type { SystemRole, ResolvedRules } from '../types/index.ts'
import { resolveRules } from '../howl/ruleset.ts'
import type { GameState, GameEvent, GameSnapshot, NightAction, DayClaim, PlayerState } from './types.ts'
import type { GameConfig, GameHandlers, GameResult, PhaseContext, VoteContext } from './handlers.ts'
import { Rng } from './random.ts'
import { generateRoleNames, generateRoleSeatNames } from './names.ts'
import {
  assignRoles, alivePlayers, getSeerResult,
  killPlayer, checkWinCondition,
} from './roles.ts'
import { forceTrueRoleCO, resolveVotes } from './engine-utils.ts'

const MAX_DAYS = 50

// ============================================================
// 公開API
// ============================================================

export async function runGame<E = never, Ext = unknown>(config: GameConfig, handlers: GameHandlers<E, Ext>): Promise<GameResult<E, Ext>> {
  const rules = resolveRules(config.rules)
  const rng = new Rng(config.seed)
  const totalPlayers = Array.from(config.roles.values()).reduce((a, b) => a + b, 0)

  // 役職割当
  const shuffledIndices = rng.shuffle(Array.from({ length: totalPlayers }, (_, i) => i))
  const assignedRoles = shuffledIndices.map(i => {
    const roleArray: SystemRole[] = []
    for (const [role, count] of config.roles) {
      for (let j = 0; j < count; j++) roleArray.push(role)
    }
    return roleArray[i]
  })
  const names = config.nameStyle === 'seat'
    ? generateRoleSeatNames(assignedRoles)
    : generateRoleNames(assignedRoles)
  const players = assignRoles(config.roles, names, shuffledIndices)

  const state: GameState<Ext> = {
    players,
    day: 0,
    phase: 'night',
    finished: false,
    result: null,
    executionHistory: new Map(),
    commander: null,
    masonPartners: new Map(),
    ext: undefined as unknown as Ext,
  }

  const events: (GameEvent | E)[] = []
  const emit = (event: GameEvent | E) => {
    events.push(event)
    handlers.onEvent?.(event)
  }

  const hasFirstVictim = config.hasFirstGhost ?? rules['first-victim'] !== 'none'

  // onSetup: 役職割当を通知
  const seatRoles = new Map(players.map(p => [p.seat, p.role]))
  if (handlers.onSetup) await handlers.onSetup(seatRoles, state)

  // ============================================================
  // Night 0
  // ============================================================

  const night0Ctx = makePhaseContext(state, events, rules)
  const night0Actions = await handlers.onNight(night0Ctx)

  // 夜行動を適用
  for (const [seat, action] of night0Actions) {
    const player = players.find(p => p.seat === seat)!
    applyNightAction(state, player, 0, action)
  }

  // 占い呪殺チェック (Night 0)
  for (const player of players) {
    const divine = player.divineHistory.get(0)
    if (!divine) continue
    const target = players.find(p => p.seat === divine.target)!
    if (target.role === 'werehamster' && target.alive) {
      killPlayer(state, target.seat)
      emit({ type: 'fox_kill', target: target.seat })
      checkImmoralistFollow(state, emit)
    }
  }

  // 初日犠牲者
  if (hasFirstVictim) {
    const immuneRoles: SystemRole[] = ['werewolf', 'nekomata', 'werehamster']
    const candidates = alivePlayers(state).filter(p => !immuneRoles.includes(p.role))
    if (candidates.length > 0) {
      const victim = rng.pick(candidates)
      killPlayer(state, victim.seat)
      emit({ type: 'night_kill', target: victim.seat })
      checkImmoralistFollow(state, emit)
    }
  }

  // ============================================================
  // メインループ
  // ============================================================

  const snapshots = config.captureSnapshotDays ? new Map<number, GameSnapshot<E, Ext>>() : undefined
  await runGameLoop(state, events, emit, rng, rules, handlers, config, 1, null, snapshots, seatRoles)

  // 役職公開
  for (const player of players) {
    emit({ type: 'reveal', seat: player.seat, role: player.role })
  }

  const timing = handlers.getTiming?.()
  return { events, state, config, timing, ...(snapshots?.size ? { snapshots } : {}) }
}

/**
 * スナップショットからゲームを再開する
 * snapshot.state.day の次の Night から開始。
 * handlers.onSetup が呼ばれるので、戦略の初期化はそこで行う。
 */
export async function resumeGame<E = never, Ext = unknown>(snapshot: GameSnapshot<E, Ext>, handlers: GameHandlers<E, Ext>): Promise<GameResult<E, Ext>> {
  const state = structuredClone(snapshot.state)
  const events: (GameEvent | E)[] = [...snapshot.events]
  const rng = Rng.fromState(snapshot.rngState)
  const rules = resolveRules(snapshot.config.rules)
  const config = snapshot.config

  const emit = (event: GameEvent | E) => {
    events.push(event)
    handlers.onEvent?.(event)
  }

  // onSetup: 役職割当を通知（戦略初期化用）
  if (handlers.onSetup) await handlers.onSetup(snapshot.seatRoles, state)

  const lastExecutedSeat = state.executionHistory.get(state.day) ?? null
  const startDay = state.day + 1

  await runGameLoop(state, events, emit, rng, rules, handlers, config, startDay, lastExecutedSeat)

  // 役職公開
  for (const player of state.players) {
    emit({ type: 'reveal', seat: player.seat, role: player.role })
  }

  const timing = handlers.getTiming?.()
  return { events, state, config, timing }
}

// ============================================================
// メインゲームループ（runGame / resumeGame 共用）
// ============================================================

async function runGameLoop<E = never, Ext = unknown>(
  state: GameState<Ext>,
  events: (GameEvent | E)[],
  emit: (event: GameEvent | E) => void,
  rng: Rng,
  rules: ResolvedRules,
  handlers: GameHandlers<E, Ext>,
  config: GameConfig,
  startDay: number,
  lastExecutedSeat: number | null,
  snapshots?: Map<number, GameSnapshot<E, Ext>>,
  seatRoles?: Map<number, SystemRole>,
): Promise<void> {
  const players = state.players
  const checkWin = handlers.checkWinCondition ?? checkWinCondition

  for (let day = startDay; day <= MAX_DAYS && !state.finished; day++) {
    state.day = day

    // ==== 夜フェーズ (day 2+、またはresumeの初日) ====
    if (day > 1) {
      state.phase = 'night'
      const night = day - 1

      const nightCtx = makePhaseContext(state, events, rules)
      const nightActions = await handlers.onNight(nightCtx)

      const actionsList: Array<{ player: PlayerState, action: NightAction }> = []
      for (const [seat, action] of nightActions) {
        const player = players.find(p => p.seat === seat)!
        applyNightAction(state, player, night, action)
        player.forecastTarget = null
        actionsList.push({ player, action })
      }

      resolveNight(state, actionsList, events, emit, rng)

      checkWin(state)
      if (state.finished) {
        emit({ type: 'game_over', result: state.result! })
        break
      }
    }

    // ==== 昼フェーズ ====
    state.phase = 'day'

    // CO フェーズ
    const dayCtx = makePhaseContext(state, events, rules)
    const claims = await handlers.onDayClaims(dayCtx)

    for (const [seat, claim] of claims) {
      const player = players.find(p => p.seat === seat)!
      applyClaim(state, player, day, claim, emit)
    }

    // 強制対抗CO (ゲームルール): COに対して真役職者が未COなら強制
    forceTrueRoleCOPass(state, day, lastExecutedSeat, emit)

    // 投票前フェーズ (オプション: 議論、指揮者等)
    // continueDiscussion が true の間は再呼び出し（consumer 側ミニループ用）
    if (handlers.onPreVote) {
      while (true) {
        const preVoteCtx = makePhaseContext(state, events, rules)
        const preVoteResult = await handlers.onPreVote(preVoteCtx)

        // 追加CO適用
        if (preVoteResult.additionalClaims) {
          for (const [seat, claim] of preVoteResult.additionalClaims) {
            const player = players.find(p => p.seat === seat)!
            applyClaim(state, player, day, claim, emit)
          }
        }

        // ハンドラーが生成したイベントを記録
        if (preVoteResult.events) {
          for (const event of preVoteResult.events) emit(event)
        }

        if (!preVoteResult.continueDiscussion) break
      }
    }

    // ==== 投票フェーズ ====
    const revoteStyle = config.revoteConfig?.style ?? 'random_tied'
    const revoteTiebreaker = config.revoteConfig?.tiebreaker ?? 'lowest_seat'
    const maxRevotes = config.revoteConfig?.maxRevotes ?? 3
    let executedSeat: number | null = null
    let revoteCount = 0
    let revoteCandidates: number[] | null = null

    while (true) {
      // ランダム再投票 (候補者限定): ハンドラーに聞かずエンジンが解決
      if (revoteCandidates && revoteStyle === 'random_tied') {
        const votes = new Map<number, number>()
        for (const voter of alivePlayers(state)) {
          const target = revoteCandidates[Math.floor(rng.next() * revoteCandidates.length)]
          votes.set(voter.seat, target)
          emit({ type: 'vote', voter: voter.seat, target })
        }
        const result = resolveVotes(votes)
        if ('decided' in result) {
          executedSeat = result.decided
          break
        }
        revoteCount++
        if (revoteCount > maxRevotes) {
          executedSeat = handleTiebreak(state, result.tied, revoteTiebreaker, emit)
          break
        }
        emit({ type: 'revote', targets: result.tied })
        revoteCandidates = result.tied
        continue
      }

      // 通常投票 or full_revote: ハンドラーに委任
      const voteCtx: VoteContext<E, Ext> = {
        ...makePhaseContext(state, events, rules),
        revoteRound: revoteCount,
        candidates: revoteCandidates,
      }
      const votes = await handlers.onVote(voteCtx)

      // 自投票禁止: 自分に投票した場合はランダムに変更
      for (const [voter, target] of votes) {
        if (voter === target) {
          const others = alivePlayers(state).filter(p => p.seat !== voter)
          if (others.length > 0) {
            votes.set(voter, others[Math.floor(rng.next() * others.length)].seat)
          }
        }
      }

      for (const [voter, target] of votes) {
        emit({ type: 'vote', voter, target })
      }

      const result = resolveVotes(votes)
      if ('decided' in result) {
        executedSeat = result.decided
        break
      }

      revoteCount++
      if (revoteCount > maxRevotes) {
        executedSeat = handleTiebreak(state, result.tied, revoteTiebreaker, emit)
        break
      }

      emit({ type: 'revote', targets: result.tied })
      revoteCandidates = result.tied
    }

    // 引き分けの場合
    if (state.finished) break

    // ==== 遺言フェーズ（処刑前CO） ====
    if (rules['phase.lastwill'] && handlers.onLastWill) {
      const lwCtx = makePhaseContext(state, events, rules)
      const lwClaim = await handlers.onLastWill(lwCtx, executedSeat!)
      if (lwClaim.type !== 'none') {
        const lwPlayer = players.find(p => p.seat === executedSeat!)!
        applyClaim(state, lwPlayer, day, lwClaim, emit)
      }
    }

    // ==== 処刑 + 後処理 ====
    killPlayer(state, executedSeat!)
    emit({ type: 'execution', target: executedSeat! })
    lastExecutedSeat = executedSeat!
    state.executionHistory.set(day, executedSeat!)

    // 霊能結果コメント
    const executedPlayer = players.find(p => p.seat === executedSeat!)!
    const medResult = getSeerResult(executedPlayer.role)
    emit({ type: 'comment', text: `霊能: ${executedPlayer.name} = ${medResult === 'human' ? '○' : '●'}` })

    // 猫又道連れ
    if (executedPlayer.role === 'nekomata') {
      let curseCandidates = alivePlayers(state)
      if (rules['role.nekomata.curse-target'] === 'villager') {
        const wolfFoxRoles: SystemRole[] = ['werewolf', 'werehamster']
        curseCandidates = curseCandidates.filter(p => !wolfFoxRoles.includes(p.role))
      }
      if (curseCandidates.length > 0) {
        const curseTarget = rng.pick(curseCandidates)
        killPlayer(state, curseTarget.seat)
        emit({ type: 'curse_kill', target: curseTarget.seat })
      }
    }

    // 背徳者後追い
    checkImmoralistFollow(state, emit)

    // 勝利判定
    checkWin(state)
    if (state.finished) {
      emit({ type: 'game_over', result: state.result! })
      break
    }

    // スナップショット取得（ゲーム継続中、処刑後）
    if (snapshots && config.captureSnapshotDays?.includes(day) && seatRoles) {
      snapshots.set(day, {
        state: structuredClone(state),
        events: [...events],
        rngState: rng.getState(),
        config,
        seatRoles,
      })
    }
  }
}

// ============================================================
// 内部ヘルパー
// ============================================================

function makePhaseContext<E = never, Ext = unknown>(state: GameState<Ext>, events: (GameEvent | E)[], rules: ResolvedRules): PhaseContext<E, Ext> {
  return {
    day: state.day,
    state,
    events,
    alivePlayers: alivePlayers(state).map(p => p.seat),
    rules,
  }
}

/** 夜アクションを状態に適用（記録のみ） */
function applyNightAction(
  state: GameState, player: PlayerState, night: number, action: NightAction,
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

type EmitFn = (event: GameEvent) => void

/** 夜の結果を解決 */
function resolveNight(
  state: GameState,
  actions: Array<{ player: PlayerState, action: NightAction }>,
  _events: unknown[],
  emit: EmitFn,
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
        emit({ type: 'comment', text: `占い: ${name(player.seat)} → ${name(action.target)} ${resultStr}` })
        break
      }
      case 'guard':
        emit({ type: 'comment', text: `護衛: ${name(player.seat)} → ${name(action.target)}` })
        break
      case 'attack':
        emit({ type: 'comment', text: `襲撃: ${name(player.seat)} → ${name(action.target)}` })
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
      emit({ type: 'fox_kill', target: action.target })
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
  let hadNightKill = foxKilled.size > 0
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
      emit({ type: 'night_kill', target: action.target })
      killPlayer(state, attacker.seat)
      emit({ type: 'night_kill', target: attacker.seat })
      hadNightKill = true
    } else {
      killPlayer(state, action.target)
      emit({ type: 'night_kill', target: action.target })
      hadNightKill = true
    }
  }

  // 妖狐死亡による背徳者後追い
  if (foxKilled.size > 0) {
    checkImmoralistFollow(state, emit)
  }

  // 平和
  if (!hadNightKill) {
    emit({ type: 'peace' })
  }
}

/** COアクションをイベントに変換 */
function applyClaim(
  state: GameState, player: PlayerState, day: number,
  claim: DayClaim, emit: EmitFn,
): void {
  switch (claim.type) {
    case 'seer_co':
      player.claimedRole = 'seer'
      player.claimedDay = day
      emit({ type: 'seer_claim', actor: player.seat, results: claim.results })
      break
    case 'seer_result':
      emit({ type: 'seer_result', actor: player.seat, target: claim.target, result: claim.result })
      break
    case 'medium_co':
      player.claimedRole = 'medium'
      player.claimedDay = day
      emit({ type: 'medium_claim', actor: player.seat, pastResults: claim.pastResults })
      break
    case 'medium_result':
      emit({ type: 'medium_result', actor: player.seat, result: claim.result })
      break
    case 'bodyguard_co':
      player.claimedRole = 'bodyguard'
      player.claimedDay = day
      emit({ type: 'bodyguard_claim', actor: player.seat, targets: claim.targets })
      break
    case 'mason_co':
      player.claimedRole = 'mason'
      player.claimedDay = day
      emit({ type: 'mason_claim', actor: player.seat, partner: claim.partner })
      if (!state.masonPartners) state.masonPartners = new Map()
      state.masonPartners.set(player.seat, claim.partner)
      break
    case 'nekomata_co':
      player.claimedRole = 'nekomata'
      player.claimedDay = day
      emit({ type: 'nekomata_claim', actor: player.seat })
      break
    case 'forecast':
    case 'none':
      break
  }
}

/** 妖狐死亡時の背徳者後追いチェック */
function checkImmoralistFollow(state: GameState, emit: EmitFn): void {
  const aliveHamsters = state.players.filter(p => p.role === 'werehamster' && p.alive)
  if (aliveHamsters.length > 0) return

  const aliveImmoralists = state.players.filter(p => p.role === 'immoralist' && p.alive)
  for (const imm of aliveImmoralists) {
    killPlayer(state, imm.seat)
    emit({ type: 'follow_kill', target: imm.seat })
  }
}

/**
 * 強制対抗COパス: COに対して真役職者が未COなら強制CO
 * 2パス: (1) 全員にCOさせる (2) 対抗がいれば真役職者を強制CO
 */
function forceTrueRoleCOPass(
  state: GameState, day: number, lastExecutedSeat: number | null, emit: EmitFn,
): void {
  const coRoles: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']

  for (const role of coRoles) {
    const claimants = state.players.filter(p => p.claimedRole === role && p.alive)
    if (claimants.length === 0) continue

    // 真役職者が未COなら強制CO
    const trueHolders = state.players.filter(p => p.role === role && p.alive && p.claimedRole === null)
    for (const player of trueHolders) {
      const claim = forceTrueRoleCO(state, player, day, lastExecutedSeat)
      if (claim.type !== 'none') {
        applyClaim(state, player, day, claim, emit)
      }
    }
  }
}

/** タイブレーク処理 */
function handleTiebreak(
  state: GameState, tied: number[], tiebreaker: string, emit: EmitFn,
): number | null {
  if (tiebreaker === 'draw') {
    state.finished = true
    state.result = 'draw'
    emit({ type: 'game_over', result: 'draw' })
    return null
  }
  // lowest_seat
  return tied[0]
}
