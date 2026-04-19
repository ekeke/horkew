<script lang="ts">
  import { onMount } from 'svelte'
  import { parse } from '../src/howl/index.ts'
  import { buildVillageStatus } from '../src/howl/bridge.ts'
  import type { VillageStatus, SystemRole } from '../src/types/index.ts'
  import type { SourceLines } from './App.svelte'
  import StatusPane from './status/StatusPane.svelte'
  import FitContainer from './FitContainer.svelte'
  import './theme.css'

  type CanvasSize = 'hd' | 'fhd'
  type Alignment = 'top' | 'bottom' | 'left' | 'right'
  type Cols = 1 | 2
  type HiddenSection = 'setup' | 'survivor' | 'vote' | 'kill' | 'execution' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata'

  let villageStatus: VillageStatus | null = $state(null)
  let players: Map<number, string> = $state(new Map())
  let currentSetup: Map<SystemRole, number> = $state(new Map())
  let shortNames: Map<number, string> = $state(new Map())
  let canvasSize: CanvasSize = $state('hd')
  let alignment: Alignment = $state('bottom')
  let bannerHeight: number = $state(100)
  let stripWidth: number = $state(320)
  let cols: Cols = $state(1)
  let bgOpacity: number = $state(100)
  let theme: 'dark' | 'light' = $state('dark')

  const emptySourceLines: SourceLines = {
    survivor: new Map(),
    claimRow: new Map(),
    claimCell: new Map(),
    kill: new Map(),
    exec: new Map(),
    vote: new Map(),
  }

  const HORIZONTAL_HIDDEN: Set<HiddenSection> = new Set(['setup', 'survivor', 'vote'])
  const LEFT_COL_HIDDEN: Set<HiddenSection> = new Set(['setup', 'survivor', 'vote', 'kill', 'execution', 'bodyguard', 'mason', 'nekomata'])
  const RIGHT_COL_HIDDEN: Set<HiddenSection> = new Set(['setup', 'survivor', 'vote', 'seer', 'medium', 'mason', 'nekomata'])

  let isHorizontal = $derived(alignment === 'top' || alignment === 'bottom')
  let hiddenSections = $derived(isHorizontal ? HORIZONTAL_HIDDEN : new Set<HiddenSection>())
  let twoColActive = $derived(cols === 2 && isHorizontal)

  function readUrlSettings() {
    const params = new URLSearchParams(window.location.search)
    const canvas = params.get('canvas')
    if (canvas === 'hd' || canvas === 'fhd') canvasSize = canvas
    const align = params.get('align')
    if (align === 'top' || align === 'bottom' || align === 'left' || align === 'right') alignment = align
    const banner = Number(params.get('banner'))
    if (Number.isFinite(banner) && banner > 0) bannerHeight = banner
    const strip = Number(params.get('strip'))
    if (Number.isFinite(strip) && strip > 0) stripWidth = strip
    const c = Number(params.get('cols'))
    if (c === 1 || c === 2) cols = c as Cols
    const bg = Number(params.get('bg'))
    if (Number.isFinite(bg) && bg >= 0 && bg <= 100) bgOpacity = Math.round(bg)
    const t = params.get('theme')
    if (t === 'dark' || t === 'light') theme = t
  }

  $effect(() => {
    document.documentElement.dataset.theme = theme
  })

  function processHowl(text: string) {
    try {
      const { meta, statements } = parse(text)
      const result = buildVillageStatus(statements, meta)
      villageStatus = result.vs
      players = result.players
      currentSetup = result.setup
      shortNames = result.shortNames
    } catch {
      // parse error — keep last valid state
    }
  }

  onMount(() => {
    readUrlSettings()

    const room = new URLSearchParams(window.location.search).get('room')

    if (room) {
      const host = import.meta.env.DEV
        ? 'localhost:1999'
        : 'horkew-relay.ekeke.partykit.dev'
      const protocol = import.meta.env.DEV ? 'ws' : 'wss'
      const ws = new WebSocket(`${protocol}://${host}/party/${room}`)
      ws.onmessage = (event) => processHowl(event.data)
      ws.onerror = (e) => console.error('[overlay] WebSocket error', e)
      return () => ws.close()
    } else {
      const channel = new BroadcastChannel('horkew-overlay')
      channel.onmessage = (event) => {
        if (event.data?.type === 'howl') {
          processHowl(event.data.text)
        }
      }
      return () => channel.close()
    }
  })
</script>

<div class="canvas" data-canvas={canvasSize} style="--banner-height: {bannerHeight}px; --strip-width: {stripWidth}px; --bg-opacity: {bgOpacity / 100};" role="region" aria-label="Horkew Overlay">
  <div class="content" data-alignment={alignment} class:two-col={twoColActive}>
    {#if villageStatus}
      {#if twoColActive}
        <div class="col">
          <FitContainer>
            <StatusPane vs={villageStatus} {players} setup={currentSetup} {shortNames} sourceLines={emptySourceLines} hiddenSections={LEFT_COL_HIDDEN} />
          </FitContainer>
        </div>
        <div class="col">
          <FitContainer>
            <StatusPane vs={villageStatus} {players} setup={currentSetup} {shortNames} sourceLines={emptySourceLines} hiddenSections={RIGHT_COL_HIDDEN} />
          </FitContainer>
        </div>
      {:else}
        <FitContainer>
          <StatusPane vs={villageStatus} {players} setup={currentSetup} {shortNames} sourceLines={emptySourceLines} {hiddenSections} />
        </FitContainer>
      {/if}
    {:else}
      <p class="waiting">メインウィンドウからの接続を待っています…</p>
    {/if}
  </div>
</div>

<style>
  .canvas {
    position: relative;
    background: transparent;
    color: var(--color-text);
    font-family: system-ui, -apple-system, sans-serif;
    overflow: hidden;
    box-sizing: border-box;
  }

  .canvas[data-canvas='hd'] {
    width: 1280px;
    height: 720px;
  }

  .canvas[data-canvas='fhd'] {
    width: 1920px;
    height: 1080px;
  }

  .content {
    position: absolute;
    background: color-mix(in srgb, var(--color-bg) calc(var(--bg-opacity, 1) * 100%), transparent);
    overflow: hidden;
    padding: 8px;
    box-sizing: border-box;
  }

  .content[data-alignment='top'],
  .content[data-alignment='bottom'] {
    padding: 0;
  }

  .content[data-alignment='top'] {
    top: 0;
    left: 0;
    right: 0;
    height: var(--banner-height, 100px);
  }

  .content[data-alignment='bottom'] {
    bottom: 0;
    left: 0;
    right: 0;
    height: var(--banner-height, 100px);
  }

  .content[data-alignment='left'] {
    top: 0;
    bottom: 0;
    left: 0;
    width: var(--strip-width, 320px);
  }

  .content[data-alignment='right'] {
    top: 0;
    bottom: 0;
    right: 0;
    width: var(--strip-width, 320px);
  }

  .content.two-col {
    display: flex;
    gap: 4px;
  }

  .col {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .waiting {
    color: var(--color-text-muted);
    font-size: 14px;
    margin: 0;
  }
</style>
