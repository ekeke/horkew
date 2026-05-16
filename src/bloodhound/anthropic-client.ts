/**
 * Anthropic SDK wrapper for one Bloodhound turn.
 *
 * Drives the tool-use loop:
 *   1. Send system + user prompts with the legal tool set.
 *   2. If the LLM returns retar tool_use blocks, run them locally and feed
 *      the results back as tool_result blocks; repeat.
 *   3. As soon as the LLM emits at least one action tool (non-retar), we
 *      treat that response as terminal and return all tool calls verbatim
 *      to the caller.
 *
 * The loop is bounded by `maxRetarIterations`.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { RetarResult } from '../fenrir/src/retar-bridge.ts'
import type { SystemRole } from '../types/index.ts'
import type { ToolCall, ToolName } from './types.ts'
import type { ToolDef } from './tools.ts'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_MAX_RETAR_ITERATIONS = 10

export type RetarRunner = (assumptions: Map<number, SystemRole>) => RetarResult

export type RunTurnInput = {
  system: string
  user: string
  tools: ToolDef[]
  toolChoice?: 'any' | { type: 'tool'; name: string }
}

export type RunTurnOptions = {
  model?: string
  maxTokens?: number
  maxRetarIterations?: number
  retarRunner: RetarRunner
  /** Optional observer for every message exchanged with the API (for logging). */
  onMessage?: (msg: { role: 'user' | 'assistant'; content: unknown }) => void
}

export type RunTurnResult = {
  toolCalls: ToolCall[]
  thinking: string         // concatenation of all text blocks in the final response
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

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

  async runTurn(input: RunTurnInput, options: RunTurnOptions): Promise<RunTurnResult> {
    const model = options.model ?? this.defaultModel
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    const maxIter = options.maxRetarIterations ?? DEFAULT_MAX_RETAR_ITERATIONS

    const toolChoice = encodeToolChoice(input.toolChoice)
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: input.user },
    ]
    options.onMessage?.({ role: 'user', content: input.user })

    const usage = { inputTokens: 0, outputTokens: 0 }

    for (let iter = 0; iter <= maxIter; iter++) {
      const response = await this.sdk.messages.create({
        model,
        max_tokens: maxTokens,
        system: input.system,
        tools: input.tools,
        tool_choice: toolChoice,
        messages,
      })
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

      const nonRetar = toolUseBlocks.filter(b => b.name !== 'retar')
      if (nonRetar.length > 0) {
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

      // Only retar calls in this response: run them, append, loop.
      messages.push({ role: 'assistant', content: response.content })
      const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map(block => {
        const assumptions = decodeRetarAssumptions(block.input)
        const result = options.retarRunner(assumptions)
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: formatRetarResult(result),
        }
      })
      messages.push({ role: 'user', content: toolResults })
      options.onMessage?.({ role: 'user', content: toolResults })
    }

    // Safeguard: max retar iterations exhausted. Force a final call with retar
    // removed from the tool set so the LLM has no choice but to pick an action.
    const actionTools = input.tools.filter(t => t.name !== 'retar')
    if (actionTools.length === 0) {
      throw new Error(`Tool-use loop exceeded ${maxIter} iterations and no non-retar tools are available`)
    }

    const lastMsg = messages[messages.length - 1]
    const nudge: Anthropic.TextBlockParam = {
      type: 'text',
      text: `You have queried retar ${maxIter} times. That is enough analysis. Pick exactly one action tool from [${actionTools.map(t => t.name).join(', ')}] and commit. The retar tool is no longer available.`,
    }
    if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
      lastMsg.content = [...lastMsg.content, nudge]
    } else {
      messages.push({ role: 'user', content: [nudge] })
    }

    const forced = await this.sdk.messages.create({
      model, max_tokens: maxTokens,
      system: input.system,
      tools: actionTools,
      tool_choice: { type: 'any' },
      messages,
    })
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
