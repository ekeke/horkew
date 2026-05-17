/**
 * Anthropic SDK wrapper for one Bloodhound turn.
 *
 * Drives the tool-use loop:
 *   1. Send system + user prompts with the legal tool set.
 *   2. If the LLM returns auxiliary tool_use blocks (retar / craft_deception),
 *      execute them locally and feed results back as tool_result blocks;
 *      repeat.
 *   3. As soon as the LLM emits at least one non-auxiliary (action) tool,
 *      the response is terminal and all tool calls are returned verbatim.
 *
 * The loop is bounded by `maxAuxIterations`. On overflow we force one
 * final call with auxiliary tools stripped so the LLM must commit.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import type { RetarResult } from '../fenrir/src/retar-bridge.ts'
import type { SystemRole } from '../types/index.ts'
import type { StrategyNode, VillageAction } from '../hati/index.ts'
import type { ToolCall, ToolName, Persona } from './types.ts'
import type { ToolDef } from './tools.ts'
import { SKOLL_TIE_TOLERANCE, type SkollResult } from './skoll-precompute.ts'
import type { HatiResult } from './hati-precompute.ts'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_MAX_AUX_ITERATIONS = 10
const DECEPTION_MAX_TOKENS = 600
const API_MAX_RETRIES = 5
const API_INITIAL_BACKOFF_MS = 1000
const API_MAX_BACKOFF_MS = 30000

// Retry transient API errors (5xx, 429, network) with exponential backoff.
// Non-retryable errors (4xx other than 429) bubble up immediately.
async function retryTransient<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number }).status
      const isRetryable = status === undefined
        || (status >= 500 && status < 600)
        || status === 429
      if (!isRetryable || attempt === API_MAX_RETRIES) throw err
      const wait = Math.min(API_INITIAL_BACKOFF_MS * (2 ** attempt), API_MAX_BACKOFF_MS)
      const tag = status !== undefined ? `status=${status}` : 'network error'
      // eslint-disable-next-line no-console
      console.error(`[bloodhound] ${label}: ${tag}, retrying in ${wait}ms (attempt ${attempt + 1}/${API_MAX_RETRIES})`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw lastErr
}

const AUXILIARY_TOOL_NAMES = new Set<ToolName>(['retar', 'skoll', 'hati', 'craft_deception'])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetarRunner = (assumptions: Map<number, SystemRole>) => RetarResult

/** Returns null when the public log can't be parsed cleanly enough for skoll. */
export type SkollRunner = (assumptions: Map<number, SystemRole>) => SkollResult | null
/** Returns null when the public log can't be parsed cleanly enough for hati. */
export type HatiRunner = (assumptions: Map<number, SystemRole>) => HatiResult | null

export type DeceptionInput = {
  intent: string
  topic: string
  style_hint?: string
}
export type DeceptionRunner = (input: DeceptionInput) => Promise<string>

export type RunTurnInput = {
  system: string
  user: string
  tools: ToolDef[]
  toolChoice?: 'any' | { type: 'tool'; name: string }
}

export type RunTurnOptions = {
  model?: string
  maxTokens?: number
  /** Backwards-compatible alias for the auxiliary tool-loop bound. */
  maxRetarIterations?: number
  maxAuxIterations?: number
  retarRunner: RetarRunner
  skollRunner: SkollRunner
  hatiRunner: HatiRunner
  /** Required when craft_deception is in the exposed tool set. */
  craftDeceptionRunner?: DeceptionRunner
  onMessage?: (msg: { role: 'user' | 'assistant'; content: unknown }) => void
}

export type RunIteration = {
  /** Free-text reasoning the LLM produced in this iteration (may be empty). */
  thinking: string
  /** Names of tools the LLM invoked in this iteration (in order). */
  toolNames: string[]
}

export type RunTurnResult = {
  toolCalls: ToolCall[]
  thinking: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
  /** Number of auxiliary tool invocations during the loop (split per name). */
  auxiliaryCalls: {
    retar: number
    skoll: number
    hati: number
    craft_deception: number
  }
  /** Per-iteration trace: each LLM response in the auxiliary loop including the terminal one. */
  iterations: RunIteration[]
}

// ---------------------------------------------------------------------------
// Deception system prompt (loaded once, cached)
// ---------------------------------------------------------------------------

let cachedDeceptionPrompt: string | null = null
function loadDeceptionPrompt(): string {
  if (cachedDeceptionPrompt !== null) return cachedDeceptionPrompt
  const dir = dirname(fileURLToPath(import.meta.url))
  cachedDeceptionPrompt = readFileSync(join(dir, 'prompts', 'deception.md'), 'utf8')
  return cachedDeceptionPrompt
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AnthropicClient {
  private readonly sdk: Anthropic
  private readonly defaultModel: string

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error('Anthropic API key not provided. Set ANTHROPIC_API_KEY env var or pass apiKey option.')
    }
    this.sdk = new Anthropic({ apiKey })
    this.defaultModel = opts.model ?? DEFAULT_MODEL
  }

  /**
   * Invoke a separate LLM call that crafts one Japanese utterance for a
   * non-village seat. Used as the local executor for the `craft_deception`
   * auxiliary tool. Returns the raw utterance text (trimmed, no quotes).
   */
  async craftDeception(input: DeceptionInput, persona: Persona): Promise<string> {
    const system = loadDeceptionPrompt()
    const userPrompt = [
      `persona:`,
      `  seat: P${persona.seat}`,
      `  name: ${persona.name}`,
      `  gender: ${persona.gender}`,
      `  occupation: ${persona.occupation}`,
      `  trait: ${persona.trait}`,
      `  voice sample: ${persona.toneSample}`,
      ``,
      `intent: ${input.intent}`,
      `topic: ${input.topic}`,
      `style_hint: ${input.style_hint ?? '(none)'}`,
      ``,
      `Output the utterance only.`,
    ].join('\n')

    const response = await retryTransient(
      () => this.sdk.messages.create({
        model: this.defaultModel,
        max_tokens: DECEPTION_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      'craftDeception API call',
    )

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('\n').trim()
    if (text.length === 0) {
      throw new Error('craft_deception sub-call returned empty text')
    }
    return text
  }

  async runTurn(input: RunTurnInput, options: RunTurnOptions): Promise<RunTurnResult> {
    const model = options.model ?? this.defaultModel
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    const maxIter = options.maxAuxIterations
      ?? options.maxRetarIterations
      ?? DEFAULT_MAX_AUX_ITERATIONS

    let toolChoice = encodeToolChoice(input.toolChoice)
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: input.user },
    ]
    options.onMessage?.({ role: 'user', content: input.user })

    const usage = { inputTokens: 0, outputTokens: 0 }
    const auxiliaryCalls = { retar: 0, skoll: 0, hati: 0, craft_deception: 0 }
    const iterations: RunIteration[] = []
    // Per-turn one-shot retry: when the LLM calls seer_co without
    // report_divination (or medium_co without report_medium AND it has at
    // least one past execution to report on), we push a corrective user
    // message and re-prompt ONCE. After that we accept whatever comes back.
    let coCompletionRetryDone = false

    for (let iter = 0; iter <= maxIter; iter++) {
      const response = await retryTransient(
        () => this.sdk.messages.create({
          model,
          max_tokens: maxTokens,
          system: input.system,
          tools: input.tools,
          tool_choice: toolChoice,
          messages,
        }),
        `runTurn iter=${iter}`,
      )
      usage.inputTokens += response.usage.input_tokens
      usage.outputTokens += response.usage.output_tokens
      options.onMessage?.({ role: 'assistant', content: response.content })

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      )
      const thinking = textBlocks.map(b => b.text).join('\n').trim()
      iterations.push({ thinking, toolNames: toolUseBlocks.map(b => b.name) })

      if (toolUseBlocks.length === 0) {
        throw new Error(
          `LLM returned no tool calls (text only). First 200 chars: ${thinking.slice(0, 200)}`,
        )
      }

      const nonAux = toolUseBlocks.filter(b => !AUXILIARY_TOOL_NAMES.has(b.name as ToolName))
      // Count auxiliary tool calls observed in THIS response (whether or not
      // we loop). When the response is terminal but contained auxiliary blocks
      // alongside an action tool, those also count.
      for (const block of toolUseBlocks) {
        if (block.name === 'retar') auxiliaryCalls.retar += 1
        else if (block.name === 'skoll') auxiliaryCalls.skoll += 1
        else if (block.name === 'hati') auxiliaryCalls.hati += 1
        else if (block.name === 'craft_deception') auxiliaryCalls.craft_deception += 1
      }
      if (nonAux.length > 0) {
        // Validate "CO + result in same turn" for seer. If the LLM emitted
        // seer_co without an accompanying report_divination, push a
        // corrective user message ONCE and re-prompt. The CRITICAL hard
        // rule in seer.md / werewolf.md / fanatic.md says this is a lose
        // move, but Sonnet 4.6 occasionally ignores it; this is the
        // technical backstop.
        const seerCoOnly = nonAux.some(b => b.name === 'seer_co')
          && !nonAux.some(b => b.name === 'report_divination')
        if (seerCoOnly && !coCompletionRetryDone) {
          coCompletionRetryDone = true
          messages.push({ role: 'assistant', content: response.content })
          const toolResults: Anthropic.ToolResultBlockParam[] = []
          for (const block of toolUseBlocks) {
            if (AUXILIARY_TOOL_NAMES.has(block.name as ToolName)) {
              const content = await executeAuxiliary(block, options)
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content })
            } else {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `REJECTED: ${block.name} は report_divination を伴わなかったため受理されませんでした。`,
                is_error: true,
              })
            }
          }
          const correction: Anthropic.TextBlockParam = {
            type: 'text',
            text: `あなたの \`seer_co\` は \`report_divination\` を伴っていなかったため拒否されました。次のレスポンスでは \`report_divination(target_seat, species, day, text)\` を呼んで結果を提示してください。占い結果は提示しないと CO は受理されません。action-decoder が report_divination を seer_co に統合するので、再度 \`seer_co\` を呼ぶ必要はありません。`,
          }
          const userContent: Anthropic.ContentBlockParam[] = [...toolResults, correction]
          messages.push({ role: 'user', content: userContent })
          options.onMessage?.({ role: 'user', content: userContent })
          // Force the next call to actually emit report_divination — soft
          // text guidance alone wasn't sufficient (Sonnet 4.6 re-emitted
          // seer_co only). action-decoder will synthesise a seer_co claim
          // from the standalone report_divination, so this single tool
          // call is enough to record the CO + result properly.
          toolChoice = { type: 'tool', name: 'report_divination' }
          continue
        }

        return {
          toolCalls: toolUseBlocks.map(b => ({
            id: b.id,
            name: b.name as ToolName,
            input: b.input as Record<string, unknown>,
          })),
          thinking,
          usage,
          auxiliaryCalls,
          iterations,
        }
      }

      // Only auxiliary calls in this response: run each locally and loop.
      messages.push({ role: 'assistant', content: response.content })
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of toolUseBlocks) {
        const content = await executeAuxiliary(block, options)
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content })
      }
      messages.push({ role: 'user', content: toolResults })
      options.onMessage?.({ role: 'user', content: toolResults })
    }

    // Safeguard: max auxiliary iterations exhausted. Force a final call with
    // ALL auxiliary tools removed so the LLM must pick an action.
    const actionTools = input.tools.filter(t => !AUXILIARY_TOOL_NAMES.has(t.name as ToolName))
    if (actionTools.length === 0) {
      throw new Error(`Tool-use loop exceeded ${maxIter} iterations and no action tools are available`)
    }

    const lastMsg = messages[messages.length - 1]
    const nudge: Anthropic.TextBlockParam = {
      type: 'text',
      text: `You have used auxiliary tools (retar / skoll / hati / craft_deception) ${maxIter} times. That is enough preparation. Pick exactly one action tool from [${actionTools.map(t => t.name).join(', ')}] and commit. Auxiliary tools are no longer available.`,
    }
    if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
      lastMsg.content = [...lastMsg.content, nudge]
    } else {
      messages.push({ role: 'user', content: [nudge] })
    }

    const forced = await retryTransient(
      () => this.sdk.messages.create({
        model, max_tokens: maxTokens,
        system: input.system,
        tools: actionTools,
        tool_choice: { type: 'any' },
        messages,
      }),
      'runTurn forced-action retry',
    )
    usage.inputTokens += forced.usage.input_tokens
    usage.outputTokens += forced.usage.output_tokens
    options.onMessage?.({ role: 'assistant', content: forced.content })

    const forcedToolUses = forced.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    const forcedText = forced.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('\n').trim()
    iterations.push({ thinking: forcedText, toolNames: forcedToolUses.map(b => b.name) })
    if (forcedToolUses.length === 0) {
      throw new Error(
        `Forced-action retry returned no tool calls. First 200 chars: ${forcedText.slice(0, 200)}`,
      )
    }
    return {
      toolCalls: forcedToolUses.map(b => ({
        id: b.id,
        name: b.name as ToolName,
        input: b.input as Record<string, unknown>,
      })),
      thinking: forcedText,
      usage,
      auxiliaryCalls,
      iterations,
    }
  }
}

// ---------------------------------------------------------------------------
// Auxiliary execution dispatch
// ---------------------------------------------------------------------------

async function executeAuxiliary(
  block: Anthropic.ToolUseBlock,
  options: RunTurnOptions,
): Promise<string> {
  if (block.name === 'retar') {
    const assumptions = decodeRetarAssumptions(block.input)
    const result = options.retarRunner(assumptions)
    return formatRetarResult(result)
  }
  if (block.name === 'skoll') {
    const assumptions = decodeRetarAssumptions(block.input)
    try {
      const result = options.skollRunner(assumptions)
      if (result === null) {
        return 'ERROR: skoll could not run (the public log is not yet parseable, or contradictory). Pick an action tool directly or call retar to inspect.'
      }
      return formatSkollResult(result)
    } catch (err) {
      return `ERROR: skoll failed: ${(err as Error).message}. Pick an action tool directly or call retar instead.`
    }
  }
  if (block.name === 'hati') {
    const assumptions = decodeRetarAssumptions(block.input)
    try {
      const result = options.hatiRunner(assumptions)
      if (result === null) {
        return 'ERROR: hati could not run (the public log is not yet parseable, or contradictory). Pick an action tool directly or call retar to inspect.'
      }
      return formatHatiResult(result)
    } catch (err) {
      return `ERROR: hati failed: ${(err as Error).message}. Pick an action tool directly or call retar instead.`
    }
  }
  if (block.name === 'craft_deception') {
    if (!options.craftDeceptionRunner) {
      return 'ERROR: craft_deception is not available for this seat (no deception runner provided). Pick an action tool directly.'
    }
    try {
      const text = await options.craftDeceptionRunner(decodeDeceptionInput(block.input))
      return text
    } catch (err) {
      return `ERROR: craft_deception failed: ${(err as Error).message}. Pick an action tool directly or call say with your own wording.`
    }
  }
  return `ERROR: unknown auxiliary tool: ${block.name}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeToolChoice(choice: RunTurnInput['toolChoice']): Anthropic.ToolChoice {
  if (!choice) return { type: 'auto' }
  if (choice === 'any') return { type: 'any' }
  return { type: 'tool', name: choice.name }
}

function decodeRetarAssumptions(input: unknown): Map<number, SystemRole> {
  const out = new Map<number, SystemRole>()
  if (typeof input !== 'object' || input === null) return out
  const raw = (input as { assumptions?: unknown }).assumptions
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const seat = (item as { seat?: unknown }).seat
    const role = (item as { role?: unknown }).role
    if (typeof seat === 'number' && typeof role === 'string') {
      out.set(seat, role as SystemRole)
    }
  }
  return out
}

function decodeDeceptionInput(input: unknown): DeceptionInput {
  const obj = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {}
  const intent = typeof obj.intent === 'string' ? obj.intent : ''
  const topic = typeof obj.topic === 'string' ? obj.topic : ''
  const style_hint = typeof obj.style_hint === 'string' ? obj.style_hint : undefined
  return { intent, topic, style_hint }
}

function formatRetarResult(result: RetarResult): string {
  const seats = [...result.possibilities.keys()].sort((a, b) => a - b)
  const lines: string[] = []
  for (const seat of seats) {
    const roles = [...result.possibilities.get(seat)!].sort()
    lines.push(`- P${seat}: ${roles.length === 0 ? '(contradiction)' : roles.join(', ')}`)
  }
  lines.push(`Max surviving non-village: ${result.maxSurvivingNV}`)
  return lines.join('\n')
}

export function formatSkollResult(result: SkollResult): string {
  const lines: string[] = []
  lines.push(`Worlds enumerated: ${result.totalWorlds}${result.truncated ? ' (truncated)' : ''}`)
  lines.push(`Overall best village win rate: ${result.overallWinRate.toFixed(3)}`)
  lines.push(`Best execution target(s) (tied within ${SKOLL_TIE_TOLERANCE}): ${result.bestSeats.map(s => `P${s}`).join(', ')}`)
  lines.push(`Per-seat village win rate if executed today (sorted, higher = better for village):`)
  const sorted = [...result.executions].sort((a, b) => b.winRate - a.winRate)
  for (const e of sorted) {
    lines.push(`  - P${e.seat}: ${e.winRate.toFixed(3)}`)
  }
  return lines.join('\n')
}

export function formatHatiResult(result: HatiResult): string {
  const lines: string[] = []
  lines.push(`Tsumi: ${result.isTsumi ? 'yes (village has a forced win)' : 'no'}`)
  const p = result.judgment.profile
  const aliveCount = countSetBits(result.judgment.alive)
  lines.push(`Alive: ${aliveCount}; ropes (int): ${p.nawaInt} (effective ${p.effectiveNawa.toFixed(1)}); max non-village threat: ${p.threat}`)
  lines.push(`Required executions: ${p.requiredExecs} (fox=${p.foxCandidates}, fox+wolf=${p.foxWolfCandidates}, wolf=${p.wolfCandidates}, wolf-confirmed=${p.wolfConfirmedCount}, white-NV=${p.whiteNVThreat})`)
  lines.push(`Surviving hamster possible: ${p.possibleSurvivingHamster}; surviving nekomata possible: ${p.possibleSurvivingNekomata}; neko parity shift: ${p.nekoParityShift}`)
  if (result.isTsumi && result.strategy) {
    const summary = summarizeStrategy(result.strategy)
    if (summary) lines.push(`Strategy: ${summary}`)
  }
  return lines.join('\n')
}

/**
 * Reduce a strategy tree to a one-line summary so the LLM does not have to
 * parse a deeply nested AND-OR record. Uses `execSetsFromEnd` when present
 * (lynch sequence forced in every branch); falls back to today's action.
 */
function summarizeStrategy(node: StrategyNode): string {
  if (node.type === 'win') return '(village already won — no executions needed)'
  const parts: string[] = []
  if (node.execSetsFromEnd && node.execSetsFromEnd.length > 0) {
    const order: string[] = []
    for (let i = node.execSetsFromEnd.length - 1; i >= 0; i--) {
      const mask = node.execSetsFromEnd[i]
      const seats = bitsToSeats(mask)
      order.push(seats.length === 1
        ? `P${seats[0]}`
        : `[${seats.map(s => `P${s}`).join('|')}]`)
    }
    parts.push(`Forced lynch order: ${order.join(' → ')}`)
  } else {
    parts.push(formatAction(node.action))
  }
  return parts.join('; ')
}

function formatAction(action: VillageAction): string {
  const out: string[] = [`Today: execute P${action.execute}`]
  if (action.bodyguardTarget !== null) out.push(`guard P${action.bodyguardTarget}`)
  if (action.seerTargets.length > 0) out.push(`divine ${action.seerTargets.map(s => `P${s}`).join(', ')}`)
  return out.join(', ')
}

function bitsToSeats(mask: number): number[] {
  const out: number[] = []
  let m = mask
  while (m !== 0) {
    const bit = m & (-m)
    out.push(31 - Math.clz32(bit))
    m ^= bit
  }
  return out
}

function countSetBits(mask: number): number {
  let count = 0
  let m = mask
  while (m !== 0) { m &= m - 1; count += 1 }
  return count
}
