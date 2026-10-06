#!/usr/bin/env python3
"""Run the golden corpus through the Python contract engine and emit canonical JSON.

Optional --freeze writes generated risk blocks back into pending-generation fixtures.
This tool contains no financial logic of its own; it delegates entirely to
monte_carlo_ledger.contract.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from monte_carlo_ledger.contract import run_scenario_safe  # noqa: E402


def fixture_files(root: Path) -> List[Path]:
    return sorted(root.glob("**/*.json"))


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Python contract conformance runner")
    parser.add_argument("--fixtures", type=Path, default=Path("fixtures"))
    parser.add_argument("--out", type=Path, default=None, help="write one result JSON per fixture")
    parser.add_argument("--freeze", action="store_true", help="freeze pending stochastic expected blocks")
    parser.add_argument("--refreeze", action="store_true", help="overwrite expected in simulation fixtures")
    args = parser.parse_args(argv)

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    frozen, pending, failed = [], [], []
    for path in fixture_files(args.fixtures):
        doc: Dict[str, Any] = json.loads(path.read_text())
        scenario = doc.get("scenario", doc)
        status = doc.get("expected_status", "frozen")
        result = run_scenario_safe(scenario)

        if args.out:
            (args.out / f"{scenario.get('scenario_id', path.stem)}.json").write_text(
                json.dumps(result, indent=2) + "\n"
            )

        if "error" not in result and (
            status == "pending-generation"
            or (args.refreeze and "simulation" in scenario)
        ):
            if args.freeze or args.refreeze:
                doc["expected"] = result
                doc["expected_status"] = "frozen"
                path.write_text(json.dumps(doc, indent=2) + "\n")
                frozen.append(scenario["scenario_id"])
            else:
                pending.append(scenario["scenario_id"])
        elif "error" in result and not (isinstance(doc.get("expected"), dict) and doc["expected"].get("error") == "SCHEMA_INVALID"):
            failed.append((scenario.get("scenario_id"), result["error"]))

    print(f"frozen={len(frozen)} pending={len(pending)} errors={len(failed)}")
    for name in frozen:
        print(f"  froze {name}")
    for name in pending:
        print(f"  pending {name}")
    for name, code in failed:
        print(f"  ERROR {name}: {code}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
