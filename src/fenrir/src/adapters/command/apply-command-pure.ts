/**
 * applyCommandPure — applyCommand の非破壊（pure）版
 *
 * afterstate 評価用。元の state を変更せず、新しい state を返す。
 * 実装は state.ext のみ浅く複製し（CommandAdapterExt の可変フィールドを全コピー）、
 * applyCommand を新 state に対して実行する。
 *
 * 注意: lupa 側の state.players, executionHistory 等は共有参照のまま。
 * これらは applyCommand が触らないため実害なし（不変前提）。
 */

import type { GameState } from '../../../../lupa/types.ts'
import type { Command, CommandAdapterExt } from './command-types.ts'
import { applyCommand } from './apply-command.ts'

/** CommandAdapterExt の deep-ish copy（Map/Set/Array を新規化） */
export function cloneCommandAdapterExt(ext: CommandAdapterExt): CommandAdapterExt {
  return {
    currentPhase: ext.currentPhase,
    discussionQueue: [...ext.discussionQueue],
    consecutiveSkips: new Set(ext.consecutiveSkips),
    commander: ext.commander,
    designatedTarget: ext.designatedTarget,
    runoffCandidates: ext.runoffCandidates ? [...ext.runoffCandidates] : null,
    ccoQueue: [...ext.ccoQueue],
    ccoAnyReveal: ext.ccoAnyReveal,
    history: [...ext.history],
    preVoteStepCount: ext.preVoteStepCount,
    voteCandidates: ext.voteCandidates ? [...ext.voteCandidates] : null,
    retarCache: ext.retarCache,  // 共有参照で OK（applyCommand は触らない）
    requestedCategoriesThisDay: new Set(ext.requestedCategoriesThisDay),
    activeCoRequests: [...ext.activeCoRequests],
    villainClaimPlan: new Map(ext.villainClaimPlan),
  }
}

/**
 * applyCommand の pure 版: state を変更せず、新 state を返す。
 * state.ext のみ複製し、state.players 等は共有参照のまま（applyCommand が
 * lupa 側フィールドを触らないため安全）。
 */
export function applyCommandPure(
  state: Readonly<GameState<CommandAdapterExt>>,
  seat: number,
  cmd: Command,
): GameState<CommandAdapterExt> {
  const newState: GameState<CommandAdapterExt> = {
    ...state,
    ext: cloneCommandAdapterExt(state.ext),
  }
  applyCommand(newState, seat, cmd)
  return newState
}
