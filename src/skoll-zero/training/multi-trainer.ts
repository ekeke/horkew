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
import type { TransformerNetwork } from '../../fenrir/src/ml/transformer-network.ts'
import { saveCheckpoint } from '../../fenrir/src/ml/checkpoint.ts'
import { TrainingBuffer, isMctsHead, type TrainingRecord } from '../selfplay/buffer.ts'
import {
  runMultiAgentSelfPlayBatch,
  type SlotMap,
  type AgentSlot,
  type MultiAgentSelfPlayResult,
} from '../selfplay/multi-runner.ts'
import type { MCTSConfig } from '../mcts/ismcts.ts'
import type { HeadName } from '../mcts/nn.ts'
import { groupRecordsByHead, recordsToBatchInputs } from './trainer.ts'
import type { SkollZeroTrainConfig } from './schedule.ts'

/** SEATS=14 per-seat mask 幅 */
const SEATS = 14
const ILLEGAL_MASK_VALUE = -1e9

/**
 * Outcome-SL 対象 head と nn-tf-transformer の headType 対応表。
 * MCTS-π head (vote/attack/divine/guard) はここに含めない。
 */
const OUTCOME_SL_HEAD_TYPES: Record<string, 'globalSoftmax' | 'perSeatSoftmax' | 'perSeatSigmoid'> = {
  claim: 'globalSoftmax',
  comm: 'globalSoftmax',
  leader: 'globalSoftmax',
  target: 'perSeatSoftmax',
  propose: 'perSeatSigmoid',
  predict: 'perSeatSigmoid',
}

export { OUTCOME_SL_HEAD_TYPES }

/**
 * Outcome-SL bucket 1 つを学習する。refNet があれば KL anchor を有効化。
 *
 * - softmax head (claim/comm/leader/target): actionIndex を action indices に
 * - sigmoid head (propose/predict): actionMultiHot (Uint8Array) を Float32Array に変換
 * - baseline: bucket 内の z の平均
 * - refLogits: slot.refNet.forward(obs).policies.get(headName) — head 固有の raw logits
 *
 * 行動を記録していない record (actionIndex / actionMultiHot 欠損) は捨てる。
 * valueLoss は outcome-SL 経路では更新しないため 0 を返す。
 *
 * モジュール関数として export しており、trainRound から呼ぶのと同じ単位で
 * 独立してテスト可能。
 */
export function trainOutcomeSLBucket(
  slot: TrainerSlot,
  headName: HeadName,
  headType: 'globalSoftmax' | 'perSeatSoftmax' | 'perSeatSigmoid',
  bucket: readonly TrainingRecord[],
  klCoeff: number,
): { loss: number, policyLoss: number, valueLoss: number, klLoss: number } | null {
  const isSigmoid = headType === 'perSeatSigmoid'
  const needsMask = headType === 'perSeatSoftmax'

  // action を持つ record のみ残す
  const valid: TrainingRecord[] = []
  for (const r of bucket) {
    if (isSigmoid) {
      if (r.actionMultiHot) valid.push(r)
    } else {
      if (r.actionIndex !== undefined) valid.push(r)
    }
  }
  if (valid.length === 0) return null

  const observations: Float32Array[] = valid.map(r => r.obs)
  const outcomes = valid.map(r => r.z)
  const baseline = outcomes.reduce((a, b) => a + b, 0) / outcomes.length

  // refLogits: refNet があれば forward して head 固有の logits を取得
  let refLogits: Float32Array[] | undefined
  if (slot.refNet && klCoeff > 0) {
    refLogits = valid.map(r => {
      const out = slot.refNet!.forward(r.obs)
      const logits = out.policies.get(headName)
      if (!logits) throw new Error(`refNet has no head '${headName}'`)
      // 新規 Float32Array にコピーして Pure JS net が共有する内部 buffer を汚さない
      return new Float32Array(logits)
    })
  }

  let actionIndices: number[] | undefined
  let actionMultiHot: Float32Array[] | undefined
  let masks: Float32Array[] | undefined
  if (isSigmoid) {
    actionMultiHot = valid.map(r => {
      const src = r.actionMultiHot!
      const dst = new Float32Array(src.length)
      for (let i = 0; i < src.length; i++) dst[i] = src[i]
      return dst
    })
  } else {
    actionIndices = valid.map(r => r.actionIndex!)
    if (needsMask) {
      masks = valid.map(r => {
        const mask = new Float32Array(SEATS)
        const legalMask = r.alive & ~(1 << r.masonSeat)
        for (let s = 1; s <= SEATS; s++) {
          mask[s - 1] = (legalMask & (1 << s)) !== 0 ? 0 : ILLEGAL_MASK_VALUE
        }
        return mask
      })
    }
  }

  const res = slot.tfNet.trainOutcomeWeightedSL({
    observations,
    outcomes,
    baseline,
    headName,
    headType,
    actionIndices,
    actionMultiHot,
    masks,
    refLogits,
    klCoeff,
  })
  return { loss: res.loss, policyLoss: res.policyLoss, valueLoss: 0, klLoss: res.klLoss }
}

export type TrainerSlot = {
  /** Pure JS 推論用 (self-play で使用) */
  masonZeroNet: MasonZeroNetwork
  /** TF.js 学習用 */
  tfNet: TfTransformerNetwork
  /**
   * Pretrained frozen reference net (Phase 3 outcome-SL KL anchor 用)。
   * 省略すると KL anchor は計算されず、policy loss のみ。
   */
  refNet?: TransformerNetwork
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
    /**
     * Phase 3 outcome-SL の KL anchor loss 平均 (outcome-SL bucket のみで計上)。
     * enableOutcomeSL=false または outcome-SL bucket が無い場合は 0。
     */
    avgKlLoss: number
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
      if (s) (out[key] as AgentSlot) = { nn: s.masonZeroNet, buffer: s.buffer }
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

      let lossSum = 0, policyLossSum = 0, valueLossSum = 0, klLossSum = 0, stepsWithData = 0
      if (!slot.frozen) {
        for (let s = 0; s < this.config.stepsPerRound; s++) {
          const records = slot.buffer.sample(this.config.batchSize, this.rng)
          if (records.length === 0) break
          // head 別にバケット分割し、head 種別で dispatch:
          //   MCTS-π head (vote/attack/divine/guard) → trainMasonZero
          //   Outcome-SL head (claim/comm/leader/target/propose/predict) → trainOutcomeWeightedSL
          const groups = groupRecordsByHead(records)
          let stepLoss = 0, stepPolicyLoss = 0, stepValueLoss = 0, stepKlLoss = 0, headsTrained = 0
          for (const [headName, bucket] of groups) {
            if (bucket.length === 0) continue
            if (isMctsHead(headName)) {
              const { observations, policyTargets, masks, valueTargets } = recordsToBatchInputs(bucket)
              const res = slot.tfNet.trainMasonZero({
                observations,
                policyTargets,
                masks,
                valueTargets,
                valueCoeff: this.config.valueCoeff,
                headName,
              })
              stepLoss += res.loss
              stepPolicyLoss += res.policyLoss
              stepValueLoss += res.valueLoss
              headsTrained++
            } else if (this.config.enableOutcomeSL) {
              const headType = OUTCOME_SL_HEAD_TYPES[headName]
              if (!headType) continue  // 未知 head 名は skip
              const res = trainOutcomeSLBucket(slot, headName, headType, bucket, this.config.klCoeff)
              if (!res) continue
              stepLoss += res.loss
              stepPolicyLoss += res.policyLoss
              stepKlLoss += res.klLoss
              headsTrained++
            }
          }
          if (headsTrained === 0) break
          // head 間で loss を平均して step として計上 (record 数で重み付けは将来検討)
          lossSum += stepLoss / headsTrained
          policyLossSum += stepPolicyLoss / headsTrained
          valueLossSum += stepValueLoss / headsTrained
          klLossSum += stepKlLoss / headsTrained
          stepsWithData++
        }
        // sync TF → Pure JS
        slot.masonZeroNet.net.loadWeights(slot.tfNet.cloneWeights())
      }

      const avgLoss = stepsWithData > 0 ? lossSum / stepsWithData : 0
      const avgPolicyLoss = stepsWithData > 0 ? policyLossSum / stepsWithData : 0
      const avgValueLoss = stepsWithData > 0 ? valueLossSum / stepsWithData : 0
      const avgKlLoss = stepsWithData > 0 ? klLossSum / stepsWithData : 0

      const checkpointPath = this.saveSlotCheckpoint(outputDir, roundId, key, slot.masonZeroNet)
      perSlot[key] = {
        recordsAdded,
        bufferSize: slot.buffer.size(),
        bufferExpired,
        stepsRun: stepsWithData,
        avgLoss,
        avgPolicyLoss,
        avgValueLoss,
        avgKlLoss,
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
