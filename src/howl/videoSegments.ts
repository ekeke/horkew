import type { Statement, VideoSourceStatement, TimestampStatement } from './statement.ts'

// 公開型: platform 非依存に保つ。URL の type/id 解決 (YouTube / niconico 判定など) は consumer 側の責務。

export type VideoTimestamp = {
  line: number      // 原文 1 始まりの行番号
  seconds: number
}

export type VideoSegment = {
  url: string                  // videoSource の生 URL
  line: number                 // videoSource 行 (原文 1 始まり)。セグメント境界に使う
  timestamps: VideoTimestamp[] // seconds 昇順にソート済み
}

/**
 * statements を走査し、`@URL` ごとにセグメント化して返す純粋関数。
 *
 * 規則:
 * - `videoSource` を見たら新セグメントを push
 * - 以降の `timestamp` statement → `{ line, seconds }` を current.timestamps に追加
 * - 以降の statement がインライン `timestamp?: number` を持つ → 同様に追加
 * - 最初の `videoSource` より前の timestamp は属する動画が無いため無視
 * - 各セグメントの timestamps は seconds 昇順にソート
 */
export function buildVideoSegments(statements: Statement[]): VideoSegment[] {
  const segments: VideoSegment[] = []
  let current: VideoSegment | null = null
  for (const s of statements) {
    if (s.type === 'videoSource') {
      const vs = s as VideoSourceStatement
      current = { url: vs.url, line: vs.line, timestamps: [] }
      segments.push(current)
    } else if (current) {
      if (s.type === 'timestamp') {
        const ts = s as TimestampStatement
        current.timestamps.push({ line: ts.line, seconds: ts.seconds })
      } else if (s.timestamp !== undefined) {
        current.timestamps.push({ line: s.line, seconds: s.timestamp })
      }
    }
  }
  for (const seg of segments) seg.timestamps.sort((a, b) => a.seconds - b.seconds)
  return segments
}
