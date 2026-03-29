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
  const result: any = {
    ...options,
    assumptions: Object.fromEntries(options.assumptions),
    hocusPocus: Object.fromEntries(options.hocusPocus),
  }
  if (options.prior) {
    const priorObj: Record<string, string[]> = {}
    for (const [seat, roles] of options.prior) {
      priorObj[String(seat)] = [...roles]
    }
    result.prior = priorObj
  }
  return result
}

export type WasmResult = {
  possibilities: Map<Seat, Set<SystemRole>>
  maxSurvivingNV: number
}

export function parseWasmResult(resultJson: string): WasmResult {
  const parsed = JSON.parse(resultJson)
  if (parsed.error) return { possibilities: new Map(), maxSurvivingNV: 0 }
  // 新フォーマット: { possibilities: {...}, maxSurvivingNV: N }
  const possObj = parsed.possibilities ?? parsed
  const maxSurvivingNV: number = parsed.maxSurvivingNV ?? 0
  const possibilities = new Map<Seat, Set<SystemRole>>()
  for (const [seatStr, roles] of Object.entries(possObj)) {
    possibilities.set(Number(seatStr), new Set(roles as SystemRole[]))
  }
  return { possibilities, maxSurvivingNV }
}

export function resultToPossibilities(result: WasmResult): Possibilities {
  let maxSeat = 0
  for (const seat of result.possibilities.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  const p = new Possibilities(maxSeat)
  for (const [seat, roles] of result.possibilities) {
    let mask = 0
    for (const role of roles) mask |= RoleSignatureBits[role]
    p.possibilities[seat] = mask
  }
  p.maxSurvivingNV = result.maxSurvivingNV
  return p
}
