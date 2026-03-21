import type { Seat, Day, VillageStatus, SystemRole } from '../types/index.ts'
import type { ConfirmationChecker, ConfirmationCheckerInput, ConfirmationReason } from './reasons.ts'
import { villageSideRoles } from './reasons.ts'
import { isTrustworthy } from './analysis.ts'

// ── 人狼人数制約 ────────────────────────────────────────────────────

/**
 * ゲーム状態から死亡人狼数の最小・最大を返す
 *
 * - ゲーム続行中: 1 ≤ 生存人狼 ≤ floor((生存者数-1)/2)
 * - 村勝利: 生存人狼 = 0
 * - 狼勝利: 生存人狼 ≥ ceil(生存者数/2)
 */
/**
 * 確定死亡した狐の数を数える
 * 後追い死（follow_*_hamster）が発生していれば、その原因となった狐は死亡確定
 */
function countConfirmedDeadHamsters(village: VillageStatus): number {
  let count = 0
  for (const [, s] of village.statuses) {
    if (
      !s.surviving &&
      (s.causeOfDeath === 'follow_executed_hamster' || s.causeOfDeath === 'follow_killed_hamster')
    ) {
      count++
    }
  }
  return count
}

export function deadWerewolfBounds(
  village: VillageStatus,
  setup: Map<SystemRole, number>,
): { min: number, max: number } | null {
  const totalWolves = setup.get('werewolf') || 0
  if (totalWolves === 0) return null

  const aliveCount = [...village.statuses.values()].filter(s => s.surviving).length
  const totalHamsters = setup.get('werehamster') || 0
  const confirmedDeadHamsters = countConfirmedDeadHamsters(village)
  // 生存している可能性のある狐の最大数
  const maxAliveHamsters = Math.min(totalHamsters - confirmedDeadHamsters, aliveCount)

  if (village.result === 'villager_won' || village.result === 'werehamster_won') {
    // 人狼全滅（村勝利・狐勝利とも人狼は全滅）
    return { min: totalWolves, max: totalWolves }
  }

  if (village.result === 'werewolf_won') {
    // 人狼 ≥ 非人狼（狐除外）
    const nonHamsterAlive = aliveCount - maxAliveHamsters
    const minAlive = Math.ceil(nonHamsterAlive / 2)
    const maxAlive = Math.min(totalWolves, aliveCount)
    return { min: totalWolves - maxAlive, max: totalWolves - minAlive }
  }

  // ゲーム続行中: 人狼 < 非人狼（狐除外）かつ人狼 ≥ 1
  if (!village.finished) {
    // 非狐の生存者数で人狼上限を計算（retarと同じロジック）
    const nonHamsterAlive = aliveCount - maxAliveHamsters
    const maxAlive = Math.min(totalWolves, Math.floor((nonHamsterAlive - 0.1) / 2))
    const minAlive = 1
    if (maxAlive < minAlive) return null
    return { min: totalWolves - maxAlive, max: totalWolves - minAlive }
  }

  return null
}

// ── 死因による確定 ──────────────────────────────────────────────────

function checkCursedByNekomataConfirm({ status, role }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werewolf') return null
  // 猫又が夜に噛まれた場合のみ人狼確定
  if (!status.surviving && status.causeOfDeath === 'cursed_by_killed_nekomata') {
    return { type: 'cursed_by_nekomata' }
  }
  return null
}

function checkExecutionCompanionConfirm({ village, seat, status, role, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'nekomata') return null
  if (status.causeOfDeath !== 'execution' || status.diedDay == null) return null

  // 同じ日に cursed_by_executed_nekomata で死亡したプレイヤーがいれば猫又確定
  for (const [s, st] of village.statuses) {
    if (s === seat) continue
    if (st.causeOfDeath === 'cursed_by_executed_nekomata' && st.diedDay === status.diedDay) {
      return { type: 'execution_companion', companionSeat: s, companionName: players?.get(s) ?? `${s}` }
    }
  }
  return null
}

function checkFollowHamsterConfirm({ status, role }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'immoralist') return null
  if (
    !status.surviving &&
    (status.causeOfDeath === 'follow_executed_hamster' ||
     status.causeOfDeath === 'follow_killed_hamster')
  ) {
    return { type: 'follow_hamster' }
  }
  return null
}

// ── CO分析による確定 ────────────────────────────────────────────────

function checkAllOtherCosBusted({ village, analysis, seat, role, players, possibilities }: ConfirmationCheckerInput): ConfirmationReason | null {
  const roleAnalysis =
    role === 'seer' ? analysis.seer :
    role === 'medium' ? analysis.medium :
    null
  if (!roleAnalysis) return null

  if (roleAnalysis.confirmed !== seat) return null

  const bustedSeats = Array.from(roleAnalysis.busted.keys())
  if (bustedSeats.length === 0) return null

  // 破綻したCO者
  const eliminatedCandidates: { seat: Seat, name: string }[] = bustedSeats.map(s => ({
    seat: s,
    name: players?.get(s) ?? `${s}`,
  }))

  // CO日までに襲撃死した非CO者: possibilitiesで役職が否定されていれば候補に含める
  if (possibilities) {
    const coSeats = new Set(roleAnalysis.candidates)
    // このCO役職の最初のCO日を求める
    let firstCoDay = Infinity
    for (const coSeat of roleAnalysis.candidates) {
      const coStatus = village.statuses.get(coSeat)
      if (coStatus?.claimedAt != null && coStatus.claimedAt < firstCoDay) {
        firstCoDay = coStatus.claimedAt
      }
    }
    // CO日までに襲撃死した非CO者
    for (const [s, st] of village.statuses) {
      if (s === seat || coSeats.has(s)) continue
      if (!st.surviving && !st.claiming && st.causeOfDeath === 'night_kill' && st.diedDay != null && st.diedDay < firstCoDay) {
        const roles = possibilities.get(s)
        if (roles && !roles.has(role)) {
          eliminatedCandidates.push({ seat: s, name: players?.get(s) ?? `${s}` })
        }
      }
    }
  }

  return { type: 'all_other_cos_busted', role, eliminatedCandidates }
}

// ── 結果合意による確定 ──────────────────────────────────────────────

function checkSeerConsensusBlack({ village, analysis, seat, role, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werewolf') return null
  const result = collectConsensus(village, analysis, 'seer', seat, 'wolf', players)
  if (!result) return null
  return { type: 'seer_consensus_black', claimants: result }
}

function checkMediumConsensusBlack({ village, analysis, seat, role, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werewolf') return null
  const result = collectConsensus(village, analysis, 'medium', seat, 'wolf', players)
  if (!result) return null
  return { type: 'medium_consensus_black', claimants: result }
}

/**
 * 霊媒合意白 + 人外確定 → 狂人/狂信者
 *
 * 非破綻の霊媒CO者全員が白判定を出している（= 人狼ではない）
 * かつ possibilitiesで人外のみに絞られている
 * → mediumResultが'human'の人外役職（possessed, fanatic）に確定
 */
function checkMediumWhiteNonWolf({ village, analysis, seat, role, possibilities, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'possessed' && role !== 'fanatic') return null
  if (!possibilities) return null

  // possibilitiesで人外のみに絞られているか確認
  const evilRoleNames: SystemRole[] = ['werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist']
  const roles = possibilities.get(seat)
  if (!roles || roles.size === 0) return null
  if (![...roles].every(r => evilRoleNames.includes(r))) return null

  // 霊媒合意白
  const result = collectConsensus(village, analysis, 'medium', seat, 'human', players)
  if (!result) return null
  return { type: 'medium_white_non_wolf', claimants: result }
}

/** 破綻していないCO者全員が同じ結果を出しているか確認 */
function collectConsensus(
  village: import('../types/index.ts').VillageStatus,
  analysis: import('./analysis.ts').AnalysisResult,
  claimRole: 'seer' | 'medium',
  seat: Seat,
  species: 'human' | 'wolf',
  players: Map<number, string> | undefined,
): { name: string, night: Day }[] | null {
  const claimants = (village.claims.get(claimRole) || []) as Seat[]
  const eligible: Seat[] = []
  for (const claimant of claimants) {
    if (!isTrustworthy(claimant, claimRole, analysis.confirmed)) continue
    const roleAnalysis = claimRole === 'seer' ? analysis.seer : analysis.medium
    if (roleAnalysis.busted.has(claimant)) continue
    eligible.push(claimant)
  }
  if (eligible.length === 0) return null

  const matches: { name: string, night: Day }[] = []
  for (const claimant of eligible) {
    const claimantStatus = village.statuses.get(claimant)!
    let found = false
    for (const [night, { target, species: sp }] of claimantStatus.assertions) {
      if (target === seat && sp === species) {
        matches.push({ name: players?.get(claimant) ?? `${claimant}`, night })
        found = true
        break
      }
    }
    if (!found) return null
  }
  return matches
}

// ── 共有相方 ────────────────────────────────────────────────────────

function checkMasonPartnerConfirm({ village, seat, role, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'mason') return null
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

// ── 呪殺 ────────────────────────────────────────────────────────────

function checkSeerFoxKillConfirm({ village, analysis, seat, status, role, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werehamster') return null
  if (status.surviving || status.causeOfDeath !== 'night_kill' || status.diedDay == null) return null

  const nightDeaths = village.kills.get(status.diedDay) || []
  if (nightDeaths.length < 2) return null

  const seerClaimants = (village.claims.get('seer') || []) as Seat[]
  for (const seerSeat of seerClaimants) {
    if (!isTrustworthy(seerSeat, 'seer', analysis.confirmed)) continue
    if (analysis.seer.busted.has(seerSeat)) continue
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

// ── 消去法 ──────────────────────────────────────────────────────────

function checkDeadWerewolfCount({ village, setup, seat, role, status, possibilities, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (!possibilities) return null
  if (role !== 'werewolf') return null
  if (status.surviving) return null

  const bounds = deadWerewolfBounds(village, setup)
  if (!bounds || bounds.min <= 0) return null

  // 死者の中で自分以外にwerewolfになれるプレイヤーを数える
  const deadWolfCandidates: { seat: Seat, name: string }[] = []
  for (const [s, roles] of possibilities) {
    if (s === seat) continue
    const st = village.statuses.get(s)
    if (st && !st.surviving && roles.has('werewolf')) {
      deadWolfCandidates.push({ seat: s, name: players?.get(s) ?? `${s}` })
    }
  }

  // 死者中の他候補数が必要死亡人狼数 - 1（自分の分）と一致すれば確定
  if (deadWolfCandidates.length === bounds.min - 1) {
    const self = { seat, name: players?.get(seat) ?? `${seat}` }
    return { type: 'dead_werewolf_count', requiredDead: bounds.min, candidates: [...deadWolfCandidates, self] }
  }

  return null
}

// ── 全人外位置判明 ──────────────────────────────────────────────────

/**
 * 全人外の位置が確定している場合、村人側の役職が確定する
 *
 * setupの人外枠（werewolf, possessed, fanatic, werehamster, immoralist）の
 * 合計数ぶんの人外がpossibilitiesで確定済みなら、残りは全員村人側。
 * CO者はそのCO役職に、非CO者は消去法で村人に確定する。
 */
function checkAllEvilAccounted({ village, setup, seat, role, status, possibilities, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (!possibilities) return null
  if (!villageSideRoles.includes(role)) return null
  // CO者の場合はCO役職と一致すること
  if (status.claiming && status.claimingRole !== role) return null

  const evilRoleNames: SystemRole[] = ['werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist']
  let totalEvilSlots = 0
  for (const r of evilRoleNames) {
    totalEvilSlots += setup.get(r) || 0
  }
  if (totalEvilSlots === 0) return null

  // possibilitiesで人外のみに絞られているプレイヤーを数える
  const evilSeats: { seat: Seat, name: string }[] = []
  for (const [s, roles] of possibilities) {
    if (roles.size === 0) continue
    const allEvil = [...roles].every(r => evilRoleNames.includes(r))
    if (allEvil) {
      evilSeats.push({ seat: s, name: players?.get(s) ?? `${s}` })
    }
  }

  if (evilSeats.length >= totalEvilSlots) {
    return { type: 'all_evil_accounted', role, evilSeats }
  }
  return null
}

// ── Exported checker list ───────────────────────────────────────────

export const allConfirmationCheckers: ConfirmationChecker[] = [
  checkCursedByNekomataConfirm,
  checkExecutionCompanionConfirm,
  checkFollowHamsterConfirm,
  checkAllOtherCosBusted,
  checkSeerConsensusBlack,
  checkMediumConsensusBlack,
  checkMediumWhiteNonWolf,
  checkMasonPartnerConfirm,
  checkSeerFoxKillConfirm,
  checkDeadWerewolfCount,
  checkAllEvilAccounted,
]
