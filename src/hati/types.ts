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
  /** 妖狐のseatビットマスク（0 = なし、複数対応） */
  hamsterMask: number
  /** 背徳者のseatビットマスク（0 = なし、複数対応） */
  immoralistMask: number
  /** 真占い師のseatビットマスク（0 = なし、複数対応） */
  seerMask: number
  /** 真狩人のseat（いなければ -1） */
  bodyguardSeat: number
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
  /** 占い先リスト（占い師N人分、seerMaskの低ビット順に割り当て） */
  seerTargets: Seat[]
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

/** 詰み判定の中間結果（探索前の計算ベース判定） */
export type TsumiJudgment = {
  /** 詰み係数: nawa - threat */
  tsumiCoeff: number
  /** 縄数: (alive - 1) / 2（人間式、小数あり） */
  nawa: number
  /** 脅威数（処理すべき非村人数） */
  threat: number
  /** 整数縄数: floor((alive - 1 - hamster) / 2)（実際に処刑できる回数） */
  nawaInt: number
  /** 生存者ビットマスク */
  alive: number
  /** 狐が生存している可能性があるか */
  hasAliveHamster: boolean
  /** 計算で詰み不可能と判定された場合 true */
  impossible: boolean
}

/** 探索結果 */
export type TsumiResult = {
  isTsumi: boolean
  strategy: StrategyNode | null
  /** 詰み係数: nawa - threat (正=余裕あり, 0=ギリギリ, 負=詰み不可能) */
  tsumiCoeff: number
  /** 縄数: (alive - 1) / 2（人間式、小数あり。パリティ余裕を表現） */
  nawa: number
  /** 脅威数（処理すべき非村人数） */
  threat: number
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
  /** 戦略木を構築する（デフォルト: true）。falseなら詰み判定のみ高速実行 */
  buildStrategy?: boolean
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  maxDepth: 5,
}
