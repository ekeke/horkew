// ********************************* Basic Syntax Elements
export const whiteSpaceClass = `\\u0020\\u3000\\t` // white space, full-width space, tab
export const whiteSpace      = `[${whiteSpaceClass}]` // white space, tab, full-width space
export const optionalSpace   = `${whiteSpace}*?`
export const whiteSpaces     = `${whiteSpace}+?`
export const rightArrow      = `(?:→|⇒|⟶|⟹|➡️|->|=>|ー＞|＝＞)`
export const leftArrow       = `(?:←|⇐|⟵|⟸|⬅️|<-|<=|＜ー|＜＝)`
export const speechArrow     = `(?:>|＞)`
export const plus            = `(?:\\+|\\＋)`
export const delimiterClass  = `,;:\\u3001\\uFF0C\\uFF1B\\uFF1A` // full-width comma, full-width semicolon, full-width colon
export const delimiter       = `[${delimiterClass}${whiteSpaceClass}]${optionalSpace}`
export const possibleName    = `[^${whiteSpaceClass}${delimiterClass}]+` // Name (not including white space, full-width comma, full-width semicolon, full-width colon)
export const dayNumber       = `(?:[0０]|[1-9１-９][0-9０-９]*?)`
export const dayUnit         = `(?:日目?|[dDｄＤ](?:[aAａＡ][yYｙＹ])?)` // Day (0-9, 0-9 in full-width); leading zeros for multi-digit not allowed


// ********************************* Basic Gaming Vocabulary

export const win    = `(?:勝(?:利|ち)?)`
export const lose   = `(?:敗(?:北|け)?)`
export const draw   = `(?:引き?分け?)`

export const claim  = `[cCｃＣ][oOｏＯ]`
export const equal  = `(?:=|＝)`

export const attack = `(?:襲撃|噛み?|死亡)`
export const lynch  = `(?:吊り?|処刑)`
export const suddenDeath = `(?:突然死|suddenDeath)`
// 契約者 (contractor) の宝刀「焔薙」による強制退場。 公開された退場として
// 生存者は焔薙退場だと知る。 retar には sudden_death と同じ「制約無し離脱」
// として渡す (bridge.ts で causeOfDeath = 'sudden_death' にマップ)。
export const corpseFound = `(?:死体で?発見)`

// 公式アナウンス (= GM / システム発の公開情報) を表す行頭マーカー。
// spoiler (`!Alice=...`、 視点配信メモ) や reveal (`Alice=...`、 終了時正体公開) と
// 異なり、 進行中に村全員が共有する公式・確定情報を表現する。
// 例: 契約者ペアの公開、 (将来) パン屋の生存アナウンス等。
// 入力者の好み・媒体に合わせて記号系 (※ * ＊) と日本語ラベル系 (GM / システム /
// アナウンス + 全/半角コロン) のいずれも受ける。
export const announce = `(?:[※*＊]|(?:GM|システム|アナウンス|announcement)[:：])`
export const revote = `(?:再投票|\-\-+|==+|ーー+|＝＝+)`
export const guard  = `(?:護衛?|ガード)`
export const peace  = `(?:平和)`
export const curse  = `(?:道連れ|猫又の呪い)`
export const follow = `(?:後追い)`
export const forecast = `(?:予告)`
export const grelan   = `(?:グレラン)`
export const none   = `(?:者?(?:なし|無し|ナシ))`

// ********************************* Basic Roles
//
// 役職別の regex フラグメントは systemRoles.howlPattern が ground truth (src/types/index.ts)。
// 新役職追加で本ファイルを触る必要はない (anyRole / roleVocab / spoilerRoleSpecs / roleMapping
// 全て systemRoles から自動派生される)。
//
// pseudo-token (SystemRole でない解析時専用トークン) のみ standalone const として残置:
//   - plainVillager: 素村 CO (= 村側 power role 全否定) を表現
//   - nonVillage: 人外 CO (= 村陣営でない可能性) を表現

import { systemRoles, type SystemRole } from '../types/index.ts'

export const plainVillager = `(?:素村人?|plainVillager)`
export const nonVillage    = `(?:人外|nonVillage)`

/** 特定 SystemRole の Howl 入力用 regex フラグメントを返す。 anchor 無し。 */
export function roleVocab(role: SystemRole): string {
  const meta = systemRoles.get(role)
  if (!meta) throw new Error(`roleVocab: unknown SystemRole '${role}'`)
  return meta.howlPattern
}

/**
 * 全 SystemRole + pseudo-token (plainVillager / nonVillage) を含む選択肢。
 * spoiler / reveal / claim 解析の汎用 token として使う。
 */
export const anyRole: string = (() => {
  const patterns = [...systemRoles.values()].map(r => r.howlPattern)
  return `(?:${plainVillager}|${patterns.join('|')}|${nonVillage})`
})()

// ********************************* Alignments

export const village = `(?:村人?|市民|村人|村)(?:陣営)?` // Villager (or village) alignment
export const wolf    = `(?:人?狼)(?:陣営)?` // Wolf (or werewolf) alignment
export const hamster = `(?:妖?狐)(?:陣営)?` // Hamster (or werehamster) alignment
export const anyAlignment = `(?:${village}|${wolf}|${hamster})` // Any alignment (village, wolf, or hamster)

// ********************************* Spoiler faction aliases
//
// `!Alice=狼陣営` のような spoiler 右辺で「役職集合」を表現するための alias。
// 単独の「狼」「狐」「村」は role pin (werewolf 等) と曖昧なため、
// 陣営付き (`...陣営`) または英語キーに限定する。
//   - factionAliasHostile: 人外 (= wolf + fox faction)
//   - factionAliasWolf:    狼陣営
//   - factionAliasFox:     狐陣営
//   - factionAliasVillage: 村陣営

export const factionAliasVillage = `(?:村陣営|village)`
export const factionAliasWolf    = `(?:狼陣営|wolf)`
export const factionAliasFox     = `(?:狐陣営|妖狐陣営|fox)`
export const factionAliasHostile = `(?:人外|hostile)`
export const anyFactionAlias     = `(?:${factionAliasVillage}|${factionAliasWolf}|${factionAliasFox}|${factionAliasHostile})`

// ********************************* Races

export const isHuman = `[白◯○〇]`
export const isWolf  = `[黒●]`
export const isKogitsune = `(?:子狐|kogitsune)`
export const race = `(?:${isHuman}|${isWolf}|${isKogitsune})`

// ********************************* Modifiers

export const denial = `(?:非)`
export const setupPrefix = `(?:配役|レギュレーション|レギュ|setup)`
export const survivors = `(?:生存者|全員)`
