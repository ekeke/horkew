/**
 * 後方互換 re-export — 実体は fenrir/src/retar-node-bridge.ts に移動
 */
export {
  initRetarWorkerPool, terminateRetarWorkerPool, analyzeFromEventsParallel,
} from '../fenrir/src/retar-node-bridge.ts'
