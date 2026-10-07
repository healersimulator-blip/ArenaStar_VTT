# Campaign Codex → ArenaStar VTT: capability-transfer plan

**Research date:** 2026-10-06

**Scope:** transfer user-facing campaign-management capabilities, not Foundry code, branding, or bundled dependencies.

**Implementation checkpoint (2026-10-07):** a first slice is in the repository: typed journal/page Codex metadata, bounded schema/reference/containment validation, GM write protection, non-GM projection, basic Journals/Handouts Codex surfaces, and full World ZIP validation/round-trip. This is not completion of Stages 1–6; see §7 for the explicit remaining gaps.

## 1. Product and source baseline

The Foundry package page currently lists **Campaign Codex 6.9.8**, compatible with Foundry 13+ and verified for 14. Its current 6.9.8 notes mention one-time Web Hub promotion, Entity Widget sheet-label overrides, Asset Librarian category tags on item containers, and configuration-tab CSS fixes; 6.9.6 added token currency to the loot dialog. The package manifest confirms `scripts/main.js`, a socket integration, JSZip/Leaflet/vis-network libraries, and documentation/macros compendia.

Campaign Codex is an add-on to Foundry journals, not a replacement for them. The documented core is six linked sheet roles—**Group, Region, Location, Entry, NPC, Tag**—plus quests, navigation, widgets, item containers/shops, and import/export. Regions and groups organize nested entries; NPCs can link to actors; locations and entries can link to scenes; Entries can expose a shop/loot inventory; quests have pin/visibility/completion and objective state. See the official [package page](https://foundryvtt.com/packages/campaign-codex), [6.9.8 manifest](https://modules.wgtngm.net/cc13/6.9.8/module.json), [changelog](https://campaigncodex.wgtngm.com/campaign-codex/changelog/), [sheet docs](https://campaigncodex.wgtngm.com/campaign-codex/sheets/group/), [quest docs](https://campaigncodex.wgtngm.com/campaign-codex/content-panels/quests/), [inventory docs](https://campaigncodex.wgtngm.com/campaign-codex/content-panels/inventory/), and [import/export docs](https://campaigncodex.wgtngm.com/campaign-codex/import-export/exporting/).

### Implementation-review caveat

The latest public manifest, changelog, and product docs were reachable, but the 6.9.8 module ZIP is binary and could not be retrieved for inspection in this environment; the former `xthesaintx/cc13` GitHub repository currently returns 404. The available source-level reference is a **DeepWiki index of an earlier repository snapshot**, commit `7d3e7a45`, indexed 2026-04-05—not a verified view of 6.9.8. That snapshot describes a JournalEntry/flag-based implementation with custom sheet subclasses, a manager/cache, permission-aware link resolution, widget registry/base class, and importer/exporter. Use those as architectural clues only; re-audit the current archive before relying on any version-specific internals. Reference: [archived implementation overview](https://deepwiki.com/xthesaintx/cc13) and [core architecture](https://deepwiki.com/xthesaintx/cc13/2-core-architecture).

## 2. Capability map and ArenaStar fit

| Campaign Codex capability                                            | ArenaStar baseline / transfer decision                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six semantic journal sheets and reusable info/content tabs           | Arena already has `JournalDocument` / `JournalPageDocument` and Markdown pages. Keep ordinary journals unchanged; add optional typed Codex metadata and render role-specific views over existing journal/page documents.                                       |
| Bidirectional links among journals, actors, items, scenes, and pages | Use stable typed `DocRef`s and a single persisted relationship direction; derive backlinks through an index rather than maintaining two mutable copies. Resolve and authorize links in the host before rendering cards.                                        |
| Group/Region hierarchy, sidebar tree, Hub/TOC search                 | Add a Codex navigator and group dashboard. Reuse the store and tag/search indexes; enforce depth/cycle limits and filter results before a player receives them.                                                                                                |
| Tags and tag-based discovery                                         | `src/core/tags.ts`, `TagIndex`, `TaggerPanel.svelte`, `TagEditor.svelte`, and host tag operations already provide substantial Tagger functionality. Reuse them. A Codex **Tag sheet** is a descriptive entity; do not replace or conflate it with string tags. |
| Quests, objectives, pinning, visibility and completion               | No equivalent Codex quest board is established. Model quest state structurally and project it per viewer. A pin is a navigation aid, never an access grant.                                                                                                    |
| Embedded widgets and extension API                                   | Arena has package/module APIs, but not Campaign Codex’s widget tray/registry. Add a typed, versioned, allow-listed Svelte widget registry; never render arbitrary HTML or grant widget code host authority.                                                    |
| Shops, loot containers, item transfer and system-specific economy    | Reuse Arena’s actor/item docs, permissions, and host-authoritative operations. Start with a PF1e adapter; do not assume one currency/item schema fits every system.                                                                                            |
| Import/export and conversion                                         | Extend `src/host/worldFile.ts` / `src/host/import.ts` for Codex docs/assets in full-world ZIP; keep subset merge/remapping separate.                                                                                                                           |
| Visibility and secrecy                                               | `src/core/projection.ts` already redacts journal secrets and links before non-GM delivery; `src/core/permissions.ts` and host sync enforce document permissions. Keep all relationship, page, quest, and widget filtering host-side.                           |

ArenaStar’s relevant existing surfaces are `src/core/documents.ts`, `src/core/store.ts`, `src/core/projection.ts`, `src/host/sync.ts`, `src/host/worldFile.ts`, and `src/ui/journals/`. `JournalsPanel.svelte` is currently a simple journal/page selector and GM editor; `HandoutsPanel.svelte` is the player reading surface. These are good integration points, not reasons to fork journal storage.

## 3. Recommended ArenaStar model

1. **Preserve journals as the content substrate.** Add an optional, schema-versioned `codex` field to `JournalDocument` with a discriminated `kind` (`npc`, `entry`, `location`, `region`, `group`, `tag`) and only typed data. Keep prose in normal journal pages so old journals remain readable and existing Markdown/secret behavior continues to work.
2. **Keep relationships typed and referential.** Store a bounded list of outgoing `{relation, target: DocRef, label?}` links on the source Codex sheet (or a dedicated typed edge document if scale demands it); derive reverse links from a maintained index. Validate target existence/type, ownership, cycles, and deletions on the host. Never let a player-supplied UUID turn into permission.
3. **Make tabs/pages and quests independently projectable.** Add typed page metadata for tab role and visibility. Represent a quest and its ordered objectives as structured data with stable IDs, status, pin state, and per-quest/objective visibility. Keep the authorization rule explicit: the user must be allowed to read the parent and the specific page/quest/objective. Pinning changes discovery only.
4. **Version widget configs and data.** A sheet stores `{id, type, version, tab, order, enabled, config}`. The renderer resolves the type through a registered first-party or package widget registry, validates config, and supplies only viewer-authorized data. Missing/invalid widget types render a safe placeholder. External widgets receive documented capabilities, not direct store/host access.
5. **Use an explicit economy adapter.** Model stock/quantity, price source, markup, loot/shop mode, and transaction limits independently of PF1e fields. A PF1e adapter reads/writes supported item/currency data. A purchase is one host-validated, idempotent transaction that checks current ownership, funds, stock, item quantity and target actor before committing.
6. **Make world-file portability a first-class invariant.** The existing full-world ZIP must save/load Codex pages, relationship refs, widget configs, quests, shop state, linked actors/items/scenes, and referenced media. Preserve replace/copy semantics for complete world archives; reserve atomic ID remapping and conflict choices for selected-content merge/import. Retain the media export-rights gate, and add Obsidian/Markdown export only after structured references can be rendered without leaking hidden content.

### Required world-ZIP persistence contract

The current format-2 World ZIP is the canonical full-campaign save/backup, not a Codex sidecar. Export must flush persistence and use the shared archive collector. `world.json` carries world identity/sequence; `documents.json` carries every world document row; `assets.json` and `assets/<hash>` carry permitted media metadata/blobs alongside the existing world/package/fog state. Store Codex sheet/page metadata, audience and tab settings, graph refs, quest/objective state, shop state, and widget config on archived documents (or a registered persistent collection included by the collector). Linked actors/items/scenes remain ordinary archived documents. Keep indexes/caches derived, and store media by content-addressed asset refs rather than remote URLs.

Load through the start-screen **Open file (.zip)** flow. **Restore** (internally the replace mode) uses the original world ID and replaces its data; as in the current importer, restored oplog/undo history starts fresh. **Open as new world** (copy mode) assigns a new world ID/name, leaves the source untouched, and preserves document IDs plus ordinary world-relative `DocRef`s; those refs resolve against the copied world’s store without per-edge rewriting. Starter templates remain copy-only. Validate or drop any future explicit cross-world refs. Atomic ID remapping and skip/link/replace conflict choices are for selected-content merge, not a complete world copy. Format-1/2 archives without Codex metadata remain valid. Treat a full-world ZIP as GM-private because it includes hidden records; a player/selected export requires a separate filtered path. Package trust is local, and asset export rights are not transferable licenses.

Do not copy Foundry’s `flags.campaign-codex` data model, document classes, socket assumptions, or bundled JSZip/Leaflet/vis-network code. Port the workflows into ArenaStar’s typed documents, host-authoritative ops, viewer projection, and existing world-file format.

## 4. Delivery plan

### Stage 0 — parity inventory and security contract

Create a capability matrix against the current package/docs; settle role names, relationship types, visibility rules, supported PF1e economy fields, and what remains optional. Define invariants for link resolution, deletion, copy/import, and guest/player projection before the first UI change.

**Exit:** schema examples and GM/player visibility tests are approved; standard journals are explicitly out of migration unless the GM opts in.

### Stage 1 — typed Codex metadata and graph services

Add optional versioned Codex metadata and validators to journal/page documents; migration defaults must be non-destructive. Add a pure link resolver/index with reverse relationships, cycle detection, stale-ref diagnostics, and host-validated create/update/delete operations. Integrate projection so inaccessible targets and their labels/IDs never reach player clients.

**Exit tests:** legacy journal world-file round-trip; valid link/backlink; invalid type, stale target, cycle, permission-denied link; ownership revoke removes projected card/link; reconnect snapshot and op replay remain equivalent.

### Stage 2 — sheets, linking UX, and navigator

Build one reusable Codex sheet shell with role-specific panels for NPC, Entry, Location, Region, Group, and Tag. Add drag/drop plus a searchable link picker for journals/pages, actors, items, and scenes. Build the Group tree and a Table-of-Contents/Hub view with type/tag/search filters, open/back navigation, and GM bulk visibility controls. Reuse Arena tags and existing journal windows rather than duplicating them.

**Exit:** create/edit/link/unlink from both ends; backlinks update immediately; nested groups/regions cannot cycle; Hub results exactly match what the viewer may read.

### Stage 3 — Quest Board

Implement ordered quests and nested objectives, progress/completion, pinning, and player visibility controls. Add the board to the Hub and let each quest return to its owning sheet. Project visible titles and objective text separately; hide inaccessible quests rather than merely disabling their UI.

**Exit:** a GM can pin, publish/unpublish, complete/reopen and reorder; two players with different sheet/page rights receive only their own authorized rows. Pinned status never bypasses permission.

### Stage 4 — widget tray and safe extension point

Add a widget tray for enabling, disabling, ordering, assigning to a tab, and configuring widgets. Start with native **linked entities**, **quest list/checklist**, **image gallery**, **timeline**, **map/scene note**, and **roll-table** widgets. Define `registerWidget(type, version, renderer, configSchema, capabilities)` for packages; run data reads through permission-filtered APIs and writes through host-validated requests.

**Exit:** widget configs round-trip, reorder and migrate; unknown versions fail to a placeholder; test attempts to read hidden actors/pages/media or mutate without capability are denied.

### Stage 5 — Entry inventory, shop/loot, and transactions

Add item-container/shop panels with loot mode (hide prices), GM controls for stock/markup, and player send/purchase flows. Implement PF1e price/currency mapping through an explicit system adapter and leave unsupported schemas read-only until an adapter exists. Log transaction receipt/undo data and make retries idempotent.

**Exit:** insufficient funds, depleted stock, stale quantities, missing character, duplicate request, and unauthorized actor each fail without a partial write; successful purchase updates shop and actor atomically.

### Stage 6 — portability, migration, and release hardening

Add standard-journal-to-Codex conversion as an explicit previewable action. Verify complete World ZIP save/restore/copy separately from a future selected-content bundle; only the latter captures a chosen dependency closure, remaps IDs, and offers skip/link/replace conflict choices. Report missing refs and media-rights restrictions. Add optional Markdown/Obsidian export with link mapping and visibility filtering. Run import/export against legacy, current, and partially missing-reference worlds.

**Exit:** round-trip graph/content integrity; copied `DocRef`s resolve only in the copied world; merge remaps are complete and atomic; player exports contain no unauthorized text/assets; replace restore has a tested recovery path.

## 5. Non-goals and release gates

- The external Campaign Codex **Web Hub** is a separate hosted/sharing product. Do not add networked world publishing in the core Codex MVP; if requested later, specify account, consent, revocation, cache deletion, and public-link threat models separately.
- Do not claim a `Campaign Codex parity` release from the Hub and sheet UI alone. Quests, widget security, transactional inventory, permissions, and portable references each need executable acceptance coverage.
- This plan reuses capabilities ArenaStar already has—especially generic tags, journal secret projection, host ops, compendia, and world-file export—instead of rebuilding them.

### Current implementation checkpoint and GAP list (2026-10-07)

Implemented: versioned typed sheet/page/relationship/quest/objective/widget/shop metadata; reference and containment validation on host writes; Codex write protection; page/tab/quest/objective/widget/shop projection on snapshots and live updates; a basic Codex Hub/editor inside Journals and a read-only player surface inside Handouts; and validated Codex-aware full World ZIP save/restore/copy. Tests cover the initial schema/projection, host privacy/authorization, and full-world archive round-trip. The full archive path remains private and separate from future selected-content export.

Still missing (do not claim parity):

- Specialized six-role sheet layouts and the Group/Region tree, reverse-link/backlink index, recent/back navigation, tag integration, richer search, drag/drop, and standard-journal conversion preview/undo.
- Selected-user audience picker and per-player preview; current UI can author only inherit or GM-only audiences.
- A registered widget renderer/config-schema/capability API and the six first-party widget experiences; widget config remains inert and non-GM projection intentionally empties it.
- PF1e pricing/currency interpretation and host-validated, idempotent, atomic purchase/send with stock/funds checks, receipts and undo. Current stock controls are informational/configuration-only.
- Cover/gallery asset selection and rendering, broken-link repair UI, dependency reports, and archive-time ref existence resolution; imported dangling refs remain inert instead of binding by name.
- A distinct permission-filtered selected-content bundle, dependency closure, conflict choices, atomic ID remapping/merge, and Markdown/Obsidian export.
- The complete multiplayer, accessibility, browser E2E, large-graph/import, rollback and release acceptance matrix.

These gaps require additional authoring and host contracts that the current VTT does not expose as reusable features yet. In particular, a generic document op is not an idempotent economy transaction, full World ZIP is not a safe sharing bundle, and arbitrary widget config is not an approved widget API.

## 6. Research references

- [Foundry package page — current version and feature summary](https://foundryvtt.com/packages/campaign-codex)
- [6.9.8 module manifest](https://modules.wgtngm.net/cc13/6.9.8/module.json) · [official changelog](https://campaigncodex.wgtngm.com/campaign-codex/changelog/)
- [Official Campaign Codex docs](https://campaigncodex.wgtngm.com/): [Regions](https://campaigncodex.wgtngm.com/campaign-codex/sheets/region/), [Locations](https://campaigncodex.wgtngm.com/campaign-codex/sheets/location/), [Entries](https://campaigncodex.wgtngm.com/campaign-codex/sheets/entries/), [NPCs](https://campaigncodex.wgtngm.com/campaign-codex/sheets/npcs/), [Tags](https://campaigncodex.wgtngm.com/campaign-codex/sheets/tags/), [Groups](https://campaigncodex.wgtngm.com/campaign-codex/sheets/group/), [Quests](https://campaigncodex.wgtngm.com/campaign-codex/content-panels/quests/), [Inventory](https://campaigncodex.wgtngm.com/campaign-codex/content-panels/inventory/), [Import](https://campaigncodex.wgtngm.com/campaign-codex/import-export/importing/), [Export](https://campaigncodex.wgtngm.com/campaign-codex/import-export/exporting/), [API](https://campaigncodex.wgtngm.com/campaign-codex/api-documentation/), [Custom Widgets](https://campaigncodex.wgtngm.com/campaign-codex/widgets-api/).
- [Earlier source snapshot overview](https://deepwiki.com/xthesaintx/cc13) · [flag model](https://deepwiki.com/xthesaintx/cc13/2.2-flag-based-data-model) · [link resolution](https://deepwiki.com/xthesaintx/cc13/2.3-linkers-and-data-resolution) · [widget system](https://deepwiki.com/xthesaintx/cc13/4-widget-system) · [economy architecture](https://deepwiki.com/xthesaintx/cc13/5-economy-and-inventory-system) · [data portability](https://deepwiki.com/xthesaintx/cc13/8-data-portability-and-migration). These pages are indexed from 2026-04-05 and are not a source audit of 6.9.8.
