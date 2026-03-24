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

    // setTimeout to let UI update before blocking
    setTimeout(() => {
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
        result = searchTsumi(vs!, setup, options)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        running = false
      }
    }, 10)
  }

  function formatObsKey(key: string): string {
    return key
      .replace(/^m:wolf/, '霊媒●')
      .replace(/^m:human/, '霊媒○')
      .replace(/^m:null/, '霊媒?')
      .replace(/^peace$/, '平和')
      .replace(/^d:([\d,]+)/, (_, seats: string) =>
        seats.split(',').map((s: string) => `${playerName(Number(s))}死亡`).join(' ')
      )
      .replace(/\|s:wolf/, ' 占●')
      .replace(/\|s:human/, ' 占○')
      .replace(/\|neko:(\d+)/, (_, s: string) => ` 猫道連れ:${playerName(Number(s))}`)
      .replace(/\|follow:([\d,]+)/, (_, seats: string) =>
        ` 後追:${seats.split(',').map((s: string) => playerName(Number(s))).join(',')}`
      )
  }
</script>

<div class="hati-pane">
  <div class="hati-controls">
    <button
      class="hati-btn"
      onclick={runSearch}
      disabled={running || !vs || setup.size === 0}
    >{running ? '探索中...' : '詰み探索'}</button>
    {#if result}
      <span class="hati-stats">
        {result.stats.worldsTotal}世界 / {result.stats.nodesVisited}ノード / {result.stats.elapsed.toFixed(1)}ms
      </span>
    {/if}
  </div>

  {#if error}
    <div class="hati-error">{error}</div>
  {/if}

  {#if result}
    <div class="hati-verdict-bar" class:tsumi={result.isTsumi}>
      {result.isTsumi ? '詰み' : '詰みなし'}
    </div>

    {#if result.strategy}
      <div class="hati-tree">
        {#snippet strategyNode(node: StrategyNode, depth: number)}
          {#if node.type === 'win'}
            <span class="hati-win">村勝利</span>
          {:else}
            <div class="hati-action" class:night={node.action.execute === -1}>
              {#if node.action.execute !== -1}
                <span class="hati-exec">処刑 {playerName(node.action.execute)}</span>
              {/if}
              {#if node.action.bodyguardTarget !== null}
                <span class="hati-night-act">護衛→{playerName(node.action.bodyguardTarget)}</span>
              {/if}
              {#if node.action.seerTarget !== null}
                <span class="hati-night-act">占い→{playerName(node.action.seerTarget)}</span>
              {/if}
            </div>
            {#if Object.keys(node.branches).length === 1}
              {@const [key, child] = Object.entries(node.branches)[0]}
              <div class="hati-branch-inline">
                <span class="hati-obs">{formatObsKey(key)}</span>
                <span class="hati-arrow">→</span>
                {@render strategyNode(child, depth + 1)}
              </div>
            {:else}
              <div class="hati-branches">
                {#each Object.entries(node.branches) as [key, child]}
                  <div class="hati-branch">
                    <div class="hati-branch-header">
                      <span class="hati-obs">{formatObsKey(key)}</span>
                    </div>
                    <div class="hati-branch-body">
                      {@render strategyNode(child, depth + 1)}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        {/snippet}
        {@render strategyNode(result.strategy, 0)}
      </div>
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
    font-size: 0.85rem;
  }

  .hati-controls {
    display: flex;
    align-items: center;
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

  .hati-stats {
    font-size: 0.7rem;
    color: var(--ctp-subtext0);
  }

  .hati-error {
    color: var(--ctp-red);
    font-size: 0.85rem;
  }

  .hati-verdict-bar {
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    font-weight: bold;
    font-size: 0.9rem;
    flex-shrink: 0;
  }

  .hati-verdict-bar.tsumi {
    background: color-mix(in srgb, var(--ctp-green) 15%, transparent);
    color: var(--ctp-green);
    border-left: 3px solid var(--ctp-green);
  }

  .hati-verdict-bar:not(.tsumi) {
    background: var(--ctp-surface0);
    color: var(--ctp-subtext0);
    border-left: 3px solid var(--ctp-surface2);
  }

  .hati-tree {
    flex: 1;
    overflow: auto;
    padding: 0.3rem;
  }

  .hati-action {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .hati-exec {
    font-weight: bold;
    color: var(--ctp-red);
    background: color-mix(in srgb, var(--ctp-red) 10%, transparent);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .hati-night-act {
    color: var(--ctp-blue);
    font-size: 0.8rem;
  }

  .hati-win {
    color: var(--ctp-green);
    font-weight: bold;
  }

  .hati-branch-inline {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .hati-arrow {
    color: var(--ctp-overlay0);
  }

  .hati-obs {
    font-size: 0.75rem;
    color: var(--ctp-subtext0);
    background: var(--ctp-surface0);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
  }

  .hati-branches {
    margin-top: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .hati-branch {
    border-left: 2px solid var(--ctp-surface1);
    padding-left: 0.6rem;
  }

  .hati-branch-header {
    margin-bottom: 0.15rem;
  }

  .hati-branch-body {
    padding-left: 0.2rem;
  }
</style>
