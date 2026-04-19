/**
 * commandPlayStore — 人間プレイヤー用の CommandAdapter ラッパー
 *
 * 責務:
 * - AsyncRemoteAgent インスタンスを保持、UI からの submit をブリッジ
 * - 人間の陣営選択 → 生存中の自陣営席を自動で AsyncRemoteAgent に割当（Q5）
 * - lupa runGame を起動し、pending 状態・ゲーム状態・履歴を購読可能な形で露出
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
}

export type StoreListener = (state: CommandPlayStoreState) => void

/**
 * 人間が「全席を操作する」役職（複数席持つ陣営）。
 * werewolf と mason のみ。fanatic/werehamster/immoralist は 1 席のみ。
 */
const MULTI_SEAT_ROLES: ReadonlySet<SystemRole> = new Set(['werewolf', 'mason'])

// ============================================================
// Store 本体
// ============================================================

export class CommandPlayStore {
  private agent: AsyncRemoteAgent
  private state: CommandPlayStoreState
  private listeners = new Set<StoreListener>()
  /**
   * 共有 2 席の連動 CO: 片方が mason_co を出したら、もう片方の pending 到着時に
   * 自動で mirror mason_co を submit する。null なら予約なし。
   */
  private pendingMasonMirror: { partnerSeat: number, selfSeat: number } | null = null

  constructor() {
    this.agent = new AsyncRemoteAgent()
    this.state = this.initialState()
    // pending 変化を state へ伝播 + mason mirror 自動投入
    this.agent.subscribe((p) => {
      // 予約があり、相方席の pending が到着したら mirror を自動投入
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
          // 次のマイクロタスクで submit（現在の subscribe コールスタックを抜けてから）
          queueMicrotask(() => {
            try { this.agent.submit(mirrorCmd) } catch { /* already resolved */ }
          })
          return
        }
      }
      this.setState({
        ...this.state,
        pending: p,
        gameState: p?.state ?? this.state.gameState,
      })
    })
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
    // mason 連動: 相方も人間制御席なら、相方席に mirror mason_co を自動投入予約
    const pending = this.agent.getPending()
    if (
      pending
      && cmd.type === 'role_co'
      && cmd.claim.type === 'mason_co'
      && this.state.humanSeats.has(cmd.claim.partner)
      && cmd.claim.partner !== pending.mySeat
    ) {
      this.pendingMasonMirror = { partnerSeat: cmd.claim.partner, selfSeat: pending.mySeat }
    }
    this.agent.submit(cmd)
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

    const seed = opts.seed ?? Math.floor(Math.random() * 1e9)
    const agents = new Map<number, CommandAgent>()
    const multiSeat = MULTI_SEAT_ROLES.has(opts.humanRole)

    // Howl 書き出し用: LupaConfig 互換の最小情報
    const lupaConfig: LupaConfig = {
      roles: opts.roles,
      seed,
      hasFirstGhost: opts.hasFirstGhost,
    }

    // ライブイベント蓄積 → editorText 再生成
    const liveEvents: (GameEvent | FenrirExtEvent)[] = []
    const refreshEditor = () => {
      const currentState = this.state.gameState
      if (!currentState) return
      try {
        const howl = formatHowl(liveEvents as GameEvent[], currentState, lupaConfig)
        this.setState({ ...this.state, editorText: howl })
      } catch { /* 書き出し失敗は無視（途中状態で format 不可なことがある） */ }
    }

    const adapter = new CommandAdapter({
      agents,
      defaultAgent: new SkollCommandAgent({ seed: seed + 1 }),
      roles: opts.roles,
      seed,
      onEventEmitted: (event) => {
        liveEvents.push(event)
        refreshEditor()
      },
      onRolesAssigned: (seatRoles) => {
        // 人間席の割当:
        //   - werewolf / mason の場合: 同役職の全席を人間が操作
        //   - それ以外: 同役職の席のうち 1 席のみ人間が操作（1 席しか無い役職も同様）
        const matchedSeats: number[] = []
        for (const [seat, role] of seatRoles) {
          if (role === opts.humanRole) matchedSeats.push(seat)
        }
        matchedSeats.sort((a, b) => a - b)

        if (multiSeat) {
          for (const seat of matchedSeats) agents.set(seat, this.agent)
        } else if (matchedSeats.length > 0) {
          agents.set(matchedSeats[0], this.agent)
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
    }

    try {
      const result = await runGame<FenrirExtEvent, CommandAdapterExt>(config, adapter)
      // 最終版の editorText を確定版に差し替え
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
