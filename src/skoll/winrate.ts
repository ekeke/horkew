/**
 * 解析的勝率計算（純粋数学）
 *
 * VillageStatus に依存せず、グレー数・狼数・狐数・確定村数・生存数の
 * 5整数から村の勝率を再帰的に計算する。
 *
 * 夜モデル（v1）: 狼は confirmed village を優先的に噛む。
 * confirmed がいなければ gray の非狼非狐を噛む。
 * 狐は噛まれても死なない（本来 world 側で扱うが、ここでは
 * 「狼の噛みでは狐は死なない」前提のため grays は減らない）。
 * 占いの呪殺はこの関数内ではモデルせず、呼び出し側（estimateNextDay）で扱う。
 */

/**
 * メモ化キー: 5整数を1つの number にパック。
 * 各値 0-31 を想定（14人村で十分）。5bit×5=25bit < 32bit。
 */
function memoKey(
  grays: number, wolves: number, foxes: number, confirmed: number, alive: number,
): number {
  return (grays << 20) | (wolves << 15) | (foxes << 10) | (confirmed << 5) | alive
}

/**
 * 村の勝率を再帰的に計算する。
 *
 * 前提:
 * - 村はグレーからランダムに1人を処刑する
 * - 狼は confirmed village を優先的に噛む（いなければ gray の非狼非狐）
 * - 狐は噛みでは死なない。処刑命中のみでしか死なない（呪殺は呼び出し側）
 * - 護衛・占いの将来結果は v1 では考慮しない
 *
 * @param grays - グレー（未確定）の生存者数（狼・狐含む）
 * @param wolves - グレー内の狼数
 * @param foxes - グレー内の狐数
 * @param confirmed - 確定村の生存者数（狼でない確定者）
 * @param alive - 全生存者数（= grays + confirmed + confirmedWolves）
 * @param cache - メモ化キャッシュ（省略時は新規作成）
 */
export function computeWinRate(
  grays: number,
  wolves: number,
  foxes: number,
  confirmed: number,
  alive: number,
  cache?: Map<number, number>,
): number {
  const c = cache ?? new Map<number, number>()
  return computeWinRateInner(grays, wolves, foxes, confirmed, alive, c)
}

function computeWinRateInner(
  grays: number,
  wolves: number,
  foxes: number,
  confirmed: number,
  alive: number,
  cache: Map<number, number>,
): number {
  // 終端条件
  if (wolves <= 0) return foxes <= 0 ? 1.0 : 0.0 // 村勝 or 狐勝
  // PP 判定: 2*wolves + foxes >= alive （狐は非狼非狐のカウント外）
  if (2 * wolves + foxes >= alive) return 0.0 // wolf_win or hamster_win, どちらも村は負け
  if (grays <= 0) return foxes <= 0 ? 1.0 : 0.0 // grays 0 で wolves > 0 は通常ありえない
  const rope = Math.floor((alive - 1) / 2)
  if (rope <= 0) return 0.0

  const key = memoKey(grays, wolves, foxes, confirmed, alive)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const pHitWolf = wolves / grays
  const pHitFox = foxes / grays
  const pMiss = (grays - wolves - foxes) / grays

  // 狼命中
  let winIfHitWolf: number
  if (wolves === 1) {
    // 最後の狼 → 狐が生存していなければ村勝ち（夜フェーズなし）
    winIfHitWolf = foxes <= 0 ? 1.0 : 0.0
  } else {
    winIfHitWolf = applyNightBite(grays - 1, wolves - 1, foxes, confirmed, alive - 1, cache)
  }

  // 狐命中
  let winIfHitFox: number
  if (foxes <= 0) {
    winIfHitFox = 0.0 // 狐ゼロなら確率もゼロなので寄与なし
  } else {
    winIfHitFox = applyNightBite(grays - 1, wolves, foxes - 1, confirmed, alive - 1, cache)
  }

  // 村吊り（ハズレ）
  const winIfMiss = applyNightBite(grays - 1, wolves, foxes, confirmed, alive - 1, cache)

  const result = pHitWolf * winIfHitWolf + pHitFox * winIfHitFox + pMiss * winIfMiss
  cache.set(key, result)
  return result
}

/**
 * 処刑後に狼が1人噛む夜フェーズを適用し、翌日の勝率を返す。
 * confirmed を優先的に噛み、いなければ gray を噛む（元モデルの簡略化：
 * グレー非狼非狐の残数はチェックせず、常に grays-1 とする。終端条件は
 * 次の recursion の PP 判定で処理される）。
 *
 * @param grays - 処刑後の grays
 * @param wolves - 処刑後の wolves
 * @param foxes - 処刑後の foxes
 * @param confirmed - 処刑後の confirmed
 * @param aliveAfterExec - 処刑後の alive（夜の前）
 */
function applyNightBite(
  grays: number,
  wolves: number,
  foxes: number,
  confirmed: number,
  aliveAfterExec: number,
  cache: Map<number, number>,
): number {
  // 終端チェック（噛み前）
  if (wolves <= 0) return foxes <= 0 ? 1.0 : 0.0
  if (2 * wolves + foxes >= aliveAfterExec) return 0.0

  if (confirmed > 0) {
    return computeWinRateInner(grays, wolves, foxes, confirmed - 1, aliveAfterExec - 1, cache)
  }
  // 常に gray を噛む（近似: 非狼非狐がいなくても数値的に扱う）
  return computeWinRateInner(grays - 1, wolves, foxes, 0, aliveAfterExec - 1, cache)
}
