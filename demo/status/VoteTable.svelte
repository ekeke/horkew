<script lang="ts">
  import type { VoteStatus, VoteVerdictInfo } from './extract.ts'
  import { computeVerdicts } from './extract.ts'

  let { status }: {
    status: VoteStatus
  } = $props()

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
      case 'runoff_locked': return info.runoffVoterName ? `${info.runoffVoterName}が決戦\u2191確定` : '決戦\u2191確定'
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
          >
            <td class="verdict-cell">{verdictLabel(info)}</td>
            <td class="name-cell">{row.name}</td>
            <td class="count-cell">{row.votedCount}</td>
            <td class="voters-cell">{#each row.voters as voter, vi}{#if vi > 0}<span class="sep">, </span>{/if}<span class:decisive-exec={execOrders.has(voter.votedOrder)} class:decisive-runoff={runoffOrders.has(voter.votedOrder)}>{voter.name}</span>{/each}</td>
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
        <span class="pending-name">{p.name}</span>
      {/each}
    </div>
  {/if}
</div>
{/if}

<style>
  .section {
    padding: 8px 12px;
    border-bottom: 1px solid #313244;
  }

  .section-header {
    font-size: 12px;
    font-weight: 600;
    color: #a6adc8;
    margin-bottom: 6px;
  }

  .remaining {
    color: #89b4fa;
    font-weight: 400;
  }

  .table-wrap {
    overflow-x: hidden;
  }

  table {
    border-collapse: collapse;
    font-size: 12px;
    font-family: 'Consolas', 'Menlo', monospace;
    width: 100%;
    table-layout: fixed;
  }

  th, td {
    border: 1px solid #313244;
    padding: 2px 6px;
  }

  th {
    background: #181825;
    color: #a6adc8;
    font-weight: 500;
    font-size: 10px;
    text-align: center;
  }

  .verdict-col {
    width: 80px;
  }

  .name-col {
    width: 56px;
  }

  .count-col {
    width: 32px;
  }

  .verdict-cell {
    text-align: center;
    font-size: 10px;
    color: #a6adc8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .name-cell {
    color: #cdd6f4;
    font-weight: 500;
    white-space: nowrap;
  }

  .count-cell {
    text-align: center;
    color: #cdd6f4;
    white-space: nowrap;
  }

  .voters-cell {
    color: #a6adc8;
    word-break: break-all;
    overflow-wrap: break-word;
  }

  .sep {
    color: #585b70;
  }

  /* Decisive voter highlights */
  .decisive-runoff {
    color: #fab387;
    font-weight: 600;
  }

  .decisive-exec {
    color: #f38ba8;
    font-weight: 600;
  }

  /* Cutoff line */
  tr.cutoff > td {
    border-bottom: 3px solid #f9e2af;
  }

  /* Execution locked */
  tr.execution-locked > td {
    background: rgba(243, 139, 168, 0.15);
  }
  tr.execution-locked .verdict-cell {
    color: #f38ba8;
    font-weight: 600;
  }

  /* Runoff locked */
  tr.runoff-locked > td {
    background: rgba(250, 179, 135, 0.15);
  }
  tr.runoff-locked .verdict-cell {
    color: #fab387;
    font-weight: 600;
  }

  /* Safe zone */
  tr.safe > td {
    opacity: 0.5;
  }

  .pending {
    margin-top: 6px;
    font-size: 11px;
    font-family: 'Consolas', 'Menlo', monospace;
    color: #a6adc8;
  }

  .pending-label {
    color: #585b70;
  }

  .pending-name {
    color: #cdd6f4;
  }
</style>
