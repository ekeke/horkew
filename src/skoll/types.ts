import type { Seat } from '../types/index.ts'

export type SeatCategory = 'confirmed_wolf' | 'confirmed_village' | 'gray' | 'dead'

export type SeatClassification = {
  categories: Map<Seat, SeatCategory>
  grayCount: number
  wolvesInGray: number
  confirmedVillageCount: number
  /** 生存している確定狼の数 */
  confirmedWolfCount: number
  totalAlive: number
  trueSeerSeat: Seat | null
}

export type Branch = {
  trueSeer: Seat | null
  fakeSeats: Seat[]
  classification: SeatClassification
  /** v1: 均等重み (1/N) */
  weight: number
}

export type ExecutionOutcome = {
  seat: Seat
  winRate: number
}

export type ExecutionAnalysis = {
  branches: Branch[]
  overallWinRate: number
  executions: ExecutionOutcome[]
  bestExecution: Seat
  /** CO なしでフォールバックした場合 true */
  fallback: boolean
}
