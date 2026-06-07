<script lang="ts">
  import type { Snippet } from 'svelte'
  import { systemRoles } from '../../types/index.ts'
  import type { SystemRole } from '../../types/index.ts'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'
  import PlayerName from '../status/PlayerName.svelte'
  import { classifyPlayer } from '../status/playerStatus.ts'

  type Grouping = 'seat' | 'co' | 'survival'
  type ViewOptions = { columns: 1 | 2 | 3 | 4, grouping: Grouping }

  let { ctx, onInsertRevealRoles, onOpenDenyWolfDialog, extraFooter, determinedBanner, hideAssumptions = false, defaultViewOptions }: {
    ctx: AnalysisContext
    onInsertRevealRoles?: (done: () => void) => void
    onOpenDenyWolfDialog?: () => void
    extraFooter?: Snippet
    determinedBanner?: Snippet<[{ insert: () => void, busy: boolean }]>
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

  function roleToShort(role: SystemRole): string {
    return systemRoles.get(role)?.shortName ?? role
  }

  let currentMap = $derived(new Map(ctx.analysisSeats.map(s => [s.seat, s.roles])))
  let baseMap = $derived(new Map(ctx.baseAnalysisSeats.map(s => [s.seat, s.roles])))

  // ---- View options (列数 / 分類) -----------------------------------
  const STORAGE_KEY = 'lykaon.analysisTable.viewOptions'
  const FALLBACK_VIEW: ViewOptions = { columns: 1, grouping: 'seat' }

  function loadViewOptions(): ViewOptions {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (
          (p.columns === 1 || p.columns === 2 || p.columns === 3 || p.columns === 4)
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
    const next = viewOptions.columns === 1 ? 2
      : viewOptions.columns === 2 ? 3
      : viewOptions.columns === 3 ? 4
      : 1
    viewOptions = { ...viewOptions, columns: next as 1 | 2 | 3 | 4 }
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

  // 分割を採用するために要求する最低削減行数 (削減 ≥ この値なら分割を進める)
  const CO_SPLIT_THRESHOLD = 2

  function buildCoColumns(): Column[] {
    const vs = ctx.villageStatus
    if (!vs) return []
    const divined = ctx.divinedSeats
    const allSeats = [...ctx.players.keys()]

    // sub-table 列を作る (CO_SUB_DEFS 順、 mainGroup は表示順序にのみ反映)。
    // CO 順 (claimOrder)、非CO は seat 順にフォールバック。
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
        subTables.push({ title: def.title, seats: matched.map(m => m.seat) })
      }
    }
    if (subTables.length === 0) return []

    return optimizeColumns(subTables, viewOptions.columns)
  }

  /**
   * sub-table 列を R 列に分配する共通最適化 (CO 別 / 生存別 で共有)。
   *
   * 分割なしを起点に、 最大 sub-table を 2,3,...,R 分割した case を順に試す。
   * - 各段で前段より閾値以上削減できれば採用、 ダメなら前段で確定
   * - ただし sub-table 数 < R で実効列数が R に届いていない段階では
   *   「列が余っている」状態なので閾値を緩めて改善あれば採用 (1 行でも) する
   */
  function optimizeColumns(subTables: SubTable[], R: number): Column[] {
    if (subTables.length === 0) return []
    let largestIdx = 0
    for (let i = 1; i < subTables.length; i++) {
      if (subTables[i].seats.length > subTables[largestIdx].seats.length) largestIdx = i
    }
    const largest = subTables[largestIdx]

    let bestColumns = distributeSubTables(subTables, R)
    let bestMax = maxRowsOf(bestColumns)
    for (let k = 2; k <= R && k <= largest.seats.length; k++) {
      const parts = splitSeatsEvenly(largest.seats, k)
      const splitSeq: SubTable[] = [
        ...subTables.slice(0, largestIdx),
        ...parts.map(seats => ({ title: largest.title, seats })),
        ...subTables.slice(largestIdx + 1),
      ]
      const cols = distributeSubTables(splitSeq, R)
      const max = maxRowsOf(cols)
      const effective = Math.min(R, splitSeq.length)
      const prevEffective = Math.min(R, splitSeq.length - 1)
      const expandingCols = effective > prevEffective
      const accept = expandingCols ? max < bestMax : max + CO_SPLIT_THRESHOLD <= bestMax
      if (accept) {
        bestColumns = cols
        bestMax = max
      } else {
        break
      }
    }
    return bestColumns
  }

  /** 列の行数 = Σ(1 (title) + seats.length) */
  function columnRows(col: Column): number {
    let rows = 0
    for (const st of col.subTables) rows += 1 + st.seats.length
    return rows
  }

  function maxRowsOf(cols: Column[]): number {
    let max = 0
    for (const c of cols) {
      const r = columnRows(c)
      if (r > max) max = r
    }
    return max
  }

  /** seats を k 個のチャンクに均等分割 ([3,3,4] のように後ろが大きめになる) */
  function splitSeatsEvenly(seats: number[], k: number): number[][] {
    const out: number[][] = []
    const len = seats.length
    for (let i = 0; i < k; i++) {
      const start = Math.floor((i * len) / k)
      const end = Math.floor(((i + 1) * len) / k)
      out.push(seats.slice(start, end))
    }
    return out
  }

  /**
   * sub-table 群を順序維持のまま R 個の連続チャンクに分け、
   * 最大列行数 (= maxRowsOf) が最小になる分け方を返す。
   * 全パターン C(N-1, R-1) を試行 (sub-table 数は 10 個程度までで全列挙可能)。
   */
  function distributeSubTables(sts: SubTable[], R: number): Column[] {
    if (sts.length === 0) return []
    if (R <= 1) return [{ subTables: sts }]
    const cols = Math.min(R, sts.length)
    if (cols === sts.length) return sts.map(s => ({ subTables: [s] }))

    const N = sts.length
    const rowsOf = (s: SubTable): number => 1 + s.seats.length
    const stRows: number[] = sts.map(rowsOf)

    let bestMax = Infinity
    let bestSplits: number[] = []

    const splits: number[] = []
    function recurse(start: number, depth: number): void {
      if (depth === cols - 1) {
        const allSplits = [...splits, N]
        let s = 0, max = 0
        for (let i = 0; i < cols; i++) {
          let chunk = 0
          for (let j = s; j < allSplits[i]; j++) chunk += stRows[j]
          if (chunk > max) max = chunk
          s = allSplits[i]
        }
        if (max < bestMax) {
          bestMax = max
          bestSplits = allSplits
        }
        return
      }
      for (let i = start; i <= N - (cols - 1 - depth); i++) {
        splits.push(i)
        recurse(i + 1, depth + 1)
        splits.pop()
      }
    }
    recurse(1, 0)

    const result: Column[] = []
    let s = 0
    for (const end of bestSplits) {
      result.push({ subTables: sts.slice(s, end) })
      s = end
    }
    return result
  }

  function buildSurvivalColumns(): Column[] {
    const alive: number[] = []
    const dead: number[] = []
    for (const seat of ctx.players.keys()) {
      if (ctx.deadSeats.has(seat)) dead.push(seat)
      else alive.push(seat)
    }
    const subTables: SubTable[] = []
    if (alive.length > 0) subTables.push({ title: '生存', seats: alive })
    if (dead.length > 0) subTables.push({ title: '退場', seats: dead })
    return optimizeColumns(subTables, viewOptions.columns)
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
  {@const status = classifyPlayer(currentMap.get(seat) ?? [])}
  {@const base = baseMap.get(seat) ?? []}
  {@const current = currentMap.get(seat) ?? []}
  {@const confirmedRole = base.length === 1 ? base[0] : undefined}
  <tr class:dead-row={ctx.deadSeats.has(seat)}>
    <td class="analysis-name-col">
      <PlayerName
        dead={ctx.deadSeats.has(seat)}
        nightKill={ctx.nightKilledSeats.has(seat)}
        executed={ctx.executedSeats.has(seat)}
        claim={ctx.claimShortNames.get(seat)}
        showClaim={viewOptions.grouping !== 'co'}
        status={status}
      >{ctx.playerShortNames.get(seat) ?? ctx.players.get(seat) ?? `#${seat}`}</PlayerName>
    </td>
    {#each ctx.analysisColumns as role}
      {@const assumed = ctx.assumptions.get(seat) === role}
      {@const currentPossible = current.includes(role)}
      {@const basePossible = base.includes(role)}
      {@const confirmed = !assumed && confirmedRole === role}
      {@const confirmedAlign = confirmed ? systemRoles.get(role)?.alignment : undefined}
      <td
        class:role-possible={!assumed && !confirmed && currentPossible}
        class:role-dim={!assumed && !confirmed && !currentPossible && basePossible}
        class:role-impossible={!assumed && !currentPossible && !basePossible}
        class:role-assumed={assumed}
        class:role-confirmed={confirmed}
        class:confirmed-village={confirmed && confirmedAlign === 'villager'}
        class:confirmed-wolf={confirmed && confirmedAlign === 'werewolf'}
        class:confirmed-fox={confirmed && confirmedAlign === 'werehamster'}
        onclick={() => ctx.toggleAssumption(seat, role)}
      >{roleToShort(role)}</td>
    {/each}
    <td class="hocuspocus-spacer"></td>
    <td
      class="hocuspocus-cell"
      class:hocuspocus-on={ctx.hocusPocusSeats.has(seat)}
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
    font-weight: 700;
    color: var(--color-text-muted);
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

  .analysis-name-col {
    text-align: left !important;
    white-space: nowrap;
    padding-right: 12px !important;
    font-weight: 700;
  }

  .role-possible,
  .role-dim,
  .role-impossible {
    cursor: pointer;
  }

  .role-possible:hover,
  .role-dim:hover,
  .role-impossible:hover {
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

  .role-impossible {
    background: var(--color-bg-sunken);
    color: var(--color-border);
  }

  .role-assumed {
    background: var(--color-accent);
    color: var(--color-bg);
    font-weight: 600;
  }

  .role-confirmed {
    color: var(--color-bg);
    font-weight: 700;
  }

  .role-confirmed.confirmed-village { background: var(--color-village); }
  .role-confirmed.confirmed-wolf { background: var(--color-wolf); }
  .role-confirmed.confirmed-fox { background: var(--color-fox); }
  .role-confirmed:not(.confirmed-village):not(.confirmed-wolf):not(.confirmed-fox) {
    background: var(--color-unknown-team);
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
