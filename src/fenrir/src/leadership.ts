import type { GameState } from '../../lupa/types.ts'
import type { SystemRole } from '../../types/index.ts'
import type { SignalRecord } from './communication.ts'
import { alivePlayers } from '../../lupa/roles.ts'

export type Proposal =
  | { type: 'execute_order', target: number }
  | { type: 'investigate_order', target: number }
  | { type: 'protect_order', target: number }

export type LeadershipResponse = 'follow' | 'defy' | 'no_response'

/**
 * シグナルベースの指揮者判定
 *
 * nominate_commander シグナルから指揮者を決定する:
 * 1. Retarで確定村陣営からの推薦/自薦 → 自動承認
 * 2. それ以外はagree/disagreeの数で判定（過半数で承認）
 * 3. 複数候補がいれば最も支持が多い候補を選出
 *
 * @param daySignals 当日のシグナル記録
 * @param retarPossibilities Retar分析結果（確定村判定用、省略可）
 */
export function detectCommander(
  state: GameState,
  retarPossibilities?: Map<number, Set<SystemRole>> | null,
  daySignals?: SignalRecord[],
): number | null {
  const alive = alivePlayers(state)
  const aliveSeats = new Set(alive.map(p => p.seat))

  if (!daySignals || daySignals.length === 0) return null

  // CO破綻判定
  const isBusted = (seat: number, claimedRole: SystemRole): boolean => {
    if (!retarPossibilities) return false
    const roles = retarPossibilities.get(seat)
    return roles !== undefined && !roles.has(claimedRole)
  }

  // 確定村判定
  const villageRoles: Set<SystemRole> = new Set(['seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'villager'])
  const isConfirmedVillage = (seat: number): boolean => {
    if (!retarPossibilities) return false
    const roles = retarPossibilities.get(seat)
    return roles !== undefined && roles.size === 1 && villageRoles.has([...roles][0])
  }

  // nominate_commander を集計
  // 被推薦者 → { nominators: Set, agreeCount, disagreeCount }
  const nominations = new Map<number, { nominators: Set<number>, agreeCount: number, disagreeCount: number }>()

  for (const record of daySignals) {
    if (record.signal.type === 'nominate_commander' && 'target' in record.signal) {
      const target = record.signal.target
      if (!aliveSeats.has(target)) continue
      // 被推薦者がCO破綻していたら無視
      const player = alive.find(p => p.seat === target)
      if (player?.claimedRole && isBusted(target, player.claimedRole)) continue

      if (!nominations.has(target)) {
        nominations.set(target, { nominators: new Set(), agreeCount: 0, disagreeCount: 0 })
      }
      nominations.get(target)!.nominators.add(record.sender)
    }
  }

  if (nominations.size === 0) return null

  // 確定村からの推薦/自薦 → 自動承認
  for (const [target, nom] of nominations) {
    for (const nominator of nom.nominators) {
      if (isConfirmedVillage(nominator)) {
        return target
      }
    }
  }

  // agree/disagree 集計（推薦者に対するagree = 被推薦者への支持）
  for (const record of daySignals) {
    if (record.signal.type === 'agree' && 'target' in record.signal) {
      // agreeのtargetが推薦者であれば、その推薦者が推した被推薦者の支持を+1
      for (const [, nom] of nominations) {
        if (nom.nominators.has(record.signal.target)) {
          nom.agreeCount++
        }
      }
    } else if (record.signal.type === 'disagree' && 'target' in record.signal) {
      for (const [, nom] of nominations) {
        if (nom.nominators.has(record.signal.target)) {
          nom.disagreeCount++
        }
      }
    }
  }

  // 最も支持が多い候補を選出
  let bestCandidate: number | null = null
  let bestSupport = 0

  for (const [target, nom] of nominations) {
    const support = nom.agreeCount + nom.nominators.size // 推薦者自身も支持とカウント
    if (support > bestSupport) {
      bestSupport = support
      bestCandidate = target
    }
  }

  return bestCandidate
}
