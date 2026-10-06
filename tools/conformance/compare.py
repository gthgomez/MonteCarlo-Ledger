#!/usr/bin/env python3
"""Dumb MonteCarlo conformance comparer.

This tool is intentionally stupid. It does exactly:

    parse -> schema-validate -> normalize -> compare -> readable diff

It MUST NOT compute forecasts, safe-to-spend, percentiles, simulations, or any business rule.
If you are tempted to add financial logic here, you are building Finance Engine #3.

Usage:
    compare.py --fixture fixtures/deterministic/no-dip.json \
               --actual python=/tmp/py-no-dip.json \
               --actual kotlin=/tmp/kt-no-dip.json

Exit code: 0 if every provided actual matches expected (or the fixture is PENDING), 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:  # optional; schema validation is skipped with a warning if unavailable
    import jsonschema  # type: ignore
except Exception:  # pragma: no cover
    jsonschema = None

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schemas"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_schema(name: str) -> Optional[Dict[str, Any]]:
    path = SCHEMA_DIR / name
    if not path.exists() or jsonschema is None:
        return None
    return load_json(path)


def schema_errors(instance: Any, schema_name: str) -> List[str]:
    schema = load_schema(schema_name)
    if schema is None:
        return []
    validator = jsonschema.Draft202012Validator(schema)
    return [
        f"{'/'.join(str(p) for p in err.absolute_path) or '<root>'}: {err.message}"
        for err in sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
    ]


def deep_diff(expected: Any, actual: Any, path: str = "") -> List[str]:
    """Return human-readable differences. No normalization beyond None/null already being JSON."""
    diffs: List[str] = []
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual)):
            child = f"{path}.{key}" if path else str(key)
            if key not in actual:
                diffs.append(f"{child}: missing in actual (expected {expected[key]!r})")
            elif key not in expected:
                diffs.append(f"{child}: unexpected in actual ({actual[key]!r})")
            else:
                diffs.extend(deep_diff(expected[key], actual[key], child))
    elif isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            diffs.append(f"{path or '<root>'}: length {len(actual)} != expected {len(expected)}")
        for i, (e, a) in enumerate(zip(expected, actual)):
            diffs.extend(deep_diff(e, a, f"{path}[{i}]"))
    elif expected != actual:
        diffs.append(f"{path or '<root>'}: {actual!r} != expected {expected!r}")
    return diffs


def extract_fixture(doc: Dict[str, Any]) -> Tuple[Dict[str, Any], Any, str]:
    if "scenario" in doc:
        return doc["scenario"], doc.get("expected"), doc.get("expected_status", "frozen")
    return doc, doc, "frozen"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Dumb MonteCarlo conformance comparer")
    parser.add_argument("--fixture", required=True, type=Path, help="fixture JSON file")
    parser.add_argument(
        "--actual",
        action="append",
        default=[],
        metavar="LABEL=FILE",
        help="engine result JSON; repeatable",
    )
    parser.add_argument("--json", action="store_true", help="emit a JSON report")
    args = parser.parse_args(argv)

    fixture_doc = load_json(args.fixture)
    scenario, expected, status = extract_fixture(fixture_doc)

    report: Dict[str, Any] = {
        "fixture": str(args.fixture),
        "scenario_id": scenario.get("scenario_id", "<unknown>"),
        "contract_version": scenario.get("contract_version", "<none>"),
        "expected_status": status,
        "schema_errors": schema_errors(scenario, "scenario.schema.json"),
        "results": {},
    }

    if status == "pending-generation" or expected is None:
        report["outcome"] = "PENDING"
        print(json.dumps(report, indent=2) if args.json else
              f"PENDING  {report['scenario_id']}  (expected not yet frozen)")
        return 0

    is_error_fixture = isinstance(expected, dict) and "error" in expected
    outcome = "PASS"

    for spec in args.actual:
        if "=" not in spec:
            print(f"bad --actual {spec!r}; expected LABEL=FILE", file=sys.stderr)
            return 2
        label, _, file_str = spec.partition("=")
        actual = load_json(Path(file_str))

        if is_error_fixture:
            code = expected["error"]
            got = actual.get("error") if isinstance(actual, dict) else None
            if code == "SCHEMA_INVALID":
                ok = bool(report["schema_errors"]) or got == code
            else:
                ok = got == code
            diffs = [] if ok else [f"expected error {code!r}, got {actual!r}"]
        else:
            # Validate actual against the result schema when available.
            actual_for_schema = {k: v for k, v in actual.items() if k != "forecast_rows"}
            result_schema_errs = schema_errors(actual_for_schema, "result.schema.json")
            diffs = result_schema_errs + deep_diff(expected, actual)
            ok = not diffs

        report["results"][label] = {"ok": ok, "diffs": diffs}
        if not ok:
            outcome = "FAIL"
            print(f"FAIL     {report['scenario_id']}  [{label}]")
            for d in diffs:
                print(f"         - {d}")
        else:
            print(f"PASS     {report['scenario_id']}  [{label}]")

    if report["schema_errors"] and not is_error_fixture:
        outcome = "FAIL"
        report["schema_error_note"] = report["schema_errors"]

    report["outcome"] = outcome
    if args.json:
        print(json.dumps(report, indent=2))
    return 0 if outcome == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
