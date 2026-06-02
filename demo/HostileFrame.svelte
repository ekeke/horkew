<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    createAnalysisContext,
    EditorPane, StatusPane, AnalysisTable,
  } from '../src/lykaon/index.ts'
  import '../src/lykaon/theme.css'
  import siren3Text from '../src/retar/scenarios/siren3.howl?raw'

  const ctx = createAnalysisContext()
  ctx.howlText = siren3Text
  onDestroy(() => ctx.destroy())
</script>

<div class="frame-root">
  <div class="frame-left">
    <EditorPane {ctx} />
  </div>
  <div class="frame-right">
    <div class="frame-right-top">
      <StatusPane {ctx} />
    </div>
    <div class="frame-right-bottom">
      <AnalysisTable {ctx} />
    </div>
  </div>
</div>

<style>
  /* PlainLykaonPane と同じ最小レイアウト (host 責務として lykaon の外で書く) */
  .frame-root {
    display: flex;
    height: 100vh;
    width: 100vw;
    background: var(--color-bg, #1e1e2e);
    color: var(--color-text, #cdd6f4);
  }
  .frame-left, .frame-right {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
  }
  .frame-left {
    border-right: 1px solid var(--color-border, #45475a);
  }
  .frame-right {
    display: flex;
    flex-direction: column;
  }
  .frame-right-top, .frame-right-bottom {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
  }
  .frame-right-top {
    border-bottom: 1px solid var(--color-border, #45475a);
  }
</style>
