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
    border-bottom: 1px solid #313244;
  }

  .section-header {
    font-size: 12px;
    font-weight: 600;
    color: #a6adc8;
    margin-right: 4px;
  }

  .day {
    color: #cdd6f4;
    margin-right: 4px;
  }

  .count {
    color: #a6e3a1;
    font-size: 14px;
  }

  .survivor-badge {
    display: inline-block;
    padding: 2px 8px;
    font-size: 12px;
    background: #313244;
    border-radius: 4px;
    color: #cdd6f4;
  }

  .empty {
    color: #585b70;
    font-size: 12px;
  }

  .active-hl {
    outline: 1.5px solid rgba(137, 180, 250, 0.6);
    background: rgba(137, 180, 250, 0.15);
  }

  .mismatch {
    background: #e64553;
    color: #fff;
    padding: 0 4px;
    border-radius: 3px;
  }
</style>
