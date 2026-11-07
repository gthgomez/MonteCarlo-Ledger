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
    # API contract version, independent of the package version in pyproject.toml.
    # Bump only when the request/response shapes of these endpoints change.
    version="2.0.0",
    lifespan=lifespan,
)

from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://montecarlo-ledger.vercel.app",
        "https://montecarlo-ledger-jonathan-gomez-aguilars-projects.vercel.app",
    ],
    # The API is unauthenticated; it never needs or uses credentials.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}


class LoopbackOnlyMiddleware:
    """Runtime guard for the unauthenticated local API.

    The intended deployment binds uvicorn to 127.0.0.1 (see README); this middleware is the
    in-app backstop that refuses requests from any non-loopback client so an accidental
    0.0.0.0 bind or port forward cannot silently expose unauthenticated financial data.
    "testclient" is the Starlette TestClient peer name and exists for the test suite only.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") in ("http", "websocket"):
            client = scope.get("client") or (None, None)
            host = client[0] if client else None
            if host not in _LOOPBACK_HOSTS:
                from fastapi.responses import JSONResponse

                response = JSONResponse(
                    {"detail": "MonteCarlo-Ledger local API is loopback-only (127.0.0.1)."},
                    status_code=403,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(LoopbackOnlyMiddleware)


def _require_sync() -> None:
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        raise HTTPException(
            status_code=409,
            detail=f"Ledger desync detected. Stored: {stored}, Ledger: {ledger}. Please reconcile via CLI.",
        )


def _resolve_as_of(as_of: Optional[str]) -> str:
    """The core never reads a clock; this HTTP boundary may default to today.

    A malformed date is a 422, not a silent fallback, so automation cannot
    accidentally query the wrong window.
    """
    if as_of is None:
        return date.today().isoformat()
    try:
        return date.fromisoformat(as_of).isoformat()
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="as_of must be an ISO date (YYYY-MM-DD).",
        )


# NOTE: Local use only (127.0.0.1). No authentication. Do not expose to a network.
@app.get("/safe-to-spend")
def get_safe_to_spend(
    days_ahead: int = Query(30, ge=1, le=365),
    as_of: Optional[str] = Query(
        None, description="Simulation date, YYYY-MM-DD. Defaults to today at this boundary."
    ),
    quantile_num: int = Query(1, ge=1),
    quantile_den: int = Query(10, ge=1),
    reserve_cents: int = Query(0, ge=0),
):
    """Quantile-based safe-to-spend over the given horizon (MCD-0008)."""
    _require_sync()
    effective_as_of = _resolve_as_of(as_of)
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
    return decisions.forecast(_resolve_as_of(as_of), horizon_days)


@app.get("/v1/risk")
def v1_risk(
    as_of: str = Query(...),
    horizon_days: int = Query(90, ge=0, le=3650),
    seed: int = Query(42, ge=0),
    runs: int = Query(500, ge=1),
):
    return decisions.risk(_resolve_as_of(as_of), horizon_days, {"seed": seed, "runs": runs})


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
    return decisions.risk(_resolve_as_of(as_of), horizon_days, {
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
    return decisions.overdraft_risk(_resolve_as_of(as_of), horizon_days, {"seed": seed, "runs": runs})


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
        amount_cents, purchase_date, _resolve_as_of(as_of), horizon_days,
        {"seed": seed, "runs": runs},
    )
