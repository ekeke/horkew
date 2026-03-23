import type { CauseOfDeath, SeatStatus, VillageStatus, SystemRole, Seat, Day } from '../types/index.ts'
import type { Possibilities } from './possibilities.ts'

type DeathCounts = {
  add: number,
  sub: number
}

export type AnalyzeContext = {
  possibilities: Possibilities
  needSeerAtDay?: number
  hamstersKilledBySeer: { day: number, seat: Seat }[]
  hamstersMaxSurvivingDay: number
  requireOneOf: { seat: Seat, role: SystemRole }[][]
  deathChronicle: Map<Day, DeathCounts>
}

export type RoleTesterEnv = {
  vs: VillageStatus
  nightKillsByDay: Map<Day, Seat[]>
  totalLiarRoles: number
  knownFakeClaimCount: number
  lastHamsterMustDieAt?: number
  lastHamsterMustDiedBy?: CauseOfDeath
  dayCountFrom: number
}

export function cloneContext(context: AnalyzeContext): AnalyzeContext {
  return {
    hamstersKilledBySeer: context.hamstersKilledBySeer.map(x => ({ ...x })),
    hamstersMaxSurvivingDay: context.hamstersMaxSurvivingDay,
    requireOneOf: context.requireOneOf.map(arr => arr.map(x => ({ ...x }))),
    deathChronicle: new Map(Array.from(context.deathChronicle.entries(), ([k, v]) => [k, { ...v }])),
    possibilities: context.possibilities.clone(),
  }
}

export type ContextSnapshot = {
  possArr: Uint16Array
  possSetup: Uint8Array
  hamstersMaxSurvivingDay: number
  needSeerAtDay: number | undefined
  hamstersKilledBySeerLen: number
  requireOneOfLen: number
  deathChronicleEntries: [number, number, number][]
}

export function saveContext(ctx: AnalyzeContext): ContextSnapshot {
  const dc: [number, number, number][] = []
  for (const [day, counts] of ctx.deathChronicle) {
    dc.push([day, counts.add, counts.sub])
  }
  return {
    possArr: new Uint16Array(ctx.possibilities.possibilities),
    possSetup: new Uint8Array(ctx.possibilities.setup),
    hamstersMaxSurvivingDay: ctx.hamstersMaxSurvivingDay,
    needSeerAtDay: ctx.needSeerAtDay,
    hamstersKilledBySeerLen: ctx.hamstersKilledBySeer.length,
    requireOneOfLen: ctx.requireOneOf.length,
    deathChronicleEntries: dc,
  }
}

export function restoreContext(ctx: AnalyzeContext, s: ContextSnapshot): void {
  ctx.possibilities.possibilities.set(s.possArr)
  ctx.possibilities.setup.set(s.possSetup)
  ctx.hamstersMaxSurvivingDay = s.hamstersMaxSurvivingDay
  ctx.needSeerAtDay = s.needSeerAtDay
  ctx.hamstersKilledBySeer.length = s.hamstersKilledBySeerLen
  ctx.requireOneOf.length = s.requireOneOfLen
  ctx.deathChronicle.clear()
  for (const [day, add, sub] of s.deathChronicleEntries) {
    ctx.deathChronicle.set(day, { add, sub })
  }
}

type RoleTester = (env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[]) => boolean

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

function testHamster(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[]): boolean {
  const hamsters = new Set<Seat>()
  let lastHamsterDiedAt = -Infinity
  let lastHamsterDiedBy: CauseOfDeath | undefined
  let livingHamsters = 0
  let seerKilledHamsterAt = -Infinity
  for ( const seat of selected ) {
    const self = getStatus(env, seat)
    hamsters.add(seat)
    if ( !context.possibilities.fixRole(seat,'werehamster') ) {
      return false
    }
    const status = getStatus(env, seat)
    if ( status.surviving ) {
      livingHamsters++
    }
    else {
      if ( status.causeOfDeath === 'night_kill' ) {

        const deathChronicle = context.deathChronicle.get(self.diedDay!)
        if ( !deathChronicle ) {
          context.deathChronicle.set(self.diedDay!, { add: 1, sub: 0 })
        }
        else {
          deathChronicle.add += 1
        }

        context.hamstersKilledBySeer.push({ day: status.diedDay!, seat })
        if ( seerKilledHamsterAt < status.diedDay! ) {
          seerKilledHamsterAt = status.diedDay!
        }
      }
      if ( lastHamsterDiedAt < status.diedDay!) {
        lastHamsterDiedAt = status.diedDay!
        lastHamsterDiedBy = status.causeOfDeath
      }
    }
  }
  if ( 0 <= seerKilledHamsterAt ) {
    context.needSeerAtDay = seerKilledHamsterAt
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
    context.possibilities.denyRole(seat, 'werehamster')
    if ( !livingHamsters ) {
      const status = getStatus(env, seat)
      if ( status.surviving || lastHamsterDiedAt < status.diedDay! ) {
        context.possibilities.denyRole(seat, 'immoralist')
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

function testSeer(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[]): boolean {
  const seers = new Set<Seat>()
  let maxSurviving = -Infinity
  const seerTargets: Map<Day, (Seat | 'unknown')[]> = new Map()
  let unresolvedHamsterDeath: Map<number, number> = new Map()
  if ( context.hamstersKilledBySeer.length > 0 ) {
    for ( const { day } of context.hamstersKilledBySeer ) {
      const current = unresolvedHamsterDeath.get(day) || 0
      unresolvedHamsterDeath.set(day, current + 1)
    }
  }

  for ( const seat of selected ) {
    seers.add(seat)
    if ( !context.possibilities.fixRole(seat, 'seer') ) {
      return false
    }

    const self = getStatus(env, seat)

    if (!self.claiming) {
      for ( const [day, count] of unresolvedHamsterDeath.entries() ) {
        if ( self.surviving || self.diedDay! >= day ) {
          unresolvedHamsterDeath.set(day, count - 1)
        }
      }
    }
    if (self.surviving) maxSurviving = Infinity
    else if (maxSurviving < self.diedDay!) maxSurviving = self.diedDay!

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
    const maxActiveDay = self.surviving ? env.vs.day - 1 : (self.causeOfDeath === 'night_kill' ? self.diedDay! : self.diedDay! - 1)
    for (let d = env.dayCountFrom; d <= maxActiveDay; d++) {
      if (!seerTargets.has(d)) {
        const forecastTarget = self.forecasts.get(d)
        seerTargets.set(d, [forecastTarget ?? 'unknown'])
      }
    }
    for (const [, { target: targetSeat, species }] of self.assertions) {
      if ( species === 'wolf' ) {
        if ( ! context.possibilities.fixRole(targetSeat,'werewolf') ) {
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
      else if ( context.possibilities.isActualRole(targetSeat, 'werehamster') ) {
        const targetStatus = getStatus(env, targetSeat)
        if ( targetStatus.surviving ) return false
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
      if ( context.possibilities.isActualRole(forecastTarget, 'werehamster') ) {
        const targetStatus = getStatus(env, forecastTarget)
        if ( targetStatus.surviving ) return false
        const targetsOnDeathDay = seerTargets.get(targetStatus.diedDay!) || []
        if ( !targetsOnDeathDay.includes(forecastTarget) && !targetsOnDeathDay.includes('unknown') ) return false
      }
    }
  }

  for ( const { day, seat } of context.hamstersKilledBySeer ) {
    for ( const [seerDay, targets] of seerTargets.entries() ) {
      for ( const target of targets ) {
        if ( day === seerDay && seat === target ) {
          unresolvedHamsterDeath.set(day, (unresolvedHamsterDeath.get(day) || 1) - 1)
        }
        else if ( day === seerDay && target === 'unknown' ) {
          unresolvedHamsterDeath.set(day, (unresolvedHamsterDeath.get(day) || 1) - 1)
        }
      }
    }
  }
  for ( const count of unresolvedHamsterDeath.values() ) {
    if ( count > 0 ) return false
  }

  if ( context.needSeerAtDay != null && maxSurviving < context.needSeerAtDay )
    return false

  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming ) {
      if ( !context.possibilities.denyRole(seat, 'seer') ) {
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

  if ( !denyRoleForOthers(env, context, 'seer', seers) ) return false
  return true
}

function testMedium(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[]): boolean {
  const mediums = new Set<Seat>()
  for ( const seat of selected ) {
    mediums.add(seat)
    if ( !context.possibilities.fixRole(seat, 'medium') ) {
      return false
    }
    const self = getStatus(env, seat)

    for (const [, { target: targetSeat, species }] of self.assertions) {
      if ( species === 'wolf' ) {
        if ( ! context.possibilities.fixRole(targetSeat, 'werewolf') ) {
          return false
        }
      }
      else {
        if ( ! context.possibilities.markAsHuman(targetSeat) ) {
          return false
        }
      }
    }
  }
  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming || status.claimingRole !== 'medium' ) {
      if (! context.possibilities.denyRole(seat, 'medium') ) {
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
  if ( !denyRoleForOthers(env, context, 'medium', mediums) ) return false
  return true
}

function testBodyguard(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[]): boolean {
  const bodyguards = new Set<Seat>()
  for ( const seat of selected ) {
    bodyguards.add(seat)
    if ( !context.possibilities.fixRole(seat, 'bodyguard') ) {
      return false
    }
  }

  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming || status.claimingRole !== 'bodyguard' ) {
      if (!context.possibilities.denyRole(seat, 'bodyguard')) {
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
  if ( !denyRoleForOthers(env, context, 'bodyguard', bodyguards) ) return false
  return true
}

function testMason(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[]): boolean {
  const masons = new Set<Seat>()
  for ( const seat of selected ) {
    masons.add(seat)
    if ( ! context.possibilities.fixRole(seat, 'mason') ) {
      return false
    }
    const self = getStatus(env, seat)

    for (const [, { target: targetSeat, species }] of self.assertions) {
      if ( species === 'wolf' ) {
        // 仕様です。共有は相方に人間とアサーションします。
        return false
      }
      else {
        if ( ! context.possibilities.fixRole(targetSeat, 'mason') ) {
          return false
        }
        masons.add(targetSeat)
      }
    }
  }
  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming || status.claimingRole !== 'mason' ) continue
    if ( ! context.possibilities.markAsLiar(seat) ) {
      return false
    }
  }
  if ( !denyRoleForOthers(env, context, 'mason', masons) ) return false
  return true
}

function testNekomata(env: RoleTesterEnv, context: AnalyzeContext, selected: Seat[], rest: Seat[]): boolean {
  const nekomatas = new Set<Seat>()
  const possibleCursed: Seat[] = []
  for ( const seat of selected ) {
    nekomatas.add(seat)
    if ( ! context.possibilities.fixRole(seat, 'nekomata') ) {
      return false
    }
    const self = getStatus(env, seat)
    if ( !self.surviving ) {
      const deathChronicle = context.deathChronicle.get(self.diedDay!)
      if ( self.causeOfDeath === 'night_kill' ) {
        if ( !deathChronicle ) {
          context.deathChronicle.set(self.diedDay!, { add: 1, sub: 0 })
        }
        else {
          deathChronicle.add += 1
        }
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
            if ( ! context.possibilities.fixRole(targetSeat, 'werewolf') ) {
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
      possibleCursed.map(targetSeat => ({ seat: targetSeat, role: 'werewolf' as SystemRole }))
    )
  }

  for ( const seat of rest ) {
    const status = getStatus(env, seat)
    if ( !status.claiming || status.claimingRole !== 'nekomata' ) {
      if ( !context.possibilities.denyRole(seat, 'nekomata') ) {
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
  if ( !denyRoleForOthers(env, context, 'nekomata', nekomatas) ) return false
  return true
}

export const roleTesterMap: Partial<Record<SystemRole, RoleTester>> = {
  werehamster: testHamster,
  seer: testSeer,
  medium: testMedium,
  bodyguard: testBodyguard,
  mason: testMason,
  nekomata: testNekomata,
}
