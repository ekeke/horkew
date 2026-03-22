// ============================================================================
// Howl Syntax Highlighting — Decoration-based approach using real parser output
// ============================================================================
//
// ## 概要
//
// このモジュールはCM6のDecoration APIを使い、Howlパーサーの出力に基づいて
// シンタックスハイライトを適用する。独自の正規表現でトークナイズするのではなく、
// App.svelteのrun()で実行される実際のHowlパーサー(src/howl/parser.ts)の
// parse結果を受け取り、それをDecorationに変換する。
//
// ## データフロー
//
// 1. ユーザーがエディタに入力
// 2. CM6 onChange → App.svelteのinput更新 → $effect → run()
// 3. run()内でparse(input)が実行され、statements[]が得られる
// 4. statements[]からStatementInfo[]を作り、setStatements Effectでこのモジュールに送信
// 5. buildDecorations()がStatementInfo[] + docからDecorationSetを構築
// 6. CM6が装飾を描画
//
// ## ハイライトの2層構造
//
// ### Layer 1: 行レベル装飾 (Decoration.line)
//   パーサーが返すstatement.typeに基づいて行全体にCSSクラスを付与。
//   これにより行の種別が視覚的に区別できる。
//
//   StatementType → CSSクラスの対応:
//     join, joinMulti  → hwl-join    (プレイヤー参加)
//     vote, multiVote  → hwl-vote    (投票)
//     attack           → hwl-attack  (夜襲撃)
//     lynch            → hwl-lynch   (処刑)
//     curse            → hwl-curse   (道連れ)
//     follow           → hwl-follow  (後追い)
//     peace            → hwl-peace   (平和)
//     revote           → hwl-revote  (再投票)
//     over             → hwl-over    (ゲーム終了)
//     assert, mason    → hwl-assert  (CO/共有確認)
//     reveal           → hwl-reveal  (役職公開)
//     unknown          → hwl-unknown (パース不能行)
//
// ### Layer 2: 行内トークン装飾 (Decoration.mark)
//   vocabulary.tsからインポートした正規表現で、行内の特定トークンにCSSクラスを付与。
//   パーサーのstatement.typeに応じて適用するトークン種を制限する。
//
//   全statement共通:
//     rightArrow, leftArrow  → hw-arrow  (→, =>, <-, ← 等)
//     isHuman                → hw-human  (白, ○ 等)
//     isWolf                 → hw-wolf   (黒, ● 等)
//
//   assertのみ:
//     claim (CO)             → hw-co     (CO キーワード)
//     anyRole                → hw-role   (役職名: 占い, 霊媒, 狩人 等)
//
//   revealのみ:
//     anyRole                → hw-role   (役職名)
//
// ## パーサーがカバーしない行の処理
//
//   Howlパーサーのpreprocess段階で除去される行は、statementsに含まれない。
//   これらはdoc全体を走査して直接検出する:
//
//   - frontmatter行 (--- で囲まれたYAML) → hw-meta マーク
//   - コメント行 (# で始まる行)          → hw-comment マーク
//   - 空行                               → 装飾なし
//
// ## 実装済み機能
//
//   1. プレイヤー名マッチの可視化
//      - PlayerNameInfo[] で解決済み/未解決のプレイヤー名位置をApp.svelteから送信
//      - hw-player-resolved (薄い緑下線), hw-player-unresolved (赤波線) で表示
//
//   2. カーソル行以下のグレイアウト
//      - HighlightPayloadにcursorLineを含め、カーソル行以下をhw-beyond-cursorで半透明化
//
//   3. unknown行の可視化強化
//      - hwl-unknown行レベル装飾 + hwl-unknown-textマーク (波線+背景+ツールチップ)
//
//   4. 重要アクションのクラス分け・装飾
//      - curse → hwl-curse, follow → hwl-follow に分離
//      - lynch/attack/peace等に背景色 + CSS ::before アイコン
//
// ## StateField の更新戦略
//
//   - setStatements Effect受信時: buildDecorations()で全装飾を再構築
//   - doc変更のみ(Effect無し): 既存装飾をchanges.mapで位置調整
//     (次のrun()で新しいstatementsが来るまでの暫定措置)
//   - それ以外: 装飾を維持
//
// ============================================================================

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import type { StatementType } from '../../src/howl/statement.ts'
import * as V from '../../src/howl/vocabulary.ts'

// ---- Public API ----

export type StatementInfo = { type: StatementType, line: number }

export type PlayerNameInfo = {
  line: number
  offset: number
  length: number
  kind: 'resolved' | 'unresolved' | 'definition'
}

export type HighlightPayload = {
  statements: StatementInfo[]
  cursorLine: number
  playerNames: PlayerNameInfo[]
}

/** App.svelteからパース結果を送信するためのStateEffect */
export const setStatements = StateEffect.define<HighlightPayload>()

// ---- Inline token patterns (from vocabulary.ts) ----

const rightArrowRe = new RegExp(V.rightArrow, 'g')
const leftArrowRe  = new RegExp(V.leftArrow, 'g')
const humanRe      = new RegExp(V.isHuman, 'g')
const wolfRe       = new RegExp(V.isWolf, 'g')
const roleRe       = new RegExp(V.anyRole, 'g')
const coRe         = new RegExp(V.claim, 'g')

// ---- Decoration marks (行内トークン用) ----

const markDeco = {
  arrow:    Decoration.mark({ class: 'hw-arrow' }),
  human:    Decoration.mark({ class: 'hw-human' }),
  wolf:     Decoration.mark({ class: 'hw-wolf' }),
  role:     Decoration.mark({ class: 'hw-role' }),
  co:       Decoration.mark({ class: 'hw-co' }),
  comment:  Decoration.mark({ class: 'hw-comment' }),
  meta:     Decoration.mark({ class: 'hw-meta' }),
  joinName: Decoration.mark({ class: 'hw-join-name' }),
  unknownText: Decoration.mark({ class: 'hwl-unknown-text', attributes: { title: 'この行はHowl記法として認識できません' } }),
  playerResolved:   Decoration.mark({ class: 'hw-player-resolved' }),
  playerUnresolved: Decoration.mark({ class: 'hw-player-unresolved', attributes: { title: '登録されていないプレイヤー名です' } }),
}

// ---- Line decorations (行レベル・statement type別) ----

const lineDeco: Record<string, Decoration> = {
  join:      Decoration.line({ class: 'hwl-join' }),
  joinMulti: Decoration.line({ class: 'hwl-join' }),
  vote:      Decoration.line({ class: 'hwl-vote' }),
  multiVote: Decoration.line({ class: 'hwl-vote' }),
  attack:    Decoration.line({ class: 'hwl-attack' }),
  lynch:     Decoration.line({ class: 'hwl-lynch' }),
  curse:     Decoration.line({ class: 'hwl-curse' }),
  follow:    Decoration.line({ class: 'hwl-follow' }),
  peace:     Decoration.line({ class: 'hwl-peace' }),
  revote:    Decoration.line({ class: 'hwl-revote' }),
  over:      Decoration.line({ class: 'hwl-over' }),
  assert:    Decoration.line({ class: 'hwl-assert' }),
  mason:     Decoration.line({ class: 'hwl-assert' }),
  reveal:    Decoration.line({ class: 'hwl-reveal' }),
  unknown:   Decoration.line({ class: 'hwl-unknown' }),
}

const beyondCursorDeco = Decoration.line({ class: 'hw-beyond-cursor' })

// ---- Helpers ----

/** 正規表現の全マッチを [from, to] ペア (doc内絶対位置) として返す */
function findMatches(re: RegExp, text: string, base: number): [number, number][] {
  const results: [number, number][] = []
  re.lastIndex = 0
  let m
  while ((m = re.exec(text)) !== null) {
    results.push([base + m.index, base + m.index + m[0].length])
  }
  return results
}

/** frontmatter領域の終了位置 (exclusive) を返す。frontmatterが無ければ0 */
function detectFrontmatterEnd(doc: string): number {
  if (!doc.startsWith('---\n') && !doc.startsWith('---\r\n')) return 0
  const searchStart = doc.startsWith('---\r\n') ? 5 : 4
  const endIdx = doc.indexOf('\n---\n', searchStart)
  if (endIdx === -1) {
    const endIdx2 = doc.indexOf('\n---\r\n', searchStart)
    if (endIdx2 === -1) return 0
    return endIdx2 + 6
  }
  return endIdx + 5
}

// ---- Build decorations from statements + doc ----

function buildDecorations(
  statements: StatementInfo[],
  cursorLine: number,
  playerNames: PlayerNameInfo[],
  doc: { toString(): string, line(n: number): { from: number, to: number, text: string }, lines: number },
): DecorationSet {
  const text = doc.toString()
  const builder: { from: number, to: number, deco: Decoration }[] = []

  // Layer 0: Frontmatter (パーサーが除去する領域)
  const fmEnd = detectFrontmatterEnd(text)
  if (fmEnd > 0) {
    builder.push({ from: 0, to: fmEnd, deco: markDeco.meta })
  }

  // Layer 0: コメント行 (パーサーが除去する行)
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    if (line.from < fmEnd) continue
    const trimmed = line.text.trimStart()
    if (trimmed.startsWith('#')) {
      builder.push({ from: line.from, to: line.to, deco: markDeco.comment })
    }
  }

  // Layer 1 + 2: Statement行の装飾
  for (const stmt of statements) {
    if (stmt.line < 1 || stmt.line > doc.lines) continue
    const line = doc.line(stmt.line)

    // Layer 1: 行レベル装飾
    const ld = lineDeco[stmt.type]
    if (ld) {
      builder.push({ from: line.from, to: line.from, deco: ld })
    }

    // Layer 2: 行内トークン装飾
    const lineText = line.text
    const base = line.from

    // 全statement共通: 矢印
    for (const [f, t] of findMatches(rightArrowRe, lineText, base)) {
      builder.push({ from: f, to: t, deco: markDeco.arrow })
    }
    for (const [f, t] of findMatches(leftArrowRe, lineText, base)) {
      builder.push({ from: f, to: t, deco: markDeco.arrow })
    }

    // 全statement共通: 種族マーカー
    for (const [f, t] of findMatches(humanRe, lineText, base)) {
      builder.push({ from: f, to: t, deco: markDeco.human })
    }
    for (const [f, t] of findMatches(wolfRe, lineText, base)) {
      builder.push({ from: f, to: t, deco: markDeco.wolf })
    }

    // assert: CO キーワード + 役職名
    if (stmt.type === 'assert') {
      for (const [f, t] of findMatches(coRe, lineText, base)) {
        builder.push({ from: f, to: t, deco: markDeco.co })
      }
      for (const [f, t] of findMatches(roleRe, lineText, base)) {
        builder.push({ from: f, to: t, deco: markDeco.role })
      }
    }

    // reveal: 役職名
    if (stmt.type === 'reveal') {
      for (const [f, t] of findMatches(roleRe, lineText, base)) {
        builder.push({ from: f, to: t, deco: markDeco.role })
      }
    }

    // unknown: 行全体にツールチップ付きマーク
    if (stmt.type === 'unknown' && line.to > line.from) {
      builder.push({ from: line.from, to: line.to, deco: markDeco.unknownText })
    }
  }

  // プレイヤー名のマッチ可視化
  for (const pn of playerNames) {
    if (pn.line < 1 || pn.line > doc.lines) continue
    const line = doc.line(pn.line)
    const from = line.from + pn.offset
    const to = from + pn.length
    if (from >= line.from && to <= line.to && to > from) {
      const deco = pn.kind === 'definition' ? markDeco.joinName
                 : pn.kind === 'resolved'   ? markDeco.playerResolved
                 :                            markDeco.playerUnresolved
      builder.push({ from, to, deco })
    }
  }

  // カーソル行以下のグレイアウト
  if (cursorLine > 0 && cursorLine < doc.lines) {
    for (let i = cursorLine + 1; i <= doc.lines; i++) {
      const line = doc.line(i)
      builder.push({ from: line.from, to: line.from, deco: beyondCursorDeco })
    }
  }

  // DecorationSetは位置順でソートされている必要がある
  builder.sort((a, b) => a.from - b.from || a.to - b.to)

  const ranges: any[] = []
  for (const { from, to, deco } of builder) {
    ranges.push(from === to ? deco.range(from) : deco.range(from, to))
  }

  return Decoration.set(ranges, true)
}

// ---- StateField ----

const statementsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setStatements)) {
        return buildDecorations(e.value.statements, e.value.cursorLine, e.value.playerNames, tr.state.doc)
      }
    }
    if (tr.docChanged) {
      // doc変更があったがまだ新しいstatementsが来ていない場合、
      // 既存の装飾位置をテキスト変更に追従させる (次のrun()までの暫定)
      return decos.map(tr.changes)
    }
    return decos
  },
  provide: f => EditorView.decorations.from(f),
})

export const howlLanguageExtension: Extension = statementsField
