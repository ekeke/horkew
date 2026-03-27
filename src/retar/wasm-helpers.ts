/**
 * WASM Retar のシリアライズ/デシリアライズヘルパー。
 * lupa と demo の両方から使用される。
 */

import type { SystemRole, Seat } from '../types/index.ts'
import type { AnalyzeOptions } from './index.ts'
import { Possibilities, RoleSignatureBits } from './possibilities.ts'

export function serializeVillageStatus(vs: any): any {
  const obj: any = { ...vs }
  obj.statuses = Object.fromEntries(
    [...vs.statuses.entries()].map(([k, v]: [any, any]) => [
      String(k),
      {
        ...v,
        actions: Object.fromEntries(v.actions),
        assertions: Object.fromEntries(
          [...v.assertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
        ),
        forecasts: Object.fromEntries(
          [...v.forecasts.entries()].map(([day, s]: [any, any]) => [String(day), s])
        ),
        previousAssertions: v.previousAssertions
          ? Object.fromEntries(
              [...v.previousAssertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
            )
          : undefined,
        previousClaims: v.previousClaims?.map((pc: any) => ({
          ...pc,
          assertions: Object.fromEntries(
            [...pc.assertions.entries()].map(([day, a]: [any, any]) => [String(day), a])
          ),
          actions: Object.fromEntries(pc.actions),
          forecasts: Object.fromEntries(
            [...pc.forecasts.entries()].map(([day, s]: [any, any]) => [String(day), s])
          ),
        })),
      },
    ])
  )
  obj.executions = Object.fromEntries(
    [...vs.executions.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.kills = Object.fromEntries(
    [...vs.kills.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.voteHistory = Object.fromEntries(
    [...vs.voteHistory.entries()].map(([k, v]: [any, any]) => [String(k), v])
  )
  obj.revoteTargets = [...vs.revoteTargets]
  obj.multiVoteDays = [...vs.multiVoteDays]
  delete obj.roles
  delete obj.claims
  return obj
}

export function serializeOptions(options: AnalyzeOptions): any {
  return {
    ...options,
    assumptions: Object.fromEntries(options.assumptions),
    hocusPocus: Object.fromEntries(options.hocusPocus),
  }
}

export function parseWasmResult(resultJson: string): Map<Seat, Set<SystemRole>> {
  const parsed = JSON.parse(resultJson)
  if (parsed.error) return new Map()
  const result = new Map<Seat, Set<SystemRole>>()
  for (const [seatStr, roles] of Object.entries(parsed)) {
    result.set(Number(seatStr), new Set(roles as SystemRole[]))
  }
  return result
}

export function resultToPossibilities(result: Map<number, Set<SystemRole>>): Possibilities {
  let maxSeat = 0
  for (const seat of result.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  const p = new Possibilities(maxSeat)
  for (const [seat, roles] of result) {
    let mask = 0
    for (const role of roles) mask |= RoleSignatureBits[role]
    p.possibilities[seat] = mask
  }
  return p
}
