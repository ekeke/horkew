/**
 * WASM Retar のシリアライズ/デシリアライズヘルパー。
 * lupa と demo の両方から使用される。
 */

import type { SystemRole, Seat } from '../types/index.ts'
import type { AnalyzeOptions, AnalyzeResult } from './index.ts'
import { Possibilities, RoleSignatureBits, RoleBitIndex, ROLE_COUNT } from './possibilities.ts'

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

export function serializeOptions(options: AnalyzeOptions, setup?: Map<SystemRole, number>): any {
  const result: any = {
    ...options,
    assumptions: Object.fromEntries(options.assumptions),
    hocusPocus: Object.fromEntries(options.hocusPocus),
  }
  if (options.prior) {
    // Rust Possibilities 構造体互換フォーマットに変換
    // { possibilities: u16[], setup: u8[11], setup_original: u8[11], max_surviving_nv: i32 }
    let maxSeat = 0
    for (const seat of options.prior.keys()) {
      if (seat > maxSeat) maxSeat = seat
    }
    const possibilities = new Array<number>(maxSeat + 1).fill(0)
    for (const [seat, roles] of options.prior) {
      let mask = 0
      for (const role of roles) mask |= RoleSignatureBits[role]
      possibilities[seat] = mask
    }
    const setupArr = new Array<number>(ROLE_COUNT).fill(0)
    if (setup) {
      for (const [role, count] of setup) {
        setupArr[RoleBitIndex[role]] = count
      }
    }
    result.prior = {
      possibilities,
      setup: setupArr,
      setup_original: setupArr,
      max_surviving_nv: 0,
    }
  }
  return result
}

export function parseWasmResult(resultJson: string): AnalyzeResult {
  const parsed = JSON.parse(resultJson)
  if (parsed.error) return { result: new Map(), maxSurvivingNV: 0 }
  const possObj = parsed.result ?? parsed.possibilities ?? parsed
  const result = new Map<Seat, Set<SystemRole>>()
  for (const [seatStr, roles] of Object.entries(possObj)) {
    result.set(Number(seatStr), new Set(roles as SystemRole[]))
  }
  return {
    result,
    maxSurvivingNV: parsed.maxSurvivingNV ?? 0,
    elapsed: parsed.elapsed,
    batch: parsed.batch,
    id: parsed.id,
    aborted: parsed.aborted,
  }
}

export function resultToPossibilities(result: AnalyzeResult): Possibilities {
  let maxSeat = 0
  for (const seat of result.result.keys()) {
    if (seat > maxSeat) maxSeat = seat
  }
  const p = new Possibilities(maxSeat)
  for (const [seat, roles] of result.result) {
    let mask = 0
    for (const role of roles) mask |= RoleSignatureBits[role]
    p.possibilities[seat] = mask
  }
  p.maxSurvivingNV = result.maxSurvivingNV
  return p
}
