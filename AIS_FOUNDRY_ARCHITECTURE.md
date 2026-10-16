# Running Foundry modules on ArenaStar — the layered architecture

*Status: design of record for Target A (D-482…D-487) and the slices that follow. Written
2026-10-15 after the owner asked for the overall project architecture to be settled before more
slices were added. Companion documents: [`DECISIONS.md`](DECISIONS.md) (D-468…D-487),
[`AIS_PF1E_MODULE_READINESS.md`](AIS_PF1E_MODULE_READINESS.md) (R-01…R-11 per real module),
[`AIS_MODULE_GUIDE.md`](AIS_MODULE_GUIDE.md) (the generic module API), the adapter's own
[`README`](modules/ais-foundry-v13/README.md).*

## 1. Goal and the two rules everything follows

**Goal (Target A).** A Foundry VTT module written against Foundry's *core* API — its `module.json`
distribution untouched — imports into an ArenaStar world and runs: settings, i18n, hooks, windows,
documents, chat, sockets, files, packs. Modules that depend on the `pf1` *system* (its data models,
sheets and rules) are Target B and build on the same layers later.

**Rule 1 — emulate the contract, never copy the implementation.** ArenaStar provides its own
implementation of what Foundry's *host* provides to a module (APIs, core templates, language keys,
base CSS, data fields, documents). Nothing from Foundry's code or files is vendored. A module must
not be asked to ship what Foundry would have given it (D-484).

**Rule 2 — the kernel stays generic; Foundry lives in the adapter.** Every capability added for
Foundry compatibility is an ordinary AIS service that any ArenaStar module can use (settings,
compendium, module bus, documents). The Foundry-specific mapping — names, subtypes, hook
signatures, `game.*` — is confined to the `ais-foundry-v13` runtime provider that runs *inside*
the module's sandbox. This keeps route (b) ("upgrade AIS + adapters, reusable") honest: the
first-party PF1e packages and third-party AIS modules get the same services.

## 2. The layers

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ L3  Foundry module (unmodified module.json distribution, ES modules + scripts + hbs)  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ L2  ais-foundry-v13 runtime provider — inside the module's sandboxed iframe           │
│     hbs.js  jq.js  core.js  fields.js  documents.js  ui.js  adapter.js                │
│     game / Hooks / CONFIG / CONST / foundry.* / ui.* / Document & Application classes │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ L1  AIS kernel (shell code, Foundry-agnostic) — one per device                        │
│     packages · manifests · capabilities (23) · sandbox + RPC (31 methods) · events    │
│     (10) · settings docs · compendium · module bus · panel chrome · sharing/consent   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ L0  ArenaStar world — documents, Ops, host validation, projection, replication, IDB   │
└──────────────────────────────────────────────────────────────────────────────────────┘
          GM device ──────── host (validates, projects) ──────── player devices
```

### L0 — the world (what already existed and shapes everything above)

- **Documents are Foundry-shaped.** `BaseDocument { _id, type, name, ownership{default,[userId]},
  flags{scope:{…}}, system }`; `ActorDocument.items[]/effects[]`, `ItemDocument.effects[]`,
  `JournalDocument.pages[]`, `CombatDocument.combatants[]`, `RollTableDocument.results[]`,
  `MacroDocument.kind/command`, `FolderDocument.parent/targetType`, `UserDocument.role`.
  Ownership levels NONE/LIMITED/OBSERVER/OWNER and roles GM/ASSISTANT/TRUSTED/PLAYER are the
  same lattice Foundry uses. The one impedance gap: ArenaStar's `type` is the *kind marker*
  (`"actor"`), Foundry's `type` is the *subtype* (`"npc"`); §4 says where the subtype lives.
- **One mutation path.** `Op = create{coll,parent?,data} | update{ref,diff} | delete{ref}` with
  dotted-path `FlatDiff` (`"-=path": null` deletes) — the same shape as Foundry's `update()`
  data. Every transaction, from the shell UI or a module, goes host-side through
  *rate limit → permissions → schema-lite → invariants*, is projected per user and replicated as
  an `OpEnvelope`. Each device holds a `DocumentStore` replica of what its user may see.

### L1 — the AIS kernel

Services a module reaches over the sandbox RPC, each behind a capability the user granted (or a
build-signed first-party hash pre-approved):

| Concern | Kernel service | Capability | Since |
|---|---|---|---|
| Settings (world = replicated doc, device = IDB) | `settings.list/get/set/register` | `module.settings.write` | D-476/D-482 |
| Compendium packs (host device) | `compendium.list/search/get` | `compendium.read` | D-477 |
| Module directory + invocation | `modules.list/invoke` | `modules.invoke` | D-478 |
| Panel (host-chromed window around the sandbox) | `ui.panel.open/close`, `ui.panel.closed` | `ui.panel` | D-470/D-483 |
| Notifications, choices, chat | `ui.notify`, `ui.select`, `chat.post` | `ui.notify`, `ui.interaction`, `chat.post` | v1 |
| Active scene, tags, token light, FX | `scene.read.visible`, `scene.tags.*`, `scene.token.light.apply`, `fx.*` | `scene.*`, `fx.play` | v1/D-473 |
| **World documents** | `documents.context/list/get/mutate`, `documents.changed` | `documents.read`, `documents.write` | **D-485** |
| Package files | `package.resource.read` | `package.resources.read` | D-482 |
| Sharing with players, consent, first-party trust | profile + per-device consent, build hashes | — | D-468/D-471 |

**Authority model (settled, no new design needed).** A module runs *with the device user's
authority, narrowed by its capabilities, never widened*. On the GM device its writes are GM
writes; on a player device they are that player's writes; the host validates them exactly as it
validates the shell's own UI. Reads come from the device's own replica, which the host already
projected for that user. Capabilities therefore gate *what a module may ask for*, while
permissions decide *what the user may do* — two independent fences.

### L2 — the runtime provider (`ais-foundry-v13`)

Loaded into the module frame before the module's own files, in this order:

| File | Emulates | Notes |
|---|---|---|
| `hbs.js` | Handlebars (parser, helpers, partials) | own implementation; `{{localize}}`, `{{selectOptions}}`, `{{formGroup}}`, … |
| `jq.js` | the jQuery surface Application v1 code touches | own implementation |
| `core.js` | Foundry's **resource** surface: core templates (10 + aliases), 496 core language keys, base CSS | derived from the contract, never copied (D-484) |
| `fields.js` | `foundry.data.fields`, `DataModel`/`TypeDataModel`, `foundry.applications.fields` | D-484 |
| `documents.js` | `Document` classes, world collections, embedded collections, hooks | D-485, over `AIS.documents.*` |
| `ui.js` | Application v1/v2, Dialog/DialogV2, Tabs, FormDataExtended, templates, window manager | D-483, renders inside the panel |
| `adapter.js` | `game`, `Hooks`, `CONFIG`, `CONST`, `foundry.*`, `ui.*`, settings/i18n/modules bridge, loader, `foundry.info/api/ui` commands | the entry |

The kernel synthesises the AIS manifest for an imported `module.json`
(`src/core/foundryModuleManifest.ts`): profile `foundry-module`, the capability set the adapter
needs, a panel, `sharing: "host-only"` (§5 lifts this), and `foundry.info`/`foundry.api`/`foundry.ui`
commands for script macros and tests.

### L3 — the module

Unmodified. Its ES-module graph is rewritten to `ais-foundry://<pkg>/<path>` blob imports, its
classic scripts, styles and language files load in Foundry's order, and its hooks fire
`init → i18nInit → setup → ready → canvasInit → canvasReady`.

## 3. Where each Foundry concern lives (map of the whole problem)

| Foundry concern | L0 | L1 | L2 | State |
|---|---|---|---|---|
| `game.settings` | settings doc / IDB | settings RPCs | `ClientSettings` emulation, generated form, `DataModel` types | done |
| `game.i18n` | — | package files | core keys + module files merged | done |
| Core templates / CSS / fields | — | — | `core.js`, `fields.js` | head of the distribution done; long tail queued by `foundry.info.templates.missing` |
| Application UI, dialogs | — | panel chrome | `ui.js` | done, panel-confined |
| **Documents** (`game.actors`, `Actor.create`, embedded, flags, `fromUuid`, CRUD hooks) | documents + Ops + host validation | `documents.*` + `documents.changed` | `documents.js` | **done for world collections (D-485)**; scenes/placeables next |
| Scenes, tokens, placeables | scene docs | `scene.read.visible`, `scene.tags.*`, token light | projected `Scene`/`TokenDocument` views | tags + light only; fold into `documents.*` with placeable projection (slice 2) |
| Chat (`ChatMessage.create`, `Roll`) | messages | `chat.post` (host stamps author) | `ChatMessage.create → chat.post`; `Roll` is a stub | text posts done; own `Roll` parser + verified host rolls next |
| Hooks (local) | — | — | `Hooks` in the frame | done |
| Sockets (`game.socket`, R-06) | — | module bus (same device, other packages) | `socket.on` recorded, `emit` unsupported | **needs a kernel package channel**: relay a package's events to its own frames on other devices (§5) |
| Files (`FilePicker`, `game.audio`, R-07) | asset library | — | stubs | needs an asset-library RPC (list/pick/resolve by hash) — never raw URLs |
| Packs (`game.packs`, R-10) | compendium docs | compendium RPCs | `game.packs` empty | map `CompendiumCollection` onto `compendium.*`; LevelDB packs need an importer |
| Canvas / PIXI | — | — | — | out of scope by design: the parent renderer is ArenaStar's; placeable *documents* are the compatibility surface |
| Systems (`pf1`) | — | — | system provider layer (TypeDataModels, sheets, `CONFIG.Actor.dataModels`) | Target B |

## 4. The document bridge (D-485/D-486) — design details that matter

**Kernel side (`src/core/aisDocuments.ts`, `aisModuleHandlers.ts`).**

- Exposed collections: `actors, items, journals, rollTables, macros, folders, playlists, combats`
  (writable) and `users, messages` (read-only). Not exposed: `settings, automations,
  actionReceipts, fxInstances, compendia, prefabs, scenes` (scenes keep their dedicated services
  until slice 2). Embedded chains are validated against the parent kind
  (`actors → items → effects`, `journals → pages`, `combats → combatants`).
- `documents.context` (who am I, collection sizes, limits), `documents.list` (paged: ≤500 rows,
  ≈256 KiB/page), `documents.get` (≤1 MiB), `documents.mutate` (≤32 ops, ≤512 KiB, one atomic host
  transaction). The kernel fills what the store requires and a module should not have to know:
  `_id`, the kind marker `type`, `ownership` (creator = owner, Foundry semantics), `flags`,
  `system`, per-kind defaults (`items: []`, `formula: "1d20"`, `kind: "chat"`, …) — recursively
  for inline embedded arrays. `_id` and `type` cannot be updated through a diff.
- `documents.changed { seq, by, changes:[{kind, collection, id, parent?, diff?}] }` is derived from
  each committed envelope for exposed roots (diffs ≤16 KiB inline) and delivered only to frames
  that subscribed under `documents.read`.
- Both device runtimes supply the same context from their own store: the GM's full world, the
  player's projected world. Player-side creates of actors are still refused by the host (ArenaStar
  lets players create messages/tokens/drawings/templates only) — the module sees a rejection, the
  world stays consistent.

**Adapter side (`runtime/documents.js`).**

- Foundry subtype ↔ kind marker: a module's `type: "npc"` is stored as `flags["ais-foundry"].type`;
  a document that never had one derives it deterministically (Actor: `character` when a non-GM
  user owns it, else `npc`; Macro from `kind`; Folder from `targetType`; JournalEntryPage from
  `src`; everything else `base`). `Actor.TYPES` stays `["base","character","npc"]`.
- Local replica with **stable instances**: hydrated once before `init` (paged, in parallel with the
  module's files — 11 RPCs; measured 0.65–1.1 s for the one-document demo world in the headless
  sandbox, where every macrotask hop costs ≈90 ms), refreshed in place by `documents.changed` so
  a reference a module holds keeps reflecting the world (`actor.system.hp` after someone else's
  edit). Updates and embedded deletions apply from the inline diff; only creates, truncated feeds
  and inapplicable diffs re-read the root — one RPC per awaited write. `game.user` becomes the device's `User` document; `game.users`, `game.actors`,
  `game.items`, `game.journal`, `game.tables`, `game.macros`, `game.folders`, `game.playlists`,
  `game.combats`, `game.messages` are live collections.
- Writes: `pre<Create|Update|Delete><Doc>` run locally and may cancel; then one `documents.mutate`;
  the promise resolves after the replica has applied the commit (seq-gated, 1.5 s fallback).
  Post hooks (`createActor`, `updateItem`, `deleteJournalEntry`, …) fire **only** from the change
  feed, with Foundry's `(doc, changes|options, options, userId)` arity — so shell-originated edits
  and the module's own take one path and fire once.
- `fromUuid`/`fromUuidSync` resolve `Actor.<id>`, `Actor.<id>.Item.<id>`,
  `JournalEntry.<id>.JournalEntryPage.<id>`, …; `Scene.<id>.Token.<id>` still goes to the scene
  view; `Compendium.*` waits for the packs slice.
- `ChatMessage.create({content})` posts the text through `chat.post` (the host stamps the author);
  HTML is flattened to text until the chat card surface exists.

**RPC economy (D-486 — a rule, not an accident).** One awaited write = one RPC
(`documents.mutate`) plus the change-feed event; the replica applies the event's inline diff
locally and re-reads a root only for creates, truncated feeds or a diff it cannot apply.
Capability checks and consent read **in-memory state only** — the host's `HostPersister.world`
record (every live write goes through `patchWorld`, so revocation is immediate), the player
runtime's per-package `consentCache` (`writeConsent`/`forget` keep it true). No IndexedDB read
sits on any RPC path: in the e2e sandbox one IDB world-row `get` costs ≈207 ms and used to make a
plain `actor.update` 408 ms; with the rule it is 119–132 ms of which the host handler is 3–8 ms
(Health trace). Residual cost is the sandbox's render-bound main thread (every macrotask hop
queues behind ≈90 ms Pixi frames on software GL — an idle `MessageChannel` ping is 89 ms there);
on GPU hardware a hop is ≈1 ms. Measure in the browser before quoting any ms number.

**Wire budget (D-487 — the rule that keeps player devices working).** One WebRTC user message
caps at 256 KiB; a composed runtime-provider + guest source measures ≈312 KiB raw, so `ais.profile`
carries heavy module payloads deflated (`payloadZ` = deflate of `{source, resources?, runtimeContext?}`;
small modules keep the plain fields). Anything else that grows — profile-like broadcasts, future
asset hand-offs — either deflates under the cap or rides the chunked asset pipeline; never one big
frame.

## 5. Player side, sockets, packs — the next slices in this structure

The document bridge's latency slice (**D-486**) is done: consent/capability from in-memory
snapshots, inline-diff application, measured end to end. Player-side execution and the cross-device
channel (**D-487**) are done. Everything below follows in order — except one core prerequisite
that is NOT AIS but affects every multi-device slice: **transport frame hardening**. One WebRTC
user message caps at 256 KiB; the D-487 profile defect (312 KiB raw composition) is one instance
of a general gap — `fog.put`/`fog.state` still accept up to 1 MiB PNGs and the join `snapshot` is
an unguarded single frame, so a large explored map or a big world can kill a session today. The
fix belongs at the frame layer (chunk + reassemble anything over the cap, as `AssetTransfer`
already does for files); until it lands, no new wire message may carry an unbounded payload and
"grows past 256 KiB" is a release-blocking shape. Tracked in `PLAN.md` (M4).

1. **Scenes and placeables through `documents.*` (slice 2).** Add `scenes` as an exposed
   collection whose rows are the *projected* scene (the player's store already is), with
   `tokens/lights/walls/…` as embedded chains. `TokenDocument.update()` then writes any token
   field the host allows (today only `flags.tagger.tags` through `scene.tags.update`); the
   dedicated tag/light services remain as higher-level helpers.
2. **Player-side Foundry modules — done (D-487).** The synthesised manifest now shares like any
   D-469 module; the same adapter stack runs in player frames with player authority
   (`game.user` = the player, writes validated as the player). Device-only capabilities
   (`fx.play`, `scene.tags.write`, `compendium.read`, `ui.theme`) stay GM-side. The D-487 e2e
   runs an unmodified Foundry module on a player device and asserts its `game.user.isGM === false`
   view. Requires the profile wire budget below.
3. **Sockets (R-06) — done (D-487).** The kernel's bounded *package channel* (`bus.transmit`;
   `AIS.bus.emit/on/off` → `bus.message`): a frame reaches the same package's frames on every
   device through the host, sender included and host-stamped (`by`), no arbitrary fan-out and no
   cross-package delivery. `game.socket.emit("module.<id>", data)` / `.on` map onto it with
   Foundry's broadcast semantics (the listener receives the payload).
4. **Packs (R-10).** `game.packs` as `CompendiumCollection`s over `compendium.list/search/get`
   with `getIndex({fields})`/`getDocument`/`fromUuid("Compendium.…")`; a LevelDB → JSON pack
   importer at package import time.
5. **Files (R-07).** An asset-library RPC (`assets.list/pick/resolve`) behind a capability;
   `FilePicker` renders over it in the panel; `img` paths resolve to asset hashes, never raw URLs.
6. **Chat cards and dice.** An own `Roll` parser/evaluator with host-verified rolls posted as
   structured messages; `templates/dice/*` (already in the library) render them.
7. **Template/UI long tail.** Driven by `foundry.info.templates.missing` and the module corpus
   ranking (combat tracker parts, active-effect parts, `journal/toc.hbs`, `scene/token/*`,
   `sidebar/apps/*`); ProseMirror-free `enrichHTML`, `ContextMenu`, `DragDrop`, FilePicker.
8. **Profile payload caching.** `ais.profile` re-ships full module sources to every device on
   every change (D-487 deflates them, but the bytes still travel). Content-addressed sources —
   the profile carries hashes, devices fetch through the §7 asset pipeline and cache — turns
   every later profile into a kilobyte. Natural home: with the files/asset-library slice.
9. **Target B.** A *system provider* layer: `pf1`'s `TypeDataModel`s, sheets and `CONFIG` hooks
   over the same documents — the owner decides when.

## 6. Guardrails that every slice must keep

- No Foundry code or files in the repository or the packages (unit guards check the library text).
- Capabilities narrow, never widen; the host validates every write; reads are the device's own
  projection. New RPCs: `AIS_MODULE_METHODS` + `AIS_METHOD_CAPABILITY` + handler + `allHandlers()`
  test double; new events: `AIS_EVENTS` + `EVENT_NAMES` + `aisEventSubscriptionCapability`.
- RPC economy (D-486): no storage read on an RPC path (host: `HostPersister.world`; player:
  `consentCache`); one RPC per awaited write; replicas consume inline diffs and re-read only on
  create/truncated/unapplicable diffs. Latency claims are measured (Health trace + e2e timings).
- Player-affecting slices carry a two-device acceptance (join + consent + cross-device traffic),
  as `e2e/ais_bus.spec.ts` does — the D-487 wire defect only appeared when a player connected.
- Everything is measured in Chromium through the real import path (`e2e/ais_foundry_module.spec.ts`)
  and unit-tested against the kernel's real normalisation (`tests/packages/aisFoundryDocuments.test.ts`).
- Diagnostics over silence: `foundry.info` reports unsupported calls, missing templates, document
  stats, rejected writes and hook errors, so a module that does not work says *why*.
- The shell carries only kernel code; the emulation lives in the adapter package (0.5.0: 89,934 B).
