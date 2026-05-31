/**
 * retar (TS) と retar-rs (Rust) のファイル名・関数名の同期チェック
 * 静的解析でソースコードを読み、camelCase↔snake_case の機械的変換で対応を検証する
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TS_DIR = join(import.meta.dirname, '.')
const RS_DIR = join(import.meta.dirname, '..', 'retar-rs', 'src')

// ── 変換ユーティリティ ──

function camelToSnake(name: string): string {
  // 大文字連続（略語）を正しく処理: computeMaxSurvivingNV → compute_max_surviving_nv
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

// ── ファイル名マッピング ──

// TS→Rust で名前が機械的変換と異なるペア
const FILE_ALIASES: Record<string, string> = {
  'index': 'village_retar',
  'role-sets': 'role_sets', // TS は kebab-case, Rust は snake_case
}

// 片方にしか存在しなくてよいファイル（WASMブリッジ、型定義、test helper など）
const TS_ONLY_FILES = new Set(['wasm-helpers', 'expectations'])
const RS_ONLY_FILES = new Set(['lib', 'types'])

// モジュールプレフィックスファイル: TSではトップレベルexportのためファイル名をプレフィックス/サフィックスに付ける
// Rustではモジュールスコープ（dump::enable()）で呼ぶためプレフィックス不要
// 例: TS enableDump / dumpFinalizePre → Rust dump::enable / dump::finalize_pre
const MODULE_PREFIX_FILES = new Set(['dump'])

// ── 関数名の許可リスト（言語イディオムの違いで一致不要） ──

// ファイル単位の許可リスト: { tsFile: { tsOnly: [...], rsOnly: [...] } }
// ここに入れた関数は比較対象外になる。理由をコメントで明記すること。
const ALLOWED_MISMATCHES: Record<string, { tsOnly?: string[], rsOnly?: string[] }> = {
  // combinatorics: 全関数が自動マッチ
  // finalizer: 全関数が自動マッチ
  // dump: MODULE_PREFIX_FILES で自動マッチ（プレフィックス/サフィックス除去）
  roleTesters: {
    rsOnly: ['save_into'], // Rust専用: SnapshotPool用のゼロアロケーション版save_context
  },
}

// クラス/structメソッドの許可リスト
const ALLOWED_METHOD_MISMATCHES: Record<string, { tsOnly?: string[], rsOnly?: string[] }> = {
  // Possibilities: 全メソッドが自動マッチ
  VillageRetar: {
    tsOnly: [
      'analyzeSafe',     // TSエントリポイント用エラーラッパー、Rustでは Result 型で代替
    ],
    rsOnly: [
      'new',                    // Rustコンストラクタ慣習、TSでは constructor
    ],
  },
}

// ── 抽出ロジック ──

function extractTsFunctions(source: string): { exported: string[], internal: string[] } {
  const exported: string[] = []
  const internal: string[] = []
  for (const m of source.matchAll(/^(export\s+)?function\*?\s+(\w+)\s*[<(]/gm)) {
    if (m[1]) exported.push(m[2])
    else internal.push(m[2])
  }
  return { exported, internal }
}

function extractTsClassMethods(source: string, className: string): { name: string, isPrivate: boolean }[] {
  // export class ClassName { ... } のブロックを抽出
  const classRe = new RegExp(`^export\\s+class\\s+${className}\\s*(\\{)`, 'gm')
  const classMatch = classRe.exec(source)
  if (!classMatch) return []

  const startIdx = classMatch.index + classMatch[0].length
  let depth = 1
  let endIdx = startIdx
  for (let i = startIdx; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    endIdx = i
  }
  const classBody = source.slice(startIdx, endIdx)

  const methods: { name: string, isPrivate: boolean }[] = []
  // メソッド定義: "  methodName(" or "  private methodName(" or "  get methodName(" etc.
  for (const m of classBody.matchAll(/^  (?:(private|static)\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/gm)) {
    const modifier = m[1]
    const name = m[2]
    if (name === 'constructor') continue
    methods.push({ name, isPrivate: modifier === 'private' })
  }
  return methods
}

/** #[cfg(test)] 以降のテストモジュールを除去 */
function stripRsTestModule(source: string): string {
  const idx = source.indexOf('#[cfg(test)]')
  return idx >= 0 ? source.slice(0, idx) : source
}

// @ts-ignore: kept for future use
function _extractRsPubFunctions(source: string): string[] {
  const src = stripRsTestModule(source)
  const fns: string[] = []
  for (const m of src.matchAll(/^\s*pub\s+fn\s+(\w+)\s*[<(]/gm)) {
    fns.push(m[1])
  }
  return fns
}

function extractRsImplMethods(source: string, structName: string): string[] {
  const src = stripRsTestModule(source)
  const methods: string[] = []
  const implRe = new RegExp(`^impl\\s+${structName}\\s*\\{`, 'gm')
  let implMatch
  while ((implMatch = implRe.exec(src)) !== null) {
    const startIdx = implMatch.index + implMatch[0].length
    let depth = 1
    let endIdx = startIdx
    for (let i = startIdx; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      endIdx = i
    }
    const implBody = src.slice(startIdx, endIdx)
    for (const m of implBody.matchAll(/^\s*pub\s+fn\s+(\w+)\s*[<(]/gm)) {
      methods.push(m[1])
    }
  }
  return methods
}

function findImplRanges(source: string): [number, number][] {
  const ranges: [number, number][] = []
  const implRe = /^impl\s+(?:<[^>]+>\s*)?\w+(?:<[^>]+>)?\s*\{/gm
  let implMatch
  while ((implMatch = implRe.exec(source)) !== null) {
    const startIdx = implMatch.index
    let depth = 1
    let endIdx = implMatch.index + implMatch[0].length
    for (let i = endIdx; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      endIdx = i
    }
    ranges.push([startIdx, endIdx])
  }
  return ranges
}

function extractRsFreeFunctions(source: string): string[] {
  const src = stripRsTestModule(source)
  const implRanges = findImplRanges(src)
  const fns: string[] = []
  for (const m of src.matchAll(/^\s*pub\s+fn\s+(\w+)\s*[<(]/gm)) {
    const pos = m.index!
    const insideImpl = implRanges.some(([start, end]) => pos >= start && pos <= end)
    if (!insideImpl) fns.push(m[1])
  }
  return fns
}

// ── テスト ──

describe('retar TS↔Rust sync check', () => {
  // ファイル一覧の取得
  const tsFiles = readdirSync(TS_DIR)
    .filter(f => f.endsWith('.ts') && !f.includes('.test.') && !f.startsWith('bench'))
    .map(f => f.replace('.ts', ''))
    .filter(f => !TS_ONLY_FILES.has(f))

  const rsFiles = readdirSync(RS_DIR)
    .filter(f => f.endsWith('.rs'))
    .map(f => f.replace('.rs', ''))
    .filter(f => !RS_ONLY_FILES.has(f))

  describe('file structure', () => {
    it('all TS files have corresponding Rust files', () => {
      const missing: string[] = []
      for (const tsFile of tsFiles) {
        const expectedRs = FILE_ALIASES[tsFile] ?? camelToSnake(tsFile)
        if (!rsFiles.includes(expectedRs)) {
          missing.push(`${tsFile}.ts → ${expectedRs}.rs`)
        }
      }
      assert.deepStrictEqual(missing, [], `TS files without Rust counterparts:\n${missing.join('\n')}`)
    })

    it('all Rust files have corresponding TS files', () => {
      const missing: string[] = []
      // 逆引き: Rust→TS
      const rsToTs = new Map<string, string>()
      for (const [ts, rs] of Object.entries(FILE_ALIASES)) {
        rsToTs.set(rs, ts)
      }
      for (const rsFile of rsFiles) {
        const expectedTs = rsToTs.get(rsFile) ?? snakeToCamel(rsFile)
        if (!tsFiles.includes(expectedTs)) {
          missing.push(`${rsFile}.rs → ${expectedTs}.ts`)
        }
      }
      assert.deepStrictEqual(missing, [], `Rust files without TS counterparts:\n${missing.join('\n')}`)
    })
  })

  describe('exported functions', () => {
    // ファイルペアごとに関数名を比較
    for (const tsFile of tsFiles) {
      const rsFile = FILE_ALIASES[tsFile] ?? camelToSnake(tsFile)
      if (!rsFiles.includes(rsFile)) continue

      it(`${tsFile}.ts ↔ ${rsFile}.rs: free functions match`, () => {
        const tsSource = readFileSync(join(TS_DIR, `${tsFile}.ts`), 'utf-8')
        const rsSource = readFileSync(join(RS_DIR, `${rsFile}.rs`), 'utf-8')

        const { exported: tsExported, internal: tsInternal } = extractTsFunctions(tsSource)
        const rsFns = extractRsFreeFunctions(rsSource)

        const allowed = ALLOWED_MISMATCHES[tsFile] ?? {}
        const tsAllowed = new Set(allowed.tsOnly ?? [])
        const rsAllowed = new Set(allowed.rsOnly ?? [])

        const isModulePrefix = MODULE_PREFIX_FILES.has(tsFile)
        const snakePrefix = isModulePrefix ? `${camelToSnake(tsFile)}_` : ''
        const snakeSuffix = isModulePrefix ? `_${camelToSnake(tsFile)}` : ''

        // モジュールプレフィックスファイル用: snake_case化後にプレフィックス/サフィックスを除去して再マッチ
        function matchesRsFn(tsSnake: string, rsFnList: string[]): boolean {
          if (rsFnList.includes(tsSnake)) return true
          if (!isModulePrefix) return false
          // dump_finalize_pre → finalize_pre (prefix除去)
          if (snakePrefix && tsSnake.startsWith(snakePrefix)) {
            if (rsFnList.includes(tsSnake.slice(snakePrefix.length))) return true
          }
          // enable_dump → enable (suffix除去)
          if (snakeSuffix && tsSnake.endsWith(snakeSuffix)) {
            if (rsFnList.includes(tsSnake.slice(0, -snakeSuffix.length))) return true
          }
          return false
        }

        function matchesTsFn(rsSnake: string, tsFnSet: Set<string>): boolean {
          const camel = snakeToCamel(rsSnake)
          if (tsFnSet.has(camel)) return true
          if (!isModulePrefix) return false
          const prefix = snakeToCamel(camelToSnake(tsFile))
          // enable → enableDump (suffix付与) or dumpEnable (prefix付与)
          const withSuffix = camel + prefix.charAt(0).toUpperCase() + prefix.slice(1)
          if (tsFnSet.has(withSuffix)) return true
          const withPrefix = prefix + camel.charAt(0).toUpperCase() + camel.slice(1)
          if (tsFnSet.has(withPrefix)) return true
          return false
        }

        // TS export → Rust: TS exportにあってRustにない
        const tsOnlyFns: string[] = []
        for (const fn of tsExported) {
          if (tsAllowed.has(fn)) continue
          const expectedRs = camelToSnake(fn)
          if (!matchesRsFn(expectedRs, rsFns)) {
            tsOnlyFns.push(`${fn} (expected: ${expectedRs})`)
          }
        }

        // Rust → TS: Rustにあって TS(export+internal) にない
        const tsAll = new Set([...tsExported, ...tsInternal])
        const rsOnlyFns: string[] = []
        for (const fn of rsFns) {
          if (rsAllowed.has(fn)) continue
          if (!matchesTsFn(fn, tsAll)) {
            rsOnlyFns.push(`${fn} (expected: ${snakeToCamel(fn)})`)
          }
        }

        const errors: string[] = []
        if (tsOnlyFns.length > 0) errors.push(`TS only:\n  ${tsOnlyFns.join('\n  ')}`)
        if (rsOnlyFns.length > 0) errors.push(`Rust only:\n  ${rsOnlyFns.join('\n  ')}`)
        assert.strictEqual(errors.length, 0, `Function mismatch in ${tsFile}↔${rsFile}:\n${errors.join('\n')}`)
      })
    }
  })

  describe('class/struct methods', () => {
    const CLASS_PAIRS: { className: string, tsFile: string, rsFile: string }[] = [
      { className: 'Possibilities', tsFile: 'possibilities', rsFile: 'possibilities' },
      { className: 'VillageRetar', tsFile: 'index', rsFile: 'village_retar' },
    ]

    for (const { className, tsFile, rsFile } of CLASS_PAIRS) {
      it(`${className}: public methods match`, () => {
        const tsSource = readFileSync(join(TS_DIR, `${tsFile}.ts`), 'utf-8')
        const rsSource = readFileSync(join(RS_DIR, `${rsFile}.rs`), 'utf-8')

        const tsMethods = extractTsClassMethods(tsSource, className)
          .filter(m => !m.isPrivate)
          .map(m => m.name)
        const rsMethods = extractRsImplMethods(rsSource, className)

        const allowed = ALLOWED_METHOD_MISMATCHES[className] ?? {}
        const tsAllowed = new Set(allowed.tsOnly ?? [])
        const rsAllowed = new Set(allowed.rsOnly ?? [])

        // TS→Rust
        const tsOnly: string[] = []
        for (const method of tsMethods) {
          if (tsAllowed.has(method)) continue
          const expectedRs = camelToSnake(method)
          if (!rsMethods.includes(expectedRs)) {
            tsOnly.push(`${method} (expected: ${expectedRs})`)
          }
        }

        // Rust→TS
        const rsOnly: string[] = []
        for (const method of rsMethods) {
          if (rsAllowed.has(method)) continue
          const expectedTs = snakeToCamel(method)
          if (!tsMethods.includes(expectedTs)) {
            rsOnly.push(`${method} (expected: ${expectedTs})`)
          }
        }

        const errors: string[] = []
        if (tsOnly.length > 0) errors.push(`TS only:\n  ${tsOnly.join('\n  ')}`)
        if (rsOnly.length > 0) errors.push(`Rust only:\n  ${rsOnly.join('\n  ')}`)
        assert.strictEqual(errors.length, 0, `Method mismatch in ${className}:\n${errors.join('\n')}`)
      })
    }
  })
})
