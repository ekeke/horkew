<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { parse } from '../src/howl/index.ts'
  import { buildVillageStatus } from '../src/howl/bridge.ts'
  import { systemRoles } from '../src/types/index.ts'
  import { stringifyStatements, type StringifiedLine } from './stringify.ts'
  import type { SeatResult } from './analysis.worker.ts'
  import type { SystemRole, VillageStatus, CauseOfDeath } from '../src/types/index.ts'
  import { requestAnalysis, type AnalysisStats } from './runAnalysis.ts'
  import StatusPane from './status/StatusPane.svelte'
  import PlayerName from './status/PlayerName.svelte'
  import { findReason, findConfirmationReason } from '../src/gmork/index.ts'
  import { formatReason, formatConfirmationReason } from '../src/gmork/format.ts'
  import { scoreWolfPairs, type WolfPairSuggestion } from './status/wolfPairScorer.ts'
  import HelpPanel from './HelpPanel.svelte'
  import ColorSwatchPane from './ColorSwatchPane.svelte'
  import './theme.css'
  import { runGame } from '../src/lupa/engine.ts'
  import { formatHowl } from '../src/lupa/format.ts'
  import { onOpenHelp, onStartTrial, TUTORIAL_TEXT } from './help.ts'
  import type { FlexibleDictionary } from '../src/howl/flexibleDictionary.ts'
  import type { EditorView } from '@codemirror/view'
  import type { StatementInfo, PlayerNameInfo } from './editor/howlLanguage.ts'

  type EditorModule = typeof import('./editor/index.ts')
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
    { id: 'rawStatements', label: 'Raw Statements' },
    { id: 'parsed', label: 'Parsed' },
    { id: 'combined', label: 'Combined' },
    { id: 'status', label: 'Status' },
    { id: 'analyzerInput', label: 'Analyzer Input' },
    { id: 'analysis', label: 'Analysis' },
    { id: 'colorSwatch', label: 'Color Swatch' },
  ] as const

  type PaneId = typeof paneEntries[number]['id']

  interface Settings {
    active: string
    skin: Skin
    devMode: boolean
    debug: boolean
    panes: Record<PaneId, boolean>
  }

  const defaultPanes: Record<PaneId, boolean> = { rawStatements: true, parsed: true, combined: true, status: true, analyzerInput: true, analysis: true, colorSwatch: true }

  function loadSettings(): Settings {
    const defaults: Settings = { active: '', skin: 'flat', devMode: false, debug: false, panes: { ...defaultPanes } }
    try {
      const stored = localStorage.getItem(SETTINGS_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
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
      .sort((a, b) => b.entry.createdAt - a.entry.createdAt)
  }

  function loadText(key: string): string {
    return localStorage.getItem(STORAGE_PREFIX + key) ?? ''
  }

  function saveText(key: string, text: string) {
    localStorage.setItem(STORAGE_PREFIX + key, text)
    const now = Date.now()
    if (fileIndex[key]) {
      fileIndex[key].updatedAt = now
    } else {
      fileIndex[key] = { createdAt: now, updatedAt: now }
    }
    saveIndex(fileIndex)
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

  let entries = $state(fileEntries())
  let activeKey = $state(settings.active)
  let input = $state(activeKey ? loadText(activeKey) : '')
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
  let denyWolfGroups: number[][] = $state([])
  let showDenyWolfDialog = $state(false)
  let denyWolfSelection: Set<number> = $state(new Set())
  let gmorkResult = $state('')
  let wolfPairSuggestions: WolfPairSuggestion[] = $state([])
  let baseAnalysisSeats: SeatResult[] = []
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
    return { key: effectiveLines, hash: (h >>> 0).toString(36) }
  }
  let currentSetup: Map<SystemRole, number> = $state(new Map())
  let skin: Skin = $state(settings.skin)
  let devMode = $state(settings.devMode)
  let debugMode = $state(settings.debug)
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
  })

  $effect(() => {
    if (activeKey && input !== undefined && !trialMode) {
      saveText(activeKey, input)
    }
  })

  function setEditorContent(text: string) {
    if (editorView) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: text },
        selection: { anchor: text.length },
      })
      editorView.focus()
    }
  }

  function generateLupaGame() {
    const roles = new Map<SystemRole, number>([
      ['werewolf', 3], ['villager', 2], ['seer', 1], ['medium', 1],
      ['bodyguard', 1], ['mason', 2], ['nekomata', 1],
      ['possessed', 1], ['werehamster', 1], ['immoralist', 1],
    ])
    const config = { roles, seed: Date.now() }
    const { events, state } = runGame(config)
    const howl = formatHowl(events, state, config)
    if (trialMode || !activeKey) {
      handleStartTrial(howl)
    } else {
      setEditorContent(howl)
    }
  }

  function handleStartTrial(text: string) {
    trialMode = true
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
    return `@ ${preset.setup}\n\n${joins}${kill}\n`
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

  function deleteCurrent() {
    if (!activeKey) return
    deleteText(activeKey)
    entries = fileEntries()
    if (entries.length > 0) {
      switchTo(entries[0].key)
    } else {
      activeKey = ''
      input = ''
      updateSettings({ active: '' })
    }
    rawStatements = ''
    analyzerJson = ''
    parsedLines = []
    analysisSeats = []
    analysisColumns = []
    analysisError = ''
    assumptions = new Map()
  }

  function onSelectChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value
    if (value === '__trial__') {
      handleStartTrial(TUTORIAL_TEXT)
    } else if (value) {
      switchTo(value)
    }
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
      if (!devMode) debugMode = false
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

  function onCursorMove() {
    run()
    tick().then(scrollRawToCursor)
  }

  // Initialize CM6 editor when parent element is available (lazy-loaded)
  // Only depends on editorParent (DOM availability via {#if activeKey} block).
  // activeKey and editorView are intentionally NOT dependencies to avoid
  // destroy/recreate loops on document switch.
  $effect(() => {
    if (!editorParent) return
    import('./editor/index.ts').then(mod => {
      editorModule = mod
      if (!editorParent || editorView) return
      editorView = mod.createHowlEditor(editorParent, {
        doc: input,
        onChange(value) {
          input = value
        },
        onCursorChange(_line) {
          onCursorMove()
        },
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
    gmorkResult = ''
    run()
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
    if (villageStatus) {
      wolfPairSuggestions = scoreWolfPairs(villageStatus, players, denyWolfGroups)
    }
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

  function run() {
    const runStart = performance.now()
    analysisSeats = []
    analysisError = ''
    if (assumptions.size === 0) gmorkResult = ''
    rawStatements = ''
    analyzerJson = ''
    parsedLines = []
    sourceLines = { survivor: new Map(), claimRow: new Map(), claimCell: new Map(), kill: new Map(), exec: new Map(), vote: new Map() }

    try {
      const { meta, statements } = parse(input, { cursorLine: getCursorLine() })
      rawStatements = JSON.stringify(statements, null, 2)
      parsedLines = stringifyStatements(statements)
      statementLines = statements.map((s: any) => s.line as number)

      const { vs, setup, players: playersMap, shortNames: shortNamesMap, dict } = buildVillageStatus(statements, meta)
      sourceLines = buildSourceLines(statements, dict)

      // Feed parse results to CM6 for syntax highlighting (after buildVillageStatus so dict is available)
      if (editorView) {
        const stmtInfo: StatementInfo[] = statements.map((s: any) => ({ type: s.type, line: s.line }))
        const playerNameInfos = buildPlayerNames(statements, dict, editorView.state.doc.toString())
        const playerList: { name: string, shortName?: string, aliases: string[], surviving: boolean }[] = []
        let seat = 1
        for (const s of statements) {
          if (s.type === 'join') {
            const surviving = vs.statuses.get(seat)?.surviving ?? true
            playerList.push({ name: s.name, shortName: s.shortName, aliases: s.aliases, surviving })
            seat++
          } else if (s.type === 'joinMulti') {
            for (const p of s.players) {
              const surviving = vs.statuses.get(seat)?.surviving ?? true
              playerList.push({ name: p, aliases: [], surviving })
              seat++
            }
          }
        }
        editorView.dispatch({ effects: [
          editorModule!.setStatements.of({ statements: stmtInfo, cursorLine: getCursorLine(), playerNames: playerNameInfos }),
          editorModule!.setPlayerList.of(playerList),
          editorModule!.setSetup.of(setup),
        ] })
      }
      cursorLine = getCursorLine()
      players = playersMap
      playerShortNames = shortNamesMap
      villageStatus = vs
      currentSetup = setup
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

      wolfPairSuggestions = (setup.get('werewolf') ?? 0) >= 2
        ? scoreWolfPairs(vs, playersMap, denyWolfGroups)
        : []

      const roleOrder = [...systemRoles.keys()] as SystemRole[]
      analysisColumns = roleOrder.filter(r => setup.has(r as SystemRole))

      const workerPayload = {
        vs,
        setup: [...setup],
        players: [...playersMap],
        assumptions: [...assumptions],
        wolfPairDenyals: denyWolfGroups.map(g => [g[0], g[1]] as [number, number]),
      }
      analyzerJson = JSON.stringify(workerPayload, (_key, value) =>
        value instanceof Map ? Object.fromEntries(value) : value
      , 2)

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
</script>

<div class="layout skin-{skin}">
  <header class="header">
    <span class="header-subtitle">人狼メモ・解析ツール</span>
    <span class="header-title" class:title-flash={titleFlash} onclick={onTitleTap}>Horkew</span>

    {#if trialMode}
    <span class="trial-banner">お試しモード</span>
    {#if activeKey}<button class="header-btn trial-exit" onclick={exitTrialMode}>戻る</button>{/if}
    <button class="header-btn trial-new" onclick={openNewModal}>新規作成</button>
    {:else}
    <select class="header-select" value={activeKey} onchange={onSelectChange}>
      {#if entries.length === 0}
        <option value="">---</option>
      {:else}
        {#each entries as { key, entry }}
          <option value={key}>{displayName(entry)}</option>
        {/each}
      {/if}
      <option disabled>──────────</option>
      <option value="__trial__">お試しモード（保存なし）</option>
    </select>

    <button class="header-btn" onclick={deleteCurrent} disabled={!activeKey} title="Delete">Del</button>
    <button class="header-btn" onclick={openNewModal}>新規作成</button>
    {/if}

    <div class="header-spacer"></div>

    {#if devMode}
    <button class="header-btn" onclick={generateLupaGame} title="Lupaでランダムゲームを生成">Lupa</button>

    <select class="header-select skin-select" value={skin} onchange={(e) => { skin = (e.target as HTMLSelectElement).value as Skin; updateSettings({ skin }) }}>
      <option value="flat">Flat</option>
      <option value="excite">Excite</option>
    </select>

    <button
      class="header-btn debug-btn"
      class:debug-on={debugMode}
      onclick={() => { debugMode = !debugMode; updateSettings({ debug: debugMode }) }}
    >{debugMode ? 'DEBUG ON' : 'DEBUG OFF'}</button>
    {/if}

    {#if debugMode}
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

    <button class="header-btn help-btn" onclick={() => showHelp = true} title="Howl記法ヘルプ">?</button>
  </header>

  {#snippet inputPane()}
    <section class="pane">
      <div class="pane-header">Input</div>
      <div class="pane-body pane-body-input">
        {#if activeKey || trialMode}
          <div class="input-editor" bind:this={editorParent}></div>
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
          <StatusPane vs={villageStatus} {players} setup={currentSetup} shortNames={playerShortNames} {sourceLines} {cursorLine} />
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
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if analysisCached}
                <div class="analysis-duration">total {analysisTotalElapsed}ms (cached) — retar {analysisDuration}ms{#if analysisStatsInfo} ({analysisStatsInfo.workers}w, {analysisStatsInfo.minElapsed}-{analysisStatsInfo.maxElapsed}ms){/if}</div>
              {:else if analysisDuration > 0}
                <div class="analysis-duration">total {analysisTotalElapsed}ms — retar {analysisDuration}ms{#if analysisStatsInfo} ({analysisStatsInfo.workers}w, {analysisStatsInfo.minElapsed}-{analysisStatsInfo.maxElapsed}ms){/if}</div>
              {/if}
            </div>
            <div class="analysis-sidebar">
              <div class="assumptions-list">
                <div class="assumptions-header">
                  仮説
                  {#if (currentSetup.get('werewolf') ?? 0) >= 2}
                    <button class="assumption-add" onclick={openDenyWolfDialog}>追加</button>
                  {/if}
                  {#if assumptions.size > 0 || denyWolfGroups.length > 0}
                    <button class="assumption-clear" onclick={() => clearAssumptions()}>全削除</button>
                  {/if}
                </div>
                {#each [...assumptions] as [seat, role]}
                  <div class="assumption-item">
                    <span class="assumption-text">{playerShortNames.get(seat) ?? players.get(seat) ?? `#${seat}`} = {systemRoles.get(role)?.name ?? role}</span>
                    <button class="assumption-remove" onclick={() => toggleAssumption(seat, role)}>&times;</button>
                  </div>
                {/each}
                {#each denyWolfGroups as group, i}
                  <div class="assumption-item">
                    <span class="assumption-text deny-wolf">{group.map(s => playerShortNames.get(s) ?? players.get(s) ?? `#${s}`).join(' & ')} は両狼でない</span>
                    <button class="assumption-remove" onclick={() => removeDenyWolfGroup(i)}>&times;</button>
                  </div>
                {/each}
                {#if wolfPairSuggestions.length > 0}
                  <div class="suggestions-section">
                    <div class="suggestions-label">提案</div>
                    {#each wolfPairSuggestions as suggestion}
                      <div class="suggestion-item">
                        <span class="suggestion-text">{playerShortNames.get(suggestion.seatA) ?? players.get(suggestion.seatA) ?? `#${suggestion.seatA}`} & {playerShortNames.get(suggestion.seatB) ?? players.get(suggestion.seatB) ?? `#${suggestion.seatB}`}</span>
                        <button class="suggestion-add" onclick={() => addSuggestion(suggestion)}>+</button>
                      </div>
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

  {#if debugMode}
  <div class="panes">
    {@render inputPane()}

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
  </div>
  {:else}
  <div class="panes panes-prod">
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
  }

  .input-editor {
    width: 100%;
    height: 100%;
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

  .analysis-label {
    display: inline-block;
    width: 1.8em;
    text-align: center;
    opacity: 0.6;
    font-size: 0.85em;
  }

  .analysis-name-col.village { color: var(--color-village); }
  .analysis-name-col.wolf { color: var(--color-wolf); }
  .analysis-name-col.fox { color: var(--color-fox); }
  .analysis-name-col.not-village { color: var(--color-unknown-team); }
  .analysis-name-col.role-fixed { font-weight: 700; }

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
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
  }

  .suggestion-text {
    color: var(--color-text-muted);
    font-size: 12px;
  }

  .suggestion-add {
    background: none;
    border: 1px solid var(--color-text-faint);
    border-radius: 3px;
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: 12px;
    padding: 0 5px;
    line-height: 1.4;
  }

  .suggestion-add:hover {
    color: var(--color-text);
    border-color: var(--color-text-muted);
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
