import { defineConfig } from "@playwright/test";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

// E2E runs against the real production build (`pnpm build` happens in the test:e2e script
// before `playwright test` starts the server) — not a component snapshot or dev server.
//
// Default to the explicit in-memory vault. The recovery lane can opt into the production
// libSQL store using a disposable local file. Neither lane inherits a hosted URL or token.
const LOOPBACK_BASE_URL = "http://127.0.0.1:3100";
const vaultFile = process.env.MC_QUALIFICATION_VAULT_FILE;
if (vaultFile && (!isAbsolute(vaultFile) || vaultFile.startsWith("\\\\") || vaultFile.startsWith("//"))) {
  throw new Error("MC_QUALIFICATION_VAULT_FILE must be an absolute local path to a disposable file.");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: LOOPBACK_BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node ./node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100",
    url: LOOPBACK_BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      VAULT_MEMORY_STORE: vaultFile ? "" : "1",
      TURSO_DATABASE_URL: vaultFile ? pathToFileURL(vaultFile).href : "",
      TURSO_AUTH_TOKEN: "",
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
    { name: "tablet", testMatch: "**/daily-use.spec.ts", use: { viewport: { width: 768, height: 1024 } } },
  ],
});
