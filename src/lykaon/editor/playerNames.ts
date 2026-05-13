import type { Statement } from '../../howl/statement.ts'
import type { FlexibleDictionary } from '../../howl/flexibleDictionary.ts'
import type { PlayerNameInfo } from './howlLanguage.ts'

type NameEntry = { name: string, kind: 'definition' | 'resolved' | 'unresolved' }

export function extractDefNames(stmt: Statement): string[] {
  const s = stmt as Statement & Record<string, unknown>
  switch (s.type) {
    case 'join':
      return [s.name as string, ...(s.shortName ? [s.shortName as string] : []), ...(s.aliases as string[])]
    case 'joinMulti':
      return (s.players as string[]) ?? []
    default:
      return []
  }
}

export function extractRefNames(stmt: Statement): string[] {
  const s = stmt as Statement & Record<string, unknown>
  switch (s.type) {
    case 'vote':
      return [s.voter as string, s.target as string]
    case 'multiVote':
      return [...(s.voters as string[]), s.target as string]
    case 'attack':
      return [...(s.target as string[])]
    case 'lynch':
      return s.target ? [s.target as string] : []
    case 'curse':
    case 'follow':
      return [s.target as string]
    case 'revote':
      return (s.targets as string[]) ?? []
    case 'assert': {
      const names = [s.actor as string]
      const assertions = (s.assertions as Array<Record<string, unknown>> | undefined) ?? []
      for (const a of assertions) {
        if (a.target) names.push(a.target as string)
      }
      return names
    }
    case 'mason':
      return (s.players as string[]) ?? []
    case 'reveal':
      return [s.player as string]
    default:
      return []
  }
}

/**
 * 各 statement の行内で参照されている player 名を doc 上の位置にマッピングする。
 * editor の player name 色分けに使う。
 */
export function buildPlayerNames(
  statements: Statement[],
  dict: FlexibleDictionary,
  doc: string,
): PlayerNameInfo[] {
  const lines = doc.split('\n')
  const result: PlayerNameInfo[] = []
  for (const stmt of statements) {
    const entries: NameEntry[] = []
    for (const name of extractDefNames(stmt)) {
      if (name) entries.push({ name, kind: 'definition' })
    }
    for (const name of extractRefNames(stmt)) {
      if (name) entries.push({ name, kind: dict.search(name).length > 0 ? 'resolved' : 'unresolved' })
    }
    if (entries.length === 0) continue
    const lineIdx = stmt.line - 1
    if (lineIdx < 0 || lineIdx >= lines.length) continue
    const lineText = lines[lineIdx]
    const used: [number, number][] = []
    for (const { name, kind } of entries) {
      let searchFrom = 0
      let idx = -1
      while ((idx = lineText.indexOf(name, searchFrom)) !== -1) {
        const end = idx + name.length
        if (!used.some(([f, t]) => idx < t && end > f)) {
          used.push([idx, end])
          result.push({ line: stmt.line, offset: idx, length: name.length, kind })
          break
        }
        searchFrom = idx + 1
      }
    }
  }
  return result
}
