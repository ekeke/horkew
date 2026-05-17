/**
 * Build the system + user prompts handed to the Anthropic API for one
 * Bloodhound LLM call.
 *
 * - System prompt = common.md + role/<role>.md + phase/<phase>.md
 * - User prompt = self/persona block + private knowledge + Howl log
 *                  + flat retar summary + legal actions + final task line
 *
 * Prompt .md files are read from `./prompts/` and cached after first read.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { SystemRole, VillageStatus, SeatStatus } from '../types/index.ts'
import type { RetarResult } from '../fenrir/src/retar-bridge.ts'
import type { BloodhoundPhase, Persona } from './types.ts'
import type { LegalActions } from './legal-actions.ts'
import type { SkollResult } from './skoll-precompute.ts'
import type { HatiResult } from './hati-precompute.ts'
import { formatSkollResult, formatHatiResult } from './anthropic-client.ts'

// ---------------------------------------------------------------------------
// Prompt file loading (cached)
// ---------------------------------------------------------------------------

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts')
const promptCache = new Map<string, string>()

function loadPrompt(relPath: string): string {
  let cached = promptCache.get(relPath)
  if (cached === undefined) {
    cached = readFileSync(join(PROMPTS_DIR, relPath), 'utf8')
    promptCache.set(relPath, cached)
  }
  return cached
}

const ROLE_PROMPT_FILE: Record<SystemRole, string> = {
  villager:    'role/villager.md',
  seer:        'role/seer.md',
  medium:      'role/medium.md',
  bodyguard:   'role/bodyguard.md',
  mason:       'role/mason.md',
  nekomata:    'role/nekomata.md',
  werewolf:    'role/werewolf.md',
  fanatic:     'role/fanatic.md',
  possessed:   'role/fanatic.md',
  werehamster: 'role/werehamster.md',
  immoralist:  'role/immoralist.md',
}

const PHASE_PROMPT_FILE: Record<BloodhoundPhase, string> = {
  discussion:      'phase/discussion.md',
  vote:            'phase/vote.md',
  revote:          'phase/vote.md',
  night_seer:      'phase/night_seer.md',
  night_bodyguard: 'phase/night_bodyguard.md',
  night_wolf:      'phase/night_wolf.md',
  last_will:       'phase/last_will.md',
}

// ---------------------------------------------------------------------------
// Public input type
// ---------------------------------------------------------------------------

export type PrivateInfo = {
  masonPartner?: number
  fellowWolves?: number[]
  fanaticKnownWolves?: number[]
  immoralistKnownFox?: number
  divineHistory?: ReadonlyArray<{ day: number; target: number; result: 'human' | 'wolf' }>
  guardHistory?: ReadonlyArray<{ day: number; target: number }>
  mediumHistory?: ReadonlyArray<{ day: number; result: 'human' | 'wolf' }>
}

export type BuildPromptInput = {
  phase: BloodhoundPhase
  role: SystemRole
  selfSeat: number
  persona: Persona
  howlText: string
  /** VillageStatus parsed from the public event log; null if unparseable. */
  publicVs?: VillageStatus | null
  /** Public retar from the event log alone, no private knowledge applied. */
  retarPublic?: RetarResult
  /** Viewer-perspective retar: self role + private knowledge injected. */
  retar: RetarResult
  /** Optional flat skoll pre-compute (viewer-role assumed). null when log was unparseable. */
  skoll?: SkollResult | null
  /** Optional flat hati pre-compute (viewer-role assumed). null when log was unparseable. */
  hati?: HatiResult | null
  legal: LegalActions
  privateInfo?: PrivateInfo
  discussionRound?: number
  maxDiscussionRounds?: number
  voteCandidates?: readonly number[] | null
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildPrompts(input: BuildPromptInput): { system: string; user: string } {
  return {
    system: buildSystemPrompt(input.role, input.phase),
    user: buildUserPrompt(input),
  }
}

function buildSystemPrompt(role: SystemRole, phase: BloodhoundPhase): string {
  const common = loadPrompt('common.md')
  const roleFile = ROLE_PROMPT_FILE[role] ?? 'role/villager.md'
  const rolePrompt = loadPrompt(roleFile)
  const phasePrompt = loadPrompt(PHASE_PROMPT_FILE[phase])
  return [common, rolePrompt, phasePrompt].join('\n\n---\n\n')
}

function buildUserPrompt(input: BuildPromptInput): string {
  const sections: string[] = []
  sections.push(renderSelf(input))
  sections.push(renderPrivateInfo(input))
  sections.push(renderHowl(input.howlText))
  sections.push(renderCoTable(input.publicVs))
  sections.push(renderRetarPublic(input.retarPublic, input.selfSeat))
  sections.push(renderRetar(input.retar, input.selfSeat))
  sections.push(renderSkoll(input.skoll))
  sections.push(renderHati(input.hati))
  sections.push(renderLegalActions(input))
  sections.push(renderTask())
  return sections.filter(s => s.length > 0).join('\n\n')
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderSelf(input: BuildPromptInput): string {
  const { selfSeat, role, persona } = input
  return [
    `## You`,
    ``,
    `- Seat: seat-${selfSeat}`,
    `- Role: ${role}`,
    `- Persona: ${persona.gender}, ${persona.trait}`,
    `  - Voice sample (use this tone for \`say\` only): "${persona.toneSample}"`,
  ].join('\n')
}

function renderPrivateInfo(input: BuildPromptInput): string {
  const info = input.privateInfo
  if (!info) return ''
  const lines: string[] = [`## Private knowledge`, ``]
  if (info.masonPartner !== undefined) {
    lines.push(`- Mason partner: seat-${info.masonPartner}`)
  }
  if (info.fellowWolves && info.fellowWolves.length > 0) {
    lines.push(`- Fellow wolves: ${info.fellowWolves.map(s => `seat-${s}`).join(', ')}`)
  }
  if (info.fanaticKnownWolves && info.fanaticKnownWolves.length > 0) {
    lines.push(`- Wolves you secretly know (fanatic): ${info.fanaticKnownWolves.map(s => `seat-${s}`).join(', ')}`)
  }
  if (info.immoralistKnownFox !== undefined) {
    lines.push(`- Werehamster you secretly know (immoralist): seat-${info.immoralistKnownFox}`)
  }
  if (info.divineHistory && info.divineHistory.length > 0) {
    lines.push(`- Your divine history:`)
    for (const r of info.divineHistory) {
      lines.push(`  - Night ${r.day}: seat-${r.target} → ${r.result}`)
    }
  }
  if (info.guardHistory && info.guardHistory.length > 0) {
    lines.push(`- Your guard history:`)
    for (const r of info.guardHistory) {
      lines.push(`  - Night ${r.day}: seat-${r.target}`)
    }
  }
  if (info.mediumHistory && info.mediumHistory.length > 0) {
    lines.push(`- Your medium history:`)
    for (const r of info.mediumHistory) {
      lines.push(`  - Day ${r.day} executed: ${r.result}`)
    }
  }
  return lines.length > 2 ? lines.join('\n') : ''
}

function renderHowl(howlText: string): string {
  return [`## Game log (Howl format)`, ``, '```howl', howlText.trimEnd(), '```'].join('\n')
}

function renderCoTable(vs: VillageStatus | null | undefined): string {
  if (!vs) return ''
  const lines: string[] = [`## Public CO table`, ``]

  type Entry = { seat: number; role: SystemRole; claimedAt?: number; claimOrder?: number; status: SeatStatus }
  const entries: Entry[] = []
  for (const [seat, status] of vs.statuses) {
    if (!status.claiming) continue
    entries.push({
      seat,
      role: status.claimingRole as SystemRole,
      claimedAt: status.claimedAt,
      claimOrder: status.claimOrder,
      status,
    })
  }
  entries.sort((a, b) => (a.claimOrder ?? 0) - (b.claimOrder ?? 0))

  if (entries.length === 0) {
    lines.push(`(No CO yet.)`)
  } else {
    for (const e of entries) {
      const dayStr = e.claimedAt !== undefined ? `D${e.claimedAt}` : 'D?'
      const extras = renderCoExtras(e.role, e.status)
      lines.push(`- seat-${e.seat} — ${e.role} (CO on ${dayStr})${extras.length > 0 ? ' — ' + extras.join(' — ') : ''}`)
    }
    const claimed = new Set(entries.map(e => e.role))
    const claimable: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']
    const missing = claimable.filter(r => !claimed.has(r))
    if (missing.length > 0) {
      lines.push(``)
      lines.push(`No CO yet for: ${missing.join(', ')}`)
    }
  }
  return lines.join('\n')
}

/**
 * Pull per-role detail out of a SeatStatus for the CO table.
 *
 * Storage conventions used by `howl/bridge.ts`:
 *   - seer / medium results: `status.assertions` with **positive** key = night
 *   - mason partner(s):      `status.assertions` with **negative** key
 *   - bodyguard guards:      `status.actions` (Map<night, target>)
 *   - seer forecasts:        `status.forecasts` (Map<day, target>)
 */
function renderCoExtras(role: SystemRole, status: SeatStatus): string[] {
  const extras: string[] = []
  if (role === 'seer') {
    const results: string[] = []
    const nights = [...status.assertions.keys()].filter(k => k >= 0).sort((a, b) => a - b)
    for (const night of nights) {
      const a = status.assertions.get(night)!
      const sym = a.species === 'wolf' ? '●' : a.species === 'human' ? '○' : '?'
      results.push(`D${night} seat-${a.target}→${sym}`)
    }
    const forecastDays = [...status.forecasts.keys()].sort((a, b) => a - b)
    for (const day of forecastDays) {
      results.push(`D${day} forecast seat-${status.forecasts.get(day)!}`)
    }
    if (results.length > 0) extras.push(`results: ${results.join(', ')}`)
  } else if (role === 'medium') {
    const results: string[] = []
    const days = [...status.assertions.keys()].filter(k => k >= 0).sort((a, b) => a - b)
    for (const day of days) {
      const a = status.assertions.get(day)!
      const sym = a.species === 'wolf' ? '●' : a.species === 'human' ? '○' : '?'
      results.push(`D${day} seat-${a.target}→${sym}`)
    }
    if (results.length > 0) extras.push(`results: ${results.join(', ')}`)
  } else if (role === 'bodyguard') {
    const nights = [...status.actions.keys()].sort((a, b) => a - b)
    const guards = nights.map(n => `D${n} seat-${status.actions.get(n)!}`)
    if (guards.length > 0) extras.push(`guards: ${guards.join(', ')}`)
  } else if (role === 'mason') {
    // Partners can land at either negative-key (joint mason statement) or
    // positive-key (assert statement that named the partner). De-dup seats.
    const seen = new Set<number>()
    for (const [, a] of status.assertions) {
      if (a.target !== undefined) seen.add(a.target)
    }
    if (seen.size > 0) {
      const partners = [...seen].sort((a, b) => a - b).map(s => `seat-${s}`)
      extras.push(`partner: ${partners.join(', ')}`)
    }
  }
  return extras
}

function renderRetarPublic(retar: RetarResult | undefined, selfSeat: number): string {
  if (!retar) return ''
  return renderRetarSection(
    retar, selfSeat,
    `## Retar (public — what every seat can derive from the log alone)`,
  )
}

function renderRetar(retar: RetarResult, selfSeat: number): string {
  return renderRetarSection(
    retar, selfSeat,
    `## Retar (your view — your own role plus private knowledge assumed)`,
  )
}

function renderRetarSection(retar: RetarResult, selfSeat: number, header: string): string {
  const lines: string[] = [header, ``]
  const seats = [...retar.possibilities.keys()].sort((a, b) => a - b)
  if (seats.length === 0) {
    lines.push(`(no possibilities computed; the game log may not yet be parseable)`)
  } else {
    for (const seat of seats) {
      const set = retar.possibilities.get(seat)!
      const roles = [...set].sort()
      const tag = seat === selfSeat ? ' (you)' : ''
      lines.push(`- seat-${seat}${tag}: ${roles.length === 0 ? '(none — contradiction)' : roles.join(', ')}`)
    }
  }
  lines.push(``)
  lines.push(`Max surviving non-village count: ${retar.maxSurvivingNV}`)
  return lines.join('\n')
}

function renderSkoll(skoll: SkollResult | null | undefined): string {
  if (!skoll) return ''
  // When world enumeration hit the cap the per-seat averages are biased by
  // whichever worlds were visited first, so embedding them in the prompt
  // would mislead the LLM more than it helps. Tell the LLM to narrow the
  // analysis with an assumption-bearing tool call instead.
  if (skoll.truncated) {
    return [
      `## Skoll: village win rate per execution (flat, your role assumed)`,
      ``,
      `(Skipped — world enumeration hit the ${skoll.totalWorlds.toLocaleString('en-US')}-world cap.`,
      `The flat per-seat averages would be biased here. Call the \`skoll\` tool with`,
      `\`assumptions\` to constrain the world set if you need a number.)`,
    ].join('\n')
  }
  return [
    `## Skoll: village win rate per execution (flat, your role assumed)`,
    ``,
    formatSkollResult(skoll),
  ].join('\n')
}

function renderHati(hati: HatiResult | null | undefined): string {
  if (!hati) return ''
  return [
    `## Hati: tsumi judgment (flat, your role assumed)`,
    ``,
    formatHatiResult(hati),
  ].join('\n')
}

function renderLegalActions(input: BuildPromptInput): string {
  const { legal, phase, discussionRound, maxDiscussionRounds, voteCandidates } = input
  const lines: string[] = [`## This turn`, ``]
  if (phase === 'discussion' && discussionRound !== undefined) {
    const total = maxDiscussionRounds ?? '?'
    const remaining = typeof total === 'number' ? Math.max(0, total - discussionRound) : '?'
    lines.push(`- Phase: discussion (round ${discussionRound} of ${total}; ${remaining} round${remaining === 1 ? '' : 's'} remaining after this one)`)
  } else {
    lines.push(`- Phase: ${phase}`)
  }
  lines.push(`- Legal tools: ${legal.toolNames.join(', ')}`)
  if (legal.targets.vote) {
    lines.push(`- Vote candidates: ${legal.targets.vote.map(s => `seat-${s}`).join(', ')}`)
  } else if (voteCandidates && voteCandidates.length > 0) {
    lines.push(`- Vote candidates: ${voteCandidates.map(s => `seat-${s}`).join(', ')}`)
  }
  for (const key of ['divine', 'guard', 'attack', 'report_divination', 'report_medium'] as const) {
    const targets = legal.targets[key]
    if (!targets || targets.length === 0) continue
    lines.push(`- ${key} candidates: ${targets.map(s => `seat-${s}`).join(', ')}`)
  }
  return lines.join('\n')
}

function renderTask(): string {
  return [
    `## Your task`,
    ``,
    `Reason briefly, then call one or more tools to take your action.`,
    `You may call auxiliary tools (\`retar\`, \`skoll\`, \`hati\`) multiple times before`,
    `settling on your final action; each result is returned to you in a subsequent turn.`,
    `Stay within the legal tool set above.`,
  ].join('\n')
}
