// ============================================================================
// Howl Autocomplete — ローマ字入力 + 文脈依存チェーン補完
// ============================================================================
//
// ## 概要
//
// IMEオフのローマ字入力から日本語候補を補完する。補完確定後はスペースを
// 自動挿入し、Howl文法に基づいて次に来るべきトークンの候補を即座に表示する。
//
// ## 補完チェーンの遷移
//
// 行頭          → プレイヤー名, スタンドアロンKW (平和, 再投票, グレラン)
// プレイヤー名   → 矢印(→), CO, アクション (処刑, 襲撃, 道連れ, 後追い, 護衛)
// 矢印(→)       → プレイヤー名
// CO            → 役職名
// 役職名         → プレイヤー名 (結果対象)
// アクション      → (チェーン終了)
//
// ## CompletionSource の2モード
//
// モード1 (入力中): matchBefore で現在の入力を取得し、romaji/labelでフィルタ
// モード2 (スペース直後): 行テキストの文脈から次の候補カテゴリを推定して表示
//
// ============================================================================

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { autocompletion, type CompletionSource, type Completion } from '@codemirror/autocomplete'
import * as V from '../../src/howl/vocabulary.ts'

// ---- カナ→ローマ字変換 ----

const KATA_TO_HIRA_OFFSET = 0x60

function kataToHira(ch: string): string {
  const code = ch.charCodeAt(0)
  if (code >= 0x30A1 && code <= 0x30F6) return String.fromCharCode(code - KATA_TO_HIRA_OFFSET)
  return ch
}

// 拗音マップ (2文字 → ローマ字)
const YOUON: Record<string, string> = {
  'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
  'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
  'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
  'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
  'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
  'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
  'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
  'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
  'じゃ': 'ja',  'じゅ': 'ju',  'じょ': 'jo',
  'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
  'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
  'てぃ': 'thi', 'でぃ': 'dhi',
  'ふぁ': 'fa',  'ふぃ': 'fi',  'ふぇ': 'fe', 'ふぉ': 'fo',
}

// 単音マップ (1文字 → ローマ字)
const KANA: Record<string, string> = {
  'あ': 'a',  'い': 'i',  'う': 'u',  'え': 'e',  'お': 'o',
  'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
  'さ': 'sa', 'し': 'shi','す': 'su', 'せ': 'se', 'そ': 'so',
  'た': 'ta', 'ち': 'chi','つ': 'tsu','て': 'te', 'と': 'to',
  'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
  'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
  'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
  'や': 'ya',             'ゆ': 'yu',             'よ': 'yo',
  'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
  'わ': 'wa', 'ゐ': 'wi',             'ゑ': 'we', 'を': 'wo',
  'ん': 'n',
  'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
  'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
  'だ': 'da', 'ぢ': 'di', 'づ': 'du', 'で': 'de', 'ど': 'do',
  'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
  'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
  'ぁ': 'a',  'ぃ': 'i',  'ぅ': 'u',  'ぇ': 'e',  'ぉ': 'o',
  'ゃ': 'ya',             'ゅ': 'yu',             'ょ': 'yo',
  'ー': '-',
}

/** カナ文字列をローマ字に変換。漢字等の非カナ文字はスキップ */
export function kanaToRomaji(text: string): string {
  let result = ''
  let i = 0
  while (i < text.length) {
    const ch = kataToHira(text[i])

    // 促音 (っ): 次の子音を重ねる
    if (ch === 'っ') {
      const next = i + 1 < text.length ? kataToHira(text[i + 1]) : ''
      if (i + 2 < text.length) {
        const youon = next + kataToHira(text[i + 2])
        if (YOUON[youon]) {
          result += YOUON[youon][0]
          i++
          continue
        }
      }
      const nextRomaji = KANA[next]
      if (nextRomaji && nextRomaji.length > 0) {
        result += nextRomaji[0]
      }
      i++
      continue
    }

    // 拗音チェック (2文字)
    if (i + 1 < text.length) {
      const pair = ch + kataToHira(text[i + 1])
      if (YOUON[pair]) {
        result += YOUON[pair]
        i += 2
        continue
      }
    }

    // 単音
    const romaji = KANA[ch]
    if (romaji) {
      result += romaji
      i++
      continue
    }

    // ASCII文字はそのまま通す
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      result += text[i].toLowerCase()
      i++
      continue
    }

    // 漢字等の変換不能文字はスキップ
    i++
  }
  return result
}

// ---- プレイヤー名リストの管理 ----

export type PlayerEntry = {
  name: string          // メイン名 (補完時に挿入される)
  shortName?: string    // 短縮名 (あれば優先して挿入)
  aliases: string[]     // エイリアス (検索用のみ)
}

export const setPlayerList = StateEffect.define<PlayerEntry[]>()

const playerListField = StateField.define<PlayerEntry[]>({
  create() { return [] },
  update(list, tr) {
    for (const e of tr.effects) {
      if (e.is(setPlayerList)) return e.value
    }
    return list
  },
})

// ---- 候補型と文脈型 ----

type Category = 'player' | 'role' | 'action' | 'arrow' | 'co' | 'standalone'

type HowlCandidate = {
  label: string
  romaji: string
  type: string
  category: Category
  categoryLabel: string
  terminal: boolean  // true = チェーン終了 (スペース挿入しない)
}

// ---- 静的候補 ----

const roleCandidates: HowlCandidate[] = [
  { label: '占い師', romaji: 'uranaishi', type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '霊媒師', romaji: 'reibaishi', type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '狩人',   romaji: 'kariudo',   type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '共有者', romaji: 'kyouyuusha', type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '猫又',   romaji: 'nekomata',  type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '人狼',   romaji: 'jinrou',    type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '狂人',   romaji: 'kyoujin',   type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '狂信者', romaji: 'kyoushinsha', type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '妖狐',   romaji: 'youko',     type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '背徳者', romaji: 'haitokusha', type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
  { label: '村人',   romaji: 'murabito',  type: 'type', category: 'role', categoryLabel: '役職', terminal: false },
]

const actionCandidates: HowlCandidate[] = [
  { label: 'CO',     romaji: 'co',        type: 'keyword', category: 'co',     categoryLabel: 'CO',       terminal: false },
  { label: '処刑',   romaji: 'shokei',    type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '襲撃',   romaji: 'shuugeki',  type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '護衛',   romaji: 'goei',      type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '道連れ', romaji: 'michizure',  type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '後追い', romaji: 'atooi',     type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
]

const standaloneCandidates: HowlCandidate[] = [
  { label: '平和',   romaji: 'heiwa',     type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true },
  { label: '再投票', romaji: 'saitouhyou', type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true },
  { label: 'グレラン', romaji: 'gureran',  type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true },
]

const arrowCandidates: HowlCandidate[] = [
  { label: '→', romaji: '->', type: 'keyword', category: 'arrow', categoryLabel: '矢印', terminal: false },
]

const allStaticCandidates = [...roleCandidates, ...actionCandidates, ...standaloneCandidates, ...arrowCandidates]

// ---- ラベルセットを事前計算 (文脈推定用) ----

const arrowRe = new RegExp(`^(?:${V.rightArrow}|${V.leftArrow})$`)
const roleLabels = new Set(roleCandidates.map(c => c.label))
const actionLabels = new Set(actionCandidates.map(c => c.label))
const coLabels = new Set(['CO', 'co', 'Co', 'cO', 'ｃｏ', 'ＣＯ', 'ｃＯ', 'Ｃｏ'])

// ---- 文脈推定 ----

/**
 * カーソル前の行テキストから、次に来るべき候補カテゴリを推定する。
 * null を返した場合、チェーン補完は起動しない。
 */
function inferContext(beforeCursor: string, players: PlayerEntry[]): Category[] | null {
  const trimmed = beforeCursor.trimEnd()
  if (trimmed === '') {
    // 行頭: プレイヤー名 + スタンドアロンKW
    return ['player', 'standalone']
  }

  // 末尾トークンを取得 (最後のスペース/区切り文字以降)
  const lastTokenMatch = trimmed.match(/[^\s,;:、，；：]+$/)
  if (!lastTokenMatch) return ['player', 'standalone']
  const lastToken = lastTokenMatch[0]

  // アクション → チェーン終了
  if (actionLabels.has(lastToken)) return null

  // 矢印 → プレイヤー名
  if (arrowRe.test(lastToken)) return ['player']

  // CO → 役職名
  if (coLabels.has(lastToken)) return ['role']

  // 役職名 → プレイヤー名 (結果対象)
  if (roleLabels.has(lastToken)) return ['player']

  // プレイヤー名 (メイン名・短縮名・エイリアスすべてで判定) → 矢印, CO, 役職名, アクション
  if (players.some(p => p.name === lastToken || p.shortName === lastToken || p.aliases.includes(lastToken)))
    return ['arrow', 'co', 'role', 'action']

  // 不明なトークン → フィルタなし (全候補)
  return null
}

// ---- 候補の構築 ----

function buildPlayerCandidates(players: PlayerEntry[]): HowlCandidate[] {
  return players.map(p => {
    const displayName = p.shortName || p.name
    // 全名前 (メイン + 短縮名 + エイリアス) のローマ字を結合して検索キーにする
    const allNames = [p.name, ...(p.shortName ? [p.shortName] : []), ...p.aliases]
    const allRomaji = allNames.map(n => kanaToRomaji(n))
    return {
      label: displayName,
      romaji: allRomaji.join('\0'), // \0 区切りで複数ローマ字を保持
      type: 'variable',
      category: 'player' as Category,
      categoryLabel: 'プレイヤー',
      terminal: false,
    }
  })
}

function candidatesToCompletions(candidates: HowlCandidate[]): Completion[] {
  return candidates.map(c => ({
    label: c.label,
    apply: c.terminal ? c.label : c.label + ' ',
    detail: c.categoryLabel,
    type: c.type,
  }))
}

function filterByCategories(candidates: HowlCandidate[], categories: Category[]): HowlCandidate[] {
  return candidates.filter(c => categories.includes(c.category))
}

// ---- 補完ソース ----

const isAscii = /^[a-zA-Z0-9_\-]+$/

const howlCompletionSource: CompletionSource = (context) => {
  const players = context.state.field(playerListField)
  const playerCandidates = buildPlayerCandidates(players)
  const allCandidates = [...playerCandidates, ...allStaticCandidates]

  const word = context.matchBefore(/[^\s,;:、，；：]+/)

  if (!word) {
    // モード2: スペース直後 — チェーン補完
    const line = context.state.doc.lineAt(context.pos)
    const beforeCursor = line.text.slice(0, context.pos - line.from)

    // スペースまたは行頭でなければ補完しない
    if (beforeCursor.length > 0 && !beforeCursor.endsWith(' ')) return null

    const categories = inferContext(beforeCursor, players)
    if (!categories) return null

    const filtered = filterByCategories(allCandidates, categories)
    if (filtered.length === 0) return null

    return {
      from: context.pos,
      options: candidatesToCompletions(filtered),
      filter: false,
    }
  }

  // モード1: 入力中 — ローマ字/日本語フィルタ + 文脈フィルタ
  if (word.to - word.from < 1) return null

  const input = context.state.sliceDoc(word.from, word.to)
  const useRomaji = isAscii.test(input)
  const inputLower = input.toLowerCase()

  // 入力中の単語より前のテキストで文脈を推定
  const line = context.state.doc.lineAt(word.from)
  const beforeWord = line.text.slice(0, word.from - line.from)
  const categories = inferContext(beforeWord, players)

  // 文脈フィルタ適用
  let candidates = allCandidates
  if (categories) {
    candidates = filterByCategories(allCandidates, categories)
  }

  // テキストマッチフィルタ
  const filtered: Completion[] = []
  for (const c of candidates) {
    const match = useRomaji
      ? c.romaji.split('\0').some(r => r.startsWith(inputLower))
      : c.label.startsWith(input)
    if (match) {
      filtered.push({
        label: c.label,
        apply: c.terminal ? c.label : c.label + ' ',
        detail: c.categoryLabel,
        type: c.type,
      })
    }
  }

  if (filtered.length === 0) return null

  return {
    from: word.from,
    options: filtered,
    filter: false,
  }
}

// ---- Extension ----

export const howlCompletionExtension: Extension = [
  playerListField,
  autocompletion({
    override: [howlCompletionSource],
    activateOnTyping: true,
    activateOnCompletion: () => true,
  }),
]
