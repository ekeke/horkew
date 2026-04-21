/**
 * Phase 2 SL pretrain data collection runner.
 *
 * heuristic vs heuristic を N ゲーム実行、各 decide* の (obs, action) を
 * role/method 別に JSONL で {outputDir}/{role}/{method}.jsonl に保存。
 *
 * 用例:
 *   node --experimental-strip-types src/skoll/phase2/runner.ts \
 *     --games 1000 \
 *     --seed 8000 \
 *     --output tmp/phase2-data
 */
import type { Agent } from '../../fenrir/src/agents/agent.ts'
import type { SystemRole } from '../../types/index.ts'
import type { LupaConfig } from '../../lupa/types.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from '../../fenrir/src/adapters/full-adapter.ts'
import { resolveRules } from '../../howl/ruleset.ts'
import { SampleCollector } from './sample-collector.ts'
import {
  CapturingRuleBasedAgent,
  CapturingWolfTeamAgent,
  CapturingMasonTeamAgent,
} from './capturing-agents.ts'

const DEFAULT_ROLES: Record<string, number> = {
  werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
  mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
}
const DEFAULT_REVOTE = { maxRevotes: 2, style: 'full_revote' as const, tiebreaker: 'draw' as const }

export type Phase2CollectorOptions = {
  numGames: number
  baseSeed: number
  outputDir: string
  progressInterval: number
}

export const DEFAULT_OPTIONS: Phase2CollectorOptions = {
  numGames: 100,
  baseSeed: 8000,
  outputDir: 'tmp/phase2-data',
  progressInterval: 10,
}

export async function runCollection(opts: Partial<Phase2CollectorOptions> = {}): Promise<SampleCollector> {
  const options = { ...DEFAULT_OPTIONS, ...opts }
  const collector = new SampleCollector()
  const roles = new Map(Object.entries(DEFAULT_ROLES) as [SystemRole, number][])
  const rules = resolveRules()
  void ({} as LupaConfig)  // for types symmetry

  for (let g = 0; g < options.numGames; g++) {
    const cc = { collector, gameId: g }

    const handlers = fullAdapter({
      agents: new Map<number, Agent>(),
      defaultAgent: new CapturingRuleBasedAgent(cc),
      wolfTeamAgent: new CapturingWolfTeamAgent(cc),
      masonTeamAgent: new CapturingMasonTeamAgent(cc),
      onRolesAssigned: () => {},
      seed: options.baseSeed + g,
      enableRetar: true,
      roles,
      rules,
    })

    await runGame(
      {
        roles,
        seed: options.baseSeed + g,
        hasFirstGhost: true,
        revoteConfig: DEFAULT_REVOTE,
      },
      handlers,
    )

    if ((g + 1) % options.progressInterval === 0) {
      process.stderr.write(`[phase2-collect] ${g + 1}/${options.numGames} games, total samples=${collector.totalSize()}\n`)
    }
  }

  process.stderr.write(`[phase2-collect] writing JSONL to ${options.outputDir}\n`)
  collector.writeJsonl(options.outputDir)

  const counts = collector.counts()
  process.stderr.write(`[phase2-collect] per (role/method) counts:\n`)
  const sortedKeys = Object.keys(counts).sort()
  for (const k of sortedKeys) {
    process.stderr.write(`  ${k.padEnd(30)} ${counts[k]}\n`)
  }

  return collector
}

function parseArgs(): Partial<Phase2CollectorOptions> {
  const opts: Partial<Phase2CollectorOptions> = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--games': opts.numGames = parseInt(args[++i], 10); break
      case '--seed': opts.baseSeed = parseInt(args[++i], 10); break
      case '--output': opts.outputDir = args[++i]; break
    }
  }
  return opts
}

if (process.argv[1]?.endsWith('runner.ts') && process.argv[1].includes('phase2')) {
  runCollection(parseArgs()).catch(err => {
    console.error(err)
    process.exit(1)
  })
}
