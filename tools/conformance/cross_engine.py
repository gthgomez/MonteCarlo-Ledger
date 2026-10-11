#!/usr/bin/env python3
"""Cross-engine conformance: compare Python and Kotlin canonical results to each fixture and to
each other, and write a divergence report.

Dumb by construction: it parses, delegates comparison to compare.deep_diff, and reports. It does
no financial computation. It also records provenance (the Android emitting commit and the contract
pin `source_commit`) in the report for MC-07; provenance is never an input to the comparison.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare import deep_diff, load_json  # noqa: E402  (same directory)


def find(fixture_dir: Path) -> List[Path]:
    return sorted(fixture_dir.glob("**/*.json"))


def load_actual(directory: Optional[Path], scenario_id: str) -> Optional[Dict[str, Any]]:
    if directory is None:
        return None
    path = directory / f"{scenario_id}.json"
    if not path.exists():
        return None
    return load_json(path)


def read_contract_pin(path: Optional[Path]) -> Optional[str]:
    """Return the contract ``source_commit`` from an Android ``contract-pin.json``.

    Parsing only: this is provenance metadata, not financial computation.
    """
    if path is None or not path.exists():
        return None
    doc = load_json(path)
    if isinstance(doc, dict):
        commit = doc.get("source_commit")
        if isinstance(commit, str) and commit:
            return commit
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", type=Path, required=True)
    ap.add_argument("--python-dir", type=Path, required=True)
    ap.add_argument("--kotlin-dir", type=Path, required=True)
    ap.add_argument("--report", type=Path, default=None)
    ap.add_argument("--kotlin-sha", default=None,
                    help="Android commit SHA whose Kotlin engine emitted --kotlin-dir "
                         "(engine provenance; reported, never used for comparison)")
    ap.add_argument("--contract-pin", type=Path, default=None,
                    help="Android contract-pin.json; its source_commit is reported as the "
                         "contract pin revision")
    ap.add_argument("--contract-sha", default=None,
                    help="contract source_commit SHA (overrides --contract-pin)")
    args = ap.parse_args()

    kotlin_sha = args.kotlin_sha or "unavailable"
    contract_pin_sha = args.contract_sha or read_contract_pin(args.contract_pin) or "unavailable"

    rows: List[Dict[str, str]] = []
    failures = 0
    checked = 0

    for path in find(args.fixtures):
        doc = load_json(path)
        scenario = doc.get("scenario")
        if scenario is None:
            continue
        expected = doc.get("expected")
        status = doc.get("expected_status", "frozen")
        sid = scenario.get("scenario_id", path.stem)
        if status == "pending-generation" or expected is None:
            rows.append({"id": sid, "outcome": "PENDING", "detail": "expected not frozen"})
            continue

        py = load_actual(args.python_dir, sid)
        kt = load_actual(args.kotlin_dir, sid)
        checked += 1
        detail: List[str] = []

        if py is None or kt is None:
            failures += 1
            rows.append({"id": sid, "outcome": "MISSING",
                         "detail": f"python={'ok' if py else 'missing'} kotlin={'ok' if kt else 'missing'}"})
            continue

        if isinstance(expected, dict) and "error" in expected:
            code = expected["error"]
            ok = py.get("error") == code and kt.get("error") == code
            if not ok:
                failures += 1
                detail.append(f"expected error {code}: py={py} kt={kt}")
        else:
            for label, actual in (("python", py), ("kotlin", kt)):
                diffs = deep_diff(expected, actual)
                if diffs:
                    failures += 1
                    detail.append(f"{label} vs expected: " + "; ".join(diffs))
            cross = deep_diff(py, kt)
            if cross:
                failures += 1
                detail.append("python vs kotlin: " + "; ".join(cross))

        rows.append({"id": sid, "outcome": "FAIL" if detail else "PASS",
                     "detail": " | ".join(detail)})

    lines = [
        "# MC-06 — Cross-Engine Divergence Report",
        "",
        "## Engine provenance",
        "",
        f"- Python engine: current working tree ({args.python_dir})",
        f"- Kotlin (Android) emitting commit: `{kotlin_sha}`",
        f"- Contract pin (`contract-pin.json` source_commit): `{contract_pin_sha}`",
        f"- Kotlin results directory: `{args.kotlin_dir}`",
        "",
        f"Fixtures checked: **{checked}**  ·  Divergences: **{failures}**",
        "",
        "| scenario_id | outcome | detail |",
        "|---|---|---|",
    ]
    for r in rows:
        lines.append(f"| {r['id']} | {r['outcome']} | {r['detail']} |")
    report = "\n".join(lines) + "\n"

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report)
    print(report)
    print(f"checked={checked} divergences={failures}")
    print(f"provenance kotlin_sha={kotlin_sha} contract_pin_sha={contract_pin_sha}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
