/**
 * Bloodhound MVP entry point.
 *
 * Run one 14d-neko game with all 14 seats controlled by Bloodhound
 * (LLM agent). Persistent artifacts (Howl log, per-LLM-call messages,
 * cost summary) are written under `logs/bloodhound/<timestamp>/`.
 *
 * Usage (git-bash / sh):
 *   ANTHROPIC_API_KEY=sk-... npm run bloodhound:play -- --seed 42
 *   ANTHROPIC_API_KEY=sk-... npm run bloodhound:play -- --seed 7 --dry-run
 *
 *   The `--` after the script name lets npm hand the remaining flags to
 *   play.ts unchanged.
 *
 * Options:
 *   --seed N             game seed (default: 1)
 *   --model NAME         Anthropic model (default: claude-sonnet-4-6)
 *   --rounds N           max discussion rounds per day (default: 3)
 *   --replay PATH        path to a previous run's dir or messages/ subdir
 *                        (deterministic replay; same seed required)
 *   --dry-run            print the first built prompt and exit without
 *                        making any LLM call (cost $0). For prompt debug.
 *   --dry-run-seat N     with --dry-run, skip until reaching this seat
 *   -h, --help           show this message
 *
 * ANTHROPIC_API_KEY is read from the environment (it's a secret, not a
 * flag). When --dry-run is set the key is optional.
 *
 * NOTE (PowerShell users only): `npm run … -- --foo` strips the `--foo`
 * flag on Windows PowerShell. Use `npm --% run bloodhound:play -- --seed 42`
 * (stop-parsing token) or invoke `node` directly. git-bash works as-is.
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

type CliOptions = {
  seed: number
  model: string
  rounds: number
  replay: string | null
  dryRun: boolean
  dryRunSeat: number | null
}

const USAGE = `Usage: npm run bloodhound:play -- [options]   (git-bash / sh)

Options:
  --seed N             game seed (default: 1)
  --model NAME         Anthropic model (default: claude-sonnet-4-6)
  --rounds N           max discussion rounds per day (default: 3)
  --replay PATH        replay from a previous run's dir or messages/ subdir
  --dry-run            print first built prompt and exit (cost $0)
  --dry-run-seat N     with --dry-run, skip until reaching this seat
  -h, --help           show this message

PowerShell note: npm strips --flags. Use \`npm --% run bloodhound:play -- ...\`
or invoke \`node --experimental-strip-types src/bloodhound/play.ts ...\` directly.
`

function parseCli(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    seed: 1,
    model: 'claude-sonnet-4-6',
    rounds: 3,
    replay: null,
    dryRun: false,
    dryRunSeat: null,
  }
  const takeValue = (flag: string, i: number): string => {
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('-')) {
      throw new Error(`Option ${flag} requires a value`)
    }
    return next
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE)
        process.exit(0)
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--seed':
        opts.seed = Number(takeValue(arg, i)); i++; break
      case '--model':
        opts.model = takeValue(arg, i); i++; break
      case '--rounds':
        opts.rounds = Number(takeValue(arg, i)); i++; break
      case '--replay':
        opts.replay = takeValue(arg, i); i++; break
      case '--dry-run-seat':
        opts.dryRunSeat = Number(takeValue(arg, i)); i++; break
      default:
        throw new Error(`Unknown option: ${arg}\n${USAGE}`)
    }
  }
  return opts
}

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
  const cli = parseCli(process.argv.slice(2))

  const scenarioName = '14d-neko'
  const scenario = findScenario(scenarioName)
  if (!scenario) throw new Error(`Scenario not found: ${scenarioName}`)

  let replayMap: Map<string, ReplayRecord> | undefined
  if (cli.replay) {
    // Accept either a run dir (contains `messages/`) or the messages dir itself
    const messagesDir = (() => {
      try {
        const inner = join(cli.replay, 'messages')
        if (statSync(inner).isDirectory()) return inner
      } catch { /* ignore */ }
      return cli.replay
    })()
    replayMap = loadReplayMap(messagesDir)
    console.log(`[bloodhound] replay map loaded from ${messagesDir} (${replayMap.size} records)`)
  }

  const config: GameConfig = {
    roles: scenarioToRoles(scenario),
    seed: cli.seed,
    hasFirstGhost: scenario.hasFirstGhost ?? false,
    revoteConfig: scenario.revoteConfig,
    nameStyle: 'seat',
  }

  const logger = new BloodhoundLogger()
  console.log(`[bloodhound] starting game (scenario=${scenarioName}, seed=${cli.seed}, model=${cli.model})`)
  console.log(`[bloodhound] log dir: ${logger.runDir}`)

  // In dry-run mode we never hit the API; AnthropicClient still requires an
  // API key in its constructor, so stub it with a placeholder. The handler's
  // onPromptBuilt callback exits before any client method is called.
  const client = new AnthropicClient({
    model: cli.model,
    apiKey: cli.dryRun ? (process.env.ANTHROPIC_API_KEY ?? 'sk-dry-run-placeholder') : undefined,
  })
  const handlers = createBloodhoundHandlers({
    client,
    config: { roles: config.roles, seed: config.seed },
    maxDiscussionRounds: cli.rounds,
    replayMap,
    dryRun: cli.dryRun,
    onPromptBuilt: cli.dryRun ? (info) => {
      // Optional seat filter: skip until we reach the requested seat. Day-0
      // night actions don't run callLLM (handler picks random), so for any
      // seat the first hit is its Day-1 discussion round-1 prompt.
      if (cli.dryRunSeat !== null && info.seat !== cli.dryRunSeat) return
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
  logger.writeCostSummary(cli.model, PRICE_INPUT_PER_MTOK, PRICE_OUTPUT_PER_MTOK)

  console.log(`[bloodhound] game finished: ${result.state.result}`)
  console.log(`[bloodhound] artifacts written to ${logger.runDir}`)
}

main().catch(err => {
  console.error('[bloodhound] error:', err)
  process.exit(1)
})
