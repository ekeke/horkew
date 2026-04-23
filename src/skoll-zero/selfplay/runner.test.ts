import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TrainingBuffer } from './buffer.ts'
import { DummyNN } from '../mcts/nn.ts'
import { runSelfPlayGame, runSelfPlayBatch, DEFAULT_ROLES } from './runner.ts'
import { MasonRoleAgent } from './mason-zero-agent.ts'
import { normalizeVisits, sampleFromVisits, argmaxFromVisits } from './policy-utils.ts'
import { createSkollZeroNetwork } from '../network/config.ts'
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'

describe('TrainingBuffer', () => {
  it('appendPending → finalize で z が貼られる', () => {
    const buf = new TrainingBuffer()
    buf.appendPending({
      obs: new Float32Array(8),
      visits: new Map([[5, 100], [7, 50]]),
      pi: new Map([[5, 0.67], [7, 0.33]]),
      day: 1,
      masonSeat: 3,
      alive: 0b11111110,
      headName: 'vote',
    })
    assert.equal(buf.size(), 0)
    assert.equal(buf.pendingSize(), 1)
    buf.finalize(1.0)
    assert.equal(buf.size(), 1)
    assert.equal(buf.pendingSize(), 0)
    assert.equal(buf.records()[0].z, 1.0)
  })

  it('reset で全クリア', () => {
    const buf = new TrainingBuffer()
    buf.appendPending({
      obs: new Float32Array(0),
      visits: new Map(),
      pi: new Map(),
      day: 1,
      masonSeat: 1,
      alive: 0b10,
      headName: 'vote',
    })
    buf.finalize(0.5)
    assert.equal(buf.size(), 1)
    buf.reset()
    assert.equal(buf.size(), 0)
    assert.equal(buf.pendingSize(), 0)
  })
})

describe('policy-utils', () => {
  it('normalizeVisits: 合計 1 に正規化', () => {
    const visits = new Map([[1, 30], [2, 70]])
    const pi = normalizeVisits(visits)
    assert.equal(pi.get(1), 0.3)
    assert.equal(pi.get(2), 0.7)
  })

  it('normalizeVisits: 合計 0 は空 Map', () => {
    const pi = normalizeVisits(new Map([[1, 0], [2, 0]]))
    assert.equal(pi.size, 0)
  })

  it('argmaxFromVisits: 最大 visit の action', () => {
    const visits = new Map([[1, 30], [2, 70], [3, 50]])
    assert.equal(argmaxFromVisits(visits), 2)
  })

  it('sampleFromVisits: 確率分布に従う（多数試行で大数の法則）', () => {
    const visits = new Map([[1, 100], [2, 0]])  // 全て action 1
    const counts = new Map<number, number>()
    let r = 0
    const rng = () => {
      r = (r * 1103515245 + 12345) & 0x7fffffff
      return r / 0x7fffffff
    }
    for (let i = 0; i < 100; i++) {
      const a = sampleFromVisits(visits, rng)
      counts.set(a, (counts.get(a) ?? 0) + 1)
    }
    assert.equal(counts.get(1), 100, '全 100 回 action 1')
    assert.ok(!counts.has(2), 'action 2 は visit 0 → 選ばれない')
  })
})

describe('SkollZeroRoleAgent.getLastMCTSResult', () => {
  it('初期状態では null', () => {
    const agent = new MasonRoleAgent({
      nn: new DummyNN(),
      setup: DEFAULT_ROLES,
      buffer: new TrainingBuffer(),
    })
    assert.equal(agent.getLastMCTSResult(), null)
  })
})

describe('runSelfPlayGame: dummy NN で end-to-end', () => {
  it('1 ゲーム完走、buffer に records が追加される', async () => {
    const buffer = new TrainingBuffer()
    const nn = new DummyNN()
    const result = await runSelfPlayGame({
      nn,
      buffer,
      seed: 42,
      mctsConfig: { cPuct: 1.5, nRollouts: 50, rng: Math.random },
    })

    // ゲームは終端に到達（draw 含む valid な result）
    assert.ok(['villager_won', 'werewolf_won', 'werehamster_won', 'draw'].includes(result.result ?? ''))
    // mason の vote 決定回数 = MCTS 呼び出し回数 + fallback 回数
    assert.ok(result.mctsCalls + result.fallbackCalls > 0, `mason の決定が 1 回以上発生 (MCTS=${result.mctsCalls}, fallback=${result.fallbackCalls})`)
    // buffer は MCTS 呼び出しぶん追加（fallback は記録しない）
    assert.equal(result.recordsAdded, result.mctsCalls,
      `records 数 (${result.recordsAdded}) = MCTS 呼び出し数 (${result.mctsCalls})`)
    if (result.recordsAdded > 0) {
      const recs = buffer.records()
      // z が全 record で同値
      const z = recs[0].z
      for (const r of recs) {
        assert.equal(r.z, z, '全 record で z 一致')
      }
      // π の合計が 1 (visits があれば)
      for (const r of recs) {
        if (r.pi && r.pi.size > 0) {
          let sum = 0
          for (const p of r.pi.values()) sum += p
          assert.ok(Math.abs(sum - 1) < 1e-6, `π 合計 = 1 (実測 ${sum})`)
        }
      }
    }
  })

  it('phase2Nets capture hook: claim head の outcome-SL record が buffer に蓄積される', async () => {
    const buffer = new TrainingBuffer()
    const nn = new DummyNN()
    // mason 席に mason-claim head checkpoint を注入 (random init で十分、挙動確認のみ)
    const masonClaimNet: TransformerNetwork = createSkollZeroNetwork()
    const phase2Nets = new Map<string, TransformerNetwork>([['mason-claim', masonClaimNet]])

    const result = await runSelfPlayGame({
      nn,
      buffer,
      seed: 100,
      mctsConfig: { cPuct: 1.5, nRollouts: 30, rng: Math.random },
      selectionMode: 'sample',  // capture hook が発火する条件
      phase2Nets,
    })

    assert.ok(['villager_won', 'werewolf_won', 'werehamster_won', 'draw'].includes(result.result ?? ''))

    // buffer には vote head (MCTS) + claim head (outcome-SL) の 2 種類が混在
    const records = buffer.records()
    const voteCount = records.filter(r => r.headName === 'vote').length
    const claimCount = records.filter(r => r.headName === 'claim').length

    assert.ok(voteCount > 0, `vote head records 1 件以上 (実測 ${voteCount})`)
    assert.ok(claimCount > 0, `claim head records 1 件以上 (capture hook 発火、実測 ${claimCount})`)

    // claim head records は actionIndex を持つ (softmax head の capture)
    for (const r of records.filter(r => r.headName === 'claim')) {
      assert.ok(r.actionIndex !== undefined, 'claim head は actionIndex を持つ')
      assert.ok(r.actionIndex >= 0 && r.actionIndex < 10, `actionIndex は 0-9 の範囲 (実測 ${r.actionIndex})`)
      assert.equal(r.visits, undefined, 'outcome-SL record は visits を持たない')
      assert.equal(r.pi, undefined, 'outcome-SL record は pi を持たない')
    }
  })

  it('phase2Nets capture hook: selectionMode=argmax では capture されない', async () => {
    const buffer = new TrainingBuffer()
    const nn = new DummyNN()
    const masonClaimNet: TransformerNetwork = createSkollZeroNetwork()
    const phase2Nets = new Map<string, TransformerNetwork>([['mason-claim', masonClaimNet]])

    await runSelfPlayGame({
      nn,
      buffer,
      seed: 100,
      mctsConfig: { cPuct: 1.5, nRollouts: 30, rng: Math.random },
      selectionMode: 'argmax',  // eval mode: record しない
      phase2Nets,
    })

    const claimCount = buffer.records().filter(r => r.headName === 'claim').length
    assert.equal(claimCount, 0, 'eval mode では claim head record なし')
  })

  it('runSelfPlayBatch: 3 games 連続実行', async () => {
    const buffer = new TrainingBuffer()
    const nn = new DummyNN()
    const results = await runSelfPlayBatch(
      {
        nn,
        buffer,
        seed: 100,
        mctsConfig: { cPuct: 1.5, nRollouts: 30, rng: Math.random },
      },
      3,
    )
    assert.equal(results.length, 3)
    // 各 game で結果が出ている
    for (const r of results) {
      assert.ok(['villager_won', 'werewolf_won', 'werehamster_won', 'draw'].includes(r.result ?? ''))
    }
    // buffer は累積（3 games ぶんの records）
    const totalRecords = results.reduce((sum, r) => sum + r.recordsAdded, 0)
    assert.equal(buffer.size(), totalRecords)
  })
})
