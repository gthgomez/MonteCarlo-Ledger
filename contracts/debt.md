# Debt & amortization — Contract 2.0

Contract 2.0 adds a **liability (debt) projection domain**. It is deterministic and independent of
the cash-ledger forecast: a scenario declares `liabilities`, and the engine returns a `debt` block
with the amortization schedule. The engine does **not** inject liability payments into `forecast`;
a caller that wants them in the cash projection adds them as ordinary `events` (they are plain
dated amounts).

This supersedes the deferred-liabilities clause of MCD-0012 (see MCD-0026).

## Scenario additions

All optional. `debt_strategy` and `extra_monthly_payment_cents` are only meaningful when
`liabilities` is present.

```text
"debt_strategy": "snowball" | "avalanche"   # default "snowball"
"extra_monthly_payment_cents": integer >= 0 # default 0
"liabilities": [ Liability ]
```

`Liability`:

```text
{ "id": string,                       # required, unique across the array
  "name": string,                     # optional
  "balance_cents": integer >= 0,      # required, principal owed
  "apr_basis_points": integer >= 0,   # required, 1850 = 18.50% APR
  "min_payment_cents": integer >= 0,  # required (installment floor)
  "kind": "installment" | "revolving",# default "installment"
  "min_payment_percent_bps": integer >= 0,   # default 0; revolving percent leg
  "min_payment_floor_cents": integer >= 0,   # default 0; revolving flat floor
  "due_day_of_month": integer 1..31 }        # default 1
```

Duplicate `id` is `SCHEMA_INVALID`. A negative `balance_cents`/`apr_basis_points`/
`min_payment_cents`/`min_payment_percent_bps`/`min_payment_floor_cents` is `SCHEMA_INVALID`.

## Result addition

The `debt` block is present **iff** the scenario declares `liabilities` (an empty array yields a
zeroed block):

```text
"debt": {
  "strategy": "snowball" | "avalanche",
  "extra_monthly_payment_cents": integer,
  "months_to_payoff": integer,
  "payoff_date": date,                 # as_of + months_to_payoff months
  "total_interest_cents": integer,
  "total_paid_cents": integer,
  "did_not_converge": boolean,
  "schedule": [ Step ]
}

Step = { "month": integer >= 1, "date": date, "liability_id": string,
         "starting_balance_cents": integer, "payment_cents": integer,
         "interest_cents": integer, "principal_cents": integer,   # signed
         "ending_balance_cents": integer }
```

Liabilities do **not** participate in the Monte Carlo: `simulation` (if present) varies only the
cash-ledger events. The `debt` block is deterministic for a fixed scenario.

## Amortization procedure (normative)

Notation: `round` is `round_half_away` from `money.md`; month `k` has date `as_of + k months`
(`k = 1` is the first row).

```text
balances = { liability.id: liability.balance_cents }
months = 0; total_interest = 0; total_paid = 0; schedule = []; overflowed = false
current_date = as_of

while any(balances[id] > 0) and months < 360 and not overflowed:
    months += 1
    current_date += 1 month

    # (a) target order: only liabilities with balance > 0, stable-sorted
    active = [l for l in liabilities if balances[l.id] > 0]      # array order preserved
    if strategy == "snowball":  order = stable_sort(active, key = balance asc)
    else:                       order = stable_sort(active, key = apr_basis_points desc)

    extra_pool = extra_monthly_payment_cents

    # (b) interest + minimum payment, in `order`
    for l in order:
        interest = monthly_interest(balances[l.id], l.apr_basis_points)
        if interest > MAX_MONEY - balances[l.id]: overflowed = true; break
        balances[l.id] += interest
        total_interest += interest

        minimum = minimum_payment(l, balances[l.id])
        principal = minimum - interest                     # signed (negative = negative amortization)
        starting = balances[l.id] - interest                # balance before this month's interest
        balances[l.id] -= minimum
        total_paid += minimum
        schedule.append(step(months, current_date, l.id, starting, minimum, interest, principal, balances[l.id]))

    # (c) apply the extra pool in the same `order`, folding each amount into that debt's (month) row
    for l in order:
        if extra_pool <= 0: break
        if balances[l.id] <= 0: continue
        extra = min(extra_pool, balances[l.id])
        balances[l.id] -= extra
        extra_pool -= extra
        total_paid += extra
        row = last schedule row with liability_id == l.id and month == months
        row.payment_cents += extra
        row.principal_cents += extra
        row.ending_balance_cents = balances[l.id]

did_not_converge = any(balances[id] > 0) or overflowed
payoff_date = as_of + months months
```

Helpers:

```text
monthly_interest(balance, apr_bps) = round(balance * apr_bps, 120000)   # apr_bps / 10000 / 12

minimum_payment(l, balance_after_interest):
    if balance_after_interest <= 0: return 0
    if l.kind != "revolving": return min(l.min_payment_cents, balance_after_interest)
    percent = round(balance_after_interest * l.min_payment_percent_bps, 10000)
    return min(max(percent, l.min_payment_floor_cents), balance_after_interest)
```

Notes:

- `months_to_payoff` is the number of months the loop ran (0 when there are no liabilities or all
  balances are 0; 360 when capped). `payoff_date` is `as_of + months_to_payoff months` (never null).
- Rows are emitted in the `order` of step (b); `starting = start_of_month_balance`,
  `ending = starting + interest - payment`, so `starting - principal == ending` on every row.
- Interest is charged **before** the payment, and the payment is capped at the post-interest balance,
  so a balance never goes negative.
- The `order` is a **stable** sort: liabilities with equal balance (snowball) or equal APR (avalanche)
  keep their order in the `liabilities` array.
- `total_paid_cents` includes the minimum payments and the extra pool; it does not include interest
  separately (interest is part of the balance growth, not a cash outflow in this model).
- If the overflow guard fires during step (b), the procedure stops: step (c) is **not** run for that
  month (`overflowed = true`), and `did_not_converge` is `true`.
- The 360-month cap and the overflow guard are the only stopping conditions besides payoff.
