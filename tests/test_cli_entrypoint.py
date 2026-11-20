from __future__ import annotations

import sys

import pytest

from monte_carlo_ledger import cli


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
