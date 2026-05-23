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

<div class="plain-root">
  <div class="plain-left">
    <EditorPane {ctx} />
  </div>
  <div class="plain-right">
    <div class="plain-right-top">
      <StatusPane {ctx} />
    </div>
    <div class="plain-right-bottom">
      <AnalysisTable {ctx} />
    </div>
  </div>
</div>

<style>
  .plain-root {
    display: flex;
    height: 100vh;
    width: 100vw;
    background: var(--color-bg-base, #1e1e2e);
    color: var(--color-text, #cdd6f4);
  }
  .plain-left, .plain-right {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
  }
  .plain-left {
    border-right: 1px solid var(--color-border, #45475a);
  }
  .plain-right {
    display: flex;
    flex-direction: column;
  }
  .plain-right-top, .plain-right-bottom {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
  }
  .plain-right-top {
    border-bottom: 1px solid var(--color-border, #45475a);
  }
</style>
