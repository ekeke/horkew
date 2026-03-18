// ********************************* Basic Syntax Elements
export const whiteSpaceClass = `\\u0020\\u3000\\t` // white space, full-width space, tab
export const whiteSpace      = `[${whiteSpaceClass}]` // white space, tab, full-width space
export const optionalSpace   = `${whiteSpace}*?`
export const whiteSpaces     = `${whiteSpace}+?`
export const rightArrow      = `(?:→|⇒|⟶|⟹|➡️|->|=>|ー＞|＝＞)`
export const leftArrow       = `(?:←|⇐|⟵|⟸|⬅️|<-|<=|＜ー|＜＝)`
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
export const revote = `(?:再投票|\-\-+|==+|ーー+|＝＝+)`
export const guard  = `(?:護衛?|ガード)`
export const peace  = `(?:平和)`
export const curse  = `(?:道連れ|猫又の呪い)`
export const follow = `(?:後追い)`
export const none   = `(?:者?(?:なし|無し|ナシ))`

// ********************************* Basic Roles

export const villager    = `(?:村人?)`
export const seer        = `(?:占い?師?|[預予]言?者?)`
export const medium      = `(?:霊(?:媒師?|能者?|))`
export const bodyguard   = `(?:護(?:衛)?|狩(?:り|人)?)`
export const mason       = `(?:共(?:有者?)?)`
export const nekomata    = `(?:猫又?)`
export const werewolf    = `(?:人?狼)`
export const possessed   = `(?:狂人?|狂信者?)`
export const werehamster = `(?:妖?狐)`
export const immoralist  = `(?:背(?:徳者?)?)`
export const anyRole     = `(?:${villager}|${seer}|${medium}|${bodyguard}|${mason}|${nekomata}|${werewolf}|${possessed}|${werehamster}|${immoralist})` // Any role (villager, seer, medium, bodyguard, mason, nekomata, werewolf, possessed, werehamster, immoralist)

// ********************************* Alignments

export const village = `(?:村人?|市民|村人|村)(?:陣営)?` // Villager (or village) alignment
export const wolf    = `(?:人?狼)(?:陣営)?` // Wolf (or werewolf) alignment
export const hamster = `(?:妖?狐)(?:陣営)?` // Hamster (or werehamster) alignment
export const anyAlignment = `(?:${village}|${wolf}|${hamster})` // Any alignment (village, wolf, or hamster)

// ********************************* Races

export const isHuman = `[白◯○〇]`
export const isWolf  = `[黒●]`
export const race = `(?:${isHuman}|${isWolf})`
