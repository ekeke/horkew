/**
 * HuginnVoteCollector — CommandAdapter.voteCollector フックから呼ばれる実装.
 *
 * 投票フェーズで各 alive seat の意思決定を huginn 交渉プロトコル (K=4 ラウンド同期発話)
 * に置き換える. 各発話と finalVote は `emitEvent` 経由で comment event として UI ログに流す.
 *
 * 最小実装のスコープ:
 *   - desire: flat MID (primary 不在). MCTS 連携は Step 2-B で追加.
 *   - knowledge: flat (全役職可能). retar との接続は Step 2-B で追加.
 *   - participants: 全 seat (死亡者含む) sorted. 死亡者と候補外は excluded=true でマスク.
 *   - isDesignationTarget: 全 false (designated 強制は CommandAdapter 側で早期 return 済み).
 *   - applyCommand / 判断ログ emit もここで行う (CommandAdapter は戻り値の Map をそのまま使う).
 */

import type { GameEvent } from '../../../../lupa/types.ts'
import type { FenrirExtEvent } from '../../events.ts'
import type { Command, CommandAdapterExt } from './command-types.ts'
import type { VoteCollector } from './command-adapter.ts'
import { applyCommand } from './apply-command.ts'
import type { TrainableNetwork } from '../../../../huginn/trainable-network.ts'
import { runRounds } from '../../../../huginn/protocol.ts'
import {
  K_ROUNDS,
  ROLE_VOCABULARY,
  type HuginnInput,
  type Message,
  type RoleName,
} from '../../../../huginn/types.ts'
import { Rng as HuginnRng } from '../../../../huginn/rng.ts'

const DESIRE_MID = 0.05

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
}

export function createHuginnVoteCollector(config: HuginnVoteCollectorConfig): VoteCollector {
  const rounds = config.rounds ?? K_ROUNDS
  const sampling = config.sampling ?? 'argmax'
  const rng = sampling === 'stochastic' ? new HuginnRng(config.seed ?? Date.now()) : undefined
  const emit = config.emitEvent

  return async (ctx, params) => {
    const { state, candidates, alive } = params
    if (alive.length === 0) return new Map()

    // participants は全 seat (死亡者含む、sorted). huginn vocab の layout は participants.length
    // に依存するので、1 ゲーム中で layout が揺れないよう全 seat を含める.
    const participants = state.players.map(p => p.seat).sort((a, b) => a - b)
    const aliveSet = new Set(alive.map(p => p.seat))
    const candidatesSet = new Set(candidates)

    // HuginnInput 構築 — Step 2-A は flat desire / flat knowledge で最小動作
    const inputs: HuginnInput[] = alive.map(player => ({
      self: player.seat,
      viewerRole: player.role as RoleName,
      participants,
      desire: flatDesire(participants.length),
      excluded: participants.map(seat => {
        if (!aliveSet.has(seat)) return true
        if (seat === player.seat) return true
        if (!candidatesSet.has(seat)) return true
        return false
      }),
      isDesignationTarget: participants.map(() => false),
      knowledgeByOther: flatKnowledge(participants.length),
    }))

    // K ラウンド交渉 + 同時 finalVote
    const trace = runRounds(
      inputs,
      config.network,
      new Map(),
      { kRounds: rounds, sampling, rng },
    )

    // 交渉メッセージを UI ログに流す (1 発話 = 1 comment event)
    if (emit) {
      for (const { round, sender, message } of trace.messageHistory) {
        const text = formatHuginnMessage(state.day, round, sender, message)
        emit({ type: 'comment', text })
      }
    }

    // finalVote を Map として返す. applyCommand と判断ログは collector の責務.
    const votes = new Map<number, number>()
    ctx.events  // referenced for eslint (未使用警告抑制) — events は emit 経由で反映する
    for (let i = 0; i < alive.length; i++) {
      const player = alive[i]
      const target = participants[trace.perAgent[i].finalVoteIdx]
      votes.set(player.seat, target)
      const voteCmd: Command = { type: 'vote', target }
      applyCommand(state, player.seat, voteCmd)
      if (emit) {
        emit({
          type: 'comment',
          text: `D${state.day} vote seat${player.seat}(${player.role}) → seat${target} (huginn finalVote)`,
        })
      }
    }
    return votes
  }
}

// ============================================================
// 内部ヘルパー
// ============================================================

function flatDesire(length: number): Float64Array {
  const desire = new Float64Array(length)
  for (let i = 0; i < length; i++) desire[i] = DESIRE_MID
  return desire
}

function flatKnowledge(length: number): Set<RoleName>[] {
  const all: readonly RoleName[] = ROLE_VOCABULARY
  return Array.from({ length }, () => new Set<RoleName>(all))
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
