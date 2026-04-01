export class Rng {
  private state: number

  constructor(seed?: number, _restoreState?: number) {
    if (_restoreState !== undefined) {
      this.state = _restoreState
    } else {
      this.state = seed ?? (Date.now() | 0)
      if (this.state === 0) this.state = 1
    }
  }

  // mulberry32
  next(): number {
    this.state |= 0
    this.state = (this.state + 0x6D2B79F5) | 0
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max)
  }

  pick<T>(array: T[]): T {
    return array[this.nextInt(array.length)]
  }

  shuffle<T>(array: T[]): T[] {
    const result = [...array]
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1)
      ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
  }

  getState(): number {
    return this.state
  }

  static fromState(state: number): Rng {
    return new Rng(undefined, state)
  }
}
