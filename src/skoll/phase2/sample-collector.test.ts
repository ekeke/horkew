import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SampleCollector } from './sample-collector.ts'

describe('SampleCollector', () => {
  it('add → counts / totalSize で内訳を取れる', () => {
    const c = new SampleCollector()
    c.add('villager', 'claim', new Float32Array(2), 3, { gameId: 0, day: 1, seat: 1, alive: 0b11 })
    c.add('villager', 'claim', new Float32Array(2), 4, { gameId: 0, day: 2, seat: 1, alive: 0b11 })
    c.add('werewolf', 'comm', new Float32Array(2), 7, { gameId: 0, day: 1, seat: 2, alive: 0b11 })
    assert.equal(c.totalSize(), 3)
    assert.equal(c.counts()['villager/claim'], 2)
    assert.equal(c.counts()['werewolf/comm'], 1)
  })

  it('writeJsonl で role/method 別ファイルに書き出される', () => {
    const c = new SampleCollector()
    c.add('seer', 'claim', Float32Array.from([0.1, 0.2]), 5, { gameId: 0, day: 3, seat: 4, alive: 0b111 })
    c.add('seer', 'comm', Float32Array.from([0.3]), 12, { gameId: 0, day: 3, seat: 4, alive: 0b111 })

    const dir = mkdtempSync(join(tmpdir(), 'sc-test-'))
    try {
      c.writeJsonl(dir)
      assert.ok(existsSync(join(dir, 'seer', 'claim.jsonl')))
      assert.ok(existsSync(join(dir, 'seer', 'comm.jsonl')))
      const claimLines = readFileSync(join(dir, 'seer', 'claim.jsonl'), 'utf-8').trim().split('\n')
      assert.equal(claimLines.length, 1)
      const parsed = JSON.parse(claimLines[0])
      assert.equal(parsed.role, 'seer')
      assert.equal(parsed.method, 'claim')
      assert.equal(parsed.actionIdx, 5)
      assert.deepEqual(parsed.obs, [0.10000000149011612, 0.20000000298023224])  // Float32Array quirk
      assert.equal(parsed.meta.seat, 4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sigmoid head の multi-hot action を actionVec で保存', () => {
    const c = new SampleCollector()
    c.add('mason', 'propose', new Float32Array(1), Float32Array.from([1, 0, 1]), { gameId: 0, day: 1, seat: 1, alive: 0b11 })

    const dir = mkdtempSync(join(tmpdir(), 'sc-test-'))
    try {
      c.writeJsonl(dir)
      const parsed = JSON.parse(readFileSync(join(dir, 'mason', 'propose.jsonl'), 'utf-8').trim())
      assert.deepEqual(parsed.actionVec, [1, 0, 1])
      assert.equal(parsed.actionIdx, undefined, 'actionIdx は出さない')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clear で全サンプル消える', () => {
    const c = new SampleCollector()
    c.add('villager', 'claim', new Float32Array(1), 0, { gameId: 0, day: 1, seat: 1, alive: 0 })
    assert.equal(c.totalSize(), 1)
    c.clear()
    assert.equal(c.totalSize(), 0)
  })
})
