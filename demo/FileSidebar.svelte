<script lang="ts">
  import { tick } from 'svelte'

  type FileEntry = {
    title?: string
    createdAt: number
    updatedAt: number
  }

  let {
    open,
    entries,
    activeKey,
    pendingKeys,
    trialMode,
    onSelect,
    onRename,
    onDelete,
    onUndoDelete,
    onCreateNew,
    onStartTrial,
    formatDate,
    displayName,
  }: {
    open: boolean
    entries: { key: string, entry: FileEntry }[]
    activeKey: string
    pendingKeys: Set<string>
    trialMode: boolean
    onSelect: (key: string) => void
    onRename: (key: string, newTitle: string) => void
    onDelete: (key: string) => void
    onUndoDelete: (key: string) => void
    onCreateNew: () => void
    onStartTrial: () => void
    formatDate: (ms: number) => string
    displayName: (entry: FileEntry) => string
  } = $props()

  let renamingKey = $state<string | null>(null)
  let renameDraft = $state('')
  let renameInputEl: HTMLInputElement | undefined = $state()

  async function startRename(key: string, entry: FileEntry) {
    renamingKey = key
    renameDraft = entry.title ?? ''
    await tick()
    renameInputEl?.focus()
    renameInputEl?.select()
  }

  function commitRename(key: string) {
    if (renamingKey !== key) return
    onRename(key, renameDraft)
    renamingKey = null
  }

  function cancelRename() {
    renamingKey = null
  }

  function onRenameKeydown(e: KeyboardEvent, key: string) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename(key)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelRename()
    }
  }
</script>

<aside class="file-sidebar" class:closed={!open} aria-hidden={!open}>
  <header class="file-sidebar-header">
    <span class="file-sidebar-title">ファイル</span>
    {#if trialMode}
      <span class="file-sidebar-trial-badge">お試し中</span>
    {/if}
    <div class="file-sidebar-spacer"></div>
  </header>

  <div class="file-sidebar-body">
    {#if entries.length === 0}
      <div class="file-sidebar-empty">
        <div class="file-sidebar-empty-text">ファイルがありません</div>
        <button class="file-sidebar-empty-link" onclick={onCreateNew}>新規作成</button>
      </div>
    {:else}
      <ul class="file-list">
        {#each entries as { key, entry } (key)}
          {#if pendingKeys.has(key)}
            <li class="file-row file-row-pending">
              <span class="file-row-pending-text">削除しました</span>
              <button class="file-row-undo" onclick={() => onUndoDelete(key)}>取り消す</button>
            </li>
          {:else}
            <li class="file-row" class:active={key === activeKey}>
              {#if renamingKey === key}
                <div class="file-row-rename">
                  <input
                    class="file-row-rename-input"
                    type="text"
                    bind:this={renameInputEl}
                    bind:value={renameDraft}
                    placeholder={displayName(entry)}
                    onkeydown={(e) => onRenameKeydown(e, key)}
                    onblur={() => commitRename(key)}
                  />
                  <span class="file-row-date">{formatDate(entry.updatedAt)}</span>
                </div>
              {:else}
                <button
                  class="file-row-main"
                  onclick={() => onSelect(key)}
                  ondblclick={() => startRename(key, entry)}
                >
                  <span class="file-row-title">{displayName(entry)}</span>
                  <span class="file-row-date">{formatDate(entry.updatedAt)}</span>
                </button>
                <div class="file-row-actions">
                  <button
                    class="file-row-action"
                    onclick={() => startRename(key, entry)}
                    title="名前を変更"
                    aria-label="名前を変更"
                  >&#x270E;</button>
                  <button
                    class="file-row-action file-row-delete"
                    onclick={() => onDelete(key)}
                    title="削除"
                    aria-label="削除"
                  >&times;</button>
                </div>
              {/if}
            </li>
          {/if}
        {/each}
      </ul>
    {/if}
  </div>

  <footer class="file-sidebar-footer">
    <button class="file-sidebar-trial" onclick={onStartTrial}>お試しモード（保存なし）</button>
  </footer>
</aside>

<style>
  .file-sidebar {
    width: 360px;
    min-width: 360px;
    background: var(--color-bg-elevated);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: width 220ms ease, min-width 220ms ease, border-right-width 220ms ease;
  }

  .file-sidebar.closed {
    width: 0;
    min-width: 0;
    border-right-width: 0;
  }

  .file-sidebar-header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    min-height: 40px;
    padding: 0 12px;
    background: var(--color-bg-elevated);
    border-bottom: 1px solid var(--color-border);
  }

  .file-sidebar-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-muted);
    letter-spacing: 0.05em;
    user-select: none;
  }

  .file-sidebar-trial-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--color-fox-bg);
    color: var(--color-text);
    user-select: none;
  }

  .file-sidebar-spacer {
    flex: 1;
  }

  .file-sidebar-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .file-sidebar-empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--color-text-muted);
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
  }

  .file-sidebar-empty-text {
    font-size: 13px;
  }

  .file-sidebar-empty-link {
    background: transparent;
    border: 1px solid var(--color-border-strong);
    color: var(--color-accent);
    padding: 6px 14px;
    font-size: 12px;
    border-radius: 4px;
    cursor: pointer;
  }

  .file-sidebar-empty-link:hover {
    background: var(--color-surface);
  }

  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .file-row {
    position: relative;
    border-bottom: 1px solid var(--color-border);
  }

  .file-row:hover:not(.file-row-pending) {
    background: var(--color-surface);
  }

  .file-row.active {
    background: var(--color-surface-hover);
    box-shadow: inset 3px 0 0 var(--color-accent);
  }

  .file-row-main {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--color-text);
    padding: 8px 12px;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
  }

  .file-row-title {
    font-size: 13px;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-right: 64px;
  }

  .file-row-date {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .file-row-actions {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: none;
    gap: 4px;
  }

  .file-row:hover .file-row-actions {
    display: flex;
  }

  .file-row-action {
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    color: var(--color-text-faint);
    width: 24px;
    height: 24px;
    padding: 0;
    font-size: 13px;
    cursor: pointer;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .file-row-action:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
    border-color: var(--color-border-strong);
  }

  .file-row-delete:hover {
    color: var(--color-danger-badge);
    border-color: var(--color-danger-badge);
  }

  .file-row-rename {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 12px;
  }

  .file-row-rename-input {
    font-size: 13px;
    padding: 3px 6px;
    background: var(--color-bg-sunken);
    color: var(--color-text);
    border: 1px solid var(--color-accent);
    border-radius: 3px;
    outline: none;
    font-family: inherit;
  }

  .file-row-pending {
    padding: 8px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--color-surface);
    color: var(--color-text-muted);
  }

  .file-row-pending-text {
    font-size: 13px;
    font-style: italic;
  }

  .file-row-undo {
    background: transparent;
    border: 1px solid var(--color-border-strong);
    color: var(--color-accent);
    padding: 3px 10px;
    font-size: 11px;
    border-radius: 3px;
    cursor: pointer;
  }

  .file-row-undo:hover {
    background: var(--color-surface-hover);
  }

  .file-sidebar-footer {
    border-top: 1px solid var(--color-border);
    padding: 6px 8px;
  }

  .file-sidebar-trial {
    width: 100%;
    background: transparent;
    border: 1px dashed var(--color-border-strong);
    color: var(--color-text-muted);
    padding: 6px 10px;
    font-size: 11px;
    border-radius: 4px;
    cursor: pointer;
  }

  .file-sidebar-trial:hover {
    background: var(--color-surface);
    color: var(--color-text);
  }
</style>
