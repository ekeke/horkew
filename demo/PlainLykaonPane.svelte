<script lang="ts">
  import { onDestroy } from 'svelte'
  import { createAnalysisContext, LykaonLayout } from '../src/lykaon/index.ts'
  import '../src/lykaon/theme.css'
  import siren3Text from '../src/retar/scenarios/siren3.howl?raw'

  const ctx = createAnalysisContext()
  ctx.howlText = siren3Text
  onDestroy(() => ctx.destroy())
</script>

<div class="plain-root">
  <LykaonLayout {ctx} />
</div>

<style>
  .plain-root {
    height: 100vh;
    width: 100vw;
  }
</style>
