<script lang="ts">
  import type { SurvivorInfo } from './extract.ts'
  import PlayerName from './PlayerName.svelte'

  let { info }: { info: SurvivorInfo } = $props()
</script>

<div class="section">
  <div class="section-header">生存 <span class="count">{info.alive}</span>/{info.total}</div>
  <div class="survivor-list">
    {#each info.survivors as { seat, name }}
      <span class="survivor-badge"><PlayerName dead={false} {seat}>{name}</PlayerName></span>
    {/each}
    {#if info.survivors.length === 0}
      <span class="empty">---</span>
    {/if}
  </div>
</div>

<style>
  .section {
    padding: 8px 12px;
    border-bottom: 1px solid #313244;
  }

  .section-header {
    font-size: 12px;
    font-weight: 600;
    color: #a6adc8;
    margin-bottom: 6px;
  }

  .count {
    color: #a6e3a1;
    font-size: 14px;
  }

  .survivor-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
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
</style>
