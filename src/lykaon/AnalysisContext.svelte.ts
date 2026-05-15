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

import type { SystemRole, VillageStatus, CauseOfDeath } from '../types/index.ts'
import { systemRoles } from '../types/index.ts'
import type { Statement } from '../howl/statement.ts'
import type { FlexibleDictionary } from '../howl/flexibleDictionary.ts'
import { parse } from '../howl/parser.ts'
import { buildVillageStatus } from '../howl/bridge.ts'
import { statementsToPublicEvents } from '../howl/events-bridge.ts'
import type { GameEvent } from '../lupa/index.ts'
import { findReason, findConfirmationReason } from '../gmork/index.ts'
import { formatReason, formatConfirmationReason } from '../gmork/format.ts'
import { serializeVillageStatus } from '../retar/wasm-helpers.ts'
import { stringifyStatements, type StringifiedLine } from './stringify.ts'
import { scoreWolfPairs, type WolfPairSuggestion } from './status/wolfPairScorer.ts'
import { requestAnalysis, type SeatResult, type AnalysisStats } from './runAnalysis.ts'

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

const EMPTY_SOURCE_LINES: SourceLines = {
  survivor: new Map(), claimRow: new Map(), claimCell: new Map(),
  kill: new Map(), exec: new Map(), vote: new Map(),
}

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
  assumptions = $state<Map<number, SystemRole>>(new Map())
  hocusPocusSeats = $state<Set<number>>(new Set())
  denyWolfGroups = $state<number[][]>([])
  forceTs = $state(false)

  // -----------------------------------------------------------------
  // 派生 — parse → bridge → ...
  // -----------------------------------------------------------------

  #fullParsed = $derived.by<ParsedResult>(() => safeParse(this.howlText))
  #parsed = $derived.by<ParsedResult>(() => safeParse(this.howlText, this.cursorLine))
  #bridge = $derived.by<Bridge | null>(() => safeBuildVillage(this.#parsed))

  meta = $derived(this.#parsed.meta)
  statements = $derived(this.#parsed.statements)
  /** cursor フィルタを掛けない全 statements。editor の syntax highlight 用。 */
  fullStatements = $derived(this.#fullParsed.statements)

  parsedLines = $derived(stringifyStatements(this.#parsed.statements))
  statementLines = $derived(this.#parsed.statements.map(s => s.line))

  villageStatus = $derived<VillageStatus | null>(this.#bridge?.vs ?? null)
  players = $derived<Map<number, string>>(this.#bridge?.players ?? new Map())
  playerShortNames = $derived<Map<number, string>>(this.#bridge?.shortNames ?? new Map())
  setup = $derived<Map<SystemRole, number>>(this.#bridge?.setup ?? new Map())
  /** howl の FlexibleDictionary (editor / sourceLines 用)。bridge 未構築なら null。 */
  dict = $derived<FlexibleDictionary | null>(this.#bridge?.dict ?? null)
  sourceLines = $derived<SourceLines>(
    this.#bridge ? buildSourceLines(this.#parsed.statements, this.#bridge.dict) : EMPTY_SOURCE_LINES
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

  // -----------------------------------------------------------------
  // 解析結果 — worker から書き込まれる
  // -----------------------------------------------------------------

  analysisSeats = $state<SeatResult[]>([])
  analysisError = $state('')
  analyzing = $state(false)
  analysisDuration = $state(0)
  analysisStats = $state<AnalysisStats | null>(null)
  baseAnalysisSeats = $state<SeatResult[]>([])

  // -----------------------------------------------------------------
  // Gmork + 派生
  // -----------------------------------------------------------------

  gmorkResult = $state('')
  wolfPairSuggestions = $state<WolfPairSuggestion[]>([])

  /**
   * GmorkDebugPane から「エディタに読込」した時に、Retar 解析完了後に
   * assumptions へ自動投入される {seat, role}。consumer 側はセットだけ
   * すればよく、解析後のクリアは ctx が自動で行う。
   */
  pendingGmorkEntry = $state<{ seat: number, role: SystemRole } | null>(null)

  // -----------------------------------------------------------------
  // Cross-pane イベントバス
  // -----------------------------------------------------------------

  #seekListeners = new Set<(ev: SeekEvent) => void>()
  #jumpListeners = new Set<(ev: JumpEvent) => void>()
  #externalLoadListeners = new Set<(text: string) => void>()

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
   * 「外部 (InspectPane / GmorkDebugPane 等) から howl を読み込んだ」イベントを購読する。
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

  // -----------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------

  #cleanup: (() => void) | null = null
  #analysisEpoch = 0
  #destroyed = false

  constructor() {
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

        // 突然死は Retar 非対応
        const hasSuddenDeath = [...vs.statuses.values()]
          .some(s => !s.surviving && s.causeOfDeath === ('sudden_death' as CauseOfDeath))
        if (hasSuddenDeath) {
          this.analysisSeats = []
          this.baseAnalysisSeats = []
          this.analysisError = '突然死を含む盤面は解析できません'
          this.analysisStats = null
          this.wolfPairSuggestions = []
          return
        }

        const players = this.players
        const assumptions = this.assumptions
        const hocusPocusSeats = this.hocusPocusSeats
        const denyWolfGroups = this.denyWolfGroups
        const forceTs = this.forceTs

        const payload = {
          vsJson: JSON.stringify(serializeVillageStatus(vs)),
          setupJson: JSON.stringify(Object.fromEntries(setup)),
          players: [...players],
          assumptions: [...assumptions],
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

            // pendingGmorkEntry (GmorkDebugPane からの読込) を assumptions に投入
            if (this.pendingGmorkEntry && this.assumptions.size === 0) {
              const pe = this.pendingGmorkEntry
              this.pendingGmorkEntry = null
              this.assumptions = new Map([[pe.seat, pe.role]])
            }

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

      // Gmork: assumptions と baseAnalysisSeats が変わるたびに再計算
      $effect(() => {
        this.gmorkResult = this.#computeGmork()
      })
    })
  }

  #computeGmork(): string {
    const vs = this.villageStatus
    if (this.assumptions.size !== 1 || !vs) return ''
    const [[seat, role]] = [...this.assumptions]
    const possibilities = new Map(this.baseAnalysisSeats.map(s => [s.seat, new Set(s.roles)]))
    const playerName = this.players.get(seat) ?? `席${seat}`
    const roleName = systemRoles.get(role)?.name ?? role

    const possibleRoles = possibilities.get(seat)
    if (possibleRoles && possibleRoles.size === 1 && possibleRoles.has(role)) {
      const confirmObj = findConfirmationReason(vs, this.setup, seat, role, this.players, possibilities)
      const confirmText = confirmObj ? formatConfirmationReason(confirmObj, role) : 'わかりません'
      return `「${playerName}」が「${roleName}」に確定した理由： ${confirmText}`
    }

    if (possibleRoles && possibleRoles.has(role)) return ''

    const reasonObj = findReason(vs, this.setup, seat, role as SystemRole, possibilities, this.players)
    const reasonText = reasonObj ? formatReason(reasonObj, role) : 'わかりません'
    return `「${playerName}」が「${roleName}」ではありえない理由： ${reasonText}`
  }

  destroy(): void {
    this.#destroyed = true
    this.#cleanup?.()
    this.#cleanup = null
    this.#seekListeners.clear()
    this.#jumpListeners.clear()
    this.#externalLoadListeners.clear()
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
export function createAnalysisContext(): AnalysisContext {
  return new AnalysisContext()
}
