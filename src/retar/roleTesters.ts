import type { CauseOfDeath, SeatStatus, VillageStatus, SystemRole, Seat, Day } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { Possibilities } from './possibilities.ts'
import { rolesByTrait, singleRoleBySeerResult, allKnownRoles, hasTrait } from './role-sets.ts'

const wolfRole = singleRoleBySeerResult('wolf')
const foxRoles = rolesByTrait('passive', 'die-when-divined')

type DeathChronicle = {
  add: Int8Array
  sub: Int8Array
}

export type AnalyzeContext = {
  possibilities: Possibilities
  needDivineAliveAtDay?: number
  hamstersKilledByDivine: { day: number, seat: Seat }[]
  hamstersMaxSurvivingDay: number
  requireOneOf: { seat: Seat, role: SystemRole }[][]
  deathChronicle: DeathChronicle
  /**
   * action:divine trait を持つ全 role の selected 席集合での最大生存日。
   * alive な席があれば Infinity. setup に複数の divine role がある場合 (seer + paparazzi 等)
   * は trait 単位での集約値となる。 needDivineAliveAtDay >= この値 で「狐呪殺日に占い能力者
   * が生きていたか」を集約的に判定する.
   */
  divineAliveMaxDay: number
  /**
   * action:divine trait を持つ全 role の selected 席による占いターゲットを日ごとに集約.
   * - trusted role (faction === 'village', 例: seer): 公開アサーション / forecast の対象を add
   * - untrusted role (faction !== 'village', 例: paparazzi): 判定を信用しないため 'unknown' を add
   * 狐呪殺日に対象が含まれる (または 'unknown' が含まれる) ことで「呪殺の説明可能」を集約判定する.
   */
  divineTargetsByDay: Map<Day, Set<Seat | 'unknown'>>
}

export type RoleTesterEnv = {
  vs: VillageStatus
  nightKillsByDay: Map<Day, Seat[]>
  totalLiarRoles: number
  knownFakeClaimCount: number
  lastHamsterMustDieAt?: number
  lastHamsterMustDiedBy?: CauseOfDeath
  dayCountFrom: number
  /** 占い師の初日占いルール: 'none'=初日占いなし, 'no-wolf'=白確定, 'all'=制限なし */
  seerFirstSeek?: 'none' | 'no-wolf' | 'all'
}

export type ContextSnapshot = {
  possArr: Uint16Array
  possSetup: Uint8Array
  hamstersMaxSurvivingDay: number
  needDivineAliveAtDay: number | undefined
  hamstersKilledByDivineLen: number
  requireOneOfLen: number
  deathChronicleAdd: Int8Array
  deathChronicleSub: Int8Array
  divineAliveMaxDay: number
  divineTargetsByDay: Map<Day, Set<Seat | 'unknown'>>
}

export function saveContext(ctx: AnalyzeContext): ContextSnapshot {
  // divineTargetsByDay は shallow clone (各 Set も clone)
  const clonedDivineTargets = new Map<Day, Set<Seat | 'unknown'>>()
  for (const [day, set] of ctx.divineTargetsByDay) {
    clonedDivineTargets.set(day, new Set(set))
  }
  return {
    possArr: new Uint16Array(ctx.possibilities.possibilities),
    possSetup: new Uint8Array(ctx.possibilities.setup),
    hamstersMaxSurvivingDay: ctx.hamstersMaxSurvivingDay,
    needDivineAliveAtDay: ctx.needDivineAliveAtDay,
    hamstersKilledByDivineLen: ctx.hamstersKilledByDivine.length,
    requireOneOfLen: ctx.requireOneOf.length,
    deathChronicleAdd: new Int8Array(ctx.deathChronicle.add),
    deathChronicleSub: new Int8Array(ctx.deathChronicle.sub),
    divineAliveMaxDay: ctx.divineAliveMaxDay,
    divineTargetsByDay: clonedDivineTargets,
  }
}

export function restoreContext(ctx: AnalyzeContext, s: ContextSnapshot): void {
  ctx.possibilities.possibilities.set(s.possArr)
  ctx.possibilities.setup.set(s.possSetup)
  ctx.hamstersMaxSurvivingDay = s.hamstersMaxSurvivingDay
  ctx.needDivineAliveAtDay = s.needDivineAliveAtDay
  ctx.hamstersKilledByDivine.length = s.hamstersKilledByDivineLen
  ctx.requireOneOf.length = s.requireOneOfLen
  ctx.deathChronicle.add.set(s.deathChronicleAdd)
  ctx.deathChronicle.sub.set(s.deathChronicleSub)
  ctx.divineAliveMaxDay = s.divineAliveMaxDay
  ctx.divineTargetsByDay.clear()
  for (const [day, set] of s.divineTargetsByDay) {
    ctx.divineTargetsByDay.set(day, new Set(set))
  }
}

function getStatus(env: RoleTesterEnv, seat: Seat): SeatStatus {
  return env.vs.statuses.get(seat)!
}

function denyRoleForOthers(env: RoleTesterEnv, context: AnalyzeContext, role: SystemRole, exclude: Set<Seat>): boolean {
  for ( const seat of env.vs.statuses.keys() ) {
    if ( exclude.has(seat) ) continue
    if ( !context.possibilities.denyRole(seat, role) ) return false
  }
  return true
}

// ============================================================================
// trait verifiers
//
// 各 verifier は「trait に対応する能力・性質」を検証する。
// testRole が role に紐付く traits を見て該当 verifier を順次呼び出す。
// 前提: selected の seat は testRole 側で既に fixRole 済み。
// ============================================================================

/** passive: attack-immune + die-when-divined (旧 testHamster 相当、狐の生存/呪殺制約) */
function verifyHamsterPassive(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[], role: SystemRole): boolean {
  let lastHamsterDiedAt = -Infinity
  let lastHamsterDiedBy: CauseOfDeath | undefined
  let livingHamsters = 0
  let divineKilledHamsterAt = -Infinity
  for ( const seat of selected ) {
    const self = getStatus(env, seat)
    const status = self
    if ( status.surviving ) {
      livingHamsters++
    }
    else {
      if ( status.causeOfDeath === 'night_kill' ) {
        context.deathChronicle.add[self.diedDay!] += 1

        context.hamstersKilledByDivine.push({ day: status.diedDay!, seat })
        if ( divineKilledHamsterAt < status.diedDay! ) {
          divineKilledHamsterAt = status.diedDay!
        }
      }
      if ( lastHamsterDiedAt < status.diedDay!) {
        lastHamsterDiedAt = status.diedDay!
        lastHamsterDiedBy = status.causeOfDeath
      }
    }
  }
  if ( 0 <= divineKilledHamsterAt ) {
    context.needDivineAliveAtDay = divineKilledHamsterAt
  }

  if ( env.lastHamsterMustDieAt != null ) {
    if (lastHamsterDiedAt !== env.lastHamsterMustDieAt ) return false
    if (lastHamsterDiedBy !== env.lastHamsterMustDiedBy ) {
      // 処刑フェーズの死亡: execution と cursed_by_executed_nekomata を同一視
      const isExecPhase = (c: CauseOfDeath) => c === 'execution' || c === 'cursed_by_executed_nekomata'
      if (!isExecPhase(lastHamsterDiedBy!) || !isExecPhase(env.lastHamsterMustDiedBy!)) return false
    }
  }
  for ( const seat of rest ) {
    context.possibilities.denyRole(seat, role)
    if ( !livingHamsters ) {
      const status = getStatus(env, seat)
      if ( status.surviving || lastHamsterDiedAt < status.diedDay! ) {
        // 後追い (reactive:follow-fox-death) trait を持つ役職を deny.
        for ( const followFox of allKnownRoles() ) {
          if ( hasTrait(followFox, 'reactive', 'follow-fox-death') ) {
            context.possibilities.denyRole(seat, followFox)
          }
        }
      }
    }
  }
  if ( livingHamsters ) {
    context.hamstersMaxSurvivingDay = Infinity
  }
  else {
    context.hamstersMaxSurvivingDay = lastHamsterDiedAt
  }
  return true
}

/** action:divine 持ち role の selected 席を context.divineTargetsByDay の指定日に追加. */
function addDivineTarget(context: AnalyzeContext, day: Day, target: Seat | 'unknown'): void {
  let set = context.divineTargetsByDay.get(day)
  if (!set) {
    set = new Set()
    context.divineTargetsByDay.set(day, set)
  }
  set.add(target)
}

/**
 * action: divine (旧 testSeer 相当、占い能力者の assertion 検証 + 狐呪殺).
 *
 * trusted (faction === 'village', 例: seer): 占い判定を信用し、 wolf-fix / fox 呪殺判定を実施.
 *   さらに対象を context.divineTargetsByDay に集約する.
 * untrusted (faction !== 'village', 例: paparazzi): 判定を信用しない. selected が active だった
 *   夜は context.divineTargetsByDay に 'unknown' を add するに留める.
 *
 * 「狐死日に占い能力者が生きていた + 対象が含まれる」の集約検証は finalize の checkDivineCoverage
 * に委譲する (複数 divine role の selected を横断するため).
 */
function verifyDivineAbility(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[], role: SystemRole): boolean {
  const seers = new Set<Seat>()
  const isTrusted = systemRoles.get(role)!.faction === 'village'

  for ( const seat of selected ) {
    seers.add(seat)
    const self = getStatus(env, seat)

    // 集約: selected の生存日を divineAliveMaxDay に Math.max で反映
    const selfMaxDay = self.surviving ? Infinity : self.diedDay!
    if (context.divineAliveMaxDay < selfMaxDay) {
      context.divineAliveMaxDay = selfMaxDay
    }

    const maxActiveDay = self.surviving ? env.vs.day - 1 : (self.causeOfDeath === 'night_kill' ? self.diedDay! : self.diedDay! - 1)
    // seerFirstSeek === 'none' のとき、初日夜(dayCountFrom)の占いをスキップ
    const firstSeerNight = (env.seerFirstSeek === 'none') ? env.dayCountFrom + 1 : env.dayCountFrom

    if (!isTrusted) {
      // untrusted (paparazzi 等): 判定を信用しない. active な夜全てに 'unknown' を集約.
      for (let d = firstSeerNight; d <= maxActiveDay; d++) {
        addDivineTarget(context, d, 'unknown')
      }
      continue
    }

    // ===== trusted (seer 等) =====
    // local seerTargets: 「この role の selected 席が day d に占った先」リスト
    const seerTargets: Map<Day, (Seat | 'unknown')[]> = new Map()

    // Populate seerTargets from day-keyed divination assertions (right-aligned by bridge)
    for (const [night, { target }] of self.assertions) {
      if (night < 0) continue
      seerTargets.set(night, [...(seerTargets.get(night) || []), target])
    }
    // If seer died at night, they acted that night but result is unreported
    if (!self.surviving && self.causeOfDeath === 'night_kill') {
      const forecastTarget = self.forecasts.get(self.diedDay!)
      seerTargets.set(self.diedDay!, [...(seerTargets.get(self.diedDay!) || []), forecastTarget ?? 'unknown'])
    }
    // Add 'unknown' only for genuinely unreported nights beyond known assertions
    for (let d = firstSeerNight; d <= maxActiveDay; d++) {
      if (!seerTargets.has(d)) {
        const forecastTarget = self.forecasts.get(d)
        seerTargets.set(d, [forecastTarget ?? 'unknown'])
      }
    }
    for (const [assertionNight, { target: targetSeat, species }] of self.assertions) {
      // seerFirstSeek === 'no-wolf': 初日夜の占い結果は白確定（狼判定は矛盾）
      if (env.seerFirstSeek === 'no-wolf' && assertionNight === env.dayCountFrom && species === 'wolf') {
        return false
      }
      if ( species === 'wolf' ) {
        // 占い結果が wolf → 対象は seerResult='wolf' な役職に固定 (現状は werewolf 1 種のみ).
        if ( ! context.possibilities.fixRole(targetSeat, wolfRole) ) {
          return false
        }
        const targetStatus = getStatus(env, targetSeat)
        if ( !targetStatus.surviving && targetStatus.causeOfDeath === 'night_kill' ) {
          const nightKillsAtDay = env.nightKillsByDay.get(targetStatus.diedDay!)
          if ( nightKillsAtDay && nightKillsAtDay.length <= 1 ) {
            return false
          }
        }
      }
      // 占い呪殺対象判定: passive:die-when-divined trait を持つ役職 (現状は werehamster 1 種).
      else if ( foxRoles.some(r => context.possibilities.isActualRole(targetSeat, r)) ) {
        const targetStatus = getStatus(env, targetSeat)
        if ( targetStatus.surviving ) return false
        // 占い師がN夜に狐を占った場合、狐はN夜に呪殺される。死亡日が異なれば矛盾。
        if ( assertionNight >= 0 && targetStatus.diedDay !== assertionNight ) return false
        const targetsOnDeathDay = seerTargets.get(targetStatus.diedDay!) || []
        if ( !targetsOnDeathDay.includes(targetSeat) && !targetsOnDeathDay.includes('unknown') ) return false
      }
      else {
        if ( ! context.possibilities.markAsHuman(targetSeat) ) return false
      }
    }
    // Forecast targets with unreported results: if alive, can't be werehamster (呪殺 would have killed them)
    for (const [night, forecastTarget] of self.forecasts) {
      if (night < env.dayCountFrom || night > maxActiveDay) continue
      if (self.assertions.has(night)) continue
      if ( foxRoles.some(r => context.possibilities.isActualRole(forecastTarget, r)) ) {
        const targetStatus = getStatus(env, forecastTarget)
        if ( targetStatus.surviving ) return false
        if ( targetStatus.diedDay !== night ) return false
        const targetsOnDeathDay = seerTargets.get(targetStatus.diedDay!) || []
        if ( !targetsOnDeathDay.includes(forecastTarget) && !targetsOnDeathDay.includes('unknown') ) return false
      }
    }

    // 集約: trusted role の local seerTargets を context.divineTargetsByDay に push
    for (const [d, targets] of seerTargets) {
      for (const t of targets) {
        addDivineTarget(context, d, t)
      }
    }
  }

  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming ) {
      if ( !context.possibilities.denyRole(seat, role) ) {
        return false
      }
      continue
    }
    // claim 持ちの rest 席
    if (isTrusted) {
      // trusted (seer): 同 role CO 席は偽者扱い (liar 役職に絞る)
      if (!context.possibilities.markAsLiar(seat)) {
        return false
      }
    } else {
      // untrusted (paparazzi 等): seer 騙りなので rest 内の seer CO は真者 (seer) の可能性が残る → 触らない.
      // ただし claimingRole が自分 (paparazzi) と同じ場合は偽 paparazzi CO として markAsLiar.
      if (status.claimingRole === role) {
        if (!context.possibilities.markAsLiar(seat)) {
          return false
        }
      }
    }
  }

  if ( !denyRoleForOthers(env, context, role, seers) ) return false
  return true
}

/** auto-info: execution-species (旧 testMedium 相当、霊媒結果の検証) */
function verifyMediumshipAbility(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[], role: SystemRole): boolean {
  const mediums = new Set<Seat>()
  for ( const seat of selected ) {
    mediums.add(seat)
    const self = getStatus(env, seat)

    for (const [, { target: targetSeat, species }] of self.assertions) {
      if ( species === 'wolf' ) {
        if ( ! context.possibilities.fixRole(targetSeat, wolfRole) ) {
          return false
        }
      }
      else {
        // 霊媒結果 ○ は mediumResult: 'human' 集合 (werewolf と kogitsune 以外) に絞る.
        // 占い ○ の markAsHuman (seerResult: 'human') と違って kogitsune は除外される.
        if ( ! context.possibilities.markAsMediumHuman(targetSeat) ) {
          return false
        }
      }
    }
  }
  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming || status.claimingRole !== role ) {
      if (! context.possibilities.denyRole(seat, role) ) {
        return false
      }
      continue
    }
    else {
      if ( ! context.possibilities.markAsLiar(seat) ) {
        return false
      }
    }
  }
  if ( !denyRoleForOthers(env, context, role, mediums) ) return false
  return true
}

/** action: guard (旧 testBodyguard 相当、護衛能力者の rest 処理のみ — assertion 検証なし) */
function verifyGuardAbility(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[], role: SystemRole): boolean {
  const bodyguards = new Set<Seat>()
  for ( const seat of selected ) {
    bodyguards.add(seat)
  }

  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming || status.claimingRole !== role ) {
      if (!context.possibilities.denyRole(seat, role)) {
        return false
      }
      continue
    }
    else {
      if (!context.possibilities.markAsLiar(seat)) {
        return false
      }
    }
  }
  if ( !denyRoleForOthers(env, context, role, bodyguards) ) return false
  return true
}

/** knowledge: know-masons (旧 testMason 相当、共有相方の固定) */
function verifyMasonBond(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[], role: SystemRole): boolean {
  const masons = new Set<Seat>()
  for ( const seat of selected ) {
    masons.add(seat)
    const self = getStatus(env, seat)

    for (const [, { target: targetSeat, species }] of self.assertions) {
      if ( species === 'wolf' ) {
        // 仕様です。共有は相方に人間とアサーションします。
        return false
      }
      else {
        if ( ! context.possibilities.fixRole(targetSeat, role) ) {
          return false
        }
        masons.add(targetSeat)
      }
    }
  }
  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming || status.claimingRole !== role ) continue
    if ( ! context.possibilities.markAsLiar(seat) ) {
      return false
    }
  }
  if ( !denyRoleForOthers(env, context, role, masons) ) return false
  return true
}

/** reactive: curse-on-executed + curse-on-killed (旧 testNekomata 相当、道連れ検証) */
function verifyNekomataCurse(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[], role: SystemRole): boolean {
  const nekomatas = new Set<Seat>()
  const possibleCursed: Seat[] = []
  for ( const seat of selected ) {
    nekomatas.add(seat)
    const self = getStatus(env, seat)
    if ( !self.surviving ) {
      if ( self.causeOfDeath === 'night_kill' ) {
        context.deathChronicle.add[self.diedDay!] += 1
      }
      let ok = false
      for ( const [targetSeat, targetStatus] of env.vs.statuses.entries() ) {
        if ( targetStatus.surviving ) continue
        if (targetStatus.diedDay !== self.diedDay) continue
        if ( targetStatus.causeOfDeath === 'execution' ) continue
        if ( targetStatus.causeOfDeath === 'follow_executed_hamster' || targetStatus.causeOfDeath === 'follow_killed_hamster' ) continue
        if (targetSeat === seat) continue
        // 別の死体がある
        if ( self.causeOfDeath === 'execution' ) {
          if ( targetStatus.causeOfDeath === 'cursed_by_executed_nekomata' ) {
            ok = true
            break
          }
        }
        else {
          ok = true
          if ( targetStatus.causeOfDeath === 'cursed_by_killed_nekomata' ) {
            if ( ! context.possibilities.fixRole(targetSeat, wolfRole) ) {
              return false
            }
          }
          possibleCursed.push(targetSeat)
        }
      }
      if ( !ok ) return false
    }
  }
  if ( possibleCursed.length ) {
    context.requireOneOf.push(
      possibleCursed.map(targetSeat => ({ seat: targetSeat, role: wolfRole as SystemRole }))
    )
  }

  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming || status.claimingRole !== role ) {
      if ( !context.possibilities.denyRole(seat, role) ) {
        return false
      }
      continue
    }
    else {
      if ( ! context.possibilities.markAsLiar(seat) ) {
        return false
      }
    }
  }
  if ( !denyRoleForOthers(env, context, role, nekomatas) ) return false
  return true
}

// ============================================================================
// testRole: trait ベース dispatcher
// 新役職は systemRoles の traits を埋めるだけで自動的にここから対応 verifier に分配される。
// ============================================================================

export function testRole(env: RoleTesterEnv, context: AnalyzeContext, role: SystemRole, selected: Seat[], rest: Seat[]): boolean {
  // 1. selected を role に固定
  for ( const seat of selected ) {
    if ( !context.possibilities.fixRole(seat, role) ) return false
  }

  // 2. role の traits に応じた verifier を順次呼ぶ
  const traits = systemRoles.get(role)?.traits ?? []

  if (traits.some(t => t.kind === 'passive' && (t.sub === 'attack-immune' || t.sub === 'die-when-divined'))) {
    if (!verifyHamsterPassive(env, context, selected, rest, role)) return false
  }
  if (traits.some(t => t.kind === 'action' && t.sub === 'divine')) {
    if (!verifyDivineAbility(env, context, selected, rest, role)) return false
  }
  if (traits.some(t => t.kind === 'auto-info' && t.sub === 'execution-species')) {
    if (!verifyMediumshipAbility(env, context, selected, rest, role)) return false
  }
  if (traits.some(t => t.kind === 'action' && t.sub === 'guard')) {
    if (!verifyGuardAbility(env, context, selected, rest, role)) return false
  }
  if (traits.some(t => t.kind === 'knowledge' && t.sub === 'know-masons')) {
    if (!verifyMasonBond(env, context, selected, rest, role)) return false
  }
  if (traits.some(t => t.kind === 'reactive' && (t.sub === 'curse-on-executed' || t.sub === 'curse-on-killed'))) {
    if (!verifyNekomataCurse(env, context, selected, rest, role)) return false
  }

  return true
}
