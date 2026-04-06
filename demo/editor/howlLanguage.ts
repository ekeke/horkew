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
// 3. run()内でparse(input) → buildVillageStatus() → dict取得
// 4. App.svelteが以下を構築し、HighlightPayloadとしてsetStatements Effectで送信:
//    - StatementInfo[]: statement type + line (パーサー出力から)
//    - PlayerNameInfo[]: プレイヤー名の位置・解決状態 (dict + 行テキスト検索から)
//    - cursorLine: 現在のカーソル行番号
// 5. buildDecorations()がHighlightPayload + docからDecorationSetを構築
// 6. CM6が装飾を描画
//
// ## 装飾レイヤー構造
//
// ### Layer 0: パーサー前処理で除去される行
//   Howlパーサーのpreprocess段階で除去される行はstatementsに含まれない。
//   doc全体を走査して直接検出する:
//
//   - frontmatter行 (--- で囲まれたYAML) → hw-meta マーク
//   - コメント行 (# で始まる行)          → hw-comment マーク
//   - 空行                               → 装飾なし
//
// ### Layer 1: 行レベル装飾 (Decoration.line)
//   パーサーが返すstatement.typeに基づいて行全体にCSSクラスを付与。
//   重要行には背景色と::beforeアイコンが適用される。
//
//   StatementType → CSSクラス (背景色 / ::beforeアイコン):
//     join, joinMulti  → hwl-join    (青背景 / +)
//     vote, multiVote  → hwl-vote    (装飾なし)
//     attack           → hwl-attack  (赤背景 / 🐺)
//     lynch            → hwl-lynch   (peach背景 / ⚔)
//     curse            → hwl-curse   (紫背景 / 💀)
//     follow           → hwl-follow  (グレー背景)
//     peace            → hwl-peace   (緑背景 / ☮)
//     revote           → hwl-revote  (装飾なし)
//     over             → hwl-over    (装飾なし)
//     assert, mason    → hwl-assert  (装飾なし)
//     reveal           → hwl-reveal  (装飾なし)
//     unknown          → hwl-unknown (赤背景 + 赤波線下線)
//
// ### Layer 2: 行内トークン装飾 (Decoration.mark)
//   vocabulary.tsからインポートした正規表現で、行内の特定トークンにCSSクラスを付与。
//
//   全statement共通:
//     rightArrow, leftArrow  → hw-arrow  (青 / →, =>, <-, ← 等)
//     isHuman                → hw-human  (緑 / 白, ○ 等)
//     isWolf                 → hw-wolf   (赤 / 黒, ● 等)
//
//   assertのみ:
//     claim (CO)             → hw-co     (紫 / CO キーワード)
//     anyRole                → hw-role   (黄 / 占い, 霊媒, 狩人 等)
//     ※ プレイヤー名領域と重なるマッチは除外
//
//   revealのみ:
//     anyRole                → hw-role   (黄 / 役職名)
//     ※ プレイヤー名領域と重なるマッチは除外
//
//   unknownのみ:
//     行全体                 → hwl-unknown-text  (ツールチップ: 「この行はHowl記法として認識できません」)
//
// ### Layer 3: プレイヤー名装飾 (Decoration.mark)
//   App.svelteがFlexibleDictionaryで解決したプレイヤー名の位置情報(PlayerNameInfo[])
//   に基づき、名前にマークを付与する。kind別に3種類:
//
//   definition  → hw-join-name         (青太字 / JOIN行での名前定義)
//   resolved    → hw-player-resolved   (teal文字 + teal背景 / 辞書にマッチした参照)
//   unresolved  → hw-player-unresolved (赤波線 + ツールチップ / 未登録名)
//
// ### Layer 4: カーソル行以下のグレイアウト (Decoration.line)
//   cursorLine以降の行にhw-beyond-cursorクラスを付与し、opacity: 0.35で半透明化。
//   statusパネルはカーソル行までの解析結果を反映するため、
//   「この範囲はstatusに反映されていない」ことを視覚的に明示する。
//
// ## StateField の更新戦略
//
//   - setStatements Effect受信時: buildDecorations()で全装飾を再構築
//   - doc変更のみ(Effect無し): 既存装飾をchanges.mapで位置調整
//     (次のrun()で新しいstatementsが来るまでの暫定措置)
//   - それ以外: 装飾を維持
//
// ============================================================================

import { StateEffect, StateField, RangeSet, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from '@codemirror/view'
import type { StatementType } from '../../src/howl/statement.ts'
import * as V from '../../src/howl/vocabulary.ts'

// ---- Public API ----

export type StatementInfo = { type: StatementType, line: number, timestamp?: { seconds: number, raw: string } }

export type PlayerNameInfo = {
  line: number
  offset: number
  length: number
  kind: 'resolved' | 'unresolved' | 'definition'
}

export type HighlightPayload = {
  statements: StatementInfo[]
  allStatements: StatementInfo[]
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

// ---- Gutter markers (timestamp seek buttons) ----

let onSeek: ((seconds: number, line: number) => void) | undefined

export function setOnSeek(fn: (seconds: number, line: number) => void) {
  onSeek = fn
}

class SeekGutterMarker extends GutterMarker {
  constructor(readonly seconds: number, readonly line: number) { super() }
  toDOM() {
    const btn = document.createElement('button')
    btn.textContent = '▶'
    btn.className = 'hwg-seek'
    btn.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onSeek?.(Math.max(0, this.seconds - 3), this.line)
    })
    return btn
  }
}

// ガターマーカーのRangeSetを構築（タイムスタンプ行のみ）
function buildGutterMarkers(
  statements: StatementInfo[],
  doc: { line(n: number): { from: number }, lines: number },
): RangeSet<GutterMarker> {
  const markers: { from: number, marker: GutterMarker }[] = []
  for (const s of statements) {
    if (!s.timestamp || s.line < 1 || s.line > doc.lines) continue
    markers.push({ from: doc.line(s.line).from, marker: new SeekGutterMarker(s.timestamp.seconds, s.line) })
  }
  markers.sort((a, b) => a.from - b.from)
  return RangeSet.of(markers.map(m => m.marker.range(m.from)))
}

const gutterField = StateField.define<RangeSet<GutterMarker>>({
  create() { return RangeSet.empty },
  update(markers, tr) {
    for (const e of tr.effects) {
      if (e.is(setStatements)) {
        return buildGutterMarkers(e.value.allStatements, tr.state.doc)
      }
    }
    if (tr.docChanged) {
      return markers.map(tr.changes)
    }
    return markers
  },
})

const statementGutter = gutter({
  class: 'hwl-gutter',
  markers: v => v.state.field(gutterField),
})

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

  // プレイヤー名の絶対位置範囲を行番号でインデックス化 (Layer 2で役職名マッチの除外に使用)
  const playerNameRanges = new Map<number, [number, number][]>()
  for (const pn of playerNames) {
    if (pn.line < 1 || pn.line > doc.lines) continue
    const line = doc.line(pn.line)
    const from = line.from + pn.offset
    const to = from + pn.length
    if (from >= line.from && to <= line.to && to > from) {
      let ranges = playerNameRanges.get(pn.line)
      if (!ranges) {
        ranges = []
        playerNameRanges.set(pn.line, ranges)
      }
      ranges.push([from, to])
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

    // assert: CO キーワード + 役職名 (プレイヤー名と重なる範囲は除外)
    if (stmt.type === 'assert') {
      for (const [f, t] of findMatches(coRe, lineText, base)) {
        builder.push({ from: f, to: t, deco: markDeco.co })
      }
      const nameRanges = playerNameRanges.get(stmt.line)
      for (const [f, t] of findMatches(roleRe, lineText, base)) {
        if (nameRanges && nameRanges.some(([nf, nt]) => f < nt && t > nf)) continue
        builder.push({ from: f, to: t, deco: markDeco.role })
      }
    }

    // reveal: 役職名 (プレイヤー名と重なる範囲は除外)
    if (stmt.type === 'reveal') {
      const nameRanges = playerNameRanges.get(stmt.line)
      for (const [f, t] of findMatches(roleRe, lineText, base)) {
        if (nameRanges && nameRanges.some(([nf, nt]) => f < nt && t > nf)) continue
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

export const howlLanguageExtension: Extension = [statementsField, gutterField, statementGutter]
