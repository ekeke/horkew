import yaml from 'js-yaml'

export type Line = {
  number: number  // 元のテキストの行番号
  content: string // 処理後の行内容
}

export interface PreprocessResult {
  meta: Record<string, any>
  lines: Line[]
}

function extractFrontmatter(content: string): { meta: Record<string, any>; numLines: number, content: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (frontmatterMatch) {
    const frontmatterRaw = frontmatterMatch[1]
    const meta = yaml.load(frontmatterRaw) as Record<string, any>
    return { meta, numLines: frontmatterMatch[0].split('\n').length, content: content.slice(frontmatterMatch[0].length) }
  }
  return { meta: {}, numLines: 1, content }
}

export function preprocess(input: string): PreprocessResult {
  const { meta, numLines, content } = extractFrontmatter(input)
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

    // 行内のスポイラーコメントを別ラインとして切り出し
    const spoilerIndex = line.indexOf('!')
    if (spoilerIndex >= 0) {
      const mainPart = line.substring(0, spoilerIndex).trim()
      const spoilerPart = line.substring(spoilerIndex).trim()

      if (mainPart.length > 0) {
        lines.push({ number: lineNumber, content: mainPart })
      }

      lines.push({ number: lineNumber, content: spoilerPart })
    } else {
      lines.push({ number: lineNumber, content: line })
    }
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

  return { meta, lines: [...joinLines, ...otherLines] }
}
