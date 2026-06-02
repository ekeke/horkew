<script lang="ts">
  import type { AnalysisContext } from '../AnalysisContext.svelte.ts'

  const ROLES = ['villager','seer','medium','bodyguard','mason','nekomata','werewolf','possessed','fanatic','werehamster','immoralist'] as const
  const ROLE_SHORT: Record<string, string> = {villager:'村',seer:'占',medium:'霊',bodyguard:'狩',mason:'共',nekomata:'猫',werewolf:'狼',possessed:'狂',fanatic:'信',werehamster:'狐',immoralist:'背'}
  const ROLE_COLORS: Record<string, string> = {villager:'var(--color-village)',seer:'var(--ctp-sapphire)',medium:'var(--ctp-lavender)',bodyguard:'var(--ctp-peach)',mason:'var(--ctp-green)',nekomata:'var(--ctp-pink)',werewolf:'var(--color-wolf)',possessed:'var(--ctp-maroon)',fanatic:'var(--ctp-flamingo)',werehamster:'var(--color-fox)',immoralist:'var(--ctp-rosewater)'}

  type IndexEntry = { file: string, seed: number, result: string, gameLength: number, model?: string, iteration?: number, gitSha?: string, runId?: string }
  type DaySnapshot = {
    global: { aliveCount: number, commander: number | null, demandWolfCoCount: number, aliveParity: number }
    seats: Array<{ alive: boolean, claimedRole?: string, blackCount: number, whiteCount: number, voteReceived: number, suspicion: number, trust: number, executeProposal: number, isCommander: boolean, accuseWolf: number, accuseFox: number, voteIntent: number, nominateCommander: number, planApproved: number, confirmHuman: number, confirmWolf: number, voteFor: number, voteAgainst: number }>
    revote: { round: number, candidates: number[] }
    history: number[]
    plan: { indices: number[] | null, forwardIndices?: number[], endgameIndices?: number[] }
    tsumiTarget: number | null
  }
  type PlayerStep = {
    seat: number
    role: string
    day: number
    myRole: string
    ropeMargin: number | null
    private: { divineResults: Array<[number, string]>, wolfTeamSeats: number[], masonPartner: number | null, guardedSeats: number[], knownHamster: number | null }
    retar: { self: Record<string, string[]> | null, global: Record<string, string[]> | null }
    proposals?: Array<{ type: string, target: number }>
  }
  type InspectGame = {
    seed: number
    result: string
    gameLength: number
    howl: string
    players: Array<{ seat: number, role: string, alive: boolean }>
    timeline: Array<TimelineStep>
    daySnapshots?: Record<string, DaySnapshot>
    playerSteps?: PlayerStep[]
    model?: string
    iteration?: number
    gitSha?: string
  }
  type TimelineStep = {
    seat: number
    role: string
    day: number
    phase: string
    actionHead: string
    actionDescription: string
    actionIdx: number
    logProb: number
    reward: number
    value: number
    done: boolean
    plan?: { indices: number[], description: string, groups: unknown[] }
    predict?: Array<{ seat: number, roles: Array<{ role: string, value: number }> }>
  }

  let { ctx }: { ctx: AnalysisContext } = $props()

  const base = import.meta.env.BASE_URL

  let index = $state<IndexEntry[]>([])
  let loading = $state(true)
  let error = $state('')
  let selectedGameIdx = $state(-1)
  let game = $state<InspectGame | null>(null)
  let gameLoading = $state(false)
  let selectedStepIdx = $state(-1)
  let howlExpanded = $state(false)

  let autoReload = $state(true)
  let autoReloadTimer: ReturnType<typeof setInterval> | null = null

  async function loadIndex() {
    try {
      const res = await fetch(`${base}inspect/index.json`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status}`)
      const newIndex = (await res.json()) as IndexEntry[]
      // 時系列ソート: タイムスタンプ形式ファイル名の降順（新しい順）、それ以外は seed 昇順
      newIndex.sort((a, b) => {
        const aTs = a.file.match(/^\d{14}\.json$/)
        const bTs = b.file.match(/^\d{14}\.json$/)
        if (aTs && bTs) return b.file.localeCompare(a.file)
        if (aTs) return -1
        if (bTs) return 1
        return a.seed - b.seed
      })
      // 選択中のゲームを維持
      const prevSeed = selectedGameIdx >= 0 ? index[selectedGameIdx]?.seed : null
      index = newIndex
      if (prevSeed != null) {
        const newIdx = index.findIndex(e => e.seed === prevSeed)
        if (newIdx >= 0) selectedGameIdx = newIdx
      }
      error = ''
    } catch (e) {
      error = `index.json 読み込み失敗: ${e}`
    } finally {
      loading = false
    }
  }

  function startAutoReload() {
    stopAutoReload()
    autoReloadTimer = setInterval(loadIndex, 5000)
  }

  function stopAutoReload() {
    if (autoReloadTimer) { clearInterval(autoReloadTimer); autoReloadTimer = null }
  }

  $effect(() => {
    if (autoReload) startAutoReload()
    else stopAutoReload()
    return () => stopAutoReload()
  })

  loadIndex()

  async function selectGame(idx: number) {
    selectedGameIdx = idx
    selectedStepIdx = -1
    game = null
    const entry = index[idx]
    if (!entry) return
    gameLoading = true
    try {
      const res = await fetch(`${base}inspect/${entry.file}`)
      if (!res.ok) throw new Error(`${res.status}`)
      game = await res.json()
      if (game?.howl) ctx.loadHowl(game.howl)
    } catch (e) {
      error = `game 読み込み失敗: ${e}`
    } finally {
      gameLoading = false
    }
  }

  /** model フィールドからフェーズ短縮名を抽出 (phase1p_wolf_collective → P1' wolf) */
  function phaseTag(model?: string): string {
    if (!model) return ''
    if (model.startsWith('phase2_')) return 'P2'
    if (model.startsWith('phase1p_')) return "P1'"
    if (model === 'mason_individual') return 'P0'
    // Phase 1 models: village, wolf_collective, etc.
    return 'P1'
  }

  function formatEntryLabel(entry: IndexEntry): string {
    // タイムスタンプ形式 (20260404145000.json) → HH:MM:SS
    const m = entry.file.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.json$/)
    if (m) {
      const prefix = entry.iteration != null ? `i${entry.iteration} ` : ''
      return `${prefix}${m[4]}:${m[5]}:${m[6]}`
    }
    return `#${entry.seed}`
  }

  function resultShort(r: string): string {
    if (r.includes('villager')) return '村'
    if (r.includes('werewolf')) return '狼'
    if (r.includes('hamster')) return '狐'
    return '分'
  }

  function resultClass(r: string): string {
    if (r.includes('villager')) return 'result-village'
    if (r.includes('werewolf')) return 'result-wolf'
    if (r.includes('hamster')) return 'result-fox'
    return 'result-draw'
  }

  let selectedStep = $derived(game && selectedStepIdx >= 0 ? game.timeline[selectedStepIdx] : null)
  let selectedAllPlayerSeat = $state<number | null>(null)
  let selectedAllPlayerDay = $state<number | null>(null)

  // 全 day を統合: playerSteps + timeline を day でマージ
  type DayGroup = {
    day: number
    snapshot: DaySnapshot | null
    players: PlayerStep[]
    mlSteps: Array<TimelineStep & { _idx: number }>
    plan: TimelineStep['plan'] | null
  }
  let mergedDays = $derived.by((): DayGroup[] => {
    if (!game) return []
    const map = new Map<number, DayGroup>()
    const getGroup = (day: number) => {
      let g = map.get(day)
      if (!g) {
        const snap = game!.daySnapshots?.[String(day)] ?? null
        g = { day, snapshot: snap, players: [], mlSteps: [], plan: null }
        map.set(day, g)
      }
      return g
    }
    if (game.playerSteps) {
      for (const s of game.playerSteps) {
        getGroup(s.day).players.push(s)
      }
    }
    for (let i = 0; i < game.timeline.length; i++) {
      const step = game.timeline[i]
      const g = getGroup(step.day)
      g.mlSteps.push({ ...step, _idx: i })
      if (step.actionHead === 'strategy' && !g.plan) {
        g.plan = step.plan ?? null
      }
    }
    for (const g of map.values()) {
      g.players.sort((a, b) => a.seat - b.seat)
    }
    return [...map.values()].sort((a, b) => a.day - b.day)
  })

  // 選択中の day の全プレイヤー (timeline のステップか allPlayerDay から)
  let activeDay = $derived(selectedStep?.day ?? selectedAllPlayerDay)
  let playersForDay = $derived.by(() => {
    if (!game?.playerSteps || activeDay == null) return []
    return game.playerSteps.filter(s => s.day === activeDay).sort((a, b) => a.seat - b.seat)
  })
  let snapshotForDay = $derived(activeDay != null && game?.daySnapshots ? game.daySnapshots[String(activeDay)] ?? null : null)

  // 全プレイヤー表示用 (selectedAllPlayerSeat に対応)
  let selectedPlayerStep = $derived.by(() => {
    if (!selectedAllPlayerSeat || !playersForDay.length) return null
    return playersForDay.find(s => s.seat === selectedAllPlayerSeat) ?? null
  })

  // 報酬収支テーブル: seat × day の報酬合計
  type RewardRow = { seat: number, role: string, byDay: Map<number, number>, total: number }
  let rewardTable = $derived.by((): { rows: RewardRow[], days: number[] } => {
    if (!game) return { rows: [], days: [] }
    const seatMap = new Map<number, RewardRow>()
    const daySet = new Set<number>()
    for (const step of game.timeline) {
      daySet.add(step.day)
      let row = seatMap.get(step.seat)
      if (!row) {
        row = { seat: step.seat, role: step.role, byDay: new Map(), total: 0 }
        seatMap.set(step.seat, row)
      }
      row.byDay.set(step.day, (row.byDay.get(step.day) ?? 0) + step.reward)
      row.total += step.reward
    }
    const days = [...daySet].sort((a, b) => a - b)
    const rows = [...seatMap.values()].sort((a, b) => a.seat - b.seat)
    return { rows, days }
  })

  type PrivateData = PlayerStep['private']

  function planTokenLabel(idx: number): { text: string, cls: string } {
    if (idx < 14) {
      const player = game?.players[idx]
      const name = player ? `${ROLE_SHORT[player.role] || '?'}${idx + 1}` : `seat${idx + 1}`
      return { text: name, cls: 'pt-seat' }
    }
    if (idx < 19) {
      const roles = ['seer','medium','bodyguard','mason','nekomata']
      return { text: ROLE_SHORT[roles[idx - 14]] || roles[idx - 14], cls: 'pt-role' }
    }
    if (idx === 19) return { text: 'grayran', cls: 'pt-gray' }
    if (idx === 20) return { text: 'OR', cls: 'pt-next' }
    if (idx === 21) return { text: '×', cls: 'pt-stop' }
    return { text: `?${idx}`, cls: '' }
  }

  function loadHowlIntoEditor() {
    if (game?.howl) ctx.loadHowl(game.howl)
  }
</script>

<div class="inspect lyk-pane">
  {#if loading}
    <div class="inspect-msg">読み込み中...</div>
  {:else if error}
    <div class="inspect-msg inspect-error">{error}</div>
  {:else if index.length === 0}
    <div class="inspect-msg">
      データなし。<code>npm run inspect -- --seed 42 --count 5 --transformer --strategy-only</code> で生成してください。
    </div>
  {:else}
    <div class="inspect-layout">
      <!-- Left: Game List -->
      <div class="inspect-list">
        <div class="inspect-list-header">
          <span>Games ({index.length})</span>
          <button class="inspect-reload-btn" onclick={loadIndex} title="Reload">R</button>
          <label class="inspect-auto-label" title="Auto-reload (5s)">
            <input type="checkbox" bind:checked={autoReload} />
            Auto
          </label>
        </div>
        {#each index as entry, i}
          <button
            class="inspect-game-item"
            class:active={i === selectedGameIdx}
            onclick={() => selectGame(i)}
          >
            {#if entry.model}<span class="inspect-phase-tag">{phaseTag(entry.model)}</span>{/if}
            <span class="inspect-seed">{formatEntryLabel(entry)}</span>
            <span class="inspect-result {resultClass(entry.result)}">{resultShort(entry.result)}</span>
            <span class="inspect-days">{entry.gameLength}d</span>
          </button>
        {/each}
      </div>

      <!-- Center: Timeline -->
      <div class="inspect-center">
        {#if gameLoading}
          <div class="inspect-msg">読み込み中...</div>
        {:else if game}
          <!-- Phase info bar -->
          {#if game.model || game.iteration != null}
            <div class="inspect-phase-bar">
              {#if game.model}<span class="inspect-phase-tag">{phaseTag(game.model)}</span> <span class="inspect-phase-model">{game.model}</span>{/if}
              {#if game.iteration != null}<span class="inspect-phase-iter">iter {game.iteration}</span>{/if}
              {#if game.gitSha}<span class="inspect-phase-sha">{game.gitSha}</span>{/if}
              <span class="inspect-phase-result">seed={game.seed} {game.result} {game.gameLength}d</span>
            </div>
          {/if}
          <!-- Players bar -->
          <div class="inspect-players">
            {#each game.players as p}
              <span class="inspect-player-chip" class:dead={!p.alive} style="border-color:{ROLE_COLORS[p.role] || 'var(--ctp-overlay0)'}">
                <span style="color:{ROLE_COLORS[p.role]}">{ROLE_SHORT[p.role] || '?'}</span>{p.seat}
              </span>
            {/each}
          </div>

          <!-- Howl log -->
          <div class="inspect-howl-bar">
            <button class="inspect-howl-toggle" onclick={() => howlExpanded = !howlExpanded}>
              Howl Log {howlExpanded ? '[-]' : '[+]'}
            </button>
            <button class="inspect-howl-load" onclick={loadHowlIntoEditor}>
              エディタに読込
            </button>
          </div>
          {#if howlExpanded}
            <pre class="inspect-howl">{game.howl}</pre>
          {/if}

          <!-- Reward breakdown -->
          {#if rewardTable.rows.length > 0}
          <div class="reward-section">
            <div class="inspect-day-header">Reward Breakdown</div>
            <div class="reward-table-wrap">
              <table class="reward-table">
                <thead>
                  <tr>
                    <th>Seat</th>
                    <th>Role</th>
                    {#each rewardTable.days as d}<th>D{d}</th>{/each}
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {#each rewardTable.rows as row}
                    <tr>
                      <td class="rt-seat">{row.seat}</td>
                      <td style="color:{ROLE_COLORS[row.role]}">{ROLE_SHORT[row.role] || '?'}</td>
                      {#each rewardTable.days as d}
                        {@const v = row.byDay.get(d) ?? 0}
                        <td class:positive={v > 0} class:negative={v < 0}>{v !== 0 ? v.toFixed(3) : ''}</td>
                      {/each}
                      <td class="rt-total" class:positive={row.total > 0} class:negative={row.total < 0}>{row.total.toFixed(3)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
          {/if}

          <!-- Day sections: player icons + ML steps -->
          {#each mergedDays as dayGroup}
            <div class="inspect-day-header">Day {dayGroup.day}</div>
            {#if dayGroup.snapshot}
              {@const snap = dayGroup.snapshot}
              <div class="day-global">
                <div class="day-global-row">
                  <span>Alive <b>{snap.global.aliveCount}/14</b></span>
                  {#if dayGroup.players[0]?.ropeMargin != null}<span>Rope <b>{dayGroup.players[0].ropeMargin.toFixed(1)}</b></span>{/if}
                  <span>Parity <b>{snap.global.aliveParity ? 'odd' : 'even'}</b></span>
                  {#if snap.global.commander}<span>Commander <b>seat{snap.global.commander}</b></span>{/if}
                  {#if snap.tsumiTarget}<span>Tsumi <b class="positive">seat{snap.tsumiTarget}</b></span>{/if}
                  {#if snap.revote.round > 0}<span>Revote <b>R{snap.revote.round}</b></span>{/if}
                </div>
                {#if dayGroup.plan || snap.plan.indices?.some(v => v !== 21)}
                  <div class="day-plan-section">
                    {#if dayGroup.plan}
                      <div class="day-plan-row">
                        <span class="day-plan-label">Plan</span>
                        <span class="plan-tokens">{#each dayGroup.plan.indices as idx}{@const pt = planTokenLabel(idx)}<span class="plan-token {pt.cls}">{pt.text}</span>{/each}</span>
                        <span class="plan-groups">{dayGroup.plan.groups.length}s</span>
                      </div>
                    {:else if snap.plan.indices}
                      <div class="day-plan-row">
                        <span class="day-plan-label">Plan</span>
                        <span class="plan-tokens">{#each snap.plan.indices as idx}{@const pt = planTokenLabel(idx)}<span class="plan-token {pt.cls}">{pt.text}</span>{/each}</span>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
            <div class="inspect-day-steps">
              <!-- Player icons -->
              {#if dayGroup.players.length > 0}
                <div class="ap-icon-row">
                  {#each dayGroup.players as ps}
                    <button
                      class="ap-icon"
                      class:active={selectedAllPlayerDay === ps.day && selectedAllPlayerSeat === ps.seat}
                      onclick={() => { selectedAllPlayerDay = ps.day; selectedAllPlayerSeat = ps.seat; selectedStepIdx = -1 }}
                      title="seat{ps.seat} {ps.role}"
                      style="background:color-mix(in srgb, {ROLE_COLORS[ps.role] || 'var(--ctp-overlay0)'} 25%, transparent);color:{ROLE_COLORS[ps.role]}"
                    >{ps.seat}</button>
                  {/each}
                </div>
              {/if}
              <!-- ML steps -->
              {#if dayGroup.mlSteps.length > 0}
                <div class="inspect-step-header">
                  <span class="col-seat">Seat</span>
                  <span class="col-action">Action</span>
                  <span class="col-desc">Description</span>
                  <span class="col-num">Reward</span>
                  <span class="col-num">Value</span>
                </div>
                {#each dayGroup.mlSteps as step}
                  <button
                    class="inspect-step-row"
                    class:active={step._idx === selectedStepIdx}
                    onclick={() => { selectedStepIdx = step._idx; selectedAllPlayerDay = null; selectedAllPlayerSeat = null }}
                  >
                    <span class="col-seat">
                      <span class="seat-badge" style="background:color-mix(in srgb, {ROLE_COLORS[step.role] || 'var(--ctp-overlay0)'} 25%, transparent);color:{ROLE_COLORS[step.role]}">{step.seat}</span>
                      {ROLE_SHORT[step.role] || '?'}
                    </span>
                    <span class="col-action">{step.actionHead}</span>
                    <span class="col-desc">{step.actionDescription}</span>
                    <span class="col-num" class:positive={step.reward > 0} class:negative={step.reward < 0}>
                      {step.reward !== 0 ? step.reward.toFixed(3) : '-'}
                    </span>
                    <span class="col-num val">{step.value != null ? step.value.toFixed(3) : '-'}</span>
                  </button>
                {/each}
              {/if}
            </div>
          {/each}
        {:else}
          <div class="inspect-msg">ゲームを選択してください</div>
        {/if}
      </div>

      <!-- Shared render snippets -->
      {#snippet privateSection(priv: PrivateData)}
        <div class="detail-section">
          <div class="detail-label">Private</div>
          <div class="detail-private">
            {#if priv.divineResults.length > 0}
              <div>Divine: {#each priv.divineResults as [seat, result]}<span class={result === 'wolf' ? 'priv-wolf' : 'priv-human'}>seat{seat}={result}</span> {/each}</div>
            {/if}
            {#if priv.wolfTeamSeats.length > 0}
              <div class="priv-wolf">Wolf: {priv.wolfTeamSeats.map((s: number) => 'seat' + s).join(', ')}</div>
            {/if}
            {#if priv.masonPartner}
              <div class="priv-human">Mason: seat{priv.masonPartner}</div>
            {/if}
            {#if priv.guardedSeats.length > 0}
              <div>Guard: {priv.guardedSeats.map((s: number) => 'seat' + s).join(', ')}</div>
            {/if}
            {#if priv.knownHamster}
              <div style="color:var(--color-fox)">Hamster: seat{priv.knownHamster}</div>
            {/if}
            {#if !priv.divineResults.length && !priv.wolfTeamSeats.length && !priv.masonPartner && !priv.guardedSeats.length && !priv.knownHamster}
              <div class="no-plan">なし</div>
            {/if}
          </div>
        </div>
      {/snippet}

      {#snippet retarHeatmap(retarSelf: Record<string, string[]>, seats: DaySnapshot['seats'], mySeat: number)}
        <div class="detail-section">
          <div class="detail-label">Retar (Self)</div>
          <div class="heatmap" style="grid-template-columns: 2.5rem repeat({ROLES.length}, 1fr)">
            <span></span>
            {#each ROLES as r}
              <span class="hm-header" style="color:{ROLE_COLORS[r]}">{ROLE_SHORT[r]}</span>
            {/each}
            {#each seats as s, i}
              {@const seatNum = i + 1}
              {@const poss = retarSelf[String(seatNum)] ?? []}
              <span class="hm-seat" class:dead={!s.alive}>{seatNum}</span>
              {#each ROLES as r}
                {@const has = poss.includes(r)}
                <span class="hm-cell" class:hm-on={has} class:hm-me={seatNum === mySeat}>{has ? 'O' : ''}</span>
              {/each}
            {/each}
          </div>
        </div>
      {/snippet}

      {#snippet seatsSummary(seats: DaySnapshot['seats'], mySeat?: number)}
        <div class="detail-section">
          <div class="detail-label">Seats</div>
          <div class="detail-seats">
            {#each seats as s, i}
              {@const seatNum = i + 1}
              {#if s.alive || seatNum === mySeat}
                <div class="seat-line" class:dead={!s.alive}>
                  <span class="seat-num">{seatNum}</span>
                  {#if seatNum === mySeat}<span class="seat-me">ME</span>{/if}
                  {#if s.claimedRole}<span style="color:{ROLE_COLORS[s.claimedRole]}">CO:{ROLE_SHORT[s.claimedRole]}</span>{/if}
                  {#if s.blackCount > 0}<span class="priv-wolf">black:{s.blackCount}</span>{/if}
                  {#if s.whiteCount > 0}<span class="priv-human">white:{s.whiteCount}</span>{/if}
                  {#if s.suspicion > 0}<span>sus:{s.suspicion}</span>{/if}
                  {#if s.trust > 0}<span>trust:{s.trust}</span>{/if}
                  {#if s.voteReceived > 0}<span>votes:{s.voteReceived}</span>{/if}
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/snippet}

      <!-- Right: Detail -->
      <div class="inspect-detail">
        {#if selectedStep}
          {@const ps = playersForDay.find(p => p.seat === selectedStep!.seat)}
          <div class="detail-title">Seat {selectedStep.seat} <span style="color:{ROLE_COLORS[selectedStep.role]}">{selectedStep.role}</span></div>

          <!-- ==================== INPUT ==================== -->
          <div class="section-divider">INPUT</div>

          <!-- Private -->
          {#if ps}
            {@render privateSection(ps.private)}
          {/if}

          <!-- Retar heatmap -->
          {#if ps?.retar.self && snapshotForDay}
            {@render retarHeatmap(ps.retar.self, snapshotForDay.seats, ps.seat)}
          {/if}

          <!-- Seats summary -->
          {#if snapshotForDay}
            {@render seatsSummary(snapshotForDay.seats, ps?.seat)}
          {/if}

          <!-- Plan Indices (observation input) -->
          {#if snapshotForDay?.plan.forwardIndices?.some(v => v !== 21)}
            <div class="detail-section">
              <div class="detail-label">Plan (observation)</div>
              <div class="day-plan-row">
                <span class="day-plan-label">Fwd</span>
                <span class="plan-tokens">{#each snapshotForDay.plan.forwardIndices! as idx}{@const pt = planTokenLabel(idx)}<span class="plan-token {pt.cls}">{pt.text}</span>{/each}</span>
              </div>
              {#if snapshotForDay.plan.endgameIndices?.some(v => v !== 21)}
                <div class="day-plan-row">
                  <span class="day-plan-label">End</span>
                  <span class="plan-tokens">{#each snapshotForDay.plan.endgameIndices! as idx}{@const pt = planTokenLabel(idx)}<span class="plan-token {pt.cls}">{pt.text}</span>{/each}</span>
                </div>
              {/if}
            </div>
          {/if}

          <!-- ==================== OUTPUT ==================== -->
          <div class="section-divider">OUTPUT</div>

          <!-- Action -->
          <div class="detail-section">
            <div class="detail-label">Action</div>
            <div class="detail-kv">
              <span class="kv-k">Head</span><span>{selectedStep.actionHead}</span>
              <span class="kv-k">Desc</span><span>{selectedStep.actionDescription}</span>
              <span class="kv-k">logProb</span><span>{selectedStep.logProb != null ? selectedStep.logProb.toFixed(4) : '-'}</span>
              <span class="kv-k">Value</span><span>{selectedStep.value != null ? selectedStep.value.toFixed(4) : '-'}</span>
            </div>
          </div>

          <!-- Plan tokens (output) -->
          {#if selectedStep.plan}
            <div class="detail-section">
              <div class="detail-label">Plan (output)</div>
              <div class="plan-tokens">
                {#each selectedStep.plan.indices as idx}
                  {@const pt = planTokenLabel(idx)}
                  <span class="plan-token {pt.cls}">{pt.text}</span>
                {/each}
              </div>
              <div class="plan-groups">{selectedStep.plan.groups.length} slot(s)</div>
            </div>
          {/if}

          <!-- Predict -->
          {#if selectedStep.predict && selectedStep.predict.length > 0}
            <div class="detail-section">
              <div class="detail-label">Predictions</div>
              <div class="predict-list">
                {#each selectedStep.predict as p}
                  <div class="predict-row">
                    <span class="predict-seat">seat{p.seat}:</span>
                    {#each p.roles as r}
                      <span class="predict-role" style="background:color-mix(in srgb, {ROLE_COLORS[r.role] || 'var(--ctp-overlay0)'} 25%, transparent);color:{ROLE_COLORS[r.role]}">{ROLE_SHORT[r.role]} {(r.value * 100).toFixed(0)}%</span>
                    {/each}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- ==================== OTHER ==================== -->
          <div class="section-divider">REWARD / OTHER</div>

          <div class="detail-section">
            <div class="detail-kv">
              <span class="kv-k">Reward</span><span class:positive={selectedStep.reward > 0} class:negative={selectedStep.reward < 0}>{selectedStep.reward != null ? selectedStep.reward.toFixed(4) : '-'}</span>
            </div>
          </div>

        {:else if selectedPlayerStep}
          <div class="detail-title">Seat {selectedPlayerStep.seat} <span style="color:{ROLE_COLORS[selectedPlayerStep.role]}">{selectedPlayerStep.role}</span> - Day {selectedPlayerStep.day}</div>

          <div class="section-divider">OBSERVATION</div>

          {@render privateSection(selectedPlayerStep.private)}

          {#if selectedPlayerStep.retar.self && snapshotForDay}
            {@render retarHeatmap(selectedPlayerStep.retar.self, snapshotForDay.seats, selectedPlayerStep.seat)}
          {/if}

          {#if snapshotForDay}
            {@render seatsSummary(snapshotForDay.seats, selectedPlayerStep.seat)}
          {/if}

          {#if snapshotForDay?.plan.forwardIndices?.some(v => v !== 21)}
            <div class="detail-section">
              <div class="detail-label">Plan (observation)</div>
              <div class="day-plan-row">
                <span class="day-plan-label">Fwd</span>
                <span class="plan-tokens">{#each snapshotForDay.plan.forwardIndices! as idx}{@const pt = planTokenLabel(idx)}<span class="plan-token {pt.cls}">{pt.text}</span>{/each}</span>
              </div>
              {#if snapshotForDay.plan.endgameIndices?.some(v => v !== 21)}
                <div class="day-plan-row">
                  <span class="day-plan-label">End</span>
                  <span class="plan-tokens">{#each snapshotForDay.plan.endgameIndices! as idx}{@const pt = planTokenLabel(idx)}<span class="plan-token {pt.cls}">{pt.text}</span>{/each}</span>
                </div>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="inspect-msg">ステップを選択してください</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .inspect {
    height: 100%;
    font-size: 0.8rem;
  }
  .inspect-msg {
    padding: 1rem;
    color: var(--ctp-subtext0);
  }
  .inspect-msg code {
    font-size: 0.7rem;
    background: var(--ctp-surface0);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }
  .inspect-error { color: var(--ctp-red); }

  .inspect-layout {
    display: grid;
    grid-template-columns: 140px 1fr 280px;
    height: 100%;
    gap: 1px;
    background: var(--ctp-surface0);
  }

  /* --- Left: Game List --- */
  .inspect-list {
    background: var(--color-bg);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .inspect-list-header {
    padding: 0.3rem 0.5rem;
    font-weight: bold;
    color: var(--color-accent);
    font-size: 0.75rem;
    border-bottom: 1px solid var(--ctp-surface0);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .inspect-list-header span { flex: 1; }
  .inspect-reload-btn {
    border: 1px solid var(--ctp-surface1);
    background: var(--ctp-surface0);
    color: var(--ctp-text);
    cursor: pointer;
    font-size: 0.6rem;
    font-family: inherit;
    width: 18px; height: 18px;
    border-radius: 3px;
    padding: 0;
  }
  .inspect-reload-btn:hover { background: var(--ctp-surface1); }
  .inspect-auto-label {
    font-size: 0.6rem;
    color: var(--ctp-subtext0);
    font-weight: normal;
    display: flex;
    align-items: center;
    gap: 2px;
    cursor: pointer;
  }
  .inspect-auto-label input { margin: 0; width: 12px; height: 12px; }
  .inspect-game-item {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    padding: 0.25rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--ctp-text);
    cursor: pointer;
    text-align: left;
    font-size: 0.7rem;
    font-family: inherit;
  }
  .inspect-game-item:hover { background: var(--ctp-surface0); }
  .inspect-game-item.active { background: var(--ctp-surface1); }
  .inspect-phase-tag {
    font-size: 0.7rem;
    font-weight: bold;
    padding: 0 3px;
    border-radius: 3px;
    background: var(--ctp-surface1);
    color: var(--ctp-mauve);
    flex-shrink: 0;
  }
  .inspect-seed { color: var(--ctp-sapphire); font-weight: bold; }
  .inspect-days { color: var(--ctp-subtext0); margin-left: auto; }
  .result-village { color: var(--color-village); }
  .result-wolf { color: var(--color-wolf); }
  .result-fox { color: var(--color-fox); }
  .result-draw { color: var(--ctp-subtext0); }

  /* --- Center: Phase info bar --- */
  .inspect-phase-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 4px 8px;
    background: var(--ctp-mantle);
    border-radius: 4px;
    font-size: 0.8rem;
    flex-shrink: 0;
  }
  .inspect-phase-model { color: var(--ctp-text); font-weight: 500; }
  .inspect-phase-iter { color: var(--ctp-yellow); }
  .inspect-phase-sha { color: var(--ctp-overlay1); font-family: var(--font-mono); font-size: 0.75rem; }
  .inspect-phase-result { color: var(--ctp-subtext0); margin-left: auto; }

  /* --- Center: Timeline --- */
  .inspect-center {
    background: var(--color-bg);
    overflow-y: auto;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .inspect-players {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    flex-shrink: 0;
  }
  .inspect-player-chip {
    padding: 1px 5px;
    border: 1px solid;
    border-radius: 10px;
    font-size: 0.65rem;
  }
  .inspect-player-chip.dead { opacity: var(--opacity-dead-player); text-decoration: line-through; }

  .inspect-howl-bar {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-shrink: 0;
  }
  .inspect-howl-toggle {
    border: none;
    background: var(--ctp-surface0);
    color: var(--ctp-subtext0);
    cursor: pointer;
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-size: 0.7rem;
    text-align: left;
    font-family: inherit;
  }
  .inspect-howl-toggle:hover { background: var(--ctp-surface1); }
  .inspect-howl-load {
    border: 1px solid var(--ctp-blue);
    background: var(--ctp-blue);
    color: var(--ctp-base);
    cursor: pointer;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    font-size: 0.65rem;
    font-family: inherit;
    font-weight: bold;
  }
  .inspect-howl-load:hover { opacity: 0.85; }
  .inspect-howl {
    white-space: pre-wrap;
    font-size: 0.7rem;
    color: var(--ctp-subtext0);
    background: var(--ctp-mantle);
    padding: 0.5rem;
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
    flex-shrink: 0;
  }

  /* Reward table */
  .reward-section { flex-shrink: 0; }
  .reward-table-wrap { overflow-x: auto; }
  .reward-table {
    border-collapse: collapse;
    font-size: 0.7rem;
    width: 100%;
  }
  .reward-table th, .reward-table td {
    padding: 0.15rem 0.4rem;
    text-align: right;
    border-bottom: 1px solid var(--ctp-mantle);
    white-space: nowrap;
  }
  .reward-table th {
    color: var(--ctp-overlay0);
    font-size: 0.6rem;
    font-weight: normal;
    position: sticky;
    top: 0;
    background: var(--color-bg);
  }
  .reward-table td:first-child, .reward-table th:first-child { text-align: center; }
  .reward-table td:nth-child(2), .reward-table th:nth-child(2) { text-align: left; }
  .rt-seat { font-weight: bold; color: var(--ctp-subtext0); }
  .rt-total { font-weight: bold; }

  /* Day global info */
  .day-global {
    padding: 0.2rem 0.5rem;
    font-size: 0.7rem;
    background: var(--ctp-mantle);
    border-radius: 0 0 3px 3px;
    margin-top: -0.2rem;
  }
  .day-global-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem 0.8rem;
    color: var(--ctp-subtext0);
  }
  .day-global-row b { color: var(--ctp-text); }
  .day-plan-section {
    margin-top: 0.2rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .day-plan-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .day-plan-label {
    font-size: 0.6rem;
    color: var(--ctp-overlay0);
    min-width: 3.5em;
    text-transform: uppercase;
    font-weight: bold;
  }

  .ap-icon-row {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 3px 6px;
    border-bottom: 1px solid var(--ctp-mantle);
  }
  .ap-icon {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid transparent;
    font-size: 0.6rem;
    font-weight: bold;
    font-family: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ap-icon:hover { border-color: var(--ctp-surface2); }
  .ap-icon.active { border-color: var(--ctp-text); outline: 1px solid var(--ctp-text); }

  .inspect-day-header {
    padding: 0.3rem 0.5rem;
    background: var(--ctp-surface0);
    color: var(--color-accent);
    border-radius: 3px;
    font-weight: bold;
    font-size: 0.75rem;
    flex-shrink: 0;
  }
  .inspect-day-steps {
    flex-shrink: 0;
  }
  .inspect-step-header {
    display: grid;
    grid-template-columns: 55px 65px 1fr 55px 55px;
    padding: 0.15rem 0.4rem;
    font-size: 0.6rem;
    color: var(--ctp-overlay0);
  }
  .inspect-step-row {
    display: grid;
    grid-template-columns: 55px 65px 1fr 55px 55px;
    padding: 0.2rem 0.4rem;
    border: none;
    background: transparent;
    color: var(--ctp-text);
    cursor: pointer;
    text-align: left;
    font-size: 0.7rem;
    font-family: inherit;
    border-bottom: 1px solid var(--ctp-mantle);
    align-items: center;
  }
  .inspect-step-row:hover { background: var(--ctp-surface0); }
  .inspect-step-row.active { background: var(--ctp-surface1); }

  .col-seat { display: flex; gap: 3px; align-items: center; }
  .col-action { color: var(--ctp-subtext0); }
  .col-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-num { text-align: right; }
  .col-num.val { color: var(--ctp-subtext0); }
  .positive { color: var(--color-village); }
  .negative { color: var(--color-wolf); }

  .seat-badge {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    font-size: 0.6rem;
    font-weight: bold;
  }

  /* --- Right: Detail --- */
  .inspect-detail {
    background: var(--color-bg);
    overflow-y: auto;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .section-divider {
    font-size: 0.6rem;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ctp-overlay0);
    border-bottom: 1px solid var(--ctp-surface0);
    padding: 0.3rem 0 0.15rem;
    margin-top: 0.3rem;
  }
  .detail-title {
    font-weight: bold;
    color: var(--color-accent);
    font-size: 0.85rem;
  }
  .detail-section {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .detail-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    color: var(--ctp-overlay0);
    letter-spacing: 0.05em;
  }
  .detail-kv {
    display: grid;
    grid-template-columns: 60px 1fr;
    gap: 1px 6px;
    font-size: 0.75rem;
  }
  .kv-k { color: var(--ctp-subtext0); }
  .no-plan { color: var(--ctp-overlay0); font-style: italic; font-weight: normal; }

  .detail-private {
    font-size: 0.7rem;
    padding: 0.2rem 0.4rem;
    background: var(--ctp-mantle);
    border-radius: 3px;
  }
  .priv-wolf { color: var(--color-wolf); }
  .priv-human { color: var(--color-village); }

  /* Heatmap */
  .heatmap {
    display: grid;
    gap: 1px;
    font-size: 0.55rem;
  }
  .hm-header { text-align: center; font-weight: bold; }
  .hm-seat { text-align: right; padding-right: 3px; color: var(--ctp-subtext0); font-weight: bold; }
  .hm-seat.dead { opacity: 0.3; }
  .hm-cell { text-align: center; border-radius: 2px; padding: 1px; }
  .hm-on { background: color-mix(in srgb, var(--color-village) 15%, transparent); color: var(--color-village); }
  .hm-me { outline: 1px solid var(--color-fox); }

  /* Seats summary */
  .detail-seats { font-size: 0.7rem; }
  .seat-line { display: flex; gap: 4px; align-items: center; padding: 1px 0; }
  .seat-line.dead { opacity: var(--opacity-dead-player); }
  .seat-num { font-weight: bold; width: 1.2em; color: var(--ctp-subtext0); }
  .seat-me { font-size: 0.55rem; background: var(--color-fox); color: var(--ctp-base); padding: 0 3px; border-radius: 2px; font-weight: bold; }

  /* Plan tokens */
  .plan-tokens { display: flex; flex-wrap: wrap; gap: 3px; }
  .plan-token {
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.7rem;
  }
  .pt-seat { background: color-mix(in srgb, var(--ctp-sapphire) 20%, transparent); color: var(--ctp-sapphire); }
  .pt-role { background: color-mix(in srgb, var(--color-fox) 20%, transparent); color: var(--color-fox); }
  .pt-gray { background: color-mix(in srgb, var(--color-village) 20%, transparent); color: var(--color-village); }
  .pt-next { color: var(--ctp-overlay0); }
  .pt-stop { color: var(--color-wolf); }
  .plan-groups { font-size: 0.65rem; color: var(--ctp-subtext0); }

  /* Predict */
  .predict-list { font-size: 0.7rem; }
  .predict-row { display: flex; gap: 3px; align-items: center; margin-bottom: 1px; }
  .predict-seat { color: var(--ctp-subtext0); width: 3.5em; }
  .predict-role { padding: 0 4px; border-radius: 2px; font-size: 0.65rem; }
</style>
