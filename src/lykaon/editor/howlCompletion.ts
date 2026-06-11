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

import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { autocompletion, startCompletion, completionStatus, acceptCompletion, type CompletionSource, type Completion } from '@codemirror/autocomplete'
import { insertNewlineAndIndent } from '@codemirror/commands'
import * as V from '../../howl/vocabulary.ts'

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

// ---- ゲーム進行統計 (CO report 数の上限算出用) ----

export type SeerFirstSeek = 'none' | 'no-wolf' | 'all'
export type FirstVictim = 'none' | 'villager-only' | 'random'

export type GameStats = {
  day: number
  executions: number
  // role.seer.first-seek 規定 (デフォルト 'all'). 'none' のときは初夜の seer 行動が無効。
  seerFirstSeek: SeerFirstSeek
  // general.first-victim 規定 (デフォルト 'random'). 'none' 以外のとき engine は初夜の
  // bodyguard 行動を無視して initial victim を強制するため、 Night 0 guard は事実上無効。
  firstVictim: FirstVictim
  // general.omitFirstDay 規定 (デフォルト false). true のとき howl の 1日目朝 = Night 0 後の
  // 議論 (初夜結果がここで報告される). false のとき 1日目朝には過去夜が無い (= 報告不可).
  omitFirstDay: boolean
  // role.bodyguard.allow-continuous-protection 規定 (デフォルト true).
  // false のとき 2 夜連続で同一プレイヤーを護衛できないので、 行内の直前護衛先を補完候補から除外する。
  bodyguardAllowContinuous: boolean
}

export const setGameStats = StateEffect.define<GameStats>()

const gameStatsField = StateField.define<GameStats>({
  create() {
    return {
      day: 1, executions: 0,
      seerFirstSeek: 'all', firstVictim: 'random', omitFirstDay: false,
      bodyguardAllowContinuous: true,
    }
  },
  update(stats, tr) {
    for (const e of tr.effects) {
      if (e.is(setGameStats)) return e.value
    }
    return stats
  },
})

// ---- 候補型と文脈型 ----

export type Category = 'player' | 'player_start' | 'role' | 'action' | 'arrow' | 'co_role' | 'denial_co_role' | 'standalone' | 'result' | 'gameresult' | 'day'

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

// CO種別 — seer/medium/bodyguard/mason は CO 後に結果/対象/ペア宣言が続く。
// それ以外 ('other'; villager/werewolf/possessed/fanatic/werehamster/immoralist/nekomata)
// は宣言だけで終わるため後続の補完を起動しない。
type CoType = 'seer' | 'medium' | 'bodyguard' | 'mason' | 'other'

const claimingRoleToCoType: Partial<Record<SystemRole, CoType>> = {
  seer: 'seer', medium: 'medium', bodyguard: 'bodyguard', mason: 'mason',
}

function coTypeOf(role: string | undefined): CoType {
  if (role === undefined) return 'other'
  return claimingRoleToCoType[role as SystemRole] ?? 'other'
}

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
    // 役職行動を含まないCO (村人/人狼/妖狐/狂人/狂信者/背徳者/猫又) は宣言だけで完結するため、
    // 確定時に半角空白を入れずチェーン補完を起動させない
    terminal: coTypeOf(r.requiredRole) === 'other',
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

const dayTokenRe = /^[0-9０-９]+(?:日目?|[dDｄＤ](?:[aAａＡ][yYｙＹ])?)$/
const arrowRe = new RegExp(`^(?:${V.rightArrow}|${V.leftArrow})$`)
const rightArrowRe = new RegExp(`^${V.rightArrow}$`)
const leftArrowRe = new RegExp(`(?:${V.leftArrow})`)
const actionLabels = new Set(actionCandidates.filter(c => c.category === 'action').map(c => c.label))
const resultLabels = new Set(resultCandidates.map(c => c.label))
/** CO宣言キーワード (占い師CO等、非COを除く) */
const coKeywordLabels = new Set(coRoleCandidates.filter(c => c.category === 'co_role').map(c => c.label))
/** 非CO 宣言キーワード (非占い師CO 等)。 宣言だけで完結する terminal */
const denialCoLabels = new Set(coRoleCandidates.filter(c => c.category === 'denial_co_role').map(c => c.label))

/** 行内にCOキーワード(占い師CO等)があるか — CO宣言行でのみ複数結果チェーンを許可 */
function hasCoKeyword(lineText: string): boolean {
  for (const label of coKeywordLabels) {
    if (lineText.includes(label)) return true
  }
  return false
}

// ---- CO種別検出 ----

/**
 * 行の先頭プレイヤーのCO種別を判定する。
 * まずVillageStatusのCO情報を参照し、未登録なら行テキストのCOキーワードで判定する。
 */
// CO キーワード検出用の正規表現 (Howl vocabulary の短形式も含む)
const seerCoRe      = new RegExp(`${V.roleVocab('seer')}CO`, 'i')
const mediumCoRe    = new RegExp(`${V.roleVocab('medium')}CO`, 'i')
const bodyguardCoRe = new RegExp(`${V.roleVocab('bodyguard')}CO`, 'i')
const masonCoRe     = new RegExp(`${V.roleVocab('mason')}CO`, 'i')

function detectCoType(lineText: string, players: PlayerEntry[]): CoType {
  // VillageStatus: 行頭のプレイヤー名からCO種別を取得
  const firstToken = lineText.match(/^(\S+)/)?.[1]
  if (firstToken) {
    const player = players.find(p => p.name === firstToken || p.shortName === firstToken)
    if (player?.claimingRole) {
      return coTypeOf(player.claimingRole)
    }
  }

  // フォールバック: 行テキストのCOキーワードで判定 (CO宣言行)
  if (seerCoRe.test(lineText)) return 'seer'
  if (mediumCoRe.test(lineText)) return 'medium'
  if (bodyguardCoRe.test(lineText)) return 'bodyguard'
  if (masonCoRe.test(lineText)) return 'mason'
  return 'other'
}

// CO type ごとに、 ゲーム進行状況から報告可能な結果数の上限を返す。
//
// 過去夜の数:
//   pastNights = (day - 1) + (omitFirstDay ? 1 : 0)
//   - omitFirstDay=false (default): 1日目朝には過去夜が無い (Day 2 朝で初夜結果が出る)
//   - omitFirstDay=true:           1日目朝が Night 0 後 (= 初夜結果がそこで出る)
//
// seer: 初夜行動は role.seer.first-seek で制限される。 'none' のとき初夜結果が報告不可。
// bodyguard: 初夜護衛は general.first-victim != 'none' のとき engine が initial victim を
//   強制するため事実上無効。 'none' のときだけ Night 0 guard が機能する。
// medium: 過去処刑数のみが上限。 omitFirstDay 等とは無関係。
function maxReportable(coType: CoType, stats: GameStats): number {
  const pastNights = Math.max(0, (stats.day - 1) + (stats.omitFirstDay ? 1 : 0))
  if (coType === 'seer') {
    if (stats.seerFirstSeek === 'none' && pastNights >= 1) return pastNights - 1
    return pastNights
  }
  if (coType === 'bodyguard') {
    if (stats.firstVictim !== 'none' && pastNights >= 1) return pastNights - 1
    return pastNights
  }
  if (coType === 'medium') return stats.executions
  return Infinity // mason, other は上限なし
}

// 現行 CO 行内で既に報告済みの結果数を数える
// seer/medium は結果マーカー ○●白黒 の出現数、bodyguard はターゲット（日付以外のトークン）数
function countReportedInCo(lineText: string, coType: CoType): number {
  const coMatch = lineText.match(new RegExp(`(?:${V.roleVocab('seer')}|${V.roleVocab('medium')}|${V.roleVocab('bodyguard')}|${V.roleVocab('mason')})CO`, 'i'))
  if (!coMatch || coMatch.index === undefined) return 0
  const afterCo = lineText.slice(coMatch.index + coMatch[0].length)
  if (coType === 'seer' || coType === 'medium') {
    return (afterCo.match(/[○●白黒]/g) ?? []).length
  }
  if (coType === 'bodyguard') {
    const tokens = afterCo.split(new RegExp(`[\\s${V.delimiterClass}]+`)).filter(t => t.length > 0)
    return tokens.filter(t => !dayTokenRe.test(t)).length
  }
  return 0
}

// ---- 文脈推定 ----

/**
 * カーソル前の行テキストから、次に来るべき候補カテゴリを推定する。
 * null を返した場合、チェーン補完は起動しない。
 */
export function inferContext(beforeCursor: string, players: PlayerEntry[], stats: GameStats): Category[] | null {
  const trimmed = beforeCursor.trimEnd()
  if (trimmed === '') {
    // 行頭: プレイヤー名 + 行頭専用名 + アクション(転置記法) + スタンドアロンKW + 試合結果
    return ['player', 'player_start', 'action', 'standalone', 'gameresult']
  }

  // 末尾トークンを取得 (最後のスペース/区切り文字以降)
  const lastTokenMatch = trimmed.match(/[^\s,;:、，；：]+$/)
  if (!lastTokenMatch) return ['player', 'player_start', 'action', 'standalone', 'gameresult']
  const lastToken = lastTokenMatch[0]

  // CO 結果数の上限を超えたら chain を打ち切る ヘルパ
  const capReached = (coType: CoType): boolean => {
    if (coType === 'other' || coType === 'mason') return false
    return countReportedInCo(trimmed, coType) >= maxReportable(coType, stats)
  }

  // アクション: 行頭なら転置記法 → プレイヤー名、プレイヤー名の後なら → チェーン終了
  if (actionLabels.has(lastToken)) {
    const beforeAction = trimmed.slice(0, trimmed.length - lastToken.length).trimEnd()
    if (beforeAction === '') return ['player'] // 転置記法: アクション → プレイヤー名
    return null // 通常記法: プレイヤー名 アクション → 終了
  }

  // 日付トークン (1日目, 2d, etc.) → CO種別に応じた候補
  if (dayTokenRe.test(lastToken)) {
    const coType = detectCoType(trimmed, players)
    if (capReached(coType)) return null
    if (coType === 'medium') return ['result']
    if (coType === 'seer' || coType === 'bodyguard') return ['player']
    return null
  }

  // 結果マーカー (○/●) → CO種別に応じた候補 (次のエントリは日付から始められる)
  if (resultLabels.has(lastToken)) {
    if (!hasCoKeyword(trimmed)) return null // 結果報告行: 1結果で終了
    const coType = detectCoType(trimmed, players)
    if (capReached(coType)) return null
    if (coType === 'medium') return ['day', 'result']
    return ['day', 'player']
  }

  // 矢印 → プレイヤー名
  if (arrowRe.test(lastToken)) return ['player']

  // 非役職名CO (denial) は宣言だけで完結 — terminal
  if (denialCoLabels.has(lastToken)) return null

  // 役職名CO → CO種別に応じた候補
  if (coKeywordLabels.has(lastToken)) {
    const coType = detectCoType(trimmed, players)
    // 役職行動を含まないCO (村人/人狼/狐/狂人/狂信者/背徳者/猫又) は宣言だけで完結
    if (coType === 'other') return null
    if (capReached(coType)) return null
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
          if (capReached(coType)) return null
          return ['day', 'player']
        }
        if (coType === 'medium') {
          if (capReached(coType)) return null
          return ['day', 'result']
        }
        // seer: プレイヤー名の直後は結果
        if (capReached(coType)) return null
        return ['result']
      }
    }

    // 行頭のプレイヤー名 → CO済みなら役職に応じた候補を優先。
    // 報告系 (day / player / result) は capReached のとき除外し、 投票/CO/アクション等
    // の汎用候補のみ返す。 これにより初日CO 狩人 (= pastNights=0 で cap=0) で「行頭 +
    // 空白」 直後に 「player」 候補が誤って出るのを防ぐ。
    if (beforeLastToken === '') {
      const firstPlayer = players.find(p => p.name === lastToken || p.shortName === lastToken)
      const firstCoType = coTypeOf(firstPlayer?.claimingRole)
      const baseCategories: Category[] = ['arrow', 'co_role', 'denial_co_role', 'action']
      if (firstCoType === 'seer') {
        if (capReached('seer')) return baseCategories
        return ['day', 'player', ...baseCategories, 'result']
      }
      if (firstCoType === 'medium') {
        if (capReached('medium')) return baseCategories
        return ['day', 'result', ...baseCategories]
      }
      if (firstCoType === 'bodyguard') {
        if (capReached('bodyguard')) return baseCategories
        return ['day', 'player', ...baseCategories]
      }
      if (firstCoType === 'mason') return ['player', ...baseCategories]
    }
    return ['arrow', 'co_role', 'denial_co_role', 'action', 'result']
  }

  // 不明なトークン → フィルタなし (全候補)
  return null
}

// ---- 候補の構築 ----

/**
 * 日付候補を動的に生成。
 * role.seer.first-seek != 'none' のとき `0日目` (= Day 0 の夜 = first-seek 由来の先制占い結果) も候補に含める。
 */
export function buildDayCandidates(currentDay: number, seerFirstSeek: SeerFirstSeek): HowlCandidate[] {
  const candidates: HowlCandidate[] = []
  const startDay = seerFirstSeek === 'none' ? 1 : 0
  for (let d = startDay; d <= currentDay; d++) {
    candidates.push({
      label: `${d}日目`,
      reading: `${d}`,
      romaji: [`${d}`, `d${d}`, `${d}d`].join('\0'),
      type: 'keyword',
      category: 'day',
      categoryLabel: '日付',
      terminal: false,
      info: d === 0 ? '0日目の結果 (first-seek 由来の先制占い)' : `${d}日目の結果`,
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

/**
 * 連続護衛禁止 (role.bodyguard.allow-continuous-protection=false) のとき、
 * bodyguard CO 行内の直前護衛先を補完候補から除外するためのラベル名を返す。
 *
 * 行頭プレイヤーが bodyguard claim、 もしくは行内に bodyguard CO キーワードがある行で
 * のみ機能する。 beforeCursor を末尾から走査して最初に見つかったプレイヤー名トークン
 * (= 直前護衛先) を返す。 「同じ夜の同じ人を再指定する」 ケースは想定しない。
 */
export function getContinuousProtectionExclusion(
  beforeCursor: string, lineText: string, players: PlayerEntry[]
): string | null {
  if (detectCoType(lineText, players) !== 'bodyguard') return null
  const tokens = beforeCursor.split(/[\s,;:、，；：]+/).filter(t => t.length > 0)
  // 行頭プレイヤー (= CO 主体) は除外対象に含めない。 後ろから 1 つ前まで走査。
  for (let i = tokens.length - 1; i >= 1; i--) {
    const t = tokens[i]
    for (const p of players) {
      if (p.name === t || p.shortName === t || p.aliases.includes(t)) {
        return p.shortName || p.name
      }
    }
  }
  return null
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

// ---- 動画タイムスタンプ補完 ----

let videoTimeGetter: (() => number | null) | undefined

export function setVideoTimeGetter(fn: () => number | null) {
  videoTimeGetter = fn
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const videoTimestampCompletionSource: CompletionSource = (context) => {
  if (!videoTimeGetter) return null
  const match = context.matchBefore(/@/)
  if (!match || match.to - match.from !== 1) return null
  const time = videoTimeGetter()
  if (time === null) return null
  const timeStr = formatTimestamp(time)
  return {
    from: match.from,
    to: match.to,
    options: [{
      label: `@${timeStr}`,
      apply: `@${timeStr}`,
      detail: '現在時刻',
      type: 'keyword',
      boost: 99,
    }],
    filter: false,
  }
}

// ---- 補完ソース ----

const isAscii = /^[a-zA-Z0-9_\-]+$/

const setupOrJoinRe = /^(?:配役|レギュレーション|レギュ|setup|\+\+?|#)/

const howlCompletionSource: CompletionSource = (context) => {
  // @行 (setup), +行 (join), ++行 (joinMulti), #行 (コメント) では補完無効
  const curLine = context.state.doc.lineAt(context.pos)
  if (setupOrJoinRe.test(curLine.text)) return null

  const players = context.state.field(playerListField)
  const setup = context.state.field(setupField)
  const currentDay = context.state.field(currentDayField)
  const gameStats = context.state.field(gameStatsField)
  const playerCandidates = buildPlayerCandidates(players)
  const dayCandidates = buildDayCandidates(currentDay, gameStats.seerFirstSeek)

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

    // スペースまたは行頭でなければ補完しない (半角/全角 space, tab を許容)
    if (beforeCursor.length > 0 && !/[ 　\t]$/.test(beforeCursor)) return null

    const categories = inferContext(beforeCursor, players, gameStats)
    if (!categories) return null

    let filtered = filterByCategories(allCandidates, categories)

    // ←行: 被投票者と既出投票者を除外
    if (leftArrowRe.test(beforeCursor)) {
      const excluded = getLeftArrowExclusions(line.text, players)
      if (excluded.size > 0) {
        filtered = filtered.filter(c => !excluded.has(c.label))
      }
    }

    // 連続護衛禁止: 行内の直前護衛先を player 候補から除外
    if (!gameStats.bodyguardAllowContinuous && categories.includes('player')) {
      const exclude = getContinuousProtectionExclusion(beforeCursor, line.text, players)
      if (exclude) filtered = filtered.filter(c => c.label !== exclude)
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
  const categories = inferContext(beforeWord, players, gameStats)

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

  // 連続護衛禁止: 行内の直前護衛先を player 候補から除外
  if (!gameStats.bodyguardAllowContinuous && categories.includes('player')) {
    const exclude = getContinuousProtectionExclusion(beforeWord, line.text, players)
    if (exclude) candidates = candidates.filter(c => c.label !== exclude)
  }

  // テキストマッチフィルタ (先頭一致を優先、substring は後段)
  const prefixMatches: Completion[] = []
  const substringMatches: Completion[] = []
  for (const c of candidates) {
    let matchKind: 'prefix' | 'substring' | null = null
    if (useRomaji) {
      for (const r of c.romaji.split('\0')) {
        if (r.startsWith(inputLower)) { matchKind = 'prefix'; break }
        if (matchKind === null && r.includes(inputLower)) matchKind = 'substring'
      }
    } else {
      if (c.label.startsWith(input)) matchKind = 'prefix'
      else if (c.label.includes(input)) matchKind = 'substring'
    }
    if (matchKind === null) continue
    const completion: Completion = {
      label: c.label,
      apply: c.terminal ? c.label : c.label + ' ',
      detail: c.categoryLabel,
      type: c.type,
      info: c.info,
    }
    if (matchKind === 'prefix') prefixMatches.push(completion)
    else substringMatches.push(completion)
  }
  const filtered = [...prefixMatches, ...substringMatches]

  if (filtered.length === 0) return null

  return {
    from: word.from,
    options: filtered,
    filter: false,
  }
}

// ---- Extension ----

// `@` は CM autocomplete のデフォルト起動文字に含まれないため、明示的にトリガーする
const atCompletionTrigger = EditorView.updateListener.of(update => {
  if (!update.docChanged) return
  let typedAt = false
  update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.toString() === '@') typedAt = true
  })
  if (typedAt) queueMicrotask(() => startCompletion(update.view))
})

// Enter が補完計算 (pending) 中に押されると改行になってしまう問題への対策。
// pending を観測したら Enter を消費し、rAF で状態遷移 (active/null) を待ってから
// accept または改行を実行する。 PENDING_WAIT_TIMEOUT_MS は保険のタイムアウト。
const PENDING_WAIT_TIMEOUT_MS = 200

const enterWaitForPending = keymap.of([{
  key: 'Enter',
  run: (view) => {
    if (completionStatus(view.state) !== 'pending') return false
    const start = performance.now()
    const tick = () => {
      const s = completionStatus(view.state)
      if (s === 'active') {
        acceptCompletion(view)
        return
      }
      if (s === null || performance.now() - start > PENDING_WAIT_TIMEOUT_MS) {
        insertNewlineAndIndent(view)
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
  },
}])

export const howlCompletionExtension: Extension = [
  playerListField,
  setupField,
  currentDayField,
  gameStatsField,
  autocompletion({
    override: [videoTimestampCompletionSource, howlCompletionSource],
    activateOnTyping: true,
    activateOnCompletion: (c) => typeof c.apply === 'string' && c.apply.endsWith(' '),
  }),
  Prec.highest(enterWaitForPending),
  atCompletionTrigger,
]
