/**
 * Bloodhound MVP entry point.
 *
 * Run one 14d-neko game with all 14 seats controlled by Bloodhound
 * (LLM agent). Persistent artifacts (Howl log, per-LLM-call messages,
 * cost summary) are written under `logs/bloodhound/<timestamp>/`.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npm run bloodhound:play
 *
 * Options (env vars):
 *   BLOODHOUND_MODEL        — Anthropic model (default: claude-sonnet-4-6)
 *   BLOODHOUND_SEED         — game seed (default: 1)
 *   BLOODHOUND_DISCUSSION_ROUNDS — max discussion rounds per day (default: 3)
 *   BLOODHOUND_REPLAY       — path to a previous run's messages/ directory
 *                             (deterministic replay; same seed required)
 *   BLOODHOUND_DRY_RUN      — set to "1" to print the first built prompt and
 *                             exit without making any LLM call (cost $0).
 *                             Useful for inspecting prompt content during
 *                             development.
 *   BLOODHOUND_DRY_RUN_SEAT — only used when DRY_RUN is on. Seat number to
 *                             wait for; earlier seats' prompts are skipped.
 *                             Example: "5" → exit on seat-5's first prompt.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { runGame } from '../lupa/engine.ts'
import { findScenario, scenarioToRoles } from '../lupa/scenarios.ts'
import type { GameConfig } from '../lupa/handlers.ts'
import { formatHowl } from '../lupa/format.ts'

import { AnthropicClient } from './anthropic-client.ts'
import { createBloodhoundHandlers, type ReplayRecord } from './handlers.ts'
import { BloodhoundLogger } from './logger.ts'
import { formatEventLine } from './howl-stream.ts'
import type { BloodhoundEvent, ToolCall } from './types.ts'

// Sonnet 4.6 pricing (USD per 1M tokens) — adjust if the rate changes.
const PRICE_INPUT_PER_MTOK  = 3
const PRICE_OUTPUT_PER_MTOK = 15

/**
 * Load a replay map from a previous run's messages directory.
 * Filenames have the form `seatNN-phase-XX.json`; the stem is the key.
 */
function loadReplayMap(dir: string): Map<string, ReplayRecord> {
  const replay = new Map<string, ReplayRecord>()
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  for (const file of files) {
    const stem = file.slice(0, -'.json'.length)
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      thinking?: string
      toolCalls?: ToolCall[]
    }
    if (!Array.isArray(raw.toolCalls)) continue
    replay.set(stem, { thinking: raw.thinking ?? '', toolCalls: raw.toolCalls })
  }
  return replay
}

async function main(): Promise<void> {
  const scenarioName = '14d-neko'
  const scenario = findScenario(scenarioName)
  if (!scenario) throw new Error(`Scenario not found: ${scenarioName}`)

  const seed = Number(process.env.BLOODHOUND_SEED ?? '1')
  const model = process.env.BLOODHOUND_MODEL ?? 'claude-sonnet-4-6'
  const maxRounds = Number(process.env.BLOODHOUND_DISCUSSION_ROUNDS ?? '3')
  const replayPath = process.env.BLOODHOUND_REPLAY
  const dryRun = process.env.BLOODHOUND_DRY_RUN === '1'
  const dryRunSeat = process.env.BLOODHOUND_DRY_RUN_SEAT !== undefined
    ? Number(process.env.BLOODHOUND_DRY_RUN_SEAT)
    : null

  let replayMap: Map<string, ReplayRecord> | undefined
  if (replayPath) {
    // Accept either a run dir (contains `messages/`) or the messages dir itself
    const messagesDir = (() => {
      try {
        const inner = join(replayPath, 'messages')
        if (statSync(inner).isDirectory()) return inner
      } catch { /* ignore */ }
      return replayPath
    })()
    replayMap = loadReplayMap(messagesDir)
    console.log(`[bloodhound] replay map loaded from ${messagesDir} (${replayMap.size} records)`)
  }

  const config: GameConfig = {
    roles: scenarioToRoles(scenario),
    seed,
    hasFirstGhost: scenario.hasFirstGhost ?? false,
    revoteConfig: scenario.revoteConfig,
    nameStyle: 'seat',
  }

  const logger = new BloodhoundLogger()
  console.log(`[bloodhound] starting game (scenario=${scenarioName}, seed=${seed}, model=${model})`)
  console.log(`[bloodhound] log dir: ${logger.runDir}`)

  // In dry-run mode we never hit the API; AnthropicClient still requires an
  // API key in its constructor, so stub it with a placeholder. The handler's
  // onPromptBuilt callback exits before any client method is called.
  const client = new AnthropicClient({
    model,
    apiKey: dryRun ? (process.env.ANTHROPIC_API_KEY ?? 'sk-dry-run-placeholder') : undefined,
  })
  const handlers = createBloodhoundHandlers({
    client,
    config: { roles: config.roles, seed: config.seed },
    maxDiscussionRounds: maxRounds,
    replayMap,
    dryRun,
    onPromptBuilt: dryRun ? (info) => {
      // Optional seat filter: skip until we reach the requested seat. Day-0
      // night actions don't run callLLM (handler picks random), so for any
      // seat the first hit is its Day-1 discussion round-1 prompt.
      if (dryRunSeat !== null && info.seat !== dryRunSeat) return
      const round = info.discussionRound !== undefined ? ` r${info.discussionRound}` : ''
      process.stdout.write(`\n========== seat-${info.seat} ${info.phase}${round} ==========\n\n`)
      process.stdout.write(`---------- SYSTEM ----------\n${info.system}\n\n`)
      process.stdout.write(`---------- USER ----------\n${info.user}\n\n`)
      process.stdout.write(`[bloodhound] DRY_RUN: prompt emitted, exiting.\n`)
      process.exit(0)
    } : undefined,
    onLLMExchange: (ex) => {
      logger.logLLMExchange(ex)
      const roundStr = ex.discussionRound !== undefined ? `[r${ex.discussionRound}] ` : ''
      const aux = ex.auxiliaryCalls
      const auxTotal = aux ? (aux.retar + aux.skoll + aux.hati + aux.craft_deception) : 0
      const auxStr = aux && auxTotal > 0
        ? ` retar=${aux.retar}`
          + (aux.skoll > 0 ? ` skoll=${aux.skoll}` : '')
          + (aux.hati > 0 ? ` hati=${aux.hati}` : '')
          + (aux.craft_deception > 0 ? ` deceive=${aux.craft_deception}` : '')
        : ''
      const iterStr = ex.iterations && ex.iterations.length > 1 ? ` iter=${ex.iterations.length}` : ''
      console.log(`[bloodhound] LLM call seat-${ex.seat} ${ex.phase} ${roundStr}(in=${ex.usage.inputTokens} out=${ex.usage.outputTokens}${auxStr}${iterStr})`)
    },
    onSpeechEvent: (ev) => {
      logger.logSpeech(ev)
      console.log(`seat-${ev.actor} > ${ev.text}`)
    },
    // Live Howl stream → stderr so the operator can abort if the game derails.
    onEvent: (event) => {
      const line = formatEventLine(event)
      if (line !== null) process.stderr.write(line + '\n')
    },
  })

  const result = await runGame<BloodhoundEvent>(config, handlers)

  const howl = formatHowl(result.events, result.state, { roles: config.roles, seed: config.seed })
  logger.writeGameHowl(howl)
  logger.writeCostSummary(model, PRICE_INPUT_PER_MTOK, PRICE_OUTPUT_PER_MTOK)

  console.log(`[bloodhound] game finished: ${result.state.result}`)
  console.log(`[bloodhound] artifacts written to ${logger.runDir}`)
}

main().catch(err => {
  console.error('[bloodhound] error:', err)
  process.exit(1)
})
