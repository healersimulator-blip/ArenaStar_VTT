# PF1e Combat Fidelity — Gap List & Work Plan

**Scope:** what it takes to faithfully recreate the *Pathfinder 1e SRD, Combat chapter*
(Gamemastering → Combat, d20pfsrd.com) inside ArenaStar_VTT, at both scales the repo
supports:

- **hero level / tactical** — Actor/Item/Effect documents, tokens on a 5-ft grid,
  `CombatDocument` + `src/core/combat.ts` tracker, `src/dice/engine.ts` rolls,
  `src/ui/combat/CombatPanel.svelte`.
- **mass combat / strategic** — `RulesModule` + `ModelPool` typed-array sim
  (10k models, SimWorker, seeded PRNG), `src/packages/pf1e/*`, `src/packages/massBattlePf1e.ts`.

Audited against the SRD Combat chapter (all 38 chunks; the 3PP "Secrets of Adventuring"
material d20pfsrd interleaves into it is out of scope — §8) and against the working tree on
`arena/01a07ced-arenastar-vtt` at `42dccd8` (the PF1e code is already committed there; the
`patches/*.patch` files are the originating drops). **No source files were modified to
produce this document** — it is a gap list, not a change. Rule numbers cited below are
transcribed in Appendix A so the work can proceed without re-opening the SRD.

Status codes: ✅ faithful · 🟡 partial · 🔴 wrong (implemented but contradicts SRD) · ⚪ absent.

> **GM-control correction (D-125):** active and last-member removal are now allowed
> immediately; roster edits preserve the round and do not tick effects. Cross-selection
> initiative ties no longer block a GM roll; stable order is retained and full tie resolution
> remains optional. This supersedes D-124's two restrictions per explicit user direction.

> **Selected-token workflows, 2026-09-08 (D-124):** GM canvas selection now drives
> encounter creation, add/remove controls and partial initiative rolls. Scene/deletion
> guards prevent stale selections from broadening scope; unselected initiative records
> are preserved. Real browser and host/peer tests pass. Context-menu/hidden-state controls
> and verified hidden rolls remain open; selected-token tracker controls are no longer absent.

> **Public initiative ties, 2026-09-08 (D-123):** PF1e-containing public roll batches
> now resolve equal totals by total modifier and recorded subgroup roll-offs, preserving
> the resolved order across core turn/round operations and peer replication. Generic-only
> and manual ties remain stable by design. T02 still awaits selected-token and verified
> hidden-roll workflows; earlier notes about automatic ties being absent are historical.

> **Public initiative, 2026-09-08 (D-122):** Roll init now uses linked PF1e
> derived modifiers and records a public breakdown. Flat-footed no longer incorrectly
> removes Dexterity from initiative. Explicit rerolls preserve the active combatant;
> hidden rosters are blocked. T02 remains partial: selected-token workflows, verified
> hidden rolls and automatic modifier/tie-roll resolution are still open.

> **Encounter selection, 2026-09-08 (D-121):** GM encounter creation/activation is
> scene-scoped and replicated; switching preserves progress. Legacy unbound encounters
> remain accessible under the first stored scene. A two-scene browser regression also
> repaired Add token's hard-coded bootstrap parent. T04 is delivered; actor-aware
> initiative, selection-aware rosters and remaining combat rules are still open.

> **Tracker prerequisite, 2026-09-08 (D-120):** scoped delayed-marker round-wrap
> cleanup is repaired and browser-tested. “Mark delayed” is explicitly metadata-only;
> PF1e delay/resume scheduling, surprise and flat-footed transitions remain open. This
> bounded T03 repair does not close P2 or the remaining P1 contracts.

> **P1 browser acceptance, 2026-09-08 (D-119):** nine real Chromium sheet/window
> tests now pass, including all shipped bestiary readouts and player token activation,
> live editing, downgrade/revocation/regrant. Browser-only Weapons/AC preview failures,
> a sparse-create projection failure blocking linked-token broadcasts, and Settings
> initialization were repaired. Firefox/WebKit acceptance and ability damage/drain remain
> open; earlier "browser unverified" notes below are historical. See unified TODO D-119.

> **P1 AC/health contracts, 2026-09-08 (D-118):** explicit, reversible AC source
> conversion now requires a same-engine preview and preserves published totals. Canonical
> temporary HP and typed energy resistance have validated manual authoring/readouts; they
> are not damage/healing automation. Ability damage/drain, full injury propagation and
> actual browser acceptance remain open. Rule boundaries and 862-test evidence are in
> unified TODO / D-118; earlier progress notes below are historical.

> **P1 weapon authoring, 2026-09-08 (D-117):** tactical attack-line add/edit/remove and
> supported DR/SR/recovery-value editors are implemented; legacy strategic weapons and
> imported defense metadata are preserved. Numeric DR/regeneration normalization loss was
> repaired. Richer HP/ER contracts, explicit published-AC conversion and actual browser
> acceptance remain open; no attack/damage/healing resolver was added in this slice.

> **P1 detail editors, 2026-09-08 (D-116):** armor components, string-list feats/traits
> and conditional descriptive monster details now have authorized editors. Published AC
> totals and structured imports are preserved rather than silently converted. Missing-parent
> first-edit Ops were repaired. Weapon/richer HP/ER editors and browser acceptance remain
> open; see unified TODO S02/S03 progress for exact scope and evidence.

> **P1 follow-up, 2026-09-08 (D-115):** WindowHost sheets and linked-token double-click
> are now implemented for GM and player paths, with live projected-store refresh and
> revocation/deletion handling. S01/S04 await actual browser acceptance; full editor
> fields and battle-analysis mounts remain open. See `PF1e_Unified_TODO.md` for evidence.

> **P1 progress, 2026-09-08 (D-114):** §1.7's PF1e actor sheet is now reachable from the
> normal Sheets panel for GM and players, using authored `system.pf1e`, the P0 derivation
> and authorized submit Ops. This is a partial closure: floating windows/token double-click,
> full editor fields and battle-analysis mounting remain open. See the unified checklist
> S01–S04 for exact scope and verification; browser flow has been collected, not run.

> **Build order, data contracts and PR slices: `PF1e_ImplementationPlan.md`** (2026-09-08). This file
> stays the rule-by-rule inventory and the verified SRD numbers (Appendix A); that file is the plan.
> Rows closed here are accounted for there — do not re-plan from this table.

---

## 0. Verdict

**Fidelity, for the purposes of this document, means four things at once.** A rule counts as
"recreated" only when all of these are true (the acceptance gate for every item below):

1. **The rule exists in code** with the SRD's numbers, not a plausible-looking subset —
   including its *exceptions* (the "unless you have X feat", "does not provoke",
   "no more than one size category larger" clauses are where the fidelity actually lives).
2. **A test cites it** — the test name or a `@srd` doc-tag names the SRD heading, and the
   fixture numbers come from Appendix A, not from the current implementation's output.
3. **Both scales consume the same kernel** — tactical and strategic must be able to resolve
   the identical scenario to identical numbers (§3), so "correct in the sim, absent on the
   sheet" is not a passing state.
4. **It is deterministic** — same seed + same inputs ⇒ same `canonicalPoolHash`, and any
   intentional deviation from the SRD is a named toggle recorded in `DEVIATIONS.md`.

| SRD section | Coverage today | Where it lives now | Target owner (§3 file) | Target test |
|---|---|---|---|---|
| 1. How Combat Works (round, initiative, surprise, flat-footed) | 🟡 30% | `src/core/combat.ts`, `CombatPanel.svelte` | `initiative.ts`, `turnStateMachine.ts` (§4.3–4.4) | `pf1eInitiative.test.ts` (new) |
| 2. Combat Statistics (attack roll, AC, damage, AoO, speed, saves) | 🟡 45% | `pf1e/combatEngine.ts`, `pf1e/schema.ts` | `attack.ts`, `derived.ts`, `damage.ts`, `aoo.ts` | `pf1eCombat.test.ts` (extend) |
| 3. Actions In Combat (the whole action economy) | 🔴 10% | ad-hoc fragments in `combatEngine`/`spells` | `actionCosts.ts`, `turnStateMachine.ts` | `pf1eActions.test.ts` (new) |
| 4. Injury & Death (dying, stable, nonlethal, temp HP) | 🔴 5% | `spells.ts` heal path only | `dying.ts` | `pf1eDying.test.ts` (new) |
| 5. Movement, Position & Distance | ⚪ 0% | nothing PF1e (only `massBattleBasic`'s `move` order) | `movement.ts`, `grid.ts` | `pf1eMovement.test.ts` (new) |
| 6. Big & Little Creatures (space, reach) | 🔴 5% | `envelopment.ts` (reach hard-coded `1.5`) | `grid.ts` + Appendix A.5 table | `pf1eEnvelopment.test.ts` (extend) |
| 7. Combat Modifiers (cover, concealment, flanking, helpless) | 🔴 25% | flanking only — the +2 lands on the attack roll and not on AC (2.2 ✅), and since D-181 it is *derived* from AoN 183's geometry (`flanking.ts`: opposite borders/corners, threatening ally, 0-ft reach) instead of a hand-ticked checkbox; cover, concealment, invisibility and helplessness are still absent | `cover.ts`, `bonuses.ts`, `flanking.ts` ✅ + `threatPreview.ts` ✅ | `pf1eCover.test.ts` (new); `pf1eFlanking.test.ts` ✅, `pf1eThreatPreview.test.ts` ✅, `pf1e_flanking.spec.ts` ✅ |
| 8. Special Attacks (maneuvers, charge, TWF, splash, mounted) | 🟡 25% | `combatEngine.ts:437` (4 of 10 maneuvers) | `maneuvers.ts`, `weapons.ts` | `pf1eManeuvers.test.ts` (new) |
| 9. Special Initiative Actions (delay, ready) | 🟡 20% | `combat.ts:176` delay flag; no ready | `turnStateMachine.ts` + interrupt queue | `pf1eReady.test.ts` (new) |

Two structural facts dominate everything else:

1. **The PF1e rules module is never executed by the app.** `createMassBattlePf1e()`
   has no importer outside its unit test; `App.svelte:234`, `sim/runner.ts:118` and
   `app/e2eHook.ts` all hardcode `createMassBattleBasic()`. The only supported path is a
   *packaged* system (`world.activeRulesPackage` → `manifest.rules.entry`), and
   `systems/pf1e-mass-battles/` ships a manifest with **no `rules.js`**, and
   `systems/pf1e-core/` ships a manifest with **no `module.js` and no `packs/*.json`** —
   so `src/packages/packageLoader.ts` rejects both (it requires every declared entry/pack file).
2. **Hero-level combat has no rules at all.** The tactical side is a generic
   Foundry-like tracker + dice parser; there is no PF1e actor schema, no derived-stats
   engine, no action economy, no grid geometry. `src/ui/sheets/PF1eActorSheet.svelte`
   exposes 9 hand-typed numbers (bab, ac, touchAc, saves, perception, stealth, CL) and is
   **not imported anywhere** (`src/ui/sheets/index.ts` exports only `SheetPanel`);
   `src/ui/armies/PF1eBattleAnalysis.svelte` is likewise orphaned (not exported from
   `src/ui/armies/index.ts`, and `ArmyWindow` only renders `tree|roster|orders|reports`).

So "faithful recreation" is not a matter of tweaking the sim — it is mostly **building the
tactical rules core that doesn't exist yet**, then making the sim consume the same core.

---

## 1. P0 — Blockers: make the module actually run (nothing else is testable until this lands)

> **Status 2026-09-08** (branch `arena/01a07ced-arenastar-vtt`): PR 1 closed 1.2–1.5 (+1.3b) and
> 2.1–2.3 — a deployed PF1e battle compiles profiles, seeds every model and resolves attacks
> against real ACs from a forked PRNG. PR 2 closed **1.1** (+1.1b) — `pnpm build:systems` now emits
> `systems/pf1e-mass-battles/rules.js` and installable zips, and a booted world activates the
> package (`rulesBoot.source === "package"`). PR 3 closed **1.8**: the 10k scale gate now runs
> in Node (`tests/packages/pf1eMassBattleScale.test.ts`) against the same runner the SimWorker
> uses, and the browser half (`e2e/pf1e_mass_battles.spec.ts`) asserts the shipped zips instead of
> a hardcoded object (see §1.11). Still open: **1.6** (joiner schema — needs a wire field, see
> §1.10) and **1.7** (orphaned Svelte mounts).
> §2: 2.1, 2.2, 2.3 ✅.

| # | Task | Target files | Done when |
|---|---|---|---|
| 1.1 ✅ | Emit real package artifacts for the two manifests: `rules.js` (self-contained ESM, `export default <rules object>`), `module.js`, `packs/spells.json`, `packs/bestiary.json`; add a build step that bundles `src/packages/pf1e` into `systems/*/rules.js` (the SimWorker sandbox cannot resolve bare imports — `src/sim/rulesLoader.ts` imports one blob-URL module). | `systems/pf1e-mass-battles/{manifest.json,rules.js}`, `systems/pf1e-core/{manifest.json,module.js,packs/*.json}`, new `scripts/buildSystemPackages.mjs` | `packageLoader.test.ts`-style load of both packages succeeds; GmExtrasPanel → import zip → activate → world reload shows `rulesBoot.source === "package"` with `error === null`. **Met** — the reload half is asserted on the real `bootHostApp` in Node (`tests/packages/pf1ePackage.test.ts`); the panel click itself stays covered generically by `e2e/packages.spec.ts`, and a PF1e-specific browser run belongs to 1.8. |
| 1.2 ✅ | Fix the model-column mismatch: manifest declares 9 columns, `PF1E_MODEL_SCHEMA` has 11 (missing `lethalDmg`, `aooUsed`). Without them, regeneration tracking and AoO budgets silently vanish because `hostBoot` passes `manifest.rules.modelColumns` (not the module's schema) as `simSys`. | `systems/pf1e-mass-battles/manifest.json`, `src/packages/pf1e/schema.ts` | A test asserts `manifest.rules.modelColumns` deep-equals `PF1E_MODEL_SCHEMA`. |
| 1.3 ✅ | Seed PF1e columns at deploy. `src/sim/deploy.ts:~163` allocates only `hp/hpMax = 1` and `sys.ammo = 6`, so `ac/fort/ref/will/sr/dr*/profileIdx` are all zero and `resolvePF1eAttacks` reads `ac === 0` (auto-hit). Also nothing ever writes `profileIdx`, so `registry.get(0)` returns `undefined` and **every attack loop `continue`s before rolling**. Add a `prepare(pool, units, ctx)`/deploy-time compile step that maps `UnitView.stats` + `leaderActors` → profile registry → `profileIdx`. | `src/sim/deploy.ts`, `src/packages/massBattlePf1e.ts`, new `src/packages/pf1e/deploy.ts` | Deploying a PF1e scene yields non-zero AC/HP/`profileIdx` for every model. |
| 1.4 ✅ | Kill the per-turn registry churn: `resolveTurn` calls `registry.register()` once per unit per turn and never `clear()`s, while `profileIdx` is frozen at deploy → ids drift and the registry grows unbounded. Make profiles **content-addressed at deploy time**, immutable during a battle. | `src/packages/pf1e/schema.ts` (`PF1eProfileRegistry`), `src/packages/massBattlePf1e.ts` | N turns → `registry.size()` constant; replay of the same seed is byte-identical. |
| 1.5 ✅ | Restore determinism. `massBattlePf1e.ts:123,172` seed from `Math.random()`, and `pf1e/combatEngine.ts` uses its own LCG (`SimpleRng`) instead of the injected `PRNG`. Both break checkpoint/`canonicalPoolHash`/replay parity (`src/sim/runner.ts` passes `new BulkDice(req.seed)`; `massBattleBasic.ts` correctly uses `rng.fork(unitIdx)`). Thread `rng` (or `BulkDice.forkDice`) into every resolver and delete `SimpleRng`. | `combatEngine.ts`, `spells.ts`, `heroBridge.ts`, `massBattlePf1e.ts` | `tests/sim/replay.test.ts`-equivalent for PF1e: same seed + same ops ⇒ same `poolHash`; `tests/sim/codec.test.ts` still green. |
| 1.6 | Make the joiner replica schema follow the active package instead of hardcoding `MASS_BATTLE_SCHEMA_COLUMNS` (which is `{ammo:"u8"}` only). | `src/app/joinBoot.ts:216-227`, `src/app/hostBoot.ts:433-443` (announce the active schema), `src/client/sync.ts` | A second browser joining a PF1e world renders correct HP/AC deltas. |
| 1.7 | Mount the two orphaned Svelte components (and keep them out of the bundle if unmounted — the single-file build budget is 6 MB, `scripts/size.mjs`). | `src/ui/sheets/index.ts`, `src/ui/sheets/SheetPanel.svelte`, `src/ui/armies/index.ts`, `src/ui/armies/ArmyWindow.svelte` | PF1e sheet opens for `actor.type === "character"` in a PF1e world; Analysis tab appears in ArmyWindow. |
| 1.8 ✅ | Replace the stub e2e. `e2e/pf1e_mass_battles.spec.ts` asserted a hardcoded `{ok:true,hits:15}` and never ran the sim. | `tests/packages/pf1eMassBattleScale.test.ts` (new), `e2e/pf1e_mass_battles.spec.ts`, `package.json` (`test:e2e` builds the packages first) | **Met, split in two** (§1.11). Scale + fidelity half runs in Node on the same `SimRunnerCore` the SimWorker uses: 10 000 models through the real `deploySnapshot`, 4 warm-up + 24 measured turns, `bytesPerModel = 66.00` (≤ 200), a full 10k checkpoint inside 1.5 MB, `console.error`/`console.warn` call counts 0, and determinism asserted on the **decompressed** delta and checkpoint wire. Measured p95 ≈ 45–50 ms for 20×500 (inside §19's 50 ms on this box, missed by the dense 40×250 shape) — so the test prints the distribution and gates at 250 ms rather than asserting a machine-dependent number. Browser half keeps what only a browser can prove: the built `rules.js` imports in a real Worker, activates, takes the rules slot, unloads cleanly, and no `pageerror`. |

| 1.3b | **(new, found while doing 1.3 — FIXED)** `i8` is in `ModelColumnType` and in both PF1e declarations (`fort`/`ref`/`will`) but was **missing from the codec's `ColKind`/`KIND_BYTES`**, so `KIND_BYTES["i8"]` was `undefined`: i8 columns packed to a zero-length buffer (silently dropped from every delta and from the joiner replica) and `canonicalPoolHash` threw `RangeError: Invalid array length` — any module declaring an i8 column crashed at the end of its first turn, PF1e's rules irrelevant. | `src/sim/codec.ts` | `i8` added to the wire kinds (signed, 1 byte) with a snapshot + delta regression test in `tests/sim/codec.test.ts`. Rejected alternative: re-typing the saves as `i16` in `PF1E_MODEL_SCHEMA`, which leaves the platform bug for the next module. |
| 1.1b | **(new, found while doing 1.1 — FIXED)** §12 world-record writes bypassed the persister: `activate`/`deactivate`/`grantTrust`/the migration version stamp called `putWorld(db, …)` directly, while `HostPersister` keeps its own cached copy and rewrites it on every write-behind tick (500 ms) and on close — so an activation silently reverted if any flush happened after it, and the reload-after-activate flow only worked by timing. | `src/storage/persistence.ts`, `src/app/hostBoot.ts` | `HostPersister.patchWorld(patch)` is now the only sanctioned way to change a live world record (it updates the cached copy, and clears keys by omitting them rather than storing `undefined`); pinned by a bypass-vs-patch test in `tests/storage/persistence.test.ts`. |

### 1.9 What shipped, and the two places the plan above was wrong

**Shipped** (all of it inside `src/packages/pf1e/` + `massBattlePf1e.ts`, no core schema change):

- `schema.ts`: `flatFootedAc` + `nonlethal` columns (13 total); `compilePF1eProfile` now derives
  `ac` / `touchAc` / `flatFootedAc` from one `ACBreakdown` instead of taking AC off the unit sheet;
  `PF1eCondition.UNCONSCIOUS` added; `PF1eProfileRegistry` is **content-addressed** (intern by a
  value key → stable id).
- `deploySeed.ts` (new): `sortUnitsForInterning` (deploy's unit order is `Object.keys(army.units)`,
  a persistence artefact — profiles are interned in id-sorted order so `profileIdx` never depends
  on key order), `rawProfileFromUnit` (same derivation as `compilePF1eProfile` but reading raw stat
  keys, so the host can deploy from a `DeploySnapshot`), `buildUnitProfiles`, `seedPF1ePool`
  (writes `hpMax` from the compiled profile, then `deploySnapshot`'s uniform ratio keeps HP intact,
  and stamps `profileIdx` per model).
- `combatEngine.ts`: `resolvePF1eAttacks` takes a `PF1eRng` (bridged off the runner's `PRNG`, so
  `XoshiroPRNG` + `BulkDice` + the `d16/d20/d100` hooks all work), `resolveTargetAc` reads the
  **defender's** profile for flat-footed AC and DR, flanking stops double-counting, minimum damage
  becomes nonlethal, sub-lethal nonlethal accumulates to `UNCONSCIOUS` (and `DEAD` at 0 hp, which is
  what `compactPool` looks for), `resetTurnAoOs` is finally called, `SimpleRng` is `@deprecated`.
- `massBattlePf1e.ts`: profiles + pool are (re)seeded at the top of every `resolveTurn` — cheap,
  idempotent, and it deliberately runs **before** the leadership aura pass, which currently
  accumulates `ac`/`damage`/`saveBonus` into `unit.stats` once per turn (an aura-creep bug this PR
  masks but does not fix — see Gap List §5).
- `spells.ts`: `resolvePF1eSpellAOE` takes the `rng` too (it previously rolled on a
  `Math.random()`-seeded `SimpleRng`).

**Two corrections to the plan above.**

1. **1.2 was understated.** The manifest was missing *four* columns, not two — `flatFootedAc` and
   `nonlethal` are also needed by the fixes in 2.1/2.3. `tests/packages/pf1eManifest.test.ts` now
   pins the manifest against the schema, and deliberately keeps a test asserting that
   `rules.entry: "rules.js"` still points at a file that does not exist, so nobody "fixes" 1.2 by
   quietly dropping the entry.
2. **1.3 had a blocker in front of it** (1.3b above): with the codec's missing `i8` kind, a PF1e
   pool could not survive `canonicalPoolHash` no matter how correctly it was seeded. Fixing 1.3
   without that would have produced a battle that resolves and then throws.

### 1.10 PR 2 — packaging (§1.1), and what it found

- `scripts/buildSystemPackages.mjs` + `pnpm build:systems`: bundles `src/packages/pf1e/rulesEntry.ts`
  with vite into **one self-contained ESM file**, then rewrites the tail into
  `export default (() => { … })();` because `rulesLoader.evalRulesModule` — the fallback for engines
  whose classic workers cannot import module scripts — only accepts that shape. The rewrite **throws**
  rather than emitting a bundle that still contains `import`/`export` statements, so a package the
  SimWorker could not load fails the build instead of the GM. `rules.js` is a build product and is
  git-ignored; each folder is also zipped to `dist/packages/<id>-<version>.zip`, which is what the
  `#pkg-file` input expects.
- `systems/pf1e-core/manifest.json` was **unloadable as declared**: `type: "system"` with a `module`
  block and packs but no `rules` block, and `validatePackageManifest` rejects exactly that
  ("system packages need a rules block"). It is now `type: "data"` with the two packs, and the
  `module.js` declaration is dropped rather than fabricated — the hero-level sheets are in-repo UI
  (§1.7), not a sandboxed iframe module, so there was no `module.js` to write. Inventing one to
  satisfy the manifest would have been the wrong kind of green.
- Seed content packs (this opens §6, it does not close it): `packs/spells.json` (fireball, magic
  missile, shield, true strike) and `packs/bestiary.json` (the six `PRECREATED_PF1E_UNITS`). The
  bestiary speaks in readable names (`dr.bypass: ["magic"]`, `regeneration.suppress: ["fire","acid"]`)
  and a test translates those into the engine's bitfields and requires the **compiled profiles to be
  identical** to the in-repo table, so the pack cannot drift from the code silently.
- `1.1b` (above) was the blocker: without `patchWorld`, "import zip → activate → reload" lost the
  activation on the next flush, so §1.1's acceptance criterion was unverifiable rather than met.
- **1.6 needs more than a code move.** `src/app/joinBoot.ts` hardcodes *both* `simSys:
  MASS_BATTLE_SCHEMA_COLUMNS` and `simSceneId: DEFAULT_SCENE_ID` when constructing `ClientSync`, and
  nothing on the wire announces the host's active package schema — a joiner cannot derive it from
  anything it receives. 1.6 is therefore a protocol change (PROTOCOL.md + host announce + joiner
  adopt before the first sim delta), not an import swap. It stays open on that basis.

**Browser flow at the time:** `e2e/packages.spec.ts` proved the panel-import path for a probe package;
the PF1e package was proven in Node only (`tests/packages/pf1ePackage.test.ts` boots the real
`bootHostApp` with `simRunner` injected — Node has no DOM `Worker`, and `WorkerSimRunner` constructs
fine and only fails at `loadRules`, which would otherwise hide this path entirely). Superseded for
PF1e by §1.11: `e2e/pf1e_mass_battles.spec.ts` now imports the real `dist/packages/*.zip` in a
browser and asserts activation, the `rulesBoot` swap and a clean unload.


### 1.11 PR 3 — the 10k scale gate (§1.8), and the three traps it found

§1.8's acceptance text said "real 10k-model run: p95 < 50 ms, `bytesPerModel ≤ 200`, zero console
errors", to be done in `e2e/pf1e_mass_battles.spec.ts`. Executing it that way is not possible in
every environment, and the parts that *are* portable are not the browser's:

- **Browsers are not there.** This sandbox has no browser binaries and `playwright install` is blocked
  by the network policy, so a Playwright-only gate is unauditable here; `pnpm exec playwright test
  --list` (collect + transpile, 123 tests) is the most any such spec can be validated by.
- **There is nothing to advance in the browser.** The `?e2e` app surface (`src/app/e2eHook.ts`) exposes
  package import/activation and `rulesBoot`, but no deploy or `simAdvance` hook — the §5A readbacks
  (`simCount`/`simVersion`/`turnPhase`/`reportEvents`) live on the *joiner* surface, so an in-browser
  turn needs a second peer. Adding a host-side sim hook is a surface change worth doing only when the
  tactical flow (§4) also needs it.
- **A 50 ms browser assertion is a flake factory.** Turn cost depends on the runner's box, and §19
  budgets exist to catch regressions, not to punish noisy CI.

So the gate is split: `tests/packages/pf1eMassBattleScale.test.ts` runs 10 000 PF1e models through the
real `deploySnapshot` + `InlineSimRunner` (the `SimRunnerCore` code path the SimWorker uses) and asserts
the machine-independent things strictly — `bytesPerModel ≤ 200` (measured 66.00), a full-model 10k
checkpoint ≤ 1.5 MB, `toVersion == turns`, casualties (`Σ rangeDiffs length` > 0 and < 10 000), melee
events actually emitted, `report.rulesVersion`/`subPhases` stamped by the module, `console.error`/
`console.warn` call counts 0, and byte-level replay determinism — while *printing* p50/p95/max and
gating p95 at 250 ms (a ~5× regression fails; noise does not). `e2e/pf1e_mass_battles.spec.ts` keeps the
browser-only half: the built `rules.js` imports in a real Worker and takes the rules slot, a data package
is refused with "data-only", deactivation returns to `builtin`, and no `pageerror` fires.

**Trap 1 — gzip carries a timestamp, so compressed bytes are never comparable.**
`encodeSimDelta`/`encodeSimSnapshot` finish with fflate `compressSync` (gzip), and the gzip header holds
**MTIME**. A first draft of the gate compared `Array.from(deltaBytes)` across two identical runs and
failed ~half the time — with `poolHash`es equal, which reads exactly like "the PF1e sim is
nondeterministic". It is not: the state and the msgpack wire are byte-identical, only the mtime differs.
Determinism assertions must compare `decompressSync(bytes)` (the msgpack wire) or decoded structures.
Nothing else in the repo was exposed: `tests/sim/replay.test.ts` and the codec tests only *round-trip*
(encode → decode → compare fields), and `simReplica.test.ts` compares decoded pools — the trap bites
the moment a test compares two independently produced encodings, which is exactly what a
"replay produces the same traffic" assertion wants to do.

**Trap 2 — the first turn is JIT, not the rules.** Turn 1 of a fresh isolate costs 110–215 ms; turns 5+
settle at ~30 ms. Any perf assert without warm-up turns measures the compiler and fails for the wrong
reason, so the gate runs 4 warm-up turns and drops them from the sample.

**Trap 3 — a 10k brawl ends in three turns.** 500 models at 10 hp vs AC 16/17 and 1d8+3 kills a whole
side by turn ~3; `poolHash` is then stable and late turns emit nothing. "Every turn changes state" is
therefore not an invariant to assert (the first draft asserted `Set(hashes).size == turns` and flaked);
"some turn fought" is. It also means the gate's *fidelity* signal is the early turns — worth pointing
the §4/§5 oracle work at a scenario that does not resolve before the analytics window closes.

**Still open after this PR:** 1.6 (needs the protocol change sketched in §1.10), 1.7 (orphaned mounts),
and the dense-army perf miss recorded in §5 (40 × 250 → p95 54–58 ms over the 50 ms target): fixing it
means cutting per-unit cost, not adding a perf knob to the test.

---

## 2. P1 — Fix rules that are implemented but *wrong* (cheapest fidelity wins)

| # | SRD rule | Current behaviour | Fix |
|---|---|---|---|
| 2.1 ✅ | Flat-footed AC = 10 + armor + shield + natural + misc (no Dex, no dodge) | `targetAcType:"flatFooted"` looks up a **non-existent** column `pool.sys["flatFooted"]` and falls back to the **attacker's** `profile.ac` (`combatEngine.ts:175`) | Add a real `flatFootedAc` column (or derive `ac/touchAc/flatFootedAc` from one bonus breakdown in `schema.ts:compilePF1eProfile`) and select by key with an explicit error on unknown keys. |
| 2.2 ✅ | Flanking = **+2 on the attack roll** only | +2 to-hit (`:206`) *and* −2 to AC (`:176`) — double-counted | Keep the +2; remove the AC penalty; set/clear the `FLANKED` bit from geometry instead of trusting a caller flag. **D-181:** the geometry now exists (`flanking.ts` + `threatPreview.ts`, browser-tested); the tactical appliers still take a caller flag because no sheet flow carries token positions, and the strategic bit is blocked on §5's deploy-spacing prerequisite. |
| 2.3 ✅ | Minimum damage: penalties below 1 ⇒ **1 point of nonlethal** | `Math.max(1, …)` (`:248`, `:420`, `:503`) — always 1 *lethal* | Return `{lethal, nonlethal}`; the nonlethal bucket feeds 2.12. |
| 2.4 | Multiplying damage: only base weapon dice + Str-type bonuses are multiplied; **precision and bonus dice are not** | Crit multiplier is applied by looping dice rolls and re-adding `damageMod`, and `elementalType` bonus dice are never rolled at all | Split damage into `{baseDice, staticMod, bonusDice[]}`; multiply first two only; add bonus dice once (with `Math.max(1, …)` per the SRD). |
| 2.5 | Threat range (19–20, 18–20 …) and multipliers ×2/×3/×4 | single `critThreatMin` from the profile, no Improved Critical / expanded-range sources, no ×4 auto-threat for firearms | Threat range as data on the weapon + feat modifiers; `d20 >= threatMin && hit` ⇒ confirm. |
| 2.6 | Melee/ranged attack bonus = BAB + **Str**/**Dex** + size + misc | `compilePF1eProfile` bakes `BAB + strMod` into `iteratives` (`schema.ts:160-168`) and adds `enhancementBonus` at roll time; ranged units use Str, size modifier is never applied to attacks | Derive per-weapon attack bonus; apply `sizeMod`; ranged uses Dex. |
| 2.7 | Damage bonus: 1½× Str two-handed, ½× off-hand (penalty not halved), +enhancement | `damageMod = weapon.damageMod + strMod`, flat | Apply Str multipliers by weapon handedness + off-hand slot; enhancement to damage too. |
| 2.8 | Ranged attacks: **−2 per full range increment beyond the 1st**; thrown weapons max 5 increments, projectile weapons max 10; beyond max range you can't attack | `rangePenalty` is computed **only inside the firearm branch** (`combatEngine.ts:162-172`); bows/crossbows/spears ignore distance entirely, and there is no max-range cutoff (an unreachable target is still attacked, just unpenalised) | One `rangePenalty(distance, increment, maxIncrements)` helper used by every attack path + an `outOfRange` legality check. |
| 2.9 | Firearms (UC p.135): **early** firearms resolve vs touch AC within the **1st** increment only, **advanced** firearms within the **5th**; both then resolve normally *with* the standard −2/increment; early max 5 increments, advanced max 10; never "a touch attack" for feats like Deadly Aim; loading provokes; capacity limits full attacks | The `touchAc` branch fires for **any** firearm inside 1 increment (so advanced firearms wrongly lose touch AC at 2–5 increments) and the `else if (profile.isEarlyFirearm)` guard means advanced firearms take **no** range penalty at any distance; no max-range check, no capacity/ammo consumption, no `isEarlyFirearm` distinction beyond a defaulted flag | Branch on `isEarlyFirearm`: `increments <= (isEarly ? 1 : 5)` ⇒ touch AC, else `10 + otherACmods − 2 × (min(increments, isEarly ? 5 : 10) − 1)`; reject `increments > max`; decrement `sys.ammo` and block the attack at 0 (SRD: a weapon with no ammunition is impossible to attack with, not merely untrained). |
| 2.9b | Misfire (UC p.135): natural result ≤ misfire value ⇒ auto-miss + weapon gains **broken**; while broken the misfire value rises **+4** (+2 with Gun Training); a **second** misfire of a broken early firearm **explodes** (burst from a chosen corner, damage as a hit, DC 12 Reflex half, nonmagical weapon destroyed / magical wrecked); advanced firearms never explode; nonproficient loader +4 to misfire values of shots they load; no misfire on a confirmation roll; clearing a misfire is a full-round action (DC 10 + ? — verify) with `Gunsmithing`/Quick Clear variants | `combatEngine.ts:189-198` has the +4 escalation right but (a) stores `MISFIRED\|BROKEN` on the **attacker's `pool.status`** (a condition bit, not the weapon's item state) so it can never be cleared and wrongly survives the fight, (b) never applies the −2 broken attack/damage penalty, (c) no explosion/DC 12 Reflex path, (d) no Gun Training +2 variant, (e) no nonproficiency +4, (f) checked before the hit roll so a natural 20 with a misfire value ≥ 20 would still misfire, (g) `misfireMin` defaults per-profile, not per-weapon+ammunition | Move misfire/broken onto the weapon (`ActorDocument.system.weapons[i].broken`, mirrored to a `weaponState` column for the sim), add a `clearMisfire` action + explosion resolution, and gate the check to `d20 !== 20`. |
| 2.10 | DR/ hardness: bypass per the CRB "Overcoming DR" table — any enhancement ≥ +1 for `/magic`, **+3** for cold iron/silver, **+4** for adamantine (not hardness), **+5** for alignment; special abilities count only toward `/epic` (total effective bonus ≥ +6); ammunition takes the **bow's** magic/alignment for DR but not its enhancement thresholds; **precision damage and stat damage are never reduced by DR**; if DR fully negates the damage, accompanying special effects (poison, disease, stunning) are negated too; hardness applies to objects, not creatures | `isDrBypassed` (`:67-95`) correctly implements +1/+3/+3/+4 and the damage-type flags, but has **no** alignment (`/good /evil /lawful /chaos`) or `/epic` or `/– <material>` forms, treats a `none` material + `enhancement 0` melee weapon as bypassing nothing (fine) yet never distinguishes natural attacks (a creature with DR/magic does not itself count as magic for other DRs — verify intent), reads `drVal`/`drTypeFlags` with an `?? profile.*` / `\|\| profile.*` fallback that silently uses the **attacker's** DR when the defender's column is 0 (`:254-255`), ignores the precision-damage and "full negation kills rider effects" rules, and has no `hardness` column for objects | Encode DR as `{value, bypass: string[]}` data instead of a 7-bit flag field (so `/magic, cold iron` compound forms work), fix the fallbacks to read the **defender's** profile (`defProfile`), apply hardness separately for objects, and skip DR for precision damage. |
| 2.11 | Spell resistance: caster check = 1d20 + CL vs the target's SR; no auto-success on a natural 20 and no auto-fail on a natural 1; once resisted, that spell has no further effect on that target that round; failing to overcome SR does not expend the spell against *other* targets | `spells.ts:139-145` rolls per model per spell and short-circuits with `if (srRoll !== 20 …)`, i.e. it *does* treat a natural 20 as auto-success (not an SRD rule); `spellPenetration` is added even though nothing caps it at +10/+20 and it is never sourced from a feat; `PF1eCombatMetrics.srBlocked` stays 0 because the spell path has its own metrics object | Keep the per-model roll, drop the nat-20 branch, cache "resisted this round" per (caster, target, spell), feed both metric objects from one `resolveSR()` used by tactical + sim. |
| 2.12 | Nonlethal & subdual damage tracked separately; staggered at nonlethal ≥ current hp, unconscious beyond; conversion to lethal at hp max | absent (only `lethalDmg` used for the regen path) | `nonlethal` column + the three thresholds; feed 2.3. |
| 2.13 | Conditions must not collide with the sim's own status flags | `PF1eCondition` bits reuse `1<<0..1<<4`, which are already `ModelStatus.dead/routed/pinned/engaged/hidden` (`src/core/strategic.ts:92-98`); `envelopment.ts` sets `1<<2` (= `pinned`) for flanked; PRONE (`1<<4`) is `hidden`, and `hidden` models are filtered out of every spatial query | Give PF1e conditions their own `u32` column (`status2`) or renumber above bit 8; add a bit-collision unit test. |
| 2.14 | Attacks of opportunity | `resetTurnAoOs()` (`:326`) has **no caller**, so `aooUsed` only ever increases; `resolvePF1eAoO` fires only from the defensive-casting path in `spells.ts` | Call the reset at turn start; drive AoOs from a trigger table (movement out of a threatened square, provoking standard actions, casting, ranged attacks in reach, standing, etc.) shared by tactical + sim. |
| 2.15 | `SpatialGrid` scale | world-unit scale is inconsistent: grid cell = 5, deploy `spacing = 4`, `envelopment` reach default `1.5`, hero aura `radius: 30 / 5`, spell radius `15` treated as world units while described as feet | Define one canonical scale (1 model square = 5 ft = 5 world units, from `ctx.grid.distance`) and derive every constant from it. Add a scale unit test. |

---

## 3. P2 — Build the shared PF1e rules core (the bulk of the work)

Today the "rules" are hard-coded inside array-walking sim loops, so they can't be reused by
the tactical UI and can't be unit-tested per rule. Introduce a pure kernel with **no**
`ModelPool`/DOM dependency, and make both scales call it.

```
src/packages/pf1e/
  tables.ts         SRD constants as data (Appendix A): size modifiers, space/reach,
                    cover/concealment values, TWF penalty table, speed by race+armor,
                    provoke column of Table: Actions in Combat, feat prerequisites
  bonuses.ts        bonus-type stacking rules (untyped & named don't stack with themselves,
                    dodge/armor/size/enhancement/natural/deflection/insight/luck/morale/
                    profane/sacred/circumstance do; armor/ACP penalties; "same source
                    doesn't stack"), and suppression (helpless/invisible ⇒ Dex denied)
  effects.ts        EffectDocument → bonus sources: {mode: add|mul|override|roll, type,
                    origin, duration, concentration-maintained}; the evaluator the repo
                    does not have today (§10 decision 2)
  derived.ts        actor/item data → DerivedStats: BAB iteratives, AC / touch AC /
                    flat-footed AC, Fort/Ref/Will, CMB, CMD, speed, DR/ER/immunity/
                    vulnerability/SR, initiative, per-weapon attack & damage
  weapons.ts        weapon/attack descriptor model: crit range & multiplier, range
                    increments, thrown vs projectile vs firearm (early/advanced), touch,
                    nonlethal, double, reach, trip/disarm/special materials, proficiency,
                    ammo & loading, natural primary/secondary, unarmed (1d3 Medium, −4 to
                    deal lethal, provokes), splash, special ability damage dice
  items.ts          armor/shield/natural armor breakdown (so AC is derived, never typed),
                    broken condition, hardness + item HP for sunder, ammunition
  conditions.ts     the PF1e condition list with its mechanical consequences attached
                    (flat-footed, prone, grappled/pinned, stunned, dazzled, blinded,
                    entangled, shaken/frightened/panicked, sickened, nauseated, exhausted,
                    helpless, unconscious, dying, disabled…) — replaces the current 11-bit
                    enum that collides with ModelStatus (§2.13)
  actionCosts.ts    the action economy table as data: cost (standard / move / full-round /
                    free / swift / immediate / not an action), provoke (bool | "move-only"),
                    replaces-standard-with-move, restricted-activity, legality guards
                    (5-foot step only if unmoved; charge needs a clear line & straight-ish
                    path & no threatened square crossed without care; run = full round,
                    −AC, ends only…; withdraw's first 5 ft)
  turnStateMachine.ts  per-turn budget + interrupt queue: standard/move/full-round/
                    free/swift/immediate, ready-trigger registration, delay,
                    initiative re-count, "start/complete full-round action", and the
                    ordering rule "readied action resolves before the AoO from the same
                    trigger"
  initiative.ts     Dex check with all modifiers, tie-break (higher Dex, then reroll),
                    surprise round, flat-footed-until-first-turn, delayed-actor
                    bookkeeping, optional grouped/modern initiative toggle
  attack.ts         one attack: eligibility (out of range? can't attack invisible?
                    no weapon? prone w/ non-crossbow?) → attack roll → target AC choice
                    (normal/touch/flat-footed) → modifiers (cover, concealment, flanking,
                    stance, size, range, shooting into melee, higher ground) → hit/miss →
                    miss chance roll → crit threat & confirm → damage (per weapon, per
                    hand, per iterative) → DR/ER/SR/resistances → HP/nonlethal/temp
  damage.ts         damage arithmetic in isolation: min-1-becomes-nonlethal,
                    multiplication vs addition, precision & ability damage bypass,
                    DR before hardness, energy resistance per type, immunity, regeneration
  defense.ts        AC assembly from bonuses.ts + DR/ER/SR/hardness queries, and the
                    "denied Dex ⇒ also loses dodge" rules used by both scales
  maneuvers.ts      CMB/CMD resolution shared by all 10+ maneuvers with Appendix A.9's
                    per-maneuver tables, legality (size, free hand, reach, legs),
                    aftermath (movement, prone, broken item, pinned, duration on the
                    condition), improved/greater feat variants, and Aid Another/Feint
  aoo.ts            threatened-square computation + provoke table → AoO budget
                    (1 + Dex if Combat Reflexes, resets on your turn), "one per triggering
                    act", no-AoO cases (flat-footed, total defense, cover, total
                    concealment, 5-foot step, withdraw first 5 ft)
  cover.ts          corner-to-corner cover/concealment/flanking geometry using
                    `ctx.walls.restriction` + `src/core/detection.ts` LOS, incl.
                    soft/partial/improved/total cover and invisible-creature rules
  movement.ts       5-ft grid pathing: space, reach, threatened squares, diagonals
                    ("555" | "5105" | "euclidean" per `ctx.grid.diagonals`), difficult &
                    darker terrain multipliers, obstacles, squeeze, minimum movement,
                    moving through/into occupied squares, illegal-ending correction
  spells.ts         components, casting time, provoke & defensive casting, concentration
                    (DC 10+damage+level, 15+2×level), armor check/spell failure, hold the
                    charge, ranged touch, target/area shape rasterisation (cone, line,
                    burst, spread, cylinder), Evasion, SR, spell resistance per round,
                    "one spell per round", swift/quickened, metamagic time
  feats.ts          the combat-feat subset that changes math or legality: Combat Expertise,
                    Improved Initiative, Combat Reflexes, Power Attack, Deadly Aim,
                    Two-Weapon Fighting tree, Improved {Trip,Disarm,Bull Rush,Sunder,
                    Grapple,Overrun,Dirty Trick,Reposition,Steal,Drag} + Greater,
                    Weapon Focus/Specialization/Finesse, Toughness, Iron Will/Great Fortitude/
                    Lightning Reflexes, Improved Critical, Point-Blank Shot/Precise Shot/
                    Manyshot, Improved Unarmed Strike, Improved Bull Rush, Mounted Combat/
                    Ride-By Attack/Trick Riding/Mounted Archery, Gun Training,
                    Great Curvature, Brawler/Defensive Combat styles as needed
  rolls.ts          glue to `src/dice/engine.ts`: validate + compile formulas once,
                    `@path` substitution against actor data, and a `RngFn` port so the
                    kernel is deterministic in both scales (kills `SimpleRng`)
  simAdapter.ts     ModelPool ⇄ kernel bridge: read/write sys columns, intern profiles
                    (content-addressed, deploy-time), per-turn reset of aoo/conditions,
                    metrics feeding `analytics.ts`
```

Two constraints the kernel must respect, from the platform rules already in the repo:
the sim-side build of this directory has to become a **self-contained ESM blob** with no
bare imports (D-086 / `src/sim/rulesLoader.ts` loads a single module), and every field the
sim mutates must live in a declared `modelColumns` entry (`packageManifest.ts` validates the
manifest's column types and `hostBoot` uses the manifest — not the module — as the deploy
schema). That is why `tables.ts`/`bonuses.ts` are data-and-pure-functions only: no DOM, no
document stores, no `Math.random`, no `Date.now`.


Everything in `tables.ts` is data, so both `resolvePF1eAttacks` (sim, one model-pair)
and the tactical chat/roll flow (single actor) consume identical numbers. `SimpleRng`
goes away: the kernel takes an `RngFn` (`src/dice/bulk.ts` already exposes
`nextFloat/roll(formula,data)/forkDice` and is Xoshiro-identical).

---

## 4. P3 — Tactical (hero-level) implementation list

Faithful hero-level combat means the full chapter. Ordered as it should be built:

1. **Actor schema + compendium-backed derived stats.** Real `system` block for PF1e
   (abilities, HP/temp/nonlethal, armor/shield/natural/deflection/dodge breakdown, feats,
   class levels/BAB progression, save good/bad, speed, size, DR/ER/SR/immunities,
   weapons/ammo/armor items, spellbook slots/CL/DC).
   Files: `src/packages/pf1e/derived.ts`, `src/core/documents.ts` (already generic — keep),
   `src/ui/sheets/PF1eActorSheet.svelte`, `systems/pf1e-core/packs/*`.
   🔴 Today: the sheet hand-writes `ac`, so AC drifts from equipment immediately.
2. **Effects engine.** `EffectDocument.changes: [{path, value}]` exists but there is **no
   evaluator** — nothing turns an effect into a stat change anywhere in `src/`. Need
   Foundry-like modes (add/multiply/override/roll), stacking by bonus type, source
   suppression, and durability (already partly modelled: `coreFlags.duration` per turn in
   `src/core/combat.ts:207-247`). Files: new `src/packages/pf1e/effects.ts` + `bonuses.ts`.
3. **Rounds/turns & initiative.** `applyInitiative` takes pre-rolled numbers and
   `CombatPanel.rollInitiative()` rolls a bare `1d20` — no Dex mod, no Improved
   Initiative, no tie-break-by-total-then-reroll, no surprise round, no flat-footed-before-first-turn,
   no inaction-keeps-initiative, no modern/grouped initiative option.
   Files: `src/core/combat.ts`, `src/ui/combat/CombatPanel.svelte`, new `src/packages/pf1e/initiative.ts`.
4. **Action economy + a turn state machine.** Need per-turn budget tracking
   (std/move/full-round/free/swift/immediate, "move may replace standard", restricted
   activity, 5-foot step only if no other movement) and GM/player UI to spend them.
   `CombatDocument` has no such state → add a `flags.pf1e` block (sanctioned extension
   point per D-077/§0) rather than a new document type.
5. **Grid geometry.** `SceneGrid` already stores `size/distance/units/diagonals` and
   `TokenDocument.width/height`, and walls carry per-axis `move/sight/sound/light`
   restrictions — but nothing in PF1e reads them. Need: space (multi-square creatures),
   threatened squares & reach (incl. reach weapons that can't strike adjacent),
   diagonal cost, difficult terrain/obstacles/squeeze, move-through rules, and the
   "5-foot step doesn't provoke / leaving a threatened square does" hooks.
   Files: new `src/packages/pf1e/movement.ts`, `src/canvas/layers/*` (highlight threatened
   squares), `src/core/detection.ts` (LOS reuse).
6. **Cover/concealment/flanking/helpless.** +4/+2 cover, improved cover +8/+4, total
   cover blocks attacks and AoOs, soft cover; concealment 20%/50% miss chance (non-stacking),
   invisibility (no Dex, +40 Stealth while stationary/+20 while moving), ~~flanking (+2,
   only threatening allies, 0-ft reach can't flank)~~ ✅ **D-181**: `flanking.ts` encodes
   AoN 183 as written — the centre-to-centre line test across opposite borders *including
   their corners*, the multi-square "any square it occupies" exception, threatening allies
   only (read through P02's `threatenedCells`, so reach per size/shape/reach-weapon decides
   it), and the 0-ft-reach exclusion from both AoN 183 and Table 8-4 — with `threatPreview.ts`
   as the scene seam and `pf1e_flanking.spec.ts` proving it in Chromium; helpless
   (Dex 0 → −5, melee −4, coup de grace full-round auto-crit + Fort DC 10+damage or die).
   Files: `src/packages/pf1e/cover.ts`; `flanking.ts` + `threatPreview.ts` landed.
7. **Attacks & damage.** Full `attack.ts` (see §3) replacing the inline math in
   `combatEngine.ts:147-315`; shooting into melee −4 (Precise Shot), thrown/projectile
   max increments, touch spells & held charge, natural primary/secondary attacks,
   unarmed strike (1d3 Medium, −4 to deal lethal unless Improved Unarmed Strike,
   provokes), TWF penalty table + double weapons + light off-hand, nonproficiency −4,
   weapon specialization feats.
8. **Combat maneuvers.** Currently `trip|grapple|bull_rush|disarm` only, and even those
   miss SRD details: no size limit (≤1 category larger), no improved/greater feat
   no-provoke, no "target immobile/unconscious ⇒ auto-success", no "+4 vs stunned", no
   CMB attack-roll penalties (cover/concealment apply — maneuvers *are* attack rolls),
   no bull-rush movement/obstacle check, no "disarm fails by 10 ⇒ you drop your weapon",
   no grapple maintain/pin/escape/hold-the-chained sequence, no sunder/hardness/`broken`
   item condition, and `cmd` comes from the profile not the live model column.
   Missing entirely: overrun, dirty trick, drag, reposition, steal, aid another, feint,
   combat-maneuver-as-attack-substitution inside a full attack, CMB/CMD special size
   modifier + Dex-instead-of-Str for Tiny-and-smaller.
9. **Injury & death.** `0 hp = disabled` (and the "standard action ⇒ 1 hp after" rule),
   dying round-by-round Con checks with negative-HP penalty, nat 20 auto-stabilize,
   Heal DC 15, coup de grace, temp HP (absorb first, never restored, don't stack from the
   same source), nonlethal thresholds, ability damage/drain, energy drain/negative levels,
   massive damage (optional). Files: `src/packages/pf1e/dying.ts`, `ActorDocument.system`
   writes via ops (`src/core/ops.ts` diff `{ "system.hp": n }`).
10. **Spellcasting in combat.** `spells.ts` covers circle radius, Reflex, Evasion, SR and
    defensive casting; add: real shape rasterisation (cone/line/burst/spread on the grid);
    **delete** the invented "scatter" step (`spells.ts:148-157` shoves *every* model in the
    area 1.0 world units away from the epicentre, before the save is even rolled — there is
    no such core rule, and the displacement also desyncs unit membership/`recomputeRanges`;
    see §10 decision 4); armor spell failure, concentration on taking damage (DC 10 + damage + level, not only when
    casting defensively), casting-spell-provokes vs touch-attack-doesn't, hold-the-charge
    free touch + full attack with up to 6 touch deliveries, swift/quickened, metamagic
    casting time, and the "one spell per round" rule.
11. **Delay & Ready (SRD: "Ready" is a standard action, sets a trigger, resolves as an
    interrupt *before* the trigger, and moves your initiative; unused ⇒ lost action;
    re-ready allowed).** `src/core/combat.ts:176` `delayCombatant()` only flags the
    combatant as skipped for the round; there is no ready action, no trigger evaluation,
    and no initiative re-count. Requires an interrupt queue in the tracker
    (`{turn, substep, interrupts[]}`), which also fixes AoO ordering (§2.14).
12. **Turn-channel/hero bridge back to documents.** `syncHeroTokens()`
    (`src/host/turnChannel.ts:918-950`) only copies the unit anchor → leader token (x, y).
    For real dual-scale play: write model HP/conditions/state back onto the hero
    `ActorDocument`, feed `RulesContext.leaderActors` into the profile compiler, and
    support "In Harm's Way"-style actions (hero leaves formation ⇒ unit loses the
    leadership aura; capture/duel).
    Note `leaderActors` is currently *always* `{}` — every construction site hardcodes it
    (`src/host/turnChannel.ts:211`, `src/ui/armies/armyModel.ts:376`,
    `src/ui/logistics/LogisticsPanel.svelte:85`, `src/app/e2eHook.ts:1519`; declared at
    `src/core/rules.ts:65`), so `applyHeroLeadershipAuras` reads an always-empty
    `ctx.leaderActors` map and the aura path is effectively dead in production.

---

## 5. P4 — Mass-combat (strategic) fidelity

The sim cannot literally run the chapter at 10k models — the plan is to run the **same
kernel per model-pair**, with a documented, measured approximation budget.

- **Per-model d20 loop stays** (that's the current design and it's the right one), but
  must consume `attack.ts`/`defense.ts`, not its own copy.
- **Engagement:** replace `envelopment.ts` "≥2 attackers within 1.5 units ⇒ flanked"
  with real contact geometry — threatened square adjacency, facing, reach per size,
  flanking angle (opposite borders/corners), and a per-round `FLANKED` set/clear
  (`envelopment.ts` currently sets the bit and never expires it). **Status: three of the
  five pieces have landed, and the fourth is blocked on P01.** Per-round set/clear is D-177;
  reach per size is D-180 (each unit's own natural reach, from its leader actor's size and
  body form); the flanking angle rule is D-181's `flanking.ts`, which encodes AoN 183
  exactly and is browser-tested at the tactical scale. It is **not** wired into
  `envelopment.ts`, because at this scale models are points in feet and can share a cell —
  `massBattlePf1e.ts` hashes on `new SpatialGrid(5)` while `src/sim/deploy.ts` spaces
  formations at **4 ft** by default — so a flanker can sit inside the space it flanks and
  the centre-to-centre line has no opposite borders to cross. Applying the test to that
  layout would decide flanking from geometry the rules never describe, and inventing an
  angle heuristic instead is exactly what R03 rejects. **Prerequisite: P01's deploy-spacing
  remainder** (spacing riding the scene grid, one model per cell), after which
  `envelopment.ts` calls `resolveFlanking` with each unit's footprint and reach. Threatened
  square adjacency and facing remain open with it.
- **Movement/orders:** PF1e `resolveTurn` has **no move/shoot/morale sub-phase at all**
  (subPhases are declared but unused) — orders other than `attack`/`custom:spell_aoe`
  do nothing. Need: move (speed × 5-ft cells, terrain cost from `ctx.grid`/walls),
  withdraw/charge/run semantics, shoot (range increments, cover, −4 into melee),
  melee (formation/envelopment), morale (per the mass-combat rules you choose to adopt),
  AoO-of-opportunity on move-through-threat.
- **Hard-coded spell order:** the Fireball block in `massBattlePf1e.ts:146-176` is a
  literal (`x: 10, y: 10, radius: 15, dc: 16, 6d6`) — spells must come from the unit's
  spellbook/profile, and each casting unit needs a `cast` order kind + payload.
- **Hero identification is a magic number:** `massBattlePf1e.ts:76-80` treats "hero" as
  `profileIdx === 4` (i.e. the 4th `PRECREATED_PF1E_UNITS` test fixture) and never consults
  `ctx.leaderActors` / `UnitView.leaderTokenId`, which is always empty (see §4.12) — so
  heroes are undeployable in real play even after 1.3 lands. Real hero auras/cleave need
  `unit.leaderTokenId` → actor document → `Leadership` feat as the data path, plus: aura
  radius from feat data and aura applied **once per turn** (today it runs inside a
  per-model loop and mutates the `fort`/`will` columns cumulatively every turn — a runaway
  bonus), and Cleave should be a second attack (SRD Cleave = one extra attack at your full
  BAB against an adjacent enemy), not "overkill damage carried over".
- **Analytics:** `PF1eCombatMetrics.srBlocked/aooExecuted/aooHits/cmbSuccesses` and
  `UnitAnalyticsSummary.deathsCount/damageHealed` are declared but never incremented, so
  the report under-reports; `exportAnalyticsToCsv` (`analytics.ts:170`) is unquoted
  (a comma in a unit name corrupts the CSV) despite the work plan's "RFC-4180" claim; and
  `generateReport()` is never called by the module — the report only exists in a test.
- **Perf guardrails (measured 2026-09-08 on the PR-3 branch, one Node isolate):** `bytesPerModel`
  for the 13-column `PF1E_MODEL_SCHEMA` is **66.00 B** → 660 kB of pool at 10k, inside §19's 200 B
  budget with room for the data-shaped additions (§2.10 DR, §2.13 `status2`) still to come. A turn's
  `checkpointBytes` is ~8.6–10 kB compressed and the deltas after the fighting settles are ~0.
  Turn cost after 4 warm-up turns (the *cold* first turn is 110–215 ms of JIT, not rules):
  **20 units × 500 → p50 30 ms, p95 45–50 ms**; **40 × 250 → p50 48, p95 54–58**; **8 × 2500
  (20k models) → p50 62, p95 75**. Two findings worth keeping: the army *shape* moves the number as
  much as the model count does (per-unit work — profile lookups, `resetTurnAoOs`, bookkeeping — so
  2× the units at the same 10k models costs ~1.2×), which means §19's p95 < 50 ms at 10k is met
  by the sparse shape and **missed** by the dense one; and scaling is sub-linear in models, so the
  lever for 10k is per-unit cost, not the pool layout.
- **`Math.hypot` is the only transcendental in the PF1e sources** (`combatEngine.ts:144`, tactical
  `gridDistance`). Keep it out of 10k hot loops: besides the cost, engines are free to implement
  `hypot` with different precision, so `===` on its result is not portable.

---

## 6. P5 — Content & data (you cannot be faithful without the tables)

- `tables.ts` SRD data set: size modifiers (Fine +8 … Colossal −8) applied to attacks *and*
  AC; special size modifier for CMB/CMD (Fine −8 … Colossal +8); space/reach; tactical speed
  by race/armor (dwarf/gnome/halfling 20 ft, 15 ft in medium/heavy, human/elf 30 → 20);
  cover table (+4/+2, improved +8/+4, soft, partial +2/+1, total); concealment (20%/50%);
  TWF penalty table; weapon properties (crit range/mult, range increments, type, special:
  brace, disarm, trip, reach, touch, nonlethal, monk, performance, disabled…); armor
  (AC bonus, max Dex, ACP, ASF, weight, armor bonus to CMD via armor); DC table for the
  "Actions in Combat" provoke column (transcribed in Appendix A.6).
- `systems/pf1e-core/packs/`: bestiary + spells + equipment + feats as compendium JSON
  (`src/core/compendium.ts` `parseCompendiumPack`, cap `COMPENDIUM_MAX_ENTRIES = 2000`)
  so units/actors stop being hand-typed numbers.
- `PRECREATED_PF1E_UNITS` (`schema.ts:243-306`) should be generated from/validated
  against those packs rather than being the source of truth.

---

## 7. P6 — Verification strategy (fidelity is only real if it's asserted)

1. **Per-rule unit tests with SRD-quoted numbers.** One file per kernel module; each test
   name cites the SRD heading (e.g. `"Combat Modifiers > Cover: +4 AC, +2 Reflex"`).
   Extend the existing `tests/packages/pf1e*.test.ts` set (currently 8 files, mostly
   happy-path smoke tests of the sim-shaped API).
2. **Table-driven tests** for: size modifier, space/reach, TWF penalties, provoke column
   (Table: Actions in Combat), saves/DC formulas, cover/concealment stacking, and the
   `Table: Attack Roll Modifiers` / `Table: Armor Class Modifiers` rows verbatim.
3. **Oracle tests:** a fixed 500-line JSON corpus of worked examples (attacker with
   1d8 longsword +4 Str vs AC 18 with −2 from Combat Expertise, DR 5/silver, etc.) whose
   expected hit chance and average damage are computed independently; assert the kernel's
   Monte-Carlo output matches within tolerance at 100k seeded iterations (deterministic —
   seeded PRNG), and assert exact expected values for single-roll paths.
4. **Determinism/replay/checkpoint parity** for PF1e (after 1.5), plus `deploy` schema
   tests (after 1.3) and the manifest-vs-schema equality test (after 1.2).
5. **E2E:** activate the `pf1e-mass-battles` package from GmExtrasPanel, deploy 10k,
   run 20 turns, assert no `rulesBoot.error`, perf gate, then a tactical scenario:
   2 PCs vs 3 goblins asserting initiative order, surprise round, a 5-foot step, a
   provoked AoO, a charge (−2 AC/+2 attack, no full attack), cover +4, concealment
   miss chance, trip attempt, and dying/stable at negative HP.
6. **Rules coverage dashboard:** a generated matrix (test-name → SRD heading) so "what's
   left" is measurable instead of remembered. Cheap: `scripts/coverage.mjs` reading
   `@srd` doc tags from the test files.

---

## 8. Explicitly out of scope (defer, but list so the gap is known)

- 3PP content that d20pfsrd interleaves into the chapter (Scars & Wounds, Crippling
  Damage variants, "Blind Opponent / Entangle / Garrote / Sap / Taunt / Throw Opponent /
  Torment / Unbalance / Seize Massive Attack / Hinder Natural Attack / Hinder Special
  Ability / Impede Movement" maneuvers, Combat_Options Overview from PZO9468 beyond the
  non-combinability rules) — mark `flags.pf1e.thirdParty = true` and gate behind a world
  setting if ever needed.
- Optional rules: Massive Damage, Tactical/Modern initiative grouping, Facing,
  Knockback, Overrun while mounted, Pursuit, Illusion/Invisibility sub-rules —
  implement as world-setting toggles, not defaults.
- Non-Combat-chapter systems the rules lean on: skills other than Acrobatics/Heal/Ride/
  Stealth/Perception/Bluff/Sense Motive/Spellcraft/Craft (weapon maintenance), full
  spell list, equipment pricing, crafting.
- Visual/UX polish (animated tokens, template drag-and-drop) — needed for playability,
  not for fidelity.

---

## 9. Suggested sequencing

| Milestone | Contents | Why first |
|---|---|---|
| **M0 (1–2 d)** | 1.2, 1.5, 1.6, 2.13 | Determinism + schema correctness; every later test depends on them |
| **M1 (3–5 d)** | 1.1 ✅, 1.3 ✅, 1.4 ✅, 1.8 ✅ (§1.11) → **1.7 left** | PF1e runs in-app; the scale gate is green in Node, the browser half asserts the shipped zips |
| **M2 (1–2 w)** | §3 kernel + 2.1–2.11, tables.ts | The single source of truth; fixes most 🔴 rows cheaply |
| **M3 (1–2 w)** | §4 items 1–4 (actor schema, effects, initiative, action economy) | Unblocks hero-level play |
| **M4 (1–2 w)** | §4 items 5–7 (grid geometry, cover/concealment, attacks) | The "positioning" half of the chapter |
| **M5 (1 w)** | §4 items 8–10 (maneuvers, dying, spellcasting) | The "consequences" half |
| **M6 (1 w)** | §4 item 11–12 + §5 (delay/ready, hero bridge, sim re-use) | Closes dual-scale loop |
| **M7 (1 w)** | §6 content packs, §7 oracle/coverage | Makes fidelity measurable & maintainable |

Acceptance: every ✅ row of the §0 table is backed by at least one cited test, and the two
remaining 🔴/🟡 rows are either fixed or recorded as an explicit deviation in `DEVIATIONS.md`
(currently there is **no** PF1e entry in `DECISIONS.md`/`DEVIATIONS.md` at all — the whole
patch is undocumented, which is itself a gap worth closing).

---

## 10. Open decisions — I need your call before writing code

1. **Which scale is the authority?** Proposal: the tactical (hero-level) kernel in §3 is
   the normative implementation of the chapter, and the 10k-model sim is a documented
   *approximation* of it (with a parity test that measures, rather than hides, the drift).
   The alternative — making the sim normative — means the chapter gets simplified for
   everyone, including the single-actor UI.
2. **Where do bonuses live?** `EffectDocument` currently carries
   `changes: [{ path, value }]` with **no mode, no bonus type and no duration**
   (`src/core/documents.ts`), and nothing in `src/core/` evaluates it. Faithful PF1e needs
   typed stacking (dodge/armor/size/enhancement/…, "same type doesn't stack, except
   bonuses of different types"). Extend `EffectDocument` with
   `mode: "add" | "mul" | "override" | "roll"`, `type: BonusType`, `origin`,
   `duration: { turns | concentration | instant }`? That touches every other module's
   effects, but it makes PF1e derivable instead of hand-typed. (Recommended: yes, plus a
   migration in `src/core/migrations.ts`.)
3. **Ship PF1e as a real package or a trusted in-repo system?** §1.1 has two endings:
   (a) a `scripts/buildSystemPackages.mjs` step that bundles `src/packages/pf1e` into
   `systems/*/rules.js` + `module.js` + `packs/*.json` and loads it through
   `packageLoader`/`rulesLoader` like any third-party module (honest, slow, exercises the
   plugin boundary, needs a trust grant in `GmExtrasPanel`); or (b) an in-repo trusted
   path that imports `createMassBattlePf1e()` directly from `App.svelte`/`joinBoot`
   (fast, and permanently diverges from what a third-party pack author can do).
   I'd start with (b) behind a `PF1E_TRUSTED_SYSTEM` seam to unblock M1, and land (a) as
   the real deliverable in M2. Your call on whether (b) is acceptable even temporarily —
   it does conflict with "everything is a package".
4. **Which optional/house rules become `worldSettings` toggles, and what is the default?**
   Massive damage; disabled-at-0-HP variant; facing; partial cover (+2/+1);
   auto-confirm criticals; grouped initiative; the `spell scatter` behaviour currently in
   `spells.ts` (there is **no** such core rule — successful Reflex saves do not move a
   target, and today it displaces *every* model in the area *before* the save is rolled,
   which also desyncs `recomputeRanges`); the Fireball-at-(10,10) test spell. Defaults
   should be core-strict with each variant explicitly flagged in `DEVIATIONS.md`.
5. **First PR scope.** Proposed: §1 items 1.2/1.3/1.4/1.5 + 2.1/2.2/2.3 — "make PF1e
   actually fight, and stop the AC math lying" — with a new
   `tests/packages/pf1eDeploySeed.test.ts` and the manifest/schema equality test, and *no*
   new rules surface. OK to cut it there, or do you want the e2e (1.8) in the same PR?

### 10.1 Decisions — answered 2026-09-08 (implemented by PR #4)

1. **Scale authority: two independent implementations.** Tactical (ActorDocument /
   CombatDocument / grid) and strategic (ModelPool / SimWorker) each implement the chapter on
   their own; parity is a convention, **not** a gate. This overrides the recommendation above,
   so §3 is downgraded from "shared kernel + parity test" to *shared data and tables only*
   (`schema.ts` constants, SRD modifiers, condition/DR/weapon enums), and §0's gate item and
   §4's "kernel" wording read as "same numbers", not "same code". Accepted risk: the two scales
   can and will disagree in edge cases, and the strategic layer keeps grid-quantised
   abstractions where exact tactical bookkeeping would cost 10 000× the work.
2. **Packaging: trusted in-repo first, real `systems/*` build as M2.** Importing
   `createMassBattlePf1e()` behind the trusted seam stays the M1 path (it is how the tests run
   today); 1.1's bundling step is a first-class M2 deliverable rather than a prerequisite.
3. **No core `EffectDocument` changes.** `mode`/`type`/`origin`/`duration` are **rejected**: no
   change to `src/core/documents.ts`, no migration, no effect on any other module. PF1e owns its
   typed bonuses in its own data (actor system data / `flags.pf1e`) and models stacking via
   `source` + `name` collision groups in PF1e code. This retires core PRD items **P-12, P-13,
   P-14** and removes the only migration hazard in the whole plan; §4 rows 7 and 10 (partly) and
   the size-cap row now describe PF1e-side structures.
4. **First PR = 1.2 + 1.3 + 1.4 + 1.5 + 2.1 + 2.2 + 2.3**, with
   `tests/packages/pf1eDeploySeed.test.ts` and the manifest↔schema equality test, no new rules
   surface, no dependency on 1.1's bundling; the 1.8 e2e rewrite explicitly deferred. Cut as
   proposed, plus one item pulled in when it turned out to block 1.3: the codec's missing `i8`
   wire kind (row 1.3b above).
5. **Decided (R03/D-130, 2026-09-09):** the invented spell **scatter** (`spells.ts`) is
   **removed** — no core-rule basis. It is not becoming an opt-in setting; it may return only
   as a named `worldSettings` toggle if a mass-battle consumer asks (none today). Filed as
   DEVIATIONS D-1 with the P5 removal.

### 10.2 P0 contracts landed (PR-A, D-113) — what the shared tables changed, and what they did not

`src/packages/pf1e/rulesTables.ts` is now the single place the SRD *numbers* live, per decision 1
(data shared, kernels not). It deliberately does **not** rewrite `compilePF1eProfile`: three known
strategic deviations survive in it, each now visible and each with a fix phase, because changing them
would move 10 000-model fixtures with no tactical need:

1. **AoO budget.** `maxAoos: 1 + max(0, dexMod)` (schema.ts) vs A.10's *one per round; extra
   AoOs equal to your Dex bonus only with Combat Reflexes (which also permits AoOs while
   flat-footed)*. `attacksOfOpportunityPerRound()` encodes the
   correct rule for the tactical path; the strategic one switches in P8, together with the analytics that
   let the diff be read as a scale-fidelity trade-off rather than a guess.
2. **CMB/CMD size.** `sizeMod` (the generic attack/AC ladder) where A.4 mandates the *special* size
   modifier. The tactical path uses the special ladder; a stat block that publishes only `sizeMod` keeps
   it, and `normalizePF1eSystem` records that in `converted` so the difference is visible per document
   rather than averaged away.
3. **Saving throws.** The sim uses the published number alone (`fort ?? 0`), the tactical rules add the
   ability modifier the SRD says a save contains. `tests/packages/pf1eActor.test.ts` pins the exact
   relationship (`tactical == strategic + conMod`) so the gap cannot widen before P8 unifies the compile.

Item 5 above is decided: the invented spell **scatter** is not getting a toggle in P0. R03
(D-130) resolved it — **remove**, with the SRD-fidelity path saving where the model stands — and
`DEVIATIONS.md` now indexes the two live code deviations with their correction paths: the scatter
(D-1, P5 removes it) and the hard-coded Fireball `radius: 15` against the pack's 20-ft baseline
(D-2, P5 makes spells profile-driven; 20 ft is the agreed baseline).

---

## 11. Appendix A — the SRD numbers to encode (fixture tables)

Transcribed from the SRD Combat chapter on 2026-09-07 so implementation and tests don't
need to re-read the page. Every row below should become a table-driven test (§7.2).

**A.1 The round & initiative** — 1 round = 6 s ≈ 1 melee attack. Initiative = Dex check
(+ modifiers from feats/magic/abilities, e.g. Improved Initiative; verified CRB p.178);
ties: the tied characters act in order of **total initiative modifier** (highest first —
not "Dex bonus": Improved Initiative counts), then reroll. You're flat-footed until your
first turn (uncanny dodge excepts). Surprise round happens when some but not all
combatants are aware; only the **aware** combatants act, each taking one standard or move
action (plus free actions) in initiative order; the unaware do not act and are
flat-footed. **Delay** (CRB p.203, AoN ID 200): act normally at any lower count you
choose (full action economy — no lost standard); your initiative permanently becomes the
count you acted on; you can't interrupt others and never regain the waited time; if you
reach your next turn without having acted, you may delay again. **Ready** (CRB p.203,
AoN ID 201): standard action (does not provoke) to prepare a standard/move/swift/free
action (never full-round) with a trigger; the readied action resolves *just before* the
trigger, interrupting it; your initiative permanently becomes the count immediately
ahead of the triggering creature; if the trigger hasn't happened by your next turn, the
readied action is lost (you may ready again); a 5-foot step may accompany it if you
haven't otherwise moved. Mid-combat reordering happens **only** through delay/ready —
a later ability change (e.g. a Str or Dex buff) never rewrites an initiative result.

**A.2 Attack roll** = 1d20 + BAB + Str (melee)/Dex (ranged) + size + misc; natural 20 =
automatic hit (and a threat), natural 1 = automatic miss. Target AC: melee =
10 + armor + shield + Dex + natural + size + misc; touch = 10 + **Dex** + size + misc
(dodge applies; only armor/shield/natural are lost — verified CRB p.189); flat-footed
= 10 + armor + shield + natural + size + misc.

**A.3 Damage** = weapon dice + Str (½× off-hand, 1½× two-handed *only for the bonus*,
enhancement, power-attack style trade-offs). Penalties that reduce damage below 1 ⇒
**1 point of nonlethal**. Multiplying damage: multiply dice + static bonus, never
precision/bonus dice; multiple multipliers **add** (×2 and ×2 ⇒ ×3, not ×4).

**A.4 Size modifiers** (attack, AC, CMB/CMD special size, stealth, combat manœuvres):
Fine +8/−8 attack·AC… Colossal −8/+8. CMB/CMD special size:
Fine −8, Dim −4, Tiny −2, Small −1, Medium +0, Large +1, Huge +2, Garg +4, Colossal +8.

**A.5 Space & natural reach** (Table 8-4: Creature Size and Scale — re-verified against
AoN Rules ID 179 on 2026-09-12 for P02/D-180: the earlier transcription had Fine at
"1½ ft" where the table prints **½ ft**, and the encoded *square* columns ran one short
for Colossal — 30 ft is 6 squares, not the 5 a "+1 per category" ladder suggests):
Fine ½ ft/0, Dim 1 ft/0, Tiny 2½ ft/0, Small 5/5,
Medium 5/5, Large tall 10/10 · long 10/5, Huge 15/15 · 15/10, Gargantuan 20/20 · 20/15,
Colossal 30/30 · 30/20. Tiny/Dim/Fine: 4/25/100 per square, must enter an opponent's
square to attack (provokes), never flank, never threaten. Large+ with a reach weapon:
strikes up to double natural reach, **cannot** strike within its natural reach — and
Small/Medium with one strike at 10 ft but "can't strike adjacent foes (those within 5
feet)" (AoN 131), i.e. the same band `(natural, 2 × natural]`. As 5-ft squares
(Fine/Dim/Tiny/Small/Medium/Large/Huge/Gargantuan/Colossal): space
0/0/0/1/1/4/9/16/**36**, tall reach 0/0/0/1/1/2/3/4/**6**, long reach —/—/—/—/—/1/2/3/4
(the long column exists only for the four multi-square sizes). Distance is counted
"the first diagonal counts as 1 square, the second counts as 2 squares" (AoN 175), which
is what makes a Medium reach weapon threaten 12 squares and not the 16 a 5-5-5 ruler gives.

**A.6 Table: Actions in Combat** (Table 7-2, CRB p.182 — re-verified against AoN Rules
ID 128 on 2026-09-09 for T05/D-131; the 2026-09-07 transcription had wrong provoke
flags — run was "no", mount/dismount "yes" — and invented rows like "snipe", "remove
curse" and "draw a weapon and move", and is replaced wholesale by the verified table
below). The provoke column answers "does the **action itself** provoke" — moving out of
a threatened square usually provokes regardless of the action (table footnote 1).

- **Standard actions** (provoke?): attack (melee) **no** · attack (ranged) **yes** ·
  attack (unarmed) **yes** · activate a magic item other than a potion or oil **no** ·
  aid another **maybe** (provokes if the aided action provokes) · cast a spell
  (1-standard-action casting time) **yes** · channel energy **no** · concentration to
  maintain an active spell **no** · dismiss a spell **no** · draw a hidden weapon
  (Sleight of Hand) **no** · drink a potion or apply an oil **yes** · escape a grapple
  **no** · feint **no** · light a torch with a tindertwig **yes** · lower spell
  resistance **no** · read a scroll **yes** · ready **no** · stabilize a dying friend
  (Heal) **yes** · total defense **no** · use extraordinary ability **no** · use skill
  that takes 1 action **usually** · use spell-like ability **yes** · use supernatural
  ability **no**.
- **Move actions:** move **yes** · control a frightened mount **yes** · direct or
  redirect an active spell **no** · draw a weapon **no** (BAB +1: combine with a
  regular move; Two-Weapon Fighting draws two light/one-handed weapons) · load a hand
  or light crossbow **yes** · open or close a door **no** · mount/dismount a steed
  **no** · move a heavy object **yes** · pick up an item **yes** · sheathe a weapon
  **yes** · stand up from prone **yes** · ready or drop a shield **no** · retrieve a
  stored item **yes**.
- **Full-round actions:** full attack **no** · charge **no** (may be taken as a
  standard action when limited to a single action — then only up to your speed, and no
  weapon draw without Quick Draw; +2 attack / −2 AC until your next turn, verified
  D-129) · deliver coup de grâce **yes** · escape from a net **yes** · extinguish
  flames **no** · light a torch **yes** · load a heavy or repeating crossbow **yes** ·
  lock or unlock a weapon in a locked gauntlet **yes** · prepare to throw a splash
  weapon **yes** · run **yes** · use skill that takes 1 round **usually** · use a touch
  spell on up to six friends **yes** · withdraw **no** (the first 5 ft never provoke,
  the rest of the movement does; you lose Dex/dodge to AC and take −4 AC until your
  next turn; may also be taken as a standard action when limited to a single action).
- **Free actions:** cease concentration on a spell **no** · drop an item **no** · drop
  to the floor **no** · prepare spell components to cast a spell **no** (unless the
  component is extremely large or awkward) · speak **no**.
- **Swift:** cast a quickened spell **no** — one swift per turn.
- **Immediate:** e.g. cast *feather fall* **no** — usable off-turn; then your next turn
  has no swift action.
- **No action:** delay **no** · 5-foot step **no**.
- **Action type varies:** perform a combat maneuver **yes** (many substitute for a
  melee attack — usable in an attack, charge or full attack, or as an AoO) · use feat
  **varies**.
- **Action types (CRB p.181):** a normal round = one standard + one move, **or** one
  full-round action, plus one swift and any number of free actions; a move action may
  always substitute for the standard; **restricted activity** (surprise round,
  staggered, slowed) = a single standard OR a single move action, plus free and swift
  actions as normal — no full-round action, but a full-round action may be **started
  or completed** with a standard action (CRB p.185; full attack, charge, run and
  withdraw can never be split); swift actions are legal in surprise rounds because a
  swift may be taken anytime you could take a free action.

**A.7 Movement** — 1 square = 5 ft; **5-10-5** diagonals by default (`ctx.grid.diagonals`
supports "555", "5105", "euclidean"); difficult terrain = ×2 per square (×4 double-doubled,
×8 triple-doubled); squeezing = 2 squares of movement per square entered, −4 to attack,
−4 to AC; minimum-movement full-round action = 5 ft (provokes, is **not** a 5-foot step);
you can never end movement in an illegal square; leaving a threatened square provokes.
5-foot step: allowed only if you (and your mount) have not moved at all this turn.

**A.8 Cover / concealment** — cover: +4 AC, +2 Reflex, blocks line of effect for total
cover (no attack, no AoO); soft cover: +4 AC only; partial cover: +2 AC/+1 Reflex;
improved cover: +8 AC/+4 Reflex (and improved evasion vs the Reflex-halved effect, +10
Stealth); low obstacle: cover only for creatures within 30 ft of it, ignorable if the
attacker is closer. Concealment: 20 % miss chance, non-stacking, d% roll after a hit;
total concealment: 50 % miss chance and no AoO. **Invisible** creatures (CRB
Invisibility): +20 on Stealth checks while moving, **+40 while stationary** (blindsense/
blindsight negates for the observer), total concealment 50 %, defenders are denied Dex
against their attacks and they attack at +2 (A.14). Corner-to-corner geometry (§4.6), and
Large+ creatures pick any occupied square.

**A.9 Combat manœuvres** — CMB = BAB + Str (Dex if Tiny or smaller) + special size + misc;
CMD = 10 + BAB + Str + Dex + special size + misc (AC bonuses of deflection/dodge/insight/
luck/morale/profane/sacred/circumstance transfer; AC penalties transfer; flat-footed loses
Dex to CMD). Nat 20 auto-success (except escaping bonds), nat 1 auto-fail. Manœuvres are
attack rolls → roll for concealment and take all attack penalties. Target
immobilised/unconscious ⇒ auto-success; stunned ⇒ +4. No Improved X feat ⇒ provokes an AoO
from the target; being hit by that AoO adds its damage as a penalty on the manœuvre roll.
Size limit "no more than one category larger" for bull rush/trip/drag/reposition/overrun/
grapple (with the listed exceptions). Per-manœuvre numbers: **bull rush** +5 ft per 5 by
which you exceed CMD, movement must be available, target can't be pushed into a solid
square, intervening creature = new check at −4 per extra creature, no AoO for the pushed
target unless Greater Bull Rush; **trip** fail by 10 ⇒ you fall prone, +2 DC per extra leg
beyond two, oozes/flying/legless can't be tripped, trip-weapon lets you drop it instead;
**disarm** unarmed −4, success ⇒ one item dropped, +10 ⇒ both hands' items (max 2), fail
by 10 ⇒ you drop yours, unarmed success ⇒ you may pick up the dropped item free;
**sunder** damage reduced by item hardness then HP, ≤ ½ HP ⇒ broken, ≤0 ⇒ choose destroy
or leave at 1 HP + broken, an attack of opportunity from a sundered-shield user is not
granted; **grapple** humanoid without two free hands −4, both sides grappled, release as
a free action, maintain as a standard action, +5 circ on subsequent checks vs the same
target, options: move (½ speed) / damage (unarmed, natural, armor spikes, light or
one-handed weapon, lethal or nonlethal) / pin (pinned loses Dex, you keep grappled and
lose your Dex bonus) / tie up (DC 20 + your CMB, −10 to escape while grappling);
escape = manœuvre or Escape Artist vs CMD (no AoO), may instead act with a light/1-handed
weapon; multiple grapplers +2 each via Aid Another; **pin** does not stack with grapple and
one check escapes either; **overrun** target may avoid; success ⇒ pass through, +5 ⇒ also
prone, +2 DC per extra leg; **feint** (not a manœuvre) = Bluff vs 10 + target BAB + target
Wis, or 10 + Sense Motive if higher; −4 vs non-humanoid, −8 vs Int 1–2, impossible vs no
Int; no AoO; Improved Feint ⇒ move action; the next melee attack denies Dex to AC, must be
made on or before your next turn; **aid another** = standard action, DC 10 skill check ⇒
+2 on the ally's next attack or AC (also usable to help escape grapples/bonds);
**dirty trick** conditions limited to blinded/dazzled/deafened/entangled/shaken/sickened,
1 round + 1 per 5 over CMD (Greater: 1d4 rounds, removal costs a standard action), removal
usually a move action; **drag** both combatants move, opponent ends in your former square,
+5 ft per 5 over CMD; **reposition** target must stay in reach except the last 5 ft, never
into intrinsically dangerous space; **steal** free hand required, item selected first,
+5 CMD for sheathed/belt/brooch items, cannot take worn/armored or held items (use disarm),
whip −4, Greater Steal ⇒ target unaware.

**A.10 Attacks of opportunity** — **one per round** (verified CRB p.180/Combat Reflexes
"Normal" text); additional AoOs come **only** with Combat Reflexes: a number of
additional AoOs per round **equal to your Dex bonus**, and the feat also allows AoOs
while flat-footed. (The strategic `maxAoos: 1 + max(0, dexMod)` is a known scale
deviation — §10.2 — not SRD text.) Each opponent gets only one AoO per
triggering action regardless of how many squares/attacks it involves; the budget is per
round; none while flat-footed (without Combat Reflexes), none with total defense, none
against a target with cover, none against a target with total concealment, none against
an incorporeal creature that doesn't have Defending Ghost Style/etc. (treat as "no AoO
against a foe you can't see"); a ranged attack made while threatened provokes; leaving a
threatened square provokes (not with a 5-foot step, not on a successful Withdraw for the
first 5 ft, not after a bull rush/drag/reposition that you didn't cause); standing from
prone provokes; casting provokes (see A.6); manœuvres provoke unless Improved X (or the
target lacks Improved Reaction — do not model); an AoO resolved against a foe that is
attacked twice (e.g. two-handed) uses the appropriate attack. Ready actions interrupt the
trigger and thus act **before** an AoO from the same trigger.

**A.11 Mounted combat** — untrained mount ⇒ DC 20 Ride as a move action each round (fail ⇒
the move becomes a full-round action and you can do nothing else); DC 5 Ride as a free
action to guide with the knees (hands free); +1 on melee attacks vs a foe **smaller than
your mount** that is **on foot** (the higher-ground bonus, verified CRB p.202); if the
mount moves more than 5 ft you can make **only one melee attack**
(no full attack) at the end of the move; lance on a charge deals ×2; ranged weapons at −4
while the mount doubles its speed, −8 while it runs, attack at half-movement, full attack
still allowed; casting while the mount moves both before and after ⇒ concentration DC
10 + spell level, while running (up to ×2 speed) ⇒ DC 15 + spell level; mount falls ⇒
DC 15 Ride or 1d6 damage; you go unconscious in the saddle ⇒ 50 % (75 % in a military
saddle) to stay mounted, else fall for 1d6; the mount acts on your initiative and shares
your space; Large mount occupies 2 squares; "You can use the Ride-By Attack / Trick
Riding feats" ⇒ order: move, attack, continue (Ride-By prevents the AoO).

**A.12 Splash weapons** — ranged **touch** attack, no nonproficiency penalty (they need no
proficiency), direct-hit damage to the target only, splash (1d6 for alchemist's fire etc.)
to every creature within 5 ft of the target square; no precision damage ever; Large+
target ⇒ pick one of its squares; grid-intersection attack = ranged attack against **AC 5**
plus range penalties, splash to all adjacent squares, no direct damage; on a miss roll
1d8 (1 = falls short in a straight line toward the thrower, 2–8 = rotate clockwise around
the target), then move that many range increments and splash there.

**A.13 Injury & death** — 0 HP ⇒ **staggered** (disabled: a single move or standard
action per turn, never both, never full-round; a standard/strenuous action deals you
1 point of damage after completing the act, putting you at −1 and dying — no
check involved; verified AoN ID 164/166); below 0 ⇒ dying: unconscious, no actions, and
**lose 1 HP every round** until dead or stable; each round on your turn, a DC 10
Constitution check to stabilize, with a **penalty on the roll equal to your negative HP
total** (nat 20 = automatic success; fail ⇒ lose 1 HP); another creature can stabilize
you with a DC 15 Heal check (first aid — standard action, provokes); dead when negative
HP ≥ your Con score; a stable character (aided) makes a DC 10 Con check each hour
(same penalty) to wake disabled. Coup de grâce = full-round action vs a helpless
defender (melee weapon, or bow/crossbow while adjacent): automatic hit and critical
hit; if the defender survives the damage, a **mandatory** Fort save DC 10 + damage
dealt or death; delivering it provokes AoOs; creatures immune to critical hits are
unaffected by the critical damage and need not save (verified AoN ID 413). Temp HP:
absorb damage first, never restored by healing real HP; **the same source does not
stack (highest applies), different sources do stack — track them separately**
(Paizo FAQ; CRB p.208 Combining Magical Effects). Nonlethal: tracks separately;
nonlethal damage **exactly equal to** current HP ⇒ staggered, **exceeding** it ⇒
unconscious; dealing nonlethal with a lethal weapon (or lethal with a nonlethal
weapon) takes a −4 attack penalty; healing HP removes an equal amount of nonlethal.

**A.14 Condition-driven attack/AC modifiers** (verbatim from the two modifier tables —
these become `attackRollModifier(state)` / `acModifier(state)` inputs):
attacker dazzled −1/−1, entangled −2/−2 (plus −4 Dex), flanking defender +2/—,
invisible +2/+2, higher ground +1/+0, prone −4/(crossbow or shuriken: 0),
shaken or frightened −2/−2, squeezing −4/−4; defender behind cover +4/+4, blinded −2 (and
loses Dex)/−2 (loses Dex), concealed or invisible see A.8, cowering −2 (loses Dex)/−2,
entangled +0/+0, flat-footed +0/+0 (no Dex), grappling (attacker not) +0/+0, helpless
−4 and Dex 0 (−5) ⇒ −9 melee/+0 ranged, kneeling or sitting −2/+2, pinned −4 (Dex 0)/
+0, prone −4/+4, stunned −2 (loses Dex)/−2, squeezing −4/−4.

**A.15 Total defense (and the two adjacent stances)** — **total defense**: standard
action, +4 **dodge** bonus to AC for 1 round (improves at the start of the action), you
can't attack or take AoOs, and it can't be combined with fighting defensively or Combat
Expertise. **Fighting defensively** and **Combat Expertise** are the two "trade attack for
AC" options in the same family; the SRD's exact numbers for them (and whether the Acrobatics
ranks bump applies) live in the "Standard Actions" text near the top of this page, so
encode them only after re-reading that block — do **not** reuse the sim's current
`+2 AC / −2 to hit` guess. (Nothing in the tree today implements either.)

**A.16 Spellcasting in combat** (all of the following is verbatim-derived from the SRD
page, chunks 12–14) — you **keep your Dex bonus to AC while casting**; casting a spell
provokes an AoO from every threatening enemy, and damage from that AoO forces a
concentration check **DC 10 + damage + spell level** (fail ⇒ spell lost, one check per
injury). Casting on the defensive **does not** provoke and instead forces
**DC 15 + 2 × spell level** (fail ⇒ spell lost; it still counts against your daily limit /
preparation). Spells whose casting time is a free action don't provoke. Spell components:
V is impossible if gagged/`silence`, and a deafened caster has a 20% chance to spoil a
verbal spell; S needs a free hand (impossible while bound/grappled/hands full); M/F/DF
preparation is a free action. Maintaining a spell = standard action, does **not** provoke,
breaks like casting. Touch spells: the touch itself is an *armed* attack and does **not**
provoke (only the casting does); you may move before casting, between casting and touching,
or after touching; touching one friend is free with the casting, or 1 friend as a standard /
up to 6 friends as a full-round while holding the charge; touching anything unintentionally
discharges it; casting another spell dissipates it; making an unarmed/natural attack while
holding the charge **does** provoke and, if it hits, deals normal unarmed damage and
discharges the spell. Ranged touch attacks as part of a spell provoke **twice** (once for
casting, once for the ranged attack) but only once for a multi-ray spell's rays
(Paizo FAQ), and cannot normally be held to a later turn. A 1-round casting time resolves
just before your action on your next turn and can be disrupted each round.
Quickened = swift action (max 1 swift/turn, or 1 immediate).
Evasion: Reflex half ⇒ 0; Improved Evasion: Reflex half ⇒ 0, Reflex fail ⇒ half.
SR: caster-level check **1d20 + CL ≥ SR** — there is **no** natural-20 auto-success and no
natural-1 auto-fail, so today's `if (srRoll !== 20)` short-circuit (`spells.ts:142`) is a
house rule to remove; resistance is overcome once per spell per round ("If you fail to
overcome SR with a spell, the spell is resisted for the rest of the round for that
creature").

**A.17 Damage reduction / energy resistance / spell resistance / hardness** — see 2.10 for
the bypass ladder (+1 magic, +3 cold iron/silver, +4 adamantine but not hardness, +5
alignment, total effective enhancement ≥ +6 for DR/epic, special abilities count only for
epic). **Precision damage (e.g. sneak attack) does NOT ignore DR**: it is part of the
weapon attack's damage total and is reduced by DR together with it (not separately;
Paizo designer clarification, CRB p.562 — DR applies to the whole attack). DR does
negate ability damage/drain, energy damage dealt along with an attack (riders), touch
attacks, and force effects; when DR negates all damage it
negates damage-dependent special effects too. Energy resistance: subtract per damage type,
applies once per attack (not per die). SR: as A.16. Hardness applies to objects only:
damage − hardness, then subtract from object HP; a weapon with hardness 10 (iron) etc.
(see `damaging-objects`), nonlethal never damages objects.

**A.18 Regeneration & death from massive damage** (optional toggles) — massive damage =
single hit ≥ 50 ⇒ Fort DC 15 or die; regeneration: round after taking damage dealt by
listed source, HP return at the start of your turn; acid/fire usually don't regenerate.
(Not part of the Combat chapter proper, but §5 needs it for the sim's `lethalDmg` regen
column — see 2.10/§5.)
