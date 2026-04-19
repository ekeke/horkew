/**
 * CommandAgent — コマンド空間での意思決定者インターフェース
 *
 * 既存 `src/fenrir/src/agents/agent.ts` の Agent とは別系統。
 * 1 インスタンス = 1 席が原則。人間陣営が複数席を 1 インスタンスで握る余地も
 * 実装側の自由（AsyncRemoteAgent は submit 側で席を選ぶ）。
 */

import type { GameState, GameEvent } from '../../../lupa/types.ts'
import type { FenrirExtEvent } from '../events.ts'
import type { Command, CommandAdapterExt } from '../adapters/command/command-types.ts'

/** Agent に渡されるイベント配列の型（adapter が公開する形式） */
export type AgentEvents = readonly (GameEvent | FenrirExtEvent)[]

/** 意思決定 1 手の結果 */
export type DecisionResult = {
  /** 選択された合法手 */
  cmd: Command
  /**
   * 判断の根拠を表す 1 行ログ（Howl コメントとして adapter が emit する）。
   * 形式: `agentName[(sub)]: <内部情報> [→ <短い判断>]`
   * 省略時は adapter が `agentName: <cmd.type>` にフォールバック。
   */
  log?: string
}

export interface CommandAgent {
  /** Howl コメントに表示されるエージェント識別子。短く（'random', 'skoll', 'human' 等） */
  readonly name: string

  /**
   * 合法手から 1 つを選んで返す。
   * - `state` は read-only（Agent は状態を書き換えない）
   * - `legal` は `legalCommands(state, mySeat)` の返値
   * - `events` は現時点までの公開イベント列（skoll/rule-based 判断に必須）
   * - HumanUI 経由の場合は未決定の間 Promise を保留し続ける
   */
  decide(
    state: Readonly<GameState<CommandAdapterExt>>,
    mySeat: number,
    legal: readonly Command[],
    events: AgentEvents,
  ): Promise<DecisionResult>
}
