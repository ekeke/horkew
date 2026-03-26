import type { Seat, SystemRole } from '../types/index.ts'

// --- ビットマスクユーティリティ ---

/** seat → ビットマスク (bit N = seat N) */
export function seatBit(seat: Seat): number { return 1 << seat }
/** ビットマスクに seat が含まれるか */
export function hasSeat(mask: number, seat: Seat): boolean { return (mask & (1 << seat)) !== 0 }
/** ビットマスクから seat を除去 */
export function removeSeat(mask: number, seat: Seat): number { return mask & ~(1 << seat) }
/** ビットマスクの立っているビット数 */
export function popCount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}
/** ビットマスクの各 seat に対してコールバック実行 */
export function forEachSeat(mask: number, fn: (seat: Seat) => void): void {
  while (mask !== 0) {
    const bit = mask & (-mask) // lowest set bit
    fn(31 - Math.clz32(bit))
    mask ^= bit
  }
}
/** ビットマスクの各 seat を配列で返す */
export function seatsFromMask(mask: number): Seat[] {
  const result: Seat[] = []
  forEachSeat(mask, s => result.push(s))
  return result
}
/** seat 配列からビットマスクを構築 */
export function maskFromSeats(seats: Iterable<Seat>): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

/** 1つの有効な役職配置（ワールド） */
export type World = {
  /** 役職配列（seat インデックス、0 番は未使用） */
  roles: SystemRole[]
  /** 役職の数値ID配列（RoleBitIndex準拠、ホットパス用） */
  roleIds: Uint8Array
  /** 人狼のseatビットマスク */
  wolfMask: number
  /** 妖狐のseat（いなければ -1） */
  hamsterSeat: number
  /** 背徳者のseat（いなければ -1） */
  immoralistSeat: number
  /** 真占い師のseat（いなければ -1） */
  seerSeat: number
  /** 真狩人のseat（いなければ -1） */
  bodyguardSeat: number
  /** 真猫又のseat（いなければ -1） */
  nekomataSeat: number
  /** 真霊媒師のseat（いなければ -1） */
  mediumSeat: number
}

/** 探索中のシミュレーション状態 */
export type SimState = {
  /** 生存者ビットマスク (bit N = seat N が生存) */
  alive: number
  day: number
}

/** 村の行動（1日分） */
export type VillageAction = {
  execute: Seat
  bodyguardTarget: Seat | null
  seerTarget: Seat | null
}

/** 観測のシリアライズキー（文字列: 出力用） */
export type ObservationKey = string

/** 戦略の決定木（JSON-serializable） */
export type StrategyNode =
  | { type: 'win' }
  | {
    type: 'action'
    action: VillageAction
    /** 観測結果ごとの分岐（ObservationKey → 子ノード） */
    branches: Record<ObservationKey, StrategyNode>
  }

/** 探索結果 */
export type TsumiResult = {
  isTsumi: boolean
  strategy: StrategyNode | null
  stats: SearchStats
}

/** 探索統計 */
export type SearchStats = {
  worldsTotal: number
  nodesVisited: number
  /** Retar解析 + ワールド列挙 + 探索の合計時間 (ms) */
  elapsed: number
  /** Retar解析の時間 (ms) */
  retarElapsed: number
  /** ワールド列挙の時間 (ms) */
  enumerateElapsed: number
  /** Hati探索単体の時間 (ms) */
  searchElapsed: number
  maxDepth: number
}

/** 探索オプション */
export type SearchOptions = {
  /** 最大探索深度（日数） */
  maxDepth: number
  /** 狐関連の枝刈りを無効化（偽陰性検証用） */
  disableHamsterPruning?: boolean
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  maxDepth: 5,
}
