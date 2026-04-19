/**
 * Phase 1 では NN obs encoder の実装は M3 で行う。
 * M4' では (obs, π, z) を buffer に蓄積する形だけ作るための placeholder。
 *
 * M3 で fenrir-style の `CollectedObservation` (Float32Array 等) に置換予定。
 */
export type RawObs = {
  alive: number
  day: number
  masonSeat: number
}

export function captureObs(alive: number, day: number, masonSeat: number): RawObs {
  return { alive, day, masonSeat }
}
