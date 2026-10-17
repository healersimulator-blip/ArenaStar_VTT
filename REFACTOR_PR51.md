# PR51 refactoring and validation

Date: 2026-10-17. Branch: `arena/73e2f72c-arenastar-vtt`.

Scope: the changes introduced by all 17 PR51 commits. The historical review is in
[REVIEW_PR51_2026-10-17.md](REVIEW_PR51_2026-10-17.md). This is a correctness and
maintainability refactor, not a claim of full Foundry/PF1 compatibility.

## Latest unchanged-upstream acceptance status

The real PF1 11.11 fresh-player sheet gate now **passes**. It verifies lossless
Battle Mage/Fireball creation and readback, GM/player preparation-hook checks,
player consent/startup, both actual upstream NPC sheets, usable spell tabs,
and a visible Fireball row for GM and player. This is not casting/damage or
Revert proof; those workflows remain unproven.

Recent shared-layer work includes overridable DataModel configuration/initialization,
post-i18n/setup document preparation, a subclassable text editor with basic HTML
sanitization (full enrichment is not implemented), early window-frame references,
search-filter binding, bounded partial dice-term parsing/formula replacement, and
single-flight asset-index loading. The last fix prevents many simultaneous image
resolutions from exhausting all 32 RPC slots and hiding the rendered sheet.

Remaining observed gaps include custom dice functions, parenthetical dice counts,
minimized synchronous dice evaluation, upstream action-preparation errors, and
other imported gameplay APIs. Do not interpret an empty adapter hook-error list as absence
of upstream internally caught errors. Latest checks: 39 targeted core/roll tests
pass; TypeScript and 99-component Svelte checking pass (three advisories). Broad
regression/security review is still required for the cumulative changes.

### GM versus player spell audit

The Chromium acceptance test opens both upstream sheets and clicks the Spells
and primary-spellbook tabs. Both now render all ten spells, including a visible
Fireball row. The setup explicitly copies the compendium spell with
`system.spellbook = "primary"`, PF1's persisted schema field; PF1 then derives
`system.spellbookId` during preparation. It does not force a derived property or
change module code or permissions. Authoritative readback still compares the full
expected system data, including that deliberate setup assignment.

### PF1 Content conjunction

The pinned PF1 Content **0.3.4** mirror is a data-only module: no scripts or ES
modules, 36 declared packs, with public pack declarations. It targets Foundry 10
and PF1 >=0.82.5; do not equate it with current upstream PF1 Content releases.

The shared catalogue gap is now **resolved** in AIS rather than the test harness.
The existing compendium APIs project approved Foundry data with canonical RPC IDs
and upstream collection aliases. PF1 discovers `pf-content.pf-feats` and resolves
`Compendium.pf-content.pf-feats.Item.2sbyeGrxp179G5dC` directly. The actual FeatModel
is imported and rendered, with description/change formulas preserved in readback.

A fresh-player test verifies late provider sharing, local consent before discovery,
UUID resolution, removal when the GM unshares, and rejection of fresh direct reads.
Private/role-restricted packs are filtered, native GM packs remain host-only, and
cached documents cannot bypass a new permission check. Catalogue documents have
correct compendium identities and read-only sheets/writes. Document-valued reads
reuse bounded 1 MiB chunk transport without raising ordinary frame limits.

See [AIS_CATALOGUE.md](docs/AIS_CATALOGUE.md) for contracts, authority and limitations.
Latest checks: **3 browser tests passed in 10.5 minutes; 2,390 scoped unit/integration
tests passed, 5 pre-existing skips across 168 files**; typecheck and targeted lint
pass. Run `npm run test:e2e:real-users:content:prepare`, then
`npm run test:e2e:real-users:content`. Full-fixture packs remain a subset; automatic
feat bonuses and complete casting/damage/Revert are not established by these tests.

## Changes

- Extracted the CSP-safe arithmetic/dice implementation into `runtime/roll.js`.
  Dynamic evaluation and the zero-on-error fallback are gone. Unsupported expressions
  fail explicitly, with expression/depth/dice bounds. The iframe CSP is unchanged.
- Extracted compendium collections, parsing and UUID resolution into `runtime/packs.js`.
  Index collection identity stays stable across refreshes; requested fields are populated.
  World-pack indexes use bounded, pack-scoped browse pages, not an invalid empty search
  with a limit above the kernel cap. SDK compendium hydration is throttled. UUID resolution
  matches actual pack IDs, including dotted world filenames and optional document types.
- Removed raw LevelDB byte scanning from the importer. `foundryPackStorage.ts` rejects
  unsupported raw storage consistently at root, nested roots and public/system layouts.
  JSON/NDJSON and split-JSON exports remain supported. YAML is not converted into fake
  metadata-only documents; convert it faithfully before import.
- Kept strict DataModel choice validation. SetField cleans elements before deduplication;
  schema/default handling does not excuse invalid explicitly supplied values.
- Bounded serialized resource chunks and settings pages, with monotonic SDK aggregation.
  Ordinary RPC and resource-read rate budgets are separate; concurrency remains bounded.
- Shared entitled asset resolution/cache logic between GM and player runtimes. Cache hits
  recheck entitlement. GM reads use OPFS; players use their authorized asset fetcher.
- Centralized action labels/metadata in `aisActionDescriptor` and `ActionDescriptor`.
  Scene-tag attribution is a separate trusted parameter, not hidden keys in untrusted input.
  Host receipt IDs remain host-allocated. Real handler→client→host tests verify receipt
  attribution, player denial, and exact GM Revert restoration.
- System identity now comes from importer `system.json` metadata, not short module IDs or
  titles containing “system.” Restored the compatible diagnostic sections of `foundry.info`
  with bounded samples and recursive compaction. Preserved the real UI mixin rather than
  replacing it with a stub based on its function source text. Missing/invalid templates fail
  explicitly instead of rendering successful empty placeholders.
- Consolidated deterministic package hashing, file enumeration, manifest discovery and
  archive rooting for world builders. External fixture paths use `VTT_FOUNDRY_FIXTURES`
  (default `/tmp`). Removed duplicate/dead builder branches and checked flat/nested layouts.
- Removed production test-only PF1 helpers and canned Fireball answers. Shared optional
  real-PF1 E2E setup now skips explicitly when fixture ZIPs are absent. Synthetic fixture
  tests are smoke coverage; removed authoring-HP restoration masquerading as Revert and
  replaced four-player fallback assertions with actual replicated-chat assertions.
- Validated recent-game records loaded from IDB, refreshed history after its write completes,
  and removed unsafe persistence casts. Added persistence regression coverage.

## PR51 commit coverage

| Commit | Refactoring area |
|---|---|
| `579a977` | Projected scene/tag boundaries; trusted attribution; browser module regression coverage |
| `adbab37` | Extracted compendium facade; paginated world indexes; UUID resolution |
| `9420bc6` | Shared entitled assets; bounded resource/cache handling; generic system metadata |
| `f7e289d` | Shared action descriptor and real host receipt/Revert integration |
| `b1f98e1` | Own-pack parser/collections; stable indexes; no lossy YAML pseudo-documents |
| `b2b29aa` | Integral builder shared helpers; explicitly scoped smoke test; removed fake Revert fallback |
| `5460ea8` | Four-player builder helpers; replicated-chat assertions and typecheck fixes |
| `28d6716` | CSP-safe Roll extraction; unsafe LevelDB reader removal; asset sharing |
| `25369b5` | Byte-aware resource paging, bounded hydration and explicit unsupported-storage failures |
| `4e84fb5` | Architecture documentation: distinguish contract goal from verified support |
| `40c33f6` | Document actual safety/compatibility boundaries rather than inferred system parity |
| `909c56b` | Clarify emulation and imported-PF1 acceptance limitations |
| `5dc482c` | Manifest-derived system identity; Vite flag rewriting preserves strings/comments |
| `3477ebf` | Shared external-fixture E2E setup; strict schema semantics; bounded diagnostics |
| `b780ea8` | Set element cleaning/strict validation; extracted pack loading and index behavior |
| `74dfd9e` | Shared full-world hashing/root discovery; explicit source/storage admission |
| `88222a6` | Removed canned production helpers; real content/Roll tests, no fabricated casting claim |

## Validation performed

| Check | Result |
|---|---|
| Package tests + AIS app tests + recent-games test + host sync tests | **110 files, 2,037 passed, 5 skipped** |
| Deterministic builder helper tests (`node --test scripts/lib/packageFixture.test.mjs`) | **3 passed** |
| Typecheck | **Pass**, 99 Svelte components, 0 blocking issues, 3 existing advisories |
| Production build | **Pass**; self-contained HTML about 6,012 kB, gzip about 1,930 kB |
| Existing Foundry module browser suite | **5 passed**: upstream Tagger, settings, V1/V2 UI, core resources/DataModels, document mutation/replication |
| New production-CSP Roll browser test | **1 passed**; Function construction blocked, arithmetic and dice totals correct |
| Synthetic integral/four-player browser smoke | **2 passed**, rerun after removing fallback assertions |
| Optional real-PF1 browser tests | **3 skipped**, external world ZIPs absent |
| ESLint on the new runtime/helper/test modules | **Pass** (not a repository-wide lint claim) |
| Builder script syntax and `git diff --check` | **Pass** |

The broad unit selection is not the entire repository test suite. Browser validation ran in
Chromium, not all browser projects. The final diagnostic compaction change only affects
oversized diagnostics; the complete browser run preceded that small tightening.

Builds also succeeded for the adapter demo, UI demo, integral and four-player fixtures.
Starter-world generation skips the optional tester fixture when its converted PF1 content is absent.

## Explicit limitations / follow-up

1. At the initial refactor validation, external PF1 archives had not been downloaded. Real-PF1 import/boot and real spell casting,
   saves, damage, conditions, FX and resulting GM Revert are **not verified**. The existing
   synthetic native spellbook smoke is not a substitute. Host AIS receipt/Revert integration
   is separately verified, but is not imported-PF1 gameplay acceptance.
2. Raw LevelDB archives now fail with snapshot-export guidance. This intentionally removes
   unsafe best-effort recovery; a proven consistent snapshot reader is still future work.
3. Full Foundry Roll syntax, Canvas/PIXI, unsupported template syntax and other missing
   APIs are not made compatible by this refactor. Strict failures may reveal further upstream
   compatibility work instead of allowing false-success boot behavior.
4. The external world builders have helper/syntax coverage but were not run against actual
   upstream PF1 archives. Their filtered-source layouts still need fixture-based integration.
5. The recent-games save/read ordering is fixed. Broader hash-autoconnect/preference ordering
   and concurrent multi-tab history writes were not redesigned or claimed as verified.

All changes remain in the working branch. No commit, push or pull request was created.


## Follow-up: fetched external sources

The missing-fixture explanation above is superseded for the pinned mirrors now downloaded.
See [external fixture setup and exact versions](tools/content/FOUNDRY_FIXTURES.md).
All five source archives are cached, and minimal/full real-source world builders succeed.
The real PF1 11.11 Chromium boot test now executes and fails on unsupported Handlebars inline
partials/decorators during template preload. The full/Fireball tests did not run after the
first failure. This is a real compatibility blocker, not an archive-availability excuse.
Four content/SBC mirrors are historical versions, not the newer GitLab versions in the review.


## Follow-up: PF1 startup fixed

The previously recorded Handlebars boot failure is resolved, not suppressed. The adapter's
interpreted template engine now supports scoped inline partials and layout partial blocks,
with declaration hoisting, shadowing, inherited scopes, escaping and bounded recursion.
Six dedicated inline-partial tests were added (48 total engine tests).

Real-source testing also exposed assignment to the getter-only `Document.id` in compendium
hydration. IDs are now constructor inputs; cache identity and getter-only IDs have regression
coverage. Real-PF1 test setup now waits for capability controls, confirms runtime.execute consent,
and the full-pack test uses the correct second argument of Locator.evaluate.

Final run: **9/9 Chromium checks passed**, including all three real-PF1 fixture tests (none
skipped), existing five Foundry module/UI/document regressions, and the actual-CSP Roll test.
Selected broad units/integration: **2,044 passed, 5 skipped, 110 files**. Typecheck and build pass.
The successful full fixture uses PF1 11.11 and the three pinned historical content mirrors;
it does not test SBC or assert real spell casting/damage/Revert acceptance.

## Follow-up: fresh-player workflows, not just startup

See [the real-user acceptance matrix and commands](e2e/REAL_USERS.md).
Final combined readiness run: **2 passed, 1 failed in 2.7 minutes** (Chromium, no retries).
The two native browser workflows pass:
owned sheet/spellbook/slot management/casting/reconnect, and observer privacy/read-only/live
ownership revocation. The player starts without the world file in a separate browser context.
Ownership assignment and revocation use visible GM UI; measured gameplay actions use player UI.
A native sheet defect exposed here is fixed: spell casting may target the owned caster,
without changing self-exclusion for the other tactical target lists.

A separate mandatory real-PF1 player gate **fails**, rather than skipping or reporting an
expected failure: genuine Battle Mage + Fireball creation exceeds the AIS RPC 64 KiB JSON
request limit. Real PF1 boot and compendium hydration succeed; creation fails before player
join. Therefore this run says nothing yet about imported player runtime delivery, consent,
sheet or spell usability. Those assertions remain required, and are not established by the
native results. Full imported casting/damage/Revert needs further acceptance coverage.

Additional validation: 92 focused casting/spell/slot tests pass; typecheck has 0 blocking
issues and 3 existing Svelte advisories; targeted lint passes. External fixture builders now
default to the documented vendor-cache directory rather than temporary `/tmp` archives.

## Follow-up: real-character document import blocker resolved

The original 64 KiB/bounded-JSON error combined size and depth failures. Large document
mutations now use ordered chunk envelopes within the unchanged 64 KiB per-message limit.
The existing 512 KiB mutation / 32-op atomic transaction limits still apply, and capability,
command lifetime, replay, rate, dynamic consent and host authorization checks remain in the
normal execution path. Only document JSON receives a separate 32-level depth budget;
ordinary RPCs keep the smaller budget. Document read responses are chunked within 1 MiB.

An independent real-source Chromium regression imports Battle Mage + Fireball and reads the
committed actor back through kernel RPC, comparing actor/embedded-item system data. It
passes without trimming the source, substituting a native actor, or partial commits.
The actual injected SDK also has 10 transport regressions, including Unicode/escaped data,
budgets, malformed/out-of-order/expired/replayed chunks, grants and inactive commands.

Final combined browser run: **3 passed, 1 failed in 5.5 min**. Both native workflows and real
character import pass. The remaining imported-player gate now fails **after player join**,
at delivery/consent (no shared-PF1 consent dialog within 45 seconds). Imported runtime boot,
sheet/spells/casting are still not established. See `e2e/REAL_USERS.md` for current commands.
Broad package/AIS/host validation: **2,061 passed, 5 skipped, 110 files**. Typecheck passes
with 0 blocking issues and 3 existing advisories; targeted lint and build pass.

## Genuine unified/integral rework (2026-10-17)

The earlier synthetic results and red-gate diagnostics above are historical.
The genuine pinned-stack gameplay gate now **passes**, including upstream sheet,
derived ability/feat changes, Fireball damage/casting/slot consumption, host chat,
cast-derived damage application, healing transaction Undo/Redo, and reload
persistence. Global and document preparation error lists are empty. Upstream
runtime files remain unchanged; fixes are generic AIS/adapter contracts.

See [PF1_UNIFIED_INTEGRAL.md](docs/PF1_UNIFIED_INTEGRAL.md) for reproduction,
exact source pin, results, and scope limits. Archetype/statblock discovery is not
application/conversion proof; targeting/saves/template placement and whole-action
revert are not certified by this gate.

Final validation: full suite **6,014 passed / 12 existing skips**; extended
integral Chromium **1 passed**; typecheck (three existing advisories), build,
and targeted ESLint passed. Repository-wide lint is not claimed.

## 2026-10-17 — Entangle / native FX acceptance

The genuine Entangle scene now passes via native Wizard editing/binding and
reviewed GM controls: real PF1 casting, failed-save confirmation, derived −4
Dexterity penalty / −2 attack, persistent target FX, release, and upstream expiry
evaluation at a demo time offset. See [the exact scope and run instructions](docs/PF1_ENTANGLE_FX.md).
This supersedes older statements that Entangle has no genuine-stack proof; it
does not certify automatic area adjudication or native substitutes as upstream.
Full unit suite: 6,018 passed / 12 existing skips.
