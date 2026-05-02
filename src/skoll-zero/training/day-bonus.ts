/**
 * Day bonus reward shaping.
 *
 * 14D-12-猫構造では 12/14 のプレイヤー (村陣営 8 + 狼陣営 4) が長期化を望む
 * (狐排除機会を増やすため)。狐陣営 (狐 + immoralist = 2/14) のみ短期決着を望む。
 * value scalar に sign × coef × day を加えることで MCTS の探索を長期化方向に
 * 偏らせる。value head 自体 (outcome 分布) は変更しない。
 */

/**
 * Faction を inline 定義 (循環 import 回避)。ISMCTS.ts の Faction と構造一致。
 */
type Faction = 'village' | 'wolf' | 'hamster'

/** 陣営別 day bonus 符号: village/wolf=+1 (長期化希望)、hamster=-1 (短期決着希望) */
export function factionDayBonusSign(faction: Faction): number {
  return faction === 'hamster' ? -1 : +1
}

/** base scalar value に day bonus を加える (coef=0 で no-op) */
export function applyDayBonus(
  baseValue: number,
  faction: Faction,
  day: number,
  coef: number,
): number {
  if (coef === 0) return baseValue
  return baseValue + factionDayBonusSign(faction) * coef * day
}

/** env SKOLLZ_DAY_BONUS_COEF からの読み取り (未設定 / 不正値 = 0) */
export function readDayBonusCoefFromEnv(): number {
  const raw = process.env.SKOLLZ_DAY_BONUS_COEF
  if (raw === undefined || raw === '') return 0
  const v = parseFloat(raw)
  return Number.isFinite(v) ? v : 0
}
