from dataclasses import dataclass


@dataclass
class MonteCarloConfig:
    runs: int = 500
    seed: int = 42
    income_variation_min: int = -8
    income_variation_max: int = 8
    surprise_probability: float = 0.15
    surprise_check_interval_days: int = 14
    surprise_amount_min: int = 2000
    surprise_amount_max: int = 15000
    worst_percentile: float = 0.10
