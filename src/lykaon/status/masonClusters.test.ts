import { describe, test } from 'node:test'
import assert from 'node:assert'
import { parse } from '../../howl/parser.ts'
import { buildVillageStatus } from '../../howl/bridge.ts'
import { extractClaimGroups } from './extract.ts'
import { buildMasonClusters, formatMasonClusters } from './masonClusters.ts'

function setup(howl: string) {
  const { statements, meta } = parse(howl)
  return buildVillageStatus(statements, meta)
}

function masonGroupFrom(howl: string) {
  const { vs, players } = setup(howl)
  const groups = extractClaimGroups(vs, players)
  return groups.find(g => g.role === 'mason')
}

function context(howl: string) {
  const { vs, players } = setup(howl)
  const groups = extractClaimGroups(vs, players)
  const masonGroup = groups.find(g => g.role === 'mason')
  const deadPlayers = new Map<number, string>()
  for (const [seat, status] of vs.statuses) {
    if (!status.surviving) deadPlayers.set(seat, players.get(seat) ?? `#${seat}`)
  }
  return { masonGroup, deadPlayers }
}

const PLAYERS = '++アリス、ボブ、チャーリー、デイブ、エミリー'

describe('buildMasonClusters', () => {
  test('pattern 1: 誰も共有 CO していない → clusters 空', () => {
    const group = masonGroupFrom(PLAYERS)
    const result = buildMasonClusters(group, 2)
    assert.deepEqual(result.clusters, [])
    assert.strictEqual(result.signals.overCapacity, false)
    assert.strictEqual(result.signals.multipleGroups, false)
    assert.strictEqual(result.signals.oversizedCluster, false)
  })

  test('pattern 2: 単独 CO 1 名 (相方未指定) → A 孤立', () => {
    const group = masonGroupFrom(`${PLAYERS}

アリス: 共有CO`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 1)
    assert.deepEqual(result.clusters[0].members.map(m => m.name), ['アリス'])
    assert.strictEqual(result.clusters[0].complete, false)
    assert.strictEqual(result.signals.overCapacity, false)
  })

  test('pattern 3: 共有 A B エイリアス → A-B 成立', () => {
    const group = masonGroupFrom(`${PLAYERS}

共有 アリス ボブ`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 1)
    assert.deepEqual(result.clusters[0].members.map(m => m.name), ['アリス', 'ボブ'])
    assert.strictEqual(result.clusters[0].complete, true)
    assert.strictEqual(result.signals.overCapacity, false)
    assert.strictEqual(result.signals.multipleGroups, false)
    assert.strictEqual(result.signals.oversizedCluster, false)
  })

  test('pattern 4: 片想い (A→B、B は別役職 CO) → A のみ孤立', () => {
    const group = masonGroupFrom(`${PLAYERS}

アリス: 共有CO ボブ○
ボブ: 占いCO`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 1)
    assert.deepEqual(result.clusters[0].members.map(m => m.name), ['アリス'])
    assert.strictEqual(result.clusters[0].complete, false)
  })

  test('pattern 5: 全員バラバラ単独 CO → 全員孤立', () => {
    const group = masonGroupFrom(`${PLAYERS}

アリス: 共有CO
ボブ: 共有CO
チャーリー: 共有CO`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 3)
    for (const cluster of result.clusters) {
      assert.strictEqual(cluster.members.length, 1)
      assert.strictEqual(cluster.complete, false)
    }
    assert.strictEqual(result.signals.overCapacity, true)
    assert.strictEqual(result.signals.multipleGroups, false)
  })

  test('pattern 6: チェーン (A→B, B→C で C は CO せず) → A, B 孤立 (C は対象外)', () => {
    const group = masonGroupFrom(`${PLAYERS}

アリス: 共有CO ボブ○
ボブ: 共有CO チャーリー○`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 2, 'C は CO していないのでクラスタに含めない')
    const names = result.clusters.flatMap(c => c.members.map(m => m.name))
    assert.deepEqual(names.sort(), ['アリス', 'ボブ'])
    for (const cluster of result.clusters) {
      assert.strictEqual(cluster.complete, false, '相互認知が成立していないので不成立')
    }
  })

  test('pattern 7: 成立ペア + 単独割り込み → A-B 成立 + C 孤立', () => {
    const group = masonGroupFrom(`${PLAYERS}

共有 アリス ボブ
チャーリー: 共有CO`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 2)
    const completeCluster = result.clusters.find(c => c.complete)!
    const isolatedCluster = result.clusters.find(c => !c.complete)!
    assert.deepEqual(completeCluster.members.map(m => m.name), ['アリス', 'ボブ'])
    assert.deepEqual(isolatedCluster.members.map(m => m.name), ['チャーリー'])
    assert.strictEqual(result.signals.overCapacity, true)
    assert.strictEqual(result.signals.multipleGroups, false)
  })

  test('pattern 8: 偽ペア 2 組 → A-B + C-D 両方成立 (multipleGroups)', () => {
    const group = masonGroupFrom(`${PLAYERS}

共有 アリス ボブ
共有 チャーリー デイブ`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 2)
    for (const cluster of result.clusters) {
      assert.strictEqual(cluster.complete, true)
    }
    assert.strictEqual(result.signals.overCapacity, true)
    assert.strictEqual(result.signals.multipleGroups, true)
  })

  test('pattern 9: 3 人一括 共有 A B C (capacity=2) → A-B-C 成立だが定員超過', () => {
    const group = masonGroupFrom(`${PLAYERS}

共有 アリス ボブ チャーリー`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 1)
    assert.deepEqual(result.clusters[0].members.map(m => m.name), ['アリス', 'ボブ', 'チャーリー'])
    assert.strictEqual(result.clusters[0].complete, true)
    assert.strictEqual(result.signals.overCapacity, true)
    assert.strictEqual(result.signals.oversizedCluster, true)
  })

  test('pattern 10: 共有 CO 後に A 噛み → A.dead=true', () => {
    const group = masonGroupFrom(`${PLAYERS}

共有 アリス ボブ

噛み アリス`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 1)
    const cluster = result.clusters[0]
    assert.strictEqual(cluster.complete, true)
    const alice = cluster.members.find(m => m.name === 'アリス')!
    const bob = cluster.members.find(m => m.name === 'ボブ')!
    assert.strictEqual(alice.dead, true)
    assert.strictEqual(bob.dead, false)
  })

  test('pattern 11: capacity=3 で 3 人一括成立 (定員ぴったり、oversized でない)', () => {
    const group = masonGroupFrom(`${PLAYERS}

共有 アリス ボブ チャーリー`)
    const result = buildMasonClusters(group, 3)
    assert.strictEqual(result.clusters.length, 1)
    assert.strictEqual(result.clusters[0].complete, true)
    assert.strictEqual(result.clusters[0].members.length, 3)
    assert.strictEqual(result.signals.overCapacity, false)
    assert.strictEqual(result.signals.oversizedCluster, false)
  })

  test('seat 昇順で members がソートされる', () => {
    const group = masonGroupFrom(`${PLAYERS}

共有 チャーリー アリス`)
    const result = buildMasonClusters(group, 2)
    const seats = result.clusters[0].members.map(m => m.seat)
    assert.deepEqual(seats, [...seats].sort((a, b) => a - b))
  })

  test('pattern 12: 既に死亡したプレイヤーを相方主張 → 一方向でも cluster 成立', () => {
    const { masonGroup, deadPlayers } = context(`${PLAYERS}

噛み ボブ

アリス: 共有CO ボブ○`)
    const result = buildMasonClusters(masonGroup, 2, deadPlayers)
    assert.strictEqual(result.clusters.length, 1)
    const cluster = result.clusters[0]
    assert.strictEqual(cluster.complete, true, '死亡相手の主張は相互認知の代わりに成立扱い')
    assert.deepEqual(cluster.members.map(m => m.name).sort(), ['アリス', 'ボブ'])
    const bob = cluster.members.find(m => m.name === 'ボブ')!
    assert.strictEqual(bob.dead, true)
  })

  test('pattern 13: 死亡相手 + 生存単独 CO の混在', () => {
    const { masonGroup, deadPlayers } = context(`${PLAYERS}

噛み ボブ

アリス: 共有CO ボブ○
チャーリー: 共有CO`)
    const result = buildMasonClusters(masonGroup, 2, deadPlayers)
    assert.strictEqual(result.clusters.length, 2)
    const completeCluster = result.clusters.find(c => c.complete)!
    const isolatedCluster = result.clusters.find(c => !c.complete)!
    assert.deepEqual(completeCluster.members.map(m => m.name).sort(), ['アリス', 'ボブ'])
    assert.deepEqual(isolatedCluster.members.map(m => m.name), ['チャーリー'])
  })

  test('pattern 14: 処刑死も成立扱い (causeOfDeath 不問)', () => {
    const { masonGroup, deadPlayers } = context(`${PLAYERS}

吊り ボブ

アリス: 共有CO ボブ○`)
    const result = buildMasonClusters(masonGroup, 2, deadPlayers)
    assert.strictEqual(result.clusters.length, 1)
    assert.strictEqual(result.clusters[0].complete, true)
  })

  test('pattern 15: deadPlayers 未指定なら死亡救済なし (後方互換)', () => {
    const group = masonGroupFrom(`${PLAYERS}

噛み ボブ

アリス: 共有CO ボブ○`)
    const result = buildMasonClusters(group, 2)
    assert.strictEqual(result.clusters.length, 1)
    assert.strictEqual(result.clusters[0].complete, false, 'deadPlayers なしなら A 孤立')
    assert.deepEqual(result.clusters[0].members.map(m => m.name), ['アリス'])
  })
})

/**
 * 表示形式の可視化テスト。
 * 各 howl 入力に対する formatMasonClusters の出力を test 名と共に表示するため、
 * node:test の出力を見れば全パターンの「実際の表示」が一目で確認できる。
 *
 *   成立: A-B / A-B-C
 *   不成立: A-? (capacity 不足分を ? でパディング)
 *   死亡 member: A-ボブ† (相互認知の代わりに死亡救済で成立)
 */
describe('formatMasonClusters (可視化)', () => {
  const cases: { pattern: string, body: string, capacity: number, expected: string }[] = [
    { pattern: '01 誰も CO していない', body: '', capacity: 2, expected: '' },
    { pattern: '02 単独 CO 1 名', body: 'アリス: 共有CO', capacity: 2, expected: 'アリス-?' },
    { pattern: '03 共有 A B エイリアス', body: '共有 アリス ボブ', capacity: 2, expected: 'アリス-ボブ' },
    { pattern: '04 片想い (B 別役職)', body: 'アリス: 共有CO ボブ○\nボブ: 占いCO', capacity: 2, expected: 'アリス-?' },
    { pattern: '05 全員バラバラ単独 CO', body: 'アリス: 共有CO\nボブ: 共有CO\nチャーリー: 共有CO', capacity: 2, expected: 'アリス-? / ボブ-? / チャーリー-?' },
    { pattern: '06 チェーン (C は CO せず)', body: 'アリス: 共有CO ボブ○\nボブ: 共有CO チャーリー○', capacity: 2, expected: 'アリス-? / ボブ-?' },
    { pattern: '07 成立ペア + 単独割り込み', body: '共有 アリス ボブ\nチャーリー: 共有CO', capacity: 2, expected: 'アリス-ボブ / チャーリー-?' },
    { pattern: '08 偽ペア 2 組', body: '共有 アリス ボブ\n共有 チャーリー デイブ', capacity: 2, expected: 'アリス-ボブ / チャーリー-デイブ' },
    { pattern: '09 3 人一括 (定員 2)', body: '共有 アリス ボブ チャーリー', capacity: 2, expected: 'アリス-ボブ-チャーリー' },
    { pattern: '10 CO 後にペアの片割れ噛み', body: '共有 アリス ボブ\n\n噛み アリス', capacity: 2, expected: 'アリス†-ボブ' },
    { pattern: '11 capacity=3 で 3 人ぴったり', body: '共有 アリス ボブ チャーリー', capacity: 3, expected: 'アリス-ボブ-チャーリー' },
    { pattern: '12 死亡相手への一方向 CO', body: '噛み ボブ\n\nアリス: 共有CO ボブ○', capacity: 2, expected: 'アリス-ボブ†' },
    { pattern: '13 死亡相手 + 生存単独 CO', body: '噛み ボブ\n\nアリス: 共有CO ボブ○\nチャーリー: 共有CO', capacity: 2, expected: 'アリス-ボブ† / チャーリー-?' },
    { pattern: '14 処刑死を相方主張', body: '吊り ボブ\n\nアリス: 共有CO ボブ○', capacity: 2, expected: 'アリス-ボブ†' },
  ]

  for (const c of cases) {
    test(`${c.pattern} → ${c.expected || '(空)'}`, () => {
      const howl = c.body ? `${PLAYERS}\n\n${c.body}` : PLAYERS
      const { masonGroup, deadPlayers } = context(howl)
      const result = buildMasonClusters(masonGroup, c.capacity, deadPlayers)
      assert.strictEqual(formatMasonClusters(result), c.expected)
    })
  }
})
