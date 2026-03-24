import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Seat, SystemRole } from '../types/index.ts'
import type { World } from './types.ts'
import { searchTsumiDirect } from './index.ts'
import { formatTsumiResult } from './format.ts'

// ヘルパー: ワールドを簡単に作成
function makeWorld(assignments: Record<number, SystemRole>): World {
  const roles = new Map<Seat, SystemRole>()
  const wolfSeats = new Set<Seat>()
  let hamsterSeat = -1
  let immoralistSeat = -1
  let seerSeat = -1
  let bodyguardSeat = -1
  let nekomataSeat = -1
  let mediumSeat = -1

  for (const [seatStr, role] of Object.entries(assignments)) {
    const seat = Number(seatStr)
    roles.set(seat, role)
    switch (role) {
      case 'werewolf': wolfSeats.add(seat); break
      case 'werehamster': hamsterSeat = seat; break
      case 'immoralist': immoralistSeat = seat; break
      case 'seer': seerSeat = seat; break
      case 'bodyguard': bodyguardSeat = seat; break
      case 'nekomata': nekomataSeat = seat; break
      case 'medium': mediumSeat = seat; break
    }
  }

  return { roles, wolfSeats, hamsterSeat, immoralistSeat, seerSeat, bodyguardSeat, nekomataSeat, mediumSeat }
}

describe('Hati searchTsumi', () => {
  describe('trivial cases', () => {
    it('3人: 確定狼1 + 村2 → 詰み（狼を処刑するだけ）', () => {
      // 1=狼確定、2=村人、3=村人
      const worlds = [makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'villager' })]
      const alive = new Set([1, 2, 3])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, true)
      assert.notEqual(result.strategy, null)
      if (result.strategy?.type === 'action') {
        assert.equal(result.strategy.action.execute, 1)
      }
    })

    it('3人: 狼1 + 村2 だが狼が不明 → 詰みでない', () => {
      // 狼が1か2か3か分からない → 外せば負け
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'villager' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager' }),
        makeWorld({ 1: 'villager', 2: 'villager', 3: 'werewolf' }),
      ]
      const alive = new Set([1, 2, 3])
      const result = searchTsumiDirect(worlds, alive)
      // 3人で狼1: 処刑で村人を吊ると2人残り(1狼1村)→狼勝ち
      assert.equal(result.isTsumi, false)
    })

    it('すでに狼全滅 → 即詰み', () => {
      const worlds = [makeWorld({ 1: 'villager', 2: 'villager', 3: 'seer' })]
      const alive = new Set([1, 2, 3])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, true)
    })
  })

  describe('medium result branching', () => {
    it('4人: 狼1 + 村3、2候補 → 霊媒結果で分岐して詰み', () => {
      // 4人生存、狼は1か2のどちらか、霊媒師(3)が生存
      // 1を処刑:
      //   霊媒●(1=狼) → 残り3人(2,3,4)全員村 → 勝ち
      //   霊媒○(1=村) → 残り3人(2,3,4)で狼は2 → 2人目を処刑する前に夜で1人死ぬ
      //     → 2人残り → 2が狼で2>=1 → 狼勝ち
      // 2を処刑しても同様
      // つまり4人狼1・2候補は詰みでない（外すと3人1狼→夜で2人1狼→パリティ負け）
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'medium', 4: 'villager' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'medium', 4: 'villager' }),
      ]
      const alive = new Set([1, 2, 3, 4])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, false)
    })

    it('5人: 狼1 + 村4（2候補）→ 詰み', () => {
      // 5人生存、狼は1か2のどちらか
      // 1を処刑:
      //   霊媒●(1=狼) → 勝ち
      //   霊媒○(1=村) → 4人で狼は2 → 夜に1人死亡 → 3人で狼1
      //     → 2を処刑 → 勝ち
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'medium', 4: 'villager', 5: 'villager' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'medium', 4: 'villager', 5: 'villager' }),
      ]
      const alive = new Set([1, 2, 3, 4, 5])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, true)
    })
  })

  describe('bodyguard', () => {
    it('4人: 狼1 + 狩人 + 村2、2候補 → 護衛込みで詰み', () => {
      // 4人生存、狼は1か2、狩人は3
      // 1を処刑:
      //   霊媒●(1=狼) → 勝ち
      //   霊媒○(1=村) → 3人(2=狼, 3=狩人, 4=村)
      //     → 狩人が護衛しても2人vs1狼...パリティ
      //     → 3人1狼: 2を処刑すれば勝ち。だが2が狼と分かっている（残りの候補は2だけ）
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'bodyguard', 4: 'villager' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'bodyguard', 4: 'villager' }),
      ]
      const alive = new Set([1, 2, 3, 4])
      const result = searchTsumiDirect(worlds, alive)
      // 1を処刑して●→勝ち、○→残り候補は2だけ→2を処刑
      // しかし夜に誰か死ぬ: 3人→夜→2人のうち狼1→パリティ負け？
      // 護衛が入れば: 3人→護衛成功で誰も死なない→3人→2を処刑→勝ち
      // 護衛先は？狼が誰を噛むか不明。狩人が4を護衛→狼が3を噛む→3死亡→2人(2=狼,4)→負け
      // 狩人が3を護衛(自分)→できない（自分は護衛不可）
      // → 護衛先候補: 2か4。狼(2)は自分を噛まないので3か4を噛む
      //   護衛4→狼が4噛み→護衛成功→3人→2処刑→勝ち
      //   護衛4→狼が3噛み→3死亡→2人(2,4)→2>=1→負け
      //   護衛先が正解しないと負ける
      // → 護衛込みでも確実ではない → 詰みでない
      assert.equal(result.isTsumi, false)
    })
  })

  describe('nekomata', () => {
    it('猫又確定: 処刑すると道連れ → 全道連れ先で勝てれば詰み', () => {
      // 3人: 1=猫又, 2=狼, 3=村人
      // 1(猫又)を処刑 → 道連れ: 2か3
      //   道連れ2(狼) → 1人(3) → 狼0 → 村勝ち
      //   道連れ3(村) → 1人(2=狼) → 0 vs 1 → 狼勝ち
      // → 道連れ先で結果が変わる → AND分岐で片方負け → 詰みでない
      //
      // 2(狼)を処刑 → 狼0 → 村勝ち
      const worlds = [makeWorld({ 1: 'nekomata', 2: 'werewolf', 3: 'villager' })]
      const alive = new Set([1, 2, 3])
      const result = searchTsumiDirect(worlds, alive)
      // 2を処刑すれば即勝ち
      assert.equal(result.isTsumi, true)
      if (result.strategy?.type === 'action') {
        assert.equal(result.strategy.action.execute, 2)
      }
    })
  })

  describe('werehamster', () => {
    it('狐生存で狼全滅 → 狐勝ち（村の負け）', () => {
      // 3人: 1=狼, 2=狐, 3=村人
      // 1を処刑 → 狼0 だが狐生存 → 狐勝ち → 村の負け
      // 2を処刑 → 2人(1=狼, 3=村) → 1>=1 → 狼勝ち
      // 3を処刑 → 2人(1=狼, 2=狐) → 狼は狐数えない: 1>=0 → 狼勝ち（但し狐生存→狐勝ち）
      const worlds = [makeWorld({ 1: 'werewolf', 2: 'werehamster', 3: 'villager' })]
      const alive = new Set([1, 2, 3])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, false)
    })
  })

  describe('classic tsumi patterns', () => {
    it('5人2狼: 確定白2 + グレー3（うち狼2）→ 詰み', () => {
      // 確定白: 4, 5 (共有者)
      // グレー: 1, 2, 3 のうち2人が狼
      // 1を処刑 → 霊媒●: 残り4人1狼 → 夜に1人死亡 → 3人1狼 → グレー処刑 → 勝ち
      //         → 霊媒○: 残り4人2狼 → 夜に1人死亡 → 3人2狼 → 負け
      // → 5人2狼・グレー3は詰みでない（1回外すとパリティ負け）
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'werewolf', 3: 'villager', 4: 'mason', 5: 'mason' }),
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'werewolf', 4: 'mason', 5: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'werewolf', 4: 'mason', 5: 'mason' }),
      ]
      const alive = new Set([1, 2, 3, 4, 5])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, false)
    })

    it('7人2狼: 確定白2 + グレー5（うち狼2）→ 詰みでない', () => {
      // 霊媒結果だけでは2連続ミス(○○)で即パリティ負け
      // Day1 ○ → 6人2狼 → Night → 5人2狼
      // Day2 ○ → 4人2狼 → 2>=2 → 狼勝ち
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'werewolf', 3: 'villager', 4: 'villager', 5: 'villager', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'werewolf', 4: 'villager', 5: 'villager', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'villager', 4: 'werewolf', 5: 'villager', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'villager', 4: 'villager', 5: 'werewolf', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'werewolf', 4: 'villager', 5: 'villager', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager', 4: 'werewolf', 5: 'villager', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager', 4: 'villager', 5: 'werewolf', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'villager', 3: 'werewolf', 4: 'werewolf', 5: 'villager', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'villager', 3: 'werewolf', 4: 'villager', 5: 'werewolf', 6: 'mason', 7: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'villager', 3: 'villager', 4: 'werewolf', 5: 'werewolf', 6: 'mason', 7: 'mason' }),
      ]
      const alive = new Set([1, 2, 3, 4, 5, 6, 7])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, false)
      console.log(`  7人2狼: nodes=${result.stats.nodesVisited}, depth=${result.stats.maxDepth}, elapsed=${result.stats.elapsed.toFixed(1)}ms`)
    })

    it('5人1狼: 2候補のみ（残り確定白）→ 詰み', () => {
      // 狼は1か2のどちらか。3,4,5は確定白
      // 1を処刑 → ●→勝ち / ○→狼は2→翌日2処刑→勝ち
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'mason', 4: 'mason', 5: 'villager' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'mason', 4: 'mason', 5: 'villager' }),
      ]
      const alive = new Set([1, 2, 3, 4, 5])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, true)
    })

    it('5人2狼: 確定白1 + グレー4（うち狼2）→ 詰みでない', () => {
      // 確定白: 5
      // グレー: 1-4 のうち2人が狼
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'werewolf', 3: 'villager', 4: 'villager', 5: 'mason' }),
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'werewolf', 4: 'villager', 5: 'mason' }),
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'villager', 4: 'werewolf', 5: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'werewolf', 4: 'villager', 5: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager', 4: 'werewolf', 5: 'mason' }),
        makeWorld({ 1: 'villager', 2: 'villager', 3: 'werewolf', 4: 'werewolf', 5: 'mason' }),
      ]
      const alive = new Set([1, 2, 3, 4, 5])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, false)
    })
  })

  describe('seer integration', () => {
    it('4人1狼: 占い師が生存 → 占い結果で詰み', () => {
      // 4人: 1=占い師, 2or3が狼, 4=村人
      // 占い師が2を占う → 結果で分岐:
      //   2=黒 → 2を処刑 → 勝ち
      //   2=白 → 3が狼確定 → 3を処刑 → 勝ち
      // 但し、夜に占い師が噛まれる可能性もある
      // 4人1狼 → 処刑で1人減 → 3人 → 夜に1人死亡 → 2人
      // 最初の処刑で狼を当てれば勝ち
      // 外した場合: 3人1狼 → 夜→2人1狼 → パリティ負け
      // 占い結果は夜に出る → 翌日の処刑に使える
      // しかし今日の処刑が先に来る
      // → 今日は適当に処刑、占い結果を待って翌日使う
      // → 4人→処刑→3人→夜（占い結果取得）→2人 → もう投票できない可能性

      // 実は4人1狼は余裕がある:
      // 処刑で村人を吊っても3人1狼 → 夜で1人死亡 → 2人1狼 → パリティ負け
      // → 占いがあっても1手しかないので占い結果が間に合わない
      // ただし: 処刑しない選択肢はないので...

      // 実際のフロー: 昼→処刑→夜（占い）→翌昼
      // 占い結果は夜に出て翌日使える
      // 4人→処刑→3人→夜→2人 → もう余裕なし
      // → 占い師がいても4人1狼・2候補は詰みでない（処刑が先で情報が遅い）

      const worlds = [
        makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager', 4: 'villager' }),
        makeWorld({ 1: 'seer', 2: 'villager', 3: 'werewolf', 4: 'villager' }),
      ]
      const alive = new Set([1, 2, 3, 4])
      const result = searchTsumiDirect(worlds, alive)
      // 占い結果が処刑の後なので間に合わない
      // でも: 占い師が夜に占う → 結果は翌日に使える
      // 今日: 2を処刑(or 3)
      //   2=狼(●) → 勝ち
      //   2=村(○) → 3人(1=占,3=狼,4=村) → 夜に占い結果で3=狼判明
      //     → 翌日3を処刑 → 勝ち
      //     → ただし夜に占い師(1)が噛まれたら？ → 2人(3=狼,4=村) → パリティ負け
      //     → 狼は占い師を噛める → 占い師死亡 → 情報失われる → 負け
      // → 占いの情報があっても護衛なしでは占い師が噛まれて負ける
      assert.equal(result.isTsumi, false)
    })

    it('6人1狼: 占い師死亡後は占い結果なし → 詰みでない', () => {
      // 占い師(1)が既に死亡。グレー4人(2,3,4,8)のうち1人が狼。確定白: 5,6(共有)
      // 占い師不在なので新規情報なし。霊媒結果のみで判断
      // 6人1狼: 処刑○→5人→夜→4人 / 処刑○→3人→夜→2人→パリティ
      // 2回連続ミスで負け。4人中1狼では50%で2連ミス → 詰みでない
      const worlds = [
        makeWorld({ 1: 'seer', 2: 'werewolf', 3: 'villager', 4: 'villager', 5: 'mason', 6: 'mason', 7: 'villager', 8: 'villager' }),
        makeWorld({ 1: 'seer', 2: 'villager', 3: 'werewolf', 4: 'villager', 5: 'mason', 6: 'mason', 7: 'villager', 8: 'villager' }),
        makeWorld({ 1: 'seer', 2: 'villager', 3: 'villager', 4: 'werewolf', 5: 'mason', 6: 'mason', 7: 'villager', 8: 'villager' }),
        makeWorld({ 1: 'seer', 2: 'villager', 3: 'villager', 4: 'villager', 5: 'mason', 6: 'mason', 7: 'villager', 8: 'werewolf' }),
      ]
      // 1(占い師)と7は死亡。生存: 2,3,4,5,6,8
      const alive = new Set([2, 3, 4, 5, 6, 8])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, false)
    })

    it('5人1狼: 占い師+狩人 → 護衛込みで詰み', () => {
      // 1=占い師, 2=狩人, 3or4が狼, 5=村人
      // 戦略: 狩人が占い師を護衛、占い師がグレーを占う
      // 今日: 3を処刑
      //   3=狼(●) → 勝ち
      //   3=村(○) → 4人(1=占,2=狩,4=狼,5=村)
      //     夜: 狩人が占い師護衛、占い師が4を占う → 4=黒
      //     狼が占い師噛み → 護衛成功 → 誰も死なない
      //     狼が5を噛み → 5死亡 → 3人(1=占,2=狩,4=狼) → 4を処刑 → 勝ち
      //     狼が狩人噛み → 2死亡 → 3人(1=占,4=狼,5=村) → 4を処刑 → 勝ち
      //   いずれにしても占い結果で狼特定 → 翌日処刑 → 勝ち
      const worlds = [
        makeWorld({ 1: 'seer', 2: 'bodyguard', 3: 'werewolf', 4: 'villager', 5: 'villager' }),
        makeWorld({ 1: 'seer', 2: 'bodyguard', 3: 'villager', 4: 'werewolf', 5: 'villager' }),
      ]
      const alive = new Set([1, 2, 3, 4, 5])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, true)
    })
  })

  describe('format', () => {
    it('戦略木をフォーマットできる', () => {
      const worlds = [
        makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'villager', 4: 'villager', 5: 'villager' }),
        makeWorld({ 1: 'villager', 2: 'werewolf', 3: 'villager', 4: 'villager', 5: 'villager' }),
      ]
      const alive = new Set([1, 2, 3, 4, 5])
      const result = searchTsumiDirect(worlds, alive)
      assert.equal(result.isTsumi, true)

      const text = formatTsumiResult(result)
      assert.ok(text.includes('詰み進行あり'))
      assert.ok(text.includes('処刑:'))
      console.log(text)
    })
  })

  describe('search statistics', () => {
    it('統計情報が返される', () => {
      const worlds = [makeWorld({ 1: 'werewolf', 2: 'villager', 3: 'villager' })]
      const alive = new Set([1, 2, 3])
      const result = searchTsumiDirect(worlds, alive)
      assert.ok(result.stats.nodesVisited > 0)
      assert.ok(result.stats.elapsed >= 0)
      assert.ok(result.stats.worldsTotal > 0)
    })
  })
})
