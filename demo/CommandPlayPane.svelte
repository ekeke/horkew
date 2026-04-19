<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { SystemRole } from '../src/types/index.ts'
  import { systemRoles } from '../src/types/index.ts'
  import type {
    Command, CommandAdapterExt,
  } from '../src/fenrir/src/adapters/command/command-types.ts'
  import {
    commandPlayStore,
    type CommandPlayStoreState,
  } from './commandPlayStore.ts'

  // ==========================================================
  // 役職プリセット: 14D猫のみ（るる鯛標準）
  // ==========================================================

  const PRESET_14D_NEKO: { label: string, roles: Record<string, number>, hasFirstGhost: boolean } = {
    label: '14D猫（占1 霊1 狩1 共2 猫1 村2 狼3 信1 狐1 背1）',
    roles: {
      seer: 1, medium: 1, bodyguard: 1, mason: 2, nekomata: 1, villager: 2,
      werewolf: 3, fanatic: 1, werehamster: 1, immoralist: 1,
    },
    hasFirstGhost: true,
  }

  // 人間が選択できる役職と、全席操作か 1 席操作かの区別
  const HUMAN_ROLE_OPTIONS: Array<{ value: SystemRole, label: string, multiSeat: boolean }> = [
    { value: 'seer', label: '占い師', multiSeat: false },
    { value: 'medium', label: '霊能者', multiSeat: false },
    { value: 'bodyguard', label: '狩人', multiSeat: false },
    { value: 'nekomata', label: '猫又', multiSeat: false },
    { value: 'mason', label: '共有（2 席を 1 人で操作）', multiSeat: true },
    { value: 'villager', label: '村人', multiSeat: false },
    { value: 'werewolf', label: '人狼（3 席を 1 人で操作）', multiSeat: true },
    { value: 'fanatic', label: '狂信者', multiSeat: false },
    { value: 'werehamster', label: '妖狐', multiSeat: false },
    { value: 'immoralist', label: '背徳者', multiSeat: false },
  ]

  // ==========================================================
  // Store 購読
  // ==========================================================

  let state: CommandPlayStoreState = $state(commandPlayStore.getState())

  const unsub = commandPlayStore.subscribe(s => { state = s })
  onDestroy(unsub)

  // ==========================================================
  // ゲーム開始設定
  // ==========================================================

  let selectedRole: SystemRole = $state('villager')
  let seedInput: string = $state('')
  let startError: string | null = $state(null)

  async function onStartGame() {
    startError = null
    const roleConfig = new Map<SystemRole, number>(
      Object.entries(PRESET_14D_NEKO.roles) as [SystemRole, number][],
    )
    const seed = seedInput ? Number.parseInt(seedInput, 10) : undefined
    try {
      await commandPlayStore.startGame({
        humanRole: selectedRole,
        roles: roleConfig,
        hasFirstGhost: PRESET_14D_NEKO.hasFirstGhost,
        seed: Number.isFinite(seed) ? seed : undefined,
      })
    } catch (e) {
      startError = String(e instanceof Error ? e.message : e)
    }
  }

  function onResetGame() {
    commandPlayStore.reset()
  }

  // ==========================================================
  // Derived
  // ==========================================================

  const pending = $derived(state.pending)
  const gameState = $derived(state.gameState)
  const ext = $derived(gameState?.ext as CommandAdapterExt | undefined)
  const currentSeat = $derived(pending?.mySeat ?? null)
  const currentRole = $derived(
    currentSeat !== null && state.seatRoles
      ? (state.seatRoles.get(currentSeat) ?? null)
      : null,
  )
  const phaseLabel = $derived(ext?.currentPhase ?? '—')
  const commanderSeat = $derived(ext?.commander ?? null)

  function formatRole(role: SystemRole | null | undefined): string {
    if (!role) return '—'
    return systemRoles.get(role)?.shortName ?? role
  }

  /** 席番号 → プレイヤー名（fallback: 席N） */
  function nameOf(seat: number | null | undefined): string {
    if (seat == null) return '—'
    const p = gameState?.players.find(pl => pl.seat === seat)
    return p?.name ?? `席${seat}`
  }

  function formatCommand(cmd: Command): string {
    switch (cmd.type) {
      case 'skip': return 'スキップ'
      case 'cco_skip': return 'CCO スキップ'
      case 'no_action': return '行動なし'
      case 'divine': return `占い: ${nameOf(cmd.target)}`
      case 'guard': return `護衛: ${nameOf(cmd.target)}`
      case 'attack': return `襲撃: ${nameOf(cmd.target)}`
      case 'role_co':
        return `CO: ${describeClaim(cmd.claim)}`
      case 'role_result_report':
        return `結果: ${describeClaim(cmd.claim)}`
      case 'cco_full':
        return `CCO(遺言): ${describeClaim(cmd.claim)}`
      case 'cco_villain_reveal':
        return `自白: ${formatRole(cmd.trueRole)}`
      case 'request_co':
        return `${requestCoLabel(cmd.category)} CO 要求`
      case 'designate_execution':
        return `吊り指定: ${nameOf(cmd.target)}`
      case 'designate_runoff':
        return `ラン指定: ${cmd.targets.map(nameOf).join(' / ')}`
      case 'vote':
        return `投票: ${nameOf(cmd.target)}`
      default:
        return JSON.stringify(cmd)
    }
  }

  /** DayClaim の詳細を 1 行に整形（partner/target/results 等も表示） */
  function describeClaim(claim: unknown): string {
    const c = claim as Record<string, unknown>
    const base = claimTypeLabel(String(c.type))
    switch (c.type) {
      case 'seer_co': {
        const results = (c.results as Array<{ target: number, result: string }> | undefined) ?? []
        if (results.length === 0) return base
        const rs = results.map(r => `${nameOf(r.target)}${r.result === 'wolf' ? '●' : '○'}`).join(' ')
        return `${base} (${rs})`
      }
      case 'medium_co': {
        const pastResults = c.pastResults as string[] | undefined
        if (pastResults && pastResults.length > 0) {
          return `${base} (${pastResults.map(r => r === 'wolf' ? '●' : '○').join('')})`
        }
        return base
      }
      case 'bodyguard_co': {
        const targets = (c.targets as number[] | undefined) ?? []
        return targets.length > 0 ? `${base} (${targets.map(nameOf).join(', ')})` : base
      }
      case 'mason_co':
        return `${base} 相方=${nameOf(c.partner as number)}`
      case 'seer_result':
        return `${base} ${nameOf(c.target as number)} ${c.result === 'wolf' ? '●' : '○'}`
      case 'medium_result':
        return `${base} ${c.result === 'wolf' ? '●' : '○'}`
      case 'forecast':
        return `予告: ${nameOf(c.target as number)}`
      default:
        return base
    }
  }

  function claimTypeLabel(t: string): string {
    const map: Record<string, string> = {
      seer_co: '占い CO', medium_co: '霊能 CO', bodyguard_co: '狩人 CO',
      mason_co: '共有 CO', nekomata_co: '猫又 CO',
      seer_result: '占い結果', medium_result: '霊能結果',
      forecast: '予告', none: '無し',
    }
    return map[t] ?? t
  }

  function requestCoLabel(cat: string): string {
    const map: Record<string, string> = {
      seer: '占い', medium: '霊能', bodyguard: '狩人',
      nekomata: '猫又', nekomata_bodyguard_grelan: '猫狩ギドラ',
    }
    return map[cat] ?? cat
  }

  function submitCommand(cmd: Command) {
    commandPlayStore.submit(cmd)
  }

  function resultLabel(r: CommandPlayStoreState['result']): string {
    switch (r) {
      case 'villager_won': return '村勝利'
      case 'werewolf_won': return '狼勝利'
      case 'werehamster_won': return '狐勝利'
      case 'draw': return '引き分け'
      default: return '—'
    }
  }
</script>

<div class="command-play">

  <!-- セットアップ -->
  {#if !state.running && !state.finished}
    <section class="setup">
      <h3>新ゲーム設定</h3>
      <div class="row">
        <label>
          構成: <span class="preset">{PRESET_14D_NEKO.label}</span>
        </label>
      </div>
      <div class="row">
        <label>
          役職:
          <select bind:value={selectedRole}>
            {#each HUMAN_ROLE_OPTIONS as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </label>
        <label>
          seed（空欄=ランダム）:
          <input type="text" bind:value={seedInput} placeholder="例: 42" />
        </label>
        <button onclick={onStartGame}>ゲーム開始</button>
      </div>
      {#if startError}
        <div class="error">エラー: {startError}</div>
      {/if}
    </section>
  {/if}

  <!-- 実行中フェーズ情報（最小限） -->
  {#if state.running && gameState}
    <section class="state">
      <div class="state-header">
        <span class="phase">Day {gameState.day} / {phaseLabel}</span>
        {#if commanderSeat !== null}
          <span class="commander">Commander: {nameOf(commanderSeat)}</span>
        {/if}
        <span class="hint">※ ゲーム進行はエディタ（お試しモード）に反映されます</span>
      </div>
    </section>
  {/if}

  <!-- 手番 UI -->
  {#if pending}
    <section class="turn">
      <div class="turn-header">
        <strong>手番: {nameOf(pending.mySeat)}</strong>
        <span class="role">（あなたの役職: {formatRole(currentRole)}）</span>
      </div>
      <div class="commands">
        {#each pending.legal as cmd, i (i)}
          <button class="cmd-btn" onclick={() => submitCommand(cmd)}>
            {formatCommand(cmd)}
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <!-- 終了表示 -->
  {#if state.finished}
    <section class="result-box">
      <div class="result-header">
        <span class="result">結果: {resultLabel(state.result)}</span>
        <button onclick={onResetGame}>新しいゲーム</button>
      </div>
    </section>
  {/if}

</div>

<style>
  .command-play {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 8px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
  }

  h3 {
    margin: 0 0 6px 0;
    font-size: 13px;
    color: var(--color-text-muted);
  }

  section {
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 8px;
    background: var(--color-surface);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  label {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  input[type="text"] {
    width: 80px;
    padding: 2px 4px;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 3px;
  }

  select {
    padding: 2px 4px;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 3px;
  }

  button {
    padding: 4px 10px;
    background: var(--ctp-sapphire);
    color: var(--color-bg);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-weight: 600;
  }

  button:hover {
    filter: brightness(1.1);
  }

  .state-header {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 6px;
    font-weight: 600;
  }

  .phase {
    color: var(--ctp-peach);
  }

  .commander {
    color: var(--ctp-green);
  }

  .result {
    color: var(--ctp-flamingo);
    font-size: 14px;
  }

  .result-header {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .hint {
    color: var(--color-text-muted);
    font-size: 11px;
    font-weight: normal;
  }

  .preset {
    color: var(--ctp-sapphire);
    font-weight: 600;
  }

  .turn-header {
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--color-border);
  }

  .role {
    color: var(--color-text-muted);
    margin-left: 8px;
  }

  .commands {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: 300px;
    overflow-y: auto;
  }

  .cmd-btn {
    font-size: 11px;
    background: var(--ctp-surface1);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    padding: 3px 8px;
  }

  .cmd-btn:hover {
    background: var(--ctp-sapphire);
    color: var(--color-bg);
  }

  .error {
    margin-top: 6px;
    padding: 4px 8px;
    background: var(--ctp-red);
    color: var(--color-bg);
    border-radius: 3px;
  }
</style>
