"""SplitMix64 PRNG, as specified by MonteCarlo Contract 1.0 (simulation.md)."""

from __future__ import annotations

MASK = (1 << 64) - 1
_GOLDEN = 0x9E3779B97F4A7C15
_M1 = 0xBF58476D1CE4E5B9
_M2 = 0x94D049BB133111EB


class SplitMix64:
    def __init__(self, seed: int) -> None:
        self.state = seed & MASK

    def next_u64(self) -> int:
        self.state = (self.state + _GOLDEN) & MASK
        z = self.state
        z = ((z ^ (z >> 30)) * _M1) & MASK
        z = ((z ^ (z >> 27)) * _M2) & MASK
        return (z ^ (z >> 31)) & MASK

    def next_bounded(self, n: int) -> int:
        if n < 1:
            raise ValueError("bound must be >= 1")
        return self.next_u64() % n

    def next_int(self, lo: int, hi: int) -> int:
        if hi < lo:
            raise ValueError("hi < lo")
        return lo + self.next_bounded(hi - lo + 1)

    def next_ppm_hit(self, ppm: int) -> bool:
        return (self.next_u64() % 1_000_000) < ppm
