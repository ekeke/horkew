import { VillageRetar } from '../src/retar/index.ts'
import type { VillageStatus, SystemRole } from '../src/types/index.ts'

export type RetarRequest = {
  vs: VillageStatus
  setup: [SystemRole, number][]
  players: [number, string][]
  assumptions: [number, SystemRole][]
}

export type SeatResult = {
  seat: number
  roles: SystemRole[]
}

export type RetarResponse =
  | { type: 'result'; seats: SeatResult[] }
  | { type: 'error'; message: string }

self.onmessage = (e: MessageEvent<RetarRequest>) => {
  try {
    const { vs, players: playersArr } = e.data
    const setup = new Map<SystemRole, number>(e.data.setup)
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
      assumptions: new Map(e.data.assumptions ?? []),
      hocusPocus: new Map(),
      id: 0,
      batches: 1,
      batch: 0,
    }

    const retar = new VillageRetar(vs, setup, options)
    const result = retar.analyze()

    const seats: SeatResult[] = []
    if (result && 'result' in result) {
      for (const [seat, roles] of result.result) {
        seats.push({ seat, roles: [...roles] as SystemRole[] })
      }
    }

    self.postMessage({ type: 'result', seats } satisfies RetarResponse)
  } catch (e: any) {
    self.postMessage({ type: 'error', message: e.message } satisfies RetarResponse)
  }
}
