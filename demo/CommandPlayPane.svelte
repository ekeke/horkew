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
  const currentSeat = $derived(pending?.mySeat ?? null)
  const currentRole = $derived(
    currentSeat !== null && state.seatRoles
      ? (state.seatRoles.get(currentSeat) ?? null)
      : null,
  )

  /**
   * ライブ更新対象のビュー。gameState.ext は in-place で mutate されるので
   * tick を読んで毎 tick 新しいオブジェクトを返すことで、下流の description 表示が追随する。
   */
  const view = $derived.by(() => {
    void state.tick
    const gs = state.gameState
    const ext = gs?.ext as CommandAdapterExt | undefined
    const day = gs?.day ?? 0
    const phase = ext?.currentPhase ?? '—'
    const commander = ext?.commander ?? null
    // 現在処理中の席: フェーズに応じた「今誰が決めているか」の推定
    let activeSeat: number | null = null
    if (ext) {
      switch (ext.currentPhase) {
        case 'discussion': activeSeat = ext.discussionQueue[0] ?? null; break
        case 'commander': activeSeat = ext.commander ?? null; break
        case 'cco': activeSeat = ext.ccoQueue[0] ?? null; break
        case 'night':
        case 'vote':
          activeSeat = null  // 全員並行処理
          break
      }
    }
    return { gs, ext, day, phase, commander, activeSeat }
  })

  const phaseLabel = $derived(view.phase)
  const commanderSeat = $derived(view.commander)
  const activeSeat = $derived(view.activeSeat)

  /** フェーズの日本語ラベル */
  function phaseJa(p: string): string {
    switch (p) {
      case 'night': return '夜'
      case 'discussion': return '議論'
      case 'commander': return '指揮'
      case 'cco': return 'CCO'
      case 'vote': return '投票'
      default: return p
    }
  }

  /** 占い師の報告テーブル行 */
  type SeerReportRow = {
    seat: number
    alive: boolean
    /** 自分が実際に占ったときの日（divineHistory の key）。未占なら null */
    divineDay: number | null
    /** 自分が実際に占ったときの結果（divineHistory から）。未占なら null */
    trueResult: 'human' | 'wolf' | null
    humanCmd: Command | null
    wolfCmd: Command | null
    forecastCmd: Command | null
  }

  /**
   * 占い師の結果報告コマンドをテーブル行にまとめる。
   * pending が占い師の結果報告タイミング（role_result_report with seer_result/forecast を含む）のときに row を生成。
   * 並び順: 占い済み席を divineDay 降順（直近が最上段）、未占席は seat 昇順で下段。
   */
  const seerReportTable = $derived.by((): SeerReportRow[] => {
    void state.tick
    if (!pending || !gameState) return []
    const me = gameState.players.find(p => p.seat === pending.mySeat)
    if (!me || me.role !== 'seer') return []

    // 自分の divine 履歴（target → {day, result}）。target ごとに直近の占いを採用
    const trueMap = new Map<number, { day: number, result: 'human' | 'wolf' }>()
    for (const [day, entry] of me.divineHistory) {
      const existing = trueMap.get(entry.target)
      if (!existing || day > existing.day) {
        trueMap.set(entry.target, { day, result: entry.result })
      }
    }

    // legal から report 系コマンドを拾って seat ごとに集約
    const rowMap = new Map<number, SeerReportRow>()
    const ensure = (seat: number): SeerReportRow => {
      let row = rowMap.get(seat)
      if (!row) {
        const player = gameState.players.find(p => p.seat === seat)
        const divine = trueMap.get(seat) ?? null
        row = {
          seat,
          alive: !!player?.alive,
          divineDay: divine?.day ?? null,
          trueResult: divine?.result ?? null,
          humanCmd: null, wolfCmd: null, forecastCmd: null,
        }
        rowMap.set(seat, row)
      }
      return row
    }
    for (const cmd of pending.legal) {
      if (cmd.type !== 'role_result_report') continue
      const claim = cmd.claim as { type: string, target?: number, result?: string }
      if (claim.type === 'seer_result' && claim.target != null) {
        const row = ensure(claim.target)
        if (claim.result === 'human') row.humanCmd = cmd
        else if (claim.result === 'wolf') row.wolfCmd = cmd
      } else if (claim.type === 'forecast' && claim.target != null) {
        const row = ensure(claim.target)
        row.forecastCmd = cmd
      }
    }
    return [...rowMap.values()].sort((a, b) => {
      // divined → divineDay 降順（直近が上）
      // undivined → divined の下に seat 昇順
      if (a.divineDay !== null && b.divineDay !== null) return b.divineDay - a.divineDay
      if (a.divineDay !== null) return -1
      if (b.divineDay !== null) return 1
      return a.seat - b.seat
    })
  })

  /** テーブル化されないその他の legal コマンド */
  const nonTableLegal = $derived.by((): Command[] => {
    void state.tick
    if (!pending) return []
    if (seerReportTable.length === 0) return [...pending.legal]
    return pending.legal.filter(cmd => {
      if (cmd.type !== 'role_result_report') return true
      const claim = cmd.claim as { type: string }
      return claim.type !== 'seer_result' && claim.type !== 'forecast'
    })
  })

  /** 自役職の CO claim type（role_co / cco_full の一致判定に使う） */
  function matchingClaimForRole(role: SystemRole | null | undefined): string | null {
    switch (role) {
      case 'seer': return 'seer_co'
      case 'medium': return 'medium_co'
      case 'bodyguard': return 'bodyguard_co'
      case 'nekomata': return 'nekomata_co'
      case 'mason': return 'mason_co'
      default: return null
    }
  }

  /**
   * nonTableLegal を「主要」「騙り (折りたたみ)」に分割する。
   * 真役職の CO（自分の役職に一致する claim）は主要、他役職の CO は騙り扱いで末尾に。
   * 非 CO コマンド（skip / request_co / designate / vote 等）はすべて主要に含める。
   * 自役職の claim が定義できない場合（villager/villain）は分割せず全て主要。
   *
   * bluff はさらに「他役職の CO」と「自役職だが違う相方/対象の CO」に分けて
   * UI で区切って描画する（mason の場合: 真相方以外の partner 指定が後者に入る）。
   */
  const splitLegal = $derived.by((): {
    primary: Command[],
    bluffFakeRole: Command[],
    bluffWrongTarget: Command[],
  } => {
    void state.tick
    const matching = matchingClaimForRole(currentRole)
    if (matching === null) {
      // attack は専用 UI に逃がす
      const primary = nonTableLegal.filter(cmd => cmd.type !== 'attack')
      return { primary, bluffFakeRole: [], bluffWrongTarget: [] }
    }
    // mason の真相方席を事前に算出（自役職 mason の場合、同役職の他席）
    const truePartnerSeat = currentRole === 'mason' && pending && gameState
      ? (gameState.players.find(p =>
          p.role === 'mason' && p.seat !== pending.mySeat,
        )?.seat ?? null)
      : null

    const primary: Command[] = []
    const bluffFakeRole: Command[] = []
    const bluffWrongTarget: Command[] = []
    for (const cmd of nonTableLegal) {
      // attack は専用 UI (wolfAttackView) で描画するためここでは除外
      if (cmd.type === 'attack') continue
      if (cmd.type !== 'role_co' && cmd.type !== 'cco_full') {
        primary.push(cmd)
        continue
      }
      const claimType = (cmd.claim as { type: string }).type
      if (claimType !== matching) {
        // 自役職と違う claim → 他役職 CO（騙り）
        bluffFakeRole.push(cmd)
        continue
      }
      // 自役職と同じ claim。mason_co の場合は真相方かどうかで分岐
      if (claimType === 'mason_co' && currentRole === 'mason') {
        const cmdPartner = (cmd.claim as { partner?: number }).partner
        if (cmdPartner === truePartnerSeat) {
          primary.push(cmd)
        } else {
          bluffWrongTarget.push(cmd)
        }
      } else {
        primary.push(cmd)
      }
    }
    return { primary, bluffFakeRole, bluffWrongTarget }
  })

  const bluffTotal = $derived(splitLegal.bluffFakeRole.length + splitLegal.bluffWrongTarget.length)

  let showBluff: boolean = $state(false)

  // ==========================================================
  // 指揮フェーズ専用: 席ピッカー (1 席=吊り指定、2+ 席=ラン指定)
  // ==========================================================

  let designateSelection: number[] = $state([])

  // pending が変わる（次の手番）ごとに席選択をリセット
  $effect(() => {
    void pending
    designateSelection = []
  })

  /** 指揮フェーズかつ pending がある時の専用ビュー */
  type CommanderView = {
    skipCmd: Command | null
    requestCoCmds: Command[]
    /** designate_execution の target 集合（生存席） */
    executionTargets: Set<number>
    /** 全ての designate_* に出現する席 (picker に表示する席集合) */
    pickerSeats: number[]
  }

  // ==========================================================
  // 夜フェーズ専用: 狼襲撃の二段ピッカー (襲撃者 × 対象)
  // ==========================================================

  /** 狼襲撃の legal コマンドから「誰が」「誰を」噛むかの候補集合を組み立てる */
  type WolfAttackView = {
    /** 選択可能な襲撃者席（生存狼） */
    actors: number[]
    /** 各襲撃者が選べる対象席（全襲撃者で同じ集合だが actor ごとに保持） */
    targetsByActor: Map<number, number[]>
    /** 行動なし（襲撃しない）コマンド。襲撃場面では通常 legal に含まれない想定だが念のため保持 */
    noActionCmd: Command | null
  }

  const wolfAttackView = $derived.by((): WolfAttackView | null => {
    void state.tick
    if (!pending || !gameState) return null
    const attackCmds: Array<{ actor: number, target: number }> = []
    let noActionCmd: Command | null = null
    for (const cmd of pending.legal) {
      if (cmd.type === 'attack') attackCmds.push({ actor: cmd.actor, target: cmd.target })
      else if (cmd.type === 'no_action') noActionCmd = cmd
    }
    if (attackCmds.length === 0) return null
    const actorSet = new Set<number>()
    const targetsByActor = new Map<number, number[]>()
    for (const { actor, target } of attackCmds) {
      actorSet.add(actor)
      const list = targetsByActor.get(actor)
      if (list) list.push(target)
      else targetsByActor.set(actor, [target])
    }
    for (const list of targetsByActor.values()) list.sort((a, b) => a - b)
    const actors = [...actorSet].sort((a, b) => a - b)
    return { actors, targetsByActor, noActionCmd }
  })

  let selectedAttacker: number | null = $state(null)
  let selectedAttackTarget: number | null = $state(null)

  // pending が変わるたびに襲撃ピッカーもリセット。襲撃者は候補が 1 つなら自動選択
  $effect(() => {
    void pending
    selectedAttackTarget = null
    if (wolfAttackView && wolfAttackView.actors.length === 1) {
      selectedAttacker = wolfAttackView.actors[0]
    } else {
      selectedAttacker = null
    }
  })

  function pickAttacker(seat: number): void {
    selectedAttacker = seat
    // 異なる襲撃者に切り替えた場合、その襲撃者が噛めない対象なら選択解除
    const targets = wolfAttackView?.targetsByActor.get(seat) ?? []
    if (selectedAttackTarget !== null && !targets.includes(selectedAttackTarget)) {
      selectedAttackTarget = null
    }
  }

  function pickAttackTarget(seat: number): void {
    selectedAttackTarget = seat
  }

  function submitWolfAttack(): void {
    if (selectedAttacker === null || selectedAttackTarget === null) return
    submitCommand({
      type: 'attack',
      target: selectedAttackTarget,
      actor: selectedAttacker,
    })
  }

  const commanderView = $derived.by((): CommanderView | null => {
    void state.tick
    if (!pending || !gameState) return null
    if (phaseLabel !== 'commander') return null

    let skipCmd: Command | null = null
    const requestCoCmds: Command[] = []
    const executionTargets = new Set<number>()
    for (const cmd of pending.legal) {
      if (cmd.type === 'skip') skipCmd = cmd
      else if (cmd.type === 'request_co') requestCoCmds.push(cmd)
      else if (cmd.type === 'designate_execution') executionTargets.add(cmd.target)
    }
    const pickerSeats = [...executionTargets].sort((a, b) => a - b)
    return { skipCmd, requestCoCmds, executionTargets, pickerSeats }
  })

  /** picker の席選択をトグル（上限なし） */
  function toggleDesignateSeat(seat: number): void {
    if (designateSelection.includes(seat)) {
      designateSelection = designateSelection.filter(s => s !== seat)
    } else {
      designateSelection = [...designateSelection, seat]
    }
  }

  /** 選択クリア */
  function clearDesignateSelection(): void {
    designateSelection = []
  }

  /** 選択席から designate コマンドを組み立てて submit */
  function submitDesignateSelection(): void {
    if (!commanderView) return
    const selected = [...designateSelection].sort((a, b) => a - b)
    if (selected.length === 1) {
      submitCommand({ type: 'designate_execution', target: selected[0] })
    } else if (selected.length >= 2) {
      submitCommand({ type: 'designate_runoff', targets: selected })
    }
    designateSelection = []
  }

  /** 選択数に応じた決定ボタンラベル */
  function designateActionLabel(count: number): string {
    if (count === 0) return '席を選択してください'
    if (count === 1) return `吊り指定（1 席）`
    return `ラン指定（${count} 席）`
  }

  /** commander phase の CO 要求カテゴリ日本語ラベル */
  function coRequestLabel(cat: string): string {
    const map: Record<string, string> = {
      seer: '占い', medium: '霊能', bodyguard: '狩人',
      nekomata: '猫又', nekomata_bodyguard_grelan: '猫狩ギドラ',
    }
    return map[cat] ?? cat
  }

  /** 私的情報（自席の視点のみ） */
  type PrivateInfo = {
    seat: number
    role: SystemRole
    alive: boolean
    /** 役職別メモ: 占い結果、護衛履歴、仲間リスト等 */
    notes: Array<{ label: string, value: string }>
  }

  const privateInfoList = $derived.by((): PrivateInfo[] => {
    // gameState は in-place で mutate されるため、tick を読んで明示的に再計算を駆動する
    void state.tick
    if (!gameState || !state.seatRoles) return []
    const result: PrivateInfo[] = []
    const sortedSeats = [...state.humanSeats].sort((a, b) => a - b)
    for (const seat of sortedSeats) {
      const player = gameState.players.find(p => p.seat === seat)
      if (!player) continue
      const role = state.seatRoles.get(seat) ?? player.role
      const notes = buildPrivateNotes(seat, role, gameState)
      result.push({ seat, role, alive: player.alive, notes })
    }
    return result
  })

  /** 役職別の私的情報を組み立てる */
  function buildPrivateNotes(
    seat: number,
    role: SystemRole,
    gs: NonNullable<typeof gameState>,
  ): Array<{ label: string, value: string }> {
    const notes: Array<{ label: string, value: string }> = []
    const player = gs.players.find(p => p.seat === seat)
    if (!player) return notes

    switch (role) {
      case 'seer': {
        const entries = [...player.divineHistory].sort((a, b) => a[0] - b[0])
        if (entries.length === 0) {
          notes.push({ label: '占い結果', value: '(未実行)' })
        } else {
          for (const [day, r] of entries) {
            notes.push({
              label: `D${day} 占い`,
              value: `${nameOf(r.target)} = ${r.result === 'wolf' ? '● (狼)' : '○ (村人)'}`,
            })
          }
        }
        break
      }
      case 'bodyguard': {
        const entries = [...player.guardHistory].sort((a, b) => a[0] - b[0])
        if (entries.length === 0) {
          notes.push({ label: '護衛履歴', value: '(未実行)' })
        } else {
          for (const [day, target] of entries) {
            notes.push({ label: `D${day} 護衛`, value: nameOf(target) })
          }
        }
        break
      }
      case 'medium': {
        // 処刑履歴 + 各処刑の真結果（medium 視点）
        const execs = [...gs.executionHistory].sort((a, b) => a[0] - b[0])
        if (execs.length === 0) {
          notes.push({ label: '霊能結果', value: '(未処刑)' })
        } else {
          for (const [day, executedSeat] of execs) {
            const executed = gs.players.find(p => p.seat === executedSeat)
            const result = executed?.role === 'werewolf' ? '● (狼)' : '○ (村人)'
            notes.push({ label: `D${day} 処刑`, value: `${nameOf(executedSeat)} = ${result}` })
          }
        }
        break
      }
      case 'werewolf': {
        const teammates = gs.players
          .filter(p => p.role === 'werewolf' && p.seat !== seat)
          .map(p => nameOf(p.seat))
        notes.push({ label: '狼仲間', value: teammates.join(', ') || '(単独)' })
        break
      }
      case 'mason': {
        const partner = gs.players.find(p => p.role === 'mason' && p.seat !== seat)
        notes.push({ label: '共有相方', value: partner ? nameOf(partner.seat) : '(不在)' })
        break
      }
      case 'fanatic': {
        const wolves = gs.players
          .filter(p => p.role === 'werewolf')
          .map(p => nameOf(p.seat))
        notes.push({ label: '狼の席', value: wolves.join(', ') || '(不在)' })
        break
      }
      case 'werehamster':
        notes.push({ label: '役職', value: '妖狐（噛み耐性）' })
        break
      case 'immoralist': {
        const fox = gs.players.find(p => p.role === 'werehamster')
        notes.push({ label: '狐の席', value: fox ? nameOf(fox.seat) : '(不在)' })
        break
      }
      case 'nekomata':
        notes.push({ label: '役職', value: '猫又（呪殺能力）' })
        break
      case 'villager':
      default:
        // 村人は特別情報なし
        break
    }
    return notes
  }

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
      case 'attack': return `襲撃: ${nameOf(cmd.actor)} → ${nameOf(cmd.target)}`
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
  {#if state.running && !gameState}
    <section class="loading">
      <div class="loading-body">ゲームを準備中...</div>
    </section>
  {/if}

  {#if state.running && gameState}
    <section class="state">
      <div class="state-header">
        <span class="phase">Day {view.day} / {phaseJa(phaseLabel)}</span>
        {#if commanderSeat !== null}
          <span class="commander">指揮: {nameOf(commanderSeat)}</span>
        {/if}
        {#if activeSeat !== null}
          <span class="active">処理中: {nameOf(activeSeat)}</span>
        {/if}
      </div>
    </section>

    <!-- 活動フィード: 最新 N 件の判断ログを小窓で表示（死後観戦にも有用） -->
    {#if state.activityLog.length > 0}
      <section class="activity">
        <h3>進行ログ</h3>
        <ul class="activity-list">
          {#each state.activityLog as line, i (i)}
            <li>{line}</li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- 自席の私的情報（記憶頼りを避けるための参照パネル） -->
    {#if privateInfoList.length > 0}
      <section class="private-info">
        <h3>自席情報</h3>
        {#each privateInfoList as info (info.seat)}
          <div class="private-seat">
            <div class="private-header">
              <span class="seat-label">{nameOf(info.seat)}</span>
              <span class="seat-role">{formatRole(info.role)}</span>
              <span class="seat-status">{info.alive ? '生存' : '退場'}</span>
            </div>
            {#if info.notes.length > 0}
              <ul class="notes">
                {#each info.notes as note, i (i)}
                  <li><span class="note-label">{note.label}:</span> {note.value}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </section>
    {/if}
  {/if}

  <!-- 手番 UI -->
  {#if pending}
    <section class="turn">
      <div class="turn-header">
        <strong>手番: {nameOf(pending.mySeat)}</strong>
        <span class="role">（あなたの役職: {formatRole(currentRole)}）</span>
      </div>

      {#if seerReportTable.length > 0}
        <div class="seer-report">
          <div class="seer-report-title">占い結果の報告 / 予告</div>
          <table class="seer-report-table">
            <thead>
              <tr>
                <th>占日</th>
                <th>対象</th>
                <th>状態</th>
                <th title="人間と報告">○</th>
                <th title="人狼と報告">●</th>
                <th title="次の夜に占う予告">予告</th>
              </tr>
            </thead>
            <tbody>
              {#each seerReportTable as row (row.seat)}
                <tr class:truth-row={row.trueResult !== null}>
                  <td class="row-day">{row.divineDay !== null ? `D${row.divineDay}` : '—'}</td>
                  <td class="row-seat">{nameOf(row.seat)}</td>
                  <td class="row-status">{row.alive ? '生存' : '退場'}</td>
                  <td>
                    {#if row.humanCmd}
                      <button
                        class="report-cell"
                        class:truth={row.trueResult === 'human'}
                        onclick={() => submitCommand(row.humanCmd!)}
                        title={row.trueResult === 'human' ? '占い結果と一致' : '偽報告になる'}
                      >○</button>
                    {/if}
                  </td>
                  <td>
                    {#if row.wolfCmd}
                      <button
                        class="report-cell"
                        class:truth={row.trueResult === 'wolf'}
                        onclick={() => submitCommand(row.wolfCmd!)}
                        title={row.trueResult === 'wolf' ? '占い結果と一致' : '偽報告になる'}
                      >●</button>
                    {/if}
                  </td>
                  <td>
                    {#if row.forecastCmd}
                      <button class="report-cell forecast-cell" onclick={() => submitCommand(row.forecastCmd!)}>予告</button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div class="seer-report-legend">
            ※ 青枠 = あなたの占い結果と一致する選択肢。並び順: 占い済み席（直近の占日が上）→ 未占席。
          </div>
        </div>
      {/if}

      {#if wolfAttackView}
        <!-- 夜フェーズ 狼襲撃 UI: 襲撃者 × 対象 の二段ピッカー -->
        <div class="wolf-attack-ui">
          {#if wolfAttackView.actors.length > 1}
            <div class="cmd-group">
              <div class="cmd-group-title">襲撃者（誰が噛むか）</div>
              <div class="seat-picker">
                {#each wolfAttackView.actors as seat (seat)}
                  <button
                    type="button"
                    class="seat-pick-btn"
                    class:seat-picked={selectedAttacker === seat}
                    onclick={() => pickAttacker(seat)}
                  >
                    {nameOf(seat)}
                  </button>
                {/each}
              </div>
            </div>
          {:else}
            <div class="cmd-group">
              <div class="cmd-group-title">襲撃者</div>
              <div class="attacker-fixed">{nameOf(wolfAttackView.actors[0])}（唯一の生存狼）</div>
            </div>
          {/if}

          <div class="cmd-group">
            <div class="cmd-group-title">襲撃対象</div>
            {#if selectedAttacker === null}
              <div class="attacker-hint">まず襲撃者を選択してください</div>
            {:else}
              <div class="seat-picker">
                {#each (wolfAttackView.targetsByActor.get(selectedAttacker) ?? []) as target (target)}
                  <button
                    type="button"
                    class="seat-pick-btn"
                    class:seat-picked={selectedAttackTarget === target}
                    onclick={() => pickAttackTarget(target)}
                  >
                    {nameOf(target)}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <div class="designate-actions">
            <button
              class="cmd-btn runoff-submit"
              disabled={selectedAttacker === null || selectedAttackTarget === null}
              onclick={submitWolfAttack}
            >
              {selectedAttacker !== null && selectedAttackTarget !== null
                ? `襲撃: ${nameOf(selectedAttacker)} → ${nameOf(selectedAttackTarget)}`
                : '襲撃者と対象を選択してください'}
            </button>
            {#if wolfAttackView.noActionCmd}
              <button class="cmd-btn secondary" onclick={() => submitCommand(wolfAttackView!.noActionCmd!)}>
                襲撃しない
              </button>
            {/if}
          </div>
        </div>
      {:else if commanderView}
        <!-- 指揮フェーズ専用 UI: カテゴリ分け + 吊り/ラン指定は単一ピッカー -->
        <div class="commander-ui">
          {#if commanderView.skipCmd}
            <div class="cmd-group">
              <button class="cmd-btn cmd-skip" onclick={() => submitCommand(commanderView.skipCmd!)}>
                スキップ（指定せず投票へ）
              </button>
            </div>
          {/if}

          {#if commanderView.requestCoCmds.length > 0}
            <div class="cmd-group">
              <div class="cmd-group-title">CO 要求</div>
              <div class="commands">
                {#each commanderView.requestCoCmds as cmd, i (i)}
                  {#if cmd.type === 'request_co'}
                    <button class="cmd-btn" onclick={() => submitCommand(cmd)}>
                      {coRequestLabel(cmd.category)}
                    </button>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}

          {#if commanderView.pickerSeats.length > 0}
            <div class="cmd-group">
              <div class="cmd-group-title">吊り / ラン指定（席を選択: 1 席=吊り、2+ 席=ラン）</div>
              <div class="seat-picker">
                {#each commanderView.pickerSeats as seat (seat)}
                  <button
                    type="button"
                    class="seat-pick-btn"
                    class:seat-picked={designateSelection.includes(seat)}
                    onclick={() => toggleDesignateSeat(seat)}
                  >
                    {nameOf(seat)}
                  </button>
                {/each}
              </div>
              <div class="designate-actions">
                <button
                  class="cmd-btn runoff-submit"
                  disabled={designateSelection.length === 0}
                  onclick={submitDesignateSelection}
                >
                  {designateActionLabel(designateSelection.length)}
                </button>
                {#if designateSelection.length > 0}
                  <button class="cmd-btn secondary" onclick={clearDesignateSelection}>
                    クリア
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="commands">
          {#each splitLegal.primary as cmd, i (i)}
            <button class="cmd-btn" onclick={() => submitCommand(cmd)}>
              {formatCommand(cmd)}
            </button>
          {/each}
        </div>
      {/if}

      {#if bluffTotal > 0}
        <div class="bluff-section">
          <button
            type="button"
            class="bluff-toggle"
            onclick={() => { showBluff = !showBluff }}
            title="他役職の CO・違う相方指定（騙り）候補を表示"
          >
            {showBluff ? '▼' : '▶'} 騙り CO ({bluffTotal})
          </button>
          {#if showBluff}
            {#if splitLegal.bluffFakeRole.length > 0}
              <div class="commands bluff-commands">
                {#each splitLegal.bluffFakeRole as cmd, i (i)}
                  <button class="cmd-btn bluff-cmd" onclick={() => submitCommand(cmd)}>
                    {formatCommand(cmd)}
                  </button>
                {/each}
              </div>
            {/if}
            {#if splitLegal.bluffWrongTarget.length > 0}
              {#if splitLegal.bluffFakeRole.length > 0}
                <div class="bluff-divider">— 違う相方指定 —</div>
              {/if}
              <div class="commands bluff-commands">
                {#each splitLegal.bluffWrongTarget as cmd, i (i)}
                  <button class="cmd-btn bluff-cmd" onclick={() => submitCommand(cmd)}>
                    {formatCommand(cmd)}
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      {/if}
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

  .active {
    color: var(--ctp-sky);
  }

  .loading {
    text-align: center;
    color: var(--color-text-muted);
    font-size: 12px;
    padding: 16px;
  }

  .activity {
    background: var(--ctp-mantle, var(--color-surface));
  }

  .activity-list {
    list-style: none;
    padding: 0;
    margin: 0;
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 11px;
    max-height: 160px;
    overflow-y: auto;
  }

  .activity-list li {
    padding: 1px 4px;
    border-left: 2px solid var(--ctp-overlay0);
    margin-bottom: 1px;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--color-text-muted);
  }

  .activity-list li:last-child {
    color: var(--color-text);
    border-left-color: var(--ctp-sky);
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

  .bluff-section {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px dashed var(--color-border);
  }

  .bluff-toggle {
    font-size: 11px;
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    padding: 2px 4px;
    cursor: pointer;
  }

  .bluff-toggle:hover {
    color: var(--color-text);
  }

  .bluff-commands {
    margin-top: 4px;
  }

  .bluff-divider {
    margin-top: 6px;
    margin-bottom: 4px;
    font-size: 10px;
    color: var(--color-text-muted);
    text-align: center;
    border-top: 1px dashed var(--color-border);
    padding-top: 4px;
  }

  .cmd-btn.bluff-cmd {
    opacity: 0.7;
  }

  .cmd-btn.bluff-cmd:hover {
    opacity: 1;
  }

  /* ========== 夜フェーズ 狼襲撃 UI ========== */

  .wolf-attack-ui {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .attacker-fixed {
    font-size: 12px;
    color: var(--ctp-red);
    font-weight: 600;
  }

  .attacker-hint {
    font-size: 11px;
    color: var(--color-text-muted);
    font-style: italic;
  }

  /* ========== 指揮フェーズ UI ========== */

  .commander-ui {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .cmd-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cmd-group-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .cmd-skip {
    align-self: flex-start;
  }

  .seat-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .seat-pick-btn {
    font-size: 11px;
    background: var(--ctp-surface1);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    min-width: 60px;
  }

  .seat-pick-btn:hover {
    background: var(--ctp-sapphire);
    color: var(--color-bg);
  }

  .seat-pick-btn.seat-picked {
    background: var(--ctp-sky);
    color: var(--color-bg);
    border-color: var(--ctp-sky);
    font-weight: 700;
  }

  .runoff-submit {
    align-self: flex-start;
    background: var(--ctp-peach);
  }

  .runoff-submit:disabled {
    background: var(--ctp-surface1);
    color: var(--color-text-muted);
    cursor: not-allowed;
  }

  .designate-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .cmd-btn.secondary {
    background: var(--ctp-surface1);
    color: var(--color-text);
  }

  .cmd-btn.secondary:hover {
    background: var(--ctp-red);
    color: var(--color-bg);
  }

  .seer-report {
    margin-bottom: 8px;
    padding: 6px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 3px;
  }

  .seer-report-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--ctp-peach);
    margin-bottom: 4px;
  }

  .seer-report-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }

  .seer-report-table th,
  .seer-report-table td {
    padding: 2px 6px;
    text-align: center;
    border-bottom: 1px solid var(--color-border);
  }

  .seer-report-table th {
    color: var(--color-text-muted);
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
  }

  .seer-report-table td.row-day {
    color: var(--ctp-peach);
    font-family: 'Consolas', 'Menlo', monospace;
    font-size: 10px;
    font-weight: 600;
  }

  .seer-report-table td.row-seat {
    text-align: left;
    font-weight: 600;
  }

  .seer-report-table td.row-status {
    color: var(--color-text-muted);
    font-size: 10px;
  }

  .seer-report-table tr.truth-row {
    background: var(--ctp-surface0, transparent);
  }

  .report-cell {
    font-size: 12px;
    min-width: 32px;
    padding: 2px 6px;
    background: var(--ctp-surface1);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 3px;
    cursor: pointer;
  }

  .report-cell:hover {
    background: var(--ctp-sapphire);
    color: var(--color-bg);
  }

  .report-cell.truth {
    border: 2px solid var(--ctp-sky);
    background: var(--ctp-surface2, var(--ctp-surface1));
    font-weight: 700;
  }

  .report-cell.forecast-cell {
    font-size: 10px;
    min-width: auto;
  }

  .seer-report-legend {
    margin-top: 4px;
    font-size: 10px;
    color: var(--color-text-muted);
  }

  .error {
    margin-top: 6px;
    padding: 4px 8px;
    background: var(--ctp-red);
    color: var(--color-bg);
    border-radius: 3px;
  }

  .private-info {
    background: var(--ctp-mantle, var(--color-surface));
  }

  .private-seat {
    margin-top: 6px;
    padding: 6px 8px;
    border-left: 3px solid var(--ctp-mauve);
    background: var(--color-bg);
  }

  .private-seat:first-of-type {
    margin-top: 0;
  }

  .private-header {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .seat-label {
    color: var(--ctp-mauve);
  }

  .seat-role {
    color: var(--ctp-peach);
  }

  .seat-status {
    color: var(--color-text-muted);
    font-weight: normal;
    font-size: 11px;
  }

  .notes {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 11px;
  }

  .notes li {
    padding: 1px 0;
  }

  .note-label {
    color: var(--color-text-muted);
    margin-right: 4px;
  }
</style>
