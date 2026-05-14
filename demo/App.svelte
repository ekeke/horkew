<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import { parse, parseFrontmatter, buildFrontmatter, parseStatement } from '../src/howl/index.ts'
  import { buildVillageStatus } from '../src/howl/bridge.ts'
  import { statementsToPublicEvents } from '../src/howl/events-bridge.ts'
  import { systemRoles } from '../src/types/index.ts'
  import { stringifyStatements, type StringifiedLine } from '../src/lykaon/stringify.ts'
  import type { SeatResult } from '../src/lykaon/analysis.worker.ts'
  import type { SystemRole, VillageStatus, CauseOfDeath } from '../src/types/index.ts'
  import { requestAnalysis, type AnalysisStats } from '../src/lykaon/runAnalysis.ts'
  import { serializeVillageStatus } from '../src/retar/wasm-helpers.ts'
  import {
    createAnalysisContext,
    HatiPane,
    StatusPane,
    InspectPane,
    GmorkDebugPane,
  } from '../src/lykaon/index.ts'
  import PlayerName from './status/PlayerName.svelte'
  import { findReason, findConfirmationReason } from '../src/gmork/index.ts'
  import { formatReason, formatConfirmationReason } from '../src/gmork/format.ts'
  import { scoreWolfPairs, type WolfPairSuggestion } from './status/wolfPairScorer.ts'
  import HelpPanel from './HelpPanel.svelte'
  import YouTubePlayer from './YouTubePlayer.svelte'
  import NicoPlayer from './NicoPlayer.svelte'
  import ColorSwatchPane from './ColorSwatchPane.svelte'
  import SkollPane from './SkollPane.svelte'
  import PretrainPane from './PretrainPane.svelte'
  import StatsPane from './StatsPane.svelte'
  import CommandPlayPane from './CommandPlayPane.svelte'
  import FileSidebar from './FileSidebar.svelte'
  import { commandPlayStore } from './commandPlayStore.ts'
  import '../src/lykaon/theme.css'
  import { runGame } from '../src/lupa/engine.ts'
  import { agentAdapter } from '../src/verify/agent-adapter.ts'
  import { RuleBasedAgent, WolfTeamRuleAgent, MasonTeamRuleAgent } from '../src/fenrir/src/agents/rule-based-agent.ts'
  import { formatHowl } from '../src/lupa/format.ts'
  import { onOpenHelp, onStartTrial, TUTORIAL_TEXT } from './help.ts'
  import type { FlexibleDictionary } from '../src/howl/flexibleDictionary.ts'
  import type { EditorView } from '@codemirror/view'
  import { setOnSeek } from '../src/lykaon/editor/howlLanguage.ts'
  import type { StatementInfo, PlayerNameInfo } from '../src/lykaon/editor/howlLanguage.ts'

  type EditorModule = typeof import('../src/lykaon/editor/index.ts')
  let editorModule: EditorModule | undefined

  export type SourceLines = {
    survivor: Map<number, number>   // seat → line
    claimRow: Map<number, number>   // seat → line (CO declaration / row highlight)
    claimCell: Map<string, number>  // "seat:night" → line (per-cell highlight)
    kill: Map<number, number>       // nightDay (kills map key) → line
    exec: Map<number, number>       // execDay → line
    vote: Map<number, number>       // voterSeat → line
  }

  const nightKillCauses: Set<CauseOfDeath> = new Set([
    'night_kill', 'follow_killed_hamster', 'cursed_by_killed_nekomata',
  ])

  const STORAGE_PREFIX = 'horkew:'
  const SETTINGS_KEY = 'horkew:__settings__'
  const INDEX_KEY = 'horkew:__index__'

  interface FileEntry {
    title?: string
    createdAt: number
    updatedAt: number
  }

  type FileIndex = Record<string, FileEntry>

  function formatDate(ms: number): string {
    const d = new Date(ms)
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  function displayName(entry: FileEntry): string {
    return entry.title ?? formatDate(entry.createdAt)
  }

  function loadIndex(): FileIndex {
    try {
      const stored = localStorage.getItem(INDEX_KEY)
      if (stored) return JSON.parse(stored)
    } catch {}
    return {}
  }

  function saveIndex(index: FileIndex) {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  }

  type Skin = 'flat' | 'excite'

  const paneEntries = [
    { id: 'input', label: 'Input (Editor)' },
    { id: 'rawStatements', label: 'Raw Statements' },
    { id: 'parsed', label: 'Parsed' },
    { id: 'combined', label: 'Combined' },
    { id: 'status', label: 'Status' },
    { id: 'analyzerInput', label: 'Analyzer Input' },
    { id: 'analysis', label: 'Analysis' },
    { id: 'colorSwatch', label: 'Color Swatch' },
    { id: 'hati', label: 'Hati (詰み)' },
    { id: 'skoll', label: 'Skoll (確率)' },
    { id: 'gmorkDebug', label: 'Gmork Debug' },
    { id: 'fenrirInspect', label: 'Fenrir Inspect' },
    { id: 'pretrainViz', label: 'Pretrain Viz' },
    { id: 'fenrirStats', label: 'Fenrir Stats' },
    { id: 'commandPlay', label: 'Command Play' },
  ] as const

  type PaneId = typeof paneEntries[number]['id']
  type DebugLayout = 'off' | 'debug' | 'fenrir'
  const debugRotation: DebugLayout[] = ['off', 'debug', 'fenrir']

  interface Settings {
    active: string
    skin: Skin
    devMode: boolean
    debug: DebugLayout
    panes: Record<PaneId, boolean>
    sidebarOpen: boolean
  }

  const defaultPanes: Record<PaneId, boolean> = { input: true, rawStatements: true, parsed: true, combined: true, status: true, analyzerInput: true, analysis: true, colorSwatch: true, hati: true, skoll: false, gmorkDebug: false, fenrirInspect: false, pretrainViz: false, fenrirStats: false, commandPlay: false }

  function loadSettings(): Settings {
    const defaults: Settings = { active: '', skin: 'flat', devMode: false, debug: 'off', panes: { ...defaultPanes }, sidebarOpen: true }
    try {
      const stored = localStorage.getItem(SETTINGS_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        // migrate boolean → DebugLayout
        if (parsed.debug === true) parsed.debug = 'debug'
        else if (parsed.debug === false) parsed.debug = 'off'
        return { ...defaults, ...parsed, panes: { ...defaultPanes, ...parsed.panes } }
      }
    } catch {}
    return defaults
  }

  function saveSettings(s: Settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  }

  let settings = loadSettings()

  function updateSettings(patch: Partial<Settings>) {
    Object.assign(settings, patch)
    saveSettings(settings)
  }

  let fileIndex = loadIndex()

  function fileEntries(): { key: string, entry: FileEntry }[] {
    return Object.entries(fileIndex)
      .map(([key, entry]) => ({ key, entry }))
      .sort((a, b) => b.entry.updatedAt - a.entry.updatedAt)
  }

  function loadText(key: string): string {
    return localStorage.getItem(STORAGE_PREFIX + key) ?? ''
  }

  function saveText(key: string, text: string) {
    const stored = localStorage.getItem(STORAGE_PREFIX + key)
    const existed = fileIndex[key] !== undefined
    const unchanged = existed && stored === text
    if (unchanged) {
      if (settings.active !== key) updateSettings({ active: key })
      return
    }
    localStorage.setItem(STORAGE_PREFIX + key, text)
    const now = Date.now()
    if (existed) {
      fileIndex[key].updatedAt = now
    } else {
      fileIndex[key] = { createdAt: now, updatedAt: now }
    }
    saveIndex(fileIndex)
    entries = fileEntries()
    if (settings.active !== key) updateSettings({ active: key })
  }

  function deleteText(key: string) {
    localStorage.removeItem(STORAGE_PREFIX + key)
    delete fileIndex[key]
    saveIndex(fileIndex)
    if (settings.active === key) {
      updateSettings({ active: '' })
    }
  }

  function renameFile(key: string, newTitle: string) {
    const entry = fileIndex[key]
    if (!entry) return
    const trimmed = newTitle.trim()
    entry.title = trimmed || undefined
    entry.updatedAt = Date.now()
    saveIndex(fileIndex)
    entries = fileEntries()
  }

  const PENDING_DELETE_MS = 5000
  let pendingDeletes = $state(new Map<string, { timer: ReturnType<typeof setTimeout> }>())
  let pendingDeleteKeys = $derived(new Set(pendingDeletes.keys()))

  function startPendingDelete(key: string) {
    if (pendingDeletes.has(key)) return
    const timer = setTimeout(() => confirmPendingDelete(key), PENDING_DELETE_MS)
    pendingDeletes.set(key, { timer })
    pendingDeletes = new Map(pendingDeletes)
  }

  function undoPendingDelete(key: string) {
    const entry = pendingDeletes.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    pendingDeletes.delete(key)
    pendingDeletes = new Map(pendingDeletes)
  }

  function confirmPendingDelete(key: string) {
    if (!pendingDeletes.has(key)) return
    pendingDeletes.delete(key)
    pendingDeletes = new Map(pendingDeletes)
    const wasActive = activeKey === key
    deleteText(key)
    entries = fileEntries()
    if (wasActive) {
      const next = entries.find(e => !pendingDeletes.has(e.key))
      if (next) {
        switchTo(next.key)
      } else {
        activeKey = ''
        input = ''
        updateSettings({ active: '' })
        setEditorContent('')
        rawStatements = ''
        analyzerJson = ''
        parsedLines = []
        analysisSeats = []
        analysisColumns = []
        analysisError = ''
        assumptions = new Map()
      }
    }
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen
    updateSettings({ sidebarOpen })
  }

  let entries = $state(fileEntries())
  let activeKey = $state(settings.active)
  let sidebarOpen = $state(settings.sidebarOpen)
  const overlayChannel = new BroadcastChannel('horkew-overlay')
  let obsRoom: string | null = $state(null)
  let obsSocket: WebSocket | null = $state(null)
  let obsConnected = $state(false)
  let obsSettingsOpen = $state(false)
  type ObsCanvas = 'hd' | 'fhd'
  type ObsAlign = 'top' | 'bottom' | 'left' | 'right'
  let obsCanvas: ObsCanvas = $state('hd')
  let obsAlign: ObsAlign = $state('bottom')
  let obsBannerHeight: number = $state(100)
  let obsStripWidth: number = $state(320)
  type ObsCols = 1 | 2
  let obsCols: ObsCols = $state(1)
  let obsBgOpacity: number = $state(100)
  type AppTheme = 'dark' | 'light'
  let appTheme: AppTheme = $state('dark')
  let obsTheme: AppTheme = $state('dark')

  const OBS_SETTINGS_KEY = 'horkew-obs-settings'
  const APP_THEME_KEY = 'horkew-theme'
  const OBS_ROOM_KEY = 'horkew-obs-room'
  const OBS_RECONNECT_PROBE_MS = 2000

  function saveObsRoomKey(room: string | null) {
    try {
      if (room === null) localStorage.removeItem(OBS_ROOM_KEY)
      else localStorage.setItem(OBS_ROOM_KEY, room)
    } catch {
      // ignore
    }
  }

  function loadObsRoomKey(): string | null {
    try {
      return localStorage.getItem(OBS_ROOM_KEY)
    } catch {
      return null
    }
  }

  function loadObsSettings() {
    try {
      const raw = localStorage.getItem(OBS_SETTINGS_KEY)
      if (!raw) return
      const s = JSON.parse(raw)
      if (s.canvas === 'hd' || s.canvas === 'fhd') obsCanvas = s.canvas
      if (s.align === 'top' || s.align === 'bottom' || s.align === 'left' || s.align === 'right') obsAlign = s.align
      if (Number.isFinite(s.banner) && s.banner > 0) obsBannerHeight = Math.round(s.banner)
      if (Number.isFinite(s.strip) && s.strip > 0) obsStripWidth = Math.round(s.strip)
      if (s.cols === 1 || s.cols === 2) obsCols = s.cols
      if (Number.isFinite(s.bg) && s.bg >= 0 && s.bg <= 100) obsBgOpacity = Math.round(s.bg)
      if (s.theme === 'dark' || s.theme === 'light') obsTheme = s.theme
    } catch {
      // ignore
    }
  }

  function saveObsSettings() {
    try {
      localStorage.setItem(OBS_SETTINGS_KEY, JSON.stringify({
        canvas: obsCanvas,
        align: obsAlign,
        banner: obsBannerHeight,
        strip: obsStripWidth,
        cols: obsCols,
        bg: obsBgOpacity,
        theme: obsTheme,
      }))
    } catch {
      // ignore
    }
  }

  function loadAppTheme() {
    try {
      const raw = localStorage.getItem(APP_THEME_KEY)
      if (raw === 'dark' || raw === 'light') appTheme = raw
    } catch {
      // ignore
    }
  }

  function setAppTheme(next: AppTheme) {
    appTheme = next
    try { localStorage.setItem(APP_THEME_KEY, next) } catch { /* ignore */ }
  }

  $effect(() => {
    document.documentElement.dataset.theme = appTheme
  })

  function generateRoomCode(): string {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => chars[b % chars.length]).join('')
  }

  function obsPartyHost(): string {
    return import.meta.env.DEV ? 'localhost:1999' : 'horkew-relay.ekeke.partykit.dev'
  }

  function overlayUrl(room: string): string {
    const base = import.meta.env.DEV
      ? `http://localhost:5375/horkew/overlay.html`
      : `${window.location.origin}/horkew/overlay.html`
    const params = new URLSearchParams({
      room,
      canvas: obsCanvas,
      align: obsAlign,
      banner: String(obsBannerHeight),
      strip: String(obsStripWidth),
      cols: String(obsCols),
      bg: String(obsBgOpacity),
      theme: obsTheme,
    })
    return `${base}?${params.toString()}`
  }

  function toggleObs() {
    if (obsSocket) {
      obsSocket.close()
      obsSocket = null
      obsRoom = null
      obsConnected = false
      saveObsRoomKey(null)
      return
    }
    const room = generateRoomCode()
    obsRoom = room
    saveObsRoomKey(room)
    const protocol = import.meta.env.DEV ? 'ws' : 'wss'
    const ws = new WebSocket(`${protocol}://${obsPartyHost()}/party/${room}`)
    ws.onopen = () => {
      obsConnected = true
      if (input) ws.send(input)
    }
    ws.onclose = () => { obsConnected = false }
    ws.onerror = () => { obsConnected = false }
    obsSocket = ws
    navigator.clipboard.writeText(overlayUrl(room))
  }

  async function tryAutoReconnectObs() {
    const saved = loadObsRoomKey()
    if (!saved) return

    const protocol = import.meta.env.DEV ? 'ws' : 'wss'
    const ws = new WebSocket(`${protocol}://${obsPartyHost()}/party/${saved}`)

    const result = await new Promise<'has-content' | 'empty'>((resolve) => {
      let settled = false
      const done = (r: 'has-content' | 'empty') => {
        if (settled) return
        settled = true
        resolve(r)
      }
      const timer = setTimeout(() => done('empty'), OBS_RECONNECT_PROBE_MS)
      ws.addEventListener('message', () => { clearTimeout(timer); done('has-content') }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); done('empty') }, { once: true })
      ws.addEventListener('close', () => { clearTimeout(timer); done('empty') }, { once: true })
    })

    if (result === 'empty') {
      try { ws.close() } catch { /* ignore */ }
      saveObsRoomKey(null)
      return
    }

    obsRoom = saved
    obsConnected = ws.readyState === WebSocket.OPEN
    ws.onmessage = null
    ws.onclose = () => { obsConnected = false }
    ws.onerror = () => { obsConnected = false }
    obsSocket = ws
    if (input && ws.readyState === WebSocket.OPEN) ws.send(input)
  }

  function copyObsUrl() {
    if (obsRoom) navigator.clipboard.writeText(overlayUrl(obsRoom))
  }

  function setObsCanvas(next: ObsCanvas) {
    obsCanvas = next
    saveObsSettings()
  }

  function setObsAlign(next: ObsAlign) {
    obsAlign = next
    saveObsSettings()
  }

  function setObsBannerHeight(next: number) {
    if (!Number.isFinite(next) || next <= 0) return
    obsBannerHeight = Math.round(next)
    saveObsSettings()
  }

  function setObsStripWidth(next: number) {
    if (!Number.isFinite(next) || next <= 0) return
    obsStripWidth = Math.round(next)
    saveObsSettings()
  }

  function setObsCols(next: ObsCols) {
    obsCols = next
    saveObsSettings()
  }

  function setObsBgOpacity(next: number) {
    if (!Number.isFinite(next)) return
    obsBgOpacity = Math.max(0, Math.min(100, Math.round(next)))
    saveObsSettings()
  }

  function setObsTheme(next: AppTheme) {
    obsTheme = next
    saveObsSettings()
  }

  let input = $state(activeKey ? loadText(activeKey) : '')
  let isActivePendingDelete = $derived(!!activeKey && pendingDeletes.has(activeKey))
  let rawStatements = $state('')
  let analyzerJson = $state('')
  let parsedLines: StringifiedLine[] = $state([])
  let statementLines: number[] = []
  let analysisSeats: SeatResult[] = $state([])
  let analysisColumns: SystemRole[] = $state([])
  let analysisError = $state('')
  let analyzing = $state(false)
  let analysisDuration = $state(0)
  let analysisStatsInfo = $state<AnalysisStats | null>(null)
  let analysisCached = $state(false)
  let analysisTotalElapsed = $state(0)
  let analysisStart = 0
  let survivorInfo = $state({ alive: 0, total: 0 })
  let deadSeats: Set<number> = $state(new Set())
  let nightKilledSeats: Set<number> = $state(new Set())
  let executedSeats: Set<number> = $state(new Set())
  let players: Map<number, string> = $state(new Map())
  let playerShortNames: Map<number, string> = $state(new Map())
  let villageStatus: VillageStatus | null = $state(null)
  let currentEvents: import('../src/lupa/types.ts').GameEvent[] = $state([])
  let sourceLines: SourceLines = $state({ survivor: new Map(), claimRow: new Map(), claimCell: new Map(), kill: new Map(), exec: new Map(), vote: new Map() })
  let cursorLine = $state(0)
  let claimShortNames: Map<number, string> = $derived(
    villageStatus
      ? new Map([...villageStatus.statuses.entries()]
          .filter(([, s]) => s.claiming)
          .map(([seat, s]) => [seat, systemRoles.get(s.claimingRole as SystemRole)?.shortName ?? s.claimingRole] as const))
      : new Map()
  )
  let assumptions: Map<number, SystemRole> = $state(new Map())
  let hocusPocusSeats: Set<number> = $state(new Set())
  let forceTs = $state(false)
  let denyWolfGroups: number[][] = $state([])
  let showDenyWolfDialog = $state(false)
  let denyWolfSelection: Set<number> = $state(new Set())
  let gmorkResult = $state('')
  let wolfPairSuggestions: WolfPairSuggestion[] = $state([])
  let baseAnalysisSeats: SeatResult[] = []
  let pendingGmorkEntry: { seat: number, role: SystemRole } | null = null

  // lykaon Phase 7 Stage A: demo state ↔ ctx の一時ブリッジ (Stage B/C で解消予定)
  const ctx = createAnalysisContext()
  onDestroy(() => ctx.destroy())

  $effect(() => { if (ctx.howlText !== input) ctx.howlText = input })
  $effect(() => { if (ctx.cursorLine !== cursorLine) ctx.cursorLine = cursorLine })
  $effect(() => { ctx.assumptions = assumptions })
  $effect(() => { ctx.hocusPocusSeats = hocusPocusSeats })
  $effect(() => { ctx.denyWolfGroups = denyWolfGroups })
  $effect(() => { ctx.forceTs = forceTs })

  $effect(() => {
    const text = ctx.howlText
    if (text !== input) {
      input = text
      setEditorContent(text)
    }
  })

  $effect(() => {
    const unsub = ctx.onJump((ev) => {
      if (!editorView) return
      const docLine = editorView.state.doc.line(ev.line)
      editorView.dispatch({
        selection: { anchor: docLine.from },
        scrollIntoView: true,
      })
      editorView.focus()
    })
    return unsub
  })

  let allRolesDetermined = $derived(
    analysisSeats.length > 0
    && players.size > 0
    && analysisSeats.length === players.size
    && analysisSeats.every(s => s.roles.length === 1)
  )
  // Retar結果キャッシュ: 行番号 → {hash, cached}
  let analysisCache = new Map<number, { hash: string, cached: SeatResult[], stats: AnalysisStats | null }>()

  function computeAnalysisHash(text: string, line: number, assumptionsMap: Map<number, SystemRole>): { key: number, hash: string } {
    // カーソル位置で巻いたテキスト（空行・末尾空白・コメント行を除去）+ assumptions のハッシュ
    const rawLines = text.split('\n').slice(0, line)
    let h = 0x811c9dc5 // FNV-1a offset basis
    let effectiveLines = 0
    for (const raw of rawLines) {
      const trimmed = raw.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      effectiveLines++
      for (let i = 0; i < trimmed.length; i++) {
        h ^= trimmed.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
      // 行区切りをハッシュに混ぜる
      h ^= 0x0a
      h = Math.imul(h, 0x01000193)
    }
    // assumptions をハッシュに混ぜる
    for (const [seat, role] of assumptionsMap) {
      h ^= seat * 31 + role.length
      h = Math.imul(h, 0x01000193)
    }
    // wolfPairDenyals をハッシュに混ぜる
    for (const group of denyWolfGroups) {
      for (const seat of group) {
        h ^= seat * 37
        h = Math.imul(h, 0x01000193)
      }
    }
    // hocusPocus をハッシュに混ぜる
    for (const seat of hocusPocusSeats) {
      h ^= seat * 41
      h = Math.imul(h, 0x01000193)
    }
    // forceTs をハッシュに混ぜる（WASM/TS で結果が異なる可能性があるためキャッシュ分離）
    if (forceTs) {
      h ^= 0x5a5a5a5a
      h = Math.imul(h, 0x01000193)
    }
    return { key: effectiveLines, hash: (h >>> 0).toString(36) }
  }
  let currentSetup: Map<SystemRole, number> = $state(new Map())
  let skin: Skin = $state(settings.skin)
  let devMode = $state(settings.devMode)
  let debugMode: DebugLayout = $state(settings.debug)
  let paneVisible: Record<PaneId, boolean> = $state(settings.panes)
  let showPaneMenu = $state(false)
  let showModal = $state(false)
  let showHelp = $state(false)
  let newTitle = $state('')
  let editorParent: HTMLElement | undefined = $state()
  let editorView: EditorView | undefined = $state()
  let rawBodyEl: HTMLElement | undefined = $state()
  let helpPanel: HelpPanel | undefined = $state()
  let trialMode = $state(false)

  // --- Video sync ---
  type VideoType = 'youtube' | 'nico' | ''
  let videoId = $state('')
  let videoType: VideoType = $state('')
  let youtubePlayer: YouTubePlayer | undefined = $state()
  let nicoPlayer: NicoPlayer | undefined = $state()
  let videoSegments: { videoId: string, videoType: VideoType, url: string, line: number, timestamps: { line: number, seconds: number }[] }[] = $state([])
  let activeSegmentIdx = $state(0)
  let videoAutoplay = $state(false)
  let videoCurrentTime = $state(0)
  let videoSyncActive = $state(false)
  let videoDay = $state(1)
  let dayLineMap: Map<number, number> = $state(new Map())  // day → first line number
  let videoInitialized = $state(false)  // true after first parse of current document
  let autoTimestampEnabled = $state(true)
  // Live note mode: record videoCurrentTime when a line transitions blank→non-blank,
  // then append @MM:SS at line end when Enter finalizes it (if statement type qualifies).
  let autoTimestampStartTime: number | null = null
  let autoTimestampLine: number | null = null

  const AUTO_TIMESTAMP_TYPES = new Set(['assert', 'vote', 'lynch', 'attack', 'peace'])
  const EXISTING_TIMESTAMP_RE = /@\d+:\d\d/

  function resetVideoState() {
    videoId = ''
    videoType = ''
    videoSegments = []
    activeSegmentIdx = 0
    videoAutoplay = false
    videoCurrentTime = 0
    videoSyncActive = false
    videoDay = 1
    videoInitialized = false
    autoTimestampStartTime = null
    autoTimestampLine = null
  }
  let maxDay = $state(1)

  function extractYouTubeId(url: string): string {
    const m = url.match(/(?:youtu\.be\/|v=|\/embed\/)([A-Za-z0-9_-]{11})/)
    return m?.[1] ?? ''
  }

  function extractNicoId(url: string): string {
    const m = url.match(/(?:nicovideo\.jp\/watch\/|embed\.nicovideo\.jp\/watch\/)((?:sm|so|nm)\d+)/)
    return m?.[1] ?? ''
  }

  function parseVideoUrl(url: string): { type: VideoType, id: string } {
    const ytId = extractYouTubeId(url)
    if (ytId) return { type: 'youtube', id: ytId }
    const nicoId = extractNicoId(url)
    if (nicoId) return { type: 'nico', id: nicoId }
    return { type: '', id: '' }
  }

  function buildDayLineMap(statements: any[]): Map<number, number> {
    const map = new Map<number, number>()
    for (const s of statements) {
      if (s.day !== undefined && !map.has(s.day)) {
        map.set(s.day, s.line)
      }
    }
    return map
  }

  // Build video segments: each @URL starts a new segment with its own timestamps
  function buildVideoSegments(statements: any[]): typeof videoSegments {
    const segments: typeof videoSegments = []
    let current: typeof videoSegments[number] | null = null
    for (const s of statements) {
      if (s.type === 'videoSource') {
        const parsed = parseVideoUrl(s.url)
        current = { videoId: parsed.id, videoType: parsed.type, url: s.url, line: s.line, timestamps: [] }
        segments.push(current)
      } else if (current) {
        if (s.type === 'timestamp') current.timestamps.push({ line: s.line, seconds: s.seconds })
        else if (s.timestamp !== undefined) current.timestamps.push({ line: s.line, seconds: s.timestamp })
      }
    }
    for (const seg of segments) seg.timestamps.sort((a, b) => a.seconds - b.seconds)
    return segments
  }

  function formatSeconds(s: number): string {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  function insertTimeAnnotation() {
    if (!editorView || !videoId) return
    const time = formatSeconds(videoCurrentTime)
    const pos = editorView.state.selection.main.head
    const line = editorView.state.doc.lineAt(pos)
    const lineContent = line.text.trim()
    let text: string
    let from: number
    if (lineContent.length > 0) {
      // Inline: append @MM:SS at end of current line
      text = ` @${time}`
      from = line.to
    } else {
      // Standalone: insert @MM:SS on blank line
      text = `@${time}\n`
      from = line.from
    }
    editorView.dispatch({
      changes: { from, insert: text },
      selection: { anchor: from + text.length },
    })
    input = editorView.state.doc.toString()
    run()
  }

  function getVideoCursorLine(): number {
    const seg = videoSegments[activeSegmentIdx]
    if (!seg || seg.timestamps.length === 0) return 999999
    const ts = seg.timestamps

    // Find the last timestamp that has been reached
    let matchedIdx = -1
    for (let i = 0; i < ts.length; i++) {
      if (videoCurrentTime >= ts[i].seconds + 3) matchedIdx = i
      else break
    }
    if (matchedIdx < 0) return ts[0].line - 1

    // Show up to the line before the NEXT timestamp, or end of this segment
    const nextIdx = matchedIdx + 1
    const nextSeg = videoSegments[activeSegmentIdx + 1]
    const segEndLine = nextSeg ? nextSeg.line - 1 : 999999
    const endLine = nextIdx < ts.length
      ? ts[nextIdx].line - 1
      : segEndLine

    // Update videoDay from dayLineMap
    const matchedLine = ts[matchedIdx].line
    let day = 1
    for (const [d, dayLine] of dayLineMap) {
      if (dayLine <= matchedLine) day = d
    }
    videoDay = day
    return endLine
  }

  function goToDay(day: number) {
    videoDay = day
    // Show up to the end of this day
    const nextDay = day + 1
    if (dayLineMap.has(nextDay)) {
      cursorLine = dayLineMap.get(nextDay)! - 1
    } else {
      cursorLine = 999999
    }
    videoSyncActive = false  // Disable auto-sync when manually navigating
    runWithCursor(cursorLine)
  }

  function resumeVideoSync() {
    videoSyncActive = true
  }

  let videoFullscreen = $state(false)

  function toggleVideoFullscreen() {
    videoFullscreen = !videoFullscreen
  }

  function onFullscreenKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') videoFullscreen = false
  }

  async function seekVideo(seconds: number, line?: number) {
    // Find which segment this line belongs to and switch if needed
    let videoChanged = false
    if (line !== undefined) {
      for (let i = videoSegments.length - 1; i >= 0; i--) {
        if (videoSegments[i].line <= line) {
          if (i !== activeSegmentIdx) {
            switchToSegment(i)
            videoChanged = true
          }
          break
        }
      }
    }
    if (videoChanged) await tick()  // wait for Player $effect to set ready=false
    if (videoType === 'youtube') youtubePlayer?.seekTo(seconds)
    else if (videoType === 'nico') nicoPlayer?.seekTo(seconds)
    videoCurrentTime = seconds
    videoSyncActive = true
    runWithCursor(getVideoCursorLine())
  }

  setOnSeek(seekVideo)

  function doOpenHelp(sectionId?: string) {
    showHelp = true
    if (sectionId) {
      tick().then(() => helpPanel?.scrollToId(sectionId))
    }
  }

  onMount(() => {
    onOpenHelp(doOpenHelp)
    onStartTrial(handleStartTrial)
    const hash = location.hash.slice(1)
    if (hash.startsWith('help-')) doOpenHelp(hash)
    if (!activeKey) handleStartTrial(TUTORIAL_TEXT)
    loadObsSettings()
    loadAppTheme()
    tryAutoReconnectObs()
  })

  $effect(() => {
    if (activeKey && input !== undefined && !trialMode) {
      saveText(activeKey, input)
    }
  })

  let copyCompressedStatus: 'idle' | 'done' | 'error' = $state('idle')
  let copyCompressedTimer: ReturnType<typeof setTimeout> | undefined
  let docMenuOpen = $state(false)

  async function copyCompressed() {
    if (!editorView) return
    try {
      const body = editorView.state.doc.toString()
      const entry = activeKey ? fileIndex[activeKey] : undefined
      const existing = parseFrontmatter(body)
      const meta = { ...existing.meta }
      if (entry && !meta.title) meta.title = displayName(entry)
      const text = buildFrontmatter(meta, existing.body)
      const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
      const buf = await new Response(stream).arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      const b64 = btoa(binary)
      await navigator.clipboard.writeText(b64)
      copyCompressedStatus = 'done'
    } catch {
      copyCompressedStatus = 'error'
    }
    if (copyCompressedTimer) clearTimeout(copyCompressedTimer)
    copyCompressedTimer = setTimeout(() => { copyCompressedStatus = 'idle' }, 1500)
  }

  function importCompressedText(title: string, body: string) {
    if (trialMode) trialMode = false
    const now = Date.now()
    const baseKey = title.trim() || ('_' + now.toString(36))
    let key = baseKey
    let n = 1
    while (fileIndex[key]) {
      key = `${baseKey}_${n++}`
    }
    fileIndex[key] = { title: title || undefined, createdAt: now, updatedAt: now }
    saveIndex(fileIndex)
    activeKey = key
    input = body
    saveText(key, body)
    entries = fileEntries()
    updateSettings({ active: key })
    setEditorContent(body)
    rawStatements = ''
    analyzerJson = ''
    parsedLines = []
    analysisSeats = []
    analysisColumns = []
    analysisError = ''
    assumptions = new Map()
  }

  function setEditorContent(text: string) {
    if (editorView) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: text },
        selection: { anchor: text.length },
      })
      editorView.focus()
    }
  }

  async function generateLupaGame() {
    const roles = new Map<SystemRole, number>([
      ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1],
      ['bodyguard', 1], ['mason', 2], ['nekomata', 1],
      ['possessed', 1], ['werehamster', 1], ['immoralist', 1],
    ])
    const seed = Date.now()
    const handlers = agentAdapter({
      defaultAgent: new RuleBasedAgent(),
      wolfTeamAgent: new WolfTeamRuleAgent(),
      masonTeamAgent: new MasonTeamRuleAgent(),
      enableRetar: false,
      seed,
      roles,
    })
    const { events, state } = await runGame({ roles, seed }, handlers)
    const howl = formatHowl(events, state, { roles, seed } as any)
    if (trialMode || !activeKey) {
      handleStartTrial(howl)
    } else {
      setEditorContent(howl)
    }
  }

  function handleStartTrial(text: string) {
    trialMode = true
    resetVideoState()
    input = text
    setEditorContent(text)
    showHelp = false
  }

  function exitTrialMode() {
    trialMode = false
    if (activeKey) {
      input = loadText(activeKey)
      setEditorContent(input)
    }
  }

  function switchTo(key: string) {
    if (trialMode) trialMode = false
    resetVideoState()
    activeKey = key
    input = loadText(key)
    setEditorContent(input)
    updateSettings({ active: key })
    rawStatements = ''
    parsedLines = []
    analysisSeats = []
    analysisColumns = []
    analysisError = ''
    assumptions = new Map()
  }

  const defaultNames = [
    'あるふぁ', 'ぶらぼー', 'ちゃーりー', 'でるた', 'えこー',
    'ふぉっくす', 'ごるふ', 'ほてる', 'いんでぃあ', 'じゅりえっと',
    'きろ', 'りま', 'まいく', 'のべんばー', 'おすかー',
    'ぱぱ', 'きゅーべっく',
  ]

  interface Preset {
    label: string
    setup: string
    count: number
    firstDayKill?: boolean
  }

  const presets: Preset[] = [
    { label: '17A', setup: '村6 占1 霊1 狩1 共2 狼4 狂1 狐1', count: 17, firstDayKill: true },
    { label: '14D猫', setup: '村2 占1 霊1 狩1 共2 猫1 狼3 信1 狐1 背1', count: 14, firstDayKill: true },
    { label: '13人村', setup: '村6 占1 霊1 狩1 狼3 狂1', count: 13 },
  ]

  function buildTemplate(title: string, preset: Preset): string {
    const names = defaultNames.slice(0, preset.count)
    const joins = names.map(n => `+${n}`).join('\n')
    const kill = preset.firstDayKill ? `\n${names[0]}死亡\n` : ''
    return `配役 ${preset.setup}\n\n${joins}${kill}\n`
  }

  function openNewModal() {
    newTitle = ''
    showModal = true
  }

  function createFromPreset(preset: Preset) {
    if (trialMode) trialMode = false
    const trimmed = newTitle.trim()
    const key = trimmed || ('_' + Date.now().toString(36))
    const now = Date.now()
    const template = buildTemplate(trimmed, preset)
    fileIndex[key] = { title: trimmed || undefined, createdAt: now, updatedAt: now }
    saveIndex(fileIndex)
    activeKey = key
    input = template
    setEditorContent(input)
    saveText(key, template)
    entries = fileEntries()
    showModal = false
    rawStatements = ''
    analyzerJson = ''
    parsedLines = []
    analysisSeats = []
    analysisColumns = []
    analysisError = ''
    assumptions = new Map()
  }

  function cancelNew() {
    showModal = false
  }

  function togglePane(id: PaneId) {
    paneVisible[id] = !paneVisible[id]
    updateSettings({ panes: paneVisible })
  }

  const DEV_TAP_COUNT = 7
  const DEV_TAP_WINDOW = 3000
  let devTaps: number[] = []
  let titleFlash = $state(false)

  function onTitleTap() {
    const now = Date.now()
    devTaps = devTaps.filter(t => now - t < DEV_TAP_WINDOW)
    devTaps.push(now)
    if (devTaps.length >= DEV_TAP_COUNT) {
      devTaps = []
      devMode = !devMode
      if (!devMode) debugMode = 'off'
      updateSettings({ devMode, debug: debugMode })
      titleFlash = true
      setTimeout(() => titleFlash = false, 600)
    }
  }

  function onModalKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') cancelNew()
  }

  function getCursorLine(): number {
    if (!editorView) return 1
    const head = editorView.state.selection.main.head
    return editorView.state.doc.lineAt(head).number
  }

  function scrollRawToCursor() {
    if (!rawBodyEl || statementLines.length === 0) return
    const cursorLine = getCursorLine()

    // Find the last statement whose source line <= cursor line
    let stmtIndex = 0
    for (let i = 0; i < statementLines.length; i++) {
      if (statementLines[i] <= cursorLine) stmtIndex = i
      else break
    }

    // Find the JSON line of the stmtIndex-th top-level object
    // In JSON.stringify(arr, null, 2), top-level objects start with "  {" after a newline
    const jsonLines = rawStatements.split('\n')
    let count = -1
    let jsonLine = 0
    for (let i = 0; i < jsonLines.length; i++) {
      if (jsonLines[i].trimStart().startsWith('{') && jsonLines[i].startsWith('  {')) {
        count++
        if (count === stmtIndex) {
          jsonLine = i
          break
        }
      }
    }

    const pre = rawBodyEl.querySelector('pre')
    if (!pre) return
    const lineHeight = parseFloat(getComputedStyle(pre).lineHeight) || 19.5
    rawBodyEl.scrollTop = jsonLine * lineHeight
  }

  let runningWithCursor = false

  function onCursorMove() {
    if (runningWithCursor) return  // prevent re-entrant calls from editor dispatch
    if (videoSyncActive) {
      videoSyncActive = false
    }
    run()
    tick().then(scrollRawToCursor)
  }

  // ============================================================
  // Command Play 連動: ゲーム進行を formatHowl でエディタに書き出し
  // ============================================================
  let cmdPlayRunning = $state(false)
  let cmdPlayEditorText = $state('')
  let cmdPlayWasRunning = false  // running 立ち上がり検出用

  onMount(() => {
    const unsub = commandPlayStore.subscribe(s => {
      cmdPlayRunning = s.running
      cmdPlayEditorText = s.editorText
    })
    return unsub
  })

  // running 立ち上がりで trial モードへ（保存ドキュメントを守る）
  // running 立ち下がりでも trial のまま（結果を読める状態を保つ）
  $effect(() => {
    if (cmdPlayRunning && !cmdPlayWasRunning) {
      // 保存ドキュメントを壊さないために即 trial モードへ
      if (!trialMode) {
        trialMode = true
        resetVideoState()
        input = cmdPlayEditorText || ''
        setEditorContent(input)
        showHelp = false
      }
    }
    cmdPlayWasRunning = cmdPlayRunning
  })

  // 実行中 editorText 変化 → エディタに書き込み、カーソルを末尾へ
  $effect(() => {
    if (!editorView) return
    if (!cmdPlayRunning) return
    if (!cmdPlayEditorText) return
    const current = editorView.state.doc.toString()
    if (current === cmdPlayEditorText) return
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: cmdPlayEditorText },
      selection: { anchor: cmdPlayEditorText.length },
      scrollIntoView: true,
    })
  })

  // エディタの編集可否: cmd-play 実行中 / 動画同期中 / アクティブファイル削除保留中 のいずれかで read-only
  $effect(() => {
    if (!editorView || !editorModule) return
    const editable = !cmdPlayRunning && !videoSyncActive && !isActivePendingDelete
    editorModule.setEditable(editorView, editable)
  })

  // Initialize CM6 editor when parent element is available (lazy-loaded)
  // Only depends on editorParent (DOM availability via {#if activeKey} block).
  // activeKey and editorView are intentionally NOT dependencies to avoid
  // destroy/recreate loops on document switch.
  $effect(() => {
    if (!editorParent) return
    import('../src/lykaon/editor/index.ts').then(mod => {
      editorModule = mod
      if (!editorParent || editorView) return
      mod.setVideoTimeGetter(() => videoId ? videoCurrentTime : null)
      editorView = mod.createHowlEditor(editorParent, {
        doc: input,
        onChange(value) {
          input = value
        },
        onCursorChange(_line) {
          onCursorMove()
        },
        extensions: [
          mod.EditorView.domEventHandlers({
            paste(event, view) {
              const clip = event.clipboardData?.getData('text')
              if (!clip) return false
              const sel = view.state.selection.main
              const fullSelection = sel.from === 0 && sel.to === view.state.doc.length
              if (!fullSelection) return false
              const trimmed = clip.trim()
              if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return false
              let binary: string
              try { binary = atob(trimmed) } catch { return false }
              if (binary.length < 2 || binary.charCodeAt(0) !== 0x1f || binary.charCodeAt(1) !== 0x8b) return false
              event.preventDefault()
              const bytes = new Uint8Array(binary.length)
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
              const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
              new Response(stream).text().then(text => {
                const fm = parseFrontmatter(text)
                const title = typeof fm.meta.title === 'string' ? fm.meta.title : ''
                if (title) {
                  importCompressedText(title, fm.body)
                } else {
                  view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: text },
                    selection: { anchor: text.length },
                  })
                }
              }).catch(() => {})
              return true
            },
          }),
          mod.EditorView.updateListener.of(update => {
            if (!update.docChanged) return

            // Detect newline insertion — identifies which line was just finalized.
            let finalizedLineNumber: number | null = null
            update.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
              if (finalizedLineNumber !== null) return
              if (!inserted.toString().includes('\n')) return
              finalizedLineNumber = update.startState.doc.lineAt(fromA).number
            })

            if (
              autoTimestampEnabled &&
              finalizedLineNumber !== null &&
              autoTimestampLine === finalizedLineNumber &&
              autoTimestampStartTime !== null &&
              videoId
            ) {
              const line = update.state.doc.line(finalizedLineNumber)
              const text = line.text
              if (!EXISTING_TIMESTAMP_RE.test(text)) {
                const stmt = parseStatement(text, finalizedLineNumber)
                if (AUTO_TIMESTAMP_TYPES.has(stmt.type)) {
                  const timeStr = formatSeconds(autoTimestampStartTime)
                  const insertPos = line.to
                  const view = update.view
                  queueMicrotask(() => {
                    view.dispatch({
                      changes: { from: insertPos, insert: ` @${timeStr}` },
                    })
                  })
                }
              }
            }

            if (finalizedLineNumber !== null) {
              autoTimestampStartTime = null
              autoTimestampLine = null
            }

            // Record start time on blank→non-blank transition of the cursor's line.
            const head = update.state.selection.main.head
            const currentLine = update.state.doc.lineAt(head)
            const isNonBlank = currentLine.text.trim() !== ''
            if (isNonBlank && autoTimestampLine !== currentLine.number) {
              autoTimestampStartTime = videoCurrentTime
              autoTimestampLine = currentLine.number
            } else if (!isNonBlank && autoTimestampLine === currentLine.number) {
              autoTimestampStartTime = null
              autoTimestampLine = null
            }
          }),
        ],
      })
    })
    return () => {
      if (editorView) {
        editorView.destroy()
        editorView = undefined
      }
    }
  })

  function roleToShort(role: SystemRole): string {
    return systemRoles.get(role)?.shortName ?? role
  }

  type NameStatus = 'default' | 'not-village' | 'village' | 'wolf' | 'fox'

  function classifyPlayer(roles: SystemRole[]): { status: NameStatus, fixed: boolean, label: string } {
    if (roles.length === 0) return { status: 'default', fixed: false, label: '?' }
    const fixed = roles.length === 1
    const label = fixed ? (systemRoles.get(roles[0])?.shortName ?? '?') : '?'
    const alignments = new Set(roles.map(r => systemRoles.get(r)!.alignment))
    if (alignments.size === 1) {
      const a = [...alignments][0]
      if (a === 'villager') return { status: 'village', fixed, label }
      if (a === 'werewolf') return { status: 'wolf', fixed, label }
      if (a === 'werehamster') return { status: 'fox', fixed, label }
    }
    if (!alignments.has('villager')) return { status: 'not-village', fixed: false, label }
    return { status: 'default', fixed: false, label }
  }

  const GMORK_DEBUG = true

  function runGmork(): string {
    if (!devMode) return ''
    if (assumptions.size !== 1 || !villageStatus) return ''
    const [[seat, role]] = [...assumptions]
    const possibilities = new Map(baseAnalysisSeats.map(s => [s.seat, new Set(s.roles)]))
    const playerName = players.get(seat) ?? `席${seat}`
    const roleName = systemRoles.get(role)?.name ?? role

    // 確定済み役職をトグルした場合は確定理由を表示
    const possibleRoles = possibilities.get(seat)
    if (possibleRoles && possibleRoles.size === 1 && possibleRoles.has(role)) {
      const confirmObj = findConfirmationReason(villageStatus, currentSetup, seat, role, players, possibilities)
      const confirmText = confirmObj ? formatConfirmationReason(confirmObj, role) : 'わかりません'
      let debugKey = ''
      if (GMORK_DEBUG && confirmObj) {
        debugKey = ` [${confirmObj.type}]`
      }
      return `「${playerName}」が「${roleName}」に確定した理由： ${confirmText}${debugKey}`
    }

    // 未確定プレイヤーの可能性がある役職をトグルした場合は何もしない
    if (possibleRoles && possibleRoles.has(role)) {
      return ''
    }

    const reasonObj = findReason(villageStatus, currentSetup, seat, role, possibilities, players)
    const reasonText = reasonObj ? formatReason(reasonObj, role) : 'わかりません'
    let debugKey = ''
    if (GMORK_DEBUG && reasonObj) {
      const inner = 'bustReason' in reasonObj ? (reasonObj as any).bustReason.type : null
      debugKey = inner ? ` [${reasonObj.type} > ${inner}]` : ` [${reasonObj.type}]`
    }
    return `「${playerName}」が「${roleName}」ではありえない理由： ${reasonText}${debugKey}`
  }

  function toggleAssumption(seat: number, role: SystemRole) {
    const current = assumptions.get(seat)
    if (current === role) {
      assumptions.delete(seat)
    } else {
      assumptions.set(seat, role)
    }
    assumptions = new Map(assumptions)
    // baseAnalysisSeats(assumption未適用)でgmorkを計算
    gmorkResult = runGmork()
    run()
  }

  function clearAssumptions() {
    assumptions = new Map()
    denyWolfGroups = []
    hocusPocusSeats = new Set()
    gmorkResult = ''
    run()
  }

  function toggleHocusPocus(seat: number) {
    if (hocusPocusSeats.has(seat)) {
      hocusPocusSeats.delete(seat)
    } else {
      hocusPocusSeats.add(seat)
    }
    hocusPocusSeats = new Set(hocusPocusSeats)
    run()
  }

  function buildRevealText(): string {
    const lines = analysisSeats.map(s => {
      const name = players.get(s.seat) ?? `#${s.seat}`
      const roleName = systemRoles.get(s.roles[0])?.name ?? s.roles[0]
      return `${name}=${roleName}`
    })
    return '\n' + lines.join('\n')
  }

  function insertRevealRoles() {
    if (!editorView || !allRolesDetermined) return
    const text = buildRevealText()
    const docLen = editorView.state.doc.length
    editorView.dispatch({
      changes: { from: docLen, insert: text },
      selection: { anchor: docLen + text.length },
    })
    editorView.focus()
  }

  function openDenyWolfDialog() {
    denyWolfSelection = new Set()
    showDenyWolfDialog = true
  }

  function closeDenyWolfDialog() {
    showDenyWolfDialog = false
  }

  function toggleDenyWolfPlayer(seat: number) {
    const next = new Set(denyWolfSelection)
    if (next.has(seat)) {
      next.delete(seat)
    } else {
      if (next.size >= 2) return
      next.add(seat)
    }
    denyWolfSelection = next
  }

  function confirmDenyWolf() {
    if (denyWolfSelection.size < 2) return
    const group = [...denyWolfSelection].sort((a, b) => a - b)
    // 重複チェック
    const isDuplicate = denyWolfGroups.some(g =>
      g.length === group.length && g.every((s, i) => s === group[i])
    )
    if (!isDuplicate) {
      denyWolfGroups = [...denyWolfGroups, group]
    }
    showDenyWolfDialog = false
    run()
  }

  function removeDenyWolfGroup(index: number) {
    denyWolfGroups = denyWolfGroups.filter((_, i) => i !== index)
    run()
  }

  function addSuggestion(suggestion: WolfPairSuggestion) {
    const group = [suggestion.seatA, suggestion.seatB]
    denyWolfGroups = [...denyWolfGroups, group]
    // 即座にUIから除外し、run()後にRetar結果で再計算される
    wolfPairSuggestions = wolfPairSuggestions.filter(s =>
      !(s.seatA === suggestion.seatA && s.seatB === suggestion.seatB)
    )
    run()
  }

  function extractRefNames(stmt: any): string[] {
    switch (stmt.type) {
      case 'vote': return [stmt.voter, stmt.target]
      case 'multiVote': return [...stmt.voters, stmt.target]
      case 'attack': return [...stmt.target]
      case 'lynch': return stmt.target ? [stmt.target] : []
      case 'curse': case 'follow': return [stmt.target]
      case 'revote': return stmt.targets ?? []
      case 'assert': {
        const names = [stmt.actor]
        for (const a of stmt.assertions ?? []) {
          if (a.target) names.push(a.target)
        }
        return names
      }
      case 'mason': return stmt.players ?? []
      case 'reveal': return [stmt.player]
      default: return []
    }
  }

  function extractDefNames(stmt: any): string[] {
    switch (stmt.type) {
      case 'join': return [stmt.name, ...(stmt.shortName ? [stmt.shortName] : []), ...stmt.aliases]
      case 'joinMulti': return stmt.players ?? []
      default: return []
    }
  }

  type NameEntry = { name: string, kind: 'definition' | 'resolved' | 'unresolved' }

  function buildPlayerNames(statements: any[], dict: FlexibleDictionary, doc: string): PlayerNameInfo[] {
    const lines = doc.split('\n')
    const result: PlayerNameInfo[] = []
    for (const stmt of statements) {
      const entries: NameEntry[] = []
      for (const name of extractDefNames(stmt)) {
        if (name) entries.push({ name, kind: 'definition' })
      }
      for (const name of extractRefNames(stmt)) {
        if (name) entries.push({ name, kind: dict.search(name).length > 0 ? 'resolved' : 'unresolved' })
      }
      if (entries.length === 0) continue
      const lineIdx = stmt.line - 1
      if (lineIdx < 0 || lineIdx >= lines.length) continue
      const lineText = lines[lineIdx]
      const used: [number, number][] = []
      for (const { name, kind } of entries) {
        let searchFrom = 0
        let idx = -1
        while ((idx = lineText.indexOf(name, searchFrom)) !== -1) {
          const end = idx + name.length
          if (!used.some(([f, t]) => idx < t && end > f)) {
            used.push([idx, end])
            result.push({ line: stmt.line, offset: idx, length: name.length, kind })
            break
          }
          searchFrom = idx + 1
        }
      }
    }
    return result
  }

  function buildSourceLines(statements: any[], dict: FlexibleDictionary): SourceLines {
    const survivor = new Map<number, number>()
    const claimRow = new Map<number, number>()
    const claimCell = new Map<string, number>()
    const kill = new Map<number, number>()
    const exec = new Map<number, number>()
    const vote = new Map<number, number>()

    function resolve(name: string): number {
      const res = dict.search(name)
      return res.length > 0 ? Number(res[0]) : -1
    }

    for (const stmt of statements) {
      const line = stmt.line as number
      switch (stmt.type) {
        case 'join':
          survivor.set(resolve(stmt.name), line)
          break
        case 'joinMulti':
          for (const name of stmt.players) survivor.set(resolve(name), line)
          break
        case 'vote':
          vote.set(resolve(stmt.voter), line)
          break
        case 'multiVote':
          for (const name of stmt.voters) vote.set(resolve(name), line)
          break
        case 'attack':
          kill.set((stmt.day ?? 1) - 1, line)
          break
        case 'peace':
          kill.set((stmt.day ?? 1) - 1, line)
          break
        case 'lynch':
          exec.set(stmt.day, line)
          break
        case 'curse':
        case 'follow':
          kill.set((stmt.day ?? 1) - 1, line)
          break
        case 'assert': {
          const seat = resolve(stmt.actor)
          claimRow.set(seat, line)
          // Compute which nights this assert populates (right-aligned, same as bridge)
          const day = stmt.day ?? 1
          const lastNight = day - 1
          const divResults = (stmt.assertions ?? []).filter((a: any) => a.target && a.result)
          for (let i = 0; i < divResults.length; i++) {
            const night = lastNight - (divResults.length - 1 - i)
            claimCell.set(`${seat}:${night}`, line)
          }
          const guardTargets = (stmt.assertions ?? []).filter((a: any) => a.action === 'guard')
          for (let i = 0; i < guardTargets.length; i++) {
            const night = lastNight - (guardTargets.length - 1 - i)
            claimCell.set(`${seat}:${night}`, line)
          }
          break
        }
        case 'mason':
          for (const name of stmt.players) claimRow.set(resolve(name), line)
          break
      }
    }

    return { survivor, claimRow, claimCell, kill, exec, vote }
  }

  function runWithCursor(overrideCursorLine?: number) {
    runningWithCursor = true
    try { runWithCursorInner(overrideCursorLine) }
    finally { runningWithCursor = false }
  }

  function runWithCursorInner(overrideCursorLine?: number) {
    const runStart = performance.now()
    analysisSeats = []
    analysisError = ''
    if (assumptions.size === 0) gmorkResult = ''
    rawStatements = ''
    analyzerJson = ''
    parsedLines = []
    sourceLines = { survivor: new Map(), claimRow: new Map(), claimCell: new Map(), kill: new Map(), exec: new Map(), vote: new Map() }

    const effectiveCursorLine = overrideCursorLine ?? getCursorLine()

    try {
      // First parse without cursor filter to build dayLineMap
      const fullParse = parse(input)
      const fullMeta = fullParse.meta

      // Deprecation warnings for old frontmatter fields
      if (fullMeta.video) console.warn('[horkew] frontmatter "video:" is deprecated. Use @URL annotation instead.')
      if (fullMeta.timestamps) console.warn('[horkew] frontmatter "timestamps:" is deprecated. Use @MM:SS annotations instead.')

      // Build video segments from @URL + @MM:SS annotations
      videoSegments = buildVideoSegments(fullParse.statements)
      const activeSeg = videoSegments[activeSegmentIdx]
      const activeId = activeSeg?.videoId ?? ''
      const activeType: VideoType = activeSeg?.videoType ?? ''
      if (activeId !== videoId || activeType !== videoType) {
        videoId = activeId
        videoType = activeType
        videoSyncActive = !!activeId
      }
      // First parse of a new document: autoplay if video annotations present
      if (!videoInitialized && videoSegments.length > 0) {
        videoAutoplay = true
        videoSyncActive = true
      }
      videoInitialized = true

      // Build day→line map
      dayLineMap = buildDayLineMap(fullParse.statements)
      maxDay = Math.max(1, ...dayLineMap.keys())

      const { meta, statements } = parse(input, { cursorLine: effectiveCursorLine })
      rawStatements = JSON.stringify(statements, null, 2)
      parsedLines = stringifyStatements(statements)
      statementLines = statements.map((s: any) => s.line as number)

      const { vs, setup, players: playersMap, shortNames: shortNamesMap, dict } = buildVillageStatus(statements, meta)
      sourceLines = buildSourceLines(statements, dict)
      currentEvents = statementsToPublicEvents(statements, dict).map(de => de.event)

      // Feed parse results to CM6 for syntax highlighting (after buildVillageStatus so dict is available)
      if (editorView) {
        const toStmtInfo = (s: any): StatementInfo => {
          const info: StatementInfo = { type: s.type, line: s.line }
          if (s.type === 'videoSource') info.timestamp = { seconds: 0, raw: '0:00' }
          else if (s.type === 'timestamp') info.timestamp = { seconds: s.seconds, raw: s.raw }
          else if (s.timestamp !== undefined) {
            const m = Math.floor(s.timestamp / 60)
            const sec = s.timestamp % 60
            info.timestamp = { seconds: s.timestamp, raw: `${m}:${String(sec).padStart(2, '0')}` }
          }
          return info
        }
        const stmtInfo: StatementInfo[] = statements.map(toStmtInfo)
        const allStmtInfo: StatementInfo[] = fullParse.statements.map(toStmtInfo)
        const playerNameInfos = buildPlayerNames(statements, dict, editorView.state.doc.toString())
        const playerList: { name: string, shortName?: string, aliases: string[], surviving: boolean, claimingRole?: string }[] = []
        let seat = 1
        for (const s of statements) {
          if (s.type === 'join') {
            const status = vs.statuses.get(seat)
            const surviving = status?.surviving ?? true
            const claimingRole = status?.claiming ? status.claimingRole : undefined
            playerList.push({ name: s.name, shortName: s.shortName, aliases: s.aliases, surviving, claimingRole })
            seat++
          } else if (s.type === 'joinMulti') {
            for (const p of s.players) {
              const status = vs.statuses.get(seat)
              const surviving = status?.surviving ?? true
              const claimingRole = status?.claiming ? status.claimingRole : undefined
              playerList.push({ name: p, aliases: [], surviving, claimingRole })
              seat++
            }
          }
        }
        editorView.dispatch({ effects: [
          editorModule!.setStatements.of({ statements: stmtInfo, allStatements: allStmtInfo, cursorLine: effectiveCursorLine, playerNames: playerNameInfos }),
          editorModule!.setPlayerList.of(playerList),
          editorModule!.setSetup.of(setup),
          editorModule!.setCurrentDay.of(vs.day),
          editorModule!.setGameStats.of({ day: vs.day, executions: vs.executions.size }),
        ] })
      }
      cursorLine = effectiveCursorLine
      players = playersMap
      playerShortNames = shortNamesMap
      villageStatus = vs
      currentSetup = setup
      overlayChannel.postMessage({ type: 'howl', text: input, cursorLine: effectiveCursorLine })
      if (obsSocket?.readyState === WebSocket.OPEN) obsSocket.send(input)
      const alive = [...vs.statuses.values()].filter(s => s.surviving).length
      survivorInfo = { alive, total: vs.statuses.size }
      deadSeats = new Set([...vs.statuses.entries()].filter(([, s]) => !s.surviving).map(([seat]) => seat))
      nightKilledSeats = new Set(
        [...vs.statuses.entries()]
          .filter(([, s]) => !s.surviving && s.causeOfDeath && nightKillCauses.has(s.causeOfDeath))
          .map(([seat]) => seat)
      )
      const executionCauses: Set<CauseOfDeath> = new Set([
        'execution', 'cursed_by_executed_nekomata', 'follow_executed_hamster',
      ])
      executedSeats = new Set(
        [...vs.statuses.entries()]
          .filter(([, s]) => !s.surviving && s.causeOfDeath && executionCauses.has(s.causeOfDeath))
          .map(([seat]) => seat)
      )

      const roleOrder = [...systemRoles.keys()] as SystemRole[]
      analysisColumns = roleOrder.filter(r => setup.has(r as SystemRole))

      const vsJson = JSON.stringify(serializeVillageStatus(vs))
      const setupJson = JSON.stringify(Object.fromEntries(setup))
      const workerPayload = {
        vsJson,
        setupJson,
        players: [...playersMap],
        assumptions: [...assumptions],
        wolfPairDenyals: denyWolfGroups.map(g => [g[0], g[1]] as [number, number]),
        hocusPocus: [...hocusPocusSeats],
        forceTs,
      }
      analyzerJson = JSON.stringify({ vs: JSON.parse(vsJson), setup: JSON.parse(setupJson) }, null, 2)

      // 突然死を含む盤面は Retar が対応していないため解析をスキップ
      const hasSuddenDeath = [...vs.statuses.values()].some(s => !s.surviving && s.causeOfDeath === 'sudden_death')
      if (hasSuddenDeath) {
        analysisSeats = []
        analysisError = '突然死を含む盤面は解析できません'
        analysisStatsInfo = null
        analysisCached = false
        analysisTotalElapsed = Math.round(performance.now() - runStart)
        gmorkResult = ''
        analyzing = false
        return
      }

      // キャッシュチェック: 同じ行で同じテキスト+assumptionsならRetar再計算をスキップ
      const { key: cacheKey, hash: cacheHash } = computeAnalysisHash(input, cursorLine, assumptions)
      const cached = analysisCache.get(cacheKey)
      if (cached && cached.hash === cacheHash) {
        analysisSeats = cached.cached
        analysisError = ''
        analysisStatsInfo = cached.stats
        analysisCached = true
        analysisTotalElapsed = Math.round(performance.now() - runStart)
        if (assumptions.size === 0) baseAnalysisSeats = cached.cached
        if (pendingGmorkEntry && assumptions.size === 0) {
          const pe = pendingGmorkEntry
          pendingGmorkEntry = null
          assumptions = new Map([[pe.seat, pe.role]])
          gmorkResult = runGmork()
        }
        analyzing = false
        return
      }

      analyzing = true
      analysisCached = false
      analysisStart = performance.now()
      requestAnalysis(workerPayload, (data) => {
        analyzing = false
        analysisDuration = Math.round(performance.now() - analysisStart)
        analysisTotalElapsed = Math.round(performance.now() - runStart)
        if (data.type === 'result') {
          analysisSeats = data.seats
          analysisError = ''
          analysisStatsInfo = data.stats
          if (assumptions.size === 0) baseAnalysisSeats = data.seats
          // Gmork Debug ペインからの pending entry を処理
          if (pendingGmorkEntry && assumptions.size === 0) {
            const pe = pendingGmorkEntry
            pendingGmorkEntry = null
            assumptions = new Map([[pe.seat, pe.role]])
            gmorkResult = runGmork()
          }
          // Retar結果から狼候補を抽出し提案を更新
          const wolfCandidates = new Set(data.seats.filter(s => s.roles.includes('werewolf')).map(s => s.seat))
          if (villageStatus && (currentSetup.get('werewolf') ?? 0) >= 2) {
            wolfPairSuggestions = scoreWolfPairs(villageStatus, players, denyWolfGroups, wolfCandidates)
          }
          // キャッシュに保存
          analysisCache.set(cacheKey, { hash: cacheHash, cached: data.seats, stats: data.stats })
        } else {
          analysisSeats = []
          analysisError = data.message
          analysisStatsInfo = null
          gmorkResult = ''
        }
      })
    } catch (e: any) {
      analysisSeats = []
      analysisError = e.message
      villageStatus = null
    }
  }

  function activeTimestamps(): { line: number, seconds: number }[] {
    return videoSegments[activeSegmentIdx]?.timestamps ?? []
  }

  function switchToSegment(idx: number) {
    if (idx < 0 || idx >= videoSegments.length) return
    activeSegmentIdx = idx
    const seg = videoSegments[idx]
    if (seg.videoId !== videoId || seg.videoType !== videoType) {
      videoAutoplay = true
      videoId = seg.videoId
      videoType = seg.videoType
    }
  }

  function onVideoEnded() {
    if (!videoSyncActive) return
    if (activeSegmentIdx + 1 >= videoSegments.length) return
    switchToSegment(activeSegmentIdx + 1)
    videoCurrentTime = 0
    const nextLine = videoSegments[activeSegmentIdx].line
    lastVideoCursorLine = nextLine
    runWithCursor(nextLine)
  }

  function run() {
    // When video sync is active, always use video-derived cursor line
    if (videoSyncActive && activeTimestamps().length > 0) {
      runWithCursor(getVideoCursorLine())
    } else {
      runWithCursor()
    }
  }

  // Video sync: when currentTime changes, update cursorLine from timestamps
  let lastVideoCursorLine = -1
  $effect(() => {
    if (!videoSyncActive || videoSegments.length === 0) return
    const _time = videoCurrentTime  // track dependency
    const seg = videoSegments[activeSegmentIdx]
    if (!seg || seg.timestamps.length === 0) return

    const newCursorLine = getVideoCursorLine()
    if (newCursorLine !== lastVideoCursorLine) {
      lastVideoCursorLine = newCursorLine
      runWithCursor(newCursorLine)
    }
  })
</script>

<div class="layout skin-{skin}">
  <header class="header">
    <button
      class="header-btn sidebar-toggle"
      class:sidebar-toggle-open={sidebarOpen}
      onclick={toggleSidebar}
      title={sidebarOpen ? 'サイドバーを閉じる' : 'サイドバーを開く'}
      aria-label="サイドバー切替"
    >
      <svg class="sidebar-toggle-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 6 L15 12 L9 18" />
      </svg>
    </button>

    <span class="header-subtitle">人狼メモ・解析ツール</span>
    <span class="header-title" class:title-flash={titleFlash} onclick={onTitleTap}>Horkew</span>

    {#if trialMode}
      <span class="trial-banner">お試しモード</span>
      {#if activeKey}<button class="header-btn trial-exit" onclick={exitTrialMode}>戻る</button>{/if}
    {:else if activeKey && fileIndex[activeKey]}
      <span class="header-active-file" title={displayName(fileIndex[activeKey])}>{displayName(fileIndex[activeKey])}</span>
    {/if}
    {#if activeKey || trialMode}
      <div class="doc-actions-cluster">
        <button
          class="doc-actions-trigger"
          onclick={() => docMenuOpen = !docMenuOpen}
          title="ドキュメント操作"
          aria-label="ドキュメント操作"
          aria-expanded={docMenuOpen}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 9 L12 15 L18 9" />
          </svg>
        </button>
        {#if docMenuOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="doc-actions-backdrop" onclick={() => docMenuOpen = false}></div>
          <div class="doc-actions-menu" role="menu">
            <button
              class="doc-actions-item"
              onclick={() => { copyCompressed(); docMenuOpen = false }}
              title="エディタ内容を gzip+Base64 でクリップボードにコピー"
            >{#if copyCompressedStatus === 'done'}コピー済み{:else if copyCompressedStatus === 'error'}失敗{:else}圧縮コピー{/if}</button>
            <button
              class="doc-actions-item"
              onclick={() => { obsSettingsOpen = true; docMenuOpen = false }}
            >OBS 設定…{obsRoom ? (obsConnected ? ' ●' : ' …') : ''}</button>
          </div>
        {/if}
      </div>
    {/if}

    <div class="header-spacer"></div>

    {#if devMode}
    <button class="header-btn" onclick={generateLupaGame} title="Lupaでランダムゲームを生成">Lupa</button>

    <select class="header-select skin-select" value={skin} onchange={(e) => { skin = (e.target as HTMLSelectElement).value as Skin; updateSettings({ skin }) }}>
      <option value="flat">Flat</option>
      <option value="excite">Excite</option>
    </select>

    {#if debugMode === 'debug'}
    <div class="pane-menu-wrap">
      <button class="header-btn" onclick={() => showPaneMenu = !showPaneMenu}>Panes</button>
      {#if showPaneMenu}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="pane-menu-backdrop" onclick={() => showPaneMenu = false}></div>
        <div class="pane-menu">
          {#each paneEntries as { id, label }}
            <label class="pane-menu-item">
              <input type="checkbox" checked={paneVisible[id]} onchange={() => togglePane(id)} />
              {label}
            </label>
          {/each}
        </div>
      {/if}
    </div>
    {/if}

    <button
      class="header-btn debug-btn"
      class:debug-on={debugMode === 'debug'}
      class:debug-fenrir={debugMode === 'fenrir'}
      onclick={() => { debugMode = debugRotation[(debugRotation.indexOf(debugMode) + 1) % debugRotation.length]; updateSettings({ debug: debugMode }) }}
    >{{ off: 'DEBUG OFF', debug: 'DEBUG', fenrir: 'FENRIR' }[debugMode]}</button>
    {/if}

    <button
      class="header-btn theme-btn"
      onclick={() => setAppTheme(appTheme === 'dark' ? 'light' : 'dark')}
      title="アプリのテーマを切り替え"
      aria-label="テーマ切替"
    >{appTheme === 'dark' ? 'Dark' : 'Light'}</button>

    {#if obsSettingsOpen}
        <div
          class="obs-settings-backdrop"
          onclick={() => obsSettingsOpen = false}
          role="button"
          tabindex="-1"
          aria-label="設定を閉じる"
          onkeydown={(e) => { if (e.key === 'Escape') obsSettingsOpen = false }}
        ></div>
        <div class="obs-settings-popover" role="dialog" aria-label="OBS連携・表示設定">
          <header class="obs-dialog-header">
            <h2>OBS 連携・表示設定</h2>
            <button class="obs-dialog-close" onclick={() => obsSettingsOpen = false} aria-label="閉じる">×</button>
          </header>
          <div class="obs-dialog-body">
          <div class="obs-settings-section">
            <div class="obs-settings-label">連携</div>
            {#if obsRoom}
              <div class="obs-connection-info">
                <span class="obs-conn-status" class:obs-conn-active={obsConnected}>{obsConnected ? '接続中' : '接続待ち…'}</span>
                <span class="obs-conn-room">room: {obsRoom}</span>
              </div>
              <div class="obs-connection-actions">
                <button class="obs-action-btn obs-action-primary" onclick={copyObsUrl}>URL をコピー</button>
                <button class="obs-action-btn" onclick={toggleObs}>停止</button>
              </div>
            {:else}
              <button class="obs-action-btn obs-action-primary" onclick={toggleObs}>OBS 連携を開始</button>
            {/if}
          </div>
          <div class="obs-settings-section">
            <div class="obs-settings-label">キャンバス</div>
            <div class="obs-segmented">
              <button class="obs-segment" class:active={obsCanvas === 'hd'} onclick={() => setObsCanvas('hd')}>HD 1280×720</button>
              <button class="obs-segment" class:active={obsCanvas === 'fhd'} onclick={() => setObsCanvas('fhd')}>FHD 1920×1080</button>
            </div>
          </div>
          <div class="obs-settings-section">
            <div class="obs-settings-label">配置</div>
            <div class="obs-align-pad">
              <button class="obs-pad-btn obs-pad-top" class:active={obsAlign === 'top'} onclick={() => setObsAlign('top')} aria-label="上寄せ">↑</button>
              <button class="obs-pad-btn obs-pad-left" class:active={obsAlign === 'left'} onclick={() => setObsAlign('left')} aria-label="左寄せ">←</button>
              <button class="obs-pad-btn obs-pad-right" class:active={obsAlign === 'right'} onclick={() => setObsAlign('right')} aria-label="右寄せ">→</button>
              <button class="obs-pad-btn obs-pad-bottom" class:active={obsAlign === 'bottom'} onclick={() => setObsAlign('bottom')} aria-label="下寄せ">↓</button>
            </div>
          </div>
          <div class="obs-settings-section">
            <div class="obs-settings-label">カラム数</div>
            <div class="obs-segmented">
              <button class="obs-segment" class:active={obsCols === 1} onclick={() => setObsCols(1)}>1 カラム</button>
              <button class="obs-segment" class:active={obsCols === 2} onclick={() => setObsCols(2)}>2 カラム</button>
            </div>
          </div>
          <div class="obs-settings-section">
            <div class="obs-settings-label">バーの厚み</div>
            <div class="obs-size-inputs">
              <label class="obs-size-label" class:dim={obsAlign === 'left' || obsAlign === 'right'}>
                <span>横バー高さ</span>
                <input
                  type="number"
                  min="20"
                  max="1080"
                  step="10"
                  value={obsBannerHeight}
                  onchange={(e) => setObsBannerHeight(Number(e.currentTarget.value))}
                />
                <span class="obs-size-unit">px</span>
              </label>
              <label class="obs-size-label" class:dim={obsAlign === 'top' || obsAlign === 'bottom'}>
                <span>縦バー幅</span>
                <input
                  type="number"
                  min="40"
                  max="1920"
                  step="10"
                  value={obsStripWidth}
                  onchange={(e) => setObsStripWidth(Number(e.currentTarget.value))}
                />
                <span class="obs-size-unit">px</span>
              </label>
            </div>
          </div>
          <div class="obs-settings-section">
            <div class="obs-settings-label">背景の不透明度 <span class="obs-range-value">{obsBgOpacity}%</span></div>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={obsBgOpacity}
              oninput={(e) => setObsBgOpacity(Number(e.currentTarget.value))}
              class="obs-range"
            />
          </div>
          <div class="obs-settings-section">
            <div class="obs-settings-label">オーバーレイのテーマ</div>
            <div class="obs-segmented">
              <button class="obs-segment" class:active={obsTheme === 'dark'} onclick={() => setObsTheme('dark')}>Dark</button>
              <button class="obs-segment" class:active={obsTheme === 'light'} onclick={() => setObsTheme('light')}>Light</button>
            </div>
          </div>
          </div>
        </div>
      {/if}
    <button class="header-btn help-btn" onclick={() => showHelp = true} title="Howl記法ヘルプ">?</button>
  </header>

  {#snippet inputPane()}
    <section class="pane">
      <div class="pane-header">Input</div>
      <div class="pane-body pane-body-input">
        {#if activeKey || trialMode}
          <div class="input-editor" bind:this={editorParent}></div>
          {#if isActivePendingDelete}
            <div class="pending-delete-overlay">
              <div class="pending-delete-banner">
                <span>削除保留中</span>
                <button class="pending-delete-undo" onclick={() => activeKey && undoPendingDelete(activeKey)}>取り消す</button>
              </div>
            </div>
          {/if}
        {:else}
          <div class="pane-placeholder"><span>新規作成ボタンから開始してください</span></div>
        {/if}
      </div>
    </section>
  {/snippet}

  {#snippet statusPane()}
    <section class="pane">
      <div class="pane-header">Status</div>
      <div class="pane-body">
        {#if villageStatus}
          <StatusPane {ctx} />
        {/if}
      </div>
    </section>
  {/snippet}

  {#snippet analysisPane()}
    <section class="pane">
      <div class="pane-header">Analysis</div>
      <div class="pane-body">
        {#if analysisError}
          <pre class="output">Error: {analysisError}</pre>
        {/if}
        {#if analysisColumns.length > 0 && players.size > 0}
          {@const currentMap = new Map(analysisSeats.map(s => [s.seat, s.roles]))}
          <div class="analysis-layout">
            <div class="analysis-table-wrap">
              <table class="analysis-table">
                <tbody>
                  {#each [...players] as [seat, name]}
                    {@const cls = classifyPlayer(currentMap.get(seat) ?? [])}
                    <tr class={deadSeats.has(seat) ? 'dead-row' : ''}>
                      <td class="analysis-name-col {cls.status}" class:role-fixed={cls.fixed}><span class="analysis-label">{cls.label}</span><PlayerName dead={deadSeats.has(seat)} nightKill={nightKilledSeats.has(seat)} executed={executedSeats.has(seat)} claim={claimShortNames.get(seat)}>{playerShortNames.get(seat) ?? name}</PlayerName></td>
                      {#each analysisColumns as role}
                        <td
                          class="{(currentMap.get(seat) ?? []).includes(role) ? 'role-possible' : 'role-impossible'}{assumptions.get(seat) === role ? ' role-assumed' : ''}"
                          onclick={() => toggleAssumption(seat, role)}
                        >{roleToShort(role)}</td>
                      {/each}
                      <td class="hocuspocus-spacer"></td>
                      <td
                        class="hocuspocus-cell{hocusPocusSeats.has(seat) ? ' hocuspocus-on' : ''}"
                        title="HocusPocus: この席のCOを無視して解析"
                        onclick={() => toggleHocusPocus(seat)}
                      >?</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if analysisCached}
                <div class="analysis-duration">total {analysisTotalElapsed}ms (cached) — retar {analysisDuration}ms{#if analysisStatsInfo} ({analysisStatsInfo.workers}w, wall {analysisStatsInfo.wallClock}ms, worker {analysisStatsInfo.minElapsed}-{analysisStatsInfo.maxElapsed}ms, {analysisStatsInfo.wasm ? 'WASM' : 'JS'}){/if}</div>
              {:else if analysisDuration > 0}
                <div class="analysis-duration">total {analysisTotalElapsed}ms — retar {analysisDuration}ms{#if analysisStatsInfo} ({analysisStatsInfo.workers}w, wall {analysisStatsInfo.wallClock}ms, worker {analysisStatsInfo.minElapsed}-{analysisStatsInfo.maxElapsed}ms, {analysisStatsInfo.wasm ? 'WASM' : 'JS'}){/if}</div>
              {/if}
              {#if devMode}
                <div class="analysis-dev-bar">
                  <label class="dev-toggle" title="WASM を無効化して TypeScript 版 Retar を強制使用（デバッグ用）">
                    <input type="checkbox" bind:checked={forceTs} />
                    <span>強制TSモード</span>
                  </label>
                </div>
              {/if}
            </div>
            <div class="analysis-sidebar">
              <div class="assumptions-list">
                <div class="assumptions-header">
                  仮説
                  {#if (currentSetup.get('werewolf') ?? 0) >= 2}
                    <button class="assumption-add" onclick={openDenyWolfDialog}>追加</button>
                  {/if}
                  {#if assumptions.size > 0 || denyWolfGroups.length > 0 || hocusPocusSeats.size > 0}
                    <button class="assumption-clear" onclick={() => clearAssumptions()}>全削除</button>
                  {/if}
                </div>
                {#if allRolesDetermined}
                  <div class="determined-banner">
                    <span class="determined-label">配役確定</span>
                    <button class="determined-insert" onclick={insertRevealRoles}>挿入</button>
                  </div>
                {/if}
                {#each [...assumptions] as [seat, role]}
                  <div class="assumption-item">
                    <span class="assumption-text">{playerShortNames.get(seat) ?? players.get(seat) ?? `#${seat}`}は{systemRoles.get(role)?.name ?? role}である</span>
                    <button class="assumption-remove" onclick={() => toggleAssumption(seat, role)}>&times;</button>
                  </div>
                {/each}
                {#each denyWolfGroups as group, i}
                  <div class="assumption-item">
                    <span class="assumption-text deny-wolf">{group.map(s => playerShortNames.get(s) ?? players.get(s) ?? `#${s}`).join(' と ')} は両狼でない</span>
                    <button class="assumption-remove" onclick={() => removeDenyWolfGroup(i)}>&times;</button>
                  </div>
                {/each}
                {#if wolfPairSuggestions.length > 0}
                  <div class="suggestions-section">
                    <div class="suggestions-label">提案</div>
                    {#each wolfPairSuggestions as suggestion}
                      <button class="suggestion-item" onclick={() => addSuggestion(suggestion)}>
                        「{playerShortNames.get(suggestion.seatA) ?? players.get(suggestion.seatA) ?? `#${suggestion.seatA}`}と{playerShortNames.get(suggestion.seatB) ?? players.get(suggestion.seatB) ?? `#${suggestion.seatB}`}の両狼はない」仮説を追加する
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              {#if gmorkResult}
                <div class="gmork-results">{gmorkResult}</div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </section>
  {/snippet}

  <div class="body-row">
    <FileSidebar
      open={sidebarOpen}
      entries={entries}
      activeKey={activeKey}
      pendingKeys={pendingDeleteKeys}
      trialMode={trialMode}
      onSelect={switchTo}
      onRename={renameFile}
      onDelete={startPendingDelete}
      onUndoDelete={undoPendingDelete}
      onCreateNew={openNewModal}
      onStartTrial={() => handleStartTrial(TUTORIAL_TEXT)}
      {formatDate}
      {displayName}
    />
    <div class="body-main">

  {#if debugMode === 'debug'}
  <div class="panes">
    {#if paneVisible.input}
    {@render inputPane()}
    {/if}

    {#if paneVisible.rawStatements}
    <section class="pane">
      <div class="pane-header">Raw Statements</div>
      <div class="pane-body" bind:this={rawBodyEl}>
        <pre class="output">{rawStatements}</pre>
      </div>
    </section>
    {/if}

    {#if paneVisible.parsed}
    <section class="pane">
      <div class="pane-header">Parsed</div>
      <div class="pane-body">
        <div class="output parsed-output">
          {#each parsedLines as line}
            {#if line.type === 'blank'}
              <div class="parsed-blank">&nbsp;</div>
            {:else if line.type === 'day'}
              <div class="parsed-day">{line.text}</div>
            {:else if line.type === 'unknown'}
              <div class="parsed-unknown">{line.text}</div>
            {:else}
              <div>{line.text}</div>
            {/if}
          {/each}
        </div>
      </div>
    </section>
    {/if}

    {#if paneVisible.combined}
    <section class="pane pane-combined">
      <div class="pane-header">Combined</div>
      <div class="pane-body">
        <div class="prod-right">
          <div class="prod-right-top">
            {@render statusPane()}
          </div>
          <div class="prod-right-bottom">
            {@render analysisPane()}
          </div>
        </div>
      </div>
    </section>
    {/if}

    {#if paneVisible.status}
    {@render statusPane()}
    {/if}

    {#if paneVisible.analyzerInput}
    <section class="pane">
      <div class="pane-header">Analyzer Input</div>
      <div class="pane-body">
        <pre class="output">{analyzerJson}</pre>
      </div>
    </section>
    {/if}

    {#if paneVisible.analysis}
    {@render analysisPane()}
    {/if}

    {#if paneVisible.colorSwatch}
    <section class="pane">
      <div class="pane-header">Color Swatch</div>
      <div class="pane-body">
        <ColorSwatchPane />
      </div>
    </section>
    {/if}

    {#if paneVisible.hati}
    <section class="pane">
      <div class="pane-header">Hati (詰み探索)</div>
      <div class="pane-body">
        <HatiPane {ctx} />
      </div>
    </section>
    {/if}

    {#if paneVisible.skoll}
    <section class="pane">
      <div class="pane-header">Skoll (確率分布)</div>
      <div class="pane-body">
        <SkollPane vs={villageStatus} setup={currentSetup} {players} publicEvents={currentEvents} />
      </div>
    </section>
    {/if}

    {#if paneVisible.gmorkDebug}
    <section class="pane">
      <div class="pane-header">Gmork Debug</div>
      <div class="pane-body">
        <GmorkDebugPane {ctx} />
      </div>
    </section>
    {/if}

    {#if paneVisible.fenrirInspect}
    <section class="pane">
      <div class="pane-header">Fenrir Inspect</div>
      <div class="pane-body">
        <InspectPane {ctx} />
      </div>
    </section>
    {/if}

    {#if paneVisible.pretrainViz}
    <section class="pane">
      <div class="pane-header">Pretrain Viz</div>
      <div class="pane-body">
        <PretrainPane />
      </div>
    </section>
    {/if}

    {#if paneVisible.fenrirStats}
    <section class="pane">
      <div class="pane-header">Fenrir Stats</div>
      <div class="pane-body">
        <StatsPane />
      </div>
    </section>
    {/if}

    {#if paneVisible.commandPlay}
    <section class="pane">
      <div class="pane-header">Command Play</div>
      <div class="pane-body">
        <CommandPlayPane />
      </div>
    </section>
    {/if}
  </div>
  {:else if debugMode === 'fenrir'}
  <div class="panes panes-fenrir">
    <div class="fenrir-left">
      {@render inputPane()}
    </div>
    <div class="fenrir-center">
      <div class="prod-right-top">
        {@render statusPane()}
      </div>
      <div class="prod-right-bottom">
        {@render analysisPane()}
      </div>
    </div>
    <div class="fenrir-right">
      <section class="pane">
        <div class="pane-body">
          <InspectPane {ctx} />
        </div>
      </section>
    </div>
  </div>
  {:else}
  <div class="panes panes-prod" class:has-video={!!videoId}>
    {#if videoId}
    <div class="prod-left prod-video-col" class:hidden-by-fullscreen={videoFullscreen}>
      <div class="video-container">
        {#if videoType === 'youtube'}
          <YouTubePlayer bind:this={youtubePlayer} {videoId} bind:currentTime={videoCurrentTime} autoplay={videoAutoplay} onended={onVideoEnded} />
        {:else if videoType === 'nico'}
          <NicoPlayer bind:this={nicoPlayer} {videoId} bind:currentTime={videoCurrentTime} autoplay={videoAutoplay} onended={onVideoEnded} />
        {/if}
      </div>
      <div class="day-nav">
        <button class="day-nav-btn" disabled={videoDay <= 1} onclick={() => goToDay(videoDay - 1)}>&lt;</button>
        <span class="day-nav-label">{videoDay}日目</span>
        <button class="day-nav-btn" disabled={videoDay >= maxDay} onclick={() => goToDay(videoDay + 1)}>&gt;</button>
        {#if !videoSyncActive}
          <button class="day-nav-sync" onclick={resumeVideoSync}>同期再生</button>
        {:else}
          <button class="day-nav-sync day-nav-sync-active" onclick={() => videoSyncActive = false}>同期再生中</button>
        {/if}
        <span class="day-nav-time">{formatSeconds(videoCurrentTime)}</span>
        <button class="day-nav-btn day-nav-fullscreen" onclick={() => toggleVideoFullscreen()}>全画面</button>
      </div>
      <div class="video-editor-wrap">
        <div class="video-editor-toolbar">
          <button class="mark-time-btn" onclick={insertTimeAnnotation}>いまここ！</button>
          <label class="auto-ts-toggle">
            <input type="checkbox" bind:checked={autoTimestampEnabled} />
            <span>自動タイムスタンプ</span>
          </label>
        </div>
        {@render inputPane()}
      </div>
    </div>
    <div class="prod-right">
      <div class="prod-right-top">
        {@render statusPane()}
      </div>
      <div class="prod-right-bottom">
        {@render analysisPane()}
      </div>
    </div>
    {:else}
    <div class="prod-left">
      {@render inputPane()}
    </div>
    <div class="prod-right">
      <div class="prod-right-top">
        {@render statusPane()}
      </div>
      <div class="prod-right-bottom">
        {@render analysisPane()}
      </div>
    </div>
    {/if}
  </div>
  {/if}

    </div>
  </div>

  {#if videoFullscreen && videoId}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="vf-overlay" onkeydown={onFullscreenKeydown}>
      <div class="vf-toolbar">
        <button class="day-nav-btn" disabled={videoDay <= 1} onclick={() => goToDay(videoDay - 1)}>&lt;</button>
        <span class="day-nav-label">{videoDay}日目</span>
        <button class="day-nav-btn" disabled={videoDay >= maxDay} onclick={() => goToDay(videoDay + 1)}>&gt;</button>
        {#if !videoSyncActive}
          <button class="day-nav-sync" onclick={resumeVideoSync}>同期再生</button>
        {:else}
          <button class="day-nav-sync day-nav-sync-active" onclick={() => videoSyncActive = false}>同期再生中</button>
        {/if}
        <span class="day-nav-time">{formatSeconds(videoCurrentTime)}</span>
        <button class="vf-close" onclick={() => toggleVideoFullscreen()}>&times;</button>
      </div>
      <div class="vf-panels">
        <div class="vf-status">
          {@render statusPane()}
        </div>
        <div class="vf-analysis">
          {@render analysisPane()}
        </div>
      </div>
    </div>
  {/if}
</div>

{#if showModal}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-overlay" onkeydown={onModalKeydown} onclick={cancelNew}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-title">新規作成</div>
      <input
        class="modal-input"
        type="text"
        placeholder="タイトル（省略可）"
        bind:value={newTitle}
        onkeydown={onModalKeydown}
        autofocus
      />
      <div class="modal-hint">配役は後から変更できます</div>
      <div class="modal-presets">
        {#each presets as preset}
          <button class="preset-btn" onclick={() => createFromPreset(preset)}>{preset.label}</button>
        {/each}
      </div>
      <button class="modal-cancel" onclick={cancelNew}>キャンセル</button>
    </div>
  </div>
{/if}

{#if showDenyWolfDialog}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={closeDenyWolfDialog}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal deny-wolf-modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-title">狼同士を否定</div>
      <div class="modal-hint">両狼ではない2人を選択</div>
      <div class="deny-wolf-players">
        {#each [...players] as [seat, name]}
          {@const selected = denyWolfSelection.has(seat)}
          {@const disabled = !selected && denyWolfSelection.size >= 2}
          <button
            class="deny-wolf-player"
            class:selected
            {disabled}
            onclick={() => toggleDenyWolfPlayer(seat)}
          >{playerShortNames.get(seat) ?? name}</button>
        {/each}
      </div>
      <div class="deny-wolf-actions">
        <button class="deny-wolf-confirm" disabled={denyWolfSelection.size < 2} onclick={confirmDenyWolf}>追加</button>
        <button class="modal-cancel" onclick={closeDenyWolfDialog}>キャンセル</button>
      </div>
    </div>
  </div>
{/if}

<HelpPanel bind:this={helpPanel} open={showHelp} onclose={() => { showHelp = false; if (location.hash) history.replaceState(null, '', location.pathname + location.search) }} />

<footer class="site-footer">
  <a class="footer-github" href="https://github.com/ekeke/horkew" target="_blank" rel="noopener noreferrer" title="GitHub">
    <svg viewBox="0 0 98 96" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M41.4395 69.3848C28.8066 67.8535 19.9062 58.7617 19.9062 46.9902C19.9062 42.2051 21.6289 37.0371 24.5 33.5918C23.2559 30.4336 23.4473 23.7344 24.8828 20.959C28.7109 20.4805 33.8789 22.4902 36.9414 25.2656C40.5781 24.1172 44.4062 23.543 49.0957 23.543C53.7852 23.543 57.6133 24.1172 61.0586 25.1699C64.0254 22.4902 69.2891 20.4805 73.1172 20.959C74.457 23.543 74.6484 30.2422 73.4043 33.4961C76.4668 37.1328 78.0937 42.0137 78.0937 46.9902C78.0937 58.7617 69.1934 67.6621 56.3691 69.2891C59.623 71.3945 61.8242 75.9883 61.8242 81.252L61.8242 91.2051C61.8242 94.0762 64.2168 95.7031 67.0879 94.5547C84.4102 87.9512 98 70.6289 98 49.1914C98 22.1074 75.9883 0 48.9043 0C21.8203 0 0 22.1074 0 49.1914C0 70.4375 13.4941 88.0469 31.6777 94.6504C34.2617 95.6074 36.75 93.8848 36.75 91.3008L36.75 83.6445C35.4102 84.2188 33.6875 84.6016 32.1562 84.6016C25.8398 84.6016 22.1074 81.1563 19.4277 74.7441C18.375 72.1602 17.2266 70.6289 15.0254 70.3418C13.877 70.2461 13.4941 69.7676 13.4941 69.1934C13.4941 68.0449 15.4082 67.1836 17.3223 67.1836C20.0977 67.1836 22.4902 68.9063 24.9785 72.4473C26.8926 75.2227 28.9023 76.4668 31.2949 76.4668C33.6875 76.4668 35.2187 75.6055 37.4199 73.4043C39.0469 71.7773 40.291 70.3418 41.4395 69.3848Z"/></svg>
  </a>
  <span class="footer-by">by <a href="https://x.com/ak_pzdr" target="_blank" rel="noopener noreferrer">ekeke</a></span>
</footer>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
    background: var(--color-bg);
    color: var(--color-text);
  }

  :global(#app) {
    height: 100%;
  }

  .layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: system-ui, -apple-system, sans-serif;
  }

  .body-row {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .body-main {
    flex: 1;
    display: flex;
    min-width: 0;
  }

  button.sidebar-toggle {
    margin: 0 0 0 -1rem;
    padding: 0 14px;
    height: 40px;
    font-size: 14px;
    line-height: 1;
    background: transparent;
    border: none;
    border-right: 1px solid var(--color-border);
    border-radius: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .sidebar-toggle-icon {
    transition: transform 200ms ease;
  }

  .sidebar-toggle-open .sidebar-toggle-icon {
    transform: rotate(180deg);
  }

  .sidebar-toggle-open {
    background: var(--color-surface-hover);
    color: var(--color-accent);
  }

  .header-active-file {
    font-size: 12px;
    color: var(--color-text-muted);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 260px;
    padding: 0 6px;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 1rem;
    height: 40px;
    min-height: 40px;
    background: var(--color-bg-elevated);
    border-bottom: 1px solid var(--color-border);
  }

  .header-subtitle {
    font-size: 10px;
    color: var(--color-text-overlay);
    margin-right: 4px;
    user-select: none;
  }

  .header-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--color-accent);
    margin-right: 0.5rem;
    cursor: default;
    user-select: none;
  }

  .header-title.title-flash {
    animation: title-flash 0.6s ease-out;
  }

  @keyframes title-flash {
    0%   { color: var(--color-accent); text-shadow: none; }
    30%  { color: var(--color-text); text-shadow: 0 0 12px var(--color-accent), 0 0 24px var(--color-link); }
    100% { color: var(--color-accent); text-shadow: none; }
  }

  .header-spacer {
    flex: 1;
  }

  .header-select {
    padding: 4px 8px;
    font-size: 12px;
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    min-width: 140px;
  }

  .header-btn {
    padding: 4px 12px;
    font-size: 12px;
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }

  .header-btn:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }

  .header-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .theme-btn {
    font-size: 11px;
    min-width: 48px;
  }

  .doc-actions-cluster {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .doc-actions-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 3px;
    line-height: 1;
  }

  .doc-actions-trigger:hover {
    background: var(--color-surface);
    color: var(--color-text);
  }

  .doc-actions-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
  }

  .doc-actions-menu {
    position: absolute;
    left: 0;
    top: calc(100% + 4px);
    z-index: 11;
    background: var(--color-bg);
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
    padding: 6px 0;
    min-width: 180px;
    box-shadow: 0 4px 12px color-mix(in srgb, black 40%, transparent);
  }

  .doc-actions-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: var(--color-text);
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }

  .doc-actions-item:hover {
    background: var(--color-surface);
  }

  .obs-connection-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 0;
  }

  .obs-conn-status {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .obs-conn-status.obs-conn-active {
    color: var(--ctp-green);
  }

  .obs-conn-room {
    font-size: 10px;
    color: var(--color-text-muted);
    font-family: 'Consolas', 'Menlo', monospace;
  }

  .obs-connection-actions {
    display: flex;
    gap: 4px;
    margin-top: 4px;
  }

  .obs-action-btn {
    flex: 1;
    padding: 5px 10px;
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }

  .obs-action-btn:hover {
    background: var(--color-surface-hover);
  }

  .obs-action-btn.obs-action-primary {
    background: var(--color-accent);
    color: var(--color-bg);
    border-color: var(--color-accent);
    font-weight: 600;
  }

  .obs-action-btn.obs-action-primary:hover {
    filter: brightness(1.1);
  }

  .obs-settings-backdrop {
    position: fixed;
    inset: 0;
    background: var(--color-overlay-backdrop);
    z-index: 199;
    border: 0;
    cursor: default;
  }

  .obs-settings-popover {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, 90vw);
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    background: var(--color-bg-elevated);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    font-size: 13px;
    z-index: 200;
  }

  .obs-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    border-bottom: 1px solid var(--color-border);
  }

  .obs-dialog-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--color-accent);
  }

  .obs-dialog-close {
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 4px;
  }

  .obs-dialog-close:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }

  .obs-dialog-body {
    padding: 16px 18px;
    overflow: auto;
  }

  .obs-range {
    width: 100%;
    accent-color: var(--color-accent);
  }

  .obs-range-value {
    color: var(--color-text);
    font-family: 'Consolas', 'Menlo', monospace;
    margin-left: 6px;
  }

  .obs-settings-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }

  .obs-settings-section:last-child {
    margin-bottom: 0;
  }

  .obs-settings-label {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .obs-segmented {
    display: flex;
    gap: 4px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 3px;
  }

  .obs-segment {
    flex: 1;
    padding: 5px 8px;
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }

  .obs-segment:hover {
    color: var(--color-text);
  }

  .obs-segment.active {
    background: var(--color-surface);
    color: var(--color-text);
  }

  .obs-align-pad {
    display: grid;
    grid-template-columns: 32px 32px 32px;
    grid-template-rows: 32px 32px 32px;
    gap: 3px;
    width: fit-content;
  }

  .obs-pad-btn {
    background: var(--color-surface);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .obs-pad-btn:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }

  .obs-pad-btn.active {
    background: var(--color-accent);
    color: var(--color-bg);
    border-color: var(--color-accent);
  }

  .obs-pad-top { grid-column: 2; grid-row: 1; }
  .obs-pad-left { grid-column: 1; grid-row: 2; }
  .obs-pad-right { grid-column: 3; grid-row: 2; }
  .obs-pad-bottom { grid-column: 2; grid-row: 3; }

  .obs-size-inputs {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .obs-size-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text);
  }

  .obs-size-label.dim {
    opacity: 0.5;
  }

  .obs-size-label > span:first-child {
    flex: 1;
    color: var(--color-text-muted);
  }

  .obs-size-label input {
    width: 60px;
    padding: 3px 5px;
    background: var(--color-bg-sunken);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 11px;
    text-align: right;
  }

  .obs-size-unit {
    color: var(--color-text-muted);
    font-size: 10px;
  }
  .help-btn {
    font-weight: 700;
    font-size: 13px;
    width: 28px;
    padding: 4px 0;
    text-align: center;
  }

  .site-footer {
    position: fixed;
    right: 10px;
    bottom: 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--color-text-overlay);
    z-index: 50;
    pointer-events: auto;
  }

  .footer-by a {
    color: var(--ctp-overlay1);
    text-decoration: none;
    transition: color 0.15s;
  }

  .footer-by a:hover {
    color: var(--color-text);
  }

  .footer-github {
    display: flex;
    align-items: center;
    color: var(--color-text-overlay);
    transition: color 0.15s;
  }

  .footer-github:hover {
    color: var(--color-text);
  }

  .debug-btn {
    font-size: 11px;
    font-weight: 600;
    opacity: 0.5;
  }

  .debug-btn.debug-on {
    opacity: 1;
    background: var(--color-error);
    color: var(--color-bg);
    border-color: var(--color-error);
  }

  .debug-btn.debug-on:hover {
    background: var(--ctp-maroon);
    border-color: var(--ctp-maroon);
  }

  .debug-btn.debug-fenrir {
    opacity: 1;
    background: var(--ctp-mauve);
    color: var(--color-bg);
    border-color: var(--ctp-mauve);
  }

  .debug-btn.debug-fenrir:hover {
    background: var(--ctp-lavender);
    border-color: var(--ctp-lavender);
  }

  .pane-menu-wrap {
    position: relative;
  }

  .pane-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
  }

  .pane-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 11;
    background: var(--color-bg);
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
    padding: 6px 0;
    min-width: 160px;
    box-shadow: 0 4px 12px color-mix(in srgb, black 40%, transparent);
  }

  .pane-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    font-size: 12px;
    color: var(--color-text);
    cursor: pointer;
    user-select: none;
  }

  .pane-menu-item:hover {
    background: var(--color-surface);
  }

  .panes {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .panes-prod {
    display: flex;
  }

  .panes-fenrir {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .panes-fenrir .pane-header {
    display: none;
  }

  .fenrir-left {
    display: flex;
    flex: 1;
    max-width: 400px;
    min-width: 0;
    border-right: 1px solid var(--color-border);
  }

  .fenrir-left .input-editor {
    background: var(--ctp-mantle);
  }

  .fenrir-center {
    display: flex;
    flex-direction: column;
    flex: 2;
    min-width: 0;
    background: var(--color-bg-elevated);
    border-right: 1px solid var(--color-border);
  }

  .fenrir-right {
    display: flex;
    flex: 2;
    min-width: 0;
  }

  .fenrir-right .pane {
    border-right: none;
  }

  .prod-left {
    display: flex;
    flex: 1;
    max-width: 400px;
    min-width: 0;
    border-right: 1px solid var(--color-border);
  }

  .prod-left .input-editor {
    background: var(--ctp-mantle);
  }

  .panes-prod .pane-header {
    display: none;
  }

  .pane-combined .pane-body {
    overflow: hidden;
  }

  .pane-combined .pane-body > .prod-right {
    height: 100%;
  }

  .pane-combined .pane-header ~ .pane-body .pane-header {
    display: none;
  }

  .prod-right {
    display: flex;
    flex-direction: column;
    flex: 2;
    min-width: 0;
    background: var(--color-bg-elevated);
  }

  .prod-right-top {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
  }

  .prod-right-top::-webkit-scrollbar {
    display: none;
  }

  .prod-right-bottom {
    flex: 0 0 auto;
    border-top: 1px solid var(--color-border-strong);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .prod-right-bottom::-webkit-scrollbar {
    display: none;
  }

  .prod-left :global(::-webkit-scrollbar) {
    display: none;
  }

  .prod-right .pane {
    border-right: none;
  }

  .prod-right .pane:last-child {
    border-bottom: none;
  }

  /* Video sync layout */
  .prod-video-col {
    display: flex;
    flex-direction: column;
    max-width: 640px;
    min-width: 320px;
    flex: 1;
  }

  .prod-video-col.prod-left {
    max-width: 640px;
  }

  .video-container {
    flex: 0 0 auto;
  }

  .day-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 6px 8px;
    background: var(--color-bg-elevated);
    border-top: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
  }

  .day-nav-btn {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 14px;
    cursor: pointer;
  }

  .day-nav-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .day-nav-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
    min-width: 4em;
    text-align: center;
  }

  .day-nav-sync {
    margin-left: auto;
    background: var(--color-accent);
    color: var(--color-bg);
    border: none;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 12px;
    cursor: pointer;
  }

  .day-nav-sync-active {
    background: var(--color-surface);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }

  .day-nav-time {
    font-size: 12px;
    font-family: 'Consolas', 'Menlo', monospace;
    color: var(--color-text-muted);
  }

  .video-editor-wrap {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .video-editor-wrap :global(.pane) {
    min-height: 0;
  }

  .video-editor-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 8px;
    background: var(--color-bg-elevated);
    border-bottom: 1px solid var(--color-border);
  }

  .auto-ts-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-muted);
    cursor: pointer;
    user-select: none;
  }

  .auto-ts-toggle input {
    cursor: pointer;
  }

  .mark-time-btn {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 12px;
    cursor: pointer;
  }

  .mark-time-btn:hover {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  /* Video fullscreen */
  .hidden-by-fullscreen .video-container {
    position: fixed;
    inset: 0;
    z-index: 9998;
    background: #000;
  }

  .hidden-by-fullscreen .video-container :global(.yt-wrap) {
    width: 100%;
    height: 100%;
    aspect-ratio: auto;
  }

  .vf-overlay {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    z-index: 9999;
    width: 340px;
    display: flex;
    flex-direction: column;
    background: rgba(30, 30, 46, 0.85);
    backdrop-filter: blur(8px);
    border-left: 1px solid var(--color-border);
    opacity: 0.3;
    transition: opacity 0.2s;
  }

  .vf-overlay:hover {
    opacity: 1;
  }

  .vf-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-border);
    flex-wrap: wrap;
  }

  .vf-close {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--color-text);
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
  }

  .vf-close:hover {
    color: var(--color-accent);
  }

  .vf-panels {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .vf-status {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .vf-analysis {
    flex: 0 0 auto;
    border-top: 1px solid var(--color-border);
  }

  .vf-panels :global(.pane-header) {
    display: none;
  }

  .day-nav-fullscreen {
    font-size: 16px;
    padding: 0 6px;
  }

  .hidden-by-fullscreen .day-nav,
  .hidden-by-fullscreen .video-editor-wrap {
    display: none;
  }


  .pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    border-right: 1px solid var(--color-border);
  }

  .pane:last-child {
    border-right: none;
  }

  .pane-header {
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-muted);
    background: var(--color-bg-elevated);
    border-bottom: 1px solid var(--color-border);
    user-select: none;
  }

  .pane-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .pane-body-input {
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .pending-delete-overlay {
    position: absolute;
    inset: 0;
    background: var(--color-overlay-backdrop);
    z-index: 10;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 16px;
  }

  .pending-delete-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    font-size: 12px;
    color: var(--color-text);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }

  .pending-delete-undo {
    background: transparent;
    border: 1px solid var(--color-border-strong);
    color: var(--color-accent);
    padding: 3px 10px;
    font-size: 11px;
    border-radius: 3px;
    cursor: pointer;
  }

  .pending-delete-undo:hover {
    background: var(--color-surface);
  }

  .input-editor {
    width: 100%;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .pane-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-faint);
    font-size: 14px;
  }

  .output {
    margin: 0;
    padding: 8px 12px;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* dead player opacity is handled by PlayerName component */

  .parsed-output {
    white-space: normal;
  }

  .parsed-day {
    color: var(--color-accent);
    font-weight: 600;
    font-size: 12px;
    padding: 2px 0;
  }

  .parsed-unknown {
    color: var(--color-text-faint);
  }

  .parsed-blank {
    height: 1.5em;
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: var(--color-overlay-backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--color-bg);
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    padding: 1rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 320px;
  }

  .modal-input {
    padding: 6px 10px;
    font-size: 13px;
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    outline: none;
  }

  .modal-input:focus {
    border-color: var(--color-accent);
  }

  .modal-title {
    font-size: 14px;
    font-weight: bold;
    color: var(--color-text);
  }

  .modal-hint {
    font-size: 11px;
    color: var(--color-text-overlay);
  }

  .modal-presets {
    display: flex;
    gap: 0.5rem;
  }

  .modal-cancel {
    font-size: 11px;
    color: var(--color-text-overlay);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 0;
    align-self: flex-end;
  }

  .modal-cancel:hover {
    color: var(--color-text-muted);
  }

  .preset-btn {
    padding: 6px 16px;
    font-size: 13px;
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border-strong);
    border-radius: 4px;
    cursor: pointer;
  }

  .preset-btn:hover {
    background: var(--color-surface-hover);
    border-color: var(--color-accent);
  }

  .analysis-layout {
    display: flex;
    align-items: flex-start;
    gap: 0;
  }

  .analysis-table-wrap {
    flex: 0 0 auto;
    overflow: auto;
    padding: 2px;
  }

  .analysis-table {
    border-collapse: collapse;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
  }

  .analysis-table td {
    text-align: center;
    padding: 2px 4px;
    border: 1px solid var(--color-border);
  }

  .analysis-name-col {
    text-align: left !important;
    white-space: nowrap;
    padding-right: 12px !important;
    font-weight: 500;
  }

  .role-possible,
  .role-impossible {
    cursor: pointer;
  }

  .role-possible:hover,
  .role-impossible:hover {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .role-possible {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  .role-impossible {
    background: var(--color-bg-sunken);
    color: var(--color-border);
  }

  .role-assumed {
    background: var(--color-accent);
    color: var(--color-bg);
    font-weight: 600;
  }

  .hocuspocus-spacer {
    border: none !important;
    background: transparent !important;
    width: 16px;
    padding: 0 !important;
  }

  .hocuspocus-cell {
    cursor: pointer;
    background: var(--color-bg-sunken);
    color: var(--color-border);
    font-weight: 700;
    user-select: none;
  }

  .hocuspocus-cell:hover {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .hocuspocus-cell.hocuspocus-on {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .analysis-label {
    display: inline-block;
    width: 1.8em;
    text-align: center;
    opacity: 0.6;
    font-size: 0.85em;
  }

  .analysis-name-col { font-weight: 700; }
  .analysis-name-col.village { background: var(--color-village-bg); }
  .analysis-name-col.wolf { background: var(--color-wolf-bg); }
  .analysis-name-col.fox { background: var(--color-fox-bg); }
  .analysis-name-col.not-village { background: var(--color-unknown-team-bg); }

  /* dead player opacity is handled by PlayerName component */



  .analysis-sidebar {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .assumptions-list {
    padding: 8px;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
  }

  .assumptions-header {
    color: var(--color-text-muted);
    margin-bottom: 4px;
  }

  .assumption-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
  }

  .assumption-text {
    color: var(--color-text);
  }

  .assumption-remove {
    background: none;
    border: none;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
  }

  .assumption-remove:hover {
    color: var(--color-text);
  }

  .assumption-add,
  .assumption-clear {
    background: none;
    border: 1px solid var(--color-text-faint);
    border-radius: 3px;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: 11px;
    padding: 1px 6px;
    margin-left: 4px;
  }

  .assumption-add:hover,
  .assumption-clear:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
  }

  .determined-banner {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin-bottom: 4px;
    border: 1px solid var(--color-village);
    border-radius: 4px;
    background: color-mix(in srgb, var(--color-village) 12%, transparent);
  }

  .determined-label {
    color: var(--color-village);
    font-weight: bold;
    font-size: 12px;
  }

  .determined-insert {
    background: none;
    border: 1px solid var(--color-village);
    border-radius: 3px;
    color: var(--color-village);
    cursor: pointer;
    font-size: 11px;
    padding: 1px 6px;
    margin-left: auto;
  }

  .determined-insert:hover {
    background: color-mix(in srgb, var(--color-village) 20%, transparent);
  }

  .deny-wolf {
    color: var(--color-wolf);
  }

  .deny-wolf-modal {
    max-width: 320px;
  }

  .deny-wolf-players {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .deny-wolf-player {
    padding: 4px 12px;
    font-size: 13px;
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
  }

  .deny-wolf-player:hover:not(:disabled) {
    border-color: var(--color-accent);
  }

  .deny-wolf-player.selected {
    background: var(--color-accent);
    color: var(--color-bg);
    border-color: var(--color-accent);
  }

  .deny-wolf-player:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .deny-wolf-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .deny-wolf-confirm {
    padding: 6px 16px;
    font-size: 13px;
    background: var(--color-accent);
    color: var(--color-bg);
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .deny-wolf-confirm:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .suggestions-section {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-border);
  }

  .suggestions-label {
    font-size: 11px;
    color: var(--color-text-faint);
    margin-bottom: 4px;
  }

  .suggestion-item {
    display: block;
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 12px;
    font-family: inherit;
    padding: 2px 0;
    cursor: pointer;
    text-align: left;
  }

  .suggestion-item:hover {
    color: var(--color-text);
  }

  .gmork-results {
    padding: 8px;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
    color: var(--color-text-muted);
    white-space: pre-wrap;
  }

  .analysis-duration {
    padding: 2px;
    font-size: 10px;
    color: var(--color-text-faint);
    text-align: right;
  }

  .analysis-dev-bar {
    padding: 2px;
    font-size: 10px;
    color: var(--color-text-faint);
    text-align: right;
  }

  .analysis-dev-bar .dev-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    user-select: none;
  }

  .analysis-dev-bar input[type="checkbox"] {
    margin: 0;
  }

  .trial-banner {
    color: var(--color-fox);
    font-size: 12px;
    font-weight: 600;
  }

  .trial-exit {
    color: var(--color-fox);
    border-color: var(--color-fox);
  }

  .trial-new {
    margin-left: 24px;
  }
</style>
