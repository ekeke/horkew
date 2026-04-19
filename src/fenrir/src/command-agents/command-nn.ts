/**
 * CommandNN — CommandAgent 向け 3-ヘッド NN インターフェース
 *
 * 設計: tmp/new-command-game-design.txt §3 "Afterstate Evaluation"
 *
 * NN は単一局面を評価するだけ。合法手列挙・topK 絞り・afterstate 適用は
 * すべて JS 側で行う。NN 出力は以下の 3 ヘッド:
 *   - value: 自陣営勝率 [0,1]
 *   - policyPrior: 候補絞り込み priors（実装依存、合法手 idx → score が典型）
 *   - opponentDist: 相手モデル（seat × role → 確率）
 *
 * Step 12 では interface と stub (RandomCommandNN) のみ。
 * 実際の NN 実装と学習は Step 14 の責務。
 */

import type { SystemRole } from '../../../types/index.ts'
import type { GameState } from '../../../lupa/types.ts'
import type { Command, CommandAdapterExt } from '../adapters/command/command-types.ts'
import type { AgentEvents } from './command-agent.ts'
import { Rng } from '../../../lupa/random.ts'

/** 局面評価に必要な視点情報（自陣営視点の観測構築用） */
export type PerspectiveView = {
  mySeat: number
  myRole: SystemRole
  state: Readonly<GameState<CommandAdapterExt>>
  events: AgentEvents
}

/** NN の 3 ヘッド出力 */
export type CommandNNOutput = {
  /** 自陣営勝率 [0,1] */
  value: number
  /**
   * 合法手 idx → score（非負、sum 不要、ranking 用）。
   * 合法手配列と同じ長さ。topK 絞りに使う。
   */
  policyPrior: Float32Array
  /**
   * 相手役職分布 p(role | seat)。
   * 席番号 (1-indexed) → SystemRole → 確率。
   * 期待値計算で反応分岐の重みに使う。
   */
  opponentDist: Map<number, Map<SystemRole, number>>
}

/** CommandNN: 観測と合法手を受け取り 3-ヘッド出力を返す関数的 interface */
export interface CommandNN {
  /** 識別名（log 表示用） */
  readonly name: string
  /**
   * 局面を評価する。
   * @param view 視点情報（mySeat, myRole, state, events）
   * @param legal 合法手配列。policyPrior の長さと対応
   */
  evaluate(view: PerspectiveView, legal: readonly Command[]): CommandNNOutput
}

// ============================================================
// RandomCommandNN: テスト／scaffold 用のランダム NN
// ============================================================

/**
 * ランダム重みで 3 ヘッドを返す stub。学習前の scaffold 検証用。
 * value=0.5、policyPrior=uniform、opponentDist=uniform (任意 setup).
 */
export class RandomCommandNN implements CommandNN {
  readonly name = 'random-nn'
  private rng: Rng

  constructor(seed?: number) {
    this.rng = new Rng(seed)
  }

  evaluate(view: PerspectiveView, legal: readonly Command[]): CommandNNOutput {
    const prior = new Float32Array(legal.length)
    for (let i = 0; i < prior.length; i++) prior[i] = this.rng.next()

    const opponentDist = new Map<number, Map<SystemRole, number>>()
    const roles: SystemRole[] = [
      'villager', 'seer', 'medium', 'bodyguard', 'mason', 'nekomata',
      'werewolf', 'fanatic', 'werehamster', 'immoralist',
    ]
    for (const p of view.state.players) {
      const dist = new Map<SystemRole, number>()
      const uniform = 1.0 / roles.length
      for (const r of roles) dist.set(r, uniform)
      opponentDist.set(p.seat, dist)
    }

    return {
      value: 0.5,  // 中立: 勝率 50%
      policyPrior: prior,
      opponentDist,
    }
  }
}
