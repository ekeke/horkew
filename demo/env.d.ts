/// <reference types="svelte" />
/// <reference types="vite/client" />

// YouTube iframe API
declare namespace YT {
  enum PlayerState {
    UNSTARTED = -1,
    ENDED = 0,
    PLAYING = 1,
    PAUSED = 2,
    BUFFERING = 3,
    CUED = 5,
  }

  interface PlayerOptions {
    videoId?: string
    width?: string | number
    height?: string | number
    playerVars?: Record<string, number | string>
    events?: {
      onReady?: (e: { target: Player }) => void
      onStateChange?: (e: OnStateChangeEvent) => void
      onError?: (e: { data: number }) => void
    }
  }

  interface OnStateChangeEvent {
    data: PlayerState
    target: Player
  }

  class Player {
    constructor(el: string | HTMLElement, opts: PlayerOptions)
    getCurrentTime(): number
    getDuration(): number
    seekTo(seconds: number, allowSeekAhead?: boolean): void
    playVideo(): void
    pauseVideo(): void
    destroy(): void
  }
}

interface Window {
  YT?: typeof YT
  onYouTubeIframeAPIReady?: () => void
}
