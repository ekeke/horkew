import type { GameOutcome } from '../../hati/simulate.ts'
import { hasSeat, popCount32 } from '../../hati/types.ts'
import { cloneSimState } from '../simulator/world-state.ts'
import type { SimState, Phase } from '../simulator/world-state.ts'
import {
  stepPhase, advancePhase, legalAttackActions, legalClaimDecisionActions, resolveNightSimulationAndAdvance,
} from '../simulator/rollout-sim.ts'
import type { PhaseAction } from '../simulator/rollout-sim.ts'
import type { SystemRole } from '../../types/index.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import { createTreeNode, totalChildVisits, childKey } from './node.ts'
import type { TreeNode } from './node.ts'
import type { Determinizer } from './determinize.ts'
import type { World } from '../../hati/types.ts'
import {
  dispatchForPhase,
  type DispatchResult,
  type ModuleBundle,
} from './dispatch.ts'
import type { RolloutInvariants } from '../observation/from-sim-state.ts'
import { sumAlivePossibilities } from '../observation/from-sim-state.ts'
import type { SkollZeroModule } from '../module/skoll-zero-module.ts'
import type { HeadName, NNOutput } from './nn.ts'
import { OUTCOME_ORDER } from '../network/config.ts'
import { BENCH_ENABLED, benchEnd } from '../bench/profiler.ts'
import { applyDayBonus, applyNarrowBonus, narrowProgress } from '../training/day-bonus.ts'

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
  /**
   * Day bonus 係数 (0 で無効、SKOLLZ_DAY_BONUS_COEF)。
   * 観測上 fox 生存中は value 評価で `+sign(faction) * coef * state.day` を加算。
   * faction sign は village/wolf=+1, hamster=-1。
   */
  dayBonusCoef?: number
  /**
   * Endgame bonus 係数 (0 で無効、SKOLLZ_ENDGAME_BONUS_COEF)。
   * viewer の retar で fox 候補が消えた時点で village/wolf に固定値 +endgameCoef を加算
   * (累積させない、最終日到達と同等の単発報酬)。hamster には適用しない。
   * 狐排除をマイルストーン化して短期決戦への遷移を促す。
   */
  endgameBonusCoef?: number
  /**
   * Night phase 並列化フラグ (SKOLLZ_NIGHT_PARALLEL)。
   * true: night_attack/divine/guard を atomic な 1 step として扱う。
   *   - 自己 phase: MCTS で expand/select、その後 executeNightStep で並列 sample + simulateNight
   *   - 敵 phase:   sampleAndAdvanceEnemyNightPhase で NN sample + advance (path 不参加 = MCTS branching せず)
   * これにより自己の night action から翌朝 state (or terminal) まで 1 step で leaf 評価される。
   * false (default): 既存挙動 (各 night phase で MCTS expand)。
   */
  nightParallel?: boolean
  /**
   * Retar narrowing reward 係数 (0 で無効、SKOLLZ_NARROW_COEF)。
   * 村陣営の leaf value に `+coef * narrowProgress` を加算する shaping。
   * narrowProgress = clamp01((rootGlobalSum - leafGlobalSum) / (alive × 11))
   * 真贋判別を学習させて「真占/真霊の自滅吊」を減らす狙い。狼/狐側は据え置き
   * (二項対称 shaping は陣営行動が分離してバレるため、handoff 2026-05-05 で不採用)。
   * `recomputeRetarInRollout=true` (= SKOLLZ_ROLLOUT_RETAR=1) と組合せて初めて意味がある。
   */
  narrowBonusCoef?: number
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
 * Root visit 分布のエントロピーを最大エントロピー (= log(N_legal)) で正規化した比率。
 * Dirichlet ε 自動減衰の判定信号として使う。
 *
 * 戻り値の解釈:
 *   - 0 → 1 つの action に visits が完全集中 (decisive)
 *   - 1 → 全 action に均等 (uniform / undecided)
 *   - 候補手が 1 つしかない / visits が空の場合は 0 を返す
 */
export function visitEntropyRatio(visits: Map<number, number>): number {
  const k = visits.size
  if (k <= 1) return 0
  let sum = 0
  for (const v of visits.values()) sum += v
  if (sum <= 0) return 0
  let h = 0
  for (const v of visits.values()) {
    if (v <= 0) continue
    const p = v / sum
    h -= p * Math.log(p)
  }
  return h / Math.log(k)
}

/**
 * MCTS root の意思決定種別。
 *
 * - `execute` / `attack` / `divine` / `guard`: per-seat 14 action 空間
 * - `claim_*_fake`: wolf/fanatic の偽 CO 判断 (15 action: skip + claimer seat)、
 *   全 sub-phase で record headName は 'claim_fake' に集約
 * - `morning`: 偽占い報告 (28 action: target × {white, black})
 *
 * Stage 2 で dispatch ベースの descent を導入したので、これは「root を置く初期 phase」を
 * 決めるためだけに使う。
 */
export type RootActionMode =
  | 'execute' | 'attack' | 'divine' | 'guard'
  | 'claim_seer_fake' | 'claim_medium_fake' | 'claim_bg_fake' | 'claim_nekomata_fake'
  | 'claim_decision'
  | 'morning'

/** action mode → MCTS root を置く initial phase */
function phaseFromActionMode(mode: RootActionMode): Phase {
  switch (mode) {
    case 'execute': return 'day'
    case 'attack': return 'night_attack'
    case 'divine': return 'night_divine'
    case 'guard': return 'night_guard'
    case 'claim_seer_fake': return 'claim_seer_fake'
    case 'claim_medium_fake': return 'claim_medium_fake'
    case 'claim_bg_fake': return 'claim_bg_fake'
    case 'claim_nekomata_fake': return 'claim_nekomata_fake'
    case 'claim_decision': return 'claim_decision'
    case 'morning': return 'morning'
  }
}

/**
 * action mode → record の headName。
 * claim_*_fake (4 種) は全て 'claim_fake' に集約 (TF head 名)。
 * claim_decision は wolf imitation A案で 1 phase 統合 head。
 */
export function headNameFromActionMode(mode: RootActionMode): HeadName {
  switch (mode) {
    case 'execute': return 'execute'
    case 'attack': return 'attack'
    case 'divine': return 'divine'
    case 'guard': return 'guard'
    case 'claim_seer_fake':
    case 'claim_medium_fake':
    case 'claim_bg_fake':
    case 'claim_nekomata_fake':
      return 'claim_fake'
    case 'claim_decision': return 'claim_decision'
    case 'morning': return 'morning'
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
/**
 * SKOLLZ_BATCH_INFER 環境変数で batched MCTS を有効化。> 1 で同 Module 内 batch を
 * 1 回の forwardBatch にまとめる。virtual loss で複数 rollout の path 集中を回避。
 *
 * 値:
 * - 未指定 / 0 / 1: 従来 sequential 経路 (既存挙動維持)
 * - 2 以上: batched 経路、その値を BATCH_SIZE として使う
 */
const BATCH_INFER_SIZE: number = (() => {
  const raw = process.env.SKOLLZ_BATCH_INFER
  if (!raw) return 1
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 1 ? n : 1
})()


export function runMCTS(
  rootSimState: SimState,
  decisionSeat: number,
  determinizer: Determinizer,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  config: MCTSConfig = DEFAULT_MCTS_CONFIG,
  opts: { actionMode?: RootActionMode, excludedMask?: number } = {},
): MCTSResult {
  // narrow bonus が有効な場合のみ root の global retar sum を計算してキャッシュ。
  // invariants は buildInvariants(ctx) で per-MCTS-call に作られるため、ここで mutate して安全。
  if ((config.narrowBonusCoef ?? 0) !== 0
    && invariants.globalRetarSumAtRoot === undefined) {
    invariants.globalRetarSumAtRoot = sumAlivePossibilities(
      invariants.globalRetarPossibilities, rootSimState.alive,
    )
  }
  if (BATCH_INFER_SIZE > 1) {
    return runBatchedMCTSImpl(rootSimState, decisionSeat, determinizer, bundle, invariants, config, opts, BATCH_INFER_SIZE)
  }
  const tMctsStart = BENCH_ENABLED ? performance.now() : 0
  const actionMode = opts.actionMode ?? 'execute'
  const excludedMask = opts.excludedMask ?? 0
  if (determinizer.isOverflow()) {
    if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
    return { root: createTreeNode(), visits: new Map(), abortReason: 'determinizer_overflow' }
  }
  if (determinizer.size() === 0) {
    if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
    return { root: createTreeNode(), visits: new Map(), abortReason: 'no_consistent_world' }
  }
  const firstWorld = determinizer.sample(config.rng)
  if (!firstWorld) {
    if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
    return { root: createTreeNode(), visits: new Map(), abortReason: 'no_consistent_world' }
  }

  // decision faction を root world から決定 (Stage 2 では root world で固定)
  const decisionRole = firstWorld.roles[decisionSeat]
  const decisionFaction = factionForRole(decisionRole)
  if (!decisionFaction) {
    if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
    return { root: createTreeNode(), visits: new Map(), abortReason: 'unknown_decision_role' }
  }

  // root を phase 別に管理する。makeRolloutState の advancePhase が world 状態に応じて
  // skip するため、同じ actionMode でも world ごとに root の state.phase が違いうる。
  // 同じ TreeNode を異なる phase で再利用すると edges (phase 依存の legal action ID) が
  // 混在して target=16 等の不正値で WASM panic を引き起こすため、phase 別に root を分ける。
  const roots = new Map<string, TreeNode>()
  const targetPhase = phaseFromActionMode(actionMode)
  let dirichletApplied = false
  // nightParallel の sample forward キャッシュ (per-MCTS-call、Determinizer の同 world 再 sample 時に hit)
  const nightSampleCache = config.nightParallel ? new NightSampleCache() : undefined
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
      const value = expandWithDispatch(root, rolloutState, decisionSeat, bundle, invariants, excludedMask, /*isRoot*/ true, decisionFaction, config.dayBonusCoef ?? 0, config.endgameBonusCoef ?? 0, config.narrowBonusCoef ?? 0)
      if (value !== null) {
        applyRootDirichletNoise(root, config)
      }
      dirichletApplied = true
    }
    runOneRollout(root, rolloutState, decisionSeat, bundle, invariants, config, decisionFaction, excludedMask, nightSampleCache)
  }
  // 戻り値は targetPhase の root に固定 (呼び出し元は actionMode 対応 phase の visit を期待)
  const finalRoot = roots.get(targetPhase) ?? createTreeNode()
  const result: MCTSResult = { root: finalRoot, visits: collectRootVisits(finalRoot), abortReason: null }
  if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
  return result
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
function factionForRole(role: SystemRole): Faction | null {
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

// ============================================================
// Night phase 並列化 (MCTSConfig.nightParallel=true 時の rollout 動作)
// ============================================================

/** night phase かどうか (executeNightStep 適用判定) */
function isNightPhase(phase: Phase): boolean {
  return phase === 'night_attack' || phase === 'night_divine' || phase === 'night_guard'
}

/** dispatch.actorRole の faction が decisionFaction と一致するか */
function isOwnPhase(dispatch: DispatchResult, decisionFaction: Faction): boolean {
  const phaseFaction = factionForRole(dispatch.actorRole)
  return phaseFaction === decisionFaction
}

/** mask の最下位 set bit に対応する seat (なければ -1) */
function lowestSetSeat(mask: number): number {
  if (mask === 0) return -1
  const bit = mask & (-mask)
  return 31 - Math.clz32(bit)
}

/** 14 人村の最大 seat 番号 (rollout-sim.ts と同じ MAX_SEAT) */
const MAX_SEAT_NIGHT = 14

/**
 * 並列 night sample の per-MCTS-call キャッシュ (ISMCTS 流 world-agnostic 共有)。
 *
 * 旧 mode (sequential night phases) では MCTS tree node が情報集合 (information set) ベースで
 * 1 つだけ存在し、最初の rollout の forward 結果が tree edges に保存され、後続の rollout は
 * world が違っても同じ edges を再利用していた (ISMCTS の標準近似)。
 *
 * 新 mode (nightParallel) では sample が tree edges に乗らないため、当初は world ごとに
 * 別 forward を計算していたが、これは forward 数 = W (世界数) に膨らむ。14 人村では W が
 * 100 を超え rollouts=200 を上回ることもあり、(B) 旧 cache (world keyed) では hit 率が低かった。
 *
 * ここでは world を cache key から外し、`(role, alive, day)` のみで key 化することで
 * 旧 mode の tree-edges 共有と同等の近似を実現する:
 *   - 第 1 rollout (world W1) の sample → forward 計算、cache に保存
 *   - 第 2 rollout (world W2、wolf seat 違う) → cache hit、policy を再利用
 *   - sampling 時の legal mask は各 rollout の world で計算 (teammates 除外等)
 *
 * 効果: forward 数が W → ~3-5 件 (alive 変化と role 数だけ) に減少、wall-time 大幅削減。
 *
 * 近似の妥当性: NN obs は情報集合 + viewer 私的情報中心、actor seat に強く依存しない。
 * MCTS visit 集積で世界差を value backup 経由で吸収する (旧 mode と同等の精度)。
 */
class NightSampleCache {
  private readonly cache: Map<string, NNOutput> = new Map()
  hits = 0
  misses = 0

  /** key で取得。miss なら compute() を呼んで保存 */
  get(key: string, compute: () => NNOutput): NNOutput {
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.hits++
      return cached
    }
    this.misses++
    const out = compute()
    this.cache.set(key, out)
    return out
  }
}

/**
 * NN policy 分布から legal action 集合に制限して 1 つ categorical sample (T=1)。
 *
 * - legal ∩ policy.keys() に正規化後 categorical sample
 * - NN policy が legal に重みを置いていない場合は legal 内で uniform sample
 */
function samplePolicyAction(
  policy: Map<number, number>,
  legal: Set<number>,
  rng: () => number,
): number {
  const candidates: Array<[number, number]> = []
  let sum = 0
  for (const a of legal) {
    const p = policy.get(a) ?? 0
    if (p > 0) {
      candidates.push([a, p])
      sum += p
    }
  }
  if (sum <= 0 || candidates.length === 0) {
    // policy が legal に重み無 → uniform fallback
    const arr = Array.from(legal)
    return arr[Math.floor(rng() * arr.length)]
  }
  const r = rng() * sum
  let acc = 0
  for (const [a, p] of candidates) {
    acc += p
    if (r <= acc) return a
  }
  return candidates[candidates.length - 1][0]  // 浮動小数誤差 fallback
}

/**
 * 狼の噛み先を NN policy から sample。
 * - 生存狼 0 → undefined (noBite が valid)
 * - bundle.wolf 不在 → undefined
 * - legalAttackActions は LW 猫又除外 + wolf teammates 除外を含む
 */
function sampleWolfAttack(
  state: SimState,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  rng: () => number,
  cache?: NightSampleCache,
): number | undefined {
  const wolfSeat = lowestSetSeat(state.world.wolfMask & state.alive)
  if (wolfSeat < 0) return undefined
  const module = bundle.wolf
  if (!module) return undefined

  // forward (cache hit なら NN forward 省略)。
  // ISMCTS 流: cache key は world-agnostic (alive + day のみ)。
  // 第 1 rollout の forward 結果を後続の世界違い rollout でも policy として再利用。
  const cacheKey = `wolf:${state.alive}:${state.day}`
  const compute = (): NNOutput => {
    const savedPhase = state.phase
    state.phase = 'night_attack'
    const r = module.forwardAt(state, wolfSeat, 'werewolf', 'attack', invariants)
    state.phase = savedPhase
    return r
  }
  const out = cache ? cache.get(cacheKey, compute) : compute()

  const legal = new Set<number>()
  for (const a of legalAttackActions(state)) {
    if (a.type === 'attack' && a.target >= 1 && a.target <= MAX_SEAT_NIGHT) legal.add(a.target)
  }
  if (legal.size === 0) return undefined
  return samplePolicyAction(out.policy, legal, rng)
}

/**
 * 真 seer の占い先を NN policy から sample。
 * - 生存真 seer 0 → undefined
 * - bundle.standard 不在 → undefined
 */
function sampleSeerDivine(
  state: SimState,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  rng: () => number,
  cache?: NightSampleCache,
): number | undefined {
  const seerSeat = lowestSetSeat(state.world.seerMask & state.alive)
  if (seerSeat < 0) return undefined
  const module = bundle.standard
  if (!module) return undefined

  const cacheKey = `seer:${state.alive}:${state.day}`
  const compute = (): NNOutput => {
    const savedPhase = state.phase
    state.phase = 'night_divine'
    const r = module.forwardAt(state, seerSeat, 'seer', 'divine', invariants)
    state.phase = savedPhase
    return r
  }
  const out = cache ? cache.get(cacheKey, compute) : compute()

  // alive 全席 (自己 seer 除く)
  const legal = new Set<number>()
  let mask = state.alive & ~(1 << seerSeat)
  while (mask !== 0) {
    const bit = mask & (-mask)
    const seat = 31 - Math.clz32(bit)
    if (seat >= 1 && seat <= MAX_SEAT_NIGHT) legal.add(seat)
    mask ^= bit
  }
  if (legal.size === 0) return undefined
  return samplePolicyAction(out.policy, legal, rng)
}

/**
 * 真 bodyguard の護衛先を NN policy から sample。
 * - bg 不在/退場 → undefined (護衛無し、null OK)
 * - bundle.standard 不在 → undefined
 * - 合法手は alive 自己除く + -1 (無護衛)
 */
function sampleBgGuard(
  state: SimState,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  rng: () => number,
  cache?: NightSampleCache,
): number | undefined {
  const bgSeat = state.world.bodyguardSeat
  if (bgSeat < 0 || (state.alive & (1 << bgSeat)) === 0) return undefined
  const module = bundle.standard
  if (!module) return undefined

  const cacheKey = `bg:${state.alive}:${state.day}`
  const compute = (): NNOutput => {
    const savedPhase = state.phase
    state.phase = 'night_guard'
    const r = module.forwardAt(state, bgSeat, 'bodyguard', 'guard', invariants)
    state.phase = savedPhase
    return r
  }
  const out = cache ? cache.get(cacheKey, compute) : compute()

  const legal = new Set<number>()
  let mask = state.alive & ~(1 << bgSeat)
  while (mask !== 0) {
    const bit = mask & (-mask)
    const seat = 31 - Math.clz32(bit)
    if (seat >= 1 && seat <= MAX_SEAT_NIGHT) legal.add(seat)
    mask ^= bit
  }
  legal.add(-1) // 無護衛
  return samplePolicyAction(out.policy, legal, rng)
}

/**
 * 並列 night step の中核: 自己以外の night actor (wolf/seer/bg) を NN policy sample で並列決定する。
 *
 * 並列セマンティクス: 各 NN forward は他者の choice を観測しない。
 *   - Phase A: 全 forward を先に実行 (state の pending* は self の値のみ書き込まれた状態)
 *   - Phase B: sample 結果を一括書き込み (parallel commit)
 *
 * selfRole に応じて自己分の sample はスキップ:
 *   - werewolf 自己: attack sample スキップ
 *   - seer 自己: divine sample スキップ
 *   - bodyguard 自己: guard sample スキップ
 */
function resolveNightInParallel(
  state: SimState,
  selfRole: SystemRole,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  rng: () => number,
  cache?: NightSampleCache,
): void {
  // 既に set 済の pendingX は再 sample しない (Day 2+ で先行 sample 済の場合あり)。
  // Phase A: 未 set かつ自己以外の night actor に対して forward を先行実行
  let attackSample: number | undefined
  let divineSample: number | undefined
  let guardSample: number | undefined

  if (selfRole !== 'werewolf' && state.pendingAttack === null) {
    attackSample = sampleWolfAttack(state, bundle, invariants, rng, cache)
  }
  if (selfRole !== 'seer' && state.pendingDivineTargets.length === 0) {
    divineSample = sampleSeerDivine(state, bundle, invariants, rng, cache)
  }
  if (selfRole !== 'bodyguard' && state.pendingGuard === null) {
    guardSample = sampleBgGuard(state, bundle, invariants, rng, cache)
  }

  // Phase B: 一括書き込み (parallel commit)
  if (attackSample !== undefined) state.pendingAttack = attackSample
  if (divineSample !== undefined) state.pendingDivineTargets.push(divineSample)
  if (guardSample !== undefined) state.pendingGuard = guardSample
}

/**
 * Enemy night phase で 1 step 進める (nightParallel mode 専用)。
 *
 * 呼び出し条件: nightParallel=true、state.phase ∈ night、非自己 phase。
 *
 * - night_attack: sampleWolfAttack で pendingAttack を埋め、state.phase=night_divine へ (skip 連鎖込み)
 * - night_divine: sampleSeerDivine で pendingDivineTargets に push、state.phase=night_guard へ
 * - night_guard:  sampleBgGuard で pendingGuard を埋め、resolveNightSimulationAndAdvance で morning/terminal へ
 *
 * 既に set されている pendingX は再 sample しない。NN sample 失敗 (生存 actor 0 等) は no-op (pendingX は null/empty のまま)。
 *
 * Note: stepPhase は使わない (skip semantics: child node 作るが path 不参加、後で MCTS branch しない)。
 */
function sampleAndAdvanceEnemyNightPhase(
  state: SimState,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  rng: () => number,
  cache?: NightSampleCache,
): void {
  switch (state.phase) {
    case 'night_attack': {
      if (state.pendingAttack === null) {
        const sample = sampleWolfAttack(state, bundle, invariants, rng, cache)
        if (sample !== undefined) state.pendingAttack = sample
      }
      state.phase = 'night_divine'
      advancePhase(state)
      break
    }
    case 'night_divine': {
      if (state.pendingDivineTargets.length === 0) {
        const sample = sampleSeerDivine(state, bundle, invariants, rng, cache)
        if (sample !== undefined) state.pendingDivineTargets.push(sample)
      }
      state.phase = 'night_guard'
      advancePhase(state)
      break
    }
    case 'night_guard': {
      if (state.pendingGuard === null) {
        const sample = sampleBgGuard(state, bundle, invariants, rng, cache)
        if (sample !== undefined) state.pendingGuard = sample
      }
      // simulateNight + outcome + 翌 morning 遷移
      resolveNightSimulationAndAdvance(state)
      break
    }
    // 他 phase は呼ばれない (caller が isNightPhase で gating)
  }
}

/**
 * Night step を atomic に処理する。MCTS rollout の自己 night phase 到達時に呼ぶ。
 *
 * 処理:
 *   1. selfAction を pending* に直接書き込み (stepPhase 不経由 = phase 遷移しない)
 *   2. resolveNightInParallel で自己以外の night actor を並列 NN sample で決定
 *   3. resolveNightSimulationAndAdvance で simulateNight + outcome + 翌 morning 遷移
 *
 * 完了時: state.phase は 'morning' か 'terminal' に確定。
 * 中間状態 (例: night_divine だが pendingDivine set 済) は発生しない。
 */
function executeNightStep(
  state: SimState,
  selfAction: PhaseAction,
  decisionSeat: number,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  rng: () => number,
  cache?: NightSampleCache,
): void {
  // 1. 自己の pending を直接書き込み
  switch (selfAction.type) {
    case 'attack':
      if (selfAction.target >= 1 && selfAction.target <= MAX_SEAT_NIGHT) {
        state.pendingAttack = selfAction.target
      }
      break
    case 'divine':
      if (selfAction.target >= 1 && selfAction.target <= MAX_SEAT_NIGHT) {
        state.pendingDivineTargets.push(selfAction.target)
      }
      break
    case 'guard':
      if (selfAction.target >= 1 && selfAction.target <= MAX_SEAT_NIGHT) {
        state.pendingGuard = selfAction.target
      }
      break
    default:
      // 自己 night phase で attack/divine/guard 以外は来ない (caller が phase で振り分け)
      break
  }

  // 2. 自己以外を並列 sample で決定
  const selfRole = state.world.roles[decisionSeat]
  resolveNightInParallel(state, selfRole, bundle, invariants, rng, cache)

  // 3. simulateNight + outcome + morning 遷移
  resolveNightSimulationAndAdvance(state)
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
  nightSampleCache?: NightSampleCache,
): void {
  const path: { node: TreeNode, action: number }[] = []
  let node = root
  let state = initialState
  let isRoot = true

  const dayBonusCoef = config.dayBonusCoef ?? 0
  const endgameBonusCoef = config.endgameBonusCoef ?? 0
  const narrowBonusCoef = config.narrowBonusCoef ?? 0

  while (true) {
    if (state.phase === 'terminal') {
      const tBackup = BENCH_ENABLED ? performance.now() : 0
      const baseV = outcomeToValue(state.outcome, decisionFaction, state.day, dayBonusCoef, { foxAliveByViewer: state.foxAliveByViewer, endgameBonusCoef })
      backup(path, applyNarrowBonusForLeaf(baseV, decisionFaction, state, invariants, narrowBonusCoef))
      if (BENCH_ENABLED) benchEnd('mcts_backup', tBackup)
      return
    }
    if (!hasSeat(state.alive, decisionSeat)) {
      // 決定者死亡: dispatch で leaf 評価 (Module で value を取る)
      const dispatch = dispatchForPhase(state, decisionSeat, bundle)
      if (!dispatch) {
        // skip 連鎖で進められない (claim/morning が default skip だが、この phase で
        // dispatch=null は本来発生しない)。安全側で 0 backup。
        const tBackup = BENCH_ENABLED ? performance.now() : 0
        backup(path, 0)
        if (BENCH_ENABLED) benchEnd('mcts_backup', tBackup)
        return
      }
      const out = dispatch.module.forwardAt(state, dispatch.actorSeat, dispatch.actorRole, dispatch.headName, invariants)
      // Stage 4: NN は outcome 分布を返す。decision faction 視点の scalar に変換して backup。
      const baseV = outcomeDistToFactionValue(out.outcomeDist, decisionFaction, state.day, dayBonusCoef, { foxAliveByViewer: state.foxAliveByViewer, endgameBonusCoef })
      const v = applyNarrowBonusForLeaf(baseV, decisionFaction, state, invariants, narrowBonusCoef)
      const tBackup = BENCH_ENABLED ? performance.now() : 0
      backup(path, v)
      if (BENCH_ENABLED) benchEnd('mcts_backup', tBackup)
      return
    }
    // dispatch で Module を選んで expand or descent
    const dispatch = dispatchForPhase(state, decisionSeat, bundle)
    if (!dispatch) {
      // 本来 advancePhase で全 skip 候補が進められるはずだが、何らかの理由で dispatch=null。
      // 同じ node を異なる phase で再訪問する経路を避けるため、pseudo-action で child node に
      // 進めて tree を分岐する (path には乗せないので tree statistics に影響しない)。
      const tStep = BENCH_ENABLED ? performance.now() : 0
      const nextState = cloneSimState(state)
      stepPhase(nextState, defaultActionForPhase(state.phase))
      if (BENCH_ENABLED) benchEnd('step_phase', tStep)
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

    // ★ nightParallel mode: 敵 night phase は NN sample で advance、MCTS branching せず (path 不参加)
    if (config.nightParallel && isNightPhase(state.phase) && !isOwnPhase(dispatch, decisionFaction)) {
      const tStep = BENCH_ENABLED ? performance.now() : 0
      const nextState = cloneSimState(state)
      sampleAndAdvanceEnemyNightPhase(nextState, bundle, invariants, config.rng, nightSampleCache)
      if (BENCH_ENABLED) benchEnd('step_phase', tStep)
      const ck = childKey(SKIP_ACTION, nextState.phase)
      let child = node.children.get(ck)
      if (!child) {
        child = createTreeNode()
        node.children.set(ck, child)
      }
      node = child
      state = nextState
      isRoot = false
      continue
    }

    if (!node.expanded) {
      const tExpand = BENCH_ENABLED ? performance.now() : 0
      const value = expandWithDispatch(node, state, decisionSeat, bundle, invariants, isRoot ? excludedMask : 0, isRoot, decisionFaction, dayBonusCoef, endgameBonusCoef, narrowBonusCoef)
      if (BENCH_ENABLED) benchEnd('mcts_expand', tExpand)
      const tBackup = BENCH_ENABLED ? performance.now() : 0
      backup(path, value ?? 0)
      if (BENCH_ENABLED) benchEnd('mcts_backup', tBackup)
      return
    }
    // 整合性検証: 同じ node を別 phase で訪れていないか (phase mismatch は children key
    // で防いでいるはずだが、防御的に検証 + 万一の場合 reportPhaseMismatch でログ)
    if (node.phase !== undefined && node.phase !== state.phase) {
      reportPhaseMismatch(node.phase, state.phase, node.edges)
    }
    const tSelect = BENCH_ENABLED ? performance.now() : 0
    const action = selectActionUCB(node, config.cPuct)
    if (BENCH_ENABLED) benchEnd('mcts_select', tSelect)
    if (action < 0) {
      const tBackup = BENCH_ENABLED ? performance.now() : 0
      backup(path, 0)
      if (BENCH_ENABLED) benchEnd('mcts_backup', tBackup)
      return
    }
    const tStep = BENCH_ENABLED ? performance.now() : 0
    const nextState = cloneSimState(state)
    // ★ nightParallel mode + 自己 night phase: executeNightStep で並列 sample + simulateNight + morning 遷移を atomic に処理
    if (config.nightParallel && isNightPhase(state.phase) && isOwnPhase(dispatch, decisionFaction)) {
      executeNightStep(nextState, buildPhaseActionFor(state, action), decisionSeat, bundle, invariants, config.rng, nightSampleCache)
    } else {
      stepPhase(nextState, buildPhaseActionFor(state, action))
    }
    if (BENCH_ENABLED) benchEnd('step_phase', tStep)
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
    case 'claim_decision':
      return { type: 'claim_decision', actionId: 0 } // skip
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
    case 'claim_decision':
      return { type: 'claim_decision', actionId: action }
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
export function legalActionIdsForPhase(state: SimState, actorSeat: number): Set<number> {
  const out = new Set<number>()
  switch (state.phase) {
    case 'night_attack': {
      // 噛み専用: rollout-sim の legalAttackActions (wolf teammates 除外、
      // LW 時の猫又除外) を使う。これを使わずに alive 全席を返すと、retar が
      // 観測上 nekomata を確定している盤面でも MCTS が「猫又を噛む」を
      // 合法手として残し、LW が猫又自滅で負ける rollout が visit に乗る。
      for (const action of legalAttackActions(state)) {
        if (action.type === 'attack' && action.target >= 0) out.add(action.target)
      }
      return out
    }
    case 'day':
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
    case 'claim_decision': {
      // 0 (skip) と未偽 CO role × 未 CO 生存 wolf/fanatic claimer の組合せ
      return legalClaimDecisionActions(state)
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
  dayBonusCoef: number,
  endgameBonusCoef: number,
  narrowBonusCoef: number,
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
    const baseV = outcomeDistToFactionValue(out.outcomeDist, decisionFaction, state.day, dayBonusCoef, { foxAliveByViewer: state.foxAliveByViewer, endgameBonusCoef })
    return applyNarrowBonusForLeaf(baseV, decisionFaction, state, invariants, narrowBonusCoef)
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
  const baseV = outcomeDistToFactionValue(out.outcomeDist, decisionFaction, state.day, dayBonusCoef, { foxAliveByViewer: state.foxAliveByViewer, endgameBonusCoef })
  return applyNarrowBonusForLeaf(baseV, decisionFaction, state, invariants, narrowBonusCoef)
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
/**
 * 狐勝ち時の村・狼ペナルティ env override。
 *
 * default: 村 -2.0、狼 -1.5 (Stage 5 で確定した値)。
 * 学習中の狐勝率が高い場合に env で強化可能 (例: -3.0 / -2.5 で +1.0 強化)。
 *
 * 注意: 強化しすぎると wolf が本職 (噛み) を放棄して狐排除に執着する局所最適に
 * 陥る (Stage 5 の経緯で -2.5 → -2.0 に緩和した経緯あり)。
 */
const VILLAGE_FOX_LOSE = (() => {
  const raw = process.env.SKOLLZ_VILLAGE_FOX_LOSE
  if (!raw) return -2.0
  const v = parseFloat(raw)
  return Number.isFinite(v) ? v : -2.0
})()
const WOLF_FOX_LOSE = (() => {
  const raw = process.env.SKOLLZ_WOLF_FOX_LOSE
  if (!raw) return -1.5
  const v = parseFloat(raw)
  return Number.isFinite(v) ? v : -1.5
})()

export function outcomeToValue(
  outcome: GameOutcome | 'draw' | null,
  faction: Faction,
  day: number = 0,
  dayBonusCoef: number = 0,
  opts?: { foxAliveByViewer?: boolean, endgameBonusCoef?: number },
): number {
  if (outcome == null) return 0
  let base: number
  // 案 A: 敗北ペナルティを bonus 分強化 (-1.0 → -1.3)。
  // endgame bonus +endgameCoef が乗ったときに「狐排除した上での敗北」が
  // 元の -1.0 相当に戻るよう、outcome 側で先取りで強める。
  // hamster_win 時のペナルティは VILLAGE_FOX_LOSE / WOLF_FOX_LOSE (env override 可)。
  switch (faction) {
    case 'village':
      base = outcome === 'village_win' ? 1.0 : outcome === 'wolf_win' ? -1.3 : outcome === 'hamster_win' ? VILLAGE_FOX_LOSE : 0
      break
    case 'wolf':
      base = outcome === 'wolf_win' ? 1.0 : outcome === 'village_win' ? -1.3 : outcome === 'hamster_win' ? WOLF_FOX_LOSE : 0
      break
    case 'hamster':
      base = outcome === 'hamster_win' ? 1.0 : outcome === 'village_win' ? -1.0 : outcome === 'wolf_win' ? -1.0 : 0
      break
  }
  return applyDayBonus(base, faction, day, dayBonusCoef, opts)
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
  day: number = 0,
  dayBonusCoef: number = 0,
  opts?: { foxAliveByViewer?: boolean, endgameBonusCoef?: number },
): number {
  if (!dist) return 0
  let v = 0
  for (let i = 0; i < OUTCOME_ORDER.length && i < dist.length; i++) {
    // base のみ加算 (default day=0, coef=0)。bonus は最後に 1 回だけ applyDayBonus する。
    v += dist[i] * outcomeToValue(OUTCOME_ORDER[i], faction)
  }
  return applyDayBonus(v, faction, day, dayBonusCoef, opts)
}

/**
 * leaf 評価値に Retar narrowing bonus を適用する内部 helper。
 *
 * 村陣営の value に `+coef × narrowProgress` を加算 (非村は据え置き、二項対称 shaping 不採用)。
 * progress は `(rootGlobalSum - leafGlobalSum) / (alive × 11)` を [0, 1] に clamp。
 *
 * 早期 short-circuit: coef=0 / globalRetarSumAtRoot 未設定 / leaf state.globalRetarSum=null で no-op。
 * (= rollout retar OFF または narrow coef OFF のとき完全に bypass)
 */
function applyNarrowBonusForLeaf(
  baseValue: number,
  faction: Faction,
  state: SimState,
  invariants: RolloutInvariants,
  coef: number,
): number {
  if (coef === 0) return baseValue
  const progress = narrowProgress(
    invariants.globalRetarSumAtRoot ?? null,
    state.globalRetarSum,
    popCount32(state.alive),
  )
  return applyNarrowBonus(baseValue, faction, progress, coef)
}

// ============================================================
// Batched MCTS (SKOLLZ_BATCH_INFER > 1 で有効化)
// ============================================================

/**
 * Virtual loss の単位。AlphaZero 標準: 各 path edge に visits=+1 / totalValue=-1 を
 * 仮置きし、複数 rollout が同じ child action に集中するのを抑制。backup 時に revert。
 */
const VIRTUAL_LOSS_VISIT = 1
const VIRTUAL_LOSS_VALUE = -1

function applyVirtualLoss(path: Array<{ node: TreeNode, action: number }>): void {
  for (const { node, action } of path) {
    const edge = node.edges.get(action)
    if (edge) {
      edge.visits += VIRTUAL_LOSS_VISIT
      edge.totalValue += VIRTUAL_LOSS_VALUE
    }
  }
}

function revertVirtualLoss(path: Array<{ node: TreeNode, action: number }>): void {
  for (const { node, action } of path) {
    const edge = node.edges.get(action)
    if (edge) {
      edge.visits -= VIRTUAL_LOSS_VISIT
      edge.totalValue -= VIRTUAL_LOSS_VALUE
    }
  }
}

/** descentToLeaf の返り値 type */
type LeafKind = 'terminal' | 'leaf_eval' | 'pending_expand' | 'invalid'

type LeafInfo = {
  kind: LeafKind
  path: Array<{ node: TreeNode, action: number }>
  state: SimState
  node: TreeNode
  dispatch?: DispatchResult
  isRoot: boolean
  /** terminal / invalid の即 backup 用 value (decision faction 視点) */
  immediateValue?: number
}

/**
 * root から leaf に到達するまで selectActionUCB + stepPhase で descent する。
 * NN forward は呼ばない (caller が batch でまとめる)。
 *
 * leaf kind:
 * - 'terminal': state.phase === 'terminal'。outcome から決まる value で即 backup
 * - 'invalid': dispatch=null かつ skip 連鎖でも進めない、または selectAction で action<0
 * - 'leaf_eval': 決定者死亡で leaf 評価が必要 (NN forward → backup、edges 触らない)
 * - 'pending_expand': 未 expand の node に到達 (NN forward → expandEdges + backup)
 *
 * nightParallel mode は ISMCTS 流 cache (world-agnostic key) に変更したため、
 * 旧 (A) batched 経路 (pending_night_*) は撤去。inline で sample + cache を実行する。
 */
function descentToLeaf(
  root: TreeNode,
  initialState: SimState,
  decisionSeat: number,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  config: MCTSConfig,
  decisionFaction: Faction,
  nightSampleCache?: NightSampleCache,
): LeafInfo {
  const path: Array<{ node: TreeNode, action: number }> = []
  let node = root
  let state = initialState

  const dayBonusCoef = config.dayBonusCoef ?? 0
  const endgameBonusCoef = config.endgameBonusCoef ?? 0
  const narrowBonusCoef = config.narrowBonusCoef ?? 0

  while (true) {
    if (state.phase === 'terminal') {
      const baseV = outcomeToValue(state.outcome, decisionFaction, state.day, dayBonusCoef, { foxAliveByViewer: state.foxAliveByViewer, endgameBonusCoef })
      return {
        kind: 'terminal', path, state, node,
        isRoot: path.length === 0,
        immediateValue: applyNarrowBonusForLeaf(baseV, decisionFaction, state, invariants, narrowBonusCoef),
      }
    }
    if (!hasSeat(state.alive, decisionSeat)) {
      const dispatch = dispatchForPhase(state, decisionSeat, bundle)
      if (!dispatch) {
        return { kind: 'invalid', path, state, node, isRoot: path.length === 0, immediateValue: 0 }
      }
      return { kind: 'leaf_eval', path, state, node, dispatch, isRoot: path.length === 0 }
    }
    const dispatch = dispatchForPhase(state, decisionSeat, bundle)
    if (!dispatch) {
      // skip 連鎖: pseudo-action で child node に進む (sequential 経路と同じ)
      const tStep = BENCH_ENABLED ? performance.now() : 0
      const nextState = cloneSimState(state)
      stepPhase(nextState, defaultActionForPhase(state.phase))
      if (BENCH_ENABLED) benchEnd('step_phase', tStep)
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

    // ★ nightParallel mode: 敵 night phase は inline で sample + advance (ISMCTS 流 world-agnostic cache 適用)
    if (config.nightParallel && isNightPhase(state.phase) && !isOwnPhase(dispatch, decisionFaction)) {
      const tStep = BENCH_ENABLED ? performance.now() : 0
      const nextState = cloneSimState(state)
      sampleAndAdvanceEnemyNightPhase(nextState, bundle, invariants, config.rng, nightSampleCache)
      if (BENCH_ENABLED) benchEnd('step_phase', tStep)
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
      return { kind: 'pending_expand', path, state, node, dispatch, isRoot: path.length === 0 }
    }
    if (node.phase !== undefined && node.phase !== state.phase) {
      reportPhaseMismatch(node.phase, state.phase, node.edges)
    }
    const tSelect = BENCH_ENABLED ? performance.now() : 0
    const action = selectActionUCB(node, config.cPuct)
    if (BENCH_ENABLED) benchEnd('mcts_select', tSelect)
    if (action < 0) {
      return { kind: 'invalid', path, state, node, isRoot: path.length === 0, immediateValue: 0 }
    }
    const tStep = BENCH_ENABLED ? performance.now() : 0
    const nextState = cloneSimState(state)
    // ★ nightParallel + 自己 night phase: inline executeNightStep (ISMCTS 流 cache 適用)
    if (config.nightParallel && isNightPhase(state.phase) && isOwnPhase(dispatch, decisionFaction)) {
      executeNightStep(nextState, buildPhaseActionFor(state, action), decisionSeat, bundle, invariants, config.rng, nightSampleCache)
    } else {
      stepPhase(nextState, buildPhaseActionFor(state, action))
    }
    if (BENCH_ENABLED) benchEnd('step_phase', tStep)
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
 * forward 結果 (policy) を受け取り、edges の初期化のみ行う。
 * `expandWithDispatch` から forward 部分を除いた版で、batched MCTS で
 * forwardBatch の結果を使って expand する用。
 */
function expandEdgesFromPolicy(
  node: TreeNode,
  state: SimState,
  dispatch: DispatchResult,
  policy: Map<number, number>,
  excludedMask: number,
  isRoot: boolean,
): void {
  const legalRaw = legalActionIdsForPhase(state, dispatch.actorSeat)
  const seatBased = isSeatBasedPhase(state.phase)
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
    return
  }
  let providedSum = 0
  for (const [action, prior] of policy) {
    if (legal.has(action)) providedSum += prior
  }
  const uniform = 1 / legal.size
  for (const action of legal) {
    if (node.edges.has(action)) continue
    let prior: number
    if (providedSum > 0) {
      prior = (policy.get(action) ?? 0) / providedSum
    } else {
      prior = uniform
    }
    node.edges.set(action, { visits: 0, totalValue: 0, prior })
  }
  node.expanded = true
  node.phase = state.phase
}

/** PendingLeaf: collected leaves で保持する LeafInfo + 元 rolloutState */
type PendingLeaf = LeafInfo & { rolloutState: SimState }


/**
 * batched MCTS の本体。BATCH_INFER_SIZE > 1 のとき runMCTS から呼ばれる。
 *
 * 構造:
 *   1. Setup (overflow/empty 早期 return、root world sample、decision faction 確定)
 *   2. 初回 root expand + Dirichlet (sequential 経路と同じ条件で 1 回)
 *   3. Batched loop: BATCH_SIZE 個 descent → group by (Module, headName) → forwardBatch → backup
 */
function runBatchedMCTSImpl(
  rootSimState: SimState,
  decisionSeat: number,
  determinizer: Determinizer,
  bundle: ModuleBundle,
  invariants: RolloutInvariants,
  config: MCTSConfig,
  opts: { actionMode?: RootActionMode, excludedMask?: number },
  batchSize: number,
): MCTSResult {
  const tMctsStart = BENCH_ENABLED ? performance.now() : 0
  const actionMode = opts.actionMode ?? 'execute'
  const excludedMask = opts.excludedMask ?? 0

  if (determinizer.isOverflow()) {
    if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
    return { root: createTreeNode(), visits: new Map(), abortReason: 'determinizer_overflow' }
  }
  if (determinizer.size() === 0) {
    if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
    return { root: createTreeNode(), visits: new Map(), abortReason: 'no_consistent_world' }
  }
  const firstWorld = determinizer.sample(config.rng)
  if (!firstWorld) {
    if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
    return { root: createTreeNode(), visits: new Map(), abortReason: 'no_consistent_world' }
  }
  const decisionRole = firstWorld.roles[decisionSeat]
  const decisionFaction = factionForRole(decisionRole)
  if (!decisionFaction) {
    if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
    return { root: createTreeNode(), visits: new Map(), abortReason: 'unknown_decision_role' }
  }

  const targetPhase = phaseFromActionMode(actionMode)
  const roots = new Map<string, TreeNode>()

  const dayBonusCoef = config.dayBonusCoef ?? 0
  const endgameBonusCoef = config.endgameBonusCoef ?? 0
  const narrowBonusCoef = config.narrowBonusCoef ?? 0

  // 初回 root expand + Dirichlet (sequential と同じ条件で 1 回)
  {
    const rolloutState = makeRolloutState(rootSimState, firstWorld, actionMode)
    let root = roots.get(rolloutState.phase)
    if (!root) { root = createTreeNode(); roots.set(rolloutState.phase, root) }
    if (rolloutState.phase === targetPhase
      && rolloutState.phase !== 'terminal' && hasSeat(rolloutState.alive, decisionSeat)) {
      const tExpand = BENCH_ENABLED ? performance.now() : 0
      const value = expandWithDispatch(root, rolloutState, decisionSeat, bundle, invariants, excludedMask, true, decisionFaction, dayBonusCoef, endgameBonusCoef, narrowBonusCoef)
      if (BENCH_ENABLED) benchEnd('mcts_expand', tExpand)
      if (value !== null) applyRootDirichletNoise(root, config)
    }
  }

  // nightParallel の sample forward キャッシュ (per-MCTS-call)
  const nightSampleCache = config.nightParallel ? new NightSampleCache() : undefined

  // Batched loop
  let completed = 0
  while (completed < config.nRollouts) {
    const remaining = config.nRollouts - completed
    const thisBatch = Math.min(batchSize, remaining)
    const collected: PendingLeaf[] = []

    // Phase 1: descent (collect leaves)
    for (let b = 0; b < thisBatch; b++) {
      const world = determinizer.sample(config.rng)
      if (!world) break
      const rolloutState = makeRolloutState(rootSimState, world, actionMode)
      let root = roots.get(rolloutState.phase)
      if (!root) { root = createTreeNode(); roots.set(rolloutState.phase, root) }

      const leaf = descentToLeaf(root, rolloutState, decisionSeat, bundle, invariants, config, decisionFaction, nightSampleCache)
      applyVirtualLoss(leaf.path)

      if (leaf.kind === 'terminal' || leaf.kind === 'invalid') {
        const tBackup = BENCH_ENABLED ? performance.now() : 0
        backup(leaf.path, leaf.immediateValue ?? 0)
        if (BENCH_ENABLED) benchEnd('mcts_backup', tBackup)
        revertVirtualLoss(leaf.path)
        completed++
      } else {
        collected.push({ ...leaf, rolloutState })
      }
    }

    if (collected.length === 0) {
      if (completed >= config.nRollouts) break
      continue
    }

    // Phase 2: group by (Module, headName)
    const groupMap = new Map<SkollZeroModule, Map<HeadName, PendingLeaf[]>>()
    for (const leaf of collected) {
      const d = leaf.dispatch!
      let perModule = groupMap.get(d.module)
      if (!perModule) { perModule = new Map(); groupMap.set(d.module, perModule) }
      let arr = perModule.get(d.headName)
      if (!arr) { arr = []; perModule.set(d.headName, arr) }
      arr.push(leaf)
    }

    // Phase 3: forwardBatchAt per (Module, headName) group
    for (const [module, perHead] of groupMap) {
      for (const [headName, leaves] of perHead) {
        const tBatch = BENCH_ENABLED ? performance.now() : 0
        const states = leaves.map(l => l.state)
        const actorSeats = leaves.map(l => l.dispatch!.actorSeat)
        const actorRoles = leaves.map(l => l.dispatch!.actorRole)
        const outputs: NNOutput[] = module.forwardBatchAt
          ? module.forwardBatchAt(states, actorSeats, actorRoles, headName, invariants)
          : leaves.map((_l, i) => module.forwardAt(states[i], actorSeats[i], actorRoles[i], headName, invariants))
        if (BENCH_ENABLED) benchEnd('batch_forward', tBatch)

        // Phase 4: backup per leaf in group
        for (let i = 0; i < leaves.length; i++) {
          const leaf = leaves[i]
          const out = outputs[i]
          const baseV = outcomeDistToFactionValue(out.outcomeDist, decisionFaction, leaf.state.day, dayBonusCoef, { foxAliveByViewer: leaf.state.foxAliveByViewer, endgameBonusCoef })
          const value = applyNarrowBonusForLeaf(baseV, decisionFaction, leaf.state, invariants, narrowBonusCoef)
          if (leaf.kind === 'pending_expand') {
            const tExpand = BENCH_ENABLED ? performance.now() : 0
            expandEdgesFromPolicy(leaf.node, leaf.state, leaf.dispatch!, out.policy, leaf.isRoot ? excludedMask : 0, leaf.isRoot)
            if (BENCH_ENABLED) benchEnd('mcts_expand', tExpand)
          }
          const tBackup = BENCH_ENABLED ? performance.now() : 0
          backup(leaf.path, value)
          if (BENCH_ENABLED) benchEnd('mcts_backup', tBackup)
          revertVirtualLoss(leaf.path)
          completed++
        }
      }
    }
  }

  const finalRoot = roots.get(targetPhase) ?? createTreeNode()
  const result: MCTSResult = { root: finalRoot, visits: collectRootVisits(finalRoot), abortReason: null }
  if (BENCH_ENABLED) benchEnd('mcts_total', tMctsStart)
  return result
}
