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

/**
 * Retar narrowing reward shaping (村陣営のみ).
 *
 * 14d-neko で「真占/真霊/真共有の自滅吊」が頻発する原因は、村側 NN が
 * 「retar 上で確定白の seat を占う/吊る」ような無情報行動の負価値を学習できていないこと。
 * 観測上 (global retar) の可能性集合を狭めることに直接 + 報酬を与えて、
 * 真贋判別と確定白の温存を学習させる。
 *
 * 設計議論 (tasks/training-handoff-20260505-102009.md) の合意:
 * - **村陣営のみ** 加算 (狼/狐側に対称な - 報酬は与えない)
 *   → 二項対称 shaping は狼が「retar 最大攪乱」に最適化されてバレるため (lessons.md 2026-05-05)
 * - **狼陣営の imitation 構造** (frozen 村 NN との KL 距離) は中期課題、今回手付かず
 * - **global retar** を基準にする (viewer 非依存、公開情報の縮小量が真の村側報酬)
 *
 * narrowProgress = clamp01((rootSum - leafSum) / (aliveAtRoot * NUM_ROLES))
 *   rootSum: MCTS root 時点の global retar 可能性総和 (Σ |possibilities[seat]| over alive)
 *   leafSum: leaf 評価時点の global retar 可能性総和 (rollout retar が ON のとき更新)
 * value bonus = +coef * narrowProgress  (village faction のみ)、wolf/hamster は base 据え置き
 *
 * coef=0 / progress 算出不能 (rootSum=null 等) で no-op。
 */
type NarrowFaction = Faction
const NUM_ROLES_FOR_NORMALIZE = 11

/**
 * (rootSum, leafSum, aliveCount) → 縮小進捗 [0, 1]。
 *
 * 縮まれば +、広がれば 0 に clamp (拡大は報酬しない)。
 * aliveCount=0 や rootSum=null/leafSum=null では 0 (no-op)。
 *
 * 正規化分母は `aliveCount × 11 (役職数)`。これは
 * 「全 alive seat の可能性集合が full set (全役職) → empty に絞り切られた最大変化量」
 * 相当のスケールにすることで、終盤 (alive 少) でも progress が小さくなりすぎないようにする。
 */
export function narrowProgress(
  rootSum: number | null | undefined,
  leafSum: number | null | undefined,
  aliveCount: number,
): number {
  if (rootSum === null || rootSum === undefined) return 0
  if (leafSum === null || leafSum === undefined) return 0
  if (aliveCount <= 0) return 0
  const denom = aliveCount * NUM_ROLES_FOR_NORMALIZE
  if (denom <= 0) return 0
  const delta = rootSum - leafSum
  if (delta <= 0) return 0
  const p = delta / denom
  return p > 1 ? 1 : p
}

/**
 * base scalar value に narrow bonus を加える。村陣営のみ +coef × progress、それ以外は据え置き。
 * coef=0 / progress=0 で no-op。
 */
export function applyNarrowBonus(
  baseValue: number,
  faction: NarrowFaction,
  progress: number,
  coef: number,
): number {
  if (coef === 0 || progress === 0) return baseValue
  if (faction !== 'village') return baseValue
  return baseValue + coef * progress
}

/** env SKOLLZ_NARROW_COEF からの読み取り (未設定 / 不正値 = 0) */
export function readNarrowBonusCoefFromEnv(): number {
  const raw = process.env.SKOLLZ_NARROW_COEF
  if (raw === undefined || raw === '') return 0
  const v = parseFloat(raw)
  return Number.isFinite(v) ? v : 0
}
