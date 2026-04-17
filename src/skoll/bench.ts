/**
 * Skoll ベンチマーク
 *
 * SkollMasonTeamAgent が collectProposals 経由で execute_order を発行し、
 * 村全員がそれに従う構成。vs 全員ヒューリスティックの村勝率比較。
 * 使い方: node --experimental-strip-types src/skoll/bench.ts
 */

import type { SystemRole } from '../types/index.ts'
import type { VoteContext } from '../lupa/handlers.ts'
import type { FenrirExt } from '../fenrir/src/ext.ts'
import type { FenrirExtEvent } from '../fenrir/src/events.ts'
import type { Proposal } from '../fenrir/src/leadership.ts'
import type { VillageStatus } from '../types/index.ts'
import { runGame } from '../lupa/engine.ts'
import { StrategyBaseAdapter } from '../fenrir/src/adapters/strategy-base-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { buildPlayerView } from '../lupa/player-view.ts'
import { alivePlayers } from '../lupa/roles.ts'
import { Possibilities, possibilityFromRoles, RoleBitIndex } from '../retar/possibilities.ts'
import { analyzeExecutionsByWorld } from './world-analysis.ts'
import { SkollMasonTeamAgent } from './skoll-mason-agent.ts'

type RoleMap = Map<SystemRole, number>

type BenchConfig = {
  name: string
  roles: RoleMap
  games: number
  seedStart?: number
  hasFirstGhost?: boolean
}

type BenchResult = {
  villageWins: number
  wolfWins: number
  otherWins: number
  total: number
  villageWinRate: number
  elapsedMs: number
}

/**
 * Skoll ベンチ用 adapter。
 * collectProposals で SkollMasonTeamAgent に execute_order を生成させ、
 * 全村プレイヤーの ctx.proposals に伝播する。
 */
class SkollBenchAdapter extends StrategyBaseAdapter {
  protected override collectProposals(
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
  ): Proposal[] {
    // 再投票時はプランを再発行しない
    if (vctx.revoteRound != null && vctx.revoteRound > 0) return []

    const state = vctx.state
    const aliveMasonPlayers = alivePlayers(state).filter(p => p.role === 'mason')
    if (aliveMasonPlayers.length === 0) return []

    const mason = aliveMasonPlayers[0]
    const view = buildPlayerView(state, mason.seat)
    const ctx = this.buildCtx(
      vctx as any,
      mason,
      view,
      ext,
      { proposals: [] },
    )
    const teamCtx = this.buildTeamCtx(ctx, state, 'mason', mason.seat)
    const proposal = this.config.masonTeamAgent?.decideProposal(teamCtx)
    return proposal ? [proposal] : []
  }
}

function buildSkollPossibilities(
  globalPoss: Map<number, Set<SystemRole>>,
  setup: Map<string, number>,
): Possibilities {
  let maxSeat = 0
  for (const seat of globalPoss.keys()) if (seat > maxSeat) maxSeat = seat
  const possibilities = new Possibilities(maxSeat)
  for (const [role, count] of setup as Map<string, number>) {
    const idx = RoleBitIndex[role as keyof typeof RoleBitIndex]
    if (idx !== undefined) possibilities.setup[idx] = count
  }
  possibilities.setupOriginal = new Uint8Array(possibilities.setup)
  for (const [seat, roles] of globalPoss) {
    possibilities.possibilities[seat] = possibilityFromRoles(roles as any)
  }
  return possibilities
}

async function runBench(cfg: BenchConfig, useSkoll: boolean): Promise<BenchResult> {
  const { roles, games, seedStart = 0, hasFirstGhost } = cfg
  let villageWins = 0
  let wolfWins = 0
  let otherWins = 0
  const t0 = performance.now()

  for (let i = 0; i < games; i++) {
    const seed = seedStart + i

    const handlers = useSkoll
      ? new SkollBenchAdapter({
          agents: new Map(),
          defaultAgent: new RuleBasedAgent(),
          wolfTeamAgent: new WolfTeamRuleAgent(),
          masonTeamAgent: new SkollMasonTeamAgent(),
          enableRetar: true,
          roles,
          seed,
        })
      : new StrategyBaseAdapter({
          agents: new Map(),
          defaultAgent: new RuleBasedAgent(),
          wolfTeamAgent: new WolfTeamRuleAgent(),
          masonTeamAgent: new MasonTeamRuleAgent(),
          enableRetar: true,
          roles,
          seed,
        })

    const { state } = await runGame({ roles, seed, hasFirstGhost }, handlers)

    const result = state.result
    if (result === 'villager_won') villageWins++
    else if (result === 'werewolf_won') wolfWins++
    else otherWins++
  }

  const elapsedMs = performance.now() - t0
  return { villageWins, wolfWins, otherWins, total: games, villageWinRate: villageWins / games, elapsedMs }
}

function printResult(label: string, r: BenchResult) {
  const rate = (r.villageWinRate * 100).toFixed(1)
  const ms = r.elapsedMs.toFixed(0)
  console.log(`${label}: 村勝率 ${rate}% (${r.villageWins}/${r.total}) 狼勝 ${r.wolfWins} その他 ${r.otherWins} [${ms}ms]`)
}

const configs: BenchConfig[] = [
  {
    name: '14人村 猫又入り (w3/v2/占1/霊1/狩1/共2/猫1/狂1/狐1/背1)',
    roles: new Map<SystemRole, number>([
      ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
      ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
    ]),
    games: 200,
    hasFirstGhost: true,
  },
]

console.log('=== Skoll (共有提案) vs Heuristic ベンチマーク ===\n')

for (const cfg of configs) {
  console.log(`--- ${cfg.name} (${cfg.games}ゲーム) ---`)
  const heuristicResult = await runBench(cfg, false)
  printResult('Heuristic', heuristicResult)
  const skollResult = await runBench(cfg, true)
  printResult('Skoll    ', skollResult)
  const diff = (skollResult.villageWinRate - heuristicResult.villageWinRate) * 100
  console.log(`差分: ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp\n`)
}
