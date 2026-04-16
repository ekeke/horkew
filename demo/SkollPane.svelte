<script lang="ts">
  import type { VillageStatus, SystemRole } from '../src/types/index.ts'
  import type { AnalyzeOptions } from '../src/retar/index.ts'
  import { VillageRetar } from '../src/retar/index.ts'
  import { Possibilities, ROLE_COUNT, RoleBitIndex, possibilityFromRoles } from '../src/retar/possibilities.ts'
  import { computeRoleProbabilities, getRoleProbability } from '../src/skoll/index.ts'
  import type { RoleProbabilities } from '../src/skoll/index.ts'
  import { analyzeExecutionsByWorld, type WorldExecutionAnalysis } from '../src/skoll/world-analysis.ts'

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

  let execResult: WorldExecutionAnalysis | null = $state(null)
  let execRunning = $state(false)
  let execError = $state('')
  let execElapsed = $state(0)

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

  function runExecAnalysis() {
    if (!vs || setup.size === 0) return
    execRunning = true
    execError = ''
    execResult = null

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
        const retarResult = retar.analyze()

        const possibilities = new Possibilities(setup)
        for (const [seat, roles] of retarResult.result) {
          possibilities.possibilities[seat] = possibilityFromRoles(roles)
        }

        execResult = analyzeExecutionsByWorld(possibilities, setup, vs!)
        execElapsed = performance.now() - t0
      } catch (e) {
        execError = e instanceof Error ? e.message : String(e)
      } finally {
        execRunning = false
      }
    }, 10)
  }

  function formatWinRate(p: number): string {
    return (p * 100).toFixed(1) + '%'
  }

  function winRateClass(p: number, isBest: boolean): string {
    if (isBest) return 'wr-best'
    if (p === 0) return 'wr-zero'
    if (p >= 0.5) return 'wr-high'
    if (p >= 0.2) return 'wr-mid'
    return 'wr-low'
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

  <div class="exec-section">
    <div class="skoll-controls">
      <button
        class="skoll-btn"
        onclick={runExecAnalysis}
        disabled={execRunning || !vs || setup.size === 0}
      >{execRunning ? '計算中...' : '吊り分析'}</button>
      {#if execResult}
        <span class="skoll-stats">
          {execResult.totalWorlds}{execResult.truncated ? '+' : ''}世界 / {execElapsed.toFixed(1)}ms
          {#if execResult.truncated}
            <span class="skoll-truncated">（打ち切り・近似値）</span>
          {/if}
        </span>
      {/if}
    </div>

    {#if execError}
      <div class="skoll-error">{execError}</div>
    {/if}

    {#if execResult}
      <div class="exec-summary">
        全体勝率: <span class="exec-overall">{formatWinRate(execResult.overallWinRate)}</span>
        / 最善手: <span class="exec-best">{playerName(execResult.bestExecution)}</span>
      </div>

      <div class="skoll-table-wrap">
        <table class="skoll-table">
          <thead>
            <tr>
              <th class="skoll-th-name">吊り候補</th>
              <th class="skoll-th-role">勝率</th>
              <th class="skoll-th-role">バー</th>
            </tr>
          </thead>
          <tbody>
            {#each execResult.executions
              .filter(e => vs!.statuses.get(e.seat)?.surviving)
              .sort((a, b) => b.winRate - a.winRate) as ex}
              {@const isBest = ex.seat === execResult.bestExecution}
              <tr class:exec-best-row={isBest}>
                <td class="skoll-td-name">{playerName(ex.seat)}</td>
                <td class="skoll-td-prob {winRateClass(ex.winRate, isBest)}">
                  {formatWinRate(ex.winRate)}
                </td>
                <td class="exec-bar-cell">
                  <div class="exec-bar" style="width: {Math.max(ex.winRate * 100, 0.5)}%"></div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

    {/if}
  </div>
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

  /* ── 吊り分析セクション ── */

  .exec-section {
    border-top: 1px solid var(--ctp-surface1);
    padding-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .exec-summary {
    font-size: 0.8rem;
    color: var(--ctp-subtext0);
  }

  .exec-overall {
    color: var(--ctp-text);
    font-weight: bold;
  }

  .exec-best {
    color: var(--ctp-green);
    font-weight: bold;
  }

  .exec-best-row {
    background: color-mix(in srgb, var(--ctp-green) 10%, transparent);
  }

  .wr-best {
    color: var(--ctp-green);
    font-weight: bold;
  }

  .wr-zero {
    color: var(--ctp-surface2);
  }

  .wr-high {
    color: var(--ctp-blue);
    font-weight: bold;
  }

  .wr-mid {
    color: var(--ctp-peach);
  }

  .wr-low {
    color: var(--ctp-subtext0);
  }

  .exec-bar-cell {
    width: 100px;
    padding: 0.2rem 0.4rem;
  }

  .exec-bar {
    height: 0.6rem;
    background: var(--ctp-blue);
    border-radius: 2px;
    min-width: 1px;
  }

  .exec-best-row .exec-bar {
    background: var(--ctp-green);
  }

  .branch-details {
    font-size: 0.75rem;
    color: var(--ctp-subtext0);
  }

  .branch-summary {
    cursor: pointer;
    color: var(--ctp-subtext1);
  }

  .branch-summary:hover {
    color: var(--ctp-text);
  }

  .branch-item {
    padding: 0.2rem 0 0.2rem 1rem;
    border-left: 2px solid var(--ctp-surface1);
    margin: 0.2rem 0;
  }

  .branch-header {
    color: var(--ctp-text);
    font-weight: bold;
  }

  .branch-stats {
    color: var(--ctp-subtext0);
  }
</style>
