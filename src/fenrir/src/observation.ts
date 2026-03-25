/**
 * 観測ベクトルエンコーダ
 *
 * DecisionContextから固定長のFloat32Arrayを構築する。
 * 情報隔壁: gameState.players[].roleは直接参照しない。
 * 初期知識はDecisionContextの専用フィールド(wolfTeammates, knownWolves, knownHamster)経由で取得。
 * 公開情報(publicEvents, signals)と自分の秘密情報(myPlayer)のみからエンコード。
 */

import type { DecisionContext } from '../../lupa/strategy.ts'
import type { SystemRole } from '../../types/index.ts'

export const MAX_SEATS = 20
export const MAX_DAYS = 50
export const HISTORY_WINDOW = 3

// 役職インデックス
const ROLES: SystemRole[] = [
  'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
  'werewolf', 'possessed', 'fanatic', 'werehamster', 'immoralist',
]
const ROLE_INDEX = new Map(ROLES.map((r, i) => [r, i]))
const NUM_ROLES = ROLES.length

// セクションサイズ
const GLOBAL_SIZE = 2 + 1 + NUM_ROLES + 1 + 1  // day, phase, alive_ratio, role_onehot, commander, progress = 16
const PER_SEAT_SIZE = 1 + (NUM_ROLES + 1) + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 // alive, claimed_role, is_me, black_count, white_count, vote_received, suspicion, trust, execute_proposal, is_commander = 21
const SEAT_SECTION_SIZE = MAX_SEATS * PER_SEAT_SIZE  // 420
const PRIVATE_SIZE = MAX_SEATS + MAX_SEATS + 1 + MAX_SEATS + 1  // divine_results + wolf_teammates + mason_partner + guard_history + known_hamster = 62
const REVOTE_SIZE = 1 + MAX_SEATS  // revote_round + revote_candidates_mask = 21
const HISTORY_DAY_SIZE = MAX_SEATS * 5  // per day: voted_for, executed, killed, claimed, signaled = 100
const HISTORY_SIZE = HISTORY_WINDOW * HISTORY_DAY_SIZE  // 300

// Retar可能性: per-seat × roles (0/1)
const RETAR_POSSIBILITIES_SIZE = MAX_SEATS * NUM_ROLES  // 220
// What-If CO: 占いCOシミュレーション後の可能性
const RETAR_WHATIF_SIZE = MAX_SEATS * NUM_ROLES  // 220

export const OBSERVATION_SIZE = GLOBAL_SIZE + SEAT_SECTION_SIZE + PRIVATE_SIZE + REVOTE_SIZE + HISTORY_SIZE + RETAR_POSSIBILITIES_SIZE + RETAR_WHATIF_SIZE

export function encodeObservation(ctx: DecisionContext): Float32Array {
  const obs = new Float32Array(OBSERVATION_SIZE)
  let offset = 0

  // ========== Global features ==========
  obs[offset++] = ctx.day / MAX_DAYS                    // normalized day
  obs[offset++] = ctx.phase === 'night' ? 0 : 1         // phase
  obs[offset++] = ctx.alivePlayers.length / MAX_SEATS    // alive ratio

  // my_role one-hot
  const roleIdx = ROLE_INDEX.get(ctx.myRole) ?? 0
  for (let i = 0; i < NUM_ROLES; i++) {
    obs[offset++] = i === roleIdx ? 1 : 0
  }

  obs[offset++] = ctx.commander !== null ? ctx.commander / MAX_SEATS : 0  // commander
  obs[offset++] = ctx.day / MAX_DAYS  // game progress (same as day, but explicit)

  // ========== Per-seat features ==========
  const aliveSet = new Set(ctx.alivePlayers)

  // Build public knowledge from events
  const claimedRoles = new Map<number, SystemRole>()
  const blackCounts = new Map<number, number>()
  const whiteCounts = new Map<number, number>()
  const voteCounts = new Map<number, number>()
  const suspicionCounts = new Map<number, number>()
  const trustCounts = new Map<number, number>()
  const executeCounts = new Map<number, number>()

  for (const event of ctx.publicEvents) {
    switch (event.type) {
      case 'seer_claim':
        claimedRoles.set(event.actor, 'seer')
        for (const r of event.results) {
          if (r.result === 'wolf') blackCounts.set(r.target, (blackCounts.get(r.target) ?? 0) + 1)
          else whiteCounts.set(r.target, (whiteCounts.get(r.target) ?? 0) + 1)
        }
        break
      case 'seer_result':
        if (event.result === 'wolf') blackCounts.set(event.target, (blackCounts.get(event.target) ?? 0) + 1)
        else whiteCounts.set(event.target, (whiteCounts.get(event.target) ?? 0) + 1)
        break
      case 'medium_claim':
        claimedRoles.set(event.actor, 'medium')
        break
      case 'bodyguard_claim':
        claimedRoles.set(event.actor, 'bodyguard')
        break
      case 'mason_claim':
        claimedRoles.set(event.actor, 'mason')
        break
      case 'nekomata_claim':
        claimedRoles.set(event.actor, 'nekomata')
        break
      case 'vote':
        if (event.type === 'vote') {
          voteCounts.set(event.target, (voteCounts.get(event.target) ?? 0) + 1)
        }
        break
      case 'signal':
        if (event.signal.type === 'suspicion') {
          suspicionCounts.set(event.signal.target, (suspicionCounts.get(event.signal.target) ?? 0) + 1)
        } else if (event.signal.type === 'trust') {
          trustCounts.set(event.signal.target, (trustCounts.get(event.signal.target) ?? 0) + 1)
        } else if (event.signal.type === 'execute_proposal') {
          executeCounts.set(event.signal.target, (executeCounts.get(event.signal.target) ?? 0) + 1)
        }
        break
    }
  }

  for (let seat = 1; seat <= MAX_SEATS; seat++) {
    const base = offset + (seat - 1) * PER_SEAT_SIZE
    let o = base

    obs[o++] = aliveSet.has(seat) ? 1 : 0

    // claimed_role one-hot (11 roles + none)
    const claimed = claimedRoles.get(seat)
    for (let i = 0; i < NUM_ROLES; i++) {
      obs[o++] = claimed !== undefined && ROLE_INDEX.get(claimed) === i ? 1 : 0
    }
    obs[o++] = claimed === undefined ? 1 : 0  // no claim

    obs[o++] = seat === ctx.mySeat ? 1 : 0
    obs[o++] = Math.min((blackCounts.get(seat) ?? 0) / 3, 1)
    obs[o++] = Math.min((whiteCounts.get(seat) ?? 0) / 3, 1)
    obs[o++] = Math.min((voteCounts.get(seat) ?? 0) / 10, 1)
    obs[o++] = Math.min((suspicionCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = Math.min((trustCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = Math.min((executeCounts.get(seat) ?? 0) / 5, 1)
    obs[o++] = ctx.commander === seat ? 1 : 0
  }
  offset += SEAT_SECTION_SIZE

  // ========== Private knowledge ==========
  const privateBase = offset

  // Seer divine results: per seat (0=unknown, 0.5=human, 1.0=wolf)
  if (ctx.myRole === 'seer') {
    for (const [, result] of ctx.myPlayer.divineHistory) {
      const seat = result.target
      if (seat >= 1 && seat <= MAX_SEATS) {
        obs[privateBase + (seat - 1)] = result.result === 'human' ? 0.5 : 1.0
      }
    }
  }
  offset += MAX_SEATS

  // Wolf teammates mask (人狼: 仲間の狼, 狂信者: 狼の位置)
  if (ctx.wolfTeammates) {
    for (const seat of ctx.wolfTeammates) {
      if (seat >= 1 && seat <= MAX_SEATS) {
        obs[offset + (seat - 1)] = 1
      }
    }
  } else if (ctx.knownWolves) {
    for (const seat of ctx.knownWolves) {
      if (seat >= 1 && seat <= MAX_SEATS) {
        obs[offset + (seat - 1)] = 1
      }
    }
  }
  offset += MAX_SEATS

  // Mason partner
  if (ctx.masonPartner !== null && ctx.masonPartner >= 1 && ctx.masonPartner <= MAX_SEATS) {
    obs[offset] = ctx.masonPartner / MAX_SEATS
  }
  offset += 1

  // Bodyguard guard history: per seat (1 if ever guarded)
  if (ctx.myRole === 'bodyguard') {
    for (const [, target] of ctx.myPlayer.guardHistory) {
      if (target >= 1 && target <= MAX_SEATS) {
        obs[offset + (target - 1)] = 1
      }
    }
  }
  offset += MAX_SEATS

  // Immoralist: known hamster seat
  if (ctx.knownHamster !== null && ctx.knownHamster >= 1 && ctx.knownHamster <= MAX_SEATS) {
    obs[offset] = ctx.knownHamster / MAX_SEATS
  }
  offset += 1

  // ========== Revote information ==========
  if (ctx.revoteRound !== null && ctx.revoteRound > 0) {
    obs[offset] = Math.min(ctx.revoteRound / 3, 1)  // normalized revote round (0..1)
  }
  offset += 1

  // Revote candidates mask
  if (ctx.revoteCandidates) {
    for (const seat of ctx.revoteCandidates) {
      if (seat >= 1 && seat <= MAX_SEATS) {
        obs[offset + (seat - 1)] = 1
      }
    }
  }
  offset += MAX_SEATS

  // ========== History window (last 3 days) ==========
  const currentDay = ctx.day
  for (let w = 0; w < HISTORY_WINDOW; w++) {
    const histDay = currentDay - HISTORY_WINDOW + w + 1
    if (histDay < 1) continue

    const dayBase = offset + w * HISTORY_DAY_SIZE

    // Collect events for this day
    for (const event of ctx.publicEvents) {
      switch (event.type) {
        case 'vote': {
          // Record who voted for whom as one-hot-ish per seat
          const voterSlot = event.voter - 1
          if (voterSlot >= 0 && voterSlot < MAX_SEATS) {
            obs[dayBase + voterSlot * 5 + 0] = event.target / MAX_SEATS
          }
          break
        }
        case 'execution': {
          const slot = event.target - 1
          if (slot >= 0 && slot < MAX_SEATS) {
            obs[dayBase + slot * 5 + 1] = 1
          }
          break
        }
        case 'night_kill':
        case 'fox_kill': {
          const slot = event.target - 1
          if (slot >= 0 && slot < MAX_SEATS) {
            obs[dayBase + slot * 5 + 2] = 1
          }
          break
        }
        case 'seer_claim':
        case 'medium_claim':
        case 'bodyguard_claim':
        case 'mason_claim':
        case 'nekomata_claim': {
          const slot = event.actor - 1
          if (slot >= 0 && slot < MAX_SEATS) {
            obs[dayBase + slot * 5 + 3] = 1
          }
          break
        }
        case 'signal': {
          const slot = event.actor - 1
          if (slot >= 0 && slot < MAX_SEATS) {
            obs[dayBase + slot * 5 + 4] = 1
          }
          break
        }
      }
    }
  }
  offset += HISTORY_SIZE

  // ========== Retar possibilities ==========
  if (ctx.retarPossibilities) {
    for (let seat = 1; seat <= MAX_SEATS; seat++) {
      const roles = ctx.retarPossibilities.get(seat)
      if (!roles) continue
      for (const role of roles) {
        const rIdx = ROLE_INDEX.get(role)
        if (rIdx !== undefined) {
          obs[offset + (seat - 1) * NUM_ROLES + rIdx] = 1
        }
      }
    }
  }
  offset += RETAR_POSSIBILITIES_SIZE

  // ========== What-If CO (人外向け) ==========
  if (ctx.retarWhatIfPossibilities) {
    for (let seat = 1; seat <= MAX_SEATS; seat++) {
      const roles = ctx.retarWhatIfPossibilities.get(seat)
      if (!roles) continue
      for (const role of roles) {
        const rIdx = ROLE_INDEX.get(role)
        if (rIdx !== undefined) {
          obs[offset + (seat - 1) * NUM_ROLES + rIdx] = 1
        }
      }
    }
  }
  // offset += RETAR_WHATIF_SIZE

  return obs
}
