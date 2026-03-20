/**
 * CLI: Vote summary per day for a .howl scenario file.
 * Usage: node --experimental-strip-types tools/vote-summary.ts <path-to-howl-file>
 */
import { readFileSync } from 'node:fs'
import { parse } from '../src/howl/parser.ts'
import { buildVillageStatus } from '../src/howl/bridge.ts'
import { extractVoteStatus, computeVerdicts } from '../demo/status/extract.ts'
import type { VoteVerdictInfo } from '../demo/status/extract.ts'

const file = process.argv[2]
if (!file) {
  console.error('Usage: node --experimental-strip-types tools/vote-summary.ts <file.howl>')
  process.exit(1)
}

const content = readFileSync(file, 'utf-8')
const { statements: rawStatements, meta } = parse(content)

// Filter out frontmatter-leaked statements (lines within --- ... --- block)
const lines = content.split(/\r?\n/)
let frontmatterEnd = 0
if (lines[0]?.trim() === '---') {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      frontmatterEnd = i + 2 // 1-indexed line number after closing --- (i is 0-indexed, parse uses 1-indexed lines)
      break
    }
  }
}
const statements = rawStatements.filter(s => s.line >= frontmatterEnd)

// Find snapshot points: just before each lynch statement, at each revote, and after final votes
type Snapshot = { label: string, endIndex: number }
const snapshots: Snapshot[] = []
let day = 1
let revoteCount = 0

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i]
  if (stmt.day !== undefined && stmt.day > day) {
    day = stmt.day
    revoteCount = 0
  }
  if (stmt.type === 'revote') {
    snapshots.push({ label: `Day ${day} 投票${revoteCount > 0 ? ` (再投票${revoteCount})` : ''}`, endIndex: i })
    revoteCount++
  }
  if (stmt.type === 'lynch') {
    snapshots.push({ label: `Day ${day} 投票${revoteCount > 0 ? ` (再投票${revoteCount})` : ''}`, endIndex: i })
    revoteCount = 0
  }
}

// Snapshot final state if there are votes after last snapshot
const lastSnapIdx = snapshots.length > 0 ? snapshots[snapshots.length - 1].endIndex : -1
const hasVotesAfter = statements.slice(lastSnapIdx + 1).some(s => s.type === 'vote' || s.type === 'multiVote')
if (hasVotesAfter) {
  snapshots.push({ label: `Day ${day} 投票 (最終)`, endIndex: statements.length })
}

function verdictTag(info: VoteVerdictInfo | undefined): string {
  if (!info) return ''
  switch (info.verdict) {
    case 'execution_locked': return info.executionVoterName ? ` [${info.executionVoterName}が処刑確定]` : ' [処刑確定]'
    case 'runoff_locked': return info.runoffVoterName ? ` [${info.runoffVoterName}が決戦↑確定]` : ' [決戦↑確定]'
    case 'safe': return info.savedBy ? ` [${info.savedBy}が救済]` : ' [救済]'
    default: return ''
  }
}

for (const snap of snapshots) {
  const subset = statements.slice(0, snap.endIndex)
  const { vs, players } = buildVillageStatus(subset, meta)
  const status = extractVoteStatus(vs, players)

  console.log(`\n=== ${snap.label} ===`)
  if (!status.hasAnyVotes) {
    console.log('  (投票なし)')
    continue
  }

  const verdicts = computeVerdicts(status)

  console.log(`  生存${status.totalVoters}人  投票済${status.totalVoters - status.remainingVotes}  残り${status.remainingVotes}票`)
  console.log()

  // Collect all decisive votedOrders across all candidates
  const runoffOrders = new Set<number>()
  const execOrders = new Set<number>()
  for (const v of verdicts.values()) {
    if (v.runoffVoterOrder !== undefined) runoffOrders.add(v.runoffVoterOrder)
    if (v.executionVoterOrder !== undefined) execOrders.add(v.executionVoterOrder)
  }

  for (const row of status.rows) {
    const info = verdicts.get(row.seat)
    const voterNames = row.voters.map(v => {
      const markers: string[] = []
      if (runoffOrders.has(v.votedOrder)) markers.push('決戦')
      if (execOrders.has(v.votedOrder)) markers.push('処刑')
      const marker = markers.length > 0 ? `(${markers.join(',')})` : ''
      return v.name + marker
    })
    const tag = verdictTag(info)
    console.log(`  ${row.name}: ${row.votedCount}票${tag}  ← ${voterNames.join(', ')}`)
  }

  if (status.pending.length > 0) {
    console.log(`  未投票: ${status.pending.map(p => p.name).join(', ')}`)
  }
}
