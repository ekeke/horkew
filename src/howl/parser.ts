import { preprocess, type Line } from './preprocess.ts'
import {
  parseStatement,
  type Statement,
  type JoinStatement,
  type JoinMultiStatement,
  type VoteStatement,
  type MultiVoteStatement,
  type AttackStatement,
  type LynchStatement,
  type CurseStatement,
  type FollowStatement,
  type ForecastStatement,
  type SuddenDeathStatement,
  type RevoteStatement,
  type RevealStatement,
  type SpoilerStatement,
  type MasonStatement,
  type AssertStatement,
  type UnknownStatement,
  type SetupStatement,
} from './statement.ts'
import * as V from './vocabulary.ts'
import { FlexibleDictionary } from './flexibleDictionary.ts'

export type ParseOptions = {
  rules?: Record<string, any>
  cursorLine?: number
}

// JOIN 文がない .howl で自動生成する仮想プレイヤー名のプレフィックス
const SYNTHESIZED_PLAYER_PREFIX = 'プレイヤー'

// 数字席番号 (半角・全角) を判定する
const seatNumberRegex = /^[0-9０-９]+$/

// FlexibleDictionary に join/joinMulti 1 件分のエントリを登録する。
// 数字エイリアス (席番号) も自動付与する。既存名と重複するときは省く。
function registerJoinInDict(dict: FlexibleDictionary, name: string, extraAliases: string[], seatNumber: number): void {
  const seatAlias = String(seatNumber)
  const aliases = new Set<string>([name, ...extraAliases, seatAlias])
  dict.add(name, [...aliases])
}

function collectExplicitVoters(round: Statement[]): Set<string> {
  const voters = new Set<string>()
  for (const s of round) {
    if (s.type === 'vote') {
      voters.add((s as VoteStatement).voter)
    } else if (s.type === 'multiVote' && (s as MultiVoteStatement).voters.length > 0) {
      for (const v of (s as MultiVoteStatement).voters) voters.add(v)
    }
  }
  return voters
}

function collectRoundTargets(round: Statement[]): Set<string> {
  const targets = new Set<string>()
  for (const s of round) {
    if (s.type === 'vote') {
      targets.add((s as VoteStatement).target)
    } else if (s.type === 'multiVote') {
      targets.add((s as MultiVoteStatement).target)
    }
  }
  return targets
}

function resolveName(dict: FlexibleDictionary, name: string): string {
  const results = dict.search(name)
  return results.length > 0 ? results[0] : name
}

function resolveNames(dict: FlexibleDictionary, names: Set<string>): Set<string> {
  const resolved = new Set<string>()
  for (const name of names) {
    resolved.add(resolveName(dict, name))
  }
  return resolved
}

function fillRound(round: Statement[], alive: Set<string>, dict: FlexibleDictionary, isRevoteRound: boolean, options: ParseOptions): Statement[] {
  const explicitFull = resolveNames(dict, collectExplicitVoters(round))

  // In final vote rounds (default), candidates cannot vote. In revote mode, they can.
  const excludedFull = new Set(explicitFull)
  if (isRevoteRound && options.rules?.['vote.final'] !== 'revote') {
    const targetsFull = resolveNames(dict, collectRoundTargets(round))
    for (const t of targetsFull) excludedFull.add(t)
  }

  const candidates = [...alive].filter(p => !excludedFull.has(p))

  return round.map(s => {
    if (s.type === 'multiVote' && (s as MultiVoteStatement).voters.length === 0) {
      const targetFull = resolveName(dict, (s as MultiVoteStatement).target)
      const voters = candidates.filter(p => p !== targetFull)
      return { ...(s as MultiVoteStatement), voters } as MultiVoteStatement
    }
    return s
  })
}

function fillMultiVoteVoters(statements: Statement[], options: ParseOptions): Statement[] {
  const alive = new Set<string>()
  const dict = new FlexibleDictionary()
  const result: Statement[] = []
  let round: Statement[] = []
  let isRevoteRound = false
  let seatIdx = 0

  function flushRound() {
    if (round.length > 0) {
      result.push(...fillRound(round, alive, dict, isRevoteRound, options))
      round = []
    }
  }

  for (const s of statements) {
    switch (s.type) {
      case 'join': {
        const js = s as JoinStatement
        seatIdx++
        alive.add(js.name)
        registerJoinInDict(dict, js.name, js.aliases, seatIdx)
        result.push(s)
        break
      }
      case 'joinMulti': {
        const players = (s as JoinMultiStatement).players
        for (let i = 0; i < players.length; i++) {
          seatIdx++
          alive.add(players[i])
          registerJoinInDict(dict, players[i], [], seatIdx)
        }
        result.push(s)
        break
      }
      case 'lynch': {
        round.push(s)
        flushRound()
        isRevoteRound = false
        const targetName = (s as LynchStatement).target
        if (targetName) {
          alive.delete(resolveName(dict, targetName))
        }
        break
      }
      case 'revote': {
        round.push(s)
        flushRound()
        isRevoteRound = true
        break
      }
      case 'attack': {
        flushRound()
        isRevoteRound = false
        for (const t of (s as AttackStatement).target) {
          alive.delete(resolveName(dict, t))
        }
        result.push(s)
        break
      }
      case 'curse': {
        alive.delete(resolveName(dict, (s as CurseStatement).target))
        result.push(s)
        break
      }
      case 'follow': {
        alive.delete(resolveName(dict, (s as FollowStatement).target))
        result.push(s)
        break
      }
      case 'peace': {
        flushRound()
        isRevoteRound = false
        result.push(s)
        break
      }
      case 'vote':
      case 'multiVote': {
        round.push(s)
        break
      }
      default: {
        if (round.length > 0) {
          round.push(s)
        } else {
          result.push(s)
        }
        break
      }
    }
  }

  flushRound()
  return result
}

function fillMediumTargets(statements: Statement[]): Statement[] {
  const dict = new FlexibleDictionary()
  const claimedMediums = new Set<string>()
  // 日付→処刑対象名のマップ
  const lynchByDay = new Map<number, string>()
  let seatIdx = 0

  // First pass: collect join names, medium claimants, lynch-by-day
  for (const s of statements) {
    if (s.type === 'join') {
      const js = s as JoinStatement
      seatIdx++
      registerJoinInDict(dict, js.name, js.aliases, seatIdx)
    } else if (s.type === 'joinMulti') {
      for (const p of (s as JoinMultiStatement).players) {
        seatIdx++
        registerJoinInDict(dict, p, [], seatIdx)
      }
    } else if (s.type === 'lynch') {
      const target = (s as LynchStatement).target
      if (target && s.day != null) {
        lynchByDay.set(s.day, resolveName(dict, target))
      }
    } else if (s.type === 'assert') {
      const st = s as AssertStatement
      if (st.assertions.some(a => a.roles?.includes('medium'))) {
        claimedMediums.add(resolveName(dict, st.actor))
      }
    }
  }

  if (claimedMediums.size === 0 || lynchByDay.size === 0) return statements

  // Second pass: fill missing targets for medium result assertions
  // 右詰め方式: 各文の結果数に応じて right-align し、対応するナイトの処刑者を割り当てる
  return statements.map(s => {
    if (s.type !== 'assert') return s
    const st = s as AssertStatement
    const actorResolved = resolveName(dict, st.actor)
    if (!claimedMediums.has(actorResolved)) return s

    const day = st.day
    if (day == null) return s

    // この文内の占い/霊能結果（ターゲット有無問わず）を数える（右詰め位置計算用）
    const divResults: number[] = []
    for (let i = 0; i < st.assertions.length; i++) {
      const a = st.assertions[i]
      if (a.roles || a.action === 'guard') continue
      if (!a.result) continue
      divResults.push(i)
    }
    if (divResults.length === 0) return s

    let changed = false
    const lastNight = day - 1
    const newAssertions = st.assertions.map((a, idx) => {
      if (a.roles || a.action === 'guard') return a
      if (!a.result) return a
      if (a.target) return a

      // この結果の右詰め位置を計算
      const posInDiv = divResults.indexOf(idx)
      const night = lastNight - (divResults.length - 1 - posInDiv)
      const target = lynchByDay.get(night)
      if (target) {
        changed = true
        return { ...a, target }
      }
      return a
    })
    if (!changed) return s
    return { ...st, assertions: newAssertions }
  })
}

// "actor delimiter target" pattern for bare guard targets
const bareGuardRegex = new RegExp(
  `^${V.optionalSpace}(?<actor>${V.possibleName})${V.delimiter}${V.optionalSpace}(?<target>${V.possibleName})${V.optionalSpace}$`
)

function fillBodyguardGuards(statements: Statement[]): Statement[] {
  const dict = new FlexibleDictionary()
  const bodyguardClaimants = new Set<string>()
  let seatIdx = 0

  for (const s of statements) {
    if (s.type === 'join') {
      const js = s as JoinStatement
      seatIdx++
      registerJoinInDict(dict, js.name, js.aliases, seatIdx)
    } else if (s.type === 'joinMulti') {
      for (const p of (s as JoinMultiStatement).players) {
        seatIdx++
        registerJoinInDict(dict, p, [], seatIdx)
      }
    } else if (s.type === 'assert') {
      const st = s as AssertStatement
      if (st.assertions.some(a => a.roles?.includes('bodyguard'))) {
        bodyguardClaimants.add(resolveName(dict, st.actor))
      }
    }
  }

  if (bodyguardClaimants.size === 0) return statements

  return statements.map(s => {
    if (s.type !== 'unknown') return s
    const match = bareGuardRegex.exec((s as UnknownStatement).text)
    if (!match || !match.groups) return s
    const actorResolved = resolveName(dict, match.groups.actor)
    if (!bodyguardClaimants.has(actorResolved)) return s
    return {
      type: 'assert',
      line: s.line,
      day: s.day,
      actor: match.groups.actor,
      assertions: [{ player: match.groups.actor, target: match.groups.target, action: 'guard' }],
    } as AssertStatement
  })
}

const survivorsRegex = new RegExp(`^${V.survivors}$`)

function expandSurvivorAsserts(statements: Statement[]): Statement[] {
  const alive = new Set<string>()
  const dict = new FlexibleDictionary()
  const result: Statement[] = []
  let seatIdx = 0

  for (const s of statements) {
    switch (s.type) {
      case 'join': {
        const js = s as JoinStatement
        seatIdx++
        alive.add(js.name)
        registerJoinInDict(dict, js.name, js.aliases, seatIdx)
        result.push(s)
        break
      }
      case 'joinMulti': {
        for (const p of (s as JoinMultiStatement).players) {
          seatIdx++
          alive.add(p)
          registerJoinInDict(dict, p, [], seatIdx)
        }
        result.push(s)
        break
      }
      case 'lynch': {
        result.push(s)
        const target = (s as LynchStatement).target
        if (target) alive.delete(resolveName(dict, target))
        break
      }
      case 'attack': {
        for (const t of (s as AttackStatement).target) {
          alive.delete(resolveName(dict, t))
        }
        result.push(s)
        break
      }
      case 'curse': {
        alive.delete(resolveName(dict, (s as CurseStatement).target))
        result.push(s)
        break
      }
      case 'follow': {
        alive.delete(resolveName(dict, (s as FollowStatement).target))
        result.push(s)
        break
      }
      case 'assert': {
        const st = s as AssertStatement
        if (survivorsRegex.test(st.actor)) {
          for (const player of alive) {
            const assertions = st.assertions.map(a => ({ ...a, player }))
            result.push({ ...st, actor: player, assertions } as AssertStatement)
          }
        } else {
          result.push(s)
        }
        break
      }
      default:
        result.push(s)
        break
    }
  }

  return result
}

function assignDays(statements: Statement[]): Statement[] {
  let day = 1
  let inNight = false
  return statements.map(s => {
    if (s.type === 'attack' || s.type === 'peace') {
      if (!inNight) {
        day++
        inNight = true
      }
      return { ...s, day }
    }
    // follow/curse は夜イベントの一部なので inNight をリセットしない
    if (s.type !== 'follow' && s.type !== 'curse') {
      inNight = false
    }
    return { ...s, day }
  })
}

function applySetupStatements(meta: any, statements: Statement[]): Statement[] {
  let lastSetup: SetupStatement | null = null
  for (const s of statements) {
    if (s.type === 'setup') lastSetup = s as SetupStatement
  }
  if (lastSetup) {
    meta.setup = lastSetup.roles
  }
  return statements.filter(s => s.type !== 'setup')
}

function computeSetupTotal(meta: any): number {
  const setup = meta?.setup
  if (!setup || typeof setup !== 'object') return 0
  let total = 0
  for (const k of Object.keys(setup)) {
    const v = setup[k]
    if (typeof v === 'number' && v > 0) total += v
  }
  return total
}

function countJoinPlayers(statements: Statement[]): number {
  let count = 0
  for (const s of statements) {
    if (s.type === 'join') count++
    else if (s.type === 'joinMulti') count += (s as JoinMultiStatement).players.length
  }
  return count
}

function hasJoinStatement(statements: Statement[]): boolean {
  return statements.some(s => s.type === 'join' || s.type === 'joinMulti')
}

function collectPlayerRefs(s: Statement): string[] {
  switch (s.type) {
    case 'vote': { const x = s as VoteStatement; return [x.voter, x.target] }
    case 'multiVote': { const x = s as MultiVoteStatement; return [...x.voters, x.target] }
    case 'attack': return (s as AttackStatement).target
    case 'lynch': { const t = (s as LynchStatement).target; return t ? [t] : [] }
    case 'curse': return [(s as CurseStatement).target]
    case 'follow': return [(s as FollowStatement).target]
    case 'forecast': { const x = s as ForecastStatement; return [x.actor, x.target] }
    case 'suddenDeath': return [(s as SuddenDeathStatement).target]
    case 'revote': return (s as RevoteStatement).targets
    case 'reveal': return [(s as RevealStatement).player]
    case 'spoiler': return [(s as SpoilerStatement).player]
    case 'mason': return (s as MasonStatement).players
    case 'assert': {
      const x = s as AssertStatement
      const out: string[] = [x.actor]
      for (const a of x.assertions) {
        if (a.player) out.push(a.player)
        if (a.target) out.push(a.target)
      }
      return out
    }
    default: return []
  }
}

function containsSeatNumberReference(statements: Statement[]): boolean {
  for (const s of statements) {
    for (const ref of collectPlayerRefs(s)) {
      if (seatNumberRegex.test(ref)) return true
    }
  }
  return false
}

// JOIN 文がない .howl で setup から仮想プレイヤー (プレイヤー1..N) を合成し、
// あるいは座席数の不整合を warnings に追加する。
function synthesizeJoinsAndValidate(meta: any, statements: Statement[]): Statement[] {
  if (!Array.isArray(meta.warnings)) meta.warnings = []

  const hasJoin = hasJoinStatement(statements)
  const setupTotal = computeSetupTotal(meta)

  if (!hasJoin) {
    if (setupTotal === 0) {
      if (containsSeatNumberReference(statements)) {
        throw new Error('Howl parse error: 数字席番号が使われていますが、setup も JOIN も指定されていません')
      }
      return statements
    }
    const players: string[] = []
    for (let i = 1; i <= setupTotal; i++) players.push(`${SYNTHESIZED_PLAYER_PREFIX}${i}`)
    const synthesized: JoinMultiStatement = { type: 'joinMulti', line: 0, players }
    return [synthesized, ...statements]
  }

  if (setupTotal > 0) {
    const joinCount = countJoinPlayers(statements)
    if (joinCount > setupTotal) {
      meta.warnings.push(`JOIN 数 (${joinCount}) が setup 合計 (${setupTotal}) を超えています`)
    } else if (joinCount < setupTotal) {
      meta.warnings.push(`JOIN 数 (${joinCount}) が setup 合計 (${setupTotal}) より少ないです`)
    }
  }
  return statements
}

export function parse(text: string, options: ParseOptions = {}): { meta: any, statements: Statement[] } {
  const { meta, lines }: { meta: any; lines: Line[] } = preprocess(text, options.cursorLine)
  const mergedOptions: ParseOptions = {
    ...options,
    rules: { ...meta?.rules, ...options.rules },
  }
  let statements: Statement[] = []

  for (const line of lines) {
    const { number, content } = line
    try {
      const statement = parseStatement( content, number )
      statements.push(statement)
    } catch (error) {
      console.error(`Error parsing line ${number}: ${content}`, error)
    }
  }

  statements = applySetupStatements(meta, statements)
  statements = synthesizeJoinsAndValidate(meta, statements)
  statements = fillMultiVoteVoters(statements, mergedOptions)
  statements = expandSurvivorAsserts(statements)
  statements = assignDays(statements)
  statements = fillMediumTargets(statements)
  statements = fillBodyguardGuards(statements)

  return { meta, statements }
}
