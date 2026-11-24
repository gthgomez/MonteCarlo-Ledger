import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// W1 acceptance for docs/campaign/WEB_PYTHON_QUALIFICATION.md.
//
// Every expected amount and date comes from testdata/household/qualification-household.json.
// That fixture was derived by hand (not by the Web or Python engines): opening cash 234567,
// rent -145000 on the 15th, car payment -42000 on the 20th, paycheck +190000 on the 22nd,
// a 30000 reserve, and zero model variance. With zero variance every modeled low equals the
// exact schedule, so the cautious amount is exactly the deterministic low minus the reserve.
//
// This browser journey starts in a fresh context and enters the household through the real
// controls. It deliberately does not inject a ledger, reuse a seeded parity fixture, or write
// any app code.
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "testdata", "household", "qualification-household.json"),
    "utf8"
  )
);

const LEDGER_KEY = "montecarlo_ledger_state_v2";
const ASSUMPTIONS_KEY = "montecarlo_financial_assumptions";

test.use({
  timezoneId: fixture.timezone,
  locale: "en-US",
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
});

function metric(page: Page, label: string): Locator {
  return page.getByRole("heading", { name: label, exact: true }).locator("..");
}

async function expectMetric(page: Page, label: string, value: string): Promise<void> {
  await expect(metric(page, label).locator("p").first()).toHaveText(value);
}

async function expectLowPoint(page: Page, label: string, value: string, lowLabel: string): Promise<void> {
  await expect(metric(page, label).locator("p").first()).toHaveText(value);
  await expect(metric(page, label).locator("p").last()).toContainText(
    `On ${lowLabel}, inside the ${fixture.horizon_days}-day plan.`
  );
}

function dayStat(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator("..").locator("dd");
}

async function readLedger(page: Page): Promise<any> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
}

async function readRawLedger(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LEDGER_KEY);
}

/** Inverse display parsing for direction checks. It does not compute the expected amounts. */
function displayCents(text: string): number {
  const match = /^(-?)\$([\d,]+)\.(\d{2})$/.exec(text.trim());
  if (!match) throw new Error(`Unexpected money display: ${text}`);
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2].replace(/,/g, "")) * 100 + Number(match[3]));
}

test("a first-time household survives onboarding, a linked debt, a decision, a moved bill, settlement, and reload", async ({
  page,
}) => {
  const afterOnboarding = fixture.oracles.after_onboarding_rent_only;
  const afterCar = fixture.oracles.after_car_payment_and_linked_debt;
  const purchase = fixture.oracles["purchase_650_on_2026-03-12"];
  const afterMove = fixture.oracles["after_move_rent_to_2026-03-24"];
  const latePayday = afterMove.late_payday_3_days;
  const afterSettle = fixture.oracles.after_marking_moved_rent_paid;
  const saved = fixture.expected_saved_ledger;

  test.setTimeout(60_000);
  await page.clock.install({ time: new Date(fixture.clock_iso) });
  await page.goto("/");

  // Fresh empty browser: the demo may be rendered in memory, but no ledger was injected.
  await expect(page.getByText(/Demo data — not your finances/)).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), LEDGER_KEY)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), ASSUMPTIONS_KEY)).toBeNull();
  await expect(page.getByText("Calculation Failed")).toHaveCount(0);

  // Ordinary onboarding, with keyboard entry for the money fields and keyboard submission.
  const enterOwn = page.getByRole("button", { name: "Enter my own numbers" });
  await enterOwn.focus();
  await page.keyboard.press("Enter");

  const balance = page.getByLabel("Money you have now ($)");
  await balance.focus();
  await page.keyboard.type("2345.67");
  await page.keyboard.press("Tab");
  await page.keyboard.type(fixture.household.income.name);
  await page.keyboard.press("Tab");
  await page.keyboard.type("1900");
  await page.getByLabel("How often").selectOption(fixture.household.income.frequency);
  await page.getByLabel("Next payday").fill(fixture.household.income.next_payday);
  await page.getByLabel("A regular bill").fill(fixture.household.rent.name);
  await page.getByLabel("Bill amount ($)").fill("1450");
  await page.getByLabel("Due day").fill(String(fixture.household.rent.due_day));

  await expect(balance).toHaveValue("2345.67");
  await expect(page.getByLabel("How often")).toHaveValue("Monthly");
  const saveOwn = page.getByRole("button", { name: "Save and show my plan" });
  await saveOwn.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText(/Demo data — not your finances/)).toHaveCount(0);
  await expect(page.getByText("Calculation Failed")).toHaveCount(0);
  await expectMetric(page, "Money available now", afterOnboarding.display.money_available_now);
  // The scheduled paycheck is not part of recorded cash; it appears only in the dated plan.
  await expect(page.getByText(/Scheduled income in that window is \$5,700\.00\./)).toBeVisible();

  // Zero-variance hand-oracle assumptions plus the planned $300 reserve. These are ordinary
  // Advanced controls, not storage injection.
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByLabel("Plan window (days, 1–730)").fill(String(fixture.assumptions.horizonDays));
  await page.getByLabel("Modeled futures (1–2000)").fill(String(fixture.assumptions.runs));
  await page.getByLabel("Seed").fill(String(fixture.assumptions.seed));
  await page.getByLabel("Low-point rank used for the cautious amount").selectOption(fixture.assumptions.quantile);
  await page.getByLabel("Income can fall to (%)").fill(String(fixture.assumptions.incomeVariationMin));
  await page.getByLabel("Income can rise to (%)").fill(String(fixture.assumptions.incomeVariationMax));
  await page.getByLabel("Bills can fall to (%)").fill(String(fixture.assumptions.expenseVariationMin));
  await page.getByLabel("Bills can rise to (%)").fill(String(fixture.assumptions.expenseVariationMax));
  await page.getByLabel("Unexpected expense chance each check (%)").fill("0");
  const reserve = page.getByLabel("Reserve to subtract from the chosen low point ($)");
  await reserve.fill("300");
  await page.getByRole("button", { name: "Update results" }).click();
  await expect(page.getByText(`${fixture.assumptions.seed} / ${fixture.assumptions.runs} / ${fixture.horizon_days} days`)).toBeVisible();
  await expect(reserve).toHaveValue("300.00");

  // First useful plan: rent lands before the first paycheck, so the exact low is the rent day.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectMetric(page, "Money available now", afterOnboarding.display.money_available_now);
  await expectMetric(page, "Cautious amount to spend", afterOnboarding.display.cautious_amount);
  await expectLowPoint(
    page,
    "Lowest point if the schedule is exact",
    afterOnboarding.display.low,
    afterOnboarding.low_date_label
  );
  await expect(page.getByText("This 90-day estimate keeps $300.00 as your reserve.")).toBeVisible();
  await expect(page.getByText("Technical name: Safe to Spend (P10).")).toBeVisible();
  await expect(
    page.getByText(
      "You have $2,345.67 recorded. Known bills in the next 90 days total $4,350.00. Scheduled income in that window is $5,700.00. If that schedule happens exactly as entered, the balance would be $3,695.67. The cautious amount you could spend over the 90-day plan is $595.67."
    )
  ).toBeVisible();

  // A second monthly bill, then the UI-supported linked debt case: Car payment covers the
  // Car loan minimum, so cash must fall by $420 once, not twice.
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await page.getByLabel("Bill name").fill(fixture.household.car_payment.name);
  await page.getByLabel("Amount ($)", { exact: true }).fill("420");
  await page.getByLabel("Due day (1-31)").fill(String(fixture.household.car_payment.due_day));
  await page.getByRole("button", { name: "Add Recurring Bill" }).click();
  await expect(page.getByRole("button", { name: "Remove Car payment" })).toBeVisible();

  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
  await page.getByLabel("Debt name").fill(fixture.household.linked_debt.name);
  await page.getByLabel("Amount still owed ($)").fill("6000");
  await page.getByLabel("Interest rate (%)").fill("0");
  await page.getByLabel("Minimum payment ($)").fill("420");
  const billSelect = page.getByLabel("Bill for this debt (optional)");
  const carOptionValue = await billSelect
    .locator("option")
    .filter({ hasText: fixture.household.car_payment.name })
    .getAttribute("value");
  expect(carOptionValue).toBeTruthy();
  await billSelect.selectOption(carOptionValue as string);
  await page.getByRole("button", { name: "Add debt" }).click();
  await expect(page.getByRole("button", { name: "Remove Car loan" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Car loan" }).first()).toContainText("min $420.00");

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectMetric(page, "Money available now", afterCar.display.money_available_now);
  await expectMetric(page, "Cautious amount to spend", afterCar.display.cautious_amount);
  await expectLowPoint(
    page,
    "Lowest point if the schedule is exact",
    afterCar.display.low,
    afterCar.low_date_label
  );
  // $1,450 rent + $420 car payment = $1,870. The linked $420 debt minimum adds no second outflow.
  await expect(dayStat(page, "Scheduled income")).toHaveText("$1,900.00");
  await expect(dayStat(page, "Scheduled payments and spending")).toHaveText("$1,870.00");
  await expect(dayStat(page, "Planned balance afterward")).toHaveText("$2,375.67");
  await expect(
    page.getByText(
      "You have $2,345.67 recorded. Known bills in the next 90 days total $5,610.00. Scheduled income in that window is $5,700.00. If that schedule happens exactly as entered, the balance would be $2,435.67. The cautious amount you could spend over the 90-day plan is $175.67."
    )
  ).toBeVisible();

  await page.getByRole("button", { name: "Future", exact: true }).click();
  await expect(page.getByText(/The cautious amount uses the more difficult tenth and is \$175\.67\./)).toBeVisible();
  await expect(
    page.getByText("Lowest planned balance $475.67 on Mar 20, 2026. Ending planned balance $2,435.67.")
  ).toBeVisible();

  // Hypothetical $650 purchase on 2026-03-12: exact cents, direction, and no ledger write.
  const ledgerBeforeDecision = await readRawLedger(page);
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByLabel("Or type an amount ($)").fill("650");
  await page.getByLabel("Planned purchase date").fill(purchase.date);
  const comparison = page.getByRole("table", { name: "Current plan compared with this decision" });
  const comparisonRow = (label: RegExp) => comparison.getByRole("row", { name: label });
  await expect(comparisonRow(/Cautious amount to spend/).locator("td").nth(0)).toHaveText(
    purchase.display.current_cautious
  );
  await expect(comparisonRow(/Cautious amount to spend/).locator("td").nth(1)).toHaveText(
    purchase.display.decision_cautious
  );
  await expect(comparisonRow(/Chance of running short/).locator("td").nth(0)).toHaveText(
    purchase.current_plan.chance_of_running_short
  );
  await expect(comparisonRow(/Chance of running short/).locator("td").nth(1)).toHaveText(
    purchase.this_decision.chance_of_running_short
  );
  await expect(comparisonRow(/Lowest point if the schedule is exact/).locator("td").nth(0)).toHaveText(
    purchase.display.current_low
  );
  await expect(comparisonRow(/Lowest point if the schedule is exact/).locator("td").nth(1)).toHaveText(
    purchase.display.decision_low
  );
  await expect(comparisonRow(/Ending balance if the schedule is exact/).locator("td").nth(0)).toHaveText(
    purchase.display.current_ending
  );
  await expect(comparisonRow(/Ending balance if the schedule is exact/).locator("td").nth(1)).toHaveText(
    purchase.display.decision_ending
  );
  expect(await readRawLedger(page)).toBe(ledgerBeforeDecision);
  expect(await readLedger(page)).toMatchObject({
    current_balance_cents: afterCar.starting_balance_cents,
    transactions: [{ amount_cents: fixture.household.opening_cash_cents }],
  });

  // Move the 2026-03-15 rent slot to 2026-03-24. The occurrence must keep its original slot,
  // follow the new date in the forecast, and leave one rent occurrence only.
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  const rentDueMar15 = page.getByRole("listitem", { name: "Rent due Mar 15, 2026" });
  await expect(rentDueMar15).toBeVisible();
  await rentDueMar15.getByLabel("New date for Rent due Mar 15, 2026").fill(afterMove.occurrence.due_date);
  await rentDueMar15.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("listitem", { name: "Rent due Mar 24, 2026" })).toBeVisible();

  const movedLedger = await readLedger(page);
  const rentOccurrences = movedLedger.bill_occurrences.filter(
    (occurrence: { payment_id: string }) => occurrence.payment_id === saved.rent_payment_id
  );
  expect(rentOccurrences).toHaveLength(1);
  expect(rentOccurrences[0]).toMatchObject(afterMove.occurrence);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectMetric(page, "Cautious amount to spend", afterMove.display.cautious_amount);
  await expectLowPoint(
    page,
    "Lowest point if the schedule is exact",
    afterMove.display.low,
    afterMove.low_date_label
  );

  // Narrow late-payday regression on the normal moved plan: car leaves 192567 on Mar 20,
  // so a three-day delay of the first receipt to Mar 25 puts Mar 24 rent first:
  // 192567 - 145000 = 47567 exact low on Mar 24 instead of 50567 on Apr 20.
  // Cautious amounts are 47567 - 30000 = 17567 versus 50567 - 30000 = 20567.
  // The ending stays 243567 and both are 0% because zero variance keeps every run positive.
  const ledgerBeforeDelay = await readRawLedger(page);
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("tab", { name: /What if payday is late/ }).click();
  const delaySlider = page.getByLabel(/Paycheck arrives late by/);
  await delaySlider.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(delaySlider).toHaveValue("3");
  await expect(page.getByText(/Paycheck arrives late by 3 days/)).toBeVisible();

  const lateComparison = page.getByRole("table", { name: "Current plan compared with this decision" });
  const lateRow = (label: RegExp) => lateComparison.getByRole("row", { name: label });
  await expect(lateRow(/Cautious amount to spend/).locator("td").nth(0)).toHaveText(
    latePayday.current_plan.display.cautious
  );
  await expect(lateRow(/Cautious amount to spend/).locator("td").nth(1)).toHaveText(
    latePayday.this_decision.display.cautious
  );
  await expect(lateRow(/Chance of running short/).locator("td").nth(0)).toHaveText(
    latePayday.current_plan.display.chance
  );
  await expect(lateRow(/Chance of running short/).locator("td").nth(1)).toHaveText(
    latePayday.this_decision.display.chance
  );
  await expect(lateRow(/Lowest point if the schedule is exact/).locator("td").nth(0)).toHaveText(
    latePayday.current_plan.display.low
  );
  await expect(lateRow(/Lowest point if the schedule is exact/).locator("td").nth(1)).toHaveText(
    latePayday.this_decision.display.low
  );
  await expect(lateRow(/Ending balance if the schedule is exact/).locator("td").nth(0)).toHaveText(
    latePayday.current_plan.display.ending
  );
  await expect(lateRow(/Ending balance if the schedule is exact/).locator("td").nth(1)).toHaveText(
    latePayday.this_decision.display.ending
  );

  // Direction from the rendered cells: delay lowers the cautious amount and exact low,
  // while the ending balance is unchanged.
  const normalCautiousCents = displayCents(
    await lateRow(/Cautious amount to spend/).locator("td").nth(0).innerText()
  );
  const delayedCautiousCents = displayCents(
    await lateRow(/Cautious amount to spend/).locator("td").nth(1).innerText()
  );
  const normalLowCents = displayCents(
    await lateRow(/Lowest point if the schedule is exact/).locator("td").nth(0).innerText()
  );
  const delayedLowCents = displayCents(
    await lateRow(/Lowest point if the schedule is exact/).locator("td").nth(1).innerText()
  );
  const normalEndingCents = displayCents(
    await lateRow(/Ending balance if the schedule is exact/).locator("td").nth(0).innerText()
  );
  const delayedEndingCents = displayCents(
    await lateRow(/Ending balance if the schedule is exact/).locator("td").nth(1).innerText()
  );
  expect(delayedCautiousCents).toBeLessThan(normalCautiousCents);
  expect(delayedLowCents).toBeLessThan(normalLowCents);
  expect(delayedEndingCents).toBe(normalEndingCents);

  // A comparison in the Plan tab must not post a transaction or move the balance.
  expect(await readRawLedger(page)).toBe(ledgerBeforeDelay);
  const afterDelayLedger = await readLedger(page);
  expect(afterDelayLedger.transactions).toHaveLength(1);
  expect(afterDelayLedger.current_balance_cents).toBe(afterCar.starting_balance_cents);

  // Return to Home on the unchanged moved plan before the existing reload continuation.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectMetric(page, "Cautious amount to spend", afterMove.display.cautious_amount);
  await expectLowPoint(
    page,
    "Lowest point if the schedule is exact",
    afterMove.display.low,
    afterMove.low_date_label
  );

  // Reload: the moved date and the unchanged assumptions persist in the same browser.
  await page.reload();
  await expectMetric(page, "Cautious amount to spend", afterMove.display.cautious_amount);
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  const rentDueMar24 = page.getByRole("listitem", { name: "Rent due Mar 24, 2026" });
  await expect(rentDueMar24).toBeVisible();
  await expect(rentDueMar24.getByLabel("New date for Rent due Mar 24, 2026")).toHaveValue(afterMove.occurrence.due_date);

  // Settle the moved slot. Mark paid records the expense on the fixed as-of date, keeps the
  // original and moved slots on the occurrence, and stops forecasting that slot.
  await rentDueMar24.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByRole("listitem", { name: "Rent due Mar 24, 2026" })).toHaveCount(0);
  await expect(page.getByRole("listitem", { name: "Rent due Mar 15, 2026" })).toHaveCount(0);

  const settledLedger = await readLedger(page);
  expect(settledLedger.version).toBe(saved.version);
  expect(settledLedger.current_balance_cents).toBe(afterSettle.recorded_balance_cents);
  expect(settledLedger.transactions).toHaveLength(saved.transaction_count);
  expect(settledLedger.transactions[1]).toMatchObject(afterSettle.transaction);
  expect(settledLedger.payments).toHaveLength(2);
  expect(settledLedger.bill_occurrences).toHaveLength(1);
  expect(settledLedger.bill_occurrences[0]).toMatchObject(afterSettle.occurrence);
  expect(settledLedger.bill_occurrences[0].transaction_id).toBe(settledLedger.transactions[1].id);
  expect(
    settledLedger.transactions.filter((tx: { description: string }) => tx.description === "Rent")
  ).toHaveLength(1);
  expect(settledLedger.liabilities).toHaveLength(saved.liability_count);
  expect(settledLedger.liabilities[0]).toMatchObject(saved.linked_liability);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("Calculation Failed")).toHaveCount(0);
  await expectMetric(page, "Money available now", afterSettle.display.money_available_now);
  await expectMetric(page, "Cautious amount to spend", afterSettle.display.cautious_amount);
  await expectLowPoint(
    page,
    "Lowest point if the schedule is exact",
    afterSettle.display.low,
    afterSettle.low_date_label
  );
  await expect(dayStat(page, "Scheduled income")).toHaveText("$1,900.00");
  // The paid rent slot no longer forecasts; only the car payment remains in the next 30 days.
  await expect(dayStat(page, "Scheduled payments and spending")).toHaveText("$420.00");
  await expect(dayStat(page, "Planned balance afterward")).toHaveText("$2,375.67");

  await page.getByRole("button", { name: "Money", exact: true }).click();
  await expect(
    page.getByText("The ledger total of $895.67 matches 2 recorded transactions.")
  ).toBeVisible();
  await expect(
    page.getByText(
      "This balance uses transactions dated today or earlier. Expected paychecks appear on their scheduled dates."
    )
  ).toBeVisible();

  // Reopen in the same browser: edits, settlement, and hand-oracle assumptions all persist.
  await page.reload();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectMetric(page, "Money available now", afterSettle.display.money_available_now);
  await expectMetric(page, "Cautious amount to spend", afterSettle.display.cautious_amount);
  await expectLowPoint(
    page,
    "Lowest point if the schedule is exact",
    afterSettle.display.low,
    afterSettle.low_date_label
  );

  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.getByLabel("Seed")).toHaveValue(String(fixture.assumptions.seed));
  await expect(page.getByLabel("Reserve to subtract from the chosen low point ($)")).toHaveValue("300.00");
  await expect(page.getByText(`${fixture.assumptions.seed} / ${fixture.assumptions.runs} / ${fixture.horizon_days} days`)).toBeVisible();

  const reloadedLedger = await readLedger(page);
  expect(reloadedLedger.current_balance_cents).toBe(afterSettle.recorded_balance_cents);
  expect(reloadedLedger.transactions).toHaveLength(saved.transaction_count);
  expect(reloadedLedger.bill_occurrences[0]).toMatchObject(afterSettle.occurrence);
});
