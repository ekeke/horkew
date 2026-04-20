/**
 * demo 用: 5 perspective skoll NN の checkpoint 読込 + 推論ヘルパー
 *
 * src/skoll/models/{mason,wolf,fanatic,hamster,immoralist}.json を
 * /horkew/models/ 経由で fetch し、checkpoint 内蔵の config から
 * TransformerNetwork を構築する (TF.js 非依存)。
 *
 * perspective ごとの違い:
 *   - observation encoder (standard / collective mason / collective wolf)
 *   - TeamDecisionContext vs DecisionContext (mason/wolf は team)
 *   - excluded 席 (mason: self+partner, wolf: teamSeats, fanatic: self+knownWolves,
 *     hamster: self, immoralist: self+knownHamster)
 *
 * すべての結果は UnifiedVoteAnalysis に正規化される。
 */

import type { VillageStatus, SystemRole } from '../src/types/index.ts'
import type {
  DecisionContext, TeamDecisionContext, ExecutionPlan,
} from '../src/fenrir/src/agents/agent.ts'
import type { GameState, PlayerState, GameEvent } from '../src/lupa/types.ts'
import { resolveRules } from '../src/howl/ruleset.ts'
import { Rng } from '../src/lupa/random.ts'
import {
  encodeObservation, encodeCollectiveMasonObservation, encodeCollectiveWolfObservation,
} from '../src/fenrir/src/observation.ts'
import { TransformerNetwork } from '../src/fenrir/src/ml/transformer-network.ts'
import { inferObservationMode } from '../src/fenrir/src/ml/checkpoint.ts'
import type { AnyNetwork } from '../src/fenrir/src/ml/nn.ts'
import { nnInferVote, type UnifiedVoteAnalysis } from '../src/skoll/unified.ts'

export type Perspective = 'mason' | 'wolf' | 'fanatic' | 'hamster' | 'immoralist'

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

/**
 * Checkpoint JSON テキストから TransformerNetwork を構築。
 * config は checkpoint に埋め込まれているので perspective ごとの config 定数は不要。
 */
export function loadSkollNetworkFromJson(jsonText: string): { network: AnyNetwork, meta: CheckpointMeta } {
  const data = JSON.parse(jsonText)
  const mode = inferObservationMode(data.config)
  const network = new TransformerNetwork(data.config, mode)
  const weights = new Map<string, Float32Array>()
  for (const [name, b64] of Object.entries(data.weights as Record<string, string>)) {
    weights.set(name, base64ToFloat32(b64))
  }
  network.loadWeights(weights)
  return { network, meta: data.metadata }
}

/** /horkew/models/{perspective}.json から fetch して load */
export async function loadSkollNetworkByPerspective(
  perspective: Perspective,
  baseUrl: string = import.meta.env.BASE_URL,
): Promise<{ network: AnyNetwork, meta: CheckpointMeta }> {
  const url = `${baseUrl.replace(/\/$/, '')}/models/${perspective}.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
  const text = await res.text()
  return loadSkollNetworkFromJson(text)
}

// ══════════════════════════════════════════════════════════
// DecisionContext 構築
// ══════════════════════════════════════════════════════════

export type NNInferenceInputs = {
  perspective: Perspective
  vs: VillageStatus
  setup: Map<SystemRole, number>
  globalPossibilities: Map<number, Set<SystemRole>>
  viewerSeat: number
  /** mason: partner / wolf: 他の wolf 席 / fanatic: knownWolves / immoralist: knownHamster */
  partnerSeat?: number | null
  teamSeats?: number[]
  knownWolves?: number[]
  knownHamster?: number | null
  publicEvents?: readonly GameEvent[]
}

function viewerRole(perspective: Perspective): SystemRole {
  switch (perspective) {
    case 'mason': return 'mason'
    case 'wolf': return 'werewolf'
    case 'fanatic': return 'fanatic'
    case 'hamster': return 'werehamster'
    case 'immoralist': return 'immoralist'
  }
}

function buildPlayers(
  vs: VillageStatus,
  perspective: Perspective,
  viewerSeat: number,
  teamSeats: number[],
): PlayerState[] {
  const players: PlayerState[] = []
  const maxSeat = Math.max(...vs.statuses.keys())
  const myRole = viewerRole(perspective)
  const teamSet = new Set(teamSeats)
  for (let seat = 1; seat <= maxSeat; seat++) {
    const status = vs.statuses.get(seat)
    if (!status) continue
    let role: SystemRole = 'villager'
    if (seat === viewerSeat) role = myRole
    else if (perspective === 'mason' && teamSet.has(seat)) role = 'mason'
    else if (perspective === 'wolf' && teamSet.has(seat)) role = 'werewolf'
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
  return players
}

function buildIndividualContext(
  inputs: NNInferenceInputs,
  aliveSeats: number[],
  players: PlayerState[],
): DecisionContext {
  const { vs, perspective, viewerSeat, publicEvents, globalPossibilities } = inputs
  const myPlayer = players.find(p => p.seat === viewerSeat)
  if (!myPlayer) throw new Error(`viewerSeat ${viewerSeat} not in VillageStatus`)
  if (!myPlayer.alive) throw new Error(`viewerSeat ${viewerSeat} is dead`)

  const day = (vs as { day?: number }).day ?? 1
  const gameState: GameState = {
    players, day, phase: 'day', finished: false, result: null,
    executionHistory: new Map(), commander: null,
    ext: {} as never,
  }

  return {
    mySeat: viewerSeat,
    myRole: viewerRole(perspective),
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
    knownWolves: perspective === 'fanatic' ? (inputs.knownWolves ?? null) : null,
    knownHamster: perspective === 'immoralist' ? (inputs.knownHamster ?? null) : null,
    masonPartner: null,
    revoteRound: 0,
    revoteCandidates: null,
    executionPlans: [] as ExecutionPlan[],
    planIndices: null,
    tsumiTarget: null,
    rules: resolveRules(),
  }
}

function buildTeamContext(
  inputs: NNInferenceInputs,
  aliveSeats: number[],
  players: PlayerState[],
): TeamDecisionContext {
  const { vs, perspective, viewerSeat, publicEvents, globalPossibilities } = inputs
  const myPlayer = players.find(p => p.seat === viewerSeat)
  if (!myPlayer) throw new Error(`viewerSeat ${viewerSeat} not in VillageStatus`)
  if (!myPlayer.alive) throw new Error(`viewerSeat ${viewerSeat} is dead`)

  const day = (vs as { day?: number }).day ?? 1
  const gameState: GameState = {
    players, day, phase: 'day', finished: false, result: null,
    executionHistory: new Map(), commander: null,
    ext: {} as never,
  }

  // team seats の組立て
  let teamSeats: number[] = []
  if (perspective === 'mason') {
    teamSeats = inputs.partnerSeat !== null && inputs.partnerSeat !== undefined && inputs.partnerSeat !== viewerSeat
      ? [viewerSeat, inputs.partnerSeat]
      : [viewerSeat]
  } else if (perspective === 'wolf') {
    teamSeats = (inputs.teamSeats && inputs.teamSeats.length > 0)
      ? inputs.teamSeats
      : [viewerSeat]
  }
  const teamPlayers = players.filter(p => teamSeats.includes(p.seat))

  return {
    mySeat: viewerSeat,
    myRole: viewerRole(perspective),
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
    wolfTeammates: perspective === 'wolf' ? teamSeats.filter(s => s !== viewerSeat) : null,
    knownWolves: null,
    knownHamster: null,
    masonPartner: perspective === 'mason' ? (inputs.partnerSeat ?? null) : null,
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

// ══════════════════════════════════════════════════════════
// Perspective 別 NN 推論 (UnifiedVoteAnalysis で正規化)
// ══════════════════════════════════════════════════════════

/**
 * perspective に応じた観測エンコーダで NN を回し、UnifiedVoteAnalysis を返す。
 *
 * @returns 生存席 × NN の vote 確率 (softmax、exclude 対象も候補には残り excluded=true)
 */
export function runSkollNNInference(
  network: AnyNetwork,
  inputs: NNInferenceInputs,
): UnifiedVoteAnalysis {
  const { perspective, viewerSeat } = inputs
  const aliveSeats: number[] = []
  for (const [seat, status] of inputs.vs.statuses) {
    if (status.surviving) aliveSeats.push(seat)
  }
  aliveSeats.sort((a, b) => a - b)

  const teamSeats =
    perspective === 'mason'
      ? (inputs.partnerSeat !== null && inputs.partnerSeat !== undefined ? [viewerSeat, inputs.partnerSeat] : [viewerSeat])
    : perspective === 'wolf'
      ? (inputs.teamSeats && inputs.teamSeats.length > 0 ? inputs.teamSeats : [viewerSeat])
    : [viewerSeat]

  const players = buildPlayers(inputs.vs, perspective, viewerSeat, teamSeats)

  let observation: Float32Array
  let excluded: Set<number>

  if (perspective === 'mason') {
    const ctx = buildTeamContext(inputs, aliveSeats, players)
    observation = encodeCollectiveMasonObservation(ctx)
    excluded = new Set<number>(ctx.teamSeats)
  } else if (perspective === 'wolf') {
    const ctx = buildTeamContext(inputs, aliveSeats, players)
    observation = encodeCollectiveWolfObservation(ctx)
    excluded = new Set<number>(ctx.teamSeats)
  } else {
    const ctx = buildIndividualContext(inputs, aliveSeats, players)
    observation = encodeObservation(ctx)
    excluded = new Set<number>([viewerSeat])
    if (perspective === 'fanatic' && inputs.knownWolves) {
      for (const s of inputs.knownWolves) excluded.add(s)
    }
    if (perspective === 'immoralist' && inputs.knownHamster !== null && inputs.knownHamster !== undefined) {
      excluded.add(inputs.knownHamster)
    }
  }

  return nnInferVote(network, observation, aliveSeats, excluded)
}
