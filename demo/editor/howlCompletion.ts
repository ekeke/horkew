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
  'じゃ': ['ja', 'zya', 'jya'], 'じゅ': ['ju', 'zyu', 'jyu'], 'じょ': ['jo', 'zyo', 'jyo'],
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
  surviving: boolean    // 生存中かどうか
  claimingRole?: string // CO済み役職 (VillageStatusから)
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

// ---- 現在日数の管理 ----

export const setCurrentDay = StateEffect.define<number>()

const currentDayField = StateField.define<number>({
  create() { return 1 },
  update(day, tr) {
    for (const e of tr.effects) {
      if (e.is(setCurrentDay)) return e.value
    }
    return day
  },
})

// ---- 候補型と文脈型 ----

type Category = 'player' | 'player_start' | 'role' | 'action' | 'arrow' | 'co_role' | 'denial_co_role' | 'standalone' | 'result' | 'gameresult' | 'day'

type HowlCandidateDef = {
  label: string
  reading: string | string[] // カナ読み (kanaToRomajiで自動変換)。配列で別名も指定可
  type: string
  category: Category
  categoryLabel: string
  terminal: boolean
  requiredRole?: SystemRole
  info?: string
}

type HowlCandidate = HowlCandidateDef & {
  romaji: string             // reading から自動生成
}

function buildStaticCandidates(defs: HowlCandidateDef[]): HowlCandidate[] {
  return defs.map(d => {
    const readings = Array.isArray(d.reading) ? d.reading : [d.reading]
    const romaji = readings.map(r => kanaToRomaji(r)).join('\0')
    return { ...d, romaji }
  })
}

// ---- 静的候補 ----

const roleCandidates = buildStaticCandidates([
  { label: '占い師', reading: 'うらないし', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'seer' },
  { label: '霊媒師', reading: 'れいばいし', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'medium' },
  { label: '狩人',   reading: 'かりうど',   type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'bodyguard' },
  { label: '共有者', reading: 'きょうゆうしゃ', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'mason' },
  { label: '猫又',   reading: 'ねこまた',  type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'nekomata' },
  { label: '人狼',   reading: 'じんろう',    type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'werewolf' },
  { label: '狂人',   reading: 'きょうじん',   type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'possessed' },
  { label: '狂信者', reading: 'きょうしんしゃ', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'fanatic' },
  { label: '妖狐',   reading: 'ようこ',     type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'werehamster' },
  { label: '背徳者', reading: 'はいとくしゃ', type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'immoralist' },
  { label: '村人',   reading: 'むらびと',  type: 'type', category: 'role', categoryLabel: '役職', terminal: false, requiredRole: 'villager' },
])

// 役職名CO 結合候補 (プレイヤー名の後に直接補完)
// Howl文法: `占い師CO` (役職名が先、COが後)
const coRoleCandidates: HowlCandidate[] = roleCandidates.flatMap(r => [
  {
    label: `${r.label}CO`,
    reading: `${r.reading}co`,
    romaji: kanaToRomaji(`${r.reading}co`),
    type: 'keyword',
    category: 'co_role' as Category,
    categoryLabel: 'CO',
    terminal: false,
    requiredRole: r.requiredRole,
    info: `${r.label}を名乗り出る`,
  },
  {
    label: `非${r.label}CO`,
    reading: `ひ${r.reading}co`,
    romaji: kanaToRomaji(`ひ${r.reading}co`),
    type: 'keyword',
    category: 'denial_co_role' as Category,
    categoryLabel: '非CO',
    terminal: true,
    requiredRole: r.requiredRole,
    info: `${r.label}ではないと宣言`,
  },
])

const actionCandidates = buildStaticCandidates([
  { label: '処刑',   reading: 'しょけい',   type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, info: '投票により処刑された' },
  { label: '吊り',   reading: 'つり',       type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, info: '投票により処刑された' },
  { label: '襲撃',   reading: 'しゅうげき', type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, info: '人狼に襲撃された' },
  { label: '噛み',   reading: 'かみ',       type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, info: '人狼に襲撃された' },
  { label: '死亡',   reading: 'しぼう',     type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, info: '人狼に襲撃された' },
  { label: '護衛',   reading: 'ごえい',     type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, requiredRole: 'bodyguard', info: '狩人が護衛した' },
  { label: 'ガード', reading: 'がーど',     type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, requiredRole: 'bodyguard', info: '狩人が護衛した' },
  { label: '道連れ', reading: 'みちづれ',   type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, requiredRole: 'nekomata', info: '猫又の呪いで道連れ死' },
  { label: '後追い', reading: 'あとおい',   type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, requiredRole: 'immoralist', info: '背徳者が妖狐の死を追って死亡' },
  { label: '予告',   reading: 'よこく',     type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, info: '処刑先を予告する' },
  { label: '共有',   reading: 'きょうゆう', type: 'keyword', category: 'action', categoryLabel: 'アクション', terminal: false, requiredRole: 'mason', info: '共有者のペアを宣言' },
])

// 非 は 非役職名CO 結合候補に統合済み

const resultCandidates = buildStaticCandidates([
  { label: '○',     reading: ['まる', 'しろ', 'にんげん'],           type: 'keyword', category: 'result', categoryLabel: '結果', terminal: false, info: '人間 (白判定)' },
  { label: '●',     reading: ['くろ', 'おおかみ', 'じんろう'],     type: 'keyword', category: 'result', categoryLabel: '結果', terminal: false, info: '人狼 (黒判定)' },
])

const standaloneCandidates = buildStaticCandidates([
  { label: '平和',   reading: 'へいわ',       type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true, info: '夜の襲撃で死者なし' },
  { label: '再投票', reading: 'さいとうひょう', type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true, info: '投票が割れて再投票になった' },
  { label: 'グレラン', reading: 'ぐれらん',   type: 'keyword', category: 'standalone', categoryLabel: 'アクション', terminal: true, info: 'グレーからランダムに投票' },
])

const gameResultCandidates = buildStaticCandidates([
  { label: '村勝',   reading: 'むらかち',       type: 'keyword', category: 'gameresult', categoryLabel: '結果', terminal: true },
  { label: '狼勝',   reading: 'おおかみかち',   type: 'keyword', category: 'gameresult', categoryLabel: '結果', terminal: true },
  { label: '狐勝',   reading: 'きつねかち',     type: 'keyword', category: 'gameresult', categoryLabel: '結果', terminal: true, requiredRole: 'werehamster' },
  { label: '引き分け', reading: 'ひきわけ',     type: 'keyword', category: 'gameresult', categoryLabel: '結果', terminal: true },
])

const specialNameCandidates = buildStaticCandidates([
  { label: '生存者', reading: 'せいぞんしゃ', type: 'variable', category: 'player_start', categoryLabel: 'プレイヤー', terminal: false },
])

const arrowCandidates = buildStaticCandidates([
  { label: '→', reading: ['->', 'とうひょう'], type: 'keyword', category: 'arrow', categoryLabel: '矢印', terminal: false, info: '投票先を指す' },
  { label: '←', reading: ['<-', 'とくひょう'], type: 'keyword', category: 'arrow', categoryLabel: '矢印', terminal: false, info: '得票者をまとめて記述' },
])

const allStaticCandidates = [
  ...roleCandidates, ...coRoleCandidates, ...actionCandidates,
  ...resultCandidates, ...standaloneCandidates, ...gameResultCandidates,
  ...specialNameCandidates, ...arrowCandidates,
]

// ---- ラベルセットを事前計算 (文脈推定用) ----

const dayTokenRe = /^[1-9１-９][0-9０-９]*(?:日目?|[dDｄＤ](?:[aAａＡ][yYｙＹ])?)$/
const arrowRe = new RegExp(`^(?:${V.rightArrow}|${V.leftArrow})$`)
const rightArrowRe = new RegExp(`^${V.rightArrow}$`)
const leftArrowRe = new RegExp(`(?:${V.leftArrow})`)
const actionLabels = new Set(actionCandidates.filter(c => c.category === 'action').map(c => c.label))
const resultLabels = new Set(resultCandidates.map(c => c.label))
const coRoleLabels = new Set(coRoleCandidates.map(c => c.label))

/** CO宣言キーワード (占い師CO等、非COを除く) */
const coKeywordLabels = new Set(coRoleCandidates.filter(c => c.category === 'co_role').map(c => c.label))

/** 行内にCOキーワード(占い師CO等)があるか — CO宣言行でのみ複数結果チェーンを許可 */
function hasCoKeyword(lineText: string): boolean {
  for (const label of coKeywordLabels) {
    if (lineText.includes(label)) return true
  }
  return false
}

// ---- CO種別検出 ----

type CoType = 'seer' | 'medium' | 'bodyguard' | 'mason' | 'other'

const claimingRoleToCoType: Record<string, CoType> = {
  seer: 'seer', medium: 'medium', bodyguard: 'bodyguard', mason: 'mason',
}

/**
 * 行の先頭プレイヤーのCO種別を判定する。
 * まずVillageStatusのCO情報を参照し、未登録なら行テキストのCOキーワードで判定する。
 */
function detectCoType(lineText: string, players: PlayerEntry[]): CoType {
  // VillageStatus: 行頭のプレイヤー名からCO種別を取得
  const firstToken = lineText.match(/^(\S+)/)?.[1]
  if (firstToken) {
    const player = players.find(p => p.name === firstToken || p.shortName === firstToken)
    if (player?.claimingRole) {
      return claimingRoleToCoType[player.claimingRole] ?? 'other'
    }
  }

  // フォールバック: 行テキストのCOキーワードで判定 (CO宣言行)
  if (lineText.includes('占い師CO')) return 'seer'
  if (lineText.includes('霊媒師CO') || lineText.includes('霊媒CO')) return 'medium'
  if (lineText.includes('狩人CO')) return 'bodyguard'
  if (lineText.includes('共有者CO') || lineText.includes('共有CO')) return 'mason'
  return 'other'
}

// ---- 文脈推定 ----

/**
 * カーソル前の行テキストから、次に来るべき候補カテゴリを推定する。
 * null を返した場合、チェーン補完は起動しない。
 */
function inferContext(beforeCursor: string, players: PlayerEntry[]): Category[] | null {
  const trimmed = beforeCursor.trimEnd()
  if (trimmed === '') {
    // 行頭: プレイヤー名 + 行頭専用名 + アクション(転置記法) + スタンドアロンKW + 試合結果
    return ['player', 'player_start', 'action', 'standalone', 'gameresult']
  }

  // 末尾トークンを取得 (最後のスペース/区切り文字以降)
  const lastTokenMatch = trimmed.match(/[^\s,;:、，；：]+$/)
  if (!lastTokenMatch) return ['player', 'player_start', 'action', 'standalone', 'gameresult']
  const lastToken = lastTokenMatch[0]

  // アクション: 行頭なら転置記法 → プレイヤー名、プレイヤー名の後なら → チェーン終了
  if (actionLabels.has(lastToken)) {
    const beforeAction = trimmed.slice(0, trimmed.length - lastToken.length).trimEnd()
    if (beforeAction === '') return ['player'] // 転置記法: アクション → プレイヤー名
    return null // 通常記法: プレイヤー名 アクション → 終了
  }

  // 日付トークン (1日目, 2d, etc.) → CO種別に応じた候補
  if (dayTokenRe.test(lastToken)) {
    const coType = detectCoType(trimmed, players)
    if (coType === 'medium') return ['result']
    if (coType === 'seer' || coType === 'bodyguard') return ['player']
    return null
  }

  // 結果マーカー (○/●) → CO種別に応じた候補 (次のエントリは日付から始められる)
  if (resultLabels.has(lastToken)) {
    if (!hasCoKeyword(trimmed)) return null // 結果報告行: 1結果で終了
    const coType = detectCoType(trimmed, players)
    if (coType === 'medium') return ['day', 'result']
    return ['day', 'player']
  }

  // 矢印 → プレイヤー名
  if (arrowRe.test(lastToken)) return ['player']

  // 役職名CO / 非役職名CO → CO種別に応じた候補
  if (coRoleLabels.has(lastToken)) {
    const coType = detectCoType(trimmed, players)
    if (coType === 'medium') return ['day', 'result']
    return ['day', 'player']
  }

  // プレイヤー名の判定
  const isPlayer = players.some(p => p.name === lastToken || p.shortName === lastToken || p.aliases.includes(lastToken))
    || lastToken === '生存者'
  if (isPlayer) {
    const beforeLastToken = trimmed.slice(0, trimmed.length - lastToken.length).trimEnd()

    const lastBeforeMatch = beforeLastToken.match(/[^\s,;:、，；：]+$/)

    // →の後のプレイヤー名 → 投票文完成、チェーン終了
    if (lastBeforeMatch && rightArrowRe.test(lastBeforeMatch[0])) return null

    // ←の後のプレイヤー名 → 得票記法、さらにプレイヤー名を追加可能
    if (lastBeforeMatch && leftArrowRe.test(lastBeforeMatch[0])) return ['player']

    // ←を含む行でプレイヤー名が連続 → さらにプレイヤー名を追加可能
    if (leftArrowRe.test(beforeLastToken)) return ['player']

    // 共有行: プレイヤー名を連続で追加可能
    if (lastBeforeMatch && lastBeforeMatch[0] === '共有') return ['player']
    if (/^共有\s/.test(trimmed)) return ['player']

    // アクションの後のプレイヤー名 → 転置記法完成、チェーン終了
    if (lastBeforeMatch && actionLabels.has(lastBeforeMatch[0])) return null

    // CO文中のプレイヤー名 (2トークン目以降) → CO種別に応じた候補
    if (beforeLastToken !== '') {
      const coType = detectCoType(trimmed, players)
      if (coType !== 'other') {
        if (coType === 'mason') return ['player']
        if (coType === 'bodyguard') {
          if (!hasCoKeyword(trimmed)) return null // 結果報告行: 1護衛先で終了
          return ['day', 'player']
        }
        if (coType === 'medium') return ['day', 'result']
        return ['result'] // seer: プレイヤー名の直後は結果 (日付はプレイヤーの前)
      }
    }

    // 行頭のプレイヤー名 → CO済みなら役職に応じた候補を優先
    if (beforeLastToken === '') {
      const firstPlayer = players.find(p => p.name === lastToken || p.shortName === lastToken)
      const firstCoType = firstPlayer?.claimingRole ? claimingRoleToCoType[firstPlayer.claimingRole] : undefined
      if (firstCoType === 'seer') return ['day', 'player', 'arrow', 'co_role', 'denial_co_role', 'action', 'result']
      if (firstCoType === 'medium') return ['day', 'result', 'arrow', 'co_role', 'denial_co_role', 'action']
      if (firstCoType === 'bodyguard') return ['day', 'player', 'arrow', 'co_role', 'denial_co_role', 'action']
      if (firstCoType === 'mason') return ['player', 'arrow', 'co_role', 'denial_co_role', 'action']
    }
    return ['arrow', 'co_role', 'denial_co_role', 'action', 'result']
  }

  // 不明なトークン → フィルタなし (全候補)
  return null
}

// ---- 候補の構築 ----

/** 日付候補を動的に生成 (1日目〜currentDay日目) */
function buildDayCandidates(currentDay: number): HowlCandidate[] {
  const candidates: HowlCandidate[] = []
  for (let d = 1; d <= currentDay; d++) {
    candidates.push({
      label: `${d}日目`,
      reading: `${d}`,
      romaji: [`${d}`, `d${d}`, `${d}d`].join('\0'),
      type: 'keyword',
      category: 'day',
      categoryLabel: '日付',
      terminal: false,
      info: `${d}日目の結果`,
    })
  }
  return candidates
}

function buildPlayerCandidates(players: PlayerEntry[]): HowlCandidate[] {
  return players.map(p => {
    const displayName = p.shortName || p.name
    // 全名前 (メイン + 短縮名 + エイリアス) のローマ字を結合して検索キーにする
    const allNames = [p.name, ...(p.shortName ? [p.shortName] : []), ...p.aliases]
    const allRomaji = allNames.map(n => kanaToRomaji(n))
    return {
      label: displayName,
      reading: displayName,
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
    info: c.info,
  }))
}

function filterByCategories(candidates: HowlCandidate[], categories: Category[]): HowlCandidate[] {
  return candidates.filter(c => categories.includes(c.category))
}

/** ←行から除外すべき名前 (被投票者 + 既出投票者 + 死亡者) を返す */
function getLeftArrowExclusions(lineText: string, players: PlayerEntry[]): Set<string> {
  const excluded = new Set<string>()

  // 死亡者を除外
  for (const p of players) {
    if (!p.surviving) excluded.add(p.shortName || p.name)
  }

  // ← で分割
  const arrowMatch = lineText.match(new RegExp(V.leftArrow))
  if (!arrowMatch || arrowMatch.index === undefined) return excluded

  // ← より前: 被投票者
  const beforeArrow = lineText.slice(0, arrowMatch.index).trim()
  const target = beforeArrow.match(/[^\s,;:、，；：]+$/)
  if (target) excluded.add(target[0])

  // ← より後: 既出投票者
  const afterArrow = lineText.slice(arrowMatch.index + arrowMatch[0].length)
  const voterRe = /[^\s,;:、，；：]+/g
  let m
  while ((m = voterRe.exec(afterArrow)) !== null) {
    excluded.add(m[0])
  }
  return excluded
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
  const currentDay = context.state.field(currentDayField)
  const playerCandidates = buildPlayerCandidates(players)
  const dayCandidates = buildDayCandidates(currentDay)

  // 配役に応じて候補をフィルタ (setupが空の場合は全候補を表示)
  const staticFiltered = setup.size === 0
    ? allStaticCandidates
    : allStaticCandidates.filter(c => !c.requiredRole || (setup.get(c.requiredRole) ?? 0) > 0)
  const allCandidates = [...playerCandidates, ...dayCandidates, ...staticFiltered]

  const word = context.matchBefore(/[^\s,;:、，；：]+/)

  if (!word) {
    // モード2: スペース直後 — チェーン補完
    const line = context.state.doc.lineAt(context.pos)
    const beforeCursor = line.text.slice(0, context.pos - line.from)

    // スペースまたは行頭でなければ補完しない
    if (beforeCursor.length > 0 && !beforeCursor.endsWith(' ')) return null

    const categories = inferContext(beforeCursor, players)
    if (!categories) return null

    let filtered = filterByCategories(allCandidates, categories)

    // ←行: 被投票者と既出投票者を除外
    if (leftArrowRe.test(beforeCursor)) {
      const excluded = getLeftArrowExclusions(line.text, players)
      if (excluded.size > 0) {
        filtered = filtered.filter(c => !excluded.has(c.label))
      }
    }

    if (filtered.length === 0) return null

    const options = candidatesToCompletions(filtered)

    // ←の直後 (投票者がまだいない): 省略TIPS候補を先頭に追加
    const lastTokenMatch = beforeCursor.trimEnd().match(/[^\s,;:、，；：]+$/)
    if (lastTokenMatch && leftArrowRe.test(lastTokenMatch[0])) {
      options.unshift({
        label: '(省略 → 改行)',
        apply: '\n',
        detail: 'TIPS',
        type: 'text',
        info: '省略も出来ます（文脈に応じて全員、または被投票ゼロになります）',
        boost: 99,
      })
    }

    return {
      from: context.pos,
      options,
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

  // 文脈フィルタ適用 (null = 文完成、補完停止)
  if (!categories) return null
  let candidates = filterByCategories(allCandidates, categories)

  // ←行: 被投票者と既出投票者を除外
  if (leftArrowRe.test(beforeWord)) {
    const excluded = getLeftArrowExclusions(line.text, players)
    if (excluded.size > 0) {
      candidates = candidates.filter(c => !excluded.has(c.label))
    }
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
        info: c.info,
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
  currentDayField,
  autocompletion({
    override: [howlCompletionSource],
    activateOnTyping: true,
    activateOnCompletion: (c) => typeof c.apply === 'string' && c.apply.endsWith(' '),
  }),
]
