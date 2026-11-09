"""stdio MCP server — read-only binding to ``monte_carlo_ledger.decisions``.

See ``docs/MCP_READINESS.md``. No ledger writes, sync, or invented figures.
"""

from __future__ import annotations

from typing import Any, Dict, List

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from . import db_manager, decisions
from .contract import ContractError

server = MCPServer(
    "monte-carlo-ledger",
    instructions=(
        "MonteCarlo Ledger read-only financial tools. Money is integer USD cents; "
        "probabilities are parts-per-million. Every decision result carries ledger "
        "provenance (as_of, balance_consistency, contract_version). Do not treat "
        "stochastic outputs as guarantees."
    ),
)


def _call(fn, **kwargs: Any) -> Dict[str, Any]:
    try:
        return fn(**kwargs)
    except ContractError as exc:
        raise ToolError(f"{exc.code}: {exc}") from exc


@server.tool(name="get_engine_capabilities", description="Contract version, bounds, and supported read-only operations.")
def get_engine_capabilities() -> Dict[str, Any]:
    caps = decisions.engine_capabilities()
    caps["writes"] = {"allowed": False}
    return caps


@server.tool(name="get_financial_snapshot", description="Aggregated balances, reconciliation, and freshness (no transaction narratives).")
def get_financial_snapshot() -> Dict[str, Any]:
    return decisions.financial_snapshot()


@server.tool(name="forecast_cash_flow", description="Deterministic cash-flow forecast for the local ledger.")
def forecast_cash_flow(as_of: str, horizon_days: int = decisions.DEFAULT_HORIZON_DAYS) -> Dict[str, Any]:
    return _call(decisions.forecast, as_of=as_of, horizon_days=horizon_days)


@server.tool(name="estimate_overdraft_risk", description="Monte Carlo overdraft summary with forecast and risk blocks.")
def estimate_overdraft_risk(
    as_of: str,
    horizon_days: int = decisions.DEFAULT_HORIZON_DAYS,
    runs: int = decisions.DEFAULT_SIM["runs"],
    seed: int = decisions.DEFAULT_SIM["seed"],
    reserve_cents: int = 0,
) -> Dict[str, Any]:
    sim = {"runs": runs, "seed": seed, "reserve_cents": reserve_cents}
    return _call(decisions.overdraft_risk, as_of=as_of, horizon_days=horizon_days, sim=sim)


@server.tool(name="get_spending_buffer", description="Conservative safe-to-spend (quantile trough minus reserve).")
def get_spending_buffer(
    as_of: str,
    horizon_days: int = decisions.DEFAULT_HORIZON_DAYS,
    runs: int = decisions.DEFAULT_SIM["runs"],
    seed: int = decisions.DEFAULT_SIM["seed"],
    reserve_cents: int = 0,
) -> Dict[str, Any]:
    sim = {"runs": runs, "seed": seed, "reserve_cents": reserve_cents}
    result = _call(decisions.risk, as_of=as_of, horizon_days=horizon_days, sim=sim)
    return {
        "as_of": as_of,
        "horizon_days": horizon_days,
        "safe_to_spend_cents": result["risk"]["safe_to_spend_cents"],
        "reserve_cents": reserve_cents,
        "basis": "p10 minimum balance minus reserve (contract MCD-0008)",
        "ledger": result["ledger"],
        "risk": result["risk"],
    }


@server.tool(name="simulate_purchase", description="Hypothetical purchase vs baseline; read-only ledger.")
def simulate_purchase(
    amount_cents: int,
    purchase_date: str,
    as_of: str,
    horizon_days: int = decisions.DEFAULT_HORIZON_DAYS,
    runs: int = decisions.DEFAULT_SIM["runs"],
    seed: int = decisions.DEFAULT_SIM["seed"],
    reserve_cents: int = 0,
) -> Dict[str, Any]:
    return _call(
        decisions.simulate_purchase,
        amount_cents=amount_cents,
        purchase_date=purchase_date,
        as_of=as_of,
        horizon_days=horizon_days,
        sim={"runs": runs, "seed": seed, "reserve_cents": reserve_cents},
    )


@server.tool(name="simulate_paycheck_delay", description="Hypothetical paycheck delay vs baseline.")
def simulate_paycheck_delay(
    delay_days: int,
    as_of: str,
    horizon_days: int = decisions.DEFAULT_HORIZON_DAYS,
    runs: int = decisions.DEFAULT_SIM["runs"],
    seed: int = decisions.DEFAULT_SIM["seed"],
    reserve_cents: int = 0,
) -> Dict[str, Any]:
    return _call(
        decisions.simulate_paycheck_delay,
        delay_days=delay_days,
        as_of=as_of,
        horizon_days=horizon_days,
        sim={"runs": runs, "seed": seed, "reserve_cents": reserve_cents},
    )


@server.tool(name="compare_debt_payoff_strategies", description="Snowball vs avalanche amortization (not injected into cash-flow forecast).")
def compare_debt_payoff_strategies(
    liabilities: List[Dict[str, Any]],
    as_of: str,
    extra_monthly_payment_cents: int = 0,
) -> Dict[str, Any]:
    return _call(
        decisions.compare_debt_strategies,
        liabilities=liabilities,
        as_of=as_of,
        extra_monthly_payment_cents=extra_monthly_payment_cents,
    )


@server.tool(name="validate_scenario", description="Fail-closed schema and engine validation for a canonical scenario document.")
def validate_scenario(scenario: Dict[str, Any]) -> Dict[str, Any]:
    return decisions.validate_scenario(scenario)


def main() -> None:
    db_manager.init_db()
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
