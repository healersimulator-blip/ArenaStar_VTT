# FX Wizard verification — D-363

Date: 2026-10-01

## Increment

The Tagger panel's placeable-type filter now includes `regions`. The core Tagger and host already supported region read/edit operations; the filter omission made them undiscoverable through this part of the GM UI.

`e2e/prefab_regions.spec.ts` now verifies the production flow: create a region, switch to the Tagger tab, choose **Regions**, locate the named region, select it, add `courtyard-root`, wait for exactly one host sequence increment, and verify the updated tag is displayed. The same test then continues through the region-root prefab flow, including capture and placement of the region with its linked active-zone graph. Its timeout is 60 seconds because the complete production scenario takes about 27 seconds here; all interaction, host-acknowledgement and placement assertions remain in force.

This is a narrow UI-discovery correction. It does **not** complete Tagger parity, A28, or any other full-parity criterion.

## Verification

- Production Chromium `e2e/prefab_regions.spec.ts --project=chromium --workers=1 --retries=0` — **1/1 passed** in 27.8 seconds, using npm-provisioned `@sparticuz/chromium@153.0.0`.
- The Playwright-pinned browser download was attempted but failed with TLS `ECONNRESET` from `cdn.playwright.dev`; using the npm-registry Chromium fallback, the production-browser regression passed. The temporary browser provisioning is outside the repository and did not change project dependencies.
- `corepack pnpm test` — **4,627 passed / 12 skipped**, 323 files passed / 2 skipped, **127.55 s**. The process emitted a `MaxListenersExceededWarning`; the suite completed successfully.
- `corepack pnpm typecheck` — passed; Svelte check reports 63 components, zero blocking issues and one advisory at `src/ui/sim/ReplayPanel.svelte:29` (`state_referenced_locally`).
- `corepack pnpm lint` — passed.
- `corepack pnpm build && corepack pnpm size` — passed; production output is **3,974,003 raw bytes / 1,136,853 gzip bytes**, within the 6 MB raw budget.
- `git diff --check` — passed.

The latest recorded PF1e p95 measurements are from D362: **61.8 ms** for 20 × 500 models, **94.6 ms** for 40 × 250, and **59.5 ms** for the 10k-model turn. They exceed the printed `<50 ms` targets; D363 did not change performance-sensitive logic. No A41 browser profile or full cross-browser run was performed.

## Remaining scope

- Broader Tagger discovery, query/filter behavior, selection, editing, rule/reference rebinding and multiplayer permissions remain only partially demonstrated.
- FX-emitter and other prefab roots, complete transform/visibility/lock/copy/edit/detach semantics, cross-grid geometry coverage and portable asset/reference behavior remain open.
- The full A01–A41 functional, security, multiplayer, browser and measured-performance acceptance matrix has not been demonstrated. No full-parity claim is made.
