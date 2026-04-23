import type { SystemRole } from '../../types/index.ts'

/** lupa GameState.result の型（GameResult は undefined を含むが GameState は null） */
export type GameResult = 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' | null
import type { GameHandlers } from '../../lupa/handlers.ts'
import type { Agent } from '../../fenrir/src/agents/agent.ts'
import type { FenrirExtEvent } from '../../fenrir/src/events.ts'
import { runGame } from '../../lupa/engine.ts'
import { fullAdapter } from '../../fenrir/src/adapters/full-adapter.ts'
import { SkollMasterAgent } from '../../skoll/skoll-master-agent.ts'
import { TrainingBuffer } from './buffer.ts'
import { MasonRoleAgent } from './mason-zero-agent.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import type { MCTSConfig } from '../mcts/ismcts.ts'
import { outcomeToMasonValue } from '../mcts/ismcts.ts'
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'

/** Phase 1 デフォルト配役 (bb-eval.ts と同じ 14 席構成) */
export const DEFAULT_ROLES: Map<SystemRole, number> = new Map<SystemRole, number>([
  ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1], ['bodyguard', 1],
  ['mason', 2], ['nekomata', 1], ['fanatic', 1], ['werehamster', 1], ['immoralist', 1],
])

export type SelfPlayConfig = {
  nn: MasonZeroNN
  buffer: TrainingBuffer
  /** 配役 */
  roles?: Map<SystemRole, number>
  /** MCTS hyperparams（省略時 DEFAULT_MCTS_CONFIG） */
  mctsConfig?: MCTSConfig
  /** 行動選択モード: 'sample' (training) or 'argmax' (eval) */
  selectionMode?: 'sample' | 'argmax'
  /** game seed */
  seed: number
  /**
   * Phase 2 pretrained head を mason seat に注入する場合のマップ。
   * key: `${role}-${method}` (例 'mason-claim', 'mason-comm')。
   * 注入すると decideDayClaim / decideProposal 等で NN の argmax が発火し、
   * selectionMode='sample' 時は outcome-SL record が buffer に蓄積される。
   */
  phase2Nets?: Map<string, TransformerNetwork>
}

export type SelfPlayResult = {
  result: GameResult
  /** mason 視点 z 値 (記録した records 全てに同値) */
  z: number
  /** 何個 (obs, π) を新規記録したか */
  recordsAdded: number
  /** デバッグ: MCTS 呼び出し回数 / fallback 回数 */
  mctsCalls: number
  fallbackCalls: number
}

/**
 * 1 ゲームの self-play 実行。
 *
 * - mason 席（2 席）: MasonRoleAgent (MCTS + buffer 蓄積)
 * - その他 12 席: SkollMasterAgent (heuristic)
 * - ゲーム終了後、buffer を z (mason 視点 outcome value) で finalize
 */
export async function runSelfPlayGame(config: SelfPlayConfig): Promise<SelfPlayResult> {
  const roles = config.roles ?? DEFAULT_ROLES
  const buffer = config.buffer
  const initialSize = buffer.size()

  const agents = new Map<number, Agent>()
  const masonAgent = new MasonRoleAgent({
    nn: config.nn,
    setup: roles,
    buffer,
    mctsConfig: config.mctsConfig,
    selectionMode: config.selectionMode ?? 'sample',
    phase2Nets: config.phase2Nets,
  })

  const defaultAgent = new SkollMasterAgent()

  const handlers = fullAdapter({
    agents,
    defaultAgent,
    enableRetar: true,
    roles,
    seed: config.seed,
    onRolesAssigned: (seatRoles) => {
      for (const [seat, role] of seatRoles) {
        if (role === 'mason') {
          agents.set(seat, masonAgent)
        }
      }
    },
  })

  const gameResult = await runGame(
    { roles, seed: config.seed, hasFirstGhost: true },
    handlers as unknown as GameHandlers<FenrirExtEvent>,
  )

  const result = gameResult.state.result
  const z = outcomeFromResult(result)
  buffer.finalize(z)

  return {
    result,
    z,
    recordsAdded: buffer.size() - initialSize,
    mctsCalls: masonAgent.mctsCalls,
    fallbackCalls: masonAgent.fallbackCalls,
  }
}

/**
 * GameResult を mason 視点 value に変換。
 * lupa の `villager_won` / `werewolf_won` / `werehamster_won` / `draw` を
 * skoll-zero の outcomeToMasonValue 範囲にマップ。
 */
function outcomeFromResult(result: GameResult): number {
  switch (result) {
    case 'villager_won': return outcomeToMasonValue('village_win')
    case 'werewolf_won': return outcomeToMasonValue('wolf_win')
    case 'werehamster_won': return outcomeToMasonValue('hamster_win')
    case 'draw': return -0.5  // reward.ts と整合
    default: return 0
  }
}

/**
 * N ゲームの self-play batch を順次実行。
 *
 * Phase 1 では並列化なし（M5 で workers 化を検討）。
 */
export async function runSelfPlayBatch(
  config: SelfPlayConfig,
  numGames: number,
  onGameComplete?: (i: number, r: SelfPlayResult) => void,
): Promise<SelfPlayResult[]> {
  const results: SelfPlayResult[] = []
  for (let i = 0; i < numGames; i++) {
    const r = await runSelfPlayGame({ ...config, seed: config.seed + i })
    results.push(r)
    onGameComplete?.(i, r)
  }
  return results
}
