<script lang="ts">
  import type { VoteStatus, VoteVerdictInfo } from './extract.ts'
  import type { SourceLines } from '../AnalysisContext.svelte.ts'
  import type { Writable } from 'svelte/store'
  import { getContext } from 'svelte'
  import { computeVerdicts } from './extract.ts'
  import PlayerName from './PlayerName.svelte'

  let { status }: { status: VoteStatus } = $props()

  const srcLines = getContext<Writable<SourceLines>>('sourceLines')
  const cursor = getContext<Writable<number>>('cursorLine')

  let verdicts = $derived(computeVerdicts(status))

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

  let runoffOrders = $derived(new Set(
    [...verdicts.values()].map(v => v.runoffVoterOrder).filter((o): o is number => o !== undefined)
  ))
  let execOrders = $derived(new Set(
    [...verdicts.values()].map(v => v.executionVoterOrder).filter((o): o is number => o !== undefined)
  ))

  let visible = $derived(status.hasAnyVotes && !status.executionOccurred)
</script>

{#if visible}
<div class="vote-list">
  <div class="header">
    投票状況 <span class="remaining">残り{status.remainingVotes}票</span>
  </div>
  {#each status.rows as row, i}
    {@const info = verdicts.get(row.seat)}
    {@const label = verdictLabel(info)}
    <div
      class="row"
      class:execution-locked={info?.verdict === 'execution_locked'}
      class:runoff-locked={info?.verdict === 'runoff_locked'}
      class:safe={info?.verdict === 'safe'}
      class:cutoff={i === cutoffIndex && cutoffIndex < status.rows.length - 1}
      class:active-hl-row={row.voters.some(v => $srcLines.vote.get(v.seat) === $cursor)}
    >
      <div class="row-top">
        <span class="target"><PlayerName dead={false} seat={row.seat}>{row.name}</PlayerName></span>
        <span class="count">{row.votedCount}票</span>
      </div>
      {#if label}<div class="verdict">{label}</div>{/if}
      {#if row.voters.length > 0}
        <div class="voters">
          {#each row.voters as voter, vi}
            {#if vi > 0}<span class="sep">, </span>{/if}
            <span
              class:decisive-exec={execOrders.has(voter.votedOrder)}
              class:decisive-runoff={runoffOrders.has(voter.votedOrder)}
              class:active-hl-voter={$srcLines.vote.get(voter.seat) === $cursor}
            ><PlayerName dead={false} seat={voter.seat}>{voter.name}</PlayerName></span>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
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
  .vote-list {
    padding: 4px 8px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.3;
    color: var(--color-text);
  }

  .header {
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    margin-bottom: 3px;
  }

  .remaining {
    color: var(--color-link);
    font-weight: 400;
  }

  .row {
    padding: 2px 6px;
    margin-bottom: 2px;
    border-radius: 3px;
    border-left: 2px solid transparent;
  }

  .row-top {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .target {
    font-weight: 500;
  }

  .count {
    color: var(--color-text);
    font-size: 12px;
  }

  .verdict {
    font-size: 11px;
    color: var(--color-text-muted);
    margin-top: 0;
  }

  .voters {
    margin-top: 0;
    color: var(--color-text-muted);
    word-break: break-all;
    overflow-wrap: break-word;
  }

  .sep {
    color: var(--color-text-faint);
  }

  .decisive-runoff {
    color: var(--color-execution);
    font-weight: 600;
  }

  .decisive-exec {
    color: var(--color-wolf);
    font-weight: 600;
  }

  .row.cutoff {
    border-bottom: 2px solid var(--color-role);
    padding-bottom: 4px;
    margin-bottom: 4px;
  }

  .row.execution-locked {
    background: color-mix(in srgb, var(--color-error) 15%, transparent);
    border-left-color: var(--color-error);
  }

  .row.execution-locked .verdict {
    color: var(--color-error);
    font-weight: 600;
  }

  .row.runoff-locked {
    background: color-mix(in srgb, var(--color-execution) 15%, transparent);
    border-left-color: var(--color-execution);
  }

  .row.runoff-locked .verdict {
    color: var(--color-execution);
    font-weight: 600;
  }

  .row.safe {
    opacity: 0.5;
  }

  .row.active-hl-row {
    background: color-mix(in srgb, var(--color-link) 10%, transparent);
  }

  .active-hl-voter {
    color: var(--color-vote-arrow);
    font-weight: 600;
  }

  .pending {
    margin-top: 4px;
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .pending-label {
    color: var(--color-text-faint);
  }

  .pending-name {
    color: var(--color-text);
  }
</style>
