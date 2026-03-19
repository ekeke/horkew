import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from '../../src/howl/parser.ts'
import { buildVillageStatus } from '../../src/howl/bridge.ts'
import {
  extractSurvivorInfo,
  extractDeathHistory,
  extractClaimGroups,
  buildAssertionTimeline,
  causeOfDeathLabel,
} from './extract.ts'

function setup(howl: string) {
  const { statements, meta } = parse(howl)
  return buildVillageStatus(statements, meta)
}

describe('extractSurvivorInfo', () => {
  test('all alive when no deaths', () => {
    const { vs, players } = setup('+アリス、ボブ、チャーリー')
    const info = extractSurvivorInfo(vs, players)
    assert.strictEqual(info.alive, 3)
    assert.strictEqual(info.total, 3)
    assert.strictEqual(info.survivors.length, 3)
  })

  test('correct count after execution', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス`)
    const info = extractSurvivorInfo(vs, players)
    assert.strictEqual(info.alive, 4)
    assert.strictEqual(info.total, 5)
    const names = info.survivors.map(s => s.name)
    assert.ok(!names.includes('アリス'))
    assert.ok(names.includes('ボブ'))
  })

  test('correct count after execution and night kill', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス

噛み ボブ`)
    const info = extractSurvivorInfo(vs, players)
    assert.strictEqual(info.alive, 3)
    assert.strictEqual(info.total, 5)
  })
})

describe('extractDeathHistory', () => {
  test('empty when no deaths', () => {
    const { vs, players } = setup('+アリス、ボブ、チャーリー')
    const history = extractDeathHistory(vs, players)
    assert.strictEqual(history.length, 0)
  })

  test('execution on day 1', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス`)
    const history = extractDeathHistory(vs, players)
    assert.strictEqual(history.length, 1)
    assert.strictEqual(history[0].day, 1)
    assert.strictEqual(history[0].executions.length, 1)
    assert.strictEqual(history[0].executions[0].name, 'アリス')
    assert.strictEqual(history[0].executions[0].causeOfDeath, 'execution')
    assert.strictEqual(history[0].nightKills.length, 0)
  })

  test('night kill on day 1 (reported as attack on day 2)', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス

噛み ボブ`)
    const history = extractDeathHistory(vs, players)
    // Day 1: execution of アリス
    // Day 1: night kill of ボブ (kills map uses day-1 = day 1)
    assert.ok(history.length >= 1)
    const day1 = history.find(d => d.day === 1)!
    assert.ok(day1)
    assert.strictEqual(day1.executions[0].name, 'アリス')
    assert.strictEqual(day1.nightKills[0].name, 'ボブ')
  })

  test('multi-day deaths sorted by day', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー、フランク、ジョージ

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

  test('curse death appears in nightKills', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

吊り アリス
道連れ ボブ`)
    const history = extractDeathHistory(vs, players)
    const day1 = history.find(d => d.day === 1)!
    // ボブ's curse death should be in kills map (same day as execution)
    const cursed = day1.nightKills.find(e => e.name === 'ボブ')
    assert.ok(cursed)
    assert.strictEqual(cursed!.causeOfDeath, 'cursed_by_executed_nekomata')
  })
})

describe('extractClaimGroups', () => {
  test('empty when no claims', () => {
    const { vs, players } = setup('+アリス、ボブ、チャーリー')
    const groups = extractClaimGroups(vs, players)
    assert.strictEqual(groups.length, 0)
  })

  test('single seer claim', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白`)
    const groups = extractClaimGroups(vs, players)
    assert.strictEqual(groups.length, 1)
    assert.strictEqual(groups[0].role, 'seer')
    assert.strictEqual(groups[0].roleShortName, '占')
    assert.strictEqual(groups[0].rows.length, 1)
    assert.strictEqual(groups[0].rows[0].name, 'アリス')
  })

  test('multiple roles grouped and ordered correctly', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

アリス: 占いCO ボブ白
チャーリー: 霊媒CO`)
    const groups = extractClaimGroups(vs, players)
    assert.strictEqual(groups.length, 2)
    // Seer before medium in roleOrder
    assert.strictEqual(groups[0].role, 'seer')
    assert.strictEqual(groups[1].role, 'medium')
  })

  test('two seer claimants in same group', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

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
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

吊り デイブ

噛み エミリー

吊り ボブ

アリス: 占いCO ボブ白 チャーリー黒`)
    const groups = extractClaimGroups(vs, players)
    const seerGroup = groups.find(g => g.role === 'seer')!
    const row = seerGroup.rows[0]
    // vs.day is now 3, so timeline has nights 1 and 2
    const timeline = buildAssertionTimeline(row, vs.day, players)

    // Night 1: ボブ→白 (first assertion in insertion order)
    const night1 = timeline.get(1)
    assert.ok(night1)
    assert.strictEqual(night1!.targetName, 'ボブ')
    assert.strictEqual(night1!.species, 'human')

    // Night 2: チャーリー→黒 (second assertion)
    const night2 = timeline.get(2)
    assert.ok(night2)
    assert.strictEqual(night2!.targetName, 'チャーリー')
    assert.strictEqual(night2!.species, 'wolf')
  })

  test('bodyguard actions mapped by night', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

吊り デイブ

噛み エミリー

アリス: 狩人CO ボブ護衛`)
    const groups = extractClaimGroups(vs, players)
    const bgGroup = groups.find(g => g.role === 'bodyguard')!
    const row = bgGroup.rows[0]
    // guard reported on day 2 → bridge sets actions.set(day-1=1, target)
    const timeline = buildAssertionTimeline(row, vs.day, players)
    const night1 = timeline.get(1)
    assert.ok(night1)
    assert.strictEqual(night1!.targetName, 'ボブ')
    assert.strictEqual(night1!.species, null)
  })

  test('empty timeline when no assertions', () => {
    const { vs, players } = setup(`+アリス、ボブ、チャーリー、デイブ、エミリー

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
