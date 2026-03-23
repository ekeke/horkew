import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameState, GameEvent } from './types.ts'
import { Rng } from './random.ts'
import { NAMES } from './names.ts'
import {
  assignRoles, alivePlayers,
  killPlayer, checkWinCondition,
} from './roles.ts'
import {
  seerChooseTarget, seerDivine, seerClaimEvent,
  mediumResult,
  bodyguardChooseTarget,
  wolvesChooseTarget,
  possessedFakeDivine, possessedClaimEvent,
  decideVote, resolveVotes,
} from './ai.ts'

export type GameResult = {
  events: GameEvent[]
  state: GameState
  config: LupaConfig
}

export function runGame(config: LupaConfig): GameResult {
  const rng = new Rng(config.seed)
  const totalPlayers = Array.from(config.roles.values()).reduce((a, b) => a + b, 0)
  const names = NAMES.slice(0, totalPlayers)
  if (names.length < totalPlayers) {
    throw new Error(`プレイヤー名が足りません (必要: ${totalPlayers}, 利用可能: ${NAMES.length})`)
  }

  const roleArray: SystemRole[] = []
  for (const [role, count] of config.roles) {
    for (let i = 0; i < count; i++) roleArray.push(role)
  }
  const shuffledIndices = rng.shuffle(Array.from({ length: totalPlayers }, (_, i) => i))

  const players = assignRoles(config.roles, names, shuffledIndices)
  const state: GameState = {
    players,
    day: 0,
    phase: 'night',
    finished: false,
    result: null,
  }

  const events: GameEvent[] = []

  // Night 0: 占い師の初回占い
  const seers = players.filter(p => p.role === 'seer')
  for (const seer of seers) {
    const target = seerChooseTarget(state, seer, rng)
    if (target !== null) {
      seerDivine(state, seer, 0, target)
    }
  }

  // 狂人の初回偽占い
  const possessedPlayers = players.filter(p => p.role === 'possessed')
  for (const p of possessedPlayers) {
    possessedFakeDivine(state, p, 0, rng)
  }

  // メインループ
  let lastExecutedSeat: number | null = null
  const MAX_DAYS = 50

  for (let day = 1; day <= MAX_DAYS && !state.finished; day++) {
    state.day = day

    // ==== 夜フェーズ (day 1+) ====
    if (day > 1) {
      state.phase = 'night'
      const night = day - 1

      // 占い師の占い
      for (const seer of seers) {
        if (!seer.alive) continue
        const target = seerChooseTarget(state, seer, rng)
        if (target !== null) {
          seerDivine(state, seer, night, target)
          // 妖狐呪殺チェック
          const targetPlayer = state.players.find(p => p.seat === target)!
          if (targetPlayer.role === 'werehamster' && targetPlayer.alive) {
            killPlayer(state, target)
            events.push({ type: 'fox_kill', target })
          }
        }
      }

      // 狂人の偽占い
      for (const p of possessedPlayers) {
        if (!p.alive) continue
        possessedFakeDivine(state, p, night, rng)
      }

      // 狩人の護衛
      const guards = players.filter(p => p.role === 'bodyguard' && p.alive)
      let guardTarget: number | null = null
      for (const guard of guards) {
        guardTarget = bodyguardChooseTarget(state, guard, rng)
        guard.guardHistory.set(night, guardTarget)
      }

      // 人狼の襲撃
      const aliveWolves = players.filter(p => p.role === 'werewolf' && p.alive)
      if (aliveWolves.length > 0) {
        const attackTarget = wolvesChooseTarget(state, rng)
        const targetPlayer = state.players.find(p => p.seat === attackTarget)!

        if (targetPlayer.role === 'werehamster') {
          // 妖狐は襲撃されても死なない → 護衛成功と同じく表示上は平和にはしない
          // ただし他に死者がいなければ平和になる
        } else if (guardTarget === attackTarget) {
          // 護衛成功 → 夜の死者なし (この死者のみ)
        } else {
          killPlayer(state, attackTarget)
          events.push({ type: 'night_kill', target: attackTarget })
        }
      }

      // 夜の死者が誰もいなければ平和
      if (!hasNightDeaths(events)) {
        events.push({ type: 'peace' })
      }

      // 勝利判定
      checkWinCondition(state)
      if (state.finished) {
        events.push({ type: 'game_over', result: state.result! })
        break
      }
    } else {
      // Day 1: 最初の夜死者はいない (初日犠牲者なしルール)
      // ただしゲームによっては初日犠牲者ありもある → Phase 1では初日犠牲者なし
    }

    // ==== 昼フェーズ ====
    state.phase = 'day'

    // CO フェーズ
    if (day === 1) {
      // 占いCO (真占い + 狂人)
      for (const seer of seers) {
        if (!seer.alive) continue
        seer.claimedRole = 'seer'
        seer.claimedDay = day
        events.push(seerClaimEvent(seer))
      }
      for (const p of possessedPlayers) {
        if (!p.alive) continue
        p.claimedRole = 'seer'
        p.claimedDay = day
        events.push(possessedClaimEvent(p))
      }
      // 霊能CO
      const mediums = players.filter(p => p.role === 'medium' && p.alive)
      for (const med of mediums) {
        med.claimedRole = 'medium'
        med.claimedDay = day
        events.push({ type: 'medium_claim', actor: med.seat })
      }
    } else {
      // Day 2+: 霊能結果発表
      if (lastExecutedSeat !== null) {
        const mediums = players.filter(p => p.role === 'medium' && p.alive)
        for (const med of mediums) {
          const result = mediumResult(state, lastExecutedSeat)
          events.push({ type: 'medium_result', actor: med.seat, result })
        }
      }

      // 占い師の新しい結果を発表 (追加結果のみ)
      for (const seer of seers) {
        if (!seer.alive) continue
        const latestNight = day - 1
        const latest = seer.divineHistory.get(latestNight)
        if (latest) {
          events.push({
            type: 'seer_result', actor: seer.seat,
            target: latest.target, result: latest.result,
          })
        }
      }
      for (const p of possessedPlayers) {
        if (!p.alive) continue
        const latestNight = day - 1
        const latest = p.fakeDivineHistory.get(latestNight)
        if (latest) {
          events.push({
            type: 'seer_result', actor: p.seat,
            target: latest.target, result: latest.result,
          })
        }
      }
    }

    // 投票フェーズ
    const alive = alivePlayers(state)

    // 黒出しされたプレイヤーを集計
    const seerBlackTargets = new Set<number>()
    for (const seer of seers) {
      for (const [, d] of seer.divineHistory) {
        if (d.result === 'wolf') seerBlackTargets.add(d.target)
      }
    }
    for (const p of possessedPlayers) {
      for (const [, d] of p.fakeDivineHistory) {
        if (d.result === 'wolf') seerBlackTargets.add(d.target)
      }
    }

    const votes = new Map<number, number>()
    for (const voter of alive) {
      const target = decideVote(state, voter, rng, seerBlackTargets)
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

function hasNightDeaths(events: GameEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'night_kill' || e.type === 'fox_kill') return true
    if (e.type === 'execution' || e.type === 'game_over') return false
  }
  return false
}
