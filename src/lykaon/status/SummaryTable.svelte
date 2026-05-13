<script lang="ts">
  import type { DayDeaths, ClaimGroup } from './extract.ts'
  import type { SourceLines } from '../AnalysisContext.svelte.ts'
  import type { Writable } from 'svelte/store'
  import { getContext } from 'svelte'
  import { causeOfDeathLabel, buildAssertionTimeline } from './extract.ts'
  import { systemRoles } from '../../types/index.ts'
  import type { SystemRole } from '../../types/index.ts'
  import PlayerName from './PlayerName.svelte'
  import SpeciesIcon from './SpeciesIcon.svelte'

  type HiddenSection = 'kill' | 'execution' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata'

  let { days, groups, maxDay, players, survivors, nightKilled, executed, claimShortNames = new Map(), compact = false, hiddenSections = new Set() }: {
    days: DayDeaths[]
    groups: ClaimGroup[]
    maxDay: number
    players: Map<number, string>
    survivors: Set<number>
    nightKilled: Set<number>
    executed: Set<number>
    claimShortNames?: Map<number, string>
    compact?: boolean
    hiddenSections?: Set<HiddenSection>
  } = $props()

  const srcLines = getContext<Writable<SourceLines>>('sourceLines')
  const cursor = getContext<Writable<number>>('cursorLine')

  const nightKillCauses = new Set(['night_kill', 'follow_killed_hamster', 'cursed_by_killed_nekomata'])
  const roleDisplayOrder = ['bodyguard', 'seer', 'medium']

  let tableGroups = $derived(
    roleDisplayOrder
      .map(r => groups.find(g => g.role === r))
      .filter((g): g is ClaimGroup => g != null)
      .filter(g => !hiddenSections.has(g.role as HiddenSection))
  )
  let masonGroup = $derived(hiddenSections.has('mason') ? undefined : groups.find(g => g.role === 'mason'))
  let nekomataGroup = $derived(hiddenSections.has('nekomata') ? undefined : groups.find(g => g.role === 'nekomata'))
  let hideKill = $derived(hiddenSections.has('kill'))
  let hideExec = $derived(hiddenSections.has('execution'))

  // Index death history by day
  let deathByDay = $derived(new Map(days.map(d => [d.day, d])))

  // Build all role timelines for checking non-empty days
  let allTimelines = $derived(
    tableGroups.flatMap(g => g.rows.map(row => buildAssertionTimeline(row, maxDay, players)))
  )

  // Max day extended by forecasts and death markers
  let maxDayExtended = $derived.by(() => {
    let m = maxDay
    for (const group of tableGroups) {
      for (const row of group.rows) {
        for (const night of row.forecasts.keys()) {
          if (night + 1 > m) m = night + 1
        }
        if (!row.surviving && row.diedDay !== undefined && row.diedDay + 1 > m) {
          m = row.diedDay + 1
        }
        if (row.slidDay !== undefined && row.slidDay + 1 > m) {
          m = row.slidDay + 1
        }
      }
    }
    return m
  })

  // Day columns: only include days that have any data
  let dayColumns = $derived(
    Array.from({ length: Math.max(0, maxDayExtended + 1) }, (_, i) => i)
      .filter(day => {
        const d = deathByDay.get(day)
        if (d && (d.executions.length > 0 || d.nightKills.length > 0)) return true
        if (allTimelines.some(t => t.has(day - 1))) return true
        if (tableGroups.some(g => g.rows.some(r => !r.surviving && r.diedDay === day - 1))) return true
        if (tableGroups.some(g => g.rows.some(r => r.slidDay === day - 1))) return true
        return false
      })
  )


  function buildMasonDisplay(group: ClaimGroup): { seat: number, name: string, dead: boolean }[][] {
    const parent = new Map<number, number>()
    function find(x: number): number {
      if (!parent.has(x)) parent.set(x, x)
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
      return parent.get(x)!
    }
    function union(a: number, b: number) { parent.set(find(a), find(b)) }

    for (const row of group.rows) {
      parent.set(row.seat, row.seat)
      for (const [targetSeat] of row.assertions) {
        if (group.rows.some(r => r.seat === targetSeat)) union(row.seat, targetSeat)
      }
    }

    const clusters = new Map<number, ClaimGroup['rows']>()
    for (const row of group.rows) {
      const root = find(row.seat)
      if (!clusters.has(root)) clusters.set(root, [])
      clusters.get(root)!.push(row)
    }

    return [...clusters.values()].map(rows =>
      rows.sort((a, b) => a.seat - b.seat).map(r => ({ seat: r.seat, name: r.name, dead: !r.surviving }))
    )
  }
</script>

{#if dayColumns.length > 0 || groups.length > 0}
<div class="table-wrap" class:compact>
  <table>
    <thead>
      <tr>
        <th class="label-col"></th>
        <th class="name-col"></th>
        {#each dayColumns as day}
          <th class="day-col">{day}d</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if !hideKill}
      <!-- 噛み -->
      <tr class="kill-row">
        <td class="label-cell kill-label">噛</td>
        <td class="name-cell"></td>
        {#each dayColumns as day}
          {@const d = deathByDay.get(day)}
          <td class="data-cell" class:active-hl-cell={$srcLines.kill.get(day - 1) === $cursor}>{#if d}{#each d.nightKills as entry, i}{#if i > 0}、{/if}<PlayerName dead nightKill={nightKillCauses.has(entry.causeOfDeath)} executed={false} claim={claimShortNames.get(entry.seat)} seat={entry.seat}>{entry.name}</PlayerName>{#if entry.causeOfDeath !== 'night_kill'}<span class="cause-note">({causeOfDeathLabel(entry.causeOfDeath)})</span>{/if}{/each}{/if}</td>
        {/each}
      </tr>
      {/if}

      <!-- 各役職 (狩→占→霊) -->
      {#each tableGroups as group}
        {#each group.rows as row, rowIdx}
          {@const timeline = buildAssertionTimeline(row, maxDay, players)}
          <tr class:group-first={rowIdx === 0} class:active-hl-row={$srcLines.claimRow.get(row.seat) === $cursor}>
            {#if rowIdx === 0}
              <td class="label-cell role-label" rowspan={group.rows.length}>{group.roleShortName}</td>
            {/if}
            <td class="name-cell"><PlayerName dead={!row.surviving} nightKill={nightKilled.has(row.seat)} executed={executed.has(row.seat)} seat={row.seat}>{row.name}</PlayerName></td>
            {#each dayColumns as day}
              {@const assertion = timeline.get(day - 1) ?? null}
              {@const isSlideMarker = !assertion && row.slidDay != null && row.slidDay === day - 1}
              {@const isDeathMarker = !assertion && !isSlideMarker && !row.surviving && row.diedDay === day - 1}
              <td class="data-cell" class:human={assertion?.species === 'human' && !assertion?.forecast} class:wolf={assertion?.species === 'wolf' && !assertion?.forecast} class:guard={row.claimingRole === 'bodyguard' && assertion !== null} class:forecast={assertion?.forecast} class:death-marker={isDeathMarker} class:slide-marker={isSlideMarker} class:co-timing={row.claimedAt === day} class:active-hl-cell={$srcLines.claimCell.get(`${row.seat}:${day - 1}`) === $cursor}>
                {#if assertion}{#if assertion.previousAssertions}<span class="slide-prev">{#each assertion.previousAssertions as prev}{prev.targetName}<SpeciesIcon species={prev.species} />→{/each}</span>{/if}<PlayerName dead={!survivors.has(assertion.targetSeat)} nightKill={nightKilled.has(assertion.targetSeat)} executed={executed.has(assertion.targetSeat)} claim={claimShortNames.get(assertion.targetSeat)} seat={assertion.targetSeat}>{assertion.targetName}</PlayerName>{#if assertion.forecast}<span class="forecast-label">(予)</span>{:else if row.claimingRole !== 'bodyguard'}<SpeciesIcon species={assertion.species} />{/if}{:else if isSlideMarker}<span class="slide-marker-label">（{systemRoles.get(row.slidToRole as SystemRole)?.shortName ?? row.slidToRole}スライド）</span>{:else if isDeathMarker}<span class="death-marker-label">（{causeOfDeathLabel(row.causeOfDeath)}死）</span>{/if}
              </td>
            {/each}
          </tr>
        {/each}
      {/each}

      {#if !hideExec}
      <!-- 吊り -->
      <tr class="exec-row group-first">
        <td class="label-cell exec-label">吊</td>
        <td class="name-cell"></td>
        {#each dayColumns as day}
          {@const d = deathByDay.get(day)}
          <td class="data-cell" class:active-hl-cell={$srcLines.exec.get(day) === $cursor}>{#if d}{#each d.executions as entry, i}{#if i > 0}、{/if}<PlayerName dead nightKill={false} executed claim={claimShortNames.get(entry.seat)} seat={entry.seat}>{entry.name}</PlayerName>{#if entry.causeOfDeath !== 'execution'}<span class="cause-note">({causeOfDeathLabel(entry.causeOfDeath)})</span>{/if}{/each}{/if}</td>
        {/each}
      </tr>
      {/if}

    </tbody>
  </table>
  {#if masonGroup || nekomataGroup}
  <div class="extra-claims">
    {#if masonGroup}
      <span class="extra-item" class:active-hl={masonGroup.rows.some(r => $srcLines.claimRow.get(r.seat) === $cursor)}><span class="extra-label">{masonGroup.roleShortName}</span>{#each buildMasonDisplay(masonGroup) as cluster, ci}{#if ci > 0}<span class="cluster-sep"> / </span>{/if}{#each cluster as member, i}{#if i > 0}<span class="mason-sep">-</span>{/if}<PlayerName dead={member.dead} nightKill={nightKilled.has(member.seat)} executed={executed.has(member.seat)} seat={member.seat}>{member.name}</PlayerName>{/each}{/each}</span>
    {/if}
    {#if nekomataGroup}
      <span class="extra-item"><span class="extra-label">{nekomataGroup.roleShortName}</span>{#each nekomataGroup.rows as row, i}{#if i > 0}、{/if}<PlayerName dead={!row.surviving} nightKill={nightKilled.has(row.seat)} executed={executed.has(row.seat)} seat={row.seat}>{row.name}</PlayerName>{#if row.slidToRole}<span class="slide-marker-label">（{systemRoles.get(row.slidToRole as SystemRole)?.shortName ?? row.slidToRole}スライド）</span>{/if}{/each}</span>
    {/if}
  </div>
  {/if}
</div>
{/if}

<style>
  .table-wrap {
    padding: 8px 12px;
    overflow-x: auto;
  }

  .table-wrap.compact {
    padding: 0;
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

  .compact th, .compact td {
    padding: 0 3px;
  }

  .compact .day-col {
    min-width: 0;
  }

  .compact .extra-claims {
    margin-top: 2px;
    gap: 2px 8px;
  }

  th {
    background: var(--color-bg-elevated);
    color: var(--color-text-muted);
    font-weight: 500;
    font-size: 10px;
    text-align: center;
  }

  .label-col {
    width: 2em;
  }

  .day-col {
    min-width: 36px;
  }

  .label-cell {
    text-align: center;
    font-size: 10px;
    font-weight: 600;
    vertical-align: middle;
  }

  .exec-label {
    color: var(--color-wolf);
  }

  .kill-label {
    color: var(--color-role);
  }

  .role-label {
    color: var(--color-co);
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

  .death-marker {
    color: var(--color-text-faint);
  }

  .death-marker-label {
    font-size: 10px;
  }

  .slide-marker {
    color: var(--color-text-faint);
  }

  .slide-marker-label {
    font-size: 10px;
  }

  .slide-prev {
    color: var(--color-text-faint);
    font-size: 10px;
  }

  .group-first td {
    border-top: 2px solid var(--ctp-overlay1);
  }

  .cause-note {
    color: var(--color-text-faint);
    font-size: 10px;
    margin-left: 2px;
  }

  .extra-claims {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin-top: 6px;
    font-size: 12px;
    font-family: 'Consolas', 'Menlo', monospace;
    color: var(--color-text);
  }

  .extra-label {
    color: var(--color-co);
    font-weight: 600;
    font-size: 11px;
    margin-right: 4px;
  }

  .mason-sep, .cluster-sep {
    color: var(--color-text-faint);
  }

  .co-timing {
    position: relative;
  }

  .co-timing::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    border-style: solid;
    border-width: 4px 0 4px 5px;
    border-color: transparent transparent transparent var(--color-text-faint);
  }

  .active-hl-row > :global(td) {
    background: color-mix(in srgb, var(--color-link) 10%, transparent);
  }

  .active-hl-cell {
    outline: 1.5px solid color-mix(in srgb, var(--color-link) 60%, transparent);
    background: color-mix(in srgb, var(--color-link) 15%, transparent) !important;
  }

  .active-hl {
    outline: 1.5px solid color-mix(in srgb, var(--color-link) 60%, transparent);
    border-radius: 4px;
  }
</style>
