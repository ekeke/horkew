import { preprocess, type Line } from './preprocess.ts'
import {
  parseStatement,
  type Statement,
  type JoinStatement,
  type VoteStatement,
  type MultiVoteStatement,
  type AttackStatement,
  type LynchStatement,
} from './statement.ts'
import { FlexibleDictionary } from './flexibleDictionary.ts'

export type ParseOptions = {
  revoteCandidatesCanVote?: boolean
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

  // In revote rounds (default), candidates cannot vote
  const excludedFull = new Set(explicitFull)
  if (isRevoteRound && !options.revoteCandidatesCanVote) {
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
        result.push(s)
        break
      }
    }
  }

  flushRound()
  return result
}

export function parse(text: string, options: ParseOptions = {}): { meta: any, statements: Statement[] } {
  const { meta, lines }: { meta: any; lines: Line[] } = preprocess(text)
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

  statements = fillMultiVoteVoters(statements, options)

  return { meta, statements }
}
