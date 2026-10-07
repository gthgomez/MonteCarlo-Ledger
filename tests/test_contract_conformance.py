"""Contract 1.0 conformance: the Python reference must pass the golden corpus."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from monte_carlo_ledger.contract import (
    ContractError,
    SplitMix64,
    nearest_rank,
    round_half_away,
    run_scenario,
    run_scenario_safe,
    scale_cents_by_basis_points,
    scale_cents_by_percent,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schemas"


def _load(path: Path):
    return json.loads(path.read_text())


def _all_fixtures():
    return sorted(FIXTURES.glob("**/*.json"))


def _schema_errors(instance) -> list:
    try:
        import jsonschema
    except Exception:  # pragma: no cover
        return []
    schema = _load(SCHEMA_DIR / "scenario.schema.json")
    validator = jsonschema.Draft202012Validator(schema)
    return [e.message for e in validator.iter_errors(instance)]


@pytest.mark.parametrize("path", _all_fixtures(), ids=lambda p: p.stem)
def test_fixture(path: Path):
    doc = _load(path)
    scenario = doc["scenario"]
    expected = doc.get("expected")
    status = doc.get("expected_status", "frozen")

    if status == "pending-generation" or expected is None:
        pytest.skip("expected not yet frozen")

    if isinstance(expected, dict) and "error" in expected:
        if expected["error"] == "SCHEMA_INVALID":
            assert _schema_errors(scenario), "expected schema failure but scenario validated"
        else:
            result = run_scenario_safe(scenario)
            assert result == {"error": expected["error"]}, result
        return

    actual = run_scenario(scenario)
    assert actual == expected, (
        f"contract mismatch for {path.name}\n"
        f"  actual:   {json.dumps(actual, sort_keys=True)}\n"
        f"  expected: {json.dumps(expected, sort_keys=True)}"
    )


def test_prng_vectors():
    rng = SplitMix64(0)
    assert rng.next_u64() == 16294208416658607535
    rng = SplitMix64(0)
    assert rng.next_int(0, 100) == 67
    rng = SplitMix64(42)
    assert rng.next_u64() == 13679457532755275413
    rng = SplitMix64(42)
    assert rng.next_int(0, 100) == 23


def test_money_rounding_examples():
    assert scale_cents_by_percent(100, 1) == 101
    assert scale_cents_by_percent(100, -1) == 99
    assert scale_cents_by_percent(101, -8) == 93
    assert scale_cents_by_percent(150, 0) == 150
    assert scale_cents_by_basis_points(999, 500) == 50
    assert round_half_away(150, 100) == 2
    assert round_half_away(-150, 100) == -2


def test_percentile_examples():
    xs = list(range(1, 501))
    assert nearest_rank(xs, 1, 10) == 50
    assert nearest_rank(xs, 1, 2) == 250
    assert nearest_rank(xs, 9, 10) == 450
    assert nearest_rank([1, 2, 3, 4, 5], 1, 10) == 1
    with pytest.raises(ContractError):
        run_scenario({"scenario_id": "x", "starting_balance_cents": 0, "events": [],
                      "horizon_days": -1, "as_of": "2026-10-01"})


def _exclusion_scenario(**overrides):
    base = {
        "contract_version": "1.1",
        "scenario_id": "x",
        "as_of": "2026-10-01",
        "starting_balance_cents": 0,
        "horizon_days": 90,
        "events": [],
        "recurrences": [
            {"id": "rent", "type": "expense", "amount_cents": -10000,
             "frequency": "monthly", "anchor_day": 15, "start_date": "2026-10-15"}
        ],
        "occurrence_exclusions": [{"recurrence_id": "rent", "date": "2026-11-15"}],
    }
    base.update(overrides)
    return base


def test_exclusion_removes_only_the_named_occurrence():
    result = run_scenario(_exclusion_scenario())
    assert result["forecast"] == {
        "minimum_balance_cents": -20000,
        "minimum_balance_date": "2026-12-15",
        "ending_balance_cents": -20000,
        "first_negative_date": "2026-10-15",
    }
    assert result["contract_version"] == "1.1"


def test_exclusion_matching_nothing_is_a_noop():
    with_exclusion = run_scenario(
        _exclusion_scenario(occurrence_exclusions=[{"recurrence_id": "nope", "date": "2026-11-15"}])
    )
    without = run_scenario(_exclusion_scenario(occurrence_exclusions=[]))
    assert with_exclusion == without


def test_malformed_exclusion_is_schema_invalid():
    with pytest.raises(ContractError) as exc:
        run_scenario(_exclusion_scenario(occurrence_exclusions=[{"recurrence_id": "rent"}]))
    assert exc.value.code == "SCHEMA_INVALID"


def test_result_echoes_declared_version():
    assert run_scenario(
        _exclusion_scenario(contract_version="1.0", occurrence_exclusions=[])
    )["contract_version"] == "1.0"
    with pytest.raises(ContractError) as exc:
        run_scenario(_exclusion_scenario(contract_version="2.0"))
    assert exc.value.code == "SCHEMA_INVALID"
