/**
 * src/spec/ 配下の .howl ファイルを再帰的に発見して読み込む。
 * 既存 dependency のみで実装 (新規 dep 無)。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type LoadedScenario = {
  /** スキャン開始ディレクトリからの相対パス (例: "seer/divines-villager.howl") */
  relPath: string
  /** 絶対パス */
  absPath: string
  /** ファイル内容 (CRLF → LF 正規化済み) */
  content: string
}

export function loadScenariosRecursive(rootDir: string): LoadedScenario[] {
  const out: LoadedScenario[] = []
  function walk(dir: string, rel: string) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const childRel = rel ? join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        walk(full, childRel)
      } else if (entry.isFile() && entry.name.endsWith('.howl')) {
        const content = readFileSync(full, 'utf-8').replace(/\r\n/g, '\n')
        out.push({ relPath: childRel, absPath: full, content })
      }
    }
  }
  walk(rootDir, '')
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}
