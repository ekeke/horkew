<script lang="ts">
  import type { Snippet } from 'svelte'

  let { dead, children }: {
    dead: boolean
    children: Snippet
  } = $props()
</script>

<span class="pn" class:dead={dead}>{@render children()}</span>

<style>
  .dead {
    opacity: 0.5;
    text-decoration: line-through;
  }
</style>
