<script lang="ts">
  import type { SeatStatus, SystemRole, CauseOfDeath, VillageStatus } from '../../src/types/index.ts'
  import { systemRoles } from '../../src/types/index.ts'
  import type { RetarResponse } from '../analysis.worker.ts'
  import AnalysisWorker from '../analysis.worker.ts?worker'

  let { seat, name, status, vs, setup, players, onclose }: {
    seat: number
    name: string
    status: SeatStatus
    vs: VillageStatus
    setup: Map<SystemRole, number>
    players: Map<number, string>
    onclose: () => void
  } = $props()

  let roleName = $derived(
    status.claiming
      ? systemRoles.get(status.claimingRole as SystemRole)?.name ?? status.claimingRole
      : null
  )

  const villageRoles: Set<SystemRole> = new Set(['villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata'])

  type RetarState =
    | { type: 'loading' }
    | { type: 'ok' }
    | { type: 'busted' }
    | { type: 'exposed' }
    | { type: 'error', message: string }

  let retarState: RetarState = $state({ type: 'loading' })

  function serializeVs(v: VillageStatus) {
    const statuses = [...v.statuses].map(([s, st]) => [s, {
      ...st,
      actions: [...st.actions],
      assertions: [...st.assertions],
    }])
    return {
      ...v,
      statuses,
      executions: [...v.executions],
      kills: [...v.kills],
      roles: [...v.roles],
      claims: [...v.claims],
    }
  }

  function runRetarCheck() {
    retarState = { type: 'loading' }

    const assumptions: [number, SystemRole][] = status.claiming
      ? [[seat, status.claimingRole as SystemRole]]
      : []

    const worker = new AnalysisWorker()
    worker.onmessage = (e: MessageEvent<RetarResponse>) => {
      worker.terminate()
      const data = e.data
      if (data.type === 'error') {
        retarState = { type: 'error', message: data.message }
        return
      }

      const seatResult = data.seats.find(s => s.seat === seat)
      if (!seatResult || seatResult.roles.length === 0) {
        retarState = status.claiming ? { type: 'busted' } : { type: 'exposed' }
        return
      }

      if (!status.claiming) {
        const hasVillageRole = seatResult.roles.some(r => {
          const role = systemRoles.get(r)
          return role && role.alignment === 'villager'
        })
        if (!hasVillageRole) {
          retarState = { type: 'exposed' }
          return
        }
      }

      retarState = { type: 'ok' }
    }
    worker.onerror = (e) => {
      worker.terminate()
      retarState = { type: 'error', message: e.message ?? 'Worker error' }
    }

    worker.postMessage({
      vs: serializeVs(vs),
      setup: [...setup],
      players: [...players],
      assumptions,
    })
  }

  $effect(() => {
    // Re-run when seat changes (access seat to track dependency)
    void seat
    runRetarCheck()
  })

  function causeLabel(cause: CauseOfDeath): string {
    switch (cause) {
      case 'execution': return '処刑'
      case 'night_kill': return '襲撃'
      case 'follow_executed_hamster': return '後追い'
      case 'follow_killed_hamster': return '後追い'
      case 'cursed_by_executed_nekomata': return '道連れ'
      case 'cursed_by_killed_nekomata': return '道連れ'
    }
  }

  function onOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onOverlayClick}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <span class="dialog-title">{name}</span>
      <button class="close-btn" onclick={onclose}>&times;</button>
    </div>
    <div class="dialog-body">
      <div class="info-row">
        <span class="label">役職CO</span>
        {#if status.claiming}
          <span class="value claim-value">{roleName}</span>
          {#if status.claimedAt != null}
            <span class="detail">{status.claimedAt}d CO</span>
          {/if}
        {:else}
          <span class="value none">未CO</span>
        {/if}
      </div>
      <div class="info-row">
        <span class="label">状態</span>
        {#if status.surviving}
          <span class="value">生存</span>
        {:else}
          <span class="value dead">{status.diedDay}d {causeLabel(status.causeOfDeath)}</span>
        {/if}
      </div>
      <div class="info-row">
        <span class="label">判定</span>
        {#if retarState.type === 'loading'}
          <span class="value none">解析中...</span>
        {:else if retarState.type === 'busted'}
          <span class="value busted">破綻</span>
        {:else if retarState.type === 'exposed'}
          <span class="value exposed">人外露呈</span>
        {:else if retarState.type === 'error'}
          <span class="value error">エラー</span>
        {:else}
          <span class="value ok">整合</span>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 8px;
    min-width: 280px;
    max-width: 400px;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #313244;
  }

  .dialog-title {
    font-size: 15px;
    font-weight: 600;
    color: #cdd6f4;
  }

  .close-btn {
    background: none;
    border: none;
    color: #585b70;
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .close-btn:hover {
    color: #cdd6f4;
  }

  .dialog-body {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .info-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
  }

  .label {
    color: #a6adc8;
    min-width: 56px;
    flex-shrink: 0;
  }

  .value {
    color: #cdd6f4;
  }

  .claim-value {
    color: #cba6f7;
    font-weight: 600;
  }

  .none {
    color: #585b70;
  }

  .detail {
    color: #585b70;
    font-size: 12px;
  }

  .dead {
    color: #f38ba8;
  }

  .busted {
    color: #f38ba8;
    font-weight: 600;
  }

  .exposed {
    color: #fab387;
    font-weight: 600;
  }

  .ok {
    color: #a6e3a1;
  }

  .error {
    color: #f38ba8;
  }
</style>
