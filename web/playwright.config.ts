import { defineConfig } from "@playwright/test";

// E2E runs against the real production build (`pnpm build` happens in the test:e2e script
// before `playwright test` starts the server) — not a component snapshot or dev server.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm start --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    // Explicit test-only durable-store substitute. A real deployment must set
    // TURSO_DATABASE_URL; otherwise vault routes fail closed with 503.
    env: { ...process.env, VAULT_MEMORY_STORE: "1" },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
