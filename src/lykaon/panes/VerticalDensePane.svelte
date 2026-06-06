<script lang="ts">
  import type { Snippet } from 'svelte'
  import { systemRoles } from '../../types/index.ts'
  import type { SystemRole } from '../../types/index.ts'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'
  import type { ClaimRow, DayAssertion } from '../status/extract.ts'
  import { buildAssertionTimeline, extractClaimGroups } from '../status/extract.ts'
  import { buildMasonClusters } from '../status/masonClusters.ts'
  import PlayerName from '../status/PlayerName.svelte'
  import SpeciesIcon from '../status/SpeciesIcon.svelte'
  import { classifyPlayer } from '../status/playerStatus.ts'

  let { ctx, onInsertRevealRoles, onOpenDenyWolfDialog, extraFooter, hideAssumptions = false }: {
    ctx: AnalysisContext
    onInsertRevealRoles?: (done: () => void) => void
    onOpenDenyWolfDialog?: () => void
    extraFooter?: Snippet
    hideAssumptions?: boolean
  } = $props()

  let insertRevealBusy = $state(false)

  function handleInsertReveal(): void {
    if (insertRevealBusy) return
    if (onInsertRevealRoles) {
      insertRevealBusy = true
      let released = false
      const done = (): void => {
        if (released) return
        released = true
        insertRevealBusy = false
      }
      try {
        onInsertRevealRoles(done)
      } catch (e) {
        done()
        throw e
      }
    } else {
      ctx.insertRevealRoles()
    }
  }

  function roleToShort(role: SystemRole): string {
    return systemRoles.get(role)?.shortName ?? role
  }

  let currentMap = $derived(new Map(ctx.analysisSeats.map(s => [s.seat, s.roles])))
  let baseMap = $derived(new Map(ctx.baseAnalysisSeats.map(s => [s.seat, s.roles])))

  /** broken 検出時 (全 seat に提示) または既に hocuspocus on の seat は、トグルを露出する */
  function shouldShowHocuspocus(seat: number): boolean {
    return ctx.brokenSeats.size > 0 || ctx.hocusPocusSeats.has(seat)
  }

  function buildCurrentClaimRow(seat: number): ClaimRow | null {
    const vs = ctx.villageStatus
    if (!vs) return null
    const s = vs.statuses.get(seat)
    if (!s || !s.claiming) return null
    return {
      seat,
      name: ctx.players.get(seat) ?? `#${seat}`,
      claimingRole: s.claimingRole,
      claimedAt: s.claimedAt,
      claimOrder: s.claimOrder,
      assertions: s.assertions,
      actions: s.actions,
      forecasts: s.forecasts,
      surviving: s.surviving,
      causeOfDeath: s.causeOfDeath,
      diedDay: s.diedDay,
      previousAssertions: s.previousAssertions,
    }
  }

  type ResultEntry = { day: number, assertion: DayAssertion, isBodyguard: boolean }

  function buildResultsFor(seat: number): ResultEntry[] {
    const row = buildCurrentClaimRow(seat)
    if (!row) return []
    if (row.claimingRole !== 'seer' && row.claimingRole !== 'medium' && row.claimingRole !== 'bodyguard') return []
    const vs = ctx.villageStatus
    if (!vs) return []
    const timeline = buildAssertionTimeline(row, vs.day, ctx.players)
    const isBodyguard = row.claimingRole === 'bodyguard'
    return [...timeline.entries()]
      .sort(([a], [b]) => a - b)
      .map(([night, assertion]) => ({ day: night + 1, assertion, isBodyguard }))
  }

  type SubTable = { tag: string, seats: number[], roles: SystemRole[], setGrouping: boolean, primaryRole?: SystemRole }

  type CoMainGroup = 'main' | 'support' | 'nonCo'
  type CoSubDef = {
    mainGroup: CoMainGroup
    /** sub-table の左上に出す 1 文字タグ */
    tag: string
    /** この CO の村役職。 sub-table 内で「主役職以外の村役職」セルを省略する基準。 undefined のとき省略しない */
    primaryRole?: SystemRole
    matches: (claimingRole: string | undefined, claiming: boolean, divined: boolean) => boolean
  }

  /** 内訳可能性の分析意義が薄い CO は 1 行リストに圧縮する */
  const COMPACT_PRIMARY_ROLES = new Set<SystemRole>(['mason', 'nekomata'])

  const KNOWN_VILLAGER_NAMES = new Set<string>(
    [...systemRoles.entries()].filter(([, r]) => r.alignment === 'villager').map(([k]) => k)
  )

  const CO_SUB_DEFS: CoSubDef[] = (() => {
    const defs: CoSubDef[] = []
    for (const [key, role] of systemRoles) {
      if (role.alignment !== 'villager') continue
      const mainGroup: CoMainGroup =
        (role.category === 'seer' || role.category === 'medium') ? 'main' : 'support'
      defs.push({
        mainGroup,
        tag: role.shortName,
        primaryRole: key as SystemRole,
        matches: (r, c) => c && r === key,
      })
    }
    defs.push({
      mainGroup: 'support',
      tag: '他',
      matches: (r, c) => c && !KNOWN_VILLAGER_NAMES.has(r ?? ''),
    })
    defs.push({ mainGroup: 'nonCo', tag: '村', matches: (_r, c, d) => !c && d })
    defs.push({ mainGroup: 'nonCo', tag: '灰', matches: (_r, c, d) => !c && !d })
    return defs
  })()

  function rolesForDef(def: CoSubDef): SystemRole[] {
    if (def.primaryRole === undefined) return ctx.analysisColumns
    return ctx.analysisColumns.filter(role => {
      const r = systemRoles.get(role)
      if (!r) return true
      if (r.alignment !== 'villager') return true
      return role === def.primaryRole
    })
  }

  function basePossibilitiesFor(seat: number): SystemRole[] {
    return baseMap.get(seat) ?? []
  }

  function hasCorePossibility(seat: number): boolean {
    for (const role of basePossibilitiesFor(seat)) {
      const r = systemRoles.get(role)
      if (!r) continue
      if (r.alignment === 'werewolf' || r.alignment === 'werehamster') return true
    }
    return false
  }

  function hasNonVillagerPossibility(seat: number): boolean {
    for (const role of basePossibilitiesFor(seat)) {
      const r = systemRoles.get(role)
      if (!r) continue
      if (r.alignment !== 'villager') return true
    }
    return false
  }

  function possibilitiesSetKey(seat: number): string {
    return [...basePossibilitiesFor(seat)].sort().join(',')
  }

  /** 村/灰 の seat ソート (alive → 人外本体 → 人外 → set 同一性 → seat) */
  function compareNonCoSeats(a: number, b: number): number {
    const aliveA = ctx.deadSeats.has(a) ? 1 : 0
    const aliveB = ctx.deadSeats.has(b) ? 1 : 0
    if (aliveA !== aliveB) return aliveA - aliveB
    const coreA = hasCorePossibility(a) ? 0 : 1
    const coreB = hasCorePossibility(b) ? 0 : 1
    if (coreA !== coreB) return coreA - coreB
    const nvA = hasNonVillagerPossibility(a) ? 0 : 1
    const nvB = hasNonVillagerPossibility(b) ? 0 : 1
    if (nvA !== nvB) return nvA - nvB
    const kA = possibilitiesSetKey(a)
    const kB = possibilitiesSetKey(b)
    if (kA !== kB) return kA < kB ? -1 : 1
    return a - b
  }

  /** seat の表示可能性: sourceRoles から base (アサンプション無し) で残った役職。 アサンプションで消えたものは dim */
  function possibilitiesFor(seat: number, sourceRoles: SystemRole[]): { role: SystemRole, dim: boolean }[] {
    const base = baseMap.get(seat) ?? []
    const cur = currentMap.get(seat) ?? []
    const out: { role: SystemRole, dim: boolean }[] = []
    for (const role of sourceRoles) {
      if (!base.includes(role)) continue
      out.push({ role, dim: !cur.includes(role) })
    }
    return out
  }

  function buildCoSubTables(): SubTable[] {
    const vs = ctx.villageStatus
    if (!vs) return []
    const divined = ctx.divinedSeats
    const allSeats = [...ctx.players.keys()]
    const subTables: SubTable[] = []
    for (const def of CO_SUB_DEFS) {
      const matched: { seat: number, order: number }[] = []
      for (const seat of allSeats) {
        const s = vs.statuses.get(seat)
        if (def.matches(s?.claimingRole, !!s?.claiming, divined.has(seat))) {
          matched.push({ seat, order: s?.claimOrder ?? seat })
        }
      }
      if (matched.length > 0) {
        let seats: number[]
        if (def.mainGroup === 'nonCo') {
          seats = matched.map(m => m.seat).sort(compareNonCoSeats)
        } else {
          matched.sort((a, b) => a.order - b.order)
          seats = matched.map(m => m.seat)
        }
        subTables.push({
          tag: def.tag,
          seats,
          roles: rolesForDef(def),
          setGrouping: def.mainGroup === 'nonCo',
          primaryRole: def.primaryRole,
        })
      }
    }
    return subTables
  }

  let subTables = $derived(buildCoSubTables())

  let masonCapacity = $derived(ctx.setup.get('mason') ?? 0)
  let deadPlayerNames = $derived.by(() => {
    const map = new Map<number, string>()
    const vs = ctx.villageStatus
    if (!vs) return map
    for (const [seat, status] of vs.statuses) {
      if (!status.surviving) map.set(seat, ctx.players.get(seat) ?? `#${seat}`)
    }
    return map
  })
  let masonClustersData = $derived.by(() => {
    const vs = ctx.villageStatus
    if (!vs) return []
    const groups = extractClaimGroups(vs, ctx.players)
    const masonGroup = groups.find(g => g.role === 'mason')
    return buildMasonClusters(masonGroup, masonCapacity, deadPlayerNames).clusters
  })
</script>

{#if ctx.analysisError}
  <pre class="va-error lyk-pane">Error: {ctx.analysisError}</pre>
{/if}
{#if ctx.analysisColumns.length > 0 && ctx.players.size > 0}
  <div class="vertical-analysis-pane lyk-pane">
    <div class="va-tables">
      {#each subTables as st}
        <div class="va-sub-table">
          <div class="va-sub-tag">{st.tag}</div>
          <div class="va-sub-body">
          {#if st.primaryRole === 'mason'}
            {@const claimingSeats = new Set(st.seats)}
            <div class="va-poss-line">
              {#each masonClustersData as cluster, ci}
                {#if ci > 0}<span class="va-mason-cluster-sep"> / </span>{/if}
                {#each cluster.members as member, mi}
                  {#if mi > 0}<span class="va-mason-link">-</span>{/if}
                  {@const isClaiming = claimingSeats.has(member.seat)}
                  {@const possibilities = isClaiming ? possibilitiesFor(member.seat, st.roles) : []}
                  {@const memberStatus = classifyPlayer(currentMap.get(member.seat) ?? [])}
                  {@const memberBase = basePossibilitiesFor(member.seat)}
                  {@const memberConfirmedRole = memberBase.length === 1 ? memberBase[0] : undefined}
                  <span class="va-poss-item">
                    <span class="va-poss-row">
                      <PlayerName
                        dead={ctx.deadSeats.has(member.seat)}
                        nightKill={ctx.nightKilledSeats.has(member.seat)}
                        executed={ctx.executedSeats.has(member.seat)}
                        seat={member.seat}
                        status={memberStatus}
                        broken={ctx.brokenSeats.has(member.seat)}
                      >{ctx.playerShortNames.get(member.seat) ?? ctx.players.get(member.seat) ?? `#${member.seat}`}</PlayerName>{#if isClaiming}{#each possibilities as { role, dim }}{@const assumed = ctx.assumptions.get(member.seat) === role}{@const confirmed = !assumed && memberConfirmedRole === role}{@const confirmedAlign = confirmed ? systemRoles.get(role)?.alignment : undefined}<span class="va-poss-cell" class:role-possible={!assumed && !confirmed && !dim} class:role-dim={!assumed && !confirmed && dim} class:role-assumed={assumed} class:role-confirmed={confirmed} class:confirmed-village={confirmed && confirmedAlign === 'villager'} class:confirmed-wolf={confirmed && confirmedAlign === 'werewolf'} class:confirmed-fox={confirmed && confirmedAlign === 'werehamster'} onclick={() => ctx.toggleAssumption(member.seat, role)} role="button" tabindex="0">{roleToShort(role)}</span>{/each}{/if}{#if shouldShowHocuspocus(member.seat)}<span class="va-hocuspocus-cell" class:hocuspocus-on={ctx.hocusPocusSeats.has(member.seat)} title="HocusPocus: この席のCOを無視して解析" onclick={() => ctx.toggleHocusPocus(member.seat)} role="button" tabindex="0">?</span>{/if}
                    </span>
                  </span>
                {/each}
                {#each Array.from({ length: Math.max(0, masonCapacity - cluster.members.length) }) as _empty}
                  <span class="va-mason-link">-</span><span class="va-mason-empty">?</span>
                {/each}
              {/each}
            </div>
          {:else}
            <div class="va-poss-line">
              {#each st.seats as seat, idx}
                {@const possibilities = possibilitiesFor(seat, st.roles)}
                {@const results = buildResultsFor(seat)}
                {@const seatStatus = classifyPlayer(currentMap.get(seat) ?? [])}
                {@const seatBase = basePossibilitiesFor(seat)}
                {@const seatConfirmedRole = seatBase.length === 1 ? seatBase[0] : undefined}
                {@const isNewGroup = idx > 0 && (!st.setGrouping || possibilitiesSetKey(seat) !== possibilitiesSetKey(st.seats[idx - 1]))}
                {#if isNewGroup}<span class="va-group-break" aria-hidden="true"></span>{/if}
                <span class="va-poss-item">
                  <span class="va-poss-row">
                    <PlayerName
                      dead={ctx.deadSeats.has(seat)}
                      nightKill={ctx.nightKilledSeats.has(seat)}
                      executed={ctx.executedSeats.has(seat)}
                      seat={seat}
                      status={seatStatus}
                      broken={ctx.brokenSeats.has(seat)}
                    >{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}</PlayerName>{#each possibilities as { role, dim }}{@const assumed = ctx.assumptions.get(seat) === role}{@const confirmed = !assumed && seatConfirmedRole === role}{@const confirmedAlign = confirmed ? systemRoles.get(role)?.alignment : undefined}<span class="va-poss-cell" class:role-possible={!assumed && !confirmed && !dim} class:role-dim={!assumed && !confirmed && dim} class:role-assumed={assumed} class:role-confirmed={confirmed} class:confirmed-village={confirmed && confirmedAlign === 'villager'} class:confirmed-wolf={confirmed && confirmedAlign === 'werewolf'} class:confirmed-fox={confirmed && confirmedAlign === 'werehamster'} onclick={() => ctx.toggleAssumption(seat, role)} role="button" tabindex="0">{roleToShort(role)}</span>{/each}{#if shouldShowHocuspocus(seat)}<span class="va-hocuspocus-cell" class:hocuspocus-on={ctx.hocusPocusSeats.has(seat)} title="HocusPocus: この席のCOを無視して解析" onclick={() => ctx.toggleHocusPocus(seat)} role="button" tabindex="0">?</span>{/if}
                  </span>{#if results.length > 0}<span class="va-poss-results">{#each results as { day, assertion, isBodyguard }, ri}{#if assertion}{#if ri > 0}<span class="va-arrow">→</span>{/if}<span class="va-result" class:human={assertion.species === 'human' && !assertion.forecast} class:wolf={assertion.species === 'wolf' && !assertion.forecast} class:guard={isBodyguard} class:forecast={assertion.forecast}><PlayerName dead={ctx.deadSeats.has(assertion.targetSeat)} nightKill={ctx.nightKilledSeats.has(assertion.targetSeat)} executed={ctx.executedSeats.has(assertion.targetSeat)} claim={ctx.claimShortNames.get(assertion.targetSeat)} seat={assertion.targetSeat}>{ctx.playerShortNames.get(assertion.targetSeat) ?? assertion.targetName}</PlayerName>{#if assertion.forecast}<span class="va-forecast-label">(予)</span>{:else if !isBodyguard}<SpeciesIcon species={assertion.species} />{/if}</span>{/if}{/each}</span>{/if}
                </span>
              {/each}
            </div>
          {/if}
          </div>
        </div>
      {/each}
    </div>
    {#if ctx.allRolesDetermined}
      <div class="determined-banner">
        <span class="determined-label">配役確定</span>
        <button class="determined-insert" onclick={handleInsertReveal} disabled={insertRevealBusy}>挿入</button>
      </div>
    {/if}
    {#if extraFooter}
      {@render extraFooter()}
    {/if}
    {#if ctx.analysisDuration > 0}
      <div class="va-footer">
        <span class="va-duration">retar {ctx.analysisDuration}ms</span>
      </div>
    {/if}
    {#if !hideAssumptions && (ctx.assumptions.size > 0 || ctx.denyWolfGroups.length > 0 || ctx.wolfPairSuggestions.length > 0)}
      <div class="va-assumptions">
        <div class="va-assumptions-header">
          仮説
          {#if onOpenDenyWolfDialog && (ctx.setup.get('werewolf') ?? 0) >= 2}
            <button class="va-assumption-btn" onclick={onOpenDenyWolfDialog}>追加</button>
          {/if}
          {#if ctx.assumptions.size > 0 || ctx.denyWolfGroups.length > 0 || ctx.hocusPocusSeats.size > 0}
            <button class="va-assumption-btn" onclick={() => ctx.clearAssumptions()}>全削除</button>
          {/if}
        </div>
        {#each [...ctx.assumptions] as [seat, role]}
          <div class="va-assumption-item">
            <span>{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}は{systemRoles.get(role)?.name ?? role}である</span>
            <button class="va-assumption-x" onclick={() => ctx.toggleAssumption(seat, role)}>&times;</button>
          </div>
        {/each}
        {#each ctx.denyWolfGroups as group, i}
          <div class="va-assumption-item">
            <span class="deny-wolf">{group.map(s => ctx.playerShortNames.get(s) ?? ctx.players.get(s) ?? `#${s}`).join(' と ')} は両狼でない</span>
            <button class="va-assumption-x" onclick={() => ctx.removeDenyWolfGroup(i)}>&times;</button>
          </div>
        {/each}
        {#if ctx.wolfPairSuggestions.length > 0}
          <div class="va-suggestions">
            <div class="va-suggestions-label">提案</div>
            {#each ctx.wolfPairSuggestions as suggestion}
              <button class="va-suggestion" onclick={() => ctx.addSuggestion(suggestion)}>
                「{ctx.playerShortNames.get(suggestion.seatA) ?? ctx.players.get(suggestion.seatA) ?? `#${suggestion.seatA}`}と{ctx.playerShortNames.get(suggestion.seatB) ?? ctx.players.get(suggestion.seatB) ?? `#${suggestion.seatB}`}の両狼はない」
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .va-error {
    margin: 0;
    padding: 8px;
    white-space: pre-wrap;
    color: var(--color-text);
  }

  .vertical-analysis-pane {
    display: flex;
    flex-direction: column;
    padding: 2px;
    box-sizing: border-box;
  }

  .va-tables {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
  }

  .va-sub-table {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    min-width: 0;
  }

  .va-sub-tag {
    flex: 0 0 auto;
    width: 14px;
    text-align: center;
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 700;
    color: var(--color-text-muted);
    padding: 1px 0 0;
  }

  .va-sub-body {
    flex: 1 1 auto;
    min-width: 0;
  }

  .va-poss-line {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    padding: 1px 0;
  }

  .va-poss-item {
    display: inline-block;
    vertical-align: top;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .va-poss-row {
    display: inline-flex;
    align-items: center;
    gap: 0;
    white-space: nowrap;
  }

  .va-poss-cell + .va-poss-cell {
    margin-left: -1px;
  }

  .va-poss-results {
    display: block;
    padding-left: 8px;
  }

  .va-poss-cell {
    display: inline-block;
    padding: 0;
    border: 1px solid var(--color-border);
    min-width: 1.4em;
    text-align: center;
    cursor: pointer;
  }

  .va-group-break {
    flex-basis: 100%;
    width: 0;
    height: 0;
  }

  .va-mason-link,
  .va-mason-cluster-sep,
  .va-mason-empty {
    display: inline-block;
    color: var(--color-text-faint);
    font-family: var(--font-mono);
    font-size: 12px;
    vertical-align: top;
    padding: 0 2px;
  }

  .va-poss-cell:hover {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .va-table {
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .va-table td {
    text-align: center;
    padding: 0;
    border: none;
  }

  .va-table td:not(.va-name-col) {
    min-width: 1.6em;
  }

  .role-possible,
  .role-dim {
    cursor: pointer;
  }

  .role-possible:hover,
  .role-dim:hover {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .role-possible {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .role-dim {
    background: var(--color-bg-sunken);
    color: var(--color-text-faint);
  }

  .role-assumed {
    background: var(--color-accent);
    color: var(--color-bg);
    font-weight: 600;
  }

  .role-confirmed {
    color: var(--color-bg);
    font-weight: 700;
    cursor: pointer;
  }

  .role-confirmed.confirmed-village { background: var(--color-village); }
  .role-confirmed.confirmed-wolf { background: var(--color-wolf); }
  .role-confirmed.confirmed-fox { background: var(--color-fox); }
  .role-confirmed:not(.confirmed-village):not(.confirmed-wolf):not(.confirmed-fox) {
    background: var(--color-unknown-team);
  }

  .va-hocuspocus-cell {
    display: inline-block;
    background: var(--color-bg-sunken);
    color: var(--color-border);
    font-weight: 700;
    cursor: pointer;
    user-select: none;
    border: 1px solid var(--color-border);
    min-width: 1.2em;
    text-align: center;
    margin-left: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.2;
    padding: 0 2px;
  }

  .va-hocuspocus-cell:hover {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .va-hocuspocus-cell.hocuspocus-on {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .va-results-row td {
    border-top: none !important;
  }

  .va-results {
    padding: 1px 4px 2px 24px !important;
    text-align: left !important;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .va-result {
    display: inline-flex;
    align-items: baseline;
  }

  .va-result.human {
    color: var(--color-human-result);
  }

  .va-result.wolf {
    color: var(--color-wolf-result);
  }

  .va-result.guard {
    color: var(--color-link);
  }

  .va-result.forecast {
    color: var(--color-text-muted);
  }

  .va-arrow {
    color: var(--color-text-faint);
    margin: 0 3px;
  }

  .va-forecast-label {
    font-size: 10px;
  }

  .determined-banner {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin: 4px 0;
    border: 1px solid var(--color-village);
    border-radius: 4px;
    background: color-mix(in srgb, var(--color-village) 12%, transparent);
  }

  .determined-label {
    color: var(--color-village);
    font-weight: bold;
    font-size: 12px;
  }

  .determined-insert {
    background: none;
    border: 1px solid var(--color-village);
    border-radius: 3px;
    color: var(--color-village);
    cursor: pointer;
    font-size: 11px;
    padding: 1px 6px;
    margin-left: auto;
  }

  .determined-insert:hover {
    background: color-mix(in srgb, var(--color-village) 20%, transparent);
  }

  .va-footer {
    display: flex;
    gap: 6px;
    padding: 4px 2px 2px;
    color: var(--color-text-muted);
    font-size: 12px;
    align-items: center;
  }

  .view-option {
    background: none;
    border: 1px solid var(--color-text-faint);
    border-radius: 3px;
    color: var(--color-text-faint);
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    padding: 1px 6px;
  }

  .view-option:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }

  .va-duration {
    margin-left: auto;
    font-size: 10px;
    color: var(--color-text-faint);
  }

  .va-assumptions {
    margin-top: 4px;
    padding: 4px 6px;
    border-top: 1px solid var(--color-border);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .va-assumptions-header {
    color: var(--color-text-muted);
    margin-bottom: 2px;
  }

  .va-assumption-btn {
    background: none;
    border: 1px solid var(--color-text-faint);
    border-radius: 3px;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: 11px;
    padding: 1px 6px;
    margin-left: 4px;
  }

  .va-assumption-btn:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }

  .va-assumption-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 0;
    color: var(--color-text);
  }

  .va-assumption-x {
    background: none;
    border: none;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
  }

  .va-assumption-x:hover {
    color: var(--color-text);
  }

  .deny-wolf {
    color: var(--color-wolf);
  }

  .va-suggestions {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--color-border);
  }

  .va-suggestions-label {
    font-size: 11px;
    color: var(--color-text-faint);
    margin-bottom: 2px;
  }

  .va-suggestion {
    display: block;
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 12px;
    font-family: inherit;
    padding: 1px 0;
    cursor: pointer;
    text-align: left;
  }

  .va-suggestion:hover {
    color: var(--color-text);
  }
</style>
