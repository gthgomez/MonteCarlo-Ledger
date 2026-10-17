"""Non-interactive CLI commands with stable JSON output (MC-05).

These commands read persisted state, call the decision layer (which calls the
contract engine), and print either human text or canonical JSON. They contain no
financial math.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional

from . import db_manager, decisions

COMMANDS = {
    "forecast",
    "risk",
    "safe-to-spend",
    "simulate-purchase",
    "simulate-paycheck-delay",
    "overdraft",
    "sync",
    "export-snapshot",
}


def _format_money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.2f}"


def _emit(obj: Dict[str, Any], as_json: bool, human: Optional[List[str]] = None) -> None:
    if as_json:
        print(json.dumps(obj, indent=2, sort_keys=True))
    else:
        for line in human or []:
            print(line)
        if human is None:
            print(json.dumps(obj, indent=2, sort_keys=True))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="monte-carlo-ledger", description="MonteCarlo decision engine")
    sub = parser.add_subparsers(dest="command")

    p_forecast = sub.add_parser("forecast", help="deterministic cash-flow forecast")
    p_forecast.add_argument("--as-of", required=True)
    p_forecast.add_argument("--horizon", type=int, default=decisions.DEFAULT_HORIZON_DAYS)

    p_risk = sub.add_parser("risk", help="forecast + Monte Carlo risk block")
    p_risk.add_argument("--as-of", required=True)
    p_risk.add_argument("--horizon", type=int, default=decisions.DEFAULT_HORIZON_DAYS)
    p_risk.add_argument("--seed", type=int, default=42)
    p_risk.add_argument("--runs", type=int, default=500)

    p_safe = sub.add_parser("safe-to-spend", help="quantile-based safe-to-spend")
    p_safe.add_argument("--as-of", required=True)
    p_safe.add_argument("--horizon", type=int, default=decisions.DEFAULT_HORIZON_DAYS)
    p_safe.add_argument("--seed", type=int, default=42)
    p_safe.add_argument("--runs", type=int, default=500)
    p_safe.add_argument("--quantile-num", type=int, default=1)
    p_safe.add_argument("--quantile-den", type=int, default=10)
    p_safe.add_argument("--reserve-cents", type=int, default=0)

    p_purchase = sub.add_parser("simulate-purchase", help="compare baseline vs a one-time purchase")
    p_purchase.add_argument("amount_cents", type=int)
    p_purchase.add_argument("--date", required=True)
    p_purchase.add_argument("--as-of", required=True)
    p_purchase.add_argument("--horizon", type=int, default=decisions.DEFAULT_HORIZON_DAYS)
    p_purchase.add_argument("--seed", type=int, default=42)
    p_purchase.add_argument("--runs", type=int, default=500)

    p_delay = sub.add_parser("simulate-paycheck-delay", help="compare baseline vs a late paycheck")
    p_delay.add_argument("delay_days", type=int)
    p_delay.add_argument("--as-of", required=True)
    p_delay.add_argument("--horizon", type=int, default=decisions.DEFAULT_HORIZON_DAYS)
    p_delay.add_argument("--seed", type=int, default=42)
    p_delay.add_argument("--runs", type=int, default=500)

    p_overdraft = sub.add_parser("overdraft", help="overdraft risk summary")
    p_overdraft.add_argument("--as-of", required=True)
    p_overdraft.add_argument("--horizon", type=int, default=decisions.DEFAULT_HORIZON_DAYS)
    p_overdraft.add_argument("--seed", type=int, default=42)
    p_overdraft.add_argument("--runs", type=int, default=500)

    p_sync = sub.add_parser("sync", help="encrypted cloud vault synchronization")
    sync_sub = p_sync.add_subparsers(dest="sync_action")
    p_sync_init = sync_sub.add_parser("init", help="initialize a new cloud vault")
    p_sync_init.add_argument("vault_id")
    p_sync_init.add_argument("passphrase")
    p_sync_init.add_argument("--server", default=None)
    p_sync_push = sync_sub.add_parser("push", help="push encrypted snapshot to cloud vault")
    p_sync_push.add_argument("--server", default=None)
    p_sync_pull = sync_sub.add_parser("pull", help="pull and decrypt snapshot from cloud vault")
    p_sync_pull.add_argument("--server", default=None)

    p_snap = sub.add_parser("export-snapshot", help="export canonical ledger snapshot JSON")

    for p in (p_forecast, p_risk, p_safe, p_purchase, p_delay, p_overdraft, p_snap):
        p.add_argument("--json", action="store_true", help="emit stable canonical JSON")
    return parser


def main(argv: List[str]) -> int:
    args = _build_parser().parse_args(argv)
    if not args.command:
        return 2
    db_manager.init_db()

    if args.command == "forecast":
        result = decisions.forecast(args.as_of, args.horizon)
        f = result["forecast"]
        _emit(result, args.json, [
            f"Projected low point: {_format_money(f['minimum_balance_cents'])} on {f['minimum_balance_date']}",
            f"Ending balance:      {_format_money(f['ending_balance_cents'])}",
            f"First negative date: {f['first_negative_date'] or 'never'}",
        ])
        return 0

    if args.command == "risk":
        result = decisions.risk(args.as_of, args.horizon, {"seed": args.seed, "runs": args.runs})
        r = result["risk"]
        f = result["forecast"]
        _emit(result, args.json, [
            f"Projected low point: {_format_money(f['minimum_balance_cents'])} on {f['minimum_balance_date']}",
            f"Minimum balance P10: {_format_money(r['minimum_balance_p10_cents'])}",
            f"Overdraft chance:    {r['negative_balance_probability_ppm'] / 10000:.2f}%",
        ])
        return 0

    if args.command == "safe-to-spend":
        result = decisions.risk(args.as_of, args.horizon, {
            "seed": args.seed, "runs": args.runs,
            "quantile_num": args.quantile_num, "quantile_den": args.quantile_den,
            "reserve_cents": args.reserve_cents,
        })
        r = result["risk"]
        _emit(result, args.json, [
            f"Projected low point: {_format_money(r['projected_low_point_cents'])}",
            f"Safe to spend:       {_format_money(r['safe_to_spend_cents'])}",
        ])
        return 0

    if args.command == "simulate-purchase":
        result = decisions.simulate_purchase(
            args.amount_cents, args.date, args.as_of, args.horizon,
            {"seed": args.seed, "runs": args.runs},
        )
        change = result["change"]
        _emit(result, args.json, [
            f"Purchase:            {_format_money(-abs(args.amount_cents))} on {args.date}",
            f"Overdraft chance:    baseline {result['baseline']['risk']['negative_balance_probability_ppm']/10000:.2f}%"
            f" -> {result['with_purchase']['risk']['negative_balance_probability_ppm']/10000:.2f}%"
            f" ({change['negative_balance_probability_ppm']/10000:+.2f} pp)",
            f"Minimum P10:         {_format_money(result['baseline']['risk']['minimum_balance_p10_cents'])}"
            f" -> {_format_money(result['with_purchase']['risk']['minimum_balance_p10_cents'])}",
        ])
        return 0

    if args.command == "simulate-paycheck-delay":
        result = decisions.simulate_paycheck_delay(
            args.delay_days, args.as_of, args.horizon, {"seed": args.seed, "runs": args.runs}
        )
        change = result["change"]
        _emit(result, args.json, [
            f"Paycheck delay:      {args.delay_days} days",
            f"Minimum P10:         {_format_money(result['baseline']['risk']['minimum_balance_p10_cents'])}"
            f" -> {_format_money(result['delayed']['risk']['minimum_balance_p10_cents'])}",
            f"Overdraft change:    {change['negative_balance_probability_ppm']/10000:+.2f} pp",
        ])
        return 0

    if args.command == "overdraft":
        result = decisions.overdraft_risk(
            args.as_of, args.horizon, {"seed": args.seed, "runs": args.runs}
        )
        _emit(result, args.json, [
            f"Projected low point: {_format_money(result['projected_low_point_cents'])} on {result['projected_low_point_date']}",
            f"First negative date: {result['first_negative_date'] or 'never'}",
            f"Overdraft chance:    {result['negative_balance_probability_ppm'] / 10000:.2f}%",
            f"Safe to spend:       {_format_money(result['safe_to_spend_cents'])}",
        ])
    if args.command == "export-snapshot":
        from . import sync
        snap = sync.export_ledger_snapshot()
        _emit(snap, args.json)
        return 0

    if args.command == "sync":
        from . import sync
        if args.sync_action == "init":
            res = sync.sync_init(args.vault_id, args.passphrase, args.server or sync.DEFAULT_SERVER_URL)
            print(f"Vault initialized: {res['vault_id']} (rev {res['revision']})")
            return 0
        elif args.sync_action == "push":
            res = sync.sync_push(args.server)
            print(f"Pushed to vault: rev {res.get('revision')}")
            return 0
        elif args.sync_action == "pull":
            res = sync.sync_pull(args.server)
            print(f"Pulled from vault: restored {res['transactions_count']} transactions, balance: {_format_money(res['balance_cents'])}")
            return 0
        return 2

    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
