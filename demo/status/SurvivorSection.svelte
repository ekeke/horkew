<script lang="ts">
  import type { SurvivorInfo } from './extract.ts'
  import PlayerName from './PlayerName.svelte'

  let { info }: { info: SurvivorInfo } = $props()
</script>

<div class="section">
  <span class="section-header">生存 <span class="count">{info.alive}</span>/{info.total}</span>
  {#each info.survivors as { seat, name }}
    <span class="survivor-badge"><PlayerName dead={false} {seat}>{name}</PlayerName></span>
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
</style>
