# FX Wizard verification — D-362

Date: 2026-10-01

## Increment

This increment continues bounded PF-01/A28 work and closes the specific hidden-descendant error-detail leak found during HostSync review.

- Convex scene regions are now eligible prefab parts and roots across validation, capture, placement, attachment movement, cascade deletion and the Prefab panel. Region placement and child transforms use the shared center-based similarity transform; uniform resizing and rotation retain valid polygon geometry, and bounds checks examine transformed polygon vertices.
- Regions participate in Tagger collection discovery/read/edit and in prefab-marker projection stripping. Capture includes saved region-anchored active-zone graphs, placement rebinds those graphs to the cloned region, and deleting the region cascades its bound graph in the same undoable transaction. Player projections can receive an entitled visible region without receiving the private hierarchy marker.
- Attachment-transform failures no longer include a child's collection or ID in the host rejection detail. A hidden descendant that would exceed scene bounds is refused with the generic message `attached child would lie outside scene bounds`.
- A HostSync wall-root integration test verifies that an owned root carries a locked visible tile and hidden token descendant atomically, a direct edit of the locked child is rejected, the hidden token stays out of the player projection, Undo restores the group, and an out-of-bounds refusal does not expose the hidden child ID.
- A HostSync region-root test verifies GM-only region edits, region-anchored graph rebinding to the clone, region-plus-tile+token descendant transforms in one commit, hidden-token and private-graph projection redaction, graph cascade deletion, and Undo. A production Chromium flow authors a region and its active-zone graph in the wizard, captures them as a region-root prefab and places the transformed instance.

This is bounded progress only. It does **not** complete PF-01–PF-07 or A28.

## Verification

- `corepack pnpm exec vitest run tests/core/prefabs.test.ts` — **26/26 passed**.
- `corepack pnpm exec vitest run tests/core/tags.test.ts` — **9/9 passed**.
- `corepack pnpm exec vitest run tests/core/projection.test.ts` — **25/25 passed**.
- `corepack pnpm exec vitest run tests/host/sync.test.ts -t 'GM prefabs'` — **6 matching tests passed**, 177 unrelated tests skipped.
- Production Chromium `e2e/prefab_regions.spec.ts --project=chromium --workers=1 --retries=0` — **1/1 passed**, covering region and active-zone graph creation, root capture, graph rebinding and transformed placement.
- Production Chromium `e2e/prefabs.spec.ts --project=chromium --workers=1 --retries=0` — **4/4 passed** (legacy, pins, tag-destination and random-destination capture/place/despawn flows).
- `corepack pnpm test` — **4,627 passed / 12 skipped**, 323 files passed / 2 skipped, **107.07 s**. Node emitted a `MaxListenersExceededWarning`; the suite completed successfully.
- `corepack pnpm typecheck` — passed; Svelte check reports 63 components, zero blocking issues and one advisory at `src/ui/sim/ReplayPanel.svelte:29` (`state_referenced_locally`).
- `corepack pnpm lint` — passed.
- `corepack pnpm build && corepack pnpm size` — passed; production output is **3,973,993 raw bytes / 1,136,846 gzip bytes**, within the 6 MB raw budget.
- `git diff --check` — passed.

The full test run's PF1e microbenchmarks logged p95 **61.8 ms** for 20 × 500 models, **94.6 ms** for 40 × 250, and **59.5 ms** for the 10k-model turn, against their printed `<50 ms` targets. Although those tests passed, their measured values do not meet the printed budgets and are not evidence that A41's browser frame/dispatch/heap requirements pass. No A41 browser profile was run in this increment; the performance requirement remains open.

## Remaining scope

- FX-emitter and other unmodeled prefab roots; complete transform semantics and full cross-grid testing across the root/child geometry matrix.
- Full visibility/lock/copy/edit/detach behavior, third-party serializers, nested summons and portable asset/license rebinding.
- Browser coverage for root transforms and interactions beyond region capture/place, plus cross-browser and multiplayer acceptance across the full A28 scenario.
- The complete A01–A41 acceptance matrix, including all functional, security, multiplayer, browser and measured-performance criteria, has not been demonstrated. No full-parity claim is made.
