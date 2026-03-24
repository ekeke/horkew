<script lang="ts">
  import type { VillageStatus, SystemRole } from '../src/types/index.ts'
  import type { TsumiResult, StrategyNode } from '../src/hati/index.ts'
  import { searchTsumi } from '../src/hati/index.ts'
  import type { AnalyzeOptions } from '../src/retar/index.ts'

  let {
    vs,
    setup,
    players,
  }: {
    vs: VillageStatus | null
    setup: Map<SystemRole, number>
    players: Map<number, string>
  } = $props()

  let result: TsumiResult | null = $state(null)
  let running = $state(false)
  let error = $state('')

  function playerName(seat: number): string {
    return players.get(seat) ?? `${seat}`
  }

  function runSearch() {
    if (!vs || setup.size === 0) return
    running = true
    error = ''
    result = null

    try {
      const options: AnalyzeOptions = {
        seerClaimingDueDate: 2,
        mediumClaimingDueDate: 2,
        bodyguardClaimingDueDate: 99,
        masonClaimingDueDate: 2,
        nekomataClaimingDueDate: 99,
        dayCountFrom: 1,
        hasFirstGhost: false,
        assumptions: new Map(),
        wolfPairDenyals: [],
        hocusPocus: new Map(),
        id: 0,
        batches: 1,
        batch: 0,
      }
      result = searchTsumi(vs, setup, options)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      running = false
    }
  }

  function formatNode(node: StrategyNode, depth: number = 0): any {
    if (node.type === 'win') return { type: 'win' }
    return {
      type: 'action',
      execute: node.action.execute !== -1 ? playerName(node.action.execute) : null,
      bodyguard: node.action.bodyguardTarget !== null ? playerName(node.action.bodyguardTarget) : null,
      seer: node.action.seerTarget !== null ? playerName(node.action.seerTarget) : null,
      branches: Object.fromEntries(
        Object.entries(node.branches).map(([k, v]) => [k, formatNode(v, depth + 1)])
      ),
    }
  }
</script>

<div class="hati-pane">
  <div class="hati-controls">
    <button
      class="hati-btn"
      onclick={runSearch}
      disabled={running || !vs || setup.size === 0}
    >{running ? '探索中...' : '詰み探索'}</button>
  </div>

  {#if error}
    <div class="hati-error">{error}</div>
  {/if}

  {#if result}
    <div class="hati-result" class:tsumi={result.isTsumi}>
      <div class="hati-verdict">{result.isTsumi ? '詰み' : '詰みなし'}</div>
      <div class="hati-stats">
        ワールド: {result.stats.worldsTotal} /
        ノード: {result.stats.nodesVisited} /
        深度: {result.stats.maxDepth} /
        {result.stats.elapsed.toFixed(1)}ms
      </div>
    </div>
    {#if result.strategy}
      <pre class="hati-json">{JSON.stringify(formatNode(result.strategy), null, 2)}</pre>
    {/if}
  {/if}
</div>

<style>
  .hati-pane {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    height: 100%;
    overflow: auto;
  }

  .hati-controls {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .hati-btn {
    padding: 0.3rem 0.8rem;
    border: 1px solid var(--ctp-surface1);
    border-radius: 4px;
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    cursor: pointer;
    font-size: 0.85rem;
  }

  .hati-btn:hover:not(:disabled) {
    background: var(--ctp-surface1);
  }

  .hati-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hati-error {
    color: var(--ctp-red);
    font-size: 0.85rem;
  }

  .hati-result {
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    background: var(--ctp-surface0);
    flex-shrink: 0;
  }

  .hati-result.tsumi {
    border-left: 3px solid var(--ctp-green);
  }

  .hati-result:not(.tsumi) {
    border-left: 3px solid var(--ctp-surface2);
  }

  .hati-verdict {
    font-weight: bold;
    font-size: 1rem;
  }

  .hati-result.tsumi .hati-verdict {
    color: var(--ctp-green);
  }

  .hati-stats {
    font-size: 0.75rem;
    color: var(--ctp-subtext0);
    margin-top: 0.2rem;
  }

  .hati-json {
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 0.75rem;
    color: var(--ctp-text);
    background: var(--ctp-mantle);
    padding: 0.5rem;
    border-radius: 4px;
    overflow: auto;
    flex: 1;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
