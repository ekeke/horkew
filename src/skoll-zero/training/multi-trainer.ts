/**
 * Multi-agent skoll-zero trainer。
 *
 * SlotMap の各役職が独立した NN + buffer を持ち、1 round で:
 *   1. 全 slot 参加の self-play batch 実行
 *   2. slot ごとに N step train → Pure JS net に sync
 *   3. slot ごとに checkpoint 保存
 *
 * 1 slot だけ有効な場合は元の SkollZeroTrainer と同等の動作。
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MasonZeroNetwork } from '../network/mason-zero.ts'
import type { TfTransformerNetwork } from '../../fenrir/src/ml/nn-tf-transformer.ts'
import type { MasonZeroNN } from '../mcts/nn.ts'
import { saveCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import {
  runMultiAgentSelfPlayBatch,
  type SlotMap,
  type AgentSlot,
  type MultiAgentSelfPlayResult,
} from '../selfplay/multi-runner.ts'
import type { MCTSConfig } from '../mcts/ISMCTS.ts'
import { groupRecordsByHead, recordsToBatchInputs } from './trainer.ts'
import type { SkollZeroTrainConfig } from './schedule.ts'

export type TrainerSlot = {
  /** Pure JS 推論用 (self-play で使用、default) */
  masonZeroNet: MasonZeroNetwork
  /** TF.js 学習用 */
  tfNet: TfTransformerNetwork
  /**
   * Optional: self-play 推論を masonZeroNet (Pure JS) ではなくこの NN で行う。
   * SKOLLZ_INFER_GPU=1 で TfMasonZeroNetwork を構築して入れる経路。
   * 未指定なら masonZeroNet が使われる (既存挙動)。
   */
  inferNet?: MasonZeroNN
  /** 教師データ buffer */
  buffer: TrainingBuffer
  /** true なら train step / sync / checkpoint 上書きを skip (self-play では使う) */
  frozen?: boolean
}

export type MultiTrainerSlots = {
  mason?: TrainerSlot
  village?: TrainerSlot
  wolf?: TrainerSlot
  fanatic?: TrainerSlot
  hamster?: TrainerSlot
  immoralist?: TrainerSlot
}

export type MultiRoundStats = {
  round: number
  gamesPlayed: number
  outcomes: { villagerWon: number, werewolfWon: number, werehamsterWon: number, draw: number }
  /** slot ごとの train 統計 */
  perSlot: Partial<Record<keyof MultiTrainerSlots, {
    recordsAdded: number
    bufferSize: number
    bufferExpired: number
    stepsRun: number
    avgLoss: number
    avgPolicyLoss: number
    avgValueLoss: number
    checkpointPath: string
  }>>
}

export type MultiSkollZeroTrainerOptions = {
  slots: MultiTrainerSlots
  config: SkollZeroTrainConfig
}

export class MultiSkollZeroTrainer {
  private readonly slots: MultiTrainerSlots
  private readonly config: SkollZeroTrainConfig
  private rng: () => number
  private gameSeedCounter: number

  constructor(opts: MultiSkollZeroTrainerOptions) {
    this.slots = opts.slots
    this.config = opts.config
    this.rng = makeRng(opts.config.rngSeed)
    this.gameSeedCounter = opts.config.rngSeed
  }

  private asSlotMap(): SlotMap {
    const out: SlotMap = {}
    for (const key of ['mason', 'village', 'wolf', 'fanatic', 'hamster', 'immoralist'] as const) {
      const s = this.slots[key]
      if (s) (out[key] as AgentSlot) = { nn: s.inferNet ?? s.masonZeroNet, buffer: s.buffer }
    }
    return out
  }

  async trainRound(roundId: number, outputDir: string): Promise<MultiRoundStats> {
    const mctsConfig: MCTSConfig = {
      cPuct: this.config.cPuct,
      nRollouts: this.config.mctsRollouts,
      rng: this.rng,
      rootDirichletAlpha: this.config.rootDirichletAlpha,
      rootDirichletEps: this.config.rootDirichletEps,
    }

    // preSize 記録 (slot ごとに後で recordsAdded を計算)
    const preSize = new Map<keyof MultiTrainerSlots, number>()
    for (const key of ['mason', 'village', 'wolf', 'fanatic', 'hamster', 'immoralist'] as const) {
      if (this.slots[key]) preSize.set(key, this.slots[key]!.buffer.size())
    }

    // self-play batch
    const outcomes = { villagerWon: 0, werewolfWon: 0, werehamsterWon: 0, draw: 0 }
    const onGameComplete = (_i: number, r: MultiAgentSelfPlayResult): void => {
      switch (r.result) {
        case 'villager_won': outcomes.villagerWon++; break
        case 'werewolf_won': outcomes.werewolfWon++; break
        case 'werehamster_won': outcomes.werehamsterWon++; break
        case 'draw': outcomes.draw++; break
      }
    }
    await runMultiAgentSelfPlayBatch(
      {
        slots: this.asSlotMap(),
        seed: this.gameSeedCounter,
        mctsConfig,
        selectionMode: 'sample',
      },
      this.config.gamesPerRound,
      onGameComplete,
    )
    this.gameSeedCounter += this.config.gamesPerRound

    // 各 slot で train + sync + checkpoint
    const perSlot: MultiRoundStats['perSlot'] = {}
    for (const key of ['mason', 'village', 'wolf', 'fanatic', 'hamster', 'immoralist'] as const) {
      const slot = this.slots[key]
      if (!slot) continue

      const recordsAdded = slot.buffer.size() - (preSize.get(key) ?? 0)
      const bufferExpired = slot.buffer.expireOldest(this.config.bufferCapacity)

      let lossSum = 0, policyLossSum = 0, valueLossSum = 0, stepsWithData = 0
      if (!slot.frozen) {
        for (let s = 0; s < this.config.stepsPerRound; s++) {
          const records = slot.buffer.sample(this.config.batchSize, this.rng)
          if (records.length === 0) break
          // head 別にバケット分割し、MCTS-π head (vote/attack/divine/guard) を trainMasonZero で学習
          const groups = groupRecordsByHead(records)
          let stepLoss = 0, stepPolicyLoss = 0, stepValueLoss = 0, headsTrained = 0
          for (const [headName, bucket] of groups) {
            if (bucket.length === 0) continue
            const { observations, policyTargets, masks, outcomeTargets } = recordsToBatchInputs(bucket)
            const res = slot.tfNet.trainMasonZero({
              observations,
              policyTargets,
              masks,
              outcomeTargets,
              valueCoeff: this.config.valueCoeff,
              headName,
            })
            stepLoss += res.loss
            stepPolicyLoss += res.policyLoss
            stepValueLoss += res.valueLoss
            headsTrained++
          }
          if (headsTrained === 0) break
          // head 間で loss を平均して step として計上 (record 数で重み付けは将来検討)
          lossSum += stepLoss / headsTrained
          policyLossSum += stepPolicyLoss / headsTrained
          valueLossSum += stepValueLoss / headsTrained
          stepsWithData++
        }
        // sync TF → Pure JS
        slot.masonZeroNet.net.loadWeights(slot.tfNet.cloneWeights())
      }

      const avgLoss = stepsWithData > 0 ? lossSum / stepsWithData : 0
      const avgPolicyLoss = stepsWithData > 0 ? policyLossSum / stepsWithData : 0
      const avgValueLoss = stepsWithData > 0 ? valueLossSum / stepsWithData : 0

      const checkpointPath = this.saveSlotCheckpoint(outputDir, roundId, key, slot.masonZeroNet)
      perSlot[key] = {
        recordsAdded,
        bufferSize: slot.buffer.size(),
        bufferExpired,
        stepsRun: stepsWithData,
        avgLoss,
        avgPolicyLoss,
        avgValueLoss,
        checkpointPath,
      }
    }

    return {
      round: roundId,
      gamesPlayed: this.config.gamesPerRound,
      outcomes,
      perSlot,
    }
  }

  private saveSlotCheckpoint(
    outputDir: string,
    roundId: number,
    slotKey: keyof MultiTrainerSlots,
    net: MasonZeroNetwork,
  ): string {
    const slotDir = join(outputDir, slotKey, `round_${String(roundId).padStart(4, '0')}`)
    if (!existsSync(slotDir)) mkdirSync(slotDir, { recursive: true })
    const weightsPath = join(slotDir, 'weights.json')
    saveCheckpoint(net.net, weightsPath, { iteration: roundId, winRate: 0 })
    const finalPath = join(outputDir, slotKey, 'final.json')
    if (!existsSync(join(outputDir, slotKey))) mkdirSync(join(outputDir, slotKey), { recursive: true })
    copyFileSync(weightsPath, finalPath)
    return weightsPath
  }
}

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

/** 補助: meta.json を書き出す */
export function writeRoundMeta(outputDir: string, stats: MultiRoundStats): void {
  const metaPath = join(outputDir, `round_${String(stats.round).padStart(4, '0')}_meta.json`)
  writeFileSync(metaPath, JSON.stringify({ ...stats, timestamp: new Date().toISOString() }, null, 2))
}
