/**
 * huginn-orchestrator.ts のテスト:
 *   - skeleton run で checkpoint / phase.done / train-progress.json が書かれる
 *   - unknown scenario で throw
 *   - 空 scenarios で throw
 *   - mix で numAgents 不一致で throw
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runHuginnCurriculum,
  runHuginnCatalogAll,
  huginnCheckpointDir,
  huginnPhaseDoneFile,
} from './huginn-orchestrator.ts'
import { loadCheckpoint } from '../../huginn/checkpoint-fs.ts'
import { catalog } from '../../huginn/scenarios.ts'

function makeTmpBase(): string {
  return mkdtempSync(join(tmpdir(), 'huginn-orch-'))
}

describe('huginn-orchestrator skeleton run', () => {
  it('writes final.json, phase.done, and train-progress.json on pair2v2Block', () => {
    const base = makeTmpBase()
    try {
      const { history, checkpointDir } = runHuginnCurriculum({
        checkpointBase: base,
        scenarios: ['pair2v2Block'],
        iterations: 999,        // skeleton で 2 に抑えられる
        gamesPerIter: 999,      // skeleton で 2 に抑えられる
        lr: 0.01,
        dModel: 16,
        numLayers: 1,
        numHeads: 2,
        dFf: 32,
        seed: 7,
        skeleton: true,
        log: () => { /* swallow log output */ },
      })

      assert.strictEqual(history.length, 2, 'skeleton should run exactly 2 iterations')

      const finalPath = join(checkpointDir, 'final.json')
      assert.ok(existsSync(finalPath), `final.json not written at ${finalPath}`)

      // final.json は huginn checkpoint format と互換
      const { config } = loadCheckpoint(finalPath)
      assert.strictEqual(config.dModel, 16)
      assert.strictEqual(config.numLayers, 1)

      const donePath = huginnPhaseDoneFile(base)
      assert.ok(existsSync(donePath), 'phase.done not written')

      const progressPath = join(base, 'train-progress.json')
      assert.ok(existsSync(progressPath), 'train-progress.json not written')
      const progress = JSON.parse(readFileSync(progressPath, 'utf-8')) as {
        latest?: { phase?: string, model?: string, iter?: number, maxIter?: number }
      }
      assert.strictEqual(progress.latest?.phase, 'huginn')
      assert.strictEqual(progress.latest?.model, 'pair2v2Block')
      assert.strictEqual(progress.latest?.iter, 2)
      assert.strictEqual(progress.latest?.maxIter, 2)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('huginnCheckpointDir points under phases/00-huginn/ckpt-huginn', () => {
    const base = '/tmp/test-huginn-base'
    const dir = huginnCheckpointDir(base)
    assert.ok(dir.includes('phases'), 'checkpointDir missing phases segment')
    assert.ok(dir.includes('00-huginn'), 'checkpointDir missing 00-huginn')
    assert.ok(dir.endsWith('ckpt-huginn'), 'checkpointDir should end with ckpt-huginn')
  })

  it('throws on unknown scenario name', () => {
    const base = makeTmpBase()
    try {
      assert.throws(
        () => runHuginnCurriculum({
          checkpointBase: base,
          scenarios: ['this_scenario_does_not_exist'],
          iterations: 1,
          gamesPerIter: 1,
          lr: 0.01,
          skeleton: true,
          log: () => {},
        }),
        /unknown scenario/,
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('throws when scenarios is empty', () => {
    const base = makeTmpBase()
    try {
      assert.throws(
        () => runHuginnCurriculum({
          checkpointBase: base,
          scenarios: [],
          iterations: 1,
          gamesPerIter: 1,
          lr: 0.01,
          skeleton: true,
          log: () => {},
        }),
        /--huginn-scenario required/,
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('checkpointLabel routes checkpoint to ckpt-huginn-{label}/ subdir', () => {
    const base = makeTmpBase()
    try {
      const { checkpointDir } = runHuginnCurriculum({
        checkpointBase: base,
        scenarios: ['pair2v2Block'],
        iterations: 999,
        gamesPerIter: 999,
        lr: 0.01,
        dModel: 16,
        numLayers: 1,
        numHeads: 2,
        dFf: 32,
        seed: 3,
        skeleton: true,
        checkpointLabel: 'pair2v2Block',
        markPhaseDone: false,
        log: () => {},
      })
      assert.ok(checkpointDir.endsWith('ckpt-huginn-pair2v2Block'), `got ${checkpointDir}`)
      assert.ok(existsSync(join(checkpointDir, 'final.json')))
      // markPhaseDone:false なので phase.done が書かれていないこと
      assert.ok(!existsSync(huginnPhaseDoneFile(base)), 'phase.done should not be written when markPhaseDone=false')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('runHuginnCatalogAll writes each scenario into its own subdir + one phase.done', () => {
    const base = makeTmpBase()
    try {
      const { perScenario } = runHuginnCatalogAll({
        checkpointBase: base,
        iterations: 999,       // skeleton で 2 iter に上書き
        gamesPerIter: 999,     // skeleton で 2 games/iter に上書き
        lr: 0.01,
        dModel: 16,
        numLayers: 1,
        numHeads: 2,
        dFf: 32,
        seed: 11,
        skeleton: true,
        log: () => {},
      })

      const catalogNames = Object.keys(catalog)
      assert.strictEqual(perScenario.length, catalogNames.length, 'should train every catalog scenario')

      // 各 scenario の final.json が該当 subdir に存在
      for (const name of catalogNames) {
        const expectedDir = huginnCheckpointDir(base, name)
        const finalPath = join(expectedDir, 'final.json')
        assert.ok(existsSync(finalPath), `missing final.json for scenario ${name}: ${finalPath}`)
      }

      // phase.done は auto-all 終了時に 1 つだけ書かれる
      assert.ok(existsSync(huginnPhaseDoneFile(base)), 'phase.done should be written after all scenarios')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('throws when mixed scenarios differ in numAgents', () => {
    const base = makeTmpBase()
    try {
      // pair2v2Block (N=4) と trio3v2Block (N=5) は numAgents 不一致
      assert.throws(
        () => runHuginnCurriculum({
          checkpointBase: base,
          scenarios: ['pair2v2Block', 'trio3v2Block'],
          iterations: 1,
          gamesPerIter: 1,
          lr: 0.01,
          skeleton: true,
          log: () => {},
        }),
        /share numAgents/,
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
