/**
 * demo 用: mason_brain NN の checkpoint 読み込み + 推論ヘルパー
 *
 * skoll-supervised pretrain で生成した checkpoint を browser で load し、
 * VillageStatus + Possibilities + viewer seat から vote 確率を計算する。
 *
 * 制約:
 *   - 完全な GameState を VillageStatus から復元できないため、
 *     一部観測次元（divineHistory 等）は空。mason 視点では問題なし。
 *   - viewer seat と partner seat はユーザー指定（既知の mason 配置を想定）。
 */

import type { VillageStatus, SystemRole } from '../src/types/index.ts'
import type { TeamDecisionContext, ExecutionPlan } from '../src/fenrir/src/agents/agent.ts'
import type { GameState, PlayerState, GameEvent } from '../src/lupa/types.ts'
import { resolveRules } from '../src/howl/ruleset.ts'
import { Rng } from '../src/lupa/random.ts'
import {
  encodeCollectiveMasonObservation,
  SEATS,
  MASON_COLLECTIVE_OBSERVATION_SIZE,
  MASON_COLLECTIVE_SEAT_FEATURES,
  MASON_COLLECTIVE_CLS_FEATURES,
  NUM_ROLE_TOKENS,
  ROLE_TOKEN_FEATURES,
} from '../src/fenrir/src/observation.ts'
import { TransformerNetwork } from '../src/fenrir/src/ml/transformer-network.ts'
import type { AnyNetwork, NetworkConfig } from '../src/fenrir/src/ml/nn.ts'
import { HEAD_SIZES } from '../src/fenrir/src/action.ts'

// training.ts は TF.js (Node-only) を取り込むので、demo (browser) では直接 NetworkConfig を組む
const MASON_BRAIN_TRANSFORMER_CONFIG: NetworkConfig = {
  inputSize: MASON_COLLECTIVE_OBSERVATION_SIZE,
  heads: { vote: HEAD_SIZES.vote },
  sigmoidHeads: {},
  transformer: {
    dModel: 64,
    numHeads: 4,
    dFf: 128,
    planFeatures: 0,
    maxPlanTokens: 0,
    roleFeatures: ROLE_TOKEN_FEATURES,
    numRoleTokens: NUM_ROLE_TOKENS,
    seatLayers: 3,
    strategyLayers: 2,
    numPlanTokens: 0,
    planVocabSize: 0,
    seatFeatures: MASON_COLLECTIVE_SEAT_FEATURES,
    clsFeatures: MASON_COLLECTIVE_CLS_FEATURES,
    perSeatHeads: ['vote'],
    perSeatSigmoidHeads: [],
  },
}

function createMasonBrainNetwork(): TransformerNetwork {
  return new TransformerNetwork(MASON_BRAIN_TRANSFORMER_CONFIG, 'mason_collective')
}

export type MasonInferenceResult = {
  voteLogits: Float32Array
  voteProbs: Float32Array
  bestSeat: number
  /** alive seats のみ、prob 降順 */
  ranked: Array<{ seat: number, prob: number }>
}

export type CheckpointMeta = {
  iteration: number
  winRate: number
  timestamp: string
}

function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

/** JSON 文字列または fetch URL から checkpoint を load する */
export async function loadMasonBrainFromJson(jsonText: string): Promise<{ network: AnyNetwork, meta: CheckpointMeta }> {
  const data = JSON.parse(jsonText)
  const network = createMasonBrainNetwork()
  const weights = new Map<string, Float32Array>()
  for (const [name, b64] of Object.entries(data.weights as Record<string, string>)) {
    weights.set(name, base64ToFloat32(b64))
  }
  network.loadWeights(weights)
  return { network, meta: data.metadata }
}

export async function loadMasonBrainFromUrl(url: string): Promise<{ network: AnyNetwork, meta: CheckpointMeta }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
  const text = await res.text()
  return loadMasonBrainFromJson(text)
}

export type InferenceInputs = {
  vs: VillageStatus
  setup: Map<SystemRole, number>
  /** Skoll 計算で使った Possibilities の per-seat possible roles */
  globalPossibilities: Map<number, Set<SystemRole>>
  /** mason 視点 seat（生存している必要がある） */
  viewerSeat: number
  /** mason partner seat（不明なら null） */
  partnerSeat: number | null
  /** Howl から復元した public events（指定なし = 空、観測の per-seat 特徴がゼロになる） */
  publicEvents?: readonly GameEvent[]
}

/**
 * VillageStatus + viewer seat から TeamDecisionContext を mock する。
 *
 * 役職割当は viewer/partner = mason、それ以外は villager と仮置き。
 * 観測の seat-level 特徴は alive/CO/投票履歴ベースなので、仮置きで問題なし。
 */
function buildMasonContext(inputs: InferenceInputs): TeamDecisionContext {
  const { vs, viewerSeat, partnerSeat, globalPossibilities, publicEvents } = inputs

  const aliveSeats: number[] = []
  for (const [seat, status] of vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  aliveSeats.sort((a, b) => a - b)

  const players: PlayerState[] = []
  const maxSeat = Math.max(...vs.statuses.keys())
  for (let seat = 1; seat <= maxSeat; seat++) {
    const status = vs.statuses.get(seat)
    if (!status) continue
    const role: SystemRole = (seat === viewerSeat || seat === partnerSeat) ? 'mason' : 'villager'
    players.push({
      seat,
      name: String(seat),
      role,
      alive: status.surviving,
      claimedRole: null,
      claimedDay: null,
      divineHistory: new Map(),
      guardHistory: new Map(),
      fakeDivineHistory: new Map(),
      forecastTarget: null,
    })
  }

  const myPlayer = players.find(p => p.seat === viewerSeat)
  if (!myPlayer) throw new Error(`viewerSeat ${viewerSeat} not in VillageStatus`)
  if (!myPlayer.alive) throw new Error(`viewerSeat ${viewerSeat} is dead`)

  const day = (vs as { day?: number }).day ?? 1

  const gameState: GameState = {
    players,
    day,
    phase: 'day',
    finished: false,
    result: null,
    executionHistory: new Map(),
    commander: null,
    ext: {} as never,
  }

  const teamSeats = partnerSeat !== null && partnerSeat !== viewerSeat
    ? [viewerSeat, partnerSeat]
    : [viewerSeat]
  const teamPlayers = players.filter(p => teamSeats.includes(p.seat))

  return {
    mySeat: viewerSeat,
    myRole: 'mason',
    myPlayer,
    day,
    phase: 'day',
    alivePlayers: aliveSeats,
    publicEvents: publicEvents ?? [],
    signals: [],
    commander: null,
    proposals: [],
    rng: new Rng(0),
    gameState,
    lastExecutedSeat: null,
    retarPossibilities: globalPossibilities,
    maxSurvivingNV: null,
    globalRetarPossibilities: globalPossibilities,
    wolfTeammates: null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: partnerSeat,
    revoteRound: 0,
    revoteCandidates: null,
    executionPlans: [] as ExecutionPlan[],
    planIndices: null,
    tsumiTarget: null,
    rules: resolveRules(),
    teamSeats,
    teamPlayers,
    currentActorSeat: viewerSeat,
  }
}

export function runMasonInference(
  network: AnyNetwork,
  inputs: InferenceInputs,
): MasonInferenceResult {
  const ctx = buildMasonContext(inputs)
  const obs = encodeCollectiveMasonObservation(ctx)
  const result = network.forward(obs)
  const voteLogits = result.policies.get('vote')
  if (!voteLogits) throw new Error('NN does not have vote head')

  // alive マスク + self/partner 除外
  const aliveMask = new Uint8Array(SEATS)
  for (const seat of ctx.alivePlayers) {
    if (seat >= 1 && seat <= SEATS) aliveMask[seat - 1] = 1
  }
  if (ctx.mySeat >= 1 && ctx.mySeat <= SEATS) aliveMask[ctx.mySeat - 1] = 0
  if (ctx.masonPartner !== null && ctx.masonPartner >= 1 && ctx.masonPartner <= SEATS) {
    aliveMask[ctx.masonPartner - 1] = 0
  }

  // softmax over masked
  let maxLogit = -Infinity
  for (let i = 0; i < SEATS; i++) {
    if (aliveMask[i] && voteLogits[i] > maxLogit) maxLogit = voteLogits[i]
  }
  const voteProbs = new Float32Array(SEATS)
  let expSum = 0
  for (let i = 0; i < SEATS; i++) {
    if (aliveMask[i]) {
      voteProbs[i] = Math.exp(voteLogits[i] - maxLogit)
      expSum += voteProbs[i]
    }
  }
  if (expSum > 0) {
    for (let i = 0; i < SEATS; i++) voteProbs[i] /= expSum
  }

  let bestSeat = -1
  let bestProb = -1
  const ranked: Array<{ seat: number, prob: number }> = []
  for (const seat of ctx.alivePlayers) {
    if (seat < 1 || seat > SEATS) continue
    if (!aliveMask[seat - 1]) continue
    const prob = voteProbs[seat - 1]
    ranked.push({ seat, prob })
    if (prob > bestProb) { bestProb = prob; bestSeat = seat }
  }
  ranked.sort((a, b) => b.prob - a.prob)

  return { voteLogits, voteProbs, bestSeat, ranked }
}
