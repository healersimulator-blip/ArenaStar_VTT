# D-360 — Tag and asset-rights discovery checkpoints

This increment closes two small pieces of the next dependency cluster without claiming the remaining Tagger/prefab or asset-platform work is complete.

## Checkpoint 1 — Tag explorer autocomplete

The GM Tag explorer now suggests existing visible tags for the active comma-separated search term. Suggestions follow the selected scene/placeable filters, are prefix-matched case-insensitively and deterministically sorted, and are bounded to eight results. Click or ArrowUp/ArrowDown + Enter completes only the final term; Esc dismisses the list. The vocabulary is assembled from the current client's projected world, so hidden/private host-only tags are not exposed. Core tests cover term completion, duplicate/case ordering, exact matches, empty terms and the suggestion bound. A production browser regression checks mouse completion and keyboard completion while retaining earlier comma-separated terms.

## Checkpoint 2 — export-rights audit filter

The GM FX asset browser can filter media by all rights states, unreviewed legacy, granted, or restricted. It reports the unreviewed legacy count and explains that such a file needs explicit review when used by an FX timeline/preset; each row also states the precise rights status. This is discovery/filtering only: it does not grant rights, change export policy, migrate metadata, or claim legal license verification. The production media-import browser regression checks that restricted and granted assets appear in their respective filters while preserving the existing export/reapproval flow. The D-359 archive tests cover actual missing-rights blocking and unrelated legacy compatibility.

## Executed verification

| Gate | Result |
| --- | --- |
| Focused `tests/core/tags.test.ts` | **8/8 passed** |
| Full Vitest (`pnpm test`) | **4,618 passed / 12 skipped**, 323 files passed / 2 skipped (325 total), **111.71 s** |
| Focused production-browser regressions | **2/2 passed**: Tag autocomplete and FX media rights-filter/import flow |
| Typecheck | Pass; 63 Svelte components, 0 blocking issues, one existing advisory at `src/ui/sim/ReplayPanel.svelte:29` |
| Lint | `pnpm lint` passes |
| Production build and size | Pass; **3,969,053 raw / 1,135,332 gzip bytes**, within the 6 MB raw budget |
| Whitespace | `git diff --check` passes |

The first targeted browser run caught a Tag explorer search regression: the compiled matcher was passed a result row instead of its tag list. The matcher now receives `row.tags`; both browser regressions pass on the rebuilt production app. Playwright's pinned Chromium download remains unavailable due to the earlier CDN TLS `ECONNRESET`; the focused browser checks used npm-provisioned `@sparticuz/chromium@153.0.0` with its packaged libraries and sandbox disabled. No full browser batch was run.

## Still partial

Broader Tagger API coverage on prototype tokens/regions/extensions and every object sheet, arbitrary third-party graph/flag reference rebinding, the remaining prefab attachment/reference features, a full pre-wizard asset rights migration/audit, creator/license registry and full cross-browser/performance/A01–A41 acceptance remain open. These two checkpoints do not close the Tagger/prefab or asset-platform workstreams.
