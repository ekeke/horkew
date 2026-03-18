<script lang="ts">
  import { tick } from 'svelte'
  import { parse } from '../src/howl/index.ts'
  import { buildVillageStatus } from '../src/howl/bridge.ts'
  import { systemRoles } from '../src/types/index.ts'
  import { stringifyStatements, type StringifiedLine } from './stringify.ts'
  import type { RetarResponse, SeatResult } from './analysis.worker.ts'
  import type { SystemRole } from '../src/types/index.ts'
  import AnalysisWorker from './analysis.worker.ts?worker'

  const STORAGE_PREFIX = 'horkew:'
  const ACTIVE_KEY = 'horkew:__active__'

  function savedKeys(): string[] {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      if (k.startsWith(STORAGE_PREFIX) && k !== ACTIVE_KEY) {
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
  let analysisError = $state('')
  let analyzing = $state(false)
  let players: Map<number, string> = $state(new Map())
  let worker: Worker | null = null
  let showModal = $state(false)
  let newTitle = $state('')
  let modalInput: HTMLInputElement | undefined = $state()
  let textareaEl: HTMLTextAreaElement | undefined = $state()
  let rawBodyEl: HTMLElement | undefined = $state()

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
    analysisError = ''
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
    analysisError = ''
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
    analysisError = ''
  }

  function onSelectChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value
    if (value) switchTo(value)
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

  function formatAnalysis(): string {
    if (analysisError) return `Error: ${analysisError}`
    if (analysisSeats.length === 0) return ''
    return analysisSeats.map(({ seat, roles }) => {
      const name = players.get(seat) ?? `#${seat}`
      return `${name}: ${roles.map(roleToShort).join('')}`
    }).join('\n')
  }

  function run() {
    if (worker) {
      worker.terminate()
    }

    analysisSeats = []
    analysisError = ''
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

      const workerPayload = {
        vs,
        setup: [...setup],
        players: [...playersMap],
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
        } else {
          analysisSeats = []
          analysisError = data.message
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
    }
  }
</script>

<div class="layout">
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
  </header>

  <div class="panes">
    <section class="pane">
      <div class="pane-header">Input</div>
      <div class="pane-body">
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

    <section class="pane">
      <div class="pane-header">Raw Statements</div>
      <div class="pane-body" bind:this={rawBodyEl}>
        <pre class="output">{rawStatements}</pre>
      </div>
    </section>

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

    <section class="pane">
      <div class="pane-header">Analyzer Input</div>
      <div class="pane-body">
        <pre class="output">{analyzerJson}</pre>
      </div>
    </section>

    <section class="pane">
      <div class="pane-header">Analysis</div>
      <div class="pane-body">
        <pre class="output">{formatAnalysis()}</pre>
      </div>
    </section>
  </div>
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

  .panes {
    display: flex;
    flex: 1;
    min-height: 0;
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
</style>
