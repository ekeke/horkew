<script lang="ts">
  import type { Snippet } from 'svelte'
  import { systemRoles } from '../../types/index.ts'
  import type { SystemRole } from '../../types/index.ts'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'
  import type { ClaimRow, DayAssertion } from '../status/extract.ts'
  import { buildAssertionTimeline } from '../status/extract.ts'
  import PlayerName from '../status/PlayerName.svelte'
  import SpeciesIcon from '../status/SpeciesIcon.svelte'

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

  type NameStatus = 'default' | 'not-village' | 'village' | 'wolf' | 'fox'

  function roleToShort(role: SystemRole): string {
    return systemRoles.get(role)?.shortName ?? role
  }

  function classifyPlayer(roles: SystemRole[]): { status: NameStatus, fixed: boolean, label: string } {
    if (roles.length === 0) return { status: 'default', fixed: false, label: '?' }
    const fixed = roles.length === 1
    const label = fixed ? (systemRoles.get(roles[0])?.shortName ?? '?') : '?'
    const alignments = new Set(roles.map(r => systemRoles.get(r)!.alignment))
    if (alignments.size === 1) {
      const a = [...alignments][0]
      if (a === 'villager') return { status: 'village', fixed, label }
      if (a === 'werewolf') return { status: 'wolf', fixed, label }
      if (a === 'werehamster') return { status: 'fox', fixed, label }
    }
    if (!alignments.has('villager')) return { status: 'not-village', fixed: false, label }
    return { status: 'default', fixed: false, label }
  }

  let currentMap = $derived(new Map(ctx.analysisSeats.map(s => [s.seat, s.roles])))
  let baseMap = $derived(new Map(ctx.baseAnalysisSeats.map(s => [s.seat, s.roles])))

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

  type SubTable = { tag: string, seats: number[], roles: SystemRole[], compact: boolean, possibilities: boolean }

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

  /** seat の表示可能性: base (アサンプション無し) で残った役職。 アサンプションで消えたものは dim */
  function possibilitiesFor(seat: number): { role: SystemRole, dim: boolean }[] {
    const base = baseMap.get(seat) ?? []
    const cur = currentMap.get(seat) ?? []
    const out: { role: SystemRole, dim: boolean }[] = []
    for (const role of ctx.analysisColumns) {
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
        matched.sort((a, b) => a.order - b.order)
        const compact = def.primaryRole !== undefined && COMPACT_PRIMARY_ROLES.has(def.primaryRole)
        const possibilities = def.mainGroup === 'nonCo'
        subTables.push({
          tag: def.tag,
          seats: matched.map(m => m.seat),
          roles: rolesForDef(def),
          compact,
          possibilities,
        })
      }
    }
    return subTables
  }

  let subTables = $derived(buildCoSubTables())
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
          {#if st.compact}
            <div class="va-compact-line">
              {#each st.seats as seat, i}
                {#if i > 0}<span class="va-compact-sep">,</span>{/if}
                <PlayerName
                  dead={ctx.deadSeats.has(seat)}
                  nightKill={ctx.nightKilledSeats.has(seat)}
                  executed={ctx.executedSeats.has(seat)}
                  claim={ctx.claimShortNames.get(seat)}
                  seat={seat}
                >{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}</PlayerName>
              {/each}
            </div>
          {:else if st.possibilities}
            <div class="va-poss-line">
              {#each st.seats as seat}
                {@const possibilities = possibilitiesFor(seat)}
                <span class="va-poss-item">
                  <PlayerName
                    dead={ctx.deadSeats.has(seat)}
                    nightKill={ctx.nightKilledSeats.has(seat)}
                    executed={ctx.executedSeats.has(seat)}
                    claim={ctx.claimShortNames.get(seat)}
                    seat={seat}
                  >{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}</PlayerName><span class="va-poss-colon">:</span>{#each possibilities as { role, dim }, i}{#if i > 0}<span class="va-poss-slash">/</span>{/if}<span class:va-poss-dim={dim}>{roleToShort(role)}</span>{/each}
                </span>
              {/each}
            </div>
          {:else}
          <table class="va-table">
            <tbody>
              {#each st.seats as seat}
                {@const cls = classifyPlayer(currentMap.get(seat) ?? [])}
                <tr class:dead-row={ctx.deadSeats.has(seat)} class:seat-broken={ctx.brokenSeats.has(seat)}>
                  <td class="va-name-col {cls.status}" class:role-fixed={cls.fixed}>
                    <PlayerName
                      dead={ctx.deadSeats.has(seat)}
                      nightKill={ctx.nightKilledSeats.has(seat)}
                      executed={ctx.executedSeats.has(seat)}
                      claim={ctx.claimShortNames.get(seat)}
                    >{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}</PlayerName>
                  </td>
                  {#each st.roles as role}
                    <td
                      class="{(currentMap.get(seat) ?? []).includes(role) ? 'role-possible' : 'role-impossible'}{ctx.assumptions.get(seat) === role ? ' role-assumed' : ''}"
                      onclick={() => ctx.toggleAssumption(seat, role)}
                    >{roleToShort(role)}</td>
                  {/each}
                </tr>
                {@const results = buildResultsFor(seat)}
                {#if results.length > 0}
                  <tr class="va-results-row">
                    <td class="va-results" colspan={1 + st.roles.length}>
                      {#each results as { day, assertion, isBodyguard }, i}
                        {#if assertion}
                          {#if i > 0}<span class="va-arrow">→</span>{/if}
                          <span
                            class="va-result"
                            class:human={assertion.species === 'human' && !assertion.forecast}
                            class:wolf={assertion.species === 'wolf' && !assertion.forecast}
                            class:guard={isBodyguard}
                            class:forecast={assertion.forecast}
                          >
                            <PlayerName dead={ctx.deadSeats.has(assertion.targetSeat)} nightKill={ctx.nightKilledSeats.has(assertion.targetSeat)} executed={ctx.executedSeats.has(assertion.targetSeat)} claim={ctx.claimShortNames.get(assertion.targetSeat)} seat={assertion.targetSeat}>{ctx.playerShortNames.get(assertion.targetSeat) ?? assertion.targetName}</PlayerName>{#if assertion.forecast}<span class="va-forecast-label">(予)</span>{:else if !isBodyguard}<SpeciesIcon species={assertion.species} />{/if}
                          </span>
                        {/if}
                      {/each}
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
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
    gap: 6px;
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

  .va-compact-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 4px;
    padding: 1px 0;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .va-compact-sep {
    color: var(--color-text-faint);
  }

  .va-poss-line {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    padding: 1px 0;
  }

  .va-poss-item {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: nowrap;
  }

  .va-poss-colon, .va-poss-slash {
    color: var(--color-text-faint);
  }

  .va-poss-dim {
    opacity: 0.35;
  }

  .va-table {
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .va-table td {
    text-align: center;
    padding: 0;
    border: 1px solid var(--color-border);
  }

  .va-table td:not(.va-name-col) {
    min-width: 1.6em;
  }

  tr.seat-broken td.va-name-col {
    background: color-mix(in srgb, var(--color-wolf) 22%, transparent);
  }

  .va-name-col {
    text-align: left !important;
    white-space: nowrap;
    padding-right: 8px !important;
    font-weight: 700;
  }

  .va-name-col.village { background: var(--color-village-bg); }
  .va-name-col.wolf { background: var(--color-wolf-bg); }
  .va-name-col.fox { background: var(--color-fox-bg); }
  .va-name-col.not-village { background: var(--color-unknown-team-bg); }

  .role-possible,
  .role-impossible {
    cursor: pointer;
  }

  .role-possible:hover,
  .role-impossible:hover {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .role-possible {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .role-impossible {
    background: var(--color-bg-sunken);
    color: var(--color-border);
  }

  .role-assumed {
    background: var(--color-accent);
    color: var(--color-bg);
    font-weight: 600;
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
