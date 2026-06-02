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
  import type { AnalysisContext } from './AnalysisContext.svelte.ts'

  let {
    ctx,
    ratio = [1, 2],
    maxEditorPx = 400,
    hideAssumptions = false,
    readonly = false,
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
  } = $props()

  let leftFlex = $derived(ratio[0])
  let rightFlex = $derived(ratio[1])
  let editorMax = $derived(maxEditorPx > 0 ? `${maxEditorPx}px` : 'none')
</script>

<div class="lykaon-layout">
  <div class="layout-left" style:flex="{leftFlex}" style:max-width={editorMax}>
    <EditorPane {ctx} {readonly} />
  </div>
  <div class="layout-right" style:flex="{rightFlex}">
    <div class="layout-right-top">
      <StatusPane {ctx} />
    </div>
    <div class="layout-right-bottom">
      <AnalysisTable {ctx} {hideAssumptions} />
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
    border-right: 1px solid var(--color-border);
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
