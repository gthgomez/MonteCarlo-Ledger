import { expect, test } from "@playwright/test";
import { DEFAULT_ASSUMPTIONS } from "../src/lib/assumptions";

const asOf = "2026-11-10";
const ledgerKey = "montecarlo_ledger_state_v2";
const deterministic = {
  ...DEFAULT_ASSUMPTIONS,
  horizonDays: 21,
  reserveCents: 0,
  runs: 40,
  incomeVariationMin: 0,
  incomeVariationMax: 0,
  expenseVariationMin: 0,
  expenseVariationMax: 0,
  surpriseProbabilityPpm: 0,
};

test.use({ timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });

test("command search, history, and privacy work using the keyboard", async ({ page }) => {
  await page.goto("/#bills");
  await expect(page.getByRole("heading", { name: "Bills", level: 1 })).toBeVisible();
  const launch = page.getByRole("button", { name: "Search and commands" });
  await launch.focus();
  await page.keyboard.press("Control+k");
  const commands = page.getByRole("dialog", { name: "Search and commands" });
  const search = commands.getByRole("searchbox");
  await expect(search).toBeFocused();
  await search.fill("no such action");
  await expect(commands.getByRole("status")).toHaveText("No matching sections or actions.");
  await page.keyboard.press("Escape");
  await expect(launch).toBeFocused();

  await page.keyboard.press("Meta+k");
  await search.fill("Future");
  await search.press("ArrowDown");
  await expect(commands.getByRole("button", { name: /^Future / })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#future$/);
  await expect(page.getByRole("main")).toBeFocused();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Bills", level: 1 })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Future", level: 1 })).toBeVisible();

  const privacy = page.getByRole("button", { name: "Privacy mode", exact: true });
  await privacy.press("Enter");
  await expect(privacy).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Privacy mode is on", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "If every entered date happens" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Cloud Vault/ })).toBeDisabled();
  await privacy.press("Enter");
  await expect(page.getByRole("heading", { name: "If every entered date happens" })).toBeVisible();
});

test("a $300 debt minimum leaves $200 of $500, and a what-if never posts a charge", async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${asOf}T12:00:00Z`));
  await page.addInitScript((assumptions) => {
    localStorage.setItem("montecarlo_financial_assumptions", JSON.stringify(assumptions));
  }, deterministic);
  const readLedger = () => page.evaluate((key) => localStorage.getItem(key), ledgerKey);
  await page.goto("/");
  await page.getByRole("button", { name: "Enter my own numbers" }).click();
  await page.getByLabel("Money you have now ($)").fill("500");
  await page.getByRole("button", { name: "Save and show my plan" }).click();
  await expect(page.getByText("Not enough information to suggest spending", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
  await page.getByLabel("Debt name").fill("Synthetic required minimum");
  await page.getByLabel("Amount still owed ($)").fill("300");
  await page.getByLabel("Interest rate (%)").fill("0");
  await page.getByLabel("Minimum payment ($)").fill("300");
  await page.getByLabel(/Usual payment day/).fill("15");
  await page.getByRole("button", { name: "Add debt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Synthetic required minimum" })).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();

  const cautious = page.getByRole("heading", { name: "Cautious amount to spend", exact: true }).locator("..");
  await expect(cautious.locator("p").first()).toHaveText("$200.00");
  await expect(cautious.locator("p").first()).not.toHaveText("$500.00");
  await expect(page.getByRole("heading", { name: "Lowest point if the schedule is exact" }).locator("..").locator("p").first()).toHaveText("$200.00");
  const before = await readLedger();

  await page.getByRole("button", { name: "Explore a what-if" }).click();
  await page.getByLabel("Or type an amount ($)").fill("40");
  const comparison = page.getByRole("table", { name: "Current plan compared with this decision" });
  await expect(comparison.getByRole("row", { name: /Cautious amount to spend/ }).getByRole("cell")).toHaveText(["$200.00", "$160.00"]);
  expect(await readLedger()).toBe(before);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.reload();
  await expect(cautious.locator("p").first()).toHaveText("$200.00");
  expect(await readLedger()).toBe(before);

  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByLabel("Reserve to subtract from the chosen low point ($)").fill("300");
  await page.getByRole("button", { name: "Update results" }).click();
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByLabel("Or type an amount ($)").fill("10");
  await expect(comparison.getByRole("row", { name: /Lowest point/ }).getByRole("cell")).toHaveText(["$200.00", "$190.00"]);
  await expect(page.getByText(/selected modeled low point is below your reserve/)).toBeVisible();
  await expect(page.getByText(/selected modeled low point falls below zero/)).toHaveCount(0);
  expect(await readLedger()).toBe(before);
});

test("a late deposit settles its own payday and survives a failed storage write and retry", async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${asOf}T12:00:00Z`));
  await page.addInitScript(({ assumptions, key }) => {
    localStorage.setItem("montecarlo_financial_assumptions", JSON.stringify(assumptions));
    if (localStorage.getItem(key) !== null) return;
    localStorage.setItem(key, JSON.stringify({
      version: "2.2",
      updated_at: "2026-11-05T12:00:00Z",
      current_balance_cents: 50_000,
      incomes: [{ id: "pay-1", name: "Synthetic payroll", amount_cents: 40_000, frequency: "Weekly",
        last_payday: "2026-10-30", next_payday: "2026-11-06" }],
      payments: [{ id: "bill-1", name: "Synthetic due bill", amount_cents: 30_000, recurrence: "One-time", due_date: "2026-11-12" }],
      bill_occurrences: [],
      liabilities: [],
      transactions: [{ id: "opening", type: "Adjustment", amount_cents: 50_000, date: "2026-11-05" }],
    }));
  }, { assumptions: deterministic, key: ledgerKey });
  const readLedger = () => page.evaluate((key) => localStorage.getItem(key), ledgerKey);

  await page.goto("/#money");
  await page.getByRole("button", { name: "Record receipt for Synthetic payroll" }).click();
  await expect(page.getByLabel("Scheduled payday")).toHaveValue("2026-11-06");
  await expect(page.getByLabel("Receipt date")).toHaveValue(asOf);
  await expect(page.getByLabel("Amount received ($)")).toHaveValue("400.00");
  const before = await readLedger();
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name === key) {
        Storage.prototype.setItem = original;
        throw new DOMException("Synthetic storage failure", "QuotaExceededError");
      }
      return original.call(this, name, value);
    };
  }, ledgerKey);
  await page.getByRole("button", { name: "Save receipt" }).click();
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Amount received ($)")).toHaveValue("400.00");
  expect(await readLedger()).toBe(before);

  await page.getByRole("button", { name: "Save receipt" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Recorded \$400\.00 received/ })).toBeVisible();
  const ledger = JSON.parse((await readLedger()) ?? "null");
  expect(ledger.incomes[0]).toMatchObject({ last_payday: "2026-11-06", next_payday: "2026-11-13" });
  expect(ledger.transactions).toHaveLength(2);
  expect(ledger.transactions[1]).toMatchObject({ amount_cents: 40_000, type: "Income", date: asOf });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" }).locator("..").locator("p").first()).toHaveText("$600.00");

  await page.getByRole("button", { name: "Search and commands" }).click();
  const commands = page.getByRole("dialog", { name: "Search and commands" });
  await commands.getByRole("searchbox").fill("Synthetic payroll");
  await commands.getByRole("button", { name: /Search recorded activity/ }).click();
  const filter = page.getByRole("searchbox", { name: "Search", exact: true });
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("Synthetic payroll");
  await expect(page.getByRole("list", { name: "Recorded transactions" }).getByRole("listitem")).toHaveCount(1);
});

test("schedules and navigation fit around the floating mobile bar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "This test explicitly checks all viewport widths.");
  await page.goto("/");
  for (const width of [320, 390, 412, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 860 });
    for (const name of ["Home", "Money", "Budget", "Bills", "Plan", "Future", "Advanced"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("heading", { name, level: 1, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name} at ${width}px`).toBeLessThanOrEqual(width);
    }
  }
});

test("an anchored monthly bill stays visible for resolution after rollover", async ({ page }) => {
  await page.clock.install({ time: new Date(`${asOf}T12:00:00Z`) });
  await page.addInitScript((assumptions) => {
    if (!localStorage.getItem("montecarlo_financial_assumptions")) {
      localStorage.setItem("montecarlo_financial_assumptions", JSON.stringify(assumptions));
    }
  }, deterministic);
  await page.goto("/");
  await page.getByRole("button", { name: "Enter my own numbers" }).click();
  await page.getByLabel("Money you have now ($)").fill("500");
  await page.getByLabel("A regular bill").fill("Synthetic power");
  await page.getByLabel("Bill amount ($)").fill("300");
  await page.getByLabel("Due day", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Save and show my plan" }).click();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toBeVisible();
  await page.clock.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  await page.reload();
  await expect(page.getByText(/recurring bill “Synthetic power” was due Nov 15, 2026/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toHaveCount(0);
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  const slot = page.getByRole("listitem", { name: "Synthetic power due Nov 15, 2026" });
  await slot.getByRole("radio", { name: /already reflected in the cash I have now/ }).check();
  await slot.getByRole("button", { name: "Mark paid without new expense" }).click();
  await expect(slot).toHaveCount(0);
  const raw = await page.evaluate((key) => localStorage.getItem(key), ledgerKey);
  const ledger = JSON.parse(raw ?? "null");
  expect(ledger.current_balance_cents).toBe(50_000);
  expect(ledger.transactions).toHaveLength(1);
  expect(ledger.bill_occurrences[0]).toMatchObject({ original_due_date: "2026-11-15", paid: true, transaction_id: null });
});

test("mobile keyboard focus clears the navigation dock", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "The floating dock is used on the mobile layout.");
  await page.setViewportSize({ width: 412, height: 740 });
  await page.goto("/#advanced");
  const assumptions = page.getByLabel("Plan window (days, 1–730)");
  await assumptions.focus();
  for (let step = 0; step < 18; step += 1) {
    await page.keyboard.press("Tab");
    const geometry = await page.evaluate(() => {
      const focused = document.activeElement;
      const dock = document.querySelector('nav[aria-label="Primary sections"]');
      if (!focused || !dock || !focused.closest("main")) return null;
      return { bottom: focused.getBoundingClientRect().bottom, dock: dock.getBoundingClientRect().top };
    });
    if (geometry) expect(geometry.bottom).toBeLessThanOrEqual(geometry.dock + 2);
  }
});

test("a phone can open the forecast from the dock and inspect the chart by touch", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "One touch-emulated browser run is sufficient.");
  const context = await browser.newContext({
    baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    timezoneId: "UTC", colorScheme: "dark",
  });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(`${asOf}T12:00:00Z`));
    await page.goto("/");
    await page.getByRole("navigation", { name: "Primary sections" }).getByRole("button", { name: "Future" }).tap();
    const chart = page.getByRole("slider", { name: "Inspect the exact schedule by scheduled event" });
    await expect(chart).toHaveAttribute("aria-valuenow", "0");
    const plot = chart.locator("svg");
    const box = await plot.boundingBox();
    expect(box).not.toBeNull();
    await plot.tap({ position: { x: box!.width * 0.82, y: box!.height * 0.42 } });
    await expect(chart).not.toHaveAttribute("aria-valuenow", "0");
    await expect(chart).toHaveAttribute("aria-valuetext", /Planned balance/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(412);
  } finally {
    await context.close();
  }
});

test("the manifest serves standalone application icons without a ledger cache", async ({ page, request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({ start_url: "/", display: "standalone" });
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((item: { sizes: string }) => item.sizes === `${size}x${size}`);
    expect(icon).toBeDefined();
    expect((await request.get(icon.src)).headers()["content-type"]).toBe("image/png");
  }
  await page.goto("/");
  const registration = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  expect(registration).toBe(0);
});
