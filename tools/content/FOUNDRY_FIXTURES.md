# External Foundry/PF1 source fixtures

Fetch the five pinned archives:

```sh
npm run fetch:foundry-fixtures
```

By default they are stored in `tools/content/vendor/foundry-fixtures/` (git-ignored).
Set `VTT_FOUNDRY_FIXTURES` to use a different destination. Each ZIP has a `.source.json`
receipt containing the upstream URL, actual mirror, exact commit, byte count and SHA-256.
Cached downloads are hash-verified before reuse. TLS verification stays enabled.

Sources and revisions are recorded in `foundry-fixtures.json`. These are **source mirrors**,
not a claim of byte identity with current GitLab HEAD or official compiled release ZIPs.
Direct GitLab is outside this session's permitted network hosts; GitHub mirrors are reachable.

| Archive | Actual source manifest version | Mirror |
|---|---|---|
| `pf1-system.zip` | PF1 **11.11** | `gabrieldosprazeres/foundryvtt-pathfinder1` |
| `pf1-content.zip` | PF Content **0.3.4** | `baileymh/pf1e-content` |
| `pf1e-archetypes.zip` | Archetypes **0.2.7** | `baileymh/pf1e-archetypes` |
| `statblock-library.zip` | Statblock Library **0.2.9** | `baileymh/statblock-library` |
| `statblock-converter.zip` | SBC **4.0.3** | `Lavaeolous/PF1-StatBlock-Converter-Module` |

The four content/SBC versions are older than the GitLab versions in the readiness review.
Do not label tests against them as acceptance of those newer versions. SBC is downloaded
for availability/provenance but is not included in the existing four-package full-world builder.

Build the existing real-source test worlds:

```sh
export VTT_FOUNDRY_FIXTURES="$PWD/tools/content/vendor/foundry-fixtures"
node scripts/buildRealPf1WorldFiltered.mjs
node scripts/buildRealPf1FullWorld.mjs
npm exec playwright test -- --project=chromium --workers=1 --retries=0 \
  e2e/real_pf1_boot2.spec.ts e2e/real_pf1_full.spec.ts e2e/real_pf1_fireball.spec.ts
```

Both builders now load their shared TypeScript admission code through Vite, avoiding Node's
extensionless-import resolution failure. Build-time YAML-to-JSON transcoding preserves complete
documents (including nested spell actions/damage formulas); it is not metadata extraction.
Guest runtime source is not rewritten by this transcoder. Raw LevelDB remains unsupported.

## Current validation result (2026-10-17)

- All five archives downloaded and cached receipts verified.
- Minimal and full real-source world ZIPs build successfully (~5.2 MB and ~13 MB).
- The original PF1 11.11 startup failure on Handlebars inline partials is **fixed** in
  `runtime/hbs.js`: program-local inline declarations, inherited scopes, layout partial blocks,
  shadowing, and bounded recursion. The engine remains interpreted and CSP-safe.
- Compendium hydration no longer assigns to getter-only `Document.id`. IDs are supplied to
  the document constructor, preserving document source and cache identity.
- All **9 Chromium browser checks pass**, with no fixture skips: real PF1 minimal startup,
  real Fireball retrieval + sandbox Roll, full four-runtime pack/index coverage, existing five
  Foundry module/UI/document tests, and the production-CSP Roll test.
- The full fixture checks PF1 11.11 plus the three historical content mirrors listed above.
  SBC is downloaded but is not part of the full fixture or its startup claim.
- The selected package/AIS app/host integration suite passes: **2,044 tests**, 5 skipped,
  across 110 files. Typecheck passes (0 blocking, 3 existing Svelte advisories). Build passes.

The browser fixture helper now waits for capability controls and verifies execution consent
before reload. The full fixture test correctly receives its package ID as the **second**
`Locator.evaluate` argument (the first is the DOM element), and matches the pinned statblock
entry `Ogre (CR 3)` without accepting Ogre Mage or unrelated feat names.

This verifies PF1 startup and content retrieval, **not** full imported-PF1 casting, damage,
saves, conditions, FX or Revert. No error suppression or fake-success fallback was added.

## Player-workflow acceptance (separate from startup)

The [fresh-player acceptance matrix](../../e2e/REAL_USERS.md) adds reproducible
`test:e2e:real-users:*` commands. Both world builders now default to the vendor-cache
location documented above; exporting `VTT_FOUNDRY_FIXTURES` is optional.

Native player spellbook/casting/reconnect and observer/privacy/revocation workflows
have passing coverage. The real PF1 document-size/depth blocker, player runtime
consent/boot, and upstream sheet/spell visibility blockers are now resolved.
The fixture explicitly assigns the copied Fireball to `system.spellbook = "primary"`;
PF1 derives the runtime `spellbookId`. Both GM and fresh player visibly render it.

The content test now uses the shared AIS catalogue, not a harness data handoff.
PF1 directly discovers the pinned Content 0.3.4 feats pack, resolves Acrobatic by
its original compendium UUID, and imports/renders its FeatModel with exact stored
description/change preservation. A fresh-player test covers late sharing, local
consent, removal on GM unshare and fresh-read denial. Run:

```sh
npm run test:e2e:real-users:content:prepare
npm run test:e2e:real-users:content
```

The module declares 36 packs and no runtime scripts; the full fixture includes a
subset, not all 36. Its Foundry 10/PF1 >=0.82.5 metadata is not evidence of current
upstream release compatibility. Private/role-restricted packs are filtered from
player catalogues; native GM compendia stay host-only. Automatic feat bonuses and
complete casting/damage/Revert remain unproven. Latest three scoped browser tests
pass in 10.5 minutes. See [AIS_CATALOGUE.md](../../docs/AIS_CATALOGUE.md).
