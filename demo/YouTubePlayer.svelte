<script lang="ts">
  let {
    videoId,
    currentTime = $bindable(0),
    autoplay = false,
    onended,
  }: {
    videoId: string
    currentTime?: number
    autoplay?: boolean
    onended?: () => void
  } = $props()

  let container: HTMLDivElement | undefined = $state()
  let player: YT.Player | undefined
  let polling: ReturnType<typeof setInterval> | undefined
  let ready = $state(false)
  let pendingSeek: number | undefined

  export function seekTo(seconds: number) {
    if (ready && player && typeof player.seekTo === 'function') {
      player.seekTo(seconds, true)
    } else {
      pendingSeek = seconds
    }
  }

  // Load YouTube iframe API once globally
  function ensureApi(): Promise<void> {
    if (window.YT?.Player) return Promise.resolve()
    return new Promise(resolve => {
      const prev = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        prev?.()
        resolve()
      }
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const tag = document.createElement('script')
        tag.src = 'https://www.youtube.com/iframe_api'
        document.head.appendChild(tag)
      }
    })
  }

  function startPolling() {
    stopPolling()
    polling = setInterval(() => {
      if (player && typeof player.getCurrentTime === 'function') {
        currentTime = player.getCurrentTime()
      }
    }, 1000)
  }

  function stopPolling() {
    if (polling) {
      clearInterval(polling)
      polling = undefined
    }
  }

  $effect(() => {
    if (!container) return
    const id = videoId
    ready = false
    ensureApi().then(() => {
      if (player) {
        player.destroy()
        player = undefined
      }
      player = new YT.Player(container!, {
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          rel: 0,
        },
        events: {
          onReady() {
            ready = true
            startPolling()
            if (pendingSeek !== undefined) {
              player!.seekTo(pendingSeek, true)
              pendingSeek = undefined
            }
            if (autoplay && player) player.playVideo()
          },
          onStateChange(e: YT.OnStateChangeEvent) {
            if (player && typeof player.getCurrentTime === 'function') {
              currentTime = player.getCurrentTime()
            }
            if (e.data === YT.PlayerState.ENDED) onended?.()
          },
        },
      })
    })
    return () => {
      stopPolling()
      if (player) {
        player.destroy()
        player = undefined
      }
    }
  })
</script>

<div class="yt-wrap">
  <div class="yt-player" bind:this={container}></div>
  {#if !ready}
    <div class="yt-loading">Loading...</div>
  {/if}
</div>

<style>
  .yt-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: #000;
  }

  .yt-player {
    width: 100%;
    height: 100%;
  }

  .yt-player :global(iframe) {
    width: 100%;
    height: 100%;
    display: block;
  }

  .yt-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted, #888);
    font-size: 14px;
  }
</style>
