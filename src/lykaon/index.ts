/**
 * lykaon — howl 解析 UI ライブラリ
 *
 * demo の解析中核 (Status / Inspect / Hati / Editor) を切り出した
 * Svelte 5 + Vite 専用モジュール。`createAnalysisContext()` で共有 state を作り、
 * 個別ペインに `ctx` を渡して構成する。
 *
 * 使用例:
 * ```svelte
 * <script lang="ts">
 *   import { onDestroy } from 'svelte'
 *   import {
 *     createAnalysisContext,
 *     EditorPane, StatusPane, HatiPane, InspectPane,
 *   } from 'horkew/lykaon'
 *   import 'horkew/lykaon/theme.css'
 *
 *   const ctx = createAnalysisContext()
 *   onDestroy(() => ctx.destroy())
 * </script>
 *
 * <EditorPane {ctx} />
 * <StatusPane {ctx} />
 * <HatiPane {ctx} />
 * <InspectPane {ctx} />
 * ```
 */

export {
  AnalysisContext,
  createAnalysisContext,
  type AnalysisContextOptions,
  type HowlPreprocessor,
  type PreprocessResult,
  type SeekEvent,
  type JumpEvent,
  type SourceLines,
  type SeatResult,
  type AnalysisStats,
  type WolfPairSuggestion,
  type StringifiedLine,
} from './AnalysisContext.svelte.ts'

export { default as EditorPane } from './panes/EditorPane.svelte'
export { default as StatusPane } from './panes/StatusPane.svelte'
export { default as HatiPane } from './panes/HatiPane.svelte'
export { default as InspectPane } from './panes/InspectPane.svelte'
export { default as AnalysisTable } from './panes/AnalysisTable.svelte'
