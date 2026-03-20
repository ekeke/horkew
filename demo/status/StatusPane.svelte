<script lang="ts">
  import type { VillageStatus, SystemRole } from '../../src/types/index.ts'
  import { systemRoles } from '../../src/types/index.ts'
  import { extractSurvivorInfo, extractDeathHistory, extractClaimGroups, extractVoteStatus } from './extract.ts'
  import SurvivorSection from './SurvivorSection.svelte'
  import VoteTable from './VoteTable.svelte'
  import DeathHistory from './DeathHistory.svelte'
  import ClaimTable from './ClaimTable.svelte'

  let { vs, players }: {
    vs: VillageStatus
    players: Map<number, string>
  } = $props()

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
  <VoteTable status={voteStatus} />
  <DeathHistory days={deathHistory} {claimShortNames} />
  <ClaimTable groups={claimGroups} maxDay={vs.day} {players} {survivors} {nightKilled} {executed} {claimShortNames} />
</div>

<style>
  .status-pane {
    font-family: system-ui, -apple-system, sans-serif;
  }
</style>
