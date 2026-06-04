import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import type { AnalyzeOptions } from './index.ts'
import { defaultAnalyzeRegulation } from './defaults.ts'
// @ts-ignore
import { analyze as wasmAnalyze } from '../retar-rs/pkg/retar.js'

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
      if (!inBlock) { inBlock = true; checkpoints.push({ lineNumber: i }) }
    } else { inBlock = false }
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

// Serialize Map/Set to plain objects for JSON
function serializeVillageStatus(vs: any): any {
  const obj: any = { ...vs }
  obj.statuses = Object.fromEntries(
    [...vs.statuses.entries()].map(([k, v]: [any, any]) => [
      String(k),
      {
        ...v,
        actions: Object.fromEntries(v.actions),
        assertions: Object.fromEntries(
          [...v.assertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
        ),
        forecasts: Object.fromEntries(
          [...v.forecasts.entries()].map(([day, s]: [any, any]) => [String(day), s])
        ),
        previousAssertions: v.previousAssertions
          ? Object.fromEntries(
              [...v.previousAssertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
            )
          : undefined,
        previousClaims: v.previousClaims?.map((pc: any) => ({
          ...pc,
          assertions: Object.fromEntries(
            [...pc.assertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
          ),
          actions: Object.fromEntries(pc.actions),
          forecasts: Object.fromEntries(
            [...pc.forecasts.entries()].map(([day, s]: [any, any]) => [String(day), s])
          ),
        })),
      },
    ])
  )
  obj.executions = Object.fromEntries(
    [...vs.executions.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.kills = Object.fromEntries(
    [...vs.kills.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.voteHistory = Object.fromEntries(
    [...vs.voteHistory.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.revoteTargets = [...vs.revoteTargets]
  obj.multiVoteDays = [...vs.multiVoteDays]
  // roles and claims are not used by Retar, skip them
  delete obj.roles
  delete obj.claims
  return obj
}

function serializeOptions(options: AnalyzeOptions): any {
  return {
    ...options,
    assumptions: Object.fromEntries(options.assumptions),
    hocusPocus: Object.fromEntries(options.hocusPocus),
  }
}

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
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i]
      const partialText = frontmatter + bodyLines.slice(0, cp.lineNumber).join('\n')
      targets.push({ name: title, label: `cp${i + 1} (L${cp.lineNumber + 1})`, text: partialText, meta })
    }
    targets.push({ name: title, label: 'full', text: content, meta })
  }
  return targets
}

function runOnce(target: BenchTarget): { elapsed: number } {
  const options = buildOptions(target.meta)
  const { statements } = parse(target.text)
  const { vs, setup } = buildVillageStatus(statements, target.meta)
  const vsJson = JSON.stringify(serializeVillageStatus(vs))
  const setupJson = JSON.stringify(Object.fromEntries(setup))
  const optJson = JSON.stringify(serializeOptions(options))
  const t0 = performance.now()
  wasmAnalyze(vsJson, setupJson, optJson)
  const elapsed = performance.now() - t0
  return { elapsed }
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
  console.log(`Retar WASM Benchmark: ${targets.length} targets, ${WARMUP} warmup + ${ITERATIONS} iterations\n`)

  type Result = { name: string, label: string, times: number[] }
  const results: Result[] = []

  for (const target of targets) {
    for (let i = 0; i < WARMUP; i++) runOnce(target)
    const times: number[] = []
    for (let i = 0; i < ITERATIONS; i++) {
      const { elapsed } = runOnce(target)
      times.push(elapsed)
    }
    results.push({ name: target.name, label: target.label, times })
  }

  console.log('─'.repeat(90))
  console.log(
    'Scenario'.padEnd(20),
    'Target'.padEnd(16),
    'Median'.padStart(10),
    'Mean'.padStart(10),
    'Min'.padStart(10),
    'Max'.padStart(10),
  )
  console.log('─'.repeat(90))

  let totalMedian = 0
  for (const r of results) {
    const med = median(r.times)
    const mean = r.times.reduce((a, b) => a + b, 0) / r.times.length
    const min = Math.min(...r.times)
    const max = Math.max(...r.times)
    totalMedian += med
    console.log(
      r.name.slice(0, 19).padEnd(20),
      r.label.padEnd(16),
      formatMs(med).padStart(10),
      formatMs(mean).padStart(10),
      formatMs(min).padStart(10),
      formatMs(max).padStart(10),
    )
  }
  console.log('─'.repeat(90))
  console.log(`Total median: ${formatMs(totalMedian)}`)
}

main()
