import * as V from './vocabulary.ts'
import { systemRoles, type SystemRole } from '../types/index.ts'

export type StatementType = 'setup' | 'join' | 'joinMulti' | 'vote' | 'multiVote' | 'attack' | 'lynch' | 'suddenDeath' | 'grelan' | 'curse' | 'follow' | 'forecast' | 'revote' | 'over' | 'assert' | 'mason' | 'peace' | 'dayMark' | 'reveal' | 'spoiler' | 'speech' | 'videoSource' | 'timestamp' | 'unknown'

export type GameResult = 'villageWin' | 'wolfWin' | 'hamsterWin' | 'draw'
export type Species = 'isHuman' | 'isWolf' | 'isKogitsune'
export type Role = 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata' | 'nonVillage'

// Todo: More strict for omit variations.
export type Assertion = {
  player: string
  target?: string
  roles?: Role[]
  negative?: boolean
  result?: Species
  action?: 'guard'
  /** 結果が属する夜番号 (0-indexed). 占い結果の日付表記 (例: `1D target○`) のソースになる. */
  day?: number
}

export type Statement = {
    type: StatementType  // Type of statement (e.g., 'join', 'vote', etc.)
    line: number  // Line number in the source code where the statement appears
    day?: number  // Day number assigned during post-processing
    timestamp?: number  // Inline @MM:SS annotation (seconds)
}

export type JoinStatement = Statement & {
    type: 'join'
    name: string
    shortName?: string
    aliases: string[]
}

export type JoinMultiStatement = Statement & {
    type: 'joinMulti'
    players: string[]
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
    target: string | null  // Target player's name, null if no execution
}

export type SuddenDeathStatement = Statement & {
    type: 'suddenDeath'
    target: string
    reason: string
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

export type MasonStatement = Statement & {
    type: 'mason'
    players: string[]
}

export type PeaceStatement = Statement & {
    type: 'peace'
}

export type DayMarkStatement = Statement & {
    type: 'dayMark'
    // 進行先の target day (1-indexed). assignDays が `day` を確定する.
    day: number
    // assignDays が「現在 day < target」で実際に day を進めたかを記録.
    // 同一 day への dayMark (no-op) と区別するため bridge / events-bridge が参照.
    advanced?: boolean
}

export type RevealStatement = Statement & {
    type: 'reveal'
    player: string
    role: string
}

export type SpoilerAction = 'divine' | 'guard' | 'attack'

export type SpoilerStatement = Statement & {
    type: 'spoiler'
    player: string
    // 役職 pin と秘匿行動はどちらか一方が入る。
    role?: string
    // 秘匿行動 (例: !Alice 1夜 占い Bob) の対象夜番号 (1-indexed)。
    // Statement 基底の進行 day と同じ field 名だが、assignDays は
    // spoiler 文を skip するため進行 day で上書きされない。
    day?: number
    action?: SpoilerAction
    target?: string
}

export type SpeechStatement = Statement & {
    type: 'speech'
    actor: string
    text: string
}

export type CurseStatement = Statement & {
    type: 'curse'
    target: string
}

export type FollowStatement = Statement & {
    type: 'follow'
    target: string
}

export type ForecastStatement = Statement & {
    type: 'forecast'
    actor: string
    target: string
}

export type GrelanStatement = Statement & {
    type: 'grelan'
}

export type SetupStatement = Statement & {
    type: 'setup'
    roles: Record<string, number>
}

export type VideoSourceStatement = Statement & {
    type: 'videoSource'
    url: string
}

export type TimestampStatement = Statement & {
    type: 'timestamp'
    seconds: number
    raw: string
}

export type UnknownStatement = Statement & {
    type: 'unknown'
    text: string
}

// Quote-aware token splitter for join statements
// Splits on delimiters (comma, space, etc.) but respects quoted strings
// Quote families: any member opens, any member of the same family closes
const doubleQuotes = new Set(['"', '\u201C', '\u201D', '\uFF02'])
const singleQuotes = new Set(["'", '\u2018', '\u2019', '\uFF07'])
function getQuoteFamily(ch: string): Set<string> | undefined {
  if (doubleQuotes.has(ch)) return doubleQuotes
  if (singleQuotes.has(ch)) return singleQuotes
  return undefined
}
const delimiterRegex = new RegExp(`^(?:${V.delimiter})+`)

function splitTokens(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    // Skip delimiters
    const rest = text.slice(i)
    const delimMatch = delimiterRegex.exec(rest)
    if (delimMatch) {
      i += delimMatch[0].length
      continue
    }
    // Start of a token
    let token = ''
    while (i < text.length) {
      const ch = text[i]
      const family = getQuoteFamily(ch)
      if (family) {
        // Quoted segment: consume until any quote in the same family
        i++ // skip opening quote
        let end = -1
        for (let j = i; j < text.length; j++) {
          if (family.has(text[j])) { end = j; break }
        }
        if (end === -1) {
          token += text.slice(i)
          i = text.length
        } else {
          token += text.slice(i, end)
          i = end + 1
        }
      } else if (delimiterRegex.test(text.slice(i))) {
        break // delimiter reached, end of token
      } else {
        token += ch
        i++
      }
    }
    if (token.length > 0) tokens.push(token)
  }
  return tokens
}

// JoinMulti statement: ++John, Curt,...
const joinMultiRegex = new RegExp(`^${V.optionalSpace}${V.plus}${V.plus}`)
export function parseJoinMultiStatement(text: string, line: number): JoinMultiStatement | null {
  const match = joinMultiRegex.test(text)
  if (!match) return null
  text = text.replace(joinMultiRegex, '')
  const players = splitTokens(text)
  return {
    type: 'joinMulti',
    line,
    players,
  }
}

// Join statement (single player): +Alice(Al), アリス
const joinRegex = new RegExp(`^${V.optionalSpace}${V.plus}`)
const shortNameRegex = /[（(]([^）)]+)[）)]\s*$/
export function parseJoinStatement(text: string, line: number): JoinStatement | null {
  if (joinMultiRegex.test(text)) return null
  if (!joinRegex.test(text)) return null
  text = text.replace(joinRegex, '')
  const tokens = splitTokens(text)
  if (tokens.length === 0) return null
  let nameToken = tokens[0]
  let shortName: string | undefined
  const shortMatch = shortNameRegex.exec(nameToken)
  if (shortMatch) {
    shortName = shortMatch[1]
    nameToken = nameToken.slice(0, shortMatch.index).trim()
  }
  return {
    type: 'join',
    line,
    name: nameToken,
    ...(shortName !== undefined && { shortName }),
    aliases: tokens.slice(1),
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
const multiVoteRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})${V.optionalSpace}${V.leftArrow}${V.optionalSpace}(${V.possibleName}(?:${V.optionalSpace}${V.delimiter}${V.possibleName})*)?${V.optionalSpace}$`)

export function parseMultiVoteStatement(text: string, line: number): MultiVoteStatement | null {
  const match = multiVoteRegex.exec(text)
  if (!match) return null
  const target = match[1].trim()
  const voters = match[2] ? match[2].split(new RegExp(`(?:${V.delimiter})+?`)).map((voter) => voter.trim()).filter((voter) => voter.length > 0) : []
  return {
    type: 'multiVote',
    line,
    voters,
    target,
  }
}

export function parseAttackStatement(text: string, line: number): AttackStatement | null {
  const attackRegex = new RegExp(`^${V.optionalSpace}${V.attack}(?:${V.delimiter})?${V.optionalSpace}(${V.possibleName}(?:${V.optionalSpace}${V.delimiter}${V.possibleName})*)${V.optionalSpace}$`)
  const match = attackRegex.exec(text)
  if (match) {
    const targets = match[1].split(new RegExp(`(?:${V.delimiter})+?`)).map((target) => target.trim()).filter((target) => target.length > 0)
    return { type: 'attack', line, target: targets }
  }
  // Reverse pattern: target+attack (e.g. 星噛)
  const reverseRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})(?:${V.delimiter})?${V.optionalSpace}${V.attack}${V.optionalSpace}$`)
  const reverseMatch = reverseRegex.exec(text)
  if (!reverseMatch) return null
  return { type: 'attack', line, target: [reverseMatch[1].trim()] }
}

export function parsePeaceStatement(text: string, line: number): PeaceStatement | null {
  const peaceRegex = new RegExp(`^${V.optionalSpace}${V.peace}${V.optionalSpace}$`)
  if (!peaceRegex.test(text)) return null
  return { type: 'peace', line }
}

// DayMark statement: `Day 2:` (ASCII) / `2日目:` (Japanese)
// 進行 day を明示的に target に前進する section marker. assignDays が target を読んで day を進める.
// 末尾のコロン (半角/全角) を必須にして seer 結果 (`1日目 Bob白`) や comment との曖昧性を回避.
const dayMarkAsciiRegex = new RegExp(`^${V.optionalSpace}[dDｄＤ][aAａＡ][yYｙＹ]${V.whiteSpaces}(${V.dayNumber})${V.optionalSpace}[:：]${V.optionalSpace}$`)
const dayMarkJapaneseRegex = new RegExp(`^${V.optionalSpace}(${V.dayNumber})${V.dayUnit}${V.optionalSpace}[:：]${V.optionalSpace}$`)
export function parseDayMarkStatement(text: string, line: number): DayMarkStatement | null {
  const ascii = dayMarkAsciiRegex.exec(text)
  if (ascii) return { type: 'dayMark', line, day: Number(ascii[1]) }
  const ja = dayMarkJapaneseRegex.exec(text)
  if (ja) return { type: 'dayMark', line, day: Number(ja[1]) }
  return null
}

export function parseRevealStatement(text: string, line: number): RevealStatement | null {
  const revealRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})${V.equal}(${V.anyRole})${V.optionalSpace}$`)
  const match = revealRegex.exec(text)
  if (!match) return null
  return { type: 'reveal', line, player: match[1].trim(), role: match[2].trim() }
}

// Spoiler statement: !Alice=seer / ！アリス＝占い / !Alice=狼陣営
// 視点配信での正体メモ、および retar 解析時の仮定（assumption）として使われる。
// 右辺は単一役職 (assumption pin) または faction alias (役職集合 deny) のいずれか。
const spoilerRegex = new RegExp(`^[!！]${V.optionalSpace}(${V.possibleName})${V.optionalSpace}${V.equal}${V.optionalSpace}(${V.anyRole}|${V.anyFactionAlias})${V.optionalSpace}$`)
// Spoiler action statement: !Alice 1夜 占い Bob
// プレイヤーの秘匿夜行動 (公開発言とは独立)。lupa engine 駆動テストで使う。
const spoilerActionRegex = new RegExp(
  `^[!！]${V.optionalSpace}(${V.possibleName})${V.optionalSpace}(\\d+)夜${V.optionalSpace}(占い?|護衛|襲撃|divine|guard|attack)${V.optionalSpace}(${V.possibleName})${V.optionalSpace}$`
)
const spoilerActionMap: Record<string, SpoilerAction> = {
  '占い': 'divine', '占': 'divine', 'divine': 'divine',
  '護衛': 'guard', 'guard': 'guard',
  '襲撃': 'attack', 'attack': 'attack',
}
export function parseSpoilerStatement(text: string, line: number): SpoilerStatement | null {
  const rm = spoilerRegex.exec(text)
  if (rm) {
    return { type: 'spoiler', line, player: rm[1].trim(), role: rm[2].trim() }
  }
  const am = spoilerActionRegex.exec(text)
  if (am) {
    const action = spoilerActionMap[am[3].trim()]
    if (!action) return null
    return {
      type: 'spoiler', line,
      player: am[1].trim(),
      day: Number(am[2]),
      action,
      target: am[4].trim(),
    }
  }
  return null
}

// Speech statement: アリス > こんにちは / Alice ＞ hello
const speechRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})${V.optionalSpace}${V.speechArrow}(.*)$`)
export function parseSpeechStatement(text: string, line: number): SpeechStatement | null {
  const match = speechRegex.exec(text)
  if (!match) return null
  const content = match[2].trim()
  if (content.length === 0) return null
  return { type: 'speech', line, actor: match[1].trim(), text: content }
}

export function parseGrelanStatement(text: string, line: number): GrelanStatement | null {
  const grelanRegex = new RegExp(`^${V.optionalSpace}${V.grelan}${V.optionalSpace}$`)
  if (!grelanRegex.test(text)) return null
  return { type: 'grelan', line }
}

export function parseLynchStatement(text: string, line: number): LynchStatement | null {
  const noLynchRegex = new RegExp(`^${V.optionalSpace}${V.lynch}${V.none}${V.optionalSpace}$`)
  if (noLynchRegex.test(text)) {
    return { type: 'lynch', line, target: null }
  }
  const lynchRegex = new RegExp(`^${V.optionalSpace}${V.lynch}(?:${V.delimiter})?${V.optionalSpace}(${V.possibleName})${V.optionalSpace}$`)
  const match = lynchRegex.exec(text)
  if (match) return { type: 'lynch', line, target: match[1].trim() }
  // Reverse pattern: target+lynch (e.g. ボブ吊り)
  const reverseRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})(?:${V.delimiter})?${V.optionalSpace}${V.lynch}${V.optionalSpace}$`)
  const reverseMatch = reverseRegex.exec(text)
  if (!reverseMatch) return null
  return { type: 'lynch', line, target: reverseMatch[1].trim() }
}

export function parseSuddenDeathStatement(text: string, line: number): SuddenDeathStatement | null {
  const suddenDeathRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})${V.optionalSpace}${V.suddenDeath}(?:[（(]([^）)\\n]*)[）)])?${V.optionalSpace}$`)
  const match = suddenDeathRegex.exec(text)
  if (!match) return null
  return {
    type: 'suddenDeath',
    line,
    target: match[1].trim(),
    reason: (match[2] ?? '').trim(),
  }
}

export function parseCurseStatement(text: string, line: number): CurseStatement | null {
  const curseRegex = new RegExp(`^${V.optionalSpace}${V.curse}(?:${V.delimiter})?${V.optionalSpace}(${V.possibleName})${V.optionalSpace}$`)
  const match = curseRegex.exec(text)
  if (match) return { type: 'curse', line, target: match[1].trim() }
  const reverseRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})(?:${V.delimiter})?${V.optionalSpace}${V.curse}${V.optionalSpace}$`)
  const reverseMatch = reverseRegex.exec(text)
  if (!reverseMatch) return null
  return { type: 'curse', line, target: reverseMatch[1].trim() }
}

export function parseFollowStatement(text: string, line: number): FollowStatement | null {
  const followRegex = new RegExp(`^${V.optionalSpace}${V.follow}(?:${V.delimiter})?${V.optionalSpace}(${V.possibleName})${V.optionalSpace}$`)
  const match = followRegex.exec(text)
  if (match) return { type: 'follow', line, target: match[1].trim() }
  const reverseRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})(?:${V.delimiter})?${V.optionalSpace}${V.follow}${V.optionalSpace}$`)
  const reverseMatch = reverseRegex.exec(text)
  if (!reverseMatch) return null
  return { type: 'follow', line, target: reverseMatch[1].trim() }
}

export function parseForecastStatement(text: string, line: number): ForecastStatement | null {
  const forecastRegex = new RegExp(`^${V.optionalSpace}(${V.possibleName})(?:${V.delimiter})?${V.optionalSpace}${V.forecast}${V.optionalSpace}(${V.possibleName})${V.optionalSpace}$`)
  const match = forecastRegex.exec(text)
  if (!match) return null
  return { type: 'forecast', line, actor: match[1].trim(), target: match[2].trim() }
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

export function parseMasonStatement(text: string, line: number): MasonStatement | null {
  const masonRegex = new RegExp(`^${V.optionalSpace}${V.roleVocab('mason')}${V.delimiter}(${V.possibleName}(?:${V.optionalSpace}${V.delimiter}${V.possibleName})*)${V.optionalSpace}$`)
  const match = masonRegex.exec(text)
  if (!match) return null
  const players = match[1].split(new RegExp(`(?:${V.delimiter})+?`)).map(p => p.trim()).filter(p => p.length > 0)
  return { type: 'mason', line, players }
}

const historyRegexText = [
  `(?:(?<day>${V.dayNumber})${V.dayUnit})?`,
  `(?:${V.optionalSpace})?`,
  `(?<target>(?!(?:${V.race}|${V.guard})(?:[${V.whiteSpaceClass}${V.delimiterClass}]|$))${V.possibleName})?`,
  `(?:${V.optionalSpace})?`,
  `(?<action>${V.race}|${V.guard})`,
].join('')

const assertRegex = new RegExp([
  `^${V.optionalSpace}(?<actor>${V.possibleName})${V.delimiter}${V.optionalSpace}`,
  `(?<claim>(?:${V.denial})?(?:${V.anyRole})+${V.claim})?`,
  `${V.optionalSpace}`,
  `(?<history>(?:`,
    `(?:${V.optionalSpace}${V.delimiter})?`,
    `${historyRegexText}`,
  `)*?)?`,
  `${V.optionalSpace}$`
].join(''))

const historyRegex = new RegExp(historyRegexText, 'g')

// Bodyguard-specific: claim required, raw history captured as text (allows bare target names)
const bodyguardAssertRegex = new RegExp([
  `^${V.optionalSpace}(?<actor>${V.possibleName})${V.delimiter}${V.optionalSpace}`,
  `(?<claim>(?:${V.denial})?(?:${V.roleVocab('bodyguard')})${V.claim})`,
  `(?:${V.optionalSpace}(?<rawHistory>.+?))?`,
  `${V.optionalSpace}$`
].join(''))

const guardSuffixRegex = new RegExp(`${V.guard}$`)
const guardHistoryTokenRegex = new RegExp(
  `^(?:(?<day>${V.dayNumber})${V.dayUnit})?(?:${V.optionalSpace})?(?<target>.+)$`
)

// claim/assert で扱う「村側 power role」 (素村 CO で否定される対象)。
// nonVillage は claim 解析専用 pseudo-role なのでこの list には含まれない。
const POWER_ROLES: Role[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']

function extractRoles(claim: string): { roles: Role[], negative: boolean } {
  const negative = new RegExp(`^${V.denial}`).test(claim)
  // 素村CO / 村人CO = deny all village power roles
  if (new RegExp(V.plainVillager).test(claim) || new RegExp(V.roleVocab('villager')).test(claim)) {
    return { roles: POWER_ROLES, negative: true }
  }
  const roles: Role[] = []
  for (const role of POWER_ROLES) {
    if (new RegExp(V.roleVocab(role as SystemRole)).test(claim)) roles.push(role)
  }
  return { roles: roles.length > 0 ? roles : ['nonVillage'], negative }
}

export function parseAssertStatement(text: string, line: number): AssertStatement | null {
  const match = assertRegex.exec(text)
  if (match && match.groups?.actor) {
    const actor = match.groups.actor
    const claim = match.groups?.claim ?? undefined
    const assertions: Assertion[] = []

    if (claim) {
      const { roles, negative } = extractRoles(claim)
      const assertion: Assertion = { player: actor, roles }
      if (negative) assertion.negative = true
      assertions.push(assertion)
    }

    const history = match.groups?.history ?? undefined
    if (history) {
      for (const m of history.matchAll(historyRegex)) {
        if (!m.groups) continue
        const target = m.groups.target ?? undefined
        const actionText = m.groups.action
        const assertion: Assertion = { player: actor }
        if (target) assertion.target = target
        if (m.groups.day !== undefined) {
          // 日数プレフィックス (1D, 2日目 等) を 0-indexed の夜番号に正規化
          const n = parseInt(m.groups.day.replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xFEE0)), 10)
          if (!Number.isNaN(n) && n >= 1) assertion.day = n - 1
        }
        if (new RegExp(V.guard).test(actionText)) {
          assertion.action = 'guard'
        } else if (new RegExp(V.isKogitsune).test(actionText)) {
          assertion.result = 'isKogitsune'
        } else if (new RegExp(V.isWolf).test(actionText)) {
          assertion.result = 'isWolf'
        } else {
          assertion.result = 'isHuman'
        }
        assertions.push(assertion)
      }
    }

    return { type: 'assert', line, actor, assertions }
  }

  // Fallback: bodyguard claim with bare target names (護衛 keyword optional)
  const bgMatch = bodyguardAssertRegex.exec(text)
  if (!bgMatch || !bgMatch.groups?.actor) return null

  const actor = bgMatch.groups.actor
  const claim = bgMatch.groups.claim
  const assertions: Assertion[] = []

  const { roles, negative } = extractRoles(claim)
  const claimAssertion: Assertion = { player: actor, roles }
  if (negative) claimAssertion.negative = true
  assertions.push(claimAssertion)

  const rawHistory = bgMatch.groups?.rawHistory
  if (rawHistory) {
    const tokens = rawHistory.split(new RegExp(`(?:${V.delimiter})+?`)).map(t => t.trim()).filter(t => t.length > 0)
    for (const token of tokens) {
      const tm = guardHistoryTokenRegex.exec(token)
      if (!tm || !tm.groups?.target) continue
      let target = tm.groups.target.trim()
      target = target.replace(guardSuffixRegex, '')
      if (!target) continue
      const assertion: Assertion = { player: actor, target, action: 'guard' }
      assertions.push(assertion)
    }
  }

  return { type: 'assert', line, actor, assertions }
}

// Setup statement: 配役 村4 占1 霊1 狩1 共2 猫1 狼3 狂1 狐1 背1
const setupRegex = new RegExp(`^${V.optionalSpace}${V.setupPrefix}${V.optionalSpace}(.+)$`)

// 配役 statement (`配役 村4 占1 ...`) で role token を先頭マッチさせる pattern 群。
// systemRoles 全件を name.length DESC でソートして「狂信者」 を「狂人」 より先に試す
// (longest-prefix-first で disambiguate)。 これにより新役職追加時にこの list を
// 触らずに済む (paparazzi など pattern が systemRoles.howlPattern で auto-export)。
const roleMapping: [RegExp, SystemRole][] = (() => {
  const sorted = [...systemRoles.entries()].sort(
    ([, a], [, b]) => b.name.length - a.name.length,
  )
  return sorted.map(([role, meta]) => [new RegExp(`^${meta.howlPattern}`), role] as [RegExp, SystemRole])
})()

const fullWidthDigits: Record<string, string> = { '０':'0','１':'1','２':'2','３':'3','４':'4','５':'5','６':'6','７':'7','８':'8','９':'9' }
function normalizeDigits(s: string): string {
  return s.replace(/[０-９]/g, c => fullWidthDigits[c])
}

const setupDelimRegex = new RegExp(`^[${V.whiteSpaceClass}${V.delimiterClass}]+`)
const digitRegex = /^[0-9０-９]+/

export function parseSetupStatement(text: string, line: number): SetupStatement | null {
  const match = setupRegex.exec(text)
  if (!match) return null
  const body = match[1].trim()
  const roles: Record<string, number> = {}
  let pos = 0
  while (pos < body.length) {
    const delimMatch = setupDelimRegex.exec(body.slice(pos))
    if (delimMatch) pos += delimMatch[0].length
    if (pos >= body.length) break
    let bestLen = 0
    let bestRole = ''
    let bestCount = 0
    for (const [regex, roleName] of roleMapping) {
      const roleMatch = regex.exec(body.slice(pos))
      if (roleMatch) {
        const digitMatch = digitRegex.exec(body.slice(pos + roleMatch[0].length))
        if (digitMatch) {
          const totalLen = roleMatch[0].length + digitMatch[0].length
          if (totalLen > bestLen) {
            bestLen = totalLen
            bestRole = roleName
            bestCount = parseInt(normalizeDigits(digitMatch[0]), 10)
          }
        }
      }
    }
    if (bestLen === 0) return null
    roles[bestRole] = bestCount
    pos += bestLen
  }
  if (Object.keys(roles).length === 0) return null
  return { type: 'setup', line, roles }
}

// Annotation: @URL (video source)
const videoSourceRegex = /^[\s\u3000]*[@＠](https?:\/\/\S+)[\s\u3000]*$/

export function parseVideoSourceStatement(text: string, line: number): VideoSourceStatement | null {
  const m = text.match(videoSourceRegex)
  if (!m) return null
  return { type: 'videoSource', line, url: m[1] }
}

// Annotation: @MM:SS or @H:MM:SS (timestamp)
const timestampLineRegex = /^[\s\u3000]*[@＠](\d{1,2}(?::\d{2}){1,2})[\s\u3000]*$/

export function parseTimestampValue(s: string): number {
  const parts = s.split(':').map(Number)
  if (parts.some(isNaN)) return -1
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return -1
}

export function parseTimestampStatement(text: string, line: number): TimestampStatement | null {
  const m = text.match(timestampLineRegex)
  if (!m) return null
  const seconds = parseTimestampValue(m[1])
  if (seconds < 0) return null
  return { type: 'timestamp', line, seconds, raw: m[1] }
}

// Inline @MM:SS at end of line (stripped before normal parsing)
const inlineTimestampRegex = /\s[@＠](\d{1,2}(?::\d{2}){1,2})[\s\u3000]*$/

export function parseStatement (text: string, line: number): Statement {
  const parsers = [
    parseVideoSourceStatement,
    parseTimestampStatement,
    parseSpoilerStatement,
    parseSpeechStatement,
    parseSetupStatement,
    parseJoinMultiStatement,
    parseJoinStatement,
    parseVoteStatement,
    parseMultiVoteStatement,
    parseSuddenDeathStatement,
    parseAttackStatement,
    parseGrelanStatement,
    parseLynchStatement,
    parseCurseStatement,
    parseFollowStatement,
    parseRevoteStatement,
    parseOverStatement,
    parsePeaceStatement,
    parseDayMarkStatement,
    parseMasonStatement,
    parseForecastStatement,
    parseAssertStatement,
    parseRevealStatement,
  ]

  // Check for inline @timestamp before normal parsing
  let inlineSeconds: number | undefined
  const inlineMatch = text.match(inlineTimestampRegex)
  if (inlineMatch) {
    const sec = parseTimestampValue(inlineMatch[1])
    if (sec >= 0) {
      inlineSeconds = sec
      text = text.slice(0, inlineMatch.index!)
    }
  }

  for (const parser of parsers) {
    const result = parser(text, line)
    if (result) {
      if (inlineSeconds !== undefined) result.timestamp = inlineSeconds
      return result
    }
  }

  const result: UnknownStatement = { type: 'unknown', line, text }
  if (inlineSeconds !== undefined) result.timestamp = inlineSeconds
  return result
}
