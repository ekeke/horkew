<script lang="ts">
  type Claim = 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata' | 'none'
  type RealRole =
    | 'villager' | 'seer' | 'medium' | 'bodyguard' | 'mason' | 'nekomata'
    | 'werewolf' | 'fanatic' | 'werehamster' | 'immoralist'
  type Result = 'villager_won' | 'werewolf_won' | 'werehamster_won' | 'draw' | 'unknown'

  type Bucket = {
    iter: number
    phase?: string
    games: number
    results: Record<Result, number>
    day1Formation: Record<RealRole, Record<Claim, number>>
  }
  type StatsJson = {
    generatedAt: string
    checkpointBase: string
    totalGames: number
    buckets: Bucket[]
  }

  const ROLES: readonly RealRole[] = [
    'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
    'werewolf', 'fanatic', 'werehamster', 'immoralist',
  ] as const
  const CLAIMS: readonly Claim[] = ['seer', 'medium', 'bodyguard', 'mason', 'nekomata', 'none'] as const

  const ROLE_LABEL: Record<RealRole, string> = {
    villager: '村人', seer: '占い師', medium: '霊能者', bodyguard: '狩人',
    mason: '共有者', nekomata: '猫又', werewolf: '人狼', fanatic: '狂信者',
    werehamster: '妖狐', immoralist: '背徳者',
  }
  const CLAIM_LABEL: Record<Claim, string> = {
    seer: '占', medium: '霊', bodyguard: '狩', mason: '共', nekomata: '猫', none: '潜',
  }
  const RESULT_LABEL: Record<Result, string> = {
    villager_won: '村勝', werewolf_won: '狼勝', werehamster_won: '狐勝', draw: '引分', unknown: '不明',
  }

  const base = import.meta.env.BASE_URL
  let stats: StatsJson | null = $state(null)
  let loading = $state(true)
  let error = $state('')
  let ckptInput = $state('tmp/orch-test28')
  let selectedIter = $state<number | null>(null)

  async function load() {
    loading = true
    error = ''
    try {
      const qs = ckptInput ? `?base=${encodeURIComponent(ckptInput)}` : ''
      const res = await fetch(`${base}stats/day1-formation.json${qs}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      stats = await res.json() as StatsJson
      if (stats.buckets.length > 0 && selectedIter === null) {
        selectedIter = stats.buckets[stats.buckets.length - 1].iter
      }
    } catch (e) {
      error = `${e}`
      stats = null
    } finally {
      loading = false
    }
  }

  load()

  const selectedBucket = $derived(
    stats?.buckets.find(b => b.iter === selectedIter) ?? null
  )

  function rowSum(row: Record<Claim, number>): number {
    let s = 0
    for (const c of CLAIMS) s += row[c] ?? 0
    return s
  }

  function pct(n: number, total: number): string {
    if (total === 0) return '-'
    return ((n / total) * 100).toFixed(0) + '%'
  }

  function cellClass(n: number, total: number): string {
    if (total === 0) return ''
    const p = n / total
    if (p >= 0.6) return 'heavy'
    if (p >= 0.3) return 'medium'
    if (p >= 0.1) return 'light'
    return ''
  }
</script>

<div class="stats">
  <div class="controls">
    <label>
      checkpoint base:
      <input type="text" bind:value={ckptInput} placeholder="tmp/orch-run-31" />
    </label>
    <button onclick={load}>Reload</button>
    {#if stats}
      <span class="meta">{stats.totalGames} games / {stats.buckets.length} iters</span>
    {/if}
  </div>

  {#if loading}
    <div class="msg">読み込み中...</div>
  {:else if error}
    <div class="msg error">{error}</div>
  {:else if !stats || stats.buckets.length === 0}
    <div class="msg">データなし</div>
  {:else}
    <div class="iter-bar">
      {#each stats.buckets as b}
        <button
          class="iter-btn"
          class:active={b.iter === selectedIter}
          onclick={() => selectedIter = b.iter}
        >
          {b.phase ? b.phase + ' ' : ''}i{b.iter}
        </button>
      {/each}
    </div>

    {#if selectedBucket}
      <div class="result-bar">
        {#each (['villager_won', 'werewolf_won', 'werehamster_won', 'draw'] as Result[]) as r}
          <span class="result-chip {r}">
            {RESULT_LABEL[r]}: {selectedBucket.results[r]} ({pct(selectedBucket.results[r], selectedBucket.games)})
          </span>
        {/each}
      </div>

      <table class="formation">
        <thead>
          <tr>
            <th>真役職 \ CO</th>
            {#each CLAIMS as c}<th>{CLAIM_LABEL[c]}</th>{/each}
            <th>計</th>
          </tr>
        </thead>
        <tbody>
          {#each ROLES as role}
            {@const row = selectedBucket.day1Formation[role]}
            {@const total = rowSum(row)}
            <tr>
              <td class="role-label">{ROLE_LABEL[role]}</td>
              {#each CLAIMS as c}
                <td class={cellClass(row[c], total)}>
                  {#if total > 0}
                    <div class="cell-pct">{pct(row[c], total)}</div>
                    <div class="cell-n">{row[c]}</div>
                  {:else}
                    -
                  {/if}
                </td>
              {/each}
              <td class="total">{total}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</div>

<style>
  .stats { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; font-family: system-ui, -apple-system, sans-serif; font-size: 0.85rem; }
  .controls { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .controls input { flex: 1; min-width: 10rem; padding: 0.2rem 0.4rem; background: var(--ctp-surface0); color: var(--ctp-text); border: 1px solid var(--ctp-overlay0); border-radius: 3px; }
  .controls button { padding: 0.2rem 0.6rem; background: var(--ctp-surface1); color: var(--ctp-text); border: 1px solid var(--ctp-overlay0); border-radius: 3px; cursor: pointer; }
  .controls button:hover { background: var(--ctp-surface2); }
  .meta { color: var(--ctp-subtext0); font-size: 0.75rem; }

  .msg { padding: 0.5rem; color: var(--ctp-subtext0); }
  .msg.error { color: var(--ctp-red); font-family: 'Consolas', 'Menlo', monospace; font-size: 0.75rem; white-space: pre-wrap; }

  .iter-bar { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .iter-btn { padding: 0.15rem 0.5rem; background: var(--ctp-surface0); color: var(--ctp-subtext0); border: 1px solid var(--ctp-overlay0); border-radius: 3px; cursor: pointer; font-family: 'Consolas', 'Menlo', monospace; font-size: 0.75rem; }
  .iter-btn:hover { background: var(--ctp-surface1); }
  .iter-btn.active { background: var(--ctp-blue); color: var(--ctp-base); border-color: var(--ctp-blue); }

  .result-bar { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .result-chip { padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.75rem; background: var(--ctp-surface0); color: var(--ctp-text); border: 1px solid var(--ctp-overlay0); }
  .result-chip.villager_won { border-color: var(--color-village); }
  .result-chip.werewolf_won { border-color: var(--color-wolf); }
  .result-chip.werehamster_won { border-color: var(--color-fox); }

  table.formation { border-collapse: collapse; width: 100%; font-family: 'Consolas', 'Menlo', monospace; font-size: 0.8rem; }
  table.formation th, table.formation td { border: 1px solid var(--ctp-overlay0); padding: 0.2rem 0.4rem; text-align: center; }
  table.formation th { background: var(--ctp-surface1); color: var(--ctp-text); font-weight: 600; }
  table.formation td.role-label { text-align: left; background: var(--ctp-surface0); color: var(--ctp-subtext1); }
  table.formation td.total { color: var(--ctp-subtext0); }
  .cell-pct { font-weight: 600; }
  .cell-n { font-size: 0.65rem; color: var(--ctp-subtext0); }
  td.light { background: color-mix(in srgb, var(--ctp-blue) 15%, transparent); }
  td.medium { background: color-mix(in srgb, var(--ctp-blue) 35%, transparent); }
  td.heavy { background: color-mix(in srgb, var(--ctp-red) 50%, transparent); color: var(--ctp-base); }
</style>
