<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children: Snippet } = $props()

  let containerEl: HTMLDivElement | null = $state(null)
  let innerEl: HTMLDivElement | null = $state(null)
  let scale: number = $state(1)

  $effect(() => {
    if (!containerEl || !innerEl) return
    const container = containerEl
    const inner = innerEl
    const recompute = () => {
      const ch = container.clientHeight
      const cw = container.clientWidth
      const nh = inner.scrollHeight
      const nw = inner.scrollWidth
      if (nh > 0 && ch > 0 && nw > 0 && cw > 0) {
        scale = Math.min(ch / nh, cw / nw)
      }
    }
    const ro = new ResizeObserver(recompute)
    ro.observe(container)
    ro.observe(inner)
    const mo = new MutationObserver(recompute)
    mo.observe(inner, { childList: true, subtree: true, attributes: true, characterData: true })
    recompute()
    return () => { ro.disconnect(); mo.disconnect() }
  })
</script>

<div class="fit-container" bind:this={containerEl}>
  <div class="fit-inner" bind:this={innerEl} style="transform: scale({scale}); transform-origin: top left;">
    {@render children()}
  </div>
</div>

<style>
  .fit-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
    box-sizing: border-box;
    line-height: 0;
  }

  .fit-inner {
    display: inline-block;
    vertical-align: top;
    line-height: normal;
  }
</style>
