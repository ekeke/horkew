/**
 * commandPlayStore — 人間プレイヤー用の CommandAdapter ラッパー
 *
 * 責務:
 * - AsyncRemoteAgent インスタンスを保持、UI からの submit をブリッジ
 * - 人間の陣営選択 → 生存中の自陣営席を自動で AsyncRemoteAgent に割当
 * - lupa runGame を起動し、pending 状態・ゲーム状態・履歴を購読可能な形で露出
 *
 * 実行モード:
 * - **worker モード**（ブラウザ既定）: demo/commandGame.worker.ts に処理を逃し、
 *   メインスレッドの UI レスポンスを保つ
 * - **inline モード**（Node テスト・フォースダウン用）: 従来どおり同一スレッドで実行
 *
 * Svelte 5 コンポーネントは `subscribe(cb)` で変化を受け取り、ローカル `$state` に反映する。
 */

import type { SystemRole } from '../src/types/index.ts'
import type { GameState, GameEvent, VillageResult, LupaConfig } from '../src/lupa/types.ts'
import type { GameConfig } from '../src/lupa/handlers.ts'
import { runGame } from '../src/lupa/engine.ts'
import { formatHowl } from '../src/lupa/format.ts'
import { CommandAdapter } from '../src/fenrir/src/adapters/command/command-adapter.ts'
import type { CommandAdapterExt, Command } from '../src/fenrir/src/adapters/command/command-types.ts'
import type { CommandAgent } from '../src/fenrir/src/command-agents/command-agent.ts'
import { SkollCommandAgent } from '../src/fenrir/src/command-agents/skoll-command-agent.ts'
import {
  AsyncRemoteAgent, type PendingDecision,
} from '../src/fenrir/src/command-agents/async-remote-agent.ts'
import type { FenrirExtEvent } from '../src/fenrir/src/events.ts'
import type {
  FromWorkerMessage, ToWorkerMessage,
  StartGameOptions as WorkerStartOptions,
} from './commandGame.worker.ts'

// ============================================================
// 型
// ============================================================

export type StartGameOptions = {
  /** 人間プレイヤーの役職。自席の役職 = humanRole となる。
   *  werewolf/mason の場合のみ同役職の全席を 1 人間が操作する（Q5 改訂） */
  humanRole: SystemRole
  roles: Map<SystemRole, number>
  /** 日ごとの初手犠牲（hasFirstGhost）。14D猫などで true */
  hasFirstGhost?: boolean
  seed?: number
}

export type CommandPlayStoreState = {
  pending: PendingDecision | null
  finished: boolean
  result: VillageResult | null
  /** 人間プレイヤーが制御する席番号（役職割当後に確定） */
  humanSeats: Set<number>
  /** 最新のゲーム状態スナップショット（pending 経由または終了時） */
  gameState: Readonly<GameState<CommandAdapterExt>> | null
  /** 現在のイベント列（ゲーム終了時にのみ埋まる） */
  events: readonly (GameEvent | FenrirExtEvent)[]
  /** 座席 → 役職マップ（役職割当後、UI 表示用） */
  seatRoles: Map<number, SystemRole> | null
  /** 人間プレイヤーの指定役職 */
  humanRole: SystemRole | null
  /** 実行中フラグ */
  running: boolean
  /** エディタへ反映する Howl テキスト（ライブ更新） */
  editorText: string
  /** 直近の comment イベントのテキスト（末尾 ACTIVITY_LOG_LIMIT 件、ライブ更新） */
  activityLog: readonly string[]
  /**
   * イベント/mutation ティック。gameState は in-place mutate されるため、
   * Svelte の derived を再実行させる明示的な reactivity トリガとして使う。
   * event emit および pending 更新のたびにインクリメント。
   */
  tick: number
}

/** activityLog に保持する直近 comment の件数（worker 側にも同値を渡す） */
export const ACTIVITY_LOG_LIMIT = 8

export type StoreListener = (state: CommandPlayStoreState) => void

export type CommandPlayStoreOptions = {
  /** 強制的に in-process 実行（テスト用）。既定はブラウザなら worker、それ以外は inline */
  forceInline?: boolean
}

/**
 * 人間が「全席を操作する」役職（複数席持つ陣営）。
 * werewolf と mason のみ。fanatic/werehamster/immoralist は 1 席のみ。
 */
const MULTI_SEAT_ROLES: ReadonlySet<SystemRole> = new Set(['werewolf', 'mason'])

// ============================================================
// Store 本体
// ============================================================

export class CommandPlayStore {
  private state: CommandPlayStoreState
  private listeners = new Set<StoreListener>()
  private forceInline: boolean

  // ----- inline モード専用 -----
  private inlineAgent: AsyncRemoteAgent | null = null

  // ----- worker モード専用 -----
  private worker: Worker | null = null

  /**
   * 共有 2 席の連動 CO: 片方が mason_co を出したら、もう片方の pending 到着時に
   * 自動で mirror mason_co を submit する。null なら予約なし。
   */
  private pendingMasonMirror: { partnerSeat: number, selfSeat: number } | null = null

  constructor(opts: CommandPlayStoreOptions = {}) {
    this.forceInline = opts.forceInline ?? false
    this.state = this.initialState()
  }

  private useWorker(): boolean {
    return !this.forceInline && typeof window !== 'undefined' && typeof Worker !== 'undefined'
  }

  // ----------- 購読 -----------

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => { this.listeners.delete(listener) }
  }

  getState(): Readonly<CommandPlayStoreState> {
    return this.state
  }

  // ----------- UI からの意思決定投入 -----------

  submit(cmd: Command): void {
    // mason 連動: 相方も人間制御席 かつ 生存していれば、相方席に mirror mason_co を自動投入予約
    // （相方が初日犠牲等で死亡していれば pending が来ないので mirror 不要）
    const currentPending = this.state.pending
    if (
      currentPending
      && cmd.type === 'role_co'
      && cmd.claim.type === 'mason_co'
      && this.state.humanSeats.has(cmd.claim.partner)
      && cmd.claim.partner !== currentPending.mySeat
    ) {
      const partnerPlayer = this.state.gameState?.players.find(
        p => p.seat === cmd.claim.partner,
      )
      if (partnerPlayer?.alive) {
        this.pendingMasonMirror = {
          partnerSeat: cmd.claim.partner,
          selfSeat: currentPending.mySeat,
        }
      }
    }
    this.doSubmit(cmd)
  }

  private doSubmit(cmd: Command): void {
    if (this.worker) {
      // Svelte 5 の $state プロキシは postMessage で clone 不可なので
      // JSON round-trip で生データに戻してから送る（Command は plain data のみ）
      const plainCmd = JSON.parse(JSON.stringify(cmd)) as Command
      this.worker.postMessage({ type: 'submit', cmd: plainCmd } satisfies ToWorkerMessage)
    } else if (this.inlineAgent) {
      this.inlineAgent.submit(cmd)
    } else {
      throw new Error('CommandPlayStore: no active game to submit')
    }
  }

  /** reset 時に mirror 予約もクリア */
  private clearMasonMirror(): void {
    this.pendingMasonMirror = null
  }

  // ----------- ゲーム起動 -----------

  async startGame(opts: StartGameOptions): Promise<void> {
    if (this.state.running) {
      throw new Error('CommandPlayStore: ゲームが既に実行中です')
    }

    this.setState({
      ...this.initialState(),
      humanRole: opts.humanRole,
      running: true,
    })

    try {
      if (this.useWorker()) {
        await this.startGameWorker(opts)
      } else {
        await this.startGameInline(opts)
      }
    } catch (err) {
      // 起動または実行中の失敗: running を戻してセットアップ画面が再表示されるようにする
      if (this.state.running) {
        this.setState({
          ...this.state,
          running: false,
          finished: false,
          pending: null,
        })
      }
      throw err
    }
  }

  // ============================================================
  // Worker モード
  // ============================================================

  private async startGameWorker(opts: StartGameOptions): Promise<void> {
    // 動的 import: node テストで ?worker の解決を発動させないため
    const mod = await import('./commandGame.worker.ts?worker')
    const worker = new mod.default() as Worker
    this.worker = worker

    const done = new Promise<void>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<FromWorkerMessage>) => {
        this.handleWorkerMessage(ev.data, resolve, reject)
      }
      worker.onerror = (err) => {
        console.error('[commandPlayStore] worker error event', err)
        reject(new Error(`Worker error: ${err.message || 'unknown'}`))
      }
      worker.onmessageerror = (err) => {
        console.error('[commandPlayStore] worker messageerror', err)
      }
    })

    const startOpts: WorkerStartOptions = {
      humanRole: opts.humanRole,
      roles: [...opts.roles.entries()],
      hasFirstGhost: opts.hasFirstGhost,
      seed: opts.seed,
      humanRoleIsMultiSeat: MULTI_SEAT_ROLES.has(opts.humanRole),
      activityLogLimit: ACTIVITY_LOG_LIMIT,
    }
    worker.postMessage({ type: 'start', opts: startOpts } satisfies ToWorkerMessage)

    try {
      await done
    } finally {
      worker.terminate()
      this.worker = null
    }
  }

  private handleWorkerMessage(
    msg: FromWorkerMessage,
    resolve: () => void,
    reject: (e: Error) => void,
  ): void {
    switch (msg.type) {
      case 'rolesAssigned':
        this.setState({
          ...this.state,
          humanSeats: new Set(msg.humanSeats),
          seatRoles: new Map(msg.seatRoles),
          gameState: msg.state ?? this.state.gameState,
          tick: this.state.tick + 1,
        })
        return
      case 'pending': {
        const pending: PendingDecision = {
          state: msg.payload.state,
          mySeat: msg.payload.mySeat,
          legal: msg.payload.legal,
        }
        // mason mirror 予約があれば自動投入
        if (
          this.pendingMasonMirror
          && pending.mySeat === this.pendingMasonMirror.partnerSeat
        ) {
          const selfSeat = this.pendingMasonMirror.selfSeat
          const mirrorCmd: Command = {
            type: 'role_co',
            claim: { type: 'mason_co', partner: selfSeat },
          }
          const legalMatch = pending.legal.some(c =>
            c.type === 'role_co'
            && c.claim.type === 'mason_co'
            && c.claim.partner === selfSeat,
          )
          this.pendingMasonMirror = null
          if (legalMatch) {
            queueMicrotask(() => {
              try { this.doSubmit(mirrorCmd) } catch { /* noop */ }
            })
            return
          }
        }
        this.setState({
          ...this.state,
          pending,
          gameState: pending.state,
          tick: this.state.tick + 1,
        })
        return
      }
      case 'pendingCleared':
        this.setState({
          ...this.state,
          pending: null,
          tick: this.state.tick + 1,
        })
        return
      case 'event':
        this.setState({
          ...this.state,
          gameState: msg.state,
          editorText: msg.editorText,
          activityLog: msg.activityLog,
          tick: this.state.tick + 1,
        })
        return
      case 'finished':
        this.setState({
          ...this.state,
          pending: null,
          finished: true,
          running: false,
          result: msg.result,
          events: msg.events,
          gameState: msg.state,
          editorText: msg.editorText,
          tick: this.state.tick + 1,
        })
        resolve()
        return
      case 'error':
        this.setState({
          ...this.state,
          pending: null,
          running: false,
          finished: true,
        })
        reject(new Error(msg.message))
        return
    }
  }

  // ============================================================
  // Inline モード（テスト / fallback 用）
  // ============================================================

  private async startGameInline(opts: StartGameOptions): Promise<void> {
    const agent = new AsyncRemoteAgent()
    this.inlineAgent = agent

    // pending 変化を state へ伝播 + mason mirror 自動投入
    const unsubscribePending = agent.subscribe((p) => {
      if (p && this.pendingMasonMirror && p.mySeat === this.pendingMasonMirror.partnerSeat) {
        const mirrorCmd: Command = {
          type: 'role_co',
          claim: { type: 'mason_co', partner: this.pendingMasonMirror.selfSeat },
        }
        const legalMatch = p.legal.some(c =>
          c.type === 'role_co'
          && c.claim.type === 'mason_co'
          && c.claim.partner === this.pendingMasonMirror!.selfSeat,
        )
        this.pendingMasonMirror = null
        if (legalMatch) {
          queueMicrotask(() => {
            try { agent.submit(mirrorCmd) } catch { /* already resolved */ }
          })
          return
        }
      }
      this.setState({
        ...this.state,
        pending: p,
        gameState: p?.state ?? this.state.gameState,
        tick: this.state.tick + 1,
      })
    })

    const seed = opts.seed ?? Math.floor(Math.random() * 1e9)
    const agents = new Map<number, CommandAgent>()
    // 進行役優先席: 人間席を村確定時に commander へ強制割当するため
    const humanSeatsForCommander = new Set<number>()
    const multiSeat = MULTI_SEAT_ROLES.has(opts.humanRole)

    const lupaConfig: LupaConfig = {
      roles: opts.roles,
      seed,
      hasFirstGhost: opts.hasFirstGhost,
      // 14d-neko の正式再投票ルール。commandGame.worker.ts と揃える。
      revoteConfig: { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' },
    }

    const liveEvents: (GameEvent | FenrirExtEvent)[] = []
    const recentComments: string[] = []
    const refreshEditor = () => {
      const currentState = this.state.gameState
      if (!currentState) return
      let nextEditorText = this.state.editorText
      try {
        nextEditorText = formatHowl(liveEvents as GameEvent[], currentState, lupaConfig)
      } catch { /* mid-game format 不可なことがある */ }
      this.setState({
        ...this.state,
        editorText: nextEditorText,
        activityLog: [...recentComments],
        tick: this.state.tick + 1,
      })
    }

    const adapter = new CommandAdapter({
      agents,
      defaultAgent: new SkollCommandAgent({ seed: seed + 1 }),
      roles: opts.roles,
      seed,
      preferredCommanderSeats: humanSeatsForCommander,
      onEventEmitted: (event) => {
        liveEvents.push(event)
        if (event.type === 'comment') {
          recentComments.push((event as { text: string }).text)
          if (recentComments.length > ACTIVITY_LOG_LIMIT) {
            recentComments.splice(0, recentComments.length - ACTIVITY_LOG_LIMIT)
          }
        }
        refreshEditor()
      },
      onRolesAssigned: (seatRoles) => {
        const matchedSeats: number[] = []
        for (const [seat, role] of seatRoles) {
          if (role === opts.humanRole) matchedSeats.push(seat)
        }
        matchedSeats.sort((a, b) => a - b)
        if (multiSeat) {
          for (const seat of matchedSeats) {
            agents.set(seat, agent)
            humanSeatsForCommander.add(seat)
          }
        } else if (matchedSeats.length > 0) {
          agents.set(matchedSeats[0], agent)
          humanSeatsForCommander.add(matchedSeats[0])
        }
        this.setState({
          ...this.state,
          humanSeats: new Set(agents.keys()),
          seatRoles: new Map(seatRoles),
        })
      },
    })

    const config: GameConfig = {
      roles: opts.roles,
      seed,
      hasFirstGhost: opts.hasFirstGhost,
      nameStyle: 'random',
    }

    try {
      const result = await runGame<FenrirExtEvent, CommandAdapterExt>(config, adapter)
      const finalHowl = (() => {
        try {
          return formatHowl(result.events as GameEvent[], result.state, lupaConfig)
        } catch { return this.state.editorText }
      })()
      this.setState({
        ...this.state,
        pending: null,
        finished: true,
        running: false,
        result: result.state.result,
        events: result.events,
        gameState: result.state,
        editorText: finalHowl,
      })
    } catch (err) {
      this.setState({
        ...this.state,
        pending: null,
        running: false,
        finished: true,
      })
      throw err
    } finally {
      unsubscribePending()
      this.inlineAgent = null
    }
  }

  // ----------- リセット -----------

  reset(): void {
    if (this.state.running) {
      throw new Error('CommandPlayStore: 実行中はリセット不可。先に終了を待つこと')
    }
    this.clearMasonMirror()
    this.setState(this.initialState())
  }

  // ============================================================
  // 内部
  // ============================================================

  private initialState(): CommandPlayStoreState {
    return {
      pending: null,
      finished: false,
      result: null,
      humanSeats: new Set(),
      gameState: null,
      events: [],
      seatRoles: null,
      humanRole: null,
      running: false,
      editorText: '',
      activityLog: [],
      tick: 0,
    }
  }

  private setState(next: CommandPlayStoreState): void {
    this.state = next
    for (const l of this.listeners) l(this.state)
  }
}

// ============================================================
// デフォルトインスタンス（demo 全体で共有）
// ============================================================

export const commandPlayStore = new CommandPlayStore()
