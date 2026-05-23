<script lang="ts">
  import type { Snippet } from 'svelte'
  import { systemRoles } from '../../types/index.ts'
  import type { SystemRole } from '../../types/index.ts'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'
  import PlayerName from '../status/PlayerName.svelte'

  let { ctx, onInsertRevealRoles, onOpenDenyWolfDialog, extraFooter }: {
    ctx: AnalysisContext
    onInsertRevealRoles?: () => void
    onOpenDenyWolfDialog?: () => void
    extraFooter?: Snippet
  } = $props()

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
</script>

{#if ctx.analysisError}
  <pre class="output">Error: {ctx.analysisError}</pre>
{/if}
{#if ctx.analysisColumns.length > 0 && ctx.players.size > 0}
  <div class="analysis-layout">
    <div class="analysis-table-wrap">
      <table class="analysis-table">
        <tbody>
          {#each [...ctx.players] as [seat, name]}
            {@const cls = classifyPlayer(currentMap.get(seat) ?? [])}
            <tr class={ctx.deadSeats.has(seat) ? 'dead-row' : ''}>
              <td class="analysis-name-col {cls.status}" class:role-fixed={cls.fixed}>
                <span class="analysis-label">{cls.label}</span>
                <PlayerName
                  dead={ctx.deadSeats.has(seat)}
                  nightKill={ctx.nightKilledSeats.has(seat)}
                  executed={ctx.executedSeats.has(seat)}
                  claim={ctx.claimShortNames.get(seat)}
                >{ctx.playerShortNames.get(seat) ?? name}</PlayerName>
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
          {/each}
        </tbody>
      </table>
      {#if ctx.analysisDuration > 0}
        <div class="analysis-duration">retar {ctx.analysisDuration}ms{#if ctx.analysisStats} ({ctx.analysisStats.workers}w, wall {ctx.analysisStats.wallClock}ms, worker {ctx.analysisStats.minElapsed}-{ctx.analysisStats.maxElapsed}ms, {ctx.analysisStats.wasm ? 'WASM' : 'JS'}){/if}</div>
      {/if}
      {#if extraFooter}
        {@render extraFooter()}
      {/if}
    </div>
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
        {#if onInsertRevealRoles && ctx.allRolesDetermined}
          <div class="determined-banner">
            <span class="determined-label">配役確定</span>
            <button class="determined-insert" onclick={onInsertRevealRoles}>挿入</button>
          </div>
        {/if}
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
      {#if ctx.gmorkResult}
        <div class="gmork-results">{ctx.gmorkResult}</div>
      {/if}
    </div>
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

  .analysis-table-wrap {
    flex: 0 0 auto;
    overflow: auto;
    padding: 2px;
  }

  .analysis-table {
    border-collapse: collapse;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
  }

  .analysis-table td {
    text-align: center;
    padding: 2px 4px;
    border: 1px solid var(--color-border);
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
    width: 16px;
    padding: 0 !important;
  }

  .hocuspocus-cell {
    cursor: pointer;
    background: var(--color-bg-sunken);
    color: var(--color-border);
    font-weight: 700;
    user-select: none;
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
    font-family: 'Consolas', 'Menlo', monospace;
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
    margin-bottom: 4px;
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

  .gmork-results {
    padding: 8px;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
    color: var(--color-text-muted);
    white-space: pre-wrap;
  }

  .analysis-duration {
    padding: 2px;
    font-size: 10px;
    color: var(--color-text-faint);
    text-align: right;
  }
</style>
