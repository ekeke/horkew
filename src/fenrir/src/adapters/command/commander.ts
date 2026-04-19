/**
 * Commander 選出 — Retar 結果から村確定席の最小席番を進行役として選ぶ
 *
 * 設計:
 * - 村確定 = possibilities から人外 4 役（werewolf/fanatic/werehamster/immoralist）が
 *   全て排除された席
 * - タイブレーク: 席番号昇順
 * - 該当席なし: null（進行役なし）
 */

import type { SystemRole } from '../../../../types/index.ts'

const NON_VILLAGE_ROLES: SystemRole[] = [
  'werewolf', 'fanatic', 'werehamster', 'immoralist',
]

/**
 * 席の possibilities が全て村陣営役職のみで構成されているかを判定。
 * possibilities が undefined（= 未計算）の場合も false（村確定ではない）。
 */
export function isConfirmedVillage(possibilities: Set<SystemRole> | undefined): boolean {
  if (!possibilities || possibilities.size === 0) return false
  return NON_VILLAGE_ROLES.every(role => !possibilities.has(role))
}

/**
 * Retar の possibilities Map から commander（進行役）席を選出。
 * 村確定席のうち最小席番を返す。該当なしなら null。
 */
export function selectCommanderFromRetar(
  possibilities: Map<number, Set<SystemRole>>,
  aliveSeats: number[],
): number | null {
  const confirmed = aliveSeats
    .filter(seat => isConfirmedVillage(possibilities.get(seat)))
    .sort((a, b) => a - b)
  return confirmed[0] ?? null
}
