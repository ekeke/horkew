import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import type { AnalyzeOptions } from './index.ts'
import type { DebugStash } from './finalizer.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, 'scenarios')

const WARMUP = 3
const ITERATIONS = 20

const defaultOptions: AnalyzeOptions = {
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

// --- Checkpoint extraction (same as integration.test.ts) ---

const expectPattern = /^#\s*@expect(?:-skip)?\s+(.+)$/

function extractCheckpoints(rawText: string) {
  const fmMatch = rawText.match(/^(---\n[\s\S]*?\n---\n)/)
  const frontmatter = fmMatch ? fmMatch[1] : ''
  const bodyText = fmMatch ? rawText.slice(fmMatch[1].length) : rawText
  const bodyLines = bodyText.split('\n')

  const checkpoints: { lineNumber: number }[] = []
  let inBlock = false

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim()
    if (expectPattern.test(line)) {
      if (!inBlock) {
        inBlock = true
        checkpoints.push({ lineNumber: i })
      }
    } else {
      inBlock = false
    }
  }

  return { frontmatter, bodyLines, checkpoints }
}

function buildOptions(meta: Record<string, any>): AnalyzeOptions {
  return {
    ...defaultOptions,
    ...(meta.options || {}),
    assumptions: meta.options?.assumptions
      ? new Map(Object.entries(meta.options.assumptions))
      : defaultOptions.assumptions,
    hocusPocus: meta.options?.hocusPocus
      ? new Map(Object.entries(meta.options.hocusPocus))
      : defaultOptions.hocusPocus,
  }
}

// --- Benchmark targets ---

type BenchTarget = {
  name: string
  label: string
  text: string
  meta: Record<string, any>
}

function loadTargets(): BenchTarget[] {
  const files = readdirSync(scenariosDir).filter(f => f.endsWith('.howl')).sort()
  const targets: BenchTarget[] = []

  for (const file of files) {
    const content = readFileSync(join(scenariosDir, file), 'utf-8').replace(/\r\n/g, '\n')
    const { meta } = parse(content)
    const title = (meta.title || file) as string
    const { frontmatter, bodyLines, checkpoints } = extractCheckpoints(content)
    const options = buildOptions(meta)

    // Each checkpoint as a target
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i]
      const partialText = frontmatter + bodyLines.slice(0, cp.lineNumber).join('\n')
      targets.push({
        name: title,
        label: `cp${i + 1} (L${cp.lineNumber + 1})`,
        text: partialText,
        meta,
      })
    }

    // Full scenario as a target
    targets.push({
      name: title,
      label: 'full',
      text: content,
      meta,
    })
  }

  return targets
}

// --- Run benchmark ---

function runOnce(target: BenchTarget): { elapsed: number, stash: DebugStash } {
  const options = buildOptions(target.meta)
  const { statements } = parse(target.text)
  const { vs, setup } = buildVillageStatus(statements, target.meta)
  const retar = new VillageRetar(vs, setup, options)
  const t0 = performance.now()
  retar.analyze()
  const elapsed = performance.now() - t0
  return { elapsed, stash: retar.debugStash }
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
  if (ms < 100) return `${ms.toFixed(2)}ms`
  return `${ms.toFixed(0)}ms`
}

function main() {
  const targets = loadTargets()
  console.log(`Retar Benchmark: ${targets.length} targets, ${WARMUP} warmup + ${ITERATIONS} iterations\n`)

  type Result = {
    name: string
    label: string
    times: number[]
    stash: DebugStash
  }

  const results: Result[] = []

  for (const target of targets) {
    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      runOnce(target)
    }

    // Measure
    const times: number[] = []
    let lastStash: DebugStash = null!
    for (let i = 0; i < ITERATIONS; i++) {
      const { elapsed, stash } = runOnce(target)
      times.push(elapsed)
      lastStash = stash
    }

    results.push({
      name: target.name,
      label: target.label,
      times,
      stash: lastStash,
    })
  }

  // Output table
  console.log('─'.repeat(120))
  console.log(
    'Scenario'.padEnd(20),
    'Target'.padEnd(16),
    'Median'.padStart(10),
    'Mean'.padStart(10),
    'Min'.padStart(10),
    'Max'.padStart(10),
    '│',
    'Tests'.padStart(8),
    'Passes'.padStart(8),
    'Finalize'.padStart(8),
    'FinalOK'.padStart(8),
  )
  console.log('─'.repeat(120))

  let totalMedian = 0

  for (const r of results) {
    const med = median(r.times)
    const mean = r.times.reduce((a, b) => a + b, 0) / r.times.length
    const min = Math.min(...r.times)
    const max = Math.max(...r.times)
    totalMedian += med

    const totalTests =
      r.stash.seerTests + r.stash.mediumTests + r.stash.bodyguardTests +
      r.stash.masonTests + r.stash.nekomataTests + r.stash.werehamsterTests

    const totalPasses =
      r.stash.seerTestPasses + r.stash.mediumTestPasses + r.stash.bodyguardTestPasses +
      r.stash.masonTestPasses + r.stash.nekomataTestPasses + r.stash.werehamsterTestPasses

    console.log(
      r.name.slice(0, 19).padEnd(20),
      r.label.padEnd(16),
      formatMs(med).padStart(10),
      formatMs(mean).padStart(10),
      formatMs(min).padStart(10),
      formatMs(max).padStart(10),
      '│',
      String(totalTests).padStart(8),
      String(totalPasses).padStart(8),
      String(r.stash.finalizerRuns).padStart(8),
      String(r.stash.finalizerPasses).padStart(8),
    )
  }

  console.log('─'.repeat(120))
  console.log(`Total median: ${formatMs(totalMedian)}`)
}

main()
