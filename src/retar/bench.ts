import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from './index.ts'
import type { AnalyzeOptions } from './index.ts'
import { defaultAnalyzeRegulation } from './defaults.ts'
import type { DebugStash } from './finalizer.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(__dirname, 'scenarios')

const WARMUP = 3
const ITERATIONS = 20

const defaultOptions: AnalyzeOptions = {
  regulation: defaultAnalyzeRegulation,
  seerClaimingDueDate: 2,
  mediumClaimingDueDate: 2,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 2,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  assumptions: new Map(),
  wolfPairDenyals: [],
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

  // Compute stats per result
  type Stat = {
    name: string
    label: string
    med: number
    mean: number
    min: number
    max: number
    tests: number
    passes: number
    finalize: number
    finalOK: number
  }

  const stats: Stat[] = results.map(r => {
    const totalTests = Object.values(r.stash.roleTests).reduce((a, b) => a + b, 0)
    const totalPasses = Object.values(r.stash.roleTestPasses).reduce((a, b) => a + b, 0)
    return {
      name: r.name,
      label: r.label,
      med: median(r.times),
      mean: r.times.reduce((a, b) => a + b, 0) / r.times.length,
      min: Math.min(...r.times),
      max: Math.max(...r.times),
      tests: totalTests,
      passes: totalPasses,
      finalize: r.stash.finalizerRuns,
      finalOK: r.stash.finalizerPasses,
    }
  })

  // Group by scenario name
  const groups: Map<string, Stat[]> = new Map()
  for (const s of stats) {
    let arr = groups.get(s.name)
    if (!arr) { arr = []; groups.set(s.name, arr) }
    arr.push(s)
  }

  // Output table
  const W = 120
  const header = [
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
  ].join(' ')
  console.log('─'.repeat(W))
  console.log(header)
  console.log('─'.repeat(W))

  let totalMedian = 0

  for (const [_name, group] of groups) {
    for (const s of group) {
      totalMedian += s.med
      console.log(
        s.name.slice(0, 19).padEnd(20),
        s.label.padEnd(16),
        formatMs(s.med).padStart(10),
        formatMs(s.mean).padStart(10),
        formatMs(s.min).padStart(10),
        formatMs(s.max).padStart(10),
        '│',
        String(s.tests).padStart(8),
        String(s.passes).padStart(8),
        String(s.finalize).padStart(8),
        String(s.finalOK).padStart(8),
      )
    }
    // Scenario summary row
    if (group.length > 1) {
      const avgMed = group.reduce((a, s) => a + s.med, 0) / group.length
      const avgMean = group.reduce((a, s) => a + s.mean, 0) / group.length
      const bestMin = Math.min(...group.map(s => s.min))
      console.log(
        ''.padEnd(20),
        `(avg ×${group.length})`.padEnd(16),
        formatMs(avgMed).padStart(10),
        formatMs(avgMean).padStart(10),
        formatMs(bestMin).padStart(10),
        ''.padStart(10),
        '│',
      )
    }
  }

  console.log('─'.repeat(W))
  console.log(`Total median: ${formatMs(totalMedian)}`)
}

main()
