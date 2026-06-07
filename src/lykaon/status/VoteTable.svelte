<script lang="ts">
  import type { VoteStatus, VoteVerdictInfo } from './extract.ts'
  import type { SourceLines } from '../AnalysisContext.svelte.ts'
  import type { Writable } from 'svelte/store'
  import { getContext } from 'svelte'
  import { computeVerdicts } from './extract.ts'
  import PlayerName from './PlayerName.svelte'

  let { status }: {
    status: VoteStatus
  } = $props()

  const srcLines = getContext<Writable<SourceLines>>('sourceLines')
  const cursor = getContext<Writable<number>>('cursorLine')

  let verdicts = $derived(computeVerdicts(status))

  // Find the cutoff index: last non-safe row
  let cutoffIndex = $derived.by(() => {
    let last = -1
    for (let i = 0; i < status.rows.length; i++) {
      const v = verdicts.get(status.rows[i].seat)
      if (v?.verdict !== 'safe') last = i
    }
    return last
  })

  function verdictLabel(info: VoteVerdictInfo | undefined): string {
    if (!info) return ''
    switch (info.verdict) {
      case 'execution_locked': return info.executionVoterName ? `${info.executionVoterName}が処刑確定` : '処刑確定'
      case 'runoff_locked': return info.runoffVoterName ? `${info.runoffVoterName}が決戦↑確定` : '決戦↑確定'
      case 'safe': return info.savedBy ? `${info.savedBy}が救済` : '救済'
      default: return ''
    }
  }

  // Collect all decisive votedOrders across all candidates for cross-row highlighting
  let runoffOrders = $derived(new Set(
    [...verdicts.values()].map(v => v.runoffVoterOrder).filter((o): o is number => o !== undefined)
  ))
  let execOrders = $derived(new Set(
    [...verdicts.values()].map(v => v.executionVoterOrder).filter((o): o is number => o !== undefined)
  ))

  let visible = $derived(status.hasAnyVotes && !status.executionOccurred)
</script>

{#if visible}
<div class="section">
  <div class="section-header">投票状況 <span class="remaining">残り{status.remainingVotes}票</span></div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="verdict-col">状態</th>
          <th class="name-col">対象</th>
          <th class="count-col">得票</th>
          <th class="voters-col">投票者</th>
        </tr>
      </thead>
      <tbody>
        {#each status.rows as row, i}
          {@const info = verdicts.get(row.seat)}
          <tr
            class:execution-locked={info?.verdict === 'execution_locked'}
            class:runoff-locked={info?.verdict === 'runoff_locked'}
            class:safe={info?.verdict === 'safe'}
            class:cutoff={i === cutoffIndex && cutoffIndex < status.rows.length - 1}
            class:active-hl-row={row.voters.some(v => $srcLines.vote.get(v.seat) === $cursor)}
          >
            <td class="verdict-cell">{verdictLabel(info)}</td>
            <td class="name-cell"><PlayerName dead={false} seat={row.seat}>{row.name}</PlayerName></td>
            <td class="count-cell">{row.votedCount}</td>
            <td class="voters-cell">{#each row.voters as voter, vi}{#if vi > 0}<span class="sep">, </span>{/if}<span class:decisive-exec={execOrders.has(voter.votedOrder)} class:decisive-runoff={runoffOrders.has(voter.votedOrder)} class:active-hl-voter={$srcLines.vote.get(voter.seat) === $cursor}><PlayerName dead={false} seat={voter.seat}>{voter.name}</PlayerName></span>{/each}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if status.pending.length > 0}
    <div class="pending">
      <span class="pending-label">未投票:</span>
      {#each status.pending as p, i}
        {#if i > 0}<span class="sep">, </span>{/if}
        <span class="pending-name"><PlayerName dead={false} seat={p.seat}>{p.name}</PlayerName></span>
      {/each}
    </div>
  {/if}
</div>
{/if}

<style>
  .section {
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border);
  }

  .section-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    margin-bottom: 6px;
  }

  .remaining {
    color: var(--color-link);
    font-weight: 400;
  }

  .table-wrap {
    overflow-x: hidden;
  }

  table {
    border-collapse: collapse;
    font-size: 12px;
    font-family: var(--font-mono);
  }

  th, td {
    border: 1px solid var(--color-border);
    padding: 2px 6px;
  }

  th {
    background: var(--color-bg-elevated);
    color: var(--color-text-muted);
    font-weight: 500;
    font-size: 10px;
    text-align: left;
  }

  .verdict-cell {
    text-align: center;
    font-size: 10px;
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .name-cell {
    color: var(--color-text);
    font-weight: 500;
    white-space: nowrap;
  }

  .count-cell {
    text-align: center;
    color: var(--color-text);
    white-space: nowrap;
  }

  .voters-cell {
    color: var(--color-text-muted);
    word-break: break-all;
    overflow-wrap: break-word;
  }

  .sep {
    color: var(--color-text-faint);
  }

  /* Decisive voter highlights */
  .decisive-runoff {
    color: var(--color-execution);
    font-weight: 600;
  }

  .decisive-exec {
    color: var(--color-wolf);
    font-weight: 600;
  }

  /* Cutoff line */
  tr.cutoff > td {
    border-bottom: 3px solid var(--color-role);
  }

  /* Execution locked */
  tr.execution-locked > td {
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
  }
  tr.execution-locked .verdict-cell {
    color: var(--color-error);
    font-weight: 600;
  }

  /* Runoff locked */
  tr.runoff-locked > td {
    background: color-mix(in srgb, var(--color-execution) 15%, transparent);
  }
  tr.runoff-locked .verdict-cell {
    color: var(--color-execution);
    font-weight: 600;
  }

  /* Safe zone */
  tr.safe > td {
    opacity: 0.5;
  }

  .pending {
    margin-top: 6px;
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--color-text-muted);
  }

  .pending-label {
    color: var(--color-text-faint);
  }

  .pending-name {
    color: var(--color-text);
  }

  tr.active-hl-row > td {
    background: color-mix(in srgb, var(--color-link) 10%, transparent);
  }

  .active-hl-voter {
    color: var(--color-vote-arrow);
    font-weight: 600;
  }
</style>
