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

import type { SystemRole, Regulation, EnumSpecies } from '../types/index.ts'
import { resolveRegulation } from '../howl/ruleset.ts'
import type { GameState, GameEvent, GameSnapshot, NightAction, DayClaim, PlayerState } from './types.ts'
import type { GameConfig, GameHandlers, GameResult, PhaseContext, VoteContext } from './handlers.ts'
import { Rng } from './random.ts'
import { generateRoleNames, generateRoleSeatNames, generateRandomNames } from './names.ts'
import {
  assignRoles, alivePlayers, getSeerResult, getMediumResult,
  killPlayer, checkWinCondition,
} from './roles.ts'
import { forceTrueRoleCO, resolveVotes } from './engine-utils.ts'
import { hasTrait, isFoxWinCounter } from './role-traits.ts'

const MAX_DAYS = 50

// ============================================================
// 公開API
// ============================================================

export async function runGame<E = never, Ext = unknown>(config: GameConfig, handlers: GameHandlers<E, Ext>): Promise<GameResult<E, Ext>> {
  const rules = resolveRegulation(config.rules)
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
    : config.nameStyle === 'random'
      ? generateRandomNames(assignedRoles.length, rng)
      : generateRoleNames(assignedRoles)
  const players = assignRoles(config.roles, names, shuffledIndices)

  // general.omitFirstDay=false (default, 一般的): 初夜=state.day 1, 犠牲者発見後=state.day 2 で議論。
  // general.omitFirstDay=true: 初夜=state.day 0, 犠牲者発見後=state.day 1 で議論 (初日を省く慣習)。
  // 内部 night index は 0-based (spoilerActions.day と一致)、 state.day だけ +dayOffset させる。
  const dayOffset = rules['general.omitFirstDay'] ? 0 : 1

  const state: GameState<Ext> = {
    players,
    day: dayOffset,
    phase: 'night',
    finished: false,
    result: null,
    executionHistory: new Map(),
    commander: null,
    masonPartners: new Map(),
    pendingNightKills: [],
    ext: undefined as unknown as Ext,
  }

  const events: (GameEvent | E)[] = []
  const emit = (event: GameEvent | E) => {
    events.push(event)
    handlers.onEvent?.(event)
  }

  // config.hasFirstGhost は legacy boolean override。 true なら 'random'、 false なら 'none' 強制。
  // 新規 'villager-only' は rules 経由でのみ指定可能。
  const firstVictimMode: 'none' | 'villager-only' | 'random'
    = config.hasFirstGhost === true ? 'random'
    : config.hasFirstGhost === false ? 'none'
    : rules['general.first-victim']

  // 'villager-only' は素村人 (villager role) seat が setup に必須
  if (firstVictimMode === 'villager-only' && !players.some(p => p.role === 'villager')) {
    throw new Error("general.first-victim='villager-only' requires at least one villager seat in the setup.")
  }

  // onSetup: 役職割当を通知
  const seatRoles = new Map(players.map(p => [p.seat, p.role]))
  if (handlers.onSetup) await handlers.onSetup(seatRoles, state)

  // ============================================================
  // Night 0
  // ============================================================

  const night0Ctx = makePhaseContext(state, events, rules)
  const night0Actions = await handlers.onNight(night0Ctx)

  // 夜行動を適用 (resolveAttacks に渡す actionsList も同時に構築)
  // 内部 night index は 0 固定 (state.day=dayOffset の夜 = 初夜)。
  // role.seer.first-seek で「占い divine action」 が制限される:
  //   none    → 占い完全不可 (action 無視)
  //   no-wolf → wolf or 妖狐 を target にした divine は reject (人間は OK)
  //   all     → 制限なし (default)
  const firstSeek = rules['role.seer.first-seek']
  const night0ActionsList: Array<{ player: PlayerState, action: NightAction }> = []
  for (const [seat, action] of night0Actions) {
    const player = players.find(p => p.seat === seat)!
    if (action.type === 'divine' && hasTrait(player.role, 'action', 'divine')) {
      if (firstSeek === 'none') continue
      if (firstSeek === 'no-wolf') {
        const target = players.find(p => p.seat === action.target)
        if (target && (
          hasTrait(target.role, 'action', 'attack')           // wolf
          || hasTrait(target.role, 'passive', 'die-when-divined')  // 妖狐
        )) continue
      }
    }
    applyNightAction(state, player, 0, action, rng)
    night0ActionsList.push({ player, action })
  }

  // 占い呪殺チェック (初夜 = night 0)
  // role.immoralist.reveal-following=false なら fox_kill event を suppress し、
  // 翌朝 (= Day 2 朝、 メインループ突入直前) に night_kill として公開する。
  const revealFollowing = rules['role.immoralist.reveal-following'] !== false
  let foxKilledInNight0 = false
  for (const player of players) {
    const divine = player.divineHistory.get(0)
    if (!divine) continue
    // divine-imperfect (子狐) は呪殺能力を持たない
    if (hasTrait(player.role, 'action', 'divine-imperfect')) continue
    const target = players.find(p => p.seat === divine.target)!
    if (hasTrait(target.role, 'passive', 'die-when-divined') && target.alive) {
      killPlayer(state, target.seat)
      if (revealFollowing) {
        emit({ type: 'fox_kill', target: target.seat })
      } else {
        (state.pendingNightKills ??= []).push(target.seat)
      }
      foxKilledInNight0 = true
    }
  }

  // 初日犠牲者: general.first-victim ルールで分岐
  // - 'none': handler の attack action を resolveAttacks で解決 (狼が通常襲撃可能)
  // - 'villager-only': 素村人 seat からのみランダム選択 (役職持ちは絶対選ばれない)
  // - 'random': 狼/狐系/猫又系を除く seat からランダム選択 (村人陣営の役職持ちも「役職欠け」として失われ得る)
  if (firstVictimMode === 'none') {
    resolveAttacks(state, night0ActionsList, emit, rng, foxKilledInNight0, 0)
  } else {
    const candidates = firstVictimMode === 'villager-only'
      ? alivePlayers(state).filter(p => p.role === 'villager')
      : alivePlayers(state).filter(p => {
          if (hasTrait(p.role, 'action', 'attack')) return false
          if (isFoxWinCounter(p.role)) return false
          if (hasTrait(p.role, 'reactive', 'curse-on-executed')) return false
          if (hasTrait(p.role, 'reactive', 'curse-on-killed')) return false
          return true
        })
    if (candidates.length > 0) {
      const victim = rng.pick(candidates)
      killPlayer(state, victim.seat)
      emit({ type: 'night_kill', target: victim.seat })
    }
  }

  checkImmoralistFollow(state, emit, rules)

  // Night 0 由来の pending kill (reveal-following=false の fox 呪殺等) を翌朝 (= Day 2 朝) に公開
  processPendingNightKills(state, emit)

  // ============================================================
  // メインループ
  // ============================================================

  const snapshots = config.captureSnapshotDays ? new Map<number, GameSnapshot<E, Ext>>() : undefined
  await runGameLoop(state, events, emit, rng, rules, handlers, config, 1 + dayOffset, null, false, dayOffset, snapshots, seatRoles)

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
  const rules = resolveRegulation(snapshot.config.rules)
  const config = snapshot.config

  const emit = (event: GameEvent | E) => {
    events.push(event)
    handlers.onEvent?.(event)
  }

  // onSetup: 役職割当を通知（戦略初期化用）
  if (handlers.onSetup) await handlers.onSetup(snapshot.seatRoles, state)

  const dayOffset = rules['general.omitFirstDay'] ? 0 : 1
  // executionHistory / mediumHistory の key は議論 1-based (= state.day - dayOffset)。
  const lastExecutedSeat = state.executionHistory.get(state.day - dayOffset) ?? null
  const startDay = state.day + 1

  await runGameLoop(state, events, emit, rng, rules, handlers, config, startDay, lastExecutedSeat, true, dayOffset)

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
  rules: Regulation,
  handlers: GameHandlers<E, Ext>,
  config: GameConfig,
  startDay: number,
  lastExecutedSeat: number | null,
  runNightOnFirstIteration: boolean,
  dayOffset: number,
  snapshots?: Map<number, GameSnapshot<E, Ext>>,
  seatRoles?: Map<number, SystemRole>,
): Promise<void> {
  const players = state.players
  const checkWin = handlers.checkWinCondition ?? checkWinCondition

  for (let day = startDay; day <= MAX_DAYS && !state.finished; day++) {
    state.day = day

    // ==== 夜フェーズ (2 周目以降、 または resume で再開した最初の Day) ====
    if (day > startDay || runNightOnFirstIteration) {
      state.phase = 'night'
      // night index は 0-based (spoilerActions.day と一致)。 state.day=dayOffset の夜=Night 0。
      const night = day - 1 - dayOffset

      const nightCtx = makePhaseContext(state, events, rules)
      const nightActions = await handlers.onNight(nightCtx)

      // 連続ガード禁止: role.bodyguard.allow-continuous-protection=false のとき
      // guard action の target が前夜の guardHistory と同じなら reject (記録せず、 ガード効果なし)。
      const allowContinuous = rules['role.bodyguard.allow-continuous-protection']
      const actionsList: Array<{ player: PlayerState, action: NightAction }> = []
      for (const [seat, action] of nightActions) {
        const player = players.find(p => p.seat === seat)!
        if (action.type === 'guard' && allowContinuous === false) {
          const prev = player.guardHistory.get(night - 1)
          if (prev !== undefined && prev === action.target) continue
        }
        applyNightAction(state, player, night, action, rng)
        player.forecastTarget = null
        actionsList.push({ player, action })
      }

      resolveNight(state, actionsList, events, emit, rng, night, rules)

      // 翌朝発動の pending kill を朝に処理 (night_kill として emit)
      processPendingNightKills(state, emit)

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
          // voter 自身が候補者の場合は自票を禁止して残り候補から選ぶ。
          // 候補が voter のみのケース (理論上ありえない) は元の候補配列にフォールバック。
          const pool = revoteCandidates.filter(c => c !== voter.seat)
          const choices = pool.length > 0 ? pool : revoteCandidates
          const target = choices[Math.floor(rng.next() * choices.length)]
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
          executedSeat = handleTiebreak(state, result.tied, revoteTiebreaker, emit, rng)
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
        executedSeat = handleTiebreak(state, result.tied, revoteTiebreaker, emit, rng)
        break
      }

      emit({ type: 'revote', targets: result.tied })
      revoteCandidates = result.tied
    }

    // 引き分けの場合
    if (state.finished) break

    // no-lynch (tiebreaker='no-lynch') の場合は処刑系処理を全部スキップして次の Day iteration へ
    if (executedSeat === null) continue

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
    // role.immoralist.reveal-following=false で妖狐処刑のとき、
    // execution event を suppress し、 翌朝 night_kill として公開する。
    const executedRole = players.find(p => p.seat === executedSeat!)!.role
    if (rules['role.immoralist.reveal-following'] === false && hasTrait(executedRole, 'passive', 'die-when-divined')) {
      (state.pendingNightKills ??= []).push(executedSeat!)
    } else {
      emit({ type: 'execution', target: executedSeat! })
    }
    lastExecutedSeat = executedSeat!
    // executionHistory / mediumHistory の key は議論 1-based (= state.day - dayOffset = day - dayOffset)。
    // omitFirstDay=true (dayOffset=0) なら state.day と一致。 default (dayOffset=1) なら state.day - 1。
    const discussionKey = day - dayOffset
    state.executionHistory.set(discussionKey, executedSeat!)

    // 霊能結果コメント
    const executedPlayer = players.find(p => p.seat === executedSeat!)!
    const medResult = getMediumResult(executedPlayer.role)
    emit({ type: 'comment', text: `霊能: ${executedPlayer.name} = ${medResult === 'human' ? '○' : '●'}` })

    // 霊能 auto-info: 生存中の霊能 trait 保持者に処刑種別を push
    for (const p of alivePlayers(state)) {
      if (hasTrait(p.role, 'auto-info', 'execution-species')) {
        p.mediumHistory.set(discussionKey, { target: executedSeat!, result: medResult })
      }
    }

    // 猫又道連れ (処刑時の呪い)
    if (hasTrait(executedPlayer.role, 'reactive', 'curse-on-executed')) {
      let curseCandidates = alivePlayers(state)
      if (rules['role.nekomata.curse-target'] === 'villager') {
        // 「村人陣営のみを呪う」設定: 襲撃可能な狼と狐陣営勝利カウント担当 (妖狐 + 子狐) を除外
        curseCandidates = curseCandidates.filter(p => !hasTrait(p.role, 'action', 'attack') && !isFoxWinCounter(p.role))
      }
      if (curseCandidates.length > 0) {
        const curseTarget = rng.pick(curseCandidates)
        if (rules['role.nekomata.curse-immediately'] === false) {
          // 翌朝発動: pending に積み、 次の day iteration の夜フェーズ後に night_kill として処理
          (state.pendingNightKills ??= []).push(curseTarget.seat)
        } else {
          killPlayer(state, curseTarget.seat)
          emit({ type: 'curse_kill', target: curseTarget.seat })
        }
      }
    }

    // 背徳者後追い
    checkImmoralistFollow(state, emit, rules)

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

function makePhaseContext<E = never, Ext = unknown>(state: GameState<Ext>, events: (GameEvent | E)[], rules: Regulation): PhaseContext<E, Ext> {
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
  state: GameState, player: PlayerState, night: number, action: NightAction, rng: Rng,
): void {
  switch (action.type) {
    case 'divine': {
      const target = state.players.find(p => p.seat === action.target)!
      // divine-imperfect (子狐): 50% で結果不発、 結果は null
      const isImperfect = hasTrait(player.role, 'action', 'divine-imperfect')
      const result = isImperfect && rng.next() >= 0.5
        ? null
        : getSeerResult(target.role)
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
  rng: Rng,
  night: number,
  rules: Regulation,
): void {
  const name = (seat: number) => state.players.find(p => p.seat === seat)!.name
  const speciesLabel = (r: EnumSpecies): string => {
    if (r === 'human') return '○'
    if (r === 'wolf') return '●'
    if (r === 'kogitsune') return '子狐'
    return '?'
  }

  // 夜行動コメント
  for (const { player, action } of actions) {
    switch (action.type) {
      case 'divine': {
        const result = player.divineHistory.get(night)
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
  // role.immoralist.reveal-following=false なら fox_kill event を suppress、 翌朝 night_kill 扱い。
  const revealFollowing = rules['role.immoralist.reveal-following'] !== false
  const foxKilled = new Set<number>()
  for (const { player, action } of actions) {
    if (action.type !== 'divine') continue
    // divine-imperfect (子狐) は呪殺能力を持たない
    if (hasTrait(player.role, 'action', 'divine-imperfect')) continue
    const target = state.players.find(p => p.seat === action.target)!
    if (hasTrait(target.role, 'passive', 'die-when-divined') && target.alive) {
      killPlayer(state, action.target)
      foxKilled.add(action.target)
      if (revealFollowing) {
        emit({ type: 'fox_kill', target: action.target })
      } else {
        (state.pendingNightKills ??= []).push(action.target)
      }
    }
  }

  resolveAttacks(state, actions, emit, rng, foxKilled.size > 0, night)

  // 狐陣営全滅による背徳者後追い (襲撃死も含むため無条件呼出)
  checkImmoralistFollow(state, emit, rules)
}

/**
 * guard 集約 + 襲撃集約 + 死亡判定 + peace emit。
 * Night N≥1 の resolveNight() と Night 0 (`general.first-victim: 'none'` 時) の両方から呼ばれる。
 * 占い呪殺は呼び出し側で処理済みなので、その分は alreadyKilled で渡す。
 */
function resolveAttacks(
  state: GameState,
  actions: Array<{ player: PlayerState, action: NightAction }>,
  emit: EmitFn,
  rng: Rng,
  alreadyKilled: boolean,
  night: number,
): void {
  // 護衛先を取得 (複数狩人がいる場合は全 guard を集約 — 各狩人の意思決定は独立)
  const guardTargets = new Set<number>()
  for (const { action } of actions) {
    if (action.type === 'guard') {
      guardTargets.add(action.target)
    }
  }

  // 襲撃処理: 狼チームの襲撃先を多数決で 1 つに集約 (同票はランダム)。
  // 個別の attack action はゲーム履歴 (呼び出し側の comment emit) に残るが、実際に死ぬのは
  // 集約された 1 target のみ。猫又道連れも襲撃した狼のうちランダム 1 匹だけ。
  let hadNightKill = alreadyKilled
  const attacksByTarget = new Map<number, PlayerState[]>()
  for (const { player, action } of actions) {
    if (action.type !== 'attack') continue
    const list = attacksByTarget.get(action.target) ?? []
    list.push(player)
    attacksByTarget.set(action.target, list)
  }

  if (attacksByTarget.size > 0) {
    let maxVotes = 0
    for (const list of attacksByTarget.values()) {
      if (list.length > maxVotes) maxVotes = list.length
    }
    const tiedTargets: number[] = []
    for (const [target, list] of attacksByTarget) {
      if (list.length === maxVotes) tiedTargets.push(target)
    }
    const chosenTarget = tiedTargets.length === 1 ? tiedTargets[0] : rng.pick(tiedTargets)
    const chosenAttackers = attacksByTarget.get(chosenTarget)!
    const target = state.players.find(p => p.seat === chosenTarget)!

    // 集約結果を全 attack 提案者の attackHistory に記録 (engine の最終決定を共有)
    for (const list of attacksByTarget.values()) {
      for (const attacker of list) {
        attacker.attackHistory.set(night, chosenTarget)
      }
    }

    if (hasTrait(target.role, 'passive', 'attack-immune')) {
      // 襲撃免疫 (妖狐) は襲撃されても死なない
    } else if (guardTargets.has(chosenTarget)) {
      // 護衛成功 (どれかの狩人が守っていれば成功)
    } else if (hasTrait(target.role, 'reactive', 'curse-on-killed')) {
      // 道連れ役職 (猫又) 襲撃: 本体は死亡、襲撃した狼のうちランダム 1 匹を道連れ
      killPlayer(state, chosenTarget)
      emit({ type: 'night_kill', target: chosenTarget })
      const cursed = rng.pick(chosenAttackers)
      killPlayer(state, cursed.seat)
      emit({ type: 'night_kill', target: cursed.seat })
      hadNightKill = true
    } else {
      killPlayer(state, chosenTarget)
      emit({ type: 'night_kill', target: chosenTarget })
      hadNightKill = true
    }
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

/**
 * 翌朝発動の遅延死亡を処理する。
 * - state.pendingNightKills に積まれた seat を取り出し、 alive なら killPlayer、 常に night_kill を emit。
 * - 既に dead な seat (= reveal-following=false 由来で execution / fox_kill suppress 済み) でも emit する。
 */
function processPendingNightKills(state: GameState, emit: EmitFn): void {
  if (!state.pendingNightKills || state.pendingNightKills.length === 0) return
  const pending = state.pendingNightKills
  state.pendingNightKills = []
  for (const seat of pending) {
    const target = state.players.find(p => p.seat === seat)
    if (target && target.alive) {
      killPlayer(state, seat)
    }
    emit({ type: 'night_kill', target: seat })
  }
}

/** 狐陣営全滅時の後追いチェック */
function checkImmoralistFollow(state: GameState, emit: EmitFn, rules: Regulation): void {
  // fox-win-counter 保有者 (妖狐 + 子狐) が 1 人でも生存していれば後追いは発生しない
  const aliveFoxes = state.players.filter(p => isFoxWinCounter(p.role) && p.alive)
  if (aliveFoxes.length > 0) return

  // follow-fox-death trait 保有者 (背徳者) が後追い
  // role.immoralist.follow-immediately=false なら翌朝発動 (= night_kill 扱い)
  const followImmediately = rules['role.immoralist.follow-immediately'] !== false
  const followers = state.players.filter(p => hasTrait(p.role, 'reactive', 'follow-fox-death') && p.alive)
  for (const imm of followers) {
    if (followImmediately) {
      killPlayer(state, imm.seat)
      emit({ type: 'follow_kill', target: imm.seat })
    } else {
      (state.pendingNightKills ??= []).push(imm.seat)
    }
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
  state: GameState, tied: number[], tiebreaker: string, emit: EmitFn, rng: Rng,
): number | null {
  if (tiebreaker === 'draw') {
    state.finished = true
    state.result = 'draw'
    emit({ type: 'game_over', result: 'draw' })
    return null
  }
  if (tiebreaker === 'random') {
    // tied 候補から rng で 1 人 pick
    return tied[Math.floor(rng.next() * tied.length)]
  }
  if (tiebreaker === 'no-lynch') {
    // 誰も処刑せず次の Night へ。 ゲーム継続。
    emit({ type: 'no_lynch', tied })
    return null
  }
  // lowest_seat (default)
  return tied[0]
}
