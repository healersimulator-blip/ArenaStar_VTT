# Automation Interconnect System (AIS) — Design

**Status:** Architecture plus a partial, browser-tested AIS v1 foundation; this document remains the target design, not a claim of full delivery.
**Date:** 2026-10-13
**Product constraint:** `dist/index.html` remains a single self-contained app, with a hard raw-size gate of 6 MiB. World archives carry system rules, modules, data, and media separately.

## 0. Decision summary

Build AIS as a small, versioned **host interconnect kernel** in ArenaStar's main file, with separately packaged system logic, automation modules, themes, and content in the world ZIP. It is not a general-purpose `eval` hook system and not a clone of Foundry's global mutable `Hooks` surface.

The kernel should own the stable things all worlds need:

1. A versioned package/extension contract and manifest validator.
2. A world-scoped mod manager, dependency resolver, and activation profile.
3. A typed event/workflow scheduler with explicit phases, deterministic ordering, budgets, and traceability.
4. A registry for actions, event providers, UI contributions, and system services.
5. An arbitration policy for additive contributors and exclusive providers.
6. A capability-checked RPC boundary between world code and the host.
7. Host-authoritative validation and atomic commit of proposed changes.
8. A small, safe UI extension surface, including declarative themes and isolated custom panels.

System-specific rules and most automation code stay in the world ZIP. The app remains the runtime, authority boundary, and universal set of safe primitives. Importing a package never implies permission to execute its code. World archives carry the desired module set and exact versions, but never carry this GM/browser's local trust grants.

The central design decision for “multiple mods connected to the same subsystem and vying for control” is: **all extensions declare how they contribute**. Observers and typed modifiers may compose; exclusive resolvers cannot silently overwrite one another. Conflicts are detected before activation and resolved explicitly in the manager. There is no implicit “last module loaded wins.”

### 0.1 Implemented AIS v1 slice (2026-10-13; reliability pass D-461)

The repository has a partial AIS v1 runtime and one app-integrated exclusive token-light provider. This is more than a metadata-only prototype, but it is **not** the complete scheduler, mechanics contribution pipeline, theme/UI slot system, or player-hydration architecture described below.

- `type: "module"` is a distinct package kind. Its closed `interconnect` block supports `api`, `entry`, exact-version requirements, declared contribution slots/modes/contracts, typed macro-callable command IDs with contract versions, declared custom event names, and the capability allow-list. Entry paths and module metadata are validated at import; import never executes module code.
- Enabled modules are locked to exact package ID, version, and a canonical SHA-256 over the package file map. The resolver validates dependencies/cycles and explicit exclusive-provider choices. `observe`/`augment`/`transform` and `register` declarations are resolved as metadata, but the general workflow/mechanics execution pipeline is not implemented. V1 package requirements use exact versions, not semver ranges.
- Settings → Packages can import modules, enable/disable them in a world profile, show dependency/provider diagnostics, select an exclusive provider, inspect a bounded entry-source preview, review requested capabilities, and grant/revoke local code approval. A module runs only when it is enabled, resolves, and has a matching exact-hash local approval. The source preview carries its package hash: replacement invalidates cached previews, and approval refuses a hash that changed after review. World profile intent and each host's consent/grants remain separate.
- World ZIP format 4 carries installed module package files, enabled exact locks, and provider selections. Local capability grants are not exported. A copy import carries the requested profile but does not carry local approval; restore does not make an edited hash trusted.
- Approved modules run in a hidden `sandbox="allow-scripts"` iframe with an opaque origin and restrictive CSP. A one-use handshake checks the exact source frame, opaque origin and per-instance boot ID, then all RPCs/commands/events use a document-bound `MessagePort`. The original document must answer a post-load probe before becoming ready. Navigation cannot inherit the bridge, and no `allow-same-origin` or cross-origin `Location` read is needed. The dispatcher checks each requested capability, closed request envelopes, bounded JSON, response-envelope size, concurrency, rate and replayed request IDs. Current RPC families include visible-scene projection; bounded inventory reads restricted to actors linked to visible tokens in the active scene; the narrow host-authoritative token-light update (with optional linked-item consumption); module-scoped storage; escaped plain-text chat; host notification; host-rendered text selection; and declared custom event emission. Capabilities include `event.emit` in addition to the existing scene, inventory, storage, chat, UI, and token-light grants.
- Runtime wiring lives in typed `src/app/aisRuntime.ts`, rather than relying on Svelte-only callback checks. Settings distinguishes **starting / ready / failed / stopped** from code approval. Startup has a 5-second readiness deadline; entry errors, unhandled callback errors and navigation stop the instance with a visible reason. Disablement, replacement, approval revocation and capability changes close the old frame/port, reject pending commands, cancel its choice dialog and invalidate queued RPC work. New code/grants still start only after reload. Revocation cannot roll back an already-submitted host transaction.
- Token-light/inventory and chat RPC success waits for `gm.client.submitAndWait`, not just intent creation. AIS light/storage mutations share a serial queue; consent/liveness and authoritative documents are read after awaits, per-module quotas cannot race, and token state changes only the calling module's flag namespace. This is the existing narrow transaction path, not the unimplemented general mechanics proposal/commit system.
- Typed events are `world.snapshot`, `world.ops.committed`, `scene.token.light.changed`, `turn.phase.changed`, `turn.report.committed`, `ui.token.action`, and `module.event`. `scene.token.light.changed` is an after-commit host hook: it carries only the active scene's visible token ID and bounded light snapshot (including optional animation metadata), never raw ops or hidden-token data. `ui.token.action` is dispatched only to the selected `scene.token.light.action` provider from the native token context menu. A new `world.snapshot` subscriber receives the current sequence even though the GM welcome preceded module boot. Subscriptions are registered only after successful live authorization. A module can emit only names declared in its exact manifest; the host authenticates the source package and broadcasts to subscribers that separately hold `action.observe`.
- Declared module commands can be registered with `AIS.commands.on` and called by ArenaStar's already-reviewed script macros through `api.ais.invoke(moduleId, commandId, input)`. Macro invocation requires a separate script grant and reviewed GM run-as; the target must be enabled, exact-hash approved and locally capable. Calls accept up to 16 KiB of bounded JSON, use an 8-second execution deadline, reserve the single per-module command slot before awaiting readiness/consent, propagate liveness through host RPCs, and cannot invoke raw module source or Foundry globals. Human selection is refused inside a macro command; it remains available to ordinary live module callbacks. This is a typed bridge into module-owned command handlers, not general `eval` or a Foundry-compatible macro runtime.
- Light documents now support strict, declarative `torch` and `pulse` animation metadata (bounded rate/intensity and optional phase reversal). The host validates module-authored token-light updates; scene rendering applies modulation to placed, carried, and cross-floor light graphics, pauses it for reduced-motion users, and leaves light-range/vision calculations unchanged. Foundry imports retain only the supported metadata fields; no animation script or arbitrary renderer callback is accepted.
- The `pf1e-torch` world module demonstrates the end-to-end path: PF1e light catalog, aliases, source choice/cycling, fallback and inventory preferences, optional consumable tracking, directional carried lighting, flame animation metadata, eight typed macro commands, and `torch.changed` / `torch.selected` events. Starter profiles may enable and select it, but no world ZIP approves code or grants capabilities. Its real native menu, host-committed consumption, text selection, persisted preferences and reviewed macro path now pass in Chromium over both file and HTTPS origins. Full Foundry parity remains incomplete and the conditional modding skill is therefore not included.
- RPC requests/results are limited to 64 KiB, 120 requests per second, and 32 concurrent requests per module. Module storage is bounded to 128 KiB per module, 256 keys, and 16 KiB per value. These are not a CPU budget. The iframe/CSP arrangement has not been audited across every target browser and cannot prove that arbitrary approved JavaScript is harmless or stop an infinite loop. Review the exact code and use disposable worlds when testing.
- D-461 verification: **5,681 unit tests passed / 12 skipped**; typecheck and lint passed; the dedicated `test:e2e:ais` batch passed **12/12** real Chromium tests with no retries in **4.6 minutes**. Coverage includes both-origin approval/RPC/event/storage/revocation and Torch workflows, cross-module events, stale source replacement, runtime/startup failure, navigation (including before first load), command deadlines, grant changes and simultaneous command admission.
- The current `pnpm size` measurement after `test:fx:prepare` is **5,319,995 raw bytes (5.074 MiB)** and 1,519,421 gzip bytes, below the 6 MiB main-file gate. Module entry sources remain in world package records and are not statically bundled.

Still outstanding from the target design: typed runtime execution for general `augment`/`transform`/resolver contributions, domain action proposals/prompts and atomic mechanics commits, schema-driven module settings and theme/UI contributions, health traces/circuit breakers/CPU budgets, comprehensive per-player compatibility negotiation, package signing/discovery, semver-range dependency solving, and broader adversarial/cross-browser tests beyond the Chromium acceptance batch. Do not treat the current slice as satisfying all acceptance criteria in §16.

### 0.2 Adapter feasibility slice (D-462; not general Foundry compatibility)

The [runnable demo](AIS_FOUNDRY_FEASIBILITY.md) now loads a world-packaged runtime provider and
original pinned Tagger 1.5.4 source, locally rebundled without source edits, into one opaque guest
frame. The additive, closed `arena.ais.runtime/1` extension to AIS 1 adds `runtimeProvider` and
`runtime` declarations, prepared classic-script lists, bounded JSON configuration and a
composition-bound guest approval. Both packages must declare/grant `runtime.execute`, also
preventing older kernels from ignoring the binding in shared local storage. Each package still
needs separate local consent, and effective capabilities are their intersection. Providers never execute standalone. Runtime packages require
world ZIP format 5 and its explicit feature marker; the new exporter/importer retains formats 1–4.

New narrow services expose non-hidden active-scene placeable tags and native transient FX. Tag
proposals carry a global-sequence precondition, are host-validated/committed synchronously, and
support normal undo. Upstream Tagger query/rule code and local pre/post update hooks run in the
adapter; native ArenaStar edits do not yet pass through a general AIS workflow scheduler. The FX
facade reuses the existing native scheduler, per-viewer policy and Pixi/audio runtime, not upstream
Sequencer. Owned FX handles cannot cancel another module's runs; stopping a module cleans them up.
Adapter-backed command dispatch is restricted to the local GM and currently viewed scene.

D-462 verification: **5,705 unit tests passed / 12 skipped**, typecheck/lint/build/size passed,
and the complete AIS Chromium batch passed **15/15 in 7.7 minutes**, with no retries. The new
browser cases execute the original Tagger methods and actual native FX drawing on file and HTTPS
origins, including clean-context world export/import and negative consent/capability cases.

This deliberately does not implement the proposed AIS 2 contract, arbitrary Foundry ZIP/ES-module
loading, binary package resources, Foundry UI/settings/system behavior, player hydration, persistent
foreign FX, or CPU-loop containment. See the [broader proposal](FOUNDRY_AIS_ADAPTER_PROPOSAL.md)
for the remaining stages. Legal review is separate from this feasibility demonstration; no legal
approval status or Foundry-core redistribution claim is changed.

### 0.3 UI appearance adapters and usable preview (D-463)

The [UI laboratory](AIS_UI_MODULES.md) now opens its own world from an inert, integrity-checked
embedded archive. A native GM selector explicitly reviews/activates one appearance provider,
switches palettes without reload, and persists module/variant/density/width in a normal settings
document. Local code grants remain separate and never travel in that world.

This is real but bounded upstream reuse: Your Flavor's original token engine and presets;
Carolingian's original CSS variable cascade; RPG Styled UI's original startup/settings hooks and
selected raster artwork. Their full Studio, sidebar/carousel and system-sheet implementations are
not claimed. Original files and source digests accompany prepared, isolated runtime resources.

AIS adds an allowlisted, chunked `package.resource.read` service and a closed `ui.theme` appearance
contract. Foreign selectors/CSS/HTML never enter the parent page. Only host-owned selectors consume
validated colors, typography, bounded layout and checked raster resources. Appearance-only
runtimes may be explicitly hot-started through the existing AIS iframe/consent boundary; broader
modules retain reload-based startup. The host rechecks selected-provider identity and consent
before applying results. Native modal review and Ctrl+Alt+0 recovery stay outside themed styling.

Verification: **5,721 unit tests passed / 12 skipped**, typecheck/lint/build/size passed, UI-adapter
browser batch **3/3**, existing AIS browser batch **15/15**, adjacent shell/world tests **20/20**.
The ordinary app is **5,355,180 raw bytes / 1,530,129 gzip bytes** (5.107 MiB raw), under the 6 MiB cap.

### 0.4 Player-side execution of shared modules (D-468)

The GM-only posture of 0.1–0.3 was an implementation stage, not a goal: the owner's rule is that
the GM can share modules, UI and sheets with players, and the first acceptance case is the shipped
`pf1e-torch` lighting a torch on a **player's own token from the player's own UI**. Slice P1a of
[AIS_PLAYER_RUNTIME_PLAN.md](AIS_PLAYER_RUNTIME_PLAN.md) delivers exactly that:

- a new `ais.profile` message (ops channel, after the welcome snapshot and on every change) carries
  the GM-approved *shared* module set — archive, hash, commands and the host grant minus the
  GM-device-only capabilities (`fx.play`, `scene.tags.write`, `ui.theme`);
- each player allows each module per device, world and exact hash; GM approval is necessary and
  never sufficient; un-sharing, revocation or a hash change stop the module without a reload;
- the player runtime composes the unchanged sandboxed iframe and kernel RPC handlers over the
  player's `ClientSync` replica, so every write is the player's own intent and the host's
  `validateOps` + ownership decide (no authorization code changed);
- the player shell gains a consent dialog, a choice dialog, notices and a token context menu with
  the light entries; the GM's module review gains a per-module "Players run this module too" box.

Verification: unit **5,775 passed / 12 skipped**, typecheck/lint/build clean, main file
**5,723,400 B** (+24,504 B). The browser case `e2e/ais_player.spec.ts` joined `test:e2e:ais` but
was not executed in the authoring sandbox. Later phases — player quickbar/chat commands, shared
sheets/panels through a Svelte component-package contract, and moving the native PF1e logic into
the world file — are planned there.

**P1b (D-469)** added the generic player-side controls without touching any module:

- `interconnect.sharing: "players" | "host-only"` — the author's own declaration; `host-only`
  modules never enter `ais.profile` and the GM's sharing box is disabled with that reason (the
  answer to the "every copy observes the same events" constraint of plan §4.7);
- `interconnect.tokenActions: [{ id, label }]` (≤ 16, needs `ui.interaction`) — token-menu entries
  in **both** shells, dispatched as the existing `ui.token.action { sceneId, tokenId, action }` to
  the declaring module; at the player, disabled on tokens the player does not control;
- `runAs: "player"` — a player's frame (`AisModuleIframe` with `playerCommands: true`) runs declared
  commands as that player (`PlayerAisRuntime.invokeCommand`), with the host validating every op
  under the player's ownership; the *Shared modules* card has a command runner for the selected
  token. Host frames keep refusing anything but the reviewed `"gm"` elevation.

**P2a (D-470)** gave third-party modules a UI surface without ever running their markup in the
shell page: `interconnect.panel { title, width, height }` + capability `ui.panel`; the module draws
inside its own sandboxed iframe document (it always had one — the frame was merely hidden) and the
shell draws the window chrome around it (`src/packages/aisPanel.ts`, used by both shells; the
iframe is created inside the panel body and never re-parented). `AIS.ui.panel.open()/close()` from
the module, "Open panel" buttons in Settings → Packages and in the player's *Shared modules* card.

**P3 step 1 (D-471)** started moving native PF1e into the world file: the strategic ruleset is no
longer compiled into the main file — the host imports the active system package's `rules.js`
in-page (`HostApp.rulesModule`) and consumes it through `RulesModule` seams (`leaderStats` for the
hero overlay, order validation in the army window). Measured −50,252 B; main file 5,688,191 B.

**P3 step 2 (D-472)** carried the same package to players: the host publishes `rules.js` under
its sha256 and serves it through the §7 chunked asset transfer (no new op framing); every welcome
names it in `sim.artifact`; `PlayerRulesPackage` verifies the digest, asks this device once per
world/package/hash (the prompt states that a rules package runs unsandboxed), imports in-page and
hands the module to the player's `WindowHost`. The same publish → announce → fetch → verify →
consent → import path is what later package tiers (T2/T3, P2b component packages) will reuse.

## 1. Goals and non-goals

### Goals

- Keep the main application generic and under the 6 MiB raw limit without compiling each RPG system or mod into it.
- Let a world select a system package and activate several compatible automation/UI modules at once.
- Support systems with different document models, checks, effects, combat phases, and automation needs without pretending every game fits one rules schema.
- Let a GM enable a Gothic/vampire UI theme or game-specific panels for one world without forking the main app.
- Support both declarative automations and complex system-specific code.
- Give modules stable, typed opportunities to observe, propose, resolve, and present game actions.
- Allow multiple compatible modules to contribute to a subsystem without order-dependent bugs.
- Keep the GM host authoritative for game state, permissions, rolls, and synchronized effects.
- Keep player-facing UI extensions possible without granting the player UI package authority to write world data.
- Keep package import/export offline-first and make a world ZIP sufficient to transport the package contents and activation profile.

### Non-goals

- Expose arbitrary access to ArenaStar's Svelte component tree, DOM, internal stores, IndexedDB, transport, or document objects.
- Promise compatibility with Foundry's JavaScript API or run unmodified Foundry modules.
- Treat third-party code as trustworthy because it is in a ZIP, has a hash, or was authored by the world creator.
- Allow arbitrary modules to rewrite combat outcomes by editing a shared mutable workflow object.
- Make a theme module able to install global CSS, hide core controls, or bypass permissions.
- Bundle all system/automation code into `index.html` or require the app to have network access to a registry.
- Make imports literally unbounded in bytes. The archive is not subject to the main-file size cap, but parsing, memory, storage and transport still require ZIP-bomb/resource limits.

## 2. Product model: separate rules, automations, data, and presentation

AIS should make four package roles visible instead of treating every customization as one generic “module.” One package may make more than one contribution, but its roles and permissions must remain explicit.

| Package role | What it owns | Cardinality / authority |
|---|---|---|
| **System** | System-specific semantics: data schema, checks, damage/effect rules, rules adapters, system-specific workflows, defaults and domain UI metadata. | Exactly one active base system provider per world for any exclusive rules contract. It can have companions, but it is not an all-powerful host module. |
| **Automation module** | Optional behaviors: triggers, item/ability automations, modifiers, workflow steps, automation actions, and optional UI contributions. | Many can be enabled. Each contribution declares `observe`, `augment`, `exclusive`, or another typed composition mode. |
| **Data package** | Compendia, actors, items, maps, journal/codex content, effect definitions, and other JSON/data assets. | Many. No executable entry point and no code trust prompt. |
| **Theme / presentation package** | Declarative theme tokens, icons, layout presets, localization, and UI descriptors; optionally an isolated custom panel entry point. | Multiple accents may compose; conflicting base themes or slot owners need an explicit selection. No authority over mechanics. |

“System package” and “automation module” must not be confused. A world can use one PF1e rules adapter and several independent modules that add spells, effects, reactions, UI, or automation. A custom system can supply a fundamentally different rules service without growing the app bundle.

### Example: a Gothic campaign

A `vampire-system` package owns hunger, sunlight, blood pools, checks, and any unique combat semantics. `gothic-noir-theme` supplies colors, type, icons, and a layout profile using approved tokens. `blood-hunt-automation` adds feeding and frenzy handlers. A `vampire-codex` data package supplies actors, locations, and lore. All four are carried in the world ZIP; ArenaStar's kernel knows only their contracts and host-side safety rules.

## 3. Where code and data should live

| Concern | Main file / AIS kernel | World ZIP |
|---|---|---|
| Account/session identity, role and permission checks | **Yes.** Always host-owned. | No. A package may request capabilities, but cannot define its own authority. |
| Core document store, sync, conflict handling, commit/revert, fog/visibility projection | **Yes.** The host remains the source of truth. | No. |
| Manifest parsing, package locks, module manager, extension registration, conflict diagnostics, RPC validation | **Yes, small and stable.** | Manifests and selected profile are data in the archive. |
| Generic action lifecycle, trigger scheduler, safe condition/interpreter primitives, roll/prompt/FX broker | **Yes.** Stable mechanisms, not a game's rulebook. | Modules declare and implement game-specific behavior against these mechanisms. |
| System model, stats, formulas, saves, damage types, stacking/expiry semantics, rule adjudication | Generic service contracts only. The app must not assume PF1e or D&D data models. | **Yes.** System package / system adapter. |
| Specific spells, abilities, items, feats, conditions and content-specific reactions | Safe action and effect primitives only. | **Yes.** Automation module, data package, or both, referenced by stable IDs. |
| Campaign media, maps, token art, audio, icons, large compendia | Small runtime and validators only. | **Yes.** Store by content hash and load when needed. |
| Themes and world-specific layouts | Theme tokens, named slots, renderer, safe custom-panel bridge. | Theme token values, icons, localization, schema-driven panels and optional isolated panel code. |
| Generic accessibility, navigation, settings shell, fallbacks | **Yes.** | Packages may contribute within named extension slots. |
| Package trust and local code approval | **Yes, local-only state.** | Never imported as consent. The ZIP can say which modules are desired/enabled, not that this browser trusts them. |

The 6 MiB cap is on the main app body (`scripts/size.mjs`). Package sources/assets must not be statically imported by `App.svelte` or otherwise land in the single-file build. The world ZIP is deliberately a different size domain. Current ZIP extraction still has configured compressed/uncompressed limits, per-entry limits, and entry-count/path checks; those are safety and browser-resource limits, not a bundle-size limit, and should remain separately configurable and tested.

## 4. Foundry automation research and transferable lessons

### 4.1 Midi-QOL

The current Foundry package listing describes Midi-QOL as optional combat automation with configurable attack/damage rolls, saving throws, hit checks, damage application with immunities, active-effect application, concentration, special-duration expiry, and roll-behavior flags. These are not one “on click” callback: they imply an ordered workflow with explicit targeting, roll, result, damage, effect, and cleanup stages. Its ecosystem exposes workflow timing to other automation authors.

#### Historical source-code sample reviewed (not current upstream)

To inspect implementation code rather than rely only on the package listing, I reviewed the pinned, unofficial GitHub mirror [at commit `b237c1d`](https://github.com/elizeuangelo/fvtt-module-midi-qol/tree/b237c1df7f2ea8335b7569f8986a2e7a10de4063). That snapshot (commit dated 2026-10-04) identifies as Midi-QOL 11.7.6, with the README describing the v11.6.x line / v12 beta and a manifest targeting Foundry 11.302–12.999 and D&D5e 3.3.x. The current package listing is v14.6.0 for D&D5e v6. **The official current v14 source on GitLab was not inspected; every implementation observation below applies only to the pinned historical sample and must not be inferred to describe current Midi-QOL.**

The reviewed code exposes several concrete lifecycle and integration patterns:

- **A real asynchronous state machine:** `Workflow` discovers methods named `WorkflowState_*`, derives pre/post stage hook names, and uses `performState` to run transitions. It awaits the outgoing stage's post integrations and incoming stage's pre integrations before invoking the next state. A run suspends at waits for player rolls, templates, or confirmation, then `unSuspend(context)` resumes the same live instance. The loop has a 150-transition guard. This is useful evidence that combat automation needs named, cancellable, resumable stages—not one generic callback.
- **Stage hooks have distinct semantics:** the historical `asyncHooksCall` awaits listeners sequentially and short-circuits when one returns `false`; `asyncHooksCallAll` also awaits sequentially but ignores return values and continues after a handler error while recording it. State hooks also have item-UUID-specific names. This demonstrates the need to define ordering, veto authority, failure policy, and scope for each event contract rather than rely on listener convention.
- **A second, less deterministic extension path:** item/actor OnUse macro passes are attached to named workflow stages and receive rich macro data, including a reference to the live workflow. In this snapshot, multiple macros for one pass are launched together and collected with `Promise.allSettled`, unlike the sequential hook listeners. Combining live mutation with concurrent execution makes safe composition and ordering hard to reason about.
- **Workflow identity is too coarse to copy:** the base workflow registry uses the item UUID as its key and removes an existing workflow for that item when constructing another. That is a version-specific design trade-off; it can discard a suspended use of the same item. AIS should key every run by a unique action/invocation ID and represent any “one pending use per item” rule as an explicit system policy.
- **Deep system integration:** `patching.js` wraps item use, attack, and damage methods (and several actor/effect APIs) through `libWrapper`. This is an effective compatibility technique in its host ecosystem, but it is coupled to Foundry/D&D implementation details; it is not a portable extension contract.
- **Damage has a useful authority boundary:** the client-side helper builds per-target damage details using the system's damage calculation, serializes the resulting list, and sends it to a GM-side socket handler for damage-card creation and any permitted HP update. The GM-side code resolves actors and recalculates HP deltas before updates. Borrow the separation between calculation/proposal and authoritative commit, not this socket protocol or its legacy permission assumptions; ArenaStar must re-read and validate live state through its own transaction path.
- **High-level orchestration and diagnostics matter:** in this historical snapshot, the public surface includes an awaitable whole-item workflow, target selection by UUID, user routing, and specialized damage-only/trap workflows. The implementation also reports hook/workflow errors to a troubleshooter. This shows the value of supported high-level actions, specialized workflow entry points, and operator-visible diagnostics; it does not require exposing the underlying workflow object.

**Transfer to ArenaStar:** define an explicit system-owned action/workflow state machine and versioned stage catalog. A `before damage` modifier, a `damage proposed` contribution, and an `after committed damage` observer are different extension points with different authority. Give each handler a documented execution policy (ordered reducer, parallel read-only observer, or selected exclusive provider), typed outputs, bounded execution, and an explicit error/veto result. Suspend only at named boundaries using serializable continuations; on resume, re-check permissions and live state. Bind item-specific automation through stable IDs and schema settings, not embedded code. GMs need clear defaults and opt-outs; a rule should be able to prompt, auto-resolve, or remain manual without a module secretly changing the result.

**Do not transfer:** writable live document/workflow objects as the shared plugin API, class/prototype patching as the normal AIS extension mechanism, implicit listener ordering, concurrent side-effectful macro dispatch, or per-item UUID as a workflow identity. In ArenaStar, modules submit typed proposals, the host arbitrates them, and the host alone commits validated changes.

### 4.2 Coven's Automation Toolkit (CAT)

CAT is an API/integration layer, rather than a package of automations by itself. Its public API registers function macros, automation records/compendia/modules, scales, animations, and diagnostics. The examined source also has explicit workflow phases (for example pre-item-roll, targeting, attack, saves, damage application, finished/cleanup), event-specific contexts, per-trigger priorities, generic configuration, and a troubleshooter. Automations are registered with source, identifier, rules version, and compendium/document identity; callers can inspect or enable sources.

**Transfer to ArenaStar:**

- Registration should happen at boot, be validated, have stable namespaced identities, and be inspectable.
- Events need domain phases and per-handler priority/order, not an undifferentiated `Hooks.on('*')` mechanism.
- A contribution must declare which system/rules version it targets and the content identifier it binds to.
- Per-automation configuration needs a schema and a normal UI editor; “script is the configuration” is not adequate for GMs.
- Add a diagnostics/troubleshooter surface showing missing dependencies, failed registration, disabled source, provider conflicts, and runtime errors.

**Do not transfer:** runtime patching of game classes/prototypes or providing privileged mutable workflow instances. CAT is written for the Foundry/D&D/Midi runtime and uses that platform's native objects and trust model.

### 4.3 Cauldron of Plentiful Resources (CPR; historically “Chris's Premades”)

CPR demonstrates that useful automation is both code and content. The inspected repository has extensive data packs and macro families split across shared, generic, legacy-rule, and modern-rule variants. Its boot code registers macro definitions and compendium automations against CAT. Many item/ability behaviors use generic per-item settings, resource checks, confirmation prompts, synthetic follow-on workflows, target riders, and events such as rests or workflow completion. Its API access is intentionally routed through CAT helper proxies. It is closely coupled to D&D 5e, Midi-QOL, and other Foundry modules.

**Transfer to ArenaStar:**

- Keep automation definitions/content in the world package and use stable IDs to connect data rows to code.
- Make settings declarative and schema-driven, with defaults and labels; let a world author tune an automation without editing source.
- Model version-specific rule variants explicitly (e.g. `systemId` + rules version/capabilities), never as hidden guesses based on field names.
- Support chained workflows, per-target riders, resource spending, prompts, and follow-up rolls through host-managed primitives.
- Treat optional module dependencies and their exact version requirements as first-class manager data.

**Do not transfer:** embedded arbitrary scripts as the default authorization model; direct game-document mutation; or implicit ordering when two modules answer the same question.

### 4.4 Research sources inspected

- [Midi-QOL package listing](https://foundryvtt.com/packages/midi-qol) — current v14.6.0 listing / feature surface for D&D5e v6, checked 2026-10-12; this is product metadata, not a source-code audit.
- [Unofficial Midi-QOL GitHub copy at commit `b237c1d`](https://github.com/elizeuangelo/fvtt-module-midi-qol/tree/b237c1df7f2ea8335b7569f8986a2e7a10de4063) — historical v11.7.6 sample only; inspected `src/module/workflow.js`, `utils.js`, `GMAction.js`, `itemhandling.js`, `patching.js`, `setupModules.js`, README, and manifest. In particular: [`workflow.js`](https://github.com/elizeuangelo/fvtt-module-midi-qol/blob/b237c1df7f2ea8335b7569f8986a2e7a10de4063/src/module/workflow.js), [`utils.js`](https://github.com/elizeuangelo/fvtt-module-midi-qol/blob/b237c1df7f2ea8335b7569f8986a2e7a10de4063/src/module/utils.js), and [`GMAction.js`](https://github.com/elizeuangelo/fvtt-module-midi-qol/blob/b237c1df7f2ea8335b7569f8986a2e7a10de4063/src/module/GMAction.js). This mirror is not official/current v14 source.
- [Official Midi-QOL GitLab repository](https://gitlab.com/tposney/midi-qol) — current upstream source remains uninspected; do not use the historical GitHub snapshot to make current-version claims.
- [CAT repository at reviewed revision](https://github.com/chrisk123999/covens-automation-toolkit/tree/b576949a67603616a505cfda8bdc193ab446fff9) — in particular `scripts/api.mjs`, `scripts/lib/automations.mjs`, `scripts/lib/macros.mjs`, `scripts/lib/event.mjs`, `scripts/events/workflow.mjs`, and startup/registration code.
- [CAT package listing](https://foundryvtt.com/packages/cat) — describes CAT as an API module for Midi-QOL-based automation and summarizes its extension features.
- [CPR repository at reviewed revision](https://github.com/chrisk123999/chris-premades/tree/c08ea0136236e4a71aacd1fb98c5d40f3af222ff) — in particular `scripts/module.mjs`, `scripts/proxy.mjs`, `scripts/macros/generic/useOnEvent.mjs`, `scripts/macros/generic/attackRider.mjs`, and `packData/`.
- No third-party code was copied into ArenaStar. The design below uses patterns and counterexamples, not upstream implementation snippets.

## 5. ArenaStar baseline and remaining gap

The repository already has useful pieces; AIS connects and evolves them rather than creating a parallel automation stack.

- `WorldFile_Packaging_Proposal.md`, `src/core/packageManifest.ts`, `src/packages/packageLoader.ts`, `src/host/worldFile.ts`, and `src/storage/idb.ts` established world-scoped rules/data packages and self-contained world ZIPs. The package contract now also includes independent `type: "module"` packages and AIS profile data in archive format 4.
- `src/app/hostBoot.ts` boots the selected strategic rules package into the SimWorker, retains the legacy `manifest.module` path for compatibility, and now resolves/boots multiple independent AIS modules from exact world locks plus local approvals.
- `src/core/moduleApi.ts`, `src/packages/moduleIframe.ts`, and `src/packages/moduleHandlers.ts` remain the legacy system-module RPC surface (`game/settings`, token list/move, chat, notify, and legacy hooks such as `ready`, `snapshot`, `turnPhase`, and `turnReport`). AIS uses a separate, narrower bridge in `src/packages/aisModuleIframe.ts` and `aisModuleHandlers.ts`.
- `src/packages/trustedModule.ts` has an in-page trust tier. It deliberately grants broad page access and cannot truly unload evaluated code. It remains a legacy/explicit escape hatch, not the target interconnect for imported AIS modules.
- `src/core/rules.ts` defines a pure, deterministic strategic RulesModule contract with seeded RNG and a read-only RulesContext. This remains the pattern for authoritative system logic: no DOM or I/O and a bounded set of inputs/outputs.
- `src/core/automation.ts` is a rich, validated declarative graph planner that resolves selectors and produces a host plan; `src/host/sync.ts` performs host-side validation/commit and manages post-actions. This should become one of AIS's safe automation languages/providers, not be replaced by arbitrary script hooks.
- `src/core/scriptMacros.ts` and `src/host/scriptWorker.ts` implement GM-reviewed scripts with policy hashes, named inputs, grants, and host RPC. The script worker explicitly documents that a browser Worker is **not** a security sandbox for hostile code. Reuse its ideas—review, grants, budgets, explicit APIs—but do not equate Worker isolation with safe execution of imported untrusted code.
- The FX Wizard and macro automation paths prove that world-owned definitions can drive a generic host runner. AIS should expose the reusable capabilities, not bake the FX Wizard into every module or allow FX code to write mechanics.

**Remaining gap:** the first slice now has a package manager, exact-hash profile locks, provider conflict metadata/UI, a capability broker, and typed read-only events. It does not yet execute registered contributions in system workflows, propose/commit mechanics actions, provide schema-driven player UI, or negotiate module versions with player clients. The selected token-light provider is wired to the native token menu; the remaining general mechanics contribution slots still resolve metadata only, without an action-workflow executor.

## 6. Proposed architecture

```text
World ZIP
  world data + package files + pinned automation profile + theme/profile data
                │ validate / hash / resolve dependencies / review capabilities
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ArenaStar host kernel (inside the ≤6 MiB main file)                   │
│                                                                      │
│ Package Manager ─ Extension Registry ─ Conflict/Order Resolver       │
│           │                 │                 │                      │
│ Capability Broker ─ Typed Event/Workflow Scheduler ─ Trace/Health   │
│           │                 │                 │                      │
│ Host auth + projected reads + typed intents + transaction commit    │
│           │                 │                 │                      │
│ UI shell / approved slots / theme tokens / safe fallback renderers  │
└───────────┼─────────────────┼─────────────────┼──────────────────────┘
            │ typed, bounded RPC; per-module capability context
   ┌────────┴───────┬─────────┴──────────┬─────────────┐
   ▼                ▼                    ▼             ▼
System adapter   Automation module(s)   Data packs   Theme / panel module(s)
(SimWorker)      (sandboxed code/graph)  (no code)    (declarative or isolated)
```

### Kernel components

1. **Package catalog and profile loader** — parse manifests; validate paths, hashes, semver/capabilities; resolve dependency graph; stage disabled packages; load only enabled entry points; keep one world-scoped lock/profile.
2. **Extension registry** — stores `event`, `action`, `resolver`, `modifier`, `service`, `ui slot`, and `theme token` registrations under `packageId/contributionId`.
3. **Workflow scheduler** — invokes the registered set for a named, versioned stage with an immutable JSON context and typed result schemas. Each run has a unique action/invocation ID (never just an item ID); the stage contract declares sequential reducer order, whether read-only observers may run in parallel, and whether a typed veto is legal. It handles deadlines, prompts, cancellation, idempotency, serialized continuations, and revalidated resume.
4. **Arbitration resolver** — validates contribution mode, ordering constraints, stack policy, and exclusive provider selection. Produces a deterministic execution plan and reports unresolved conflicts before enabling.
5. **Capability broker** — exposes only the requested/granted methods for a specific module, world, event, and caller. Rechecks role, object visibility, and permissions at each request.
6. **Host intent validator/committer** — turns accepted module proposals into normal host-authorized ops; validates against current documents and system adapters; commits mechanics atomically; emits post-commit notifications after the write.
7. **UI extension host** — renders standard panels/forms/actions from declarative schemas and mounts richer panels only inside isolated, sandboxed frames. Core navigation, accessibility and recovery controls remain available if modules fail.
8. **Health/trace store** — records loaded version/hash, registration result, invocation phase, duration, budget use, conflicts, denied capabilities, and failure summaries. It must not log hidden data or script source to players.

## 7. Package and interconnect contract

### 7.1 Manifest direction

Retain existing `system` and `data` packages for compatibility. Add an independent `module`/`automation` package role and a declarative theme/data contribution. Do not encode every plug-in as an optional block inside the one active system package.

Illustrative v1 manifest (shape is a proposal, not an implemented schema):

```json
{
  "id": "example.pf1e.condition-automation",
  "name": "PF1e Condition Automation",
  "version": "1.2.0",
  "type": "module",
  "interconnect": {
    "api": "arena.ais/1",
    "entry": "automation/entry.js",
    "clientEntry": "ui/entry.js"
  },
  "requires": [
    { "id": "system.pf1e", "version": ">=2.0.0 <3.0.0", "optional": false }
  ],
  "provides": [
    { "id": "pf1e.conditions.duration", "mode": "augment", "contract": 1 }
  ],
  "capabilities": ["scene.read.visible", "actor.read.visible", "automation.propose", "ui.action.register"],
  "settings": { "schema": "settings/schema.json", "defaults": "settings/defaults.json" }
}
```

Requirements for the real schema:

- Closed, versioned fields; reject unknown keys where they could change execution semantics.
- Package ID + semantic version + manifest version + AIS API major, plus exact content hash in the world lock.
- Package-relative safe file paths only; no external URL imports, dynamic remote `import()`, or runtime CDN dependency.
- Declared `requires`, `provides`, system/ruleset compatibility, entry point types, requested capabilities, configuration schema, and migrations.
- Data-only packages have no executable entry points. Theme-only packages do not receive automation permissions.
- Optional dependencies are explicit. Missing required dependencies block activation; optional ones create warnings and disable just the dependent contribution.
- A manifest/hash is an integrity check, not proof of publisher identity or trust.

### 7.2 Runtime APIs are host capabilities, not a copy of `game.*`

A module receives a temporary context for one invocation, not a long-lived host object. The context contains bounded immutable JSON snapshots and a narrow broker. Example API families:

- `context.read.*` — visible actor/token/item/scene/system snapshots. Reads are projected and scope-limited; modules never receive the whole store by default.
- `automation.on(event, handler)` — only for manifest-declared event IDs, contract versions, and capabilities.
- `automation.propose(intent)` — append a typed proposal to the current invocation; it does not commit immediately.
- `actions.request(actionId, targets, options)` — ask the system adapter to run a supported, high-level action workflow (including its canonical stages, prompts and completion). Targets are stable references that the host re-resolves and authorizes. This avoids making every calling module reconstruct attack/save/damage/effect orchestration.
- `workflow.prompt(schema, recipient, deadline)` — request a supported user decision, then suspend with a serializable continuation. On response, the host rechecks authorization and live state before resuming.
- `dice.request(spec)` — ask the host/system adapter to create and resolve an allowed roll; modules cannot invent a total or bypass commit/reveal.
- `effects.propose(definitionId, targets, duration)` — request application of an identified effect through the system/effect resolver.
- `fx.play(presetId, context)` — request visual/audio presentation after authorized checks; it is not a mechanics API.
- `ui.action/registerPanel` — register a schema-driven action/panel in an approved slot. The renderer returns a typed user action, not DOM access.
- `storage.get/set(namespace, key)` — module-owned, bounded, versioned settings only. No direct IndexedDB handles, secrets, arbitrary world-document paths, or cross-module storage.

Do **not** expose generic `submit(Op[])`, `db`, `store`, `window`, Svelte components, live Documents, user-supplied role, or an unrestricted `ctx.actor.update()` method to an imported module. The host may expose narrower, high-level operations over time after authorization and idempotency contracts are proven.

### 7.3 Event catalog and workflow phases

The kernel should have a small universal event catalog and allow a system package to publish additional typed contracts in a namespace such as `system.pf1e.*`. Each event is defined with:

- stable ID and contract version;
- immutable input schema and visibility policy;
- allowed contribution modes;
- whether it is observational, transformable, or decision-making;
- expected deadline / retry / cancellation behavior;
- effect on host state and whether a human prompt is allowed;
- result schema and system-specific reducer, if applicable.

Initial cross-system events could include `scene.activated`, `turn.phase.changed`, `token.move.before`, `token.move.committed`, `action.intent`, `action.committed`, `effect.expired`, and `chat.message.committed`. System-owned combat events could include `system.<id>.check.prepare`, `roll.requested`, `roll.resolved`, `attack.classified`, `damage.proposed`, `effect.proposed`, and `action.committed`.

A combat/action workflow should be explicit rather than one mutable workflow object:

```text
user action
  → host authenticates caller and validates input
  → system adapter creates a canonical action snapshot
  → before/prepare extension stages return typed modifiers or veto reasons
  → host/system adapter rolls or requests a player decision
  → result is canonicalized by the host/system adapter
  → damage/effect proposals are composed and revalidated against live state
  → one host transaction commits mechanics + durable action record
  → read-only after-commit events emit chat/FX/UI notifications
```

A “before” hook may only do what its event contract explicitly permits (for example, add a bounded modifier, offer a reaction, or return a veto reason). “After commit” observers cannot reverse or rewrite the committed result. User prompts suspend at named safe boundaries; no mutable object remains open across a prompt. The contract also fixes dispatch semantics: deterministic sequential execution for reducers, optional parallel dispatch only for read-only observers when order cannot affect outcomes, and an explicit typed veto result only for stages declared vetoable. Errors are recorded; continuation or fallback behavior is stage-specific, not an accidental consequence of `false`, exception, or load order.

### 7.4 Safe declarative automation is the first-class path

Use a bounded declarative graph/condition language for common automation: triggers, filters, resource checks, choices, calls to named system services, rolls, effects, chat, and FX. `src/core/automation.ts` is an existing foundation. The authoring UI can show conditions, branches, inputs and resulting host actions without requiring code review. Item-, ability-, or content-specific behavior is stored as a binding to a stable namespaced automation ID, named event/stage, and schema-validated parameters—not as a string naming an arbitrary macro or a live workflow object.

Arbitrary code remains an advanced package feature. Code may calculate or choose from a bounded set of outputs but still uses the same typed event and intent contracts. An automation package cannot bypass the graph/runtime's limits by asking for direct world writes.

## 8. Multi-module arbitration and conflict policy

Every contribution declares a mode. These are contract semantics, not UI labels only.

| Mode | Semantics | Typical use |
|---|---|---|
| `observe` | All handlers receive the same immutable event. Results cannot change mechanics; errors are isolated. | Trace, chat/FX cues, optional UI refresh. |
| `augment` | All providers emit typed contributions. A system-owned reducer combines them using a published stack rule. Contributions are namespaced and deduplicated. | Additive modifiers, condition tags, extra action options. |
| `transform` | A deterministic reducer chain receives a typed value and each provider returns a schema-checked transform. Order is explicit and traceable; the system defines legal fields and merge semantics. | Normalizing inputs, adding an allowed roll term, selecting among supported targets. |
| `exclusive` | One selected provider owns a resolver slot. Two enabled exclusive providers for the same slot are a pre-activation conflict unless a declared delegation protocol applies. | Damage resolver, initiative resolver, replacement of a system's base targeting policy. |
| `register` | Each contribution adds a new namespaced command/action/content ID; duplicate IDs are rejected. | A new skill, effect, hotbar action or automation definition. |

### Resolution order

1. Required package/dependency order is a DAG; cycles are a validation error.
2. The world profile may specify priority bands and explicit `before`/`after` where the contract allows them.
3. Within a cooperative event, execution order is stable: declared precedence, then package ID and contribution ID as a deterministic tie-breaker.
4. For authoritative resolution, a stable tie-breaker is **not** a substitute for resolving an exclusive conflict. The GM must choose the winning provider, explicitly opt into a supported chain, or disable one provider.
5. Every reducer records its input hash and accepted output summary in the GM trace. A module cannot silently overwrite an earlier result.
6. Core/system fallback behavior is explicit. If an optional module fails, use the declared fallback or stop that feature with a visible error; never silently select a random provider.

### Conflict examples

- Two modules both add resistance modifiers: both may contribute if the system adapter defines whether they stack, cap, or deduplicate. Otherwise activation fails for that slot.
- Two modules both claim `pf1e.damage.resolve` exclusively: the manager marks a hard conflict and asks the GM to select one. “Enable both and hope load order wins” is not supported.
- One provider implements a new named spell automation and another implements a different spell: no conflict if their IDs differ.
- Two themes set the same `surface.background` token: one selected base theme or an explicitly ordered accent composition; no accidental cascade order.
- A UI module wants to replace core navigation: deny the slot. It can add a panel in a supported slot, not remove escape/disable controls.

Module-to-module calls must use declared service contracts resolved by the broker. A module must not import another package's internal entry point or reach into another module's mutable state. Cross-module events use namespaced IDs, schema validation, and the same bounded RPC limits as host calls.

## 9. Execution, authority, and deterministic state

### Authority rule

Only the host's existing permission and transaction path changes shared world state. Modules can observe authorized projections and propose domain intents. The host then:

1. re-reads live data and role/visibility for the caller;
2. validates the action against the current system adapter and package profile;
3. checks module capability, event stage, user permission, action audience, and resource/range constraints;
4. canonicalizes names, totals, formulas, result provenance, and stable IDs where required;
5. commits accepted mechanical operations in one normal host envelope;
6. emits after-commit events and visual cues separately.

No script-returned `true`, player-supplied roll total, or module-supplied permission statement is evidence of authority. If an automation fails after a commit, the trace must say which earlier step committed; presentation errors cannot roll back a completed world transaction.

### Replay and multiplayer

- A single authoritative GM host executes mechanics. Do not run authoritative modules independently on each player's machine and compare outputs.
- A module invocation gets an invocation ID derived from world, event, host sequence/action ID, phase, and contribution ID. Retried transport messages deduplicate against this identity.
- Deterministic system services get seeded RNG from the host invocation. Wall clock, ambient browser randomness, network responses, and mutable global state are not inputs to deterministic resolution.
- Prompts return typed player responses. The host stores a continuation token, validates the response once, then re-reads and revalidates world state before resuming.
- Module versions, API contract versions, hashes, required features, and selected exclusive providers are part of the world profile. Host/player negotiation happens before features that need local UI or matching logic are used.
- Mechanics remain host-resolved even when player UI code is missing. A client with no optional UI module sees the core fallback; a missing required rules provider is a compatibility error, never an invisible ruleset change.
- (D-468) Player-side module code is **the same archive the GM approved**, delivered by the host in `ais.profile` and keyed by hash; it runs under the player's identity against the player's visibility-filtered replica, and its writes are ordinary intents — the host's permission path is the only authority for them, exactly as for a human player's own edits.
- Module-produced player UI is client-side presentation only. It gets that player's projected data and can request actions through the host; it never gets GM documents or host-only secrets.

### Budgets and failure containment

All boundaries need hard caps: JSON depth/bytes, number of handlers per stage, intents per invocation, prompts, nested calls, parallel work, storage size, wall-clock time, and per-package memory where the browser permits it. Initial numeric caps should be measured against actual PF1e workflows and written as versioned API limits. Interactive prompt deadlines are separate from compute deadlines.

- Run code outside the app's main event loop where possible; one module's infinite loop must not freeze core UI.
- On timeout, terminate that module invocation, cancel its outstanding capability tokens, reject its uncommitted proposals, and continue only if that event declares a safe fallback.
- Repeated failures trip a circuit breaker and quarantine the offending contribution for the session, with a visible manager warning.
- One module cannot prevent core settings, exit, save, or disable controls from rendering.
- Never retry a side-effectful call blindly. Idempotency keys are mandatory for proposals that can be replayed.

## 10. Security and trust model

World packages are arbitrary user-provided artifacts. Treat their code, data, strings, SVGs, CSS, templates, filenames and declared permissions as hostile until validated. A zip hash protects integrity, not origin or intent.

### Execution tiers

1. **Data-only** — no code. Validate structure and render through core templates. No execution consent required.
2. **Declarative automation** — interpreted by the app's bounded graph/condition evaluator. No arbitrary JavaScript. Host authorizes every resulting intent.
3. **Sandboxed module** — default for executable package code. Run in an isolated frame (`sandbox="allow-scripts"`, opaque origin; never `allow-same-origin`, top navigation, popups, forms or downloads) with a restrictive CSP that denies network/connectivity by default. Bootstrap a one-use `MessageChannel`; validate every request/response by module identity, invocation ID, schema, size, rate, and capability. The module has no host DOM, localStorage, IndexedDB handle, or direct transport/store reference.
4. **Trusted in-page code** — explicit local-only escape hatch for GM-authored/accepted code, with a severe warning that it is page-class code and may be impossible to unload. Never the default for imported modules; never trust based only on manifest request; never export the grant. Long-term, migrate users away from this path as AIS covers required cases.

A worker is useful for performance isolation but is not, by itself, a security sandbox; browser Workers can expose networking and resource-exhaustion risks. Monkey-patching `fetch` is defense in depth, not a security proof. Arbitrary-code packages should not be given more authority than their brokered capabilities, and the UI must say exactly what each capability grants.

### Capabilities and authorization

Capabilities are granular and are both requested at install time and granted by the GM per world/package. Examples:

- `scene.read.visible`, `actor.read.visible`, `item.read.visible`;
- `turn.observe`, `action.observe`, `automation.propose`;
- `roll.request`, `effect.propose`, `chat.post`;
- `ui.panel.register`, `ui.action.register`, `theme.tokens.read`;
- `module.storage.read/write` within the package's namespace.

No default `world.write`, `actor.update.any`, `admin`, `network`, or raw operation capability. A capability answers “may this module request the operation?”; ordinary user permission answers “may this caller do it to these objects now?” Both are required. Capability grants are revoked immediately on disable, version/hash change, dependency resolution change, or explicit revoke. Role, user ID, target visibility and ownership are always host-derived.

### UI and asset safety

- No untrusted package HTML inserted into app DOM. Use escaped text and core-rendered forms/cards.
- A custom UI frame gets a scoped data projection and the same broker, never a reference to parent elements.
- Core theme customization is token-based (colors, type scale, spacing, border, icon IDs, density, panel layout presets). No arbitrary global selectors or CSS that can cover/hide consent and safety controls.
- If arbitrary custom CSS is ever accepted, scope/sanitize it and consider it a separate, explicitly trusted feature; do not make it the normal Gothic-theme path.
- SVGs, rich text, media URLs and filenames require the existing safe asset pipeline; no `javascript:` or remote code/content fetch in package data.

## 11. UI and mod management

Add a world-scoped **Settings → Automation & Modules** manager. It is a package manager and a runtime debugger, not a folder of opaque ZIPs.

### Import/activation flow

1. **Import package ZIP** — validate archive paths, manifest, referenced files, API version, compatibility, required dependencies, size quotas, and hash. Import to a disabled staging state. Do not execute code during import or preview.
2. **Review package** — display name, author/source metadata if supplied, version/hash, description, system compatibility, requested capabilities, declared extension slots, UI surfaces, migrations, dependencies, and data/media sizes. Clearly say unsigned metadata is self-asserted.
3. **Resolve dependencies/conflicts** — show missing package versions, incompatible packages, duplicate action IDs, exclusive slot conflicts, order cycles, and expected fallback behavior.
4. **Enable** — GM explicitly chooses which compatible package contributions become active. Prompt separately for any code capability. Enabling an imported package is not the same as granting in-page trust.
5. **Configure** — render the module's validated settings schema with descriptions/defaults. Show which settings are campaign-shared versus device-local.
6. **Preview/test** — run a no-write diagnostics pass; display registered events/actions, conflicts, and simulation traces. A UI/theme contribution can be previewed before applying.
7. **Disable/rollback/update** — immediate disable cancels active invocations and falls back safely. Updates are staged beside the pinned version; the GM reviews changed capabilities and migrations before switching. Preserve the prior lock until the new version passes validation.

### Manager screens

- **Overview:** active system, enabled modules, missing dependencies, compatibility status, last errors, unresolved conflicts, theme in use.
- **Installed:** version/hash, enabled/disabled, package type, system compatibility, requested/granted capabilities, declared entry points, source package, data footprint.
- **Subsystems:** groups contributions by named extension point. For an exclusive point, show the selected resolver and competing providers with “select / disable / supported chain” controls. For additive points, show the reducer/stacking rule and effective order.
- **Settings:** schema-driven module settings; include a reset-to-default action and clear local-only/world-shared labels.
- **Theme & Layout:** select one base theme and compatible accents, preview using a standard scene, restore default. Theme toggles never change game mechanics.
- **Diagnostics:** searchable GM trace for registration, invocation, denied capability, timeout, fallback, budget, and commit IDs. Each entry links to the package, event, version, and help text without exposing secret data to players.
- **Import/export:** package export and world ZIP export preserve package files and desired profile; local trust grants remain local.

Player controls contributed by modules appear only in core-approved slots and use core-rendered accessible components where possible. If the module UI fails, the user must still be able to perform core actions through the default UI. Player-specific cosmetic preferences (e.g. a high-contrast Gothic variant) are device-local; rules and shared profile are world-controlled by the GM.

## 12. World ZIP, activation profile, settings and migration

### World ZIP additions

Keep package file bytes in the world archive under package IDs, as the current format already does. Add a versioned, explicit **interconnect profile** that records desired shared state, for example:

```json
{
  "format": 1,
  "api": "arena.ais/1",
  "system": { "id": "system.pf1e", "version": "2.4.1", "hash": "..." },
  "modules": [
    { "id": "example.condition-automation", "version": "1.2.0", "hash": "...", "enabled": true }
  ],
  "providers": {
    "pf1e.damage.resolve": "system.pf1e/default"
  },
  "theme": { "base": "theme.gothic-noir", "accents": ["theme.high-contrast"] }
}
```

The actual file layout may reuse `world.json`/`packages.json`, but it must be versioned and distinguish **installed**, **enabled**, **selected provider**, and **trusted here**. Export packages that are required by this profile; if portability is desired, export all installed packages and label inactive ones. Do not silently omit code required to replay/restore a campaign.

### Trust and copy semantics

- `automationProfile` and module settings/schema defaults may be exported with the world because they are campaign data.
- Per-user UI prefs stay local unless the GM explicitly authors them as a shared campaign profile.
- Explicit code grants, in-page trust, publisher trust, host/browser secrets, local approvals, and access tokens are never exported.
- Import-as-copy imports profile intent but the copy starts with executable packages **disabled/untrusted** until the new GM reviews and enables them. A restore on the same device may retain that device's prior local consent only if the exact package hash remains the same; changed code requires re-review.
- The package lock records exact versions and hashes. Semver ranges are used for dependency resolution at import/update time, not as a floating version at runtime.

### Configuration and migrations

Package settings are namespaced by `worldId/packageId/schemaVersion`. Values are JSON, size/depth bounded, validated before persistence, and never share keys with other modules. Upgrade migrations are declarative where possible. Any executable migration runs in the same restricted context, is previewed as a diff, has an explicit backup/rollback plan, and runs only after GM confirmation. Imports never run migrations merely because an archive was opened.

### Compatibility negotiation

- The host resolves the effective package lock before accepting player actions that depend on it.
- Host sends a compact `worldCapabilities` profile with API major, required feature IDs, package IDs/versions/hashes needed for client views, and system version.
- Player UI modules are either already installed from the same world ZIP/hash or loaded from a bounded, hash-verified host package transfer. Host code must not expose arbitrary package paths as public reads.
- If a client lacks an optional theme/panel, core fallback is acceptable. If a client lacks a required contract for an action UI, hide that optional UI but keep an accessible core route. If the host lacks an active authoritative provider, refuse that feature rather than change rules silently.
- Keep the existing `requiredWorldFeatures` pattern for wire/archive compatibility: new semantics are explicit feature tags, old clients can be rejected or limited before they see an unsupported policy.

## 13. Modifying UI without breaking the app

The supported UI stack should have three levels:

1. **Theme tokens (recommended):** JSON values for palette, typography tokens, spacing, surface/outline, icon mapping, animation preference, density, and allowed panel layouts. Core CSS maps these to scoped `--arena-theme-*` properties. This is enough for a strong “Gothic” or “sci-fi” reskin while preserving controls and accessibility.
2. **Schema-driven views/actions:** a module registers a panel/action descriptor—title, icon, slot, required capability, field schema, row/detail schema, and callbacks by namespaced action ID. The main app renders it with its own accessible components and typed API.
3. **Custom rich panel (advanced):** an isolated iframe with its own DOM/CSS and a scoped, projected data feed. It can render bespoke dashboards, but it cannot style or query the app shell. Requests return typed messages, which the host validates. Do not load a world-supplied Svelte component into ArenaStar's parent runtime.

Slots should be deliberate and few: system sheet tab, action/ability section, sidebar panel, GM tools, settings page, chat-card renderer, toolbar action, and campaign theme. Slots have stable IDs, contract versions, sizing/keyboard rules, and declared audience. Core rails, network/session controls, import/export, recovery, permissions, and navigation are not replaceable slots.

## 14. Observability, failure modes, and recovery

The manager should distinguish:

- package invalid (archive/manifest/hash/path/schema);
- dependency unavailable/incompatible;
- API/event contract unsupported;
- provider conflict or order cycle;
- capability not requested/granted;
- invocation denied by current user permission;
- module exception, timeout, output schema failure, budget limit;
- host commit rejection or stale state;
- UI renderer unavailable / theme invalid / core fallback active.

Each trace record should include `worldId`, package ID/version/hash, contribution ID, event contract, invocation/action ID, caller audience (or privacy-safe user key), phase, duration, result class, sanitized error, budget, and commit sequence if any. It must not store secret actor data, raw private script inputs, or another player's hidden state in a player-visible log.

A single faulty optional module should be disableable without restarting the whole world. Package registration is staged before activation; if boot fails, core opens in safe mode with the last known-good profile and a clear explanation. Disabling a module cancels pending invocations/prompts and unregisters its callbacks. A trusted in-page legacy script is an exception: the app can stop calling it and remove visible globals, but cannot guarantee undo of arbitrary side effects already executed; mark it accordingly.

## 15. Rollout plan

### Phase 0 — contract and safety spike

- Lock the terms (`system`, `module`, `data`, `theme`) and `arena.ais/1` manifest schema.
- Build a miniature extension registry + arbitration validator with no code execution.
- Prove module registration, exclusive conflict display, dependency resolution, and world-profile round-trip in tests.
- Verify proposed sandbox/CSP/MessageChannel behavior in Chromium and target browsers before promising it as a security boundary.
- Measure current `pnpm build` + `pnpm size` headroom; reserve explicit size budget for kernel and manager before implementation.

### Phase 1 — package manager and declarative UI/themes

- Add independent module package role and per-world active profile while retaining old `system.module` import behavior through an adapter.
- Add enable/disable/configure, dependency/conflict diagnostics, explicit local capability grants, module settings namespace, and local-vs-world profile split.
- Add theme tokens and schema-driven UI slots; no arbitrary custom page code yet.
- Add multi-module package archive/export/import and local-trust non-export tests.

### Phase 2 — read-only event bridge

- Introduce versioned event contracts, immutable projected contexts, an async observer bus, per-module budgets, circuit breaker, trace log, and package health UI.
- Run modules only in the sandboxed context; no mechanics write API. Pilot `scene.activated`, `turn.phase.changed`, and `action.committed` observers.
- Add player-side UI module hydration/compatibility fallback for theme and panels.

### Phase 3 — safe automation contributions

- Connect the existing automation graph planner and reviewed scripts to the same registry/broker where practical.
- Add typed `augment` and `transform` extension points for one selected system workflow (recommended pilot: one PF1e action/check/damage vertical slice, with explicit stages and one provider conflict case).
- Add prompt/continuation protocol, host revalidation, idempotency, atomic commit, and after-commit FX/chat behavior.
- Keep system rules pure in SimWorker with seeded RNG. Do not allow general module hooks inside deterministic sim without an explicit pure contract.

### Phase 4 — rich isolated panels and wider system adapters

- Add advanced sandboxed custom panels, richer event schemas, system-provided stacking policies, and module-to-module declared services.
- Port one existing system-specific feature as a package outside main `App.svelte` to demonstrate actual bundle independence.
- Convert legacy trusted in-page modules only where the safe API now covers their needs; retain explicit opt-in for unavoidable legacy integrations.

### Phase 5 — polish, authoring SDK, and publishing workflow

- Add manifest editor/templates, example packages, local package export, compatibility checker, migration preview, theme preview and documented SDK.
- Add optional package signing/publisher metadata if a signing trust-root is chosen. Signing is a later provenance feature; never block offline package authoring on a remote registry.

## 16. Acceptance criteria

The first generally usable AIS release should meet all of these:

1. The built main file passes the existing 6 MiB raw `pnpm size` gate; no world/system/module source or large module assets are statically bundled.
2. A world can activate one system package and at least two independent automation modules concurrently.
3. Importing a world ZIP does not execute module code; code activation and capabilities require a clear GM action.
4. The active module profile, provider selections, package files, and exact hashes round-trip through world export/import/copy; local trust does not.
5. A missing or incompatible optional module produces a clear warning and safe fallback; a missing required authoritative provider blocks the relevant action rather than silently changing the rules.
6. Read-only events expose only an authorized projection; no module can read the raw store or mutate a host document directly.
7. Every state-changing contribution is host-validated, permission-checked, idempotent, and committed through the normal host transaction path.
8. Two cooperative contributors run in deterministic order under the documented reducer; two exclusive providers conflict visibly and cannot be enabled ambiguously.
9. A timeout, exception, malformed response, oversized message, revoked capability, or stale prompt response cannot partially commit an unvalidated action or hang the app.
10. A client without an optional theme/module can use the core UI; a module can add a panel/action without overriding core navigation or escaping its audience projection.
11. Diagnostics identify the module, version/hash, event, failure, fallback, and whether a host commit occurred.
12. Tests cover package validation, world profile migration, dependency graph, exclusive/additive arbitration, malicious RPC frames, bounds, permission changes, replay/dedup, player visibility, host/peer compatibility, theme fallback, and multi-module browser behavior.

## 17. Open decisions to settle before coding

1. **Package role name:** `module`, `automation`, or a generic module with typed `contributes` fields? Recommendation: use `module` as the package role and classify behavior with `contributes`, so a package can provide automation + UI without duplicate wrappers.
2. **Client code delivery:** require players to import the world ZIP, or transfer selected UI module blobs from host? Recommendation: first require exact local package/hash for client code and fall back to core UI; add verified bounded package transfer only if user testing shows this is too much friction. **Decided (D-468):** the host transfers the approved archive in `ais.profile`, identified by hash; the player consents per device and hash; no local import is required.
3. **Custom UI ceiling:** is theme-token + schema-driven UI enough initially, or is a sandboxed custom panel required in v1? Recommendation: ship first two levels first; do isolated custom panels after sandbox/CSP proof.
4. **Trusted in-page modules:** keep as a long-lived legacy tier, or deprecate after sandboxed capabilities reach parity? Recommendation: retain temporarily but make the warning and non-unloadability explicit; don't extend it with new APIs.
5. **System-specific event evolution:** can an installed system package declare new events at boot, or must the main app predeclare every event? Recommendation: core owns universal events; a system may declare additional namespaced contracts, validated against a bounded schema subset and pinned with its version.
6. **Code provenance:** is GM consent enough for local campaign use, or will ArenaStar eventually provide signed/published modules? Recommendation: start offline-first with local consent and hashes; don't imply hashes are signatures.
7. **What counts as mandatory for a player client:** decide per contribution whether it is host-only, player-UI-optional, or player-UI-required, and encode this in the profile/handshake rather than guessing from `module.entry`. **Decided (D-468):** mechanics stay host-resolved; shared modules at the player are optional UI/intent producers, and a player who declines still plays with the core fallback (the GM device keeps running the module).

## 18. Recommended prototype vertical slice

Before migrating a whole game system, build one small sample world package set:

- `demo-system`: minimal system adapter with one check and one damage/effect result schema;
- `demo-automation-a`: observes the check and proposes a bounded modifier;
- `demo-automation-b`: contributes an optional action and an effect after commit;
- `demo-conflict`: deliberately claims the same exclusive resolver slot as the system, proving conflict UI and explicit provider selection;
- `demo-gothic-theme`: token-only reskin with a previewable sidebar panel;
- one data package with a few actors/effects bound by stable automation IDs.

Acceptance walkthrough: import a ZIP; inspect without execution; enable three compatible packages; resolve an additive modifier in a deterministic order; see the exclusive conflict and choose a provider; run an action as GM and player; confirm mechanics commit once and FX/chat fire afterward; disable one module while an invocation is pending; export/copy the world and confirm the new copy has the same desired profile but no local code trust; run the same flow with a client missing the optional UI package and verify the core fallback.

This prototype exercises the hard architecture questions—multi-module coexistence, system-owned semantics, trust, authority, UI, packaging, and host/peer compatibility—without prematurely porting a large Foundry ecosystem or weakening the bundle budget.
