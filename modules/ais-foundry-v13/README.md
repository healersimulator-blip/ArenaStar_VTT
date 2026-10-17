# AIS Foundry v13 adapter (0.6.0)

**IMPORTANT: This adapter is NOT a 1:1 carbon copy of Foundry — it EMULATES what a module/system needs to work.** ArenaStar-authored code, loaded inside the separately approved guest's opaque AIS iframe. The adapter is a runtime provider, not an in-page module and not Foundry core (which is proprietary — every API here is a re-implementation of the surface, never copied code). It provides generic emulation for any system (pf1 main target, but also dnd5e, pf2e, swade, etc) via `ensureSystemConfig` + `ensureSystemGlobal`.

## Emulation principle (not duplication)

AIS does not try to be Foundry. Instead:
- **Kernel (L1)** is generic: `documents.*`, `settings.*`, `compendium.*`, `bus.*`, `assets.*`, `ui.panel`, etc — any AIS module can use them.
- **Adapter (L2)** emulates Foundry contract that real modules actually call: `game`, `Hooks`, `CONFIG`, `CONST`, `foundry.*`, `ui.*`, `Document` classes, `Roll` (own parser: interpolation `@abilities.str.mod`, `NdM`, `kh/kl/dh/dl`, `d%`, safe eval), `FilePicker` (own UI over `AIS.assets` list/pick/resolve by hash, never raw URLs, blob URL cache paging 8192), `CompendiumCollection` (over `compendium.*` RPCs, fields concurrency 8, img fallback), `ChatMessage.create→AIS.chat.post` (host stamps author), `fromUuid` with `CONFIG.compendium.uuidRedirects` mutable, `CONFIG[SYSTEM]` + `globalThis[system]` shims for any system id, `Actor.create` with inline items, `game.socket` via `bus.transmit`.
- Canvas/PIXI is out of scope by design: ArenaStar's renderer is own, placeable documents are the surface.
- pf1 is **main target** base module (provides `CONFIG.PF1`, `pf1` registry, hooks), but adapter is **generic** — same path works for dnd5e (`CONFIG.DND5E`, `globalThis.dnd5e`), pf2e, swade, custom systems via `ensureSystemConfig(sysId)` + `ensureSystemGlobal(sysId)`.

## Profile `foundry-module` (D-482) — unmodified Foundry distributions

A Foundry module's release zip (`module.json` at the root or inside one folder) imports through
*Settings → packages* with no changes: the loader synthesizes the ArenaStar manifest, keeps every
module file byte-identical, serves the text files as runtime resources and skips binaries. After
enable + review + approve + reload the adapter:

1. reads the distribution's files over AIS, applies `styles[]`, loads `languages[]` into `game.i18n`;
2. mints one blob URL per `.js/.mjs` file and installs a single import map for the rewritten
   specifiers (`ais-foundry://<package>/<path>`; see `src/packages/foundryEsmGraph.ts`);
3. runs `scripts[]` as classic scripts, then `esmodules[]` through `import()`;
4. dispatches `init → i18nInit → setup → ready → canvasInit/canvasReady`; hook exceptions are
   logged into `foundry.info().hookErrors`, not fatal.

Foundry core APIs mapped onto AIS services:

| Foundry | ArenaStar |
|---|---|
| `game.settings.register/get/set/registerMenu` | kernel `settings.register/list/get/set` (D-476/D-482); `Boolean`/`Number(range)`/`String(choices)` become typed declarations, everything else hidden JSON text; `config: false` → hidden; `get` is synchronous from a cache kept current by `module.settings.changed`, so a GM form edit reaches the module's `onChange` |
| `game.i18n.localize/format/has` | the module's own `lang/*.json` (en first) |
| `game.modules.get(id)` | mutable `Collection` with the module's own entry (`.api` assignable) + a `sequencer` substitute row |
| `game.user/users/world/system` | GM device user; `game.system.id` is generic — `pf1` when self is pf1 system (main target), `dnd5e` when self is dnd5e, etc, else first declared dependency or `arenastar`. **Emulation**: adapter reports system id so content modules don't stay inert, but rules remain ArenaStar's unless system provider layer implements them. |
| `CONFIG.PF1`/`CONFIG.DND5E`/`CONFIG[SYSTEM]` + `globalThis.pf1`/`dnd5e`/any | **Generic**: `ensureSystemConfig(sysId)` creates `CONFIG[UPPER]` + `CONFIG[lower]` with abilities/skills/conditions/etc + mutable `compendium.uuidRedirects`; `ensureSystemGlobal(sysId)` creates `globalThis[sysId]` with `registry.sources.registerSource`, `utils.createTag`, `config`, etc. pf1 main target but dnd5e/pf2e/swade same. |
| `game.scenes`, `canvas.<layer>.placeables`, `fromUuid` | the projected active scene (visible placeables), tag flags read/write through `scene.tags.*`, stale revisions refreshed once |
| `game.keybindings.register` | recorded (reported in `foundry.info`), not dispatched |
| `game.socket.emit/on/off` | **0.6.0 (D-487):** the kernel's bounded cross-device channel (`AIS.bus`) — every running instance of this module on every device hears the frame, sender included; the listener receives the payload; sender identity host-stamped; no cross-package delivery |
| `ui.notifications.info/warn/error` | `ui.notify` |
| `Hooks`, `foundry.utils.*`, `CONST`, `CONFIG`, `randomID`, `Array#deepFlatten` | local implementations |
| `Sequence`/`Sequencer.EffectManager` | the bounded transient-FX builder over `fx.play` |
| `Application`, `FormApplication`, `DocumentSheet`, `Dialog`, `Tabs`, `FormDataExtended`, `ApplicationV2`, `HandlebarsApplicationMixin`, `DocumentSheetV2`, `DialogV2`, `renderTemplate`/`loadTemplates`, `ui.windows`, `game.settings.registerMenu` | **D-483:** real implementations (`runtime/ui.js`) rendering into the module's own sandboxed panel; templates are the module's own `.hbs` resources compiled by `runtime/hbs.js`; `html` is the jQuery subset in `runtime/jq.js`. Windows open the panel, the last close hides it, the shell's Close raises `ui.panel.closed` and closes every window with its hooks |
| `Actor`, `Item`, `Token`, `Scene`, `ChatMessage`, … documents | world documents are real since 0.5.0 (below); `Scene`/`TokenDocument` beyond tags/light still fail explicitly (next slice) and `FilePicker` uploads likewise (R-07) |

Commands every imported Foundry module exposes to reviewed script macros:

- `foundry.info` — loader diagnostics (files loaded, languages, styles, settings with their AIS
  keys and sync state, keybindings, socket listeners, hooks, hook errors, warnings, unsupported
  calls, module globals, `loadMs`).
- `foundry.ui { menu: "<namespace>.<key>" }` or `{ app: "Global.Class", args }` — open a registered
  settings menu or render an Application class inside the module's panel; the result describes the
  window and `windows` lists what is open (D-483).
- `foundry.api { path, args }` — call the module's own global API the way a Foundry macro would
  (`{ path: "Tagger.getByTag", args: ["Beacon"] }`); a path that is not a global is looked up on
  `game.modules.get(id).api`; `"@uuid:Scene.<id>.Token.<id>"` arguments become projected
  documents; results are JSON-safe copies; the roots `AIS`, `eval`, `Function`, `window`,
  `document`, `fetch`, … are unreachable.

Limits in this phase: host-only (GM device); startup within the kernel's 5 s budget; windows live
inside the module's panel (no shell DOM: no sidebar injection, no canvas overlays); icons are the
core library's own glyph set for the common `fa-*` names, not FontAwesome; no ProseMirror/
`enrichHTML`, `FilePicker` (disabled control), `ContextMenu`, `DragDrop`; the core template
library covers the paths modules reference most (below) — a core path it lacks fails with a
message naming the path, and `foundry.info.templates.missing` lists it; no document CRUD beyond
tags/light, no socket emit, no file storage; `packs/` are listed, not loaded; `game.actors/items/
packs` are empty projections.

## Core resource library (`runtime/core.js`, `runtime/fields.js`, D-484)

Foundry modules reference resources the Foundry *host* provides and never ship themselves:
`templates/generic/tab-navigation.hbs`, `templates/hud/dialog.html`, the `COMMON.*`/`SETTINGS.*`/
`DOCUMENT.*` language keys, the base form CSS classes, `foundry.data.fields.*` and
`foundry.abstract.DataModel`. The adapter is an emulator of that surface: it provides ArenaStar's
own implementation of each, derived from the contract modules depend on (the path, the context
shape, the DOM markers and class names modules select on, the key names) — never Foundry's files.

- Templates (10 entries, 12 aliases so every generation's name resolves to one entry):
  `templates/generic/{tab-navigation,form-footer,form-group,form-fields}.hbs`,
  `templates/hud/dialog.html`, `templates/dice/{roll,tooltip,table-result}.html`,
  `templates/sidebar/{document-create,chat-message}.html`. Resolution order: the module's own
  files, then the library. `renderTemplate`, `loadTemplates`, `getTemplate`, `{{> "templates/…"}}`
  partials and V2 `PARTS` all go through it; `Dialog` renders through `templates/hud/dialog.html`
  (`options.template` overrides).
- Language keys: 496 core keys (`Yes`, `COMMON.Cancel`, `SETTINGS.Save`, `DOCUMENT.Actor`,
  `TYPES.Actor.npc`, `KEYBINDINGS.*`, `PERMISSION.*`, …) seeded under the module's own files, which
  win on conflict.
- CSS: `.standard-form`, `.form-group/.form-fields/.hint`, `.flexrow/.flexcol`, tabs, dialog
  buttons, dice cards, chat message, table draws, `color-picker`/`file-picker`/`range-picker`
  elements; `ui.js`'s base sheet maps the common `fa-*` icon names to text glyphs — all
  self-contained (the sandbox CSP has no `font-src`/`img-src`).
- Data layer: `foundry.data.fields` (`DataField`, `SchemaField`, `BooleanField`, `NumberField`,
  `StringField`, `ObjectField`, `ArrayField`, `SetField`, `EmbeddedDataField`, `ColorField`,
  `FilePathField`, `AngleField`, `AlphaField`, `HTMLField`, `JSONField`, `DocumentIdField`,
  `ForeignDocumentField`, `TypedSchemaField`, `TypedObjectField`, `DocumentStatsField`, …) with
  `clean/validate/initialize/toInput/toFormGroup`; `foundry.abstract.DataModel`/`TypeDataModel`
  (`defineSchema`, `schema`, `cleanData`, `migrateData`, `updateSource` → nested diff, `validate`,
  `toObject`, `clone`, `fromSource`); `foundry.applications.fields.create*Input/createFormGroup/
  prepareSelectOptionGroups`; the `formGroup`/`formField`/`formInput` helpers render through it.
  A `game.settings.register` with `type: SomeDataModel` stores the model's source as hidden JSON and
  `get` returns an instance; `set` accepts an instance or source and validates strictly.
- Also from this release: `Actor.TYPES`/`Item.TYPES`/`game.documentTypes`, `game.release`,
  `CONST.TOKEN_DISPLAY_MODES`, `ACTIVE_EFFECT_MODES`, `DICE_ROLL_MODES`, `MACRO_TYPES`,
  `MEASURED_TEMPLATE_TYPES`, wall/playlist/table enumerations.
- `foundry.info.templates = { compiled, core: [paths used from the library], missing: [core paths asked for that the library lacks] }`.

## World documents (`runtime/documents.js`, D-485)

`game.actors`, `game.items`, `game.journal`, `game.tables`, `game.macros`, `game.folders`,
`game.playlists`, `game.combats`, `game.users`, `game.messages` and `game.user` are real
documents hydrated from the kernel's generic document service (`AIS.documents.*`, capabilities
`documents.read`/`documents.write`) before `init`, and kept current by `documents.changed`.
`Actor`, `Item`, `JournalEntry`, `JournalEntryPage`, `RollTable`, `Macro`, `Folder`, `Playlist`,
`Combat`, `Combatant`, `User`, `ChatMessage`, `ActiveEffect` are our own `Document`
implementation: `create/createDocuments/updateDocuments/deleteDocuments`, `update/delete`,
`getFlag/setFlag/unsetFlag`, `createEmbeddedDocuments/updateEmbeddedDocuments/
deleteEmbeddedDocuments`, `getEmbeddedCollection`, `toObject/clone`, `uuid`/`fromUuid`/
`fromUuidSync`, `isOwner/testUserPermission`, `prepareData` hooks, `Actor#itemTypes`,
`User#isGM/role/character`. Writes are one atomic host transaction **with the device user's
authority** (the host validates, as for the shell's own UI); `pre*` hooks may cancel; post hooks
(`createActor`, `updateItem`, …) fire from replication only, once, with Foundry's
`(doc, changes, options, userId)` arity — also for edits made in ArenaStar's own UI. Foundry's
subtype (`type: "npc"`) is kept in `flags["ais-foundry"].type`; the store's `type` stays the kind
marker. `ChatMessage.create({ content })` posts text through `chat.post`. `foundry.info.documents`
reports `{ userId, collections, hydrateMs, writes, rejectedWrites, events, hookErrors }`.

RPC economy: the replica applies **updates and embedded deletions from the inline diff** the
change feed carries (kernel FlatDiff semantics — dotted set, `-=path` delete, numeric array
index), so an awaited `doc.update()` costs one RPC (`documents.mutate`) plus the event; only
creates, truncated feeds and a diff the local copy cannot apply re-read the root with
`documents.get`. Measured in the e2e sandbox (headless Chromium, software rendering): 119–132 ms
per awaited `actor.update` — 3–8 ms of it inside the host handler, the rest is the ≈90 ms cost
of every macrotask hop on that render-bound main thread (the shell's own `submitAndWait` is 2 ms;
an idle `MessageChannel` ping is 89 ms there). Before the fix it was 408 ms: the kernel re-read
the world record from IndexedDB on every RPC (207 ms per read in that sandbox) and the replica
re-fetched every changed root.
Scenes/placeables still use the projected scene view (`Scene.<id>.Token.<id>`), `Compendium.*`
uuids and `game.packs` wait for the packs slice — see `AIS_FOUNDRY_ARCHITECTURE.md` §5.

## Cross-device socket and player devices (0.6.0, D-487)

`game.socket` maps onto the kernel's bounded package channel (`AIS.bus`, capability
`bus.transmit`): `emit(name, data)` reaches this module's instances on **every device of the
table** — the sender's own listeners included, exactly Foundry's broadcast — `on(name, handler)`
receives the payload as its single argument, `off` removes. The host stamps the sender
(`{id, name}` for generic modules; Foundry handlers just see the data). Channels are free-form
socket names (`module.<id>`, `system.<id>`, …), payloads ≤ 16 KiB bounded JSON; there is no
cross-package delivery and no arbitrary fan-out — a GM-relay pattern (player emits, the GM
instance acts) is the intended shape.

Imported Foundry modules now synthesise `sharing: "players"`: when the GM shares one in Settings →
Packages, the same adapter stack runs in player frames with the **player's** authority —
`game.user.isGM` is false there, `game.actors` is what that player may see, writes are validated
as that player, and `compendium.read`/`fx.play`/`scene.tags.write` fail with their usual
explanations (GM-device services). Heavy runtime payloads travel deflated on the wire (a composed
adapter stack measures ≈312 KiB raw against the 256 KiB per-message budget).

## Layout (`runtimeProvider.scripts`, D-483/D-484/D-485)

The manifest declares `runtimeProvider.scripts = ["runtime/hbs.js", "runtime/jq.js", "runtime/core.js", "runtime/fields.js", "runtime/documents.js", "runtime/ui.js"]`
— classic scripts the kernel evaluates in order inside the module frame before `runtime/adapter.js`
(`entry`). Each publishes one factory (`__aisFoundryHbs`, `__aisFoundryJq`, `__aisFoundryCore`,
`__aisFoundryFields`, `__aisFoundryDocuments`, `__aisFoundryUi`) that the adapter wires with its own `AIS`, `Hooks`,
`game.i18n` and resource reader. No vendored Handlebars or jQuery and no Foundry files: every layer
is a re-implementation of the surface Foundry modules use. The layers are unit-tested without a
browser (`tests/packages/aisFoundryHbs.test.ts`, `tests/packages/aisFoundryCore.test.ts`,
`tests/packages/aisFoundryDocuments.test.ts`) and in
Chromium (`e2e/ais_foundry_ui_runtime.spec.ts`, `e2e/ais_foundry_module.spec.ts`).

## Profile `foundry-v13-scene-tags-fx` (0.1.0 behaviour, unchanged)

- Synchronous local hooks, scene collections, projected document/tag facades and a small utility API.
- Initialization/hydration over AIS; a fresh command-scoped view for each invocation.
- Tag-only updates with local pre-hook/veto, host revision validation, committed acknowledgement,
  then local post-hook notification.
- A small `Sequence`/manager facade over the existing native transient FX engine.
- `game.settings` is unsupported here; the bundled guest uses ArenaStar commands instead.

Common to both profiles: effective rights are the intersection of this package's and the guest's
grants; `runtime.execute` is required on both packages; no standalone execution — disabling,
revoking or replacing this provider stops its guests. `game.version` describes the v13 API
profile, not a running Foundry build.

Build with `corepack pnpm build:ais-demo` (or `test:fx:prepare`). The build writes this package
ZIP, the bundled Tagger guest, the **verbatim upstream Tagger distribution**
(`foundry-tagger-upstream-1.5.4.zip`, provenance-checked files only) and the demonstration world
into `dist/`. See `AIS_FOUNDRY_FEASIBILITY.md` and DECISIONS.md D-482.
