import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../types/index.ts'
import type { LupaConfig, GameState, NightAction } from './types.ts'
import type { GameConfig, GameHandlers } from './handlers.ts'
import { runGame } from './engine.ts'
import { makeRandomHandlers } from './test-helpers.ts'
import { formatHowl } from './format.ts'
import { parse } from '../howl/parser.ts'
import { checkWinCondition } from './roles.ts'

function makeGameConfig(roles: Record<string, number>, seed?: number): GameConfig {
  return {
    roles: new Map(Object.entries(roles) as [SystemRole, number][]),
    seed,
  }
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
    const { events, state } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
    const howl = formatHowl(events, state, makeLupaConfig(roles, seed))
    const result = parse(howl)
    assert.ok(result.statements.length > 0, 'パース結果にstatementがあること')
    const unknowns = result.statements.filter(s => s.type === 'unknown')
    assert.equal(unknowns.length, 0, `unknown statements: ${unknowns.map((s: any) => s.raw).join(', ')}`)
  })

  it('同じseedで同じ結果が出る', async () => {
    const roles = { werewolf: 1, villager: 3, seer: 1 }
    const seed = 123
    const lupaConfig = makeLupaConfig(roles, seed)
    const r1 = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
    const r2 = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
    const h1 = formatHowl(r1.events, r1.state, lupaConfig)
    const h2 = formatHowl(r2.events, r2.state, lupaConfig)
    assert.equal(h1, h2)
  })

  it('ゲームが終了する', async () => {
    const roles = { werewolf: 1, villager: 3, seer: 1 }
    const seed = 99
    const { state } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
    assert.ok(state.finished)
    assert.ok(state.result !== null)
  })

  it('勝利条件が正しい (村勝利: 狼全滅)', async () => {
    const roles = { werewolf: 1, villager: 4, seer: 1 }
    for (let seed = 0; seed < 20; seed++) {
      const { state } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
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
    const { state } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
    assert.ok(state.finished)
    assert.ok(state.result !== null)
  })

  it('生成howlがパーサーでパースできる (複数seed)', async () => {
    const roles = { werewolf: 2, villager: 4, seer: 1, possessed: 1, medium: 1, bodyguard: 1 }
    for (let seed = 0; seed < 10; seed++) {
      const { events, state } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
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
      const { events } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
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
      const { state, events } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
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
      const { events } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
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
      const { state, events } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
      assert.ok(state.finished, `seed ${seed}: ゲームが終了していない`)
      const howl = formatHowl(events, state, makeLupaConfig(roles, seed))
      const result = parse(howl)
      const unknowns = result.statements.filter(s => s.type === 'unknown')
      assert.equal(unknowns.length, 0, `seed ${seed}: unknown: ${unknowns.map((s: any) => s.raw).join(', ')}`)
    }
  })

  it('複数狩人の guard が独立に効く (猫又バグと同質の不備リグレッション)', async () => {
    // シナリオ:
    //   狼 2 人 → villager[0] を同 target で attack (合計 2 票)
    //   狩人 A → 別 seat (狩人 B 自身) を guard
    //   狩人 B → villager[0] (= attack target) を guard
    //
    // 期待: 狩人 B の guard が有効で villager[0] は守られる → night_kill 0
    // バグあり (最初の guard のみ採用): 狩人 A の guard が選ばれる
    //   → guardTarget != attack target → villager[0] 死亡 → night_kill 1
    const config: GameConfig = {
      roles: new Map<SystemRole, number>([
        ['werewolf', 2], ['villager', 2], ['bodyguard', 2],
      ]),
      seed: 1,
      hasFirstGhost: false,  // 初日犠牲者を無効化してシナリオ単純化
    }

    let nightCallCount = 0
    let attackTargetSeat = -1
    let seatRolesCaptured = new Map<number, SystemRole>()

    const handlers: GameHandlers = {
      onSetup(roles) { seatRolesCaptured = roles },
      onNight(ctx) {
        nightCallCount++
        const actions = new Map<number, NightAction>()
        if (nightCallCount === 1) return actions  // night 0: 何もしない

        // night 1+: 役職別に seat を集めて決定的にアクションを組む
        const state = ctx.state as GameState
        const wolves: number[] = []
        const guards: number[] = []
        const villagers: number[] = []
        for (const p of state.players) {
          if (!p.alive) continue
          if (p.role === 'werewolf') wolves.push(p.seat)
          else if (p.role === 'bodyguard') guards.push(p.seat)
          else if (p.role === 'villager') villagers.push(p.seat)
        }
        assert.ok(wolves.length === 2 && guards.length === 2 && villagers.length >= 1,
          `Day 2 night の前提条件失敗: wolves=${wolves.length} guards=${guards.length} villagers=${villagers.length}`)

        attackTargetSeat = villagers[0]
        actions.set(wolves[0], { type: 'attack', target: attackTargetSeat })
        actions.set(wolves[1], { type: 'attack', target: attackTargetSeat })  // 同 target で多数決確定
        actions.set(guards[0], { type: 'guard', target: guards[1] })          // 「最初の」狩人は別 seat を guard
        actions.set(guards[1], { type: 'guard', target: attackTargetSeat })   // 「2 人目の」狩人が attack target を guard
        return actions
      },
      onDayClaims() { return new Map() },
      onVote(ctx) {
        // 決定的に「villager を吊る」: 役職を seatRolesCaptured で確認し villager を選ぶ
        // (Day 1 で wolf/bodyguard が処刑されるとシナリオが崩れるため)
        const villagerSeat = ctx.alivePlayers.find(s => seatRolesCaptured.get(s) === 'villager')!
        const votes = new Map<number, number>()
        for (const seat of ctx.alivePlayers) {
          votes.set(seat, seat === villagerSeat
            ? ctx.alivePlayers.find(s => s !== villagerSeat)!
            : villagerSeat)
        }
        return votes
      },
    }

    const { events } = await runGame(config, handlers)

    // events 構造: ... [night0 occurrences] ... execution(Day1) ... [Day2 night events] ... execution(Day2) ...
    // 最初の execution と次の execution の間が Day 2 (Day 2 night → Day 2 vote → Day 2 execution)
    const firstExecIdx = events.findIndex(e => e.type === 'execution')
    assert.ok(firstExecIdx >= 0, 'Day 1 の処刑 event が見つからない')
    const secondExecIdx = events.findIndex((e, i) => i > firstExecIdx && e.type === 'execution')
    const day2Events = events.slice(firstExecIdx + 1, secondExecIdx === -1 ? undefined : secondExecIdx)
    const day2NightKills = day2Events.filter(e => e.type === 'night_kill')

    assert.equal(
      day2NightKills.length, 0,
      `Day 2 night: attack target (seat ${attackTargetSeat}) が「2 人目の狩人」に守られているのに ` +
      `night_kill が ${day2NightKills.length} 件発生した (target=${(day2NightKills[0] as { target?: number })?.target}). ` +
      `「最初の guard」しか採用されないバグの兆候。`,
    )
  })

  it('パパラッチが夜に占い能力を発動する', async () => {
    // 14d-neko ベース + paparazzi 1 (villager を 1 減らす)
    const roles = {
      werewolf: 3, villager: 1, seer: 1, medium: 1, bodyguard: 1,
      mason: 2, nekomata: 1, fanatic: 1, werehamster: 1, immoralist: 1,
      paparazzi: 1,
    }
    let paparazziDivineFound = false
    for (let seed = 0; seed < 5; seed++) {
      let paparazziSeat: number | null = null
      const handlers = makeRandomHandlers(seed)
      const wrapped = {
        ...handlers,
        onSetup(seatRoles: Map<number, SystemRole>, state: any) {
          for (const [seat, role] of seatRoles) if (role === 'paparazzi') paparazziSeat = seat
          return handlers.onSetup?.(seatRoles, state)
        },
      }
      const { state } = await runGame(makeGameConfig(roles, seed), wrapped)
      const paparazziPlayer = state.players.find(p => p.seat === paparazziSeat)!
      // paparazzi が少なくとも 1 回 divine action を発行している (divineHistory に entry あり)
      if (paparazziPlayer.divineHistory.size > 0) {
        paparazziDivineFound = true
        break
      }
    }
    assert.ok(paparazziDivineFound, '5 seed 中にパパラッチの divine が 1 回も発行されなかった')
  })

  it('パパラッチは狼陣営として勝利判定される (人狼過半数シナリオ)', () => {
    // 手動で state を組む: alive = werewolf 1, paparazzi 1, villager 1
    // 期待: wolves=1 (werewolf のみ、paparazzi は襲撃能力なし)
    //       nonWolfCount = 2 (paparazzi + villager は人扱い)
    //       1 >= 2 ではないので未終了
    const state1: any = {
      players: [
        { seat: 1, role: 'werewolf', alive: true },
        { seat: 2, role: 'paparazzi', alive: true },
        { seat: 3, role: 'villager', alive: true },
      ],
      finished: false, result: null,
    }
    checkWinCondition(state1)
    assert.equal(state1.finished, false, 'werewolf 1 + paparazzi 1 + villager 1 では未終了 (狼数 < 村数)')

    // alive = werewolf 1, paparazzi 1: wolves=1, nonWolfCount=1, 1>=1 で狼勝
    const state2: any = {
      players: [
        { seat: 1, role: 'werewolf', alive: true },
        { seat: 2, role: 'paparazzi', alive: true },
      ],
      finished: false, result: null,
    }
    checkWinCondition(state2)
    assert.equal(state2.finished, true, 'werewolf 1 + paparazzi 1 で終了')
    assert.equal(state2.result, 'werewolf_won', 'パパラッチ生存時の狼勝利')

    // werewolf 全滅 + paparazzi のみ alive: wolves=0 → 村勝 (paparazzi は襲撃役ではない)
    const state3: any = {
      players: [
        { seat: 1, role: 'werewolf', alive: false },
        { seat: 2, role: 'paparazzi', alive: true },
        { seat: 3, role: 'villager', alive: true },
      ],
      finished: false, result: null,
    }
    checkWinCondition(state3)
    assert.equal(state3.finished, true, 'werewolf 全滅で終了')
    assert.equal(state3.result, 'villager_won', 'パパラッチ単独残存では村勝利 (襲撃役なし)')
  })

  it('全役職入りゲームがパースできる', async () => {
    const roles = {
      werewolf: 3, villager: 2, seer: 1, medium: 1, bodyguard: 1,
      mason: 2, nekomata: 1, possessed: 1, fanatic: 1,
      werehamster: 1, immoralist: 1,
    }
    for (let seed = 0; seed < 10; seed++) {
      const { state, events } = await runGame(makeGameConfig(roles, seed), makeRandomHandlers(seed))
      assert.ok(state.finished, `seed ${seed}: ゲームが終了していない`)
      const howl = formatHowl(events, state, makeLupaConfig(roles, seed))
      const result = parse(howl)
      const unknowns = result.statements.filter(s => s.type === 'unknown')
      assert.equal(unknowns.length, 0, `seed ${seed}: unknown: ${unknowns.map((s: any) => s.raw).join(', ')}`)
    }
  })
})
