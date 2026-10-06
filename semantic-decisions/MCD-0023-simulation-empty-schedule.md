# MCD-0023 — Simulation is defined for any scenario; surprises do not depend on scheduled events

- **Status:** accepted
- **Contract:** 1.0 (simulation)
- **Audit ref:** MC-06b flagged product decision
- **Question:** If a scenario has no scheduled events or recurrences, does the Monte Carlo simulation
  still generate surprise expenses, or is simulation empty / 0% risk?
- **Options:** A. surprises depend only on `horizon_days` and the surprise parameters; B. surprises
  are generated only when the base timeline is non-empty; C. simulation is undefined for an empty
  schedule.
- **Decision:** A. The simulation procedure in `simulation.md` is unconditional. With no base events,
  the per-run random walk is the (constant) starting balance plus any surprise expenses. The engine
  reports the true distribution.
- **Reason:** A surprise expense is "an unexpected expense" — whether the user has entered scheduled
  bills is irrelevant to whether one can occur. Making surprise generation conditional on schedule
  data would mean two scenarios with identical balances and horizons produce different risk solely
  because of an unrelated bookkeeping choice. Android had silently set `simulation = null` when
  there were no events, which fabricated a 0% risk the engine would not report; that is removed
  (product UX for an empty ledger, if desired, must be an explicit "not enough information" state,
  not a fake zero).
- **Affected fixtures:** `stochastic/no-events-surprises`.
- **Introduced in:** contract 1.0 (clarification; the procedure was already unconditional — this
  records it explicitly).
