import { applyExecution, applyFollowDeaths, checkOutcome, simulateNight } from '../../hati/simulate.ts'
import { popCount32, seatsFromMask } from '../../hati/types.ts'
import { RoleBitIndex } from '../../retar/possibilities.ts'
import type { World } from '../../hati/types.ts'
import type { SimState, Phase, FakeDivineColor, DivineColor } from './world-state.ts'

/**
 * 1 phase 分の意思決定 action。phase ごとに必要な情報だけを持つ
 * discriminated union。MCTS 側は state.phase を見て対応する type の
 * action を組み立てて stepPhase に渡す。
 *
 * - morning: 偽 seer CO 済の各偽占い師ごとに「target + color」を報告。複数 CO 者がいれば cartesian
 * - claim_true: 真役職者の CO/潜伏 (2 択)
 * - claim_fake: 狼/狂の偽 CO/見送り (skip + 各 claimer 候補)
 * - execute: day の処刑先 (集団意思決定として 1 seat)
 * - attack: 狼の噛み先 (1 seat)
 * - divine: 真 seer の占い先 (1 seat)
 * - guard: 真 bg の護衛先 (1 seat、null = 無護衛)
 */
export type PhaseAction =
  | { type: 'morning', reports: Array<{ seerSeat: number, target: number, color: FakeDivineColor }> }
  | { type: 'claim_true', willClaim: boolean }
  | { type: 'claim_fake', willClaim: false }
  | { type: 'claim_fake', willClaim: true, claimerSeat: number }
  | { type: 'execute', target: number }
  | { type: 'attack', target: number }
  | { type: 'divine', target: number }
  | { type: 'guard', target: number }

const MASON_ROLE_ID = RoleBitIndex.mason

/** 最大 seat 番号 (14 人村、seat 1..14)。target の range check に使う */
const MAX_SEAT = 14

/**
 * 不正な action.target が来た時の警告 (panic を防ぐための defensive guard)。
 * 上限を超えたら抑制する (大量出力回避)。
 */
let invalidTargetWarnCount = 0
const INVALID_TARGET_WARN_LIMIT = 5
function warnInvalidTarget(phase: string, target: number, context = ''): void {
  if (invalidTargetWarnCount < INVALID_TARGET_WARN_LIMIT) {
    console.error(`[stepPhase] invalid target out of seat range: phase=${phase} target=${target}${context ? ' ' + context : ''}`)
    invalidTargetWarnCount++
    if (invalidTargetWarnCount === INVALID_TARGET_WARN_LIMIT) {
      console.error(`[stepPhase] further invalid target warnings suppressed (limit=${INVALID_TARGET_WARN_LIMIT})`)
    }
  }
}
const FANATIC_ROLE_ID = RoleBitIndex.fanatic

/** roles 配列から指定 role の seat ビットマスクを構築 (mason / fanatic は World に直接 mask が無い) */
function maskOfRoleId(world: World, roleId: number): number {
  let mask = 0
  for (let s = 1; s < world.roleIds.length; s++) {
    if (world.roleIds[s] === roleId) mask |= (1 << s)
  }
  return mask
}

/** その phase の「真役職」生存マスクを返す */
function trueRoleMask(world: World, phase: Phase, alive: number): number {
  switch (phase) {
    case 'claim_seer_true': return world.seerMask & alive
    case 'claim_medium_true': return world.mediumMask & alive
    case 'claim_bg_true': return world.bodyguardSeat >= 0 && (alive & (1 << world.bodyguardSeat)) ? (1 << world.bodyguardSeat) : 0
    case 'claim_nekomata_true': return world.nekomataMask & alive
    case 'claim_mason': return maskOfRoleId(world, MASON_ROLE_ID) & alive
    default: return 0
  }
}

/** wolf + fanatic の生存マスク (偽 CO の actor 候補) */
function fakeActorMask(world: World, alive: number): number {
  return (world.wolfMask | maskOfRoleId(world, FANATIC_ROLE_ID)) & alive
}

/** その phase の偽 CO 対象 SystemRole 名 (claim を state.claims に書くため) */
function fakeClaimRole(phase: Phase): 'seer' | 'medium' | 'bodyguard' | 'nekomata' | null {
  switch (phase) {
    case 'claim_seer_fake': return 'seer'
    case 'claim_medium_fake': return 'medium'
    case 'claim_bg_fake': return 'bodyguard'
    case 'claim_nekomata_fake': return 'nekomata'
    default: return null
  }
}

/** その phase の真 CO 対象 SystemRole 名 */
function trueClaimRole(phase: Phase): 'seer' | 'medium' | 'bodyguard' | 'nekomata' | 'mason' | null {
  switch (phase) {
    case 'claim_seer_true': return 'seer'
    case 'claim_medium_true': return 'medium'
    case 'claim_bg_true': return 'bodyguard'
    case 'claim_nekomata_true': return 'nekomata'
    case 'claim_mason': return 'mason'
    default: return null
  }
}

/**
 * phase が skip 条件を満たすか判定。skip は世界状態と CO 履歴から決まる。
 *
 * - morning: 偽 seer CO 済の actor が 0 → skip
 * - claim_*_true: 真役職の未 CO 生存席が 0 → skip
 * - claim_*_fake: 該当役職の偽 CO 既出 OR 未 CO の生存 wolf/fanatic が 0 → skip
 * - day / night_attack / night_divine / night_guard / terminal: skip しない
 *
 * 注意: night_attack は狼全滅で skip 候補になりうるが、その状態は前の day の
 * outcome 判定で既に terminal になっているはずなので発生しない前提。安全側で
 * skip も認める。night_divine は真 seer 全員死亡で skip。
 */
export function shouldSkipPhase(state: SimState): boolean {
  const { world, alive, phase, claims } = state
  switch (phase) {
    case 'morning':
      // Stage 3: morningPending が空なら skip。populating は stepPhase の night_guard 終端 +
      // テスト等が enterMorningPhase で行う
      return state.morningPending.length === 0
    case 'claim_seer_true':
    case 'claim_medium_true':
    case 'claim_bg_true':
    case 'claim_nekomata_true':
    case 'claim_mason': {
      const truthMask = trueRoleMask(world, phase, alive)
      if (truthMask === 0) return true
      let unclaimed = truthMask
      for (const seat of claims.keys()) unclaimed &= ~(1 << seat)
      return unclaimed === 0
    }
    case 'claim_seer_fake':
    case 'claim_medium_fake':
    case 'claim_bg_fake':
    case 'claim_nekomata_fake': {
      const role = fakeClaimRole(phase)!
      // 既偽 CO 有なら skip (Stage 1 単純化: 同役職の重複偽 CO は扱わない)
      for (const entry of claims.values()) {
        if (entry.role === role && entry.isFake) return true
      }
      // 未 CO の生存 wolf/fanatic が 0 → skip
      let unclaimedActors = fakeActorMask(world, alive)
      for (const seat of claims.keys()) unclaimedActors &= ~(1 << seat)
      return unclaimedActors === 0
    }
    case 'night_attack':
      return (world.wolfMask & alive) === 0
    case 'night_divine':
      return (world.seerMask & alive) === 0
    case 'day':
    case 'night_guard':
    case 'terminal':
      return false
  }
}

/** phase の物理的な次 phase (skip 判定なし) */
function rawNextPhase(phase: Phase): Phase {
  switch (phase) {
    case 'morning': return 'claim_seer_true'
    case 'claim_seer_true': return 'claim_medium_true'
    case 'claim_medium_true': return 'claim_bg_true'
    case 'claim_bg_true': return 'claim_nekomata_true'
    case 'claim_nekomata_true': return 'claim_mason'
    case 'claim_mason': return 'claim_seer_fake'
    case 'claim_seer_fake': return 'claim_medium_fake'
    case 'claim_medium_fake': return 'claim_bg_fake'
    case 'claim_bg_fake': return 'claim_nekomata_fake'
    case 'claim_nekomata_fake': return 'day'
    case 'day': return 'night_attack'
    case 'night_attack': return 'night_divine'
    case 'night_divine': return 'night_guard'
    case 'night_guard': return 'morning' // simulateNight 後に翌 morning へ
    case 'terminal': return 'terminal'
  }
}

/** skip ロジックを再帰的に適用し、最初に「skip しない」phase まで進める */
export function advancePhase(state: SimState): void {
  while (state.phase !== 'terminal' && shouldSkipPhase(state)) {
    state.phase = rawNextPhase(state.phase)
  }
}

/**
 * 1 phase 分の action を適用し、次 phase に進める。skip 連鎖もここで処理する。
 *
 * - terminal なら no-op
 * - phase と action.type の不一致は throw (caller の責任)
 * - in-place mutate
 */
export function stepPhase(state: SimState, action: PhaseAction): SimState {
  if (state.phase === 'terminal') return state

  switch (state.phase) {
    case 'morning': {
      assertActionType(action, 'morning')
      // Stage 3: 1 step あたり 1 actor 分の report を処理。morningPending FIFO から消費。
      for (const r of action.reports) {
        if (r.target < 1 || r.target > MAX_SEAT) {
          warnInvalidTarget('morning', r.target, `seerSeat=${r.seerSeat}`)
          continue
        }
        const list = state.fakeDivineHistory.get(r.seerSeat) ?? []
        list.push({ day: state.day, target: r.target, color: r.color })
        state.fakeDivineHistory.set(r.seerSeat, list)
        const idx = state.morningPending.indexOf(r.seerSeat)
        if (idx >= 0) state.morningPending.splice(idx, 1)
      }
      // 残 actor がいれば morning に留まる (advance しない)
      if (state.morningPending.length > 0) return state
      break
    }
    case 'claim_seer_true':
    case 'claim_medium_true':
    case 'claim_bg_true':
    case 'claim_nekomata_true':
    case 'claim_mason': {
      assertActionType(action, 'claim_true')
      if (action.willClaim) {
        const role = trueClaimRole(state.phase)!
        const truthMask = trueRoleMask(state.world, state.phase, state.alive)
        let unclaimed = truthMask
        for (const seat of state.claims.keys()) unclaimed &= ~(1 << seat)
        // Stage 1 暫定: 未 CO の真役職席のうち最低位 seat を actor とする。
        // 実際の actor 選択 (複数同一役職時) は Stage 3 で MCTS が扱う。
        if (unclaimed !== 0) {
          const lowBit = unclaimed & (-unclaimed)
          const actorSeat = 31 - Math.clz32(lowBit)
          state.claims.set(actorSeat, { role, isFake: false })
        }
      }
      break
    }
    case 'claim_seer_fake':
    case 'claim_medium_fake':
    case 'claim_bg_fake':
    case 'claim_nekomata_fake': {
      assertActionType(action, 'claim_fake')
      if (action.willClaim) {
        const role = fakeClaimRole(state.phase)!
        state.claims.set(action.claimerSeat, { role, isFake: true })
      }
      break
    }
    case 'day': {
      assertActionType(action, 'execute')
      if (action.target >= 1 && action.target <= MAX_SEAT) {
        const beforeAlive = state.alive
        state.alive = applyExecution(state.alive, action.target)
        state.deathLog.push({ day: state.day, seat: action.target, cause: 'execute' })
        state.alive = applyFollowDeaths(state.alive, state.world)
        // applyFollowDeaths で追加死亡した seat (immoralist の後追い等) を log
        const followMask = beforeAlive & ~state.alive & ~(1 << action.target)
        for (const seat of seatsFromMask(followMask)) {
          state.deathLog.push({ day: state.day, seat, cause: 'follow' })
        }
      } else if (action.target >= 0) {
        warnInvalidTarget('day', action.target)
      }
      const outcome = checkOutcome(state.world, state.alive)
      if (outcome !== 'ongoing') {
        state.outcome = outcome
        state.phase = 'terminal'
        return state
      }
      break
    }
    case 'night_attack':
      assertActionType(action, 'attack')
      if (action.target >= 1 && action.target <= MAX_SEAT) {
        state.pendingAttack = action.target
      } else {
        if (action.target >= 0) warnInvalidTarget('night_attack', action.target)
        state.pendingAttack = null
      }
      break
    case 'night_divine':
      assertActionType(action, 'divine')
      if (action.target >= 1 && action.target <= MAX_SEAT) {
        state.pendingDivineTargets.push(action.target)
      } else if (action.target >= 0) {
        warnInvalidTarget('night_divine', action.target)
      }
      break
    case 'night_guard': {
      assertActionType(action, 'guard')
      if (action.target >= 1 && action.target <= MAX_SEAT) {
        state.pendingGuard = action.target
      } else {
        if (action.target >= 0) warnInvalidTarget('night_guard', action.target)
        state.pendingGuard = null
      }
      // 護衛履歴を log (真 bg 視点の私的情報)
      if (state.pendingGuard !== null) {
        state.guardLog.push({ day: state.day, target: state.pendingGuard })
      }
      // 夜 3 行動を一括解決
      const wolfBiteTarget = state.pendingAttack ?? -1
      const beforeAlive = state.alive
      const aliveSeers = state.world.seerMask & beforeAlive
      const result = simulateNight(
        state.world,
        state.alive,
        wolfBiteTarget,
        state.pendingGuard,
        state.pendingDivineTargets,
      )
      state.alive = result.nextAlive
      state.alive = applyFollowDeaths(state.alive, state.world)

      // 死亡 log: 死因を判定
      // - 呪殺: 占い対象の狐 (pendingDivineTargets に含まれる werehamster)
      // - 噛み: wolfBiteTarget (護衛成功なら除外)
      // - 道連れ: 噛まれた猫又に対する随伴狼 (現実装は 1 wolf のみ反撃モデル)
      // - 後追い: その他 (immoralist の hamster 死亡後追い等)
      const deadMask = beforeAlive & ~state.alive
      const cursedTargets = new Set<number>()
      for (const t of state.pendingDivineTargets) {
        if (t >= 0 && state.world.roleIds[t] === RoleBitIndex.werehamster && (deadMask & (1 << t))) {
          cursedTargets.add(t)
        }
      }
      const guardSucceeded = state.pendingGuard !== null
        && state.pendingGuard === wolfBiteTarget
        && state.world.bodyguardSeat >= 0
        && (beforeAlive & (1 << state.world.bodyguardSeat)) !== 0
      for (const seat of seatsFromMask(deadMask)) {
        let cause: 'execute' | 'night_kill' | 'follow' | 'curse' | 'nekomata_revenge'
        if (cursedTargets.has(seat)) cause = 'curse'
        else if (seat === wolfBiteTarget && !guardSucceeded) cause = 'night_kill'
        else if (state.world.roleIds[seat] === RoleBitIndex.werewolf
          && wolfBiteTarget >= 0
          && state.world.roleIds[wolfBiteTarget] === RoleBitIndex.nekomata) cause = 'nekomata_revenge'
        else cause = 'follow'
        state.deathLog.push({ day: state.day, seat, cause })
      }

      // 真占い結果の log: 生存中の seer のみが結果を観測
      // simulateNight と同じ順序 (seerMask の low-bit 順) で pendingDivineTargets を割り当て
      let seerIdx = 0
      let scan = aliveSeers
      while (scan !== 0) {
        const bit = scan & (-scan)
        const seerSeat = 31 - Math.clz32(bit)
        scan ^= bit
        const target = state.pendingDivineTargets[seerIdx++]
        if (target !== undefined && target >= 0 && (state.alive & (1 << seerSeat))) {
          const color: DivineColor = state.world.roleIds[target] === RoleBitIndex.werewolf ? 'wolf' : 'human'
          const log = state.divineLog.get(seerSeat) ?? []
          log.push({ day: state.day, target, color })
          state.divineLog.set(seerSeat, log)
        }
      }

      const outcome = checkOutcome(state.world, state.alive)
      if (outcome !== 'ongoing') {
        state.outcome = outcome
        state.phase = 'terminal'
        return state
      }
      // 翌日へ。pending をクリア + 翌 morning の queue を populate
      state.day += 1
      state.pendingAttack = null
      state.pendingGuard = null
      state.pendingDivineTargets = []
      enterMorningPhase(state)
      break
    }
  }

  state.phase = rawNextPhase(state.phase)
  advancePhase(state)
  return state
}

function assertActionType<T extends PhaseAction['type']>(
  action: PhaseAction,
  expected: T,
): asserts action is Extract<PhaseAction, { type: T }> {
  if (action.type !== expected) {
    throw new Error(`stepPhase: expected action type ${expected}, got ${action.type}`)
  }
}

// --- legal action 列挙 (D2 採用 Z による Stage 1 必須機能) ---

/** day phase の legal execute actions。生存席 (-1 = skip) */
export function legalExecuteActions(state: SimState): PhaseAction[] {
  const out: PhaseAction[] = []
  for (const seat of seatsFromMask(state.alive)) {
    out.push({ type: 'execute', target: seat })
  }
  return out
}

/** night_attack phase の legal attack actions。狼が噛める seat 一覧 */
export function legalAttackActions(state: SimState): PhaseAction[] {
  const out: PhaseAction[] = []
  const wolves = state.world.wolfMask & state.alive
  if (wolves === 0) return out
  let targets = state.alive & ~state.world.wolfMask
  // LW (狼 1 匹) は猫又を噛むと道連れ全滅で負けるため除外
  if (popCount32(wolves) === 1) {
    let scan = targets
    while (scan !== 0) {
      const bit = scan & (-scan)
      const seat = 31 - Math.clz32(bit)
      if (state.world.roleIds[seat] === RoleBitIndex.nekomata) targets ^= bit
      scan ^= bit
    }
  }
  for (const seat of seatsFromMask(targets)) {
    out.push({ type: 'attack', target: seat })
  }
  return out
}

/** night_divine phase の legal divine actions。真 seer の占い先一覧 */
export function legalDivineActions(state: SimState): PhaseAction[] {
  const out: PhaseAction[] = []
  if ((state.world.seerMask & state.alive) === 0) return out
  for (const seat of seatsFromMask(state.alive)) {
    out.push({ type: 'divine', target: seat })
  }
  return out
}

/** night_guard phase の legal guard actions。真 bg の護衛先一覧 (-1 = 無護衛) */
export function legalGuardActions(state: SimState): PhaseAction[] {
  const out: PhaseAction[] = []
  const bg = state.world.bodyguardSeat
  if (bg < 0 || (state.alive & (1 << bg)) === 0) {
    // bg 不在 → 護衛先選択肢は -1 (無護衛) 1 つのみ
    out.push({ type: 'guard', target: -1 })
    return out
  }
  // bg 自分自身は護衛できない (他席のみ)
  for (const seat of seatsFromMask(state.alive & ~(1 << bg))) {
    out.push({ type: 'guard', target: seat })
  }
  out.push({ type: 'guard', target: -1 })
  return out
}

/**
 * claim_*_true phase の legal claim_true actions。CO/潜伏の 2 択。
 * skip 条件を満たす phase で呼ばれた場合は空配列を返す。
 */
export function legalClaimTrueActions(state: SimState): PhaseAction[] {
  if (shouldSkipPhase(state)) return []
  return [
    { type: 'claim_true', willClaim: false },
    { type: 'claim_true', willClaim: true },
  ]
}

/**
 * claim_*_fake phase の legal claim_fake actions。skip + 各 claimer 候補。
 * skip 条件を満たす phase で呼ばれた場合は空配列を返す。
 */
export function legalClaimFakeActions(state: SimState): PhaseAction[] {
  if (shouldSkipPhase(state)) return []
  const out: PhaseAction[] = [{ type: 'claim_fake', willClaim: false }]
  let unclaimed = fakeActorMask(state.world, state.alive)
  for (const seat of state.claims.keys()) unclaimed &= ~(1 << seat)
  for (const seat of seatsFromMask(unclaimed)) {
    out.push({ type: 'claim_fake', willClaim: true, claimerSeat: seat })
  }
  return out
}

/**
 * morning phase の legal morning actions (Stage 3: per-actor)。
 *
 * morningPending FIFO の先頭 actor 1 人分について、alive seats × {human, wolf} =
 * 28 actions を返す (各 action は単一 reports 要素を持つ)。
 *
 * morningPending 空 (skip 条件) では空配列を返す。
 */
export function legalMorningActions(state: SimState): PhaseAction[] {
  if (state.morningPending.length === 0) return []
  const actor = state.morningPending[0]
  const colors: FakeDivineColor[] = ['human', 'wolf']
  const out: PhaseAction[] = []
  for (const t of seatsFromMask(state.alive)) {
    for (const c of colors) {
      out.push({ type: 'morning', reports: [{ seerSeat: actor, target: t, color: c }] })
    }
  }
  return out
}

/**
 * morning phase 開始時に morningPending を populate する。
 *
 * 偽 seer CO 済 (claims に role='seer', isFake=true) かつ生存中の actor を
 * claims の挿入順 (= CO した順) で queue に積む。
 *
 * 呼び出しタイミング:
 * - stepPhase の night_guard 終端 (翌 morning へ遷移する直前)
 * - 初期 SimState で phase='morning' から開始したい場合 (主にテスト)
 */
export function enterMorningPhase(state: SimState): void {
  state.morningPending = []
  for (const [seat, entry] of state.claims) {
    if (entry.role === 'seer' && entry.isFake && (state.alive & (1 << seat)) !== 0) {
      state.morningPending.push(seat)
    }
  }
}
