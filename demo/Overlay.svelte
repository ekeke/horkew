<script lang="ts">
  import { onMount } from 'svelte'
  import { parse } from '../src/howl/index.ts'
  import { buildVillageStatus } from '../src/howl/bridge.ts'
  import type { VillageStatus, SystemRole } from '../src/types/index.ts'
  import type { SourceLines } from './App.svelte'
  import StatusPane from './status/StatusPane.svelte'
  import './theme.css'

  let villageStatus: VillageStatus | null = $state(null)
  let players: Map<number, string> = $state(new Map())
  let currentSetup: Map<SystemRole, number> = $state(new Map())
  let shortNames: Map<number, string> = $state(new Map())
  const emptySourceLines: SourceLines = {
    survivor: new Map(),
    claimRow: new Map(),
    claimCell: new Map(),
    kill: new Map(),
    exec: new Map(),
    vote: new Map(),
  }

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
    const room = new URLSearchParams(window.location.search).get('room')

    if (room) {
      // PartyKit WebSocket 接続
      const host = import.meta.env.DEV
        ? 'localhost:1999'
        : 'horkew-relay.ekeke.partykit.dev'
      const protocol = import.meta.env.DEV ? 'ws' : 'wss'
      const ws = new WebSocket(`${protocol}://${host}/party/${room}`)
      ws.onmessage = (event) => processHowl(event.data)
      ws.onerror = (e) => console.error('[overlay] WebSocket error', e)
      return () => ws.close()
    } else {
      // フォールバック: 同一ブラウザ内の BroadcastChannel
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

<div class="overlay">
  {#if villageStatus}
    <StatusPane vs={villageStatus} {players} setup={currentSetup} {shortNames} sourceLines={emptySourceLines} />
  {:else}
    <p class="waiting">メインウィンドウからの接続を待っています…</p>
  {/if}
</div>

<style>
  .overlay {
    padding: 8px;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .waiting {
    color: var(--ctp-subtext0, #999);
    font-size: 14px;
  }
</style>
