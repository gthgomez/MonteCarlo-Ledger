/**
 * SplitMix64 PRNG, as specified by MonteCarlo Contract 1.0 (simulation.md).
 */

const MASK = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const M1 = 0xbf58476d1ce4e5b9n;
const M2 = 0x94d049bb133111ebn;

export class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint | number) {
    this.state = BigInt(seed) & MASK;
  }

  nextU64(): bigint {
    this.state = (this.state + GOLDEN) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * M1) & MASK;
    z = ((z ^ (z >> 27n)) * M2) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  }

  nextBounded(n: bigint | number): bigint {
    const bigN = BigInt(n);
    if (bigN < 1n) {
      throw new Error("bound must be >= 1");
    }
    return this.nextU64() % bigN;
  }

  nextInt(lo: number, hi: number): number {
    if (hi < lo) {
      throw new Error("hi < lo");
    }
    const diff = BigInt(hi - lo + 1);
    return lo + Number(this.nextBounded(diff));
  }

  nextPpmHit(ppm: number): boolean {
    return Number(this.nextU64() % 1000000n) < ppm;
  }
}
