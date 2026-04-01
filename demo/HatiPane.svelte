<script lang="ts">
  import type { VillageStatus, SystemRole } from '../src/types/index.ts'
  import type { TsumiResult, StrategyNode } from '../src/hati/index.ts'
  import { searchTsumi } from '../src/hati/index.ts'
  import type { RunRetar } from '../src/hati/index.ts'
  import type { AnalyzeOptions } from '../src/retar/index.ts'
  import wasmInit, { analyze } from '../src/retar-rs/pkg-web/retar.js'
  // @ts-ignore — Vite ?url import
  import wasmUrl from '../src/retar-rs/pkg/retar_bg.wasm?url'
  import { serializeVillageStatus, serializeOptions, parseWasmResult, resultToPossibilities } from '../src/retar/wasm-helpers.ts'

  let {
    vs,
    setup,
    players,
  }: {
    vs: VillageStatus | null
    setup: Map<SystemRole, number>
    players: Map<number, string>
  } = $props()

  let wasmReady = $state(false)
  wasmInit(wasmUrl).then(() => { wasmReady = true }).catch(() => {})

  const wasmRunRetar: RunRetar = (vs, setup, options) => {
    const vsJson = JSON.stringify(serializeVillageStatus(vs))
    const setupJson = JSON.stringify(Object.fromEntries(setup))
    const optJson = JSON.stringify(serializeOptions(options))
    return resultToPossibilities(parseWasmResult(analyze(vsJson, setupJson, optJson)))
  }

  let result: TsumiResult | null = $state(null)
  let running = $state(false)
  let error = $state('')
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  function playerName(seat: number): string {
    return players.get(seat) ?? `${seat}`
  }

  function runSearch() {
    if (!vs || setup.size === 0) return
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    running = true
    error = ''
    result = null

    // setTimeout to let UI update before blocking
    pendingTimer = setTimeout(() => {
      pendingTimer = null
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
        result = searchTsumi(vs!, setup, options, undefined, wasmReady ? wasmRunRetar : undefined)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        running = false
      }
    }, 10)
  }

  // Auto-run when vs or setup changes
  $effect(() => {
    // Read reactive deps
    const _vs = vs
    const _setup = setup
    const _setupSize = setup.size
    // Trigger search
    runSearch()
  })

  function formatObsKey(key: string): string {
    return key
      .replace(/^m:wolf/, '●の場合')
      .replace(/^m:human/, '○の場合')
      .replace(/^m:null/, '?の場合')
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
        {result.stats.worldsTotal}世界 / {result.stats.nodesVisited}ノード / retar {result.stats.retarElapsed.toFixed(1)}ms + hati {result.stats.searchElapsed.toFixed(1)}ms
      </span>
    {/if}
  </div>

  {#if error}
    <div class="hati-error">{error}</div>
  {/if}

  {#if result}
    <div class="hati-verdict-bar" class:tsumi={result.isTsumi}>
      <span class="hati-verdict-label">{result.isTsumi ? '詰み' : '詰みなし'}</span>
      <span class="hati-nawa-threat">縄{result.judgment.profile.nawa % 1 ? result.judgment.profile.nawa.toFixed(1) : result.judgment.profile.nawa} / 人外{result.judgment.profile.threat}</span>
    </div>

    {#if result.strategy}
      <div class="hati-tree">
        {#snippet strategyNode(node: StrategyNode, depth: number)}
          {#if node.type === 'win'}
            <span class="hati-win">村勝利</span>
          {:else}
            {@const entries = Object.entries(node.branches)}
            {@const isTrivialWin = entries.length === 1 && entries[0][0] === 'win'}
            <div class="hati-action" class:night={node.action.execute === -1}>
              {#if node.action.execute !== -1}
                <span class="hati-exec">処刑 {playerName(node.action.execute)}</span>
              {/if}
              {#if node.action.bodyguardTarget !== null}
                <span class="hati-night-act">護衛→{playerName(node.action.bodyguardTarget)}</span>
              {/if}
              {#if node.action.seerTargets?.length}
                {#each node.action.seerTargets as st}
                  <span class="hati-night-act">占い→{playerName(st)}</span>
                {/each}
              {/if}
              {#if isTrivialWin}
                <span class="hati-arrow">→</span>
                <span class="hati-win">村勝利</span>
              {/if}
            </div>
            {#if !isTrivialWin && entries.length === 1}
              {@const [key, child] = entries[0]}
              <div class="hati-branch-inline">
                <span class="hati-obs">{formatObsKey(key)}</span>
                <span class="hati-arrow">→</span>
                {@render strategyNode(child, depth + 1)}
              </div>
            {:else if !isTrivialWin}
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

  .hati-verdict-bar {
    display: flex;
    align-items: center;
    gap: 0.8rem;
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

  .hati-nawa-threat {
    color: var(--ctp-subtext0);
    font-size: 0.75rem;
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
