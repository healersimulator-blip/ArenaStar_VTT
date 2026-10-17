# Fresh-player acceptance tests

These tests distinguish native PF1e gameplay from imported Foundry PF1 support.
Passing a system boot/content smoke test is not evidence of a usable player sheet.

## Run

```sh
npm ci
npm run e2e:browser
npm run test:e2e:real-users:prepare
npm run test:e2e:real-users
```

Preparation fetches the pinned external archives (or verifies their cache), builds the
application, and builds the real-source minimal world. Archive versions and licensing are
recorded in [FOUNDRY_FIXTURES.md](../tools/content/FOUNDRY_FIXTURES.md). Builders default to
`tools/content/vendor/foundry-fixtures`; `VTT_FOUNDRY_FIXTURES` can override that directory.
A later application build clears `dist`, so prepare again before running the imported gate.
Missing fixtures fail that gate with setup instructions; they do not skip it.

To isolate the two coverage classes after preparation:

```sh
npm run test:e2e:real-users:native
npm run test:e2e:real-users:import
npm run test:e2e:real-users:pf1
```

Commands run Chromium with one worker and no retries. These are scoped readiness checks,
not a claim of complete imported-PF1 gameplay compatibility. Do not add `test.skip`, `test.fail`, optional fixture
skips, or remove assertions to make imported-PF1 readiness appear green.

## What is measured

GM and player use separate browser contexts: no shared local storage, IndexedDB, world ZIP,
package cache, or runtime consent. The player joins through an invitation and manual
WebRTC offer/answer exchange. Fixtures are prepared programmatically on the GM side;
measured gameplay actions use the visible UI. Test hooks read connection state, replica
contents, rejection status and chat, not fabricate gameplay results.

| Scenario | Assertions | Measured result (2026-10-17) |
|---|---|---|
| Native owned character | GM assigns ownership through UI; player opens readable HP/spellbook, spends/restores a slot, prepares a spell, casts, and sees synchronized GM/player HP, expended preparation and slot usage | Passed, 45.8 s |
| Native reconnect | Actual player-page reload and manual rejoin preserve identity, HP, spent slots and prepared spells from the still-running GM | Included in first test |
| Native privacy/read-only | Observer can read spells but cannot edit/cast; GM-secret actor is absent from replica and list; GM revokes ownership through permissions UI and the already-open sheet becomes unavailable | Passed, 26.9 s |
| Real PF1 character import | Import unconverted upstream Battle Mage + Fireball (>64 KiB), read it back through kernel RPC, compare complete actor and embedded-item system data | Passed, 1.6 min |
| Imported PF1 sheet/spell visibility | Boot real PF1 11.11, hydrate upstream Battle Mage and Fireball, explicitly assign Fireball to the primary book, fresh-player delivery/consent/boot, open both actual upstream sheets and spell tabs, verify visible Fireball | Passed, 2.3 min; casting not asserted |
| PF1 Content catalogue/import | PF1 discovers real Content 0.3.4 packs, resolves the original Acrobatic UUID and imports/renders a FeatModel with preserved description/changes | Passed, 3.3 min |
| Player catalogue consent/revocation | PF1 boots before content; newly shared content remains absent before local consent, appears/resolves afterward, disappears on GM unshare; fresh reads denied | Passed, 4.9 min |

The native cast deliberately targets the owned caster, with legal real `1d2` host dice.
It checks HP 16 or 17 and exact agreement between GM, player and reconnect; it does not
mock dice or claim to implement the full rules of Magic Missile. Native fixtures use
ArenaStar's `system.pf1e` schema, not raw Foundry PF1 documents.

## Original import blocker: resolved

The original error combined JSON-shape and size admission failures:

```text
Document write rejected: AIS RPC request must be bounded JSON no larger than 64 KiB
```

The genuine actor and embedded spell exceed both the ordinary frame-size limit and the
12-level generic JSON-envelope depth budget. Document mutations now travel as ordered
bounded chunks; individual messages remain at most 64 KiB. The existing 512 KiB mutation
budget, 32-operation limit, host authorization and atomic transaction are unchanged.
Document JSON has a separate 32-level depth budget. Document read responses are similarly
chunked within their existing 1 MiB budget, so reading the imported actor back also works.
Ordinary non-document RPC limits are unchanged.

`real_pf1_document_import.spec.ts` is an independent, unskipped regression against the real
PF1 11.11 distribution. It imports Battle Mage + Fireball and compares actor and embedded
item system data with a full authoritative readback. No fields are trimmed, no native
`system.pf1e` replacement is substituted, and no transaction is split into partial writes.

## Player delivery and spell-list setup: resolved

Shared-runtime consent, startup and actual upstream sheet rendering now pass.
The missing Fireball was also absent for GM: its compendium source was unassigned.
The fixture now sets PF1's stored `system.spellbook = "primary"` on the copied
spell before actor creation. Upstream PF1 derives `spellbookId`; both sheets render
all ten spell rows, and the Fireball row is visibly accessible through the spell tabs.
The original raw compendium entry and all upstream code remain unchanged.

For the separate content test:

```sh
npm run test:e2e:real-users:content:prepare
npm run test:e2e:real-users:content
```

The content test uses the real Content 0.3.4 feats pack. PF1 now resolves its
upstream UUID directly through the permission-aware AIS catalogue, without a test
handoff. The player test covers late sharing, local consent, registry refresh and
unsharing/read denial. Native GM packs are not replicated or exposed to players.
See [AIS_CATALOGUE.md](../docs/AIS_CATALOGUE.md). Automatic feat bonuses remain
unproven by these catalogue/import tests.

Complete imported casting, damage, saves, conditions, FX and GM Revert still need
their own end-to-end assertions. Native self-casting does not prove these behaviors.

## Boundaries

- Chromium desktop/laptop viewports only; no mobile, multi-player stress, browser matrix,
  public-network NAT traversal, or adverse-network coverage is claimed here.
- Reconnect keeps the GM running; it does not test GM restart, disk durability or world export.
- Observer UI restrictions and replica privacy are user-workflow assertions, not a replacement
  for host-side malicious-client authorization tests.
- The self-target picker defect found by the native flow is fixed only for spell casting;
  unrelated tactical target pickers still exclude the caster.

Latest scoped GM/player sheet + content catalogue/import + player catalogue run: **3 passed in 10.5 minutes**.
This does not rerun the entire native/imported acceptance matrix.
Validation alongside these flows: **2,061 unit/integration tests passed, 5 skipped, 110
files**, including 10 new chunk-transport regressions (real injected SDK roundtrip,
escaped/Unicode data, request/response size limits, ordering, expiry, replay, missing grants
and inactive commands). TypeScript/Svelte check passes (0 blocking issues, 3 existing
advisories); targeted ESLint passes.
