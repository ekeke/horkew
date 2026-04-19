/**
 * RandomCommandAgent — 合法手から一様ランダムに選択
 *
 * 動作確認・ベースライン用。実戦では skoll 評価器や NN に置き換える。
 *
 * 議論フェーズでは skip/cco_skip に強いバイアスを掛けないと
 * 合法手数（数百）に埋もれて議論が終わらない。`skipBias` で確率的に早期終了させる。
 */

import { Rng } from '../../../lupa/random.ts'
import type { GameState } from '../../../lupa/types.ts'
import type { Command, CommandAdapterExt } from '../adapters/command/command-types.ts'
import type { CommandAgent, DecisionResult } from './command-agent.ts'

export type RandomCommandAgentOptions = {
  /** 議論・CCO フェーズで skip/cco_skip を選ぶ確率（0〜1）。デフォルト 0.7 */
  skipBias?: number
}

const DEFAULT_SKIP_BIAS = 0.7

export class RandomCommandAgent implements CommandAgent {
  readonly name = 'random'
  private rng: Rng
  private skipBias: number

  constructor(
    seedOrRng?: number | Rng,
    options: RandomCommandAgentOptions = {},
  ) {
    this.rng = seedOrRng instanceof Rng ? seedOrRng : new Rng(seedOrRng)
    this.skipBias = options.skipBias ?? DEFAULT_SKIP_BIAS
  }

  async decide(
    state: Readonly<GameState<CommandAdapterExt>>,
    _mySeat: number,
    legal: readonly Command[],
  ): Promise<DecisionResult> {
    if (legal.length === 0) {
      throw new Error('RandomCommandAgent: legal commands is empty')
    }

    // 議論 / CCO フェーズでは skip にバイアスを掛ける
    const phase = state.ext.currentPhase
    if (phase === 'discussion' || phase === 'cco') {
      const skipCmd = legal.find(c => c.type === 'skip' || c.type === 'cco_skip')
      if (skipCmd && this.rng.next() < this.skipBias) {
        return { cmd: skipCmd, log: `skipBias hit (${this.skipBias})` }
      }
    }

    const cmd = this.rng.pick([...legal])
    return { cmd, log: `uniform from ${legal.length} legal` }
  }
}
