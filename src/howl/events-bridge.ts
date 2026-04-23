/**
 * Howl statements → Lupa GameEvent[] 変換
 *
 * パースされた Howl statements を Lupa engine が emit する GameEvent 列に変換する。
 * Agent perspective (= mason perspective を含む) で必要な public 情報のみを扱う。
 *
 * 主な用途: demo で NN 推論時に観測の publicEvents を埋めるため。
 * Lupa engine の runGame を再走させずに、howl テキストから直接 events を引き出す。
 *
 * 限界:
 * - 占い/狩人/猫又などの**秘密の**夜行動結果は events に含まれない（engine と同じ規約）
 * - 襲撃の attacker (どの狼が噛んだか) は元々 public ではないので含まれない
 */

import type { Statement, AssertStatement, MasonStatement, VoteStatement, MultiVoteStatement, AttackStatement, LynchStatement, RevoteStatement, OverStatement, RevealStatement, CurseStatement, FollowStatement, ForecastStatement } from './statement.ts'
import type { GameEvent } from '../lupa/types.ts'
import type { SystemRole, EnumSpecies } from '../types/index.ts'
import type { FlexibleDictionary } from './flexibleDictionary.ts'

export type DayEvent = { day: number, event: GameEvent }

const SPECIES_MAP: Record<string, EnumSpecies> = { isHuman: 'human', isWolf: 'wolf' }

const ROLE_TO_SYSTEM: Record<string, SystemRole> = {
  seer: 'seer',
  medium: 'medium',
  bodyguard: 'bodyguard',
  mason: 'mason',
  nekomata: 'nekomata',
  villager: 'villager',
  werewolf: 'werewolf',
  fanatic: 'fanatic',
  possessed: 'possessed',
  werehamster: 'werehamster',
  immoralist: 'immoralist',
}

function resolveSeat(dict: FlexibleDictionary, name: string): number | null {
  const results = dict.search(name)
  if (results.length === 0) return null
  return Number(results[0])
}

function processAssert(stmt: AssertStatement, dict: FlexibleDictionary, currentDay: number): GameEvent[] {
  const actor = resolveSeat(dict, stmt.actor)
  if (actor === null) return []

  const events: GameEvent[] = []

  // 最初の assertion が role claim、以降が history (results / guards)
  // 但し negative claim (素村CO等) は emit しない
  const claimAssertion = stmt.assertions[0]
  if (!claimAssertion?.roles || claimAssertion.negative) {
    // negative claim や history のみは role イベントにできない
    return []
  }

  const restAssertions = stmt.assertions.slice(1)

  for (const role of claimAssertion.roles) {
    if (role === 'seer') {
      const results: Array<{ day: number, target: number, result: EnumSpecies }> = []
      // assertion に明示的な day (1D/2日目 等) があればそれを、無ければ statement day - 1 を fallback.
      const fallbackDay = Math.max(0, currentDay - 1)
      for (const a of restAssertions) {
        if (!a.target || !a.result) continue
        const targetSeat = resolveSeat(dict, a.target)
        if (targetSeat === null) continue
        const resolved = SPECIES_MAP[a.result]
        if (!resolved) continue
        results.push({ day: a.day ?? fallbackDay, target: targetSeat, result: resolved })
      }
      events.push({ type: 'seer_claim', actor, results })
    } else if (role === 'medium') {
      const pastResults: EnumSpecies[] = []
      for (const a of restAssertions) {
        if (!a.result) continue
        const resolved = SPECIES_MAP[a.result]
        if (!resolved) continue
        pastResults.push(resolved)
      }
      events.push({ type: 'medium_claim', actor, ...(pastResults.length > 0 ? { pastResults } : {}) })
    } else if (role === 'bodyguard') {
      const targets: number[] = []
      for (const a of restAssertions) {
        if (!a.target || a.action !== 'guard') continue
        const targetSeat = resolveSeat(dict, a.target)
        if (targetSeat === null) continue
        targets.push(targetSeat)
      }
      events.push({ type: 'bodyguard_claim', actor, targets })
    } else if (role === 'nekomata') {
      events.push({ type: 'nekomata_claim', actor })
    } else if (role === 'mason') {
      // 単独の mason CO (assertion 形式) は partner 情報なし → emit しない（mason statement の方で扱う）
    }
    // nonVillage/villager は public claim event を emit しない
  }

  return events
}

function processMasonStatement(stmt: MasonStatement, dict: FlexibleDictionary): GameEvent[] {
  const seats = stmt.players.map(p => resolveSeat(dict, p)).filter((s): s is number => s !== null)
  if (seats.length < 2) return []
  const events: GameEvent[] = []
  // 各 mason が相手を partner として CO する形でイベント化
  for (let i = 0; i < seats.length; i++) {
    const partner = seats[(i + 1) % seats.length]
    events.push({ type: 'mason_claim', actor: seats[i], partner })
  }
  return events
}

/**
 * パースされた Howl statements を public な GameEvent 列に変換する。
 * 各イベントには元の statement の day を付与する。
 *
 * 呼び出し前に buildVillageStatus を実行して dict を取得しておくこと。
 */
export function statementsToPublicEvents(
  statements: readonly Statement[],
  dict: FlexibleDictionary,
): DayEvent[] {
  const out: DayEvent[] = []
  let currentDay = 1

  function emit(event: GameEvent) {
    out.push({ day: currentDay, event })
  }

  for (const stmt of statements) {
    if (stmt.day !== undefined) currentDay = stmt.day

    switch (stmt.type) {
      case 'vote': {
        const s = stmt as VoteStatement
        const voter = resolveSeat(dict, s.voter)
        const target = resolveSeat(dict, s.target)
        if (voter === null || target === null) break
        emit({ type: 'vote', voter, target })
        break
      }
      case 'multiVote': {
        const s = stmt as MultiVoteStatement
        const target = resolveSeat(dict, s.target)
        if (target === null) break
        for (const voterName of s.voters) {
          const voter = resolveSeat(dict, voterName)
          if (voter === null) continue
          emit({ type: 'vote', voter, target })
        }
        break
      }
      case 'attack': {
        const s = stmt as AttackStatement
        for (const tgt of s.target) {
          const target = resolveSeat(dict, tgt)
          if (target === null) continue
          emit({ type: 'night_kill', target })
        }
        break
      }
      case 'lynch': {
        const s = stmt as LynchStatement
        if (!s.target) break
        const target = resolveSeat(dict, s.target)
        if (target === null) break
        emit({ type: 'execution', target })
        break
      }
      case 'revote': {
        const s = stmt as RevoteStatement
        const targets = s.targets.map(t => resolveSeat(dict, t)).filter((x): x is number => x !== null)
        emit({ type: 'revote', targets })
        break
      }
      case 'assert': {
        const evs = processAssert(stmt as AssertStatement, dict, currentDay)
        for (const e of evs) emit(e)
        break
      }
      case 'mason': {
        const evs = processMasonStatement(stmt as MasonStatement, dict)
        for (const e of evs) emit(e)
        break
      }
      case 'peace': {
        emit({ type: 'peace' } satisfies GameEvent)
        // satisfies 対応していない場合のフォールバック
        break
      }
      case 'forecast': {
        const s = stmt as ForecastStatement
        const actor = resolveSeat(dict, s.actor)
        const target = resolveSeat(dict, s.target)
        if (actor === null || target === null) break
        emit({ type: 'forecast', actor, target })
        break
      }
      case 'curse': {
        const s = stmt as CurseStatement
        const target = resolveSeat(dict, s.target)
        if (target === null) break
        emit({ type: 'curse_kill', target })
        break
      }
      case 'follow': {
        const s = stmt as FollowStatement
        const target = resolveSeat(dict, s.target)
        if (target === null) break
        emit({ type: 'follow_kill', target })
        break
      }
      case 'grelan': {
        emit({ type: 'grelan' })
        break
      }
      case 'over': {
        const s = stmt as OverStatement
        const map: Record<string, 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw'> = {
          villageWin: 'villager_won',
          wolfWin: 'werewolf_won',
          hamsterWin: 'werehamster_won',
          draw: 'draw',
        }
        emit({ type: 'game_over', result: map[s.result] })
        break
      }
      case 'reveal': {
        const s = stmt as RevealStatement
        const seat = resolveSeat(dict, s.player)
        if (seat === null) break
        const role = ROLE_TO_SYSTEM[s.role.toLowerCase()]
        if (!role) break
        emit({ type: 'reveal', seat, role })
        break
      }
      // skip: setup, join, joinMulti, spoiler, videoSource, timestamp, suddenDeath, unknown
      default:
        break
    }
  }

  return out
}
