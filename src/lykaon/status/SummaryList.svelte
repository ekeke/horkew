<script lang="ts">
  import type { DayDeaths, ClaimGroup, ClaimRow, DayAssertion } from './extract.ts'
  import type { SourceLines } from '../AnalysisContext.svelte.ts'
  import type { Writable } from 'svelte/store'
  import { getContext } from 'svelte'
  import { causeOfDeathLabel, buildAssertionTimeline } from './extract.ts'
  import { buildMasonClusters } from './masonClusters.ts'
  import { systemRoles } from '../../types/index.ts'
  import type { SystemRole } from '../../types/index.ts'
  import PlayerName from './PlayerName.svelte'
  import SpeciesIcon from './SpeciesIcon.svelte'

  let { days, groups, maxDay, players, survivors, nightKilled, executed, claimShortNames = new Map(), masonCapacity = 0, deadPlayers = new Map() }: {
    days: DayDeaths[]
    groups: ClaimGroup[]
    maxDay: number
    players: Map<number, string>
    survivors: Set<number>
    nightKilled: Set<number>
    executed: Set<number>
    claimShortNames?: Map<number, string>
    masonCapacity?: number
    deadPlayers?: Map<number, string>
  } = $props()

  const srcLines = getContext<Writable<SourceLines>>('sourceLines')
  const cursor = getContext<Writable<number>>('cursorLine')

  const nightKillCauses = new Set(['night_kill', 'follow_killed_hamster', 'cursed_by_killed_nekomata'])
  const roleDisplayOrder = ['bodyguard', 'seer', 'medium']

  let tableGroups = $derived(
    roleDisplayOrder
      .map(r => groups.find(g => g.role === r))
      .filter((g): g is ClaimGroup => g != null)
  )
  let masonGroup = $derived(groups.find(g => g.role === 'mason'))
  let nekomataGroup = $derived(groups.find(g => g.role === 'nekomata'))

  let killDays = $derived(days.filter(d => d.nightKills.length > 0))
  let execDays = $derived(days.filter(d => d.executions.length > 0))
  let dayMap = $derived(new Map(days.map(d => [d.day, d])))
  let killExecDays = $derived.by(() => {
    const set = new Set<number>()
    for (const d of killDays) set.add(d.day)
    for (const d of execDays) set.add(d.day)
    return [...set].sort((a, b) => a - b)
  })

  type RoleDayEntry = {
    day: number
    assertion: DayAssertion
    slide: boolean
    death: boolean
  }

  const ROLE_COLS = 3

  function chunkN<T>(arr: T[], n: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
    return out
  }

  function unionDays(entriesList: RoleDayEntry[][]): number[] {
    const set = new Set<number>()
    for (const list of entriesList) for (const e of list) set.add(e.day)
    return [...set].sort((a, b) => a - b)
  }

  function buildRowEntries(row: ClaimRow): RoleDayEntry[] {
    const timeline = buildAssertionTimeline(row, maxDay, players)
    const dayKeys = new Set<number>()
    for (const night of timeline.keys()) dayKeys.add(night + 1)
    if (row.slidDay != null) dayKeys.add(row.slidDay + 1)
    if (!row.surviving && row.diedDay != null) dayKeys.add(row.diedDay + 1)
    return [...dayKeys].sort((a, b) => a - b).map(day => {
      const a = timeline.get(day - 1) ?? null
      const isSlide = !a && row.slidDay === day - 1
      const isDeath = !a && !isSlide && !row.surviving && row.diedDay === day - 1
      return { day, assertion: a, slide: isSlide, death: isDeath }
    })
  }

  let masonClusters = $derived(buildMasonClusters(masonGroup, masonCapacity, deadPlayers).clusters)

  let hasContent = $derived(
    killExecDays.length > 0 || groups.length > 0
  )
</script>

{#if hasContent}
<div class="summary-list">
  {#if killExecDays.length > 0}
    <section class="sect">
      <div class="sect-header"></div>
      <div class="sect-body">
      <table class="role-grid">
        <thead>
          <tr>
            <th class="day-axis-head"></th>
            <th class="player-head kill-header">噛</th>
            <th class="player-head exec-header">吊</th>
          </tr>
        </thead>
        <tbody>
          {#each killExecDays as day}
            {@const entry = dayMap.get(day)}
            <tr>
              <td class="day-axis">{day}d</td>
              <td class="role-cell" class:active-hl-cell={$srcLines.kill.get(day - 1) === $cursor}>
                <div class="role-cell-inner">
                {#if entry}
                  {#each entry.nightKills as nk, i}
                    {#if i > 0}<span class="sep">,</span>{/if}
                    <PlayerName dead nightKill={nightKillCauses.has(nk.causeOfDeath)} executed={false} claim={claimShortNames.get(nk.seat)} seat={nk.seat}>{nk.name}</PlayerName>
                    {#if nk.causeOfDeath !== 'night_kill'}<span class="cause-note">({causeOfDeathLabel(nk.causeOfDeath)})</span>{/if}
                  {/each}
                {/if}
                </div>
              </td>
              <td class="role-cell" class:active-hl-cell={$srcLines.exec.get(day) === $cursor}>
                <div class="role-cell-inner">
                {#if entry}
                  {#each entry.executions as ex, i}
                    {#if i > 0}<span class="sep">,</span>{/if}
                    <PlayerName dead nightKill={false} executed claim={claimShortNames.get(ex.seat)} seat={ex.seat}>{ex.name}</PlayerName>
                    {#if ex.causeOfDeath !== 'execution'}<span class="cause-note">({causeOfDeathLabel(ex.causeOfDeath)})</span>{/if}
                  {/each}
                {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      </div>
    </section>
  {/if}

  {#each tableGroups as group}
    <section class="sect">
      <div class="sect-header role-header">{group.roleShortName}</div>
      <div class="sect-body">
      {#each chunkN(group.rows, ROLE_COLS) as groupRows}
        {@const rowEntries = groupRows.map(buildRowEntries)}
        {@const days = unionDays(rowEntries)}
        {@const padCount = ROLE_COLS - groupRows.length}
        <table class="role-grid">
          <thead>
            <tr>
              <th class="day-axis-head"></th>
              {#each groupRows as r}
                <th
                  class="player-head"
                  class:active-hl-row={$srcLines.claimRow.get(r.seat) === $cursor}
                >
                  <PlayerName dead={!r.surviving} nightKill={nightKilled.has(r.seat)} executed={executed.has(r.seat)} seat={r.seat}>{r.name}</PlayerName>
                </th>
              {/each}
              {#each Array.from({ length: padCount }) as _}<th class="player-head empty"></th>{/each}
            </tr>
          </thead>
          {#if days.length > 0}
          <tbody>
            {#each days as d}
              <tr>
                <td class="day-axis">{d}d</td>
                {#each groupRows as r, idx}
                  {@const entry = rowEntries[idx].find(e => e.day === d) ?? null}
                  {@const assertion = entry?.assertion ?? null}
                  {@const slide = entry?.slide ?? false}
                  {@const death = entry?.death ?? false}
                  {@const isHuman = assertion?.species === 'human' && !assertion?.forecast}
                  {@const isWolf = assertion?.species === 'wolf' && !assertion?.forecast}
                  {@const isGuard = group.role === 'bodyguard' && assertion !== null}
                  <td
                    class="role-cell"
                    class:human={isHuman}
                    class:wolf={isWolf}
                    class:guard={isGuard}
                    class:forecast={assertion?.forecast}
                    class:slide-marker={slide}
                    class:death-marker={death}
                    class:co-timing={r.claimedAt === d}
                    class:active-hl-cell={$srcLines.claimCell.get(`${r.seat}:${d - 1}`) === $cursor}
                  >
                    <div class="role-cell-inner">
                    {#if assertion}
                      {#if assertion.previousAssertions}
                        <span class="slide-prev">
                          {#each assertion.previousAssertions as prev}{prev.targetName}<SpeciesIcon species={prev.species} />→{/each}
                        </span>
                      {/if}
                      <PlayerName dead={!survivors.has(assertion.targetSeat)} nightKill={nightKilled.has(assertion.targetSeat)} executed={executed.has(assertion.targetSeat)} claim={claimShortNames.get(assertion.targetSeat)} seat={assertion.targetSeat}>{assertion.targetName}</PlayerName>
                      {#if assertion.forecast}
                        <span class="forecast-label">(予)</span>
                      {:else if group.role !== 'bodyguard'}
                        <SpeciesIcon species={assertion.species} />
                      {/if}
                    {:else if slide}
                      <span class="slide-marker-label">（{systemRoles.get(r.slidToRole as SystemRole)?.shortName ?? r.slidToRole}スライド）</span>
                    {:else if death}
                      <span class="death-marker-label">（{causeOfDeathLabel(r.causeOfDeath)}死）</span>
                    {/if}
                    </div>
                  </td>
                {/each}
                {#each Array.from({ length: padCount }) as _}<td class="role-cell empty"></td>{/each}
              </tr>
            {/each}
          </tbody>
          {/if}
        </table>
      {/each}
      </div>
    </section>
  {/each}

  {#if masonGroup}
    <section class="sect">
      <div class="sect-header role-header">{masonGroup.roleShortName}</div>
      <div class="sect-body">
        <div class="extra-line" class:active-hl-row={masonGroup.rows.some(r => $srcLines.claimRow.get(r.seat) === $cursor)}>
          {#each masonClusters as cluster, ci}
            {#if ci > 0}<span class="cluster-sep"> / </span>{/if}
            {#each cluster.members as member, i}
              {#if i > 0}<span class="mason-sep">-</span>{/if}
              <PlayerName dead={member.dead} nightKill={nightKilled.has(member.seat)} executed={executed.has(member.seat)} seat={member.seat}>{member.name}</PlayerName>
            {/each}
            {#each Array.from({ length: Math.max(0, masonCapacity - cluster.members.length) }) as _empty}
              <span class="mason-sep">-</span><span class="mason-empty-slot">?</span>
            {/each}
          {/each}
        </div>
      </div>
    </section>
  {/if}

  {#if nekomataGroup}
    <section class="sect">
      <div class="sect-header role-header">{nekomataGroup.roleShortName}</div>
      <div class="sect-body">
        <div class="extra-line" class:active-hl-row={nekomataGroup.rows.some(r => $srcLines.claimRow.get(r.seat) === $cursor)}>
          {#each nekomataGroup.rows as row, i}
            {#if i > 0}<span class="sep">,</span>{/if}
            <PlayerName dead={!row.surviving} nightKill={nightKilled.has(row.seat)} executed={executed.has(row.seat)} seat={row.seat}>{row.name}</PlayerName>
            {#if row.slidToRole}<span class="slide-marker-label">（{systemRoles.get(row.slidToRole as SystemRole)?.shortName ?? row.slidToRole}スライド）</span>{/if}
          {/each}
        </div>
      </div>
    </section>
  {/if}

</div>
{/if}

<style>
  .summary-list {
    padding: 2px 8px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.3;
    color: var(--color-text);
  }

  .sect {
    display: flex;
    align-items: flex-start;
    gap: 2px;
    padding: 1px 0;
    border-top: 1px solid var(--color-border);
  }

  .sect:first-child {
    border-top: none;
  }

  .sect-header {
    flex: 0 0 auto;
    width: 14px;
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    padding: 0;
    text-align: center;
  }

  .sect-body {
    flex: 1 1 auto;
    min-width: 0;
  }

  .role-header {
    color: var(--color-co);
  }

  .kill-header {
    color: var(--color-role);
  }

  .exec-header {
    color: var(--color-wolf);
  }

  .role-block {
    margin-bottom: 2px;
  }

  .role-name {
    font-weight: 500;
    padding-left: 0;
  }

  .day-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 4px;
    padding: 0;
  }

  .role-day-line {
    padding-left: 10px;
  }

  .role-grid {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-family: var(--font-mono);
    margin-bottom: 2px;
  }

  .day-axis-head,
  .day-axis {
    width: 24px;
    text-align: right;
    padding: 0 4px 0 0;
    vertical-align: baseline;
    color: var(--color-text-muted);
    font-size: 11px;
    font-weight: 400;
    white-space: nowrap;
  }

  .player-head {
    padding: 0 2px;
    vertical-align: baseline;
    text-align: left;
    font-weight: 500;
  }

  .role-cell {
    padding: 0 2px;
    vertical-align: baseline;
  }

  .role-cell-inner {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0;
  }

  .day-tag {
    color: var(--color-text-muted);
    font-size: 11px;
    min-width: 22px;
  }

  .sep {
    color: var(--color-text-faint);
  }

  .cause-note {
    color: var(--color-text-faint);
    font-size: 11px;
  }

  .day-line.human, .role-cell.human {
    color: var(--color-human-result);
  }

  .day-line.wolf, .role-cell.wolf {
    color: var(--color-wolf-result);
  }

  .day-line.guard, .role-cell.guard {
    color: var(--color-link);
  }

  .day-line.forecast, .role-cell.forecast {
    color: var(--color-text-muted);
  }

  .forecast-label {
    font-size: 11px;
  }

  .death-marker, .role-cell.death-marker {
    color: var(--color-text-faint);
  }

  .death-marker-label {
    font-size: 11px;
  }

  .slide-marker, .role-cell.slide-marker {
    color: var(--color-text-faint);
  }

  .slide-marker-label {
    font-size: 11px;
  }

  .slide-prev {
    color: var(--color-text-faint);
    font-size: 11px;
  }

  .co-timing, .role-cell.co-timing {
    position: relative;
  }

  .co-timing::before, .role-cell.co-timing::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    border-style: solid;
    border-width: 4px 0 4px 5px;
    border-color: transparent transparent transparent var(--color-text-faint);
  }

  .extra-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0;
    padding: 0;
    font-family: var(--font-mono);
  }

  .mason-sep, .cluster-sep {
    color: var(--color-text-faint);
  }

  .mason-empty-slot {
    color: var(--color-text-faint);
  }

  .active-hl-row {
    background: color-mix(in srgb, var(--color-link) 10%, transparent);
    border-radius: 2px;
  }

  .active-hl-cell {
    outline: 1.5px solid color-mix(in srgb, var(--color-link) 60%, transparent);
    background: color-mix(in srgb, var(--color-link) 15%, transparent);
    border-radius: 2px;
  }
</style>
