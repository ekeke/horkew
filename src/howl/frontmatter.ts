import yaml from 'js-yaml'

export interface FrontmatterResult {
  meta: Record<string, any>
  body: string
  numLines: number
}

export function parseFrontmatter(content: string): FrontmatterResult {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (match) {
    const meta = yaml.load(match[1]) as Record<string, any>
    return { meta, body: content.slice(match[0].length), numLines: match[0].split('\n').length }
  }
  return { meta: {}, body: content, numLines: 1 }
}

export function buildFrontmatter(meta: Record<string, any>, body: string): string {
  const keys = Object.keys(meta)
  if (keys.length === 0) return body
  const yamlText = yaml.dump(meta).trimEnd()
  return `---\n${yamlText}\n---\n${body}`
}
