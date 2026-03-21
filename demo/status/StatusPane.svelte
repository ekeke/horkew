<script lang="ts">
  import type { VillageStatus, SystemRole, SeatStatus } from '../../src/types/index.ts'
  import { systemRoles } from '../../src/types/index.ts'
  import { setContext } from 'svelte'
  import { writable } from 'svelte/store'
  import type { SourceLines } from '../App.svelte'
  import { extractSurvivorInfo, extractDeathHistory, extractClaimGroups, extractVoteStatus } from './extract.ts'
  import SurvivorSection from './SurvivorSection.svelte'
  import VoteTable from './VoteTable.svelte'
  import DeathHistory from './DeathHistory.svelte'
  import ClaimTable from './ClaimTable.svelte'
  import SummaryTable from './SummaryTable.svelte'
  import PlayerDialog from './PlayerDialog.svelte'

  let { vs, players, setup, shortNames = new Map(), sourceLines, cursorLine = 0 }: {
    vs: VillageStatus
    players: Map<number, string>
    setup: Map<SystemRole, number>
    shortNames?: Map<number, string>
    sourceLines: SourceLines
    cursorLine?: number
  } = $props()

  let dialogSeat: number | null = $state(null)
  let dialogName = $derived(dialogSeat != null ? players.get(dialogSeat) ?? `#${dialogSeat}` : '')
  let dialogStatus: SeatStatus | null = $derived(dialogSeat != null ? vs.statuses.get(dialogSeat) ?? null : null)

  function openPlayerDialog(seat: number) {
    dialogSeat = seat
  }

  setContext('playerclick', openPlayerDialog)

  const hoveredSeat = writable<number | null>(null)
  setContext('hoveredSeat', hoveredSeat)
  setContext('shortNames', shortNames)

  const srcLines = writable(sourceLines)
  const cursor = writable(cursorLine)
  $effect(() => { srcLines.set(sourceLines) })
  $effect(() => { cursor.set(cursorLine) })
  setContext('sourceLines', srcLines)
  setContext('cursorLine', cursor)

  function closePlayerDialog() {
    dialogSeat = null
  }

  let survivorInfo = $derived(extractSurvivorInfo(vs, players))
  let voteStatus = $derived(extractVoteStatus(vs, players))
  let deathHistory = $derived(extractDeathHistory(vs, players))
  let claimGroups = $derived(extractClaimGroups(vs, players))
  let survivors = $derived(new Set(survivorInfo.survivors.map(s => s.seat)))

  const nightKillCauses: Set<import('../../src/types/index.ts').CauseOfDeath> = new Set([
    'night_kill', 'follow_killed_hamster', 'cursed_by_killed_nekomata',
  ])
  const executionCauses: Set<import('../../src/types/index.ts').CauseOfDeath> = new Set([
    'execution', 'cursed_by_executed_nekomata', 'follow_executed_hamster',
  ])
  let nightKilled = $derived(new Set(
    [...vs.statuses.entries()]
      .filter(([, s]) => !s.surviving && s.causeOfDeath && nightKillCauses.has(s.causeOfDeath))
      .map(([seat]) => seat)
  ))
  let executed = $derived(new Set(
    [...vs.statuses.entries()]
      .filter(([, s]) => !s.surviving && s.causeOfDeath && executionCauses.has(s.causeOfDeath))
      .map(([seat]) => seat)
  ))
  let claimShortNames = $derived(new Map(
    [...vs.statuses.entries()]
      .filter(([, s]) => s.claiming)
      .map(([seat, s]) => [seat, systemRoles.get(s.claimingRole as SystemRole)?.shortName ?? s.claimingRole] as const)
  ))
</script>

<div class="status-pane">
  <SurvivorSection info={survivorInfo} />
  <SummaryTable days={deathHistory} groups={claimGroups} maxDay={vs.day} {players} {survivors} {nightKilled} {executed} {claimShortNames} />
  <VoteTable status={voteStatus} />
</div>

{#if dialogSeat != null && dialogStatus}
  <PlayerDialog seat={dialogSeat} name={dialogName} status={dialogStatus} vs={vs} {setup} {players} onclose={closePlayerDialog} />
{/if}

<style>
  .status-pane {
    font-family: system-ui, -apple-system, sans-serif;
  }
</style>
