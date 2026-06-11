import { describe, test } from 'node:test'
import assert from 'node:assert'
import {
  inferContext, getContinuousProtectionExclusion, buildDayCandidates,
  type PlayerEntry, type GameStats, type Category,
} from './howlCompletion.ts'

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function player(name: string, opts: Partial<Omit<PlayerEntry, 'name'>> = {}): PlayerEntry {
  return {
    name,
    aliases: opts.aliases ?? [],
    surviving: opts.surviving ?? true,
    shortName: opts.shortName,
    claimingRole: opts.claimingRole,
  }
}

const PLAYERS: PlayerEntry[] = [
  player('エケケ', { shortName: 'エケ' }),
  player('ヒトミ', { shortName: 'ヒト' }),
  player('カズキ', { shortName: 'カズ' }),
]

const SEER_CLAIM: PlayerEntry[] = [
  player('エケケ', { shortName: 'エケ', claimingRole: 'seer' }),
  player('ヒトミ', { shortName: 'ヒト' }),
  player('カズキ', { shortName: 'カズ' }),
]

// デフォルト規定: omitFirstDay=false, first-seek='all', first-victim='random'
// → Day 2 朝で初めて過去夜 1 (Night 1) が現れ、 first-seek=all なので 1 件報告可
function stats(opts: Partial<GameStats> = {}): GameStats {
  return {
    day: opts.day ?? 1,
    executions: opts.executions ?? 0,
    seerFirstSeek: opts.seerFirstSeek ?? 'all',
    firstVictim: opts.firstVictim ?? 'random',
    omitFirstDay: opts.omitFirstDay ?? false,
    bodyguardAllowContinuous: opts.bodyguardAllowContinuous ?? true,
  }
}
const STATS_DAY1 = stats({ day: 1, executions: 0 })
const STATS_DAY2 = stats({ day: 2, executions: 1 })
const STATS_DAY3 = stats({ day: 3, executions: 2 })

// 期待カテゴリの順序は実装の戻り値順に合わせる前提では脆い。
// has/lacks ヘルパでカテゴリ含有のみを検証する。
function hasCategory(result: Category[] | null, cat: Category): boolean {
  return result !== null && result.includes(cat)
}

// ----------------------------------------------------------------------------
// 行頭・空文字
// ----------------------------------------------------------------------------

describe('inferContext — 行頭', () => {
  test('空文字: プレイヤー + 行頭名 + アクション + standalone + gameresult', () => {
    const r = inferContext('', PLAYERS, STATS_DAY1)
    assert.ok(hasCategory(r, 'player'))
    assert.ok(hasCategory(r, 'player_start'))
    assert.ok(hasCategory(r, 'action'))
    assert.ok(hasCategory(r, 'standalone'))
    assert.ok(hasCategory(r, 'gameresult'))
  })
})

// ----------------------------------------------------------------------------
// 矢印・アクション
// ----------------------------------------------------------------------------

describe('inferContext — 矢印 / アクション', () => {
  test('→ の後 → プレイヤー名', () => {
    const r = inferContext('エケケ → ', PLAYERS, STATS_DAY1)
    assert.deepStrictEqual(r, ['player'])
  })

  test('プレイヤー → プレイヤー (= 投票文完成) → 終了', () => {
    const r = inferContext('エケケ → ヒトミ ', PLAYERS, STATS_DAY1)
    assert.strictEqual(r, null)
  })

  test('行頭アクション (転置記法) → プレイヤー名', () => {
    const r = inferContext('処刑 ', PLAYERS, STATS_DAY1)
    assert.deepStrictEqual(r, ['player'])
  })

  test('プレイヤー アクション (通常記法) → 終了', () => {
    const r = inferContext('エケケ 処刑 ', PLAYERS, STATS_DAY1)
    assert.strictEqual(r, null)
  })
})

// ----------------------------------------------------------------------------
// 占い師CO のチェーン (今回の本丸)
// ----------------------------------------------------------------------------

describe('inferContext — 占い師CO チェーン (規定マトリクス)', () => {
  // ---- omitFirstDay=false (default): Day 1 朝には過去夜なし、 ただし first-seek != 'none' なら 0日目 結果が報告可 ----
  test('Day 1 + omitFirstDay=false + first-seek=all (default): 0日目 結果 1件報告可 → day + player', () => {
    const r = inferContext('エケケ 占い師CO ', SEER_CLAIM, STATS_DAY1)
    assert.ok(r !== null, 'first-seek != none なら Day 1 朝に 0日目 (= 行動日 0 = Day 0 の夜) の結果を 1 件報告可')
    assert.ok(hasCategory(r, 'day'))
    assert.ok(hasCategory(r, 'player'))
  })

  test('Day 1 + omitFirstDay=false + first-seek=none: pastNights=0 → 上限 0 → null', () => {
    const r = inferContext('エケケ 占い師CO ', SEER_CLAIM, stats({ day: 1, seerFirstSeek: 'none' }))
    assert.strictEqual(r, null, 'first-seek=none なら Day 1 朝に報告可能な結果は無い')
  })

  test('Day 2 + first-seek=all: pastNights=1 → day + player', () => {
    const r = inferContext('エケケ 占い師CO ', SEER_CLAIM, STATS_DAY2)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'day'))
    assert.ok(hasCategory(r, 'player'))
  })

  test('Day 2 + first-seek=none: pastNights=1 - 1 = 0 → null', () => {
    const r = inferContext('エケケ 占い師CO ', SEER_CLAIM, stats({ day: 2, seerFirstSeek: 'none' }))
    assert.strictEqual(r, null, 'first-seek=none で初夜結果が報告不可')
  })

  // ---- omitFirstDay=true: Day 1 朝が Night 0 後 (= 初夜結果がここで出る) ----
  test('★ omitFirstDay=true + first-seek=all + Day 1: 占い師CO 直後 → player', () => {
    const r = inferContext('エケケ 占い師CO ', SEER_CLAIM, stats({ day: 1, omitFirstDay: true }))
    assert.ok(r !== null, 'omitFirstDay=true なら Day 1 朝に初夜結果 1 件報告可')
    assert.ok(hasCategory(r, 'player'))
  })

  test('omitFirstDay=true + first-seek=none + Day 1: pastNights=1 - 1 = 0 → null', () => {
    const r = inferContext('エケケ 占い師CO ', SEER_CLAIM, stats({ day: 1, omitFirstDay: true, seerFirstSeek: 'none' }))
    assert.strictEqual(r, null)
  })

  test('omitFirstDay=true + first-seek=all + Day 2: pastNights=2 → 2 件まで OK', () => {
    const r = inferContext('エケケ 占い師CO ', SEER_CLAIM, stats({ day: 2, omitFirstDay: true }))
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'player'))
  })

  // ---- chain の途中 ----
  test('Day 2: 占い師CO 2日目 直後 → プレイヤー候補', () => {
    const r = inferContext('エケケ 占い師CO 2日目 ', SEER_CLAIM, STATS_DAY2)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'player'))
  })

  test('Day 2: 占い師CO 2日目 ヒトミ 直後 → 結果 (○/●)', () => {
    const r = inferContext('エケケ 占い師CO 2日目 ヒトミ ', SEER_CLAIM, STATS_DAY2)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'result'))
  })

  // omitFirstDay=false + first-seek=all + Day 2: pastNights=1 + 1 (= 0日目) = 上限 2 → 1 件報告済みでさらに 1 件報告可
  test('Day 2 + first-seek=all: 1 件報告済み → 0日目 結果がまだ報告可 → day + player', () => {
    const r = inferContext('エケケ 占い師CO 2日目 ヒトミ ● ', SEER_CLAIM, STATS_DAY2)
    assert.ok(r !== null, 'first-seek != none で行動日 0 の結果も報告可なので 1 件目で上限に達しない')
    assert.ok(hasCategory(r, 'day'))
    assert.ok(hasCategory(r, 'player'))
  })

  test('Day 2 + first-seek=none: 1 件報告済み → 上限到達 → null', () => {
    const r = inferContext('エケケ 占い師CO 2日目 ヒトミ ● ', SEER_CLAIM, stats({ day: 2, seerFirstSeek: 'none' }))
    assert.strictEqual(r, null, 'first-seek=none で pastNights=1 - 1 = 0 なので 1 件目で上限。 ただし実際は 1 件報告済み → 過去夜カウントずれだが null は維持')
  })

  // omitFirstDay=true + first-seek=all + Day 2: pastNights=2 → 2 件まで OK
  test('omitFirstDay=true + Day 2: 1 件報告済み → さらに day + player', () => {
    const r = inferContext('エケケ 占い師CO 2日目 ヒトミ ● ', SEER_CLAIM, stats({ day: 2, omitFirstDay: true }))
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'day'))
    assert.ok(hasCategory(r, 'player'))
  })

  test('Day 3: 占い師CO 2日目 ヒトミ ● 直後 → さらに day + player', () => {
    const r = inferContext('エケケ 占い師CO 2日目 ヒトミ ● ', SEER_CLAIM, STATS_DAY3)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'day'))
    assert.ok(hasCategory(r, 'player'))
  })
})

// ----------------------------------------------------------------------------
// 狩人CO チェーン (first-victim 反映)
// ----------------------------------------------------------------------------

describe('inferContext — 狩人CO チェーン (first-victim 反映)', () => {
  const BG_CLAIM: PlayerEntry[] = [
    player('エケケ', { shortName: 'エケ', claimingRole: 'bodyguard' }),
    player('ヒトミ', { shortName: 'ヒト' }),
    player('カズキ', { shortName: 'カズ' }),
  ]

  test('Day 2 + first-victim=random (default): Night 0 guard 無効 → pastNights=1 - 1 = 0 → null', () => {
    const r = inferContext('エケケ 狩人CO ', BG_CLAIM, STATS_DAY2)
    assert.strictEqual(r, null, 'first-victim != none なら初夜護衛は engine 側で無視される')
  })

  test('Day 2 + first-victim=none: pastNights=1 → day + player', () => {
    const r = inferContext('エケケ 狩人CO ', BG_CLAIM, stats({ day: 2, firstVictim: 'none' }))
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'day'))
    assert.ok(hasCategory(r, 'player'))
  })

  test('omitFirstDay=true + first-victim=none + Day 1: pastNights=1 → player', () => {
    const r = inferContext('エケケ 狩人CO ', BG_CLAIM, stats({ day: 1, omitFirstDay: true, firstVictim: 'none' }))
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'player'))
  })

  test('omitFirstDay=true + first-victim=random + Day 1: pastNights=1 - 1 = 0 → null', () => {
    const r = inferContext('エケケ 狩人CO ', BG_CLAIM, stats({ day: 1, omitFirstDay: true, firstVictim: 'random' }))
    assert.strictEqual(r, null)
  })

  test('Day 3 + first-victim=random: 1 件報告済み → 上限到達 → null', () => {
    const r = inferContext('エケケ 狩人CO 2日目 ヒトミ ', BG_CLAIM, STATS_DAY3)
    // pastNights=2 だが first-victim != 'none' で初夜分を -1 → max=1
    // 既に 1 件 (= 2日目=ヒトミ) 報告済みなので 2 件目以降は出さない
    assert.strictEqual(r, null)
  })
})

// ----------------------------------------------------------------------------
// 連続護衛禁止 (role.bodyguard.allow-continuous-protection=false)
// ----------------------------------------------------------------------------

describe('getContinuousProtectionExclusion — 連続護衛禁止', () => {
  const BG_CLAIM: PlayerEntry[] = [
    player('エケケ', { shortName: 'エケ', claimingRole: 'bodyguard' }),
    player('ヒトミ', { shortName: 'ヒト' }),
    player('カズキ', { shortName: 'カズ' }),
  ]

  test('狩人CO 行で直前のプレイヤー名を返す', () => {
    const exclude = getContinuousProtectionExclusion(
      'エケケ 狩人CO 2日目 ヒトミ 3日目 ',
      'エケケ 狩人CO 2日目 ヒトミ 3日目 ',
      BG_CLAIM,
    )
    assert.strictEqual(exclude, 'ヒト', '直前の護衛先 (ヒトミ) を shortName で返す')
  })

  test('狩人CO 直後 (まだプレイヤー未指定): null', () => {
    const exclude = getContinuousProtectionExclusion(
      'エケケ 狩人CO ', 'エケケ 狩人CO ', BG_CLAIM,
    )
    assert.strictEqual(exclude, null)
  })

  test('行頭プレイヤーが bodyguard CO していない行: null', () => {
    const seer: PlayerEntry[] = [
      player('エケケ', { shortName: 'エケ', claimingRole: 'seer' }),
      player('ヒトミ', { shortName: 'ヒト' }),
    ]
    const exclude = getContinuousProtectionExclusion(
      'エケケ 占い師CO 2日目 ヒトミ 3日目 ',
      'エケケ 占い師CO 2日目 ヒトミ 3日目 ',
      seer,
    )
    assert.strictEqual(exclude, null, 'bodyguard CO 行以外では除外対象を返さない')
  })

  test('shortName / aliases にマッチしても shortName で返す', () => {
    const exclude = getContinuousProtectionExclusion(
      'エケケ 狩人CO 2日目 ヒト 3日目 ',
      'エケケ 狩人CO 2日目 ヒト 3日目 ',
      BG_CLAIM,
    )
    assert.strictEqual(exclude, 'ヒト')
  })
})

// ----------------------------------------------------------------------------
// 霊媒師CO チェーン
// ----------------------------------------------------------------------------

describe('inferContext — 霊媒師CO チェーン', () => {
  const MEDIUM_CLAIM: PlayerEntry[] = [
    player('エケケ', { shortName: 'エケ', claimingRole: 'medium' }),
    player('ヒトミ', { shortName: 'ヒト' }),
  ]

  test('Day 2 + 処刑 1 回: 霊媒師CO 直後 → day + result', () => {
    const r = inferContext('エケケ 霊媒師CO ', MEDIUM_CLAIM, STATS_DAY2)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'day'))
    assert.ok(hasCategory(r, 'result'))
  })

  test('Day 2 + 処刑 0 回: 霊媒師CO 直後 → 上限 0 → null', () => {
    const r = inferContext('エケケ 霊媒師CO ', MEDIUM_CLAIM, stats({ day: 2, executions: 0 }))
    assert.strictEqual(r, null)
  })

  // medium には初夜/初日系規定の影響は無い (能力は「過去処刑数」 のみで決まる)。
  // omitFirstDay / first-victim / first-seek を変えても挙動は executions だけで決まることを担保。
  test('規定変更不変: omitFirstDay=true + first-victim=none + first-seek=none でも executions のみで決まる', () => {
    const opts = { firstVictim: 'none' as const, seerFirstSeek: 'none' as const, omitFirstDay: true }
    const r0 = inferContext('エケケ 霊媒師CO ', MEDIUM_CLAIM, stats({ day: 3, executions: 0, ...opts }))
    assert.strictEqual(r0, null, '処刑 0 件 → 上限 0')
    const r1 = inferContext('エケケ 霊媒師CO ', MEDIUM_CLAIM, stats({ day: 3, executions: 1, ...opts }))
    assert.ok(r1 !== null, '処刑 1 件 → day + result')
    assert.ok(hasCategory(r1, 'result'))
  })
})

// ----------------------------------------------------------------------------
// 役職行動を持たないCO (村人 / 人狼 等)
// ----------------------------------------------------------------------------

describe('inferContext — 宣言完結 (村人CO / 非○○CO)', () => {
  test('村人CO 直後 → null (チェーン終了)', () => {
    const villager: PlayerEntry[] = [
      player('エケケ', { shortName: 'エケ', claimingRole: 'villager' }),
    ]
    const r = inferContext('エケケ 村人CO ', villager, STATS_DAY2)
    assert.strictEqual(r, null)
  })

  test('非占い師CO 直後 → null (denial は terminal)', () => {
    // claimingRole が seer の人が「自分は占い師ではない」 と宣言した形でも
    // denial CO は宣言完結。 後続に day/player を出してはいけない。
    const r = inferContext('エケケ 非占い師CO ', SEER_CLAIM, STATS_DAY2)
    assert.strictEqual(r, null)
  })

  test('非村人CO 直後 → null', () => {
    const r = inferContext('エケケ 非村人CO ', PLAYERS, STATS_DAY2)
    assert.strictEqual(r, null)
  })
})

// ----------------------------------------------------------------------------
// 共有 / ← 行
// ----------------------------------------------------------------------------

describe('inferContext — 共有 / ←行', () => {
  test('共有 (アクション) + プレイヤー + プレイヤー → さらにプレイヤー追加可', () => {
    const r = inferContext('共有 エケケ ヒトミ ', PLAYERS, STATS_DAY1)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'player'))
  })

  test('← の後 → プレイヤー名 (得票記法)', () => {
    const r = inferContext('エケケ ← ', PLAYERS, STATS_DAY1)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'player'))
  })

  test('← の後にプレイヤー名が続く → さらにプレイヤー追加可', () => {
    const r = inferContext('エケケ ← ヒトミ ', PLAYERS, STATS_DAY1)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'player'))
  })
})

// ----------------------------------------------------------------------------
// プレイヤー名のみ (行頭)
// ----------------------------------------------------------------------------

describe('inferContext — 行頭プレイヤー名のみ', () => {
  test('CO 未宣言プレイヤー → arrow / co_role / action / result 等', () => {
    const r = inferContext('エケケ ', PLAYERS, STATS_DAY1)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'arrow'))
    assert.ok(hasCategory(r, 'co_role'))
    assert.ok(hasCategory(r, 'action'))
  })

  test('占い師CO 済みプレイヤー (Day 2) → day / player / 他', () => {
    const r = inferContext('エケケ ', SEER_CLAIM, STATS_DAY2)
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'player'))
  })

  // ★ Day 1 + first-seek=none の cap=0 で 報告系候補 (day / player / result) が
  //   出ないことを担保。 汎用候補 (arrow / co_role / action) は残る。
  // first-seek != 'none' のときは 0日目 結果が 1 件報告可なので別途許容される。
  test('★ 初日CO 占い師 (Day 1 + first-seek=none + cap=0) → 報告系 (day/player/result) を出さない', () => {
    const r = inferContext('エケケ ', SEER_CLAIM, stats({ day: 1, seerFirstSeek: 'none' }))
    assert.ok(r !== null)
    assert.ok(!hasCategory(r, 'day'), 'day 候補は cap=0 で除外')
    assert.ok(!hasCategory(r, 'player'), 'player 候補は cap=0 で除外')
    assert.ok(!hasCategory(r, 'result'), 'result 候補は cap=0 で除外')
    assert.ok(hasCategory(r, 'arrow'), 'arrow は汎用候補として残す')
    assert.ok(hasCategory(r, 'co_role'))
    assert.ok(hasCategory(r, 'action'))
  })

  test('★ 初日CO 狩人 (Day 1 + first-victim=random + cap=0) → player を出さない', () => {
    const BG_CLAIM: PlayerEntry[] = [
      player('エケケ', { shortName: 'エケ', claimingRole: 'bodyguard' }),
      player('ヒトミ', { shortName: 'ヒト' }),
    ]
    const r = inferContext('エケケ ', BG_CLAIM, STATS_DAY1)
    assert.ok(r !== null)
    assert.ok(!hasCategory(r, 'day'))
    assert.ok(!hasCategory(r, 'player'))
    assert.ok(hasCategory(r, 'arrow'))
  })

  test('狩人CO 済み + Day 2 + first-victim=random: cap=0 で player を出さない', () => {
    const BG_CLAIM: PlayerEntry[] = [
      player('エケケ', { shortName: 'エケ', claimingRole: 'bodyguard' }),
      player('ヒトミ', { shortName: 'ヒト' }),
    ]
    const r = inferContext('エケケ ', BG_CLAIM, STATS_DAY2)
    assert.ok(r !== null)
    assert.ok(!hasCategory(r, 'player'), 'Day 2 でも first-victim=random なら cap=0')
    assert.ok(hasCategory(r, 'arrow'))
  })

  test('狩人CO 済み + Day 2 + first-victim=none: player 候補を出す', () => {
    const BG_CLAIM: PlayerEntry[] = [
      player('エケケ', { shortName: 'エケ', claimingRole: 'bodyguard' }),
      player('ヒトミ', { shortName: 'ヒト' }),
    ]
    const r = inferContext('エケケ ', BG_CLAIM, stats({ day: 2, firstVictim: 'none' }))
    assert.ok(r !== null)
    assert.ok(hasCategory(r, 'player'))
    assert.ok(hasCategory(r, 'day'))
  })

  test('霊媒師CO 済み + 処刑 0 回 (cap=0): result を出さない', () => {
    const MEDIUM_CLAIM: PlayerEntry[] = [
      player('エケケ', { shortName: 'エケ', claimingRole: 'medium' }),
      player('ヒトミ', { shortName: 'ヒト' }),
    ]
    const r = inferContext('エケケ ', MEDIUM_CLAIM, stats({ day: 2, executions: 0 }))
    assert.ok(r !== null)
    assert.ok(!hasCategory(r, 'day'))
    assert.ok(!hasCategory(r, 'result'))
    assert.ok(hasCategory(r, 'arrow'))
  })
})

// ----------------------------------------------------------------------------
// buildDayCandidates: 0日目 拡張 (first-seek 連動)
// ----------------------------------------------------------------------------

describe('buildDayCandidates — 0日目 (first-seek 連動)', () => {
  test('first-seek = none: 0日目 候補は出ない (= 通常通り 1日目〜)', () => {
    const candidates = buildDayCandidates(3, 'none')
    const labels = candidates.map(c => c.label)
    assert.deepStrictEqual(labels, ['1日目', '2日目', '3日目'])
  })

  test('first-seek = no-wolf: 0日目 候補が含まれる', () => {
    const candidates = buildDayCandidates(3, 'no-wolf')
    const labels = candidates.map(c => c.label)
    assert.deepStrictEqual(labels, ['0日目', '1日目', '2日目', '3日目'])
  })

  test('first-seek = all: 0日目 候補が含まれる', () => {
    const candidates = buildDayCandidates(2, 'all')
    const labels = candidates.map(c => c.label)
    assert.deepStrictEqual(labels, ['0日目', '1日目', '2日目'])
  })

  test('currentDay = 1: first-seek 規定下では 0日目 + 1日目', () => {
    const candidates = buildDayCandidates(1, 'no-wolf')
    const labels = candidates.map(c => c.label)
    assert.deepStrictEqual(labels, ['0日目', '1日目'])
  })

  test('0日目 候補の info 表示は first-seek 由来を明示', () => {
    const candidates = buildDayCandidates(1, 'no-wolf')
    const day0 = candidates.find(c => c.label === '0日目')
    assert.ok(day0)
    assert.match(day0!.info ?? '', /first-seek/)
  })
})
