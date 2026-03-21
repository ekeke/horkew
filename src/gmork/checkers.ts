import type { SystemRole, Seat, VillageStatus, Day } from '../types/index.ts'
import type { Checker, CheckerInput, DenialReason } from './reasons.ts'
import { villageSpecialRoles, villageSideRoles, evilRoles } from './reasons.ts'
import type { AnalysisResult } from './analysis.ts'
import { isTrustworthy } from './analysis.ts'

// ── CO constraint: 村役職COは他の村役職を否定 ──────────────────────

function checkCoImpliesNotOtherVillageRole({ status, role }: CheckerInput): DenialReason | null {
  if (!status.claiming) return null
  const claimed = status.claimingRole as SystemRole
  if (!villageSpecialRoles.includes(claimed)) return null
  if (claimed === role) return null
  // 村役職COは他の村役職と村人を否定（真なら村人ではない、偽なら人外で村人ではない）
  if (role === 'villager' || villageSpecialRoles.includes(role)) {
    return { type: 'co_implies_not_other_village_role', claimedRole: claimed }
  }
  return null
}

// ── Tier 0: Analysis-based (confirmed roles from Retar) ────────────

function checkConfirmedSeerResult({ village, analysis, seat, role, players }: CheckerInput): DenialReason | null {
  if (!analysis?.seer.confirmed) return null

  const seerSeat = analysis.seer.confirmed
  const seerName = players?.get(seerSeat) ?? `${seerSeat}`
  const seerStatus = village.statuses.get(seerSeat)
  if (!seerStatus) return null

  for (const [night, { target, species }] of seerStatus.assertions) {
    if (night < 0 || target !== seat) continue
    if (species === 'human' && role === 'werewolf') {
      return { type: 'confirmed_seer_white', seerSeat, seerName, night }
    }
    if (species === 'wolf' && role !== 'werewolf') {
      return { type: 'confirmed_seer_black', seerSeat, seerName, night }
    }
  }
  return null
}

function checkConfirmedMediumResult({ village, analysis, seat, role, players }: CheckerInput): DenialReason | null {
  if (!analysis?.medium.confirmed) return null

  const mediumSeat = analysis.medium.confirmed
  const mediumName = players?.get(mediumSeat) ?? `${mediumSeat}`
  const mediumStatus = village.statuses.get(mediumSeat)
  if (!mediumStatus) return null

  for (const [night, { target, species }] of mediumStatus.assertions) {
    if (night < 0 || target !== seat) continue
    if (species === 'human' && role === 'werewolf') {
      return { type: 'confirmed_medium_white', mediumSeat, mediumName, night }
    }
    if (species === 'wolf' && role !== 'werewolf') {
      return { type: 'confirmed_medium_black', mediumSeat, mediumName, night }
    }
  }
  return null
}

function checkConfirmedRoleHolderExists({ village, setup, analysis, seat, role, status, players }: CheckerInput): DenialReason | null {
  if (!analysis) return null

  // seer/medium CO者: analysis の破綻判定経由で確定者を探す
  if (status.claiming && status.claimingRole === role) {
    const roleAnalysis =
      role === 'seer' ? analysis.seer :
      role === 'medium' ? analysis.medium :
      null
    if (roleAnalysis) {
      if (roleAnalysis.confirmed != null && roleAnalysis.confirmed !== seat) {
        const confirmedName = players?.get(roleAnalysis.confirmed) ?? `${roleAnalysis.confirmed}`
        return { type: 'confirmed_role_holder_exists', confirmedSeat: roleAnalysis.confirmed, confirmedName, confirmedRole: role }
      }
      return null
    }
  }

  // 汎用: retar の confirmed roles からスロットが埋まっているか確認
  const slots = setup.get(role) || 0
  if (slots <= 0) return null

  let filledCount = 0
  let lastConfirmedSeat: Seat | null = null
  for (const [s, confirmedRole] of analysis.confirmed) {
    if (s !== seat && confirmedRole === role) {
      filledCount++
      lastConfirmedSeat = s
    }
  }
  if (filledCount >= slots && lastConfirmedSeat != null) {
    const confirmedName = players?.get(lastConfirmedSeat) ?? `${lastConfirmedSeat}`
    return { type: 'confirmed_role_holder_exists', confirmedSeat: lastConfirmedSeat, confirmedName, confirmedRole: role }
  }
  return null
}

function checkSeerClaimContradicted({ analysis, seat, role }: CheckerInput): DenialReason | null {
  if (!analysis || role !== 'seer') return null
  const bustReason = analysis.seer.busted.get(seat)
  if (bustReason) return { type: 'seer_claim_contradicted', bustReason }
  return null
}

function checkMediumClaimContradicted({ analysis, seat, role }: CheckerInput): DenialReason | null {
  if (!analysis || role !== 'medium') return null
  const bustReason = analysis.medium.busted.get(seat)
  if (bustReason) return { type: 'medium_claim_contradicted', bustReason }
  return null
}

// ── Tier 1: Direct inference ────────────────────────────────────────

function checkNotInSetup({ setup, role }: CheckerInput): DenialReason | null {
  if (!setup.has(role) || setup.get(role) === 0) {
    return { type: 'not_in_setup' }
  }
  return null
}

function checkNoHamsterNoImmoralist({ setup, role }: CheckerInput): DenialReason | null {
  if (role === 'immoralist' && (!setup.has('werehamster') || setup.get('werehamster') === 0)) {
    return { type: 'no_hamster_no_immoralist' }
  }
  return null
}

function checkCursedByNekomata({ status, role }: CheckerInput): DenialReason | null {
  // 猫又が夜に噛まれた場合のみ人狼確定（噛んだ人狼が道連れ）
  // 猫又が処刑された場合は対象がランダムなので人狼確定にならない
  if (
    status.causeOfDeath === 'cursed_by_killed_nekomata' &&
    !status.surviving &&
    role !== 'werewolf'
  ) {
    return { type: 'cursed_by_nekomata' }
  }
  return null
}

function checkFollowHamster({ status, role }: CheckerInput): DenialReason | null {
  if (
    (status.causeOfDeath === 'follow_executed_hamster' ||
     status.causeOfDeath === 'follow_killed_hamster') &&
    !status.surviving &&
    role !== 'immoralist'
  ) {
    return { type: 'follow_hamster' }
  }
  return null
}

function checkSoleNightKill({ village, status, role }: CheckerInput): DenialReason | null {
  if (
    role === 'werewolf' &&
    !status.surviving &&
    status.causeOfDeath === 'night_kill' &&
    status.diedDay != null
  ) {
    const nightDeaths = village.kills.get(status.diedDay) || []
    if (nightDeaths.length === 1) {
      return { type: 'sole_night_kill', night: status.diedDay }
    }
  }
  return null
}

function checkVillagerCo({ status, role }: CheckerInput): DenialReason | null {
  if (status.claimingRole === 'villager' && villageSpecialRoles.includes(role)) {
    return { type: 'villager_co' }
  }
  return null
}

function checkSurrenderCo({ status, role }: CheckerInput): DenialReason | null {
  if (status.claimingRole === 'surrender' && villageSideRoles.includes(role)) {
    return { type: 'surrender_co' }
  }
  return null
}

function checkSilentExecution({ status, role }: CheckerInput): DenialReason | null {
  if (
    !status.surviving &&
    status.causeOfDeath === 'execution' &&
    !status.claiming &&
    villageSpecialRoles.includes(role)
  ) {
    return { type: 'silent_execution' }
  }
  return null
}

function checkDeniedByNegativeCo({ status, role }: CheckerInput): DenialReason | null {
  if (status.deniedRoles.includes(role)) {
    return { type: 'denied_by_negative_co' }
  }
  return null
}

// ── Tier 2: Simple combination ──────────────────────────────────────

function checkSeerBlack({ village, analysis, seat, role, players }: CheckerInput): DenialReason | null {
  if (role === 'werewolf') return null
  const result = collectSeerConsensus(village, analysis, seat, 'wolf', players)
  if (!result) return null
  return { type: 'seer_black', claimants: result }
}

function checkSeerWhite({ village, analysis, seat, role, players }: CheckerInput): DenialReason | null {
  if (role !== 'werewolf') return null
  const result = collectSeerConsensus(village, analysis, seat, 'human', players)
  if (!result) return null
  return { type: 'seer_white', claimants: result }
}

/** 破綻していない占い師候補全員が同じ結果を出しているか確認 */
function collectSeerConsensus(
  village: VillageStatus,
  analysis: AnalysisResult | null,
  seat: Seat,
  species: 'human' | 'wolf',
  players: Map<number, string> | undefined,
): { name: string, night: Day }[] | null {
  const seerClaimants = (village.claims.get('seer') || []) as Seat[]
  const eligible: Seat[] = []
  for (const seerSeat of seerClaimants) {
    if (analysis && !isTrustworthy(seerSeat, 'seer', analysis.confirmed)) continue
    if (analysis?.seer.busted.has(seerSeat)) continue
    eligible.push(seerSeat)
  }
  if (eligible.length === 0) return null

  const matches: { name: string, night: Day }[] = []
  for (const seerSeat of eligible) {
    const seerStatus = village.statuses.get(seerSeat)!
    let found = false
    for (const [night, { target, species: sp }] of seerStatus.assertions) {
      if (target === seat && sp === species) {
        matches.push({ name: players?.get(seerSeat) ?? `${seerSeat}`, night })
        found = true
        break
      }
    }
    if (!found) return null // 1人でも結果を出していなければ合意なし
  }
  return matches
}

function checkSeerFoxKill({ village, analysis, seat, status, role, players }: CheckerInput): DenialReason | null {
  if (role === 'werehamster') return null
  if (status.surviving || status.causeOfDeath !== 'night_kill' || status.diedDay == null) return null

  const nightDeaths = village.kills.get(status.diedDay) || []
  if (nightDeaths.length < 2) return null

  const seerClaimants = (village.claims.get('seer') || []) as Seat[]
  for (const seerSeat of seerClaimants) {
    if (analysis && !isTrustworthy(seerSeat, 'seer', analysis.confirmed)) continue
    if (analysis?.seer.busted.has(seerSeat)) continue
    const seerStatus = village.statuses.get(seerSeat)!
    for (const [night, { target }] of seerStatus.assertions) {
      if (target === seat && night === status.diedDay) {
        if (seerStatus.surviving || (seerStatus.diedDay != null && seerStatus.diedDay >= night)) {
          return { type: 'seer_fox_kill', seerSeat, seerName: players?.get(seerSeat) ?? `${seerSeat}`, night }
        }
      }
    }
  }
  return null
}

function checkMediumBlack({ village, analysis, seat, role, players }: CheckerInput): DenialReason | null {
  if (role === 'werewolf') return null
  const result = collectMediumConsensus(village, analysis, seat, 'wolf', players)
  if (!result) return null
  return { type: 'medium_black', claimants: result }
}

function checkMediumWhite({ village, analysis, seat, role, players }: CheckerInput): DenialReason | null {
  if (role !== 'werewolf') return null
  const result = collectMediumConsensus(village, analysis, seat, 'human', players)
  if (!result) return null
  return { type: 'medium_white', claimants: result }
}

/** 破綻していない霊媒師候補全員が同じ結果を出しているか確認 */
function collectMediumConsensus(
  village: VillageStatus,
  analysis: AnalysisResult | null,
  seat: Seat,
  species: 'human' | 'wolf',
  players: Map<number, string> | undefined,
): { name: string, night: Day }[] | null {
  const mediumClaimants = (village.claims.get('medium') || []) as Seat[]
  const eligible: Seat[] = []
  for (const mediumSeat of mediumClaimants) {
    if (analysis && !isTrustworthy(mediumSeat, 'medium', analysis.confirmed)) continue
    if (analysis?.medium.busted.has(mediumSeat)) continue
    eligible.push(mediumSeat)
  }
  if (eligible.length === 0) return null

  const matches: { name: string, night: Day }[] = []
  for (const mediumSeat of eligible) {
    const mediumStatus = village.statuses.get(mediumSeat)!
    let found = false
    for (const [night, { target, species: sp }] of mediumStatus.assertions) {
      if (target === seat && sp === species) {
        matches.push({ name: players?.get(mediumSeat) ?? `${mediumSeat}`, night })
        found = true
        break
      }
    }
    if (!found) return null
  }
  return matches
}

function checkMasonPartner({ village, seat, role, players }: CheckerInput): DenialReason | null {
  if (role === 'mason') return null
  const masonClaimants = (village.claims.get('mason') || []) as Seat[]
  for (const masonSeat of masonClaimants) {
    const masonStatus = village.statuses.get(masonSeat)!
    for (const [, { target, species }] of masonStatus.assertions) {
      if (target === seat && species === 'human') {
        return { type: 'mason_partner', masonSeat, masonName: players?.get(masonSeat) ?? `${masonSeat}` }
      }
    }
  }
  return null
}

function checkRoleSlotsFilled({ village, setup, seat, status, role }: CheckerInput): DenialReason | null {
  if (!villageSpecialRoles.includes(role)) return null
  if (status.claiming && status.claimingRole === role) return null

  const claimants = (village.claims.get(role) || []) as Seat[]
  const slots = setup.get(role) || 0
  if (slots <= 0 || claimants.length < slots) return null

  // CO前に襲撃死した非CO者には適用しない（COの機会がなかった）
  if (!status.claiming && status.causeOfDeath === 'night_kill' && status.diedDay != null) {
    let firstCoDay = Infinity
    for (const coSeat of claimants) {
      const coStatus = village.statuses.get(coSeat)
      if (coStatus?.claimedAt != null && coStatus.claimedAt < firstCoDay) {
        firstCoDay = coStatus.claimedAt
      }
    }
    if (status.diedDay < firstCoDay) return null
  }

  return { type: 'role_slots_filled', claimants }
}

function checkNekomataNoCompanion({ village, status, role }: CheckerInput): DenialReason | null {
  if (role !== 'nekomata') return null
  if (status.surviving || status.causeOfDeath !== 'night_kill' || status.diedDay == null) return null

  const nightDeaths = village.kills.get(status.diedDay) || []
  if (nightDeaths.length === 1) {
    return { type: 'nekomata_no_companion', night: status.diedDay }
  }
  return null
}

function checkAllHamstersDead({ village, setup, status, role }: CheckerInput): DenialReason | null {
  if (role !== 'immoralist') return null

  const hamsterCount = setup.get('werehamster') || 0
  if (hamsterCount === 0) return null

  const hamsterDeathDays = new Set<number>()
  for (const [, s] of village.statuses) {
    if (
      !s.surviving &&
      (s.causeOfDeath === 'follow_executed_hamster' || s.causeOfDeath === 'follow_killed_hamster') &&
      s.diedDay != null
    ) {
      hamsterDeathDays.add(s.diedDay)
    }
  }

  if (hamsterDeathDays.size < hamsterCount) return null

  const lastHamsterDiedDay = Math.max(...hamsterDeathDays)

  if (status.surviving || (status.diedDay != null && status.diedDay > lastHamsterDiedDay)) {
    return { type: 'all_hamsters_dead', lastHamsterDiedDay }
  }
  return null
}

// ── Tier 3: Chained reasoning ───────────────────────────────────────

function checkVillageWon({ village, status, role }: CheckerInput): DenialReason | null {
  if (village.result === 'villager_won' && status.surviving && role === 'werewolf') {
    return { type: 'village_won_survivor' }
  }
  return null
}

function checkLiarBudget({ village, setup, status, role }: CheckerInput): DenialReason | null {
  const coRoles: SystemRole[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata']
  const roleNameJa: Record<string, string> = {
    seer: '占い', medium: '霊媒', bodyguard: '狩人', mason: '共有', nekomata: '猫又',
    werewolf: '人狼', possessed: '狂人', fanatic: '狂信者', werehamster: '妖狐', immoralist: '背徳者',
    villager: '村人',
  }

  let evilCapacity = 0
  const evilParts: string[] = []
  for (const r of evilRoles) {
    const c = setup.get(r) || 0
    if (c > 0) { evilCapacity += c; evilParts.push(`${roleNameJa[r]}${c}`) }
  }
  if (evilRoles.includes(role)) {
    evilCapacity -= 1
  }
  if (evilCapacity < 0) return null

  let minFakes = 0
  const breakdown: { label: string, count: number }[] = []

  for (const r of coRoles) {
    const claimants = (village.claims.get(r) || []) as Seat[]
    let realSlots = setup.get(r) || 0

    if (role === r) {
      realSlots = Math.max(0, realSlots - 1)
    }

    const seatClaimsR = status.claiming && status.claimingRole === r
    let fakes: number

    if (seatClaimsR && role !== r) {
      // 自分は偽者だがevilCapacityで既に除外済みなので、他のCO者のうちの偽者のみ数える
      fakes = Math.max(0, claimants.length - 1 - realSlots)
    } else if (seatClaimsR && role === r) {
      fakes = Math.max(0, claimants.length - 1 - realSlots)
    } else {
      fakes = Math.max(0, claimants.length - realSlots)
    }

    if (fakes > 0) {
      breakdown.push({ label: `${roleNameJa[r]}の偽者(${claimants.length}CO中${realSlots}枠)に${fakes}人`, count: fakes })
      minFakes += fakes
    }
  }

  if (minFakes > evilCapacity) {
    const hypothesisLabel = `${roleNameJa[role] || role}`
    const budgetDetail = evilRoles.includes(role)
      ? `${evilParts.join('・')}から自身を除いた${evilCapacity}`
      : `${evilParts.join('・')}の計${evilCapacity}`
    return { type: 'liar_budget_exceeded', required: minFakes, available: evilCapacity, budgetDetail, hypothesisLabel, breakdown }
  }
  return null
}

// ── Tier 3: CO contradiction slot constraint ─────────────────────

type CoContradiction = {
  divinerSeat: Seat, divinerName: string, divinerRole: string,
  targetSeat: Seat, targetName: string, targetRole: string,
}

/**
 * CO間矛盾を検出: 占い/霊媒COの結果が他の村役職CO者を黒判定
 */
function detectCoContradictions(
  village: VillageStatus,
  allCoSeats: Set<Seat>,
  players: Map<number, string> | undefined,
): CoContradiction[] {
  const contradictions: CoContradiction[] = []
  const divinerRoles: SystemRole[] = ['seer', 'medium']
  for (const divinerRole of divinerRoles) {
    const diviners = (village.claims.get(divinerRole) || []) as Seat[]
    for (const divinerSeat of diviners) {
      const divinerStatus = village.statuses.get(divinerSeat)
      if (!divinerStatus) continue
      for (const [, assertion] of divinerStatus.assertions) {
        if (assertion.species !== 'wolf') continue
        if (!allCoSeats.has(assertion.target) || assertion.target === divinerSeat) continue
        const targetStatus = village.statuses.get(assertion.target)
        if (!targetStatus?.claiming) continue
        const targetRole = targetStatus.claimingRole
        if (!villageSpecialRoles.includes(targetRole as SystemRole)) continue
        contradictions.push({
          divinerSeat,
          divinerName: players?.get(divinerSeat) ?? `${divinerSeat}`,
          divinerRole,
          targetSeat: assertion.target,
          targetName: players?.get(assertion.target) ?? `${assertion.target}`,
          targetRole,
        })
      }
    }
  }
  return contradictions
}

/**
 * 非CO候補が特定の役職セットをいくつ埋められるか計算
 */
type CandidateFillingResult = {
  maxFilling: number
  excludedCandidates: { name: string }[]
}

function countCandidateFillingForRoles(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
  seat: Seat,
  allCoSeats: Set<Seat>,
  targetRoles: SystemRole[],
  analysis: AnalysisResult | null,
  possibilities: Map<Seat, Set<SystemRole>> | undefined,
  players: Map<number, string> | undefined,
): CandidateFillingResult {
  const candidates: SystemRole[][] = []
  const excludedCandidates: { name: string }[] = []
  for (const [s, st] of village.statuses) {
    if (s === seat || allCoSeats.has(s)) continue
    const name = players?.get(s) ?? `${s}`

    // 非村役職確定は除外
    if (analysis) {
      const confirmed = analysis.confirmed.get(s)
      if (confirmed && !villageSpecialRoles.includes(confirmed)) continue
    }
    if (!st.surviving) {
      if (st.causeOfDeath === 'cursed_by_killed_nekomata') continue
      if (st.causeOfDeath === 'cursed_by_executed_nekomata') continue
      if (st.causeOfDeath === 'follow_executed_hamster' || st.causeOfDeath === 'follow_killed_hamster') continue
      if (st.causeOfDeath === 'execution' && !st.claiming) continue
    }
    if (st.claiming && (st.claimingRole === 'surrender' || st.claimingRole === 'villager')) continue

    // この候補が就ける対象役職を特定
    let fillable: SystemRole[]
    const playerPoss = possibilities?.get(s)
    if (playerPoss) {
      fillable = targetRoles.filter(r => playerPoss.has(r))
    } else {
      fillable = targetRoles.filter(r =>
        (setup.get(r) || 0) > 0 && !(st.deniedRoles && st.deniedRoles.includes(r))
      )
    }
    if (fillable.length === 0) {
      // 対象役職を埋められない死亡非CO候補 → 除外リストに追加（生存者は自明なので省略）
      if (!st.surviving) {
        excludedCandidates.push({ name })
      }
      continue
    }
    candidates.push(fillable)
  }

  // 二部マッチング
  const slots: SystemRole[] = []
  for (const r of targetRoles) {
    const count = setup.get(r) || 0
    for (let i = 0; i < count; i++) slots.push(r)
  }
  const matchSlot: number[] = new Array(slots.length).fill(-1)
  let matched = 0
  for (let ci = 0; ci < candidates.length; ci++) {
    const visited = new Set<number>()
    if (augmentMatch(ci, candidates, slots, matchSlot, visited)) matched++
  }
  return { maxFilling: matched, excludedCandidates }
}

function augmentMatch(
  ci: number,
  candidates: SystemRole[][],
  slots: SystemRole[],
  matchSlot: number[],
  visited: Set<number>,
): boolean {
  for (let si = 0; si < slots.length; si++) {
    if (visited.has(si)) continue
    if (!candidates[ci].includes(slots[si])) continue
    visited.add(si)
    if (matchSlot[si] === -1 || augmentMatch(matchSlot[si], candidates, slots, matchSlot, visited)) {
      matchSlot[si] = ci
      return true
    }
  }
  return false
}

/**
 * 2役職版: 占い/霊媒COが他の村役職COに黒判定 → どちらかが偽者 → 空いた枠を埋める候補がいなければ否定
 */
function checkContradictionPairSlot({ village, setup, seat, role, analysis, players, possibilities }: CheckerInput): DenialReason | null {
  if (villageSpecialRoles.includes(role)) return null

  const allCoSeats = new Set<Seat>()
  for (const r of villageSpecialRoles) {
    for (const s of (village.claims.get(r) || []) as Seat[]) allCoSeats.add(s)
  }

  const contradictions = detectCoContradictions(village, allCoSeats, players)
  if (contradictions.length === 0) return null

  // 各矛盾ペアについて個別にチェック
  for (const c of contradictions) {
    // overageで矛盾が吸収される場合はスキップ
    // いずれかの役職でCO数 > 枠数なら、その偽者で矛盾を説明できる
    const dRole = c.divinerRole as SystemRole
    const tRole = c.targetRole as SystemRole
    const dCOs = ((village.claims.get(dRole) || []) as Seat[]).length
    const dSlots = setup.get(dRole) || 0
    const tCOs = ((village.claims.get(tRole) || []) as Seat[]).length
    const tSlots = setup.get(tRole) || 0
    if (dCOs > dSlots || tCOs > tSlots) continue

    const pairRoles = [dRole, tRole]
    const uniqueRoles = [...new Set(pairRoles)]

    // 対象プレイヤーがこれらの役職のどちらかになれるか確認
    const targetPoss = possibilities?.get(seat)
    if (targetPoss && !uniqueRoles.some(r => targetPoss.has(r))) continue

    const { maxFilling, excludedCandidates } = countCandidateFillingForRoles(
      village, setup, seat, allCoSeats, uniqueRoles, analysis, possibilities, players,
    )
    // 矛盾により最低1つの空きが発生。候補が0ならtargetが埋めなければならない
    if (maxFilling < 1) {
      const roleSlots = uniqueRoles.map(r => ({ role: r, slots: setup.get(r) || 0 }))
      return {
        type: 'co_contradiction_pair_slot',
        divinerName: c.divinerName, divinerRole: c.divinerRole,
        targetName: c.targetName, targetRole: c.targetRole,
        maxFilling, roleSlots, excludedCandidates,
      }
    }
  }
  return null
}

/**
 * 3役職版: 占い/霊媒COが異なる2つの村役職COに黒判定 → 最低1つの空き → 候補不足なら否定
 */
function checkContradictionTripleSlot({ village, setup, seat, role, analysis, players, possibilities }: CheckerInput): DenialReason | null {
  if (villageSpecialRoles.includes(role)) return null

  const allCoSeats = new Set<Seat>()
  for (const r of villageSpecialRoles) {
    for (const s of (village.claims.get(r) || []) as Seat[]) allCoSeats.add(s)
  }

  const contradictions = detectCoContradictions(village, allCoSeats, players)
  if (contradictions.length < 2) return null

  // 同じ判定元が2つ以上の異なる役職COに黒を出しているケースを探す
  const byDiviner = new Map<Seat, CoContradiction[]>()
  for (const c of contradictions) {
    const list = byDiviner.get(c.divinerSeat) || []
    list.push(c)
    byDiviner.set(c.divinerSeat, list)
  }

  for (const [, divinerContradictions] of byDiviner) {
    if (divinerContradictions.length < 2) continue

    // この判定元が黒を出した対象のCO役職を集める
    const allRolesSet = new Set<SystemRole>()
    allRolesSet.add(divinerContradictions[0].divinerRole as SystemRole)
    for (const c of divinerContradictions) {
      allRolesSet.add(c.targetRole as SystemRole)
    }
    if (allRolesSet.size < 3) continue

    // overageで矛盾が吸収される場合はスキップ
    // 判定元の役職にoverageがあれば、判定元が偽者で矛盾を全て説明できる
    const dRole = divinerContradictions[0].divinerRole as SystemRole
    const dCOs = ((village.claims.get(dRole) || []) as Seat[]).length
    const dSlots = setup.get(dRole) || 0
    if (dCOs > dSlots) continue
    // 対象側のoverageも確認（全対象のうち1つでもoverageがあれば吸収可能）
    let anyTargetOverage = false
    for (const c of divinerContradictions) {
      const tRole = c.targetRole as SystemRole
      const tCOs = ((village.claims.get(tRole) || []) as Seat[]).length
      const tSlots = setup.get(tRole) || 0
      if (tCOs > tSlots) { anyTargetOverage = true; break }
    }
    if (anyTargetOverage) continue

    const tripleRoles = [...allRolesSet]

    // 判定元が真なら対象CO全員が偽者（vacancies = 対象数）
    // 判定元が偽なら判定元の役職が空く（vacancies = 1）
    // 最低vacancies = 1
    const minVacancies = 1

    const targetPoss = possibilities?.get(seat)
    if (targetPoss && !tripleRoles.some(r => targetPoss.has(r))) continue

    const { maxFilling, excludedCandidates } = countCandidateFillingForRoles(
      village, setup, seat, allCoSeats, tripleRoles, analysis, possibilities, players,
    )
    if (maxFilling < minVacancies) {
      const roleSlots = tripleRoles.map(r => ({ role: r, slots: setup.get(r) || 0 }))
      return {
        type: 'co_contradiction_triple_slot',
        contradictions: divinerContradictions.map(c => ({
          divinerName: c.divinerName, divinerRole: c.divinerRole,
          targetName: c.targetName, targetRole: c.targetRole,
        })),
        roles: tripleRoles,
        minVacancies,
        maxFilling, roleSlots, excludedCandidates,
      }
    }
  }
  return null
}

// ── Tier 3: Cross-role pigeonhole (general) ──────────────────────

function tryAugmentSlot(
  ci: number,
  candidates: { seat: Seat, villageRoles: SystemRole[] }[],
  slots: SystemRole[],
  matchSlot: number[],
  visited: Set<number>,
): boolean {
  const cand = candidates[ci]
  for (let si = 0; si < slots.length; si++) {
    if (visited.has(si)) continue
    if (!cand.villageRoles.includes(slots[si])) continue
    visited.add(si)
    if (matchSlot[si] === -1 || tryAugmentSlot(matchSlot[si], candidates, slots, matchSlot, visited)) {
      matchSlot[si] = ci
      return true
    }
  }
  return false
}

function checkPigeonholeVillageRole({ village, setup, seat, role, analysis, players, possibilities }: CheckerInput): DenialReason | null {
  // 村役職の仮説には適用しない（村役職でなければならないことを示すチェッカー）
  if (villageSpecialRoles.includes(role)) return null

  // 村役職の総枠数
  let totalSlots = 0
  for (const r of villageSpecialRoles) totalSlots += (setup.get(r) || 0)
  if (totalSlots === 0) return null

  // 各村役職のCO者を集計
  const coSeatsByRole = new Map<SystemRole, Seat[]>()
  const allCoSeats = new Set<Seat>()
  for (const r of villageSpecialRoles) {
    const claimants = [...(village.claims.get(r) || [])] as Seat[]
    coSeatsByRole.set(r, claimants)
    for (const s of claimants) allCoSeats.add(s)
  }

  // CO者がいなければこのチェッカーは効かない
  if (allCoSeats.size === 0) return null

  // 各役職のoverage（CO数 - 枠数の超過分）
  let overageFakes = 0
  const overageByRole = new Map<SystemRole, number>()
  for (const r of villageSpecialRoles) {
    const claimants = coSeatsByRole.get(r) || []
    const slots = setup.get(r) || 0
    const overage = Math.max(0, claimants.length - slots)
    overageByRole.set(r, overage)
    overageFakes += overage
  }

  // CO間矛盾の検出: 占い/霊媒COが他の村役職CO者に黒判定を出している
  type Contradiction = { divinerSeat: Seat, divinerName: string, divinerRole: string, targetSeat: Seat, targetName: string, targetRole: string }
  const contradictions: Contradiction[] = []
  const divinerRoles: ('seer' | 'medium')[] = ['seer', 'medium']
  for (const divinerRole of divinerRoles) {
    const diviners = coSeatsByRole.get(divinerRole) || []
    for (const divinerSeat of diviners) {
      const divinerStatus = village.statuses.get(divinerSeat)
      if (!divinerStatus) continue
      for (const [, assertion] of divinerStatus.assertions) {
        if (assertion.species !== 'wolf') continue
        if (!allCoSeats.has(assertion.target)) continue
        if (assertion.target === divinerSeat) continue
        // 対象のCO役職を取得
        const targetStatus = village.statuses.get(assertion.target)
        if (!targetStatus?.claiming) continue
        const targetRole = targetStatus.claimingRole
        if (!villageSpecialRoles.includes(targetRole as SystemRole)) continue
        contradictions.push({
          divinerSeat,
          divinerName: players?.get(divinerSeat) ?? `${divinerSeat}`,
          divinerRole,
          targetSeat: assertion.target,
          targetName: players?.get(assertion.target) ?? `${assertion.target}`,
          targetRole,
        })
      }
    }
  }

  // 矛盾による追加偽者数: overageで吸収されない矛盾のみカウント
  let extraFakes = 0
  const usedByContradiction = new Set<Seat>()
  for (const c of contradictions) {
    // どちらかのCOに矛盾が吸収済みならスキップ
    if (usedByContradiction.has(c.divinerSeat) || usedByContradiction.has(c.targetSeat)) continue
    const dRole = c.divinerRole as SystemRole
    const tRole = c.targetRole as SystemRole
    const divinerOverage = overageByRole.get(dRole) || 0
    const targetOverage = overageByRole.get(tRole) || 0
    if (divinerOverage > 0) {
      overageByRole.set(dRole, divinerOverage - 1)
      usedByContradiction.add(c.divinerSeat)
    } else if (targetOverage > 0) {
      overageByRole.set(tRole, targetOverage - 1)
      usedByContradiction.add(c.targetSeat)
    } else {
      extraFakes++
      usedByContradiction.add(c.targetSeat)
    }
  }

  const totalCOs = allCoSeats.size
  const guaranteedFakes = overageFakes + extraFakes
  const maxRealCOs = totalCOs - guaranteedFakes
  if (maxRealCOs >= totalSlots) return null

  // 非CO確定村役職者を集計（死因ベース + analysis.confirmed）
  let confirmedNonCoSlots = 0
  const confirmedNonCoSeats = new Set<Seat>()

  // 処刑時に道連れが出た → 処刑された人は猫又
  for (const [s, st] of village.statuses) {
    if (s === seat || allCoSeats.has(s) || confirmedNonCoSeats.has(s)) continue
    if (!st.surviving && st.causeOfDeath === 'execution' && st.diedDay != null) {
      // 同日に cursed_by_executed_nekomata の死者がいれば、この処刑者は猫又
      for (const [otherSeat, otherSt] of village.statuses) {
        if (otherSeat === s) continue
        if (otherSt.causeOfDeath === 'cursed_by_executed_nekomata' && otherSt.diedDay === st.diedDay) {
          confirmedNonCoSlots++
          confirmedNonCoSeats.add(s)
          break
        }
      }
    }
  }

  // analysis.confirmed から非COの村役職確定者
  if (analysis) {
    for (const [s, confirmedRole] of analysis.confirmed) {
      if (s === seat || allCoSeats.has(s) || confirmedNonCoSeats.has(s)) continue
      if (villageSpecialRoles.includes(confirmedRole)) {
        confirmedNonCoSlots++
        confirmedNonCoSeats.add(s)
      }
    }
  }

  // 残枠
  const remainingSlots = totalSlots - maxRealCOs - confirmedNonCoSlots
  if (remainingSlots <= 0) return null

  // 対象以外の候補が埋められる村役職スロット数を二部マッチングで計算
  const candidates: { seat: Seat, villageRoles: SystemRole[] }[] = []
  for (const [s, st] of village.statuses) {
    if (s === seat || allCoSeats.has(s) || confirmedNonCoSeats.has(s)) continue

    // 非村役職が確定していれば除外
    if (analysis) {
      const confirmed = analysis.confirmed.get(s)
      if (confirmed && !villageSpecialRoles.includes(confirmed)) continue
    }

    // 死因で非村役職確定なら除外
    if (!st.surviving) {
      if (st.causeOfDeath === 'cursed_by_killed_nekomata') continue
      if (st.causeOfDeath === 'cursed_by_executed_nekomata') continue
      if (st.causeOfDeath === 'follow_executed_hamster' || st.causeOfDeath === 'follow_killed_hamster') continue
      if (st.causeOfDeath === 'execution' && !st.claiming) continue
    }

    // 降参CO / 村人CO → 村役職ではない
    if (st.claiming && (st.claimingRole === 'surrender' || st.claimingRole === 'villager')) continue

    // この候補が就ける村役職を特定
    let candidateVillageRoles: SystemRole[]
    const playerPossibilities = possibilities?.get(s)
    if (playerPossibilities) {
      // retarのpossibilitiesがあればそれを使う
      candidateVillageRoles = villageSpecialRoles.filter(r =>
        (setup.get(r) || 0) > 0 && playerPossibilities.has(r)
      )
    } else {
      // possibilitiesがなければ保守的に全村役職を候補とする
      candidateVillageRoles = villageSpecialRoles.filter(r =>
        (setup.get(r) || 0) > 0 &&
        !(st.deniedRoles && st.deniedRoles.includes(r))
      )
    }

    if (candidateVillageRoles.length === 0) continue
    candidates.push({ seat: s, villageRoles: candidateVillageRoles })
  }

  // 二部マッチング: 候補 ↔ 村役職スロット（setup枠数で展開）
  const slots: SystemRole[] = []
  for (const r of villageSpecialRoles) {
    const count = setup.get(r) || 0
    for (let i = 0; i < count; i++) slots.push(r)
  }
  const matchSlot: number[] = new Array(slots.length).fill(-1)
  let maxFilling = 0
  for (let ci = 0; ci < candidates.length; ci++) {
    const visited = new Set<number>()
    if (tryAugmentSlot(ci, candidates, slots, matchSlot, visited)) {
      maxFilling++
    }
  }

  if (maxFilling < remainingSlots) {
    return {
      type: 'pigeonhole_must_be_village_special',
      totalSlots,
      maxRealCOs,
      confirmedNonCoSlots,
      remainingSlots,
      otherEligibleCount: maxFilling,
      contradictions,
    }
  }
  return null
}

// ── Exported checker list ───────────────────────────────────────────

export const allCheckers: Checker[] = [
  // CO constraint
  checkCoImpliesNotOtherVillageRole,
  // Tier 0: Analysis-based
  checkConfirmedSeerResult,
  checkConfirmedMediumResult,
  checkSeerClaimContradicted,
  checkMediumClaimContradicted,
  // Tier 1
  checkNotInSetup,
  checkNoHamsterNoImmoralist,
  checkCursedByNekomata,
  checkFollowHamster,
  checkSoleNightKill,
  checkVillagerCo,
  checkSurrenderCo,
  checkSilentExecution,
  checkDeniedByNegativeCo,
  // Tier 2
  checkSeerBlack,
  checkSeerWhite,
  checkSeerFoxKill,
  checkMediumBlack,
  checkMediumWhite,
  checkMasonPartner,
  checkRoleSlotsFilled,
  checkNekomataNoCompanion,
  checkAllHamstersDead,
  // Tier 3
  checkVillageWon,
  checkLiarBudget,
  checkContradictionPairSlot,
  checkContradictionTripleSlot,
  checkPigeonholeVillageRole,
  // Tier 4: 間接的な理由（他プレイヤーの確定に依存するため最低優先）
  checkConfirmedRoleHolderExists,
]
