import type { VillageStatus } from '../../src/types/index.ts'

export type SuggestionReason = {
  type: 'direct_vote' | 'mutual_vote' | 'decisive_vote' | 'co_vote_penalty'
  day?: number
  contribution: number
}

export type WolfPairSuggestion = {
  seatA: number
  seatB: number
  score: number
  reasons: SuggestionReason[]
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`
}

function canonicalPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a]
}

export function scoreWolfPairs(
  vs: VillageStatus,
  players: Map<number, string>,
  existingPairs: number[][],
  canBeWolf?: Set<number>
): WolfPairSuggestion[] {
  const allSeats = [...players.keys()]
  if (allSeats.length < 2) return []

  const existingKeys = new Set(
    existingPairs.map(g => pairKey(g[0], g[1]))
  )

  // Build set of executed seats per day for decisive vote detection
  const executedOnDay = new Map<number, Set<number>>()
  for (const [day, seats] of vs.executions) {
    executedOnDay.set(day, new Set(seats))
  }

  // Accumulate scores per pair
  const scores = new Map<string, { seatA: number, seatB: number, score: number, reasons: SuggestionReason[] }>()

  function addScore(a: number, b: number, contribution: number, reason: SuggestionReason) {
    const key = pairKey(a, b)
    if (!scores.has(key)) {
      const [sA, sB] = canonicalPair(a, b)
      scores.set(key, { seatA: sA, seatB: sB, score: 0, reasons: [] })
    }
    const entry = scores.get(key)!
    entry.score += contribution
    entry.reasons.push(reason)
  }

  // Track which pairs have direct votes in each direction
  const hasDirectVote = new Map<string, Set<string>>()

  for (const [day, votes] of vs.voteHistory) {
    const totalVoters = votes.length

    // Build vote map for this day
    const dayVoteMap = new Map<number, number>()
    const dayVoteOrder = new Map<number, number>()

    for (let i = 0; i < votes.length; i++) {
      const { voter, target } = votes[i]
      dayVoteMap.set(voter, target)
      dayVoteOrder.set(voter, i + 1)
    }

    // Find who got the most votes (for decisive vote detection)
    const voteCounts = new Map<number, number>()
    for (const { target } of votes) {
      voteCounts.set(target, (voteCounts.get(target) ?? 0) + 1)
    }
    const executed = executedOnDay.get(day)

    // 1. Direct votes: A voted for B
    for (const { voter, target } of votes) {
      if (voter === target) continue

      const order = dayVoteOrder.get(voter) ?? 1
      const earlyBonus = 1.0 + 0.5 * Math.max(0, 1 - (order - 1) / Math.max(1, totalVoters - 1))
      const contribution = 3.0 * earlyBonus

      addScore(voter, target, contribution, { type: 'direct_vote', day, contribution })

      // Decisive vote bonus: voter contributed to target's execution
      if (executed?.has(target)) {
        addScore(voter, target, 2.0, { type: 'decisive_vote', day, contribution: 2.0 })
      }

      // Track direction for mutual vote bonus
      const key = pairKey(voter, target)
      if (!hasDirectVote.has(key)) hasDirectVote.set(key, new Set())
      hasDirectVote.get(key)!.add(`${voter}->${target}`)
    }

    // 2. Co-voting penalty: A and B both voted for the same target
    for (let i = 0; i < allSeats.length; i++) {
      for (let j = i + 1; j < allSeats.length; j++) {
        const a = allSeats[i]
        const b = allSeats[j]
        const targetA = dayVoteMap.get(a)
        const targetB = dayVoteMap.get(b)
        if (targetA !== undefined && targetB !== undefined && targetA === targetB) {
          addScore(a, b, -1.0, { type: 'co_vote_penalty', day, contribution: -1.0 })
        }
      }
    }
  }

  // 3. Mutual vote bonus
  for (const [key, directions] of hasDirectVote) {
    if (directions.size >= 2) {
      const entry = scores.get(key)
      if (entry) {
        const contribution = 2.0
        entry.score += contribution
        entry.reasons.push({ type: 'mutual_vote', contribution })
      }
    }
  }

  // Filter, sort, return top 3
  return [...scores.values()]
    .filter(s => s.score > 0
      && !existingKeys.has(pairKey(s.seatA, s.seatB))
      && (!canBeWolf || (canBeWolf.has(s.seatA) && canBeWolf.has(s.seatB)))
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ seatA, seatB, score, reasons }) => ({
      seatA,
      seatB,
      score: Math.round(score * 10) / 10,
      reasons: reasons.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    }))
}
