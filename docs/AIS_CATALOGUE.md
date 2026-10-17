# AIS shared compendium catalogue

## Contract

`AIS.compendium.list/index/search/get` serve both native host packs and declared
Foundry distribution packs. The existing `compendium.read` grant controls discovery
and reads; it does not authorize mutation or execution of another module's code.
`modules.invoke` and its declared `requires` checks remain separate and unchanged.

The kernel uses a canonical `<packageId>/<pack path>` RPC identity. List metadata
also carries the upstream `collectionId` (for example `pf-content.pf-feats`) and
package type. The Foundry adapter mounts that alias in `game.packs` and routes reads
back through the canonical RPC identity. Original entry IDs retain case, and
`fromUuid` accepts the usual typed and untyped upstream compendium references.
Hydrated documents report their actual compendium UUID and pack membership;
`fromUuidSync` resolves an already-hydrated document. The catalogue exposes declared
data only, not sibling scripts, globals or undeclared resource files.

Catalogue documents and sheets are read-only. Import a world copy through the
normal document APIs to modify it; those writes retain host authorization. Pack
context is not serialized into world copies. A cached `getDocument` still performs
a fresh kernel read/authorization check before returning the cached instance.

## Authority and lifecycle

- GM: native world compendia plus distribution data from enabled, exact-hash
  approved modules and approved runtime dependencies. Live approval is rechecked
  for every catalogue operation, not cached alongside parsed data.
- Player: **no native GM package database access**. Only public distribution data
  from currently shared, locally consented running providers is available. The
  caller also needs its own locally consented `compendium.read` capability.
- Private packs and packs whose explicit PLAYER/user/default ownership is below
  OBSERVER are excluded from player list, search and get. Pack policy comes from
  the approved original configuration, not an iframe's registration request.
- `compendium.changed` is kernel-originated and gated by `compendium.read`.
  Provider consent/removal refreshes sibling registries without restarting PF1.
  Unsharing removes the provider and denies direct reads even if the caller kept
  its old pack handle. Previously delivered data cannot be made unread retroactively.
- Parsing is memoized by immutable resource snapshot and reader policy. A new
  version/snapshot cannot reuse an old parse. Authorization is checked outside
  that cache. JSON, NDJSON and split JSON are supported; YAML fixture sources
  still require faithful conversion before import. No raw LevelDB guessing.

Paged index/search limits remain unchanged. Individual compendium documents use
existing bounded document-response chunk transport (1 MiB payload ceiling,
64 KiB maximum frames, ordinary request and JSON-shape checks intact). Oversized
entries fail explicitly; no description, effects or nested data is truncated.

## Verification, 2026-10-17

- Real PF1 11.11 discovers pinned PF1 Content 0.3.4 packs directly, resolves the
  original Acrobatic UUID, imports a real FeatModel and renders the item on the
  upstream actor sheet. Its description and change formulas survive readback.
  The harness reads the content source independently for comparison; it no longer
  passes a source document into the PF1 frame.
- A fresh player first boots PF1 without content, receives the newly shared
  provider, sees no content before local consent, then discovers/resolves it.
  GM unsharing removes its packs and a fresh canonical get is denied.
- GM and fresh player still render the assigned Fireball in the actual spell tabs.
- Three Chromium tests pass in 10.5 minutes. Scoped package/app/host and AIS-core
  regressions: 2,390 passed, 5 pre-existing skips, 168 files. Typecheck and targeted
  ESLint pass; Svelte reports three existing advisories.

Run `npm run test:e2e:real-users:content:prepare` followed by
`npm run test:e2e:real-users:content`. The full fixture intentionally contains a
subset of upstream packs. These tests establish catalogue/UUID/import/consent
behavior, not every pack's rule automation or complete PF1 casting/damage/Revert.
