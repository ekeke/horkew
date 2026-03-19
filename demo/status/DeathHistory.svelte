<script lang="ts">
  import type { DayDeaths } from './extract.ts'
  import { causeOfDeathLabel } from './extract.ts'

  let { days }: { days: DayDeaths[] } = $props()
</script>

<div class="section">
  <div class="section-header">死亡履歴</div>
  {#if days.length === 0}
    <div class="empty">---</div>
  {:else}
    {#each days as { day, executions, nightKills }}
      <div class="day-group">
        <div class="day-label">{day}日目</div>
        {#each executions as entry}
          <div class="death-entry execution">
            <span class="cause">処刑</span>
            <span class="name">{entry.name}</span>
          </div>
        {/each}
        {#each nightKills as entry}
          <div class="death-entry night-kill">
            <span class="cause">{causeOfDeathLabel(entry.causeOfDeath)}</span>
            <span class="name">{entry.name}</span>
          </div>
        {/each}
      </div>
    {/each}
  {/if}
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

  .empty {
    color: #585b70;
    font-size: 12px;
  }

  .day-group {
    margin-bottom: 4px;
  }

  .day-label {
    font-size: 11px;
    font-weight: 600;
    color: #cba6f7;
    margin-bottom: 2px;
  }

  .death-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 1px 0;
    font-size: 12px;
  }

  .cause {
    display: inline-block;
    min-width: 36px;
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    text-align: center;
  }

  .execution .cause {
    background: rgba(243, 139, 168, 0.2);
    color: #f38ba8;
  }

  .night-kill .cause {
    background: rgba(249, 226, 175, 0.2);
    color: #f9e2af;
  }

  .name {
    color: #cdd6f4;
  }
</style>
