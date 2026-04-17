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

// ─── ミニマックス勝率計算 ───────────────────────────────────────────────────

/**
 * ミニマックス勝率計算。村（MAX）と狼（MIN）が最善手を指す前提で村の勝率を返す。
 *
 * 状態定義:
 * - grays: 役職不明プール（wolves/foxes/村人の混合）
 * - wolves: grays 内の狼数
 * - foxes: grays 内の狐数
 * - confirmedVillage: 占い白確定の生存者（処刑対象外）
 * - confirmedWolves: 占い黒確定の生存者（次ターン確実処刑）
 * - seerAlive/mediumAlive/bodyguardAlive: 真役職の生存フラグ
 * - nekomata: 猫又生存数
 *
 * alive = grays + confirmedVillage + confirmedWolves + seer + medium + bodyguard + nekomata
 *
 * 日フェーズ (村 MAX):
 *   confirmedWolves > 0 なら確定狼を吊る（deterministic -1 wolf）
 *   それ以外はグレーからランダム処刑（期待値）
 *   村は両者を比較して高い方を選ぶ
 *
 * 夜フェーズ (狼 MIN):
 *   占い師/霊媒/狩人/猫又/グレー村人/確定白 の各噛み先候補を評価し
 *   狼は村勝率を最小化する選択肢を選ぶ
 *   狩人は ランダム護衛（P=1/aliveNonWolf で狼の最善手をブロック）
 *
 * 占い師 (確率的):
 *   占い師生存 → グレーを占い: 狼発見(confirmedWolves+1) / 狐呪殺 / 白確定(confirmedVillage+1)
 */
export function minimaxWinRate(
  wolves: number,
  foxes: number,
  grays: number,
  confirmedVillage: number,
  confirmedWolves: number,
  seerAlive: boolean,
  mediumAlive: boolean,
  bodyguardAlive: boolean,
  nekomata: number,
  cache?: Map<number, number>,
): number {
  const totalWolves = wolves + confirmedWolves
  const alive = grays + confirmedVillage + confirmedWolves
    + (seerAlive ? 1 : 0) + (mediumAlive ? 1 : 0) + (bodyguardAlive ? 1 : 0) + nekomata

  if (totalWolves === 0) return foxes === 0 ? 1.0 : 0.0
  if (2 * totalWolves + foxes >= alive) return 0.0

  const localCache = cache ?? new Map<number, number>()
  const key = mmKey(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata)
  const cached = localCache.get(key)
  if (cached !== undefined) return cached

  const result = mmDay(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive, localCache)
  localCache.set(key, result)
  return result
}

/**
 * 夜フェーズ開始のミニマックス勝率計算。
 * 処刑直後（夜の始まり）から計算する場合に使用。
 * minimaxWinRate は日フェーズ（処刑から）開始なのに対し、こちらは夜（噛みから）開始。
 */
export function minimaxNightWinRate(
  wolves: number,
  foxes: number,
  grays: number,
  confirmedVillage: number,
  confirmedWolves: number,
  seerAlive: boolean,
  mediumAlive: boolean,
  bodyguardAlive: boolean,
  nekomata: number,
  cache?: Map<number, number>,
): number {
  const totalWolves = wolves + confirmedWolves
  const alive = grays + confirmedVillage + confirmedWolves
    + (seerAlive ? 1 : 0) + (mediumAlive ? 1 : 0) + (bodyguardAlive ? 1 : 0) + nekomata
  if (totalWolves === 0) return foxes === 0 ? 1.0 : 0.0
  if (2 * totalWolves + foxes >= alive) return 0.0
  const localCache = cache ?? new Map<number, number>()
  return mmNight(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive, localCache)
}

/**
 * ビットパック: wolves(4) | foxes(3) | grays(5) | confirmedVillage(4) |
 *              confirmedWolves(4) | seer(1) | medium(1) | bodyguard(1) | nekomata(3)
 * 合計 26bit < 32bit
 */
function mmKey(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number,
): number {
  return wolves
    | (foxes << 4)
    | (grays << 7)
    | (confirmedVillage << 12)
    | (confirmedWolves << 16)
    | ((seerAlive ? 1 : 0) << 20)
    | ((mediumAlive ? 1 : 0) << 21)
    | ((bodyguardAlive ? 1 : 0) << 22)
    | (nekomata << 23)
}

/** 日フェーズ: 村 MAX — 確定狼処刑 or グレーランダム処刑の高い方を選ぶ */
function mmDay(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, alive: number, cache: Map<number, number>,
): number {
  let best = -1

  // Option A: 確定狼処刑（deterministic wolf hit）
  if (confirmedWolves > 0) {
    const r = mmNight(wolves, foxes, grays, confirmedVillage, confirmedWolves - 1, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache)
    if (r > best) best = r
  }

  // Option B: グレーからランダム処刑（期待値）
  if (grays > 0) {
    const pWolf = wolves / grays
    const pFox = foxes / grays
    const pHuman = 1 - pWolf - pFox
    let grayRate = 0
    if (pWolf > 0) grayRate += pWolf * mmNight(wolves - 1, foxes, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache)
    if (pFox > 0) grayRate += pFox * mmNight(wolves, foxes - 1, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache)
    if (pHuman > 0) grayRate += pHuman * mmNight(wolves, foxes, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache)
    if (grayRate > best) best = grayRate
  }

  return best < 0 ? 0 : best
}

/** 夜フェーズ: 狼 MIN — 各噛み先候補を評価し最小勝率を選ぶ + 狩人護衛補正 */
function mmNight(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, alive: number, cache: Map<number, number>,
): number {
  const totalWolves = wolves + confirmedWolves
  if (totalWolves === 0) return foxes === 0 ? 1.0 : 0.0
  if (2 * totalWolves + foxes >= alive) return 0.0

  let wolfMin = 2.0 // 1.0 超のセンチネル

  // 噛み先1: 占い師
  if (seerAlive) {
    const r = mmSeer(wolves, foxes, grays, confirmedVillage, confirmedWolves, false, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache)
    if (r < wolfMin) wolfMin = r
  }
  // 噛み先2: 霊媒
  if (mediumAlive) {
    const r = mmSeer(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, false, bodyguardAlive, nekomata, alive - 1, cache)
    if (r < wolfMin) wolfMin = r
  }
  // 噛み先3: 狩人
  if (bodyguardAlive) {
    const r = mmSeer(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, false, nekomata, alive - 1, cache)
    if (r < wolfMin) wolfMin = r
  }
  // 噛み先4: 猫又（LW 以外）
  if (nekomata > 0 && totalWolves >= 2) {
    // 猫又 + 噛んだ狼 の両方退場。狼は grays 内優先、なければ confirmedWolves から
    const fromGrays = wolves > 0
    const r = mmSeer(
      fromGrays ? wolves - 1 : wolves, foxes,
      fromGrays ? grays - 1 : grays, confirmedVillage,
      fromGrays ? confirmedWolves : confirmedWolves - 1,
      seerAlive, mediumAlive, bodyguardAlive, nekomata - 1, alive - 2, cache,
    )
    if (r < wolfMin) wolfMin = r
  }
  // 噛み先5: グレー内の通常村人（非狼非狐）
  if (grays - wolves - foxes > 0) {
    const r = mmSeer(wolves, foxes, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache)
    if (r < wolfMin) wolfMin = r
  }
  // 噛み先6: 確定白村人
  if (confirmedVillage > 0) {
    const r = mmSeer(wolves, foxes, grays, confirmedVillage - 1, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache)
    if (r < wolfMin) wolfMin = r
  }

  if (wolfMin > 1.0) return 1.0 // 有効な噛み先なし（終端条件で本来捕捉される）

  // 狩人護衛: ランダム護衛で狼の最善手をブロックする確率
  if (bodyguardAlive && alive - totalWolves > 1) {
    const pBlock = 1 / (alive - totalWolves)
    // ブロック時: 噛みなし、占い師のみ行動
    const rateBlocked = mmSeer(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive, cache)
    wolfMin = wolfMin + pBlock * Math.max(0, rateBlocked - wolfMin)
  }

  return wolfMin
}

/**
 * 占い師の夜行動を確率的に適用して翌日の minimaxWinRate を返す。
 * seerAlive=false なら即 minimaxWinRate へ。
 * grays=0 なら占い対象なし → 即 minimaxWinRate へ。
 *
 * 占い結果:
 *   P(狼) = wolves/grays → confirmedWolves+1, wolves-1, grays-1 (alive 不変)
 *   P(狐) = foxes/grays  → foxes-1, grays-1, alive-1 (呪殺)
 *   P(人) = rest/grays   → confirmedVillage+1, grays-1 (alive 不変)
 */
function mmSeer(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, _alive: number, cache: Map<number, number>,
): number {
  if (!seerAlive || grays === 0) {
    return minimaxWinRate(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
  }

  const pWolf = wolves / grays
  const pFox = foxes / grays
  const pHuman = 1 - pWolf - pFox
  let expected = 0

  if (pWolf > 0) {
    // 狼発見: grays→confirmedWolves へ移動（alive 不変、翌日確実処刑）
    expected += pWolf * minimaxWinRate(wolves - 1, foxes, grays - 1, confirmedVillage, confirmedWolves + 1, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
  }
  if (pFox > 0) {
    // 狐呪殺: 狐退場（alive-1 は minimaxWinRate が再計算）
    expected += pFox * minimaxWinRate(wolves, foxes - 1, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
  }
  if (pHuman > 0) {
    // 白確定: grays→confirmedVillage へ移動（alive 不変）
    expected += pHuman * minimaxWinRate(wolves, foxes, grays - 1, confirmedVillage + 1, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
  }

  return expected
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
