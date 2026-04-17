import { parseFrontmatter } from './frontmatter.ts'

export type Line = {
  number: number  // 元のテキストの行番号
  content: string // 処理後の行内容
}

export interface PreprocessResult {
  meta: Record<string, any>
  lines: Line[]
}

export function preprocess(input: string, cursorLine?: number): PreprocessResult {
  const { meta, numLines, body: content } = parseFrontmatter(input)
  const lines: Line[] = []

  // フロントマター後の内容を行単位で処理
  const rawLines = content.split('\n')

  rawLines.forEach((rawLine, idx) => {
    const lineNumber = idx + numLines // 行番号は1ベース
    const line = rawLine.trim()
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
      if (/^[+＋]|^(?:配役|レギュレーション|レギュ|setup)\b/.test(line.content)) return true
      return line.number <= cursorLine
    })
  }

  return { meta, lines: resultLines }
}
