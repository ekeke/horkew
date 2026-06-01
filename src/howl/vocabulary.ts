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
export const dayNumber       = `[1-9１-９][0-9０-９]*?`
export const dayUnit         = `(?:日目?|[dDｄＤ](?:[aAａＡ][yYｙＹ])?)` // Day (1-9, 1-9 in full-width)


// ********************************* Basic Gaming Vocabulary

export const win    = `(?:勝(?:利|ち)?)`
export const lose   = `(?:敗(?:北|け)?)`
export const draw   = `(?:引き?分け?)`

export const claim  = `[cCｃＣ][oOｏＯ]`
export const equal  = `(?:=|＝)`

export const attack = `(?:襲撃|噛み?|死亡)`
export const lynch  = `(?:吊り?|処刑)`
export const suddenDeath = `(?:突然死|suddenDeath)`
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

// ********************************* Races

export const isHuman = `[白◯○〇]`
export const isWolf  = `[黒●]`
export const isKogitsune = `(?:子狐|kogitsune)`
export const race = `(?:${isHuman}|${isWolf}|${isKogitsune})`

// ********************************* Modifiers

export const denial = `(?:非)`
export const setupPrefix = `(?:配役|レギュレーション|レギュ|setup)`
export const survivors = `(?:生存者|全員)`
