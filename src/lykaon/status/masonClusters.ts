import type { ClaimGroup, ClaimRow } from './extract.ts'

export type MasonMember = {
  seat: number
  name: string
  dead: boolean
}

export type MasonCluster = {
  members: MasonMember[]
  complete: boolean
}

export type MasonClustersResult = {
  clusters: MasonCluster[]
  capacity: number
  signals: {
    overCapacity: boolean
    multipleGroups: boolean
    oversizedCluster: boolean
  }
}

function toMember(row: ClaimRow): MasonMember {
  return { seat: row.seat, name: row.name, dead: !row.surviving }
}

export function buildMasonClusters(
  group: ClaimGroup | undefined,
  capacity: number,
  deadPlayers: Map<number, string> = new Map(),
): MasonClustersResult {
  if (!group || group.rows.length === 0) {
    return {
      clusters: [],
      capacity,
      signals: { overCapacity: false, multipleGroups: false, oversizedCluster: false },
    }
  }

  const claimants = new Set(group.rows.map(r => r.seat))
  const rowBySeat = new Map<number, ClaimRow>()
  for (const row of group.rows) rowBySeat.set(row.seat, row)

  // 死亡 seat が「主張先」として登場した場合は救済対象。死人に口無しなので
  // 相手側の同意なしに cluster 成立扱いとする。
  const deadTargets = new Map<number, string>()

  const partners = new Map<number, Set<number>>()
  for (const row of group.rows) {
    const set = new Set<number>()
    for (const [, assertion] of row.assertions) {
      const target = assertion.target
      if (target === row.seat) continue
      if (claimants.has(target)) {
        set.add(target)
      } else if (deadPlayers.has(target)) {
        set.add(target)
        deadTargets.set(target, deadPlayers.get(target)!)
      }
    }
    partners.set(row.seat, set)
  }

  const allSeats = new Set<number>([...claimants, ...deadTargets.keys()])
  const adjacency = new Map<number, Set<number>>()
  for (const seat of allSeats) adjacency.set(seat, new Set())
  for (const a of claimants) {
    const aPartners = partners.get(a)!
    for (const b of aPartners) {
      if (deadTargets.has(b)) {
        adjacency.get(a)!.add(b)
        adjacency.get(b)!.add(a)
      } else if (partners.get(b)?.has(a)) {
        adjacency.get(a)!.add(b)
        adjacency.get(b)!.add(a)
      }
    }
  }

  const visited = new Set<number>()
  const clusters: MasonCluster[] = []
  const sortedSeats = [...allSeats].sort((a, b) => a - b)
  for (const start of sortedSeats) {
    if (visited.has(start)) continue
    const componentSeats: number[] = []
    const queue: number[] = [start]
    visited.add(start)
    while (queue.length > 0) {
      const seat = queue.shift()!
      componentSeats.push(seat)
      for (const next of adjacency.get(seat)!) {
        if (!visited.has(next)) {
          visited.add(next)
          queue.push(next)
        }
      }
    }
    componentSeats.sort((a, b) => a - b)
    const members: MasonMember[] = componentSeats.map(s => {
      const row = rowBySeat.get(s)
      if (row) return toMember(row)
      return { seat: s, name: deadTargets.get(s)!, dead: true }
    })
    clusters.push({ members, complete: members.length >= 2 })
  }

  const completeCount = clusters.filter(c => c.complete).length
  const oversizedCluster = clusters.some(c => c.members.length > capacity)
  const signals = {
    overCapacity: claimants.size > capacity,
    multipleGroups: completeCount >= 2,
    oversizedCluster,
  }

  return { clusters, capacity, signals }
}

/**
 * Render clusters as a single-line string for tests and quick inspection.
 * 成立クラスタは A-B-C 形式、不足分は `?` でパディング、クラスタ間は ` / ` 区切り。
 * 死亡 member には `†` を付けて生死を視認できるようにする。
 */
export function formatMasonClusters(result: MasonClustersResult): string {
  return result.clusters
    .map(cluster => {
      const parts = cluster.members.map(m => m.dead ? `${m.name}†` : m.name)
      const padding = Math.max(0, result.capacity - cluster.members.length)
      for (let i = 0; i < padding; i++) parts.push('?')
      return parts.join('-')
    })
    .join(' / ')
}
