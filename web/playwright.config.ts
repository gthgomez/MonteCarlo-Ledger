import { defineConfig } from "@playwright/test";

// E2E runs against the real production build (`pnpm build` happens in the test:e2e script
// before `playwright test` starts the server) — not a component snapshot or dev server.
//
// The test server is deliberately pinned to loopback and to the explicit in-memory vault
// store. Empty Turso overrides are required: VAULT_MEMORY_STORE only selects memory mode
// when TURSO_DATABASE_URL is falsy, and inheriting a usable URL/token would let a test
// write to a real backend.
const LOOPBACK_BASE_URL = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: LOOPBACK_BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec next start --hostname 127.0.0.1 --port 3100",
    url: LOOPBACK_BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    // Explicit test-only durable-store substitute. A real deployment must set
    // TURSO_DATABASE_URL; otherwise vault routes fail closed with 503.
    env: {
      ...process.env,
      VAULT_MEMORY_STORE: "1",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
