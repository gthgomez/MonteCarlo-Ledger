from monte_carlo_ledger.cli import *  # noqa: F401,F403
from monte_carlo_ledger.cli import main as run_main
from monte_carlo_ledger.risk import (
    generate_scenario_timeline,  # noqa: F401
    simulate_scenario,  # noqa: F401
)

if __name__ == "__main__":
    try:
        run_main()
    except KeyboardInterrupt:
        raise SystemExit(0)
