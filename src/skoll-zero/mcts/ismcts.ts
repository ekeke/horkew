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
 * rootDirichlet* は M5 で追加。root prior に `(1-ε)*prior + ε*Dir(α)` を適用して
 * exploration を促す。eval では ε=0 (noise 無効) 推奨。
 */
export type MCTSConfig = {
  cPuct: number
  nRollouts: number
  rng: () => number
  /** root Dirichlet α (省略 or 0 で noise 無効) */
  rootDirichletAlpha?: number
  /** root Dirichlet ε (省略 or 0 で noise 無効) */
  rootDirichletEps?: number
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
  // root を先に NN 展開して Dirichlet noise を注入（rollout 中は descent のみ）。
  // 未展開だと noise を prior に効かせられず exploration が鈍る。
  // alive / masonSeat は determinization で不変なので、サンプル world は mask 専用。
  const firstWorld = determinizer.sample(config.rng)
  if (!firstWorld) {
    return { root, visits: new Map(), abortReason: 'no_consistent_world' }
  }
  const rootState = createSimState(firstWorld, infoState.alive, infoState.day, infoState.phase as 'day' | 'night')
  if (rootState.phase !== 'terminal' && isMasonAlive(rootState, masonSeat)) {
    expandWithNN(root, rootState, masonSeat, nn, rootObs)
    applyRootDirichletNoise(root, config)
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
 * root prior に Dirichlet noise を混合: P ← (1-ε)P + ε·Dir(α)。
 * α / ε のいずれかが未設定 or 0 なら no-op。
 */
function applyRootDirichletNoise(root: TreeNode, config: MCTSConfig): void {
  const alpha = config.rootDirichletAlpha ?? 0
  const eps = config.rootDirichletEps ?? 0
  if (alpha <= 0 || eps <= 0 || root.edges.size === 0) return
  const actions = Array.from(root.edges.keys())
  const noise = sampleDirichlet(actions.length, alpha, config.rng)
  for (let i = 0; i < actions.length; i++) {
    const edge = root.edges.get(actions[i])!
    edge.prior = (1 - eps) * edge.prior + eps * noise[i]
  }
}

/**
 * Dirichlet(α) sample (K 次元、合計 1)。α<1 は boost 法で処理:
 *   g_i ~ Gamma(α+1, 1)、u_i ~ U(0,1)、x_i = g_i · u_i^(1/α)
 * 次に x を合計で正規化。
 */
function sampleDirichlet(k: number, alpha: number, rng: () => number): Float32Array {
  const out = new Float32Array(k)
  let sum = 0
  const useBoost = alpha < 1
  for (let i = 0; i < k; i++) {
    const g = sampleGamma(useBoost ? alpha + 1 : alpha, rng)
    const x = useBoost ? g * Math.pow(Math.max(rng(), 1e-12), 1 / alpha) : g
    out[i] = x
    sum += x
  }
  if (sum <= 0) {
    const u = 1 / k
    for (let i = 0; i < k; i++) out[i] = u
    return out
  }
  for (let i = 0; i < k; i++) out[i] /= sum
  return out
}

/**
 * Marsaglia-Tsang 法で Gamma(α, 1) sampling (α ≥ 1 向け)。
 * 本実装は applyRootDirichletNoise 内で常に α ≥ 1 (boost 適用後) で呼ばれる。
 */
function sampleGamma(alpha: number, rng: () => number): number {
  const d = alpha - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (let iter = 0; iter < 1000; iter++) {
    const x = sampleNormal(rng)
    const v1 = 1 + c * x
    if (v1 <= 0) continue
    const v = v1 * v1 * v1
    const u = Math.max(rng(), 1e-12)
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) {
      return d * v
    }
  }
  // 極端な numerical 状況での fallback
  return d
}

/** Box-Muller で standard normal sampling */
function sampleNormal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
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
