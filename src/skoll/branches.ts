/**
 * CO 構造分析と世界分岐の構築。
 *
 * VillageStatus から占いCO者を抽出し、「誰が真占いか」の
 * 仮説ごとに Branch を生成する。各 Branch 内で全 seat を
 * confirmed_wolf / confirmed_village / gray / dead に分類する。
 */

import type { VillageStatus, SystemRole, Seat } from '../types/index.ts'
import type { Branch, SeatClassification, SeatCategory } from './types.ts'

/** Retar の分析結果: seat → ありえる役職の集合 */
export type SeatPossibilityMap = Map<Seat, Set<SystemRole>>

type ClaimantInfo = {
  seat: Seat
  assertions: { target: Seat, species: 'human' | 'wolf' }[]
}

/**
 * VillageStatus から占いCO者の情報を抽出する。
 */
export function extractSeerClaims(vs: VillageStatus): ClaimantInfo[] {
  const claimants: ClaimantInfo[] = []
  for (const [seat, status] of vs.statuses) {
    if (!status.claiming || status.claimingRole !== 'seer') continue
    const assertions: ClaimantInfo['assertions'] = []
    for (const [, assertion] of status.assertions) {
      if (assertion.species === 'human' || assertion.species === 'wolf') {
        assertions.push({ target: assertion.target, species: assertion.species })
      }
    }
    claimants.push({ seat, assertions })
  }
  return claimants
}

/**
 * VillageStatus から共有CO者を抽出する。
 */
function extractMasonClaims(vs: VillageStatus, setup: Map<SystemRole, number>): Set<Seat> {
  const masonSlots = setup.get('mason') ?? 0
  if (masonSlots === 0) return new Set()

  const masonClaimants: Seat[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.claiming && status.claimingRole === 'mason') {
      masonClaimants.push(seat)
    }
  }

  // 共有COが枠数以内なら全員確定村
  if (masonClaimants.length <= masonSlots) {
    return new Set(masonClaimants)
  }
  // 枠数を超えてCOしている場合は信用しない（v1簡略化）
  return new Set()
}

/** 人狼陣営の役職 */
const WOLF_SIDE_ROLES: SystemRole[] = ['werewolf', 'possessed', 'fanatic']

/**
 * 全 seat を分類する。
 *
 * 情報源の優先順:
 * 1. 真占いの黒結果 → confirmed_wolf
 * 2. 真占いの白結果 / 共有CO / 真占い自身 → confirmed_village
 * 3. Retar が werewolf を排除 → confirmed_village
 * 4. Retar が村陣営を全排除（wolf/possessed/fanatic のみ）→ confirmed_wolf
 * 5. それ以外 → gray
 *
 * @param retarPossibilities - Retar の分析結果（省略時は占い結果 + 共有のみで分類）
 */
export function classifySeats(
  trueSeerSeat: Seat | null,
  trueAssertions: ClaimantInfo['assertions'],
  masonSeats: Set<Seat>,
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  retarPossibilities?: SeatPossibilityMap,
): SeatClassification {
  const categories = new Map<Seat, SeatCategory>()
  const totalWolves = setup.get('werewolf') ?? 0

  // 真占いの結果から確定情報を構築
  const confirmedWolfSeats = new Set<Seat>()
  const confirmedVillageSeats = new Set<Seat>()

  for (const { target, species } of trueAssertions) {
    if (species === 'wolf') {
      confirmedWolfSeats.add(target)
    } else {
      confirmedVillageSeats.add(target)
    }
  }

  // 真占い自身は確定村
  if (trueSeerSeat !== null) {
    confirmedVillageSeats.add(trueSeerSeat)
  }

  // 共有は確定村
  for (const seat of masonSeats) {
    confirmedVillageSeats.add(seat)
  }

  // 全 seat を分類
  let grayCount = 0
  let confirmedVillageCount = 0
  let confirmedWolfCount = 0
  let totalAlive = 0

  for (const [seat, status] of vs.statuses) {
    if (!status.surviving) {
      categories.set(seat, 'dead')
      continue
    }

    totalAlive++

    if (confirmedWolfSeats.has(seat)) {
      categories.set(seat, 'confirmed_wolf')
      confirmedWolfCount++
    } else if (confirmedVillageSeats.has(seat)) {
      categories.set(seat, 'confirmed_village')
      confirmedVillageCount++
    } else if (retarPossibilities) {
      // Retar の possibilities で分類を補強
      const roles = retarPossibilities.get(seat)
      if (roles && !roles.has('werewolf')) {
        // 狼がありえない → 確定村側
        categories.set(seat, 'confirmed_village')
        confirmedVillageCount++
      } else if (roles && [...roles].every(r => WOLF_SIDE_ROLES.includes(r))) {
        // 村陣営の可能性がゼロ → 確定敵（狼扱い）
        categories.set(seat, 'confirmed_wolf')
        confirmedWolfCount++
      } else {
        categories.set(seat, 'gray')
        grayCount++
      }
    } else {
      categories.set(seat, 'gray')
      grayCount++
    }
  }

  // グレー内の狼数 = 総狼数 - 確定狼（生存+死亡）
  let deadConfirmedWolves = 0
  for (const seat of confirmedWolfSeats) {
    const status = vs.statuses.get(seat)
    if (status && !status.surviving) {
      deadConfirmedWolves++
    }
  }
  // Retar 由来の confirmed_wolf も死亡者をカウント
  if (retarPossibilities) {
    for (const [seat, status] of vs.statuses) {
      if (status.surviving) continue
      if (confirmedWolfSeats.has(seat)) continue // 既にカウント済み
      const roles = retarPossibilities.get(seat)
      if (roles && [...roles].every(r => WOLF_SIDE_ROLES.includes(r)) && roles.has('werewolf')) {
        deadConfirmedWolves++
      }
    }
  }
  const wolvesInGray = Math.max(0, totalWolves - confirmedWolfCount - deadConfirmedWolves)

  return {
    categories,
    grayCount,
    wolvesInGray,
    confirmedVillageCount,
    confirmedWolfCount,
    totalAlive,
    trueSeerSeat,
  }
}

/**
 * VillageStatus と setup から CO 構造を分析し、世界分岐を構築する。
 *
 * 占いCO が2人で枠1の場合、2つの分岐（A真/B真）を返す。
 * CO がない場合は全員グレーの単一分岐を返す。
 *
 * @param retarPossibilities - Retar の分析結果。指定すると seer がありえない
 *   seat の分岐を除外し、seer 確率で重み付けする。
 */
export function buildBranches(
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  retarPossibilities?: SeatPossibilityMap,
): Branch[] {
  const seerClaims = extractSeerClaims(vs)
  const masonSeats = extractMasonClaims(vs, setup)
  const seerSlots = setup.get('seer') ?? 0

  // CO なし or 枠なし → 全員グレーの単一分岐
  if (seerClaims.length === 0 || seerSlots === 0) {
    return [buildNoCOBranch(masonSeats, vs, setup, retarPossibilities)]
  }

  // 占いCO が枠数以内 → 全員真の単一分岐
  if (seerClaims.length <= seerSlots) {
    // 全員の assertions を統合
    const allAssertions = seerClaims.flatMap(c => c.assertions)
    const classification = classifySeats(
      seerClaims[0].seat, allAssertions, masonSeats, vs, setup, retarPossibilities,
    )
    // trueSeerSeat は最初の一人を代表とする（v1簡略化）
    return [{
      trueSeer: seerClaims[0].seat,
      fakeSeats: [],
      classification,
      weight: 1.0,
    }]
  }

  // 占いCO > 枠数 → C(N, K) 個の分岐を生成
  // v1: K=1 の場合のみ対応（N 個の分岐）

  // Retar の possibilities で seer がありえる claimant だけに絞る
  const validClaims = retarPossibilities
    ? seerClaims.filter(c => {
      const roles = retarPossibilities.get(c.seat)
      return roles !== undefined && roles.has('seer')
    })
    : seerClaims

  // 全員排除された場合はフォールバック（全 claimant を使う）
  const effectiveClaims = validClaims.length > 0 ? validClaims : seerClaims

  // 重みを Retar の seer ありえる数で均等割り（確率分布は Step 1 で精密化可能）
  const branches: Branch[] = []
  const weight = 1 / effectiveClaims.length

  for (let i = 0; i < effectiveClaims.length; i++) {
    const trueClaim = effectiveClaims[i]
    // fakeSeats は全 seer claimant のうち trueClaim 以外
    const fakeSeats = seerClaims
      .filter(c => c.seat !== trueClaim.seat)
      .map(c => c.seat)

    const classification = classifySeats(
      trueClaim.seat, trueClaim.assertions, masonSeats, vs, setup, retarPossibilities,
    )

    branches.push({
      trueSeer: trueClaim.seat,
      fakeSeats,
      classification,
      weight,
    })
  }

  return branches
}

/**
 * CO なしの場合の分岐を構築する。
 * 共有以外の全生存者がグレーになる。
 */
function buildNoCOBranch(
  masonSeats: Set<Seat>,
  vs: VillageStatus,
  setup: Map<SystemRole, number>,
  retarPossibilities?: SeatPossibilityMap,
): Branch {
  const classification = classifySeats(null, [], masonSeats, vs, setup, retarPossibilities)
  return {
    trueSeer: null,
    fakeSeats: [],
    classification,
    weight: 1.0,
  }
}
