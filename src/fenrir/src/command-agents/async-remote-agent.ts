/**
 * AsyncRemoteAgent — Promise 注入型の汎用 CommandAgent
 *
 * decide() を呼ばれると pending 状態になり、外部（UI / CLI / ネットワーク）が
 * submit(cmd) を呼ぶまで Promise は保留される。
 *
 * 想定利用:
 * - Svelte store が onPendingChange を購読し、UI に pending を露出
 * - UI ボタン押下時に agent.submit(cmd) を呼ぶ
 * - CLI プロンプトや WebSocket ハンドラも同インターフェース
 */

import type { GameState } from '../../../lupa/types.ts'
import type { Command, CommandAdapterExt } from '../adapters/command/command-types.ts'
import type { CommandAgent, DecisionResult } from './command-agent.ts'

export type PendingDecision = {
  state: Readonly<GameState<CommandAdapterExt>>
  mySeat: number
  legal: readonly Command[]
}

export type PendingListener = (pending: PendingDecision | null) => void

export class AsyncRemoteAgent implements CommandAgent {
  readonly name = 'human'
  private pending: PendingDecision | null = null
  private resolver: ((cmd: Command) => void) | null = null
  private listeners = new Set<PendingListener>()

  /** pending 状態の変化を購読（複数リスナー対応） */
  subscribe(listener: PendingListener): () => void {
    this.listeners.add(listener)
    // 初期状態を即座に通知
    listener(this.pending)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 現在の pending 状態（非購読の単発問い合わせ用） */
  getPending(): PendingDecision | null {
    return this.pending
  }

  async decide(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
  ): Promise<DecisionResult> {
    if (this.pending) {
      throw new Error('AsyncRemoteAgent: decide() called while another decision is pending')
    }
    // 合法手が 1 つしかない場合は自動決定（夜の no_action 等、意思決定の余地なし）
    if (legal.length === 1) {
      return { cmd: legal[0], log: 'only legal (auto)' }
    }
    const cmd = await new Promise<Command>((resolve) => {
      this.pending = { state, mySeat, legal }
      this.resolver = resolve
      this.notify()
    })
    return { cmd, log: `submitted (${legal.length} options)` }
  }

  /**
   * 外部から意思決定を投入する。
   * legal 列に含まれない cmd を渡した場合はエラー（UI 側の整合性バグ検知）。
   */
  submit(cmd: Command): void {
    if (!this.pending || !this.resolver) {
      throw new Error('AsyncRemoteAgent: no pending decision to submit')
    }
    if (!isLegalMatch(cmd, this.pending.legal)) {
      throw new Error(`AsyncRemoteAgent: submitted command is not in legal list: ${JSON.stringify(cmd)}`)
    }
    const resolve = this.resolver
    this.pending = null
    this.resolver = null
    this.notify()
    resolve(cmd)
  }

  private notify(): void {
    for (const l of this.listeners) l(this.pending)
  }
}

/**
 * legal 配列に cmd と構造的等価な要素があるかチェック。
 * discriminated union なので JSON 深比較で十分（Map/Set は現 Command 内に無し）
 */
function isLegalMatch(cmd: Command, legal: readonly Command[]): boolean {
  const key = JSON.stringify(cmd)
  return legal.some(c => JSON.stringify(c) === key)
}
