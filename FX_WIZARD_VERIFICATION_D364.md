# FX Wizard verification — D-364

Date: 2026-10-01

## Increment

Wired the existing Tagger-style `tag:` search semantics into the GM Tagger explorer's combined name query. The query accepts plain or quoted name terms plus quoted/unquoted `tag:` clauses; all terms are required. Tag clauses use case-insensitive substring matching, with `*` and `?` wildcards, while quoted values preserve spaces. Query length and term count are bounded, and the matcher is compiled once per projected-result scan. A green “Lenient sidebar tag search” indicator explains this behavior. The separate Tag API query remains exact and case-sensitive by default; the sidebar query does not silently change API semantics.

This closes one unconnected UI path only. It does **not** complete TG-01–TG-12 or A13.

## Verification

- `corepack pnpm exec vitest run tests/core/tags.test.ts` — **10/10 passed**, including combined name/tag AND search, quoted phrases, case-insensitive substring/wildcard matching, negative terms and query bounds.
- Production Chromium `e2e/script_macros.spec.ts --project=chromium --workers=1 --retries=0 --grep "Tag search autocomplete"` — **1/1 passed** in 17.0 seconds. It verifies combined search with a quoted multiword tag and wildcard clause, a negative query, the visible lenient-mode indicator, and the separate API query's exact/case-sensitive default.
- `corepack pnpm test` — **4,628 passed / 12 skipped**, 323 files passed / 2 skipped, **114.54 s**.
- `corepack pnpm typecheck` — passed; 63 Svelte components, zero blocking issues and one advisory at `src/ui/sim/ReplayPanel.svelte:29` (`state_referenced_locally`).
- `corepack pnpm lint` — passed.
- `corepack pnpm build && corepack pnpm size` — passed; production output is **3,975,447 raw bytes / 1,137,337 gzip bytes**, within the 6 MB raw budget.
- `git diff --check` — passed.

The full-suite PF1e measurements were p95 **88.8 ms** for 20 × 500 models, **113.9 ms** for 40 × 250, and **72.0 ms** for the 10k-model turn. All exceed their printed `<50 ms` targets. They are not A41 browser frame/dispatch/heap evidence; performance parity remains open.

## Remaining scope

- Tagging is not yet supported across prototype tokens, actor/item documents, every relevant object sheet or system extensions. Complete Tagger API, reference binding, clone/import and multiuser coverage remain open.
- A13–A18, A22 and A28 are still only partially covered; the production test is one focused GM Chromium flow, not the complete functional/security/multiplayer matrix.
- Cross-browser acceptance, A41 profiling on a published reference device, and the full A01–A41 acceptance matrix remain incomplete. No full-parity claim is made.
