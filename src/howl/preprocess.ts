import { parseFrontmatter } from './frontmatter.ts'
import { whiteSpace, whiteSpaceClass } from './vocabulary.ts'

// 行末コメント: 空白 (半角 / 全角 / タブ) に続く `#` 以降を行末まで除去する。
// 行頭の `#` (trim 後 startsWith) は別途フルライン除去するため、 ここでは
// 「空白 + `#`」のみを対象にして、 ハッシュタグ的トークン (例: `#1` 席番号) と
// の衝突を避ける。
const trailingCommentRegex = new RegExp(`[${whiteSpaceClass}]#.*$`)

/**
 * 行から行末コメント (`[ws]# ...`) を剥がして返す。 行頭フルラインコメント
 * (`#` で始まる行) はこの関数では落とさない (呼び出し側で `.trim().startsWith('#')`
 * 判定してください)。 preprocess と rename の両経路で同一仕様にするため共通化。
 */
export function stripTrailingHashComment(line: string): string {
  return line.replace(trailingCommentRegex, '')
}

/**
 * 行を本体と行末コメント部 (空白 + `#` ...) に分割する。 コメントが無ければ
 * `comment` は空文字列。 rename のように本体だけ parse して comment は原文のまま
 * 保持したいケース向け。
 */
export function splitTrailingHashComment(line: string): { body: string, comment: string } {
  const m = trailingCommentRegex.exec(line)
  if (!m) return { body: line, comment: '' }
  return { body: line.slice(0, m.index), comment: line.slice(m.index) }
}

export type Line = {
  number: number  // 元のテキストの行番号
  content: string // 処理後の行内容
}

export interface PreprocessResult {
  meta: Record<string, any>
  lines: Line[]
}

// `配役` / `レギュ` / `レギュレーション` は CJK 始まりのため `\b` (word boundary) が
// 立たない (JS の `\w` は ASCII のみ)。 後続が whiteSpace (半角/全角/タブ) または行末で
// あることを look-ahead で要求し、 `配役者` のような誤マッチを防ぐ。
const structuralLineRegex = new RegExp(
  `^[+＋]|^(?:配役|レギュレーション|レギュ|setup)(?=${whiteSpace}|$)`
)

export function preprocess(input: string, cursorLine?: number): PreprocessResult {
  const { meta, numLines, body: content } = parseFrontmatter(input)
  const lines: Line[] = []

  // フロントマター後の内容を行単位で処理
  const rawLines = content.split('\n')

  rawLines.forEach((rawLine, idx) => {
    const lineNumber = idx + numLines // 行番号は1ベース
    const stripped = stripTrailingHashComment(rawLine)
    const line = stripped.trim()
    if (line.length === 0 || line.startsWith('#')) {
      // 空行とハッシュコメント行は除去
      return
    }
    lines.push({ number: lineNumber, content: line })
  })

  // Join行（+で始まる）を先頭に巻き上げ
  const joinLines: Line[] = []
  const otherLines: Line[] = []
  for (const line of lines) {
    if (/^[+＋]/.test(line.content)) {
      joinLines.push(line)
    } else {
      otherLines.push(line)
    }
  }

  let resultLines = [...joinLines, ...otherLines]

  // cursorLine が指定された場合、構造行（+, 配役/setup）以外をカーソル行でフィルタ
  if (cursorLine !== undefined) {
    resultLines = resultLines.filter(line => {
      if (structuralLineRegex.test(line.content)) return true
      return line.number <= cursorLine
    })
  }

  return { meta, lines: resultLines }
}
