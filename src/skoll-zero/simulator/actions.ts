/**
 * Mason の MCTS action 空間。Phase 1 では day vote のみ。
 *
 * - mason に夜行動なし
 * - CO / claim は scope 外
 * - commander runoff は scope 外
 *
 * action は「vote 対象 seat」を表す single integer に縮退できるが、
 * 将来 night action 等を加える際の拡張余地として discriminated union にしておく。
 */
export type MasonAction =
  | { type: 'execute', target: number }

/**
 * 1 night 分の全プレイヤー night action（heuristic で決定済み）。
 * hati/simulate.ts の `simulateNight` シグネチャに直接渡す。
 */
export type NightDecisions = {
  wolfBiteTarget: number
  bodyguardTarget: number | null
  /** seerMask の low-bit 順に各占い師の対象 seat を並べる */
  seerTargets: number[]
}
