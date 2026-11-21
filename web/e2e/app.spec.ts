import { expect, test } from "@playwright/test";
import { LedgerState } from "../src/lib/types";
import { SAMPLE_LEDGER_STATE } from "../src/lib/types";

// A stored ledger with a zero-amount bill. Validation now rejects it at load time,
// before any financial number is computed, and never substitutes the demo ledger.
function invalidStoredState(): LedgerState {
  return {
    ...SAMPLE_LEDGER_STATE,
    payments: [
      {
        id: "pmt-broken",
        name: "Broken Bill",
        amount_cents: 0,
        due_day: 5,
        recurrence: "Monthly",
      },
    ],
  };
}

// A structurally valid ledger whose arithmetic overflows the supported money range.
// It passes import validation, then the canonical engine rejects it with MONEY_OVERFLOW.
function overflowState(): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-07T00:00:00.000Z",
    current_balance_cents: Number.MAX_SAFE_INTEGER,
    incomes: [
      {
        id: "inc-overflow",
        name: "Overflow Pay",
        amount_cents: 1_000_000,
        frequency: "Monthly",
        last_payday: "2026-10-10",
        next_payday: "2026-11-10",
      },
    ],
    payments: [],
    transactions: [
      {
        id: "tx-balance",
        amount_cents: Number.MAX_SAFE_INTEGER,
        category: "Adjustment",
        type: "Adjustment",
        date: "2026-10-01",
        description: "Opening",
      },
    ],
    bill_occurrences: [],
    liabilities: [],
  };
}

test.describe("dashboard loads with synthetic sample data", () => {
  test("home explains the cautious amount, not an error screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("What these numbers mean")).toBeVisible();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
    await expect(page.getByText(/\$[\d,]/).first()).toBeVisible();
    await expect(page.getByText(/Demo data — not your finances/)).toBeVisible();
  });

  test("plan shows a purchase comparison from the engine", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.getByText("How this changes the plan")).toBeVisible();
    await expect(page.getByText("Chance of running short").first()).toBeVisible();
  });
});

test.describe("fail-closed surfaces", () => {
  test("invalid stored data is reported and never replaced by demo numbers", async ({ page }) => {
    await page.addInitScript((state) => {
      window.localStorage.setItem("montecarlo_ledger_state_v2", JSON.stringify(state));
    }, invalidStoredState());
    await page.goto("/");
    await expect(page.getByText("Saved Ledger Not Loaded")).toBeVisible();
    await expect(page.getByText(/could not be loaded/)).toBeVisible();
    // No dashboard numbers are shown for an unvalidated ledger.
    await expect(page.getByText("Safe to Spend (P10)")).toHaveCount(0);
    await expect(page.getByText("Download raw data")).toBeVisible();
    // Replacement requires the explicit button and confirmation.
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByText("Replace with sample data (explicit)").click();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText(/Demo data — not your finances/)).toBeVisible();
  });

  test("a valid ledger that overflows the engine fails closed, never zeros", async ({ page }) => {
    await page.addInitScript((state) => {
      window.localStorage.setItem("montecarlo_ledger_state_v2", JSON.stringify(state));
    }, overflowState());
    await page.goto("/");
    await expect(page.getByText("Calculation Failed")).toBeVisible();
    await expect(page.getByText("MONEY_OVERFLOW").first()).toBeVisible();
    await expect(page.getByText("Reset to sample data")).toBeVisible();
  });
});

test.describe("decision journeys", () => {
  test("purchase scenario is labelled as a model estimate, never a guarantee", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.getByText(/^Purchase Amount:/)).toBeVisible();
    await page.locator('input[type="range"]').first().press("End");
    await expect(page.getByText(/^Purchase Amount: \$2,500/)).toBeVisible();
    await expect(page.getByText(/without risking negative balance/i)).toHaveCount(0);
    await expect(page.getByText(/in this simulation/i).first()).toBeVisible();
    await expect(page.getByText("Chance of running short").first()).toBeVisible();
  });

  test("late paycheck tab computes payroll-variance impact", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: /What if payday is late/ }).click();
    await expect(page.getByText("If that paycheck arrives late")).toBeVisible();
    await expect(page.getByText("Chance of running short").first()).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
  });

  test("debt tab computes payoff and states the cash-flow caveat", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
    await expect(page.getByText("Payoff Strategy")).toBeVisible();
    await expect(page.getByText("Months to Payoff")).toBeVisible();
    await expect(page.getByText("Total Interest Paid")).toBeVisible();
    await expect(
      page.getByText(/Minimum payments for debts you entered are already ordinary outflows/i)
    ).toBeVisible();
    await page.getByRole("button", { name: /Avalanche \(APR\)/ }).click();
    await expect(page.getByText("Months to Payoff")).toBeVisible();
    await expect(page.getByText(/Calculation Failed|UNKNOWN_ERROR/)).toHaveCount(0);
  });
});

test.describe("ledger editing", () => {
  test("adding a recurring bill updates the ledger and keeps a valid forecast", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Bills", exact: true }).click();
    await expect(page.getByText("Safe to Spend (P10)")).toHaveCount(0);

    const billForm = page
      .locator("form")
      .filter({ has: page.getByPlaceholder("e.g. Electric Bill, Rent, Netflix") });
    await page.getByPlaceholder("e.g. Electric Bill, Rent, Netflix").fill("Demo Gym");
    const numbers = billForm.locator('input[type="number"]');
    await numbers.nth(0).fill("45");
    await numbers.nth(1).fill("12");
    await billForm.getByRole("button", { name: /Add Recurring Bill/ }).click();

    await expect(page.getByRole("button", { name: "Remove Demo Gym" })).toBeVisible();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
  });
});

test.describe("local-first privacy", () => {
  test("dashboard and decisions make no remote network calls", async ({ page }) => {
    const remote: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      const local =
        url.startsWith("http://127.0.0.1:3100") ||
        url.startsWith("data:") ||
        url.startsWith("blob:");
      if (!local) remote.push(url);
    });

    await page.goto("/");
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: /What if payday is late/ }).click();
    await expect(page.getByText("If that paycheck arrives late")).toBeVisible();
    await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
    await expect(page.getByText("Payoff Strategy")).toBeVisible();

    expect(remote, `unexpected remote requests: ${remote.join(", ")}`).toEqual([]);
  });

  test("cloud vault is optional and opening it sends nothing", async ({ page }) => {
    const vaultCalls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/vault")) vaultCalls.push(req.url());
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Cloud Vault/ }).click();
    await expect(page.getByText(/Cloud Vault & CLI Synchronization/)).toBeVisible();
    await expect(page.getByText(/zero-knowledge end-to-end encryption/i)).toBeVisible();
    // Opening the optional sync surface must not by itself send the ledger anywhere.
    expect(vaultCalls).toEqual([]);
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
  });
});

test.describe("beginner financial journey", () => {
  test("applied financial assumptions persist after reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Plan window (days, 1–730)").fill("120");
    await page.getByLabel("Modeled futures (1–2000)").fill("750");
    await page.getByLabel("Seed").fill("123");
    await page.getByLabel("Low-point rank used for the cautious amount").selectOption("9/10");
    await page.getByLabel("Income can fall to (%)").fill("-10");
    await page.getByLabel("Income can rise to (%)").fill("10");
    await page.getByLabel("Bills can fall to (%)").fill("-3");
    await page.getByLabel("Bills can rise to (%)").fill("5");
    await page.getByLabel("Unexpected expense chance each check (%)").fill("5");
    await page.getByLabel("Check every (days)").fill("21");
    await page.getByLabel("Smallest unexpected expense ($)").fill("25");
    await page.getByLabel("Largest unexpected expense ($)").fill("180");
    const reserve = page.getByLabel("Reserve to subtract from the chosen low point ($)");
    await reserve.fill("500");
    await page.getByRole("button", { name: "Update results" }).click();
    await expect(reserve).toHaveValue("500.00");

    await page.reload();
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(page.getByLabel("Plan window (days, 1–730)")).toHaveValue("120");
    await expect(page.getByLabel("Modeled futures (1–2000)")).toHaveValue("750");
    await expect(page.getByLabel("Seed")).toHaveValue("123");
    await expect(page.getByLabel("Low-point rank used for the cautious amount")).toHaveValue("9/10");
    await expect(page.getByLabel("Income can fall to (%)")).toHaveValue("-10");
    await expect(page.getByLabel("Income can rise to (%)")).toHaveValue("10");
    await expect(page.getByLabel("Bills can fall to (%)")).toHaveValue("-3");
    await expect(page.getByLabel("Bills can rise to (%)")).toHaveValue("5");
    await expect(page.getByLabel("Unexpected expense chance each check (%)")).toHaveValue("5");
    await expect(page.getByLabel("Check every (days)")).toHaveValue("21");
    await expect(page.getByLabel("Smallest unexpected expense ($)")).toHaveValue("25.00");
    await expect(page.getByLabel("Largest unexpected expense ($)")).toHaveValue("180.00");
    await expect(
      page.getByLabel("Reserve to subtract from the chosen low point ($)")
    ).toHaveValue("500.00");
  });

  test("settings read failures stop forecasts and explain how to retry", async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (key === "montecarlo_financial_assumptions") throw new Error("storage blocked");
        return original.call(this, key);
      };
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Financial Settings Not Loaded" })).toBeVisible();
    await expect(page.getByText(/could not be read from this browser/i)).toBeVisible();
    await expect(page.getByText("Safe to spend", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Use default financial assumptions" }).click();
    await expect(page.getByText(/previous financial settings could not be checked/i)).toBeVisible();
    await expect(page.getByText("Safe to spend", { exact: true })).toHaveCount(0);
  });

  test("financial assumptions update across open tabs", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();

    const otherTab = await page.context().newPage();
    await otherTab.goto("/");
    await otherTab.evaluate(() => {
      localStorage.setItem(
        "montecarlo_financial_assumptions",
        JSON.stringify({
          schemaVersion: 1,
          values: {
            horizonDays: 90,
            runs: 500,
            seed: 42,
            quantileNum: 1,
            quantileDen: 10,
            incomeVariationMin: -8,
            incomeVariationMax: 8,
            expenseVariationMin: 0,
            expenseVariationMax: 0,
            surpriseProbabilityPpm: 150000,
            surpriseAmountMin: 2000,
            surpriseAmountMax: 15000,
            surpriseIntervalDays: 14,
            reserveCents: 25000,
          },
        })
      );
    });

    await expect(page.getByLabel("Reserve to subtract from the chosen low point ($)")).toHaveValue("250.00");
    await expect(page.getByText("Financial settings were updated in another tab.", { exact: true })).toBeVisible();
    await otherTab.close();
  });

  for (const delivery of ["before", "after"] as const) {
    test(`a legacy storage event delivered ${delivery} another tab saves preserves the explicit reserve`, async ({ page }) => {
      const key = "montecarlo_financial_assumptions";
      const legacy = {
        horizonDays: 90, runs: 500, seed: 42, quantileNum: 1, quantileDen: 10,
        incomeVariationMin: -8, incomeVariationMax: 8, expenseVariationMin: 0, expenseVariationMax: 0,
        surpriseProbabilityPpm: 150000, surpriseAmountMin: 2000, surpriseAmountMax: 15000,
        surpriseIntervalDays: 14, reserveCents: 10000,
      };
      const otherTab = await page.context().newPage();
      const reserve = "Reserve to subtract from the chosen low point ($)";
      await page.goto("/");
      await otherTab.goto("/");
      await page.getByRole("button", { name: "Advanced", exact: true }).click();
      await otherTab.getByRole("button", { name: "Advanced", exact: true }).click();
      await otherTab.evaluate(({ key, legacy }) => localStorage.setItem(key, JSON.stringify(legacy)), { key, legacy });
      await expect(page.getByLabel(reserve)).toHaveValue("100.00");

      const deliverQueuedEvent = () => page.evaluate(({ key, legacy }) => {
        window.dispatchEvent(new StorageEvent("storage", {
          key, newValue: JSON.stringify(legacy), storageArea: localStorage,
        }));
      }, { key, legacy });

      if (delivery === "before") await deliverQueuedEvent();
      await otherTab.getByLabel(reserve).fill("900");
      await otherTab.getByRole("button", { name: "Update results" }).click();
      await expect(page.getByLabel(reserve)).toHaveValue("900.00");
      if (delivery === "after") await deliverQueuedEvent();

      const durable = await otherTab.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "{}"), key);
      expect(durable.schemaVersion).toBe(1);
      expect(durable.values.reserveCents).toBe(90000);
      await expect(page.getByLabel(reserve)).toHaveValue("900.00");
      await otherTab.close();
    });
  }

  test("an interrupted assumptions write keeps the prior plan active", async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      let failures = 0;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === "montecarlo_financial_assumptions" && failures < 2) {
          failures += 1;
          original.call(this, key, value);
          throw new Error("interrupted write");
        }
        return original.call(this, key, value);
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Reserve to subtract from the chosen low point ($)").fill("500");
    await page.getByRole("button", { name: "Update results" }).click();

    await expect(page.getByRole("alert").filter({ hasText: "Financial settings could not be saved" })).toBeVisible();
    await expect(page.getByText("Reserve subtracted", { exact: true }).locator("..")).toContainText("$0.00");
    expect(await page.evaluate(() => localStorage.getItem("montecarlo_financial_assumptions"))).toBeNull();
  });

  test("legacy assumptions hydrate read-only until explicitly saved", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "montecarlo_financial_assumptions",
        JSON.stringify({
          horizonDays: 90,
          runs: 500,
          seed: 42,
          quantileNum: 1,
          quantileDen: 10,
          incomeVariationMin: -8,
          incomeVariationMax: 8,
          expenseVariationMin: 0,
          expenseVariationMax: 0,
          surpriseProbabilityPpm: 150000,
          surpriseAmountMin: 2000,
          surpriseAmountMax: 15000,
          surpriseIntervalDays: 14,
          reserveCents: 12500,
        })
      );
    });
    await page.goto("/");
    await expect(page.getByText("Older financial settings were loaded. Save under Advanced to update their format.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(page.getByLabel("Reserve to subtract from the chosen low point ($)")).toHaveValue("125.00");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("montecarlo_financial_assumptions") ?? "{}").schemaVersion)).toBeUndefined();
    await page.getByRole("button", { name: "Update results" }).click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("montecarlo_financial_assumptions") ?? "{}").schemaVersion)).toBe(1);
  });

  test("legacy startup cannot overwrite a newer explicit save in another tab", async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === "montecarlo_financial_assumptions" && value.includes('"schemaVersion":1')) {
          Object.defineProperty(window, "__releaseLegacyWrite", {
            configurable: true, value: () => original.call(this, key, value),
          });
          return;
        }
        return original.call(this, key, value);
      };
      localStorage.setItem(
        "montecarlo_financial_assumptions",
        JSON.stringify({
          horizonDays: 90, runs: 500, seed: 42, quantileNum: 1, quantileDen: 10,
          incomeVariationMin: -8, incomeVariationMax: 8, expenseVariationMin: 0, expenseVariationMax: 0,
          surpriseProbabilityPpm: 150000, surpriseAmountMin: 2000, surpriseAmountMax: 15000,
          surpriseIntervalDays: 14, reserveCents: 10000,
        })
      );
    });
    await page.goto("/");

    const otherTab = await page.context().newPage();
    await otherTab.goto("/");
    await otherTab.getByRole("button", { name: "Advanced", exact: true }).click();
    await otherTab.getByLabel("Reserve to subtract from the chosen low point ($)").fill("900");
    await otherTab.getByRole("button", { name: "Update results" }).click();
    await page.evaluate(() => {
      const release = (window as Window & { __releaseLegacyWrite?: () => void }).__releaseLegacyWrite;
      release?.();
    });

    expect(
      await otherTab.evaluate(() => JSON.parse(localStorage.getItem("montecarlo_financial_assumptions") ?? "{}").values.reserveCents)
    ).toBe(90000);
    await otherTab.close();
  });

  test("invalid settings can be recovered without replacing the ledger", async ({ page }) => {
    await page.goto("/");
    const ledgerBefore = await page.evaluate(() => {
      const ledger = {
        version: "2.1",
        updated_at: "2026-11-20T00:00:00.000Z",
        current_balance_cents: 123456,
        incomes: [],
        payments: [],
        transactions: [
          {
            id: "opening-balance",
            amount_cents: 123456,
            type: "Adjustment",
            date: "2026-11-20",
            description: "Opening balance",
          },
        ],
        bill_occurrences: [],
        liabilities: [],
      };
      const serialized = JSON.stringify(ledger);
      localStorage.setItem("montecarlo_ledger_state_v2", serialized);
      localStorage.setItem("montecarlo_financial_assumptions", '{"schemaVersion":99,"values":{}}');
      return serialized;
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Financial Settings Not Loaded" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download saved settings" })).toBeVisible();
    await page.getByRole("button", { name: "Use default financial assumptions" }).click();
    await expect(page.getByRole("heading", { name: "Financial Settings Not Loaded" })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("montecarlo_ledger_state_v2"))).toBe(ledgerBefore);
  });

  test("own numbers, spending, bills, a decision, and the forecast stay consistent", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Enter my own numbers" }).click();
    await page.getByLabel("Money you have now ($)").fill("1800");
    await page.getByLabel("Paycheck name").fill("Job");
    await page.getByLabel("Take-home amount ($)").fill("2400");
    await page.getByLabel("A regular bill").fill("Rent");
    await page.getByLabel("Bill amount ($)").fill("900");
    await page.getByLabel("Due day").fill("1");
    await page.getByRole("button", { name: "Save and show my plan" }).click();

    await expect(page.getByText("Demo data — not your finances.")).toHaveCount(0);
    await expect(page.getByText("$1,800.00").first()).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
    await expect(page.getByText(/not a guarantee/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Money", exact: true }).click();
    await page.getByRole("textbox", { name: "Amount ($)", exact: true }).fill("80");
    await page.getByLabel("Category").fill("Groceries");
    await page.getByRole("button", { name: "Record this" }).click();
    await expect(page.getByText("Groceries").first()).toBeVisible();
    await expect(page.getByText("The ledger total of $1,720.00 matches 2 recorded transactions.")).toBeVisible();

    await page.getByRole("button", { name: "Budget", exact: true }).click();
    await expect(page.getByText("Groceries").first()).toBeVisible();
    await expect(page.getByText("$80.00").first()).toBeVisible();
    await page.getByLabel("Monthly spending target ($)").fill("200");
    await page.getByRole("button", { name: "Save target" }).click();
    await expect(page.getByText(/\$120\.00 under the target/)).toBeVisible();
    await expect(page.getByText(/not part of the forecast/i)).toBeVisible();

    await page.getByRole("button", { name: "Bills", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove Rent" })).toBeVisible();
    await expect(page.getByText(/you marked this as leaving on its own/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.getByText("How this changes the plan")).toBeVisible();
    await page.getByRole("tab", { name: /What if payday is late/ }).click();
    await expect(page.getByText("If that paycheck arrives late")).toBeVisible();

    await page.getByRole("button", { name: "Future", exact: true }).click();
    await expect(page.getByText(/median, not an average/i).first()).toBeVisible();
    await expect(page.getByText("More difficult low point")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);

    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Seed").fill("7");
    await page.getByRole("button", { name: "Update results" }).click();
    await expect(page.getByText("7 / 500 / 90 days")).toBeVisible();
    await expect(page.getByText("minimum_balance_p10 / p50 / p90")).toBeVisible();
  });

  test("sections fit the required viewports without horizontal overflow", async ({ page }) => {
    await page.goto("/");
    const sizes = [
      [320, 568],
      [375, 667],
      [390, 844],
      [768, 1024],
      [1280, 800],
      [1440, 900],
    ] as const;
    const sections = ["Home", "Money", "Budget", "Bills", "Plan", "Future", "Advanced"] as const;
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      for (const name of sections) {
        await page.getByRole("button", { name, exact: true }).click();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow, `${name} at ${width}x${height}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
