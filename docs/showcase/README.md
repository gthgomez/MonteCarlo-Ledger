# Reproducing the MonteCarlo-Ledger showcase

These are screenshots and a video of the real locally running UI, captured by browser automation. Application source was unchanged. Existing license and attribution terms apply; public visibility is not a new license grant.

## Provenance

- Application source revision: [`41b190b5873041f75651055f925a5bf38219ea8a`](https://github.com/gthgomez/MonteCarlo-Ledger/tree/41b190b5873041f75651055f925a5bf38219ea8a). The showcase commit adds documentation/media only.
- Captured 2026-10-30 with Chromium 154.0.8037.57, 1280 × 900, en-US / UTC.
- [Machine-readable capture manifest](capture.json) records scenario, source SHA, timing, blocked hosts, screenshot labels, media byte sizes and SHA-256 checksums.
- MP4: 11.8 seconds, silent H.264. GIF: 1.00× playback, 4 fps, reduced palette/size. JPGs are direct viewport captures. Only the video/GIF receives a provenance caption; no UI is generated or reconstructed.
- All amounts and obligations shown are synthetic sample data. Forecasts and what-if results are computed by the real client-side Contract 2.0 engine; no bank account, private ledger, or cloud vault was accessed.

## Run locally

Use this PR branch (the baseline revision above predates the added capture scripts). From the repository root, start the application in one terminal:

```bash
cd web
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start --hostname 127.0.0.1 --port 4312
```

In another terminal, install the isolated capture-tool dependencies and record. Requirements: Node compatible with the project, Chromium, FFmpeg and ffprobe on PATH. On Linux, the default browser path is `/usr/bin/chromium`; set `CHROMIUM_PATH` for your system. Installing Playwright's small FFmpeg helper supports its temporary WebM recorder; system FFmpeg creates the committed MP4/GIF. No hosted account or external media upload is needed.

```bash
npm ci --prefix docs/showcase
npx --prefix docs/showcase playwright install ffmpeg
node docs/showcase/capture.mjs
```

`SHOWCASE_URL` can override the local server origin; only loopback hosts are accepted. `CHROMIUM_PATH` and `FFMPEG_PATH` override executables. In restricted environments, put npm, corepack and Playwright caches in writable directories and use the same `PLAYWRIGHT_BROWSERS_PATH` during helper installation and capture. Do not point this script at production.

The script launches a new browser context with empty storage, blocks non-loopback requests, operates the actual UI, records a temporary WebM, creates the compact deliverables in `media/`, writes `capture.json`, and removes its own temporary recording directory. Rerunning replaces only showcase media and its manifest. Fonts can differ slightly because external font requests are blocked.

## Workflow and limits

Inspect forecast; test a hypothetical purchase and delayed income; add a synthetic recurring bill.

The browser starts with `web/src/lib/types.ts` → `SAMPLE_LEDGER_STATE`, in a fresh context with no saved storage. The capture clock is fixed at 2026-10-30 so recurring obligations line up reproducibly. No sync buttons, account links, or API vault routes are used. Results describe only this sample; simulated quantiles are estimates, not guarantees. Run `next build` before `next start`; do not run dev and build simultaneously in one `.next` directory.

Source surfaces inspected: `web/src/app/page.tsx`, `web/src/lib/types.ts`, `web/src/components/DecisionStudio.tsx`, `web/src/components/LedgerManager.tsx`, `web/src/contract/engine.ts`.

## Validation

Web companion: `npm run lint` (TypeScript), `npm test` (31 golden Contract 2.0 fixtures), and `npm run build`: passed. No Python source was changed; Python-wide checks were not run for this browser-documentation change.

Every screenshot and sampled video frames were visually inspected. Browser capture reported no uncaught page errors. README links, media checksums, encodings, file sizes, and final Git diff were reviewed. Public hosted links, when listed, received a read-only HTTP 200 check only; no production UI interaction, account setup, cloud sync, deployment, or paid inference was performed.
