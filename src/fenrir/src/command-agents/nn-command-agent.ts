/**
 * NNCommandAgent — 3-ヘッド NN + afterstate 評価で Command を選ぶ agent
 *
 * 設計: tmp/new-command-game-design.txt §3
 *
 * アルゴリズム:
 *   1. 合法手を列挙
 *   2. NN で value / policyPrior / opponentDist を評価
 *   3. policyPrior 上位 K 件に絞る
 *   4. 各候補を afterstate 適用 → NN で値評価
 *   5. 最大値の候補を選ぶ
 *
 * Step 12 では RandomCommandNN stub 前提。学習後に実 NN に差し替える
 * ことで decide ロジックを変更せず性能を伸ばせる構造。
 *
 * fallback: NN 判断不能 / 合法手数 0 / エラー時は fallback agent
 * （デフォルト SkollCommandAgent）に委譲。
 */

import type { SystemRole } from '../../../types/index.ts'
import type { GameState } from '../../../lupa/types.ts'
import type { Command, CommandAdapterExt } from '../adapters/command/command-types.ts'
import { applyCommandPure } from '../adapters/command/apply-command-pure.ts'
import type { AgentEvents, CommandAgent, DecisionResult } from './command-agent.ts'
import type { CommandNN, PerspectiveView } from './command-nn.ts'
import { RandomCommandNN } from './command-nn.ts'
import { SkollCommandAgent } from './skoll-command-agent.ts'

export type NNCommandAgentOptions = {
  /** 3 ヘッド NN。未指定なら RandomCommandNN stub */
  nn?: CommandNN
  /** NN 判断不能時の fallback。未指定なら SkollCommandAgent */
  fallback?: CommandAgent
  /** topK 絞りの K 値（policyPrior 上位のみ afterstate 評価する） */
  topK?: number
  /** 決定性確保用の seed */
  seed?: number
}

const DEFAULT_TOP_K = 5

export class NNCommandAgent implements CommandAgent {
  readonly name = 'nn'
  private nn: CommandNN
  private fallback: CommandAgent
  private topK: number

  constructor(options: NNCommandAgentOptions = {}) {
    this.nn = options.nn ?? new RandomCommandNN(options.seed)
    this.fallback = options.fallback ?? new SkollCommandAgent({ seed: options.seed })
    this.topK = options.topK ?? DEFAULT_TOP_K
  }

  async decide(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    events: AgentEvents = [],
  ): Promise<DecisionResult> {
    if (legal.length === 0) {
      throw new Error('NNCommandAgent: legal commands is empty')
    }

    const player = state.players.find(p => p.seat === mySeat)
    if (!player) {
      const sub = await this.fallback.decide(state, mySeat, legal, events)
      return { cmd: sub.cmd, log: `nn:fallback→${this.fallback.name}(no-player): ${sub.log ?? ''}`.trim() }
    }

    const view: PerspectiveView = {
      mySeat,
      myRole: player.role,
      state,
      events,
    }

    let out
    try {
      out = this.nn.evaluate(view, legal)
    } catch (err) {
      void err
      const sub = await this.fallback.decide(state, mySeat, legal, events)
      return { cmd: sub.cmd, log: `nn:fallback→${this.fallback.name}(nn-throw): ${sub.log ?? ''}`.trim() }
    }

    // 単一合法手なら評価省略
    if (legal.length === 1) {
      return {
        cmd: legal[0],
        log: `nn[${this.nn.name}]: only legal (v=${out.value.toFixed(3)})`,
      }
    }

    // policyPrior 上位 K 件に絞る
    const prior = out.policyPrior
    const indices: number[] = []
    for (let i = 0; i < legal.length; i++) indices.push(i)
    indices.sort((a, b) => (prior[b] ?? 0) - (prior[a] ?? 0))
    const topK = indices.slice(0, Math.min(this.topK, legal.length))

    // afterstate 評価: 各候補を apply → 新 state で NN value を取る
    // 非決定的（反応分岐あり）な command は設計書 §3.4 で期待値計算が必要だが
    // Step 12 では簡易化し、すべて決定的として扱う。
    let bestIdx = topK[0]
    let bestValue = -Infinity
    for (const i of topK) {
      const cmd = legal[i]
      let v: number
      try {
        const sPrime = applyCommandPure(state, mySeat, cmd)
        const viewPrime: PerspectiveView = { ...view, state: sPrime }
        const outPrime = this.nn.evaluate(viewPrime, [])
        v = outPrime.value
      } catch (err) {
        void err
        v = -Infinity
      }
      if (v > bestValue) {
        bestValue = v
        bestIdx = i
      }
    }

    const chosen = legal[bestIdx]
    const priorStr = prior[bestIdx]?.toFixed(3) ?? '?'
    return {
      cmd: chosen,
      log: `nn[${this.nn.name}] v=${out.value.toFixed(3)} v'=${bestValue.toFixed(3)} prior=${priorStr} topK=${topK.length}`,
    }
  }
}

// ============================================================
// ヘルパー (将来 NN 実装で使用予定)
// ============================================================

/** 自陣営識別: opponentDist の期待値計算や reward 視点決定に使う */
export type Faction = 'village' | 'wolf' | 'hamster'

export function factionOf(role: SystemRole): Faction {
  switch (role) {
    case 'werewolf':
    case 'fanatic':
      return 'wolf'
    case 'werehamster':
    case 'immoralist':
      return 'hamster'
    default:
      return 'village'
  }
}
