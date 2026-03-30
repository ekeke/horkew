/**
 * retar (TS) と retar-rs (Rust) のファイル名・関数名の同期チェック
 * 静的解析でソースコードを読み、camelCase↔snake_case の機械的変換で対応を検証する
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

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
}

// 片方にしか存在しなくてよいファイル（WASMブリッジ、型定義など）
const TS_ONLY_FILES = new Set(['wasm-helpers', 'dump'])
const RS_ONLY_FILES = new Set(['lib', 'types'])

// ── 関数名の許可リスト（言語イディオムの違いで一致不要） ──

// ファイル単位の許可リスト: { tsFile: { tsOnly: [...], rsOnly: [...] } }
// ここに入れた関数は比較対象外になる。理由をコメントで明記すること。
const ALLOWED_MISMATCHES: Record<string, { tsOnly?: string[], rsOnly?: string[] }> = {
  combinatorics: {
    tsOnly: [
      'selectOne',          // TSジェネレータ、Rustではコールバックパターンで不要
      'backtrackForMatrix', // TSジェネレータ、Rustでは未使用
    ],
    rsOnly: [
      'generate_combinations_collect', // Rustのcollect版、TSではジェネレータで代替
    ],
  },
  finalizer: {
    tsOnly: [
      'createDebugStash', // TSファクトリ関数、Rustでは構造体の Default/初期化で代替
    ],
    rsOnly: [
      'constrain_by_death_counts_mut', // Rust所有権モデル用のミュータブル版
    ],
  },
  possibilities: {
    tsOnly: [
      'roleCount',                      // Rust未移植（pop_count でインライン代替）
      'intersectionOfRolePossibility',  // Rust未移植（ビット演算でインライン化）
      'differenceOfRolePossibilities',  // Rust未移植（ビット演算でインライン化）
    ],
  },
  roleTesters: {
    tsOnly: [
      'cloneContext', // Rustでは save_context/restore_context で代替
    ],
    rsOnly: [
      'test_role', // Rustではディスパッチ関数として pub fn、TSでは roleTesterMap 経由
    ],
  },
}

// クラス/structメソッドの許可リスト
const ALLOWED_METHOD_MISMATCHES: Record<string, { tsOnly?: string[], rsOnly?: string[] }> = {
  Possibilities: {
    tsOnly: [
      'clone',  // Rustでは clone_instance（Cloneトレイトとの衝突回避）
      'toObj',  // TSデバッグ用、Rust不要
    ],
    rsOnly: [
      'from_setup',              // Rustファクトリ、TSではコンストラクタで処理
      'with_seat_count',         // Rustファクトリ、TSではコンストラクタで処理
      'seat_count',              // Rustゲッター、TSでは直接フィールドアクセス
      'clone_instance',          // TSでは clone（Cloneトレイト衝突回避のため名前が異なる）
      'set_role',                // Rust追加メソッド、TSでは set() で代替
    ],
  },
  VillageRetar: {
    tsOnly: [
      'getStatus',       // Rust未移植（WASM経由で不要）
      'extractMetadata', // Rust未移植（WASM経由で不要）
      'testRole',        // Rust未移植
      'finalize',        // TSでは public wrapper、Rustでは内部呼び出しのみ
      'analyzeSafe',     // TSエラーハンドリング用、Rustでは Result 型で代替
    ],
    rsOnly: [
      'new',                    // Rustコンストラクタ慣習、TSでは constructor
      'initial_possibilities',  // Rustゲッター、TSでは直接フィールドアクセス
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
  // メソッド定義: "  methodName(" or "  private methodName(" or "  static methodName("
  for (const m of classBody.matchAll(/^  (?:(private|static)\s+)?(\w+)\s*\(/gm)) {
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

function extractRsPubFunctions(source: string): string[] {
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

        // TS export → Rust: TS exportにあってRustにない
        const tsOnlyFns: string[] = []
        for (const fn of tsExported) {
          if (tsAllowed.has(fn)) continue
          const expectedRs = camelToSnake(fn)
          if (!rsFns.includes(expectedRs)) {
            tsOnlyFns.push(`${fn} (expected: ${expectedRs})`)
          }
        }

        // Rust → TS: Rustにあって TS(export+internal) にない
        const tsAll = new Set([...tsExported, ...tsInternal])
        const rsOnlyFns: string[] = []
        for (const fn of rsFns) {
          if (rsAllowed.has(fn)) continue
          const expectedTs = snakeToCamel(fn)
          if (!tsAll.has(expectedTs)) {
            rsOnlyFns.push(`${fn} (expected: ${expectedTs})`)
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
