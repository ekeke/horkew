import type { SystemRole } from '../types/index.ts'

/**
 * spoiler 由来 (.howl テキストから派生) と UI 由来 (席を手動クリックでセット) の
 * assumption Map をマージする。 同じ席に両方の指定があれば spoiler を優先する
 * (UI 操作不可ポリシー)。
 */
export function mergeAssumptions(
  spoiler: Map<number, SystemRole>,
  ui: Map<number, SystemRole>,
): Map<number, SystemRole> {
  const out = new Map<number, SystemRole>(ui)
  for (const [seat, role] of spoiler) out.set(seat, role)
  return out
}
