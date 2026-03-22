import { VillageRetar } from '../src/retar/index.ts'
import type { VillageStatus, SystemRole } from '../src/types/index.ts'

export type RetarRequest = {
  vs: VillageStatus
  setup: [SystemRole, number][]
  players: [number, string][]
  assumptions: [number, SystemRole][]
  batches?: number
  batch?: number
}

export type SeatResult = {
  seat: number
  roles: SystemRole[]
}

export type RetarResponse =
  | { type: 'result'; seats: SeatResult[]; elapsed: number }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

let signal: Int32Array | undefined

self.onmessage = (e: MessageEvent<any>) => {
  const msg = e.data
  if (msg.type === 'init') {
    signal = new Int32Array(msg.signal)
    return
  }

  try {
    const { vs, players: playersArr } = msg as RetarRequest
    const setup = new Map<SystemRole, number>(msg.setup)
    const players = new Map<number, string>(playersArr)

    // Reconstruct Maps from serialized VillageStatus
    vs.statuses = new Map(vs.statuses as any)
    vs.executions = new Map(vs.executions as any)
    vs.kills = new Map(vs.kills as any)
    vs.roles = new Map(vs.roles as any)
    vs.claims = new Map(vs.claims as any)
    vs.voteHistory = new Map(vs.voteHistory as any ?? [])
    for (const [seat, status] of vs.statuses) {
      status.actions = new Map(status.actions as any)
      status.assertions = new Map(status.assertions as any)
    }

    const options = {
      seerClaimingDueDate: 2,
      mediumClaimingDueDate: 2,
      bodyguardClaimingDueDate: 99,
      masonClaimingDueDate: 2,
      nekomataClaimingDueDate: 99,
      dayCountFrom: 1,
      hasFirstGhost: false,
      assumptions: new Map(msg.assumptions ?? []),
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

    self.postMessage({ type: 'result', seats, elapsed: result.elapsed ?? 0 } satisfies RetarResponse)
  } catch (e: any) {
    self.postMessage({ type: 'error', message: e.message } satisfies RetarResponse)
  }
}
