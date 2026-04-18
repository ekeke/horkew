/**
 * Skoll ベンチ構成で単一ゲームを走らせ、イベント列を Howl 形式で書き出す。
 *
 * 使い方:
 *   node --experimental-strip-types src/skoll/record-game.ts [--seed=N] [--mode=heuristic|skoll_village|skoll_wolf|skoll_both] [--out=path.howl]
 *
 * mode デフォルト: skoll_both
 * seed デフォルト: 0
 * out  デフォルト: tmp/skoll-game-<mode>-<seed>.howl
 *
 * Howl 変換本体は `src/lupa/to-howl.ts` の `gameToHowl()` に任せる。
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SystemRole } from '../types/index.ts'
import { runGame } from '../lupa/engine.ts'
import { gameToHowl } from '../lupa/to-howl.ts'
import { StrategyBaseAdapter } from '../fenrir/src/adapters/strategy-base-adapter.ts'
import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../fenrir/src/agents/rule-based-agent.ts'
import { buildPlayerView } from '../lupa/player-view.ts'
import { alivePlayers } from '../lupa/roles.ts'
import { SkollMasonTeamAgent } from './skoll-mason-agent.ts'
import { SkollWolfTeamAgent } from './skoll-wolf-agent.ts'
import type { VoteContext } from '../lupa/handlers.ts'
import type { FenrirExt } from '../fenrir/src/ext.ts'
import type { FenrirExtEvent } from '../fenrir/src/events.ts'
import type { Proposal } from '../fenrir/src/leadership.ts'

type BenchMode = 'heuristic' | 'skoll_village' | 'skoll_wolf' | 'skoll_both'

class SkollBenchAdapter extends StrategyBaseAdapter {
  protected override collectProposals(
    vctx: VoteContext<FenrirExtEvent, FenrirExt>,
    ext: FenrirExt,
  ): Proposal[] {
    if (vctx.revoteRound != null && vctx.revoteRound > 0) return []
    const state = vctx.state
    const aliveMasonPlayers = alivePlayers(state).filter(p => p.role === 'mason')
    if (aliveMasonPlayers.length === 0) return []
    const mason = aliveMasonPlayers[0]
    const view = buildPlayerView(state, mason.seat)
    const ctx = this.buildCtx(vctx as any, mason, view, ext, { proposals: [] })
    const teamCtx = this.buildTeamCtx(ctx, state, 'mason', mason.seat)
    const proposal = this.config.masonTeamAgent?.decideProposal(teamCtx)
    return proposal ? [proposal] : []
  }
}

class HeuristicBenchAdapter extends StrategyBaseAdapter {}

// ---- CLI 引数 ----
function parseArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : null
}

const seed = parseInt(parseArg('seed') ?? '0', 10)
const mode = (parseArg('mode') ?? 'skoll_both') as BenchMode
const outPath = parseArg('out') ?? `tmp/skoll-game-${mode}-${seed}.howl`

// ---- 役職設定（bench.ts と同じ 14人村 猫又入り） ----
const roles = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])
const hasFirstGhost = true

// ---- エージェント構成 ----
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

// ---- ゲーム実行 + Howl 書き出し ----
const result = await runGame({ roles, seed, hasFirstGhost }, handlers)

const howl = gameToHowl(result, {
  title: `Skoll bench game (mode=${mode}, seed=${seed})`,
  frontmatter: { mode, seed },
})

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, howl)

console.log(`書き出し完了: ${outPath}`)
console.log(`  mode=${mode} seed=${seed} result=${result.state.result} events=${result.events.length}`)
