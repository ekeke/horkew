import wasmInit, { analyze } from '../src/retar-rs/pkg-web/retar.js'
// @ts-ignore — Vite ?url import
import wasmUrl from '../src/retar-rs/pkg/retar_bg.wasm?url'
import { VillageRetar } from '../src/retar/index.ts'
import type { SystemRole } from '../src/types/index.ts'

export type RetarRequest = {
  vsJson: string
  setupJson: string
  players: [number, string][]
  assumptions: [number, SystemRole][]
  wolfPairDenyals?: [number, number][]
  batches?: number
  batch?: number
}

export type SeatResult = {
  seat: number
  roles: SystemRole[]
}

export type RetarResponse =
  | { type: 'result'; seats: SeatResult[]; elapsed: number; wasm: boolean }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

let signal: Int32Array | undefined
let wasmReady = false
const wasmReady$ = wasmInit(wasmUrl).then(() => { wasmReady = true }).catch(() => {})

self.onmessage = (e: MessageEvent<any>) => {
  const msg = e.data
  if (msg.type === 'init') {
    signal = new Int32Array(msg.signal)
    return
  }

  wasmReady$.then(() => handleAnalysis(msg))
}

function handleAnalysis(msg: any) {
  const t0 = performance.now()
  try {
    const { vsJson, setupJson } = msg as RetarRequest

    const optJson = JSON.stringify({
      seerClaimingDueDate: 2,
      mediumClaimingDueDate: 2,
      bodyguardClaimingDueDate: 99,
      masonClaimingDueDate: 2,
      nekomataClaimingDueDate: 99,
      dayCountFrom: 1,
      hasFirstGhost: false,
      assumptions: Object.fromEntries(msg.assumptions ?? []),
      wolfPairDenyals: msg.wolfPairDenyals ?? [],
      hocusPocus: {},
      id: 0,
      batches: msg.batches ?? 1,
      batch: msg.batch ?? 0,
    })

    if (wasmReady) {
      const resultJson = analyze(vsJson, setupJson, optJson)

      const parsed = JSON.parse(resultJson)
      if (parsed.error) {
        self.postMessage({ type: 'error', message: parsed.error } satisfies RetarResponse)
        return
      }
      if (parsed.aborted) {
        self.postMessage({ type: 'aborted' } satisfies RetarResponse)
        return
      }

      const seats: SeatResult[] = []
      for (const [seatStr, roles] of Object.entries(parsed.result)) {
        seats.push({ seat: Number(seatStr), roles: roles as SystemRole[] })
      }
      self.postMessage({ type: 'result', seats, elapsed: performance.now() - t0, wasm: true } satisfies RetarResponse)
      return
    }

    // JS fallback: reconstruct from JSON
    const vs = JSON.parse(vsJson)
    const setupEntries: [SystemRole, number][] = Object.entries(JSON.parse(setupJson)) as any
    const setup = new Map<SystemRole, number>(setupEntries)

    vs.statuses = new Map(Object.entries(vs.statuses).map(([k, v]: [any, any]) => {
      v.actions = new Map(Object.entries(v.actions))
      v.assertions = new Map(Object.entries(v.assertions))
      v.forecasts = v.forecasts ? new Map(Object.entries(v.forecasts)) : new Map()
      return [Number(k), v]
    }))
    vs.executions = new Map(Object.entries(vs.executions).map(([k, v]: [any, any]) => [Number(k), v]))
    vs.kills = new Map(Object.entries(vs.kills).map(([k, v]: [any, any]) => [Number(k), v]))
    vs.voteHistory = new Map(Object.entries(vs.voteHistory ?? {}).map(([k, v]: [any, any]) => [Number(k), v]))
    vs.roles = new Map()
    vs.claims = new Map()
    vs.revoteTargets = new Set(vs.revoteTargets ?? [])
    vs.multiVoteDays = new Set(vs.multiVoteDays ?? [])

    const options = {
      seerClaimingDueDate: 2,
      mediumClaimingDueDate: 2,
      bodyguardClaimingDueDate: 99,
      masonClaimingDueDate: 2,
      nekomataClaimingDueDate: 99,
      dayCountFrom: 1,
      hasFirstGhost: false,
      assumptions: new Map(msg.assumptions ?? []),
      wolfPairDenyals: msg.wolfPairDenyals ?? [],
      hocusPocus: new Map(),
      id: 0,
      batches: msg.batches ?? 1,
      batch: msg.batch ?? 0,
      signal,
    }

    const retar = new VillageRetar(vs, setup, options)
    const result = retar.analyze()

    if (result.aborted) {
      self.postMessage({ type: 'aborted' } satisfies RetarResponse)
      return
    }

    const seats: SeatResult[] = []
    if (result && 'result' in result) {
      for (const [seat, roles] of result.result) {
        seats.push({ seat, roles: [...roles] as SystemRole[] })
      }
    }

    self.postMessage({ type: 'result', seats, elapsed: performance.now() - t0, wasm: false } satisfies RetarResponse)
  } catch (e: any) {
    self.postMessage({ type: 'error', message: e.message } satisfies RetarResponse)
  }
}
