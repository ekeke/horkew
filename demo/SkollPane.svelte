<script lang="ts">
  import type { VillageStatus, SystemRole } from '../src/types/index.ts'
  import type { AnalyzeOptions } from '../src/retar/index.ts'
  import { VillageRetar } from '../src/retar/index.ts'
  import { defaultAnalyzeRegulation } from '../src/retar/defaults.ts'
  import { Possibilities, RoleBitIndex, possibilityFromRoles } from '../src/retar/possibilities.ts'
  import { computeRoleProbabilities, getRoleProbability } from '../src/skoll/index.ts'
  import type { RoleProbabilities } from '../src/skoll/index.ts'
  import { analyzeExecutionsByWorld, type WorldExecutionAnalysis } from '../src/skoll/world-analysis.ts'
  import { estimateWorldCount, estimateRuntimeMs, type WorldEstimate } from '../src/skoll/estimate.ts'
  import {
    loadSkollNetworkByPerspective,
    runSkollNNInference,
    type Perspective,
    type CheckpointMeta,
  } from './skoll-nn.ts'
  import type { AnyNetwork } from '../src/fenrir/src/ml/nn.ts'
  import type { UnifiedVoteAnalysis } from '../src/skoll/unified.ts'

  let {
    vs,
    setup,
    players,
    publicEvents = [],
  }: {
    vs: VillageStatus | null
    setup: Map<SystemRole, number>
    players: Map<number, string>
    publicEvents?: readonly import('../src/lupa/types.ts').GameEvent[]
  } = $props()

  let result: RoleProbabilities | null = $state(null)
  let running = $state(false)
  let error = $state('')
  let elapsed = $state(0)

  let execResult: WorldExecutionAnalysis | null = $state(null)
  let execRunning = $state(false)
  let execError = $state('')
  let execElapsed = $state(0)

  /** 「吊り分析」を回す前に表示する世界数の見積もり。retar 結果が要るので
   *  「確率計算」ボタン (= retar を回す) と同時に算出する */
  let worldEstimate: WorldEstimate | null = $state(null)

  // === NN-skoll (5 perspective supported) ===
  const perspectives: Perspective[] = ['mason', 'wolf', 'fanatic', 'hamster', 'immoralist']
  const perspectiveLabels: Record<Perspective, string> = {
    mason: '共有', wolf: '狼', fanatic: '狂信', hamster: '狐', immoralist: '背徳',
  }
  let nnPerspective = $state<Perspective>('mason')
  let nnNetwork: AnyNetwork | null = $state(null)
  let nnMeta: CheckpointMeta | null = $state(null)
  let nnLoadError = $state('')
  let nnLoading = $state(false)
  let nnResult: UnifiedVoteAnalysis | null = $state(null)
  let nnRunning = $state(false)
  let nnError = $state('')
  let nnElapsed = $state(0)
  /** 視点 seat (NN 推論用) */
  let nnViewerSeat = $state<number | null>(null)
  /** mason: partner / immoralist: 狐 / 単一指定用 */
  let nnPartnerSeat = $state<number | null>(null)
  /** wolf: 他の wolf 席 / fanatic: 知っている狼席 */
  let nnTeamSeatsStr = $state('')

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
          regulation: defaultAnalyzeRegulation,
          seerClaimingDueDate: 2,
          mediumClaimingDueDate: 2,
          bodyguardClaimingDueDate: 99,
          masonClaimingDueDate: 2,
          nekomataClaimingDueDate: 99,
          dayCountFrom: 1,
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
        worldEstimate = estimateWorldCount(possibilities, setup)
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
          regulation: defaultAnalyzeRegulation,
          seerClaimingDueDate: 2,
          mediumClaimingDueDate: 2,
          bodyguardClaimingDueDate: 99,
          masonClaimingDueDate: 2,
          nekomataClaimingDueDate: 99,
          dayCountFrom: 1,
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

  function formatLargeNumber(n: number): string {
    if (!isFinite(n)) return '∞'
    if (n < 1_000) return n.toFixed(0)
    if (n < 1_000_000) return (n / 1_000).toFixed(1) + 'K'
    if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    return (n / 1_000_000_000).toFixed(1) + 'B'
  }

  function winRateClass(p: number, isBest: boolean): string {
    if (isBest) return 'wr-best'
    if (p === 0) return 'wr-zero'
    if (p >= 0.5) return 'wr-high'
    if (p >= 0.2) return 'wr-mid'
    return 'wr-low'
  }

  // === NN-skoll handlers ===

  /** perspective キャッシュ: 一度ロードしたモデルは再利用 */
  const nnCache = new Map<Perspective, { network: AnyNetwork, meta: CheckpointMeta }>()

  async function loadSelectedPerspective() {
    const hit = nnCache.get(nnPerspective)
    if (hit) {
      nnNetwork = hit.network
      nnMeta = hit.meta
      nnLoadError = ''
      return
    }
    nnLoadError = ''
    nnLoading = true
    try {
      const { network, meta } = await loadSkollNetworkByPerspective(nnPerspective)
      nnCache.set(nnPerspective, { network, meta })
      nnNetwork = network
      nnMeta = meta
    } catch (e) {
      nnLoadError = e instanceof Error ? e.message : String(e)
      nnNetwork = null
      nnMeta = null
    } finally {
      nnLoading = false
    }
  }

  // perspective 変更 (および初期 mount) で自動的に該当モデルを load
  $effect(() => {
    void nnPerspective  // subscribe
    nnResult = null
    loadSelectedPerspective()
  })

  function parseSeatList(s: string): number[] {
    return s.split(/[,\s]+/).map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0)
  }

  function aliveSeatList(): number[] {
    if (!vs) return []
    return [...vs.statuses.entries()]
      .filter(([, s]) => s.surviving)
      .map(([seat]) => seat)
      .sort((a, b) => a - b)
  }

  function runNn() {
    if (!nnNetwork || !vs || setup.size === 0) return
    nnRunning = true
    nnError = ''
    nnResult = null

    setTimeout(() => {
      try {
        const t0 = performance.now()
        const options: AnalyzeOptions = {
          regulation: defaultAnalyzeRegulation,
          seerClaimingDueDate: 2,
          mediumClaimingDueDate: 2,
          bodyguardClaimingDueDate: 99,
          masonClaimingDueDate: 2,
          nekomataClaimingDueDate: 99,
          dayCountFrom: 1,
          assumptions: new Map(),
          wolfPairDenyals: [],
          hocusPocus: new Map(),
          id: 0,
          batches: 1,
          batch: 0,
        }
        const retar = new VillageRetar(vs!, setup, options)
        const retarResult = retar.analyze()

        const alive = aliveSeatList()
        if (alive.length === 0) throw new Error('no alive seats')
        const viewer = nnViewerSeat ?? alive[0]
        if (!alive.includes(viewer)) throw new Error(`viewer seat ${viewer} not alive`)

        const teamList = parseSeatList(nnTeamSeatsStr)
        nnResult = runSkollNNInference(nnNetwork!, {
          perspective: nnPerspective,
          vs: vs!,
          setup,
          globalPossibilities: retarResult.result,
          viewerSeat: viewer,
          partnerSeat: nnPerspective === 'mason' ? nnPartnerSeat : null,
          teamSeats: nnPerspective === 'wolf' ? [viewer, ...teamList.filter(s => s !== viewer)] : undefined,
          knownWolves: nnPerspective === 'fanatic' ? teamList : undefined,
          knownHamster: nnPerspective === 'immoralist' ? nnPartnerSeat : null,
          publicEvents,
        })
        nnElapsed = performance.now() - t0
      } catch (e) {
        nnError = e instanceof Error ? e.message : String(e)
      } finally {
        nnRunning = false
      }
    }, 10)
  }

  function formatPct(p: number): string {
    return (p * 100).toFixed(1) + '%'
  }

  function nnProbClass(p: number, isBest: boolean): string {
    if (isBest) return 'wr-best'
    if (p < 0.01) return 'wr-zero'
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
          実測: {execResult.totalWorlds}{execResult.truncated ? '+' : ''}世界 / {execElapsed.toFixed(1)}ms
          {#if execResult.truncated}
            <span class="skoll-truncated">（打ち切り・近似値）</span>
          {/if}
        </span>
      {/if}
    </div>

    {#if worldEstimate}
      <div class="estimate-line" title="Bregman-Minc permanent 上限。actual ≤ upperBound。">
        見積上限: ~{formatLargeNumber(worldEstimate.upperBound)}世界 / ~{estimateRuntimeMs(worldEstimate).toFixed(0)}ms
        <span class="estimate-detail">(alive {worldEstimate.aliveSeats}席, avg {worldEstimate.avgPossibilities.toFixed(1)} roles/seat)</span>
      </div>
    {/if}

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

  <!-- ── NN-skoll (5 perspective) ── -->
  <div class="exec-section">
    <div class="nn-header">NN-skoll ({perspectiveLabels[nnPerspective]}視点)</div>

    <div class="skoll-controls">
      <label>
        視点:
        <select bind:value={nnPerspective}>
          {#each perspectives as p}
            <option value={p}>{perspectiveLabels[p]}</option>
          {/each}
        </select>
      </label>
      {#if nnLoading}
        <span class="skoll-stats">読込中...</span>
      {:else if nnMeta}
        <span class="skoll-stats">
          iter {nnMeta.iteration} / {new Date(nnMeta.timestamp).toLocaleString()}
        </span>
      {/if}
    </div>

    {#if nnLoadError}
      <div class="skoll-error">load error: {nnLoadError}</div>
    {/if}

    {#if nnNetwork && vs}
      <div class="nn-config">
        <label>
          {nnPerspective === 'mason' ? '共有席'
            : nnPerspective === 'wolf' ? '狼自席'
            : nnPerspective === 'fanatic' ? '狂信席'
            : nnPerspective === 'hamster' ? '狐席'
            : '背徳席'}:
          <select bind:value={nnViewerSeat}>
            {#each aliveSeatList() as seat}
              <option value={seat}>{playerName(seat)}</option>
            {/each}
          </select>
        </label>

        {#if nnPerspective === 'mason'}
          <label>
            partner:
            <select bind:value={nnPartnerSeat}>
              <option value={null}>(不明)</option>
              {#each aliveSeatList() as seat}
                {#if seat !== nnViewerSeat}
                  <option value={seat}>{playerName(seat)}</option>
                {/if}
              {/each}
            </select>
          </label>
        {:else if nnPerspective === 'wolf'}
          <label>
            仲間狼席 (カンマ区切り):
            <input type="text" bind:value={nnTeamSeatsStr} placeholder="例: 2,5" />
          </label>
        {:else if nnPerspective === 'fanatic'}
          <label>
            知ってる狼席 (カンマ区切り):
            <input type="text" bind:value={nnTeamSeatsStr} placeholder="例: 2,5,9" />
          </label>
        {:else if nnPerspective === 'immoralist'}
          <label>
            知ってる狐席:
            <select bind:value={nnPartnerSeat}>
              <option value={null}>(未指定)</option>
              {#each aliveSeatList() as seat}
                {#if seat !== nnViewerSeat}
                  <option value={seat}>{playerName(seat)}</option>
                {/if}
              {/each}
            </select>
          </label>
        {/if}

        <button
          class="skoll-btn"
          onclick={runNn}
          disabled={nnRunning || setup.size === 0}
        >{nnRunning ? '推論中...' : 'NN 推論'}</button>
        {#if nnResult}
          <span class="skoll-stats">{nnElapsed.toFixed(1)}ms</span>
        {/if}
      </div>
    {/if}

    {#if nnError}
      <div class="skoll-error">{nnError}</div>
    {/if}

    {#if nnResult}
      <div class="exec-summary">
        NN 最善: <span class="exec-best">{nnResult.bestVote !== null ? playerName(nnResult.bestVote) : '—'}</span>
        {#if execResult && nnPerspective === 'mason'}
          / Skoll 最善: <span class="exec-best">{playerName(execResult.bestExecution)}</span>
          {#if nnResult.bestVote === execResult.bestExecution}
            <span class="nn-match">✓ 一致</span>
          {:else}
            <span class="nn-mismatch">✗ 不一致</span>
          {/if}
        {/if}
      </div>

      <div class="skoll-table-wrap">
        <table class="skoll-table">
          <thead>
            <tr>
              <th class="skoll-th-name">投票候補</th>
              <th class="skoll-th-role">NN 確率</th>
              <th class="skoll-th-role">バー</th>
            </tr>
          </thead>
          <tbody>
            {#each [...nnResult.candidates].sort((a, b) => b.score - a.score) as c}
              {@const isBest = c.seat === nnResult!.bestVote}
              <tr class:exec-best-row={isBest} class:excluded-row={c.excluded}>
                <td class="skoll-td-name">
                  {playerName(c.seat)}
                  {#if c.excluded}<span class="excluded-badge">除外</span>{/if}
                </td>
                <td class="skoll-td-prob {nnProbClass(c.score, isBest)}">{formatPct(c.score)}</td>
                <td class="exec-bar-cell">
                  <div class="exec-bar nn-bar" style="width: {Math.max(c.score * 100, 0.5)}%"></div>
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

  /* ── 見積もり ── */

  .estimate-line {
    font-size: 0.8rem;
    color: var(--ctp-mauve);
    padding: 0.2rem 0;
  }

  .estimate-detail {
    color: var(--ctp-subtext0);
    font-size: 0.7rem;
  }

  /* ── NN-skoll セクション ── */

  .nn-header {
    font-weight: bold;
    color: var(--ctp-mauve);
    font-size: 0.9rem;
  }

  .nn-config {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--ctp-subtext0);
  }

  .nn-config select {
    padding: 0.15rem 0.3rem;
    border: 1px solid var(--ctp-surface1);
    border-radius: 3px;
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    font-size: 0.8rem;
  }

  .nn-bar {
    background: var(--ctp-mauve);
  }

  .exec-best-row .nn-bar {
    background: var(--ctp-green);
  }

  .nn-match {
    color: var(--ctp-green);
    font-weight: bold;
  }

  .nn-mismatch {
    color: var(--ctp-peach);
    font-weight: bold;
  }

  .excluded-row {
    opacity: 0.5;
  }

  .excluded-badge {
    display: inline-block;
    margin-left: 0.3rem;
    padding: 0 0.3rem;
    font-size: 0.65rem;
    background: var(--ctp-surface1);
    color: var(--ctp-subtext0);
    border-radius: 2px;
  }

  .nn-config input[type="text"] {
    padding: 0.15rem 0.3rem;
    border: 1px solid var(--ctp-surface1);
    border-radius: 3px;
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    font-size: 0.8rem;
    width: 6rem;
    font-family: 'Consolas', 'Menlo', monospace;
  }
</style>
