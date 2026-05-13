/**
 * AnalysisContext — lykaon の共有 state factory
 *
 * Phase 1 のスケルトン。API surface のみ確定させて、実装は Phase 5 で行う。
 * パース・解析パイプラインの全 state と cross-pane イベントバスを 1 つの class に集約する。
 *
 * 設計方針:
 *   - howlText / cursorLine / assumptions などの「入力」は writable $state
 *   - parsed / villageStatus / sourceLines などの「派生」は $derived getter
 *   - 解析結果は worker から writable $state に書き込まれる
 *   - editor ↔ pane / 動画 player との通信は onSeek / onJump のイベントバスで疎結合化
 *
 * 注: 本ファイルは Phase 1 の design proposal。Phase 2 で worker / scheduler が
 *     src/lykaon/ に移管された後、Phase 5 で実装本体を埋める。
 */

import type { SystemRole, VillageStatus } from '../types/index.ts'
import type { GameEvent } from '../lupa/index.ts'

// =====================================================================
// 共通型定義（Phase 2 で各ファイルへ分割移管されるが、ここに置く）
// =====================================================================

/**
 * howl テキスト内の論理要素 → 行番号のマップ。
 * editor のシンタックスハイライト連動と pane → editor ジャンプに使う。
 * （現状は demo/App.svelte L44-51 の SourceLines 型と同一）
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
 * host が onSeek() で購読し、YouTube/Nico player の seek に繋ぐ。
 */
export type SeekEvent = {
  seconds: number
  line: number
}

/**
 * pane → editor の「この行にジャンプ」要求。
 * EditorPane が onJump() で購読し、CodeMirror のカーソルを移動する。
 */
export type JumpEvent = {
  line: number
  column?: number
}

/**
 * 1 席分の解析結果。
 * Phase 2 で src/lykaon/analysis.worker.ts に移管後、そこから import 予定。
 */
// TODO Phase 2: import type { SeatResult } from './analysis.worker.ts'
export type SeatResult = {
  seat: number
  roles: SystemRole[]
  // ... 詳細は demo/analysis.worker.ts に準ずる
}

/**
 * 解析統計（workers 数、wall-clock 時間など）。
 * Phase 2 で src/lykaon/scheduler.ts から import 予定。
 */
// TODO Phase 2: import type { AnalysisStats } from './scheduler.ts'
export type AnalysisStats = {
  workers: number
  minElapsed: number
  maxElapsed: number
  wallClock: number
  wasm: boolean
}

/**
 * 狼ペア候補のスコアリング結果。
 * Phase 2 で src/lykaon/status/wolfPairScorer.ts から import 予定。
 */
// TODO Phase 2: import type { WolfPairSuggestion } from './status/wolfPairScorer.ts'
export type WolfPairSuggestion = {
  pair: [number, number]
  score: number
}

/**
 * stringifyStatements の 1 行分の構造化情報。
 * Phase 2 で src/lykaon/stringify.ts から import 予定。
 */
// TODO Phase 2: import type { StringifiedLine } from './stringify.ts'
export type StringifiedLine = {
  line: number
  // ... 詳細は demo/stringify.ts に準ずる
}

// =====================================================================
// AnalysisContext class
// =====================================================================

export class AnalysisContext {
  // -----------------------------------------------------------------
  // 入力 — 外部から書き換え可能
  // -----------------------------------------------------------------

  /** .howl テキスト本体。editor が bind:howlText で書き換え、すべての解析の起点。 */
  howlText = $state('')

  /**
   * editor のカーソル位置（1-indexed）。
   * parse() の `cursorLine` オプションに渡され、ここまでの statements で解析対象が決まる。
   * 動画 sync 時は動画位置から逆引きでセットされる。
   */
  cursorLine = $state(0)

  // -----------------------------------------------------------------
  // 入力 — ユーザー操作 (assumption / hocus pocus / wolf pair denial / forceTs)
  // -----------------------------------------------------------------

  /** seat → 確定役職の仮定マップ。StatusPane のクリックで更新。 */
  assumptions = $state<Map<number, SystemRole>>(new Map())

  /** CO を無視する席の集合（仮想シナリオ用、devMode）。 */
  hocusPocusSeats = $state<Set<number>>(new Set())

  /** 「この組は狼ペアではない」と仮定する 2 席組の配列。 */
  denyWolfGroups = $state<number[][]>([])

  /** Retar WASM を無効化し、TS 実装で解析する（devMode 用）。 */
  forceTs = $state(false)

  // -----------------------------------------------------------------
  // 派生 — howlText / cursorLine から計算（実装は Phase 5）
  // -----------------------------------------------------------------

  /** frontmatter の YAML 解析結果。 */
  get meta(): Record<string, unknown> {
    throw new Error('AnalysisContext.meta: not implemented (Phase 5)')
  }

  /** parse() の statements 結果。 */
  get statements(): unknown[] {
    throw new Error('AnalysisContext.statements: not implemented (Phase 5)')
  }

  /** stringifyStatements の結果（statement → 行情報）。 */
  get parsedLines(): StringifiedLine[] {
    throw new Error('AnalysisContext.parsedLines: not implemented (Phase 5)')
  }

  /** 各 statement が howl テキスト内の何行目か。 */
  get statementLines(): number[] {
    throw new Error('AnalysisContext.statementLines: not implemented (Phase 5)')
  }

  /** buildVillageStatus の結果。null は未パース or パース失敗。 */
  get villageStatus(): VillageStatus | null {
    throw new Error('AnalysisContext.villageStatus: not implemented (Phase 5)')
  }

  /** seat → 表示名のマップ。 */
  get players(): Map<number, string> {
    throw new Error('AnalysisContext.players: not implemented (Phase 5)')
  }

  /** seat → 短縮名のマップ。 */
  get playerShortNames(): Map<number, string> {
    throw new Error('AnalysisContext.playerShortNames: not implemented (Phase 5)')
  }

  /** 役職構成（SystemRole → 人数）。 */
  get setup(): Map<SystemRole, number> {
    throw new Error('AnalysisContext.setup: not implemented (Phase 5)')
  }

  /** seat / claim / kill / exec / vote の行マップ。 */
  get sourceLines(): SourceLines {
    throw new Error('AnalysisContext.sourceLines: not implemented (Phase 5)')
  }

  /** Retar が消費する public な game events。 */
  get currentEvents(): GameEvent[] {
    throw new Error('AnalysisContext.currentEvents: not implemented (Phase 5)')
  }

  // -----------------------------------------------------------------
  // 解析結果 — worker から書き込まれる
  // -----------------------------------------------------------------

  /** assumption / hocusPocus / denyWolfGroups 適用後の解析結果。 */
  analysisSeats = $state<SeatResult[]>([])

  /** 解析対象の役職列。 */
  analysisColumns = $state<SystemRole[]>([])

  /** worker からのエラーメッセージ（空文字なら正常）。 */
  analysisError = $state('')

  /** 解析実行中フラグ。 */
  analyzing = $state(false)

  /** Retar 単体の実行時間（ms）。 */
  analysisDuration = $state(0)

  /** worker 数 / wall clock / wasm フラグなどの統計。 */
  analysisStats = $state<AnalysisStats | null>(null)

  /**
   * assumption / hocusPocus 未適用時の基準解析結果。
   * Gmork の理由付け計算は assumption 適用後と未適用の両方を見る必要があるため別途保持する。
   */
  baseAnalysisSeats = $state<SeatResult[]>([])

  // -----------------------------------------------------------------
  // Gmork 結果（assumption ベースで再計算）
  // -----------------------------------------------------------------

  /** findReason / findConfirmationReason の結果を formatReason で整形した日本語テキスト。 */
  gmorkResult = $state('')

  // -----------------------------------------------------------------
  // 派生情報
  // -----------------------------------------------------------------

  /** scoreWolfPairs の結果。狼ペア候補のスコア順。 */
  wolfPairSuggestions = $state<WolfPairSuggestion[]>([])

  // -----------------------------------------------------------------
  // Cross-pane イベントバス
  // -----------------------------------------------------------------

  #seekListeners = new Set<(ev: SeekEvent) => void>()
  #jumpListeners = new Set<(ev: JumpEvent) => void>()

  /**
   * editor 内の時刻トークン click → 動画 player seek の購読 API。
   * 返り値は unsubscribe 関数。
   *
   * 想定: demo の YouTubePlayer / NicoPlayer が onMount で購読する。
   *       mirurou のような動画 player を持たない consumer は購読しなくて良い。
   */
  onSeek(listener: (ev: SeekEvent) => void): () => void {
    this.#seekListeners.add(listener)
    return () => { this.#seekListeners.delete(listener) }
  }

  /** editor 側（CodeMirror timeSeekPlugin）が時刻 click 時に呼ぶ。 */
  emitSeek(ev: SeekEvent): void {
    for (const fn of this.#seekListeners) fn(ev)
  }

  /**
   * pane → editor の「この行にジャンプ」要求の購読 API。
   * 返り値は unsubscribe 関数。
   *
   * 想定: EditorPane が onMount で購読し、CodeMirror のカーソル移動を行う。
   */
  onJump(listener: (ev: JumpEvent) => void): () => void {
    this.#jumpListeners.add(listener)
    return () => { this.#jumpListeners.delete(listener) }
  }

  /** StatusPane の行クリックなど、pane 側が呼ぶ。 */
  jumpTo(ev: JumpEvent): void {
    for (const fn of this.#jumpListeners) fn(ev)
  }

  // -----------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------

  /**
   * worker pool の起動、$effect の登録などは Phase 5 で実装。
   * Phase 1 では何もしない。
   */
  constructor() {
    // TODO Phase 5: scheduler の起動、howlText/cursorLine/assumptions → run の $effect 配線
  }

  /**
   * worker terminate、listener clear。
   * consumer 側で `onDestroy(() => ctx.destroy())` を呼ぶ想定。
   */
  destroy(): void {
    this.#seekListeners.clear()
    this.#jumpListeners.clear()
    // TODO Phase 5: scheduler.terminate()
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
