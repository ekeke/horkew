import type { Seat, SystemRole, EnumSpecies } from '../types/index.ts'

/** 1つの有効な役職配置（ワールド） */
export type World = {
  /** seat → 役職 の完全な割り当て */
  roles: Map<Seat, SystemRole>
  /** 人狼のseat集合 */
  wolfSeats: Set<Seat>
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
  alive: Set<Seat>
  day: number
}

/** 村の行動（1日分） */
export type VillageAction = {
  execute: Seat
  bodyguardTarget: Seat | null
  seerTarget: Seat | null
}

/** 夜の観測結果（村が区別できるもの） */
export type NightObservation = {
  /** 夜に死んだプレイヤー（ソート済み） */
  deaths: Seat[]
  /** 占い結果（真占い師のワールドでのみ有効） */
  seerResult: EnumSpecies | undefined
}

/** 観測のシリアライズキー */
export type ObservationKey = string

/** 処刑後の観測（霊媒結果） */
export type ExecutionObservation = {
  /** 処刑対象の霊媒結果 */
  mediumResult: EnumSpecies
  /** 猫又道連れで死んだプレイヤー（なければ null） */
  nekomataCurseTarget: Seat | null
  /** 背徳者後追いで死んだプレイヤー群 */
  immoralistFollowDeaths: Seat[]
}

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
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  maxDepth: 5,
}
