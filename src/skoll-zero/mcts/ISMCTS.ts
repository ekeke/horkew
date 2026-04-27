import type { GameOutcome } from '../../hati/simulate.ts'
import { hasSeat } from '../../hati/types.ts'
import { cloneSimState } from '../simulator/world-state.ts'
import type { SimState, Phase } from '../simulator/world-state.ts'
import { stepPhase, advancePhase } from '../simulator/rollout-sim.ts'
import type { PhaseAction } from '../simulator/rollout-sim.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { createTreeNode, totalChildVisits, childKey } from './node.ts'
import type { TreeNode } from './node.ts'
import type { Determinizer } from './determinize.ts'
import type { World } from '../../hati/types.ts'
import {
  dispatchForPhase,
  type ModuleBundle,
} from './dispatch.ts'
import type { RolloutInvariants } from '../observation/from-sim-state.ts'
import { OUTCOME_ORDER } from '../network/config.ts'

const RoleBitIndexFanatic = RoleBitIndex.fanatic

/** dispatch=null skip phase で child node を作るときに使う pseudo-action ID。
 *  edges には登録しないので backup での影響なし。 */
const SKIP_ACTION = -2

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
  if (determinizer.isOverflow()) {
    return { root: createTreeNode(), visits: new Map(), abortReason: 'determinizer_overflow' }
  }
  if (determinizer.size() === 0) {
    return { root: createTreeNode(), visits: new Map(), abortReason: 'no_consistent_world' }
  }
  const firstWorld = determinizer.sample(config.rng)
  if (!firstWorld) {
    return { root: createTreeNode(), visits: new Map(), abortReason: 'no_consistent_world' }
  }

  // decision faction を root world から決定 (Stage 2 では root world で固定)
  const decisionRole = firstWorld.roles[decisionSeat]
  const decisionFaction = factionForRole(decisionRole)
  if (!decisionFaction) {
    return { root: createTreeNode(), visits: new Map(), abortReason: 'unknown_decision_role' }
  }

  // root を phase 別に管理する。makeRolloutState の advancePhase が world 状態に応じて
  // skip するため、同じ actionMode でも world ごとに root の state.phase が違いうる。
  // 同じ TreeNode を異なる phase で再利用すると edges (phase 依存の legal action ID) が
  // 混在して target=16 等の不正値で WASM panic を引き起こすため、phase 別に root を分ける。
  const roots = new Map<string, TreeNode>()
  const targetPhase = phaseFromActionMode(actionMode)
  let dirichletApplied = false
  for (let i = 0; i < config.nRollouts; i++) {
    const world = i === 0 ? firstWorld : determinizer.sample(config.rng)
    if (!world) break
    const rolloutState = makeRolloutState(rootSimState, world, actionMode)
    let root = roots.get(rolloutState.phase)
    if (!root) {
      root = createTreeNode()
      roots.set(rolloutState.phase, root)
    }
    // 初回 expand + Dirichlet noise は targetPhase の root にだけ適用 (1 回限り)
    if (!dirichletApplied && rolloutState.phase === targetPhase
      && rolloutState.phase !== 'terminal' && hasSeat(rolloutState.alive, decisionSeat)) {
      const value = expandWithDispatch(root, rolloutState, decisionSeat, bundle, invariants, excludedMask, /*isRoot*/ true, decisionFaction)
      if (value !== null) {
        applyRootDirichletNoise(root, config)
      }
      dirichletApplied = true
    }
    runOneRollout(root, rolloutState, decisionSeat, bundle, invariants, config, decisionFaction, excludedMask)
  }
  // 戻り値は targetPhase の root に固定 (呼び出し元は actionMode 対応 phase の visit を期待)
  const finalRoot = roots.get(targetPhase) ?? createTreeNode()
  return { root: finalRoot, visits: collectRootVisits(finalRoot), abortReason: null }
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
      // Stage 4: NN は outcome 分布を返す。decision faction 視点の scalar に変換して backup。
      const v = outcomeDistToFactionValue(out.outcomeDist, decisionFaction)
      backup(path, v)
      return
    }
    // dispatch で Module を選んで expand or descent
    const dispatch = dispatchForPhase(state, decisionSeat, bundle)
    if (!dispatch) {
      // 本来 advancePhase で全 skip 候補が進められるはずだが、何らかの理由で dispatch=null。
      // 同じ node を異なる phase で再訪問する経路を避けるため、pseudo-action で child node に
      // 進めて tree を分岐する (path には乗せないので tree statistics に影響しない)。
      const nextState = cloneSimState(state)
      stepPhase(nextState, defaultActionForPhase(state.phase))
      const ck = childKey(SKIP_ACTION, nextState.phase)
      let child = node.children.get(ck)
      if (!child) {
        child = createTreeNode()
        node.children.set(ck, child)
      }
      node = child
      state = nextState
      continue
    }

    if (!node.expanded) {
      const value = expandWithDispatch(node, state, decisionSeat, bundle, invariants, isRoot ? excludedMask : 0, isRoot, decisionFaction)
      backup(path, value ?? 0)
      return
    }
    // 整合性検証: 同じ node を別 phase で訪れていないか (phase mismatch は children key
    // で防いでいるはずだが、防御的に検証 + 万一の場合 reportPhaseMismatch でログ)
    if (node.phase !== undefined && node.phase !== state.phase) {
      reportPhaseMismatch(node.phase, state.phase, node.edges)
    }
    const action = selectActionUCB(node, config.cPuct)
    if (action < 0) {
      backup(path, 0)
      return
    }
    const nextState = cloneSimState(state)
    stepPhase(nextState, buildPhaseActionFor(state, action))
    isRoot = false
    // child key = `${action}:${nextState.phase}` で world 依存の next phase を分岐
    const ck = childKey(action, nextState.phase)
    let child = node.children.get(ck)
    if (!child) {
      child = createTreeNode()
      node.children.set(ck, child)
    }
    path.push({ node, action })
    node = child
    state = nextState
  }
}

/**
 * 現 phase に応じた default action。Stage 3 では dispatch=null の場合の安全側 fallback
 * (本来は claim/morning も含め全 phase で dispatch が機能する前提)。
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
 * UCB action ID → PhaseAction 変換。phase ごとに ID 空間が異なる:
 *
 * | phase | action ID | 意味 |
 * |---|---|---|
 * | day / night_attack / night_divine / night_guard | 1..14 / -1 | target seat or -1 |
 * | claim_*_true | 0 / 1 | skip / CO |
 * | claim_*_fake | 0 / 1..14 | skip / claimer seat |
 * | morning | 0..27 | target_idx × 2 + color (0=human, 1=wolf) |
 *
 * morning の場合は state.morningPending[0] を seerSeat として使う。
 */
function buildPhaseActionFor(state: SimState, action: number): PhaseAction {
  switch (state.phase) {
    case 'day': return { type: 'execute', target: action }
    case 'night_attack': return { type: 'attack', target: action }
    case 'night_divine': return { type: 'divine', target: action }
    case 'night_guard': return { type: 'guard', target: action }
    case 'claim_seer_true':
    case 'claim_medium_true':
    case 'claim_bg_true':
    case 'claim_nekomata_true':
    case 'claim_mason':
      return { type: 'claim_true', willClaim: action === 1 }
    case 'claim_seer_fake':
    case 'claim_medium_fake':
    case 'claim_bg_fake':
    case 'claim_nekomata_fake':
      return action === 0
        ? { type: 'claim_fake', willClaim: false }
        : { type: 'claim_fake', willClaim: true, claimerSeat: action }
    case 'morning': {
      const seerSeat = state.morningPending[0] ?? -1
      const targetSeat = (action >> 1) + 1
      const color = (action & 1) === 0 ? 'human' : 'wolf'
      return { type: 'morning', reports: [{ seerSeat, target: targetSeat, color }] }
    }
    case 'terminal':
      return defaultActionForPhase('terminal')
  }
}

/**
 * 現 phase の legal action ID 集合を返す。
 *
 * - day / night_*: alive seat 1..14 (actor 自身を除く、night_guard は -1=無護衛も含む)
 * - claim_*_true: {0=skip, 1=CO}
 * - claim_*_fake: {0=skip} ∪ 未 CO 生存 wolf/fanatic seat
 * - morning: 28 ID = alive target seats × {human, wolf}
 *
 * @param state 現 state (morningPending 等を参照)
 * @param actorSeat dispatch.actorSeat (一部 phase で除外対象)
 */
function legalActionIdsForPhase(state: SimState, actorSeat: number): Set<number> {
  const out = new Set<number>()
  switch (state.phase) {
    case 'day':
    case 'night_attack':
    case 'night_divine': {
      // alive 全席 (actor 除く)
      let mask = state.alive & ~(1 << actorSeat)
      while (mask !== 0) {
        const bit = mask & (-mask)
        out.add(31 - Math.clz32(bit))
        mask ^= bit
      }
      return out
    }
    case 'night_guard': {
      let mask = state.alive & ~(1 << actorSeat)
      while (mask !== 0) {
        const bit = mask & (-mask)
        out.add(31 - Math.clz32(bit))
        mask ^= bit
      }
      out.add(-1) // 無護衛
      return out
    }
    case 'claim_seer_true':
    case 'claim_medium_true':
    case 'claim_bg_true':
    case 'claim_nekomata_true':
    case 'claim_mason':
      out.add(0)
      out.add(1)
      return out
    case 'claim_seer_fake':
    case 'claim_medium_fake':
    case 'claim_bg_fake':
    case 'claim_nekomata_fake': {
      out.add(0) // skip
      // 未 CO の wolf + fanatic 生存 seat
      const w = state.world
      let fanaticMask = 0
      for (let s = 1; s < w.roleIds.length; s++) {
        if (w.roleIds[s] === RoleBitIndexFanatic) fanaticMask |= (1 << s)
      }
      let mask = (w.wolfMask | fanaticMask) & state.alive
      for (const seat of state.claims.keys()) mask &= ~(1 << seat)
      while (mask !== 0) {
        const bit = mask & (-mask)
        out.add(31 - Math.clz32(bit))
        mask ^= bit
      }
      return out
    }
    case 'morning': {
      let mask = state.alive
      while (mask !== 0) {
        const bit = mask & (-mask)
        const targetSeat = 31 - Math.clz32(bit)
        out.add((targetSeat - 1) * 2 + 0) // human
        out.add((targetSeat - 1) * 2 + 1) // wolf
        mask ^= bit
      }
      return out
    }
    case 'terminal':
      return out
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
  // phase ごとに legal action ID 集合が異なるため、phase-aware に filter する。
  // seat-based phase (day/night_*) では追加で excludedMask (wolf teammates 等) を root のみ適用。
  const legalRaw = legalActionIdsForPhase(state, dispatch.actorSeat)
  const seatBased = isSeatBasedPhase(state.phase)
  // excludedMask 適用 (seat-based phase の root のみ)
  const legal = new Set<number>()
  for (const action of legalRaw) {
    if (seatBased && isRoot && excludedMask !== 0
      && action >= 1 && action <= 31
      && ((excludedMask >>> action) & 1)) continue
    legal.add(action)
  }
  if (legal.size === 0) {
    node.expanded = true
    node.phase = state.phase
    return outcomeDistToFactionValue(out.outcomeDist, decisionFaction)
  }
  // NN policy が legal action に与える prior を集計
  let providedSum = 0
  for (const [action, prior] of out.policy) {
    if (legal.has(action)) providedSum += prior
  }
  // 全 legal action に edge を作る (NN policy 不在のものも uniform で補填して MCTS 探索可能に)
  const uniform = 1 / legal.size
  for (const action of legal) {
    if (node.edges.has(action)) continue
    let prior: number
    if (providedSum > 0) {
      prior = (out.policy.get(action) ?? 0) / providedSum
    } else {
      prior = uniform
    }
    node.edges.set(action, { visits: 0, totalValue: 0, prior })
  }
  node.expanded = true
  node.phase = state.phase
  return outcomeDistToFactionValue(out.outcomeDist, decisionFaction)
}

/** Debug: phase mismatch (expandedPhase, currentPhase) のペアごとに最初の 1 回だけ警告 */
const phaseMismatchSeen = new Set<string>()
function reportPhaseMismatch(
  expandedPhase: string,
  currentPhase: string,
  edges: Map<number, { prior: number, visits: number, totalValue: number }>,
): void {
  const key = `${expandedPhase}->${currentPhase}`
  if (phaseMismatchSeen.has(key)) return
  phaseMismatchSeen.add(key)
  const actionIds = Array.from(edges.keys()).sort((a, b) => a - b)
  const minId = actionIds.length > 0 ? actionIds[0] : '-'
  const maxId = actionIds.length > 0 ? actionIds[actionIds.length - 1] : '-'
  console.error(`[MCTS] phase mismatch: ${key} edgesCount=${edges.size} edgeIdRange=[${minId}..${maxId}]`)
}

/** seat-based phase かどうか (excludedMask 適用判定用) */
function isSeatBasedPhase(phase: Phase): boolean {
  return phase === 'day' || phase === 'night_attack'
    || phase === 'night_divine' || phase === 'night_guard'
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
 * outcome → 指定 faction 視点の value [-2.0, +1]。
 *
 * | outcome \ faction | village | wolf | hamster |
 * |-------------------|--------:|-----:|--------:|
 * | village_win       |    +1.0 | -1.0 |    -1.0 |
 * | wolf_win          |    -1.0 | +1.0 |    -1.0 |
 * | hamster_win       |    -2.0 | -1.5 |    +1.0 |
 * | draw / ongoing    |     0   |   0  |       0 |
 *
 * 設計: normal skoll (`world-analysis.ts` の `FOX_WIN_PENALTY` および
 * `wolf-attack-analysis.ts` の `WOLF_FOX_WIN_PENALTY`) の思想を移植。
 *
 * - 村は狐排除を優先 (差 1.0: wolf_win=-1.0 → hamster_win=-2.0)。
 *   Stage 5 当初は -2.5 (差 1.5) だったが、30 round 学習で狼勝ち過剰
 *   (村が狐排除に意識を向けすぎ狼警戒が落ちた疑い) のため -2.0 に緩和
 * - 狼は狐排除を「やや」優先 (差 0.5: village_win=-1.0 → hamster_win=-1.5)。
 *   狼を村より弱いペナルティにすることで、狼が本職 (噛み) を放棄して
 *   狐排除に執着する局所最適を防ぐ
 * - 狐視点は対称的に他 2 陣営勝ち = -1.0 (狐自身は脅威評価が不要)
 * - draw/ongoing は中立 0
 *
 * Stage 4: 'draw' (FinalOutcome) と 'ongoing' (GameOutcome) の両方を受ける。
 * tanh range 制限は無く (outcome dist の dot product なので)、-2.0 でも安定。
 */
export function outcomeToValue(
  outcome: GameOutcome | 'draw' | null,
  faction: Faction,
): number {
  if (outcome == null) return 0
  switch (faction) {
    case 'village':
      return outcome === 'village_win' ? 1.0 : outcome === 'wolf_win' ? -1.0 : outcome === 'hamster_win' ? -2.0 : 0
    case 'wolf':
      return outcome === 'wolf_win' ? 1.0 : outcome === 'village_win' ? -1.0 : outcome === 'hamster_win' ? -1.5 : 0
    case 'hamster':
      return outcome === 'hamster_win' ? 1.0 : outcome === 'village_win' ? -1.0 : outcome === 'wolf_win' ? -1.0 : 0
  }
}

/** 互換: mason は village faction */
export function outcomeToMasonValue(outcome: GameOutcome | 'draw' | null): number {
  return outcomeToValue(outcome, 'village')
}

/**
 * Stage 4: outcome 分布 (Float32Array, 順序は network/config.ts の OUTCOME_ORDER) を
 * 指定 faction 視点の scalar value に変換。
 *
 * `value(faction) = Σ_o P(o) × outcomeToValue(o, faction)`
 *
 * NN の outcomeDist 出力 (softmax 済) を直接受け取り、faction-aware な MCTS backup
 * 用 scalar に整形する。陣営非依存の単一 distribution から派生するので、
 * 3 faction の value は数学的に整合する (互いに矛盾しない)。
 */
export function outcomeDistToFactionValue(
  dist: Float32Array | undefined,
  faction: Faction,
): number {
  if (!dist) return 0
  let v = 0
  for (let i = 0; i < OUTCOME_ORDER.length && i < dist.length; i++) {
    v += dist[i] * outcomeToValue(OUTCOME_ORDER[i], faction)
  }
  return v
}
