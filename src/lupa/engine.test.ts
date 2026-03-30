import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../types/index.ts'
import type { LupaConfig } from './types.ts'
import type { GameConfig } from './handlers.ts'
import { runGame } from './engine-next.ts'
import { strategyAdapter } from './adapters/strategy-adapter.ts'
import { RandomStrategy } from './random-strategy.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'

const defaultStrategy = new RandomStrategy()

function makeGameConfig(roles: Record<string, number>, seed?: number): GameConfig {
  return {
    roles: new Map(Object.entries(roles) as [SystemRole, number][]),
    seed,
  }
}

function makeHandlers(roles: Record<string, number>, seed?: number) {
  return strategyAdapter({
    defaultStrategy,
    seed,
    roles: new Map(Object.entries(roles) as [SystemRole, number][]),
  })
}

function makeLupaConfig(roles: Record<string, number>, seed?: number): LupaConfig {
  return {
    roles: new Map(Object.entries(roles) as [SystemRole, number][]),
    seed,
  }
}

describe('lupa engine', () => {
  it('生成されたhowlがパーサーでパースできる', async () => {
    const roles = { werewolf: 2, villager: 5, seer: 1, medium: 1, bodyguard: 1 }
    const seed = 42
    const { events, state } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
    const howl = formatHowl(events, state, makeLupaConfig(roles, seed))
    const result = parse(howl)
    assert.ok(result.statements.length > 0, 'パース結果にstatementがあること')
    // unknownタイプのstatementがないことを確認
    const unknowns = result.statements.filter(s => s.type === 'unknown')
    assert.equal(unknowns.length, 0, `unknown statements: ${unknowns.map((s: any) => s.raw).join(', ')}`)
  })

  it('同じseedで同じ結果が出る', async () => {
    const roles = { werewolf: 1, villager: 3, seer: 1 }
    const seed = 123
    const lupaConfig = makeLupaConfig(roles, seed)
    const r1 = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
    const r2 = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
    const h1 = formatHowl(r1.events, r1.state, lupaConfig)
    const h2 = formatHowl(r2.events, r2.state, lupaConfig)
    assert.equal(h1, h2)
  })

  it('ゲームが終了する', async () => {
    const roles = { werewolf: 1, villager: 3, seer: 1 }
    const seed = 99
    const { state } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
    assert.ok(state.finished)
    assert.ok(state.result !== null)
  })

  it('勝利条件が正しい (村勝利: 狼全滅)', async () => {
    // 多数のseedで実行して結果を検証
    const roles = { werewolf: 1, villager: 4, seer: 1 }
    for (let seed = 0; seed < 20; seed++) {
      const { state } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
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

  it('妖狐入りゲームが正常動作する', async () => {
    const roles = { werewolf: 2, villager: 5, seer: 1, medium: 1, werehamster: 1 }
    const seed = 42
    const { state } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
    assert.ok(state.finished)
    assert.ok(state.result !== null)
  })

  it('狂人が偽占いCOする', async () => {
    const roles = { werewolf: 2, villager: 4, seer: 1, possessed: 1, medium: 1, bodyguard: 1 }
    const seed = 42
    const { events } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
    const seerClaims = events.filter(e => e.type === 'seer_claim')
    // 真占い + 狂人で少なくとも2つのseer_claimイベント
    assert.ok(seerClaims.length >= 2, `占いCO数: ${seerClaims.length}`)
  })

  it('生成howlがパーサーでパースできる (複数seed)', async () => {
    const roles = { werewolf: 2, villager: 4, seer: 1, possessed: 1, medium: 1, bodyguard: 1 }
    for (let seed = 0; seed < 10; seed++) {
      const { events, state } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
      const howl = formatHowl(events, state, makeLupaConfig(roles, seed))
      const result = parse(howl)
      const unknowns = result.statements.filter(s => s.type === 'unknown')
      assert.equal(unknowns.length, 0, `seed ${seed}: unknown statements: ${unknowns.map((s: any) => s.raw).join(', ')}`)
    }
  })

  it('猫又処刑で道連れが発生する', async () => {
    let curseFound = false
    const roles = { werewolf: 1, villager: 3, seer: 1, nekomata: 1 }
    for (let seed = 0; seed < 50; seed++) {
      const { events } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
      if (events.some(e => e.type === 'curse_kill')) {
        curseFound = true
        break
      }
    }
    assert.ok(curseFound, '50 seed中に猫又道連れが1回も発生しなかった')
  })

  it('共有者入りゲームが正常動作する', async () => {
    const roles = { werewolf: 2, villager: 3, seer: 1, medium: 1, mason: 2 }
    for (let seed = 0; seed < 10; seed++) {
      const { state, events } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
      assert.ok(state.finished, `seed ${seed}: ゲームが終了していない`)
      const howl = formatHowl(events, state, makeLupaConfig(roles, seed))
      const result = parse(howl)
      const unknowns = result.statements.filter(s => s.type === 'unknown')
      assert.equal(unknowns.length, 0, `seed ${seed}: unknown: ${unknowns.map((s: any) => s.raw).join(', ')}`)
    }
  })

  it('背徳者が妖狐死亡時に後追いする', async () => {
    let followFound = false
    const roles = { werewolf: 2, villager: 4, seer: 1, werehamster: 1, immoralist: 1 }
    for (let seed = 0; seed < 50; seed++) {
      const { events } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
      if (events.some(e => e.type === 'follow_kill')) {
        followFound = true
        break
      }
    }
    assert.ok(followFound, '50 seed中に背徳者後追いが1回も発生しなかった')
  })

  it('狂信者入りゲームが正常動作する', async () => {
    const roles = { werewolf: 2, villager: 4, seer: 1, medium: 1, fanatic: 1 }
    for (let seed = 0; seed < 10; seed++) {
      const { state, events } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
      assert.ok(state.finished, `seed ${seed}: ゲームが終了していない`)
      const howl = formatHowl(events, state, makeLupaConfig(roles, seed))
      const result = parse(howl)
      const unknowns = result.statements.filter(s => s.type === 'unknown')
      assert.equal(unknowns.length, 0, `seed ${seed}: unknown: ${unknowns.map((s: any) => s.raw).join(', ')}`)
    }
  })

  it('全役職入りゲームがパースできる', async () => {
    const roles = {
      werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
      mason: 2, nekomata: 1, possessed: 1, fanatic: 1,
      werehamster: 1, immoralist: 1,
    }
    for (let seed = 0; seed < 10; seed++) {
      const { state, events } = await runGame(makeGameConfig(roles, seed), makeHandlers(roles, seed))
      assert.ok(state.finished, `seed ${seed}: ゲームが終了していない`)
      const howl = formatHowl(events, state, makeLupaConfig(roles, seed))
      const result = parse(howl)
      const unknowns = result.statements.filter(s => s.type === 'unknown')
      assert.equal(unknowns.length, 0, `seed ${seed}: unknown: ${unknowns.map((s: any) => s.raw).join(', ')}`)
    }
  })
})
