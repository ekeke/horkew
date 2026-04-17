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
import { runGame } from '../lupa/engine.ts'
import { StrategyBaseAdapter } from '../fenrir/src/adapters/strategy-base-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { buildPlayerView } from '../lupa/player-view.ts'
import { alivePlayers } from '../lupa/roles.ts'
import { SkollMasonTeamAgent } from './skoll-mason-agent.ts'
import { SkollWolfTeamAgent } from './skoll-wolf-agent.ts'

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
  // 狼生存数の分布: wolfWinDist[n] = 狼n体生存で狼勝したゲーム数
  wolfWinDist: number[]
  // 狐勝時の狼生存数分布: foxWinDist[n] = 狼n体生存で狐勝したゲーム数
  foxWinDist: number[]
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

/** StrategyBaseAdapter の具体化（collectProposals なし = proposals 空） */
class HeuristicBenchAdapter extends StrategyBaseAdapter {}

type BenchMode = 'heuristic' | 'skoll_village' | 'skoll_wolf' | 'skoll_both'

async function runBench(cfg: BenchConfig, mode: BenchMode): Promise<BenchResult> {
  const { roles, games, seedStart = 0, hasFirstGhost } = cfg
  let villageWins = 0
  let wolfWins = 0
  let otherWins = 0
  const wolfWinDist: number[] = []
  const foxWinDist: number[] = []
  const t0 = performance.now()

  for (let i = 0; i < games; i++) {
    const seed = seedStart + i

    const wolfAgent = (mode === 'skoll_wolf' || mode === 'skoll_both')
      ? new SkollWolfTeamAgent()
      : new WolfTeamRuleAgent()
    const masonAgent = (mode === 'skoll_village' || mode === 'skoll_both')
      ? new SkollMasonTeamAgent()
      : new MasonTeamRuleAgent()

    const adapterCfg = {
      agents: new Map(),
      defaultAgent: new RuleBasedAgent(),
      wolfTeamAgent: wolfAgent,
      masonTeamAgent: masonAgent,
      enableRetar: true,
      roles,
      seed,
    }
    const handlers = (mode === 'skoll_village' || mode === 'skoll_both')
      ? new SkollBenchAdapter(adapterCfg)
      : new HeuristicBenchAdapter(adapterCfg)

    const { state } = await runGame({ roles, seed, hasFirstGhost }, handlers)

    const result = state.result
    const survivingWolves = state.players.filter(p => p.role === 'werewolf' && p.alive).length

    if (result === 'villager_won') {
      villageWins++
    } else if (result === 'werewolf_won') {
      wolfWins++
      wolfWinDist[survivingWolves] = (wolfWinDist[survivingWolves] ?? 0) + 1
    } else {
      otherWins++
      foxWinDist[survivingWolves] = (foxWinDist[survivingWolves] ?? 0) + 1
    }
  }

  const elapsedMs = performance.now() - t0
  return { villageWins, wolfWins, otherWins, total: games, villageWinRate: villageWins / games, elapsedMs, wolfWinDist, foxWinDist }
}

function formatDist(dist: number[]): string {
  const entries = dist.map((count, wolves) => `狼${wolves}:${count ?? 0}`).filter((_, i) => dist[i] != null)
  return entries.length > 0 ? entries.join(' ') : '-'
}

function printResult(label: string, r: BenchResult) {
  const rate = (r.villageWinRate * 100).toFixed(1)
  const ms = r.elapsedMs.toFixed(0)
  console.log(`${label}: 村勝率 ${rate}% (${r.villageWins}/${r.total}) 狼勝 ${r.wolfWins} その他 ${r.otherWins} [${ms}ms]`)
  if (r.wolfWins > 0) console.log(`  狼勝分布(狼生存数): ${formatDist(r.wolfWinDist)}`)
  if (r.otherWins > 0) console.log(`  狐勝分布(狼生存数): ${formatDist(r.foxWinDist)}`)
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

const foxWinPenalty = process.env['FOX_WIN_PENALTY'] ?? '-0.5'
console.log(`=== Skoll ベンチマーク [FOX_WIN_PENALTY=${foxWinPenalty}] ===\n`)

for (const cfg of configs) {
  console.log(`--- ${cfg.name} (${cfg.games}ゲーム) ---`)
  const heuristicResult = await runBench(cfg, 'heuristic')
  printResult('Heuristic       ', heuristicResult)
  const skollVillageResult = await runBench(cfg, 'skoll_village')
  printResult('Skoll(村+)      ', skollVillageResult)
  const skollWolfResult = await runBench(cfg, 'skoll_wolf')
  printResult('Skoll(狼+)      ', skollWolfResult)
  const skollBothResult = await runBench(cfg, 'skoll_both')
  printResult('Skoll(村+狼+)   ', skollBothResult)

  const diffVillage = (skollVillageResult.villageWinRate - heuristicResult.villageWinRate) * 100
  const diffWolf = (skollWolfResult.villageWinRate - heuristicResult.villageWinRate) * 100
  const diffBoth = (skollBothResult.villageWinRate - heuristicResult.villageWinRate) * 100
  console.log(`差分 Skoll(村+): ${diffVillage >= 0 ? '+' : ''}${diffVillage.toFixed(1)}pp`)
  console.log(`差分 Skoll(狼+): ${diffWolf >= 0 ? '+' : ''}${diffWolf.toFixed(1)}pp`)
  console.log(`差分 Skoll(両+): ${diffBoth >= 0 ? '+' : ''}${diffBoth.toFixed(1)}pp\n`)
}
