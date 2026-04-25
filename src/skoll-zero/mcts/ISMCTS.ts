import type { GameOutcome } from '../../hati/simulate.ts'
import { cloneSimState, createSimState } from '../simulator/world-state.ts'
import type { SimState, Phase } from '../simulator/world-state.ts'
import { stepPhase, advancePhase } from '../simulator/rollout-sim.ts'
import type { PhaseAction } from '../simulator/rollout-sim.ts'
import { createTreeNode, totalChildVisits } from './node.ts'
import type { TreeNode } from './node.ts'
import type { Determinizer } from './determinize.ts'
import type { HeadName, MasonZeroNN, RootObservation } from './nn.ts'
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
 * MCTS の root action 種別。Stage 1 で 15 phase 化された後も、root の意思決定は
 * 4 種のうちのどれか (day=execute / night の 3 種) に対応する。
 *
 * - 'execute': day フェーズで処刑先 seat を選ぶ
 * - 'attack' : night_attack フェーズで噛み先 seat を選ぶ (wolf 用)
 * - 'divine' : night_divine フェーズで占い先 seat を選ぶ (seer 用)
 * - 'guard'  : night_guard  フェーズで護衛先 seat を選ぶ (bodyguard 用)
 *
 * Stage 2-3 で claim_* / morning も意思決定対象に加わる予定だが、Stage 1 では
 * これら phase は default action で通過させて expand しない。
 */
export type RootActionMode = 'execute' | 'attack' | 'divine' | 'guard'

/** action mode → MCTS root を置く initial phase */
function phaseFromActionMode(mode: RootActionMode): Phase {
  switch (mode) {
    case 'execute': return 'day'
    case 'attack': return 'night_attack'
    case 'divine': return 'night_divine'
    case 'guard': return 'night_guard'
  }
}

/** phase → NN forward で使う head 名。expand 対象 phase のみ意味を持つ */
function headNameForPhase(phase: Phase): HeadName {
  switch (phase) {
    case 'day': return 'execute'
    case 'night_attack': return 'attack'
    case 'night_divine': return 'divine'
    case 'night_guard': return 'guard'
    // Stage 1 では claim/morning は expand されないため、ここに来ない想定。
    // 安全のため execute に fallback。
    default: return 'execute'
  }
}

/**
 * Stage 1 の暫定挙動: claim_* / morning phase は default action で通過させる
 * (expand しない)。Stage 2-3 で Module dispatch を入れた時に有効化する。
 */
function isAutoSkipPhase(phase: Phase): boolean {
  return phase === 'morning'
    || phase === 'claim_seer_true'
    || phase === 'claim_medium_true'
    || phase === 'claim_bg_true'
    || phase === 'claim_nekomata_true'
    || phase === 'claim_mason'
    || phase === 'claim_seer_fake'
    || phase === 'claim_medium_fake'
    || phase === 'claim_bg_fake'
    || phase === 'claim_nekomata_fake'
}

/**
 * 現 phase に応じた default PhaseAction を組み立てる。expand 対象 phase では
 * UCB で選んだ action seat を target に、Stage 1 暫定 phase では「何もしない」
 * default action を返す。
 */
function buildPhaseAction(phase: Phase, action: number): PhaseAction {
  switch (phase) {
    case 'day': return { type: 'execute', target: action }
    case 'night_attack': return { type: 'attack', target: action }
    case 'night_divine': return { type: 'divine', target: action }
    case 'night_guard': return { type: 'guard', target: action }
    case 'morning': return { type: 'morning', reports: [] }
    case 'claim_seer_true':
    case 'claim_medium_true':
    case 'claim_bg_true':
    case 'claim_nekomata_true':
    case 'claim_mason':
      return { type: 'claim_true', willClaim: false }
    case 'claim_seer_fake':
    case 'claim_medium_fake':
    case 'claim_bg_fake':
    case 'claim_nekomata_fake':
      return { type: 'claim_fake', willClaim: false }
    case 'terminal':
      throw new Error('buildPhaseAction: phase is terminal')
  }
}

/**
 * 1 rollout の root state を構築。actionMode に対応する初期 phase に置き、
 * skip 条件を満たす auto-skip phase は advancePhase で前進させる。
 */
function makeRolloutState(
  world: import('../../hati/types.ts').World,
  alive: number,
  day: number,
  actionMode: RootActionMode,
): SimState {
  const state = createSimState(world, alive, day, phaseFromActionMode(actionMode))
  // 開始 phase が skip 条件を満たすケース (例: night_divine で真 seer 全員死亡) は前進
  advancePhase(state)
  return state
}

/**
 * mason の 1 vote 決定点で MCTS を実行し、root の visit 分布を返す。
 *
 * @param rootObs MCTS 開始時にキャプチャした生観測（rollout 中固定）
 * @param infoState 決定者の情報集合 state（world は仮置き、rollout ごとに上書き）
 * @param decisionSeat 決定する席
 * @param determinizer determinized world サンプラ
 * @param nn policy + value 評価器
 * @param config MCTS hyperparams
 * @param faction value 評価視点 (default: village)
 * @param opts root action 種別 + NN policy から除外する席 bitmask
 */
export function runMCTS(
  rootObs: RootObservation,
  infoState: SimState,
  decisionSeat: number,
  determinizer: Determinizer,
  nn: MasonZeroNN,
  config: MCTSConfig = DEFAULT_MCTS_CONFIG,
  faction: Faction = 'village',
  opts: { actionMode?: RootActionMode, excludedMask?: number } = {},
): MCTSResult {
  const actionMode = opts.actionMode ?? 'execute'
  const excludedMask = opts.excludedMask ?? 0
  const root = createTreeNode()
  if (determinizer.isOverflow()) {
    return { root, visits: new Map(), abortReason: 'determinizer_overflow' }
  }
  if (determinizer.size() === 0) {
    return { root, visits: new Map(), abortReason: 'no_consistent_world' }
  }
  // root を先に NN 展開して Dirichlet noise を注入（rollout 中は descent のみ）。
  // 未展開だと noise を prior に効かせられず exploration が鈍る。
  // alive / decisionSeat は determinization で不変なので、サンプル world は mask 専用。
  const firstWorld = determinizer.sample(config.rng)
  if (!firstWorld) {
    return { root, visits: new Map(), abortReason: 'no_consistent_world' }
  }
  const rootState = makeRolloutState(firstWorld, infoState.alive, infoState.day, actionMode)
  if (rootState.phase !== 'terminal' && isMasonAlive(rootState, decisionSeat)) {
    expandWithNN(root, rootState, decisionSeat, nn, rootObs, excludedMask, headNameForPhase(rootState.phase))
    applyRootDirichletNoise(root, config)
  }
  for (let i = 0; i < config.nRollouts; i++) {
    const world = determinizer.sample(config.rng)
    if (!world) break
    const rolloutState = makeRolloutState(world, infoState.alive, infoState.day, actionMode)
    runOneRollout(root, rolloutState, decisionSeat, nn, rootObs, config, faction, excludedMask)
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
 * Stage 1 の暫定挙動:
 * - 実 expand 対象 phase: day / night_attack / night_divine / night_guard
 * - claim_* / morning は default action で stepPhase 直呼び (木に edge は登らない)
 * - terminal なら outcome → faction value で backup
 * - 決定者死亡 leaf なら NN value で leaf 評価
 * - 未展開 leaf なら NN 評価 → backup
 * - 展開済 node なら UCB で action 選択 → stepPhase → 子 node に descent
 */
function runOneRollout(
  root: TreeNode,
  initialState: SimState,
  decisionSeat: number,
  nn: MasonZeroNN,
  rootObs: RootObservation,
  config: MCTSConfig,
  faction: Faction,
  excludedMask: number,
): void {
  const path: { node: TreeNode, action: number }[] = []
  let node = root
  let state = initialState
  let isRoot = true

  while (true) {
    if (state.phase === 'terminal') {
      backup(path, outcomeToValue(state.outcome, faction))
      return
    }
    if (!isMasonAlive(state, decisionSeat)) {
      // 決定者死亡: NN value で leaf 評価
      const { value } = nn.forward(rootObs, state, decisionSeat, headNameForPhase(state.phase))
      backup(path, value)
      return
    }
    // Stage 1: claim_* / morning は default action で通過 (expand しない)
    if (isAutoSkipPhase(state.phase)) {
      stepPhase(state, buildPhaseAction(state.phase, -1))
      continue
    }
    if (!node.expanded) {
      // root のみ excludedMask を適用、descent では自席除外のみ
      const value = expandWithNN(
        node, state, decisionSeat, nn, rootObs,
        isRoot ? excludedMask : 0,
        headNameForPhase(state.phase),
      )
      backup(path, value)
      return
    }
    const action = selectActionUCB(node, config.cPuct)
    if (action < 0) {
      backup(path, 0)
      return
    }
    const nextState = cloneSimState(state)
    stepPhase(nextState, buildPhaseAction(nextState.phase, action))
    isRoot = false
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

/**
 * node に対し NN forward → edge を初期化、value を返す。
 * excludedMask で指定された seat (wolf 仲間等) は policy から除外し、残りを renormalize する。
 * headName で policy を読み出す head を切り替える。
 */
function expandWithNN(
  node: TreeNode,
  state: SimState,
  masonSeat: number,
  nn: MasonZeroNN,
  rootObs: RootObservation,
  excludedMask: number,
  headName: HeadName,
): number {
  const { policy, value } = nn.forward(rootObs, state, masonSeat, headName)
  // excludedMask の seat を除外 + renormalize
  let sum = 0
  const filtered: Array<[number, number]> = []
  for (const [action, prior] of policy) {
    if ((excludedMask >>> action) & 1) continue
    filtered.push([action, prior])
    sum += prior
  }
  if (filtered.length === 0) {
    // fallback: excludedMask が policy を全除外してしまった場合は元の policy を使う
    for (const [action, prior] of policy) {
      if (!node.edges.has(action)) {
        node.edges.set(action, { visits: 0, totalValue: 0, prior })
      }
    }
  } else {
    const norm = sum > 0 ? 1 / sum : 1 / filtered.length
    for (const [action, prior] of filtered) {
      if (!node.edges.has(action)) {
        node.edges.set(action, { visits: 0, totalValue: 0, prior: sum > 0 ? prior * norm : norm })
      }
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

/** path 全体の edge stats を value で更新（決定者視点で同符号） */
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
 * どの陣営の視点で value を評価するか。
 * 陣営別に 3 陣営の勝利を +1 / -1 / -1.3 (敵陣営の最悪勝利) にマップ。
 */
export type Faction = 'village' | 'wolf' | 'hamster'

/**
 * GameOutcome → 指定 faction 視点の value [-1.3, +1]。
 *
 * 各陣営の視点で「自陣営勝ち = +1」「他 2 陣営のうち最悪 = -1.3」。
 * reward.ts と整合 (village 視点で hamster_win が最悪という慣例)。
 *
 * - village faction: village_win +1 / wolf_win -1 / hamster_win -1.3
 * - wolf faction:    wolf_win +1 / village_win -1 / hamster_win -1.3
 * - hamster faction: hamster_win +1 / village_win -1 / wolf_win -1.3
 */
export function outcomeToValue(outcome: GameOutcome | null, faction: Faction): number {
  if (outcome == null) return 0
  switch (faction) {
    case 'village':
      return outcome === 'village_win' ? 1.0 : outcome === 'wolf_win' ? -1.0 : outcome === 'hamster_win' ? -1.3 : 0
    case 'wolf':
      return outcome === 'wolf_win' ? 1.0 : outcome === 'village_win' ? -1.0 : outcome === 'hamster_win' ? -1.3 : 0
    case 'hamster':
      return outcome === 'hamster_win' ? 1.0 : outcome === 'village_win' ? -1.0 : outcome === 'wolf_win' ? -1.3 : 0
  }
}

/** 互換: mason は village faction */
export function outcomeToMasonValue(outcome: GameOutcome | null): number {
  return outcomeToValue(outcome, 'village')
}
