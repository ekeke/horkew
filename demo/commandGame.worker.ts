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
import { CommandAdapter, type VoteCollector } from '../src/fenrir/src/adapters/command/command-adapter.ts'
import type { CommandAdapterExt, Command } from '../src/fenrir/src/adapters/command/command-types.ts'
import type { CommandAgent } from '../src/fenrir/src/command-agents/command-agent.ts'
import { SkollCommandAgent } from '../src/fenrir/src/command-agents/skoll-command-agent.ts'
import { AsyncRemoteAgent } from '../src/fenrir/src/command-agents/async-remote-agent.ts'
import type { FenrirExtEvent } from '../src/fenrir/src/events.ts'
import { TransformerNetwork } from '../src/fenrir/src/ml/transformer-network.ts'
import { inferObservationMode } from '../src/fenrir/src/observation.ts'
import {
  createHuginnVoteCollector,
  type HuginnHumanBridge,
  type HuginnHumanBridgeReq,
} from '../src/fenrir/src/adapters/command/huginn-vote-collector.ts'
import { TrainableNetwork as HuginnTrainableNetwork } from '../src/huginn/trainable-network.ts'
import { buildVocabLayout, type VocabLayout } from '../src/huginn/message-vocab.ts'
import {
  MAX_AGENTS as HUGINN_MAX_AGENTS,
  OFFER_REF_WINDOW as HUGINN_OFFER_REF_WINDOW,
  type Message as HuginnMessage,
  type RoleName as HuginnRoleName,
} from '../src/huginn/types.ts'
import { importWeights as importHuginnWeights, CHECKPOINT_VERSION as HUGINN_CHECKPOINT_VERSION, type HuginnCheckpoint } from '../src/huginn/checkpoint.ts'
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
  /**
   * Huginn 交渉投票を有効化するオプション.
   * 指定されると CommandAdapter.onVote が huginn runRounds に差し替わり、
   * 交渉メッセージと finalVote が comment event として UI ログに流れる.
   */
  huginnVoting?: {
    enabled: boolean
    /** scenario 名 (例: 'pair2v2Block'). 未指定 / fetch 失敗 / vocab 不一致なら random init. */
    scenarioName?: string
  }
}

export type PendingPayload = {
  state: GameState<CommandAdapterExt>
  mySeat: number
  legal: Command[]
}

/**
 * Huginn bridge 要求の UI 用 payload 型.
 * HuginnHumanBridgeReq を worker→main に post するにあたり、Uint8Array などの
 * TypedArray を plain array に変換した「シリアライズ可能」版.
 */
export type HuginnPendingPayload =
  | {
      type: 'message'
      self: number
      round: number
      legalMask: number[]
      layout: VocabLayout
      participants: number[]
      messageHistory: Array<{ round: number; sender: number; message: HuginnMessage }>
      viewerRole: HuginnRoleName
    }
  | {
      type: 'vote'
      self: number
      mask: number[]
      numAgents: number
      participants: number[]
      viewerRole: HuginnRoleName
    }

export type ToWorkerMessage =
  | { type: 'start', opts: StartGameOptions }
  | { type: 'submit', cmd: Command }
  | { type: 'huginn_submit', value: number }

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
  | { type: 'huginn_pending', payload: HuginnPendingPayload }
  | { type: 'huginn_pending_cleared' }
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
/** Huginn bridge 用の pending resolver. 1 リクエスト in-flight を前提に単一スロット. */
let huginnPendingResolve: ((value: number) => void) | null = null

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
      huginnPendingResolve = null
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
  } else if (msg.type === 'huginn_submit') {
    console.log('[huginn/worker] huginn_submit received, value=', msg.value)
    if (!huginnPendingResolve) {
      post({ type: 'error', message: 'huginn_submit: no pending bridge request' })
      return
    }
    const resolve = huginnPendingResolve
    huginnPendingResolve = null
    post({ type: 'huginn_pending_cleared' })
    resolve(msg.value)
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
    return net
  } catch {
    return null
  }
}

/** slot に属する全 role × method の checkpoint を並列 fetch し、map<`${role}-${method}`, net> にする */
async function fetchPhase2NetsForSlot(slot: ZeroSlot): Promise<Map<string, TransformerNetwork>> {
  const out = new Map<string, TransformerNetwork>()
  const rolesForSlot = SLOT_ROLES[slot]
  // pretrain-all.ts で生成される method 名一覧 (METHOD_HEAD_MAP と同じ 9 種類)
  const methods = ['claim', 'comm', 'propose', 'leader', 'forecast', 'defensive_claim', 'target', 'bodyguard_targets', 'predict']
  const pairs: Array<[string, string]> = []
  for (const role of rolesForSlot) {
    for (const method of methods) pairs.push([role, method])
  }
  const results = await Promise.all(pairs.map(async ([role, method]) => {
    const net = await fetchPhase2Network(`${role}-${method}.json`)
    return net ? ([`${role}-${method}`, net] as [string, TransformerNetwork]) : null
  }))
  for (const r of results) if (r) out.set(r[0], r[1])
  console.log(`[phase2] slot=${slot} loaded ${out.size}/${pairs.length} checkpoints`)
  return out
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

/** slot → その slot で動く SystemRole 集合 (phase2 checkpoint のキーに使う role) */
const SLOT_ROLES: Record<ZeroSlot, SystemRole[]> = {
  mason: ['mason'],
  village: ['villager', 'seer', 'medium', 'bodyguard', 'nekomata'],
  wolf: ['werewolf'],
  fanatic: ['fanatic'],
  hamster: ['werehamster'],
  immoralist: ['immoralist'],
}

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
  // 6 slot を並列 fetch (skoll-zero + phase2 heads 両方)
  const slotResults = await Promise.all(ZERO_SLOTS.map(async slot => {
    const [mzNet, phase2Nets] = await Promise.all([
      fetchMasonZeroNetwork(slot),
      fetchPhase2NetsForSlot(slot),
    ])
    return { slot, mzNet, phase2Nets }
  }))
  for (const { slot, mzNet, phase2Nets } of slotResults) {
    if (!mzNet) continue
    const opts = {
      nn: mzNet,
      phase2Nets: phase2Nets.size > 0 ? phase2Nets : undefined,
      ...commonOpts,
    }
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

// ============================================================
// Huginn network 構築 (voteCollector 用)
// ============================================================

/**
 * Huginn TrainableNetwork を組み立てる.
 *   - scenarioName 未指定 (デフォルト): `/horkew/models/huginn/final.json` から
 *     mix 統合学習の checkpoint を fetch (実プレイ用).
 *   - scenarioName 指定時: `/horkew/models/huginn/scenarios/{name}.json` から
 *     scenario 別 checkpoint を fetch (個別評価用).
 *   - 失敗 / vocab 不一致 → random init にフォールバック.
 *
 * Vocab は MAX_AGENTS=15 基準で固定. N≤15 の人狼卓で同じ NN が使い回せる.
 */
async function buildHuginnNetwork(scenarioName?: string): Promise<HuginnTrainableNetwork> {
  const layout = buildVocabLayout(HUGINN_MAX_AGENTS, HUGINN_OFFER_REF_WINDOW)
  const expectedVocabSize = layout.vocabSize

  const url = scenarioName
    ? `models/huginn/scenarios/${scenarioName}.json`
    : 'models/huginn/final.json'
  const label = scenarioName ?? 'mixed-final'

  try {
    const res = await fetch(url)
    if (res.ok) {
      const ckpt = await res.json() as HuginnCheckpoint
      if (ckpt.version !== HUGINN_CHECKPOINT_VERSION) {
        console.warn(`[huginn] checkpoint version ${ckpt.version} unsupported (expected ${HUGINN_CHECKPOINT_VERSION}) → random init`)
      } else if (ckpt.config.vocabSize !== expectedVocabSize) {
        console.warn(`[huginn] vocabSize ${ckpt.config.vocabSize} from ${label} does not match MAX_AGENTS-based ${expectedVocabSize} → random init`)
      } else {
        const net = new HuginnTrainableNetwork(ckpt.config)
        importHuginnWeights(net, ckpt.weights)
        console.log(`[huginn] loaded ${label} (dModel=${ckpt.config.dModel}, layers=${ckpt.config.numLayers}, vocabSize=${ckpt.config.vocabSize})`)
        return net
      }
    } else {
      console.warn(`[huginn] fetch ${url} failed (${res.status}) → random init`)
    }
  } catch (e) {
    console.warn(`[huginn] error loading ${label}:`, e)
  }

  console.log(`[huginn] using random-init network (dModel=64, layers=2, vocabSize=${expectedVocabSize})`)
  return new HuginnTrainableNetwork({
    dModel: 64,
    numLayers: 2,
    numHeads: 4,
    dFf: 128,
    vocabSize: expectedVocabSize,
  })
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

  // CommandAdapter.onEventEmitted と Huginn voteCollector の emitEvent で共通利用するクロージャ.
  // liveEvents 配列への記録 + activityLog 更新 + post(event) を一括で行う.
  const emitEvent = (event: GameEvent | FenrirExtEvent): void => {
    liveEvents.push(event)
    if (event.type === 'comment') {
      const text = (event as { text: string }).text
      recentComments.push(text)
      if (recentComments.length > opts.activityLogLimit) {
        recentComments.splice(0, recentComments.length - opts.activityLogLimit)
      }
    }

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
  }

  // defaultAgent は adapter と collector で共有 (どちらも seed+1 で決定性を揃える)
  const adapterDefaultAgent = new SkollCommandAgent({ seed: seed + 1 })

  // Huginn bridge: worker → main の pending 送信 + submit の resolve を繋ぐ.
  // huginnHumanBridge は collector の各 round / finalVote で呼ばれる.
  const huginnHumanBridge: HuginnHumanBridge = (req: HuginnHumanBridgeReq) => {
    console.log(`[huginn/worker] bridge req type=${req.type} self=seat${req.self}${req.type === 'message' ? ` round=${req.round}` : ''}`)
    const payload: HuginnPendingPayload = req.type === 'message'
      ? {
          type: 'message',
          self: req.self,
          round: req.round,
          legalMask: Array.from(req.legalMask),
          layout: req.layout,
          participants: [...req.participants],
          messageHistory: req.messageHistory.map(e => ({
            round: e.round, sender: e.sender, message: e.message,
          })),
          viewerRole: req.viewerRole,
        }
      : {
          type: 'vote',
          self: req.self,
          mask: Array.from(req.mask),
          numAgents: req.numAgents,
          participants: [...req.participants],
          viewerRole: req.viewerRole,
        }
    return new Promise<number>((resolve) => {
      huginnPendingResolve = resolve
      try {
        post({ type: 'huginn_pending', payload })
        console.log('[huginn/worker] huginn_pending posted')
      } catch (err) {
        console.error('[huginn/worker] failed to post huginn_pending', err)
      }
    })
  }

  // Huginn 交渉投票が enabled なら voteCollector を組み立てる (checkpoint fetch or random init).
  // agents Map / humanSeatsForCommander は onRolesAssigned で populate されるが、参照渡しなので
  // collector 呼び出し時には埋まっている.
  let huginnVoteCollector: VoteCollector | undefined = undefined
  if (opts.huginnVoting?.enabled) {
    const huginnNetwork = await buildHuginnNetwork(opts.huginnVoting.scenarioName)
    huginnVoteCollector = createHuginnVoteCollector({
      network: huginnNetwork,
      sampling: 'stochastic',
      seed: seed + 7,
      emitEvent,
      agents,
      defaultAgent: adapterDefaultAgent,
      humanSeats: humanSeatsForCommander,
      humanBridge: huginnHumanBridge,
    })
  }

  const adapter = new CommandAdapter({
    agents,
    defaultAgent: adapterDefaultAgent,
    roles: rolesMap,
    seed,
    preferredCommanderSeats: humanSeatsForCommander,
    onStateReady: (state) => {
      stateRef = state
    },
    onEventEmitted: emitEvent,
    voteCollector: huginnVoteCollector,
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

  // 14D猫は再投票ルール (full_revote). GameConfig.revoteConfig が未指定だと lupa
  // engine が default 'random_tied' (= 決戦・ランダム解決) に落ちるため、ここで明示.
  // lupaConfig と同一設定を共有する.
  const config: GameConfig = {
    roles: rolesMap,
    seed,
    hasFirstGhost: opts.hasFirstGhost,
    nameStyle: 'random',
    revoteConfig: lupaConfig.revoteConfig,
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
