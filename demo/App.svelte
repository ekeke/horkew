<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { parse } from '../src/howl/index.ts'
  import { buildVillageStatus } from '../src/howl/bridge.ts'
  import { systemRoles } from '../src/types/index.ts'
  import { stringifyStatements, type StringifiedLine } from './stringify.ts'
  import type { RetarResponse, SeatResult } from './analysis.worker.ts'
  import type { SystemRole, VillageStatus, CauseOfDeath } from '../src/types/index.ts'
  import AnalysisWorker from './analysis.worker.ts?worker'
  import StatusPane from './status/StatusPane.svelte'
  import PlayerName from './status/PlayerName.svelte'
  import { findReason } from '../src/gmork/index.ts'
  import { formatReason } from '../src/gmork/format.ts'
  import HelpPanel from './HelpPanel.svelte'
  import { onOpenHelp } from './help.ts'

  const nightKillCauses: Set<CauseOfDeath> = new Set([
    'night_kill', 'follow_killed_hamster', 'cursed_by_killed_nekomata',
  ])

  const STORAGE_PREFIX = 'horkew:'
  const ACTIVE_KEY = 'horkew:__active__'
  const PANES_KEY = 'horkew:__panes__'
  const SKIN_KEY = 'horkew:__skin__'
  const DEBUG_KEY = 'horkew:__debug__'

  type Skin = 'flat' | 'excite'

  const paneEntries = [
    { id: 'rawStatements', label: 'Raw Statements' },
    { id: 'parsed', label: 'Parsed' },
    { id: 'status', label: 'Status' },
    { id: 'analyzerInput', label: 'Analyzer Input' },
    { id: 'analysis', label: 'Analysis' },
  ] as const

  type PaneId = typeof paneEntries[number]['id']

  function loadPaneVisibility(): Record<PaneId, boolean> {
    const defaults: Record<PaneId, boolean> = { rawStatements: true, parsed: true, status: true, analyzerInput: true, analysis: true }
    try {
      const stored = localStorage.getItem(PANES_KEY)
      if (stored) return { ...defaults, ...JSON.parse(stored) }
    } catch {}
    return defaults
  }

  function savePaneVisibility(v: Record<PaneId, boolean>) {
    localStorage.setItem(PANES_KEY, JSON.stringify(v))
  }

  function savedKeys(): string[] {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      if (k.startsWith(STORAGE_PREFIX) && k !== ACTIVE_KEY && k !== PANES_KEY) {
        keys.push(k.slice(STORAGE_PREFIX.length))
      }
    }
    return keys.sort()
  }

  function loadText(title: string): string {
    return localStorage.getItem(STORAGE_PREFIX + title) ?? ''
  }

  function saveText(title: string, text: string) {
    localStorage.setItem(STORAGE_PREFIX + title, text)
    localStorage.setItem(ACTIVE_KEY, title)
  }

  function deleteText(title: string) {
    localStorage.removeItem(STORAGE_PREFIX + title)
    if (localStorage.getItem(ACTIVE_KEY) === title) {
      localStorage.removeItem(ACTIVE_KEY)
    }
  }

  let titles = $state(savedKeys())
  let activeTitle = $state(localStorage.getItem(ACTIVE_KEY) ?? '')
  let input = $state(activeTitle ? loadText(activeTitle) : '')
  let rawStatements = $state('')
  let analyzerJson = $state('')
  let parsedLines: StringifiedLine[] = $state([])
  let statementLines: number[] = []
  let analysisSeats: SeatResult[] = $state([])
  let analysisColumns: SystemRole[] = $state([])
  let analysisError = $state('')
  let analyzing = $state(false)
  let survivorInfo = $state({ alive: 0, total: 0 })
  let deadSeats: Set<number> = $state(new Set())
  let nightKilledSeats: Set<number> = $state(new Set())
  let executedSeats: Set<number> = $state(new Set())
  let players: Map<number, string> = $state(new Map())
  let villageStatus: VillageStatus | null = $state(null)
  let claimShortNames: Map<number, string> = $derived(
    villageStatus
      ? new Map([...villageStatus.statuses.entries()]
          .filter(([, s]) => s.claiming)
          .map(([seat, s]) => [seat, systemRoles.get(s.claimingRole as SystemRole)?.shortName ?? s.claimingRole] as const))
      : new Map()
  )
  let assumptions: Map<number, SystemRole> = $state(new Map())
  let gmorkResult = $state('')
  let currentSetup: Map<SystemRole, number> = $state(new Map())
  let worker: Worker | null = null
  let skin: Skin = $state((localStorage.getItem(SKIN_KEY) as Skin) ?? 'flat')
  let debugMode = $state(localStorage.getItem(DEBUG_KEY) === 'true')
  let paneVisible: Record<PaneId, boolean> = $state(loadPaneVisibility())
  let showPaneMenu = $state(false)
  let showModal = $state(false)
  let showHelp = $state(false)
  let newTitle = $state('')
  let modalInput: HTMLInputElement | undefined = $state()
  let textareaEl: HTMLTextAreaElement | undefined = $state()
  let rawBodyEl: HTMLElement | undefined = $state()
  let helpPanel: HelpPanel | undefined = $state()

  function doOpenHelp(sectionId?: string) {
    showHelp = true
    if (sectionId) {
      tick().then(() => helpPanel?.scrollToId(sectionId))
    }
  }

  onMount(() => {
    onOpenHelp(doOpenHelp)
    const hash = location.hash.slice(1)
    if (hash.startsWith('help-')) doOpenHelp(hash)
  })

  $effect(() => {
    if (activeTitle && input !== undefined) {
      saveText(activeTitle, input)
      run()
    }
  })

  function switchTo(title: string) {
    activeTitle = title
    input = loadText(title)
    localStorage.setItem(ACTIVE_KEY, title)
    rawStatements = ''
    parsedLines = []
    analysisSeats = []
    analysisColumns = []
    analysisError = ''
    assumptions = new Map()
  }

  function openNewModal() {
    newTitle = ''
    showModal = true
  }

  function confirmNew() {
    const trimmed = newTitle.trim()
    if (!trimmed) return
    if (titles.includes(trimmed)) {
      switchTo(trimmed)
    } else {
      const template = `---\ntitle: ${trimmed}\n---\n\n`
      activeTitle = trimmed
      input = template
      saveText(trimmed, template)
      titles = savedKeys()
    }
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
    if (!activeTitle) return
    deleteText(activeTitle)
    titles = savedKeys()
    if (titles.length > 0) {
      switchTo(titles[0])
    } else {
      activeTitle = ''
      input = ''
      localStorage.removeItem(ACTIVE_KEY)
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
    if (value) switchTo(value)
  }

  function togglePane(id: PaneId) {
    paneVisible[id] = !paneVisible[id]
    savePaneVisibility(paneVisible)
  }

  function onModalKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') confirmNew()
    if (e.key === 'Escape') cancelNew()
  }

  function getCursorLine(): number {
    if (!textareaEl) return 1
    const pos = textareaEl.selectionStart
    return input.slice(0, pos).split('\n').length
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

  function getInputUpToCursor(): string {
    if (!textareaEl) return input
    const pos = textareaEl.selectionStart
    // Include the full line the cursor is on
    const nextNewline = input.indexOf('\n', pos)
    return nextNewline === -1 ? input : input.slice(0, nextNewline)
  }

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
    const possibilities = new Map(analysisSeats.map(s => [s.seat, new Set(s.roles)]))
    const playerName = players.get(seat) ?? `席${seat}`
    const roleName = systemRoles.get(role)?.name ?? role
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
    run()
  }

  function run() {
    if (worker) {
      worker.terminate()
    }

    analysisSeats = []
    analysisError = ''
    gmorkResult = ''
    rawStatements = ''
    analyzerJson = ''
    parsedLines = []

    try {
      const { meta, statements } = parse(getInputUpToCursor())
      rawStatements = JSON.stringify(statements, null, 2)
      parsedLines = stringifyStatements(statements)
      statementLines = statements.map((s: any) => s.line as number)

      const { vs, setup, players: playersMap } = buildVillageStatus(statements, meta)
      players = playersMap
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

      const roleOrder = [...systemRoles.keys()] as SystemRole[]
      analysisColumns = roleOrder.filter(r => setup.has(r as SystemRole))

      const workerPayload = {
        vs,
        setup: [...setup],
        players: [...playersMap],
        assumptions: [...assumptions],
      }
      analyzerJson = JSON.stringify(workerPayload, (_key, value) =>
        value instanceof Map ? Object.fromEntries(value) : value
      , 2)

      analyzing = true
      worker = new AnalysisWorker()
      worker.onmessage = (e: MessageEvent<RetarResponse>) => {
        analyzing = false
        const data = e.data
        if (data.type === 'result') {
          analysisSeats = data.seats
          analysisError = ''
          gmorkResult = runGmork()
        } else {
          analysisSeats = []
          analysisError = data.message
          gmorkResult = ''
        }
        worker?.terminate()
        worker = null
      }
      worker.onerror = (e) => {
        analyzing = false
        analysisSeats = []
        analysisError = `Worker error: ${e.message}`
        worker?.terminate()
        worker = null
      }
      worker.postMessage(workerPayload)
    } catch (e: any) {
      analysisSeats = []
      analysisError = e.message
      villageStatus = null
    }
  }
</script>

<div class="layout skin-{skin}">
  <header class="header">
    <span class="header-title">Horkew</span>

    <select class="header-select" value={activeTitle} onchange={onSelectChange} disabled={titles.length === 0}>
      {#if titles.length === 0}
        <option value="">---</option>
      {:else}
        {#each titles as title}
          <option value={title}>{title}</option>
        {/each}
      {/if}
    </select>

    <button class="header-btn" onclick={deleteCurrent} disabled={!activeTitle} title="Delete">Del</button>

    <button class="header-btn" onclick={openNewModal}>New</button>

    <div class="header-spacer"></div>

    <select class="header-select skin-select" value={skin} onchange={(e) => { skin = (e.target as HTMLSelectElement).value as Skin; localStorage.setItem(SKIN_KEY, skin) }}>
      <option value="flat">Flat</option>
      <option value="excite">Excite</option>
    </select>

    <button
      class="header-btn debug-btn"
      class:debug-on={debugMode}
      onclick={() => { debugMode = !debugMode; localStorage.setItem(DEBUG_KEY, String(debugMode)) }}
    >{debugMode ? 'DEBUG ON' : 'DEBUG OFF'}</button>

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
        {#if activeTitle}
          <textarea
            class="input-editor"
            bind:value={input}
            bind:this={textareaEl}
            onclick={onCursorMove}
            onkeyup={onCursorMove}
          ></textarea>
        {:else}
          <div class="pane-placeholder"><span>New ボタンから開始してください</span></div>
        {/if}
      </div>
    </section>
  {/snippet}

  {#snippet statusPane()}
    <section class="pane">
      <div class="pane-header">Status</div>
      <div class="pane-body">
        {#if villageStatus}
          <StatusPane vs={villageStatus} {players} setup={currentSetup} />
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
                      <td class="analysis-name-col {cls.status}" class:role-fixed={cls.fixed}><span class="analysis-label">{cls.label}</span><PlayerName dead={deadSeats.has(seat)} nightKill={nightKilledSeats.has(seat)} executed={executedSeats.has(seat)} claim={claimShortNames.get(seat)}>{name}</PlayerName></td>
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
            </div>
            {#if gmorkResult}
              <div class="gmork-results">{gmorkResult}</div>
            {/if}
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
      <div class="modal-title">New Howl</div>
      <input
        class="modal-input"
        type="text"
        placeholder="タイトルを入力"
        bind:value={newTitle}
        bind:this={modalInput}
        onkeydown={onModalKeydown}
        autofocus
      />
      <div class="modal-actions">
        <button class="header-btn" onclick={cancelNew}>Cancel</button>
        <button class="header-btn modal-confirm" onclick={confirmNew} disabled={!newTitle.trim()}>Create</button>
      </div>
    </div>
  </div>
{/if}

<HelpPanel bind:this={helpPanel} open={showHelp} onclose={() => showHelp = false} />

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
    background: #1e1e2e;
    color: #cdd6f4;
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
    background: #181825;
    border-bottom: 1px solid #313244;
  }

  .header-title {
    font-weight: 600;
    font-size: 14px;
    color: #cba6f7;
    margin-right: 0.5rem;
  }

  .header-spacer {
    flex: 1;
  }

  .header-select {
    padding: 4px 8px;
    font-size: 12px;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
    min-width: 140px;
  }

  .header-btn {
    padding: 4px 12px;
    font-size: 12px;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }

  .header-btn:hover:not(:disabled) {
    background: #45475a;
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

  .debug-btn {
    font-size: 11px;
    font-weight: 600;
    opacity: 0.5;
  }

  .debug-btn.debug-on {
    opacity: 1;
    background: #f38ba8;
    color: #1e1e2e;
    border-color: #f38ba8;
  }

  .debug-btn.debug-on:hover {
    background: #eba0ac;
    border-color: #eba0ac;
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
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 6px;
    padding: 6px 0;
    min-width: 160px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .pane-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    font-size: 12px;
    color: #cdd6f4;
    cursor: pointer;
    user-select: none;
  }

  .pane-menu-item:hover {
    background: #313244;
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
    border-right: 1px solid #313244;
  }

  .prod-left .input-editor {
    background: #242438;
  }

  .panes-prod .pane-header {
    display: none;
  }

  .prod-right {
    display: flex;
    flex-direction: column;
    flex: 2;
    min-width: 0;
    background: #181825;
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
    border-top: 1px solid #45475a;
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
    border-right: 1px solid #313244;
  }

  .pane:last-child {
    border-right: none;
  }

  .pane-header {
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 500;
    color: #a6adc8;
    background: #181825;
    border-bottom: 1px solid #313244;
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
    box-sizing: border-box;
    padding: 8px 12px;
    margin: 0;
    border: none;
    outline: none;
    resize: none;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
    line-height: 1.5;
    background: #1e1e2e;
    color: #cdd6f4;
  }

  .pane-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #585b70;
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

  .output .dead {
    color: #585b70;
  }

  .parsed-output {
    white-space: normal;
  }

  .parsed-day {
    color: #cba6f7;
    font-weight: 600;
    font-size: 12px;
    padding: 2px 0;
  }

  .parsed-unknown {
    color: #585b70;
  }

  .parsed-blank {
    height: 1.5em;
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 1.5rem;
    min-width: 320px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .modal-title {
    font-size: 14px;
    font-weight: 600;
    color: #cdd6f4;
  }

  .modal-input {
    padding: 6px 10px;
    font-size: 13px;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
    outline: none;
  }

  .modal-input:focus {
    border-color: #cba6f7;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .analysis-layout {
    display: flex;
    align-items: flex-start;
    gap: 0;
  }

  .analysis-table-wrap {
    flex: 0 0 auto;
    overflow: auto;
    padding: 8px;
  }

  .analysis-table {
    border-collapse: collapse;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
  }

  .analysis-table td {
    text-align: center;
    padding: 2px 4px;
    border: 1px solid #313244;
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
    outline: 1px solid #cba6f7;
    outline-offset: -1px;
  }

  .role-possible {
    background: #45475a;
    color: #cdd6f4;
  }

  .role-impossible {
    background: #11111b;
    color: #313244;
  }

  .role-assumed {
    background: #cba6f7;
    color: #1e1e2e;
    font-weight: 600;
  }

  .analysis-label {
    display: inline-block;
    width: 1.8em;
    text-align: center;
    opacity: 0.6;
    font-size: 0.85em;
  }

  .analysis-name-col.village { color: #a6e3a1; }
  .analysis-name-col.wolf { color: #f38ba8; }
  .analysis-name-col.fox { color: #f9e2af; }
  .analysis-name-col.not-village { color: #cba6f7; }
  .analysis-name-col.role-fixed { font-weight: 700; }

  .dead-row .analysis-name-col {
    opacity: 0.6;
  }

  .modal-confirm {
    background: #cba6f7;
    color: #1e1e2e;
    border-color: #cba6f7;
    font-weight: 600;
  }

  .modal-confirm:hover:not(:disabled) {
    background: #b4befe;
    border-color: #b4befe;
  }

  .gmork-results {
    flex: 1;
    min-width: 0;
    padding: 8px;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 13px;
    color: #a6adc8;
    white-space: pre-wrap;
  }
</style>
