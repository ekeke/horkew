import type { SystemRole } from '../../types/index.ts'
import type { World } from '../../hati/types.ts'
import { collectWorlds } from '../../hati/worlds.ts'
import type { Possibilities } from '../../retar/possibilities.ts'
import { BENCH_ENABLED, benchEnd } from '../bench/profiler.ts'

/**
 * Retar possibilities から integral world を sampling する utility。
 *
 * Phase 1 戦略: 1 回の MCTS run につき一括で全 world を enumerate し、
 * rollout ごとに uniform pick。重盤面（>maxWorlds）は overflow となり
 * `sample()` が null を返すので caller が早期 abort する。
 *
 * 将来は posterior 重み付け（NN predict head による）や MCMC への切替を検討。
 */
export class Determinizer {
  private readonly worlds: readonly World[] | null

  constructor(
    possibilities: Possibilities,
    setup: Map<SystemRole, number>,
    maxWorlds: number = 100000,
  ) {
    const t0 = BENCH_ENABLED ? performance.now() : 0
    this.worlds = collectWorlds(possibilities, setup, maxWorlds)
    if (BENCH_ENABLED) benchEnd('world_enumerate', t0)
  }

  /** rng で uniform sample。世界数が 0 / overflow なら null */
  sample(rng: () => number = Math.random): World | null {
    const t0 = BENCH_ENABLED ? performance.now() : 0
    if (this.worlds === null || this.worlds.length === 0) {
      if (BENCH_ENABLED) benchEnd('world_sample', t0)
      return null
    }
    const idx = Math.min(this.worlds.length - 1, Math.floor(rng() * this.worlds.length))
    const result = this.worlds[idx]
    if (BENCH_ENABLED) benchEnd('world_sample', t0)
    return result
  }

  /** 列挙した world 数。null（overflow）なら -1 */
  size(): number {
    return this.worlds?.length ?? -1
  }

  /** overflow したかどうか */
  isOverflow(): boolean {
    return this.worlds === null
  }
}
