/**
 * Multi-agent self-play runner。
 *
 * 6 つの slot (mason / village / wolf / fanatic / hamster / immoralist) ごとに
 * 独立した NN + buffer を持ち、1 ゲームで該当席に対応する SkollZeroRoleAgent を配置する。
 * slot が設定されていない席は SkollMasterAgent (heuristic) を使う。
 *
 * ゲーム終了時、各 buffer の pending records を各 faction 視点の z で finalize。
 *
 * Phase 1 では並列化なし、1 ゲーム 1 thread。
 */

import type { SystemRole } from '../../types/index.ts'
import type { Agent } from '../../fenrir/src/agents/agent.ts'
import type { FenrirExtEvent } from '../../fenrir/src/events.ts'
import type { GameHandlers } from '../../lupa/handlers.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from '../../fenrir/src/adapters/full-adapter.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { outcomeToValue, type Faction, type MCTSConfig } from '../mcts/ISMCTS.ts'
import type { ModuleBundle } from '../mcts/dispatch.ts'
import type { FinalOutcome } from '../network/config.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import { TrainingBuffer } from './buffer.ts'
import { MasonRoleAgent } from './mason-zero-agent.ts'
import {
  VillageRoleAgent, WolfRoleAgent, FanaticRoleAgent, HamsterRoleAgent, ImmoralistRoleAgent,
} from './role-zero-agents.ts'
import { SkollZeroRoleAgent } from './role-zero-agent.ts'

export type GameResult = 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' | null

export const DEFAULT_ROLES: Map<SystemRole, number> = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

/** 1 slot = 1 役職グループ分の NN + buffer */
export type AgentSlot = {
  nn: MasonZeroNN
  buffer: TrainingBuffer
}

/** 各役職の slot (undefined なら heuristic にフォールバック) */
export type SlotMap = {
  mason?: AgentSlot        // 1030 dims mason_collective、village faction
  village?: AgentSlot      // 1029 dims individual、village faction (villager/seer/medium/bodyguard/nekomata)
  wolf?: AgentSlot         // 1212 dims wolf_collective、wolf faction
  fanatic?: AgentSlot      // 1029 dims individual、wolf faction
  hamster?: AgentSlot      // 1029 dims individual、hamster faction
  immoralist?: AgentSlot   // 1029 dims individual、hamster faction
}

export type MultiAgentSelfPlayConfig = {
  slots: SlotMap
  roles?: Map<SystemRole, number>
  mctsConfig?: MCTSConfig
  selectionMode?: 'sample' | 'argmax'
  seed: number
}

export type SlotStats = {
  mctsCalls: number
  fallbackCalls: number
  recordsAdded: number
  z: number
}

export type MultiAgentSelfPlayResult = {
  result: GameResult
  /** slot ごとの実行統計 (未設定の slot は undefined) */
  stats: Partial<Record<keyof SlotMap, SlotStats>>
}

/** role → slot bucket mapping */
function bucketForRole(role: SystemRole): keyof SlotMap | null {
  switch (role) {
    case 'mason': return 'mason'
    case 'villager':
    case 'seer':
    case 'medium':
    case 'bodyguard':
    case 'nekomata':
      return 'village'
    case 'werewolf': return 'wolf'
    case 'fanatic': return 'fanatic'
    case 'werehamster': return 'hamster'
    case 'immoralist': return 'immoralist'
    default: return null
  }
}

/** slot → faction mapping */
function factionForSlot(slot: keyof SlotMap): Faction {
  switch (slot) {
    case 'mason':
    case 'village':
      return 'village'
    case 'wolf':
    case 'fanatic':
      return 'wolf'
    case 'hamster':
    case 'immoralist':
      return 'hamster'
  }
}

function buildAgent(
  slotKey: keyof SlotMap,
  slot: AgentSlot,
  setup: Map<SystemRole, number>,
  cfg: MultiAgentSelfPlayConfig,
): SkollZeroRoleAgent {
  const opts = {
    nn: slot.nn,
    setup,
    buffer: slot.buffer,
    mctsConfig: cfg.mctsConfig,
    selectionMode: cfg.selectionMode ?? 'sample',
  }
  switch (slotKey) {
    case 'mason': return new MasonRoleAgent(opts)
    case 'village': return new VillageRoleAgent(opts)
    case 'wolf': return new WolfRoleAgent(opts)
    case 'fanatic': return new FanaticRoleAgent(opts)
    case 'hamster': return new HamsterRoleAgent(opts)
    case 'immoralist': return new ImmoralistRoleAgent(opts)
  }
}

/**
 * lupa GameResult → hati GameOutcome (Stage 4: outcome 分布 buffer 用)。
 * Faction-independent — buffer 全 record で同じ outcome を共有する。
 */
function gameOutcomeFromResult(result: GameResult): FinalOutcome {
  switch (result) {
    case 'villager_won': return 'village_win'
    case 'werewolf_won': return 'wolf_win'
    case 'werehamster_won': return 'hamster_win'
    case 'draw': return 'draw'
    default: return 'draw'
  }
}

/**
 * Stats 用: outcome を faction 視点 scalar value に変換 (Stage 4 でも debug 表示で使う)。
 */
function factionValueFromResult(result: GameResult, faction: Faction): number {
  const outcome = gameOutcomeFromResult(result)
  return outcomeToValue(outcome, faction)
}

export async function runMultiAgentSelfPlayGame(
  cfg: MultiAgentSelfPlayConfig,
): Promise<MultiAgentSelfPlayResult> {
  const roles = cfg.roles ?? DEFAULT_ROLES

  // 各 slot につき agent を 1 個、seat 毎に同じインスタンスを共有
  const agentsBySlot = new Map<keyof SlotMap, SkollZeroRoleAgent>()
  const preSize = new Map<keyof SlotMap, number>()
  const slotKeys: (keyof SlotMap)[] = ['mason', 'village', 'wolf', 'fanatic', 'hamster', 'immoralist']
  for (const key of slotKeys) {
    const slot = cfg.slots[key]
    if (!slot) continue
    agentsBySlot.set(key, buildAgent(key, slot, roles, cfg))
    preSize.set(key, slot.buffer.size())
  }

  // cross-module dispatch 用 ModuleBundle を構築して全 Agent に注入。
  // SlotMap.village は ModuleBundle.standard に対応 (bucket 名差異)、他は同名。
  const bundle: ModuleBundle = {}
  const masonAgent = agentsBySlot.get('mason'); if (masonAgent) bundle.mason = masonAgent.getModule()
  const villageAgent = agentsBySlot.get('village'); if (villageAgent) bundle.standard = villageAgent.getModule()
  const wolfAgent = agentsBySlot.get('wolf'); if (wolfAgent) bundle.wolf = wolfAgent.getModule()
  const fanaticAgent = agentsBySlot.get('fanatic'); if (fanaticAgent) bundle.fanatic = fanaticAgent.getModule()
  const hamsterAgent = agentsBySlot.get('hamster'); if (hamsterAgent) bundle.hamster = hamsterAgent.getModule()
  const immoralistAgent = agentsBySlot.get('immoralist'); if (immoralistAgent) bundle.immoralist = immoralistAgent.getModule()
  for (const agent of agentsBySlot.values()) agent.setBundle(bundle)

  const agents = new Map<number, Agent>()
  const defaultAgent = new SkollMasterAgent()

  const handlers = fullAdapter({
    agents,
    defaultAgent,
    enableRetar: true,
    roles,
    seed: cfg.seed,
    onRolesAssigned: (seatRoles) => {
      for (const [seat, role] of seatRoles) {
        const bucket = bucketForRole(role)
        if (bucket === null) continue
        const agent = agentsBySlot.get(bucket)
        if (agent) agents.set(seat, agent)
      }
    },
  })

  const gameResult = await runGame(
    { roles, seed: cfg.seed, hasFirstGhost: true },
    handlers as unknown as GameHandlers<FenrirExtEvent>,
  )
  const result = gameResult.state.result

  // Stage 4: 各 slot の buffer は faction 非依存の outcome で finalize (one-hot 4-vec)。
  // stats の z は debug 用の faction 視点 scalar (実学習目標とは異なる)。
  const outcome = gameOutcomeFromResult(result)
  const stats: MultiAgentSelfPlayResult['stats'] = {}
  for (const key of slotKeys) {
    const slot = cfg.slots[key]
    const agent = agentsBySlot.get(key)
    if (!slot || !agent) continue
    const faction = factionForSlot(key)
    slot.buffer.finalize(outcome)
    stats[key] = {
      mctsCalls: agent.mctsCalls,
      fallbackCalls: agent.fallbackCalls,
      recordsAdded: slot.buffer.size() - (preSize.get(key) ?? 0),
      z: factionValueFromResult(result, faction),
    }
  }

  return { result, stats }
}

/** N ゲーム連続実行 (並列化なし) */
export async function runMultiAgentSelfPlayBatch(
  cfg: MultiAgentSelfPlayConfig,
  numGames: number,
  onGameComplete?: (i: number, r: MultiAgentSelfPlayResult) => void,
): Promise<MultiAgentSelfPlayResult[]> {
  const results: MultiAgentSelfPlayResult[] = []
  for (let i = 0; i < numGames; i++) {
    const r = await runMultiAgentSelfPlayGame({ ...cfg, seed: cfg.seed + i })
    results.push(r)
    onGameComplete?.(i, r)
  }
  return results
}
