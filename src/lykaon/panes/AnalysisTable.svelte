<script lang="ts">
  import type { Snippet } from 'svelte'
  import { systemRoles } from '../../types/index.ts'
  import type { SystemRole } from '../../types/index.ts'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'
  import PlayerName from '../status/PlayerName.svelte'

  type Grouping = 'seat' | 'co' | 'survival'
  type ViewOptions = { columns: 1 | 2 | 3, grouping: Grouping }

  let { ctx, onInsertRevealRoles, onOpenDenyWolfDialog, extraFooter, hideAssumptions = false, defaultViewOptions }: {
    ctx: AnalysisContext
    onInsertRevealRoles?: (done: () => void) => void
    onOpenDenyWolfDialog?: () => void
    extraFooter?: Snippet
    hideAssumptions?: boolean
    defaultViewOptions?: ViewOptions
  } = $props()

  // onInsertRevealRoles hook 実行中は再クリックを防ぐためボタンを disable する。
  // consumer は受け取った done() を呼んで disable を解除する。
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

  // ---- View options (列数 / 分類) -----------------------------------
  const STORAGE_KEY = 'lykaon.analysisTable.viewOptions'
  const FALLBACK_VIEW: ViewOptions = { columns: 1, grouping: 'seat' }

  function loadViewOptions(): ViewOptions {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (
          (p.columns === 1 || p.columns === 2 || p.columns === 3)
          && (p.grouping === 'seat' || p.grouping === 'co' || p.grouping === 'survival')
        ) return { columns: p.columns, grouping: p.grouping }
      }
    } catch { /* ignore */ }
    return defaultViewOptions ?? FALLBACK_VIEW
  }

  let viewOptions = $state<ViewOptions>(loadViewOptions())

  $effect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(viewOptions)) } catch { /* ignore */ }
  })

  function cycleColumns(): void {
    const next = viewOptions.columns === 1 ? 2 : viewOptions.columns === 2 ? 3 : 1
    viewOptions = { ...viewOptions, columns: next as 1 | 2 | 3 }
  }

  function cycleGrouping(): void {
    const next: Grouping =
      viewOptions.grouping === 'seat' ? 'co'
      : viewOptions.grouping === 'co' ? 'survival'
      : 'seat'
    viewOptions = { ...viewOptions, grouping: next }
  }

  function groupingLabel(g: Grouping): string {
    return g === 'seat' ? '席順' : g === 'co' ? 'CO別' : '生存'
  }

  /** 縦割り分割で 2 列目以降に置く placeholder タイトル (高さ揃え用の nbsp)。 */
  const TITLE_PLACEHOLDER = ' '

  // ---- グルーピング --------------------------------------------------
  function chunkVertical<T>(items: T[], n: number): T[][] {
    if (n <= 1) return items.length === 0 ? [] : [items]
    const size = Math.ceil(items.length / n)
    if (size === 0) return []
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
  }

  type SubTable = { title?: string, seats: number[] }
  type Column = { subTables: SubTable[] }

  type CoMainGroup = 'main' | 'support' | 'nonCo'
  type CoSubDef = {
    mainGroup: CoMainGroup
    title: string
    matches: (claimingRole: string | undefined, claiming: boolean, divined: boolean) => boolean
  }

  // systemRoles から CO 役職別の sub def を動的に構築する。
  // - main: category 'seer' / 'medium' (占い系・霊系の役職)
  // - support: alignment 'villager' で main 以外 (狩・共・猫・将来の追加村役職)
  // - 'その他CO': 村陣営でない CO (狼CO / 狐CO 等のレアケース) を catch
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
        title: `${role.shortName}CO`,
        matches: (r, c) => c && r === key,
      })
    }
    defs.push({
      mainGroup: 'support',
      title: 'その他CO',
      matches: (r, c) => c && !KNOWN_VILLAGER_NAMES.has(r ?? ''),
    })
    defs.push({ mainGroup: 'nonCo', title: '非CO (判定あり)', matches: (_r, c, d) => !c && d })
    defs.push({ mainGroup: 'nonCo', title: '非CO (グレー)',   matches: (_r, c, d) => !c && !d })
    return defs
  })()

  function buildCoColumns(): Column[] {
    const vs = ctx.villageStatus
    if (!vs) return []
    const divined = ctx.divinedSeats
    const allSeats = [...ctx.players.keys()]

    // 各 sub def に該当する席を集める
    const subsByMain: Record<CoMainGroup, SubTable[]> = { main: [], support: [], nonCo: [] }
    for (const def of CO_SUB_DEFS) {
      const seats: number[] = []
      for (const seat of allSeats) {
        const s = vs.statuses.get(seat)
        if (def.matches(s?.claimingRole, !!s?.claiming, divined.has(seat))) seats.push(seat)
      }
      if (seats.length > 0) subsByMain[def.mainGroup].push({ title: def.title, seats })
    }

    const order: CoMainGroup[] = ['main', 'support', 'nonCo']
    const nonEmpty = order.filter(m => subsByMain[m].length > 0)
    if (nonEmpty.length === 0) return []

    const sizeOf = (m: CoMainGroup): number =>
      subsByMain[m].reduce((acc, st) => acc + st.seats.length, 0)

    const requested = viewOptions.columns
    const effective = Math.min(requested, nonEmpty.length)

    if (effective === 1) {
      return [{ subTables: nonEmpty.flatMap(m => subsByMain[m]) }]
    }
    if (effective === nonEmpty.length) {
      return nonEmpty.map(m => ({ subTables: subsByMain[m] }))
    }
    // effective === 2 && nonEmpty.length === 3
    // パターンA: [m0+m1 | m2]、 パターンB: [m0 | m1+m2] のうち高さバランス良い方
    const [a, b, c] = nonEmpty
    const sa = sizeOf(a), sb = sizeOf(b), sc = sizeOf(c)
    const diffA = Math.abs((sa + sb) - sc)
    const diffB = Math.abs(sa - (sb + sc))
    if (diffA <= diffB) {
      return [
        { subTables: [...subsByMain[a], ...subsByMain[b]] },
        { subTables: subsByMain[c] },
      ]
    }
    return [
      { subTables: subsByMain[a] },
      { subTables: [...subsByMain[b], ...subsByMain[c]] },
    ]
  }

  function buildSurvivalColumns(): Column[] {
    const alive: number[] = []
    const dead: number[] = []
    for (const seat of ctx.players.keys()) {
      if (ctx.deadSeats.has(seat)) dead.push(seat)
      else alive.push(seat)
    }
    const groups: { title: string, seats: number[] }[] = []
    if (alive.length > 0) groups.push({ title: '生存', seats: alive })
    if (dead.length > 0) groups.push({ title: '退場', seats: dead })
    if (groups.length === 0) return []

    const requested = viewOptions.columns

    // 全員生存 (or 全員退場) で 1 グループしかない時は、 列数で縦割り
    if (groups.length === 1) {
      const g = groups[0]
      return chunkVertical(g.seats, requested).map((s, i) => ({
        subTables: [{ title: i === 0 ? g.title : TITLE_PLACEHOLDER, seats: s }],
      }))
    }

    // groups.length === 2
    if (requested === 1) {
      return [{ subTables: groups.map(g => ({ title: g.title, seats: g.seats })) }]
    }
    if (requested === 2) {
      return groups.map(g => ({ subTables: [{ title: g.title, seats: g.seats }] }))
    }
    // requested === 3: 多い方を 2 列に縦割り、 少ない方は 1 列
    const biggerIdx = groups[0].seats.length >= groups[1].seats.length ? 0 : 1
    const smallerIdx = 1 - biggerIdx
    const chunks = chunkVertical(groups[biggerIdx].seats, 2)
    const cols: Column[] = chunks.map((s, i) => ({
      subTables: [{ title: i === 0 ? groups[biggerIdx].title : TITLE_PLACEHOLDER, seats: s }],
    }))
    const smaller = groups[smallerIdx]
    const smallerCol: Column = { subTables: [{ title: smaller.title, seats: smaller.seats }] }
    // 生存 → 退場 の順を維持: biggerIdx === 0 (生存が多い) → smaller を末尾、 そうでなければ先頭
    if (biggerIdx === 0) cols.push(smallerCol)
    else cols.unshift(smallerCol)
    return cols
  }

  let columns = $derived.by<Column[]>(() => {
    if (viewOptions.grouping === 'seat') {
      const seats = [...ctx.players.keys()]
      return chunkVertical(seats, viewOptions.columns).map(s => ({
        subTables: [{ seats: s }],
      }))
    }
    if (viewOptions.grouping === 'survival') return buildSurvivalColumns()
    return buildCoColumns()
  })

  let effectiveCols = $derived(Math.max(1, columns.length))
</script>

{#snippet seatRow(seat: number)}
  {@const cls = classifyPlayer(currentMap.get(seat) ?? [])}
  <tr class:dead-row={ctx.deadSeats.has(seat)} class:seat-broken={ctx.brokenSeats.has(seat)}>
    <td class="analysis-name-col {cls.status}" class:role-fixed={cls.fixed}>
      <span class="analysis-label">{cls.label}</span>
      <PlayerName
        dead={ctx.deadSeats.has(seat)}
        nightKill={ctx.nightKilledSeats.has(seat)}
        executed={ctx.executedSeats.has(seat)}
        claim={ctx.claimShortNames.get(seat)}
      >{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}</PlayerName>
    </td>
    {#each ctx.analysisColumns as role}
      <td
        class="{(currentMap.get(seat) ?? []).includes(role) ? 'role-possible' : 'role-impossible'}{ctx.assumptions.get(seat) === role ? ' role-assumed' : ''}"
        onclick={() => ctx.toggleAssumption(seat, role)}
      >{roleToShort(role)}</td>
    {/each}
    <td class="hocuspocus-spacer"></td>
    <td
      class="hocuspocus-cell{ctx.hocusPocusSeats.has(seat) ? ' hocuspocus-on' : ''}"
      title="HocusPocus: この席のCOを無視して解析"
      onclick={() => ctx.toggleHocusPocus(seat)}
    >?</td>
  </tr>
{/snippet}

{#if ctx.analysisError}
  <pre class="output lyk-pane">Error: {ctx.analysisError}</pre>
{/if}
{#if ctx.analysisColumns.length > 0 && ctx.players.size > 0}
  <div class="analysis-layout lyk-pane">
    <div class="analysis-main">
      <div class="analysis-tables" style:--cols={effectiveCols}>
        {#each columns as column}
          <div class="analysis-column">
            {#each column.subTables as st}
              <div class="sub-table">
                {#if st.title}<div class="sub-table-title">{st.title}</div>{/if}
                <table class="analysis-table">
                  <tbody>
                    {#each st.seats as seat}
                      {@render seatRow(seat)}
                    {/each}
                  </tbody>
                </table>
              </div>
            {/each}
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
      <div class="analysis-footer">
        <button class="view-option" onclick={cycleColumns} title="列数を切り替え">列: {viewOptions.columns}</button>
        <button class="view-option" onclick={cycleGrouping} title="分類方法を切り替え">分類: {groupingLabel(viewOptions.grouping)}</button>
        {#if ctx.analysisDuration > 0}
          <span class="analysis-duration">retar {ctx.analysisDuration}ms{#if ctx.analysisStats} ({ctx.analysisStats.workers}w, wall {ctx.analysisStats.wallClock}ms, worker {ctx.analysisStats.minElapsed}-{ctx.analysisStats.maxElapsed}ms, {ctx.analysisStats.wasm ? 'WASM' : 'JS'}){/if}</span>
        {/if}
      </div>
    </div>
    {#if !hideAssumptions}
    <div class="analysis-sidebar">
      <div class="assumptions-list">
        <div class="assumptions-header">
          仮説
          {#if onOpenDenyWolfDialog && (ctx.setup.get('werewolf') ?? 0) >= 2}
            <button class="assumption-add" onclick={onOpenDenyWolfDialog}>追加</button>
          {/if}
          {#if ctx.assumptions.size > 0 || ctx.denyWolfGroups.length > 0 || ctx.hocusPocusSeats.size > 0}
            <button class="assumption-clear" onclick={() => ctx.clearAssumptions()}>全削除</button>
          {/if}
        </div>
        {#each [...ctx.assumptions] as [seat, role]}
          <div class="assumption-item">
            <span class="assumption-text">{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}は{systemRoles.get(role)?.name ?? role}である</span>
            <button class="assumption-remove" onclick={() => ctx.toggleAssumption(seat, role)}>&times;</button>
          </div>
        {/each}
        {#each ctx.denyWolfGroups as group, i}
          <div class="assumption-item">
            <span class="assumption-text deny-wolf">{group.map(s => ctx.playerShortNames.get(s) ?? ctx.players.get(s) ?? `#${s}`).join(' と ')} は両狼でない</span>
            <button class="assumption-remove" onclick={() => ctx.removeDenyWolfGroup(i)}>&times;</button>
          </div>
        {/each}
        {#if ctx.wolfPairSuggestions.length > 0}
          <div class="suggestions-section">
            <div class="suggestions-label">提案</div>
            {#each ctx.wolfPairSuggestions as suggestion}
              <button class="suggestion-item" onclick={() => ctx.addSuggestion(suggestion)}>
                「{ctx.playerShortNames.get(suggestion.seatA) ?? ctx.players.get(suggestion.seatA) ?? `#${suggestion.seatA}`}と{ctx.playerShortNames.get(suggestion.seatB) ?? ctx.players.get(suggestion.seatB) ?? `#${suggestion.seatB}`}の両狼はない」仮説を追加する
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
    {/if}
  </div>
{/if}

<style>
  .output {
    margin: 0;
    padding: 8px;
    white-space: pre-wrap;
    color: var(--color-text);
  }

  .analysis-layout {
    display: flex;
    align-items: flex-start;
    gap: 0;
  }

  .analysis-main {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    padding: 2px;
    min-width: 0;
  }

  .analysis-footer {
    display: flex;
    gap: 6px;
    padding: 6px 4px 4px;
    color: var(--color-text-muted);
    font-size: 13px;
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

  .analysis-tables {
    display: grid;
    grid-template-columns: repeat(var(--cols, 1), auto);
    gap: 12px;
    align-items: start;
  }

  .analysis-column {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .sub-table {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: auto;
    min-width: 0;
  }

  .sub-table-title {
    font-size: 11px;
    color: var(--color-text-faint);
    padding: 2px 4px;
  }

  .analysis-table {
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .analysis-table td {
    text-align: center;
    padding: 0;
    border: 1px solid var(--color-border);
  }

  .analysis-table td:not(.analysis-name-col):not(.hocuspocus-spacer) {
    min-width: 1.6em;
  }

  tr.seat-broken td.analysis-name-col {
    background: color-mix(in srgb, var(--color-wolf) 22%, transparent);
  }

  .analysis-name-col {
    text-align: left !important;
    white-space: nowrap;
    padding-right: 12px !important;
    font-weight: 500;
  }

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

  .hocuspocus-spacer {
    border: none !important;
    background: transparent !important;
    width: 4px;
    padding: 0 !important;
  }

  .hocuspocus-cell {
    cursor: pointer;
    background: var(--color-bg-sunken);
    color: var(--color-border);
    font-weight: 700;
    user-select: none;
    min-width: 1em;
  }

  .hocuspocus-cell:hover {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .hocuspocus-cell.hocuspocus-on {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .analysis-label {
    display: inline-block;
    width: 1.8em;
    text-align: center;
    opacity: 0.6;
    font-size: 0.85em;
  }

  .analysis-name-col { font-weight: 700; }
  .analysis-name-col.village { background: var(--color-village-bg); }
  .analysis-name-col.wolf { background: var(--color-wolf-bg); }
  .analysis-name-col.fox { background: var(--color-fox-bg); }
  .analysis-name-col.not-village { background: var(--color-unknown-team-bg); }

  .analysis-sidebar {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .assumptions-list {
    padding: 8px;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .assumptions-header {
    color: var(--color-text-muted);
    margin-bottom: 4px;
  }

  .assumption-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
  }

  .assumption-text {
    color: var(--color-text);
  }

  .assumption-remove {
    background: none;
    border: none;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
  }

  .assumption-remove:hover {
    color: var(--color-text);
  }

  .assumption-add,
  .assumption-clear {
    background: none;
    border: 1px solid var(--color-text-faint);
    border-radius: 3px;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: 11px;
    padding: 1px 6px;
    margin-left: 4px;
  }

  .assumption-add:hover,
  .assumption-clear:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
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

  .deny-wolf {
    color: var(--color-wolf);
  }

  .suggestions-section {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border);
  }

  .suggestions-label {
    font-size: 11px;
    color: var(--color-text-faint);
    margin-bottom: 4px;
  }

  .suggestion-item {
    display: block;
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 12px;
    font-family: inherit;
    padding: 2px 0;
    cursor: pointer;
    text-align: left;
  }

  .suggestion-item:hover {
    color: var(--color-text);
  }

  .analysis-duration {
    margin-left: auto;
    font-size: 10px;
    color: var(--color-text-faint);
    text-align: right;
  }
</style>
