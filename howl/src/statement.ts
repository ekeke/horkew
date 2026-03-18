import * as V from './vocabulary.ts'

export type StatementType = 'join' | 'vote' | 'multiVote' | 'attack' | 'lynch' | 'revote' | 'over' | 'assert' | 'peace' | 'reveal' | 'unknown'

export type GameResult = 'villageWin' | 'wolfWin' | 'hamsterWin' | 'draw'
export type Species = 'isHuman' | 'isWolf'
export type Role = 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata' | 'nonVillage'

// Todo: More strict for omit variations.
export type Assertion = {
  player: string
  target?: string
  roles?: Role[]
  result?: Species
  action?: 'guard'
}

export type Statement = {
    type: StatementType  // Type of statement (e.g., 'join', 'vote', etc.)
    line: number  // Line number in the source code where the statement appears
}

export type JoinStatement = Statement & {
    type: 'join'  // Type of statement (e.g., 'join')
    players: string[]  // Player's name
}

export type VoteStatement = Statement & {
    type: 'vote'  // Type of statement (e.g., 'vote')
    voter: string  // Player's name
    target: string  // Target player's name
}

export type MultiVoteStatement = Statement & {
    type: 'multiVote'  // Type of statement (e.g., 'multiVote')
    voters: string[]  // Array of players' names
    target: string  // Target player's name
}

export type AttackStatement = Statement & {
    type: 'attack'  // Type of statement (e.g., 'attack')
    target: string[]  // Target player's names (it could be multiple)
}

export type LynchStatement = Statement & {
    type: 'lynch'  // Type of statement (e.g., 'lynch')
    target: string  // Target player's name
}

export type RevoteStatement = Statement & {
    type: 'revote'  // Type of statement (e.g., 'revote')
    targets: string[]  // Target player's names (If it's final vote, it could be multiple)
}

export type OverStatement = Statement & {
    type: 'over'  // Type of statement (e.g., 'over')
    result: GameResult  // Result of the game
}

export type AssertStatement = Statement & {
    type: 'assert'  // Type of statement (e.g., 'assert')
    actor: string  // Name of the player making the assertion
    assertions: Assertion[]  // Array of assertions made by the player
}

export type PeaceStatement = Statement & {
    type: 'peace'
}

export type RevealStatement = Statement & {
    type: 'reveal'
    player: string
    role: string
}

export type UnknownStatement = Statement & {
    type: 'unknown'
    text: string
}

// Join statement: +John, Curt,...
const joinRegex = new RegExp(`^${V.optionalSpace}${V.plus}`)
export function parseJoinStatement(text: string, line: number): JoinStatement | null {
  const match = joinRegex.test(text)
  if (!match) return null
  text = text.replace(joinRegex, '') // Remove the + from the text
  const players = text.split(new RegExp(`(?:${V.delimiter})+?`)).map((player) => player.trim()).filter((player) => player.length > 0)
  return {
    type: 'join',
    line,
    players,
  }
}

// Vote statement: John -> Bob
const voteRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})${V.optionalSpace}${V.rightArrow}${V.optionalSpace}(${V.possibleName})${V.optionalSpace}$`)
export function parseVoteStatement(text: string, line: number): VoteStatement | null {
  const match = voteRegex.exec(text)
  if (!match) return null
  const voter = match[1].trim()
  const target = match[2].trim()
  return {
    type: 'vote',
    line,
    voter,
    target,
  }
}

// MultiVote statement: John <- Alice, Bob, Charlie
const multiVoteRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})${V.optionalSpace}${V.leftArrow}${V.optionalSpace}(${V.possibleName}(?:${V.optionalSpace}${V.delimiter}${V.possibleName})*)${V.optionalSpace}$`)

export function parseMultiVoteStatement(text: string, line: number): MultiVoteStatement | null {
  const match = multiVoteRegex.exec(text)
  if (!match) return null
  const target = match[1].trim()
  const voters = match[2].split(new RegExp(`(?:${V.delimiter})+?`)).map((voter) => voter.trim()).filter((voter) => voter.length > 0)
  return {
    type: 'multiVote',
    line,
    voters,
    target,
  }
}

export function parseAttackStatement(text: string, line: number): AttackStatement | null {
  const attackRegex = new RegExp(`^${V.optionalSpace}${V.attack}${V.delimiter}(${V.possibleName}(?:${V.optionalSpace}${V.delimiter}${V.possibleName})*)${V.optionalSpace}$`)
  const match = attackRegex.exec(text)
  if (match) {
    const targets = match[1].split(new RegExp(`(?:${V.delimiter})+?`)).map((target) => target.trim()).filter((target) => target.length > 0)
    return { type: 'attack', line, target: targets }
  }
  // Reverse pattern: target+attack (e.g. 星噛)
  const reverseRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})${V.attack}${V.optionalSpace}$`)
  const reverseMatch = reverseRegex.exec(text)
  if (!reverseMatch) return null
  return { type: 'attack', line, target: [reverseMatch[1].trim()] }
}

export function parsePeaceStatement(text: string, line: number): PeaceStatement | null {
  const peaceRegex = new RegExp(`^${V.optionalSpace}${V.peace}${V.optionalSpace}$`)
  if (!peaceRegex.test(text)) return null
  return { type: 'peace', line }
}

export function parseRevealStatement(text: string, line: number): RevealStatement | null {
  const revealRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})${V.equal}(${V.anyRole})${V.optionalSpace}$`)
  const match = revealRegex.exec(text)
  if (!match) return null
  return { type: 'reveal', line, player: match[1].trim(), role: match[2].trim() }
}

export function parseLynchStatement(text: string, line: number): LynchStatement | null {
  const lynchRegex = new RegExp(`^${V.optionalSpace}${V.lynch}${V.delimiter}(${V.possibleName})${V.optionalSpace}$`)
  const match = lynchRegex.exec(text)
  if (!match) return null
  const target = match[1].trim()
  return {
    type: 'lynch',
    line,
    target,
  }
}

export function parseRevoteStatement(text: string, line: number): RevoteStatement | null {
  const revoteRegex = new RegExp(`^${V.optionalSpace}${V.revote}((?:${V.optionalSpace}${V.delimiter}${V.possibleName})*)?${V.optionalSpace}$`)
  const match = revoteRegex.exec(text)
  if (!match) return null
  const targets = match[1]?.split(new RegExp(`(?:${V.delimiter})+?`)).map((target) => target.trim()).filter((target) => target.length > 0)
  return {
    type: 'revote',
    line,
    targets: targets || [], // If no targets are specified, return an empty array
  }
}

export function parseOverStatement(text: string, line: number): OverStatement | null {
  const overRegex = new RegExp(`^${V.optionalSpace}(?:${V.win}(?:${V.delimiter})?(${V.anyAlignment})|(${V.anyAlignment})(?:${V.delimiter})?${V.win}|(${V.draw}))${V.optionalSpace}$`)
  const match = overRegex.exec(text)
  if (!match) return null
  const resultText = (match[1] || match[2] || match[3]).trim()
  const result = new RegExp(V.village).test(resultText) ? 'villageWin'
               : new RegExp(V.wolf).test(resultText)    ? 'wolfWin'
               : new RegExp(V.hamster).test(resultText) ? 'hamsterWin'
               :                                          'draw'
  return {
    type: 'over',
    line,
    result,
  }
}

export function parseMasonStatement(text: string, line: number): AssertStatement | null {
  const masonRegex = new RegExp(`^${V.optionalSpace}${V.mason}${V.delimiter}(${V.possibleName}(?:${V.optionalSpace}${V.delimiter}${V.possibleName})*)${V.optionalSpace}$`)
  const match = masonRegex.exec(text)
  if (!match) return null
  const players = match[1].split(new RegExp(`(?:${V.delimiter})+?`)).map(p => p.trim()).filter(p => p.length > 0)
  const assertions: Assertion[] = players.map(player => ({ player, roles: ['mason'] as Role[] }))
  return { type: 'assert', line, actor: players[0], assertions }
}

const historyRegexText = [
  `(?:(?<day>${V.dayNumber})${V.dayUnit})?`,
  `(?:${V.optionalSpace})?`,
  `(?<target>${V.possibleName})?`,
  `(?:${V.optionalSpace})?`,
  `(?<action>${V.race}|${V.guard})`,
].join('')

const assertRegex = new RegExp([
  `^${V.optionalSpace}(?<actor>${V.possibleName})${V.delimiter}${V.optionalSpace}`,
  `(?<claim>(?:${V.anyRole})+${V.claim})?`,
  `${V.optionalSpace}`,
  `(?<history>(?:`,
    `(?:${V.optionalSpace}${V.delimiter})?`,
    `${historyRegexText}`,
  `)*?)?`,
  `${V.optionalSpace}$`
].join(''))

const historyRegex = new RegExp(historyRegexText, 'g')

function extractRoles(claim: string): Role[] {
  const roleMap: [RegExp, Role][] = [
    [new RegExp(V.seer), 'seer'],
    [new RegExp(V.medium), 'medium'],
    [new RegExp(V.bodyguard), 'bodyguard'],
    [new RegExp(V.mason), 'mason'],
    [new RegExp(V.nekomata), 'nekomata'],
  ]
  const roles: Role[] = []
  for (const [regex, role] of roleMap) {
    if (regex.test(claim)) roles.push(role)
  }
  return roles.length > 0 ? roles : ['nonVillage']
}

export function parseAssertStatement(text: string, line: number): AssertStatement | null {
  const match = assertRegex.exec(text)
  if (!match || !match.groups || !match.groups.actor) return null
  const actor = match.groups.actor
  const claim = match.groups?.claim ?? undefined
  const assertions: Assertion[] = []

  if (claim) {
    const roles = extractRoles(claim)
    assertions.push({ player: actor, roles })
  }

  const history = match.groups?.history ?? undefined
  if (history) {
    for (const m of history.matchAll(historyRegex)) {
      if (!m.groups) continue
      const target = m.groups.target ?? undefined
      const actionText = m.groups.action
      const assertion: Assertion = { player: actor }
      if (target) assertion.target = target
      if (new RegExp(V.guard).test(actionText)) {
        assertion.action = 'guard'
      } else {
        assertion.result = new RegExp(V.isWolf).test(actionText) ? 'isWolf' : 'isHuman'
      }
      assertions.push(assertion)
    }
  }

  return { type: 'assert', line, actor, assertions }
}

export function parseStatement (text: string, line: number): Statement {
  const parsers = [
    parseJoinStatement,
    parseVoteStatement,
    parseMultiVoteStatement,
    parseAttackStatement,
    parseLynchStatement,
    parseRevoteStatement,
    parseOverStatement,
    parsePeaceStatement,
    parseMasonStatement,
    parseAssertStatement,
    parseRevealStatement,
  ]

  for (const parser of parsers) {
    const result = parser(text, line)
    if (result) return result
  }

  return {
    type: 'unknown',
    line,
    text,
  } as UnknownStatement
}
