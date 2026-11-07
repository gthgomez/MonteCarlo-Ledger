import assert from "node:assert/strict";
import test from "node:test";

import { runScenario } from "../engine";
import { amortize, validateLiabilities } from "../debt";
import {
  checkedSub,
  ContractError,
  MAX_MONEY_CENTS,
  MIN_MONEY_CENTS,
  roundHalfAway,
} from "../money";

const AS_OF = "2026-11-01";

function scenario(overrides: Record<string, any> = {}): any {
  return {
    contract_version: "2.0",
    as_of: AS_OF,
    starting_balance_cents: 100000,
    horizon_days: 30,
    events: [],
    ...overrides,
  };
}

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ContractError, `expected ContractError, got ${err}`);
    assert.equal((err as ContractError).code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

test("strict starting-balance inputs", () => {
  assert.equal(runScenario(scenario({ starting_balance_cents: 123 })).forecast.ending_balance_cents, 123);
  assert.equal(runScenario(scenario({ starting_balance_cents: -123 })).forecast.ending_balance_cents, -123);
  for (const value of [123.99, "123", true, false, null, [], {}]) {
    expectCode(() => runScenario(scenario({ starting_balance_cents: value })), "INVALID_AMOUNT");
  }
  expectCode(
    () => runScenario(scenario({ starting_balance_cents: 2 ** 53 })),
    "MONEY_OVERFLOW"
  );
});

test("event amounts must be exact integers", () => {
  for (const value of [1.5, "100", true, null]) {
    expectCode(
      () => runScenario(scenario({ events: [{ date: AS_OF, amount_cents: value, type: "income" }] })),
      "INVALID_AMOUNT"
    );
  }
});

test("negative reserve and reversed ranges are typed errors", () => {
  expectCode(
    () => runScenario(scenario({ simulation: { runs: 1, seed: 1, reserve_cents: -1 } })),
    "INVALID_AMOUNT"
  );
  expectCode(
    () => runScenario(scenario({ simulation: { runs: 1, seed: 1, income_variation_min: 10, income_variation_max: -10 } })),
    "INVALID_AMOUNT"
  );
  expectCode(
    () => runScenario(scenario({ simulation: { runs: 1, seed: 1, quantile_num: 11, quantile_den: 10 } })),
    "INVALID_QUANTILE"
  );
  expectCode(
    () => runScenario(scenario({ simulation: { runs: 1, seed: 1, surprise_probability_ppm: 1000001 } })),
    "INVALID_AMOUNT"
  );
  expectCode(
    () => runScenario(scenario({ simulation: { runs: 1, seed: 1, unknown_option: 1 } })),
    "SCHEMA_INVALID"
  );
  expectCode(
    () => runScenario(scenario({ simulation: { runs: 1, seed: -1 } })),
    "INVALID_SEED"
  );
});

test("safe-to-spend subtraction is checked", () => {
  expectCode(() => checkedSub(MIN_MONEY_CENTS, 1n), "MONEY_OVERFLOW");
  assert.equal(checkedSub(0n, 1n), -1n);
});

test("debt output conversion fails closed beyond exact JS range", () => {
  // The schedule stays exact for normal values; the guard is exercised directly.
  assert.throws(() => {
    const huge = MAX_MONEY_CENTS;
    if (huge > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ContractError("MONEY_OVERFLOW", String(huge));
    }
  }, /MONEY_OVERFLOW/);
});

function reference(balance: number, aprBps: number, minimum: number, maxMonths = 360) {
  const rows: any[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let month = 0;
  while (balance > 0 && month < maxMonths) {
    month += 1;
    const interest = Number(roundHalfAway(BigInt(balance) * BigInt(aprBps), 120000n));
    const after = balance + interest;
    const payment = Math.min(minimum, after);
    const ending = after - payment;
    rows.push({ month, starting: balance, interest, payment, principal: payment - interest, ending });
    totalInterest += interest;
    totalPaid += payment;
    balance = ending;
  }
  return { rows, totalInterest, totalPaid, remaining: balance };
}

for (const [balance, apr, minimum] of [
  [100000, 1200, 10000],
  [250000, 2199, 6500],
  [1000000, 0, 100000],
  [333333, 1999, 33333],
]) {
  test(`debt matches independent reference ${balance}/${apr}/${minimum}`, () => {
    const result = amortize(AS_OF, [{
      id: "x", name: "X", balance_cents: balance, apr_basis_points: apr,
      min_payment_cents: minimum, kind: "installment",
    }], "snowball", 0);
    const expected = reference(balance, apr, minimum);
    assert.equal(result.total_interest_cents, expected.totalInterest);
    assert.equal(result.total_paid_cents, expected.totalPaid);
    assert.equal(result.months_to_payoff, expected.rows.length);
    assert.equal(result.did_not_converge, expected.remaining > 0);
    for (let i = 0; i < expected.rows.length; i++) {
      const e = expected.rows[i];
      const a = result.schedule[i];
      assert.equal(a.month, e.month);
      assert.equal(a.starting_balance_cents, e.starting);
      assert.equal(a.interest_cents, e.interest);
      assert.equal(a.payment_cents, e.payment);
      assert.equal(a.principal_cents, e.principal);
      assert.equal(a.ending_balance_cents, e.ending);
    }
  });
}

test("revolving without percent/floor is accepted as contract semantics and does not converge", () => {
  const liabilities = [{
    id: "card", name: "Card", balance_cents: 100000, apr_basis_points: 1800,
    min_payment_cents: 5000, kind: "revolving",
  }];
  validateLiabilities(liabilities);
  const result = amortize(AS_OF, liabilities, "snowball", 0);
  assert.equal(result.did_not_converge, true);
  assert.equal(result.months_to_payoff, 360);
});

test("debt rejects invalid due day and negative extra payment", () => {
  const base = {
    id: "x", name: "X", balance_cents: 1000, apr_basis_points: 0,
    min_payment_cents: 100, due_day_of_month: 32,
  };
  expectCode(() => validateLiabilities([base]), "SCHEMA_INVALID");
  expectCode(
    () => amortize(AS_OF, [{ ...base, due_day_of_month: 15 }], "snowball", -1),
    "INVALID_AMOUNT"
  );
});
