/**
 * Command Game Worker — ゲーム進行と skoll 計算を Worker thread で実行。
 *
 * 主スレッドはUIと入力のみ。重い処理（Retar 再計算、skoll 分析、
 * skoll-driven agents の判断）を Worker に隔離し、ユーザー操作後のフリーズを防ぐ。
 *
 * プロトコル:
 *   Main → Worker: { type: 'start', opts } | { type: 'submit', cmd }
 *   Worker → Main: rolesAssigned | pending | pendingCleared | event | finished | error
 *
 * 注意: state は in-place mutate されるので、postMessage 送信時に retarCache を剥がして
 * structuredClone エラーを避ける（VillageStatus クラスは安全に clone できるが不要）。
 */

import type { SystemRole } from '../src/types/index.ts'
import type { GameEvent, GameState, VillageResult, LupaConfig } from '../src/lupa/types.ts'
import type { GameConfig } from '../src/lupa/handlers.ts'
import { runGame } from '../src/lupa/engine.ts'
import { formatHowl } from '../src/lupa/format.ts'
import { CommandAdapter } from '../src/fenrir/src/adapters/command/command-adapter.ts'
import type { CommandAdapterExt, Command } from '../src/fenrir/src/adapters/command/command-types.ts'
import type { CommandAgent } from '../src/fenrir/src/command-agents/command-agent.ts'
import { SkollCommandAgent } from '../src/fenrir/src/command-agents/skoll-command-agent.ts'
import { AsyncRemoteAgent } from '../src/fenrir/src/command-agents/async-remote-agent.ts'
import type { FenrirExtEvent } from '../src/fenrir/src/events.ts'

// ============================================================
// プロトコル型
// ============================================================

export type StartGameOptions = {
  humanRole: SystemRole
  /** Map をシリアライズ可能な配列形式で受け取る */
  roles: Array<[SystemRole, number]>
  hasFirstGhost?: boolean
  seed?: number
  /** humanRole が werewolf/mason（全席人間操作）か */
  humanRoleIsMultiSeat: boolean
  /** activityLog 保持件数 */
  activityLogLimit: number
}

export type PendingPayload = {
  state: GameState<CommandAdapterExt>
  mySeat: number
  legal: Command[]
}

export type ToWorkerMessage =
  | { type: 'start', opts: StartGameOptions }
  | { type: 'submit', cmd: Command }

export type FromWorkerMessage =
  | {
      type: 'rolesAssigned',
      seatRoles: Array<[number, SystemRole]>,
      humanSeats: number[],
      /** 役職割当直後の初期 state snapshot（UI 即時表示用） */
      state: GameState<CommandAdapterExt>,
    }
  | { type: 'pending', payload: PendingPayload }
  | { type: 'pendingCleared' }
  | {
      type: 'event',
      event: GameEvent | FenrirExtEvent,
      state: GameState<CommandAdapterExt>,
      editorText: string,
      activityLog: string[],
    }
  | {
      type: 'finished',
      result: VillageResult | null,
      state: GameState<CommandAdapterExt>,
      editorText: string,
      events: Array<GameEvent | FenrirExtEvent>,
    }
  | { type: 'error', message: string }

// ============================================================
// 実装
// ============================================================

let asyncAgent: AsyncRemoteAgent | null = null
let gameInFlight = false

self.onmessage = (ev: MessageEvent<ToWorkerMessage>) => {
  const msg = ev.data
  if (msg.type === 'start') {
    if (gameInFlight) {
      post({ type: 'error', message: 'game already running' })
      return
    }
    void startGame(msg.opts).catch(err => {
      console.error('[commandGame.worker] startGame failed', err)
      post({ type: 'error', message: String((err as Error).message ?? err) })
      gameInFlight = false
      asyncAgent = null
    })
  } else if (msg.type === 'submit') {
    if (!asyncAgent) {
      post({ type: 'error', message: 'submit: no asyncAgent' })
      return
    }
    try {
      asyncAgent.submit(msg.cmd)
    } catch (err) {
      post({ type: 'error', message: `submit failed: ${String((err as Error).message ?? err)}` })
    }
  }
}

function post(msg: FromWorkerMessage): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(self as any).postMessage(msg)
  } catch (err) {
    console.error('[commandGame.worker] postMessage failed', msg.type, err)
  }
}

async function startGame(opts: StartGameOptions): Promise<void> {
  gameInFlight = true
  asyncAgent = new AsyncRemoteAgent()

  const agents = new Map<number, CommandAgent>()
  // 進行役優先席: 人間席を村確定時に commander へ強制割当するため
  const humanSeatsForCommander = new Set<number>()
  const rolesMap = new Map(opts.roles)
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9)

  const lupaConfig: LupaConfig = {
    roles: rolesMap,
    seed,
    hasFirstGhost: opts.hasFirstGhost,
  }

  const liveEvents: Array<GameEvent | FenrirExtEvent> = []
  const recentComments: string[] = []

  // state 参照キャプチャ（onSetup → onStateReady で 1 回だけ受け取る）
  let stateRef: GameState<CommandAdapterExt> | null = null

  // AsyncRemoteAgent.pending をメインに転送
  asyncAgent.subscribe(p => {
    if (p) {
      post({
        type: 'pending',
        payload: {
          state: snapshotState(p.state),
          mySeat: p.mySeat,
          legal: [...p.legal],
        },
      })
    } else {
      post({ type: 'pendingCleared' })
    }
  })

  const adapter = new CommandAdapter({
    agents,
    defaultAgent: new SkollCommandAgent({ seed: seed + 1 }),
    roles: rolesMap,
    seed,
    preferredCommanderSeats: humanSeatsForCommander,
    onStateReady: (state) => {
      stateRef = state
    },
    onEventEmitted: (event) => {
      liveEvents.push(event)
      if (event.type === 'comment') {
        const text = (event as { text: string }).text
        recentComments.push(text)
        if (recentComments.length > opts.activityLogLimit) {
          recentComments.splice(0, recentComments.length - opts.activityLogLimit)
        }
      }

      // editorText 再生成（失敗は無視）
      let editorText = ''
      if (stateRef) {
        try {
          editorText = formatHowl(liveEvents as GameEvent[], stateRef, lupaConfig)
        } catch { /* mid-game format 不可なことがある */ }
      }

      if (!stateRef) return  // onSetup 前は何も送らない

      post({
        type: 'event',
        event,
        state: snapshotState(stateRef),
        editorText,
        activityLog: [...recentComments],
      })
    },
    onRolesAssigned: (seatRoles) => {
      // 人間席の割当
      const matchedSeats: number[] = []
      for (const [seat, role] of seatRoles) {
        if (role === opts.humanRole) matchedSeats.push(seat)
      }
      matchedSeats.sort((a, b) => a - b)

      if (opts.humanRoleIsMultiSeat) {
        for (const seat of matchedSeats) {
          agents.set(seat, asyncAgent!)
          humanSeatsForCommander.add(seat)
        }
      } else if (matchedSeats.length > 0) {
        agents.set(matchedSeats[0], asyncAgent!)
        humanSeatsForCommander.add(matchedSeats[0])
      }

      // stateRef は onStateReady で onRolesAssigned の前に捕捉済み
      post({
        type: 'rolesAssigned',
        seatRoles: [...seatRoles.entries()],
        humanSeats: [...agents.keys()],
        state: stateRef ? snapshotState(stateRef) : (null as unknown as GameState<CommandAdapterExt>),
      })
    },
  })

  const config: GameConfig = {
    roles: rolesMap,
    seed,
    hasFirstGhost: opts.hasFirstGhost,
    nameStyle: 'random',
  }

  try {
    const result = await runGame<FenrirExtEvent, CommandAdapterExt>(config, adapter)
    let finalEditorText = ''
    try {
      finalEditorText = formatHowl(result.events as GameEvent[], result.state, lupaConfig)
    } catch { /* 失敗時は空文字で送る */ }
    post({
      type: 'finished',
      result: result.state.result,
      state: snapshotState(result.state),
      editorText: finalEditorText,
      events: [...result.events],
    })
  } finally {
    gameInFlight = false
    asyncAgent = null
  }
}

/**
 * state を postMessage で安全に送れる形に clone 用意。
 * retarCache は VillageStatus 等のクラスインスタンスを含むため剥がす
 * （メインスレッド側では skoll を呼ばないので情報不要）。
 */
function snapshotState(
  state: GameState<CommandAdapterExt>,
): GameState<CommandAdapterExt> {
  return {
    ...state,
    ext: { ...state.ext, retarCache: null },
  }
}
