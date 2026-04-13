/**
 * Eval howl 統計の型定義
 */

export type RealRole =
  | 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata'
  | 'werewolf' | 'fanatic' | 'werehamster' | 'immoralist'

/** Day 1 の CO 種別。CO しなかった席は 'none' */
export type ClaimType = 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata' | 'none'

export type GameResult = 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' | 'unknown'

/** 1 ゲームのパース結果（統計に必要な最小情報のみ）。名前は含まない */
export type ParsedGame = {
  result: GameResult
  /** Day 0 夜に死亡した席数（分母補正用） */
  day0Deaths: number
  /** Day 1 開始時点で生存していたプレイヤーの (真役職, Day 1 CO) ペア */
  entries: Array<{ role: RealRole, claim: ClaimType }>
}

/** 1 iter (= 1 eval バケット) の集計結果 */
export type IterBucket = {
  iter: number
  /** train-progress.json から解決した phase (BB, BB+1, ..., BB+5) / 不明なら undefined */
  phase?: string
  /** このバケットのゲーム数 */
  games: number
  /** 結果別ゲーム数 */
  results: Record<GameResult, number>
  /** 真役職 × Day 1 CO の頻度表。行: 真役職、列: CO 種別 */
  day1Formation: Record<RealRole, Record<ClaimType, number>>
}

export type StatsJson = {
  /** 生成日時 (ISO8601) */
  generatedAt: string
  /** 入力 checkpoint ベースパス */
  checkpointBase: string
  /** 集計対象のゲーム総数 */
  totalGames: number
  /** iter 昇順 */
  buckets: IterBucket[]
}

export const REAL_ROLES: readonly RealRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  'werewolf', 'fanatic', 'werehamster', 'immoralist',
] as const

export const CLAIM_TYPES: readonly ClaimType[] = [
  'seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'none',
] as const

export function emptyFormation(): Record<RealRole, Record<ClaimType, number>> {
  const result = {} as Record<RealRole, Record<ClaimType, number>>
  for (const r of REAL_ROLES) {
    const row = {} as Record<ClaimType, number>
    for (const c of CLAIM_TYPES) row[c] = 0
    result[r] = row
  }
  return result
}

export function emptyResults(): Record<GameResult, number> {
  return { villager_won: 0, werewolf_won: 0, werehamster_won: 0, draw: 0, unknown: 0 }
}
