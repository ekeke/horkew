/**
 * Retar分析ワーカー (worker_threads用)
 *
 * Howlテキストを受け取り、batches/batchで分割してRetarを実行、
 * 部分結果を返す。
 */

import { parentPort } from 'node:worker_threads'
import type { SystemRole } from '../types/index.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { VillageRetar } from '../retar/index.ts'
import type { AnalyzeOptions } from '../retar/index.ts'

export type RetarWorkerRequest = {
  howl: string
  hasFirstGhost: boolean
  batches: number
  batch: number
}

export type RetarWorkerResponse =
  | { type: 'result', seats: Array<{ seat: number, roles: SystemRole[] }> }
  | { type: 'error', message: string }

const DEFAULT_OPTIONS: AnalyzeOptions = {
  seerClaimingDueDate: 99,
  mediumClaimingDueDate: 99,
  bodyguardClaimingDueDate: 99,
  masonClaimingDueDate: 99,
  nekomataClaimingDueDate: 99,
  dayCountFrom: 1,
  hasFirstGhost: false,
  assumptions: new Map(),
  wolfPairDenyals: [],
  hocusPocus: new Map(),
  id: 0,
  batches: 1,
  batch: 0,
}

parentPort!.on('message', (req: RetarWorkerRequest) => {
  try {
    const { meta, statements } = parse(req.howl)
    const unknowns = statements.filter(s => s.type === 'unknown')
    if (unknowns.length > 0) {
      parentPort!.postMessage({ type: 'result', seats: [] } satisfies RetarWorkerResponse)
      return
    }

    const { vs, setup } = buildVillageStatus(statements, meta)
    const options: AnalyzeOptions = {
      ...DEFAULT_OPTIONS,
      hasFirstGhost: req.hasFirstGhost,
      batches: req.batches,
      batch: req.batch,
    }

    const retar = new VillageRetar(vs, setup, options)
    const result = retar.analyzeSafe()

    if (result.error || !result.result) {
      parentPort!.postMessage({ type: 'result', seats: [] } satisfies RetarWorkerResponse)
      return
    }

    const seats: Array<{ seat: number, roles: SystemRole[] }> = []
    for (const [seat, roles] of result.result) {
      seats.push({ seat, roles: [...roles] })
    }
    parentPort!.postMessage({ type: 'result', seats } satisfies RetarWorkerResponse)
  } catch (e: any) {
    parentPort!.postMessage({ type: 'error', message: e.message } satisfies RetarWorkerResponse)
  }
})
