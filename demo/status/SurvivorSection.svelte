<script lang="ts">
  import type { SurvivorInfo } from './extract.ts'
  import type { SourceLines } from '../App.svelte'
  import type { Writable } from 'svelte/store'
  import { getContext } from 'svelte'
  import PlayerName from './PlayerName.svelte'

  let { info, setupMismatch = false, day = 1 }: { info: SurvivorInfo, setupMismatch?: boolean, day?: number } = $props()

  const srcLines = getContext<Writable<SourceLines>>('sourceLines')
  const cursor = getContext<Writable<number>>('cursorLine')
</script>

<div class="section">
  <span class="section-header"><span class="day">{day}日目</span> 生存 <span class="count">{info.alive}</span>/<span class:mismatch={setupMismatch}>{info.total}</span></span>
  {#each info.survivors as { seat, name }}
    <span class="survivor-badge" class:active-hl={$srcLines.survivor.get(seat) === $cursor}><PlayerName dead={false} {seat}>{name}</PlayerName></span>
  {/each}
  {#if info.survivors.length === 0}
    <span class="empty">---</span>
  {/if}
</div>

<style>
  .section {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-border);
  }

  .section-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    margin-right: 4px;
  }

  .day {
    color: var(--color-text);
    margin-right: 4px;
  }

  .count {
    color: var(--color-village);
    font-size: 14px;
  }

  .survivor-badge {
    display: inline-block;
    padding: 2px 8px;
    font-size: 12px;
    background: var(--color-surface);
    border-radius: 4px;
    color: var(--color-text);
  }

  .empty {
    color: var(--color-text-faint);
    font-size: 12px;
  }

  .active-hl {
    outline: 1.5px solid color-mix(in srgb, var(--color-link) 60%, transparent);
    background: color-mix(in srgb, var(--color-link) 15%, transparent);
  }

  .mismatch {
    background: var(--color-danger-badge);
    color: var(--color-danger-text);
    padding: 0 4px;
    border-radius: 3px;
  }
</style>
