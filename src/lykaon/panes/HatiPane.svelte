<script lang="ts">
  import type { TsumiResult, StrategyNode, RunRetar } from '../../hati/index.ts'
  import { searchTsumi, searchTsumiStrategy } from '../../hati/index.ts'
  import type { AnalyzeOptions } from '../../retar/index.ts'
  import wasmInit, { analyze } from '../../retar-rs/pkg-web/retar.js'
  // @ts-ignore — Vite ?url import
  import wasmUrl from '../../retar-rs/pkg/retar_bg.wasm?url'
  import { serializeVillageStatus, serializeOptions, parseWasmResult, resultToPossibilities } from '../../retar/wasm-helpers.ts'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'

  let { ctx }: { ctx: AnalysisContext } = $props()

  let wasmReady = $state(false)
  wasmInit({ module_or_path: wasmUrl }).then(() => { wasmReady = true }).catch(() => {})

  const wasmRunRetar: RunRetar = (vs, setup, options) => {
    const vsJson = JSON.stringify(serializeVillageStatus(vs))
    const setupJson = JSON.stringify(Object.fromEntries(setup))
    const optJson = JSON.stringify(serializeOptions(options))
    return resultToPossibilities(parseWasmResult(analyze(vsJson, setupJson, optJson)))
  }

  type DisplayResult = {
    tsumi: TsumiResult
    strategy: StrategyNode | null
    worldsTotal: number
    nodesVisited: number
    enumerateElapsed: number
    searchElapsed: number
  }

  let result: DisplayResult | null = $state(null)
  let running = $state(false)
  let error = $state('')
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  function playerName(seat: number): string {
    return ctx.players.get(seat) ?? `${seat}`
  }

  function runSearch() {
    const vs = ctx.villageStatus
    const setup = ctx.setup
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
        const tsumi = searchTsumi(vs, setup, options, wasmReady ? wasmRunRetar : undefined)
        if (tsumi.isTsumi) {
          const sr = searchTsumiStrategy(tsumi)
          result = {
            tsumi,
            strategy: sr.strategy,
            worldsTotal: sr.worldsTotal,
            nodesVisited: sr.nodesVisited,
            enumerateElapsed: sr.enumerateElapsed,
            searchElapsed: sr.searchElapsed,
          }
        } else {
          result = {
            tsumi,
            strategy: null,
            worldsTotal: 0,
            nodesVisited: 0,
            enumerateElapsed: 0,
            searchElapsed: 0,
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        running = false
      }
    }, 10)
  }

  // Auto-run when villageStatus or setup changes
  $effect(() => {
    // Read reactive deps to register tracking
    void ctx.villageStatus
    void ctx.setup
    void ctx.setup.size
    runSearch()
  })

  function formatObsKey(key: string): string {
    return key
      .replace(/^m:wolf/, '●の場合')
      .replace(/^m:human/, '○の場合')
      .replace(/^m:null/, '?の場合')
      .replace(/^peace$/, '平和')
      .replace(/^d:([\d,]+)/, (_, seats: string) =>
        seats.split(',').map((s: string) => `${playerName(Number(s))}退場`).join(' ')
      )
      .replace(/\|s:wolf/, ' 占●')
      .replace(/\|s:human/, ' 占○')
      .replace(/\|neko:(\d+)/, (_, s: string) => ` 猫道連れ:${playerName(Number(s))}`)
      .replace(/\|follow:([\d,]+)/, (_, seats: string) =>
        ` 後追:${seats.split(',').map((s: string) => playerName(Number(s))).join(',')}`
      )
  }
</script>

<div class="hati-pane lyk-pane">
  <div class="hati-controls">
    <button
      class="hati-btn"
      onclick={runSearch}
      disabled={running || !ctx.villageStatus || ctx.setup.size === 0}
    >{running ? '探索中...' : '詰み探索'}</button>
    {#if result}
      <span class="hati-stats">
        {result.worldsTotal}世界 / {result.nodesVisited}ノード / retar {result.tsumi.stats.retarElapsed.toFixed(1)}ms + hati {result.searchElapsed.toFixed(1)}ms
      </span>
    {/if}
  </div>

  {#if error}
    <div class="hati-error">{error}</div>
  {/if}

  {#if result}
    <div class="hati-verdict-bar" class:tsumi={result.tsumi.isTsumi}>
      <span class="hati-verdict-label">{result.tsumi.isTsumi ? '詰み' : '詰みなし'}</span>
      <span class="hati-nawa-threat">縄{result.tsumi.judgment.profile.nawa % 1 ? result.tsumi.judgment.profile.nawa.toFixed(1) : result.tsumi.judgment.profile.nawa} / 人外{result.tsumi.judgment.profile.threat}</span>
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
  /* rem 単位を全廃 (px 固定) — host の html font-size 流入を遮断する。 */
  .hati-pane {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    overflow: auto;
    font-size: 14px;
  }

  .hati-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .hati-btn {
    padding: 5px 13px;
    border: 1px solid var(--ctp-surface1);
    border-radius: 4px;
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    cursor: pointer;
    font-size: 14px;
  }

  .hati-btn:hover:not(:disabled) {
    background: var(--ctp-surface1);
  }

  .hati-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hati-stats {
    font-size: 11px;
    color: var(--ctp-subtext0);
  }

  .hati-error {
    color: var(--ctp-red);
    font-size: 14px;
  }

  .hati-verdict-bar {
    padding: 5px 10px;
    border-radius: 4px;
    font-weight: bold;
    font-size: 15px;
    flex-shrink: 0;
  }

  .hati-verdict-bar {
    display: flex;
    align-items: center;
    gap: 13px;
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
    font-size: 12px;
  }

  .hati-tree {
    flex: 1;
    overflow: auto;
    padding: 5px;
  }

  .hati-action {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }

  .hati-exec {
    font-weight: bold;
    color: var(--ctp-red);
    background: color-mix(in srgb, var(--ctp-red) 10%, transparent);
    padding: 2px 6px;
    border-radius: 3px;
  }

  .hati-night-act {
    color: var(--ctp-blue);
    font-size: 13px;
  }

  .hati-win {
    color: var(--ctp-green);
    font-weight: bold;
  }

  .hati-branch-inline {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .hati-arrow {
    color: var(--ctp-overlay0);
  }

  .hati-obs {
    font-size: 12px;
    color: var(--ctp-subtext0);
    background: var(--ctp-surface0);
    padding: 1px 6px;
    border-radius: 3px;
  }

  .hati-branches {
    margin-top: 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hati-branch {
    border-left: 2px solid var(--ctp-surface1);
    padding-left: 10px;
  }

  .hati-branch-header {
    margin-bottom: 2px;
  }

  .hati-branch-body {
    padding-left: 3px;
  }
</style>
