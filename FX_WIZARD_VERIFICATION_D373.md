# D373 verification — intentional-cycle diagnostics (A27)

**Date:** 2026-10-02  
**Result:** The intentional landing/jump cycle now has a host-integration regression covering bounded termination, GM-only diagnostics, rollback, and host recovery. This closes that diagnostic slice, not the remaining trigger/action parity matrix or overall A01–A41.

## Changes

- Added a `ClientSync` → `HostSync` → GM-client loopback test for a valid two-step `landing` / unconditional `jump` cycle, with a connected player present.
- Verified the existing per-graph budget terminates the loop after 10,000 executed steps with the diagnostic `automation cycle/resource budget (10000 per graph, 25000 total steps)`.
- Bounded the *delivered and rendered* trace for cycle/recursion/depth-budget rejections to 128 entries: the first 127 diagnostic rows plus an omitted-count summary. Successful acyclic traces retain the existing 4,096-entry cap, so the 600-run-step A41 trace remains inspectable.
- The test verifies the error trace is GM-only, no graph history/sequence/message/token changes commit, and a normal graph commits immediately afterward. This test verifies the host path and client delivery, not a production-browser freeze run. Together with D372's production 600-run-step graph and 601-entry trace, it provides complementary evidence for A27's acyclic-load and intentional-cycle branches; the broader TR action/event matrix remains incomplete.

The budget failure is not persisted in the world. The bounded response prevents the GM Automation panel from receiving and rendering thousands of repeated cycle rows; the host trace still identifies the first landing/jump steps and quantifies the omitted rows.

## Current A41 diagnostic reference

The corrected workload follows the runbook: **600 run-scope steps plus terminal stop**, yielding **601 trace entries**. The latest diagnostic used headless Chromium 153 with WebGL backed by the **SwiftShader software renderer**, not a physical GPU; no pre-published reference profile was available. It completed the workload but is non-qualifying:

| Metric | Result | A41 limit | Diagnostic status |
|---|---:|---:|---|
| Visible-page rAF p95 | 150 ms | ≤50 ms | Miss |
| Trigger-dispatch p95 | 86 ms | ≤100 ms | Pass |
| Stabilized V8 heap ratio | 1.1482× | ≤1.10× | Miss |

FX cleanup, exact 100-visual cycles, all 100 trigger commits, 200 rendered tile images, and the 600-step graph all completed. See [D372 for the detailed workload, environment and measurements](FX_WIZARD_VERIFICATION_HISTORY.md#report-d372). A41 remains open until a matching GPU reference run passes every target.

## Verification

- Focused A27 host integration test: **1 passed**; final tightened assertion confirms exactly 128 delivered trace entries and the exact `9,873 more trace entries omitted` marker. The test completed in 53 ms.
- Original full `corepack pnpm test` at D373: **4,650 passed / 12 skipped**, 325 files passed / 2 skipped; 110.74 seconds. The focused A27 test was rerun after tightening its omitted-count assertion.
- Workspace count reconciliation rerun (2026-10-02): **4,655 passed / 12 skipped**, 325 files passed / 2 skipped; 115.15 seconds. The current suite total is five higher than the original D373 run; that historical result is retained rather than backdated.
- `corepack pnpm typecheck`: passed; 64 Svelte components, zero blocking issues, one existing advisory at `src/ui/sim/ReplayPanel.svelte:29`.
- `corepack pnpm lint`: passed.
- `corepack pnpm test:fx:prepare`: production app, system packages, and available starter-world artifacts built; optional tester starter skipped because `dist/content/pf1e` was absent.
- Separate PF1e benchmark p95s: **55.2 ms** (20×500), **104.7 ms** (40×250), and **65.6 ms** (10k-model turn), above their printed `<50 ms` targets. Their wider test regression ceiling does not establish those budgets or A41 parity.

Full A01–A41 feature, security, multiplayer, browser, and performance parity remains incomplete and is not claimed.
