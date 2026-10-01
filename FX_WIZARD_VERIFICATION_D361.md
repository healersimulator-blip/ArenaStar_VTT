# FX Wizard verification — D-361

Date: 2026-10-01

## Increment

This increment expands a bounded part of PF-01/PF-02 (A28). `attachedMovementOps` now infers nested-child transforms from additional prefab root geometries:

- Tokens and tiles retain translation, rotation and uniform resize support.
- Walls use endpoint-pair midpoint, segment-length ratio and bearing delta.
- Measured templates use position, uniform distance/width scale and facing.
- Lights and sounds translate and support their modeled uniform size changes.
- Notes translate.
- Box drawings translate and uniformly scale; point drawings can translate, uniformly scale and rotate when all points share one similarity transform.

Derived descendant updates are added to the same planned host transaction. Invalid, unsupported or nonuniform parent geometries fail closed. The Prefab panel now summarizes the supported roots and named gaps. These changes do **not** complete A28: the parity spec also requires all relevant root/child types, visibility/lock behavior, cross-grid scaling, copy/edit/detach, tags and cleanup to work coherently.

## Verification

- `corepack pnpm exec vitest run tests/core/prefabs.test.ts` — **25/25 passed**.
- Production Chromium `e2e/prefabs.spec.ts --project=chromium --workers=1 --retries=0` — **4/4 passed** (legacy, pins, tag-destination and random-destination capture/place/despawn flows). These existing browser cases do not exercise the new wall/template/light/sound/drawing-root transforms.
- `corepack pnpm test` — **4,623 passed / 12 skipped**, 323 files passed / 2 skipped, 109.97 s. A Node `MaxListenersExceededWarning` was emitted; the run completed successfully.
- `corepack pnpm typecheck` — passed; Svelte check reports 63 components, zero blocking issues and one existing advisory at `src/ui/sim/ReplayPanel.svelte:29` (`state_referenced_locally`).
- `corepack pnpm lint` — passed.
- `corepack pnpm build && corepack pnpm size` — passed; production output is **3,972,607 raw bytes / 1,136,519 gzip bytes**, within the 6 MB raw budget.

The full test run's PF1e microbenchmarks logged p95 **60.1 ms** for 20 × 500 models, **92.3 ms** for 40 × 250, and **66.4 ms** for the 10k-model turn, against their printed `<50 ms` targets. The tests passed, but these results are not evidence that A41's reference-browser frame/dispatch/heap requirements pass; no A41 browser profile was run in this increment, and I do not count the performance requirement as satisfied.

## Remaining scope

- The root-transform extension has focused core tests, not browser tests for each added root geometry or dedicated multiplayer/security/Undo/Redo acceptance scenarios for those geometries.
- FX-emitter and region roots, complete root/child geometry transforms, full-matrix cross-grid verification (the existing portable-placement test covers token/wall geometry), visibility-policy parity, and interactive attach/detach, edit and copy workflows remain incomplete.
- Existing support for locks, tag/graph rebinding, privacy, undo and scripted placement does not establish the entire A28 scenario.
- The full A01–A41 acceptance matrix, including its functional, security, multiplayer, browser and measured-performance criteria, has not been demonstrated. No full-parity claim is made.
