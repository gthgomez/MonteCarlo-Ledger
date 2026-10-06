# Timeline — Contract 1.0

## Explicit `as_of`

- Every forecast and simulation takes a required **`as_of`** value: a calendar date
  (`YYYY-MM-DD`), with no time component and no timezone.
- The financial core must **not** read a wall clock. `datetime.now()`, `LocalDate.now()`,
  `System.currentTimeMillis()`, `Instant.now()`, and equivalents are forbidden in any function that
  produces a contract-observable result. The current date is an input.
- Omitting `as_of` is an error, code `MISSING_AS_OF`.

Rationale: audit D-01. Python's seeded Monte Carlo was not reproducible across days because
`risk.py:33` read `datetime.now()`; Kotlin had a `today` seam but not an `as_of` concept.

## Horizon boundary

- `horizon_days` is a non-negative integer. Negative is `INVALID_HORIZON`.
- The forecast window is **half-open**:

  ```text
  window = [ as_of, as_of + horizon_days )
  ```

  An event is in-window iff `as_of <= event.date < as_of + horizon_days`.
- Consequence: `horizon_days = 0` yields an empty window (only `as_of` balance is observable);
  `horizon_days = 30` spans exactly 30 calendar dates, `as_of … as_of+29`.
- An event dated exactly `as_of` **is** in-window. An event dated exactly `as_of + horizon_days`
  is **not**.

This resolves audit D-02 (Python was end-inclusive, Kotlin half-open). Kotlin's convention is
adopted.

## Event ordering

Events are totally ordered by the tuple:

```text
(date, sequence, input_index)
```

- `date` — ascending calendar date.
- `sequence` — optional integer supplied by the scenario. When absent, the default is
  **`0` for `income`, `1` for `expense` and `adjustment`**. Explicit `sequence` overrides the
  default, so a caller can force a specific same-day order.
- `input_index` — the position of the event in the scenario's `events` array (stable tiebreak so the
  order is always total).

Consequence (default behavior): on a day with both a paycheck and a bill, income is applied before
the bill. This is the shared behavior of both engines (audit D-03). The contract does not claim this
models intraday reality; it is a fixed deterministic convention. (An implementation may separately
surface an intraday-low warning, but that is not part of this contract.)

## Recurrence definitions (scenario input)

A canonical scenario may declare `recurrences` in addition to explicit `events`. A recurrence is a
template that **expands into events** before forecasting:

```text
{ "id", "name", "type": income|expense, "amount_cents",
  "frequency", "start_date", "anchor_day"?, "end_date"?, "expected_amount_cents"? }
```

Expansion procedure (normative):

1. Generate occurrences from `start_date` forward by the frequency rule below, in ascending order,
   stopping once the occurrence date is `>= as_of + horizon_days` (or past `end_date`).
2. Keep only occurrences with `as_of <= date < as_of + horizon_days`.
3. If `type == income` and `expected_amount_cents` is present, the **first kept occurrence** uses
   `expected_amount_cents`; all others use `amount_cents`.
4. Expanded income occurrences default to `sequence = 0`; expanded expenses to `sequence = 1`.
5. Occurrences before `as_of` are not emitted (they are overdue state; see below).

`start_date` is the first possible occurrence. A recurrence must always make forward progress.

## Recurrence rules

The contract fixes the produced dates.

- **Weekly** — `+7` days. **Biweekly** — `+14` days.
- **Monthly / bimonthly / quarterly** — advance by 1 / 2 / 3 calendar months, then place the
  occurrence on the **anchor day of month**, clamped to the last valid day of the target month. The
  anchor is preserved across clamped months: the sequence from Jan 31 with anchor 31 is
  Jan 31 → Feb 28 → Mar 31 (not Mar 28).
- **Annually** — `+1` year, same month/clamp rule. Feb 29 → Feb 28 in a common year, and returns to
  Feb 29 in the next leap year.
- **Semimonthly** — two occurrences per month: `(1st, 15th)` or `(15th, last day)`, selected by the
  anchor.
- A recurrence must always advance; an implementation that cannot advance must stop and report,
  never loop.
- An occurrence that is **clamped** or **user-modified** is still a single occurrence; it must not be
  double-emitted.

## Past-due events

Contract 1.0 separates overdue state from future projection:

- The forecast window contains **only** events dated `>= as_of`. Events dated before `as_of` are not
  silently projected onto `as_of` and are not merged into the forecast.
- Implementations may compute an **overdue list** (unpaid obligations dated before `as_of`) for their
  UI, but that list is not part of the canonical forecast/result and must not change forecast
  numbers.
- If a scenario intentionally wants a past event to affect the projection, it must set the event's
  date explicitly (or the scenario must include its balance effect via `starting_balance_cents`).

This resolves audit D-14: Python's 30-day bill lookback and Kotlin's emit-all-past-on-start were two
different implicit models. Both move to an explicit overdue concept.

## Expected amount

- A recurring income definition may carry `expected_amount_cents`.
- It applies to **exactly the first occurrence whose date is `>= as_of`**, and to no other
  occurrence. Subsequent occurrences use the base `amount_cents`.
- If no such occurrence exists in the window, the expected amount is not observable and does not
  error. This resolves audit D-17 (Python dropped it when the first payday preceded `as_of`).
