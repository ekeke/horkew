import { parseFrontmatter } from './frontmatter.ts'
import { FlexibleDictionary } from './flexibleDictionary.ts'
import { parseStatement } from './statement.ts'
import { serializeStatement } from './serialize.ts'
import { stripTrailingHashComment, splitTrailingHashComment } from './preprocess.ts'
import type {
  Statement,
  JoinStatement, JoinMultiStatement,
  VoteStatement, MultiVoteStatement, RevoteStatement,
  AttackStatement, LynchStatement, SuddenDeathStatement,
  CorpseFoundStatement,
  AssertStatement, MasonStatement,
  RevealStatement, SpoilerStatement, SpeechStatement,
  CurseStatement, FollowStatement, ForecastStatement,
} from './statement.ts'

// parser.ts と同等のロジックで join/joinMulti を dict に登録する。
// shortName は元々 dict 登録対象外、aliases と席番号 alias のみ登録する。
function registerJoinInDict(dict: FlexibleDictionary, name: string, extraAliases: string[], seatNumber: number): void {
  const seatAlias = String(seatNumber)
  const aliases = new Set<string>([name, ...extraAliases, seatAlias])
  try {
    dict.add(name, [...aliases])
  } catch {
    // 重複登録 (同名プレイヤー / alias 衝突) は無視
  }
}

// 文書内の join / joinMulti を 1 pass で走査して FlexibleDictionary を構築する。
function buildDictFromBody(bodyLines: string[]): FlexibleDictionary {
  const dict = new FlexibleDictionary()
  let seatNumber = 0
  for (let i = 0; i < bodyLines.length; i++) {
    const trimmed = stripTrailingHashComment(bodyLines[i]).trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const stmt = parseStatement(trimmed, i + 1)
    if (stmt.type === 'join') {
      const j = stmt as JoinStatement
      seatNumber++
      registerJoinInDict(dict, j.name, j.aliases, seatNumber)
    } else if (stmt.type === 'joinMulti') {
      for (const p of (stmt as JoinMultiStatement).players) {
        seatNumber++
        registerJoinInDict(dict, p, [], seatNumber)
      }
    }
  }
  return dict
}

// dict 経由で name を canonical へ正規化する (parser.ts の resolveName と同じ)。
function resolveName(dict: FlexibleDictionary, name: string): string {
  const results = dict.search(name)
  return results.length > 0 ? results[0] : name
}

// Statement 内の player フィールドを置換する。変更があった場合は新しい Statement を、
// 無ければ null を返す。 join statement の aliases / shortName は既定では歴史的な別表記として
// 保持するが、 `clearAliases: true` を指定すると name が置換されたタイミングで両方とも消去する。
function renameInStatement(
  stmt: Statement,
  dict: FlexibleDictionary,
  canonical: string,
  newName: string,
  options: { clearAliases: boolean },
): Statement | null {
  let changed = false
  const sub = (name: string): string => {
    if (resolveName(dict, name) === canonical) {
      changed = true
      return newName
    }
    return name
  }

  let result: Statement = stmt
  switch (stmt.type) {
    case 'join': {
      const s = stmt as JoinStatement
      const renamed = sub(s.name)
      const renamedThisJoin = renamed !== s.name
      const next: JoinStatement = options.clearAliases && renamedThisJoin
        ? { type: 'join', line: s.line, name: renamed, aliases: [] }
        : { ...s, name: renamed }
      result = next
      break
    }
    case 'joinMulti': {
      const s = stmt as JoinMultiStatement
      const next: JoinMultiStatement = { ...s, players: s.players.map(sub) }
      result = next
      break
    }
    case 'vote': {
      const s = stmt as VoteStatement
      const next: VoteStatement = { ...s, voter: sub(s.voter), target: sub(s.target) }
      result = next
      break
    }
    case 'multiVote': {
      const s = stmt as MultiVoteStatement
      const next: MultiVoteStatement = { ...s, voters: s.voters.map(sub), target: sub(s.target) }
      result = next
      break
    }
    case 'attack': {
      const s = stmt as AttackStatement
      const next: AttackStatement = { ...s, target: s.target.map(sub) }
      result = next
      break
    }
    case 'lynch': {
      const s = stmt as LynchStatement
      const next: LynchStatement = { ...s, target: s.target === null ? null : sub(s.target) }
      result = next
      break
    }
    case 'suddenDeath': {
      const s = stmt as SuddenDeathStatement
      const next: SuddenDeathStatement = { ...s, target: sub(s.target) }
      result = next
      break
    }
    case 'corpseFound': {
      const s = stmt as CorpseFoundStatement
      const next: CorpseFoundStatement = { ...s, target: sub(s.target) }
      result = next
      break
    }
    case 'revote': {
      const s = stmt as RevoteStatement
      const next: RevoteStatement = { ...s, targets: s.targets.map(sub) }
      result = next
      break
    }
    case 'assert': {
      const s = stmt as AssertStatement
      const next: AssertStatement = {
        ...s,
        actor: sub(s.actor),
        assertions: s.assertions.map(a => {
          const na = { ...a, player: sub(a.player) }
          if (a.target !== undefined) na.target = sub(a.target)
          return na
        }),
      }
      result = next
      break
    }
    case 'mason': {
      const s = stmt as MasonStatement
      const next: MasonStatement = { ...s, players: s.players.map(sub) }
      result = next
      break
    }
    case 'reveal': {
      const s = stmt as RevealStatement
      const next: RevealStatement = { ...s, player: sub(s.player) }
      result = next
      break
    }
    case 'spoiler': {
      const s = stmt as SpoilerStatement
      const next: SpoilerStatement = { ...s, player: sub(s.player) }
      if (s.target !== undefined) next.target = sub(s.target)
      result = next
      break
    }
    case 'speech': {
      const s = stmt as SpeechStatement
      const next: SpeechStatement = { ...s, actor: sub(s.actor) }
      result = next
      break
    }
    case 'curse': {
      const s = stmt as CurseStatement
      const next: CurseStatement = { ...s, target: sub(s.target) }
      result = next
      break
    }
    case 'follow': {
      const s = stmt as FollowStatement
      const next: FollowStatement = { ...s, target: sub(s.target) }
      result = next
      break
    }
    case 'forecast': {
      const s = stmt as ForecastStatement
      const next: ForecastStatement = { ...s, actor: sub(s.actor), target: sub(s.target) }
      result = next
      break
    }
    // setup / peace / dayMark / grelan / over / videoSource / timestamp / unknown:
    // プレイヤーフィールドを持たないため触らない
    default:
      return null
  }

  return changed ? result : null
}

// 行内末尾の inline timestamp (` @MM:SS`) を切り出す。
const INLINE_TIMESTAMP_REGEX = /\s[@＠](\d{1,2}(?::\d{2}){1,2})[\s　]*$/

export type RenamePlayerOptions = {
  /**
   * `true` のとき、対象 join statement の `aliases` / `shortName` を消去して `name` のみ残す。
   * 既定 (`false`) では aliases / shortName を歴史的な別表記として保持する。
   */
  clearAliases?: boolean
}

/**
 * Howl テキスト内のプレイヤー名を一括リネームする。
 *
 * - `oldName` は FlexibleDictionary (parser と同じ経路) でマッチング。表記揺れも吸収する。
 * - リネーム対象のプレイヤーが関わる statement のみ再 serialize される (canonical form)。
 * - 関係ない行 / コメント / 空行 / unknown statement / frontmatter は原文のまま保存される。
 * - inline `@MM:SS` annotation は再 serialize 行でも末尾に保持される。
 * - join statement の `aliases` / `shortName` は既定では歴史的な別表記として保持する。
 *   `options.clearAliases` が true のとき、name を置換した join の aliases / shortName は消去される。
 *
 * 設計契約 (不変条件):
 * - **行単位 preservation**: リネーム対象 player を参照しない行は原文を完全保持する。
 *   この性質は `rename.test.ts` の `renamePlayer preservation` 群が回帰ガード。
 * - **フィールド単位 canonical 化**: リネーム対象 player を参照する行は当該 statement type
 *   の canonical form に再シリアライズされる。元の表記揺れ (空白・矢印形式・順序・
 *   `吊り` vs `処刑` 等の語選択) は失われる。これは設計通り。
 * - **ラウンドトリップ性**: 再シリアライズ結果は必ず `parseStatement` で受理可能で
 *   なければならない。 `serialize.test.ts` の roundtrip 群がこの不変条件を全 statement type
 *   について保証する。 ここを破ると「rename 経由で行が unknown 化する」 バグになる。
 */
export function renamePlayer(
  howlText: string,
  oldName: string,
  newName: string,
  options: RenamePlayerOptions = {},
): string {
  const clearAliases = options.clearAliases ?? false
  const { body, numLines } = parseFrontmatter(howlText)
  const headerEnd = howlText.length - body.length
  const header = howlText.slice(0, headerEnd)

  const bodyLines = body.split('\n')
  const dict = buildDictFromBody(bodyLines)
  const canonical = resolveName(dict, oldName)

  const outLines: string[] = []
  for (let i = 0; i < bodyLines.length; i++) {
    const rawLine = bodyLines[i]
    // 行末コメント (`[ws]# ...`) を先に分離。 parse には body だけ渡し、
    // 結果文字列の末尾に comment をそのまま付け戻して保持する。
    const { body: noComment, comment: commentSuffix } = splitTrailingHashComment(rawLine)
    const trimmed = noComment.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      outLines.push(rawLine)
      continue
    }

    // inline timestamp を切り出して保持
    const tsMatch = trimmed.match(INLINE_TIMESTAMP_REGEX)
    const stripped = tsMatch ? trimmed.slice(0, tsMatch.index!) : trimmed
    const tsSuffix = tsMatch ? ` ${tsMatch[0].trim()}` : ''

    const stmt = parseStatement(stripped, numLines + i)
    if (stmt.type === 'unknown') {
      outLines.push(rawLine)
      continue
    }

    const renamed = renameInStatement(stmt, dict, canonical, newName, { clearAliases })
    if (renamed === null) {
      outLines.push(rawLine)
      continue
    }

    outLines.push(serializeStatement(renamed) + tsSuffix + commentSuffix)
  }

  return header + outLines.join('\n')
}
