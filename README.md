# VTT — serverless browser-only Virtual Tabletop

A Foundry-class virtual tabletop that ships as **one self-contained `index.html`**
(all JS/CSS/wasm/fonts inlined). No dedicated server: the GM's browser tab is the
authoritative host, persister and relay; players join with a link/code. Implements
the architecture spec in `uploads/VTT_Task.txt` (§0–§19) — see `PLAN.md`.

## Quickstart

```sh
pnpm install
pnpm dev          # vite dev server
pnpm build        # → dist/index.html (single file, ≤ 6 MB raw budget)
pnpm test         # vitest unit tests
pnpn typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm size         # prints raw+gzip size of dist/index.html, fails > 6 MB raw
pnpm test:e2e     # builds, then runs Playwright against file:// of dist/index.html
```

Requires Node 20+ and pnpm 10.

## Layout

Exact per spec §18 — see `src/` (app, core, host, client, net/signaling/_, canvas/_,
ui/*, dice, audio, packages, storage, workers, sim) and `systems/mass-battle-basic/`.
Each module folder has an `index.ts` barrel. Tracking files live in the repo root:
`PLAN.md`, `DECISIONS.md`, `DEVIATIONS.md`, `ROADMAP.md`, `PROTOCOL.md`.

## file:// limitations (§15)

The deliverable must boot from `https://` and `file://`:

- The app boots from `file://` in all supported browsers; the bootstrap screen
  reports which storage/network APIs the current origin provides.
- Storage availability on `file://` varies by browser: IndexedDB and Cache API
  generally work in Chromium; OPFS (`navigator.storage.getDirectory`) requires a
  secure context and may be unavailable; Safari/Firefox restrict some storage on
  `file://` origins. The host persistence layer degrades with a visible warning
  when a required store is missing.
- WebRTC works on `file://` (it is treated as a trustworthy/secure context by the
  supported browsers), but public signaling relays must be reachable over wss/https.
- For long-running hosted worlds we recommend serving `index.html` over `https://`;
  `file://` is fully supported for quick local play.

## Browser matrix (§15)

Chromium ≥ 110, Firefox ≥ 115, Safari ≥ 16.4. Playwright e2e runs Chromium; the
other engines are exercised per the matrix during milestone acceptance.

For an already-installed Chromium when the Playwright browser CDN is unavailable,
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable:

```bash
pnpm build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium \
  pnpm exec playwright test e2e/sheets.spec.ts e2e/windows.spec.ts --project=chromium --workers=1
```

The override affects only the Chromium project and adds no browser-security bypass
flags. Without it, Playwright uses its pinned browser as before. Record the actual
browser version when using an alternate binary; this is not Firefox/WebKit or full
supported-matrix acceptance. Browser executables and their libraries stay outside Git.
