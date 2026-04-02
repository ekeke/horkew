<script lang="ts">
  const ROLES = ['villager','seer','medium','bodyguard','mason','nekomata','werewolf','possessed','fanatic','werehamster','immoralist'] as const
  const ROLE_SHORT: Record<string, string> = {villager:'村',seer:'占',medium:'霊',bodyguard:'狩',mason:'共',nekomata:'猫',werewolf:'狼',possessed:'狂',fanatic:'信',werehamster:'狐',immoralist:'背'}
  const ROLE_COLORS: Record<string, string> = {villager:'var(--color-village)',seer:'var(--ctp-sapphire)',medium:'var(--ctp-lavender)',bodyguard:'var(--ctp-peach)',mason:'var(--ctp-green)',nekomata:'var(--ctp-pink)',werewolf:'var(--color-wolf)',possessed:'var(--ctp-maroon)',fanatic:'var(--ctp-flamingo)',werehamster:'var(--color-fox)',immoralist:'var(--ctp-rosewater)'}

  type IndexEntry = { file: string, seed: number, result: string, gameLength: number }
  type InspectGame = {
    seed: number
    result: string
    gameLength: number
    howl: string
    players: Array<{ seat: number, role: string, alive: boolean }>
    timeline: Array<TimelineStep>
    allPlayerSteps?: Array<{ seat: number, role: string, day: number, observation: any }>
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
    observation: any
    planForward?: { indices: number[], description: string, groups: any[] }
    planEndgame?: { indices: number[], description: string, groups: any[] }
    predict?: Array<{ seat: number, roles: Array<{ role: string, value: number }> }>
  }

  let {
    onLoadHowl,
  }: {
    onLoadHowl?: (howl: string) => void
  } = $props()

  const base = import.meta.env.BASE_URL

  let index: IndexEntry[] = $state([])
  let loading = $state(true)
  let error = $state('')
  let selectedGameIdx = $state(-1)
  let game: InspectGame | null = $state(null)
  let gameLoading = $state(false)
  let selectedStepIdx = $state(-1)
  let howlExpanded = $state(false)

  async function loadIndex() {
    try {
      const res = await fetch(`${base}inspect/index.json`)
      if (!res.ok) throw new Error(`${res.status}`)
      index = await res.json()
    } catch (e) {
      error = `index.json 読み込み失敗: ${e}`
    } finally {
      loading = false
    }
  }

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
    } catch (e) {
      error = `game 読み込み失敗: ${e}`
    } finally {
      gameLoading = false
    }
  }

  function resultClass(r: string): string {
    if (r.includes('villager')) return 'result-village'
    if (r.includes('werewolf')) return 'result-wolf'
    if (r.includes('hamster')) return 'result-fox'
    return 'result-draw'
  }

  // タイムラインを day+phase でグループ化
  let groupedTimeline = $derived.by(() => {
    if (!game) return []
    const groups: Array<{ key: string, day: number, phase: string, steps: Array<TimelineStep & { _idx: number }> }> = []
    const map = new Map<string, typeof groups[number]>()
    for (let i = 0; i < game.timeline.length; i++) {
      const step = game.timeline[i]
      const key = `${step.day}-${step.phase}`
      let group = map.get(key)
      if (!group) {
        group = { key, day: step.day, phase: step.phase, steps: [] }
        map.set(key, group)
        groups.push(group)
      }
      group.steps.push({ ...step, _idx: i })
    }
    return groups
  })

  let selectedStep = $derived(game && selectedStepIdx >= 0 ? game.timeline[selectedStepIdx] : null)
  let selectedAllPlayerSeat = $state<number | null>(null)

  // 選択中の day の全プレイヤー observation
  let allPlayerForDay = $derived.by(() => {
    if (!game?.allPlayerSteps || !selectedStep) return []
    return game.allPlayerSteps.filter(s => s.day === selectedStep!.day).sort((a, b) => a.seat - b.seat)
  })

  // 全プレイヤー表示用の observation (selectedAllPlayerSeat に対応)
  let allPlayerObs = $derived.by(() => {
    if (!selectedAllPlayerSeat || !allPlayerForDay.length) return null
    return allPlayerForDay.find(s => s.seat === selectedAllPlayerSeat) ?? null
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

  function planTokenLabel(idx: number): { text: string, cls: string } {
    if (idx < 14) return { text: `seat${idx + 1}`, cls: 'pt-seat' }
    if (idx < 19) {
      const roles = ['seer','medium','bodyguard','mason','nekomata']
      return { text: ROLE_SHORT[roles[idx - 14]] || roles[idx - 14], cls: 'pt-role' }
    }
    if (idx === 19) return { text: 'grayran', cls: 'pt-gray' }
    if (idx === 20) return { text: '|', cls: 'pt-next' }
    if (idx === 21) return { text: 'STOP', cls: 'pt-stop' }
    return { text: `?${idx}`, cls: '' }
  }
</script>

<div class="inspect">
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
        <div class="inspect-list-header">Games ({index.length})</div>
        {#each index as entry, i}
          <button
            class="inspect-game-item"
            class:active={i === selectedGameIdx}
            onclick={() => selectGame(i)}
          >
            <span class="inspect-seed">#{entry.seed}</span>
            <span class="inspect-result {resultClass(entry.result)}">{entry.result.replace('_won', '')}</span>
            <span class="inspect-days">{entry.gameLength}d</span>
          </button>
        {/each}
      </div>

      <!-- Center: Timeline -->
      <div class="inspect-center">
        {#if gameLoading}
          <div class="inspect-msg">読み込み中...</div>
        {:else if game}
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
            {#if onLoadHowl}
              <button class="inspect-howl-load" onclick={() => onLoadHowl!(game!.howl)}>
                エディタに読込
              </button>
            {/if}
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

          <!-- Timeline steps -->
          {#each groupedTimeline as group}
            <div class="inspect-day-header">Day {group.day} - {group.phase}</div>
            <div class="inspect-day-steps">
              <div class="inspect-step-header">
                <span class="col-seat">Seat</span>
                <span class="col-action">Action</span>
                <span class="col-desc">Description</span>
                <span class="col-num">Reward</span>
                <span class="col-num">Value</span>
              </div>
              {#each group.steps as step}
                <button
                  class="inspect-step-row"
                  class:active={step._idx === selectedStepIdx}
                  onclick={() => selectedStepIdx = step._idx}
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
                  <span class="col-num val">{step.value.toFixed(3)}</span>
                </button>
              {/each}
            </div>
          {/each}
        {:else}
          <div class="inspect-msg">ゲームを選択してください</div>
        {/if}
      </div>

      <!-- Right: Detail -->
      <div class="inspect-detail">
        {#if selectedStep}
          {@const obs = selectedStep.observation}
          <div class="detail-title">Seat {selectedStep.seat} ({selectedStep.role})</div>

          <!-- ==================== INPUT ==================== -->
          <div class="section-divider">INPUT</div>

          <!-- Global -->
          <div class="detail-section">
            <div class="detail-label">Global</div>
            <div class="detail-kv">
              <span class="kv-k">Day</span><span>{obs.global.day}</span>
              <span class="kv-k">Phase</span><span>{obs.global.phase}</span>
              <span class="kv-k">My Role</span><span style="color:{ROLE_COLORS[obs.global.myRole]}">{obs.global.myRole} ({ROLE_SHORT[obs.global.myRole] || '?'})</span>
              <span class="kv-k">Alive</span><span>{(obs.global.aliveRatio * 14).toFixed(0)} / 14</span>
              <span class="kv-k">Rope</span><span>{obs.global.ropeMargin.toFixed(1)}</span>
              <span class="kv-k">Parity</span><span>{obs.global.aliveParity ? 'odd' : 'even'}</span>
              <span class="kv-k">Commander</span><span>{obs.global.commander ? `seat${obs.global.commander}` : 'なし'}</span>
              <span class="kv-k">Tsumi</span><span>{obs.tsumi ? `seat${obs.tsumi}` : 'なし'}</span>
              <span class="kv-k">狼CO要求</span><span>{obs.global.demandWolfCoCount}</span>
              <span class="kv-k">Revote</span><span>{obs.revote.round > 0 ? `R${obs.revote.round.toFixed(0)} [${obs.revote.candidates.map((s: number) => s).join(',')}]` : 'なし'}</span>
              <span class="kv-k">Plan</span><span class="exec-plan">{#each [obs.seats.filter((s: any) => s.planIncluded).sort((a: any, b: any) => a.planPosition - b.planPosition)] as planSeats}{#if planSeats.length > 0}{#each planSeats as ps, i}{#if i > 0} → {/if}<span class="plan-seat" style="color:{ROLE_COLORS[game!.players.find((p: any) => p.seat === ps.seat)?.role ?? ''] || 'var(--ctp-text)'}">{ps.seat}</span>{/each}{:else}<span class="no-plan">なし</span>{/if}{/each}</span>
            </div>
          </div>

          <!-- Private -->
          <div class="detail-section">
            <div class="detail-label">Private</div>
            <div class="detail-private">
              {#if obs.private.divineResults.length > 0}
                <div>Divine: {#each obs.private.divineResults as d}<span class={d.result === 'wolf' ? 'priv-wolf' : 'priv-human'}>seat{d.seat}={d.result}</span> {/each}</div>
              {/if}
              {#if obs.private.wolfTeammates.length > 0}
                <div class="priv-wolf">Wolf: {obs.private.wolfTeammates.map((s: number) => 'seat' + s).join(', ')}</div>
              {/if}
              {#if obs.private.masonPartner}
                <div class="priv-human">Mason: seat{obs.private.masonPartner}</div>
              {/if}
              {#if obs.private.guardHistory.length > 0}
                <div>Guard: {obs.private.guardHistory.map((s: number) => 'seat' + s).join(', ')}</div>
              {/if}
              {#if obs.private.knownHamster}
                <div style="color:var(--color-fox)">Hamster: seat{obs.private.knownHamster}</div>
              {/if}
              {#if !obs.private.divineResults.length && !obs.private.wolfTeammates.length && !obs.private.masonPartner && !obs.private.guardHistory.length && !obs.private.knownHamster}
                <div class="no-plan">なし</div>
              {/if}
            </div>
          </div>

          <!-- Retar heatmap -->
          <div class="detail-section">
            <div class="detail-label">Retar (Self)</div>
            <div class="heatmap" style="grid-template-columns: 2.5rem repeat({ROLES.length}, 1fr)">
              <span></span>
              {#each ROLES as r}
                <span class="hm-header" style="color:{ROLE_COLORS[r]}">{ROLE_SHORT[r]}</span>
              {/each}
              {#each obs.seats as s}
                <span class="hm-seat" class:dead={!s.alive}>{s.seat}</span>
                {#each ROLES as r}
                  {@const has = s.retarPossibilities.includes(r)}
                  <span class="hm-cell" class:hm-on={has} class:hm-me={s.isMe}>{has ? 'O' : ''}</span>
                {/each}
              {/each}
            </div>
          </div>

          <!-- Seats summary -->
          <div class="detail-section">
            <div class="detail-label">Seats</div>
            <div class="detail-seats">
              {#each obs.seats as s}
                {#if s.alive || s.isMe}
                  <div class="seat-line" class:dead={!s.alive}>
                    <span class="seat-num">{s.seat}</span>
                    {#if s.isMe}<span class="seat-me">ME</span>{/if}
                    {#if s.claimedRole}<span style="color:{ROLE_COLORS[s.claimedRole]}">CO:{ROLE_SHORT[s.claimedRole]}</span>{/if}
                    {#if s.blackCount > 0}<span class="priv-wolf">black:{s.blackCount.toFixed(0)}</span>{/if}
                    {#if s.whiteCount > 0}<span class="priv-human">white:{s.whiteCount.toFixed(0)}</span>{/if}
                    {#if s.suspicion > 0}<span>sus:{s.suspicion.toFixed(1)}</span>{/if}
                    {#if s.trust > 0}<span>trust:{s.trust.toFixed(1)}</span>{/if}
                    {#if s.voteReceived > 0}<span>votes:{s.voteReceived.toFixed(0)}</span>{/if}
                  </div>
                {/if}
              {/each}
            </div>
          </div>

          <!-- Plan Tokens (input) -->
          {#if obs.planTokens.count > 0}
            <div class="detail-section">
              <div class="detail-label">Plan Tokens ({obs.planTokens.count})</div>
              {#each obs.planTokens.tokens as pt, i}
                <div class="plan-token-input">
                  <span class="plan-token-idx">#{i + 1}</span>
                  <span class="plan-token-targets">targets: [{pt.targetMask.map((v: number, j: number) => v > 0.5 ? j + 1 : null).filter((v: any) => v).join(',')}]</span>
                  <span class="plan-token-type">{['roller','decision','designated','grayran','endgame'][pt.typeOneHot.indexOf(Math.max(...pt.typeOneHot))] ?? '?'}</span>
                </div>
              {/each}
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
              <span class="kv-k">logProb</span><span>{selectedStep.logProb.toFixed(4)}</span>
              <span class="kv-k">Value</span><span>{selectedStep.value.toFixed(4)}</span>
            </div>
          </div>

          <!-- Plan tokens (output) -->
          {#if selectedStep.planForward}
            <div class="detail-section">
              <div class="detail-label">Plan Forward (output)</div>
              <div class="plan-tokens">
                {#each selectedStep.planForward.indices as idx}
                  {@const pt = planTokenLabel(idx)}
                  <span class="plan-token {pt.cls}">{pt.text}</span>
                {/each}
              </div>
              <div class="plan-groups">{selectedStep.planForward.groups.length} group(s)</div>
            </div>
          {/if}
          {#if selectedStep.planEndgame}
            <div class="detail-section">
              <div class="detail-label">Plan Endgame (output)</div>
              <div class="plan-tokens">
                {#each selectedStep.planEndgame.indices as idx}
                  {@const pt = planTokenLabel(idx)}
                  <span class="plan-token {pt.cls}">{pt.text}</span>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Predict -->
          {#if selectedStep.predict && selectedStep.predict.length > 0}
            <div class="detail-section">
              <div class="detail-label">Predictions (&gt;30%)</div>
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
              <span class="kv-k">Reward</span><span class:positive={selectedStep.reward > 0} class:negative={selectedStep.reward < 0}>{selectedStep.reward.toFixed(4)}</span>
            </div>
          </div>

          <!-- All player observations -->
          {#if allPlayerForDay.length > 0}
            <div class="detail-section">
              <div class="detail-label">All Players (Day {selectedStep.day})</div>
              <div class="all-player-tabs">
                {#each allPlayerForDay as ap}
                  <button
                    class="ap-tab"
                    class:active={selectedAllPlayerSeat === ap.seat}
                    onclick={() => selectedAllPlayerSeat = selectedAllPlayerSeat === ap.seat ? null : ap.seat}
                    style="color:{ROLE_COLORS[ap.role]}"
                  >{ROLE_SHORT[ap.role]}{ap.seat}</button>
                {/each}
              </div>
              {#if allPlayerObs}
                {@const aobs = allPlayerObs.observation}
                <div class="ap-detail">
                  <div class="detail-kv">
                    <span class="kv-k">Role</span><span style="color:{ROLE_COLORS[allPlayerObs.role]}">{allPlayerObs.role}</span>
                    <span class="kv-k">Alive</span><span>{(aobs.global.aliveRatio * 14).toFixed(0)} / 14</span>
                    <span class="kv-k">Plan</span><span class="exec-plan">{#each [aobs.seats.filter((s: any) => s.planIncluded).sort((a: any, b: any) => a.planPosition - b.planPosition)] as planSeats}{#if planSeats.length > 0}{#each planSeats as ps, i}{#if i > 0} → {/if}<span class="plan-seat" style="color:{ROLE_COLORS[game!.players.find((p: any) => p.seat === ps.seat)?.role ?? ''] || 'var(--ctp-text)'}">{ps.seat}</span>{/each}{:else}<span class="no-plan">なし</span>{/if}{/each}</span>
                  </div>
                  {#if aobs.private.divineResults.length > 0 || aobs.private.wolfTeammates.length > 0 || aobs.private.masonPartner || aobs.private.knownHamster}
                    <div class="detail-private" style="margin-top:0.3rem">
                      {#if aobs.private.divineResults.length > 0}
                        <div>Divine: {#each aobs.private.divineResults as d}<span class={d.result === 'wolf' ? 'priv-wolf' : 'priv-human'}>seat{d.seat}={d.result}</span> {/each}</div>
                      {/if}
                      {#if aobs.private.wolfTeammates.length > 0}
                        <div class="priv-wolf">Wolf: {aobs.private.wolfTeammates.map((s: number) => 'seat' + s).join(', ')}</div>
                      {/if}
                      {#if aobs.private.masonPartner}
                        <div class="priv-human">Mason: seat{aobs.private.masonPartner}</div>
                      {/if}
                      {#if aobs.private.knownHamster}
                        <div style="color:var(--color-fox)">Hamster: seat{aobs.private.knownHamster}</div>
                      {/if}
                    </div>
                  {/if}
                  <div style="margin-top:0.3rem">
                    <div class="detail-label">Retar (Self)</div>
                    <div class="heatmap" style="grid-template-columns: 2.5rem repeat({ROLES.length}, 1fr)">
                      <span></span>
                      {#each ROLES as r}
                        <span class="hm-header" style="color:{ROLE_COLORS[r]}">{ROLE_SHORT[r]}</span>
                      {/each}
                      {#each aobs.seats as s}
                        <span class="hm-seat" class:dead={!s.alive}>{s.seat}</span>
                        {#each ROLES as r}
                          {@const has = s.retarPossibilities.includes(r)}
                          <span class="hm-cell" class:hm-on={has} class:hm-me={s.isMe}>{has ? 'O' : ''}</span>
                        {/each}
                      {/each}
                    </div>
                  </div>
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
    padding: 0.4rem 0.5rem;
    font-weight: bold;
    color: var(--color-accent);
    font-size: 0.75rem;
    border-bottom: 1px solid var(--ctp-surface0);
    flex-shrink: 0;
  }
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
  .inspect-seed { color: var(--ctp-sapphire); font-weight: bold; }
  .inspect-days { color: var(--ctp-subtext0); margin-left: auto; }
  .result-village { color: var(--color-village); }
  .result-wolf { color: var(--color-wolf); }
  .result-fox { color: var(--color-fox); }
  .result-draw { color: var(--ctp-subtext0); }

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
  .exec-plan { font-weight: bold; }
  .plan-seat { font-weight: bold; }
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
  .plan-token-input { display: flex; gap: 4px; align-items: center; font-size: 0.7rem; padding: 1px 0; }
  .plan-token-idx { color: var(--ctp-overlay0); width: 1.5em; }
  .plan-token-targets { color: var(--ctp-sapphire); }
  .plan-token-type { color: var(--ctp-subtext0); font-style: italic; }

  /* Predict */
  .predict-list { font-size: 0.7rem; }
  .predict-row { display: flex; gap: 3px; align-items: center; margin-bottom: 1px; }
  .predict-seat { color: var(--ctp-subtext0); width: 3.5em; }
  .predict-role { padding: 0 4px; border-radius: 2px; font-size: 0.65rem; }

  /* All player tabs */
  .all-player-tabs { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: 0.3rem; }
  .ap-tab {
    border: 1px solid var(--ctp-surface1);
    background: transparent;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.65rem;
    font-family: inherit;
    cursor: pointer;
    font-weight: bold;
  }
  .ap-tab:hover { background: var(--ctp-surface0); }
  .ap-tab.active { background: var(--ctp-surface1); }
  .ap-detail { font-size: 0.75rem; }
</style>
