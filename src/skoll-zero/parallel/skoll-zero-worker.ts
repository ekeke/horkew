/**
 * skoll-zero self-play worker entry。
 *
 * Stage 1: worker 内で Pure JS NN forward を実行する経路。
 *   - main から SelfPlayChunkRequest を受信
 *   - SharedWeights から MasonZeroNetwork を 6 slot 分構築
 *   - runMultiAgentSelfPlayGame を seeds 数だけ実行
 *   - finalize 済み TrainingRecord[] を SelfPlayChunkResult として返す
 *
 * 例外時は SelfPlayChunkError を返す (main 側で拾って再 throw)。
 */

import { parentPort } from 'node:worker_threads'

import type { SystemRole } from '../../types/index.ts'
import { unpackWeights } from '../../fenrir/src/parallel.ts'
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import {
  createSkollZeroNetwork,
  createStandardZeroNetwork,
  createWolfZeroNetwork,
  createFanaticZeroNetwork,
  createWolfImitationZeroNetwork,
} from '../network/config.ts'
import { MasonZeroNetwork } from '../network/mason-zero.ts'
import { WolfImitationNetwork } from '../network/wolf-imitation-network.ts'
import { TrainingBuffer, type TrainingRecord } from '../selfplay/buffer.ts'
import {
  runMultiAgentSelfPlayGame,
  type SlotMap,
  type AgentSlot,
} from '../selfplay/multi-runner.ts'
import type { MCTSConfig } from '../mcts/ISMCTS.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import { ProxiedMasonZeroNN } from './proxy-nn.ts'
import type {
  SelfPlayChunkRequest,
  SelfPlayChunkResult,
  SelfPlayChunkError,
  SerializedOutcomes,
  SlotName,
} from './types.ts'
import { createEmptyClaimMatrix, addClaim, type ClaimMatrix } from '../eval/claim-matrix.ts'

if (!parentPort) throw new Error('skoll-zero-worker must run in a worker thread')

/**
 * slot 名 → 対応する Pure JS network factory。
 *
 * wolf slot は wolfImitation=true で WolfImitationNetwork 用 wolf NN を作る (head 構造が
 * 異なるため、weights の serialize/unpack も新 head 名で対応)。
 */
function buildPureNetForSlot(slotKey: SlotName, wolfImitation: boolean): TransformerNetwork {
  switch (slotKey) {
    case 'mason': return createSkollZeroNetwork()
    case 'wolf': return wolfImitation ? createWolfImitationZeroNetwork() : createWolfZeroNetwork()
    case 'fanatic': return createFanaticZeroNetwork()
    case 'village':
    case 'hamster':
    case 'immoralist': return createStandardZeroNetwork()
  }
  throw new Error(`unknown slot: ${slotKey satisfies never}`)
}

/** mulberry32 — multi-trainer.ts の private makeRng と完全一致させる (再現性のため) */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  if (s === 0) s = 1
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

parentPort.on('message', async (req: SelfPlayChunkRequest) => {
  try {
    if (req.type !== 'self_play_chunk') {
      throw new Error(`unknown message type: ${(req as { type: string }).type}`)
    }
    const result = await processChunk(req)
    parentPort!.postMessage(result satisfies SelfPlayChunkResult)
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    parentPort!.postMessage({
      type: 'self_play_error',
      message: e.message,
      stack: e.stack,
    } satisfies SelfPlayChunkError)
  }
})

async function processChunk(req: SelfPlayChunkRequest): Promise<SelfPlayChunkResult> {
  // カリキュラム: rolloutRetar が指定されたら env を上書き。from-ctx.ts:204 が読み取る。
  if (req.rolloutRetar !== undefined) {
    process.env.SKOLLZ_ROLLOUT_RETAR = req.rolloutRetar ? '1' : '0'
  }
  const useProxy = req.forwardSABs !== undefined && req.workerId !== undefined
  // Wolf imitation 有効化判定: req.wolfImitationFrozenVillageWeights が指定されたら、
  // wolf slot は WolfImitationNetwork (frozen village + deviation/α) で構築。
  // この場合 wolf slot のみ ProxiedMasonZeroNN を bypass (mix forward は Pure JS で実行、
  // forward server 経路は未対応)。
  const wolfImitation = req.wolfImitationFrozenVillageWeights !== undefined
  // Wolf imitation 用の frozen village (Pure JS、morning 経路で使う) と、
  // proxy 経路有効時の batched 版 (claim_decision 4 viewer 用) を構築。
  let frozenVillagePure: TransformerNetwork | undefined
  let frozenVillageBatched: MasonZeroNN | undefined
  if (wolfImitation && req.wolfImitationFrozenVillageWeights) {
    frozenVillagePure = createStandardZeroNetwork()
    unpackWeights(frozenVillagePure, req.wolfImitationFrozenVillageWeights)
    // proxy 経路有効時 (SKOLLZ_PARALLEL_GPU=1 + forwardSABs あり) は、
    // claim_decision の 4 viewer obs を main thread の TF GPU で 1 batched forward に
    // まとめるため、frozenVillage 用の ProxiedMasonZeroNN を構築。
    // 内部 fallback として Pure JS net を MasonZeroNetwork で wrap (forward server エラー時用、
    // 通常パスでは使われない)。
    if (useProxy) {
      const frozenMason = new MasonZeroNetwork(frozenVillagePure, { zeroValueHead: false })
      frozenVillageBatched = new ProxiedMasonZeroNN(
        'frozenVillage',
        frozenMason,
        req.forwardSABs!.signalSAB,
        req.forwardSABs!.requestSAB,
        req.forwardSABs!.responseSAB,
        req.workerId!,
      )
    }
  }

  const slots: SlotMap = {}
  for (const slotName of Object.keys(req.weights) as SlotName[]) {
    const sw = req.weights[slotName]
    if (!sw) continue
    const pureNet = buildPureNetForSlot(slotName, wolfImitation && slotName === 'wolf')
    unpackWeights(pureNet, sw)

    let nn: MasonZeroNN
    if (slotName === 'wolf' && wolfImitation && frozenVillagePure) {
      // WolfImitationNetwork で wrap (frozen village + deviation/α)。
      // proxy 経路有効時は frozenVillageBatched を渡して claim_decision を batched 化。
      nn = new WolfImitationNetwork(frozenVillagePure, pureNet, {
        zeroValueHead: false,
        frozenVillageBatched,
      })
    } else {
      const masonZero = new MasonZeroNetwork(pureNet, { zeroValueHead: false })
      nn = useProxy
        ? new ProxiedMasonZeroNN(
            slotName,
            masonZero,
            req.forwardSABs!.signalSAB,
            req.forwardSABs!.requestSAB,
            req.forwardSABs!.responseSAB,
            req.workerId!,
          )
        : masonZero
    }
    const slot: AgentSlot = { nn, buffer: new TrainingBuffer() }
    slots[slotName] = slot
  }

  const rng = makeRng(req.mctsConfig.rngSeed)
  const mctsConfig: MCTSConfig = {
    cPuct: req.mctsConfig.cPuct,
    nRollouts: req.mctsConfig.nRollouts,
    rng,
    rootDirichletAlpha: req.mctsConfig.rootDirichletAlpha,
    rootDirichletEps: req.mctsConfig.rootDirichletEps,
    dayBonusCoef: req.mctsConfig.dayBonusCoef,
    endgameBonusCoef: req.mctsConfig.endgameBonusCoef,
    nightParallel: req.mctsConfig.nightParallel,
    narrowBonusCoef: req.mctsConfig.narrowBonusCoef,
  }

  // rolesEntries が undefined なら roles を渡さず、runMultiAgentSelfPlayGame 内の
  // `cfg.roles ?? DEFAULT_ROLES` fallback を使う。
  const roles = req.rolesEntries
    ? new Map<SystemRole, number>(req.rolesEntries)
    : undefined

  const outcomes: SerializedOutcomes = {
    villagerWon: 0, werewolfWon: 0, werehamsterWon: 0, draw: 0,
  }
  const entropyStats: Partial<Record<SlotName, { sum: number, count: number }>> = {}
  const claimMatrix: ClaimMatrix = createEmptyClaimMatrix()

  for (const seed of req.seeds) {
    const r = await runMultiAgentSelfPlayGame({
      slots,
      roles,
      mctsConfig,
      selectionMode: req.selectionMode,
      seed,
      dirichletEpsBySlot: req.dirichletEpsBySlot,
    })
    switch (r.result) {
      case 'villager_won': outcomes.villagerWon++; break
      case 'werewolf_won': outcomes.werewolfWon++; break
      case 'werehamster_won': outcomes.werehamsterWon++; break
      case 'draw': outcomes.draw++; break
    }
    for (const slotName of Object.keys(r.stats) as SlotName[]) {
      const s = r.stats[slotName]
      if (!s) continue
      const acc = entropyStats[slotName] ?? { sum: 0, count: 0 }
      acc.sum += s.entropyRatioSum
      acc.count += s.entropyRatioCount
      entropyStats[slotName] = acc
    }
    for (const sc of r.seatClaims) {
      addClaim(claimMatrix, sc.role, sc.claimedRole)
    }
  }

  const records: Partial<Record<SlotName, TrainingRecord[]>> = {}
  for (const slotName of Object.keys(slots) as SlotName[]) {
    const slot = slots[slotName]
    if (!slot) continue
    records[slotName] = [...slot.buffer.records()]
  }

  return { type: 'self_play_result', records, outcomes, entropyStats, claimMatrix }
}
