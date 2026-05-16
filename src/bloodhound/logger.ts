/**
 * Bloodhound run logger.
 *
 * Writes one timestamped directory per game under `logs/bloodhound/`:
 *   game.howl                  — final Howl render
 *   messages/<seat>-<phase>-<turn>.json — every LLM request/response
 *   speech.jsonl               — every speech event in order
 *   cost.json                  — token usage summary
 *
 * Directory creation is lazy on first write so callers don't need to
 * pre-create anything.
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SpeechEvent } from './types.ts'
import type { LLMExchange } from './handlers.ts'

export type LoggerOptions = {
  /** Root directory; default 'logs/bloodhound'. */
  rootDir?: string
  /** Override timestamp (UTC ISO) for testing. */
  timestamp?: string
}

export class BloodhoundLogger {
  readonly runDir: string
  private readonly messagesDir: string
  private readonly seatPhaseCounters = new Map<string, number>()
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private llmCallCount = 0
  private initialized = false

  constructor(opts: LoggerOptions = {}) {
    const root = opts.rootDir ?? join('logs', 'bloodhound')
    const ts = (opts.timestamp ?? new Date().toISOString()).replace(/[:.]/g, '-')
    this.runDir = join(root, ts)
    this.messagesDir = join(this.runDir, 'messages')
  }

  private ensureDirs(): void {
    if (this.initialized) return
    mkdirSync(this.messagesDir, { recursive: true })
    this.initialized = true
  }

  logLLMExchange(ex: LLMExchange): void {
    this.ensureDirs()
    this.llmCallCount += 1
    this.totalInputTokens += ex.usage.inputTokens
    this.totalOutputTokens += ex.usage.outputTokens
    const key = `${ex.seat}-${ex.phase}`
    const turn = (this.seatPhaseCounters.get(key) ?? 0) + 1
    this.seatPhaseCounters.set(key, turn)
    const filename = `seat${String(ex.seat).padStart(2, '0')}-${ex.phase}-${String(turn).padStart(2, '0')}.json`
    writeFileSync(
      join(this.messagesDir, filename),
      JSON.stringify({
        seat: ex.seat,
        phase: ex.phase,
        usage: ex.usage,
        thinking: ex.thinking,
        toolCalls: ex.toolCalls,
        system: ex.system,
        user: ex.user,
      }, null, 2),
      'utf8',
    )
  }

  logSpeech(event: SpeechEvent): void {
    this.ensureDirs()
    appendFileSync(
      join(this.runDir, 'speech.jsonl'),
      JSON.stringify(event) + '\n',
      'utf8',
    )
  }

  writeGameHowl(howl: string): void {
    this.ensureDirs()
    writeFileSync(join(this.runDir, 'game.howl'), howl, 'utf8')
  }

  writeCostSummary(modelName: string, pricePerMTokInput?: number, pricePerMTokOutput?: number): void {
    this.ensureDirs()
    const inputUSD = pricePerMTokInput !== undefined
      ? (this.totalInputTokens / 1_000_000) * pricePerMTokInput : null
    const outputUSD = pricePerMTokOutput !== undefined
      ? (this.totalOutputTokens / 1_000_000) * pricePerMTokOutput : null
    const totalUSD = inputUSD !== null && outputUSD !== null ? inputUSD + outputUSD : null
    writeFileSync(
      join(this.runDir, 'cost.json'),
      JSON.stringify({
        model: modelName,
        llmCallCount: this.llmCallCount,
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        pricePerMTokInput: pricePerMTokInput ?? null,
        pricePerMTokOutput: pricePerMTokOutput ?? null,
        estimatedCostUSD: totalUSD,
      }, null, 2),
      'utf8',
    )
  }
}
