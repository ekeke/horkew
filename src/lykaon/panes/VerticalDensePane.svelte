<script lang="ts">
  import type { Snippet } from 'svelte'
  import { systemRoles } from '../../types/index.ts'
  import type { SystemRole } from '../../types/index.ts'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'
  import type { ClaimRow, DayAssertion } from '../status/extract.ts'
  import { buildAssertionTimeline, buildExecutionRows, buildNightKillRows, extractClaimGroups, extractDeathHistory } from '../status/extract.ts'
  import { buildMasonClusters } from '../status/masonClusters.ts'
  import PlayerName from '../status/PlayerName.svelte'
  import SpeciesIcon from '../status/SpeciesIcon.svelte'
  import { classifyPlayer } from '../status/playerStatus.ts'

  let { ctx, onInsertRevealRoles, extraFooter, determinedBanner, hideAssumptions = false }: {
    ctx: AnalysisContext
    onInsertRevealRoles?: (done: () => void) => void
    extraFooter?: Snippet
    determinedBanner?: Snippet<[{ insert: () => void, busy: boolean }]>
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

  let deathSequence = $derived.by(() => {
    const vs = ctx.villageStatus
    if (!vs) return { executionRows: [], killRows: [] }
    const history = extractDeathHistory(vs, ctx.players)
    return {
      executionRows: buildExecutionRows(history),
      killRows: buildNightKillRows(history),
    }
  })

  let hasAssumptionState = $derived(
    ctx.assumptions.size > 0 || ctx.denyWolfGroups.length > 0 || ctx.hocusPocusSeats.size > 0
  )
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
                    >{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}</PlayerName>{#each possibilities as { role, dim }}{@const assumed = ctx.assumptions.get(seat) === role}{@const confirmed = !assumed && seatConfirmedRole === role}{@const confirmedAlign = confirmed ? systemRoles.get(role)?.alignment : undefined}<span class="va-poss-cell" class:role-possible={!assumed && !confirmed && !dim} class:role-dim={!assumed && !confirmed && dim} class:role-assumed={assumed} class:role-confirmed={confirmed} class:confirmed-village={confirmed && confirmedAlign === 'villager'} class:confirmed-wolf={confirmed && confirmedAlign === 'werewolf'} class:confirmed-fox={confirmed && confirmedAlign === 'werehamster'} onclick={() => ctx.toggleAssumption(seat, role)} role="button" tabindex="0">{roleToShort(role)}</span>{/each}{#if shouldShowHocuspocus(seat)}<span class="va-hocuspocus-cell" class:hocuspocus-on={ctx.hocusPocusSeats.has(seat)} title="HocusPocus: この席のCOを無視して解析" onclick={() => ctx.toggleHocusPocus(seat)} role="button" tabindex="0">?</span>{/if}
                  </span>{#if results.length > 0}<span class="va-poss-results">{#each results as { day, assertion, isBodyguard }, ri}{#if assertion}{#if ri > 0}<span class="va-arrow">→</span>{/if}<span class="va-result" class:dead={ctx.deadSeats.has(assertion.targetSeat)} class:human={assertion.species === 'human' && !assertion.forecast} class:wolf={assertion.species === 'wolf' && !assertion.forecast} class:guard={isBodyguard} class:forecast={assertion.forecast}><PlayerName dead={ctx.deadSeats.has(assertion.targetSeat)} nightKill={ctx.nightKilledSeats.has(assertion.targetSeat)} executed={ctx.executedSeats.has(assertion.targetSeat)} claim={ctx.claimShortNames.get(assertion.targetSeat)} seat={assertion.targetSeat} outline={assertion.species === 'wolf' && !assertion.forecast}>{ctx.playerShortNames.get(assertion.targetSeat) ?? assertion.targetName}</PlayerName>{#if assertion.forecast}<span class="va-forecast-label">(予)</span>{:else if !isBodyguard}<SpeciesIcon species={assertion.species} />{/if}</span>{/if}{/each}</span>{/if}
                </span>
              {/each}
            </div>
          {/if}
          </div>
        </div>
      {/each}
    </div>
    {#if deathSequence.executionRows.length > 0 || deathSequence.killRows.length > 0}
      <div class="va-deaths">
        {#if deathSequence.executionRows.length > 0}
          <div class="va-sub-table">
            <div class="va-sub-tag exec">吊</div>
            <div class="va-sub-body">
              <div class="va-death-seq">
                {#each deathSequence.executionRows as row, di}
                  {#if di > 0}<span class="va-arrow">→</span>{/if}
                  {#if row.entries.length === 0}
                    <span class="va-empty-day">(処刑なし)</span>
                  {:else}
                    {#each row.entries as entry, ei}
                      {#if ei > 0}<span class="va-coexist">、</span>{/if}
                      <PlayerName dead executed seat={entry.seat} claim={ctx.claimShortNames.get(entry.seat)}>{ctx.playerShortNames.get(entry.seat) ?? entry.name}</PlayerName>
                    {/each}
                  {/if}
                {/each}
              </div>
            </div>
          </div>
        {/if}
        {#if deathSequence.killRows.length > 0}
          <div class="va-sub-table">
            <div class="va-sub-tag kill">噛</div>
            <div class="va-sub-body">
              <div class="va-death-seq">
                {#each deathSequence.killRows as row, di}
                  {#if di > 0}<span class="va-arrow">→</span>{/if}
                  {#if row.entries.length === 0}
                    <span class="va-empty-day">(平和)</span>
                  {:else}
                    {#each row.entries as entry, ei}
                      {#if ei > 0}<span class="va-coexist">、</span>{/if}
                      <PlayerName dead nightKill seat={entry.seat} claim={ctx.claimShortNames.get(entry.seat)}>{ctx.playerShortNames.get(entry.seat) ?? entry.name}</PlayerName>
                    {/each}
                  {/if}
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/if}
    {#if ctx.allRolesDetermined}
      {#if determinedBanner}
        {@render determinedBanner({ insert: handleInsertReveal, busy: insertRevealBusy })}
      {:else}
        <div class="determined-banner">
          <span class="determined-label">配役確定</span>
          <button class="determined-insert" onclick={handleInsertReveal} disabled={insertRevealBusy}>挿入</button>
        </div>
      {/if}
    {/if}
    {#if extraFooter}
      {@render extraFooter()}
    {/if}
    {#if !hideAssumptions && hasAssumptionState}
      <div class="va-footer">
        <button class="va-assumption-btn" onclick={() => ctx.clearAssumptions()}>仮説全削除</button>
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

  /* 名前は両ペイン共通で bold 固定。PlayerName 自体は他テーブル (Vote/Claim/Summary
     等) でも使われるため、グローバル変更を避けて VerticalDense scope 内だけで適用。 */
  .va-poss-row :global(.player-name-root) {
    font-weight: 700;
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

  /* SpeciesIcon (○/●) は baseline 整列だと SVG 中心が周囲文字より上に
     見えるので、 cross-axis センターに置き直す。
     non-flex (Status pane 等) では align-self は無視されるので副作用なし。 */
  .va-result :global(.species-icon-wrap) {
    align-self: center;
  }

  /* 明暗 = 生存軸専用に再編。
     - 生存時の標準色は --color-text。
     - 退場時は --color-text-faint (名前は PlayerName.pn.dead で自動追従、
       SpeciesIcon は currentColor で追従)。
     判定結果が ● (人狼結果) のときは .va-result.wolf に背景塗りを当て、
     名前 + アイコン全体を反転表示でくり抜く。
     - 生存 + ● : 背景 = --color-text (フル反転)
     - 退場 + ● : 背景 = --color-text-muted (subtext0、 一段ダウンで dim 感
       を出しつつ、 Light / Dark 両モードで文字色 --color-bg との
       コントラストを AA 以上で確保) */
  .va-result {
    color: var(--color-text);
  }

  .va-result.dead {
    color: var(--color-text-faint);
  }

  .va-result.wolf {
    background: var(--color-text);
    color: var(--color-bg);
  }

  .va-result.dead.wolf {
    background: var(--color-text-muted);
  }

  .va-result.guard {
    color: var(--color-link);
  }

  /* 結果セル内の対象プレイヤー名は、行頭の主体プレイヤー名 (.va-poss-row の
     bold 700 名前) と紛らわしいので、 1px ダウン + italic で
     「この結果の宛先」であることを視覚的に示す。 */
  .va-result :global(.player-name-root) {
    font-size: 11px;
    font-style: italic;
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

  .va-assumption-btn {
    background: none;
    border: 1px solid var(--color-text-faint);
    border-radius: 3px;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: 11px;
    padding: 1px 6px;
  }

  .va-assumption-btn:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }

  .va-deaths {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    margin-top: 2px;
  }

  .va-sub-tag.exec { color: var(--color-wolf); }
  .va-sub-tag.kill { color: var(--color-role); }

  .va-death-seq {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 2px;
    padding: 1px 0;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .va-death-seq :global(.player-name-root) {
    font-weight: 700;
  }

  /* 同日内の複数死亡を区切る読点。 翌日への遷移を表す → と意味的に区別する */
  .va-coexist {
    color: var(--color-text-muted);
    margin: 0 1px;
  }

  /* 噛みなし (平和) / 処刑なし の日を示す軽量ラベル。 名前枠と並んで違和感のない
     ミュート色 + italic で示す */
  .va-empty-day {
    color: var(--color-text-faint);
    font-style: italic;
  }
</style>
