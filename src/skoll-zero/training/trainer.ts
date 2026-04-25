/**
 * skoll-zero Phase 1 trainer。
 *
 * 責務:
 *   - buffer から minibatch を抽出 (MCTS visits Map → 14-dim π + legal mask)
 *   - TF.js で trainMasonZero (CE(π) + c_value * MSE(z)) を 1 step
 *   - TF → Pure JS 重み同期 (self-play 用 MasonZeroNetwork に反映)
 *   - round 単位の checkpoint 保存
 *
 * 外部呼び出しは `trainRound(roundId, outputDir)` を回すだけ。
 * self-play batch はこの中で runSelfPlayBatch を呼ぶ。
 *
 * Phase 1 は同期実行 (self-play → train → checkpoint) の単純ループ。
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MasonZeroNetwork } from '../network/mason-zero.ts'
import type { TfTransformerNetwork } from '../../fenrir/src/ml/nn-tf-transformer.ts'
import { saveCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { SEATS } from '../../fenrir/src/observation.ts'
import { TrainingBuffer } from '../selfplay/buffer.ts'
import type { TrainingRecord } from '../selfplay/buffer.ts'
import type { HeadName } from '../mcts/nn.ts'
import { runSelfPlayBatch } from '../selfplay/runner.ts'
import type { SelfPlayResult } from '../selfplay/runner.ts'
import type { MCTSConfig } from '../mcts/ISMCTS.ts'
import type { SkollZeroTrainConfig } from './schedule.ts'

const ILLEGAL_MASK_VALUE = -1e9

export type TrainStepStats = {
  loss: number
  policyLoss: number
  valueLoss: number
  /** 実際に投入された batch size (buffer が空だと 0) */
  batchSize: number
}

export type RoundStats = {
  round: number
  gamesPlayed: number
  recordsAdded: number
  bufferSize: number
  bufferExpired: number
  stepsRun: number
  /** 平均 loss over steps */
  avgLoss: number
  avgPolicyLoss: number
  avgValueLoss: number
  /** self-play 結果の集計 */
  outcomes: {
    villagerWon: number
    werewolfWon: number
    werehamsterWon: number
    draw: number
  }
  /** チェックポイント path (保存された weights.json) */
  checkpointPath: string
}

export type SkollZeroTrainerOptions = {
  masonZeroNet: MasonZeroNetwork
  tfNet: TfTransformerNetwork
  buffer: TrainingBuffer
  config: SkollZeroTrainConfig
}

export class SkollZeroTrainer {
  private readonly masonZeroNet: MasonZeroNetwork
  private readonly tfNet: TfTransformerNetwork
  private readonly buffer: TrainingBuffer
  private readonly config: SkollZeroTrainConfig
  private rng: () => number
  private gameSeedCounter: number

  constructor(opts: SkollZeroTrainerOptions) {
    this.masonZeroNet = opts.masonZeroNet
    this.tfNet = opts.tfNet
    this.buffer = opts.buffer
    this.config = opts.config
    this.rng = makeRng(opts.config.rngSeed)
    this.gameSeedCounter = opts.config.rngSeed
  }

  /** TF 重みを Pure JS MasonZeroNetwork に反映 (次 self-play batch で使われる) */
  syncWeights(): void {
    this.masonZeroNet.net.loadWeights(this.tfNet.cloneWeights())
  }

  /** buffer から batch をサンプリング → trainMasonZero を 1 step 実行 */
  trainStep(): TrainStepStats {
    const records = this.buffer.sample(this.config.batchSize, this.rng)
    if (records.length === 0) {
      return { loss: 0, policyLoss: 0, valueLoss: 0, batchSize: 0 }
    }
    const { observations, policyTargets, masks, outcomeTargets } = recordsToBatchInputs(records)
    const res = this.tfNet.trainMasonZero({
      observations,
      policyTargets,
      masks,
      outcomeTargets,
      valueCoeff: this.config.valueCoeff,
      headName: 'execute',
    })
    return { ...res, batchSize: records.length }
  }

  /**
   * 1 round: self-play gamesPerRound → train stepsPerRound → sync → checkpoint。
   */
  async trainRound(roundId: number, outputDir: string): Promise<RoundStats> {
    const mctsConfig: MCTSConfig = {
      cPuct: this.config.cPuct,
      nRollouts: this.config.mctsRollouts,
      rng: this.rng,
      rootDirichletAlpha: this.config.rootDirichletAlpha,
      rootDirichletEps: this.config.rootDirichletEps,
    }

    // self-play batch
    const preSize = this.buffer.size()
    const outcomes = { villagerWon: 0, werewolfWon: 0, werehamsterWon: 0, draw: 0 }
    const onGameComplete = (_i: number, r: SelfPlayResult): void => {
      switch (r.result) {
        case 'villager_won': outcomes.villagerWon++; break
        case 'werewolf_won': outcomes.werewolfWon++; break
        case 'werehamster_won': outcomes.werehamsterWon++; break
        case 'draw': outcomes.draw++; break
      }
    }
    await runSelfPlayBatch(
      {
        nn: this.masonZeroNet,
        buffer: this.buffer,
        seed: this.gameSeedCounter,
        mctsConfig,
        selectionMode: 'sample',
      },
      this.config.gamesPerRound,
      onGameComplete,
    )
    this.gameSeedCounter += this.config.gamesPerRound

    const recordsAdded = this.buffer.size() - preSize
    const bufferExpired = this.buffer.expireOldest(this.config.bufferCapacity)

    // train loop
    let lossSum = 0
    let policyLossSum = 0
    let valueLossSum = 0
    let stepsWithData = 0
    for (let s = 0; s < this.config.stepsPerRound; s++) {
      const st = this.trainStep()
      if (st.batchSize === 0) break
      lossSum += st.loss
      policyLossSum += st.policyLoss
      valueLossSum += st.valueLoss
      stepsWithData++
    }

    // sync TF → Pure JS
    this.syncWeights()

    // checkpoint
    const avgLoss = stepsWithData > 0 ? lossSum / stepsWithData : 0
    const avgPolicyLoss = stepsWithData > 0 ? policyLossSum / stepsWithData : 0
    const avgValueLoss = stepsWithData > 0 ? valueLossSum / stepsWithData : 0

    const checkpointPath = this.saveRoundCheckpoint(outputDir, roundId, {
      round: roundId,
      gamesPlayed: this.config.gamesPerRound,
      recordsAdded,
      bufferSize: this.buffer.size(),
      bufferExpired,
      stepsRun: stepsWithData,
      avgLoss,
      avgPolicyLoss,
      avgValueLoss,
      outcomes,
    })

    return {
      round: roundId,
      gamesPlayed: this.config.gamesPerRound,
      recordsAdded,
      bufferSize: this.buffer.size(),
      bufferExpired,
      stepsRun: stepsWithData,
      avgLoss,
      avgPolicyLoss,
      avgValueLoss,
      outcomes,
      checkpointPath,
    }
  }

  /**
   * `outputDir/round_NNNN/{weights.json,meta.json}` を保存し、
   * `outputDir/final.json` にも最新 weights をコピーする。
   */
  saveRoundCheckpoint(outputDir: string, roundId: number, meta: Omit<RoundStats, 'checkpointPath' | 'round'> & { round: number }): string {
    const roundDir = join(outputDir, `round_${String(roundId).padStart(4, '0')}`)
    if (!existsSync(roundDir)) mkdirSync(roundDir, { recursive: true })
    const weightsPath = join(roundDir, 'weights.json')
    saveCheckpoint(this.masonZeroNet.net, weightsPath, { iteration: roundId, winRate: 0 })
    const metaPath = join(roundDir, 'meta.json')
    writeFileSync(metaPath, JSON.stringify({ ...meta, timestamp: new Date().toISOString() }, null, 2))
    const finalPath = join(outputDir, 'final.json')
    copyFileSync(weightsPath, finalPath)
    return weightsPath
  }
}

/**
 * buffer の record 配列を TF trainMasonZero が受ける Float32Array 群に変換。
 * - policyTargets[i][s-1] = pi.get(s) ?? 0
 * - masks[i][s-1] = 0 if legal (alive & ~masonSeat)、else ILLEGAL_MASK_VALUE
 * - outcomeTargets[i] = record.outcomeTarget (Stage 4: outcome one-hot 4-vec)
 * - observations は素通し
 */
export function recordsToBatchInputs(records: readonly TrainingRecord[]): {
  observations: Float32Array[]
  policyTargets: Float32Array[]
  masks: Float32Array[]
  outcomeTargets: Float32Array[]
} {
  const observations: Float32Array[] = new Array(records.length)
  const policyTargets: Float32Array[] = new Array(records.length)
  const masks: Float32Array[] = new Array(records.length)
  const outcomeTargets: Float32Array[] = new Array(records.length)

  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    observations[i] = r.obs
    outcomeTargets[i] = r.outcomeTarget

    const pi = new Float32Array(SEATS)
    if (r.pi) {
      for (const [seat, prob] of r.pi) {
        if (seat >= 1 && seat <= SEATS) pi[seat - 1] = prob
      }
    }
    policyTargets[i] = pi

    const mask = new Float32Array(SEATS)
    const legalMask = r.alive & ~(1 << r.masonSeat)
    for (let s = 1; s <= SEATS; s++) {
      mask[s - 1] = (legalMask & (1 << s)) !== 0 ? 0 : ILLEGAL_MASK_VALUE
    }
    masks[i] = mask
  }

  return { observations, policyTargets, masks, outcomeTargets }
}

/**
 * records を headName ごとにバケットに分ける。head ごとに独立 trainMasonZero を呼ぶための前処理。
 * 他の head を持たない records に対しては空配列を返す。
 */
export function groupRecordsByHead(records: readonly TrainingRecord[]): Map<HeadName, TrainingRecord[]> {
  const out = new Map<HeadName, TrainingRecord[]>()
  for (const r of records) {
    let bucket = out.get(r.headName)
    if (!bucket) {
      bucket = []
      out.set(r.headName, bucket)
    }
    bucket.push(r)
  }
  return out
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
