<script lang="ts">
  import type { SeatStatus, SystemRole, CauseOfDeath, VillageStatus, EnumSpecies } from '../../types/index.ts'
  import { systemRoles } from '../../types/index.ts'
  import type { SeatResult } from '../analysis.worker.ts'
  import { extractVoteStatus, computeVerdicts } from './extract.ts'
  import { runParallelAnalysis } from '../runAnalysis.ts'
  import { serializeVillageStatus } from '../../retar/wasm-helpers.ts'
  import SpeciesIcon from './SpeciesIcon.svelte'

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

  let retarState = $state<RetarState>({ type: 'loading' })

  function runRetarCheck() {
    retarState = { type: 'loading' }

    const assumptions: [number, SystemRole][] = status.claiming
      ? [[seat, status.claimingRole as SystemRole]]
      : []

    runParallelAnalysis({
      vsJson: JSON.stringify(serializeVillageStatus(vs)),
      setupJson: JSON.stringify(Object.fromEntries(setup)),
      players: [...players],
      assumptions,
    }).then((data) => {
      if (data.type === 'error') {
        retarState = { type: 'error', message: data.message }
        return
      }
      retarState = { type: 'done', seats: data.seats }
    })
  }

  $effect(() => {
    void seat
    runRetarCheck()
  })

  // --- Main player verdict (derived from retarState) ---

  type Verdict = { type: 'loading' | 'ally' | 'ok' | 'busted' | 'exposed' | 'error', fixedRole?: string }

  function seatVerdict(seatId: number, claimingRole: string | null): Verdict {
    if (retarState.type === 'loading') return { type: 'loading' }
    if (retarState.type === 'error') return { type: 'error' }
    const result = retarState.seats.find(s => s.seat === seatId)
    const fixedRole = result && result.roles.length === 1
      ? systemRoles.get(result.roles[0])?.name ?? result.roles[0]
      : undefined
    if (!result || result.roles.length === 0) {
      return { type: claimingRole ? 'busted' : 'exposed' }
    }
    if (claimingRole) {
      if (!result.roles.includes(claimingRole as SystemRole)) return { type: 'busted', fixedRole }
    } else {
      const hasVillageRole = result.roles.some(r => {
        const role = systemRoles.get(r)
        return role && role.alignment === 'villager'
      })
      if (!hasVillageRole) return { type: 'exposed', fixedRole }
    }
    const allVillage = result.roles.every(r => {
      const role = systemRoles.get(r)
      return role && role.alignment === 'villager'
    })
    if (allVillage) return { type: 'ally', fixedRole }
    return { type: 'ok', fixedRole }
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

  let targetVerdict: Verdict = $derived(
    targetStatus ? seatVerdict(targetSeat, targetStatus.claiming ? targetStatus.claimingRole : null) : { type: 'loading' }
  )

  // --- Vote history (all days) ---

  type VoteTag = { text: string, color: 'exec' | 'runoff' | 'saved' }

  type DayVoteRelation = {
    day: number
    mainVotedForTarget: boolean
    targetVotedForMain: boolean
    mainTag: VoteTag | null
    targetTag: VoteTag | null
  }

  // Current day decisive vote analysis
  let voteAnalysis = $derived(extractVoteStatus(vs, players))
  let verdicts = $derived(computeVerdicts(voteAnalysis))

  function currentDayVoteTag(voterName: string, votedForSeat: number): VoteTag | null {
    const v = verdicts.get(votedForSeat)
    if (v?.executionVoterName === voterName) return { text: '処刑確定票', color: 'exec' }
    if (v?.runoffVoterName === voterName) return { text: '決戦確定票', color: 'runoff' }
    if (v?.savedBy === voterName) return { text: '救済票', color: 'saved' }
    return null
  }

  // For past days: determine tag from execution outcome
  function pastDayVoteTag(day: number, _voterSeat: number, votedForSeat: number): VoteTag | null {
    if (vs.multiVoteDays.has(day)) return null
    const executed = vs.executions.get(day)
    if (!executed) return null
    if (executed.includes(votedForSeat)) return { text: '処刑票', color: 'exec' }
    return null
  }

  let voteRelationHistory = $derived.by((): DayVoteRelation[] => {
    const result: DayVoteRelation[] = []
    const days = [...vs.voteHistory.keys()].sort((a, b) => a - b)
    for (const d of days) {
      const votes = vs.voteHistory.get(d) ?? []
      const mainVote = votes.find(v => v.voter === seat)
      const targetVote = votes.find(v => v.voter === targetSeat)
      const mainVotedForTarget = !!mainVote && mainVote.target === targetSeat
      const targetVotedForMain = !!targetVote && targetVote.target === seat
      if (!mainVotedForTarget && !targetVotedForMain) continue

      const isCurrentDay = d === vs.day
      let mainTag: VoteTag | null = null
      let targetTag: VoteTag | null = null
      if (mainVotedForTarget) {
        mainTag = isCurrentDay
          ? currentDayVoteTag(name, targetSeat)
          : pastDayVoteTag(d, seat, targetSeat)
      }
      if (targetVotedForMain) {
        targetTag = isCurrentDay
          ? currentDayVoteTag(targetName, seat)
          : pastDayVoteTag(d, targetSeat, seat)
      }

      result.push({ day: d, mainVotedForTarget, targetVotedForMain, mainTag, targetTag })
    }
    return result
  })

  // --- Seer / Medium divination results ---

  type DivinationEntry = { seerName: string, species: EnumSpecies | null }
  type MediumEntry = { mediumName: string, species: EnumSpecies | null }

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

  // Find a seer's divination result for a given target seat
  function seerResultFor(seerStatus: SeatStatus, targetSeat: number): EnumSpecies | null {
    for (const [, { target, species }] of seerStatus.assertions) {
      if (target === targetSeat) return species
    }
    return null
  }

  // Find medium result for a given player seat (must have been executed)
  function mediumResultFor(_mediumSeat: number, mediumStatus: SeatStatus, playerSeat: number, playerStatus: SeatStatus): EnumSpecies | null {
    // Player must have died by execution
    if (playerStatus.surviving) return null
    if (playerStatus.causeOfDeath !== 'execution') return null
    // Medium must have been alive when the execution happened
    if (!mediumStatus.surviving && mediumStatus.diedDay != null && playerStatus.diedDay != null && mediumStatus.diedDay <= playerStatus.diedDay) return null
    // Check medium's assertions for a matching target
    for (const [, { target, species }] of mediumStatus.assertions) {
      if (target === playerSeat) return species
    }
    return null
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
      case 'sudden_death': return '突然死'
    }
  }

  function verdictLabel(v: Verdict): string {
    if (v.fixedRole) return v.fixedRole
    switch (v.type) {
      case 'busted': return '敵対'
      case 'exposed': return '敵対'
      case 'ally': return '同陣営'
      case 'ok': return '未定'
      case 'error': return 'エラー'
      default: return '...'
    }
  }

  function verdictClass(v: Verdict): string {
    switch (v.type) {
      case 'busted': return 'busted'
      case 'exposed': return 'exposed'
      case 'ally': return 'ally'
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
    if (e.key === 'ArrowLeft') { prevTarget(); e.preventDefault() }
    if (e.key === 'ArrowRight') { nextTarget(); e.preventDefault() }
  }

  function onWheel(e: WheelEvent) {
    // Tilt wheel (horizontal scroll) to navigate targets
    if (e.deltaX !== 0) {
      if (e.deltaX > 0) nextTarget()
      else prevTarget()
      e.preventDefault()
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="overlay" onclick={onOverlayClick}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="dialog" onclick={(e) => e.stopPropagation()} onwheel={onWheel}>
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
            <span class="div-chip"><span class="div-name">{entry.seerName}</span><span class="div-species" class:human={entry.species === 'human'} class:wolf={entry.species === 'wolf'} class:unknown={entry.species == null}>{#if entry.species}<SpeciesIcon species={entry.species} />{:else}-{/if}</span></span>
          {/each}
          {#each mainDivinations.mediums as entry}
            <span class="div-chip medium-chip"><span class="div-name">{entry.mediumName}</span><span class="div-species" class:human={entry.species === 'human'} class:wolf={entry.species === 'wolf'} class:unknown={entry.species == null}>{#if entry.species}<SpeciesIcon species={entry.species} />{:else}-{/if}</span></span>
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
                <span class="div-chip"><span class="div-name">{entry.seerName}</span><span class="div-species" class:human={entry.species === 'human'} class:wolf={entry.species === 'wolf'} class:unknown={entry.species == null}>{#if entry.species}<SpeciesIcon species={entry.species} />{:else}-{/if}</span></span>
              {/each}
              {#each targetDivinations.mediums as entry}
                <span class="div-chip medium-chip"><span class="div-name">{entry.mediumName}</span><span class="div-species" class:human={entry.species === 'human'} class:wolf={entry.species === 'wolf'} class:unknown={entry.species == null}>{#if entry.species}<SpeciesIcon species={entry.species} />{:else}-{/if}</span></span>
              {/each}
            </div>
          {/if}
          {#if voteRelationHistory.length > 0}
            <div class="vote-history">
              {#each voteRelationHistory as rel}
                <div class="vote-day">
                  <span class="vote-day-label">{rel.day}d</span>
                  <div class="vote-day-content">
                    {#if rel.mainVotedForTarget}
                      <span class="vote-arrow mutual">
                        {name} → {targetName}
                        {#if rel.mainTag}<span class="vote-tag {rel.mainTag.color}">{rel.mainTag.text}</span>{/if}
                      </span>
                    {/if}
                    {#if rel.targetVotedForMain}
                      <span class="vote-arrow mutual">
                        {targetName} → {name}
                        {#if rel.targetTag}<span class="vote-tag {rel.targetTag.color}">{rel.targetTag.text}</span>{/if}
                      </span>
                    {/if}
                  </div>
                </div>
              {/each}
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
    background: var(--color-overlay-backdrop);
    display: flex;
    justify-content: center;
    z-index: 100;
    padding-top: 10vh;
    align-items: flex-start;
  }

  .dialog {
    background: var(--color-bg);
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    width: 420px;
    max-height: 80vh;
    overflow-y: auto;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-border);
  }

  .dialog-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--color-text-faint);
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .close-btn:hover {
    color: var(--color-text);
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
    color: var(--color-text-muted);
    min-width: 56px;
    flex-shrink: 0;
  }

  .value {
    color: var(--color-text);
  }

  .claim-value {
    color: var(--color-co);
    font-weight: 600;
  }

  .none {
    color: var(--color-text-faint);
  }

  .detail {
    color: var(--color-text-faint);
    font-size: 12px;
  }

  .dead {
    opacity: var(--opacity-dead-player);
  }

  .busted {
    color: var(--color-error);
    font-weight: 600;
  }

  .exposed {
    color: var(--color-execution);
    font-weight: 600;
  }

  .ally {
    color: var(--ctp-sky);
    font-weight: 600;
  }

  .ok {
    color: var(--color-village);
  }

  .error {
    color: var(--color-error);
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
    background: var(--color-surface);
    border-radius: 3px;
    padding: 1px 6px;
    border-left: 2px solid var(--color-link);
  }

  .medium-chip {
    border-left-color: var(--color-accent);
  }

  .div-name {
    color: var(--color-text-muted);
  }

  .div-species {
    font-weight: 600;
  }

  .div-species.human {
    color: var(--color-human-result);
  }

  .div-species.wolf {
    color: var(--color-wolf-result);
  }

  .div-species.unknown {
    color: var(--color-text-faint);
  }

  /* --- Relation section --- */

  .relation-section {
    border-top: 1px solid var(--color-border);
  }

  .relation-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 4px;
  }

  .nav-btn {
    background: none;
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    color: var(--color-text);
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
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .relation-target {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
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
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .rel-sep {
    color: var(--color-border-strong);
    margin: 0 2px;
  }

  .roles-list {
    color: var(--color-link);
    letter-spacing: 0.5px;
  }

  .vote-history {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
  }

  .vote-day {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }

  .vote-day-label {
    color: var(--color-text-faint);
    font-size: 11px;
    min-width: 20px;
    flex-shrink: 0;
  }

  .vote-day-content {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .vote-arrow {
    color: var(--color-text-muted);
    font-size: 12px;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .vote-arrow.mutual {
    color: var(--color-text);
    font-weight: 500;
  }

  .vote-tag {
    font-size: 10px;
    font-weight: 600;
    padding: 0 4px;
    border-radius: 2px;
  }

  .vote-tag.exec {
    color: var(--color-error);
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
  }

  .vote-tag.runoff {
    color: var(--color-execution);
    background: color-mix(in srgb, var(--color-execution) 15%, transparent);
  }

  .vote-tag.saved {
    color: var(--color-village);
    background: color-mix(in srgb, var(--color-village) 15%, transparent);
  }
</style>
