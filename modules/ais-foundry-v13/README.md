# AIS Foundry v13 adapter (0.3.0)

ArenaStar-authored code, loaded inside the separately approved guest's opaque AIS iframe.
The adapter is a runtime provider, not an in-page module and not Foundry core (which is
proprietary — every API here is a re-implementation of the surface, never copied code).

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
| `game.user/users/world/system` | GM device user; `game.system.id === "arenastar"` — deliberately never `pf1` |
| `game.scenes`, `canvas.<layer>.placeables`, `fromUuid` | the projected active scene (visible placeables), tag flags read/write through `scene.tags.*`, stale revisions refreshed once |
| `game.keybindings.register`, `game.socket.on` | recorded (reported in `foundry.info`), not dispatched |
| `ui.notifications.info/warn/error` | `ui.notify` |
| `Hooks`, `foundry.utils.*`, `CONST`, `CONFIG`, `randomID`, `Array#deepFlatten` | local implementations |
| `Sequence`/`Sequencer.EffectManager` | the bounded transient-FX builder over `fx.play` |
| `Application`, `FormApplication`, `DocumentSheet`, `Dialog`, `Tabs`, `FormDataExtended`, `ApplicationV2`, `HandlebarsApplicationMixin`, `DocumentSheetV2`, `DialogV2`, `renderTemplate`/`loadTemplates`, `ui.windows`, `game.settings.registerMenu` | **D-483:** real implementations (`runtime/ui.js`) rendering into the module's own sandboxed panel; templates are the module's own `.hbs` resources compiled by `runtime/hbs.js`; `html` is the jQuery subset in `runtime/jq.js`. Windows open the panel, the last close hides it, the shell's Close raises `ui.panel.closed` and closes every window with its hooks |
| `Actor`, `Item`, `Token`, `Scene`, `ChatMessage`, … documents | class stubs: `extends`/`instanceof` work; CRUD beyond tags/light fails explicitly naming the gap (R-02); `game.socket.emit` (R-06) and `FilePicker` uploads (R-07) likewise |

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
inside the module's panel (no shell DOM: no sidebar injection, no canvas overlays); no FontAwesome,
ProseMirror/`enrichHTML`, `FilePicker` (disabled control), `ContextMenu`, `DragDrop`; Foundry core
`templates/…` are proprietary and unavailable — ship your own; no document CRUD beyond tags/light,
no socket emit, no file storage; `packs/` are listed, not loaded; `game.actors/items/packs` are
empty projections.

## Layout (`runtimeProvider.scripts`, D-483)

The manifest declares `runtimeProvider.scripts = ["runtime/hbs.js", "runtime/jq.js", "runtime/ui.js"]`
— classic scripts the kernel evaluates in order inside the module frame before `runtime/adapter.js`
(`entry`). Each publishes one factory (`__aisFoundryHbs`, `__aisFoundryJq`, `__aisFoundryUi`) that
the adapter wires with its own `AIS`, `Hooks`, `game.i18n` and resource reader. No vendored
Handlebars or jQuery: both are re-implementations of the surface Foundry modules use. The layer is
unit-tested without a browser (`tests/packages/aisFoundryHbs.test.ts`) and in Chromium
(`e2e/ais_foundry_ui_runtime.spec.ts`, `e2e/ais_foundry_module.spec.ts`).

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
