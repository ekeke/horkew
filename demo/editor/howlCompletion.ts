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

// ローマ字マップ: [ヘボン式, 訓令式] (同じ場合は1要素)
// 拗音マップ (2文字 → ローマ字)
const YOUON: Record<string, string[]> = {
  'きゃ': ['kya'], 'きゅ': ['kyu'], 'きょ': ['kyo'],
  'しゃ': ['sha', 'sya'], 'しゅ': ['shu', 'syu'], 'しょ': ['sho', 'syo'],
  'ちゃ': ['cha', 'tya'], 'ちゅ': ['chu', 'tyu'], 'ちょ': ['cho', 'tyo'],
  'にゃ': ['nya'], 'にゅ': ['nyu'], 'にょ': ['nyo'],
  'ひゃ': ['hya'], 'ひゅ': ['hyu'], 'ひょ': ['hyo'],
  'みゃ': ['mya'], 'みゅ': ['myu'], 'みょ': ['myo'],
  'りゃ': ['rya'], 'りゅ': ['ryu'], 'りょ': ['ryo'],
  'ぎゃ': ['gya'], 'ぎゅ': ['gyu'], 'ぎょ': ['gyo'],
  'じゃ': ['ja', 'zya'], 'じゅ': ['ju', 'zyu'], 'じょ': ['jo', 'zyo'],
  'びゃ': ['bya'], 'びゅ': ['byu'], 'びょ': ['byo'],
  'ぴゃ': ['pya'], 'ぴゅ': ['pyu'], 'ぴょ': ['pyo'],
  'てぃ': ['thi'], 'でぃ': ['dhi'],
  'ふぁ': ['fa'], 'ふぃ': ['fi'], 'ふぇ': ['fe'], 'ふぉ': ['fo'],
}

// 単音マップ (1文字 → ローマ字)
const KANA: Record<string, string[]> = {
  'あ': ['a'],  'い': ['i'],  'う': ['u'],  'え': ['e'],  'お': ['o'],
  'か': ['ka'], 'き': ['ki'], 'く': ['ku'], 'け': ['ke'], 'こ': ['ko'],
  'さ': ['sa'], 'し': ['shi', 'si'], 'す': ['su'], 'せ': ['se'], 'そ': ['so'],
  'た': ['ta'], 'ち': ['chi', 'ti'], 'つ': ['tsu', 'tu'], 'て': ['te'], 'と': ['to'],
  'な': ['na'], 'に': ['ni'], 'ぬ': ['nu'], 'ね': ['ne'], 'の': ['no'],
  'は': ['ha'], 'ひ': ['hi'], 'ふ': ['fu', 'hu'], 'へ': ['he'], 'ほ': ['ho'],
  'ま': ['ma'], 'み': ['mi'], 'む': ['mu'], 'め': ['me'], 'も': ['mo'],
  'や': ['ya'],               'ゆ': ['yu'],               'よ': ['yo'],
  'ら': ['ra'], 'り': ['ri'], 'る': ['ru'], 'れ': ['re'], 'ろ': ['ro'],
  'わ': ['wa'], 'ゐ': ['wi'],               'ゑ': ['we'], 'を': ['wo'],
  'ん': ['n'],
  'が': ['ga'], 'ぎ': ['gi'], 'ぐ': ['gu'], 'げ': ['ge'], 'ご': ['go'],
  'ざ': ['za'], 'じ': ['ji', 'zi'], 'ず': ['zu'], 'ぜ': ['ze'], 'ぞ': ['zo'],
  'だ': ['da'], 'ぢ': ['di'], 'づ': ['du', 'zu'], 'で': ['de'], 'ど': ['do'],
  'ば': ['ba'], 'び': ['bi'], 'ぶ': ['bu'], 'べ': ['be'], 'ぼ': ['bo'],
  'ぱ': ['pa'], 'ぴ': ['pi'], 'ぷ': ['pu'], 'ぺ': ['pe'], 'ぽ': ['po'],
  'ぁ': ['a'],  'ぃ': ['i'],  'ぅ': ['u'],  'ぇ': ['e'],  'ぉ': ['o'],
  'ゃ': ['ya'],               'ゅ': ['yu'],               'ょ': ['yo'],
  'ー': ['-'],
}

/**
 * カナ文字列をローマ字バリアントに変換。
 * ヘボン式/訓令式の差異がある文字は全組み合わせを生成し、\0 区切りで返す。
 * 漢字等の非カナ文字はスキップ。
 */
export function kanaToRomaji(text: string): string {
  // variants[i] = i番目の位置までの全バリアント
  let variants = ['']
  let i = 0
  while (i < text.length) {
    const ch = kataToHira(text[i])

    // 促音 (っ): 次の子音を重ねる
    if (ch === 'っ') {
      const next = i + 1 < text.length ? kataToHira(text[i + 1]) : ''
      let prefixes: string[]
      // 拗音チェック
      if (i + 2 < text.length) {
        const youon = next + kataToHira(text[i + 2])
        const youonRomaji = YOUON[youon]
        if (youonRomaji) {
          prefixes = youonRomaji.map(r => r[0])
          variants = expand(variants, dedupe(prefixes))
          i++
          continue
        }
      }
      const nextRomaji = KANA[next]
      if (nextRomaji) {
        prefixes = nextRomaji.map(r => r[0])
        variants = expand(variants, dedupe(prefixes))
      }
      i++
      continue
    }

    // 拗音チェック (2文字)
    if (i + 1 < text.length) {
      const pair = ch + kataToHira(text[i + 1])
      const youonRomaji = YOUON[pair]
      if (youonRomaji) {
        variants = expand(variants, youonRomaji)
        i += 2
        continue
      }
    }

    // 単音
    const romaji = KANA[ch]
    if (romaji) {
      variants = expand(variants, romaji)
      i++
      continue
    }

    // ASCII文字はそのまま通す
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      variants = expand(variants, [text[i].toLowerCase()])
      i++
      continue
    }

    // 漢字等の変換不能文字はスキップ
    i++
  }
  return dedupe(variants).join('\0')
}

/** バリアント配列に各サフィックスを追加して展開 */
function expand(variants: string[], suffixes: string[]): string[] {
  if (suffixes.length === 1) {
    // 最適化: 1つだけなら新配列を作らない
    const s = suffixes[0]
    for (let i = 0; i < variants.length; i++) variants[i] += s
    return variants
  }
  const result: string[] = []
  for (const v of variants) {
    for (const s of suffixes) {
      result.push(v + s)
    }
  }
  return result
}

function dedupe(arr: string[]): string[] {
  return arr.length <= 1 ? arr : [...new Set(arr)]
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

// ---- 配役情報の管理 ----

type SystemRole = 'werewolf' | 'possessed' | 'fanatic' | 'werehamster' | 'immoralist' | 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata'

export const setSetup = StateEffect.define<Map<string, number>>()

const setupField = StateField.define<Map<string, number>>({
  create() { return new Map() },
  update(setup, tr) {
    for (const e of tr.effects) {
      if (e.is(setSetup)) return e.value
    }
    return setup
  },
})

// ---- 候補型と文脈型 ----

type Category = 'player' | 'role' | 'action' | 'arrow' | 'co_role' | 'denial_co_role' | 'standalone' | 'result' | 'gameresult'

type HowlCandidate = {
  label: string
  romaji: string
  type: string
  category: Category
  categoryLabel: string
  terminal: boolean  // true = チェーン終了 (スペース挿入しない)
  requiredRole?: SystemRole  // この役職が配役にない場合、候補から除外
}

// ---- 静的候補 ----

const roleCandidates: HowlCandidate[] = [
  { label: '占い師', romaji: 'uranaishi', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'seer' },
  { label: '霊媒師', romaji: 'reibaishi', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'medium' },
  { label: '狩人',   romaji: 'kariudo',   type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'bodyguard' },
  { label: '共有者', romaji: 'kyouyuusha', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'mason' },
  { label: '猫又',   romaji: 'nekomata',  type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'nekomata' },
  { label: '人狼',   romaji: 'jinrou',    type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'werewolf' },
  { label: '狂人',   romaji: 'kyoujin',   type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'possessed' },
  { label: '狂信者', romaji: 'kyoushinsha', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'fanatic' },
  { label: '妖狐',   romaji: 'youko',     type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'werehamster' },
  { label: '背徳者', romaji: 'haitokusha', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'immoralist' },
  { label: '村人',   romaji: 'murabito',  type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'villager' },
]

// 役職名CO 結合候補 (プレイヤー名の後に直接補完)
// Howl文法: `占い師CO` (役職名が先、COが後)
const coRoleCandidates: HowlCandidate[] = roleCandidates.flatMap(r => [
  {
    label: `${r.label}CO`,
    romaji: r.romaji.split('\0').map(rom => `${rom}co`).join('\0'),
    type: 'keyword',
    category: 'co_role' as Category,
    categoryLabel: 'CO',
    terminal: false,
    requiredRole: r.requiredRole,
  },
  {
    label: `非${r.label}CO`,
    romaji: r.romaji.split('\0').map(rom => `hi${rom}co`).join('\0'),
    type: 'keyword',
    category: 'denial_co_role' as Category,
    categoryLabel: '非CO',
    terminal: true,
    requiredRole: r.requiredRole,
  },
])

const actionCandidates: HowlCandidate[] = [
  { label: '処刑',   romaji: 'shokei',    type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '吊り',   romaji: 'tsuri\0turi', type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '襲撃',   romaji: 'shuugeki',  type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '噛み',   romaji: 'kami',      type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '死亡',   romaji: 'sibou\0shibou', type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true },
  { label: '護衛',   romaji: 'goei',      type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true, requiredRole: 'bodyguard' },
  { label: 'ガード', romaji: 'ga-do\0gaado', type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true, requiredRole: 'bodyguard' },
  { label: '道連れ', romaji: 'michizure\0mitizure', type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true, requiredRole: 'nekomata' },
  { label: '後追い', romaji: 'atooi',     type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: true, requiredRole: 'immoralist' },
  { label: '予告',   romaji: 'yokoku',    type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false },
]

// 非 は 非役職名CO 結合候補に統合済み

const resultCandidates: HowlCandidate[] = [
  { label: '○',     romaji: 'maru\0siro\0shiro', type: 'keyword', category: 'result', categoryLabel: '結果', terminal: false },
  { label: '●',     romaji: 'kuro',      type: 'keyword', category: 'result', categoryLabel: '結果', terminal: false },
]

const standaloneCandidates: HowlCandidate[] = [
  { label: '平和',   romaji: 'heiwa',     type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true },
  { label: '再投票', romaji: 'saitouhyou\0saitouhyou', type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true },
  { label: 'グレラン', romaji: 'gureran',  type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true },
]

const gameResultCandidates: HowlCandidate[] = [
  { label: '村勝',   romaji: 'murashou\0murakachi', type: 'keyword', category: 'gameresult', categoryLabel: '結果', terminal: true },
  { label: '狼勝',   romaji: 'ookamishou\0ookamikachi', type: 'keyword', category: 'gameresult', categoryLabel: '結果', terminal: true },
  { label: '狐勝',   romaji: 'kituneshou\0kitunekachi\0kitsunekachi', type: 'keyword', category: 'gameresult', categoryLabel: '結果', terminal: true, requiredRole: 'werehamster' },
  { label: '引き分け', romaji: 'hikiwake',  type: 'keyword', category: 'gameresult', categoryLabel: '結果', terminal: true },
]

const specialNameCandidates: HowlCandidate[] = [
  { label: '生存者', romaji: 'seizonsha\0seizonsya', type: 'variable', category: 'player', categoryLabel: 'プレイヤー', terminal: false },
]

const arrowCandidates: HowlCandidate[] = [
  { label: '→', romaji: '->', type: 'keyword', category: 'arrow', categoryLabel: '矢印', terminal: false },
  { label: '←', romaji: '<-', type: 'keyword', category: 'arrow', categoryLabel: '矢印', terminal: false },
]

const allStaticCandidates = [
  ...roleCandidates, ...coRoleCandidates, ...actionCandidates,
  ...resultCandidates, ...standaloneCandidates, ...gameResultCandidates,
  ...specialNameCandidates, ...arrowCandidates,
]

// ---- ラベルセットを事前計算 (文脈推定用) ----

const arrowRe = new RegExp(`^(?:${V.rightArrow}|${V.leftArrow})$`)
const actionLabels = new Set(actionCandidates.filter(c => c.category === 'action').map(c => c.label))
const resultLabels = new Set(resultCandidates.map(c => c.label))
const coRoleLabels = new Set(coRoleCandidates.map(c => c.label))

// ---- 文脈推定 ----

/**
 * カーソル前の行テキストから、次に来るべき候補カテゴリを推定する。
 * null を返した場合、チェーン補完は起動しない。
 */
function inferContext(beforeCursor: string, players: PlayerEntry[]): Category[] | null {
  const trimmed = beforeCursor.trimEnd()
  if (trimmed === '') {
    // 行頭: プレイヤー名 + スタンドアロンKW + 試合結果
    return ['player', 'standalone', 'gameresult']
  }

  // 末尾トークンを取得 (最後のスペース/区切り文字以降)
  const lastTokenMatch = trimmed.match(/[^\s,;:、，；：]+$/)
  if (!lastTokenMatch) return ['player', 'standalone', 'gameresult']
  const lastToken = lastTokenMatch[0]

  // アクション → チェーン終了
  if (actionLabels.has(lastToken)) return null

  // 結果マーカー (○/●) → プレイヤー名 (次の結果対象)
  if (resultLabels.has(lastToken)) return ['player']

  // 矢印 → プレイヤー名
  if (arrowRe.test(lastToken)) return ['player']

  // 役職名CO / 非役職名CO → プレイヤー名 (結果対象)
  if (coRoleLabels.has(lastToken)) return ['player']

  // プレイヤー名 → 矢印, 役職名CO, 非役職名CO, アクション, 結果
  if (players.some(p => p.name === lastToken || p.shortName === lastToken || p.aliases.includes(lastToken)))
    return ['arrow', 'co_role', 'denial_co_role', 'action', 'result']

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

const setupOrJoinRe = /^(?:[@＠]|\+\+?|#)/

const howlCompletionSource: CompletionSource = (context) => {
  // @行 (setup), +行 (join), ++行 (joinMulti), #行 (コメント) では補完無効
  const curLine = context.state.doc.lineAt(context.pos)
  if (setupOrJoinRe.test(curLine.text)) return null

  const players = context.state.field(playerListField)
  const setup = context.state.field(setupField)
  const playerCandidates = buildPlayerCandidates(players)

  // 配役に応じて候補をフィルタ (setupが空の場合は全候補を表示)
  const staticFiltered = setup.size === 0
    ? allStaticCandidates
    : allStaticCandidates.filter(c => !c.requiredRole || (setup.get(c.requiredRole) ?? 0) > 0)
  const allCandidates = [...playerCandidates, ...staticFiltered]

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
  setupField,
  autocompletion({
    override: [howlCompletionSource],
    activateOnTyping: true,
    activateOnCompletion: () => true,
  }),
]
