/**
 * applyCommand — CommandAdapterExt の決定論的状態遷移
 *
 * lupa 側の GameState フィールド（player.claimedRole 等）は触らない。
 * それらはアダプタ層（onDayClaims, onNight, onVote）が lupa へ渡すことで反映される。
 *
 * 本関数は Command Adapter 内部の state machine（フェーズ・キュー・履歴）のみを管理する。
 */

import type { GameState } from '../../../../lupa/types.ts'
import type { Command, CommandAdapterExt, CommandPhase } from './command-types.ts'

/**
 * コマンドをアダプタ状態に適用する。
 * 呼び出し側は legalCommands で得た Command のみ渡すこと（防御的チェックなし）。
 */
export function applyCommand(
  state: GameState<CommandAdapterExt>,
  seat: number,
  cmd: Command,
): void {
  const ext = state.ext

  // 履歴は必ず記録（合法性の後追い検証用）
  ext.history.push({
    day: state.day,
    phase: ext.currentPhase,
    seat,
    cmd,
  })

  switch (ext.currentPhase) {
    case 'night':
      applyNightPhase(ext, seat, cmd)
      break
    case 'discussion':
      applyDiscussionPhase(state, ext, seat, cmd)
      break
    case 'commander':
      applyCommanderPhase(state, ext, cmd)
      break
    case 'cco':
      applyCcoPhase(ext, seat, cmd)
      break
    case 'vote':
      // vote フェーズ: history 記録のみ（実投票は onVote の Map に反映）
      break
  }
}

// ============================================================
// 夜
// ============================================================

function applyNightPhase(
  _ext: CommandAdapterExt, _seat: number, _cmd: Command,
): void {
  // 夜コマンドは lupa の onNight が集約返却するため、ext 側の遷移は不要。
  // 実効はアダプタ層で NightAction にマップして lupa へ渡す。
  // Phase 遷移（night → discussion）はアダプタの onDayClaims で行う。
}

// ============================================================
// 議論
// ============================================================

function applyDiscussionPhase(
  _state: GameState<CommandAdapterExt>,
  ext: CommandAdapterExt,
  seat: number,
  cmd: Command,
): void {
  if (cmd.type === 'skip') {
    ext.consecutiveSkips.add(seat)
    // キュー先頭と一致していれば pop
    if (ext.discussionQueue[0] === seat) ext.discussionQueue.shift()
    return
  }

  if (cmd.type === 'role_co' || cmd.type === 'role_result_report') {
    // 誰かが行動したので連続 skip をリセット
    ext.consecutiveSkips.clear()
    // 行動者はキューから除外（同一人物の連続行動禁止、R3）
    ext.discussionQueue = ext.discussionQueue.filter(s => s !== seat)
    // 他の生存者を再シャッフルしてキュー末尾に積み直す責務はアダプタ側（Rng を持つ層）
    // ここではフラグ的に discussionQueue を空にしておく（アダプタが埋める）
    // → Phase 3 のアダプタ実装で再構築する想定。
    return
  }
}

// ============================================================
// 指揮
// ============================================================

function applyCommanderPhase(
  _state: GameState<CommandAdapterExt>,
  ext: CommandAdapterExt,
  cmd: Command,
): void {
  switch (cmd.type) {
    case 'request_co':
      // CO 要求: 議論フェーズへ戻す
      ext.currentPhase = 'discussion'
      ext.consecutiveSkips.clear()
      // キューはアダプタ側で再構築
      ext.discussionQueue = []
      // 当日の request_co 履歴に追加（同カテゴリを同日に再要求しないため）
      ext.requestedCategoriesThisDay.add(cmd.category)
      // UI バナー用のアクティブセットにも追加。一巡完了 → commander 遷移時に clear.
      ext.activeCoRequests.push(cmd.category)
      return
    case 'designate_execution':
      ext.designatedTarget = cmd.target
      ext.runoffCandidates = null
      ext.ccoQueue = [cmd.target]
      ext.ccoAnyReveal = false
      ext.currentPhase = 'cco'
      return
    case 'designate_runoff':
      ext.designatedTarget = null
      ext.runoffCandidates = [...cmd.targets]
      ext.ccoQueue = [...cmd.targets]
      ext.ccoAnyReveal = false
      ext.currentPhase = 'cco'
      return
    case 'skip':
      // commander が明示的に skip: 指定無しで直接投票フェーズへ
      ext.designatedTarget = null
      ext.runoffCandidates = null
      ext.currentPhase = 'vote'
      return
  }
}

// ============================================================
// CCO
// ============================================================

function applyCcoPhase(
  ext: CommandAdapterExt, seat: number, cmd: Command,
): void {
  // キューから先頭 seat を除去（ccoQueue は順次処理）
  const idx = ext.ccoQueue.indexOf(seat)
  if (idx >= 0) ext.ccoQueue.splice(idx, 1)

  if (cmd.type === 'cco_full' || cmd.type === 'cco_villain_reveal') {
    ext.ccoAnyReveal = true
  }
  // cco_skip は何もしない（既にキュー除去済み）

  // キュー消化完了時のフェーズ遷移はアダプタ側で判定:
  //   ccoAnyReveal=true → discussion へ戻す
  //   ccoAnyReveal=false → vote へ進む
}

// ============================================================
// フェーズ遷移ヘルパー（アダプタから呼ぶ）
// ============================================================

/** 議論フェーズのキューを再構築（行動者除外 + シャッフル順はアダプタで供給） */
export function resetDiscussionQueue(
  ext: CommandAdapterExt, seats: number[],
): void {
  ext.discussionQueue = [...seats]
  ext.consecutiveSkips.clear()
}

/** 議論終了判定（全員連続 skip） */
export function isDiscussionExhausted(
  ext: CommandAdapterExt, aliveSeats: number[],
): boolean {
  return aliveSeats.every(s => ext.consecutiveSkips.has(s))
}

/** フェーズ切替（外部から明示的に使う） */
export function setPhase(ext: CommandAdapterExt, phase: CommandPhase): void {
  ext.currentPhase = phase
}
