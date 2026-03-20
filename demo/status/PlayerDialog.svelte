<script lang="ts">
  import type { SeatStatus, SystemRole, CauseOfDeath, VillageStatus } from '../../src/types/index.ts'
  import { systemRoles } from '../../src/types/index.ts'
  import type { RetarResponse, SeatResult } from '../analysis.worker.ts'
  import { extractVoteStatus, computeVerdicts } from './extract.ts'
  import AnalysisWorker from '../analysis.worker.ts?worker'

  let { seat, name, status, vs, setup, players, onclose }: {
    seat: number
    name: string
    status: SeatStatus
    vs: VillageStatus
    setup: Map<SystemRole, number>
    players: Map<number, string>
    onclose: () => void
  } = $props()

  let roleName = $derived(
    status.claiming
      ? systemRoles.get(status.claimingRole as SystemRole)?.name ?? status.claimingRole
      : null
  )

  // --- Retar analysis (stores full result for relation view) ---

  type RetarState =
    | { type: 'loading' }
    | { type: 'done', seats: SeatResult[] }
    | { type: 'error', message: string }

  let retarState: RetarState = $state({ type: 'loading' })

  function serializeVs(v: VillageStatus) {
    const statuses = [...v.statuses].map(([s, st]) => [s, {
      ...st,
      actions: [...st.actions],
      assertions: [...st.assertions],
    }])
    return {
      ...v,
      statuses,
      executions: [...v.executions],
      kills: [...v.kills],
      roles: [...v.roles],
      claims: [...v.claims],
    }
  }

  function runRetarCheck() {
    retarState = { type: 'loading' }

    const assumptions: [number, SystemRole][] = status.claiming
      ? [[seat, status.claimingRole as SystemRole]]
      : []

    const worker = new AnalysisWorker()
    worker.onmessage = (e: MessageEvent<RetarResponse>) => {
      worker.terminate()
      const data = e.data
      if (data.type === 'error') {
        retarState = { type: 'error', message: data.message }
        return
      }
      retarState = { type: 'done', seats: data.seats }
    }
    worker.onerror = (e) => {
      worker.terminate()
      retarState = { type: 'error', message: e.message ?? 'Worker error' }
    }

    worker.postMessage({
      vs: serializeVs(vs),
      setup: [...setup],
      players: [...players],
      assumptions,
    })
  }

  $effect(() => {
    void seat
    runRetarCheck()
  })

  // --- Main player verdict (derived from retarState) ---

  function seatVerdict(seatId: number, claimingRole: string | null): 'loading' | 'ok' | 'busted' | 'exposed' | 'error' {
    if (retarState.type === 'loading') return 'loading'
    if (retarState.type === 'error') return 'error'
    const result = retarState.seats.find(s => s.seat === seatId)
    if (!result || result.roles.length === 0) {
      return claimingRole ? 'busted' : 'exposed'
    }
    if (claimingRole) {
      // CO した役職が可能役職に含まれていなければ破綻
      if (!result.roles.includes(claimingRole as SystemRole)) return 'busted'
    } else {
      const hasVillageRole = result.roles.some(r => {
        const role = systemRoles.get(r)
        return role && role.alignment === 'villager'
      })
      if (!hasVillageRole) return 'exposed'
    }
    return 'ok'
  }

  let mainVerdict = $derived(seatVerdict(seat, status.claiming ? status.claimingRole : null))

  // --- Relation target rotation ---

  let otherSeats = $derived(
    [...players.keys()].filter(s => s !== seat).sort((a, b) => a - b)
  )
  let targetIndex = $state(0)

  $effect(() => {
    void seat
    targetIndex = 0
  })

  let targetSeat = $derived(otherSeats[targetIndex] ?? -1)
  let targetName = $derived(players.get(targetSeat) ?? '')
  let targetStatus = $derived(vs.statuses.get(targetSeat))

  function prevTarget() {
    targetIndex = (targetIndex - 1 + otherSeats.length) % otherSeats.length
  }

  function nextTarget() {
    targetIndex = (targetIndex + 1) % otherSeats.length
  }

  // --- Target: CO info ---

  let targetClaimName = $derived(
    targetStatus?.claiming
      ? systemRoles.get(targetStatus.claimingRole as SystemRole)?.name ?? targetStatus.claimingRole
      : null
  )

  // --- Target: possible roles from main's perspective ---

  let targetRolesLabel = $derived.by(() => {
    if (retarState.type !== 'done') return null
    const result = retarState.seats.find(s => s.seat === targetSeat)
    if (!result || result.roles.length === 0) return null
    return result.roles
      .map(r => systemRoles.get(r)?.shortName ?? r)
      .join(' ')
  })

  let targetVerdict = $derived(
    targetStatus ? seatVerdict(targetSeat, targetStatus.claiming ? targetStatus.claimingRole : null) : 'loading'
  )

  // --- Vote relationship ---

  let mainVotedTarget = $derived(status.voted && status.votedTarget === targetSeat)
  let targetVotedMain = $derived(!!targetStatus?.voted && targetStatus.votedTarget === seat)

  // --- Decisive / salvation vote analysis ---

  let voteAnalysis = $derived(extractVoteStatus(vs, players))
  let verdicts = $derived(computeVerdicts(voteAnalysis))

  type VoteTag = { text: string, color: 'exec' | 'runoff' | 'saved' }

  let mainToTargetTag = $derived.by((): VoteTag | null => {
    if (!mainVotedTarget) return null
    const v = verdicts.get(targetSeat)
    if (v?.executionVoterName === name) return { text: '処刑確定票', color: 'exec' }
    if (v?.runoffVoterName === name) return { text: '決戦確定票', color: 'runoff' }
    return null
  })

  let targetToMainTag = $derived.by((): VoteTag | null => {
    if (!targetVotedMain) return null
    const v = verdicts.get(seat)
    if (v?.executionVoterName === targetName) return { text: '処刑確定票', color: 'exec' }
    if (v?.runoffVoterName === targetName) return { text: '決戦確定票', color: 'runoff' }
    if (v?.savedBy === targetName) return { text: '救済票', color: 'saved' }
    return null
  })

  let mainSavedByTarget = $derived.by((): boolean => {
    const v = verdicts.get(seat)
    return v?.savedBy === targetName
  })

  // --- Seer / Medium divination results ---

  type DivinationEntry = { seerName: string, species: '○' | '●' | '-' }
  type MediumEntry = { mediumName: string, species: '○' | '●' | '-' }

  // All seer claimants (sorted by CO order)
  let seerClaimants = $derived(
    [...vs.statuses.entries()]
      .filter(([, s]) => s.claiming && s.claimingRole === 'seer')
      .sort(([, a], [, b]) => (a.claimOrder ?? Infinity) - (b.claimOrder ?? Infinity))
  )

  // All medium claimants (sorted by CO order)
  let mediumClaimants = $derived(
    [...vs.statuses.entries()]
      .filter(([, s]) => s.claiming && s.claimingRole === 'medium')
      .sort(([, a], [, b]) => (a.claimOrder ?? Infinity) - (b.claimOrder ?? Infinity))
  )

  function speciesSymbol(species: import('../../src/types/index.ts').EnumSpecies): '○' | '●' {
    return species === 'wolf' ? '●' : '○'
  }

  // Find a seer's divination result for a given target seat
  function seerResultFor(seerStatus: SeatStatus, targetSeat: number): '○' | '●' | '-' {
    for (const [, { target, species }] of seerStatus.assertions) {
      if (target === targetSeat) return speciesSymbol(species)
    }
    return '-'
  }

  // Find medium result for a given player seat (must have been executed)
  function mediumResultFor(mediumSeat: number, mediumStatus: SeatStatus, playerSeat: number, playerStatus: SeatStatus): '○' | '●' | '-' {
    // Player must have died by execution
    if (playerStatus.surviving) return '-'
    if (playerStatus.causeOfDeath !== 'execution') return '-'
    // Medium must have been alive when the execution happened
    if (!mediumStatus.surviving && mediumStatus.diedDay != null && playerStatus.diedDay != null && mediumStatus.diedDay <= playerStatus.diedDay) return '-'
    // Check medium's assertions for a matching target
    for (const [, { target, species }] of mediumStatus.assertions) {
      if (target === playerSeat) return speciesSymbol(species)
    }
    return '-'
  }

  let mainDivinations = $derived.by(() => {
    const seers: DivinationEntry[] = seerClaimants.map(([seerSeat, s]) => ({
      seerName: players.get(seerSeat) ?? '?',
      species: seerResultFor(s, seat),
    }))
    const mediums: MediumEntry[] = mediumClaimants.map(([medSeat, s]) => ({
      mediumName: players.get(medSeat) ?? '?',
      species: mediumResultFor(medSeat, s, seat, status),
    }))
    return { seers, mediums }
  })

  let targetDivinations = $derived.by(() => {
    if (!targetStatus) return { seers: [] as DivinationEntry[], mediums: [] as MediumEntry[] }
    const seers: DivinationEntry[] = seerClaimants.map(([seerSeat, s]) => ({
      seerName: players.get(seerSeat) ?? '?',
      species: seerResultFor(s, targetSeat),
    }))
    const mediums: MediumEntry[] = mediumClaimants.map(([medSeat, s]) => ({
      mediumName: players.get(medSeat) ?? '?',
      species: mediumResultFor(medSeat, s, targetSeat, targetStatus),
    }))
    return { seers, mediums }
  })

  // --- Helpers ---

  function causeLabel(cause: CauseOfDeath): string {
    switch (cause) {
      case 'execution': return '処刑'
      case 'night_kill': return '襲撃'
      case 'follow_executed_hamster': return '後追い'
      case 'follow_killed_hamster': return '後追い'
      case 'cursed_by_executed_nekomata': return '道連れ'
      case 'cursed_by_killed_nekomata': return '道連れ'
    }
  }

  function verdictLabel(v: string): string {
    switch (v) {
      case 'busted': return '破綻'
      case 'exposed': return '人外露呈'
      case 'ok': return '整合'
      case 'error': return 'エラー'
      default: return '...'
    }
  }

  function verdictClass(v: string): string {
    switch (v) {
      case 'busted': return 'busted'
      case 'exposed': return 'exposed'
      case 'ok': return 'ok'
      case 'error': return 'error'
      default: return 'none'
    }
  }

  function onOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onOverlayClick}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <span class="dialog-title">{name}</span>
      <button class="close-btn" onclick={onclose}>&times;</button>
    </div>
    <div class="dialog-body">
      <div class="info-row">
        <span class="label">役職CO</span>
        {#if status.claiming}
          <span class="value claim-value">{roleName}</span>
          {#if status.claimedAt != null}
            <span class="detail">{status.claimedAt}d CO</span>
          {/if}
        {:else}
          <span class="value none">未CO</span>
        {/if}
      </div>
      <div class="info-row">
        <span class="label">状態</span>
        {#if status.surviving}
          <span class="value">生存</span>
        {:else}
          <span class="value dead">{status.diedDay}d {causeLabel(status.causeOfDeath)}</span>
        {/if}
      </div>
      <div class="info-row">
        <span class="label">判定</span>
        <span class="value {verdictClass(mainVerdict)}">{verdictLabel(mainVerdict)}</span>
      </div>
      {#if mainDivinations.seers.length > 0 || mainDivinations.mediums.length > 0}
        <div class="divination-row">
          {#each mainDivinations.seers as entry}
            <span class="div-chip"><span class="div-name">{entry.seerName}</span><span class="div-species" class:human={entry.species === '○'} class:wolf={entry.species === '●'} class:unknown={entry.species === '-'}>{entry.species}</span></span>
          {/each}
          {#each mainDivinations.mediums as entry}
            <span class="div-chip medium-chip"><span class="div-name">{entry.mediumName}</span><span class="div-species" class:human={entry.species === '○'} class:wolf={entry.species === '●'} class:unknown={entry.species === '-'}>{entry.species}</span></span>
          {/each}
        </div>
      {/if}
    </div>
    {#if otherSeats.length > 0}
      <div class="relation-section">
        <div class="relation-header">
          <button class="nav-btn" onclick={prevTarget}>&lsaquo;</button>
          <span class="relation-target">{targetName}</span>
          <button class="nav-btn" onclick={nextTarget}>&rsaquo;</button>
        </div>
        <div class="relation-body">
          <div class="rel-row">
            <span class="rel-label">CO</span>
            {#if targetClaimName}
              <span class="claim-value">{targetClaimName}</span>
            {:else}
              <span class="none">未CO</span>
            {/if}
            <span class="rel-sep">|</span>
            {#if targetStatus?.surviving}
              <span>生存</span>
            {:else if targetStatus}
              <span class="dead">{targetStatus.diedDay}d {causeLabel(targetStatus.causeOfDeath)}</span>
            {/if}
            <span class="rel-sep">|</span>
            <span class="rel-label">判定</span>
            <span class={verdictClass(targetVerdict)}>{verdictLabel(targetVerdict)}</span>
          </div>
          {#if retarState.type === 'done' && targetRolesLabel}
            <div class="rel-row">
              <span class="rel-label">可能役職</span>
              <span class="roles-list">{targetRolesLabel}</span>
            </div>
          {/if}
          {#if targetDivinations.seers.length > 0 || targetDivinations.mediums.length > 0}
            <div class="divination-row">
              {#each targetDivinations.seers as entry}
                <span class="div-chip"><span class="div-name">{entry.seerName}</span><span class="div-species" class:human={entry.species === '○'} class:wolf={entry.species === '●'} class:unknown={entry.species === '-'}>{entry.species}</span></span>
              {/each}
              {#each targetDivinations.mediums as entry}
                <span class="div-chip medium-chip"><span class="div-name">{entry.mediumName}</span><span class="div-species" class:human={entry.species === '○'} class:wolf={entry.species === '●'} class:unknown={entry.species === '-'}>{entry.species}</span></span>
              {/each}
            </div>
          {/if}
          {#if mainVotedTarget || targetVotedMain}
            <div class="rel-row vote-row">
              {#if mainVotedTarget}
                <span class="vote-arrow">
                  {name} → {targetName}
                  {#if mainToTargetTag}
                    <span class="vote-tag {mainToTargetTag.color}">{mainToTargetTag.text}</span>
                  {/if}
                </span>
              {/if}
              {#if targetVotedMain}
                <span class="vote-arrow">
                  {targetName} → {name}
                  {#if targetToMainTag}
                    <span class="vote-tag {targetToMainTag.color}">{targetToMainTag.text}</span>
                  {/if}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 8px;
    min-width: 280px;
    max-width: 400px;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #313244;
  }

  .dialog-title {
    font-size: 15px;
    font-weight: 600;
    color: #cdd6f4;
  }

  .close-btn {
    background: none;
    border: none;
    color: #585b70;
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .close-btn:hover {
    color: #cdd6f4;
  }

  .dialog-body {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .info-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
  }

  .label {
    color: #a6adc8;
    min-width: 56px;
    flex-shrink: 0;
  }

  .value {
    color: #cdd6f4;
  }

  .claim-value {
    color: #cba6f7;
    font-weight: 600;
  }

  .none {
    color: #585b70;
  }

  .detail {
    color: #585b70;
    font-size: 12px;
  }

  .dead {
    color: #f38ba8;
  }

  .busted {
    color: #f38ba8;
    font-weight: 600;
  }

  .exposed {
    color: #fab387;
    font-weight: 600;
  }

  .ok {
    color: #a6e3a1;
  }

  .error {
    color: #f38ba8;
  }

  /* --- Divination chips --- */

  .divination-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 2px;
  }

  .div-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: 11px;
    background: #313244;
    border-radius: 3px;
    padding: 1px 6px;
    border-left: 2px solid #89b4fa;
  }

  .medium-chip {
    border-left-color: #cba6f7;
  }

  .div-name {
    color: #a6adc8;
  }

  .div-species {
    font-weight: 600;
  }

  .div-species.human {
    color: #a6e3a1;
  }

  .div-species.wolf {
    color: #f38ba8;
  }

  .div-species.unknown {
    color: #585b70;
  }

  /* --- Relation section --- */

  .relation-section {
    border-top: 1px solid #313244;
  }

  .relation-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 4px;
  }

  .nav-btn {
    background: none;
    border: 1px solid #45475a;
    border-radius: 4px;
    color: #cdd6f4;
    font-size: 18px;
    line-height: 1;
    width: 28px;
    height: 28px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .nav-btn:hover {
    border-color: #cba6f7;
    color: #cba6f7;
  }

  .relation-target {
    font-size: 14px;
    font-weight: 600;
    color: #cdd6f4;
  }

  .relation-body {
    padding: 4px 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .rel-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 12px;
    flex-wrap: wrap;
  }

  .rel-label {
    color: #a6adc8;
    flex-shrink: 0;
  }

  .rel-sep {
    color: #45475a;
    margin: 0 2px;
  }

  .roles-list {
    color: #89b4fa;
    letter-spacing: 0.5px;
  }

  .vote-row {
    flex-direction: column;
    gap: 2px;
    margin-top: 2px;
  }

  .vote-arrow {
    color: #cdd6f4;
    font-size: 12px;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .vote-tag {
    font-size: 10px;
    font-weight: 600;
    padding: 0 4px;
    border-radius: 2px;
  }

  .vote-tag.exec {
    color: #f38ba8;
    background: rgba(243, 139, 168, 0.15);
  }

  .vote-tag.runoff {
    color: #fab387;
    background: rgba(250, 179, 135, 0.15);
  }

  .vote-tag.saved {
    color: #a6e3a1;
    background: rgba(166, 227, 161, 0.15);
  }
</style>
