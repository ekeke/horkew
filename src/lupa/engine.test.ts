import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../types/index.ts'
import type { LupaConfig } from './types.ts'
import { runGame } from './engine.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'

function makeConfig(roles: Record<string, number>, seed?: number): LupaConfig {
  return {
    roles: new Map(Object.entries(roles) as [SystemRole, number][]),
    seed,
  }
}

describe('lupa engine', () => {
  it('生成されたhowlがパーサーでパースできる', () => {
    const config = makeConfig({ werewolf: 2, villager: 5, seer: 1, medium: 1, bodyguard: 1 }, 42)
    const { events, state } = runGame(config)
    const howl = formatHowl(events, state, config)
    const result = parse(howl)
    assert.ok(result.statements.length > 0, 'パース結果にstatementがあること')
    // unknownタイプのstatementがないことを確認
    const unknowns = result.statements.filter(s => s.type === 'unknown')
    assert.equal(unknowns.length, 0, `unknown statements: ${unknowns.map((s: any) => s.raw).join(', ')}`)
  })

  it('同じseedで同じ結果が出る', () => {
    const config = makeConfig({ werewolf: 1, villager: 3, seer: 1 }, 123)
    const r1 = runGame(config)
    const r2 = runGame(config)
    const h1 = formatHowl(r1.events, r1.state, config)
    const h2 = formatHowl(r2.events, r2.state, config)
    assert.equal(h1, h2)
  })

  it('ゲームが終了する', () => {
    const config = makeConfig({ werewolf: 1, villager: 3, seer: 1 }, 99)
    const { state } = runGame(config)
    assert.ok(state.finished)
    assert.ok(state.result !== null)
  })

  it('勝利条件が正しい (村勝利: 狼全滅)', () => {
    // 多数のseedで実行して結果を検証
    for (let seed = 0; seed < 20; seed++) {
      const config = makeConfig({ werewolf: 1, villager: 4, seer: 1 }, seed)
      const { state } = runGame(config)
      assert.ok(state.finished, `seed ${seed}: ゲームが終了していない`)
      const aliveWolves = state.players.filter(p => p.alive && p.role === 'werewolf')
      const aliveNonWolves = state.players.filter(p => p.alive && p.role !== 'werewolf')
      if (state.result === 'villager_won') {
        assert.equal(aliveWolves.length, 0, `seed ${seed}: 村勝利なのに狼が生存`)
      } else if (state.result === 'werewolf_won') {
        assert.ok(aliveWolves.length >= aliveNonWolves.length,
          `seed ${seed}: 狼勝利なのに狼が少数派`)
      }
    }
  })

  it('妖狐入りゲームが正常動作する', () => {
    const config = makeConfig({ werewolf: 2, villager: 5, seer: 1, medium: 1, werehamster: 1 }, 42)
    const { state } = runGame(config)
    assert.ok(state.finished)
    assert.ok(state.result !== null)
  })

  it('狂人が偽占いCOする', () => {
    const config = makeConfig({ werewolf: 2, villager: 4, seer: 1, possessed: 1, medium: 1, bodyguard: 1 }, 42)
    const { events } = runGame(config)
    const seerClaims = events.filter(e => e.type === 'seer_claim')
    // 真占い + 狂人で少なくとも2つのseer_claimイベント
    assert.ok(seerClaims.length >= 2, `占いCO数: ${seerClaims.length}`)
  })

  it('生成howlがパーサーでパースできる (複数seed)', () => {
    for (let seed = 0; seed < 10; seed++) {
      const config = makeConfig({ werewolf: 2, villager: 4, seer: 1, possessed: 1, medium: 1, bodyguard: 1 }, seed)
      const { events, state } = runGame(config)
      const howl = formatHowl(events, state, config)
      const result = parse(howl)
      const unknowns = result.statements.filter(s => s.type === 'unknown')
      assert.equal(unknowns.length, 0, `seed ${seed}: unknown statements: ${unknowns.map((s: any) => s.raw).join(', ')}`)
    }
  })
})
