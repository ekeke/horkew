<script lang="ts">
  import type { SystemRole, SeatStatus, CauseOfDeath } from '../../types/index.ts'
  import { systemRoles } from '../../types/index.ts'
  import { setContext } from 'svelte'
  import { writable } from 'svelte/store'
  import type { AnalysisContext, SourceLines } from '../AnalysisContext.svelte.ts'
  import { extractSurvivorInfo, extractDeathHistory, extractClaimGroups, extractVoteStatus } from '../status/extract.ts'
  import SurvivorSection from '../status/SurvivorSection.svelte'
  import VoteTable from '../status/VoteTable.svelte'
  import SummaryTable from '../status/SummaryTable.svelte'
  import PlayerDialog from '../status/PlayerDialog.svelte'

  type SummaryHiddenSection = 'kill' | 'execution' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata'
  type HiddenSection = 'setup' | 'survivor' | 'vote' | SummaryHiddenSection

  let { ctx, hiddenSections = new Set<HiddenSection>() }: {
    ctx: AnalysisContext
    hiddenSections?: Set<HiddenSection>
  } = $props()

  const summarySectionKeys: SummaryHiddenSection[] = ['kill', 'execution', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata']
  let summaryHidden = $derived(new Set<SummaryHiddenSection>(summarySectionKeys.filter(k => hiddenSections.has(k))))

  let dialogSeat = $state<number | null>(null)
  let dialogName = $derived(dialogSeat != null ? ctx.players.get(dialogSeat) ?? `#${dialogSeat}` : '')
  let dialogStatus: SeatStatus | null = $derived(
    dialogSeat != null && ctx.villageStatus
      ? ctx.villageStatus.statuses.get(dialogSeat) ?? null
      : null
  )

  function openPlayerDialog(seat: number) {
    dialogSeat = seat
  }

  setContext('playerclick', openPlayerDialog)

  const hoveredSeat = writable<number | null>(null)
  setContext('hoveredSeat', hoveredSeat)

  const shortNamesStore = writable<Map<number, string>>(new Map())
  $effect(() => { shortNamesStore.set(ctx.playerShortNames) })
  setContext('shortNames', shortNamesStore)

  const emptySourceLines: SourceLines = {
    survivor: new Map(), claimRow: new Map(), claimCell: new Map(),
    kill: new Map(), exec: new Map(), vote: new Map(),
  }
  const srcLines = writable<SourceLines>(emptySourceLines)
  const cursor = writable<number>(0)
  $effect(() => { srcLines.set(ctx.sourceLines) })
  $effect(() => { cursor.set(ctx.cursorLine) })
  setContext('sourceLines', srcLines)
  setContext('cursorLine', cursor)

  function closePlayerDialog() {
    dialogSeat = null
  }

  let setupEntries = $derived(
    [...systemRoles.keys()]
      .filter(role => ctx.setup.has(role))
      .map(role => ({
        shortName: systemRoles.get(role)?.shortName ?? role,
        count: ctx.setup.get(role)!,
        alignment: systemRoles.get(role)?.alignment ?? 'villager',
      }))
  )
  let setupTotal = $derived(
    [...ctx.setup.values()].reduce((sum, c) => sum + c, 0)
  )

  let survivorInfo = $derived(
    ctx.villageStatus ? extractSurvivorInfo(ctx.villageStatus, ctx.players) : null
  )
  let setupMismatch = $derived(
    survivorInfo != null && survivorInfo.total > 0 && setupTotal !== survivorInfo.total
  )
  let voteStatus = $derived(
    ctx.villageStatus ? extractVoteStatus(ctx.villageStatus, ctx.players) : null
  )
  let deathHistory = $derived(
    ctx.villageStatus ? extractDeathHistory(ctx.villageStatus, ctx.players) : []
  )
  let claimGroups = $derived(
    ctx.villageStatus ? extractClaimGroups(ctx.villageStatus, ctx.players) : []
  )
  let survivors = $derived(new Set(survivorInfo?.survivors.map(s => s.seat) ?? []))

  const nightKillCauses: Set<CauseOfDeath> = new Set([
    'night_kill', 'follow_killed_hamster', 'cursed_by_killed_nekomata',
  ])
  const executionCauses: Set<CauseOfDeath> = new Set([
    'execution', 'cursed_by_executed_nekomata', 'follow_executed_hamster',
  ])
  let nightKilled = $derived(new Set(
    ctx.villageStatus
      ? [...ctx.villageStatus.statuses.entries()]
          .filter(([, s]) => !s.surviving && s.causeOfDeath && nightKillCauses.has(s.causeOfDeath))
          .map(([seat]) => seat)
      : []
  ))
  let executed = $derived(new Set(
    ctx.villageStatus
      ? [...ctx.villageStatus.statuses.entries()]
          .filter(([, s]) => !s.surviving && s.causeOfDeath && executionCauses.has(s.causeOfDeath))
          .map(([seat]) => seat)
      : []
  ))
  let claimShortNames = $derived(new Map(
    ctx.villageStatus
      ? [...ctx.villageStatus.statuses.entries()]
          .filter(([, s]) => s.claiming)
          .map(([seat, s]) => [seat, systemRoles.get(s.claimingRole as SystemRole)?.shortName ?? s.claimingRole] as const)
      : []
  ))
</script>

{#if ctx.villageStatus && survivorInfo && voteStatus}
  <div class="status-pane">
    {#if !hiddenSections.has('setup') && setupEntries.length > 0}
      <div class="setup-section">
        <span class="setup-header">配役 <span class="count">{setupTotal}</span>人</span>
        {#each setupEntries as { shortName, count, alignment }}
          <span class="setup-badge {alignment}">{shortName}{count}</span>
        {/each}
      </div>
    {/if}
    {#if !hiddenSections.has('survivor')}
      <SurvivorSection info={survivorInfo} {setupMismatch} day={ctx.villageStatus.day} />
    {/if}
    <SummaryTable days={deathHistory} groups={claimGroups} maxDay={ctx.villageStatus.day} players={ctx.players} {survivors} {nightKilled} {executed} {claimShortNames} compact={hiddenSections.size > 0} hiddenSections={summaryHidden} />
    {#if !hiddenSections.has('vote')}
      <VoteTable status={voteStatus} />
    {/if}
  </div>

  {#if dialogSeat != null && dialogStatus}
    <PlayerDialog seat={dialogSeat} name={dialogName} status={dialogStatus} vs={ctx.villageStatus} setup={ctx.setup} players={ctx.players} onclose={closePlayerDialog} />
  {/if}
{/if}

<style>
  .status-pane {
    font-family: system-ui, -apple-system, sans-serif;
  }

  .setup-section {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-border);
  }

  .setup-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    margin-right: 4px;
  }

  .setup-badge {
    display: inline-block;
    padding: 2px 6px;
    font-size: 12px;
    border-radius: 4px;
    color: var(--color-text);
  }

  .setup-badge.villager {
    background: var(--color-surface);
  }

  .setup-badge.werewolf {
    background: var(--color-wolf-bg-tint);
  }

  .setup-badge.werehamster {
    background: var(--color-fox-bg-tint);
  }
</style>
