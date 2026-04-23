/**
 * HuginnVoteCollector — CommandAdapter.voteCollector フックから呼ばれる実装.
 *
 * 投票フェーズで各 alive seat の意思決定を huginn 交渉プロトコル (K=4 ラウンド同期発話)
 * に置き換える. 各発話と finalVote は `emitEvent` 経由で comment event として UI ログに流す.
 *
 * 情報の注入:
 *   - desire: 各 agent.decide を走らせて MCTS visits top-1 → HIGH, teammates → LOW, 他 → MID.
 *             agents 未指定または MCTS 非対応 agent → flat MID fallback.
 *   - knowledge: state.ext.retarCache.possibilities を参考に各 seat の可能性集合を構築.
 *                retarCache 未設定 → flat (全役職可能).
 *   - participants: 全 seat (死亡者含む) sorted. 死亡者と候補外は excluded=true でマスク.
 *   - isDesignationTarget: 全 false (designated 強制は CommandAdapter 側で早期 return 済み).
 *   - applyCommand / comment event push はここで行う (CommandAdapter は戻り値の Map をそのまま使う).
 */

import type { GameEvent, GameState, PlayerState } from '../../../../lupa/types.ts'
import type { SystemRole } from '../../../../types/index.ts'
import type { FenrirExtEvent } from '../../events.ts'
import type { Command, CommandAdapterExt, RetarCache } from './command-types.ts'
import type { VoteCollector } from './command-adapter.ts'
import type { CommandAgent } from '../../command-agents/command-agent.ts'
import { applyCommand } from './apply-command.ts'
import { legalCommands } from './legal-commands.ts'
import type { TrainableNetwork } from '../../../../huginn/trainable-network.ts'
import { runRounds } from '../../../../huginn/protocol.ts'
import type { Trace, AgentTrace } from '../../../../huginn/protocol.ts'
import { encodeObservation } from '../../../../huginn/observation.ts'
import {
  buildVocabLayout,
  buildLegalMask,
  decodeMessage,
  type VocabLayout,
} from '../../../../huginn/message-vocab.ts'
import {
  applyMask,
  sampleArgmax,
  sampleStochastic,
} from '../../../../huginn/trainable-network.ts'
import {
  K_ROUNDS,
  MAX_AGENTS,
  OFFER_REF_WINDOW,
  DESIRE_HIGH_BASE,
  ROLE_VOCABULARY,
  type AgentId,
  type HuginnInput,
  type Message,
  type Observation,
  type RoleName,
} from '../../../../huginn/types.ts'
import { Rng as HuginnRng } from '../../../../huginn/rng.ts'

// huginn/abstract-env.ts と同期: LOW=0.00 / MID=0.05 / HIGH=DESIRE_HIGH_BASE=0.10
const DESIRE_LOW = 0.0
const DESIRE_MID = 0.05
const DESIRE_HIGH = DESIRE_HIGH_BASE

/** MCTS 結果の最小型 (skoll-zero を import しないための構造型). */
type MCTSVisits = { visits: Map<number, number> }

export type HuginnVoteCollectorConfig = {
  /** 学習済み (or random init) の huginn network. MAX_AGENTS 基準の vocab を想定. */
  network: TrainableNetwork
  /** 交渉ラウンド数 (default: K_ROUNDS = 4). */
  rounds?: number
  /** 'argmax' (default) | 'stochastic'. stochastic は seed 必須. */
  sampling?: 'argmax' | 'stochastic'
  /** stochastic 用 seed. 未指定なら Date.now(). */
  seed?: number
  /** 交渉メッセージ / finalVote を UI ログへ流す callback. 未指定なら emit しない. */
  emitEvent?: (event: GameEvent | FenrirExtEvent) => void
  /**
   * 席ごとの Agent. 指定されると各 alive seat で agent.decide を走らせて
   * MCTS visits を desire の primary signal として使う.
   * 未指定 / agent が MCTS 非対応 → flat MID desire にフォールバック.
   */
  agents?: ReadonlyMap<number, CommandAgent>
  /** agents に登録のない席用のデフォルト. 省略可. */
  defaultAgent?: CommandAgent
  /**
   * Human 制御下の席集合. これらの席の発話と finalVote は humanBridge から取得する.
   * 未指定 or 空 Set → 全席 NN 駆動 (従来動作).
   */
  humanSeats?: ReadonlySet<number>
  /**
   * Human の入力を取得する bridge. humanSeats が非空のとき必須.
   * - 'message' req: K ラウンド毎に呼ばれ、tokenId (layout.vocabSize 内) を返す.
   * - 'vote' req: K ラウンド終了後に呼ばれ、vote idx (participants index) を返す.
   */
  humanBridge?: HuginnHumanBridge
}

/** Human bridge に渡るリクエスト型 (message 発話 or finalVote). */
export type HuginnHumanBridgeReq =
  | {
      type: 'message'
      self: number
      round: number
      legalMask: Uint8Array
      layout: VocabLayout
      participants: readonly number[]
      messageHistory: readonly { round: number; sender: number; message: Message }[]
      viewerRole: RoleName
    }
  | {
      type: 'vote'
      self: number
      mask: Uint8Array
      numAgents: number
      participants: readonly number[]
      viewerRole: RoleName
    }

export type HuginnHumanBridge = (req: HuginnHumanBridgeReq) => Promise<number>

export function createHuginnVoteCollector(config: HuginnVoteCollectorConfig): VoteCollector {
  const rounds = config.rounds ?? K_ROUNDS
  const sampling = config.sampling ?? 'argmax'
  const rng = sampling === 'stochastic' ? new HuginnRng(config.seed ?? Date.now()) : undefined
  const emit = config.emitEvent

  return async (ctx, params) => {
    const { state, candidates, alive } = params
    if (alive.length === 0) return new Map()

    // participants は全 seat (死亡者含む、sorted) + MAX_AGENTS まで dummy padding.
    // vocab layout が MAX_AGENTS=15 基準で固定されているため、participants.length も
    // MAX_AGENTS に揃えないと decodeMessage で participants[N..] が undefined になる.
    // padding seat は負数 (実 seat は正数なので被らない) で常に excluded=true にする.
    const actualSeats = state.players.map(p => p.seat).sort((a, b) => a - b)
    const actualN = actualSeats.length
    const participants: number[] = [...actualSeats]
    for (let k = actualN; k < MAX_AGENTS; k++) participants.push(-(k - actualN + 1))
    const aliveSet = new Set(alive.map(p => p.seat))
    const candidatesSet = new Set(candidates)

    // agent.decide を走らせて MCTS を取得 (agents 未指定ならスキップ → flat MID).
    // 人間席 (humanSeats) はスキップする: 人間の agent は AsyncRemoteAgent で
    // vote UI pending を発火してしまい、collector のフローから外れるため.
    // 人間席は MCTS も不要 (desire は flat MID で扱う).
    const mctsBySeat = new Map<number, MCTSVisits | null>()
    if (config.agents || config.defaultAgent) {
      for (const player of alive) {
        if (config.humanSeats?.has(player.seat)) continue
        const agent = config.agents?.get(player.seat) ?? config.defaultAgent
        if (!agent) continue
        const legal = legalCommands(state, player.seat)
        if (legal.length === 0) continue
        try {
          await agent.decide(state, player.seat, legal, ctx.events)
        } catch {
          // MCTS 走行中の例外は無視 (null にフォールバックする)
        }
        mctsBySeat.set(player.seat, extractMCTSFromAgent(agent))
      }
    }

    // knowledge は全 viewer 共通で retarCache.possibilities を参照する簡易版.
    // per-viewer retar (viewer の真役職を assumption に入れる) は将来の拡張.
    const knowledgeByOther = buildKnowledgeFromRetarCache(state.ext.retarCache, participants)

    // HuginnInput 構築. participants は MAX_AGENTS 長 padding 済.
    // excluded は padding seat (index >= actualN) を常に true、実 seat は死亡/self/候補外で true.
    const inputs: HuginnInput[] = alive.map(player => {
      const mcts = mctsBySeat.get(player.seat) ?? null
      const teammates = collectTeammatesFromState(state, player.seat)
      return {
        self: player.seat,
        viewerRole: player.role as RoleName,
        participants,
        desire: buildDesire(mcts, teammates, participants),
        excluded: participants.map((seat, i) => {
          if (i >= actualN) return true  // padding seat は常に除外
          if (!aliveSet.has(seat)) return true
          if (seat === player.seat) return true
          if (!candidatesSet.has(seat)) return true
          return false
        }),
        isDesignationTarget: participants.map(() => false),
        knowledgeByOther,
      }
    })

    // K ラウンド交渉 + 同時 finalVote.
    // humanSeats が空なら runRounds 一発、非空なら段階実行 (各 agent 発話で bridge を問う).
    const humanSeats = config.humanSeats
    const humanBridge = config.humanBridge
    const hasHuman = !!humanSeats && humanSeats.size > 0 && !!humanBridge
    const trace: Trace = hasHuman
      ? await runRoundsWithHumans(
          inputs, config.network,
          { kRounds: rounds, sampling, rng },
          humanSeats!, humanBridge!,
        )
      : runRounds(inputs, config.network, new Map(), { kRounds: rounds, sampling, rng })

    // comment event は lupa engine の events 配列にも push する (formatHowl 出力に反映させる)
    // + 指定されていれば emit callback にも通知する (UI ログ更新用).
    const pushComment = (text: string): void => {
      const ev: GameEvent = { type: 'comment', text }
      ;(ctx.events as (GameEvent | FenrirExtEvent)[]).push(ev)
      if (emit) emit(ev)
    }

    // 交渉メッセージを流す (1 発話 = 1 comment event)
    for (const { round, sender, message } of trace.messageHistory) {
      pushComment(formatHuginnMessage(state.day, round, sender, message))
    }

    // finalVote を Map として返す. applyCommand と判断ログは collector の責務.
    const votes = new Map<number, number>()
    for (let i = 0; i < alive.length; i++) {
      const player = alive[i]
      const target = participants[trace.perAgent[i].finalVoteIdx]
      votes.set(player.seat, target)
      const voteCmd: Command = { type: 'vote', target }
      applyCommand(state, player.seat, voteCmd)
      pushComment(`D${state.day} vote seat${player.seat}(${player.role}) → seat${target} (huginn finalVote)`)
    }
    return votes
  }
}

// ============================================================
// 内部ヘルパー
// ============================================================

/** Agent から最後の MCTS 結果を duck-type で取り出す. 非対応は null. */
function extractMCTSFromAgent(agent: CommandAgent): MCTSVisits | null {
  const fn = (agent as unknown as { getLastMCTSResult?: unknown }).getLastMCTSResult
  if (typeof fn !== 'function') return null
  try {
    const result = (fn as () => MCTSVisits | null).call(agent)
    if (!result || !(result.visits instanceof Map)) return null
    return result
  } catch {
    return null
  }
}

/** MCTS visits (Map<seat, count>) の argmax seat を返す. 空なら -1. */
function argmaxVisitedSeat(visits: Map<number, number>): number {
  let topSeat = -1
  let topCount = -1
  for (const [seat, count] of visits) {
    if (count > topCount) {
      topCount = count
      topSeat = seat
    }
  }
  return topSeat
}

/**
 * state.players の真役職から self と teammate 席の集合を構築.
 * huginn の desire は自席と仲間を LOW にするため (primary 吊り対象から外すため) に使う.
 *
 * ルール前提:
 *   - werewolf は他の werewolf + fanatic を仲間とみなす (狼陣営)
 *   - fanatic は werewolf を仲間とみなす
 *   - mason は他の mason
 *   - werehamster / immoralist は互いを仲間 (狐陣営)
 *   - 他は self のみ
 *
 * 注: 真役職情報は worker 内で AI が自分の判断に使うのみ. 対戦相手への漏洩はなし.
 */
function collectTeammatesFromState(
  state: GameState<CommandAdapterExt>,
  selfSeat: number,
): Set<number> {
  const teammates = new Set<number>([selfSeat])
  const self = state.players.find(p => p.seat === selfSeat)
  if (!self) return teammates
  const addByRoles = (roles: SystemRole[]): void => {
    for (const p of state.players) if (roles.includes(p.role)) teammates.add(p.seat)
  }
  switch (self.role) {
    case 'werewolf':
    case 'fanatic':
      addByRoles(['werewolf', 'fanatic'])
      break
    case 'mason':
      addByRoles(['mason'])
      break
    case 'werehamster':
    case 'immoralist':
      addByRoles(['werehamster', 'immoralist'])
      break
    default:
      break
  }
  return teammates
}

/**
 * desire 構築: MCTS 成功時は top-1 HIGH / teammates LOW / 他 MID、失敗時は flat MID.
 * teammates LOW は「自分と仲間は primary 吊り対象から外す」signal.
 */
function buildDesire(
  mcts: MCTSVisits | null,
  teammates: Set<number>,
  participants: number[],
): Float64Array {
  const desire = new Float64Array(participants.length)
  if (!mcts || mcts.visits.size === 0) {
    for (let i = 0; i < participants.length; i++) desire[i] = DESIRE_MID
    return desire
  }
  const topSeat = argmaxVisitedSeat(mcts.visits)
  for (let i = 0; i < participants.length; i++) {
    const seat = participants[i]
    if (teammates.has(seat)) {
      desire[i] = DESIRE_LOW
      continue
    }
    desire[i] = seat === topSeat ? DESIRE_HIGH : DESIRE_MID
  }
  return desire
}

/**
 * retarCache.possibilities を huginn の knowledgeByOther (Set<RoleName>[]) に変換.
 * cache 未設定 or seat 欠落 → 全役職可能で埋める.
 *
 * SystemRole と RoleName は ROLE_VOCABULARY と完全一致 (11 役職、同一文字列) なのでキャストのみ.
 */
function buildKnowledgeFromRetarCache(
  retarCache: RetarCache | null,
  participants: number[],
): Set<RoleName>[] {
  const allRoles: readonly RoleName[] = ROLE_VOCABULARY
  if (!retarCache) {
    return participants.map(() => new Set<RoleName>(allRoles))
  }
  return participants.map(seat => {
    const possible = retarCache.possibilities.get(seat)
    if (!possible) return new Set<RoleName>(allRoles)
    return new Set<RoleName>(possible as Set<RoleName>)
  })
}

function formatHuginnMessage(day: number, round: number, sender: number, m: Message): string {
  const head = `D${day} huginn R${round} seat${sender}`
  switch (m.type) {
    case 'silent':
      return `${head}: silent`
    case 'propose':
      return `${head}: propose seat${m.target} p${m.priority} ${m.heat}`
    case 'offer':
      return `${head}: offer(i→seat${m.iVote}, you→seat${m.youVote})`
    case 'accept':
      return `${head}: accept offer#${m.offerRef}`
    case 'reject':
      return `${head}: reject offer#${m.offerRef}`
    case 'commit':
      return `${head}: commit seat${m.target}`
  }
}

// ============================================================
// runRoundsWithHumans — runRounds の段階実行版 (Human 席あり)
// ============================================================

/**
 * Human 席の決定は humanBridge に問い合わせる. NPC 席は NN forward + sample で従来通り.
 * 既存 `huginn/protocol.ts:runRounds` と同じ state 管理 (messageHistory / pastViolations は
 * 空 Map 固定) だが、agent ごとの tokenId / voteIdx 決定で isHuman 分岐する.
 */
async function runRoundsWithHumans(
  inputs: HuginnInput[],
  network: TrainableNetwork,
  opts: { kRounds: number; sampling: 'argmax' | 'stochastic'; rng?: HuginnRng },
  humanSeats: ReadonlySet<number>,
  humanBridge: HuginnHumanBridge,
): Promise<Trace> {
  const numActors = inputs.length
  if (numActors === 0) throw new Error('runRoundsWithHumans: no inputs')
  const layout = buildVocabLayout(MAX_AGENTS, OFFER_REF_WINDOW)
  const pastCommitViolations = new Map<AgentId, number>()

  const messageHistory: { round: number; sender: AgentId; message: Message }[] = []
  const perAgent: AgentTrace[] = inputs.map(input => ({
    agent: input.self,
    steps: [],
    messages: [],
    finalVoteIdx: 0,
    finalVoteLogProb: 0,
    finalVoteValue: 0,
  }))

  for (let round = 0; round < opts.kRounds; round++) {
    const roundMessages: Message[] = []
    for (let a = 0; a < numActors; a++) {
      const input = inputs[a]
      const obs: Observation = {
        input,
        roundNumber: round,
        messageHistory,
        pastCommitViolations,
      }
      const enc = encodeObservation(obs, opts.kRounds)
      const { msgLogits } = network.forward(enc.cls, enc.agents, enc.numAgents)
      const recentOffers = countRecentOffersSimple(messageHistory, layout.offerRefWindow)
      const mask = buildLegalMask(input, recentOffers, layout)
      const masked = applyMask(msgLogits, mask)

      let tokenId: number
      if (humanSeats.has(input.self)) {
        tokenId = await humanBridge({
          type: 'message',
          self: input.self,
          round,
          legalMask: mask,
          layout,
          participants: input.participants,
          messageHistory,
          viewerRole: input.viewerRole,
        })
        // 防御的: legal mask 違反なら argmax にフォールバック
        if (tokenId < 0 || tokenId >= layout.vocabSize || mask[tokenId] === 0) {
          tokenId = sampleArgmax(masked)
        }
      } else {
        tokenId = (opts.sampling === 'argmax' || !opts.rng)
          ? sampleArgmax(masked)
          : sampleStochastic(masked, () => opts.rng!.next())
      }
      const message = decodeMessage(tokenId, input.participants, layout)
      perAgent[a].messages.push(message)
      roundMessages.push(message)
    }
    for (let a = 0; a < numActors; a++) {
      messageHistory.push({ round, sender: inputs[a].self, message: roundMessages[a] })
    }
  }

  // finalVote
  for (let a = 0; a < numActors; a++) {
    const input = inputs[a]
    const obs: Observation = {
      input,
      roundNumber: opts.kRounds,
      messageHistory,
      pastCommitViolations,
    }
    const enc = encodeObservation(obs, opts.kRounds)
    const { voteLogits } = network.forward(enc.cls, enc.agents, enc.numAgents)
    const voteMask = new Uint8Array(enc.numAgents)
    for (let i = 0; i < enc.numAgents; i++) voteMask[i] = input.excluded[i] ? 0 : 1
    const masked = applyMask(voteLogits, voteMask)

    let idx: number
    if (humanSeats.has(input.self)) {
      idx = await humanBridge({
        type: 'vote',
        self: input.self,
        mask: voteMask,
        numAgents: enc.numAgents,
        participants: input.participants,
        viewerRole: input.viewerRole,
      })
      if (idx < 0 || idx >= enc.numAgents || voteMask[idx] === 0) {
        idx = sampleArgmax(masked)
      }
    } else {
      idx = (opts.sampling === 'argmax' || !opts.rng)
        ? sampleArgmax(masked)
        : sampleStochastic(masked, () => opts.rng!.next())
    }
    perAgent[a].finalVoteIdx = idx
  }

  return { perAgent, messageHistory }
}

function countRecentOffersSimple(
  history: { message: Message }[],
  window: number,
): number {
  let count = 0
  for (let i = history.length - 1; i >= 0 && count < window; i--) {
    if (history[i].message.type === 'offer') count++
  }
  return count
}
