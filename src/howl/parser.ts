import { preprocess, type Line } from './preprocess.ts'
import {
  parseStatement,
  type Statement,
  type JoinStatement,
  type VoteStatement,
  type MultiVoteStatement,
  type AttackStatement,
  type LynchStatement,
  type CurseStatement,
  type FollowStatement,
  type AssertStatement,
} from './statement.ts'
import { FlexibleDictionary } from './flexibleDictionary.ts'

export type ParseOptions = {
  rules?: Record<string, any>
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

  function flushRound() {
    if (round.length > 0) {
      result.push(...fillRound(round, alive, dict, isRevoteRound, options))
      round = []
    }
  }

  for (const s of statements) {
    switch (s.type) {
      case 'join': {
        const players = (s as JoinStatement).players
        for (let i = 0; i < players.length; i++) {
          alive.add(players[i])
          dict.add(players[i], [players[i]])
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
  const lynchTargets: string[] = []
  const claimedMediums = new Set<string>()

  // First pass: collect join names, lynch targets, and medium claimants
  for (const s of statements) {
    if (s.type === 'join') {
      for (const p of (s as JoinStatement).players) {
        dict.add(p, [p])
      }
    } else if (s.type === 'lynch') {
      const target = (s as LynchStatement).target
      if (target) {
        lynchTargets.push(resolveName(dict, target))
      }
    } else if (s.type === 'assert') {
      const st = s as AssertStatement
      if (st.assertions.some(a => a.roles?.includes('medium'))) {
        claimedMediums.add(resolveName(dict, st.actor))
      }
    }
  }

  if (claimedMediums.size === 0 || lynchTargets.length === 0) return statements

  // Second pass: fill missing targets for medium result assertions
  const mediumResultCount = new Map<string, number>()
  return statements.map(s => {
    if (s.type !== 'assert') return s
    const st = s as AssertStatement
    const actorResolved = resolveName(dict, st.actor)
    if (!claimedMediums.has(actorResolved)) return s

    let count = mediumResultCount.get(actorResolved) ?? 0
    let changed = false
    const newAssertions = st.assertions.map(a => {
      if (a.roles || a.action === 'guard') return a
      if (!a.result) return a

      if (a.target) {
        count++
        return a
      }

      // No target + has result + actor is medium → fill from lynch history
      const lynchIndex = count
      count++
      if (lynchIndex < lynchTargets.length) {
        changed = true
        return { ...a, target: lynchTargets[lynchIndex] }
      }
      return a
    })
    mediumResultCount.set(actorResolved, count)
    if (!changed) return s
    return { ...st, assertions: newAssertions }
  })
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
    inNight = false
    return { ...s, day }
  })
}

export function parse(text: string, options: ParseOptions = {}): { meta: any, statements: Statement[] } {
  const { meta, lines }: { meta: any; lines: Line[] } = preprocess(text)
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

  statements = fillMultiVoteVoters(statements, mergedOptions)
  statements = fillMediumTargets(statements)
  statements = assignDays(statements)

  return { meta, statements }
}
