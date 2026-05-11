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

  // Direct iframe URL with empty referer (skipping the official script wrapper)
  // to bypass the localhost referer rejection on niconico's side.
  const src = $derived(`${NICO_ORIGIN}/watch/${videoId}?oldScript=1&referer=&from=0&allowProgrammaticFullScreen=1`)

  // Best-effort seek via postMessage. May silently no-op if jsapi is not enabled
  // on this embed URL — playback will still work, users seek manually.
  export function seekTo(seconds: number) {
    if (!iframeEl?.contentWindow) return
    iframeEl.contentWindow.postMessage({
      sourceConnectorType: 1,
      playerId: 'horkew',
      eventName: 'seek',
      data: { time: seconds * 1000 },
    }, '*')
  }

  function onMessage(e: MessageEvent) {
    if (e.origin !== NICO_ORIGIN) return
    const { eventName, data } = e.data ?? {}
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
    referrerpolicy="no-referrer"
    allow="autoplay; fullscreen; encrypted-media"
    allowfullscreen
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
