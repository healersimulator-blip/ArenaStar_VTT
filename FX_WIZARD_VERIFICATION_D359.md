# D-359 — Legacy FX media rights at world export

World archive collection now traces image/sound `assetId`s in saved FX sequence and preset macros. A referenced media asset with no `exportRights` is treated as unreviewed and blocks ZIP/folder export until the GM reviews it. Explicit `granted` rights allow export; explicit `restricted` rights remain blocked. The gate is reference-aware: unrelated legacy assets without rights retain the existing export behavior. The FX existing-media review panel also tells the GM when a selected file is unreviewed legacy media, restricted, or marked for export.

Regression coverage creates an unreviewed timeline image and preset sound, confirms each blocks export until granted, verifies a referenced restricted file remains blocked, then exports both granted FX assets alongside an unrelated legacy image with no rights declaration. The existing restricted-media round-trip test continues to check the archive/import review path.

## Executed verification

| Gate | Result |
| --- | --- |
| Focused `tests/host/worldFile.test.ts` | **8/8 passed** |
| Full Vitest (`pnpm test`, serial rerun) | **4,617 passed / 12 skipped**, 323 files passed / 2 skipped (325 total), **110.24 s** |
| Focused FX media-import browser regression | **1/1 passed** (`e2e/fx_sequence.spec.ts`, media import/export-rights case) |
| Production build and size | Pass; **3,965,418 raw / 1,134,106 gzip bytes**, within the 6 MB raw budget |
| Typecheck | Pass; 63 Svelte components, 0 blocking issues, one existing advisory at `src/ui/sim/ReplayPanel.svelte:29` |
| Lint | `pnpm lint` passes |
| Whitespace | `git diff --check` passes |

The initial full Vitest run overlapped typecheck, lint and build, and two unrelated timing-budget assertions failed: FX sound-fader gain remained at its old value for one check, and a compendium-index keystroke measured 16.77 ms against a 16 ms budget. With no changes to either subsystem, the serial full-suite rerun passed both. The focused world-file suite also passed independently.

The Playwright-pinned Chromium binary was absent and its CDN install attempt failed with TLS `ECONNRESET`. The focused browser case was therefore run using npm-provisioned `@sparticuz/chromium@153.0.0`, with its packaged AL2023 libraries and sandbox disabled; the full FX browser suite was not run.

## Remaining gaps

This closes only the scoped legacy FX media world-export rule. The broader pre-wizard asset rights migration/audit, remaining Tagger/prefab reference rules, full FX browser acceptance, cross-browser/performance gates, and broader A01–A41 parity remain open. No full-parity claim.
