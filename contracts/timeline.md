# Timeline — Contract 1.1

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
3. Remove any occurrence whose `(recurrence id, date)` is listed in `occurrence_exclusions`
   (contract 1.1; see "Occurrence exclusions"). An excluded occurrence is not projected and does
   **not** consume the `expected_amount_cents` slot.
4. If `type == income` and `expected_amount_cents` is present, the **first remaining occurrence**
   (after step 3) uses `expected_amount_cents`; all others use `amount_cents`.
5. Expanded income occurrences default to `sequence = 0`; expanded expenses to `sequence = 1`.
6. Occurrences before `as_of` are not emitted (they are overdue state; see below).
7. Occurrence ordering: all expanded recurrence occurrences use an `input_index` greater than every
   explicit event's index, assigned in recurrence-array order and then ascending occurrence date.
8. Schema precedence: a scenario that omits a schema-required field (for example `as_of`) is
   `SCHEMA_INVALID`. `MISSING_AS_OF` is reserved for an `as_of` that is present but empty or
   unparseable.

`start_date` is the first possible occurrence / lower bound. A recurrence must always make forward
progress.

## Recurrence rules

The contract fixes the produced dates.

- **Weekly** — `start_date + k*7` days. **Biweekly** — `start_date + k*14` days.
- **Monthly / bimonthly / quarterly / semiannually / annually** — occurrence months are
  `start_date`'s month plus `k*1 / k*2 / k*3 / k*6 / k*12` calendar months. In each such month the
  date is `min(anchor, last_day_of_month)`, where `anchor = anchor_day` when given, otherwise
  `start_date.day`. `start_date` is a **lower bound**, not necessarily the first occurrence: the
  first occurrence is the smallest generated date `>= start_date`. The anchor is preserved across
  clamped months: Jan 31 → Feb 28 → Mar 31 (not Mar 28), and annually Feb 29 → Feb 28 in a common
  year, returning to Feb 29 in the next leap year. If `anchor_day` is earlier than `start_date.day`
  in `start_date`'s month, that first month's occurrence is dropped and the series begins the
  following month.
- **Semimonthly** — two occurrences per month: `(1st, 15th)` when `anchor < 15`, otherwise
  `(15th, last day)`. The first occurrence is the smallest pair date `>= start_date`.
- **`end_date` is inclusive**: occurrences are generated while `occurrence <= end_date`, in addition
  to the horizon bound.
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

## Occurrence exclusions (contract 1.1)

A canonical scenario may declare an optional top-level list:

```text
"occurrence_exclusions": [ { "recurrence_id": "<recurrence id>", "date": "YYYY-MM-DD" } ]
```

- An excluded `(recurrence_id, date)` pair removes that generated occurrence from the projection
  (expansion step 3). Explicit `events` are unaffected.
- `recurrence_id` must be a string and `date` an ISO date. A pair that matches no generated
  occurrence is a **no-op**, not an error.
- Matching is on the occurrence date the recurrence actually produces (after month anchoring and
  clamping), not on `start_date`.
- The list is a set: duplicate pairs have no additional effect.
- Rationale: audit MC-07/C5. The product must express a user who **paid or moved a single
  occurrence in the middle of the window**. Without an exclusion, the generated template occurrence
  is projected *and* an explicit moved event is projected — a double count. Advancing `start_date`
  could only suppress a prefix.
- This is a backward-compatible addition: a scenario with no `occurrence_exclusions` is unaffected,
  and a `contract_version` of `"1.0"` remains valid.

## Result contract version

The canonical result echoes the `contract_version` declared by the scenario (`"1.0"` or `"1.1"`).
A 1.0 scenario therefore still produces a byte-identical 1.0 result; the version never widens
silently, and the default (no declared version) is the implementation's latest (`1.1`).
