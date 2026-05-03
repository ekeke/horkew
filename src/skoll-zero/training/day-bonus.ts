/**
 * Day bonus + endgame bonus reward shaping.
 *
 * 14D-12-猫構造では 12/14 のプレイヤー (村陣営 8 + 狼陣営 4) が長期化を望む
 * (狐排除機会を増やすため)。狐陣営 (狐 + immoralist = 2/14) のみ短期決着を望む。
 *
 * 観測上 (viewer の retar 結果) の fox 生存状態に応じて 2 段階で切り替える:
 * - foxAliveByViewer=true (狐生存可能性あり): village/wolf に +coef × day を累積
 *   (長期化方向に MCTS 探索を偏らせる)。狐は -coef × day で短期化方向。
 * - foxAliveByViewer=false (狐死亡確認後): village/wolf は固定 +endgameCoef
 *   (狐排除はマイルストーン、以降は累積させない)。狐は -coef × day を継続だが
 *   観測上 fox 死亡 = ほぼ自陣営 terminal なので実質無関係。
 *
 * value head 自体 (outcome 分布) は変更しない。MCTS の value scalar 計算側のみ修正。
 */

/**
 * Faction を inline 定義 (循環 import 回避)。ISMCTS.ts の Faction と構造一致。
 */
type Faction = 'village' | 'wolf' | 'hamster'

/** 陣営別 day bonus 符号: village/wolf=+1 (長期化希望)、hamster=-1 (短期決着希望) */
export function factionDayBonusSign(faction: Faction): number {
  return faction === 'hamster' ? -1 : +1
}

/**
 * base scalar value に day bonus / endgame bonus を加える。
 *
 * - village / wolf:
 *   - foxAliveByViewer=true (default): base + coef × day (累積)
 *   - foxAliveByViewer=false:           base + endgameCoef (固定、day 不問)
 * - hamster:
 *   - 常に base - coef × day (短期化志向、観測 fox 状態に依存しない)
 *
 * coef=0 かつ endgameCoef=0 のときは no-op (互換)。foxAliveByViewer 省略時は true 扱い。
 */
export function applyDayBonus(
  baseValue: number,
  faction: Faction,
  day: number,
  coef: number,
  opts?: { foxAliveByViewer?: boolean, endgameCoef?: number },
): number {
  const endgameCoef = opts?.endgameCoef ?? 0
  if (coef === 0 && endgameCoef === 0) return baseValue
  const foxAlive = opts?.foxAliveByViewer ?? true
  if (faction === 'hamster') {
    return baseValue - coef * day
  }
  // village or wolf: 観測上 fox 死亡確認後は endgame 固定 bonus に切り替え
  return foxAlive
    ? baseValue + coef * day
    : baseValue + endgameCoef
}

/** env SKOLLZ_DAY_BONUS_COEF からの読み取り (未設定 / 不正値 = 0) */
export function readDayBonusCoefFromEnv(): number {
  const raw = process.env.SKOLLZ_DAY_BONUS_COEF
  if (raw === undefined || raw === '') return 0
  const v = parseFloat(raw)
  return Number.isFinite(v) ? v : 0
}

/** env SKOLLZ_ENDGAME_BONUS_COEF からの読み取り (未設定 / 不正値 = 0) */
export function readEndgameBonusCoefFromEnv(): number {
  const raw = process.env.SKOLLZ_ENDGAME_BONUS_COEF
  if (raw === undefined || raw === '') return 0
  const v = parseFloat(raw)
  return Number.isFinite(v) ? v : 0
}
