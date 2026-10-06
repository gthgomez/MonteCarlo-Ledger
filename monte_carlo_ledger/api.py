from contextlib import asynccontextmanager
from datetime import date
from typing import Optional

from fastapi import FastAPI, HTTPException, Query

from . import db_manager, decisions
from .contract import run_scenario
from .scenario import build_scenario


@asynccontextmanager
async def lifespan(_: FastAPI):
    db_manager.init_db()
    yield


app = FastAPI(
    title="Monte Carlo Budget API",
    description=(
        "Local-only API over the canonical MonteCarlo contract engine. "
        "All financial conclusions are produced by the contract engine."
    ),
    version="2.0.0",
    lifespan=lifespan,
)


def _require_sync() -> None:
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        raise HTTPException(
            status_code=409,
            detail=f"Ledger desync detected. Stored: {stored}, Ledger: {ledger}. Please reconcile via CLI.",
        )


def _boundary_as_of(as_of: Optional[str]) -> str:
    """The core never reads a clock; the HTTP boundary may default to today."""
    return as_of or date.today().isoformat()


# NOTE: Local use only (127.0.0.1). No authentication. Do not expose to a network.
@app.get("/safe-to-spend")
def get_safe_to_spend(
    days_ahead: int = Query(30, ge=1, le=365),
    as_of: Optional[str] = None,
    quantile_num: int = Query(1, ge=1),
    quantile_den: int = Query(10, ge=1),
    reserve_cents: int = Query(0, ge=0),
):
    """Quantile-based safe-to-spend over the given horizon (MCD-0008)."""
    _require_sync()
    effective_as_of = _boundary_as_of(as_of)
    result = run_scenario(build_scenario(
        effective_as_of,
        days_ahead,
        include_simulation={
            "runs": 500,
            "seed": 42,
            "quantile_num": quantile_num,
            "quantile_den": quantile_den,
            "reserve_cents": reserve_cents,
        },
        read_only=True,
    ))
    risk = result["risk"]
    return {
        "safe_spend_cents": risk["safe_to_spend_cents"],
        "projected_low_point_cents": risk["projected_low_point_cents"],
        "days_ahead": days_ahead,
        "as_of": effective_as_of,
    }


@app.get("/v1/forecast")
def v1_forecast(
    as_of: str = Query(...),
    horizon_days: int = Query(90, ge=0, le=3650),
):
    return decisions.forecast(as_of, horizon_days)


@app.get("/v1/risk")
def v1_risk(
    as_of: str = Query(...),
    horizon_days: int = Query(90, ge=0, le=3650),
    seed: int = Query(42, ge=0),
    runs: int = Query(500, ge=1),
):
    return decisions.risk(as_of, horizon_days, {"seed": seed, "runs": runs})


@app.get("/v1/safe-to-spend")
def v1_safe_to_spend(
    as_of: str = Query(...),
    horizon_days: int = Query(90, ge=0, le=3650),
    seed: int = Query(42, ge=0),
    runs: int = Query(500, ge=1),
    quantile_num: int = Query(1, ge=1),
    quantile_den: int = Query(10, ge=1),
    reserve_cents: int = Query(0, ge=0),
):
    return decisions.risk(as_of, horizon_days, {
        "seed": seed,
        "runs": runs,
        "quantile_num": quantile_num,
        "quantile_den": quantile_den,
        "reserve_cents": reserve_cents,
    })


@app.get("/v1/overdraft")
def v1_overdraft(
    as_of: str = Query(...),
    horizon_days: int = Query(90, ge=0, le=3650),
    seed: int = Query(42, ge=0),
    runs: int = Query(500, ge=1),
):
    return decisions.overdraft_risk(as_of, horizon_days, {"seed": seed, "runs": runs})


@app.get("/v1/simulate-purchase")
def v1_simulate_purchase(
    amount_cents: int = Query(..., ge=1),
    purchase_date: str = Query(...),
    as_of: str = Query(...),
    horizon_days: int = Query(90, ge=0, le=3650),
    seed: int = Query(42, ge=0),
    runs: int = Query(500, ge=1),
):
    return decisions.simulate_purchase(
        amount_cents, purchase_date, as_of, horizon_days, {"seed": seed, "runs": runs}
    )
