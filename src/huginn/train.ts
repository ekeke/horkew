/**
 * REINFORCE + value baseline trainer for Huginn.
 *
 * 1 ゲームに対して 1 つの terminal reward (= desire[eliminated] + 食言ペナルティ) が
 * 各 agent に与えられる。各 agent の各 step で advantage = return - value を使い、
 * policy gradient と value loss を計算してパラメータを更新する。
 */

import { join } from 'node:path'
import {
  TrainableNetwork,
  type ForwardCache,
  applyMask,
  sampleStochastic,
  logProbOf,
  softmax,
} from './trainable-network.ts'
import { saveCheckpoint } from './checkpoint.ts'
import {
  AbstractGame,
  type EnvConfig,
  type StepResult,
  scriptedBotMessage,
  scriptedBotVoteIdx,
} from './abstract-env.ts'
import { Rng } from './rng.ts'
import { encodeObservation } from './observation.ts'
import { buildVocabLayout, decodeMessage, buildLegalMask } from './message-vocab.ts'
import { type Trace } from './protocol.ts'
import {
  K_ROUNDS,
  OFFER_REF_WINDOW,
  type Message,
  type Observation,
  type AgentId,
} from './types.ts'

const MASK_NEG_THRESHOLD = -1e8

type StepRecord = {
  cache: ForwardCache
  msgMaskedLogits: Float32Array | null
  msgChosen: number
  msgLogp: number
  voteMaskedLogits: Float32Array | null
  voteChosen: number
  voteLogp: number
  value: number
  numAgents: number
  isFinal: boolean
}

export type TrainConfig = {
  iterations: number
  gamesPerIter: number
  lr: number
  dModel?: number       // default 64
  numLayers?: number    // default 2
  numHeads?: number     // default 4
  dFf?: number          // default 128
  /** 訓練に使う env 設定の配列. 1 個なら単一シナリオ、複数なら mix. 全て numAgents 同一必須. */
  envConfigs: EnvConfig[]
  /** sampling weight (長さは envConfigs と一致). 省略時 uniform. */
  mixWeights?: number[]
  /** 表示用シナリオ名 (長さは envConfigs と一致). 省略時 "scenario0" 等. */
  mixNames?: string[]
  seed: number
  log?: (line: string) => void
  greedyEvalEvery?: number   // 0 = off
  greedyEvalGames?: number
  msgLossWeight?: number     // default 1.0
  normalizeAdvantage?: boolean   // default true
  valueLossWeight?: number       // default 1.0
  optimizer?: 'sgd' | 'adam'     // default 'sgd'
  entropyBonus?: number          // default 0. policy entropy を最大化する方向の regularizer.
                                 //   β > 0 で smoother policy, exploration 促進
  /** Global L2 gradient clip norm. 0 / 未指定ならクリップしない. 安定化のため通常は 1.0-5.0. */
  gradClipNorm?: number
  /** checkpoint 保存先ディレクトリ. 未指定なら保存しない. */
  checkpointDir?: string
  /** N iter ごとに `${checkpointDir}/iter{N}.json` を保存.
   *  0 / 未指定なら intermediate checkpoint は書かない. 終了時は別途 final.json を保存. */
  checkpointInterval?: number
  /** 各 iter 終了時に呼ばれる hook (オーケストレータから進捗を拾うため). */
  onIteration?: (entry: IterationLog, network: TrainableNetwork) => void
}

export type IterationLog = {
  iter: number
  meanReward: number
  policyLoss: number
  valueLoss: number
  violationRate: number
  msgTypeFractions: Record<string, number>
  greedyMeanReward?: number
  meanInitialValue: number
  initialValueSpread: number
}

export function train(config: TrainConfig): { history: IterationLog[]; network: TrainableNetwork } {
  const log = config.log ?? ((s: string) => console.log(s))
  const rng = new Rng(config.seed)

  if (config.envConfigs.length === 0) throw new Error('envConfigs must have at least one entry')
  const N = config.envConfigs[0].numAgents
  for (const ec of config.envConfigs) {
    if (ec.numAgents !== N) {
      throw new Error(`mix requires same numAgents; got [${config.envConfigs.map(e => e.numAgents).join(', ')}]`)
    }
  }
  const envs = config.envConfigs.map(ec => new AbstractGame(ec, rng))
  const mixNames = config.mixNames ?? envs.map((_, i) => `scenario${i}`)
  const mixWeights = config.mixWeights ?? envs.map(() => 1)
  const totalWeight = mixWeights.reduce((s, v) => s + v, 0)
  const sampleEnvIdx = (): number => {
    let r = rng.next() * totalWeight
    for (let i = 0; i < mixWeights.length; i++) {
      r -= mixWeights[i]
      if (r <= 0) return i
    }
    return mixWeights.length - 1
  }

  const layout = buildVocabLayout(N, OFFER_REF_WINDOW)
  const dModel = config.dModel ?? 64
  const numLayers = config.numLayers ?? 2
  const numHeads = config.numHeads ?? 4
  const dFf = config.dFf ?? 128
  const network = new TrainableNetwork({
    dModel, numLayers, numHeads, dFf,
    vocabSize: layout.vocabSize,
  })

  log(`# Huginn training (Transformer)`)
  log(`N=${N}, K=${K_ROUNDS}, vocabSize=${layout.vocabSize}, dModel=${dModel}, layers=${numLayers}, heads=${numHeads}`)
  log(`iterations=${config.iterations}, gamesPerIter=${config.gamesPerIter}, lr=${config.lr}`)
  if (envs.length > 1) {
    log(`mix: ${mixNames.map((n, i) => `${n}(w=${mixWeights[i]})`).join(', ')}`)
  } else {
    log(`single scenario: ${mixNames[0]}`)
  }
  log(``)

  const history: IterationLog[] = []
  const normalizeAdvantage = config.normalizeAdvantage ?? true
  const valueLossWeight = config.valueLossWeight ?? 1.0
  const entropyBonus = config.entropyBonus ?? 0

  for (let iter = 0; iter < config.iterations; iter++) {
    let totalReward = 0
    let totalSteps = 0
    let policyLossSum = 0
    let valueLossSum = 0
    let violationCount = 0
    const msgTypeAccum: Record<string, number> = { silent: 0, propose: 0, offer: 0, accept: 0, reject: 0, commit: 0 }
    let totalMsgs = 0

    // Phase 1: rollout 全件、advantage の生値を集める
    const rolloutBatch: { result: ReturnType<typeof rolloutGame>; envIdx: number }[] = []
    const rawAdvantages: number[] = []
    const perEnvRewardSum = new Array<number>(envs.length).fill(0)
    const perEnvAgentCount = new Array<number>(envs.length).fill(0)
    for (let g = 0; g < config.gamesPerIter; g++) {
      const envIdx = envs.length === 1 ? 0 : sampleEnvIdx()
      const result = rolloutGame(network, envs[envIdx], layout, rng, true)
      rolloutBatch.push({ result, envIdx })
      for (let a = 0; a < N; a++) {
        const ret = result.envResult.rewards[a]
        perEnvRewardSum[envIdx] += ret
        perEnvAgentCount[envIdx] += 1
        for (const step of result.perAgentSteps[a]) {
          rawAdvantages.push(ret - step.value)
        }
      }
    }
    // advantage の mean/std (normalization 有効時のみ使う)
    const advMean = rawAdvantages.reduce((s, v) => s + v, 0) / Math.max(1, rawAdvantages.length)
    let advVar = 0
    for (const v of rawAdvantages) advVar += (v - advMean) ** 2
    advVar /= Math.max(1, rawAdvantages.length)
    const advStd = Math.sqrt(advVar) + 1e-6

    // 初期局面 value の集計 (value head が局面差を識別できているかの診断)
    let initialValueSum = 0
    let initialValueCount = 0
    let initialValueSqSum = 0
    for (const { result } of rolloutBatch) {
      for (let a = 0; a < N; a++) {
        const steps = result.perAgentSteps[a]
        if (steps.length === 0) continue
        const v0 = steps[0].value
        initialValueSum += v0
        initialValueSqSum += v0 * v0
        initialValueCount++
      }
    }
    const meanInitialValue = initialValueSum / Math.max(1, initialValueCount)
    const initialValueVar = initialValueSqSum / Math.max(1, initialValueCount) - meanInitialValue ** 2
    const initialValueSpread = Math.sqrt(Math.max(0, initialValueVar))

    // Phase 2: backward
    for (const { result } of rolloutBatch) {
      for (let a = 0; a < N; a++) {
        const steps = result.perAgentSteps[a]
        const ret = result.envResult.rewards[a]

        for (const step of steps) {
          const rawAdv = ret - step.value
          const advantage = normalizeAdvantage ? (rawAdv - advMean) / advStd : rawAdv
          const valueGrad = (step.value - ret) * valueLossWeight

          const msgGrad = new Float32Array(layout.vocabSize)
          const msgWeight = config.msgLossWeight ?? 1.0
          if (!step.isFinal && step.msgMaskedLogits && msgWeight !== 0) {
            const probs = softmax(step.msgMaskedLogits)
            let H = 0
            if (entropyBonus !== 0) {
              for (let i = 0; i < layout.vocabSize; i++) {
                if (step.msgMaskedLogits[i] <= MASK_NEG_THRESHOLD) continue
                if (probs[i] > 0) H -= probs[i] * Math.log(probs[i])
              }
            }
            for (let i = 0; i < layout.vocabSize; i++) {
              if (step.msgMaskedLogits[i] <= MASK_NEG_THRESHOLD) {
                msgGrad[i] = 0
              } else {
                let g = (probs[i] - (i === step.msgChosen ? 1 : 0)) * advantage * msgWeight
                if (entropyBonus !== 0) {
                  g += entropyBonus * probs[i] * (Math.log(Math.max(probs[i], 1e-12)) + H)
                }
                msgGrad[i] = g
              }
            }
            policyLossSum += -step.msgLogp * advantage * msgWeight
          }

          const voteGrad = new Float32Array(step.numAgents)
          if (step.isFinal && step.voteMaskedLogits) {
            const probs = softmax(step.voteMaskedLogits)
            let H = 0
            if (entropyBonus !== 0) {
              for (let i = 0; i < step.numAgents; i++) {
                if (step.voteMaskedLogits[i] <= MASK_NEG_THRESHOLD) continue
                if (probs[i] > 0) H -= probs[i] * Math.log(probs[i])
              }
            }
            for (let i = 0; i < step.numAgents; i++) {
              if (step.voteMaskedLogits[i] <= MASK_NEG_THRESHOLD) {
                voteGrad[i] = 0
              } else {
                let g = (probs[i] - (i === step.voteChosen ? 1 : 0)) * advantage
                if (entropyBonus !== 0) {
                  g += entropyBonus * probs[i] * (Math.log(Math.max(probs[i], 1e-12)) + H)
                }
                voteGrad[i] = g
              }
            }
            policyLossSum += -step.voteLogp * advantage
          }

          valueLossSum += 0.5 * (step.value - ret) ** 2
          network.backward(step.cache, msgGrad, voteGrad, valueGrad)
          totalSteps++
        }
        totalReward += ret
        if (result.envResult.commitViolations[a]) violationCount++
      }

      for (let a = 0; a < N; a++) {
        for (const m of result.perAgentMessages[a]) {
          msgTypeAccum[m.type]++
          totalMsgs++
        }
      }
    }

    // NaN ガード: backward 終了後に勾配の健全性を確認. 壊れた勾配を適用すると
    // 重みが NaN になり以降の全 iter が無意味になるため、skip してログに残す.
    let skippedStep = false
    if (network.hasNonFiniteGrad()) {
      log(`  [warn] iter ${iter + 1}: non-finite gradient detected → applyStep skipped`)
      network.zeroAllGrads()
      skippedStep = true
    }

    // Gradient clipping (skip 済みなら不要). global L2 norm > clip で全勾配を scale.
    if (!skippedStep && config.gradClipNorm !== undefined && config.gradClipNorm > 0) {
      const norm = network.gradNorm()
      if (norm > config.gradClipNorm) {
        network.scaleGrads(config.gradClipNorm / norm)
      }
    }

    if (!skippedStep) {
      if ((config.optimizer ?? 'sgd') === 'adam') {
        network.applyStepAdam(config.lr, totalSteps)
      } else {
        network.applyStep(config.lr, totalSteps)
      }
    }

    // 重みが NaN に陥ったら以降は全て無意味. 即時中断して呼び出し側に通知.
    if (network.hasNonFiniteWeights()) {
      log(`  [fatal] iter ${iter + 1}: network weights became non-finite → aborting training`)
      break
    }

    const numAgentRewards = N * config.gamesPerIter
    const meanReward = totalReward / numAgentRewards
    const violationRate = violationCount / numAgentRewards
    const msgTypeFractions: Record<string, number> = {}
    for (const k of Object.keys(msgTypeAccum)) {
      msgTypeFractions[k] = totalMsgs > 0 ? msgTypeAccum[k] / totalMsgs : 0
    }

    const entry: IterationLog = {
      iter: iter + 1,
      meanReward,
      policyLoss: policyLossSum / totalSteps,
      valueLoss: valueLossSum / totalSteps,
      violationRate,
      msgTypeFractions,
      meanInitialValue,
      initialValueSpread,
    }

    if (config.greedyEvalEvery && (iter + 1) % config.greedyEvalEvery === 0) {
      const perEnvGreedy = envs.map(e => greedyEval(network, e, layout, rng, config.greedyEvalGames ?? 16))
      entry.greedyMeanReward = perEnvGreedy.reduce((s, v) => s + v, 0) / perEnvGreedy.length
      if (envs.length > 1) {
        log(`  greedy per scenario: ${mixNames.map((n, i) => `${n}=${perEnvGreedy[i].toFixed(3)}`).join(', ')}`)
      }
    }

    if (envs.length > 1) {
      const perEnvMean = perEnvRewardSum.map((s, i) => perEnvAgentCount[i] > 0 ? s / perEnvAgentCount[i] : 0)
      log(`  train per scenario: ${mixNames.map((n, i) => `${n}=${perEnvMean[i].toFixed(3)}(n=${perEnvAgentCount[i]})`).join(', ')}`)
    }

    history.push(entry)
    log(formatLog(entry))

    if (config.onIteration) config.onIteration(entry, network)

    if (config.checkpointDir && config.checkpointInterval && config.checkpointInterval > 0) {
      if ((iter + 1) % config.checkpointInterval === 0) {
        saveCheckpoint(network, join(config.checkpointDir, `iter${iter + 1}.json`))
      }
    }
  }

  if (config.checkpointDir) {
    saveCheckpoint(network, join(config.checkpointDir, 'final.json'))
  }

  return { history, network }
}

function rolloutGame(
  network: TrainableNetwork,
  env: AbstractGame,
  layout: ReturnType<typeof buildVocabLayout>,
  rng: Rng,
  collectCache: boolean,
): {
  perAgentSteps: StepRecord[][]
  perAgentMessages: Message[][]
  envResult: StepResult
} {
  const inputs = env.reset()
  const N = inputs.length
  const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
  const pastViolations = new Map<AgentId, number>()

  const perAgentSteps: StepRecord[][] = inputs.map(() => [])
  const perAgentMessages: Message[][] = inputs.map(() => [])

  for (let round = 0; round < K_ROUNDS; round++) {
    const roundMsgs: Message[] = []
    for (let a = 0; a < N; a++) {
      const role = env.getAgentRole(a)
      // Bot (非 learning) はスクリプトされた発話を出す. trace には積まない (学習対象外).
      if (role !== 'learning') {
        const message = scriptedBotMessage(role, a, round, messageHistory)
        perAgentMessages[a].push(message)
        roundMsgs.push(message)
        continue
      }
      const obs: Observation = {
        input: inputs[a],
        roundNumber: round,
        messageHistory,
        pastCommitViolations: pastViolations,
      }
      const enc = encodeObservation(obs, K_ROUNDS)
      const result = network.forward(enc.cls, enc.agents, enc.numAgents)
      const recentOffers = countRecentOffers(messageHistory, layout.offerRefWindow)
      const mask = buildLegalMask(inputs[a], recentOffers, layout)
      const masked = applyMask(result.msgLogits, mask)
      const tokenId = sampleStochastic(masked, () => rng.next())
      const lp = logProbOf(masked, tokenId)
      const message = decodeMessage(tokenId, inputs[a].participants, layout)

      perAgentSteps[a].push({
        cache: result.cache,
        msgMaskedLogits: collectCache ? masked : null,
        msgChosen: tokenId,
        msgLogp: lp,
        voteMaskedLogits: null,
        voteChosen: -1,
        voteLogp: 0,
        value: result.value,
        numAgents: enc.numAgents,
        isFinal: false,
      })
      perAgentMessages[a].push(message)
      roundMsgs.push(message)
    }
    for (let a = 0; a < N; a++) {
      messageHistory.push({ round, sender: inputs[a].self, message: roundMsgs[a] })
    }
  }

  const finalVoteIdx: number[] = []
  for (let a = 0; a < N; a++) {
    const role = env.getAgentRole(a)
    if (role !== 'learning') {
      finalVoteIdx.push(scriptedBotVoteIdx(role, a, inputs[a], messageHistory, rng))
      continue
    }
    const obs: Observation = {
      input: inputs[a],
      roundNumber: K_ROUNDS,
      messageHistory,
      pastCommitViolations: pastViolations,
    }
    const enc = encodeObservation(obs, K_ROUNDS)
    const result = network.forward(enc.cls, enc.agents, enc.numAgents)
    const voteMask = new Uint8Array(enc.numAgents)
    for (let i = 0; i < enc.numAgents; i++) voteMask[i] = inputs[a].excluded[i] ? 0 : 1
    const masked = applyMask(result.voteLogits, voteMask)
    const idx = sampleStochastic(masked, () => rng.next())
    const lp = logProbOf(masked, idx)

    perAgentSteps[a].push({
      cache: result.cache,
      msgMaskedLogits: null,
      msgChosen: -1,
      msgLogp: 0,
      voteMaskedLogits: collectCache ? masked : null,
      voteChosen: idx,
      voteLogp: lp,
      value: result.value,
      numAgents: enc.numAgents,
      isFinal: true,
    })
    finalVoteIdx.push(idx)
  }

  const trace: Trace = {
    perAgent: inputs.map((input, a) => ({
      agent: input.self,
      steps: [],
      messages: perAgentMessages[a],
      finalVoteIdx: finalVoteIdx[a],
      finalVoteLogProb: 0,
      finalVoteValue: 0,
    })),
    messageHistory,
  }
  const envResult = env.step(trace)

  return { perAgentSteps, perAgentMessages, envResult }
}

function greedyEval(
  network: TrainableNetwork,
  env: AbstractGame,
  layout: ReturnType<typeof buildVocabLayout>,
  rng: Rng,
  numGames: number,
): number {
  let total = 0
  let count = 0
  for (let g = 0; g < numGames; g++) {
    const inputs = env.reset()
    const N = inputs.length
    const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
    const pastViolations = new Map<AgentId, number>()
    const perAgentMessages: Message[][] = inputs.map(() => [])

    for (let round = 0; round < K_ROUNDS; round++) {
      const roundMsgs: Message[] = []
      for (let a = 0; a < N; a++) {
        const role = env.getAgentRole(a)
        if (role !== 'learning') {
          const m = scriptedBotMessage(role, a, round, messageHistory)
          perAgentMessages[a].push(m)
          roundMsgs.push(m)
          continue
        }
        const obs: Observation = { input: inputs[a], roundNumber: round, messageHistory, pastCommitViolations: pastViolations }
        const enc = encodeObservation(obs, K_ROUNDS)
        const result = network.forward(enc.cls, enc.agents, enc.numAgents)
        const recentOffers = countRecentOffers(messageHistory, layout.offerRefWindow)
        const mask = buildLegalMask(inputs[a], recentOffers, layout)
        const masked = applyMask(result.msgLogits, mask)
        const tokenId = argmax(masked)
        const m = decodeMessage(tokenId, inputs[a].participants, layout)
        perAgentMessages[a].push(m)
        roundMsgs.push(m)
      }
      for (let a = 0; a < N; a++) {
        messageHistory.push({ round, sender: inputs[a].self, message: roundMsgs[a] })
      }
    }
    const finalVotes: number[] = []
    for (let a = 0; a < N; a++) {
      const role = env.getAgentRole(a)
      if (role !== 'learning') {
        finalVotes.push(scriptedBotVoteIdx(role, a, inputs[a], messageHistory, rng))
        continue
      }
      const obs: Observation = { input: inputs[a], roundNumber: K_ROUNDS, messageHistory, pastCommitViolations: pastViolations }
      const enc = encodeObservation(obs, K_ROUNDS)
      const result = network.forward(enc.cls, enc.agents, enc.numAgents)
      const voteMask = new Uint8Array(enc.numAgents)
      for (let i = 0; i < enc.numAgents; i++) voteMask[i] = inputs[a].excluded[i] ? 0 : 1
      const masked = applyMask(result.voteLogits, voteMask)
      finalVotes.push(argmax(masked))
    }
    const trace: Trace = {
      perAgent: inputs.map((input, a) => ({
        agent: input.self,
        steps: [],
        messages: perAgentMessages[a],
        finalVoteIdx: finalVotes[a],
        finalVoteLogProb: 0,
        finalVoteValue: 0,
      })),
      messageHistory,
    }
    const envResult = env.step(trace)
    for (let a = 0; a < N; a++) {
      total += envResult.rewards[a]
      count++
    }
  }
  return total / count
}

function argmax(logits: Float32Array): number {
  let best = -Infinity
  let bestIdx = 0
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > best) {
      best = logits[i]
      bestIdx = i
    }
  }
  return bestIdx
}

function countRecentOffers(history: { message: Message }[], window: number): number {
  let count = 0
  for (let i = history.length - 1; i >= 0 && count < window; i--) {
    if (history[i].message.type === 'offer') count++
  }
  return count
}

function formatLog(entry: IterationLog): string {
  const m = entry.msgTypeFractions
  const msgStr = `silent=${(m.silent * 100).toFixed(0)}% propose=${(m.propose * 100).toFixed(0)}% offer=${(m.offer * 100).toFixed(0)}% commit=${(m.commit * 100).toFixed(0)}%`
  const greedyStr = entry.greedyMeanReward !== undefined ? ` greedy=${entry.greedyMeanReward.toFixed(3)}` : ''
  const valStr = `v0=${entry.meanInitialValue.toFixed(3)}±${entry.initialValueSpread.toFixed(3)}`
  return `iter ${String(entry.iter).padStart(4)} | mean_R=${entry.meanReward.toFixed(3)}${greedyStr} | pol_loss=${entry.policyLoss.toFixed(3)} val_loss=${entry.valueLoss.toFixed(3)} ${valStr} | violations=${(entry.violationRate * 100).toFixed(0)}% | msgs[${msgStr}]`
}
