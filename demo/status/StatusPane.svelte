<script lang="ts">
  import type { VillageStatus } from '../../src/types/index.ts'
  import { extractSurvivorInfo, extractDeathHistory, extractClaimGroups } from './extract.ts'
  import SurvivorSection from './SurvivorSection.svelte'
  import DeathHistory from './DeathHistory.svelte'
  import ClaimTable from './ClaimTable.svelte'

  let { vs, players }: {
    vs: VillageStatus
    players: Map<number, string>
  } = $props()

  let survivorInfo = $derived(extractSurvivorInfo(vs, players))
  let deathHistory = $derived(extractDeathHistory(vs, players))
  let claimGroups = $derived(extractClaimGroups(vs, players))
  let survivors = $derived(new Set(survivorInfo.survivors.map(s => s.seat)))
</script>

<div class="status-pane">
  <SurvivorSection info={survivorInfo} />
  <DeathHistory days={deathHistory} />
  <ClaimTable groups={claimGroups} maxDay={vs.day} {players} {survivors} />
</div>

<style>
  .status-pane {
    font-family: system-ui, -apple-system, sans-serif;
  }
</style>
