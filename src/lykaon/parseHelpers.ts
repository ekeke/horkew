/*
 * lykaon の parse / preprocess / bridge 段の握りつぶし回避ロジック。
 *
 * かつて AnalysisContext 内に inline で書いていたが、 AnalysisContext.svelte.ts は
 * retar/wasm を transit deps として読み込むため node:test から直接 import できない。
 * unit test 可能にするため独立 module として切り出している。
 *
 * 設計方針: 全段で throw をキャッチし、 Error を返り値の `error` フィールドに保持する。
 * 同時に console.error にも吐く (API 利用者が DevTools で気付けるように)。
 * AnalysisContext は error を $derived として公開し、 AnalysisErrorBanner が UI 表示する。
 */
import type { Statement } from '../howl/statement.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'

export type PreprocessResult = { text: string, lineOffset: number }

/**
 * editor のテキストを parse 直前に変換するフック。
 * 返した文字列が howl parser への入力になる。 editor 表示自体は変えない。
 *
 * 用途: マクロ展開、 consumer 固有のショートカット記法、テンプレ注入など。
 * 例外を投げた場合は元の text にフォールバックする (safeParse と同じ方針)。
 *
 * prepend など行数が変わる変換を入れる場合は string ではなく PreprocessResult を返し、
 * lineOffset に前置した行数 K を入れること。 AnalysisContext は cursor と statement.line /
 * sourceLines を K だけシフトしてエディタ座標と parse 座標のズレを吸収する。
 */
export type HowlPreprocessor = (text: string) => string | PreprocessResult

export type ParsedResult = {
  meta: Record<string, unknown>
  statements: Statement[]
  error: Error | null
}

export function safeParse(text: string, cursorLine?: number): ParsedResult {
  try {
    const result = cursorLine != null
      ? parse(text, { cursorLine })
      : parse(text)
    return { meta: result.meta as Record<string, unknown>, statements: result.statements, error: null }
  } catch (err) {
    // API 利用時にも気付けるよう console に流す (browser DevTools / Node stderr どちらでも見える)。
    console.error('[lykaon] howl parse error:', err)
    return { meta: {}, statements: [], error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/**
 * preprocess フックの戻り値を PreprocessResult に正規化する。
 * - undefined / 例外時は元の text + lineOffset 0 にフォールバック
 * - string 戻りは lineOffset 0 に揃える (後方互換)
 * - lineOffset は非負整数に丸める (防御)
 */
export function normalizePreprocess(
  preprocess: HowlPreprocessor | undefined,
  text: string,
): { result: PreprocessResult, error: Error | null } {
  if (!preprocess) return { result: { text, lineOffset: 0 }, error: null }
  try {
    const out = preprocess(text)
    if (typeof out === 'string') return { result: { text: out, lineOffset: 0 }, error: null }
    return { result: { text: out.text, lineOffset: Math.max(0, Math.floor(out.lineOffset)) }, error: null }
  } catch (err) {
    console.error('[lykaon] preprocess error:', err)
    return { result: { text, lineOffset: 0 }, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

export type Bridge = ReturnType<typeof buildVillageStatus>

export type BridgeResult = { bridge: Bridge | null, error: Error | null }

export function safeBuildVillage(parsed: ParsedResult): BridgeResult {
  if (parsed.statements.length === 0) return { bridge: null, error: null }
  try {
    return { bridge: buildVillageStatus(parsed.statements, parsed.meta), error: null }
  } catch (err) {
    console.error('[lykaon] bridge build error:', err)
    return { bridge: null, error: err instanceof Error ? err : new Error(String(err)) }
  }
}
