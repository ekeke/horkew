<script lang="ts">
  import type { ClaimGroup, DayAssertion } from './extract.ts'
  import { buildAssertionTimeline } from './extract.ts'

  let { groups, maxDay, players }: {
    groups: ClaimGroup[]
    maxDay: number
    players: Map<number, string>
  } = $props()

  const tableRoles = new Set(['seer', 'medium', 'bodyguard'])

  let tableGroups = $derived(groups.filter(g => tableRoles.has(g.role)))
  let masonGroup = $derived(groups.find(g => g.role === 'mason'))
  let nekomataGroup = $derived(groups.find(g => g.role === 'nekomata'))

  // Column range: nights 1 to maxDay-1 (night N result reported on day N+1)
  let nights = $derived(
    Array.from({ length: Math.max(0, maxDay - 1) }, (_, i) => i + 1)
  )

  function speciesSymbol(species: import('../../src/types/index.ts').EnumSpecies): string {
    if (species === 'human') return '○'
    if (species === 'wolf') return '●'
    return ''
  }

  function cellContent(assertion: DayAssertion, role: string): string {
    if (!assertion) return ''
    if (role === 'bodyguard') {
      return assertion.targetName
    }
    return assertion.targetName + speciesSymbol(assertion.species)
  }

  /**
   * Build mason pairs/groups from assertions.
   * Each mason's assertions map contains partner seats.
   * We use union-find to group connected masons.
   */
  function buildMasonGroups(group: ClaimGroup): { members: { name: string, dead: boolean }[] }[] {
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
      members: rows.sort((a, b) => a.seat - b.seat).map(r => ({ name: r.name, dead: !r.surviving })),
    }))
  }
</script>

<div class="section">
  <div class="section-header">CO表</div>
  {#if groups.length === 0}
    <div class="empty">---</div>
  {:else}
    {#each tableGroups as group}
      <div class="group">
        <div class="group-header">{group.roleShortName}</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="name-col"></th>
                {#each nights as night}
                  <th class="night-col">{night}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each group.rows as row}
                {@const timeline = buildAssertionTimeline(row, maxDay, players)}
                <tr class:dead={!row.surviving}>
                  <td class="name-cell">{row.name}</td>
                  {#each nights as night}
                    {@const assertion = timeline.get(night) ?? null}
                    <td class="data-cell" class:human={assertion?.species === 'human'} class:wolf={assertion?.species === 'wolf'} class:guard={row.claimingRole === 'bodyguard' && assertion !== null}>
                      {cellContent(assertion, row.claimingRole)}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/each}

    {#if masonGroup}
      <div class="group">
        <div class="group-header">{masonGroup.roleShortName}</div>
        <div class="mason-groups">
          {#each buildMasonGroups(masonGroup) as cluster}
            <span class="mason-cluster">{#each cluster.members as member, i}{#if i > 0}<span class="mason-sep"> - </span>{/if}<span class:dead={member.dead}>{member.name}</span>{/each}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if nekomataGroup}
      <div class="group">
        <div class="group-header">{nekomataGroup.roleShortName}</div>
        <div class="simple-claims">
          {#each nekomataGroup.rows as row}
            <span class="simple-name" class:dead={!row.surviving}>{row.name}</span>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .section {
    padding: 8px 12px;
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

  .group {
    margin-bottom: 8px;
  }

  .group-header {
    font-size: 11px;
    font-weight: 600;
    color: #cba6f7;
    margin-bottom: 2px;
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
    color: #a6adc8;
    font-weight: 500;
    font-size: 10px;
    text-align: center;
  }

  .name-col {
    min-width: 48px;
  }

  .night-col {
    min-width: 36px;
  }

  .name-cell {
    color: #cdd6f4;
    font-weight: 500;
  }

  .data-cell {
    text-align: center;
    color: #a6adc8;
  }

  .data-cell.human {
    color: #a6e3a1;
  }

  .data-cell.wolf {
    color: #f38ba8;
  }

  .data-cell.guard {
    color: #89b4fa;
  }

  tr.dead .name-cell {
    color: #585b70;
    text-decoration: line-through;
  }

  tr.dead .data-cell {
    opacity: 0.6;
  }

  .mason-groups {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 12px;
    font-family: 'Consolas', 'Menlo', monospace;
    color: #cdd6f4;
  }

  .mason-sep {
    color: #585b70;
  }

  .simple-claims {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    font-size: 12px;
    font-family: 'Consolas', 'Menlo', monospace;
  }

  .simple-name {
    color: #cdd6f4;
  }

  .dead {
    color: #585b70;
    text-decoration: line-through;
  }
</style>
