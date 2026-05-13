<script lang="ts">
  import type { SystemRole } from '../../types/index.ts'
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'

  type NoCheckerEntry = {
    file: string
    title: string
    line: number | null
    label: string
    kind: 'deny' | 'confirm'
    player: string
    seat: number
    role: SystemRole
  }

  let { ctx }: { ctx: AnalysisContext } = $props()

  let entries: NoCheckerEntry[] = $state([])
  let selectedIdx = $state(-1)
  let scenarioCache = $state(new Map<string, string>())
  let loading = $state(true)
  let error = $state('')
  let filterFile = $state('')
  let filterKind = $state<'all' | 'deny' | 'confirm'>('all')

  const base = import.meta.env.BASE_URL

  async function loadEntries() {
    try {
      const res = await fetch(`${base}gmork-no-checker.json`)
      if (!res.ok) throw new Error(`${res.status}`)
      entries = await res.json()
    } catch (e) {
      error = `no-checker.json 読み込み失敗: ${e}`
    } finally {
      loading = false
    }
  }

  loadEntries()

  async function fetchScenario(file: string): Promise<string> {
    const cached = scenarioCache.get(file)
    if (cached) return cached
    const res = await fetch(`${base}scenarios/${file}`)
    if (!res.ok) throw new Error(`${res.status}`)
    const text = await res.text()
    scenarioCache.set(file, text)
    scenarioCache = new Map(scenarioCache)
    return text
  }

  let filtered = $derived(entries.filter(e => {
    if (filterFile && e.file !== filterFile) return false
    if (filterKind !== 'all' && e.kind !== filterKind) return false
    return true
  }))

  let uniqueFiles = $derived([...new Set(entries.map(e => e.file))].sort())

  let selected = $derived(selectedIdx >= 0 && selectedIdx < filtered.length ? filtered[selectedIdx] : null)

  let scenarioText = $state('')
  let copiedCommand = $state('')

  function extractPartial(raw: string, bodyLine: number): string {
    const text = raw.replace(/\r\n/g, '\n')
    const fmMatch = text.match(/^(---\n[\s\S]*?\n---\n)/)
    const frontmatter = fmMatch ? fmMatch[1] : ''
    const bodyText = fmMatch ? text.slice(fmMatch[1].length) : text
    const bodyLines = bodyText.split('\n')
    // bodyLine は 1-indexed（coverage test の cp.lineNumber + 1）
    // slice(0, bodyLine - 1) で @expect 行の手前までを取得
    return frontmatter + bodyLines.slice(0, bodyLine - 1).join('\n')
  }

  async function selectEntry(idx: number) {
    selectedIdx = idx
    const entry = filtered[idx]
    if (!entry) return

    // /gmork-improve コマンドをクリップボードに自動コピー
    const lineArg = entry.line !== null ? String(entry.line) : 'end'
    const cmd = `/gmork-improve ${entry.file} ${lineArg}`
    copiedCommand = cmd
    navigator.clipboard.writeText(cmd).catch(() => {})

    try {
      const full = await fetchScenario(entry.file)
      if (entry.line !== null) {
        scenarioText = extractPartial(full, entry.line)
      } else {
        scenarioText = full.replace(/\r\n/g, '\n')
      }
    } catch (e) {
      scenarioText = `読み込み失敗: ${e}`
    }
  }

  function loadInEditor() {
    if (scenarioText) {
      ctx.howlText = scenarioText
      const lineCount = scenarioText.split('\n').length
      ctx.jumpTo({ line: lineCount })
    }
  }

  function prev() {
    if (selectedIdx > 0) selectEntry(selectedIdx - 1)
  }

  function next() {
    if (selectedIdx < filtered.length - 1) selectEntry(selectedIdx + 1)
  }
</script>

<div class="gmork-debug">
  {#if loading}
    <div class="gmork-loading">読み込み中...</div>
  {:else if error}
    <div class="gmork-error">{error}</div>
  {:else}
    <div class="gmork-toolbar">
      <select bind:value={filterFile}>
        <option value="">全シナリオ</option>
        {#each uniqueFiles as f}
          <option value={f}>{f}</option>
        {/each}
      </select>
      <select bind:value={filterKind}>
        <option value="all">all</option>
        <option value="deny">deny</option>
        <option value="confirm">confirm</option>
      </select>
      <span class="gmork-count">{filtered.length} 件</span>
    </div>

    <div class="gmork-nav">
      <button onclick={prev} disabled={selectedIdx <= 0}>←</button>
      <span class="gmork-pos">{selectedIdx >= 0 ? `${selectedIdx + 1}/${filtered.length}` : '-'}</span>
      <button onclick={next} disabled={selectedIdx >= filtered.length - 1}>→</button>
      {#if selected}
        <button class="gmork-load-btn" onclick={loadInEditor}>エディタに読込</button>
      {/if}
    </div>

    {#if selected}
      <div class="gmork-detail">
        <div class="gmork-meta">
          <span class="gmork-kind" class:deny={selected.kind === 'deny'} class:confirm={selected.kind === 'confirm'}>
            {selected.kind}
          </span>
          <span class="gmork-target">{selected.player}/{selected.role}</span>
          <span class="gmork-file">{selected.file}:{selected.line ?? 'end'}</span>
        </div>
        {#if copiedCommand}
          <div class="gmork-copied">{copiedCommand} copied</div>
        {/if}
        <div class="gmork-desc">
          {#if selected.kind === 'deny'}
            Retarは「{selected.player}」が {selected.role} ではないと判定したが、Gmorkはその理由を説明できない
          {:else}
            Retarは「{selected.player}」を {selected.role} に確定したが、Gmorkはその理由を説明できない
          {/if}
        </div>
      </div>
    {/if}

    <div class="gmork-list">
      {#each filtered as entry, i}
        <button
          class="gmork-entry"
          class:active={i === selectedIdx}
          onclick={() => selectEntry(i)}
        >
          <span class="gmork-entry-kind" class:deny={entry.kind === 'deny'} class:confirm={entry.kind === 'confirm'}>
            {entry.kind === 'deny' ? '否定' : '確定'}
          </span>
          <span class="gmork-entry-player">{entry.player}</span>
          <span class="gmork-entry-role">/{entry.role}</span>
          <span class="gmork-entry-file">{entry.file}:{entry.line ?? 'end'}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .gmork-debug {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    height: 100%;
    font-size: 0.8rem;
  }

  .gmork-loading, .gmork-error {
    padding: 0.5rem;
    color: var(--ctp-subtext0);
  }

  .gmork-error {
    color: var(--ctp-red);
  }

  .gmork-toolbar {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-shrink: 0;
  }

  .gmork-toolbar select {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--ctp-surface1);
    border-radius: 3px;
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    font-size: 0.75rem;
  }

  .gmork-count {
    color: var(--ctp-subtext0);
    font-size: 0.7rem;
    margin-left: auto;
  }

  .gmork-nav {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    flex-shrink: 0;
  }

  .gmork-nav button {
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--ctp-surface1);
    border-radius: 3px;
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    cursor: pointer;
    font-size: 0.8rem;
  }

  .gmork-nav button:hover:not(:disabled) {
    background: var(--ctp-surface1);
  }

  .gmork-nav button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .gmork-pos {
    font-size: 0.75rem;
    color: var(--ctp-subtext0);
    min-width: 4em;
    text-align: center;
  }

  .gmork-load-btn {
    margin-left: auto;
    font-size: 0.7rem;
    background: var(--ctp-blue) !important;
    color: var(--ctp-base) !important;
    border-color: var(--ctp-blue) !important;
  }

  .gmork-copied {
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 0.65rem;
    color: var(--ctp-teal);
    padding: 0.1rem 0.5rem;
  }

  .gmork-detail {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .gmork-desc {
    font-size: 0.75rem;
    color: var(--ctp-subtext0);
    padding: 0.2rem 0.5rem;
    line-height: 1.4;
  }

  .gmork-meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.3rem 0.5rem;
    background: var(--ctp-surface0);
    border-radius: 4px;
  }

  .gmork-kind {
    font-weight: bold;
    font-size: 0.7rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  .gmork-kind.deny {
    color: var(--ctp-red);
    background: color-mix(in srgb, var(--ctp-red) 15%, transparent);
  }

  .gmork-kind.confirm {
    color: var(--ctp-green);
    background: color-mix(in srgb, var(--ctp-green) 15%, transparent);
  }

  .gmork-target {
    font-weight: bold;
    color: var(--ctp-text);
  }

  .gmork-file {
    color: var(--ctp-subtext0);
    font-size: 0.7rem;
    margin-left: auto;
  }

  .gmork-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .gmork-entry {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    padding: 0.2rem 0.4rem;
    border: none;
    background: transparent;
    color: var(--ctp-text);
    cursor: pointer;
    text-align: left;
    font-size: 0.75rem;
    border-radius: 2px;
  }

  .gmork-entry:hover {
    background: var(--ctp-surface0);
  }

  .gmork-entry.active {
    background: var(--ctp-surface1);
  }

  .gmork-entry-kind {
    flex-shrink: 0;
    width: 2.5em;
    font-size: 0.65rem;
    text-align: center;
  }

  .gmork-entry-kind.deny {
    color: var(--ctp-red);
  }

  .gmork-entry-kind.confirm {
    color: var(--ctp-green);
  }

  .gmork-entry-player {
    font-weight: bold;
  }

  .gmork-entry-role {
    color: var(--ctp-subtext0);
  }

  .gmork-entry-file {
    color: var(--ctp-overlay0);
    font-size: 0.65rem;
    margin-left: auto;
    flex-shrink: 0;
  }
</style>
