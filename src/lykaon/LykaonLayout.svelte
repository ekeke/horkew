<script lang="ts">
  /*
   * LykaonLayout — エディタ + 解析サイドカーの結合レイアウト (opinionated)。
   *
   * 「ctx を渡すだけで lykaon の標準レイアウト (左: EditorPane / 右: StatusPane +
   * AnalysisTable) を 1:2 で並べる」入口。 比率と最大幅は prop でカスタマイズ可。
   *
   * mirurou など consumer はまずこれを使い、 細かく組みたくなったら個別ペインを
   * 直接 import して自前のレイアウトを書く。
   */
  import EditorPane from './panes/EditorPane.svelte'
  import StatusPane from './panes/StatusPane.svelte'
  import AnalysisTable from './panes/AnalysisTable.svelte'
  import AnalysisErrorBanner from './panes/AnalysisErrorBanner.svelte'
  import type { Snippet } from 'svelte'
  import type { AnalysisContext } from './AnalysisContext.svelte.ts'

  let {
    ctx,
    ratio = [1, 2],
    maxEditorPx = 400,
    hideAssumptions = false,
    readonly = false,
    editorTop,
    editorBottom,
    extraViewOptions,
  }: {
    ctx: AnalysisContext
    /** [左=エディタ, 右=combined] の flex 比率。 default [1, 2] は main demo に準拠 */
    ratio?: [number, number]
    /** エディタ側の最大幅 (px)。 0 で無制限 */
    maxEditorPx?: number
    /** AnalysisTable の右サイドバー (仮説 / 提案) を非表示にする */
    hideAssumptions?: boolean
    /** EditorPane を編集ロックする (内部で EditorPane の readonly に渡る) */
    readonly?: boolean
    /** エディタペインの上に差し込む任意コンテンツ (動画プレイヤー等)。consumer が snippet で渡す */
    editorTop?: Snippet
    /** エディタペインの下に差し込む任意コンテンツ。consumer が snippet で渡す */
    editorBottom?: Snippet
    /** AnalysisTable の表示コントロール群 (列 / 分類ボタン) の後ろに差し込む snippet。 そのまま AnalysisTable の extraViewOptions に渡る */
    extraViewOptions?: Snippet
  } = $props()

  let leftFlex = $derived(ratio[0])
  let rightFlex = $derived(ratio[1])
  let editorMax = $derived(maxEditorPx > 0 ? `${maxEditorPx}px` : 'none')
</script>

<div class="lykaon-layout">
  <div class="layout-left" style:flex="{leftFlex}" style:max-width={editorMax}>
    {#if editorTop}
      <div class="layout-editor-top">{@render editorTop()}</div>
    {/if}
    <div class="layout-editor">
      <EditorPane {ctx} {readonly} />
    </div>
    {#if editorBottom}
      <div class="layout-editor-bottom">{@render editorBottom()}</div>
    {/if}
  </div>
  <div class="layout-right" style:flex="{rightFlex}">
    <AnalysisErrorBanner {ctx} />
    <div class="layout-right-top">
      <StatusPane {ctx} />
    </div>
    <div class="layout-right-bottom">
      <AnalysisTable {ctx} {hideAssumptions} {extraViewOptions} />
    </div>
  </div>
</div>

<style>
  .lykaon-layout {
    display: flex;
    height: 100%;
    width: 100%;
    background: var(--color-bg);
    color: var(--color-text);
  }
  .layout-left, .layout-right {
    min-width: 0;
    overflow: hidden;
  }
  .layout-left {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--color-border);
  }
  .layout-editor-top {
    flex: 0 0 auto;
  }
  .layout-editor {
    flex: 1;
    min-height: 0;
  }
  .layout-editor-bottom {
    flex: 0 0 auto;
  }
  .layout-right {
    display: flex;
    flex-direction: column;
  }
  .layout-right-top {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border-bottom: 1px solid var(--color-border);
  }
  .layout-right-bottom {
    flex: 0 0 auto;
    overflow-x: auto;
  }
</style>
