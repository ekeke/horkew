/**
 * AnalysisContext — lykaon の共有 state factory
 *
 * パース・解析パイプラインの全 state と cross-pane イベントバスを 1 つの class に集約する。
 *
 * 設計方針:
 *   - howlText / cursorLine / assumptions などの「入力」は writable $state
 *   - parsed / villageStatus / sourceLines などの「派生」は $derived
 *   - 解析結果は worker から writable $state に書き込まれる
 *   - editor ↔ pane / 動画 player との通信は onSeek / onJump のイベントバスで疎結合化
 */

import { tick } from 'svelte'
import type { SystemRole, SeatStatus, VillageStatus, CauseOfDeath } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { Statement } from '../howl/statement.ts'
import type { FlexibleDictionary } from '../howl/flexibleDictionary.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { statementsToPublicEvents } from '../howl/events-bridge.ts'
import type { GameEvent } from '../lupa/index.ts'
import { serializeVillageStatus } from '../retar/wasm-helpers.ts'
import { stringifyStatements, type StringifiedLine } from './stringify.ts'
import { scoreWolfPairs, type WolfPairSuggestion } from './status/wolfPairScorer.ts'
import { requestAnalysis, type SeatResult, type AnalysisStats } from './runAnalysis.ts'
import { mergeAssumptions } from './assumptions-merge.ts'

// =====================================================================
// 共通型定義
// =====================================================================

/**
 * howl テキスト内の論理要素 → 行番号のマップ。
 * editor のシンタックスハイライト連動と pane → editor ジャンプに使う。
 */
export type SourceLines = {
  survivor: Map<number, number>   // seat → line
  claimRow: Map<number, number>   // seat → line (CO 宣言の代表行)
  claimCell: Map<string, number>  // "seat:night" → line (per-cell)
  kill: Map<number, number>       // nightDay → line
  exec: Map<number, number>       // execDay → line
  vote: Map<number, number>       // voterSeat → line
}

/**
 * editor 内で時刻トークンがクリックされたとき発火するイベント。
 */
export type SeekEvent = {
  seconds: number
  line: number
}

/**
 * pane → editor の「この行にジャンプ」要求。
 */
export type JumpEvent = {
  line: number
  column?: number
}

export type { SeatResult, AnalysisStats, WolfPairSuggestion, StringifiedLine }

/**
 * AnalysisTable 等で席をグルーピングする際のカテゴリ。
 * `broken` (possibilities=0) は overlay 扱いで `brokenSeats` の Set に別管理する。
 *
 * - `mainCo`: 占い系 / 霊系 (category === 'seer' | 'medium')
 * - `supportCo`: それ以外の villager 系 CO (狩・共・猫・将来増える村役職) と、レアな非村役職 CO
 * - `nonCoNotGray`: 非 CO + 占い判定対象になったことのある席
 * - `nonCoGray`: 非 CO + 占い判定なし
 */
export type SeatCategory = 'mainCo' | 'supportCo' | 'nonCoNotGray' | 'nonCoGray'

/** mainCo 判定 (= 占い / 霊 系 CO)。 systemRoles の category で動的判定し、 新役職追加に追従する。 */
function isMainCoRole(claimingRole: string): boolean {
  const role = systemRoles.get(claimingRole as SystemRole)
  return role?.category === 'seer' || role?.category === 'medium'
}

/**
 * preprocess フックの戻り値型。 string を返すと従来どおり lineOffset 0 扱い (後方互換)。
 * prepend 等で行数が変わる変換は { text, lineOffset } を返すこと。
 * lineOffset = parse 入力の先頭に増えた行数 (editor 座標 → parse 座標の +オフセット)。
 */
export type PreprocessResult = { text: string, lineOffset: number }

/**
 * editor のテキストを parse 直前に変換するフック。
 * 返した文字列が howl parser への入力になる。 editor 表示自体は変えない。
 *
 * 用途: マクロ展開、 consumer 固有のショートカット記法、テンプレ注入など。
 * 例外を投げた場合は元の text にフォールバックする (safeParse と同じ方針)。
 *
 * prepend など行数が変わる変換を入れる場合は string ではなく PreprocessResult を返し、
 * lineOffset に前置した行数 K を入れること。 AnalysisContext は cursor と statement.line /
 * sourceLines を K だけシフトしてエディタ座標と parse 座標のズレを吸収する。
 */
export type HowlPreprocessor = (text: string) => string | PreprocessResult

/**
 * createAnalysisContext / new AnalysisContext のオプション。
 */
export type AnalysisContextOptions = {
  /** editor テキスト → parse 入力 の変換フック */
  preprocess?: HowlPreprocessor
}

const EMPTY_SOURCE_LINES: SourceLines = {
  survivor: new Map(), claimRow: new Map(), claimCell: new Map(),
  kill: new Map(), exec: new Map(), vote: new Map(),
}

const NIGHT_KILL_CAUSES: Set<CauseOfDeath> = new Set([
  'night_kill', 'follow_killed_hamster', 'cursed_by_killed_nekomata',
])

const EXECUTION_CAUSES: Set<CauseOfDeath> = new Set([
  'execution', 'cursed_by_executed_nekomata', 'follow_executed_hamster',
])

// =====================================================================
// Helpers
// =====================================================================

function buildSourceLines(statements: Statement[], dict: FlexibleDictionary): SourceLines {
  const survivor = new Map<number, number>()
  const claimRow = new Map<number, number>()
  const claimCell = new Map<string, number>()
  const kill = new Map<number, number>()
  const exec = new Map<number, number>()
  const vote = new Map<number, number>()

  function resolve(name: string): number {
    const res = dict.search(name)
    return res.length > 0 ? Number(res[0]) : -1
  }

  for (const stmt of statements) {
    const line = stmt.line
    const s = stmt as Statement & Record<string, unknown>
    switch (s.type) {
      case 'join':
        survivor.set(resolve(s.name as string), line)
        break
      case 'joinMulti':
        for (const name of s.players as string[]) survivor.set(resolve(name), line)
        break
      case 'vote':
        vote.set(resolve(s.voter as string), line)
        break
      case 'multiVote':
        for (const name of s.voters as string[]) vote.set(resolve(name), line)
        break
      case 'attack':
      case 'peace':
      case 'curse':
      case 'follow':
        kill.set(((s.day as number | undefined) ?? 1) - 1, line)
        break
      case 'lynch':
        exec.set(s.day as number, line)
        break
      case 'assert': {
        const seat = resolve(s.actor as string)
        claimRow.set(seat, line)
        const day = (s.day as number | undefined) ?? 1
        const lastNight = day - 1
        const assertions = (s.assertions as Array<Record<string, unknown>> | undefined) ?? []
        const divResults = assertions.filter(a => a.target && a.result)
        for (let i = 0; i < divResults.length; i++) {
          const night = lastNight - (divResults.length - 1 - i)
          claimCell.set(`${seat}:${night}`, line)
        }
        const guardTargets = assertions.filter(a => a.action === 'guard')
        for (let i = 0; i < guardTargets.length; i++) {
          const night = lastNight - (guardTargets.length - 1 - i)
          claimCell.set(`${seat}:${night}`, line)
        }
        break
      }
      case 'mason':
        for (const name of s.players as string[]) claimRow.set(resolve(name), line)
        break
    }
  }

  return { survivor, claimRow, claimCell, kill, exec, vote }
}

type ParsedResult = { meta: Record<string, unknown>, statements: Statement[] }

function safeParse(text: string, cursorLine?: number): ParsedResult {
  try {
    const result = cursorLine != null
      ? parse(text, { cursorLine })
      : parse(text)
    return { meta: result.meta as Record<string, unknown>, statements: result.statements }
  } catch {
    return { meta: {}, statements: [] }
  }
}

/**
 * preprocess フックの戻り値を PreprocessResult に正規化する。
 * - undefined / 例外時は元の text + lineOffset 0 にフォールバック (safeParse と同じ方針)
 * - string 戻りは lineOffset 0 に揃える (後方互換)
 * - lineOffset は非負整数に丸める (防御)
 */
function normalizePreprocess(
  preprocess: HowlPreprocessor | undefined,
  text: string,
): PreprocessResult {
  if (!preprocess) return { text, lineOffset: 0 }
  try {
    const out = preprocess(text)
    if (typeof out === 'string') return { text: out, lineOffset: 0 }
    return { text: out.text, lineOffset: Math.max(0, Math.floor(out.lineOffset)) }
  } catch {
    return { text, lineOffset: 0 }
  }
}

/**
 * statement.line を parse 座標 → editor 座標へシフトする。
 * offset === 0 のときは元配列をそのまま返し、コピーと reactivity churn を回避する。
 */
function shiftStatementLines(statements: Statement[], offset: number): Statement[] {
  if (offset === 0) return statements
  return statements.map(s => ({ ...s, line: s.line - offset }))
}

/**
 * SourceLines の値 (parse 座標) を editor 座標へシフトする。
 * offset === 0 のときは元 Map をそのまま返す。
 */
function shiftSourceLines(src: SourceLines, offset: number): SourceLines {
  if (offset === 0) return src
  const shiftNum = (m: Map<number, number>) =>
    new Map([...m].map(([k, v]) => [k, v - offset] as const))
  const shiftStr = (m: Map<string, number>) =>
    new Map([...m].map(([k, v]) => [k, v - offset] as const))
  return {
    survivor:  shiftNum(src.survivor),
    claimRow:  shiftNum(src.claimRow),
    claimCell: shiftStr(src.claimCell),
    kill:      shiftNum(src.kill),
    exec:      shiftNum(src.exec),
    vote:      shiftNum(src.vote),
  }
}

type Bridge = ReturnType<typeof buildVillageStatus>

function safeBuildVillage(parsed: ParsedResult): Bridge | null {
  if (parsed.statements.length === 0) return null
  try {
    return buildVillageStatus(parsed.statements, parsed.meta)
  } catch {
    return null
  }
}

// =====================================================================
// AnalysisContext class
// =====================================================================

export class AnalysisContext {
  // -----------------------------------------------------------------
  // 入力 — 外部から書き換え可能
  // -----------------------------------------------------------------

  howlText = $state('')
  cursorLine = $state(0)
  /**
   * UI 由来 assumption (席を手動クリックでセット)。
   * spoiler 由来 ([spoilerAssumptions](#spoilerAssumptions)) とは別に保持し、
   * retar への入力と UI 表示には [mergedAssumptions](#mergedAssumptions) を参照する。
   */
  assumptions = $state<Map<number, SystemRole>>(new Map())
  hocusPocusSeats = $state<Set<number>>(new Set())
  denyWolfGroups = $state<number[][]>([])
  forceTs = $state(false)
  /**
   * .howl の spoiler 行を retar 解析に反映するか。 false にすると spoiler 由来の
   * assumption / faction deny は全て無効化され、 公開情報のみで解析される。
   * UI トグル ([AnalysisTable](panes/AnalysisTable.svelte) footer) で操作。
   */
  spoilerEnabled = $state(true)

  // -----------------------------------------------------------------
  // 派生 — parse → bridge → ...
  // -----------------------------------------------------------------

  #preprocess: HowlPreprocessor | undefined

  // editor 座標 ↔ parse 座標 の橋渡し。 #pre は preprocess の戻り値を正規化したもの。
  // cursor を parse へ渡すときに +lineOffset、 statement.line / sourceLines を
  // editor へ公開するときに -lineOffset することで両座標系のズレを吸収する。
  #pre = $derived.by<PreprocessResult>(() => normalizePreprocess(this.#preprocess, this.howlText))
  #parseSource = $derived.by<string>(() => this.#pre.text)
  /** preprocess の lineOffset (= prefix 行数 K)。デバッグ用に公開。 */
  lineOffset = $derived.by<number>(() => this.#pre.lineOffset)

  #fullParsed = $derived.by<ParsedResult>(() => safeParse(this.#parseSource))
  // cursorLine === 0 は「未確定」のセンチネルなのでシフトしない。 > 0 のときだけ +K。
  #parsed = $derived.by<ParsedResult>(() =>
    safeParse(
      this.#parseSource,
      this.cursorLine > 0 ? this.cursorLine + this.#pre.lineOffset : this.cursorLine,
    )
  )
  #bridge = $derived.by<Bridge | null>(() => safeBuildVillage(this.#parsed))

  meta = $derived(this.#parsed.meta)
  // 公開する statements は editor 座標 (-lineOffset)。 内部消費 (#bridge / currentEvents /
  // buildSourceLines への入力 / parsedLines) は this.#parsed.statements を直接使い続けること。
  statements = $derived(shiftStatementLines(this.#parsed.statements, this.#pre.lineOffset))
  /** cursor フィルタを掛けない全 statements。editor の syntax highlight 用 (editor 座標)。 */
  fullStatements = $derived(shiftStatementLines(this.#fullParsed.statements, this.#pre.lineOffset))

  parsedLines = $derived(stringifyStatements(this.#parsed.statements))
  statementLines = $derived(this.#parsed.statements.map(s => s.line - this.#pre.lineOffset))

  villageStatus = $derived.by<VillageStatus | null>(() => {
    const vs = this.#bridge?.vs
    if (!vs) return null
    if (this.spoilerEnabled) return vs
    const spoilerDeny = this.#bridge?.spoilerDeniedRoles
    if (!spoilerDeny || spoilerDeny.size === 0) return vs
    // spoiler 無視: 各 SeatStatus.deniedRoles から spoiler 由来分を除外した shallow copy。
    // 他の VS フィールドは worker への JSON シリアライズで読まれるだけなので参照共有でよい。
    const newStatuses = new Map<number, SeatStatus>()
    for (const [seat, status] of vs.statuses) {
      const denySet = spoilerDeny.get(seat)
      if (!denySet || denySet.size === 0) {
        newStatuses.set(seat, status)
      } else {
        newStatuses.set(seat, {
          ...status,
          deniedRoles: status.deniedRoles.filter(r => !denySet.has(r)),
        })
      }
    }
    return { ...vs, statuses: newStatuses }
  })
  players = $derived<Map<number, string>>(this.#bridge?.players ?? new Map())
  playerShortNames = $derived<Map<number, string>>(this.#bridge?.shortNames ?? new Map())
  setup = $derived<Map<SystemRole, number>>(this.#bridge?.setup ?? new Map())
  /** howl の FlexibleDictionary (editor / sourceLines 用)。bridge 未構築なら null。 */
  dict = $derived<FlexibleDictionary | null>(this.#bridge?.dict ?? null)
  sourceLines = $derived<SourceLines>(
    this.#bridge
      ? shiftSourceLines(buildSourceLines(this.#parsed.statements, this.#bridge.dict), this.#pre.lineOffset)
      : EMPTY_SOURCE_LINES
  )
  currentEvents = $derived<GameEvent[]>(
    this.#bridge
      ? statementsToPublicEvents(this.#parsed.statements, this.#bridge.dict).map(de => de.event)
      : []
  )

  analysisColumns = $derived.by<SystemRole[]>(() => {
    const roleOrder = [...systemRoles.keys()] as SystemRole[]
    return roleOrder.filter(r => this.setup.has(r))
  })

  /**
   * .howl の spoiler 行 (`!Alice=seer` / frontmatter `spoilers.roles`) から派生する assumption。
   * 「実 spoiler」 (= .howl に書かれた値、 トグル状態に依存しない)。 UI でボタン表示
   * の有無を判定するときに参照する。 解析・表示に効くのは [spoilerAssumptions](#spoilerAssumptions)。
   */
  rawSpoilerAssumptions = $derived<Map<number, SystemRole>>(this.#bridge?.assumptions ?? new Map())

  /**
   * spoiler faction alias 由来の deny。 「実値」 (トグル状態に依存しない)。
   * UI でボタン表示判定に使う。 解析・表示に効くのは [spoilerDeniedRoles](#spoilerDeniedRoles)。
   */
  rawSpoilerDeniedRoles = $derived<Map<number, Set<SystemRole>>>(this.#bridge?.spoilerDeniedRoles ?? new Map())

  /**
   * spoiler 行から派生する assumption (= 解析・UI で実効的に使われる値)。
   * spoilerEnabled が false なら空 Map になる。 bridge が解析済みなので read-only。
   * UI からは toggle できない (toggleAssumption がガード)。
   */
  spoilerAssumptions = $derived<Map<number, SystemRole>>(
    this.spoilerEnabled ? this.rawSpoilerAssumptions : new Map()
  )

  /**
   * spoiler 由来と UI 由来の assumption をマージしたもの。 衝突時は spoiler 優先。
   * retar worker への入力と UI 表示の両方で参照する。
   */
  mergedAssumptions = $derived<Map<number, SystemRole>>(
    mergeAssumptions(this.spoilerAssumptions, this.assumptions)
  )

  /**
   * spoiler faction alias 由来で deny された SystemRole 集合 (= 実効値)。
   * spoilerEnabled が false なら空 Map。 retar 側へは [villageStatus](#villageStatus) の
   * SeatStatus.deniedRoles 経由で渡るので worker payload は触らず、 UI 上で
   * 「spoiler 由来で消えたセル」を色違い表示するためにのみ使う。
   */
  spoilerDeniedRoles = $derived<Map<number, Set<SystemRole>>>(
    this.spoilerEnabled ? this.rawSpoilerDeniedRoles : new Map()
  )

  /** .howl 内に spoiler 行があるか (= UI トグルボタンを表示すべきか)。 */
  hasSpoilers = $derived<boolean>(
    this.rawSpoilerAssumptions.size > 0 || this.rawSpoilerDeniedRoles.size > 0
  )

  // -----------------------------------------------------------------
  // 死亡カテゴリ・確定状態の派生
  // -----------------------------------------------------------------

  deadSeats = $derived<Set<number>>(
    this.villageStatus
      ? new Set([...this.villageStatus.statuses.entries()]
          .filter(([, s]) => !s.surviving)
          .map(([seat]) => seat))
      : new Set()
  )

  nightKilledSeats = $derived<Set<number>>(
    this.villageStatus
      ? new Set([...this.villageStatus.statuses.entries()]
          .filter(([, s]) => !s.surviving && s.causeOfDeath && NIGHT_KILL_CAUSES.has(s.causeOfDeath))
          .map(([seat]) => seat))
      : new Set()
  )

  executedSeats = $derived<Set<number>>(
    this.villageStatus
      ? new Set([...this.villageStatus.statuses.entries()]
          .filter(([, s]) => !s.surviving && s.causeOfDeath && EXECUTION_CAUSES.has(s.causeOfDeath))
          .map(([seat]) => seat))
      : new Set()
  )

  claimShortNames = $derived<Map<number, string>>(
    this.villageStatus
      ? new Map([...this.villageStatus.statuses.entries()]
          .filter(([, s]) => s.claiming)
          .map(([seat, s]) => [seat, systemRoles.get(s.claimingRole as SystemRole)?.shortName ?? s.claimingRole as string] as const))
      : new Map()
  )

  // -----------------------------------------------------------------
  // 席カテゴリ — AnalysisTable のグルーピング用
  // -----------------------------------------------------------------

  /** seer / medium 系 CO の assertions.target に含まれた席 (= 占い判定対象になった席)。 */
  divinedSeats = $derived.by<Set<number>>(() => {
    const result = new Set<number>()
    const vs = this.villageStatus
    if (!vs) return result
    for (const status of vs.statuses.values()) {
      if (!status.claiming) continue
      if (!isMainCoRole(status.claimingRole)) continue
      for (const assertion of status.assertions.values()) {
        if (typeof assertion.target === 'number') result.add(assertion.target)
      }
    }
    return result
  })

  /** 各席を 4 カテゴリに分類する。 `broken` (possibilities=0) は別管理 ([brokenSeats](#brokenSeats))。 */
  seatCategory = $derived.by<Map<number, SeatCategory>>(() => {
    const result = new Map<number, SeatCategory>()
    const vs = this.villageStatus
    if (!vs) return result
    const divined = this.divinedSeats
    for (const seat of this.players.keys()) {
      const s = vs.statuses.get(seat)
      if (s?.claiming) {
        result.set(seat, isMainCoRole(s.claimingRole) ? 'mainCo' : 'supportCo')
      } else {
        result.set(seat, divined.has(seat) ? 'nonCoNotGray' : 'nonCoGray')
      }
    }
    return result
  })

  /** カテゴリ → 席番号配列 (seat 番号順)。 [AnalysisTable](panes/AnalysisTable.svelte) の CO 別レイアウト用。 */
  seatsByCategory = $derived.by<Record<SeatCategory, number[]>>(() => {
    const result: Record<SeatCategory, number[]> = {
      mainCo: [], supportCo: [], nonCoNotGray: [], nonCoGray: [],
    }
    const cat = this.seatCategory
    for (const seat of this.players.keys()) {
      const c = cat.get(seat)
      if (c) result[c].push(seat)
    }
    return result
  })

  // -----------------------------------------------------------------
  // 解析結果 — worker から書き込まれる
  // -----------------------------------------------------------------

  analysisSeats = $state<SeatResult[]>([])
  analysisError = $state('')
  analyzing = $state(false)
  analysisDuration = $state(0)
  analysisStats = $state<AnalysisStats | null>(null)
  baseAnalysisSeats = $state<SeatResult[]>([])

  allRolesDetermined = $derived<boolean>(
    this.analysisSeats.length > 0
    && this.players.size > 0
    && this.analysisSeats.length === this.players.size
    && this.analysisSeats.every(s => s.roles.length === 1)
  )

  /** possibilities=0 となった破綻席。 元カテゴリと重畳して、 行 highlight で示す。 */
  brokenSeats = $derived<Set<number>>(
    new Set(this.analysisSeats.filter(s => s.roles.length === 0).map(s => s.seat))
  )

  // -----------------------------------------------------------------
  // 解析派生
  // -----------------------------------------------------------------

  wolfPairSuggestions = $state<WolfPairSuggestion[]>([])

  // -----------------------------------------------------------------
  // Cross-pane イベントバス
  // -----------------------------------------------------------------

  #seekListeners = new Set<(ev: SeekEvent) => void>()
  #jumpListeners = new Set<(ev: JumpEvent) => void>()
  #externalLoadListeners = new Set<(text: string) => void>()
  #cursorChangeListeners = new Set<(line: number) => void>()

  onSeek(listener: (ev: SeekEvent) => void): () => void {
    this.#seekListeners.add(listener)
    return () => { this.#seekListeners.delete(listener) }
  }

  emitSeek(ev: SeekEvent): void {
    for (const fn of this.#seekListeners) fn(ev)
  }

  onJump(listener: (ev: JumpEvent) => void): () => void {
    this.#jumpListeners.add(listener)
    return () => { this.#jumpListeners.delete(listener) }
  }

  jumpTo(ev: JumpEvent): void {
    for (const fn of this.#jumpListeners) fn(ev)
  }

  /**
   * 「外部 (InspectPane 等) から howl を読み込んだ」イベントを購読する。
   * consumer (demo 等) は trial mode への遷移・動画リセット・保存抑止などの副作用を扱う。
   */
  onExternalLoad(listener: (text: string) => void): () => void {
    this.#externalLoadListeners.add(listener)
    return () => { this.#externalLoadListeners.delete(listener) }
  }

  /**
   * 外部ペインから howl を読み込む。howlText を更新しつつ onExternalLoad listener も通知する。
   * editor onChange 経由の更新と区別するために、外部ペインは this method を使う。
   */
  loadHowl(text: string): void {
    this.howlText = text
    for (const fn of this.#externalLoadListeners) fn(text)
  }

  /**
   * editor 内で cursor が動いたとき (CodeMirror onCursorChange 由来) のみ発火するイベント。
   * `ctx.cursorLine = X` の単純な代入 (goToDay 等) では発火しない。
   *
   * 用途: consumer が「ユーザーの cursor 移動」と「プログラム的な cursor 設定」を区別したい場合
   * (例: video sync 解除、demo 派生 state 更新の trigger)。$effect で ctx.cursorLine を watch すると
   * runWithCursorInner 等の内部書き戻しで無限ループになるため、この event bus 経由が安全。
   */
  onCursorChange(listener: (line: number) => void): () => void {
    this.#cursorChangeListeners.add(listener)
    return () => { this.#cursorChangeListeners.delete(listener) }
  }

  emitCursorChange(line: number): void {
    for (const fn of this.#cursorChangeListeners) fn(line)
  }

  // -----------------------------------------------------------------
  // 仮説 (assumptions / denyWolfGroups / hocusPocusSeats) 操作 API
  // -----------------------------------------------------------------

  /**
   * 席 × 役職 の役職仮定をトグルする。既に同じ仮定があれば解除、なければ設定。
   * 別役職の仮定があれば上書き (1 席につき 1 仮定)。
   * spoiler 由来 assumption がある席は no-op (.howl テキスト側で消す必要がある)。
   */
  toggleAssumption(seat: number, role: SystemRole): void {
    if (this.spoilerAssumptions.has(seat)) return
    const next = new Map(this.assumptions)
    if (next.get(seat) === role) next.delete(seat)
    else next.set(seat, role)
    this.assumptions = next
  }

  /** その席の CO を無視して解析する hocuspocus フラグをトグルする。 */
  toggleHocusPocus(seat: number): void {
    const next = new Set(this.hocusPocusSeats)
    if (next.has(seat)) next.delete(seat)
    else next.add(seat)
    this.hocusPocusSeats = next
  }

  /** assumptions / denyWolfGroups / hocusPocusSeats を全てクリアする。 */
  clearAssumptions(): void {
    this.assumptions = new Map()
    this.denyWolfGroups = []
    this.hocusPocusSeats = new Set()
  }

  /** denyWolfGroups の index 番目を削除する。 */
  removeDenyWolfGroup(index: number): void {
    this.denyWolfGroups = this.denyWolfGroups.filter((_, i) => i !== index)
  }

  /**
   * wolfPairSuggestions の 1 件を denyWolfGroups に昇格させる。
   * suggestion 一覧からは即座に取り除く (Retar 再解析で再生成される)。
   */
  addSuggestion(suggestion: WolfPairSuggestion): void {
    const group = [suggestion.seatA, suggestion.seatB]
    this.denyWolfGroups = [...this.denyWolfGroups, group]
    this.wolfPairSuggestions = this.wolfPairSuggestions.filter(s =>
      !(s.seatA === suggestion.seatA && s.seatB === suggestion.seatB)
    )
  }

  /**
   * 配役が確定 (allRolesDetermined === true) しているときに、確定役職を
   * `Player=役職名` 行の集合として howlText に書き込む。
   * 既存の reveal 行があれば、最初の reveal 行の位置で新ブロックに置換し、
   * それ以外の reveal 行は削除する。 reveal 行が無ければ末尾に追加する。
   * 書き込み後はエディタのカーソルをファイル末尾に強制移動する
   * (howlText 差し替えで CodeMirror 側のカーソルが先頭にリセットされるのを防ぐ)。
   * jumpTo は EditorPane の doc 同期 $effect が走った後に呼ぶ必要があるため tick を待つ。
   * 未確定なら no-op。 AnalysisTable の挿入ボタンの default 動作。
   */
  async insertRevealRoles(): Promise<void> {
    if (!this.allRolesDetermined) return
    const newLines = this.analysisSeats.map(s => {
      const name = this.players.get(s.seat) ?? `#${s.seat}`
      const roleName = systemRoles.get(s.roles[0])?.name ?? s.roles[0]
      return `${name}=${roleName}`
    })
    const revealLineNumbers = new Set(
      this.fullStatements
        .filter(s => s.type === 'reveal' && s.line >= 1)
        .map(s => s.line)
    )
    if (revealLineNumbers.size === 0) {
      this.howlText = this.howlText + '\n' + newLines.join('\n')
    } else {
      const insertAt = Math.min(...revealLineNumbers)
      const lines = this.howlText.split('\n')
      const kept: string[] = []
      for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1
        if (lineNo === insertAt) {
          kept.push(...newLines)
        } else if (!revealLineNumbers.has(lineNo)) {
          kept.push(lines[i])
        }
      }
      this.howlText = kept.join('\n')
    }
    const lastLine = this.howlText.split('\n').length
    await tick()
    this.jumpTo({ line: lastLine })
  }

  // -----------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------

  #cleanup: (() => void) | null = null
  #analysisEpoch = 0
  #destroyed = false

  constructor(options: AnalysisContextOptions = {}) {
    this.#preprocess = options.preprocess
    this.#cleanup = $effect.root(() => {
      // 解析リクエスト: 入力変更で発火
      $effect(() => {
        const vs = this.villageStatus
        const setup = this.setup
        if (!vs || setup.size === 0) {
          this.analysisSeats = []
          this.baseAnalysisSeats = []
          this.analysisStats = null
          this.analysisError = ''
          this.wolfPairSuggestions = []
          return
        }

        const players = this.players
        const mergedAssumptions = this.mergedAssumptions
        const hocusPocusSeats = this.hocusPocusSeats
        const denyWolfGroups = this.denyWolfGroups
        const forceTs = this.forceTs

        const payload = {
          vsJson: JSON.stringify(serializeVillageStatus(vs)),
          setupJson: JSON.stringify(Object.fromEntries(setup)),
          players: [...players],
          assumptions: [...mergedAssumptions],
          wolfPairDenyals: denyWolfGroups.map(g => [g[0], g[1]] as [number, number]),
          hocusPocus: [...hocusPocusSeats],
          forceTs,
        }
        this.analyzing = true
        const start = performance.now()
        const epoch = ++this.#analysisEpoch

        requestAnalysis(payload, (data) => {
          if (this.#destroyed) return
          if (epoch !== this.#analysisEpoch) return

          this.analyzing = false
          this.analysisDuration = Math.round(performance.now() - start)

          if (data.type === 'result') {
            this.analysisSeats = data.seats
            this.analysisError = ''
            this.analysisStats = data.stats
            if (this.assumptions.size === 0) this.baseAnalysisSeats = data.seats

            if ((setup.get('werewolf' as SystemRole) ?? 0) >= 2) {
              const wolfCandidates = new Set(
                data.seats.filter(s => s.roles.includes('werewolf' as SystemRole)).map(s => s.seat)
              )
              this.wolfPairSuggestions = scoreWolfPairs(vs, players, denyWolfGroups, wolfCandidates)
            } else {
              this.wolfPairSuggestions = []
            }
          } else {
            this.analysisSeats = []
            this.analysisError = data.message
            this.analysisStats = null
            this.wolfPairSuggestions = []
          }
        })
      })

    })
  }

  destroy(): void {
    this.#destroyed = true
    this.#cleanup?.()
    this.#cleanup = null
    this.#seekListeners.clear()
    this.#jumpListeners.clear()
    this.#externalLoadListeners.clear()
    this.#cursorChangeListeners.clear()
  }
}

/**
 * AnalysisContext のインスタンスを作成する。
 *
 * 使用例:
 * ```svelte
 * <script lang="ts">
 *   import { onDestroy } from 'svelte'
 *   import { createAnalysisContext, EditorPane, StatusPane } from 'horkew/lykaon'
 *
 *   const ctx = createAnalysisContext()
 *   onDestroy(() => ctx.destroy())
 * </script>
 *
 * <EditorPane {ctx} />
 * <StatusPane {ctx} />
 * ```
 */
export function createAnalysisContext(options: AnalysisContextOptions = {}): AnalysisContext {
  return new AnalysisContext(options)
}
