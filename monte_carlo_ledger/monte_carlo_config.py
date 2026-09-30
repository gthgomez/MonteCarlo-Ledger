import math
from dataclasses import dataclass

# Documented resource budget: the maximum number of simulation runs a single
# Monte Carlo invocation may request. See docs/engineering/calculation-contract.md.
MAX_RUNS = 100_000


def _require_int(name: str, value) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer, got {value!r}")
    return value


def _require_float(name: str, value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number, got {value!r}")
    value = float(value)
    if math.isnan(value):
        raise ValueError(f"{name} must not be NaN")
    return value


@dataclass
class MonteCarloConfig:
    """Validated configuration for the Monte Carlo risk layer.

    All validation happens at construction time, i.e. before any sampling
    runs, so an invalid configuration can never produce a partial result.

    Scale note: ``worst_percentile`` uses the historical normalized [0, 1]
    scale (default 0.10 = the 10th percentile). It is deliberately NOT
    reinterpreted as a 0-100 percentage so that previously saved
    configurations keep their meaning.
    """

    runs: int = 500
    seed: int = 42
    income_variation_min: int = -8
    income_variation_max: int = 8
    surprise_probability: float = 0.15
    surprise_check_interval_days: int = 14
    surprise_amount_min: int = 2000
    surprise_amount_max: int = 15000
    worst_percentile: float = 0.10

    def __post_init__(self):
        self.runs = _require_int("runs", self.runs)
        if not 1 <= self.runs <= MAX_RUNS:
            raise ValueError(
                f"runs must be in [1, {MAX_RUNS}] (documented resource budget), "
                f"got {self.runs}"
            )

        _require_int("seed", self.seed)

        self.income_variation_min = _require_int(
            "income_variation_min", self.income_variation_min
        )
        self.income_variation_max = _require_int(
            "income_variation_max", self.income_variation_max
        )
        if self.income_variation_min > self.income_variation_max:
            raise ValueError(
                "income_variation_min must be <= income_variation_max, got "
                f"[{self.income_variation_min}, {self.income_variation_max}]"
            )
        if self.income_variation_max < 0:
            raise ValueError(
                "income_variation_max must be >= 0, got "
                f"{self.income_variation_max}"
            )

        self.surprise_probability = _require_float(
            "surprise_probability", self.surprise_probability
        )
        if not 0.0 <= self.surprise_probability <= 1.0:
            raise ValueError(
                f"surprise_probability must be in [0, 1], got {self.surprise_probability}"
            )

        self.surprise_check_interval_days = _require_int(
            "surprise_check_interval_days", self.surprise_check_interval_days
        )
        if self.surprise_check_interval_days < 1:
            raise ValueError(
                "surprise_check_interval_days must be >= 1, got "
                f"{self.surprise_check_interval_days}"
            )

        self.surprise_amount_min = _require_int(
            "surprise_amount_min", self.surprise_amount_min
        )
        self.surprise_amount_max = _require_int(
            "surprise_amount_max", self.surprise_amount_max
        )
        if self.surprise_amount_min < 0 or self.surprise_amount_max < 0:
            raise ValueError(
                "surprise amounts must be nonnegative cents, got "
                f"[{self.surprise_amount_min}, {self.surprise_amount_max}]"
            )
        if self.surprise_amount_min > self.surprise_amount_max:
            raise ValueError(
                "surprise_amount_min must be <= surprise_amount_max, got "
                f"[{self.surprise_amount_min}, {self.surprise_amount_max}]"
            )

        self.worst_percentile = _require_float("worst_percentile", self.worst_percentile)
        if not 0.0 < self.worst_percentile <= 1.0:
            raise ValueError(
                "worst_percentile must be in the normalized scale (0, 1] "
                f"(0.10 = 10th percentile), got {self.worst_percentile}"
            )
