<script lang="ts">
  import type { DayDeaths } from './extract.ts'
  import { causeOfDeathLabel } from './extract.ts'
  import PlayerName from './PlayerName.svelte'

  let { days, claimShortNames = new Map() }: { days: DayDeaths[], claimShortNames?: Map<number, string> } = $props()

  const nightKillCauses = new Set(['night_kill', 'follow_killed_hamster', 'cursed_by_killed_nekomata'])
</script>

<div class="section">
  <div class="section-header">死亡履歴</div>
  {#if days.length === 0}
    <div class="empty">---</div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th></th>
            {#each days as { day }}
              <th class="day-col">{day}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          <tr class="kill-row">
            <td class="type-cell kill-type">襲撃</td>
            {#each days as { nightKills }}
              <td class="name-cell">{#each nightKills as entry, i}{#if i > 0}、{/if}<PlayerName dead={true} nightKill={nightKillCauses.has(entry.causeOfDeath)} claim={claimShortNames.get(entry.seat)}>{entry.name}</PlayerName>{#if entry.causeOfDeath !== 'night_kill'}<span class="cause-note">({causeOfDeathLabel(entry.causeOfDeath)})</span>{/if}{/each}</td>
            {/each}
          </tr>
          <tr class="exec-row">
            <td class="type-cell exec-type">処刑</td>
            {#each days as { executions }}
              <td class="name-cell">{#each executions as entry, i}{#if i > 0}、{/if}<PlayerName dead={true} executed claim={claimShortNames.get(entry.seat)}>{entry.name}</PlayerName>{#if entry.causeOfDeath !== 'execution'}<span class="cause-note">({causeOfDeathLabel(entry.causeOfDeath)})</span>{/if}{/each}</td>
            {/each}
          </tr>
        </tbody>
      </table>
    </div>
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

  .table-wrap {
    overflow-x: auto;
  }

  table {
    border-collapse: collapse;
    font-size: 12px;
    font-family: 'Consolas', 'Menlo', monospace;
  }

  th, td {
    border: 1px solid #313244;
    padding: 2px 6px;
    white-space: nowrap;
  }

  th {
    background: #181825;
    color: #cba6f7;
    font-weight: 600;
    font-size: 11px;
    text-align: center;
  }

  .type-cell {
    text-align: center;
    font-size: 10px;
    font-weight: 500;
  }

  .kill-type {
    color: #f9e2af;
  }

  .exec-type {
    color: #f38ba8;
  }

  .name-cell {
    color: #cdd6f4;
  }

  .cause-note {
    color: #585b70;
    font-size: 10px;
    margin-left: 2px;
  }
</style>
