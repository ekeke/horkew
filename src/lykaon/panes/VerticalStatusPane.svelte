<script lang="ts">
  import type { SystemRole, SeatStatus, CauseOfDeath } from '../../types/index.ts'
  import { systemRoles } from '../../types/index.ts'
  import { setContext } from 'svelte'
  import { writable } from 'svelte/store'
  import type { AnalysisContext, SourceLines } from '../AnalysisContext.svelte.ts'
  import { extractSurvivorInfo, extractDeathHistory, extractClaimGroups, extractVoteStatus } from '../status/extract.ts'
  import SummaryList from '../status/SummaryList.svelte'
  import VoteList from '../status/VoteList.svelte'
  import PlayerName from '../status/PlayerName.svelte'
  import PlayerDialog from '../status/PlayerDialog.svelte'

  type TabKey = 'summary' | 'vote'

  let { ctx, defaultTab = 'summary' }: {
    ctx: AnalysisContext
    defaultTab?: TabKey
  } = $props()

  let tab = $state<TabKey>(defaultTab)

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

  function closePlayerDialog() {
    dialogSeat = null
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
  let deadPlayers = $derived.by(() => {
    const map = new Map<number, string>()
    if (!ctx.villageStatus) return map
    for (const [seat, status] of ctx.villageStatus.statuses) {
      if (!status.surviving) map.set(seat, ctx.players.get(seat) ?? `#${seat}`)
    }
    return map
  })

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
  <div class="vertical-status-pane lyk-pane">
    <div class="tab-bar" role="tablist">
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={tab === 'summary'}
        aria-selected={tab === 'summary'}
        onclick={() => tab = 'summary'}
      >集約</button>
      <button
        type="button"
        role="tab"
        class="tab"
        class:active={tab === 'vote'}
        aria-selected={tab === 'vote'}
        onclick={() => tab = 'vote'}
      >投票</button>
    </div>

    <div class="tab-body">
      {#if tab === 'summary'}
        {#if setupEntries.length > 0}
          <div class="setup-section">
            <span class="section-label">配役 <span class="count">{setupTotal}</span></span>
            {#each setupEntries as { shortName, count, alignment }}
              <span class="setup-badge {alignment}">{shortName}{count}</span>
            {/each}
          </div>
        {/if}
        <div class="survivor-section">
          <span class="section-label">
            <span class="day">{ctx.villageStatus.day}d</span>
            生存 <span class="count">{survivorInfo.alive}</span>/<span class:mismatch={setupMismatch}>{survivorInfo.total}</span>
          </span>
          {#each survivorInfo.survivors as { seat, name }}
            <span class="survivor-badge" class:active-hl={$srcLines.survivor.get(seat) === $cursor}>
              <PlayerName dead={false} {seat}>{name}</PlayerName>
            </span>
          {/each}
          {#if survivorInfo.survivors.length === 0}
            <span class="empty">---</span>
          {/if}
        </div>
        <div class="scroll-area">
          <SummaryList days={deathHistory} groups={claimGroups} maxDay={ctx.villageStatus.day} players={ctx.players} {survivors} {nightKilled} {executed} {claimShortNames} masonCapacity={ctx.setup.get('mason') ?? 0} {deadPlayers} />
        </div>
      {:else}
        <div class="scroll-area">
          <VoteList status={voteStatus} />
        </div>
      {/if}
    </div>
  </div>

  {#if dialogSeat != null && dialogStatus}
    <PlayerDialog seat={dialogSeat} name={dialogName} status={dialogStatus} vs={ctx.villageStatus} setup={ctx.setup} players={ctx.players} onclose={closePlayerDialog} />
  {/if}
{/if}

<style>
  .vertical-status-pane {
    width: 320px;
    height: 720px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    font-family: var(--font-ui);
    font-size: 13px;
    box-sizing: border-box;
  }

  .tab-bar {
    flex: 0 0 auto;
    display: flex;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-elevated);
  }

  .tab {
    flex: 1;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--color-text-muted);
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-sizing: border-box;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab.active {
    color: var(--color-link);
    border-bottom-color: var(--color-link);
  }

  .tab-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .scroll-area {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .setup-section,
  .survivor-section {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 3px 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--color-border);
    font-size: 13px;
  }

  .section-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    margin-right: 2px;
  }

  .day {
    color: var(--color-text);
    margin-right: 2px;
  }

  .count {
    color: var(--color-village);
    font-size: 14px;
  }

  .mismatch {
    background: var(--color-danger-badge);
    color: var(--color-danger-text);
    padding: 0 4px;
    border-radius: 3px;
  }

  .setup-badge {
    display: inline-block;
    padding: 1px 5px;
    font-size: 12px;
    border-radius: 3px;
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

  .survivor-badge {
    display: inline-block;
    padding: 1px 6px;
    font-size: 12px;
    background: var(--color-surface);
    border-radius: 3px;
    color: var(--color-text);
  }

  .empty {
    color: var(--color-text-faint);
    font-size: 12px;
  }

  .active-hl {
    outline: 1.5px solid color-mix(in srgb, var(--color-link) 60%, transparent);
    background: color-mix(in srgb, var(--color-link) 15%, transparent);
  }
</style>
