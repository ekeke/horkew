import type { Statement } from './statement.ts'

/**
 * statements を走査し、Day → その Day が最初に登場する行番号 のマップを返す純粋関数。
 *
 * 規則:
 * - `Statement.day` が定義されている statement を順に見て、未登録の day なら登録
 * - 同じ day を持つ後続の statement は無視 (各 day の "最初の行" だけ拾う)
 * - `day` が undefined の statement は無視
 *
 * 用途: video 同期や day ナビで「Day N の先頭行」を引きたいとき。
 */
export function buildDayLineMap(statements: Statement[]): Map<number, number> {
  const map = new Map<number, number>()
  for (const s of statements) {
    if (s.day !== undefined && !map.has(s.day)) {
      map.set(s.day, s.line)
    }
  }
  return map
}
