/**
 * 狐視点の minimax 勝率計算。
 *
 * 既存 winrate.ts の minimaxWinRate と同じ抽象状態で動くが、
 * 村勝率ではなく**狐勝率** P(hamster_won) を返す。
 *
 * 終局判定 (hati の checkOutcome 規約):
 *   - wolves == 0 かつ hamster 生存 → hamster_win
 *   - wolves == 0 かつ hamster 不在 → village_win
 *   - 2*wolves + hamster >= alive (PP) かつ hamster 生存 → hamster_win
 *   - 2*wolves >= alive (PP) かつ hamster 不在 → wolf_win
 *
 * minimax プレイ:
 *   - 日: 村 MAX village_winrate を選び、その分岐の hamster_winrate を返す
 *   - 夜: 狼 MIN village_winrate を選び、その分岐の hamster_winrate を返す
 *   - 占い: 確率的（gray 内ランダム） — 全分岐の期待値
 */

const memoCache = new Map<number, number>()

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

/**
 * 夜フェーズ開始から minimax で狐勝率を計算する。
 * 抽象状態 inputs:
 *   wolves, foxes, grays, confirmedVillage, confirmedWolves
 *   seerAlive, mediumAlive, bodyguardAlive, nekomata
 *
 * Returns: P(hamster_won)
 */
export function minimaxNightHamsterRate(
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

  if (totalWolves === 0) return foxes > 0 ? 1.0 : 0.0
  if (2 * totalWolves + foxes >= alive) return foxes > 0 ? 1.0 : 0.0

  const c = cache ?? memoCache
  return mmNight(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive, c)
}

/** 日フェーズ: 村 MAX village_winrate を選び、hamster_winrate を返す */
function mmDay(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, _alive: number, cache: Map<number, number>,
): number {
  // 村は MAX village_winrate を選ぶが、ここでは hamster_winrate を返す。
  // 簡略化: 「村の最善 = 確定狼処刑があればそれ、なければグレーランダム」と仮定し
  // その分岐の hamster_winrate を返す。
  // 確定狼処刑時は狼を確実に減らせるので狐にとっても良い面がある。

  if (confirmedWolves > 0) {
    return mmNightCached(wolves, foxes, grays, confirmedVillage, confirmedWolves - 1, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
  }

  if (grays > 0) {
    const pWolf = wolves / grays
    const pFox = foxes / grays
    const pHuman = 1 - pWolf - pFox
    let rate = 0
    if (pWolf > 0) rate += pWolf * mmNightCached(wolves - 1, foxes, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
    if (pFox > 0) rate += pFox * mmNightCached(wolves, foxes - 1, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
    if (pHuman > 0) rate += pHuman * mmNightCached(wolves, foxes, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
    return rate
  }

  return 0
}

function mmNightCached(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, cache: Map<number, number>,
): number {
  const totalWolves = wolves + confirmedWolves
  const alive = grays + confirmedVillage + confirmedWolves
    + (seerAlive ? 1 : 0) + (mediumAlive ? 1 : 0) + (bodyguardAlive ? 1 : 0) + nekomata

  if (totalWolves === 0) return foxes > 0 ? 1.0 : 0.0
  if (2 * totalWolves + foxes >= alive) return foxes > 0 ? 1.0 : 0.0

  const key = mmKey(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const result = mmNight(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive, cache)
  cache.set(key, result)
  return result
}

/**
 * 夜フェーズ: 狼 MIN village_winrate を選ぶ → その分岐の hamster_winrate を返す。
 *
 * 狼は村にとって最悪の噛み先を選ぶ（占い・霊媒・狩人優先）。
 * 村にとって最悪 ≠ 狐にとって最良 とは限らないので、狐勝率は村の最善とは独立にトラックする。
 */
function mmNight(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, alive: number, cache: Map<number, number>,
): number {
  const totalWolves = wolves + confirmedWolves
  if (totalWolves === 0) return foxes > 0 ? 1.0 : 0.0
  if (2 * totalWolves + foxes >= alive) return foxes > 0 ? 1.0 : 0.0

  // 狼の各噛み先候補を村勝率で評価し、最小（狼にとって最良）を選ぶ。
  // その候補の hamster_winrate を返す。
  type Branch = { villageRate: number, hamsterRate: number }
  const branches: Branch[] = []

  if (seerAlive) {
    branches.push(seerBranch(wolves, foxes, grays, confirmedVillage, confirmedWolves, false, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache))
  }
  if (mediumAlive) {
    branches.push(seerBranch(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, false, bodyguardAlive, nekomata, alive - 1, cache))
  }
  if (bodyguardAlive) {
    branches.push(seerBranch(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, false, nekomata, alive - 1, cache))
  }
  if (nekomata > 0 && totalWolves >= 2) {
    const fromGrays = wolves > 0
    branches.push(seerBranch(
      fromGrays ? wolves - 1 : wolves, foxes,
      fromGrays ? grays - 1 : grays, confirmedVillage,
      fromGrays ? confirmedWolves : confirmedWolves - 1,
      seerAlive, mediumAlive, bodyguardAlive, nekomata - 1, alive - 2, cache,
    ))
  }
  if (grays - wolves - foxes > 0) {
    branches.push(seerBranch(wolves, foxes, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache))
  }
  if (confirmedVillage > 0) {
    branches.push(seerBranch(wolves, foxes, grays, confirmedVillage - 1, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive - 1, cache))
  }

  if (branches.length === 0) return foxes > 0 ? 1.0 : 0.0

  // 狼は villageRate を最小化する候補を選ぶ
  let bestVillageRate = 2.0
  let chosenHamsterRate = 0
  for (const b of branches) {
    if (b.villageRate < bestVillageRate) {
      bestVillageRate = b.villageRate
      chosenHamsterRate = b.hamsterRate
    }
  }
  return chosenHamsterRate
}

/** 占い師の確率的分岐を含む遷移。村勝率と狐勝率を同時に返す */
function seerBranch(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, _alive: number, cache: Map<number, number>,
): { villageRate: number, hamsterRate: number } {
  if (!seerAlive || grays === 0) {
    const villageRate = villageWinRateAfterDay(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
    const hamsterRate = hamsterWinRateAfterDay(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
    return { villageRate, hamsterRate }
  }

  const pWolf = wolves / grays
  const pFox = foxes / grays
  const pHuman = 1 - pWolf - pFox
  let villageRate = 0
  let hamsterRate = 0

  if (pWolf > 0) {
    villageRate += pWolf * villageWinRateAfterDay(wolves - 1, foxes, grays - 1, confirmedVillage, confirmedWolves + 1, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
    hamsterRate += pWolf * hamsterWinRateAfterDay(wolves - 1, foxes, grays - 1, confirmedVillage, confirmedWolves + 1, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
  }
  if (pFox > 0) {
    villageRate += pFox * villageWinRateAfterDay(wolves, foxes - 1, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
    hamsterRate += pFox * hamsterWinRateAfterDay(wolves, foxes - 1, grays - 1, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
  }
  if (pHuman > 0) {
    villageRate += pHuman * villageWinRateAfterDay(wolves, foxes, grays - 1, confirmedVillage + 1, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
    hamsterRate += pHuman * hamsterWinRateAfterDay(wolves, foxes, grays - 1, confirmedVillage + 1, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
  }
  return { villageRate, hamsterRate }
}

// 既存 winrate.ts の minimaxWinRate を呼ぶ（村勝率取得）
import { minimaxWinRate } from './winrate.ts'

function villageWinRateAfterDay(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, cache: Map<number, number>,
): number {
  return minimaxWinRate(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, cache)
}

function hamsterWinRateAfterDay(
  wolves: number, foxes: number, grays: number,
  confirmedVillage: number, confirmedWolves: number,
  seerAlive: boolean, mediumAlive: boolean, bodyguardAlive: boolean,
  nekomata: number, cache: Map<number, number>,
): number {
  const totalWolves = wolves + confirmedWolves
  const alive = grays + confirmedVillage + confirmedWolves
    + (seerAlive ? 1 : 0) + (mediumAlive ? 1 : 0) + (bodyguardAlive ? 1 : 0) + nekomata

  if (totalWolves === 0) return foxes > 0 ? 1.0 : 0.0
  if (2 * totalWolves + foxes >= alive) return foxes > 0 ? 1.0 : 0.0

  return mmDay(wolves, foxes, grays, confirmedVillage, confirmedWolves, seerAlive, mediumAlive, bodyguardAlive, nekomata, alive, cache)
}
