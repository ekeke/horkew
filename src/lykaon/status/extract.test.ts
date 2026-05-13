import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from '../../howl/parser.ts'
import { buildVillageStatus } from '../../howl/bridge.ts'
import {
  extractSurvivorInfo,
  extractDeathHistory,
  extractClaimGroups,
  extractVoteStatus,
  computeVerdicts,
  buildAssertionTimeline,
  causeOfDeathLabel,
} from './extract.ts'
import type { VoteStatus, VoteRow } from './extract.ts'

function setup(howl: string) {
  const { statements, meta } = parse(howl)
  return buildVillageStatus(statements, meta)
}

describe('extractSurvivorInfo', () => {
  test('all alive when no deaths', () => {
    const { vs, players } = setup('++アリス、ボブ、チャーリー')
    const info = extractSurvivorInfo(vs, players)
    assert.strictEqual(info.alive, 3)
    assert.strictEqual(info.total, 3)
    assert.strictEqual(info.survivors.length, 3)
  })

  test('correct count after execution', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス`)
    const info = extractSurvivorInfo(vs, players)
    assert.strictEqual(info.alive, 4)
    assert.strictEqual(info.total, 5)
    const names = info.survivors.map(s => s.name)
    assert.ok(!names.includes('アリス'))
    assert.ok(names.includes('ボブ'))
  })

  test('correct count after execution and night kill', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス

噛み ボブ`)
    const info = extractSurvivorInfo(vs, players)
    assert.strictEqual(info.alive, 3)
    assert.strictEqual(info.total, 5)
  })
})

describe('extractDeathHistory', () => {
  test('empty when no deaths', () => {
    const { vs, players } = setup('++アリス、ボブ、チャーリー')
    const history = extractDeathHistory(vs, players)
    assert.strictEqual(history.length, 0)
  })

  test('execution on day 1', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス`)
    const history = extractDeathHistory(vs, players)
    assert.strictEqual(history.length, 1)
    assert.strictEqual(history[0].day, 1)
    assert.strictEqual(history[0].executions.length, 1)
    assert.strictEqual(history[0].executions[0].name, 'アリス')
    assert.strictEqual(history[0].executions[0].causeOfDeath, 'execution')
    assert.strictEqual(history[0].nightKills.length, 0)
  })

  test('night kill displayed on discovery day (next day)', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス

噛み ボブ`)
    const history = extractDeathHistory(vs, players)
    // Day 1: execution of アリス
    const day1 = history.find(d => d.day === 1)!
    assert.ok(day1)
    assert.strictEqual(day1.executions[0].name, 'アリス')
    assert.strictEqual(day1.nightKills.length, 0)
    // Day 2: ボブ discovered (night kill on night 1, displayed on day 2)
    const day2 = history.find(d => d.day === 2)!
    assert.ok(day2)
    assert.strictEqual(day2.nightKills[0].name, 'ボブ')
  })

  test('multi-day deaths sorted by day', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー、フランク、ジョージ

吊り アリス

噛み ボブ

吊り チャーリー

噛み デイブ`)
    const history = extractDeathHistory(vs, players)
    assert.ok(history.length >= 2)
    // Days should be ascending
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].day >= history[i - 1].day)
    }
  })

  test('curse after execution appears in executions row', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス
道連れ ボブ`)
    const history = extractDeathHistory(vs, players)
    const day1 = history.find(d => d.day === 1)!
    // ボブ's curse death is execution-related, belongs in executions
    const cursed = day1.executions.find(e => e.name === 'ボブ')
    assert.ok(cursed)
    assert.strictEqual(cursed!.causeOfDeath, 'cursed_by_executed_nekomata')
    assert.strictEqual(day1.nightKills.length, 0)
  })
})

describe('extractClaimGroups', () => {
  test('empty when no claims', () => {
    const { vs, players } = setup('++アリス、ボブ、チャーリー')
    const groups = extractClaimGroups(vs, players)
    assert.strictEqual(groups.length, 0)
  })

  test('single seer claim', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白`)
    const groups = extractClaimGroups(vs, players)
    assert.strictEqual(groups.length, 1)
    assert.strictEqual(groups[0].role, 'seer')
    assert.strictEqual(groups[0].roleShortName, '占')
    assert.strictEqual(groups[0].rows.length, 1)
    assert.strictEqual(groups[0].rows[0].name, 'アリス')
  })

  test('multiple roles grouped and ordered correctly', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白
チャーリー: 霊媒CO`)
    const groups = extractClaimGroups(vs, players)
    assert.strictEqual(groups.length, 2)
    // Seer before medium in roleOrder
    assert.strictEqual(groups[0].role, 'seer')
    assert.strictEqual(groups[1].role, 'medium')
  })

  test('two seer claimants in same group', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白
デイブ: 占いCO チャーリー黒`)
    const groups = extractClaimGroups(vs, players)
    assert.strictEqual(groups.length, 1)
    assert.strictEqual(groups[0].role, 'seer')
    assert.strictEqual(groups[0].rows.length, 2)
  })
})

describe('buildAssertionTimeline', () => {
  test('seer assertions mapped to sequential nights', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り デイブ

噛み エミリー

吊り ボブ

アリス: 占いCO ボブ白 チャーリー黒`)
    const groups = extractClaimGroups(vs, players)
    const seerGroup = groups.find(g => g.role === 'seer')!
    const row = seerGroup.rows[0]
    // vs.day is now 2, assertions right-aligned: nights 0 and 1
    const timeline = buildAssertionTimeline(row, vs.day, players)

    // Night 0 (お告げ): ボブ→白
    const night0 = timeline.get(0)
    assert.ok(night0)
    assert.strictEqual(night0!.targetName, 'ボブ')
    assert.strictEqual(night0!.species, 'human')

    // Night 1: チャーリー→黒
    const night1 = timeline.get(1)
    assert.ok(night1)
    assert.strictEqual(night1!.targetName, 'チャーリー')
    assert.strictEqual(night1!.species, 'wolf')
  })

  test('bodyguard last guard anchored to previous night', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

吊り デイブ

噛み エミリー

アリス: 狩人CO ボブ護衛`)
    // Reported on day 2 → last (only) guard = night 1 (day-1)
    const groups = extractClaimGroups(vs, players)
    const bgGroup = groups.find(g => g.role === 'bodyguard')!
    const row = bgGroup.rows[0]
    const timeline = buildAssertionTimeline(row, vs.day, players)
    const night1 = timeline.get(1)
    assert.ok(night1)
    assert.strictEqual(night1!.targetName, 'ボブ')
  })

  test('bodyguard multiple guards: last = day-1, counting backwards', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー、フランク、ジョージ

吊り デイブ

噛み エミリー

吊り フランク

噛み ジョージ

アリス: 狩人CO チャーリー護衛 ボブ護衛`)
    // Reported on day 3 → last guard (ボブ) = night 2 (day-1), first (チャーリー) = night 1
    const groups = extractClaimGroups(vs, players)
    const bgGroup = groups.find(g => g.role === 'bodyguard')!
    const row = bgGroup.rows[0]
    const timeline = buildAssertionTimeline(row, vs.day, players)
    assert.strictEqual(timeline.get(1)!.targetName, 'チャーリー')
    assert.strictEqual(timeline.get(2)!.targetName, 'ボブ')
  })

  test('empty timeline when no assertions', () => {
    const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 霊媒CO`)
    const groups = extractClaimGroups(vs, players)
    const row = groups[0].rows[0]
    const timeline = buildAssertionTimeline(row, vs.day, players)
    assert.strictEqual(timeline.size, 0)
  })
})

describe('causeOfDeathLabel', () => {
  test('returns Japanese labels', () => {
    assert.strictEqual(causeOfDeathLabel('execution'), '処刑')
    assert.strictEqual(causeOfDeathLabel('night_kill'), '襲撃')
    assert.strictEqual(causeOfDeathLabel('follow_executed_hamster'), '後追い')
    assert.strictEqual(causeOfDeathLabel('cursed_by_executed_nekomata'), '道連れ')
  })
})

// --- computeVerdicts tests ---

/**
 * Build a VoteStatus from a compact config.
 * votes: array of [targetSeat, [...voterSeats]] — voter order within each target is preserved,
 *   and a global votedOrder is assigned across all targets by interleaving in the order given.
 * voteOrder: optional explicit global order of votes as [targetSeat, voterSeat] pairs.
 *   If omitted, voters are assigned votedOrder 1,2,3... by iterating votes entries sequentially.
 */
function makeVoteStatus(config: {
  votes: [number, number[]][]
  pending?: number[]
  totalVoters: number
  voteOrder?: [number, number][]  // explicit ordering: [target, voter] pairs in chronological order
}): VoteStatus {
  const { votes, pending = [], totalVoters, voteOrder } = config

  // Build votedOrder mapping
  const orderMap = new Map<string, number>() // "voter" → votedOrder
  if (voteOrder) {
    for (let i = 0; i < voteOrder.length; i++) {
      const [target, voter] = voteOrder[i]
      orderMap.set(`${target}:${voter}`, i + 1)
    }
  } else {
    let order = 0
    for (const [, voterSeats] of votes) {
      for (const v of voterSeats) {
        orderMap.set(`*:${v}`, ++order)
      }
    }
  }

  const rows: VoteRow[] = []
  for (const [target, voterSeats] of votes) {
    const voters = voterSeats.map(v => {
      const key = voteOrder ? `${target}:${v}` : `*:${v}`
      return { seat: v, name: `P${v}`, votedOrder: orderMap.get(key) ?? 0 }
    })
    voters.sort((a, b) => a.votedOrder - b.votedOrder)
    rows.push({
      seat: target,
      name: `P${target}`,
      votedCount: voterSeats.length,
      voters,
    })
  }
  rows.sort((a, b) => b.votedCount - a.votedCount || a.seat - b.seat)

  return {
    rows,
    pending: pending.map(s => ({ seat: s, name: `P${s}` })),
    remainingVotes: pending.length,
    totalVoters,
    hasAnyVotes: rows.length > 0,
    executionOccurred: false,
    hasMultiVote: false,
  }
}

describe('computeVerdicts', () => {
  describe('verdict classification', () => {
    test('all at_risk when evenly split with remaining votes', () => {
      // A=3, B=3, 4 remaining (total=10)
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13]], [2, [14, 15, 16]]],
        pending: [17, 18, 19, 20],
        totalVoters: 10,
      })
      const verdicts = computeVerdicts(status)
      assert.strictEqual(verdicts.get(1)?.verdict, 'at_risk')
      assert.strictEqual(verdicts.get(2)?.verdict, 'at_risk')
    })

    test('execution_locked when sole leader is unreachable', () => {
      // A=5, B=2, remaining=0 (total=7)
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14, 15]], [2, [16, 17]]],
        totalVoters: 7,
      })
      const verdicts = computeVerdicts(status)
      assert.strictEqual(verdicts.get(1)?.verdict, 'execution_locked')
      assert.strictEqual(verdicts.get(2)?.verdict, 'safe')
    })

    test('runoff_locked: 5v4 with 1 remaining', () => {
      // A=5, B=4, remaining=1 (total=10). B can tie A but not surpass.
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14, 15]], [2, [16, 17, 18, 19]]],
        pending: [20],
        totalVoters: 10,
      })
      const verdicts = computeVerdicts(status)
      assert.strictEqual(verdicts.get(1)?.verdict, 'runoff_locked')
      assert.strictEqual(verdicts.get(2)?.verdict, 'at_risk')
    })

    test('safe when candidate cannot reach max', () => {
      // A=5, B=1, remaining=0 (total=6)
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14, 15]], [2, [16]]],
        totalVoters: 6,
      })
      const verdicts = computeVerdicts(status)
      assert.strictEqual(verdicts.get(1)?.verdict, 'execution_locked')
      assert.strictEqual(verdicts.get(2)?.verdict, 'safe')
    })

    test('mixed: execution + at_risk + safe', () => {
      // A=6, B=3, C=1, remaining=2 (total=12)
      // A: maxOther=3, 3+2=5<6 → execution_locked
      // B: maxOther=6, 6+2=8>3 but 3+2=5<6 → safe
      // C: maxOther=6, 1+2=3<6 → safe
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14, 15, 16]], [2, [17, 18, 19]], [3, [20]]],
        pending: [21, 22],
        totalVoters: 12,
      })
      const verdicts = computeVerdicts(status)
      assert.strictEqual(verdicts.get(1)?.verdict, 'execution_locked')
      assert.strictEqual(verdicts.get(2)?.verdict, 'safe')
      assert.strictEqual(verdicts.get(3)?.verdict, 'safe')
    })

    test('runoff_locked when tied with no remaining', () => {
      // A=4, B=4, remaining=0
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14]], [2, [15, 16, 17, 18]]],
        totalVoters: 8,
      })
      const verdicts = computeVerdicts(status)
      assert.strictEqual(verdicts.get(1)?.verdict, 'runoff_locked')
      assert.strictEqual(verdicts.get(2)?.verdict, 'runoff_locked')
    })
  })

  describe('decisive voter identification', () => {
    test('execution_locked: interleaved votes, correct decisive voter', () => {
      // A gets votes at orders 1,3,5,7,9; B at 2,4,8; C at 6. remaining=0, total=9.
      // Simulation for candidate A:
      //   step0(A,o1): A=1,r=8. maxO=0. 0+8<=1? No.
      //   step1(B,o2): B=1,r=7. maxO=1. 1+7<=1? No.
      //   step2(A,o3): A=2,r=6. maxO=1. 1+6<=2? No.
      //   step3(B,o4): B=2,r=5. maxO=2. 2+5<=2? No.
      //   step4(A,o5): A=3,r=4. maxO=2. 2+4<=3? No.
      //   step5(C,o6): C=1,r=3. maxO=2. 2+3<=3? No.
      //   step6(A,o7): A=4,r=2. maxO=2. 2+2<=4? Yes → runoff voter = lastFor[A]=o7
      //   step7(B,o8): B=3,r=1. maxO=3. 3+1<4? No.
      //   step8(A,o9): A=5,r=0. maxO=3. 3+0<5? Yes → exec voter = lastFor[A]=o9
      const status = makeVoteStatus({
        votes: [[1, [11, 13, 15, 17, 19]], [2, [12, 14, 18]], [3, [16]]],
        totalVoters: 9,
        voteOrder: [
          [1, 11], [2, 12], [1, 13], [2, 14], [1, 15],
          [3, 16], [1, 17], [2, 18], [1, 19],
        ],
      })
      const verdicts = computeVerdicts(status)
      const info = verdicts.get(1)!
      assert.strictEqual(info.verdict, 'execution_locked')
      assert.strictEqual(info.runoffVoterOrder, 7, 'runoff decisive voter should be P17 (order 7)')
      assert.strictEqual(info.executionVoterOrder, 9, 'exec decisive voter should be P19 (order 9)')
    })

    test('runoff_locked: decisive voter identified', () => {
      // A=5, B=4, remaining=1, total=10
      // Sequential: A votes first (o1-5), then B (o6-9)
      // step4(A,o5): A=5,r=5. maxO=0. 0+5<=5? Yes → runoff voter = o5
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14, 15]], [2, [16, 17, 18, 19]]],
        pending: [20],
        totalVoters: 10,
      })
      const verdicts = computeVerdicts(status)
      const info = verdicts.get(1)!
      assert.strictEqual(info.verdict, 'runoff_locked')
      assert.strictEqual(info.runoffVoterOrder, 5)
      assert.strictEqual(info.executionVoterOrder, undefined)
    })

    test('execution_locked: both runoff and execution voters set', () => {
      // A=5, B=2, remaining=0, total=7. Sequential order.
      // step0(A,o1): A=1,r=6. 0+6<=1? No.
      // step1(A,o2): A=2,r=5. 0+5<=2? No.
      // step2(A,o3): A=3,r=4. 0+4<=3? No.
      // step3(A,o4): A=4,r=3. 0+3<=4? Yes → runoff=o4.  0+3<4? Yes → exec=o4.
      // Wait, both at same step? That's because maxOther is still 0.
      // Actually: runoff cond is 0+3<=4 → Yes. exec cond is 0+3<4 → Yes.
      // So both set at same step when no opposition votes have been counted yet.
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14, 15]], [2, [16, 17]]],
        totalVoters: 7,
      })
      const verdicts = computeVerdicts(status)
      const info = verdicts.get(1)!
      assert.strictEqual(info.verdict, 'execution_locked')
      assert.ok(info.runoffVoterOrder !== undefined, 'runoffVoterOrder should be set')
      assert.ok(info.executionVoterOrder !== undefined, 'executionVoterOrder should be set')
      // execution voter should be >= runoff voter (same or later)
      assert.ok(info.executionVoterOrder! >= info.runoffVoterOrder!)
    })

    test('safe: savedBy identifies the correct voter', () => {
      // A=5, B=2, remaining=0, total=7. Sequential.
      // B is safe: 2+0<5.
      // Simulation for B:
      //   step0(A,o1): A=1,r=6. B:0+6<1? No.
      //   step1(A,o2): A=2,r=5. B:0+5<2? No.
      //   step2(A,o3): A=3,r=4. B:0+4<3? No.
      //   step3(A,o4): A=4,r=3. B:0+3<4? Yes! savedBy = P14 (voted for A at order 4)
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14, 15]], [2, [16, 17]]],
        totalVoters: 7,
      })
      const verdicts = computeVerdicts(status)
      const info = verdicts.get(2)!
      assert.strictEqual(info.verdict, 'safe')
      assert.strictEqual(info.savedBy, 'P14')
    })

    test('safe: savedBy set even for 1-vote candidates', () => {
      // A=4, B=1, remaining=0, total=5. Sequential.
      // B is safe: 1+0<4. savedBy = whoever triggered it.
      // step2(A,o3): A=3,r=2. B:0+2<3? Yes! savedBy = P13
      const status = makeVoteStatus({
        votes: [[1, [11, 12, 13, 14]], [2, [15]]],
        totalVoters: 5,
      })
      const verdicts = computeVerdicts(status)
      const info = verdicts.get(2)!
      assert.strictEqual(info.verdict, 'safe')
      assert.strictEqual(info.savedBy, 'P13')
    })

    test('execution_locked with interleaved votes: runoff and exec voters differ', () => {
      // A=4, B=2, C=1, remaining=0, total=7.
      // Vote order: A(o1), B(o2), A(o3), C(o4), A(o5), B(o6), A(o7)
      // Simulation for candidate A:
      //   step0(A,o1): A=1,r=6. maxO=0. 0+6<=1? No.
      //   step1(B,o2): B=1,r=5. maxO=1. 1+5<=1? No.
      //   step2(A,o3): A=2,r=4. maxO=1. 1+4<=2? No.
      //   step3(C,o4): C=1,r=3. maxO=1. 1+3<=2? No.
      //   step4(A,o5): A=3,r=2. maxO=1. 1+2<=3? Yes → runoff=o5. 1+2<3? No.
      //   step5(B,o6): B=2,r=1. maxO=2. (runoff found). 2+1<3? No.
      //   step6(A,o7): A=4,r=0. maxO=2. (runoff found). 2+0<4? Yes → exec=o7.
      const status = makeVoteStatus({
        votes: [[1, [11, 13, 15, 17]], [2, [12, 16]], [3, [14]]],
        totalVoters: 7,
        voteOrder: [[1, 11], [2, 12], [1, 13], [3, 14], [1, 15], [2, 16], [1, 17]],
      })
      const verdicts = computeVerdicts(status)
      const info = verdicts.get(1)!
      assert.strictEqual(info.verdict, 'execution_locked')
      assert.strictEqual(info.runoffVoterOrder, 5, 'runoff voter is P15 at order 5')
      assert.strictEqual(info.executionVoterOrder, 7, 'exec voter is P17 at order 7')
    })
  })

    test('runoff_locked: triggering vote is for a different candidate', () => {
      // 4 candidates tied at 2 votes each, 1-vote candidates below.
      // A=2, B=2, C=2, D=2, E=1, remaining=0, total=9.
      // Vote order: A,A, B,B, C,C, D,D, E
      // Simulation for A:
      //   step0(A,o1): A=1,r=8. maxO=0. 0+8<=1? No.
      //   step1(A,o2): A=2,r=7. maxO=0. 0+7<=2? No.
      //   step2(B,o3): B=1,r=6. maxO=1. 1+6<=2? No.
      //   step3(B,o4): B=2,r=5. maxO=2. 2+5<=2? No.
      //   step4(C,o5): C=1,r=4. maxO=2. 2+4<=2? No.
      //   step5(C,o6): C=2,r=3. maxO=2. 2+3<=2? No.
      //   step6(D,o7): D=1,r=2. maxO=2. 2+2<=2? No.
      //   step7(D,o8): D=2,r=1. maxO=2. 2+1<=2? No.
      //   step8(E,o9): E=1,r=0. maxO=2. 2+0<=2? Yes → triggered by P9 (voted for E, not A!)
      const status = makeVoteStatus({
        votes: [[1, [11, 12]], [2, [13, 14]], [3, [15, 16]], [4, [17, 18]], [5, [19]]],
        totalVoters: 9,
        voteOrder: [[1, 11], [1, 12], [2, 13], [2, 14], [3, 15], [3, 16], [4, 17], [4, 18], [5, 19]],
      })
      const verdicts = computeVerdicts(status)
      const info = verdicts.get(1)!
      assert.strictEqual(info.verdict, 'runoff_locked')
      // P19 voted for candidate 5, but their vote triggered A's runoff lock
      assert.strictEqual(info.runoffVoterName, 'P19', 'triggering voter is P19 who voted for E')
      assert.strictEqual(info.runoffVoterOrder, 9)
    })

  describe('integration: howl → extractVoteStatus → computeVerdicts', () => {
    test('partial voting produces correct verdicts', () => {
      const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス→ボブ
チャーリー→ボブ
デイブ→ボブ`)
      const status = extractVoteStatus(vs, players)
      assert.strictEqual(status.rows.length, 1) // only ボブ has votes
      assert.strictEqual(status.rows[0].votedCount, 3)
      assert.strictEqual(status.pending.length, 2) // ボブ and エミリー
      const verdicts = computeVerdicts(status)
      // 3 votes, 2 remaining, maxOther=0: 0+2<3 → execution_locked
      assert.strictEqual(verdicts.get(status.rows[0].seat)?.verdict, 'execution_locked')
    })

    test('hidden after execution', () => {
      const { vs, players } = setup(`++アリス、ボブ、チャーリー、デイブ、エミリー

アリス→ボブ
チャーリー→ボブ
デイブ→ボブ
吊り ボブ`)
      const status = extractVoteStatus(vs, players)
      assert.strictEqual(status.executionOccurred, true)
    })
  })
})
