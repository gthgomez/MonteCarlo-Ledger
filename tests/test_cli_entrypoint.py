from __future__ import annotations

import sys

import pytest

from monte_carlo_ledger import cli, db_manager


def test_global_help_does_not_initialize_or_create_the_ledger(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["monte-carlo-ledger", "--help"])

    def unexpected_database_initialization():
        pytest.fail("--help must not initialize a database")

    monkeypatch.setattr(cli.db_manager, "init_db", unexpected_database_initialization)

    with pytest.raises(SystemExit) as exit_info:
        cli.main()

    assert exit_info.value.code == 0
    output = capsys.readouterr().out
    assert "usage: monte-carlo-ledger" in output
    assert "forecast" in output
    assert "simulate-paycheck-delay" in output


def test_forecast_does_not_create_missing_ledger(tmp_path, monkeypatch, capsys):
    from monte_carlo_ledger import commands

    path = tmp_path / "missing.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(path))
    assert commands.main(["forecast", "--as-of", "2027-01-01"]) != 0
    assert not path.exists()
    assert "No ledger database" in capsys.readouterr().err



def test_unknown_command_cannot_fall_through_to_ledger_creation(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["monte-carlo-ledger", "forecats"])

    def unexpected_database_initialization():
        pytest.fail("Invalid commands must not initialize a database")

    monkeypatch.setattr(cli.db_manager, "init_db", unexpected_database_initialization)
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 2
    assert "invalid choice" in capsys.readouterr().err
