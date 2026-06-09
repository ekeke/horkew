import { describe, test } from 'node:test'
import assert from 'node:assert'
import { renamePlayer } from './rename.ts'

describe('renamePlayer', () => {
  test('vote の voter / target を置換する', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    assert.match(lines[0], /Alice/)
    assert.strictEqual(lines[1], '+ ボブ')
    assert.strictEqual(lines[2], 'Alice→ボブ')
  })

  test('FlexibleDictionary 経由で表記揺れにマッチする', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'ありす→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'ありす', 'Alice')
    const lines = out.split('\n').filter(l => l.length > 0)
    assert.match(lines[0], /Alice/)
    // ありす は serializer で canonical 形 (Alice) に置換される
    assert.strictEqual(lines[2], 'Alice→ボブ')
  })

  test('リネーム対象を含まない vote は文字列として完全保存される', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      '+ チャーリー',
      'ボブ  →  チャーリー',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // 関係ない vote の不規則な空白が保持される
    assert.strictEqual(lines[3], 'ボブ  →  チャーリー')
  })

  test('コメント行は原文のまま保持される', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      '# アリス を疑っている',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // コメントは触らない
    assert.strictEqual(lines[2], '# アリス を疑っている')
  })

  test('frontmatter は完全保存される (players: も触らない)', () => {
    const input = [
      '---',
      'title: Test',
      'players:',
      '  - アリス',
      '  - ボブ',
      '---',
      '+ アリス',
      '+ ボブ',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const frontmatterEnd = out.indexOf('---\n', 4) + 4
    const frontmatter = out.slice(0, frontmatterEnd)
    assert.match(frontmatter, /^---\ntitle: Test\nplayers:\n  - アリス\n  - ボブ\n---\n/)
  })

  test('存在しない oldName は no-op', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'マロリー', 'Mallory')
    // 全部が文字列として保持される
    assert.strictEqual(out, input)
  })

  test('attack / lynch の target を置換する', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      '噛み アリス',
      'アリス処刑',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    assert.match(lines[2], /Alice/)
    assert.match(lines[3], /Alice/)
    // アリス が残っていないこと (置換対象行のみ)
    assert.doesNotMatch(lines[2], /アリス/)
    assert.doesNotMatch(lines[3], /アリス/)
  })

  test('占いCO の actor / target を置換する', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      '+ チャーリー',
      'アリス 占いCO ボブ○',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    assert.match(lines[3], /^Alice/)
  })

  test('占い結果の target をリネームできる', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'アリス 占いCO ボブ○',
    ].join('\n')
    const out = renamePlayer(input, 'ボブ', 'Bob')
    const lines = out.split('\n')
    assert.match(lines[2], /Bob/)
    assert.doesNotMatch(lines[2], /ボブ/)
  })

  test('joinMulti の特定プレイヤーのみ置換される', () => {
    const input = [
      '++ アリス, ボブ, チャーリー',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // joinMulti は serialize で `+ Alice, ボブ, チャーリー` 形式になる
    assert.match(lines[0], /Alice/)
    assert.match(lines[0], /ボブ/)
    assert.match(lines[0], /チャーリー/)
  })

  test('join の aliases / shortName は既定で保持される', () => {
    const input = [
      '+ アリス(あ) あり ア',
      '+ ボブ',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // name は置換、aliases (あり, ア) は historical reference として保持
    assert.match(lines[0], /Alice/)
    assert.match(lines[0], /あり/)
    assert.match(lines[0], /ア/)
  })

  test('clearAliases: true で対象 join の aliases / shortName が消去される', () => {
    const input = [
      '+ アリス(あ) あり ア',
      '+ ボブ(ぼ) bob',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice', { clearAliases: true })
    const lines = out.split('\n')
    // 対象 join: aliases / shortName が消えて name のみ残る
    assert.strictEqual(lines[0], '+ Alice')
    // 非対象 join (ボブ) には触らない
    assert.strictEqual(lines[1], '+ ボブ(ぼ) bob')
  })

  test('unknown statement は触らない', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'なんだかよくわからない文字列 アリス',
      'アリス→ボブ',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    // unknown は parse 失敗扱いで原文保持
    assert.strictEqual(lines[2], 'なんだかよくわからない文字列 アリス')
    assert.strictEqual(lines[3], 'Alice→ボブ')
  })

  test('inline @MM:SS timestamp は再 serialize 行でも末尾に保持される', () => {
    const input = [
      '+ アリス',
      '+ ボブ',
      'アリス→ボブ @1:23',
    ].join('\n')
    const out = renamePlayer(input, 'アリス', 'Alice')
    const lines = out.split('\n')
    assert.strictEqual(lines[2], 'Alice→ボブ @1:23')
  })
})

/**
 * preservation: 「リネーム対象を含まない行」と「parse 対象外の行」が
 * 完全に元の文字列のまま (表記揺れ・空白・記号も含めて) 保存されるかを確認する。
 *
 * 関連しない行で variant が canonical form に書き換わると、ユーザの記法選択や
 * フォーマット意図が失われるため、 renamePlayer 経由でも touch されてはいけない。
 */
describe('renamePlayer preservation', () => {
  // ----- ヘルパー: 各シナリオで `+ アリス` / `+ ボブ` / `+ チャーリー` を冒頭に置き、
  //                関連しない 1 行が strict equality で残ることを確認する。
  const PROLOGUE = ['+ アリス', '+ ボブ', '+ チャーリー']

  function preservesLine(unrelatedLine: string, oldName = 'アリス', newName = 'Alice'): void {
    const input = [...PROLOGUE, unrelatedLine].join('\n')
    const out = renamePlayer(input, oldName, newName)
    const lines = out.split('\n')
    assert.strictEqual(
      lines[3],
      unrelatedLine,
      `unrelated line should be byte-identical:\n  input:  ${JSON.stringify(unrelatedLine)}\n  output: ${JSON.stringify(lines[3])}`,
    )
  }

  // ---------------------------------------------------------------- vote
  describe('vote / multiVote の表記揺れ保持', () => {
    test('全角矢印 (関連なし)', () => preservesLine('ボブ→チャーリー'))
    test('半角矢印 -> (関連なし)', () => preservesLine('ボブ->チャーリー'))
    test('半角矢印 => (関連なし)', () => preservesLine('ボブ=>チャーリー'))
    test('全角空白入り (関連なし)', () => preservesLine('ボブ　→　チャーリー'))
    test('複数空白入り (関連なし)', () => preservesLine('ボブ   →   チャーリー'))
    test('multiVote 左矢印 (関連なし)', () => preservesLine('チャーリー←ボブ'))
    test('multiVote 半角 <- (関連なし)', () => preservesLine('チャーリー<-ボブ'))
  })

  // ---------------------------------------------------------------- attack / lynch
  describe('attack / lynch の表記揺れ保持', () => {
    test('attack 噛み (関連なし)', () => preservesLine('ボブ噛み'))
    test('attack 噛む 別語形 (関連なし)', () => preservesLine('ボブ噛'))
    test('attack 襲撃 (関連なし)', () => preservesLine('襲撃 ボブ'))
    test('lynch 処刑 (関連なし)', () => preservesLine('ボブ処刑'))
    test('lynch 吊り (関連なし)', () => preservesLine('ボブ吊り'))
    test('lynch なし (関連なし)', () => preservesLine('処刑者なし'))
  })

  // ---------------------------------------------------------------- assert / 占いCO
  describe('assert / CO 行の表記揺れ保持 (関連なし)', () => {
    test('占いCO + 結果 (関連なし)', () => preservesLine('ボブ 占いCO チャーリー○'))
    test('霊媒CO (関連なし)', () => preservesLine('ボブ 霊媒CO'))
    test('狩人CO + 護衛履歴 (関連なし)', () => preservesLine('ボブ 狩人CO 1日目 チャーリー護衛'))
    test('占い結果 日付プレフィックス付き (関連なし)', () => preservesLine('ボブ 1日目 チャーリー●'))
    test('占い結果 D 表記 (関連なし)', () => preservesLine('ボブ 1D チャーリー●'))
  })

  // ---------------------------------------------------------------- mason / reveal / spoiler
  describe('mason / reveal / spoiler の保持 (関連なし)', () => {
    test('mason (関連なし)', () => preservesLine('共有 ボブ, チャーリー'))
    test('reveal (関連なし)', () => preservesLine('ボブ=狩人'))
    test('spoiler = 形式 (関連なし)', () => preservesLine('!ボブ=狼'))
    test('spoiler action 形式 (関連なし)', () => preservesLine('!ボブ 1夜 占い チャーリー'))
  })

  // ---------------------------------------------------------------- speech
  describe('speech の保持 (関連なし)', () => {
    test('speech 半角 > (関連なし)', () => preservesLine('ボブ > こんにちは'))
    test('speech 全角 ＞ (関連なし)', () => preservesLine('ボブ ＞ こんにちは'))
    test('speech 内に oldName を言及 (関連なし)', () => {
      // 「アリス」が言及されているが、 speech の text は parser によって actor だけが
      // 認識される。 actor=ボブ なので renameInStatement は changed=false → 原文保持されるはず。
      preservesLine('ボブ > アリスは怪しい')
    })
  })

  // ---------------------------------------------------------------- curse / follow / forecast / suddenDeath / revote
  describe('その他 statement の保持 (関連なし)', () => {
    test('curse 道連れ (関連なし)', () => preservesLine('ボブ道連れ'))
    test('curse 猫又の呪い (関連なし)', () => preservesLine('ボブ猫又の呪い'))
    test('follow 後追い (関連なし)', () => preservesLine('ボブ後追い'))
    test('forecast 予告 (関連なし)', () => preservesLine('ボブ 予告 チャーリー'))
    test('suddenDeath 突然死 (関連なし)', () => preservesLine('ボブ 突然死'))
    test('suddenDeath 理由付き (関連なし)', () => preservesLine('ボブ 突然死 (回線落ち)'))
    test('revote 半角 -- (関連なし)', () => preservesLine('--'))
    test('revote 全角 ーー (関連なし)', () => preservesLine('ーーー'))
    test('revote == (関連なし)', () => preservesLine('=='))
  })

  // ---------------------------------------------------------------- statement w/ no players (常に保持)
  describe('プレイヤー無し statement の保持', () => {
    test('peace 平和', () => preservesLine('平和'))
    test('grelan グレラン', () => preservesLine('グレラン'))
    test('dayMark Day 2:', () => preservesLine('Day 2:'))
    test('dayMark 2日目:', () => preservesLine('2日目:'))
    test('over 村勝ち', () => preservesLine('村勝ち'))
    test('over 狼勝ち', () => preservesLine('狼勝利'))
    test('over 引き分け', () => preservesLine('引き分け'))
  })

  // ---------------------------------------------------------------- frontmatter (header)
  describe('frontmatter は touch されない', () => {
    test('frontmatter 内に oldName が登場しても完全保存', () => {
      const input = [
        '---',
        'title: アリスとボブの対決',
        'notes: アリス は seer 役',
        'players:',
        '  - アリス',
        '  - ボブ',
        '---',
        '+ アリス',
        '+ ボブ',
        'アリス→ボブ',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      // frontmatter は header として原文保持される
      const frontmatterEnd = out.indexOf('---\n', 4) + 4
      const fm = out.slice(0, frontmatterEnd)
      assert.strictEqual(
        fm,
        '---\ntitle: アリスとボブの対決\nnotes: アリス は seer 役\nplayers:\n  - アリス\n  - ボブ\n---\n',
      )
    })
  })

  // ---------------------------------------------------------------- コメント / 空行
  describe('コメント / 空行の保持', () => {
    test('# コメント内に oldName 含む (touched ではない)', () => {
      const input = [
        '+ アリス',
        '+ ボブ',
        '# アリス が seer CO した',
        '# 別行コメント',
        'アリス→ボブ',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      const lines = out.split('\n')
      assert.strictEqual(lines[2], '# アリス が seer CO した')
      assert.strictEqual(lines[3], '# 別行コメント')
    })
    test('空行が保持される', () => {
      const input = [
        '+ アリス',
        '+ ボブ',
        '',
        'アリス→ボブ',
        '',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      const lines = out.split('\n')
      assert.strictEqual(lines[2], '')
      assert.strictEqual(lines[4], '')
    })
  })

  // ---------------------------------------------------------------- unknown (parse 不能)
  describe('unknown statement の保持', () => {
    test('parse 不能行に oldName が含まれていても原文保持', () => {
      // parser のどれにもマッチしない文字列。 stmt.type === 'unknown' で早期 push される。
      preservesLine('これは関係ないメモ アリス を疑っている')
    })
    test('parse 不能行で oldName と区切り記号を含むケース (関連なし)', () => {
      // parse できなければ unknown 扱いになり原文保持されるはず。
      preservesLine('☆ アリス: 占いCO 予定 ☆')
    })
  })

  // ---------------------------------------------------------------- inline timestamp (関連なし)
  describe('inline timestamp の保持 (関連なし)', () => {
    test('関連しない vote に inline timestamp が付いている', () => {
      preservesLine('ボブ→チャーリー @2:34')
    })
    test('関連しない attack に inline timestamp', () => {
      preservesLine('ボブ噛み @3:45')
    })
  })

  // ---------------------------------------------------------------- 統合シナリオ
  describe('統合シナリオ: 多種混在 howl 文書', () => {
    test('関連しない行群がすべて strict-identical で保存される', () => {
      const input = [
        '---',
        'title: テスト村',
        '---',
        '+ アリス',
        '+ ボブ',
        '+ チャーリー',
        '+ デイブ',
        '',
        '# Day 1 開始',
        'Day 1:',
        'ボブ 占いCO チャーリー●',
        'デイブ 霊媒CO',
        'ボブ->デイブ',         // 関連なし vote, 半角矢印
        'チャーリー  →  ボブ',   // 関連なし vote, 全角矢印 + 余分空白
        'ボブ処刑',
        'チャーリー噛み',         // 関連なし attack
        '平和',
        '--',                    // 関連なし revote
        'Day 2:',
        '# 議論コメント',
        '村勝ち',
        'アリス→ボブ',           // 関連 vote (これだけ書き換わる)
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      const lines = out.split('\n')

      // frontmatter 全保存
      assert.strictEqual(lines[0], '---')
      assert.strictEqual(lines[1], 'title: テスト村')
      assert.strictEqual(lines[2], '---')

      // join 行: アリスだけ書き換わる、他はそのまま
      assert.match(lines[3], /Alice/)
      assert.strictEqual(lines[4], '+ ボブ')
      assert.strictEqual(lines[5], '+ チャーリー')
      assert.strictEqual(lines[6], '+ デイブ')

      // 空行・コメント
      assert.strictEqual(lines[7], '')
      assert.strictEqual(lines[8], '# Day 1 開始')

      // dayMark
      assert.strictEqual(lines[9], 'Day 1:')
      // 関連しない assert (占いCO)
      assert.strictEqual(lines[10], 'ボブ 占いCO チャーリー●')
      assert.strictEqual(lines[11], 'デイブ 霊媒CO')
      // 関連しない vote × 2
      assert.strictEqual(lines[12], 'ボブ->デイブ')
      assert.strictEqual(lines[13], 'チャーリー  →  ボブ')
      // 関連しない lynch
      assert.strictEqual(lines[14], 'ボブ処刑')
      // 関連しない attack
      assert.strictEqual(lines[15], 'チャーリー噛み')
      // peace / revote
      assert.strictEqual(lines[16], '平和')
      assert.strictEqual(lines[17], '--')
      // dayMark / コメント / over
      assert.strictEqual(lines[18], 'Day 2:')
      assert.strictEqual(lines[19], '# 議論コメント')
      assert.strictEqual(lines[20], '村勝ち')
      // 関連 vote (アリス → Alice)
      assert.strictEqual(lines[21], 'Alice→ボブ')
    })
  })

  // ---------------------------------------------------------------- spoiler 切り分け
  describe('spoiler 行のリネーム挙動', () => {
    test('role-pin 形式: 関係ない rename で原文保持', () => {
      const input = [
        '+ アリス',
        '+ ボブ',
        '!アリス=占い',
      ].join('\n')
      const out = renamePlayer(input, 'ボブ', 'Bob')
      assert.strictEqual(out.split('\n')[2], '!アリス=占い')
    })

    test('role-pin 形式: faction alias は関係ない rename で原文保持', () => {
      const input = [
        '+ アリス',
        '+ ボブ',
        '!アリス=狼陣営',
      ].join('\n')
      const out = renamePlayer(input, 'ボブ', 'Bob')
      assert.strictEqual(out.split('\n')[2], '!アリス=狼陣営')
    })

    test('role-pin 形式: ASCII player は関係ない rename で原文保持', () => {
      const input = [
        '+ Alice',
        '+ Bob',
        '!Alice=seer',
      ].join('\n')
      const out = renamePlayer(input, 'Bob', 'Bobby')
      assert.strictEqual(out.split('\n')[2], '!Alice=seer')
    })

    test('action 形式: 誰も hit しない rename で原文保持', () => {
      const input = [
        '+ アリス',
        '+ ボブ',
        '+ チャーリー',
        '!アリス 1夜 占い ボブ',
      ].join('\n')
      const out = renamePlayer(input, 'チャーリー', 'Charlie')
      assert.strictEqual(out.split('\n')[3], '!アリス 1夜 占い ボブ')
    })

    test('action 形式: target が rename 対象 → canonical action 形式で再シリアライズ', () => {
      // 旧バグ: target=ボブ が sub() を通り、 serializer の role-only 出力で
      // `>!アリス undefined!<` に化けて parser unknown 扱いになっていた。
      const input = [
        '+ アリス',
        '+ ボブ',
        '!アリス 1夜 占い ボブ',
      ].join('\n')
      const out = renamePlayer(input, 'ボブ', 'Bob')
      assert.strictEqual(out.split('\n')[2], '!アリス 1夜 占い Bob')
    })

    test('role-pin 形式: player 自身を rename → canonical な !X=role 形式', () => {
      // 旧バグ: `!アリス=占い` → `>!Alice 占い!<` に化けて parser unknown 扱い。
      const input = [
        '+ アリス',
        '+ ボブ',
        '!アリス=占い',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      assert.strictEqual(out.split('\n')[2], '!Alice=占い')
    })

    test('action 形式: player 自身を rename → canonical action 形式', () => {
      const input = [
        '+ アリス',
        '+ ボブ',
        '!アリス 1夜 占い ボブ',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      assert.strictEqual(out.split('\n')[2], '!Alice 1夜 占い ボブ')
    })
  })

  // ---------------------------------------------------------------- corpseFound
  describe('corpseFound 行のリネーム挙動', () => {
    test('関係ない rename で原文保持', () => {
      const input = [
        '+ アリス',
        '+ ボブ',
        'ボブ 死体発見',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      assert.strictEqual(out.split('\n')[2], 'ボブ 死体発見')
    })

    test('対象 target を rename → canonical 形式で再シリアライズ', () => {
      // 旧バグ: renameInStatement に corpseFound case が無く default → null
      // 返却で原文保持されていた (=rename 対象が含まれていても置換されない)。
      const input = [
        '+ アリス',
        '+ ボブ',
        'アリス 死体発見',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      assert.strictEqual(out.split('\n')[2], 'Alice 死体発見')
    })
  })

  // ---------------------------------------------------------------- 表記揺れマッチング (危険ゾーン)
  describe('FlexibleDictionary 経由のリネーム範囲', () => {
    test('別人 (アル) の vote はアリス検索でマッチしない', () => {
      // ア + L vs ア + リ + ス。 length=2 の 1 文字スキップにも該当しない。
      const input = [
        '+ アリス',
        '+ ボブ',
        '+ アル',
        'アル→ボブ',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      const lines = out.split('\n')
      assert.strictEqual(
        lines[3],
        'アル→ボブ',
        '別人 (アル) の vote は touch されないこと',
      )
    })

    test('別人 (チャーリー) は touch されない', () => {
      const input = [
        '+ アリス',
        '+ ボブ',
        '+ チャーリー',
        'チャーリー→ボブ',
        'ボブ→チャーリー',
      ].join('\n')
      const out = renamePlayer(input, 'アリス', 'Alice')
      const lines = out.split('\n')
      assert.strictEqual(lines[3], 'チャーリー→ボブ')
      assert.strictEqual(lines[4], 'ボブ→チャーリー')
    })
  })
})
