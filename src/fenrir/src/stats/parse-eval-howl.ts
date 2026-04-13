/**
 * Eval howl 1 ファイルをパースして ParsedGame を返す
 *
 * 入力 howl の前提:
 *   - 末尾に `<名前>＝<役職ラベル>` の開示行ブロックがある（真役職の確定情報）
 *   - Day 0 夜の死亡が `<名前> 死亡` で先頭付近に現れる
 *   - Day 1 CO は最初の `処刑` 行よりも前に `<名前> <役職ラベル>CO ...` 形式で現れる
 *
 * 名前は内部で CO → 真役職のリンクに使うだけで、出力には含めない。
 */

import type { ParsedGame, RealRole, ClaimType, GameResult } from './types.ts'

/** 開示行の役職ラベル → 内部 RealRole */
const REVEAL_LABEL_TO_ROLE: Record<string, RealRole> = {
  '村': 'villager',
  '占い': 'seer',
  '霊': 'medium',
  '狩り': 'bodyguard',
  '共有': 'mason',
  '猫': 'nekomata',
  '人狼': 'werewolf',
  '狂信': 'fanatic',
  '狐': 'werehamster',
  '背徳': 'immoralist',
}

/** CO ラベル → ClaimType */
const CO_LABEL_TO_CLAIM: Record<string, ClaimType> = {
  '占い': 'seer',
  '霊能': 'medium',
  '狩り': 'bodyguard',
  '共有': 'mason',
  '猫': 'nekomata',
}

const CO_LABELS = Object.keys(CO_LABEL_TO_CLAIM)

const RESULT_MAP: Record<string, GameResult> = {
  '村勝利': 'villager_won',
  '狼勝利': 'werewolf_won',
  '狐勝利': 'werehamster_won',
  '引き分け': 'draw',
}

/** 行頭コメント/空白/メタ行を除外してコンテンツ行のみ返す */
function stripComments(lines: string[]): string[] {
  return lines.map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('配役') && !l.startsWith('++'))
}

/** 末尾の `<name>＝<label>` ブロックから真役職マップと結果を抽出 */
function parseReveal(lines: string[]): { nameToRole: Map<string, RealRole>, result: GameResult } {
  const nameToRole = new Map<string, RealRole>()
  let result: GameResult = 'unknown'

  // 勝利/引き分け行を見つける
  let resultIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = RESULT_MAP[lines[i]]
    if (r) { result = r; resultIdx = i; break }
  }
  if (resultIdx < 0) return { nameToRole, result }

  // 結果行の後を reveal として読む
  for (let i = resultIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\S+)＝(\S+)$/)
    if (!m) continue
    const role = REVEAL_LABEL_TO_ROLE[m[2]]
    if (role) nameToRole.set(m[1], role)
  }
  return { nameToRole, result }
}

/** Day 0 夜の死者名集合（Day 1 開始時点で既に死亡） */
function parseDay0Deaths(lines: string[]): Set<string> {
  const dead = new Set<string>()
  for (const line of lines) {
    // Day 1 CO が始まったら Day 0 収集終了
    if (isCoLine(line)) break
    // 処刑行が出たらどのみち終了（保険）
    if (/処刑$/.test(line)) break
    const m = line.match(/^(\S+)\s+死亡$/)
    if (m) dead.add(m[1])
  }
  return dead
}

function isCoLine(line: string): boolean {
  for (const label of CO_LABELS) {
    if (line.match(new RegExp('^\\S+\\s+' + label + 'CO(\\s|$)'))) return true
  }
  return false
}

/** Day 1 CO（最初の `処刑` 行よりも前の CO 行）を actor → ClaimType で返す */
function parseDay1Claims(lines: string[]): Map<string, ClaimType> {
  const claims = new Map<string, ClaimType>()
  for (const line of lines) {
    if (/処刑$/.test(line)) break
    for (const label of CO_LABELS) {
      const m = line.match(new RegExp('^(\\S+)\\s+' + label + 'CO(?:\\s|$)'))
      if (m && !claims.has(m[1])) {
        claims.set(m[1], CO_LABEL_TO_CLAIM[label])
        break
      }
    }
  }
  return claims
}

export function parseEvalHowl(howl: string): ParsedGame {
  const rawLines = howl.split('\n').map(l => l.replace(/\r$/, ''))
  const { nameToRole, result } = parseReveal(rawLines.map(l => l.trim()))

  const contentLines = stripComments(rawLines)
  const day0Dead = parseDay0Deaths(contentLines)
  const day1Claims = parseDay1Claims(contentLines)

  const entries: Array<{ role: RealRole, claim: ClaimType }> = []
  for (const [name, role] of nameToRole) {
    if (day0Dead.has(name)) continue
    const claim = day1Claims.get(name) ?? 'none'
    entries.push({ role, claim })
  }

  return {
    result,
    day0Deaths: day0Dead.size,
    entries,
  }
}
