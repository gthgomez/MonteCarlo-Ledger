from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query

from . import db_manager, timeline_service
from .forecasting import calculate_safe_spend


@asynccontextmanager
async def lifespan(_: FastAPI):
    db_manager.init_db()
    yield


app = FastAPI(
    title="Monte Carlo Budget API",
    description="API layer for the Monte Carlo Budget Simulator exposing deterministic safe spend metrics.",
    version="1.0.0",
    lifespan=lifespan,
)

# NOTE: This endpoint is intended for local use only (127.0.0.1).
# It has no authentication. Do not expose this API to an external network.
@app.get("/safe-to-spend")
def get_safe_to_spend(days_ahead: int = Query(30, ge=1, le=365)):
    """
    Calculates the maximum safe spend amount before the next income event
    without triggering a negative balance window.
    """
    # 0. Validate consistency before serving data
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        raise HTTPException(
            status_code=409, 
            detail=f"Ledger desync detected. Stored: {stored}, Ledger: {ledger}. Please reconcile via CLI."
        )

    # 1. Get current cached balance
    balance_cents = stored
    
    # 2. Generate timeline of deterministic events
    timeline = timeline_service.build_financial_timeline(days_ahead=days_ahead, read_only=True)
    
    # 3. Process running balance simulation to find minima
    safe_spend_cents = calculate_safe_spend(balance_cents, timeline)
    
    return {
        "safe_spend_cents": safe_spend_cents,
        "days_ahead": days_ahead
    }
