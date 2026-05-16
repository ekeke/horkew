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
import type { ToolCall, ToolName, Persona } from './types.ts'
import type { ToolDef } from './tools.ts'

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

const AUXILIARY_TOOL_NAMES = new Set<ToolName>(['retar', 'craft_deception'])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetarRunner = (assumptions: Map<number, SystemRole>) => RetarResult

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
  /** Required when craft_deception is in the exposed tool set. */
  craftDeceptionRunner?: DeceptionRunner
  onMessage?: (msg: { role: 'user' | 'assistant'; content: unknown }) => void
}

export type RunTurnResult = {
  toolCalls: ToolCall[]
  thinking: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
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
      `  seat: seat-${persona.seat}`,
      `  gender: ${persona.gender}`,
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

    const toolChoice = encodeToolChoice(input.toolChoice)
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: input.user },
    ]
    options.onMessage?.({ role: 'user', content: input.user })

    const usage = { inputTokens: 0, outputTokens: 0 }

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

      if (toolUseBlocks.length === 0) {
        throw new Error(
          `LLM returned no tool calls (text only). First 200 chars: ${thinking.slice(0, 200)}`,
        )
      }

      const nonAux = toolUseBlocks.filter(b => !AUXILIARY_TOOL_NAMES.has(b.name as ToolName))
      if (nonAux.length > 0) {
        return {
          toolCalls: toolUseBlocks.map(b => ({
            id: b.id,
            name: b.name as ToolName,
            input: b.input as Record<string, unknown>,
          })),
          thinking,
          usage,
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
      text: `You have used auxiliary tools (retar / craft_deception) ${maxIter} times. That is enough preparation. Pick exactly one action tool from [${actionTools.map(t => t.name).join(', ')}] and commit. Auxiliary tools are no longer available.`,
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
    lines.push(`- seat-${seat}: ${roles.length === 0 ? '(contradiction)' : roles.join(', ')}`)
  }
  lines.push(`Max surviving non-village: ${result.maxSurvivingNV}`)
  return lines.join('\n')
}
