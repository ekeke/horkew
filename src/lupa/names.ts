import type { SystemRole } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'

export const RANDOM_NAMES = [
  'アリス',
  'ボブ',
  'クロエ',
  'ダニエル',
  'エミリー',
  'フランク',
  'グレース',
  'ハロルド',
  'イザベル',
  'ジャック',
  'カレン',
  'レオン',
  'マリア',
  'ニコラス',
  'オリビア',
  'パトリック',
  'レイチェル',
  'サイモン',
  'トーマス',
  'ウルスラ',
]

/**
 * 役職名ベースの名前を生成する。
 * 割り当て済み役職の順に、同役職が複数なら番号を付ける。
 * 例: 占い, 人狼１, 人狼２, 村１, 村２, 村３
 */
export function generateRoleNames(
  assignedRoles: SystemRole[],
): string[] {
  // 各役職の出現数をカウント
  const roleCounts = new Map<SystemRole, number>()
  for (const role of assignedRoles) {
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1)
  }

  // 各役職の連番カウンター
  const roleIndex = new Map<SystemRole, number>()

  return assignedRoles.map(role => {
    const shortName = systemRoles.get(role)!.shortName
    const total = roleCounts.get(role)!
    const idx = (roleIndex.get(role) ?? 0) + 1
    roleIndex.set(role, idx)

    if (total === 1) return shortName
    return `${shortName}${toFullWidth(idx)}`
  })
}

/**
 * 役職短縮名+席番号の名前を生成する。
 * 例: 占13, 狼4, 村10
 * names[i] の seat は i+1（assignRoles で seat: i+1 になる）
 */
export function generateRoleSeatNames(
  assignedRoles: SystemRole[],
): string[] {
  return assignedRoles.map((role, i) => {
    const shortName = systemRoles.get(role)!.shortName
    return `${shortName}${i + 1}`
  })
}

function toFullWidth(n: number): string {
  return String(n).replace(/[0-9]/g, c =>
    String.fromCharCode(c.charCodeAt(0) + 0xFEE0)
  )
}
