# Montecarlo Budget Sim Startup And Scope

## Required Context

1. `PROJECT_CONTEXT.md`
2. `AGENTS.md`

## Repo Map

- `main.py` - CLI and orchestration shell
- `db_manager.py` - SQLite persistence and accounting rules
- `budget_engine.py` - pure financial logic and money helpers
- `timeline_service.py` - future event and forecast timeline logic
- `api.py` - FastAPI surface
- `schema.sql` - database schema and migration base

## Scope Discipline

- Treat provided data and file paths as hypotheses and verify them first.
- Do not redesign accounting flow when a local logic fix will solve the issue.
- Keep DB, timeline, and API behavior aligned.
