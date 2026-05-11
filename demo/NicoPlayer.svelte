<script lang="ts">
  let {
    videoId,
    currentTime = $bindable(0),
    autoplay: _autoplay = false,
    onended: _onended,
  }: {
    videoId: string
    currentTime?: number
    autoplay?: boolean
    onended?: () => void
  } = $props()

  let iframeEl: HTMLIFrameElement | undefined = $state()
  let ready = $state(false)

  const NICO_ORIGIN = 'https://embed.nicovideo.jp'
  const PLAYER_ID = 'horkew'

  // Minimal jsapi URL form from older niconico embed docs.
  const src = $derived(`${NICO_ORIGIN}/watch/${videoId}?jsapi=1&playerId=${PLAYER_ID}`)

  export function seekTo(seconds: number) {
    if (!iframeEl?.contentWindow) return
    iframeEl.contentWindow.postMessage({
      sourceConnectorType: 1,
      playerId: PLAYER_ID,
      eventName: 'seek',
      data: { time: seconds * 1000 },
    }, '*')
  }

  function onMessage(e: MessageEvent) {
    if (e.origin !== NICO_ORIGIN) return
    const msg = e.data ?? {}
    if (msg.playerId && msg.playerId !== PLAYER_ID) return
    const { eventName, data } = msg
    console.debug('[NicoPlayer] message', eventName, data)
    if (eventName === 'playerMetadataChange' && data) {
      if (typeof data.currentTime === 'number') {
        currentTime = data.currentTime / 1000
      }
      if (!ready) ready = true
    }
    if (eventName === 'loadComplete') {
      ready = true
    }
  }

  $effect(() => {
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })
</script>

<div class="nico-wrap">
  <iframe
    bind:this={iframeEl}
    {src}
    width="100%"
    height="100%"
    frameborder="0"
    allow="autoplay; fullscreen; encrypted-media"
    allowfullscreen
    onload={() => ready = true}
    title="niconico player"
  ></iframe>
  {#if !ready}
    <div class="nico-loading">Loading...</div>
  {/if}
</div>

<style>
  .nico-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
  }

  .nico-wrap iframe {
    width: 100%;
    height: 100%;
    display: block;
  }

  .nico-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted, #888);
    font-size: 14px;
    pointer-events: none;
  }
</style>
