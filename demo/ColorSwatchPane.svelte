<script lang="ts">
  const palette = [
    { label: 'Crust',     var: '--ctp-crust',    hex: '#11111b' },
    { label: 'Mantle',    var: '--ctp-mantle',    hex: '#181825' },
    { label: 'Base',      var: '--ctp-base',      hex: '#1e1e2e' },
    { label: 'Surface 0', var: '--ctp-surface0',  hex: '#313244' },
    { label: 'Surface 1', var: '--ctp-surface1',  hex: '#45475a' },
    { label: 'Surface 2', var: '--ctp-surface2',  hex: '#585b70' },
    { label: 'Overlay 0', var: '--ctp-overlay0',  hex: '#6c7086' },
    { label: 'Overlay 1', var: '--ctp-overlay1',  hex: '#7f849c' },
    { label: 'Subtext 0', var: '--ctp-subtext0',  hex: '#a6adc8' },
    { label: 'Subtext 1', var: '--ctp-subtext1',  hex: '#bac2de' },
    { label: 'Text',      var: '--ctp-text',      hex: '#cdd6f4' },
  ] as const

  const accents = [
    { label: 'Rosewater', var: '--ctp-rosewater', hex: '#f5e0dc' },
    { label: 'Flamingo',  var: '--ctp-flamingo',  hex: '#f2cdcd' },
    { label: 'Pink',      var: '--ctp-pink',      hex: '#f5c2e7' },
    { label: 'Mauve',     var: '--ctp-mauve',     hex: '#cba6f7' },
    { label: 'Red',       var: '--ctp-red',       hex: '#f38ba8' },
    { label: 'Maroon',    var: '--ctp-maroon',    hex: '#eba0ac' },
    { label: 'Peach',     var: '--ctp-peach',     hex: '#fab387' },
    { label: 'Yellow',    var: '--ctp-yellow',    hex: '#f9e2af' },
    { label: 'Green',     var: '--ctp-green',     hex: '#a6e3a1' },
    { label: 'Teal',      var: '--ctp-teal',      hex: '#94e2d5' },
    { label: 'Sky',       var: '--ctp-sky',       hex: '#89dceb' },
    { label: 'Sapphire',  var: '--ctp-sapphire',  hex: '#74c7ec' },
    { label: 'Blue',      var: '--ctp-blue',      hex: '#89b4fa' },
    { label: 'Lavender',  var: '--ctp-lavender',  hex: '#b4befe' },
  ] as const

  const semantic = [
    { section: 'Layout' },
    { label: 'bg',             var: '--color-bg',             ref: '--ctp-base' },
    { label: 'bg-elevated',    var: '--color-bg-elevated',    ref: '--ctp-mantle' },
    { label: 'bg-sunken',      var: '--color-bg-sunken',      ref: '--ctp-crust' },
    { label: 'surface',        var: '--color-surface',        ref: '--ctp-surface0' },
    { label: 'surface-hover',  var: '--color-surface-hover',  ref: '--ctp-surface1' },
    { label: 'border',         var: '--color-border',         ref: '--ctp-surface0' },
    { label: 'border-strong',  var: '--color-border-strong',  ref: '--ctp-surface1' },
    { section: 'Text' },
    { label: 'text',           var: '--color-text',           ref: '--ctp-text' },
    { label: 'text-muted',     var: '--color-text-muted',     ref: '--ctp-subtext0' },
    { label: 'text-faint',     var: '--color-text-faint',     ref: '--ctp-surface2' },
    { label: 'text-overlay',   var: '--color-text-overlay',   ref: '--ctp-overlay0' },
    { section: 'Interactive' },
    { label: 'accent',         var: '--color-accent',         ref: '--ctp-mauve' },
    { label: 'focus-ring',     var: '--color-focus-ring',     ref: '--ctp-mauve' },
    { label: 'link',           var: '--color-link',           ref: '--ctp-blue' },
    { section: 'Domain: 陣営' },
    { label: 'village',        var: '--color-village',        ref: '--ctp-green' },
    { label: 'wolf',           var: '--color-wolf',           ref: '--ctp-red' },
    { label: 'fox',            var: '--color-fox',            ref: '--ctp-yellow' },
    { label: 'unknown-team',   var: '--color-unknown-team',   ref: '--ctp-mauve' },
    { section: 'Domain: 判定' },
    { label: 'human-result',   var: '--color-human-result',   ref: '--ctp-green' },
    { label: 'wolf-result',    var: '--color-wolf-result',    ref: '--ctp-red' },
    { section: 'Domain: イベント' },
    { label: 'role',           var: '--color-role',           ref: '--ctp-yellow' },
    { label: 'co',             var: '--color-co',             ref: '--ctp-mauve' },
    { label: 'execution',      var: '--color-execution',      ref: '--ctp-peach' },
    { label: 'vote-arrow',     var: '--color-vote-arrow',     ref: '--ctp-blue' },
    { label: 'player-resolved', var: '--color-player-resolved', ref: '--ctp-teal' },
    { section: 'Feedback' },
    { label: 'error',          var: '--color-error',          ref: '--ctp-red' },
    { label: 'danger-bg',      var: '--color-danger-bg',      ref: '--ctp-red' },
    { label: 'danger-text',    var: '--color-danger-text',    ref: '--ctp-base' },
  ] as const

  type PaletteEntry = { label: string, var: string, hex: string }
  type SemanticEntry = { label: string, var: string, ref: string }
  type SectionEntry = { section: string }

  let copied = $state('')

  function copyVar(varName: string) {
    navigator.clipboard.writeText(`var(${varName})`)
    copied = varName
    setTimeout(() => { if (copied === varName) copied = '' }, 1500)
  }

  function isSection(entry: PaletteEntry | SemanticEntry | SectionEntry): entry is SectionEntry {
    return 'section' in entry
  }
</script>

<div class="swatch-pane">
  <h3 class="section-title">Palette — Base</h3>
  <div class="swatch-grid">
    {#each palette as c}
      <button class="swatch-item" onclick={() => copyVar(c.var)} title="Copy var({c.var})">
        <span class="swatch-color" style="background: var({c.var})"></span>
        <span class="swatch-info">
          <span class="swatch-label">{c.label}</span>
          <code class="swatch-var" class:copied={copied === c.var}>{c.var}</code>
          <code class="swatch-hex">{c.hex}</code>
        </span>
      </button>
    {/each}
  </div>

  <h3 class="section-title">Palette — Accents</h3>
  <div class="swatch-grid">
    {#each accents as c}
      <button class="swatch-item" onclick={() => copyVar(c.var)} title="Copy var({c.var})">
        <span class="swatch-color" style="background: var({c.var})"></span>
        <span class="swatch-info">
          <span class="swatch-label">{c.label}</span>
          <code class="swatch-var" class:copied={copied === c.var}>{c.var}</code>
          <code class="swatch-hex">{c.hex}</code>
        </span>
      </button>
    {/each}
  </div>

  <h3 class="section-title">Semantic Tokens</h3>
  <div class="semantic-list">
    {#each semantic as entry}
      {#if isSection(entry)}
        <h4 class="semantic-section">{entry.section}</h4>
      {:else}
        <button class="semantic-item" onclick={() => copyVar(entry.var)} title="Copy var({entry.var})">
          <span class="swatch-color small" style="background: var({entry.var})"></span>
          <code class="swatch-var" class:copied={copied === entry.var}>{entry.var}</code>
          <span class="semantic-ref">→ {entry.ref}</span>
        </button>
      {/if}
    {/each}
  </div>
</div>

<style>
  .swatch-pane {
    padding: 12px;
    font-size: 12px;
    overflow-y: auto;
    height: 100%;
  }

  .section-title {
    margin: 0 0 8px 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ctp-mauve, #cba6f7);
  }

  .swatch-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 4px;
    margin-bottom: 16px;
  }

  .swatch-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
  }

  .swatch-item:hover {
    background: var(--ctp-surface0, #313244);
  }

  .swatch-color {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    flex-shrink: 0;
    border: 1px solid var(--ctp-surface1, #45475a);
  }

  .swatch-color.small {
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }

  .swatch-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .swatch-label {
    font-weight: 500;
    color: var(--ctp-text, #cdd6f4);
    font-size: 12px;
  }

  .swatch-var {
    color: var(--ctp-subtext0, #a6adc8);
    font-size: 10px;
    font-family: 'Consolas', 'Menlo', monospace;
    transition: color 0.2s;
  }

  .swatch-var.copied {
    color: var(--ctp-green, #a6e3a1);
  }

  .swatch-hex {
    color: var(--ctp-surface2, #585b70);
    font-size: 10px;
    font-family: 'Consolas', 'Menlo', monospace;
  }

  .semantic-list {
    margin-bottom: 16px;
  }

  .semantic-section {
    margin: 12px 0 4px 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--ctp-subtext0, #a6adc8);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .semantic-section:first-child {
    margin-top: 0;
  }

  .semantic-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    width: 100%;
  }

  .semantic-item:hover {
    background: var(--ctp-surface0, #313244);
  }

  .semantic-ref {
    color: var(--ctp-surface2, #585b70);
    font-size: 10px;
    margin-left: auto;
  }
</style>
