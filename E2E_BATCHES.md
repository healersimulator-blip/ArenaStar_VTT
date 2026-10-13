# Browser batches — the runnable division of `e2e/`

`pnpm test:e2e` runs **all 138 spec files** in one command and is the one command that does not meet
the 25-minute rule. The batches below are how the suite is actually run: pick one, run it, and know
how long it may take. `FX_TEST_BATCHES.md` covers the older FX/canvas/multilevel groups the same way.

## Prepare once after any source change

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test:fx:prepare     # vite build + system packages + starter worlds
```

The specs load the built `dist/index.html` over `file://` (which doubles as the §15 boot check).
They never start a dev server. `dist/worlds/*.zip` must exist — `e2e/start.spec.ts` and the
starter-world specs open the built archives, and a bare `pnpm build` wipes them.

## Rules

- **One batch at a time.** Every command uses one Chromium worker and `--retries=0`; the sandbox has
  two CPUs and overlapping heavy jobs (vitest, Playwright, lint, tsc, build) kill it.
- **`--global-timeout` caps every batch** (15–20 minutes). A cap fails the command; it never counts
  unfinished tests as passing.
- **A spec belongs to exactly one batch**, and `tests/scripts/e2eBatchCoverage.test.ts` asserts it at
  unit-test speed: all 138 files / 429 tests covered, no duplicates, no batch over the cap. Add a
  spec without a batch and that test fails.

## The batches

| script | specs | tests | cap | measured | result |
| --- | --- | --- | --- | --- | --- |
| `test:e2e:core` | 19 | 48 | 20 min | 9.5 min | **48 passed** |
| `test:e2e:table` | 19 | 39 | 20 min | 11.8 min | **39 passed** |
| `test:e2e:hexcrawl` | 8 | 16 | 15 min | 9.0 min | **15 passed / 1 skipped** |
| `test:e2e:images` | 10 | 31 | 15 min | 5.7 min | **29 passed / 2 skipped** |
| `test:e2e:net` | 3 | 4 | 15 min | 0.5 min | **4 passed** |
| `test:e2e:pf1e-combat` | 16 | 70 | 20 min | 13.5 min | 64 passed / **6 pre-existing failures** |
| `test:e2e:pf1e-sheets` | 14 | 28 | 20 min | 4.9 min | 23 passed / **5 pre-existing failures** |

Measured on the 2-CPU sandbox with the Chromium workaround in `README.md` (`@sparticuz/chromium` +
SwiftShader); they are observations, not guarantees.

## Known pre-existing failures (not regressions)

Both groups predate the batch split and live in `pf1e-combat`; neither is caused by a batch's own
code. They are recorded here so the failure is visible instead of hiding in an unrun file.

1. **`e2e/pf1e_opportunity.spec.ts` — the D-187/D-188 manual prompt (4 tests).**
   With `autoResolveAoos: false` a provoking drag never opens the reaction prompt, so
   `reactionPrompt(page)` is null. Confirmed pre-existing: with every app change of the batch work
   reverted (`git checkout -- src/`, rebuild), the first of the four still fails identically.
2. **`e2e/pf1e_movement.spec.ts` (2 tests), `e2e/pf1e_acceptance.spec.ts` (2) and
   `e2e/pf1e_spell_demo.spec.ts` (1).** A refused walk commits anyway (the token ends on the
   destination square), the mass-battle acceptance specs assert an empty console while the app
   probes `file:///api/cloud/status` (a `file://` fetch is a console error), and the aimed
   Lightning Bolt / Entangle demo never shows its FX. All five reproduce with this work's app
   changes reverted (`git checkout -- src/`, rebuild), so they predate it.
3. **`e2e/pf1e_entangle.spec.ts` — the D-407 scene (2 tests).**
   The spec drives the single-target cast path, but the quickbar routes a bound **Entangle** through
   the canvas-aim flow (`canvasAimedSpell` → `requestQuickbarSpellAim`), so slot 1 waits for an aim
   that the spec never performs. The spec's own docstring says the area cast was out of scope
   "because the tree does not implement it yet" — the tree implements it now. It needs rewriting
   against the aim flow, not a relaxed assertion.
