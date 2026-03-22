import { StreamLanguage, type StringStream } from '@codemirror/language'

type HowlState = {
  inFrontmatter: boolean
}

// Arrows
const rightArrowRe = /(?:→|⇒|⟶|⟹|➡️|->|=>|ー＞|＝＞)/
const leftArrowRe = /(?:←|⇐|⟵|⟸|⬅️|<-|<=|＜ー|＜＝)/

// Roles (Japanese + ASCII)
const roleRe = /(?:村人?|占い?師?|[預予]言?者?|霊(?:媒師?|能者?)?|護(?:衛)?|狩(?:り|人)?|共(?:有者?)?|猫又?|人?狼|狂(?:人?|信者?)|妖?狐|背(?:徳者?)?|villager|seer|medium|bodyguard|mason|nekomata|werewolf|possessed|fanatic|werehamster|immoralist)/

// Species
const humanRe = /[白◯○〇]/
const wolfRe = /[黒●]/

// Statement keywords
const actionRe = /(?:襲撃|噛み?|死亡|吊り?|処刑|再投票|平和|道連れ|猫又の呪い|後追い)/

// Game results
const resultRe = /(?:村人?|市民|村)(?:陣営)?(?:勝(?:利|ち)?|敗(?:北|け)?)|(?:人?狼)(?:陣営)?(?:勝(?:利|ち)?|敗(?:北|け)?)|(?:妖?狐)(?:陣営)?(?:勝(?:利|ち)?|敗(?:北|け)?)|(?:引き?分け?)|villageWin|wolfWin|hamsterWin|draw/

// CO keyword
const coRe = /[cCｃＣ][oOｏＯ]/

// Day marker
const dayRe = /[1-9１-９][0-9０-９]*(?:日目?|[dDｄＤ](?:[aAａＡ][yYｙＹ])?)/

// Join prefix
const joinPrefixRe = /\+\+|\＋\＋|\+|\＋/

// Frontmatter delimiter
const frontmatterRe = /^---\s*$/

const howlMode = {
  startState(): HowlState {
    return { inFrontmatter: false }
  },

  token(stream: StringStream, state: HowlState): string | null {
    // Beginning of line checks
    if (stream.sol()) {
      // Frontmatter delimiter
      if (stream.match(frontmatterRe)) {
        state.inFrontmatter = !state.inFrontmatter
        return 'meta'
      }

      // Inside frontmatter — consume whole line
      if (state.inFrontmatter) {
        stream.skipToEnd()
        return 'meta'
      }

      // Comment line
      if (stream.peek() === '#') {
        stream.skipToEnd()
        return 'comment'
      }

      // Join prefix at start of line
      if (stream.match(joinPrefixRe)) {
        return 'keyword'
      }
    }

    // Inside frontmatter (shouldn't reach here but safety)
    if (state.inFrontmatter) {
      stream.skipToEnd()
      return 'meta'
    }

    // Skip whitespace
    if (stream.eatSpace()) return null

    // Game results (check before roles since they overlap with alignment words)
    if (stream.match(resultRe)) return 'heading'

    // Day marker
    if (stream.match(dayRe)) return 'number'

    // Arrows
    if (stream.match(rightArrowRe) || stream.match(leftArrowRe)) return 'operator'

    // Species
    if (stream.match(humanRe)) return 'string'
    if (stream.match(wolfRe)) return 'bool'

    // Action keywords
    if (stream.match(actionRe)) return 'keyword'

    // CO keyword
    if (stream.match(coRe)) return 'keyword'

    // Roles
    if (stream.match(roleRe)) return 'typeName'

    // Default: advance one character
    stream.next()
    return null
  },
}

export const howlLanguage = StreamLanguage.define(howlMode)
