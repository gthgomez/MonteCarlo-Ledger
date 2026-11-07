"""HTTP boundary: consistent resource limits and read-only behaviour."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from monte_carlo_ledger import api, db_manager, decisions

AS_OF = "2026-10-01"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    with TestClient(api.app) as test_client:
        db_manager.add_transaction(
            500_000, "System", "Opening", t_type="Adjustment", date_str="2026-09-01"
        )
        db_manager.add_income_source("Pay", 220_000, "Bi-weekly", "2026-09-25")
        yield test_client


def _db_dump():
    with db_manager.get_db_connection() as conn:
        return {
            table: [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY 1")]
            for table in ("income", "payments", "transactions", "bill_occurrences", "settings")
        }


def test_v1_endpoints_return_provenance(client):
    response = client.get("/v1/forecast", params={"as_of": AS_OF})
    assert response.status_code == 200, response.text
    assert "ledger" in response.json()
    assert response.json()["ledger"]["read_only"] is True


def test_safe_to_spend_endpoint_enforces_the_same_run_bound(client):
    response = client.get(
        "/v1/safe-to-spend",
        params={"as_of": AS_OF, "runs": decisions.MAX_RUNS + 1},
    )
    assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    "path,params",
    [
        ("/v1/forecast", {"as_of": AS_OF, "horizon_days": decisions.MAX_HORIZON_DAYS + 1}),
        ("/v1/risk", {"as_of": AS_OF, "runs": decisions.MAX_RUNS + 1}),
        ("/v1/overdraft", {"as_of": AS_OF, "runs": decisions.MAX_RUNS + 1}),
        (
            "/v1/safe-to-spend",
            {"as_of": AS_OF, "quantile_num": 11, "quantile_den": 10},
        ),
        (
            "/v1/safe-to-spend",
            {"as_of": AS_OF, "quantile_den": decisions.MAX_QUANTILE + 1},
        ),
        (
            "/v1/safe-to-spend",
            {"as_of": AS_OF, "reserve_cents": decisions.MAX_RESERVE_CENTS + 1},
        ),
        (
            "/v1/simulate-purchase",
            {
                "amount_cents": decisions.MAX_AMOUNT_CENTS + 1,
                "purchase_date": "2026-10-05",
                "as_of": AS_OF,
            },
        ),
        ("/v1/risk", {"as_of": "not-a-date"}),
    ],
)
def test_out_of_bounds_requests_are_rejected(client, path, params):
    response = client.get(path, params=params)
    assert response.status_code == 422, response.text
    body = response.json()
    # ContractError -> {"error": code}; request-validation -> {"detail": [...]}.
    assert "error" in body or "detail" in body


def test_read_only_requests_do_not_mutate_the_ledger(client):
    before = _db_dump()
    accepted = [
        ("/v1/forecast", {"as_of": AS_OF}),
        ("/v1/risk", {"as_of": AS_OF, "runs": 25, "seed": 3}),
        ("/v1/overdraft", {"as_of": AS_OF, "runs": 25, "seed": 3}),
        ("/v1/safe-to-spend", {"as_of": AS_OF, "runs": 25, "seed": 3}),
        (
            "/v1/simulate-purchase",
            {
                "amount_cents": 65_000,
                "purchase_date": "2026-10-05",
                "as_of": AS_OF,
                "runs": 25,
                "seed": 3,
            },
        ),
    ]
    for path, params in accepted:
        response = client.get(path, params=params)
        assert response.status_code == 200, (path, response.text)
    assert _db_dump() == before, "read-only HTTP operations must not mutate the ledger"
