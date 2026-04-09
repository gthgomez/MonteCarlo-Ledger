# Montecarlo Budget Sim Context Loading And Contract Safety

Read this rule before changing persistence, API shape, or financial behavior.

## Smallest Correct Context

- Load only the rules needed for the task.
- Use a skill only when the workflow truly repeats.
- Do not reread every repro artifact by default; start from `PROJECT_CONTEXT.md`, then load only the relevant evidence.

## Contracts To Protect

- ledger-driven balance behavior
- transaction sign rules
- `bill_occurrences` synchronization
- timeline generation semantics
- Monte Carlo risk-engine assumptions
- API request and response behavior in `api.py`
- SQLite schema and migration expectations in `schema.sql`

## Change Classification

- `COMPATIBLE`: internal cleanup with no output or persistence contract change
- `RISKY`: changes forecast outputs, API shape, or occurrence-linking behavior
- `BREAKING`: alters money representation, weakens ledger authority, or changes persistence semantics

For `RISKY` or `BREAKING` changes, name the consumers, the test plan, and the rollback path.
