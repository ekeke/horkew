/**
 * 全員 SkollCommandAgent でコマンドバトルを N 回回し、D1 陣形統計を出力。
 *
 * D1 陣形 = 初日 (day=1) discussion で発生した CO 種別のカウント。
 *           占NN-霊NN-狩NN-猫NN-共NN 形式で canonicalize して頻度集計。
 *
 * 追加で以下も集計:
 * - 真役職ごとの CO 行動 (どの役職を騙ったか / 潜伏したか)
 * - 勝敗分布
 *
 * 14D猫構成（CommandPlayPane と同じ）:
 *   占1 霊1 狩1 共2 猫1 村2 狼3 信1 狐1 背1
 *
 * 使用例:
 *   node --experimental-strip-types cli/d1-formation-stats.ts --n=50
 *   node --experimental-strip-types cli/d1-formation-stats.ts --n=200 --seed=1000
 */
import type { SystemRole } from '../src/types/index.ts'
import type { GameEvent } from '../src/lupa/types.ts'
import type { GameConfig } from '../src/lupa/handlers.ts'
import { runGame } from '../src/lupa/engine.ts'
import { CommandAdapter } from '../src/fenrir/src/adapters/command/command-adapter.ts'
import { SkollCommandAgent } from '../src/fenrir/src/command-agents/skoll-command-agent.ts'
import { RandomCommandAgent } from '../src/fenrir/src/command-agents/random-command-agent.ts'

const ROLE_CONFIG = new Map<SystemRole, number>([
  ['seer', 1], ['medium', 1], ['bodyguard', 1], ['mason', 2], ['nekomata', 1],
  ['villager', 2], ['werewolf', 3], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

const CLAIM_LABEL: Record<string, string> = {
  seer_claim: '占',
  medium_claim: '霊',
  bodyguard_claim: '狩',
  nekomata_claim: '猫',
  mason_claim: '共',
}
const CLAIM_ORDER = ['seer_claim', 'medium_claim', 'bodyguard_claim', 'nekomata_claim', 'mason_claim']

// ---------- 引数パース ----------
function parseArgs(): { n: number, seed: number } {
  const args = new Map<string, string>()
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=')
    args.set(k, v ?? 'true')
  }
  return {
    n: parseInt(args.get('n') ?? '50'),
    seed: parseInt(args.get('seed') ?? '1'),
  }
}

// ---------- 1 ゲーム分の抽出 ----------
type D1Stats = {
  formation: string
  claims: Array<{ actor: number, claimType: string, trueRole: SystemRole }>
  /** D1 discussion 開始時に生存していた席の真役職（= 集計分母） */
  aliveAtD1Roles: SystemRole[]
  outcome: string | null
}

const DEATH_TYPES = new Set(['night_kill', 'fox_kill', 'curse_kill', 'follow_kill'])

async function runOne(seed: number): Promise<D1Stats> {
  const adapter = new CommandAdapter({
    agents: new Map(),
    defaultAgent: new SkollCommandAgent({ seed, fallback: new RandomCommandAgent(seed) }),
    roles: ROLE_CONFIG,
    seed,
  })
  const config: GameConfig = { roles: ROLE_CONFIG, seed }
  const result = await runGame(config, adapter)
  const events = result.events as GameEvent[]

  // 最初の execution イベント = D1 投票完了。その前までが D1 discussion
  let stopIdx = events.length
  for (let i = 0; i < events.length; i++) {
    if ((events[i] as { type?: string }).type === 'execution') {
      stopIdx = i
      break
    }
  }

  // D1 discussion 前に死んだ席を除外（D0 夜の噛み / 呪殺 / 後追い等）
  const deadBeforeD1 = new Set<number>()
  for (let i = 0; i < stopIdx; i++) {
    const ev = events[i] as { type?: string, target?: number }
    if (ev.type && DEATH_TYPES.has(ev.type) && ev.target !== undefined) {
      deadBeforeD1.add(ev.target)
    }
  }

  const claims: D1Stats['claims'] = []
  const claimedSeats = new Set<number>()
  for (let i = 0; i < stopIdx; i++) {
    const ev = events[i] as { type?: string, actor?: number }
    if (!ev.type || !(ev.type in CLAIM_LABEL)) continue
    const actor = ev.actor
    if (actor === undefined) continue
    // 1 プレイヤーが D1 に複数 CO することはない前提。重複出たら最初のみ採用
    if (claimedSeats.has(actor)) continue
    claimedSeats.add(actor)
    const player = result.state.players.find(p => p.seat === actor)
    if (!player) continue
    claims.push({ actor, claimType: ev.type, trueRole: player.role })
  }

  // 陣形 canonicalize
  const counts = new Map<string, number>()
  for (const c of claims) counts.set(c.claimType, (counts.get(c.claimType) ?? 0) + 1)
  const formation = CLAIM_ORDER.map(t => `${CLAIM_LABEL[t]}${counts.get(t) ?? 0}`).join('-')

  const aliveAtD1Roles: SystemRole[] = []
  for (const p of result.state.players) {
    if (!deadBeforeD1.has(p.seat)) aliveAtD1Roles.push(p.role)
  }

  return {
    formation,
    claims,
    aliveAtD1Roles,
    outcome: result.state.result,
  }
}

// ---------- main ----------
const { n: N, seed: baseSeed } = parseArgs()

console.log(`14D猫 × ${N} games, base seed=${baseSeed}`)
console.log(`ロール構成: ${[...ROLE_CONFIG.entries()].map(([r, c]) => `${r}${c}`).join(' ')}`)
console.log('')

const allStats: D1Stats[] = []
const t0 = Date.now()
for (let i = 0; i < N; i++) {
  const seed = baseSeed + i
  const stats = await runOne(seed)
  allStats.push(stats)
  const done = i + 1
  const elapsed = (Date.now() - t0) / 1000
  const etaSec = (elapsed / done) * (N - done)
  process.stdout.write(
    `\r  ${done}/${N} games | ${elapsed.toFixed(1)}s elapsed | ETA ${etaSec.toFixed(0)}s  `,
  )
}
process.stdout.write('\n\n')

// ---------- 集計 & 出力 ----------

// 1. 陣形頻度
const formationCounts = new Map<string, number>()
for (const s of allStats) {
  formationCounts.set(s.formation, (formationCounts.get(s.formation) ?? 0) + 1)
}
const sortedForms = [...formationCounts.entries()].sort(([, a], [, b]) => b - a)
console.log('===== Top 陣形 =====')
for (const [f, c] of sortedForms.slice(0, 15)) {
  const pct = (c / N * 100).toFixed(1)
  const bar = '█'.repeat(Math.round(c / N * 40))
  console.log(`  ${f}: ${c.toString().padStart(4)} (${pct.padStart(5)}%) ${bar}`)
}
if (sortedForms.length > 15) {
  const rest = sortedForms.slice(15).reduce((s, [, c]) => s + c, 0)
  console.log(`  ... 他 ${sortedForms.length - 15} 種 合計 ${rest} game`)
}

// 2. CO 件数のヒストグラム
console.log('\n===== CO 件数別 役職分布 =====')
for (const claimType of CLAIM_ORDER) {
  const hist = new Map<number, number>()
  for (const s of allStats) {
    const c = s.claims.filter(x => x.claimType === claimType).length
    hist.set(c, (hist.get(c) ?? 0) + 1)
  }
  const parts = [...hist.entries()].sort(([a], [b]) => a - b)
    .map(([k, v]) => `${k}=${v}(${(v / N * 100).toFixed(0)}%)`)
  console.log(`  ${CLAIM_LABEL[claimType]}CO: ${parts.join(' ')}`)
}

// 3. 真役職別 CO 行動（D1 discussion 開始時に生存していた席のみ分母）
const byRoleClaimed = new Map<SystemRole, Map<string, number>>()
const aliveByRole = new Map<SystemRole, number>()
for (const s of allStats) {
  for (const r of s.aliveAtD1Roles) aliveByRole.set(r, (aliveByRole.get(r) ?? 0) + 1)
  for (const c of s.claims) {
    let map = byRoleClaimed.get(c.trueRole)
    if (!map) { map = new Map(); byRoleClaimed.set(c.trueRole, map) }
    map.set(c.claimType, (map.get(c.claimType) ?? 0) + 1)
  }
}
console.log('\n===== 真役職別 CO 行動 (D1) =====')
console.log('  分母 = D1 discussion 開始時の生存席数（D0 夜で退場した席は除外）')
console.log('  (横軸 = どの役職として CO したか、hide = 潜伏)')
const header = `  ${'真役職'.padEnd(14)}${CLAIM_ORDER.map(t => CLAIM_LABEL[t].padStart(7)).join('')}${'hide'.padStart(7)}${'alive'.padStart(8)}`
console.log(header)
console.log('  ' + '-'.repeat(header.length - 2))
for (const role of [...aliveByRole.keys()].sort()) {
  const total = aliveByRole.get(role) ?? 0
  const claimed = byRoleClaimed.get(role) ?? new Map()
  let coSum = 0
  const cells = CLAIM_ORDER.map(t => {
    const c = claimed.get(t) ?? 0
    coSum += c
    return c === 0 ? '.'.padStart(7) : `${(c / total * 100).toFixed(0)}%`.padStart(7)
  })
  const hideCount = total - coSum
  const hideCell = `${(hideCount / total * 100).toFixed(0)}%`.padStart(7)
  console.log(`  ${role.padEnd(14)}${cells.join('')}${hideCell}${total.toString().padStart(8)}`)
}

// 4. 勝敗分布
const outcomes = new Map<string, number>()
for (const s of allStats) outcomes.set(s.outcome ?? 'unfinished', (outcomes.get(s.outcome ?? 'unfinished') ?? 0) + 1)
console.log('\n===== 勝敗 =====')
for (const [k, v] of [...outcomes.entries()].sort()) {
  console.log(`  ${k}: ${v} (${(v / N * 100).toFixed(1)}%)`)
}

const totalSec = (Date.now() - t0) / 1000
console.log(`\n${N} games, ${totalSec.toFixed(1)}s (${(totalSec / N).toFixed(2)}s/game)`)
