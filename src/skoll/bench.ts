/**
 * Skoll ベンチマーク
 *
 * SkollAgent（投票のみ Skoll 解析）vs 全員ヒューリスティックの村勝率比較。
 * 使い方: node --experimental-strip-types src/skoll/bench.ts
 */

import type { SystemRole } from '../types/index.ts'
import { runGame } from '../lupa/engine.ts'
import { MasonTrainingAdapter } from '../fenrir/src/adapters/mason-training-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { SkollAgent } from './skoll-agent.ts'

type RoleMap = Map<SystemRole, number>

type BenchConfig = {
  name: string
  roles: RoleMap
  games: number
  seedStart?: number
}

type BenchResult = {
  villageWins: number
  wolfWins: number
  otherWins: number
  total: number
  villageWinRate: number
  elapsedMs: number
}

async function runBench(cfg: BenchConfig, useSkoll: boolean): Promise<BenchResult> {
  const { roles, games, seedStart = 0 } = cfg
  let villageWins = 0
  let wolfWins = 0
  let otherWins = 0
  const t0 = performance.now()

  for (let i = 0; i < games; i++) {
    const seed = seedStart + i
    const agentsMap = new Map<number, RuleBasedAgent>()

    const handlers = new MasonTrainingAdapter({
      agents: agentsMap,
      defaultAgent: useSkoll ? new SkollAgent() : new RuleBasedAgent(),
      wolfTeamAgent: new WolfTeamRuleAgent(),
      masonTeamAgent: new MasonTeamRuleAgent(),
      enableRetar: useSkoll,
      roles,
      seed,
      onRolesAssigned: useSkoll
        ? (seatRoles: Map<number, SystemRole>) => {
            const villageRoles = new Set<SystemRole>([
              'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
            ])
            for (const [seat, role] of seatRoles) {
              if (villageRoles.has(role)) {
                agentsMap.set(seat, new SkollAgent())
              }
            }
          }
        : undefined,
    })

    const gameConfig = { roles, seed }
    const { state } = await runGame(gameConfig, handlers)

    const result = state.result
    if (result === 'villager_won') villageWins++
    else if (result === 'werewolf_won') wolfWins++
    else otherWins++
  }

  const elapsedMs = performance.now() - t0
  return {
    villageWins,
    wolfWins,
    otherWins,
    total: games,
    villageWinRate: villageWins / games,
    elapsedMs,
  }
}

function printResult(label: string, r: BenchResult) {
  const rate = (r.villageWinRate * 100).toFixed(1)
  const ms = r.elapsedMs.toFixed(0)
  console.log(`${label}: 村勝率 ${rate}% (${r.villageWins}/${r.total}) 狼勝 ${r.wolfWins} その他 ${r.otherWins} [${ms}ms]`)
}

const configs: BenchConfig[] = [
  {
    name: '5人村 (w1/v3/占1)',
    roles: new Map<SystemRole, number>([['werewolf', 1], ['villager', 3], ['seer', 1]]),
    games: 200,
  },
  {
    name: '8人村 (w2/v4/占1/霊1)',
    roles: new Map<SystemRole, number>([['werewolf', 2], ['villager', 4], ['seer', 1], ['medium', 1]]),
    games: 200,
  },
  {
    name: '10人村 (w2/v5/占1/霊1/狩1)',
    roles: new Map<SystemRole, number>([
      ['werewolf', 2], ['villager', 5], ['seer', 1], ['medium', 1], ['bodyguard', 1],
    ]),
    games: 200,
  },
]

console.log('=== Skoll vs Heuristic ベンチマーク ===\n')

for (const cfg of configs) {
  console.log(`--- ${cfg.name} (${cfg.games}ゲーム) ---`)
  const heuristicResult = await runBench(cfg, false)
  printResult('Heuristic', heuristicResult)
  const skollResult = await runBench(cfg, true)
  printResult('Skoll    ', skollResult)
  const diff = (skollResult.villageWinRate - heuristicResult.villageWinRate) * 100
  console.log(`差分: ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp\n`)
}
