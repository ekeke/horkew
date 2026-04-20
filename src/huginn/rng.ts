/** Seeded PRNG (mulberry32) — Huginn 内で完結。lupa の Rng には依存しない。 */

export class Rng {
  private state: number

  constructor(seed: number = Date.now()) {
    this.state = seed >>> 0
    if (this.state === 0) this.state = 1
  }

  next(): number {
    let t = this.state += 0x6d2b79f5
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive)
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(arr.length)]
  }
}

export function gaussian(rng: Rng): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng.next()
  while (v === 0) v = rng.next()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}
