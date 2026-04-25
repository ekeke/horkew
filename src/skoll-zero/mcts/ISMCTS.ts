import type { GameOutcome } from '../../hati/simulate.ts'
import { hasSeat } from '../../hati/types.ts'
import { cloneSimState } from '../simulator/world-state.ts'
import type { SimState, Phase } from '../simulator/world-state.ts'
import { stepPhase, advancePhase } from '../simulator/rollout-sim.ts'
import type { PhaseAction } from '../simulator/rollout-sim.ts'
import { createTreeNode, totalChildVisits } from './node.ts'
import type { TreeNode } from './node.ts'
import type { Determinizer } from './determinize.ts'
import type { World } from '../../hati/types.ts'
import {
  dispatchForPhase, convertValueAcrossFaction,
  type ModuleBundle,
} from './dispatch.ts'
import type { RolloutInvariants } from '../observation/from-sim-state.ts'

/**
 * MCTS の hyperparams。c_puct は AlphaZero default 中央値 1.5。
 *
 * rootDirichlet* は root prior に `(1-ε)*prior + ε*Dir(α)` を適用して
 * exploration を促す。eval では ε=0 (noise 無効) 推奨。
 */
export type MCTSConfig = {
  cPuct: number
  nRollouts: number
  rng: () => number
  rootDirichletAlpha?: number
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
  abortReason: string | null
}

/**
 * MCTS root の意思決定種別。Stage 1 と同じ 4 種を維持。Stage 2 で
 * dispatch ベースの descent を導入したので、これは「root を置く初期 phase」を
 * 決めるためだけに使う。
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

/**
 * 役職 Module 集合を使った MCTS。phase ごとに dispatch して対応 Module の
 * forward を呼ぶ。観測は各 Module が SimState から動的に encode する。
 *
 * @param rootSimState root の SimState (ctx + determinized 済 world から構築)
 * @param decisionSeat 決定者 (root の意思決定 seat)
 * @param determinizer determinized world サンプラ
 * @param bundle 役職 Module 集合
 * @param invariants rollout 不変情報 (signal counts / retar / tsumi 等)
 * @param config MCTS hyperparams
 * @param opts root action 種別 + NN policy から除外する席 bitmask
 */
export function runMCTS(
  rootSimState: SimState,
  decisionSeat: number,
  determinizer: Determinizer,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  config: MCTSConfig = DEFAULT_MCTS_CONFIG,
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
  const firstWorld = determinizer.sample(config.rng)
  if (!firstWorld) {
    return { root, visits: new Map(), abortReason: 'no_consistent_world' }
  }

  // decision faction を root world から決定 (Stage 2 では root world で固定)
  const decisionRole = firstWorld.roles[decisionSeat]
  const decisionFaction = factionForRole(decisionRole)
  if (!decisionFaction) {
    return { root, visits: new Map(), abortReason: 'unknown_decision_role' }
  }

  // root state: rootSimState の clone + world 差替
  const rootState = makeRolloutState(rootSimState, firstWorld, actionMode)
  if (rootState.phase !== 'terminal' && hasSeat(rootState.alive, decisionSeat)) {
    const value = expandWithDispatch(root, rootState, decisionSeat, bundle, invariants, excludedMask, /*isRoot*/ true, decisionFaction)
    if (value !== null) {
      applyRootDirichletNoise(root, config)
    }
  }
  for (let i = 0; i < config.nRollouts; i++) {
    const world = determinizer.sample(config.rng)
    if (!world) break
    const rolloutState = makeRolloutState(rootSimState, world, actionMode)
    runOneRollout(root, rolloutState, decisionSeat, bundle, invariants, config, decisionFaction, excludedMask)
  }
  return { root, visits: collectRootVisits(root), abortReason: null }
}

/**
 * rootSimState (ctx 由来の base) を clone して world を差替、actionMode に応じた phase で開始。
 */
function makeRolloutState(
  rootSimState: SimState,
  world: World,
  actionMode: RootActionMode,
): SimState {
  const state = cloneSimState(rootSimState)
  state.world = world
  state.phase = phaseFromActionMode(actionMode)
  // rootSimState 由来の pending* / outcome はリセット (新規 rollout)
  state.pendingAttack = null
  state.pendingGuard = null
  state.pendingDivineTargets = []
  state.outcome = null
  // skip 条件を満たす phase は前進
  advancePhase(state)
  return state
}

/**
 * SystemRole → Faction (decision faction の判定用)
 */
function factionForRole(role: import('../../types/index.ts').SystemRole): Faction | null {
  switch (role) {
    case 'mason':
    case 'villager':
    case 'seer':
    case 'medium':
    case 'bodyguard':
    case 'nekomata':
      return 'village'
    case 'werewolf':
    case 'fanatic':
      return 'wolf'
    case 'werehamster':
    case 'immoralist':
      return 'hamster'
    default:
      return null
  }
}

/**
 * root prior に Dirichlet noise を混合。
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
  return d
}

function sampleNormal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * 1 rollout: tree descent → expand → evaluate → backup。
 *
 * Stage 2 改: phase ごとに dispatchForPhase で Module/actor を切替、
 * Module の動的 obs encoder + forward を呼ぶ。claim_* と morning は
 * dispatch=null なので advancePhase で skip 通過する (Stage 1 暫定の維持)。
 */
function runOneRollout(
  root: TreeNode,
  initialState: SimState,
  decisionSeat: number,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  config: MCTSConfig,
  decisionFaction: Faction,
  excludedMask: number,
): void {
  const path: { node: TreeNode, action: number }[] = []
  let node = root
  let state = initialState
  let isRoot = true

  while (true) {
    if (state.phase === 'terminal') {
      backup(path, outcomeToValue(state.outcome, decisionFaction))
      return
    }
    if (!hasSeat(state.alive, decisionSeat)) {
      // 決定者死亡: dispatch で leaf 評価 (Module で value を取る)
      const dispatch = dispatchForPhase(state, decisionSeat, bundle)
      if (!dispatch) {
        // skip 連鎖で進められない (claim/morning が default skip だが、この phase で
        // dispatch=null は本来発生しない)。安全側で 0 backup。
        backup(path, 0)
        return
      }
      const out = dispatch.module.forwardAt(state, dispatch.actorSeat, dispatch.actorRole, dispatch.headName, invariants)
      const v = convertValueAcrossFaction(out.value, dispatch.module.faction(), decisionFaction)
      backup(path, v)
      return
    }
    // dispatch で Module を選んで expand or descent
    const dispatch = dispatchForPhase(state, decisionSeat, bundle)
    if (!dispatch) {
      // claim/morning phase が default skip で advancePhase 後にも引き続き dispatch=null は
      // 本来発生しない (advancePhase で全 skip 候補を進めるため)。緊急回避: stepPhase で default
      // action を入れて 1 phase 進める。Stage 3 で実 dispatch に置換される。
      stepPhase(state, defaultActionForPhase(state.phase))
      continue
    }

    if (!node.expanded) {
      const value = expandWithDispatch(node, state, decisionSeat, bundle, invariants, isRoot ? excludedMask : 0, isRoot, decisionFaction)
      backup(path, value ?? 0)
      return
    }
    const action = selectActionUCB(node, config.cPuct)
    if (action < 0) {
      backup(path, 0)
      return
    }
    const nextState = cloneSimState(state)
    stepPhase(nextState, buildPhaseActionFor(state.phase, action))
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
 * 現 phase に応じた default action (claim/morning の skip 通過用)。
 */
function defaultActionForPhase(phase: Phase): PhaseAction {
  switch (phase) {
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
    case 'day': return { type: 'execute', target: -1 }
    case 'night_attack': return { type: 'attack', target: -1 }
    case 'night_divine': return { type: 'divine', target: -1 }
    case 'night_guard': return { type: 'guard', target: -1 }
    case 'terminal':
      throw new Error('defaultActionForPhase: phase is terminal')
  }
}

/**
 * dispatch 対象 phase で UCB に渡せる action shape を組み立てる。
 * Stage 2 では day/night_* のみ expand されるので、それらの phase に対応する action 型のみ。
 */
function buildPhaseActionFor(phase: Phase, action: number): PhaseAction {
  switch (phase) {
    case 'day': return { type: 'execute', target: action }
    case 'night_attack': return { type: 'attack', target: action }
    case 'night_divine': return { type: 'divine', target: action }
    case 'night_guard': return { type: 'guard', target: action }
    default:
      // claim/morning は default skip で expand されない前提 (Stage 1-2)。
      return defaultActionForPhase(phase)
  }
}

/**
 * dispatch ベースの expand: 現 phase の actor Module を選び、その Module の
 * forward で policy/value を取得、edges を初期化する。
 *
 * @returns decision faction 視点に変換済の value (root の場合のみ意味を持つ)
 */
function expandWithDispatch(
  node: TreeNode,
  state: SimState,
  decisionSeat: number,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  excludedMask: number,
  isRoot: boolean,
  decisionFaction: Faction,
): number | null {
  const dispatch = dispatchForPhase(state, decisionSeat, bundle)
  if (!dispatch) return null
  const out = dispatch.module.forwardAt(
    state, dispatch.actorSeat, dispatch.actorRole, dispatch.headName, invariants,
  )
  // legal action mask: 自席除外 + excludedMask
  // dispatch.actorSeat (の自身席) は phase によって意味が異なる:
  // - day: decisionSeat 自身は legal でない (自分に投票しない)
  // - night_attack: actor (wolf) 自身は legal でない (狼が自分を噛まない)
  // - 基本的には actor 自身を除外する。root では更に excludedMask (wolf teammates 等) を適用
  const baseExcluded = (1 << dispatch.actorSeat) | (isRoot ? excludedMask : 0)
  let sum = 0
  const filtered: Array<[number, number]> = []
  for (const [action, prior] of out.policy) {
    if ((baseExcluded >>> action) & 1) continue
    filtered.push([action, prior])
    sum += prior
  }
  if (filtered.length === 0) {
    // 全除外: 元の policy をそのまま使う
    for (const [action, prior] of out.policy) {
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
  return convertValueAcrossFaction(out.value, dispatch.module.faction(), decisionFaction)
}

/**
 * UCB（PUCT 変種、AlphaZero 流）で action 選択。
 * score(a) = Q(a) + c_puct * P(a) * sqrt(N_total) / (1 + N(a))
 */
function selectActionUCB(node: TreeNode, cPuct: number): number {
  const totalVisits = totalChildVisits(node)
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

/** path 全体の edge stats を value で更新 (decision faction 視点で同符号) */
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
 */
export type Faction = 'village' | 'wolf' | 'hamster'

/**
 * GameOutcome → 指定 faction 視点の value [-1.3, +1]。
 *
 * 各陣営の視点で「自陣営勝ち = +1」「他 2 陣営のうち最悪 = -1.3」。
 * reward.ts と整合 (village 視点で hamster_win が最悪という慣例)。
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
