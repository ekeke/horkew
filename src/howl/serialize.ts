/**
 * Howl Statement → 文字列シリアライザと、構造化 Statement のファクトリ。
 *
 * `parser.ts` / `statement.ts` がテキスト → Statement のパースを担うのに対し、
 * このモジュールは Statement → テキストの逆変換を提供する。
 * 加えて、プログラムから Statement を合成するためのファクトリ関数群を公開する。
 *
 * 用途:
 * - Lupa の GameEvent からゲーム記録を Howl 形式で書き出す（to-howl.ts）
 * - テスト/シナリオ生成で Statement を宣言的に組み立てる
 * - 将来的なラウンドトリップ検証（parse → serialize → parse）
 *
 * 注: Howl パーサーは多様な表記を受理するが、このシリアライザは **canonical form**
 * （日本語記号を優先した正規形）を一意に出力する。パーサーでの受理は別形式でも可。
 */

import type {
  Statement,
  SetupStatement, JoinStatement, JoinMultiStatement,
  VoteStatement, MultiVoteStatement, RevoteStatement, GrelanStatement,
  AttackStatement, LynchStatement, SuddenDeathStatement, CorpseFoundStatement,
  PeaceStatement, DayMarkStatement, CurseStatement, FollowStatement, ForecastStatement,
  OverStatement, AssertStatement, MasonStatement,
  RevealStatement, SpoilerStatement, SpeechStatement,
  VideoSourceStatement, TimestampStatement, UnknownStatement,
  Species, GameResult, Role, Assertion,
} from './statement.ts'

// ----------------------------------------------------------------------
// Canonical vocabulary for emission
// ----------------------------------------------------------------------

// 注: `狂` は `possessed` (狂人?) にもマッチしてしまうため、
// fanatic は必ず `狂信` と出力して両者を区別する。
const ROLE_SHORT: Record<string, string> = {
  villager: '村', werewolf: '狼', seer: '占', medium: '霊',
  bodyguard: '狩', mason: '共', nekomata: '猫',
  fanatic: '狂信', werehamster: '狐', immoralist: '背',
  possessed: '狂人',
}

const ROLE_ORDER_FOR_SETUP = [
  'villager', 'werewolf', 'seer', 'medium', 'bodyguard',
  'mason', 'nekomata', 'fanatic', 'werehamster', 'immoralist', 'possessed',
]

const CO_LABEL: Record<Role, string> = {
  seer: '占いCO',
  medium: '霊媒CO',
  bodyguard: '狩人CO',
  mason: '共有CO',
  nekomata: '猫又CO',
  nonVillage: '人外CO',
}

function speciesGlyph(s: Species): string {
  if (s === 'isWolf') return '●'
  if (s === 'isKogitsune') return '子狐'
  return '○'
}

function resultWord(r: GameResult): string {
  switch (r) {
    case 'villageWin': return '村勝ち'
    case 'wolfWin': return '狼勝ち'
    case 'hamsterWin': return '狐勝ち'
    case 'draw': return '引き分け'
  }
}

// ----------------------------------------------------------------------
// Factories
// ----------------------------------------------------------------------

export function makeSetup(roles: Record<string, number>): SetupStatement {
  return { type: 'setup', line: 0, roles }
}

export function makeJoin(name: string, opts: { shortName?: string; aliases?: string[] } = {}): JoinStatement {
  // shortName は undefined を明示的に入れずに、指定時のみ設定する。
  // （parseStatement 結果はフィールド未定義なので deepEqual と一致させるため）
  const stmt: JoinStatement = { type: 'join', line: 0, name, aliases: opts.aliases ?? [] }
  if (opts.shortName !== undefined) stmt.shortName = opts.shortName
  return stmt
}

export function makeJoinMulti(players: string[]): JoinMultiStatement {
  return { type: 'joinMulti', line: 0, players }
}

export function makeVote(voter: string, target: string): VoteStatement {
  return { type: 'vote', line: 0, voter, target }
}

export function makeMultiVote(voters: string[], target: string): MultiVoteStatement {
  return { type: 'multiVote', line: 0, voters, target }
}

export function makeRevote(targets: string[]): RevoteStatement {
  return { type: 'revote', line: 0, targets }
}

export function makeGrelan(): GrelanStatement {
  return { type: 'grelan', line: 0 }
}

export function makeAttack(targets: string[]): AttackStatement {
  return { type: 'attack', line: 0, target: targets }
}

export function makeLynch(target: string | null): LynchStatement {
  return { type: 'lynch', line: 0, target }
}

export function makeSuddenDeath(target: string, reason: string): SuddenDeathStatement {
  return { type: 'suddenDeath', line: 0, target, reason }
}

export function makePeace(): PeaceStatement {
  return { type: 'peace', line: 0 }
}

export function makeCurse(target: string): CurseStatement {
  return { type: 'curse', line: 0, target }
}

export function makeFollow(target: string): FollowStatement {
  return { type: 'follow', line: 0, target }
}

export function makeForecast(actor: string, target: string): ForecastStatement {
  return { type: 'forecast', line: 0, actor, target }
}

export function makeOver(result: GameResult): OverStatement {
  return { type: 'over', line: 0, result }
}

export function makeAssert(actor: string, assertions: Assertion[]): AssertStatement {
  return { type: 'assert', line: 0, actor, assertions }
}

export function makeMason(players: string[]): MasonStatement {
  return { type: 'mason', line: 0, players }
}

export function makeReveal(player: string, role: string): RevealStatement {
  return { type: 'reveal', line: 0, player, role }
}

export function makeSpoiler(player: string, role: string): SpoilerStatement {
  return { type: 'spoiler', line: 0, player, role }
}

/**
 * 占いCO（役職主張 + 0件以上の結果）用の AssertStatement ファクトリ。
 */
export function makeSeerCO(
  actor: string,
  results: Array<{ day?: number; target: string; result: Species }> = [],
): AssertStatement {
  const assertions: Assertion[] = [{ player: actor, roles: ['seer'] }]
  for (const r of results) {
    const assertion: Assertion = { player: actor, target: r.target, result: r.result }
    if (r.day !== undefined) assertion.day = r.day
    assertions.push(assertion)
  }
  return makeAssert(actor, assertions)
}

/**
 * 占い結果（COなし、結果のみ報告）用の AssertStatement ファクトリ。
 */
export function makeSeerResult(actor: string, target: string, result: Species): AssertStatement {
  return makeAssert(actor, [{ player: actor, target, result }])
}

/**
 * 霊媒CO（役職主張 + 過去結果）。target は必須（通常は前日の処刑者）。
 */
export function makeMediumCO(
  actor: string,
  results: Array<{ target: string; result: Species }> = [],
): AssertStatement {
  const assertions: Assertion[] = [{ player: actor, roles: ['medium'] }]
  for (const r of results) {
    assertions.push({ player: actor, target: r.target, result: r.result })
  }
  return makeAssert(actor, assertions)
}

/**
 * 霊媒結果（COなし、結果のみ）。target は前日の処刑者。
 */
export function makeMediumResult(actor: string, target: string, result: Species): AssertStatement {
  return makeAssert(actor, [{ player: actor, target, result }])
}

/**
 * 狩人CO（役職主張 + 護衛履歴）。
 */
export function makeBodyguardCO(actor: string, guardTargets: string[] = []): AssertStatement {
  const assertions: Assertion[] = [{ player: actor, roles: ['bodyguard'] }]
  for (const t of guardTargets) {
    assertions.push({ player: actor, target: t, action: 'guard' })
  }
  return makeAssert(actor, assertions)
}

/**
 * 共有CO（役職主張 + パートナー情報は Howl の AssertStatement には乗らないため無視）。
 * パートナー情報を保持したい場合は makeMason([actor, partner]) を別途発行する。
 */
export function makeMasonCO(actor: string): AssertStatement {
  return makeAssert(actor, [{ player: actor, roles: ['mason'] }])
}

/**
 * 猫又CO。
 */
export function makeNekomataCO(actor: string): AssertStatement {
  return makeAssert(actor, [{ player: actor, roles: ['nekomata'] }])
}

// ----------------------------------------------------------------------
// Serializer
// ----------------------------------------------------------------------

/**
 * Statement を canonical な Howl 文字列に変換する。
 *
 * 入力の `line` / `day` / `timestamp` は出力には含めない（情報保持したい場合は
 * 呼び出し側が別途コメント等として付加する）。
 */
export function serializeStatement(stmt: Statement): string {
  switch (stmt.type) {
    case 'setup':      return serializeSetup(stmt as SetupStatement)
    case 'join':       return serializeJoin(stmt as JoinStatement)
    case 'joinMulti':  return serializeJoinMulti(stmt as JoinMultiStatement)
    case 'vote':       return serializeVote(stmt as VoteStatement)
    case 'multiVote':  return serializeMultiVote(stmt as MultiVoteStatement)
    case 'revote':     return serializeRevote(stmt as RevoteStatement)
    case 'grelan':     return 'グレラン'
    case 'attack':     return serializeAttack(stmt as AttackStatement)
    case 'lynch':      return serializeLynch(stmt as LynchStatement)
    case 'suddenDeath':return serializeSuddenDeath(stmt as SuddenDeathStatement)
    case 'peace':      return '平和'
    case 'dayMark':    return `Day ${(stmt as DayMarkStatement).day}:`
    case 'curse':      return `${(stmt as CurseStatement).target}道連れ`
    case 'follow':     return `${(stmt as FollowStatement).target}後追い`
    case 'forecast':   return serializeForecast(stmt as ForecastStatement)
    case 'over':       return resultWord((stmt as OverStatement).result)
    case 'assert':     return serializeAssert(stmt as AssertStatement)
    case 'mason':      return serializeMason(stmt as MasonStatement)
    case 'reveal':     return serializeReveal(stmt as RevealStatement)
    case 'spoiler':    return serializeSpoiler(stmt as SpoilerStatement)
    case 'speech':     return serializeSpeech(stmt as SpeechStatement)
    case 'videoSource':return (stmt as VideoSourceStatement).url
    case 'timestamp':  return `@${(stmt as TimestampStatement).raw}`
    case 'corpseFound':return `${(stmt as CorpseFoundStatement).target} 死体発見`
    case 'unknown':    return (stmt as UnknownStatement).text
  }
}

function serializeSetup(stmt: SetupStatement): string {
  const parts = ROLE_ORDER_FOR_SETUP
    .filter(r => (stmt.roles[r] ?? 0) > 0)
    .map(r => `${ROLE_SHORT[r] ?? r}${stmt.roles[r]}`)
  return `レギュ ${parts.join('')}`
}

function serializeJoin(stmt: JoinStatement): string {
  // shortName は name と空白で離すと parser 側の splitTokens が別 token として扱い
  // alias に落ちてしまうため、必ず name に連結する (例: `+ Alice(Al) Aliceちゃん`)。
  const head = stmt.shortName ? `${stmt.name}(${stmt.shortName})` : stmt.name
  return `+ ${[head, ...stmt.aliases].join(' ')}`
}

function serializeJoinMulti(stmt: JoinMultiStatement): string {
  // `+` 1 個は parseJoin に hit する。 joinMulti 形式は `++` プレフィックスを要求。
  return `++ ${stmt.players.join(', ')}`
}

function serializeVote(stmt: VoteStatement): string {
  return `${stmt.voter}→${stmt.target}`
}

function serializeMultiVote(stmt: MultiVoteStatement): string {
  return `${stmt.target}←${stmt.voters.join('、')}`
}

function serializeRevote(stmt: RevoteStatement): string {
  // parser 受理形は `ーーー Alice, Bob` (delimiter で targets を列挙)。
  // 旧実装は `# 再投票候補:` コメントを付与していたが parser が `#` をコメントとして
  // 扱わず token に取り込んで targets が汚染されていた。
  const suffix = stmt.targets.length > 0 ? ` ${stmt.targets.join(', ')}` : ''
  return `ーーー${suffix}`
}

function serializeAttack(stmt: AttackStatement): string {
  // 単一 target は後方形式 (`Alice噛み`)。 複数 target は parser が後方形式を受理
  // しないため前方形式 (`襲撃 Alice、Bob`) に切り替える。
  if (stmt.target.length <= 1) return `${stmt.target.join('、')}噛み`
  return `襲撃 ${stmt.target.join('、')}`
}

function serializeLynch(stmt: LynchStatement): string {
  return stmt.target === null ? '処刑者なし' : `${stmt.target}処刑`
}

function serializeSuddenDeath(stmt: SuddenDeathStatement): string {
  // parser は `突然死` と `(reason)` の間に空白を許容しない。
  // reason 空のときは括弧自体を出力しない (`Alice 突然死`)。
  if (stmt.reason.length === 0) return `${stmt.target} 突然死`
  return `${stmt.target} 突然死(${stmt.reason})`
}

function serializeForecast(stmt: ForecastStatement): string {
  return `${stmt.actor} 予告 ${stmt.target}`
}

function serializeMason(stmt: MasonStatement): string {
  return `共有 ${stmt.players.join(', ')}`
}

function serializeReveal(stmt: RevealStatement): string {
  return `${stmt.player}=${stmt.role}`
}

// spoiler action 漢字マップ ([src/howl/statement.ts](./statement.ts) の spoilerActionMap の逆引き)。
const SPOILER_ACTION_GLYPH: Record<string, string> = {
  divine: '占い',
  guard: '護衛',
  attack: '襲撃',
}

function serializeSpoiler(stmt: SpoilerStatement): string {
  // action 形式 (例: `!Alice 1夜 占い Bob`) は role を持たず day/action/target を持つ。
  if (stmt.action !== undefined && stmt.target !== undefined && stmt.day !== undefined) {
    return `!${stmt.player} ${stmt.day}夜 ${SPOILER_ACTION_GLYPH[stmt.action]} ${stmt.target}`
  }
  // role pin 形式 (例: `!Alice=占い`)。 parser 受理形に揃える。
  return `!${stmt.player}=${stmt.role}`
}

function serializeSpeech(stmt: SpeechStatement): string {
  return `${stmt.actor} > ${stmt.text}`
}

function serializeAssert(stmt: AssertStatement): string {
  // 役職主張 + 結果履歴を分離して再構築
  // 同じ actor の複数 assertions を1行に畳む想定。
  const claimParts: string[] = []
  const historyParts: string[] = []

  for (const a of stmt.assertions) {
    if (a.roles && a.roles.length > 0) {
      const prefix = a.negative ? '非' : ''
      // 素村CO（= 全霊能持ち役職の negative 付き）だけ特別扱い
      if (a.negative && a.roles.length === 5 && a.roles.every(r => r !== 'nonVillage')) {
        claimParts.push('素村CO')
      } else {
        for (const role of a.roles) {
          claimParts.push(`${prefix}${CO_LABEL[role]}`)
        }
      }
    } else if (a.target) {
      // 夜番号を 1-indexed の "{N}D " プレフィックスで出力 (howl パーサは dayNumber+dayUnit を受理)
      const dayPrefix = a.day !== undefined ? `${a.day + 1}D ` : ''
      if (a.action === 'guard') {
        historyParts.push(`${dayPrefix}${a.target}護衛`)
      } else if (a.result) {
        historyParts.push(`${dayPrefix}${a.target}${speciesGlyph(a.result)}`)
      }
    }
  }

  const head = claimParts.length > 0 ? ` ${claimParts.join(' ')}` : ''
  const body = historyParts.length > 0 ? ' ' + historyParts.join(' ') : ''
  return `${stmt.actor}${head}${body}`.trimEnd()
}

// ----------------------------------------------------------------------
// Helper: コメント行フォーマッタ（Statement に乗らない補助情報向け）
// ----------------------------------------------------------------------

/** `# ...` 形式のコメント行を作る。改行は含めない。 */
export function commentLine(text: string): string {
  return `# ${text}`
}
