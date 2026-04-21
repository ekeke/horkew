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
import { TransformerNetwork } from '../src/fenrir/src/ml/transformer-network.ts'
import { inferObservationMode } from '../src/fenrir/src/observation.ts'
import { MasonZeroNetwork } from '../src/skoll-zero/network/mason-zero.ts'
import { MasonZeroAgent } from '../src/skoll-zero/selfplay/mason-zero-agent.ts'
import {
  VillageZeroAgent, WolfZeroAgent, FanaticZeroAgent,
  HamsterZeroAgent, ImmoralistZeroAgent,
} from '../src/skoll-zero/selfplay/role-zero-agents.ts'
import type { RoleZeroAgent } from '../src/skoll-zero/selfplay/role-zero-agent.ts'
import { TrainingBuffer } from '../src/skoll-zero/selfplay/buffer.ts'

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

/** Phase 2 checkpoint を fetch して Pure JS TransformerNetwork に展開 (decideDayClaim 等の head を含む) */
async function fetchPhase2Network(relativeFile: string): Promise<TransformerNetwork | null> {
  try {
    const res = await fetch(`models/phase2/${relativeFile}`)
    if (!res.ok) return null
    const data = await res.json()
    const net = new TransformerNetwork(data.config, inferObservationMode(data.config.inputSize))
    const weights = new Map<string, Float32Array>()
    for (const [name, b64] of Object.entries(data.weights as Record<string, string>)) {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      weights.set(name, new Float32Array(bytes.buffer))
    }
    net.loadWeights(weights)
    console.log(`[phase2] loaded ${relativeFile}`)
    return net
  } catch (err) {
    console.warn(`[phase2] failed to load ${relativeFile}:`, err)
    return null
  }
}

/** checkpoint を fetch して Pure JS TransformerNetwork + MasonZeroNetwork wrapper に展開 */
async function fetchMasonZeroNetwork(slot: string): Promise<MasonZeroNetwork | null> {
  // 優先: /horkew/models/zero/{slot}.json (trained skoll-zero)
  // fallback: /horkew/models/{slot}.json (SL warm-start)
  for (const path of [`models/zero/${slot}.json`, `models/${slot}.json`]) {
    try {
      const res = await fetch(path)
      if (!res.ok) continue
      const data = await res.json()
      const net = new TransformerNetwork(data.config, inferObservationMode(data.config.inputSize))
      const weights = new Map<string, Float32Array>()
      for (const [name, b64] of Object.entries(data.weights as Record<string, string>)) {
        const binary = atob(b64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        weights.set(name, new Float32Array(bytes.buffer))
      }
      net.loadWeights(weights)
      return new MasonZeroNetwork(net, { zeroValueHead: false })
    } catch {
      // 次の path にフォールバック
    }
  }
  return null
}

type ZeroSlot = 'mason' | 'village' | 'wolf' | 'fanatic' | 'hamster' | 'immoralist'

const ZERO_SLOTS: ZeroSlot[] = ['mason', 'village', 'wolf', 'fanatic', 'hamster', 'immoralist']

/**
 * 6 slot の skoll-zero NN をロードして RoleZeroAgent の Map を返す。
 * 失敗した slot は null のまま、呼び出し側で heuristic にフォールバック。
 */
async function buildSkollZeroAgents(
  rolesMap: Map<SystemRole, number>,
): Promise<Map<ZeroSlot, RoleZeroAgent>> {
  const out = new Map<ZeroSlot, RoleZeroAgent>()
  const commonOpts = {
    setup: rolesMap,
    buffer: new TrainingBuffer(),
    selectionMode: 'argmax' as const,
  }
  // Phase 2 pretrained head (villager/claim) を village slot に注入。未配置なら null で素通し。
  const villagerClaimNet = await fetchPhase2Network('villager-claim.json')
  for (const slot of ZERO_SLOTS) {
    const mzNet = await fetchMasonZeroNetwork(slot)
    if (!mzNet) continue
    const phase2Net = slot === 'village' ? (villagerClaimNet ?? undefined) : undefined
    const opts = { nn: mzNet, phase2Net, ...commonOpts }
    const agent: RoleZeroAgent =
      slot === 'mason' ? new MasonZeroAgent(opts)
      : slot === 'village' ? new VillageZeroAgent(opts)
      : slot === 'wolf' ? new WolfZeroAgent(opts)
      : slot === 'fanatic' ? new FanaticZeroAgent(opts)
      : slot === 'hamster' ? new HamsterZeroAgent(opts)
      : new ImmoralistZeroAgent(opts)
    out.set(slot, agent)
  }
  return out
}

function roleToSlot(role: SystemRole): ZeroSlot | null {
  switch (role) {
    case 'mason': return 'mason'
    case 'villager':
    case 'seer':
    case 'medium':
    case 'bodyguard':
    case 'nekomata':
      return 'village'
    case 'werewolf': return 'wolf'
    case 'fanatic': return 'fanatic'
    case 'werehamster': return 'hamster'
    case 'immoralist': return 'immoralist'
    default: return null
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
    // 14d-neko の正式再投票ルール。default (random_tied) だと再投票がエンジン側で
    // ランダム解決され、handlers.onVote 経由の agent 判断が効かない。
    revoteConfig: { maxRevotes: 2, style: 'full_revote', tiebreaker: 'draw' },
  }

  // 6 slot の skoll-zero エージェント (fetch 失敗 slot は heuristic fallback)
  const zeroAgents = await buildSkollZeroAgents(rolesMap)
  const zeroCommandAgents = new Map<ZeroSlot, CommandAgent>()
  for (const [slot, agent] of zeroAgents) {
    zeroCommandAgents.set(slot, new SkollCommandAgent({
      seed: seed + 2,
      master: agent,
      name: `zero-${slot}`,
    }))
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

      const humanSeats = new Set<number>()
      if (opts.humanRoleIsMultiSeat) {
        for (const seat of matchedSeats) {
          agents.set(seat, asyncAgent!)
          humanSeatsForCommander.add(seat)
          humanSeats.add(seat)
        }
      } else if (matchedSeats.length > 0) {
        agents.set(matchedSeats[0], asyncAgent!)
        humanSeatsForCommander.add(matchedSeats[0])
        humanSeats.add(matchedSeats[0])
      }

      // 非人間席を役職に応じた skoll-zero ISMCTS エージェントに割当
      for (const [seat, role] of seatRoles) {
        if (humanSeats.has(seat)) continue
        const slot = roleToSlot(role)
        if (!slot) continue
        const agent = zeroCommandAgents.get(slot)
        if (agent) agents.set(seat, agent)
      }

      // stateRef は onStateReady で onRolesAssigned の前に捕捉済み
      post({
        type: 'rolesAssigned',
        seatRoles: [...seatRoles.entries()],
        humanSeats: [...humanSeats],
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
