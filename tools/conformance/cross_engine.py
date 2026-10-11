#!/usr/bin/env python3
"""Cross-engine conformance: compare Python and Kotlin canonical results to each fixture and to
each other, and write a divergence report.

Dumb by construction: it parses, delegates comparison to compare.deep_diff, and reports. It does
no financial computation. It also records provenance (the Android emitting commit and the contract
pin `source_commit`) in the report for MC-07; provenance is never an input to the comparison.

Provenance is never guessed and never silently downgraded. If a caller supplies a provenance
source (`--contract-pin`), that source MUST resolve: an unreadable file, malformed JSON, or a pin
without `source_commit` exits 2 with a clear message instead of reporting "unavailable" next to a
green comparison. `--strict` additionally requires provenance to be supplied at all, so CI cannot
publish a passing report that carries no engine/contract revision (the live job uses `--strict`).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare import deep_diff, load_json  # noqa: E402  (same directory)

UNAVAILABLE = "unavailable"
PROVENANCE_EXIT = 2


class ProvenanceError(Exception):
    """A requested provenance source could not be resolved. Never silently downgraded."""


def find(fixture_dir: Path) -> List[Path]:
    return sorted(fixture_dir.glob("**/*.json"))


def scenario_ids(directory: Optional[Path]) -> List[str]:
    """Scenario ids available as ``<scenario_id>.json`` in an engine result directory."""
    if directory is None or not directory.is_dir():
        return []
    return sorted(path.stem for path in directory.glob("*.json"))


def load_actual(directory: Optional[Path], scenario_id: str) -> Optional[Dict[str, Any]]:
    if directory is None:
        return None
    path = directory / f"{scenario_id}.json"
    if not path.exists():
        return None
    return load_json(path)


def read_contract_pin(path: Path) -> str:
    """Return the contract ``source_commit`` from an Android ``contract-pin.json``.

    Parsing only: this is provenance metadata, not financial computation. Raises
    :class:`ProvenanceError` when the file cannot be read, is not JSON, is not an object, or
    carries no non-empty ``source_commit`` — an explicitly supplied provenance source that cannot
    be resolved is an error, not an excuse to report "unavailable".
    """
    try:
        doc = load_json(path)
    except OSError as exc:
        raise ProvenanceError(f"--contract-pin {path} could not be read: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ProvenanceError(f"--contract-pin {path} is not valid JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise ProvenanceError(
            f"--contract-pin {path} must be a JSON object, found {type(doc).__name__}"
        )
    commit = doc.get("source_commit")
    if not isinstance(commit, str) or not commit.strip():
        raise ProvenanceError(
            f"--contract-pin {path} has no non-empty 'source_commit' string; "
            f"provenance would silently degrade to '{UNAVAILABLE}'"
        )
    return commit.strip()


def resolve_kotlin_sha(args: argparse.Namespace) -> str:
    """Engine provenance: the Android commit whose Kotlin engine emitted the results."""
    if args.kotlin_sha:
        return str(args.kotlin_sha)
    if args.strict:
        raise ProvenanceError("--strict requires engine provenance: pass --kotlin-sha")
    return UNAVAILABLE


def resolve_contract_sha(args: argparse.Namespace) -> str:
    """Contract pin revision: ``--contract-sha`` wins, then the pin file, then unavailable."""
    if args.contract_sha:
        return str(args.contract_sha)
    if args.contract_pin is not None:
        return read_contract_pin(args.contract_pin)
    if args.strict:
        raise ProvenanceError(
            "--strict requires contract provenance: pass --contract-sha or --contract-pin"
        )
    return UNAVAILABLE


def _listing(ids: Sequence[str]) -> str:
    return ", ".join(f"`{sid}`" for sid in ids) if ids else "(none)"


def main(argv: Optional[Sequence[str]] = None) -> int:
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
                         "contract pin revision (unreadable/invalid/missing source_commit is an "
                         "error, exit 2)")
    ap.add_argument("--contract-sha", default=None,
                    help="contract source_commit SHA (overrides --contract-pin)")
    ap.add_argument("--strict", action="store_true",
                    help="require complete provenance (--kotlin-sha plus --contract-sha or a "
                         "readable --contract-pin); exit 2 instead of reporting 'unavailable'")
    args = ap.parse_args(argv)

    try:
        kotlin_sha = resolve_kotlin_sha(args)
        contract_pin_sha = resolve_contract_sha(args)
    except ProvenanceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return PROVENANCE_EXIT

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

    # Corpus skew: which scenario ids only one engine emitted. Reported (it discloses cross-repo
    # coupling — a Ledger fixture newer than the pinned Android SHA), but never tolerated: a
    # scenario missing from either engine is already MISSING above and fails the run.
    python_ids = scenario_ids(args.python_dir)
    kotlin_ids = scenario_ids(args.kotlin_dir)
    only_python = sorted(set(python_ids) - set(kotlin_ids))
    only_kotlin = sorted(set(kotlin_ids) - set(python_ids))
    if only_python or only_kotlin:
        print(
            f"warning: corpus skew — python-only={len(only_python)} kotlin-only={len(only_kotlin)}; "
            "the missing scenarios fail below by design. Bump ANDROID_PIN_SHA together with the "
            "vendored contract-pin.json (see the workflow header) to resynchronise the corpora.",
            file=sys.stderr,
        )

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
        "## Corpus skew",
        "",
        "Reported only, never tolerated: a scenario emitted by one engine and not the other is "
        "already MISSING above and fails the run. Skew means the pinned Android commit predates a "
        "Ledger fixture change; bump `ANDROID_PIN_SHA` and re-vendor `contract-pin.json` together.",
        "",
        f"- in Python results only ({len(only_python)}): {_listing(only_python)}",
        f"- in Kotlin results only ({len(only_kotlin)}): {_listing(only_kotlin)}",
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
