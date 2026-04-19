import type { GameOutcome } from '../../hati/simulate.ts'
import { cloneSimState, createSimState } from '../simulator/world-state.ts'
import type { SimState } from '../simulator/world-state.ts'
import { runRollout, stepDayNightCycle } from '../simulator/rollout-sim.ts'
import { createTreeNode, totalChildVisits } from './node.ts'
import type { TreeNode } from './node.ts'
import type { Determinizer } from './determinize.ts'
import type { MasonZeroNN, RootObservation } from './nn.ts'
import { isMasonAlive } from './nn.ts'

/**
 * MCTS の hyperparams。c_puct は AlphaZero default 中央値 1.5。
 *
 * Phase 1 では Dirichlet noise 未導入（M5 で root prior に注入予定）。
 */
export type MCTSConfig = {
  cPuct: number
  nRollouts: number
  rng: () => number
}

export const DEFAULT_MCTS_CONFIG: MCTSConfig = {
  cPuct: 1.5,
  nRollouts: 400,
  rng: Math.random,
}

/** MCTS 結果: action → 訪問回数。π（policy target）の元データ */
export type MCTSResult = {
  root: TreeNode
  visits: Map<number, number>
  /** 中断理由（rollout が予算より少なく終了した場合のみ） */
  abortReason: string | null
}

/**
 * mason の 1 vote 決定点で MCTS を実行し、root の visit 分布を返す。
 *
 * @param rootObs MCTS 開始時にキャプチャした生観測（rollout 中固定）
 * @param infoState mason の情報集合 state（world は仮置き、rollout ごとに上書き）
 * @param masonSeat decide する mason 席
 * @param determinizer determinized world サンプラ
 * @param nn policy + value 評価器
 * @param config MCTS hyperparams
 */
export function runMCTS(
  rootObs: RootObservation,
  infoState: SimState,
  masonSeat: number,
  determinizer: Determinizer,
  nn: MasonZeroNN,
  config: MCTSConfig = DEFAULT_MCTS_CONFIG,
): MCTSResult {
  const root = createTreeNode()
  if (determinizer.isOverflow()) {
    return { root, visits: new Map(), abortReason: 'determinizer_overflow' }
  }
  if (determinizer.size() === 0) {
    return { root, visits: new Map(), abortReason: 'no_consistent_world' }
  }
  for (let i = 0; i < config.nRollouts; i++) {
    const world = determinizer.sample(config.rng)
    if (!world) break
    const rolloutState = createSimState(world, infoState.alive, infoState.day, infoState.phase as 'day' | 'night')
    runOneRollout(root, rolloutState, masonSeat, nn, rootObs, config)
  }
  return { root, visits: collectRootVisits(root), abortReason: null }
}

/**
 * 1 rollout: tree descent → expand → evaluate → backup。
 *
 * - terminal なら outcome → mason value で backup
 * - mason 死亡 leaf なら heuristic rollout で終端到達 → outcome → backup
 * - 未展開 leaf なら NN 評価 → backup
 * - 展開済 node なら UCB で action 選択 → step → 子 node に descent
 */
function runOneRollout(
  root: TreeNode,
  initialState: SimState,
  masonSeat: number,
  nn: MasonZeroNN,
  rootObs: RootObservation,
  config: MCTSConfig,
): void {
  const path: { node: TreeNode, action: number }[] = []
  let node = root
  let state = initialState

  while (true) {
    if (state.phase === 'terminal') {
      backup(path, outcomeToMasonValue(state.outcome))
      return
    }
    if (!isMasonAlive(state, masonSeat)) {
      // mason 死亡: tree はこれ以上分岐しない、heuristic rollout で終端まで
      const finalOutcome = runRollout(cloneSimState(state))
      backup(path, outcomeToMasonValue(finalOutcome))
      return
    }
    if (!node.expanded) {
      const value = expandWithNN(node, state, masonSeat, nn, rootObs)
      backup(path, value)
      return
    }
    const action = selectActionUCB(node, config.cPuct)
    if (action < 0) {
      // 合法 action がない（理論上 mason 生存時は必ずあるはず）
      backup(path, 0)
      return
    }
    // step: mason vote = action、他席は heuristic
    const nextState = cloneSimState(state)
    const override = new Map<number, number>([[masonSeat, action]])
    stepDayNightCycle(nextState, override)
    let child = node.children.get(action)
    if (!child) {
      child = createTreeNode()
      node.children.set(action, child)
    }
    path.push({ node, action })
    node = child
    state = nextState
  }
}

/** node に対し NN forward → edge を初期化、value を返す */
function expandWithNN(
  node: TreeNode,
  state: SimState,
  masonSeat: number,
  nn: MasonZeroNN,
  rootObs: RootObservation,
): number {
  const { policy, value } = nn.forward(rootObs, state, masonSeat)
  for (const [action, prior] of policy) {
    if (!node.edges.has(action)) {
      node.edges.set(action, { visits: 0, totalValue: 0, prior })
    }
  }
  node.expanded = true
  return value
}

/**
 * UCB（PUCT 変種、AlphaZero 流）で action 選択。
 * score(a) = Q(a) + c_puct * P(a) * sqrt(N_total) / (1 + N(a))
 */
function selectActionUCB(node: TreeNode, cPuct: number): number {
  const totalVisits = totalChildVisits(node)
  // sqrt 引数が 0 にならないよう +1（AlphaZero common）
  const sqrtTotal = Math.sqrt(totalVisits + 1)
  let bestAction = -1
  let bestScore = -Infinity
  for (const [action, edge] of node.edges) {
    const Q = edge.visits > 0 ? edge.totalValue / edge.visits : 0
    const U = cPuct * edge.prior * sqrtTotal / (1 + edge.visits)
    const score = Q + U
    if (score > bestScore) {
      bestScore = score
      bestAction = action
    }
  }
  return bestAction
}

/** path 全体の edge stats を value で更新（mason 視点で同符号） */
function backup(path: { node: TreeNode, action: number }[], value: number): void {
  for (const { node, action } of path) {
    const edge = node.edges.get(action)
    if (edge) {
      edge.visits += 1
      edge.totalValue += value
    }
  }
}

/** root の child edges から visit 分布を抽出 */
function collectRootVisits(root: TreeNode): Map<number, number> {
  const result = new Map<number, number>()
  for (const [action, edge] of root.edges) {
    result.set(action, edge.visits)
  }
  return result
}

/**
 * GameOutcome → mason 視点の value [-1.3, +1]。
 *
 * - village_win: +1.0
 * - wolf_win: -1.0
 * - hamster_win: -1.3 (狐勝ちは「3陣営で最悪」、reward.ts と一致)
 * - ongoing: 0（ここに来るのは異常系のみ）
 */
export function outcomeToMasonValue(outcome: GameOutcome | null): number {
  switch (outcome) {
    case 'village_win': return 1.0
    case 'wolf_win': return -1.0
    case 'hamster_win': return -1.3
    default: return 0
  }
}
