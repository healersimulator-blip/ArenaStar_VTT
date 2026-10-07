# Campaign Codex for ArenaStar VTT

**Status:** product and technical specification; partial implementation as of 2026-10-07 (see §13 GAP list)

**Research baseline:** Campaign Codex 6.9.8, reviewed 2026-10-06

**Related:** [Capability-transfer plan](CAMPAIGN_CODEX_TRANSFER_PLAN.md)

## 1. Summary

Add a campaign knowledge layer to ArenaStar built on its existing journals, pages, actors, items, scenes, tags, permissions, and world files. GMs can author connected NPC, Entry, Location, Region, Group, and Tag sheets; organize them in a navigable Hub; publish selected content to players; track quests and objectives; and later use widgets and shops as interactive campaign tools.

The core design decision is **not to replace journals**. Existing journals remain valid and continue to render as they do today. A journal can opt into Codex behavior by carrying optional typed metadata. Its prose remains in ordinary journal pages; typed relationships and widget/quest state remain data. Codex views are projections over ArenaStar documents, not a new parallel campaign database.

The design follows the user-facing capabilities documented by Campaign Codex, while adapting its architecture to ArenaStar’s typed documents and host-authoritative permission model. It does not copy the Foundry module’s code, flags, dependencies, or branding. The current Campaign Codex v6.9.8 source archive could not be inspected in this environment; implementation observations are limited to the current manifest/docs and an explicitly older source snapshot. See §14.

## 2. Product goals and principles

### Goals

1. Make campaign facts easy to create, find, and navigate without breaking standard handouts.
2. Represent links between journals/pages, actors, items, scenes, and Codex sheets as stable, validated references.
3. Give GMs fine-grained control over what each player can discover and read.
4. Let groups and regions provide a useful tree/dashboard view over those linked documents.
5. Add quests/objectives and a player-facing quest board with explicit, safe publication rules.
6. Add reusable, versioned widgets and eventually PF1e-aware shop/loot transactions.
7. Preserve all Codex content and references in world-file workflows and support safe conversion/export.

### Non-negotiable principles

- **Compatibility:** absent Codex metadata means existing journal behavior is unchanged.
- **Host authority:** all durable writes, links, purchases, imports, and visibility transitions are validated by the host.
- **Projection before display:** hidden titles, IDs, links, quest objectives, item values, and widget data are removed before they reach an unauthorized client. Hiding a DOM node is not access control.
- **References, not copied content:** link to actors/items/scenes/pages by `DocRef`; render a viewer-authorized card from the current target.
- **No permission escalation:** a link, tag, pin, widget, selected audience, or parent relationship never grants read/write access by itself.
- **Typed and migratable:** use versioned types and validators rather than unbounded data in `flags` or executable document text.
- **Transactions for mechanics:** a shop/purchase widget never mutates an actor directly; the host validates and commits one idempotent operation.

## 3. Capability scope

| Capability      | Initial design scope                                                               | Later/optional scope                                        |
| --------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Semantic sheets | Group, Region, Location, Entry, NPC, Tag views over journal documents              | More system-specific templates or new role types            |
| Linking         | Journals/pages, actors, items, scenes, Codex entries; reverse links derived        | Cross-world/cloud links                                     |
| Navigation      | Codex Hub, type/tag filters, group tree, recent/back navigation                    | External read-only Web Hub                                  |
| Quests          | Quest records, ordered objectives, status, pinning and publication                 | Party-specific quest variants and automation                |
| Widgets         | First-party typed renderer registry; safe read-only widgets first                  | Third-party widgets with explicit capabilities              |
| Economy         | Entry inventory, loot/shop presentation, PF1e adapter and host-validated transfers | Additional rules systems through adapters                   |
| Portability     | Full World ZIP save/load, replace/copy, media-rights handling                      | Selected bundle merge/remap; Markdown/Obsidian export later |

This is a phased product. A Hub or sheet renderer alone is not Campaign Codex feature parity; quest privacy, widget security, economy transactions, and data portability are separate completion gates.

## 4. Users and primary workflows

### GM / Assistant

- Create a Codex sheet from the Journal panel or Hub; choose its role and a visibility default.
- Add pages/tabs, links, tags, quests, and widgets in the same editor.
- Drag a journal, actor, item, or scene onto a compatible target, or use a search picker.
- Reorder, rename, hide, and configure tabs; preview the sheet as GM or as a selected player.
- Export a full World ZIP for backup/transfer, then use the start-screen **Open file (.zip)** flow to **Restore** under its archived ID (overwriting a matching local world when present) or **Open as new world**. Starter templates remain copy-only. Selected-content bundles and merge conflict review are a later, separate workflow.

### Player

- Open the Hub or a shared handout and see only authorized sheets and cards.
- Follow permitted links and navigate back to the originating Group/Region/Location.
- See only quests and objectives explicitly published to them; pinning does not alter permission.
- Use permitted shop/loot controls if they have an owned character and the host accepts the transaction.

### Core journeys

1. **Build a campaign tree:** make a Group, add Regions and Locations, link Scenes, and associate Entries/NPCs.
2. **Publish a person or place:** link an NPC sheet to an Actor; keep private GM notes separate from player-readable content; verify the result in player preview.
3. **Run a quest:** add a quest to a sheet, author objectives, publish selected objectives, pin it to the Hub, then update completion as play progresses.
4. **Run a shop/loot scene:** link stock items to an Entry, choose loot or shop mode, configure prices/stock, and let an eligible player submit a purchase that the host validates.
5. **Save, restore, or copy a campaign:** export its full World ZIP, then use **Restore** (keep the archived ID/restore over its matching local world) or **Open as new world**; verify Codex pages, links, quest/shop state, and media survived.
6. **Share selected content:** in a later phase, export an explicitly selected, permission-filtered bundle, review dependencies and media rights, then merge with a conflict plan.

## 5. Domain model

### 5.1 Codex journal metadata

Add an optional, schema-versioned field to `JournalDocument`:

```ts
interface CodexSheet {
  version: 1;
  kind: "group" | "region" | "location" | "entry" | "npc" | "tag";
  subtitle?: string;
  cover?: string; // asset reference, not a remote fetch instruction
  tabs?: CodexTabConfig[]; // layout/presentation only
  links: CodexLink[]; // source-to-target edges
  widgets: CodexWidgetInstance[]; // versioned declarative config
  quests?: CodexQuest[];
  shop?: CodexShopConfig;
}

type CodexRelation =
  | "contains"
  | "locatedAt"
  | "associatedWith"
  | "operatedBy"
  | "representsActor"
  | "linksScene"
  | "linksItem"
  | "relatedTo";

type CodexAudience =
  | { kind: "inherit" }
  | { kind: "gmOnly" }
  | { kind: "selectedUsers"; userIds: string[] };

interface CodexTabConfig {
  key: string;
  label: string;
  order: number;
  audience: CodexAudience;
}

interface CodexLink {
  id: string;
  relation: CodexRelation;
  target: DocRef;
  label?: string; // display override; still permission-filtered
}
```

`CodexAudience` only narrows access: `inherit` uses the parent document’s read permission, `gmOnly` is GM/Assistant only, and `selectedUsers` still requires parent document read access. The exact TypeScript shape is an implementation decision; the schema contract is the important part. Add it as a typed document field, not generic module flags. Older journals omit `codex`. Migrations should add defaults only when a GM explicitly converts a journal or imports data that declares a Codex version.

### 5.2 Roles and relationships

- **Group:** organizer/dashboard. May contain Groups, Regions, Locations, Entries, NPCs, and Tags.
- **Region:** navigable geography. May contain Regions, Locations, Entries, and NPCs; may link to one or more Scenes.
- **Location:** specific place. May be nested under a Group or Region, link to Scenes, and associate NPCs/Entries.
- **Entry:** point of interest, encounter, service, shop, or loot source. May link to Scenes and carry inventory/shop configuration.
- **NPC:** narrative record optionally linked to an Actor; can be associated with places, entries, groups, and Tags.
- **Tag:** descriptive Codex record linked to other Codex sheets. It is distinct from ArenaStar’s existing string-valued Tagger labels.

Use a small, typed relation vocabulary (`contains`, `locatedAt`, `associatedWith`, `operatedBy`, `representsActor`, `linksScene`, `linksItem`, `relatedTo`). Each edge is stored once on its source; reverse links are derived. Uniqueness is `(sourceRef, relation, targetRef)`. Parent/containment edges must be acyclic and bounded; default nesting depth is 5, configurable up to 10. Non-hierarchical relationships may form cycles.

A deleted target is unlinked transactionally when possible, with undo data. A pre-existing dangling reference is shown to the GM as a repairable warning and is never followed blindly. Sorting is deterministic by authored order, then name and ID.

### 5.3 Pages and tabs

Keep narrative text in existing `JournalPageDocument` pages. Add optional typed Codex presentation metadata to pages (for example, tab key, label override, order, and audience policy). Tab layout and page content are separate: changing a tab label/order must not rewrite a page’s prose.

Initial tab roles: **Info**, **Relationships**, **Quests**, **Inventory** (Entry only), **Notes** (GM-only by default), and configurable custom tabs. The base journal page remains available for non-Codex imports and conversion fallback.

### 5.4 Quests and objectives

A quest is embedded, stable-ID data on the parent Codex sheet:

```ts
interface CodexQuest {
  id: string;
  title: string;
  description: string;
  state: "active" | "completed" | "failed";
  pinned: boolean;
  audience: CodexAudience;
  order: number;
  objectives: CodexObjective[];
}
interface CodexObjective {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  audience: CodexAudience;
  order: number;
  children: CodexObjective[];
}
```

The host projects quest and objective records separately. A private objective must not leak through an otherwise visible quest title, count, reorder event, or completion summary. Player progress mutation is GM-only initially; later policy may allow a GM to delegate a specific quest/objective action.

### 5.5 Widgets

A widget instance is data, not a macro:

```ts
interface CodexWidgetInstance {
  id: string;
  type: string;
  version: number;
  tab: string;
  order: number;
  enabled: boolean;
  audience: CodexAudience;
  config: Json;
}
```

Initial widgets: linked entities, quest list/checklist, image gallery, timeline, scene/map note, and roll-table display. Start read-only. Any write-capable widget must declare a narrow capability and call a host-validated operation; it cannot submit arbitrary ops or fetch hidden documents/media by ID.

### 5.6 Inventory and economy

An Entry’s shop configuration references Item documents instead of copying their definitions. Each stock row stores a stable row ID, item `DocRef`, optional quantity/price override, category/order, and purchase visibility. Shop settings include mode (`shop` or `loot`), markup, and transaction policy. The PF1e adapter owns price/currency path interpretation; unsupported item/currency shapes remain view-only with a clear notice.

A purchase request carries a request ID, sheet/row, quantity, and target actor. The host re-resolves the item and actor, checks caller and actor ownership, price, stock, current currency and quantity, then commits stock reduction + actor item/currency updates atomically. Duplicate request IDs return the prior result, not a second transfer.

## 6. Visibility and authority

### 6.1 Effective access

The effective access rule is an intersection, never a union:

```text
read Codex content = can(user, "read", parent journal)
                 AND page/tab/quest/widget audience allows user
                 AND every linked entity/media item is independently readable
```

- **GM/Assistant:** may author and preview all content.
- **Players:** need document read access first. `CodexAudience` can narrow that access to GM-only or selected readers; it cannot grant access to a document the user otherwise cannot read.
- **Tab/page policy:** use typed `inherit`, `gmOnly`, or `selectedUsers` rules. Do not rely on the page’s embedded `ownership` value alone: current journal projection sends pages based on the parent journal and redacts `<secret>` blocks; Codex needs explicit field-level filtering before snapshots and updates.
- **Quests/objectives:** each record is independently filtered. Pinned means “show in navigation if authorized,” never “show regardless of permission.”
- **Links:** inaccessible targets are omitted or replaced with a generic non-identifying placeholder. Never send the target ID, name, image, or count unless authorized.
- **Widgets:** receive only projected inputs; widgets cannot probe the host store.
- **Media:** use Arena’s media visibility and export-rights checks; neither link visibility nor audience selection grants bytes.

Apply the same projection for snapshot, create/update/delete, reconnect/catch-up, export, Hub results, popouts, search indexes, and summaries. Permission revocation must remove data already delivered to a replica, not only disable a button.

### 6.2 Authoring and action permissions

Document read permission, edit permission, player visibility, and optional player actions are separate. Initial policy:

| Operation                                                               | GM/Assistant                    | Player                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Create/edit/delete Codex sheet, links, tabs, widgets, quest definitions | Yes                             | No by default; ownership-based editing can be evaluated later                                     |
| Read player-facing content                                              | Yes                             | Only if document and content policy allow                                                         |
| Update objective completion                                             | Yes                             | No in MVP                                                                                         |
| Buy/send item                                                           | Yes                             | Only through a specific published operation, owned actor, host transaction, and live revalidation |
| Register/install a widget                                               | Via package/GM-authorized setup | Never by a client-authored widget config                                                          |

## 7. User interface design

### 7.1 Hub / Navigator

Add a **Codex** entry in the Journals area and a scene toolbar button for the Hub. Hub tabs: Groups, Regions, Locations, Entries, NPCs, Tags, and Quests. Provide search by name, type, Codex Tag, and link relation; filters must operate over the viewer’s projected store. Include recent/back navigation, “open sheet,” and a GM-only create action. Do not show hidden result counts or hidden tags.

### 7.2 Common sheet shell

Each sheet uses a common frame:

- Header: title, role icon, subtitle, permitted cover image, edit/read status.
- Sidebar: quick links, parent/child tree, associated Actor/Scene, tag chips, context actions.
- Main tabs: Info and role-specific panels, with custom tab ordering/labels.
- GM controls: edit content, manage links, configure tabs/audience, add widgets, preview as selected player.
- Player controls: only authorized open/follow actions; no disabled-but-readable private controls.

NPC links surface the current Actor card; Location/Entry links surface Scenes; Entry may expose Inventory; Group provides the nested dashboard instead of duplicating child content. Use one link picker/drop target component across all roles.

### 7.3 Group dashboard and tree

The Group sheet defaults to a tree/sidebar and overview cards. Tree controls expand/collapse, filter role types, switch to tag-oriented grouping, and optionally show linked Entry items only when permitted. Selecting a child opens it in the Group’s content region; the group header remains in context. A child can be opened in its own window as well.

### 7.4 Quest Board

The Hub’s Quests tab shows authorized pinned quests first, followed by authorized unpinned quests if the user setting permits. Each quest expands to its authorized objectives, completion state, and source sheet link. GM can reorder, pin/unpin, edit descriptions, create nested objectives, and publish/unpublish content. Player view is read-only in MVP.

### 7.5 Widget tray

GMs add, enable/disable, reorder, move between tabs, configure, and remove widgets. Disabled configuration may be retained for later reactivation. A widget with missing code/version renders a stable placeholder and preserves its config for migration; removal of data requires explicit confirmation.

### 7.6 Shops and loot

Entry Inventory has a GM-only configure mode and a player mode with permitted item descriptions. Shop mode may show prices; loot mode suppresses price/cost fields. Actions are Send, Open, Remove (GM), and Purchase (published shop only). The UI never predicts success as a committed result; it displays host transaction feedback after the host revalidates.

## 8. Technical architecture and file map

### Existing components to extend

| Area                  | Current ArenaStar seam                                                                   | Design work                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Schema/store          | `src/core/documents.ts`, `src/core/store.ts`                                             | Add optional typed `JournalDocument.codex`, page metadata, validators, and stable IDs; preserve old-world defaults.           |
| Permission/projection | `src/core/permissions.ts`, `src/core/projection.ts`, `src/core/ownership.ts`             | Add Codex page/tab/quest/widget projector; use it for snapshots and envelopes, including visibility transitions and catch-up. |
| Host operations       | `src/host/sync.ts`, `src/core/ops.ts`                                                    | Validate link endpoint/ref changes, hierarchy constraints, shop requests, idempotency, access, and atomic commits.            |
| Tags                  | `src/core/tags.ts`, `src/ui/macros/TaggerPanel.svelte`, `src/ui/sheets/TagEditor.svelte` | Reuse existing tag queries/index; integrate Codex Tag sheets without changing generic Tagger semantics.                       |
| Journals UI           | `src/ui/journals/`                                                                       | Add Hub, common Codex sheet, editors, link picker, Quest Board, widget host, and read-only player views.                      |
| Packages/widgets      | `src/core/moduleApi.ts`, package APIs                                                    | Define a versioned widget registration contract with schemas/capabilities; all durable actions return through the host.       |
| Portability           | `src/host/worldFile.ts`, `src/host/import.ts`                                            | Codex docs/refs/assets round-trip in World ZIP; reserve filtered-bundle merge/remapping for a separate import path.           |
| Rules adapter         | `src/packages/pf1e/`, item/actor editors                                                 | Implement supported PF1e economy conversion; other systems remain read-only until they provide adapters.                      |

### World ZIP contract (required)

ArenaStar’s existing World ZIP is the canonical **full-campaign save/backup**, not a Codex sidecar:

- Export through the existing **Export world** action and start-screen export must use the same flushed archive collector. The current format-2 layout records campaign identity/sequence in `world.json`, all world document rows in `documents.json`, asset metadata in `assets.json` plus permitted `assets/<hash>` blobs, and the existing package/fog/strategic-state entries.
- Persist Codex state as typed fields on ordinary `JournalDocument` / `JournalPageDocument` records (or as registered persistent document collections if the model later requires them). Thus sheet kind, prose/pages, tab and audience metadata, links, quest/objective progress, shop stock/price/config, widget config, and any durable transaction receipts travel in `documents.json`; linked actors, items, and scenes travel as their normal document rows. Request-deduplication caches and UI state may reset, but must not be the source of durable quest or shop state. Do not make browser-local state, an index, caches, or an unregistered IndexedDB store the sole copy of campaign information.
- Store cover/gallery/widget media as references to ArenaStar content-addressed assets. Their metadata and bytes use the existing asset archive and rights checks; remote URLs are not an import instruction. Rebuild `CodexIndex` from imported committed docs instead of serializing it as authority.
- A full World ZIP is GM-private: it contains **all** world records, including GM-only notes/pages and ownership/audience rules, not the current viewer’s projection. It is a recovery/transfer archive, never a player-facing share bundle. Public or selected-content exports require a separate permission-filtered pipeline.
- Keep the Codex schema version independent from `WORLD_FILE_FORMAT`: an additive optional Codex field should remain readable from legacy format-1/2 archives. Change the outer ZIP format only if its archive layout changes; retain readers for supported prior formats.
- Package files may be present in a World ZIP, but local package trust and reviewed-script approvals are not imported. Widget config is inert data: an unknown/untrusted widget renders a placeholder until a locally registered, approved renderer is available; imported code cannot gain execution rights from the archive.

### Indexing and write granularity

Maintain a derived `CodexIndex` from committed store changes for parent/child lookups, reverse links, entity cards, and Hub filters. Invalidate incrementally on journal/page/actor/item/scene/tag changes. The index is a performance aid, not authority: host queries re-resolve each target and its current access; never reuse another viewer’s cached authorization result. Client-facing Hub search runs against that client’s projected data or an equivalently filtered host result.

Codex edits must be small, conflict-aware operations: update a page by its embedded `DocRef`, update one link/widget/quest row by stable ID, and preserve unrelated siblings. Avoid replacing the whole `pages`, `codex`, `widgets`, or `quests` arrays during a single-field edit—the current journal editor’s whole-pages-array shape is not appropriate for concurrent Codex authoring. Use the existing op sequence and report a stale/missing row so the editor can reload or merge rather than silently losing another edit.

### Runtime flow

```text
GM authors a Codex journal/page
  → client submits ordinary document op(s)
  → host validates schema, refs, permissions, limits, and transaction boundaries
  → committed world store + undo history
  → host projects safe snapshot/op per user
  → Hub/sheet resolves only permitted link cards and registered widgets
```

For a purchase:

```text
player clicks Purchase
  → requestCodexPurchase(requestId, shopRef, stockRowId, quantity, actorRef)
  → host re-reads live user, journal, row, item, actor, funds, and stock
  → one atomic validated commit / action receipt
  → per-viewer projected result and updated inventory
```

## 9. Import, export, and migration

### 9.1 Full-world save, restore, and copy

- **Save/export:** the app’s **Export world** action and start-screen world export call the same `exportWorldZip` / archive collector. Flush pending persistence before taking the snapshot. The resulting ZIP is the full campaign save, including Codex records, linked world documents, authorized asset blobs, and related world state.
- **Load/restore:** use **Open file (.zip)** on the start screen, classify and validate the archive, then choose **Restore** under its archived ID (or restore over the matching local world) or **Open as new world**. Starter templates remain copy-only. Continue to read supported format-1/2 archives when they have no Codex fields; ordinary journals remain ordinary journals.
- **Replace/restore:** restore under the archive’s original `worldId`, replacing that world’s documents and related data as one import operation. This is recovery, not a merge; the current world-file importer resets oplog/undo history for the restored world. Preflight/commit failures must leave the existing database campaign usable and not partially replaced, with a clear report; unreferenced content-addressed blobs may be cleaned up separately.
- **Copy:** create a new `worldId` and user-selected name while leaving the source world untouched. A full-world copy preserves document IDs and ordinary `DocRef`s: these refs contain collection/document/parent IDs and are resolved against the active world’s store, so the same graph resolves inside the copy without rewriting each edge. Any future explicit cross-world reference must be separately validated, remapped, or dropped; it must never silently retain a link to the source. Rebuild indexes and caches after import.
- Verify archive paths, sizes, document schemas, and content hashes before activation. World-file asset bytes are not a transferable license: preserve their rights metadata, apply import restrictions, and require local review/reapproval where required by the asset policy.

### 9.2 Codex schema migration and safe loading

- Version Codex metadata independently from `WORLD_FILE_FORMAT`. Additive optional fields must default safely; format-1/2 ZIPs and journals without Codex metadata need no destructive rewrite. Keep migrations deterministic, idempotent, and covered by fixtures.
- Validate role metadata, stable page/link/quest/objective/widget IDs, relation types, sizes, asset refs, and document refs in a staging world before commit. Report unresolved refs as explicit broken-link placeholders rather than binding by name. Ordinary `DocRef`s are world-relative; any explicitly supported web/cross-world link must remain inert and follow a separate validation policy. Reject structurally corrupt archives without partially replacing the campaign.
- Preserve unsupported but well-formed optional data when possible. If a newer Codex schema or widget type cannot be interpreted, keep it inert/read-only and report it; never execute imported configuration or silently discard it. Unknown widgets render the placeholder described in the ZIP contract.
- Recreate derived `CodexIndex`, reverse links, search data, and other caches from committed source documents after restore/copy. They are disposable and must not be needed to recover the campaign.

### 9.3 Selected-content bundle and merge (separate from full World ZIP)

A selected-content or player-facing bundle is a later, distinct feature; it must not weaken the full-world ZIP’s backup contract or reuse its unfiltered data path. Require explicit roots and a dependency preview. Compute the selected transitive closure of authorized pages, linked documents, quest/widget state, and media; show omitted or dangling refs and rights restrictions. Apply the viewer/export policy before serialization so GM-only material and hidden counts cannot leak.

For import into an existing world, preview new, matched, replaced, conflicting, and unresolved targets. Matching by name alone is never silent. Require explicit skip/link/replace choices; build one complete ID-remap table and rewrite every internal `DocRef` and relationship atomically before commit. Do not leave a partial import or an accidental link to the source world. Media with disallowed rights is omitted with a report, not fetched from remote URLs.

### 9.4 Standard-journal conversion and text export

Standard-journal conversion is opt-in and reversible: preserve original page content, secrets, ownership, and ordering; add typed Codex metadata; and show a conversion report before commit. Support cancel/undo and verify that the converted journal survives a normal full-world ZIP export and restore. Markdown/Obsidian export is a later phase; map links deterministically and apply the relevant visibility filter rather than exporting the full GM backup to players.

## 10. Delivery sequence

1. **Domain and permission contract:** schema, role/relation catalog, page/quest projection model, migration fixtures, threat model.
2. **Data and graph foundation:** typed metadata validators, link index, host ops, permission projection, undo and world-file round-trip.
3. **Core authoring/navigation:** common sheet shell, six role layouts, link picker, group tree, Hub, search and player preview.
4. **Quest system:** quest/objective editing, publication, board navigation, filtered player view.
5. **Widget runtime:** safe registry, widget tray, first-party read-only widgets, package registration and migration.
6. **PF1e inventory/economy:** Entry shop/loot, adapter, atomic buy/send, transaction receipts and denial paths.
7. **Portability/release:** verify full-world ZIP round-trip/restore/copy; add selected-bundle conflict UI and ID remapping as a separate path; then conversion, Markdown export, performance, accessibility, migration, and multiplayer security review.

Each stage should ship only after its exit tests pass; do not combine feature completeness with UI presence.

## 11. Acceptance and test plan

### Unit/schema

- Valid/invalid role metadata, duplicate IDs, unknown versions, size limits, unsupported relations, malformed refs, widget config migrations, quest/objective IDs and ordering.
- Parent-cycle and maximum-depth validation; deterministic reverse-link index updates.
- Audience/policy predicate matrix for GM, Assistant, owner, observer, limited reader, non-reader, and selected-user lists.
- PF1e price/currency parsing rejects missing, negative, overflow, and unsupported paths rather than guessing.

### Host and projection integration

- Link create/update/delete is owner-authorized, target-validated, undoable, and consistent in reverse views.
- A player cannot probe a private journal/page/Actor/item/Scene by changing a `DocRef` or widget config.
- A hidden tab/quest/objective is absent from snapshots, updates, reconnect/catch-up, Hub search, card counts, and exports; permission revocation removes previously projected content.
- Pinning never publishes; player widget inputs never contain hidden IDs/names/assets.
- Purchase tests cover insufficient funds, stale stock, duplicate request ID, concurrent buy, unauthorized actor, deleted item, and atomic rollback.

### World-file and browser E2E

- Legacy journals and supported format-1/2 world files with no Codex fields load and re-export without destructive migration.
- Export after pending writes flushes a complete snapshot. The app-header and start-screen exports contain the same Codex document, asset, and world-state entries.
- Full format-2 round-trip preserves Codex role/schema metadata, page text/order/audience, tabs, tags, world-relative link refs, quest/objective state, widget configuration, shop stock/price/configuration and durable transaction receipts, post-purchase actor inventory/currency, linked Actor/Item/Scene records, and supported media metadata plus bytes/hash. Any separately supported external link remains inert.
- Replace/restore uses the original world ID, restores the snapshot, and resets the restored world’s oplog/undo history. Copy creates a distinct world ID/name, does not mutate the source, preserves ordinary world-relative document IDs and refs, and verifies every copied relationship resolves only against the copied world’s documents.
- Bad archive structure, invalid IDs/refs, schema migration failures, or asset hash mismatch produce a clear error and no partially replaced campaign. Unresolved document refs remain explicit broken-link placeholders, never silently bind by name; external URLs are not fetched.
- Missing/unsupported widget packages render inert placeholders with config preserved. Package trust and reviewed-script approvals remain local; restricted media is not silently redistributed, and remote media URLs are never fetched during restore.
- Any future selected-content bundle is tested separately: hidden pages/fields, private quests, hidden counts, and non-exportable media are absent, while included refs and dependencies are reported and remapped atomically on merge.
- GM and two players with different ownership/page audiences see correct Hub trees, backlinks, quests, and widget cards after restore and reconnect.
- Standard journal conversion preview, cancel, commit, undo, full-world export, and restore preserve prose, secrets, ownership, and page order.
- Keyboard navigation, screen-reader labels, narrow viewport, large relationship graph, and large import preview are covered.

## 12. Open decisions and risks

1. Whether the first release exposes all six sheet roles together or starts with Group/Region/Location/Entry/NPC and adds Tag sheets in a follow-up.
2. The exact tab audience vocabulary and whether any player may author personal/private Codex sheets. MVP defaults to GM authoring only.
3. PF1e price/currency semantics and item transfer rules for worlds with custom item fields. Unsupported inputs must stay read-only until a reviewed adapter exists.
4. Whether a connected bundle stores relationship edges on journal metadata or a dedicated typed edge collection. Start embedded unless profiling or atomic-edit requirements justify the extra collection.
5. Selected-content merge conflicts for matching actor/item names. Require preview and explicit choice; never perform silent replace.
6. Widget package trust model: only safe data/render extension initially; defer privileged write widgets until capability and audit contracts exist.
7. The latest Campaign Codex implementation source was not accessible for a current source audit. Verify version-specific workflows against a downloaded 6.9.8 archive before asserting implementation parity.

## 13. Incremental implementation status, gaps, and non-goals

The first implementation slice is present, but this is **not a parity-complete release**. Ordinary journals remain compatible. Codex uses typed metadata on existing journal/page documents; current full-world archives already collect those rows, so no sidecar or outer ZIP format change was added.

### Implemented in this slice

- Typed version-1 metadata for six sheet roles, tabs/page presentation and audience, relationships, quests/objectives, widget instances/config, and shop/loot stock.
- Pure validation for bounded schema data, stable IDs, supported DocRefs and relation targets, containment cycles/depth, and shop item targets. New or changed refs are host-validated; pre-existing dangling refs are not rebound by name.
- GM/Assistant-only create/update/delete protection for Codex journals and pages, including embedded page and audience changes. Linked-target deletion is blocked until remaining Codex references are removed in the same transaction.
- Non-GM snapshot/live projection for page/tab/quest/objective/widget/shop audiences, readable linked documents, secret text, loot prices, and inert widget configuration. Visibility changes to embedded pages are rewritten as create/delete transitions.
- Full World ZIP format-1/2 compatibility and format-2 save/restore/copy of Codex fields through ordinary journal rows. Known version-1 metadata is validated before import; bounded unknown future versions are preserved inertly. Full archives remain distinct from selected-content bundles and merge workflows.
- Focused schema/projection, host authorization/live-replication, and archive tests exist. Passing targeted checks are recorded with the implementation changes; the remaining §11 matrix is still a release gate.

### GAP list — not yet delivered / requires additional VTT functionality

1. **Role-specific authoring and navigation:** the Journals and player Handouts surfaces have a basic Codex Hub/sheet reader/editor, six role labels, simple name/subtitle search, tabs/pages, relationships, quest/objective toggles, widget placeholders, and stock configuration. The specialized Group tree/dashboard, Region/Location semantics, six role-specific layouts, back/recent navigation, drag/drop, reverse-link index/backlinks, tag integration, full-text/search indexing, conversion preview/undo, and bulk player preview are not implemented.
2. **Audience authoring:** the data model supports `selectedUsers`, but the current editor exposes only inherit and GM-only controls. Per-user preview and an ergonomic selected-reader picker are missing.
3. **Widgets:** widget records are inert and preserved; the player projector deliberately removes arbitrary config. There is no registered first-party renderer registry, config-schema migration host, package capability API, media-safe gallery, timeline/map/roll-table renderer, or widget-specific permission test suite. Unknown widgets show safe text placeholders.
4. **Economy transactions:** the UI edits stock, quantity, mode, and simple string prices; it is not a transaction system. Missing pieces are a PF1e currency/price adapter, a host-authoritative idempotent purchase/send request, concurrent-stock/funds validation, atomic actor currency/item transfer, durable transaction receipts, replay/undo behavior, and feedback for unsupported item shapes. Players cannot purchase or send items.
5. **Relationship repair and derived views:** new/changed links validate and deletions cannot strand supported-version references, but there is no CodexIndex/backlink cache, broken-link repair UI, bulk unlink workflow, deterministic role-aware tree, or archive-time dependency report. Archive load intentionally preserves unresolved refs inertly instead of binding them by name.
6. **Asset authoring/reporting:** Codex cover/gallery media pickers and renderers are absent. The existing content-addressed asset archive and export-rights restrictions continue to apply; archive import does not transfer a redistribution license. Restricted or unreviewed media may therefore not be available for a subsequent full-world export without local rights review.
7. **Selected-content portability:** the implemented World ZIP remains a full-world private backup with replace/restore and copy behavior. There is **no** selected-content/player-safe bundle, dependency closure preview, existing-world merge, collision UI, atomic ID remapping, or Markdown/Obsidian export. These must use a separate filtered pipeline and must never reuse an unfiltered World ZIP as a share bundle.
8. **End-to-end/release coverage:** targeted unit, host, live projection, and World ZIP cases cover the implemented slice. The complete §11 matrix—multiplayer permission permutations, large import/graph limits, failure/rollback recovery, accessibility/browser journeys, every relation/deletion path, and the future transaction/widget features—has not been run or satisfied.

The current VTT provides typed documents, ownership, host ops, live replication, content-addressed assets, and a full-world ZIP, which are sufficient for the implemented metadata/projection slice. It does **not** currently provide the widget registry/capability boundary, Codex purchase transaction contract, selected-bundle merge/remap path, or full role-specific UI; those are concrete feature gaps, not implied parity. Keep the acceptance criteria in §11 as release gates.

### Non-goals

- This design does not add the hosted Web Hub, accounts, public campaign publishing, or external relay service.
- It does not copy Foundry’s proprietary/UI code, logos, or third-party widget/media libraries.
- It does not let an imported widget or a player-authored document run arbitrary code.
- It does not promise cross-system shopping until each rules adapter defines an explicit, tested price and transaction contract.
- It does not claim Campaign Codex parity until the full acceptance matrix, privacy/reconnect paths, export/import, and supported economy behaviors pass.

## 14. Research references

- [Foundry package page](https://foundryvtt.com/packages/campaign-codex) · [6.9.8 manifest](https://modules.wgtngm.net/cc13/6.9.8/module.json) · [official changelog](https://campaigncodex.wgtngm.com/campaign-codex/changelog/)
- Official docs: [Groups](https://campaigncodex.wgtngm.com/campaign-codex/sheets/group/), [Regions](https://campaigncodex.wgtngm.com/campaign-codex/sheets/region/), [Locations](https://campaigncodex.wgtngm.com/campaign-codex/sheets/location/), [Entries](https://campaigncodex.wgtngm.com/campaign-codex/sheets/entries/), [NPCs](https://campaigncodex.wgtngm.com/campaign-codex/sheets/npcs/), [Tags](https://campaigncodex.wgtngm.com/campaign-codex/sheets/tags/), [Quests](https://campaigncodex.wgtngm.com/campaign-codex/content-panels/quests/), [Inventory](https://campaigncodex.wgtngm.com/campaign-codex/content-panels/inventory/), [import](https://campaigncodex.wgtngm.com/campaign-codex/import-export/importing/), [export](https://campaigncodex.wgtngm.com/campaign-codex/import-export/exporting/), [API](https://campaigncodex.wgtngm.com/campaign-codex/api-documentation/), [widget API](https://campaigncodex.wgtngm.com/campaign-codex/widgets-api/).
- Earlier source snapshot, indexed 2026-04-05: [overview](https://deepwiki.com/xthesaintx/cc13), [architecture](https://deepwiki.com/xthesaintx/cc13/2-core-architecture), [data model](https://deepwiki.com/xthesaintx/cc13/2.2-flag-based-data-model), [link resolution](https://deepwiki.com/xthesaintx/cc13/2.3-linkers-and-data-resolution), [widgets](https://deepwiki.com/xthesaintx/cc13/4-widget-system), [economy](https://deepwiki.com/xthesaintx/cc13/5-economy-and-inventory-system), [portability](https://deepwiki.com/xthesaintx/cc13/8-data-portability-and-migration). This is not a source audit of 6.9.8.
