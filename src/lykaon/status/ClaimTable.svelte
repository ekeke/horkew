<script lang="ts">
  import type { ClaimGroup } from './extract.ts'
  import { buildAssertionTimeline } from './extract.ts'
  import PlayerName from './PlayerName.svelte'
  import SpeciesIcon from './SpeciesIcon.svelte'

  let { groups, maxDay, players, survivors, nightKilled, executed, claimShortNames = new Map() }: {
    groups: ClaimGroup[]
    maxDay: number
    players: Map<number, string>
    survivors: Set<number>
    nightKilled: Set<number>
    executed: Set<number>
    claimShortNames?: Map<number, string>
  } = $props()

  const tableRoles = new Set(['seer', 'medium', 'bodyguard'])

  const divinationRoles = new Set(['seer', 'medium'])
  let tableGroups = $derived(groups.filter(g => tableRoles.has(g.role)))
  let leftGroups = $derived(tableGroups.filter(g => divinationRoles.has(g.role)))
  let rightTableGroups = $derived(tableGroups.filter(g => !divinationRoles.has(g.role)))
  let masonGroup = $derived(groups.find(g => g.role === 'mason'))
  let nekomataGroup = $derived(groups.find(g => g.role === 'nekomata'))

  // Column range: nights 1 to maxDay-1, extended if forecasts exist beyond
  let maxNight = $derived.by(() => {
    let m = maxDay - 1
    for (const group of tableGroups) {
      for (const row of group.rows) {
        for (const night of row.forecasts.keys()) {
          if (night > m) m = night
        }
      }
    }
    return m
  })
  let nights = $derived(
    Array.from({ length: Math.max(0, maxNight) }, (_, i) => i + 1)
  )


  /**
   * Build mason pairs/groups from assertions.
   * Each mason's assertions map contains partner seats.
   * We use union-find to group connected masons.
   */
  function buildMasonGroups(group: ClaimGroup): { members: { seat: number, name: string, dead: boolean }[] }[] {
    const parent = new Map<number, number>()
    function find(x: number): number {
      if (!parent.has(x)) parent.set(x, x)
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
      return parent.get(x)!
    }
    function union(a: number, b: number) {
      parent.set(find(a), find(b))
    }

    for (const row of group.rows) {
      parent.set(row.seat, row.seat)
      for (const [targetSeat] of row.assertions) {
        if (group.rows.some(r => r.seat === targetSeat)) {
          union(row.seat, targetSeat)
        }
      }
    }

    const clusters = new Map<number, ClaimGroup['rows']>()
    for (const row of group.rows) {
      const root = find(row.seat)
      if (!clusters.has(root)) clusters.set(root, [])
      clusters.get(root)!.push(row)
    }

    return [...clusters.values()].map(rows => ({
      members: rows.sort((a, b) => a.seat - b.seat).map(r => ({ seat: r.seat, name: r.name, dead: !r.surviving })),
    }))
  }
</script>

<div class="section">
  {#if groups.length === 0}
    <div class="empty">---</div>
  {:else}
    {#snippet roleTable(group: ClaimGroup)}
      <div class="group">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="role-label" rowspan={group.rows.length + 1}>{group.roleShortName}</th>
                {#each nights as night}
                  <th class="night-col">{night}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each group.rows as row}
                {@const timeline = buildAssertionTimeline(row, maxDay, players)}
                {@const coNight = row.claimedAt != null ? row.claimedAt - 1 : -1}
                <tr>
                  <td class="name-cell" class:co-timing={coNight < 1 && coNight >= 0}><PlayerName dead={!row.surviving} nightKill={nightKilled.has(row.seat)} executed={executed.has(row.seat)} claim={claimShortNames.get(row.seat)} seat={row.seat}>{row.name}</PlayerName></td>
                  {#each nights as night}
                    {@const assertion = timeline.get(night) ?? null}
                    <td class="data-cell" class:human={assertion?.species === 'human' && !assertion?.forecast} class:wolf={assertion?.species === 'wolf' && !assertion?.forecast} class:guard={row.claimingRole === 'bodyguard' && assertion !== null} class:forecast={assertion?.forecast} class:co-timing={night === coNight}>
                      {#if assertion}<PlayerName dead={!survivors.has(assertion.targetSeat)} nightKill={nightKilled.has(assertion.targetSeat)} executed={executed.has(assertion.targetSeat)} claim={claimShortNames.get(assertion.targetSeat)} seat={assertion.targetSeat}>{assertion.targetName}</PlayerName>{#if assertion.forecast}<span class="forecast-label">(予)</span>{:else if row.claimingRole !== 'bodyguard'}<SpeciesIcon species={assertion.species} />{/if}{/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/snippet}

    <div class="claim-columns">
      <div class="claim-col">
        {#each leftGroups as group}
          {@render roleTable(group)}
        {/each}
      </div>
      <div class="claim-col">
        {#each rightTableGroups as group}
          {@render roleTable(group)}
        {/each}
        {#if masonGroup}
          <div class="group group-inline">
            <span class="inline-role-label">{masonGroup.roleShortName}</span>
            <div class="mason-groups">
              {#each buildMasonGroups(masonGroup) as cluster}
                <span class="mason-cluster">{#each cluster.members as member, i}{#if i > 0}<span class="mason-sep"> - </span>{/if}<PlayerName dead={member.dead} nightKill={nightKilled.has(member.seat)} executed={executed.has(member.seat)} claim={claimShortNames.get(member.seat)} seat={member.seat}>{member.name}</PlayerName>{/each}</span>
              {/each}
            </div>
          </div>
        {/if}
        {#if nekomataGroup}
          <div class="group group-inline">
            <span class="inline-role-label">{nekomataGroup.roleShortName}</span>
            <div class="simple-claims">
              {#each nekomataGroup.rows as row}
                <PlayerName dead={!row.surviving} nightKill={nightKilled.has(row.seat)} executed={executed.has(row.seat)} claim={claimShortNames.get(row.seat)} seat={row.seat}>{row.name}</PlayerName>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .section {
    padding: 8px 12px;
  }

  .empty {
    color: var(--color-text-faint);
    font-size: 12px;
  }

  .claim-columns {
    display: flex;
    gap: 12px;
  }

  .claim-col {
    flex: 1;
    min-width: 0;
  }

  .group {
    margin-bottom: 6px;
  }

  .group-inline {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .inline-role-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-co);
  }

  .role-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-co);
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    padding: 2px 6px;
    vertical-align: middle;
    text-align: center;
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
    border: 1px solid var(--color-border);
    padding: 2px 6px;
    white-space: nowrap;
  }

  th {
    background: var(--color-bg-elevated);
    color: var(--color-text-muted);
    font-weight: 500;
    font-size: 10px;
    text-align: center;
  }

  .night-col {
    min-width: 36px;
  }

  .name-cell {
    color: var(--color-text);
    font-weight: 500;
  }

  .data-cell {
    text-align: center;
    color: var(--color-text-muted);
  }

  .data-cell.human {
    color: var(--color-human-result);
  }

  .data-cell.wolf {
    color: var(--color-wolf-result);
  }

  .data-cell.guard {
    color: var(--color-link);
  }

  .data-cell.forecast {
    color: var(--color-text-muted);
  }

  .forecast-label {
    font-size: 10px;
  }

  .mason-groups {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 12px;
    font-family: 'Consolas', 'Menlo', monospace;
    color: var(--color-text);
  }

  .mason-sep {
    color: var(--color-text-faint);
  }

  .simple-claims {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    font-size: 12px;
    font-family: 'Consolas', 'Menlo', monospace;
    color: var(--color-text);
  }

</style>
