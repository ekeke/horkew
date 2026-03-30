/**
 * Retar compat dump
 * TS/Rust 両方で同じフォーマットの中間結果を出力し、diff で差分箇所を特定する
 *
 * フォーマット: 関数名\t{キーソート済みJSON}\n
 * 有効化: enableDump() / 環境変数 RETAR_DUMP=1
 */
import type { Possibilities } from './possibilities.ts'

export let DUMP_ENABLED = !!process.env.RETAR_DUMP
let dumpBuffer: string[] = []

export function enableDump(): void { DUMP_ENABLED = true }
export function disableDump(): void { DUMP_ENABLED = false }
export function resetDump(): void { dumpBuffer = [] }
export function getDump(): string[] { return dumpBuffer }

function sortedJson(obj: Record<string, unknown>): string {
  // 数値キーは数値順、それ以外は辞書順
  const keys = Object.keys(obj).sort((a, b) => {
    const na = Number(a), nb = Number(b)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return a < b ? -1 : a > b ? 1 : 0
  })
  return JSON.stringify(obj, keys)
}

function possObj(p: Possibilities): Record<string, number> {
  const obj: Record<string, number> = {}
  for (let i = 1; i < p.possibilities.length; i++) {
    obj[String(i)] = p.possibilities[i]
  }
  return obj
}

function emit(fn: string, data: Record<string, unknown>): void {
  if (!DUMP_ENABLED) return
  const line = `${fn}\t${sortedJson(data)}`
  dumpBuffer.push(line)
}

export function dumpFinalizePre(possibilities: Possibilities): void {
  emit('finalize', possObj(possibilities))
}

export function dumpSolveResult(result: Possibilities | undefined): void {
  emit('solve_possibilities', result ? possObj(result) : { result: 'none' as unknown as number })
}

export function dumpAnalyze(result: Record<string, number>[]): void {
  // result は [{seat: n, bits: n}, ...] のソート済み配列
  const obj: Record<string, number> = {}
  for (const { seat, bits } of result) {
    obj[String(seat)] = bits
  }
  emit('analyze', obj)
}
