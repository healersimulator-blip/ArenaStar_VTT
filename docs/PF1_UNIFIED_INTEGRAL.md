# Genuine PF1 unified starter / integral gate

**2026-10-17: the real gameplay gate passes in Chromium.** This is a bounded
upstream gameplay acceptance result, not certification of all PF1 automation.
It supersedes the earlier red-gate reports.

## Build and reproduce

```sh
npm run fetch:foundry-fixtures
npm run build
npm run build:worlds:pf1-unified
npm run test:e2e:pf1-integral
```

The builder writes identical `dist/worlds/pf1e-unified-starter-1.0.0.zip` and
`dist/worlds/pf1e-integral-test-1.0.0.zip` archives. Import the starter, approve the
adapter and each upstream package in Settings, and reload. No native PF1 rules
provider is activated (`rules.active: null`). The native world format's fallback
system identifier is not an active gameplay rules provider.

## Sources and scene

Immutable provenance and checksums are in
`tools/content/vendor/foundry-fixtures/*.source.json`:

- PF1 **11.11**, unchanged upstream commit
  `fc067cd7c3ff0fd79548a149d82ed3d5be9fda1a`. This revision precedes the upstream
  NPC preparation regression and subsequent removal of v13 support.
- PF Content **0.3.4**, archetypes **0.2.7**, statblock-library **0.2.9**.
  These historical mirrors are not equivalent to the newer versions in the
  original GitLab inventory.

Upstream runtime files are not patched. YAML documents are converted to JSON.
This is a **selected-pack** stack: PF1 basic-monsters/spells and retained
upstream resources, Content feats/items, all four archetype packs, and two
statblock-library bestiary packs. Missing declared pack warnings are not full
pack coverage. Some upstream image references still produce blocked local-file
requests in the file:// build; this result is not an artwork-completeness claim.

Linked tokens use the real Battle Mage and Orc from `pf1.basic-monsters`.
Scenario edits rename the mage to Valtiel, set Wizard to level 5, and add one
prepared real Fireball from `pf1.spells`. Derived ability modifiers, HP, caster
level, DC, and damage are not injected as fixture answers. The real AIS create
normalizer admits the serialized documents. Token dispositions use the kernel's
string enum rather than incompatible Foundry numbers.

## Passing browser acceptance

`e2e/pf1e_integral.spec.ts` runs actual upstream methods and checks:

- Explicit consent and boot of all four packages; real upstream actor sheet.
- INT **15 → 17**, modifier **+3**, from upstream preparation and racial changes.
- Acrobatic discovered through the shared cross-module catalogue, imported onto
  the actor: Acrobatics **4 → 6 → 4** after import and removal.
- Archetype and statblock UUID resolution across distributions.
- Fireball `Action.rollDamage`: caster level **5**, DC **16**, damage within
  **5–30** for the source formula `(min(10, @cl))d6`.
- Real `Item.use({skipDialog:true, options:{measureTemplate:false}})`: preparation
  **1 → 0**, confirmed by authoritative host readback; actual cast damage is
  extracted from the upstream action's finalized chat attacks.
- A host-persisted chat message containing Fireball, addressed by its actual
  host-issued ID (not just a local temporary message).
- That cast's damage applied with upstream `Actor.applyDamage`, then healed
  with its inverse amount; authoritative HP and offset readbacks.
- Host **Undo/Redo** of the actual healing transaction, with the adapter replica
  following each result. This is transaction undo, not a second healing call.
- Reload without reimport: consumed Fireball preparation remains **0**, restored
  HP survives, and fresh upstream preparation completes without errors.
- Empty global hook **and document-preparation error lists**, before and after
  reload. Individual gameplay errors are collected, attached, and fail the test.

No gameplay skip, native substitute, or hard-coded rolled damage is used.
Playwright attaches `integral-real-pf1` and `integral-persistence-undo` reports.

## Universal compatibility fixes

The adapter now supplies document implementation factories, type-model update
preprocessing with expanded paths, embedded-model migration before cleaning,
array/set element initialization with correct model parents, and safe update
path rejection. These fixes preserve legacy changes and PF1 HP-offset updates
without PF1-specific adapter branches.

The standalone guest's `parent` resolves to its own window after the SDK's
private MessagePort handshake, not the host's cross-origin WindowProxy. This
matches a standalone Foundry window without granting access to host state.

The CSP-safe dice layer provides Foundry term classes, computed dice counts,
conditional/comparison rule expressions, structured dice results, registered
functions, and inline-roll anchors. Nested/custom-function dice are evaluated
once and retained in metadata; regression tests assert RNG call counts. The
adapter loads the unchanged Showdown 2.1.0 distribution and accompanying license
for the normal upstream Markdown dependency.

## Validation

- Extended integral browser gate: **1 passed**, including reload and Undo/Redo.
- Full `npm test` after the Entangle extension: **6,018 passed, 12 existing skips**, 454 passing test files.
  No new gameplay skips were added. An intermediate concurrent run exceeded an
  unrelated compendium timing threshold; the final full run passed without
  changing that threshold.
- Typecheck: **0 blocking issues**, three existing Svelte advisories.
- Application build and targeted ESLint: passed.
- Repository-wide lint is not claimed; existing adapter JS style debt remains.

## Explicit remaining scope

Archetypes and statblocks are proven for discovery/UUID resolution here, **not**
archetype progression/application or SBC conversion. Template placement is
explicitly disabled through the upstream quickcast option, not simulated by a
no-op canvas listener. Automated target selection, saves/SR, template geometry,
automatic Entangle area/repeated-save/elevation behavior, complete pack coverage, multiplayer gameplay, and PF1 card
reroll/revert semantics remain separate acceptance work. The Undo/Redo proof
above concerns an AIS document transaction, not complete spell-action reversal.
Native/mock scenario results must not be cited as proof of those upstream flows.

## Entangle extension

The native FX Wizard ↔ Foundry-derived Entangle demonstration now also passes:
[run instructions, exact measurements, and scope](PF1_ENTANGLE_FX.md). It includes
real casting, a GM-confirmed failed-save resolution, upstream condition penalties,
linked persistent native FX, release, and upstream expiry evaluation at a demo
time offset. It does not claim automatic area-spell adjudication.
