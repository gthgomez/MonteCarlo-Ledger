"""Cross-engine comparer: provenance + exit-code contract (WS7 independent-review fixes).

`pyrightconfig.json` excludes `tests/` and `pyproject.toml` excludes it from ruff, so this file is
validated by pytest alone; behaviour under test lives in `tools/conformance/cross_engine.py`.

The comparer stays dumb: these tests only pin (a) where provenance is read from, (b) that a
requested-but-unresolvable provenance source is a loud non-zero error instead of a quiet
"unavailable", and (c) that provenance never changes the comparison verdict.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

TOOLS = Path(__file__).resolve().parents[1] / "tools" / "conformance"
sys.path.insert(0, str(TOOLS))

import cross_engine  # noqa: E402  (module lives outside the importable package)

KOTLIN_SHA = "6cadf72c50ca6466f342a7263bacacf9145b28d3"
PIN_COMMIT = "c1dea8cd73e133d2a4adc5940d817f0147366a60"


def _write_json(path: Path, payload: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))
    return path


@pytest.fixture()
def workspace(tmp_path: Path) -> Dict[str, Path]:
    """Minimal two-engine layout: one frozen scenario both engines reproduce."""
    fixtures = tmp_path / "fixtures"
    python_dir = tmp_path / "python-results"
    kotlin_dir = tmp_path / "kotlin-results"
    _write_json(
        fixtures / "alpha.json",
        {"scenario": {"scenario_id": "alpha"}, "expected": {"value": 1}},
    )
    _write_json(python_dir / "alpha.json", {"value": 1})
    _write_json(kotlin_dir / "alpha.json", {"value": 1})
    return {
        "tmp": tmp_path,
        "fixtures": fixtures,
        "python": python_dir,
        "kotlin": kotlin_dir,
        "report": tmp_path / "report.md",
    }


def _run(workspace: Dict[str, Path], *extra: str) -> int:
    argv: List[str] = [
        "--fixtures",
        str(workspace["fixtures"]),
        "--python-dir",
        str(workspace["python"]),
        "--kotlin-dir",
        str(workspace["kotlin"]),
        *extra,
    ]
    return cross_engine.main(argv)


def _pin(workspace: Dict[str, Path], **overrides: Any) -> Path:
    payload: Dict[str, Any] = {
        "source_repo": "https://github.com/gthgomez/Monte-Carlo-Ledger",
        "source_commit": PIN_COMMIT,
        "contract_version": "2.0",
    }
    payload.update(overrides)
    return _write_json(workspace["tmp"] / "contract-pin.json", payload)


# ---------------------------------------------------------------------------
# Provenance is surfaced, not invented
# ---------------------------------------------------------------------------


def test_provenance_is_surfaced_from_a_readable_pin(workspace: Dict[str, Path]) -> None:
    rc = _run(
        workspace,
        "--kotlin-sha",
        KOTLIN_SHA,
        "--contract-pin",
        str(_pin(workspace)),
        "--strict",
        "--report",
        str(workspace["report"]),
    )
    assert rc == 0
    text = workspace["report"].read_text()
    assert f"- Kotlin (Android) emitting commit: `{KOTLIN_SHA}`" in text
    assert f"- Contract pin (`contract-pin.json` source_commit): `{PIN_COMMIT}`" in text
    assert cross_engine.UNAVAILABLE not in text


def test_contract_sha_takes_precedence_over_pin(workspace: Dict[str, Path]) -> None:
    pin = _pin(workspace, source_commit="aaaa" * 10)
    rc = _run(
        workspace,
        "--contract-pin",
        str(pin),
        "--contract-sha",
        "bbbb" * 10,
        "--report",
        str(workspace["report"]),
    )
    assert rc == 0
    text = workspace["report"].read_text()
    assert f"- Contract pin (`contract-pin.json` source_commit): `{'bbbb' * 10}`" in text
    assert "aaaa" * 10 not in text


def test_pin_is_optional_without_strict(workspace: Dict[str, Path]) -> None:
    """Backwards compatibility: no provenance args at all is still a comparison, not an error."""
    rc = _run(workspace, "--report", str(workspace["report"]))
    assert rc == 0
    assert f"`{cross_engine.UNAVAILABLE}`" in workspace["report"].read_text()


# ---------------------------------------------------------------------------
# A requested provenance source that cannot be resolved is a loud error (never exit 0)
# ---------------------------------------------------------------------------


def test_missing_pin_file_is_a_clear_error(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    missing = workspace["tmp"] / "nope.json"
    rc = _run(workspace, "--contract-pin", str(missing), "--report", str(workspace["report"]))
    assert rc == cross_engine.PROVENANCE_EXIT
    err = capsys.readouterr().err
    assert "error:" in err
    assert str(missing) in err
    assert "could not be read" in err
    assert "Traceback" not in err
    # No report: provenance failure must not leave a green-looking artefact behind.
    assert not workspace["report"].exists()


def test_unreadable_pin_path_is_a_clear_error(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    """A directory (or any OSError) must not escape as a traceback."""
    directory = workspace["tmp"] / "pin-dir"
    directory.mkdir()
    rc = _run(workspace, "--contract-pin", str(directory))
    assert rc == cross_engine.PROVENANCE_EXIT
    assert "could not be read" in capsys.readouterr().err


def test_malformed_pin_json_is_a_clear_error(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    bad = workspace["tmp"] / "contract-pin.json"
    bad.write_text('{"source_commit": "c1dea8cd",')
    rc = _run(workspace, "--contract-pin", str(bad))
    assert rc == cross_engine.PROVENANCE_EXIT
    err = capsys.readouterr().err
    assert "not valid JSON" in err
    assert "Traceback" not in err


def test_pin_without_source_commit_is_a_clear_error(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    # No --strict needed: an explicitly supplied pin that carries no source_commit is an error on
    # its own, otherwise the report would claim "unavailable" beside a green comparison.
    rc = _run(workspace, "--contract-pin", str(_pin(workspace, source_commit="")))
    assert rc == cross_engine.PROVENANCE_EXIT
    err = capsys.readouterr().err
    assert "source_commit" in err
    assert cross_engine.UNAVAILABLE in err


def test_pin_with_non_string_source_commit_is_a_clear_error(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    rc = _run(workspace, "--contract-pin", str(_pin(workspace, source_commit=None)))
    assert rc == cross_engine.PROVENANCE_EXIT
    assert "source_commit" in capsys.readouterr().err


def test_pin_that_is_not_an_object_is_a_clear_error(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    not_an_object = _write_json(workspace["tmp"] / "contract-pin.json", [PIN_COMMIT])
    rc = _run(workspace, "--contract-pin", str(not_an_object))
    assert rc == cross_engine.PROVENANCE_EXIT
    assert "must be a JSON object" in capsys.readouterr().err


def test_strict_requires_engine_provenance(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    rc = _run(workspace, "--strict", "--contract-pin", str(_pin(workspace)))
    assert rc == cross_engine.PROVENANCE_EXIT
    assert "--kotlin-sha" in capsys.readouterr().err


def test_strict_requires_contract_provenance(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    rc = _run(workspace, "--strict", "--kotlin-sha", KOTLIN_SHA)
    assert rc == cross_engine.PROVENANCE_EXIT
    assert "--contract-pin" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Provenance never changes the verdict
# ---------------------------------------------------------------------------


def test_exit_code_unchanged_when_provenance_args_are_added(workspace: Dict[str, Path]) -> None:
    bare = _run(workspace, "--report", str(workspace["report"]))
    with_provenance = _run(
        workspace,
        "--kotlin-sha",
        KOTLIN_SHA,
        "--contract-pin",
        str(_pin(workspace)),
        "--strict",
        "--report",
        str(workspace["report"]),
    )
    assert bare == with_provenance == 0
    assert "| alpha | PASS |" in workspace["report"].read_text()


def test_divergence_still_exits_one_with_provenance(workspace: Dict[str, Path]) -> None:
    _write_json(workspace["python"] / "alpha.json", {"value": 2})
    bare = _run(workspace)
    with_provenance = _run(
        workspace,
        "--kotlin-sha",
        KOTLIN_SHA,
        "--contract-pin",
        str(_pin(workspace)),
        "--strict",
        "--report",
        str(workspace["report"]),
    )
    assert bare == with_provenance == 1
    assert "| alpha | FAIL |" in workspace["report"].read_text()


# ---------------------------------------------------------------------------
# Corpus skew: disclosed, still fatal
# ---------------------------------------------------------------------------


def test_corpus_skew_is_reported_and_still_fails(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    (workspace["kotlin"] / "alpha.json").unlink()
    rc = _run(
        workspace,
        "--kotlin-sha",
        KOTLIN_SHA,
        "--report",
        str(workspace["report"]),
    )
    assert rc == 1
    text = workspace["report"].read_text()
    assert "## Corpus skew" in text
    assert "- in Python results only (1): `alpha`" in text
    assert "| alpha | MISSING |" in text
    assert "corpus skew" in capsys.readouterr().err


def test_no_skew_is_quiet(
    workspace: Dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    assert _run(workspace, "--report", str(workspace["report"])) == 0
    text = workspace["report"].read_text()
    assert "- in Python results only (0): (none)" in text
    assert "corpus skew" not in capsys.readouterr().err
