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

import type { SystemRole } from '../types/index.ts'
import type { RetarResult } from '../fenrir/src/retar-bridge.ts'
import type { BloodhoundPhase, Persona } from './types.ts'
import type { LegalActions } from './legal-actions.ts'

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
  retar: RetarResult
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
  sections.push(renderRetar(input.retar, input.selfSeat))
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

function renderRetar(retar: RetarResult, selfSeat: number): string {
  const lines: string[] = [`## Retar analysis (flat, with your role assumed)`, ``]
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
    `You may call \`retar\` multiple times before settling on your final action;`,
    `the tool result will be returned to you in a subsequent turn.`,
    `Stay within the legal tool set above.`,
  ].join('\n')
}
