<script lang="ts">
  const ROLE_SHORT: Record<string, string> = {villager:'村',seer:'占',medium:'霊',bodyguard:'狩',mason:'共',nekomata:'猫',werewolf:'狼',possessed:'狂',fanatic:'信',werehamster:'狐',immoralist:'背'}
  const ROLE_COLORS: Record<string, string> = {villager:'var(--color-village)',seer:'var(--ctp-sapphire)',medium:'var(--ctp-lavender)',bodyguard:'var(--ctp-peach)',mason:'var(--ctp-green)',nekomata:'var(--ctp-pink)',werewolf:'var(--color-wolf)',possessed:'var(--ctp-maroon)',fanatic:'var(--ctp-flamingo)',werehamster:'var(--color-fox)',immoralist:'var(--ctp-rosewater)'}

  type TopRole = { role: string, prob: number }
  type PredictEntry = { seat: number, top: TopRole[] }

  type Sample = {
    forwardLabel: number[]
    forwardPred: number[]
    forwardMask: boolean[]
    endgameLabel: number[]
    endgamePred: number[]
    endgameMask: boolean[]
    predictLabel?: PredictEntry[]
    predictPred?: PredictEntry[]
    valueLabel?: number
    valuePred?: number
    seat?: number
    role?: string
  }

  type Snapshot = {
    phase: 'B' | 'B2' | 'D'
    epoch: number
    metrics: {
      loss?: number
      accuracy?: number
      nextAccuracy?: number
      stopAccuracy?: number
      predictLoss?: number
      valueLoss?: number
    }
    samples: Sample[]
  }

  type SnapshotFile = {
    timestamp: string
    snapshots: Snapshot[]
  }

  let data: SnapshotFile | null = $state(null)
  let error: string | null = $state(null)
  let loading = $state(true)
  let selectedIdx = $state(0)
  let sampleIdx = $state(0)

  const selected = $derived(data?.snapshots[selectedIdx] ?? null)
  const sample = $derived(selected?.samples[sampleIdx] ?? null)

  const PHASE_COLORS: Record<string, string> = { B: 'var(--ctp-sapphire)', B2: 'var(--ctp-green)', D: 'var(--ctp-peach)' }

  async function loadData() {
    loading = true
    error = null
    try {
      const res = await fetch('pretrain-snapshots.json')
      if (!res.ok) throw new Error(`${res.status}`)
      data = await res.json()
      selectedIdx = 0
      sampleIdx = 0
    } catch (e: any) {
      error = `読み込み失敗: ${e.message}`
      data = null
    } finally {
      loading = false
    }
  }

  $effect(() => { loadData() })

  function planTokenLabel(idx: number): { text: string, cls: string } {
    if (idx < 14) return { text: `seat${idx + 1}`, cls: 'pt-seat' }
    if (idx < 19) {
      const roles = ['seer','medium','bodyguard','mason','nekomata']
      return { text: ROLE_SHORT[roles[idx - 14]] || roles[idx - 14], cls: 'pt-role' }
    }
    if (idx === 19) return { text: 'grayran', cls: 'pt-gray' }
    if (idx === 20) return { text: 'OR', cls: 'pt-next' }
    if (idx === 21) return { text: '×', cls: 'pt-stop' }
    return { text: `?${idx}`, cls: '' }
  }

  function pct(v: number | undefined): string {
    return v != null ? `${(v * 100).toFixed(1)}%` : '-'
  }

  function selectSnapshot(idx: number) {
    selectedIdx = idx
    sampleIdx = 0
  }
</script>

<div class="pretrain">
  {#if loading}
    <div class="pretrain-msg">読み込み中...</div>
  {:else if error}
    <div class="pretrain-msg pretrain-error">{error}</div>
  {:else if !data || data.snapshots.length === 0}
    <div class="pretrain-msg">スナップショットなし</div>
  {:else}
    <!-- Epoch pill bar -->
    <div class="epoch-bar">
      {#each data.snapshots as snap, i}
        <button
          class="epoch-pill"
          class:active={i === selectedIdx}
          style="--phase-color: {PHASE_COLORS[snap.phase]}"
          onclick={() => selectSnapshot(i)}
        >
          {snap.phase}:{snap.epoch}
        </button>
      {/each}
      <button class="reload-btn" onclick={loadData} title="再読み込み">↻</button>
    </div>

    {#if selected}
      <!-- Metrics header -->
      <div class="metrics-header">
        <span class="phase-badge" style="color: {PHASE_COLORS[selected.phase]}">Phase {selected.phase}</span>
        <span>epoch {selected.epoch}</span>
        {#if selected.metrics.accuracy != null}
          <span>acc={pct(selected.metrics.accuracy)}</span>
        {/if}
        {#if selected.metrics.nextAccuracy != null}
          <span>next={pct(selected.metrics.nextAccuracy)}</span>
        {/if}
        {#if selected.metrics.stopAccuracy != null}
          <span>stop={pct(selected.metrics.stopAccuracy)}</span>
        {/if}
        {#if selected.metrics.loss != null}
          <span>loss={selected.metrics.loss.toFixed(4)}</span>
        {/if}
        {#if selected.metrics.predictLoss != null}
          <span>pred_loss={selected.metrics.predictLoss.toFixed(4)}</span>
        {/if}
        {#if selected.metrics.valueLoss != null}
          <span>val_loss={selected.metrics.valueLoss.toFixed(4)}</span>
        {/if}
      </div>

      <!-- Sample navigator -->
      <div class="sample-nav">
        <button onclick={() => { if (sampleIdx > 0) sampleIdx-- }} disabled={sampleIdx === 0}>◀</button>
        <span>Sample {sampleIdx + 1}/{selected.samples.length}</span>
        <button onclick={() => { if (sampleIdx < selected.samples.length - 1) sampleIdx++ }} disabled={sampleIdx >= selected.samples.length - 1}>▶</button>
        {#if sample?.seat != null}
          <span class="sample-info" style="color: {ROLE_COLORS[sample.role ?? ''] ?? 'inherit'}">
            seat{(sample.seat ?? 0) + 1} {ROLE_SHORT[sample.role ?? ''] ?? sample.role}
          </span>
        {/if}
      </div>

      {#if sample}
        <!-- Forward Plan -->
        {#if sample.forwardLabel.length > 0}
          <div class="token-section">
            <div class="token-label">Forward Plan</div>
            <div class="token-row">
              <span class="row-label">Label</span>
              {#each sample.forwardLabel as tok, i}
                {@const t = planTokenLabel(tok)}
                <span class="pt {t.cls}" class:masked={!sample.forwardMask[i]}>{t.text}</span>
              {/each}
            </div>
            <div class="token-row">
              <span class="row-label">Pred</span>
              {#each sample.forwardPred as tok, i}
                {@const t = planTokenLabel(tok)}
                {@const mismatch = sample.forwardMask[i] && tok !== sample.forwardLabel[i]}
                <span class="pt {t.cls}" class:masked={!sample.forwardMask[i]} class:mismatch>{t.text}</span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Endgame Plan -->
        {#if sample.endgameLabel.length > 0}
          <div class="token-section">
            <div class="token-label">Endgame Plan</div>
            <div class="token-row">
              <span class="row-label">Label</span>
              {#each sample.endgameLabel as tok, i}
                {@const t = planTokenLabel(tok)}
                <span class="pt {t.cls}" class:masked={!sample.endgameMask[i]}>{t.text}</span>
              {/each}
            </div>
            <div class="token-row">
              <span class="row-label">Pred</span>
              {#each sample.endgamePred as tok, i}
                {@const t = planTokenLabel(tok)}
                {@const mismatch = sample.endgameMask[i] && tok !== sample.endgameLabel[i]}
                <span class="pt {t.cls}" class:masked={!sample.endgameMask[i]} class:mismatch>{t.text}</span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Predict (Phase D only) -->
        {#if sample.predictLabel && sample.predictPred}
          <div class="token-section">
            <div class="token-label">Predict (per-seat top roles)</div>
            <div class="predict-grid">
              <span class="pg-header"></span>
              <span class="pg-header">Label</span>
              <span class="pg-header">Pred</span>
              {#each sample.predictLabel as entry, i}
                {@const pred = sample.predictPred?.[i]}
                <span class="pg-seat">seat{entry.seat + 1}</span>
                <span class="pg-roles">
                  {#each entry.top as r}
                    <span class="role-chip" style="color:{ROLE_COLORS[r.role] ?? 'inherit'}">{ROLE_SHORT[r.role] ?? r.role} {(r.prob * 100).toFixed(0)}%</span>
                  {/each}
                </span>
                <span class="pg-roles">
                  {#if pred}
                    {#each pred.top as r}
                      <span class="role-chip" style="color:{ROLE_COLORS[r.role] ?? 'inherit'}">{ROLE_SHORT[r.role] ?? r.role} {(r.prob * 100).toFixed(0)}%</span>
                    {/each}
                  {/if}
                </span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Value (Phase D only) -->
        {#if sample.valueLabel != null}
          <div class="token-section">
            <div class="token-label">Value</div>
            <div class="value-row">
              <span>Label: <strong class:positive={sample.valueLabel > 0} class:negative={sample.valueLabel < 0}>{sample.valueLabel.toFixed(3)}</strong></span>
              <span>Pred: <strong class:positive={(sample.valuePred ?? 0) > 0} class:negative={(sample.valuePred ?? 0) < 0}>{sample.valuePred?.toFixed(3) ?? '-'}</strong></span>
            </div>
          </div>
        {/if}
      {/if}
    {/if}
  {/if}
</div>

<style>
  .pretrain {
    font-size: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
  }
  .pretrain-msg { color: var(--ctp-subtext0); padding: 1rem; text-align: center; }
  .pretrain-error { color: var(--color-wolf); }

  /* Epoch pill bar */
  .epoch-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .epoch-pill {
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid var(--ctp-surface1);
    background: transparent;
    color: var(--phase-color);
    font-size: 0.7rem;
    cursor: pointer;
    font-family: 'Consolas', 'Menlo', monospace;
  }
  .epoch-pill:hover { background: var(--ctp-surface0); }
  .epoch-pill.active {
    background: color-mix(in srgb, var(--phase-color) 20%, transparent);
    border-color: var(--phase-color);
    font-weight: bold;
  }
  .reload-btn {
    margin-left: auto;
    padding: 2px 6px;
    border: 1px solid var(--ctp-surface1);
    border-radius: 4px;
    background: transparent;
    color: var(--ctp-subtext0);
    cursor: pointer;
    font-size: 0.75rem;
  }

  /* Metrics header */
  .metrics-header {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 0.75rem;
    color: var(--ctp-subtext0);
    padding: 4px 0;
    border-bottom: 1px solid var(--ctp-surface0);
  }
  .phase-badge { font-weight: bold; }

  /* Sample navigator */
  .sample-nav {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.75rem;
  }
  .sample-nav button {
    padding: 1px 8px;
    border: 1px solid var(--ctp-surface1);
    border-radius: 4px;
    background: transparent;
    color: var(--ctp-text);
    cursor: pointer;
  }
  .sample-nav button:disabled { opacity: 0.3; cursor: default; }
  .sample-info { font-weight: bold; margin-left: 0.5rem; }

  /* Token sections */
  .token-section { margin-top: 0.25rem; }
  .token-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ctp-subtext0);
    margin-bottom: 2px;
  }
  .token-row {
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 2px 0;
  }
  .row-label {
    width: 3rem;
    font-size: 0.65rem;
    color: var(--ctp-subtext0);
    text-align: right;
    flex-shrink: 0;
  }

  /* Plan tokens (reusing InspectPane conventions) */
  .pt {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 0.7rem;
    font-family: 'Consolas', 'Menlo', monospace;
    border: 1px solid transparent;
  }
  .pt-seat { background: color-mix(in srgb, var(--ctp-sapphire) 20%, transparent); color: var(--ctp-sapphire); }
  .pt-role { background: color-mix(in srgb, var(--color-fox) 20%, transparent); color: var(--color-fox); }
  .pt-gray { background: color-mix(in srgb, var(--color-village) 20%, transparent); color: var(--color-village); }
  .pt-next { color: var(--ctp-overlay0); }
  .pt-stop { color: var(--color-wolf); }
  .pt.masked { opacity: 0.3; }
  .pt.mismatch { border-color: var(--color-wolf); border-style: solid; }

  /* Predict grid */
  .predict-grid {
    display: grid;
    grid-template-columns: 3.5rem 1fr 1fr;
    gap: 1px 0.5rem;
    font-size: 0.7rem;
    font-family: 'Consolas', 'Menlo', monospace;
  }
  .pg-header { font-size: 0.6rem; color: var(--ctp-subtext0); text-transform: uppercase; }
  .pg-seat { color: var(--ctp-subtext0); }
  .pg-roles { display: flex; gap: 4px; flex-wrap: wrap; }
  .role-chip {
    font-size: 0.65rem;
  }

  /* Value row */
  .value-row {
    display: flex;
    gap: 1.5rem;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 0.75rem;
  }
  .positive { color: var(--color-village); }
  .negative { color: var(--color-wolf); }
</style>
