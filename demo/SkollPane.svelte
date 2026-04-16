<script lang="ts">
  import type { VillageStatus, SystemRole } from '../src/types/index.ts'
  import type { AnalyzeOptions } from '../src/retar/index.ts'
  import { VillageRetar } from '../src/retar/index.ts'
  import { Possibilities, ROLE_COUNT, RoleBitIndex, possibilityFromRoles } from '../src/retar/possibilities.ts'
  import { computeRoleProbabilities, getRoleProbability } from '../src/skoll/index.ts'
  import type { RoleProbabilities } from '../src/skoll/index.ts'

  let {
    vs,
    setup,
    players,
  }: {
    vs: VillageStatus | null
    setup: Map<SystemRole, number>
    players: Map<number, string>
  } = $props()

  let result: RoleProbabilities | null = $state(null)
  let running = $state(false)
  let error = $state('')
  let elapsed = $state(0)

  /** setup に含まれる role 一覧（表示列用） */
  let activeRoles: SystemRole[] = $derived(
    [...setup.keys()].sort((a, b) => RoleBitIndex[a] - RoleBitIndex[b])
  )

  /** 全 seat 一覧（生存→死亡の順、各グループ内は seat 昇順） */
  let allSeats: { seat: number, alive: boolean }[] = $derived(
    vs ? [...vs.statuses.entries()]
      .map(([seat, st]) => ({ seat, alive: st.surviving }))
      .sort((a, b) => a.alive !== b.alive ? (a.alive ? -1 : 1) : a.seat - b.seat) : []
  )

  function playerName(seat: number): string {
    return players.get(seat) ?? `${seat}`
  }

  function runSkoll() {
    if (!vs || setup.size === 0) return
    running = true
    error = ''
    result = null

    setTimeout(() => {
      try {
        const t0 = performance.now()
        const options: AnalyzeOptions = {
          seerClaimingDueDate: 2,
          mediumClaimingDueDate: 2,
          bodyguardClaimingDueDate: 99,
          masonClaimingDueDate: 2,
          nekomataClaimingDueDate: 99,
          dayCountFrom: 1,
          hasFirstGhost: false,
          assumptions: new Map(),
          wolfPairDenyals: [],
          hocusPocus: new Map(),
          id: 0,
          batches: 1,
          batch: 0,
        }
        const retar = new VillageRetar(vs!, setup, options)
        const analyzeResult = retar.analyze()

        const possibilities = new Possibilities(setup)
        for (const [seat, roles] of analyzeResult.result) {
          possibilities.possibilities[seat] = possibilityFromRoles(roles)
        }

        result = computeRoleProbabilities(possibilities, setup)
        elapsed = performance.now() - t0
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        running = false
      }
    }, 10)
  }

  function formatProb(p: number): string {
    if (p === 0) return ''
    const pct = p * 100
    if (pct === 100) return '100'
    return pct.toFixed(1)
  }

  function probClass(p: number): string {
    if (p === 0) return 'prob-zero'
    if (p === 1) return 'prob-certain'
    if (p >= 0.5) return 'prob-high'
    if (p >= 0.2) return 'prob-mid'
    return 'prob-low'
  }

  const roleLabel: Record<string, string> = {
    villager: '村', seer: '占', medium: '霊', bodyguard: '狩',
    mason: '共', nekomata: '猫', werewolf: '狼', possessed: '狂',
    fanatic: '信', werehamster: '狐', immoralist: '背',
  }
</script>

<div class="skoll-pane">
  <div class="skoll-controls">
    <button
      class="skoll-btn"
      onclick={runSkoll}
      disabled={running || !vs || setup.size === 0}
    >{running ? '計算中...' : '確率計算'}</button>
    {#if result}
      <span class="skoll-stats">
        {result.totalWorlds}{result.truncated ? '+' : ''}世界 / {elapsed.toFixed(1)}ms
        {#if result.truncated}
          <span class="skoll-truncated">（打ち切り・近似値）</span>
        {/if}
      </span>
    {/if}
  </div>

  {#if error}
    <div class="skoll-error">{error}</div>
  {/if}

  {#if result}
    <div class="skoll-table-wrap">
      <table class="skoll-table">
        <thead>
          <tr>
            <th class="skoll-th-name">Player</th>
            {#each activeRoles as role}
              <th class="skoll-th-role">{roleLabel[role] ?? role}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each allSeats as { seat, alive }}
            <tr class:dead-row={!alive}>
              <td class="skoll-td-name">{playerName(seat)}</td>
              {#each activeRoles as role}
                {@const p = getRoleProbability(result, seat, role)}
                <td class="skoll-td-prob {probClass(p)}">{formatProb(p)}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .skoll-pane {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    height: 100%;
    overflow: auto;
    font-size: 0.85rem;
  }

  .skoll-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .skoll-btn {
    padding: 0.3rem 0.8rem;
    border: 1px solid var(--ctp-surface1);
    border-radius: 4px;
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    cursor: pointer;
    font-size: 0.85rem;
  }

  .skoll-btn:hover:not(:disabled) {
    background: var(--ctp-surface1);
  }

  .skoll-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .skoll-stats {
    font-size: 0.7rem;
    color: var(--ctp-subtext0);
  }

  .skoll-error {
    color: var(--ctp-red);
    font-size: 0.85rem;
  }

  .skoll-truncated {
    color: var(--ctp-peach);
  }

  .skoll-table-wrap {
    overflow: auto;
    flex: 1;
  }

  .skoll-table {
    border-collapse: collapse;
    width: 100%;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 0.8rem;
  }

  .skoll-table th,
  .skoll-table td {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--ctp-surface1);
    text-align: center;
  }

  .skoll-th-name,
  .skoll-td-name {
    text-align: left;
    white-space: nowrap;
    color: var(--ctp-text);
    font-weight: bold;
    position: sticky;
    left: 0;
    background: var(--ctp-base);
  }

  .skoll-th-role {
    color: var(--ctp-subtext0);
    font-weight: normal;
    font-size: 0.75rem;
  }

  .dead-row {
    opacity: 0.4;
  }

  .prob-zero {
    color: var(--ctp-surface2);
  }

  .prob-certain {
    color: var(--ctp-green);
    font-weight: bold;
  }

  .prob-high {
    color: var(--ctp-red);
    font-weight: bold;
  }

  .prob-mid {
    color: var(--ctp-peach);
  }

  .prob-low {
    color: var(--ctp-subtext0);
  }
</style>
