/**
 * 後方互換 re-export — 実体は fenrir/src/retar-bridge.ts に移動
 */
export {
  useWasm, DEFAULT_RETAR_OPTIONS, lupaRunRetar,
  analyzeFromEvents, buildAssumptions, analyzePerPlayer,
  checkRetarConsistency, searchTsumiFromEvents, retarResultToPossibilities,
} from '../fenrir/src/retar-bridge.ts'

export type { RetarResult, PerPlayerRetarResult, TsumiFromEventsResult } from '../fenrir/src/retar-bridge.ts'
