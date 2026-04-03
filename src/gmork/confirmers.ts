import type { Seat, Day, VillageStatus, SystemRole } from '../types/index.ts'
import type { ConfirmationCheckerInput, ConfirmationReason, TaggedConfirmationChecker } from './reasons.ts'
import { villageSideRoles } from './reasons.ts'
import { isTrustworthy, analyzeSeer, analyzeMedium } from './analysis.ts'
import { formatBustReason, formatReason } from './format.ts'
import { allCheckers } from './checkers.ts'

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
    // CO日までに襲撃死またはグレラン処刑された非CO者
    for (const [s, st] of village.statuses) {
      if (s === seat || coSeats.has(s)) continue
      if (!st.surviving && !st.claiming && (st.causeOfDeath === 'night_kill' || (st.causeOfDeath === 'execution' && st.noCoOpportunity)) && st.diedDay != null && st.diedDay < firstCoDay) {
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

function checkSeerConsensusBlack({ village, setup, analysis, seat, role, players, possibilities }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werewolf') return null
  const result = collectConsensus(village, analysis, setup, 'seer', seat, 'wolf', players, possibilities)
  if (!result) return null
  return { type: 'seer_consensus_black', claimants: result }
}

function checkMediumConsensusBlack({ village, setup, analysis, seat, role, players, possibilities }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'werewolf') return null
  const result = collectConsensus(village, analysis, setup, 'medium', seat, 'wolf', players, possibilities)
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
function checkMediumWhiteNonWolf({ village, setup, analysis, seat, status, role, possibilities, players }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (role !== 'possessed' && role !== 'fanatic') return null
  if (!possibilities) return null

  // possibilitiesで人外のみに絞られているか確認
  const evilRoleNames: SystemRole[] = ['werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist']
  const roles = possibilities.get(seat)
  if (!roles || roles.size === 0) return null
  if (![...roles].every(r => evilRoleNames.includes(r))) return null

  // 霊媒合意白
  const result = collectConsensus(village, analysis, setup, 'medium', seat, 'human', players, possibilities)
  if (!result) return null

  // 破綻理由を収集（CO者なら analysis の bust reason）
  let bustDescription = '人外確定'
  if (status.claiming) {
    const claimRole = status.claimingRole as SystemRole
    const roleNameJa: Record<string, string> = {
      seer: '占い師', medium: '霊媒師', bodyguard: '狩人', mason: '共有者', nekomata: '猫又',
    }
    const roleAnalysis =
      claimRole === 'seer' ? analysis.seer :
      claimRole === 'medium' ? analysis.medium :
      null
    const bustReason = roleAnalysis?.busted.get(seat)
    if (bustReason) {
      bustDescription = formatBustReason(bustReason, roleNameJa[claimRole] ?? claimRole)
    }
  }

  return { type: 'medium_white_non_wolf', claimants: result, bustDescription }
}

/**
 * 破綻していないCO者全員が同じ結果を出しているか確認
 *
 * 合意が成立するには、全ての真の役職者がeligible CO者の中にいる必要がある。
 * CO前に死亡した非CO者がretarで当該役職の候補に残っている場合、
 * その人物が真の可能性があり、結果が不明なため合意とは見なさない。
 */
function collectConsensus(
  village: import('../types/index.ts').VillageStatus,
  analysis: import('./analysis.ts').AnalysisResult,
  setup: Map<SystemRole, number>,
  claimRole: 'seer' | 'medium',
  seat: Seat,
  species: 'human' | 'wolf',
  players: Map<number, string> | undefined,
  possibilities?: Map<Seat, Set<SystemRole>>,
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

  const slots = setup.get(claimRole) || 0
  if (slots <= 0 || eligible.length < slots) return null

  // CO前に死亡した非CO者で、retarで当該役職の候補に残っている人数
  const coSeats = new Set(claimants)
  let firstCoDay = Infinity
  for (const coSeat of claimants) {
    const coStatus = village.statuses.get(coSeat)
    if (coStatus?.claimedAt != null && coStatus.claimedAt < firstCoDay) {
      firstCoDay = coStatus.claimedAt
    }
  }
  let unknownTrueCandidates = 0
  for (const [s, st] of village.statuses) {
    if (coSeats.has(s)) continue
    if (!st.surviving && !st.claiming && (st.causeOfDeath === 'night_kill' || (st.causeOfDeath === 'execution' && st.noCoOpportunity)) && st.diedDay != null && st.diedDay < firstCoDay) {
      // retarでこの役職の可能性が残っているかチェック
      const roles = possibilities?.get(s)
      if (!roles || roles.has(claimRole)) {
        unknownTrueCandidates++
      }
    }
  }
  // 未知の真候補がいる場合、全eligibleの結果が一致しても真の結果は不明
  if (unknownTrueCandidates > 0) return null

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
function checkAllEvilAccounted({ village: _village, setup, seat: _seat, role, status, possibilities, players }: ConfirmationCheckerInput): ConfirmationReason | null {
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

// ── 否定理由による消去法 ────────────────────────────────────────────

/**
 * 否定理由で他の役職を消去し、retarのpossibilitiesと突合して確定する
 *
 * 1. setupに存在する全役職について、この席に対する否定理由を収集
 * 2. 否定できなかった役職とretarのpossibilitiesの積集合を取る
 * 3. 積集合が{target role}のみなら確定
 */
function checkDenialElimination({ village, setup, seat, role, status, analysis, players, possibilities }: ConfirmationCheckerInput): ConfirmationReason | null {
  if (!possibilities) return null

  const retarRoles = possibilities.get(seat)
  if (!retarRoles || retarRoles.size !== 1 || !retarRoles.has(role)) return null

  // 対象自身を confirmed から除外した analysis を構築（循環参照防止）
  const filteredConfirmed = new Map(analysis.confirmed)
  filteredConfirmed.delete(seat)
  const filteredSeer = analyzeSeer(village, setup, filteredConfirmed, players)
  const filteredMedium = analyzeMedium(village, setup, filteredConfirmed, players)
  const filteredAnalysis = { confirmed: filteredConfirmed, seer: filteredSeer, medium: filteredMedium }

  // setupに存在する全役職を収集
  const allRoles: SystemRole[] = []
  for (const [r, count] of setup) {
    if (count > 0) allRoles.push(r)
  }

  // 各役職について否定理由を収集
  const checkerInput = { village, setup, seat, role: role, status, analysis: filteredAnalysis, players, possibilities }
  const eliminatedRoles: { role: SystemRole, reason: string }[] = []

  for (const candidateRole of allRoles) {
    if (candidateRole === role) continue

    const input = { ...checkerInput, role: candidateRole }
    let denied = false
    for (const { fn: checker } of allCheckers) {
      const denialReason = checker(input)
      if (denialReason) {
        eliminatedRoles.push({ role: candidateRole, reason: formatReason(denialReason, candidateRole) })
        denied = true
        break
      }
    }
    if (!denied) return null // 否定できない役職がある → 確定不可
  }

  if (eliminatedRoles.length === 0) return null
  return { type: 'denial_elimination', eliminatedRoles }
}

// ── Exported checker list ───────────────────────────────────────────

// axiomatic → dependent → elimination の順。

export const allConfirmationCheckers: TaggedConfirmationChecker[] = [
  // ── axiomatic: ゲーム事実のみで完結 ──
  { fn: checkCursedByNekomataConfirm, category: 'axiomatic' },
  { fn: checkExecutionCompanionConfirm, category: 'axiomatic' },
  { fn: checkFollowHamsterConfirm, category: 'axiomatic' },
  { fn: checkMasonPartnerConfirm, category: 'axiomatic' },
  // ── dependent: 他プレイヤーの確定/破綻に依存 ──
  { fn: checkAllOtherCosBusted, category: 'dependent' },
  { fn: checkSeerConsensusBlack, category: 'dependent' },
  { fn: checkMediumConsensusBlack, category: 'dependent' },
  { fn: checkMediumWhiteNonWolf, category: 'dependent' },
  { fn: checkSeerFoxKillConfirm, category: 'dependent' },
  { fn: checkDeadWerewolfCount, category: 'dependent' },
  // ── elimination: 消去法 ──
  { fn: checkAllEvilAccounted, category: 'elimination' },
  { fn: checkDenialElimination, category: 'elimination' },
]
