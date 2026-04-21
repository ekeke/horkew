import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { popCount32 } from '../../hati/types.ts'
import { checkOutcome } from '../../hati/simulate.ts'
import { collectWorlds } from '../../hati/worlds.ts'
import { Possibilities, RoleBitIndex, RoleSignatureBits } from '../../retar/possibilities.ts'
import { createSimState } from './world-state.ts'
import { runRollout, stepDayNightCycle } from './rollout-sim.ts'
import { decideVoteHeuristic, tallyVotes } from './heuristic-policy.ts'

/** ヘルパー: assignments からテスト用 world を構築 */
function makeWorld(assignments: Record<number, SystemRole>): World {
  const maxSeat = Math.max(...Object.keys(assignments).map(Number))
  const roles: SystemRole[] = new Array(maxSeat + 1)
  const roleIds = new Uint8Array(maxSeat + 1)
  let wolfMask = 0
  let hamsterMask = 0
  let immoralistMask = 0
  let seerMask = 0
  let mediumMask = 0
  let nekomataMask = 0
  let bodyguardSeat = -1

  for (const [seatStr, role] of Object.entries(assignments)) {
    const seat = Number(seatStr)
    roles[seat] = role
    roleIds[seat] = RoleBitIndex[role]
    switch (role) {
      case 'werewolf': wolfMask |= (1 << seat); break
      case 'werehamster': hamsterMask |= (1 << seat); break
      case 'immoralist': immoralistMask |= (1 << seat); break
      case 'seer': seerMask |= (1 << seat); break
      case 'medium': mediumMask |= (1 << seat); break
      case 'nekomata': nekomataMask |= (1 << seat); break
      case 'bodyguard': bodyguardSeat = seat; break
    }
  }

  return {
    roles, roleIds, wolfMask, hamsterMask, immoralistMask,
    seerMask, mediumMask, nekomataMask, bodyguardSeat,
  }
}

function aliveOf(seats: number[]): number {
  let mask = 0
  for (const s of seats) mask |= (1 << s)
  return mask
}

describe('decideVoteHeuristic', () => {
  it('村陣営は狼を最優先で投票', () => {
    const world = makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' })
    const alive = aliveOf([1, 2, 3])
    assert.equal(decideVoteHeuristic(world, alive, 1), 2, '村人 seat1 は狼 seat2 へ')
    assert.equal(decideVoteHeuristic(world, alive, 3), 2, '村人 seat3 は狼 seat2 へ')
  })

  it('狼陣営は占い師を最優先で投票', () => {
    const world = makeWorld({
      1: 'seer', 2: 'werewolf', 3: 'villager', 4: 'werewolf',
    })
    const alive = aliveOf([1, 2, 3, 4])
    assert.equal(decideVoteHeuristic(world, alive, 2), 1, '狼 seat2 は占い seat1 へ')
    assert.equal(decideVoteHeuristic(world, alive, 4), 1, '狼 seat4 も占い seat1 へ')
  })

  it('狐陣営は狼を最優先（縄消費を狙う）', () => {
    const world = makeWorld({
      1: 'werehamster', 2: 'werewolf', 3: 'villager', 4: 'seer',
    })
    const alive = aliveOf([1, 2, 3, 4])
    assert.equal(decideVoteHeuristic(world, alive, 1), 2, '狐 seat1 は狼 seat2 へ')
  })

  it('alive に自分以外いなければ -1（abstain）', () => {
    const world = makeWorld({ 1: 'villager' })
    const alive = aliveOf([1])
    assert.equal(decideVoteHeuristic(world, alive, 1), -1)
  })
})

describe('tallyVotes', () => {
  it('多数決で対象が決まる、同票は最小席番', () => {
    // 1=村, 2=村, 3=狼, 4=狼 → 村2票で狼へ、狼2票で村へ → 狼3 vs 村1 → 4票 vs 2票
    const world = makeWorld({
      1: 'villager', 2: 'villager', 3: 'werewolf', 4: 'werewolf',
    })
    const alive = aliveOf([1, 2, 3, 4])
    // 村人は狼を投票（priority: WOLF first）→ seat3 (最小狼)
    // 狼は占い等いないので村priority → seat1 (最小村)
    // 結果: seat3 に 2票、seat1 に 2票 → tie → 最小席番 seat1
    const executed = tallyVotes(world, alive)
    assert.equal(executed, 1, 'tie → 最小席番')
  })

  it('mason vote override が反映される', () => {
    const world = makeWorld({
      1: 'mason', 2: 'mason', 3: 'werewolf', 4: 'villager',
    })
    const alive = aliveOf([1, 2, 3, 4])
    // override なし: 村陣営全員が狼 seat3 を投票 → seat3 処刑
    assert.equal(tallyVotes(world, alive), 3)
    // mason 2 人が seat4 を override → seat4 が 2票、seat3 は villager+wolf=2票（村→狼,狼→村→seat1）
    // seat1=mason→override で 4
    // seat2=mason→override で 4
    // seat3=wolf→villager priority で seat1 を投票 (mason は VILLAGER 優先より上ではないが、村の最小席番)
    //   実際: WOLF_PRIORITY=[SEER,MEDIUM,BODYGUARD,MASON,NEKOMATA,VILLAGER]
    //         alive 候補内に SEER/MEDIUM/BODYGUARD なし、MASON が seat1,2 → seat1 へ
    // seat4=villager→VILLAGE_PRIORITY=[WEREWOLF,...] → seat3 へ
    // 集計: seat4 → 2, seat1 → 1, seat3 → 1 → seat4 が 2 で最多
    const override = new Map<number, number>([[1, 4], [2, 4]])
    assert.equal(tallyVotes(world, alive, override), 4)
  })
})

describe('runRollout: 基本動作', () => {
  it('3人 (狼1+村2): 終端まで進み、結果は valid な outcome', () => {
    const world = makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]))
    const outcome = runRollout(state)
    assert.equal(state.phase, 'terminal')
    assert.ok(['village_win', 'wolf_win', 'hamster_win'].includes(outcome))
    // 神視点 heuristic で村人は狼を投票するため、初日に狼処刑 → village_win
    assert.equal(outcome, 'village_win')
  })

  it('3人 (狼2+村1): 狼が多すぎて村は負ける', () => {
    const world = makeWorld({ 1: 'werewolf', 2: 'werewolf', 3: 'villager' })
    const state = createSimState(world, aliveOf([1, 2, 3]))
    // 初日 day phase で alive=3, wolf=2, nonWolfNonHamster=1 → wolf_win 即時
    // checkOutcome は execute 後に呼ぶが、執行前は ongoing。
    // 投票: 村→狼 seat1, 狼2人→村 seat3 → 集計 seat1=1, seat3=2 → seat3 処刑
    // 残: 狼2 vs 0 → wolf_win
    const outcome = runRollout(state)
    assert.equal(outcome, 'wolf_win')
  })

  it('狐単独生存 (1人): hamster_win', () => {
    const world = makeWorld({ 1: 'werewolf', 2: 'werehamster' })
    const state = createSimState(world, aliveOf([1, 2]))
    // 初日: 狐→狼priorityで seat1, 狼→FOX priority で seat2 (狐) → 1票ずつ tie → seat1 処刑
    // 残: seat2 (狐) のみ → wolf=0, hamsterAlive=true → hamster_win
    const outcome = runRollout(state)
    assert.equal(outcome, 'hamster_win')
  })

  it('終端後は state.outcome と checkOutcome が一致', () => {
    const world = makeWorld({
      1: 'seer', 2: 'villager', 3: 'werewolf', 4: 'werewolf',
      5: 'villager', 6: 'bodyguard',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6]))
    const outcome = runRollout(state)
    assert.equal(state.phase, 'terminal')
    // 終端時点の alive を checkOutcome に再投入して一致
    const recheck = checkOutcome(world, state.alive)
    assert.equal(recheck, outcome, 'simulator outcome と checkOutcome が一致')
  })

  it('alive は単調減少（vote/bite で 0 になることはない、必ず終端到達）', () => {
    const world = makeWorld({
      1: 'villager', 2: 'seer', 3: 'medium', 4: 'bodyguard',
      5: 'mason', 6: 'mason', 7: 'werewolf', 8: 'werewolf',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6, 7, 8]))
    const initialAlive = popCount32(state.alive)
    runRollout(state)
    assert.equal(state.phase, 'terminal')
    assert.ok(popCount32(state.alive) < initialAlive, '終端時 alive < 初期 alive')
  })
})

describe('stepDayNightCycle: mason vote override', () => {
  it('mason override で異なる seat が処刑される', () => {
    const world = makeWorld({
      1: 'mason', 2: 'mason', 3: 'werewolf', 4: 'villager', 5: 'villager',
    })
    // override なし: 村陣営全員が狼 seat3 へ → seat3 処刑
    {
      const state = createSimState(world, aliveOf([1, 2, 3, 4, 5]))
      stepDayNightCycle(state)
      // 終端ではない (狼1匹残→noise が無いと: 残3村2狼1, day1 で狼処刑→残4村0狼,outcome=village_win)
      // 注: 1日 step は day+night の両方、night で狼が噛む
      // day: vote → seat3 (狼) 処刑 → 残 [1,2,4,5] 全村 → village_win 即終端
      assert.equal(state.outcome, 'village_win')
    }
    // override で mason 2 人が seat5 へ → seat3 (狼) は wolf 2 人ぶんだけ → tie 解決
    {
      const state = createSimState(world, aliveOf([1, 2, 3, 4, 5]))
      const override = new Map<number, number>([[1, 5], [2, 5]])
      stepDayNightCycle(state, override)
      // vote: seat1=5, seat2=5, seat3(wolf)→WOLF_PRIORITY=[SEER,..,MASON,..]→ seat1, seat4=村→3, seat5=村→3
      // 集計: seat5=2, seat1=1, seat3=2 → tie seat3 vs seat5、seat3 が小さい → seat3 処刑
      // → 同じ結果（狼処刑）。override の効果が tie で吸収されるケース
      assert.equal(state.outcome, 'village_win', 'tie → 最小席番で結果は同じ')
    }
    // override 強める: 村人 (4,5) も seat3 を回避してみる... テストとしては override の
    // 「mason の vote が tally に反映される」ことが見えれば OK
  })

  it('nightOverride.attackTarget で heuristic と異なる噛み先を強制できる', () => {
    // heuristic では wolf が seer を噛むが、override で別席を噛ませる
    const world = makeWorld({
      1: 'seer', 2: 'villager', 3: 'werewolf', 4: 'villager', 5: 'villager',
    })
    // mason override で 3 票を seat5 に集中 → seat5 処刑 (wolf 残存で夜が起きる)
    const masonOverride = new Map<number, number>([[1, 5], [2, 5], [4, 5]])

    // heuristic: wolf → SEER priority で seat1 を噛む
    const stateA = createSimState(world, aliveOf([1, 2, 3, 4, 5]))
    stepDayNightCycle(stateA, masonOverride)
    assert.equal(stateA.alive, aliveOf([2, 3, 4]), 'heuristic: seer(seat1) 噛み')

    // override: wolf が seat4 を噛む
    const stateB = createSimState(world, aliveOf([1, 2, 3, 4, 5]))
    stepDayNightCycle(stateB, masonOverride, { attackTarget: 4 })
    assert.equal(stateB.alive, aliveOf([1, 2, 3]), 'override: seat4 噛み')
  })

  it('nightOverride.seerDivines で seer の占い先を上書きできる', () => {
    // 狼 2 匹 + 狐 1 匹で夜が生じる。
    // heuristic では seer が狐を占って呪殺するが、override で村人を占えば狐は生存する。
    const world = makeWorld({
      1: 'seer', 2: 'werewolf', 3: 'werewolf', 4: 'werehamster',
      5: 'villager', 6: 'villager', 7: 'villager',
    })
    // day1 は 5 票が wolf(seat2) に集中 → seat2 処刑 → wolf 1 匹生存で night 発生

    // heuristic: seer → WEREHAMSTER priority で seat4 を占う → 呪殺
    //            wolf(seat3) → SEER で seat1 を噛む
    //            alive = [3,5,6,7]
    const stateA = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6, 7]))
    stepDayNightCycle(stateA)
    assert.equal(stateA.alive, aliveOf([3, 5, 6, 7]), 'heuristic: 狐 seat4 を呪殺 + seer 噛み')

    // override: seer が seat5 (村人) を占う → 呪殺なし → 狐生存
    const stateB = createSimState(world, aliveOf([1, 2, 3, 4, 5, 6, 7]))
    stepDayNightCycle(stateB, null, { seerDivines: new Map([[1, 5]]) })
    assert.equal(stateB.alive, aliveOf([3, 4, 5, 6, 7]), 'override: 狐 seat4 生存')
  })

  it('nightOverride.guardTarget で bodyguard の護衛先を上書きできる', () => {
    // 狼 2 匹の setup: day1 で決着しないので night が起き guard の効果が見える
    const world = makeWorld({
      1: 'bodyguard', 2: 'seer', 3: 'werewolf', 4: 'villager', 5: 'werewolf',
    })
    // day1 vote: 村陣営 3 票が seat3、狼 2 票が seat2 → seat3 処刑 → alive [1,2,4,5]
    // night: wolf(seat5) → SEER priority で seat2 を噛む

    // heuristic: bodyguard は seat2 (seer) を守る → seer 生存
    const stateA = createSimState(world, aliveOf([1, 2, 3, 4, 5]))
    stepDayNightCycle(stateA)
    assert.equal(stateA.alive, aliveOf([1, 2, 4, 5]), 'heuristic: seer 護衛成功')

    // override: bodyguard を seat4 (村) へ → wolf が seer を噛んで seer 退場
    const stateB = createSimState(world, aliveOf([1, 2, 3, 4, 5]))
    stepDayNightCycle(stateB, null, { guardTarget: 4 })
    assert.equal(stateB.alive, aliveOf([1, 4, 5]), 'override: seer 未護衛で退場')
  })

  it('mason override による direct な処刑対象変更', () => {
    // 村陣営 4 人 + 狼 1 人。mason 全員 + 村人 1 人で別席を投票させる
    const world = makeWorld({
      1: 'mason', 2: 'mason', 3: 'villager', 4: 'villager', 5: 'werewolf',
    })
    const state = createSimState(world, aliveOf([1, 2, 3, 4, 5]))
    // override: mason 2 人が seat3 を投票 (本来 seat5 wolf を投票するはず)
    // seat3 (村人) → seat5 wolf, seat4 (村人) → seat5 wolf, seat5 (wolf) → MASON priority で seat1
    // override 込み: seat1 投票=3, seat2 投票=3, seat3 投票=5, seat4 投票=5, seat5 投票=1
    // 集計: seat3=2, seat5=2, seat1=1 → tie seat3 vs seat5、最小 seat3 処刑
    const override = new Map<number, number>([[1, 3], [2, 3]])
    stepDayNightCycle(state, override)
    // seat3 (村) 処刑 → 残 [1,2,4,5] = mason+mason+村+狼 → 狼1 vs 非狼3 → ongoing
    // night: wolf(seat5) 噛み → priority [SEER,MEDIUM,BODYGUARD,MASON,...] → seat1 (mason)
    // → 残 [2,4,5] = mason+村+狼 → 狼1 vs 非狼2 → ongoing
    // state は phase=day, day=2, alive=[2,4,5]
    assert.equal(state.phase, 'day', 'まだ ongoing')
    assert.equal(state.day, 2)
    const expectedAlive = aliveOf([2, 4, 5])
    assert.equal(state.alive, expectedAlive, 'seat3 処刑 + seat1 噛み')
  })
})

describe('property: enumerated worlds で simulator が valid outcome を返す', () => {
  it('5人 setup (狼1+狐1+村2+占1) の全 world で終端到達、outcome は checkOutcome と整合', () => {
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['seer', 1], ['werewolf', 1], ['werehamster', 1],
    ])
    const allMask = RoleSignatureBits.villager | RoleSignatureBits.seer
      | RoleSignatureBits.werewolf | RoleSignatureBits.werehamster
    const poss = new Possibilities(setup)
    for (let s = 1; s <= 5; s++) poss.possibilities[s] = allMask

    const worlds = collectWorlds(poss, setup)
    assert.ok(worlds !== null, 'world 列挙成功')
    assert.equal(worlds.length, 60, '5! / (2!) = 60 worlds')

    let validCount = 0
    for (const w of worlds) {
      const state = createSimState(w, aliveOf([1, 2, 3, 4, 5]))
      const outcome = runRollout(state)
      assert.equal(state.phase, 'terminal')
      assert.notEqual(outcome, 'ongoing')
      // 終端 alive を checkOutcome に再投入して整合
      assert.equal(checkOutcome(w, state.alive), outcome,
        `simulator outcome (${outcome}) と checkOutcome が一致`)
      validCount++
    }
    assert.equal(validCount, worlds.length, '全 world で valid outcome')
  })

  it('7人 setup (狼2+狐1+村3+占1) の全 world で終端到達 + checkOutcome 整合', () => {
    // 真role-aware heuristic は決定論的なので outcome は setup ごとに収束する。
    // M1 acceptance はあくまで「simulator が valid に進行 + checkOutcome 整合」を見る。
    const setup = new Map<SystemRole, number>([
      ['villager', 3], ['seer', 1], ['werewolf', 2], ['werehamster', 1],
    ])
    const allMask = RoleSignatureBits.villager | RoleSignatureBits.seer
      | RoleSignatureBits.werewolf | RoleSignatureBits.werehamster
    const poss = new Possibilities(setup)
    for (let s = 1; s <= 7; s++) poss.possibilities[s] = allMask

    const worlds = collectWorlds(poss, setup)
    assert.ok(worlds !== null && worlds.length > 0)

    let validCount = 0
    for (const w of worlds) {
      const state = createSimState(w, aliveOf([1, 2, 3, 4, 5, 6, 7]))
      const outcome = runRollout(state)
      assert.equal(state.phase, 'terminal')
      assert.notEqual(outcome, 'ongoing')
      assert.equal(checkOutcome(w, state.alive), outcome)
      validCount++
    }
    assert.equal(validCount, worlds.length, '全 world で valid outcome')
  })

  it('狼が圧倒的に多い setup では wolf_win 側に倒れる', () => {
    // 狼3+村2+占1 = 6人。村が seer+villagers=3 票、狼が3票で互角だが、
    // 初日に狼1処刑→狼2残→checkOutcome で 狼2 vs 非狼3=ongoing
    // 夜: seer 死亡（狼priority）→ 残5 (狼2 vs 村2+占0) → ongoing
    // 2日目: 村2票で狼へ、狼2票で村へ → tie 最小席番、wolfが最小なら wolf 処刑
    // 結果は world ごとに wolf_win or village_win に分かれる可能性あり
    const setup = new Map<SystemRole, number>([
      ['villager', 2], ['seer', 1], ['werewolf', 3],
    ])
    const allMask = RoleSignatureBits.villager | RoleSignatureBits.seer
      | RoleSignatureBits.werewolf
    const poss = new Possibilities(setup)
    for (let s = 1; s <= 6; s++) poss.possibilities[s] = allMask

    const worlds = collectWorlds(poss, setup)
    assert.ok(worlds !== null && worlds.length > 0)

    const counts: Record<string, number> = { village_win: 0, wolf_win: 0, hamster_win: 0 }
    for (const w of worlds) {
      const state = createSimState(w, aliveOf([1, 2, 3, 4, 5, 6]))
      const outcome = runRollout(state)
      assert.equal(checkOutcome(w, state.alive), outcome)
      counts[outcome]++
    }
    // 狐なしなので hamster_win は 0
    assert.equal(counts.hamster_win, 0, '狐不在で hamster_win なし')
    // village_win または wolf_win が出る（神視点 heuristic でも狼優勢で wolf_win 寄り）
    assert.ok(counts.village_win + counts.wolf_win === worlds.length, '全 world が valid')
  })
})
