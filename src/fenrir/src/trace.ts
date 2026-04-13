/**
 * 軽量トレースモジュール
 *
 * 使い方:
 *   FENRIR_TRACE=1 npm run train:orchestrate -- ...
 *   FENRIR_TRACE_SEAT=14 npm run train:orchestrate -- ...   # 特定席だけ
 *   FENRIR_TRACE_CAT=adapter,agent npm run ...              # カテゴリ絞り
 *
 * Adapter / Agent の主要メソッドに trace() 呼び出しを仕込み、
 * 「いつ・誰が・どのメソッドを呼んだか」を時系列で stdout へ出す。
 */

// ブラウザバンドルでも安全なように process アクセスをガード
const env: Record<string, string | undefined> =
  (typeof process !== 'undefined' && process.env) ? process.env : {}

const enabled = env.FENRIR_TRACE === '1' || env.FENRIR_TRACE === 'true'

const seatFilter: Set<number> | null = env.FENRIR_TRACE_SEAT
  ? new Set(env.FENRIR_TRACE_SEAT.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n)))
  : null

const catFilter: Set<string> | null = env.FENRIR_TRACE_CAT
  ? new Set(env.FENRIR_TRACE_CAT.split(',').map(s => s.trim()))
  : null

export const traceEnabled: boolean = enabled

/**
 * @param category 'adapter' | 'agent' | 'engine' など
 * @param day      ゲームの day（不明なら -1）
 * @param seat     席番号（adapter エントリなど該当しない場合は null）
 * @param role     player の役職（不明なら null）
 * @param msg      実際のメッセージ（"BrainBattleAdapter.onDayClaims" など）
 */
export function trace(
  category: string,
  day: number,
  seat: number | null,
  role: string | null,
  msg: string,
): void {
  if (!enabled) return
  if (catFilter && !catFilter.has(category)) return
  if (seatFilter && seat != null && !seatFilter.has(seat)) return
  const dayStr = day >= 0 ? `D${day}` : 'D?'
  const seatStr = seat != null ? ` seat${seat}${role ? `(${role})` : ''}` : ''
  // eslint-disable-next-line no-console
  console.log(`[trace] ${dayStr} ${category}${seatStr} ${msg}`)
}
