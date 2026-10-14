# Proposal: world-packaged Foundry compatibility through AIS

**Status:** broader implementation proposal; the limited [D-462 feasibility slice](AIS_FOUNDRY_FEASIBILITY.md) now runs. This is not general compatibility certification.  
**Date:** 2026-10-13.  
**UI follow-up:** [D-463 appearance adapters](AIS_UI_MODULES.md) add a self-opening demo and three
bounded upstream UI profiles. This advances appearance resources/live activation, not general
Foundry DOM or application compatibility.  
**Baseline:** AIS v1 after D-461; see [the AIS design](AUTOMATION_INTERCONNECT_DESIGN.md).  
**Decision requested:** approve a bounded compatibility/runtime-provider architecture and two pilot modules—not a promise to run the entire Foundry ecosystem.

## 1. Recommendation

**Yes, the proposed arrangement is technically plausible for a selected, tested subset of Foundry modules:** put an adapter package, the original module, its approved dependencies, and compatibility profiles in the world ZIP. Enabling the adapter makes a compatible guest eligible to run; enabling the guest still requires its own review and local consent.

The adapter must provide a **package-local Foundry API environment**, not merely rename dependencies. It supplies local `Hooks`, `game`, document/collection facades, settings, and selected UI/library APIs. Behind those facades, AIS supplies projected data and host-authorized operations. Neither the guest nor the adapter receives ArenaStar's live store, DOM, renderer, transport, or GM session.

Recommend:

1. **Keep Foundry-specific compatibility code in world packages.** Add generic runtime-provider, workflow, document-projection and service primitives to AIS/core.
2. **Start with a Foundry v13 compatibility profile**, pinned to a concrete reference build during the spike. This is a deliberately limited target, not a claim that v13 is the latest Foundry release. v14 requires a separate profile and certification.
3. **Pilot the original Tagger 1.5.4 code**, initially its declared scene/API subset, then the original Torch 3.3.0 code with a small PF1 inventory/light profile. Test real upstream code, not another native rewrite.
4. **Expose our existing FX engine through AIS and an early Sequencer-shaped API facade.** The FX wizard already authors substantial native sequence behavior; do not rebuild it or defer this useful dependency bridge until the final phase. Running upstream Sequencer's implementation is a separate, nonessential goal.
5. **Keep the existing native `pf1e-torch` as a supported fallback.** Do not replace a working module until the guest path meets explicit acceptance criteria.
6. **Make licensing and provenance a prerequisite.** Technical emulation does not establish permission to redistribute a module or its embedded Foundry code.

A useful product claim is:

> “These exact module versions and features are tested with this adapter/profile.”

Not:

> “Enable the adapter and any Foundry module will work.”

### 1.1 What “selected modules” means

Selection is **by required contracts and demonstrated behavior, not a permanent module-name whitelist**.
Distinguish choosing initial engineering pilots from declaring a module verified:

- A guest needs a supported Foundry API/version profile and, where applicable, a supported system model.
- Its required library APIs, resource-loading patterns, hooks, document operations and UI surfaces must
  be implemented or explicitly substituted. Merely finding a dependency name is insufficient.
- Its required behavior must fit AIS's authority/isolation rules. Private renderer patches, unrestricted
  host DOM/store access or automatic GM escalation are blockers unless replaced by a supported contract.
- Running/packaging the actual artifacts needs the relevant consent and license/provenance review.
- Only version-specific behavior tests justify a verified status. Static scans help diagnose gaps;
  dynamic JavaScript prevents treating them as a complete compatibility proof.

A new module that uses covered APIs should not require its name to be added to the kernel. A GM can
attempt an unverified guest under a generic supported profile with explicit consent and diagnostics;
unknown calls still fail and permissions do not expand. Module-specific recipes are exceptions for
real mismatches, not the default architecture. Named certification profiles record tested combinations;
they should not replace reusable API-family profiles.

Tagger and Torch were proposed as pilots because they exercise reusable document, flag, hook,
settings and action boundaries, and ArenaStar already supplies useful native equivalents for comparison.
A Sequencer-shaped facade over native FX is an early parallel integration because it can satisfy a
common dependency without importing another renderer.

## 2. What the documentation and source actually show

### 2.1 Foundry modules depend on an environment, not just other packages

The official module guide documents `module.json`, ordered scripts, ES modules, styles, languages, compendia, version compatibility, dependency relationships and module socket namespaces. Resolving `relationships.requires` alone does not supply the rest of that runtime. [1](https://foundryvtt.com/article/module-development/)

Relevant semantic contracts:

| Foundry contract | Consequence for an AIS adapter |
| --- | --- |
| `Hooks.call` calls listeners in registration order and stops on explicit `false`; `callAll` calls all listeners | A queued after-commit notification is not a cancellable hook. Preserve synchronous local dispatch semantics; implement a real pre-commit stage where needed. |
| `preUpdateDocument` can modify the pending differential or return `false`; it runs on the initiating client | The adapter needs a working draft and a defined initiator scope. Do not run every client's pre-hook independently or veto after the write. |
| `updateDocument` runs after processing, for connected clients | Update projections first, then dispatch the projected post-commit notification with the originating user and commit identity. |
| Collections, `getFlag`, embedded-document lookups and settings reads are synchronous | Hydrate a bounded local mirror before calling module code. A Promise-valued proxy is not a compatible replacement. |
| `setFlag` / document updates are asynchronous document operations | Translate only supported operations to validated host intents, and resolve after acknowledgement plus local mirror reconciliation. |
| `ApplicationV2` renders HTML into Foundry's UI | ArenaStar has no equivalent Foundry DOM. Native UI slots or a deliberately implemented isolated UI profile are required. |
| Systems define their own DataModels, document classes and behavior | A generic Foundry facade does not implement PF1, PF2e or dnd5e. A system-specific compatibility contract is a separate dependency. |

Primary API references for the table: [Hooks](https://foundryvtt.com/api/v13/classes/foundry.helpers.Hooks.html), [preUpdateDocument](https://foundryvtt.com/api/v13/functions/hookEvents.preUpdateDocument.html), [updateDocument](https://foundryvtt.com/api/v13/functions/hookEvents.updateDocument.html), [Document](https://foundryvtt.com/api/v13/classes/foundry.abstract.Document.html), [ClientSettings](https://foundryvtt.com/api/v13/classes/foundry.helpers.ClientSettings.html), [ApplicationV2](https://foundryvtt.com/api/v13/classes/foundry.applications.api.ApplicationV2.html). System extension points are described in the system-development guide. [3](https://foundryvtt.com/article/system-development/)

**Important distinction:** Foundry's protected document `_preUpdate` method is async; the public `preUpdateDocument` hook and `Hooks.call` have synchronous cancellation semantics. An adapter must not conflate them or silently start awaiting promises returned by legacy hook listeners.

### 2.2 Representative module audit

This table records the initial **static documentation/source inspection**. The subsequent D-462 demo now exercises the pinned Tagger 1.5.4 source through the real browser lifecycle; other rows remain assessments, not runtime certification. Source pins and paths are recorded in §12. The demo is source-preserving/rebundled, not an untouched published release archive.

| Candidate | Observed dependencies | Assessment / recommendation |
| --- | --- | --- |
| **Tagger 1.5.4** | ES module imports; synchronous scene collections and tag queries; flags; `preCreate` / `preUpdate`; `updateSource`; keybindings; configuration-UI hooks | **Best first guest pilot.** Start with explicitly listed scene collections, queries and tag writes; then pre-create rules. Do not initially certify its complete UI, all-scene search or integrations with Token Attacher / Monk's modules. |
| **Tagger 1.6-era source** | The above plus refactored native-DOM configuration and sidebar integration | Separate target after the 1.5.4 pilot. Do not assume success on one version certifies the other. |
| **Torch 3.3.0** | Settings and localization; Actor/Token/Item facades; prototype token light; flags and `update`; HUD DOM and jQuery; dialogs; socket handlers; optional configuration-file fetch | **Plausible second pilot**, using a PF1 inventory/light profile and declared UI replacement. Its complete cross-system behavior is not a generic mapping problem. |
| **libWrapper 1.13.5.1 family** | Resolving and wrapping named methods, including prototypes; wrapper ordering and `this`/return behavior | **Curated facade targets only**, initially. A `libWrapper` shim cannot wrap an ArenaStar method that has no Foundry semantic equivalent, and must never patch the actual host renderer/store. |
| **socketlib 1.1.4 family** | Registered remote functions, selected-GM execution, user/everyone broadcasts and awaited results | A **restricted service/delegation shim** is plausible. Preserve initiating-user authority; `executeAsGM` cannot become arbitrary GM execution. |
| **Sequencer 4.3.0** | Foundry canvas classes/layers, PIXI objects, animation ticker, renderer access and wrapping `PIXI.BaseImageResource.prototype.upload` | **Not a sensible first unchanged-code target.** Prefer a documented subset facade over ArenaStar's native FX services. Running the entire upstream renderer would be a much larger compatibility project. |

Source evidence includes Tagger's [API documentation](https://github.com/fantasycalendar/FoundryVTT-Tagger/blob/e7936bc9ee01e4445624fbc82a11e887e5cd0075/docs/api.md) and [entry implementation](https://github.com/fantasycalendar/FoundryVTT-Tagger/blob/e7936bc9ee01e4445624fbc82a11e887e5cd0075/scripts/module.js), Torch's [entry](https://github.com/League-of-Foundry-Developers/torch/blob/f1ee45a8148ad6e7029043ad2fe829472720144c/src/torch.mjs), [HUD](https://github.com/League-of-Foundry-Developers/torch/blob/f1ee45a8148ad6e7029043ad2fe829472720144c/src/hud.mjs) and [token state machine](https://github.com/League-of-Foundry-Developers/torch/blob/f1ee45a8148ad6e7029043ad2fe829472720144c/src/token.mjs), the [libWrapper contract](https://github.com/ruipin/fvtt-lib-wrapper/blob/ad83e8b339bb38d4feea21c3a2896804454178a2/README.md), [socketlib API](https://github.com/farling42/foundryvtt-socketlib/blob/3cae17890800852478c973b14b612bef2b16df3e/README.md), and Sequencer's [canvas implementation](https://github.com/fantasycalendar/FoundryVTT-Sequencer/blob/d8529e70ac91cee705f3dd0803231ca1c147e1e3/src/canvas-effects/canvas-effect.js) / [wrapper target](https://github.com/fantasycalendar/FoundryVTT-Sequencer/blob/d8529e70ac91cee705f3dd0803231ca1c147e1e3/src/libwrapper.js).

**A concrete parity trap:** Torch 3.3.0 writes its flag state, changes light, and consumes eligible inventory when switching the source **off**, restoring prototype-token lighting. Our native `pf1e-torch` consumes on activation and uses its own state model. Existing native Torch tests are valuable regression coverage, but are **not an oracle for upstream Torch semantics**. The guest profile must either match its pinned upstream version or disclose and test an intentional adaptation.

**A concrete CSP trap:** Torch's [source-library loader](https://github.com/League-of-Foundry-Developers/torch/blob/f1ee45a8148ad6e7029043ad2fe829472720144c/src/library.mjs) uses Ajv runtime schema validation for custom source configuration. Ajv documents that runtime compilation uses `Function`, and recommends standalone build-time validators when CSP forbids it. [2](https://ajv.js.org/standalone.html) Thus the custom-source feature needs a tested preparation/dependency recipe or must remain explicitly unsupported. Packaging the original bundle alone does not fix it; adding `unsafe-eval` is not the proposed solution.

### 2.3 Current ArenaStar is a good base, but cannot do this unchanged

Repository facts after D-461:

- `src/packages/packageLoader.ts` accepts native `manifest.json` packages and decodes **every package file as UTF-8 text**. `PackageRecord.files` is a string map; package hashing uses that model.
- `src/core/packageManifest.ts` requires native slug IDs and three-component semantic versions. Foundry metadata can differ: inspected libWrapper uses `1.13.5.1`; source-tree manifests can contain build-time version placeholders. Do not silently coerce those into a native version.
- `HostAutomationModuleBoot` supplies a **single classic-script source** to each AIS instance. The iframe is hidden, script-only, with network, media, child frames and workers denied. It is not an ES-module/VFS loader or a visible Foundry application surface.
- AIS has narrow scene/inventory/light/storage/chat/UI RPCs and typed observations. Contribution modes are resolved as metadata, but there is no general prepare/reduce/prompt/commit workflow executor.
- Current AIS execution is GM-host-local. A player compatibility runtime, projected package delivery and original-caller delegation are not implemented.
- The repository already has host-authorized tags, FX, macros, prefabs and summons. `src/host/scriptWorker.ts` exposes **ArenaStar-native, often asynchronous APIs**, not upstream `Tagger`, `Sequence`, Foundry Documents or a general module loader.
- `src/core/foundryImport.ts` and `src/packages/pf1e/import/foundry.ts` translate selected exported data. They are not a running Foundry engine. PF1 actor components are converted into ArenaStar's model rather than retaining the whole Foundry system implementation.
- `src/host/sync.ts` currently has a synchronous `handleIntent`. Awaitable extension stages require an explicit intake/commit scheduling change, not just a hook fired beside it.

These gaps are real core/AIS work; an ordinary module cannot safely fill them by itself.

## 3. Proposed architecture: an adapter-backed runtime

```text
World ZIP
  native packages / world documents / assets
  ais-foundry-v13              adapter code + compatibility profiles
  ais-foundry-pf1-light        optional, narrow system model translation
  foundry-tagger               original module files + native wrapper metadata
  foundry-torch                original module files + native wrapper metadata
  approved dependency packages or explicitly selected substitutes
  exact dependency/profile/artifact lock + notices
                       │ import is inert; inspect / resolve / review
                       ▼
ArenaStar core / AIS 2
  package/VFS broker · runtime launcher · consent and capability broker
  projected snapshots/deltas · named workflow stages · typed services
  caller authorization · validation · host commits / receipts · safe UI slots
                       │ one instance-bound channel per execution island
          ┌────────────┴────────────────────────────┐
          │ Isolated compatibility runtime          │
          │ trusted minimal bootstrap               │
          │ + world-packaged adapter                │
          │ + approved guest/dependency code        │
          │                                          │
          │ local Hooks / game / Documents / APIs   │
          │ projected mirror, never the live store  │
          └─────────────────────────────────────────┘
```

**This is not an AIS bypass.** The direction is `Foundry guest → package-local adapter → AIS
capability/workflow/service boundary → existing ArenaStar subsystem`. Pure helpers and synchronous
reads of an AIS-projected local mirror need not make an RPC on every call, but all access to actual
world state and host-side effects remains mediated by AIS. “Runtime provider” describes how AIS
loads the foreign code, not an alternative authority or game engine.

### 3.1 The crucial change to “an adapter module”

Today's two AIS modules live in separate iframes. An adapter in one cannot synchronously create `game` or patch `Hooks` for a guest in another. Cross-frame RPC also cannot transport functions, prototypes, DOM nodes or live Documents.

Therefore add a generic **runtime-provider package role/contract**. Core validates and launches the selected adapter **with the guest inside the guest's execution environment**. The adapter is still separately packaged, enabled, versioned, reviewed and revocable. It is not injected into ArenaStar's main page and cannot define new privileged host methods.

A compatibility profile enumerates permitted document fields/scopes, lifecycle and workflow hooks,
resource patterns, wrapped facade targets, and exported AIS command/service contracts. After the guest
boots, the adapter binds approved guest APIs (for example `game.Torch.toggle`) to those declared
commands and UI actions. Results crossing back to ArenaStar contain bounded values/host document
references, never live foreign Document objects. Native reviewed macros can then call the wrapper's
AIS commands without gaining a general-purpose `eval` channel.

Package enablement and readiness become distinct:

```text
imported → inspected → dependency-resolved → consented → enabled
         → adapter prepared → projected state hydrated → guest ready
```

Enabling an adapter alone starts no arbitrary guest. Turning it off stops dependent guests and their pending uncommitted work. Replacing any executable dependency or profile invalidates the affected composed runtime's approval.

### 3.2 Ownership of responsibilities

| ArenaStar core / AIS | World-packaged adapter and profiles |
| --- | --- |
| Safe archive import, byte hashes, dependency resolution, consent | Foundry manifest interpretation and tested API/profile metadata |
| Runtime isolation, instance identity, broker validation | Local Foundry globals, collections, document facade classes |
| Permission-filtered snapshots and deltas | Translation of those snapshots into supported Foundry-shaped views |
| Named pre-commit stages, typed intents, host validation and receipts | Mapping supported hooks and guest method calls to those contracts |
| Safe UI slots, core forms, isolated panel mounting, asset broker | Module-specific HUD/dialog/template compatibility or replacement recipes |
| Typed service routing and original-caller authority | Curated dependency API substitutes, never a blanket GM proxy |
| Audit, cancellation, revocation, quarantine, fallback controls | Compatibility diagnostics and source/profile-level tests |

The kernel must remain useful for native modules. No `if (moduleId === "torch")` branch in host transaction logic; differences belong in profiles/recipes and existing native domain contracts.

### 3.3 Execution and trust boundaries

- Default to **one root guest plus adapter per island**. Embed pure dependency libraries only when their lifecycle/singleton behavior is understood.
- Adapter and guest in the same JavaScript realm are **not isolated from each other**. The adapter is not the security boundary; the host broker is.
- If mutually dependent modules require synchronous shared globals/APIs, an explicit **multi-guest island** may be necessary. All code there can exercise the island's effective granted capabilities. Review the aggregate rights and every code member; do not claim per-module privilege isolation inside that realm.
- Default-deny such grouping. Record an exact composition lock and an explicit island grant rather than silently unioning existing package grants. Read-only module A must not silently acquire dependency B's write privileges.
- Independent islands communicate only through declared JSON service contracts. Synchronous foreign APIs cannot be converted to async RPC without classifying that dependency as adapted or unsupported.
- Never use the legacy trusted in-page execution tier as the automatic compatibility fallback.

For compute-only profiles, investigate a terminable Worker launched from an opaque, CSP-constrained bootstrap. Prove its behavior under both `file://` and HTTPS before adopting it. A Worker alone is not a network/security sandbox. DOM-dependent guests may need an isolated UI frame; this remains reviewed-code execution and **cannot honestly promise protection from a tight loop freezing the UI**. Splitting arbitrary unchanged modules into a Worker and UI frame is not automatic. No `allow-same-origin` escape hatch.

## 4. Packages, dependencies and the world ZIP

### 4.1 Preserve the original; add a native wrapper

Suggested layout—not an accepted current manifest:

```text
packages/ais-foundry-v13/
  manifest.json
  runtime/bootstrap.js
  profiles/...
  notices/...
packages/foundry-tagger/
  manifest.json                  ArenaStar wrapper
  upstream/module.json           original metadata, not overwritten
  upstream/scripts/...           original code / other original files
  upstream/LICENSE
  prepared/entry.js              optional reproducible normalized bundle
  compatibility.json             profile, exclusions, recipe and provenance
```

Illustrative **proposed AIS 2** wrapper fields:

```json
{
  "id": "foundry-tagger",
  "name": "Tagger — Foundry compatibility guest",
  "version": "0.1.0",
  "type": "module",
  "interconnect": {
    "api": "arena.ais/2",
    "runtime": {
      "provider": "ais-foundry-v13",
      "contract": 1,
      "profile": "tagger-1-5-4-scene-api-v1",
      "upstreamManifest": "upstream/module.json"
    },
    "requires": [{ "id": "ais-foundry-v13", "version": "0.1.0" }],
    "capabilities": ["documents.read.visible", "document.flags.own.write", "action.observe"]
  }
}
```

`runtime` and the new capability names above are proposals. The native wrapper's version is separate from the raw upstream version. The real schema must be closed and versioned, with explicit native-entry versus adapter-runtime variants; existing AIS 1 packages remain supported unchanged.

### 4.2 Dependency resolution is more than `active: true`

For every required dependency, select exactly one documented mode:

1. **Original code**, inside an explicitly approved execution closure/island.
2. **Adapter-provided substitute**, advertising a tested API subset and semantic contract.
3. **Native-backed service**, with a compatible async boundary or a hydrated synchronous facade.
4. **Unsupported**—block activation or disable a declared optional feature visibly.

Do not create a dummy `game.modules` entry just to satisfy a dependency check. Honor required/recommended/conflicting packages and supported Foundry/system versions. Resolve ranges during preparation using the appropriate upstream version rules; runtime remains pinned to exact artifacts, not floating manifests or CDN URLs.

The execution approval fingerprint must cover adapter, guest, dependencies/substitutes, system profile, recipe, compiler/preparation version, prepared executable bytes and requested island rights. Package content hashes remain necessary but a guest hash alone is insufficient when the adapter can change its behavior. Approval is local and is never exported.

### 4.3 Required storage/loader changes

- Add **binary-safe package resources**, with per-file path, MIME, byte length and digest; reuse the asset store/OPFS facilities where appropriate. Preserve original bytes, notices and aliases. Native AIS 1 text hashing must keep its existing meaning.
- Introduce an explicit byte-hash scheme for the new package/profile format. Do not quietly reinterpret an existing approved text hash.
- Version the archive semantics: recommended **world ZIP format 5** with explicit AIS/runtime/binary-package feature markers. Exact names require schema review. Readers of formats 1–4 continue working; an older reader must refuse unsupported execution rather than ignore its authority metadata.
- Preserve normal ZIP bomb/path traversal/duplicate-file protection; add file-count, per-kind size and resource-budget checks. Never execute package entry points or migrations merely to inspect a ZIP.
- Build a **virtual file system**, not an HTTP server requirement: own package paths and approved dependency resources resolve from world contents. Remote URLs, filesystem paths and unapproved imports are denied. Historical manifest leading-slash paths need explicit normalization rules, not arbitrary access to the host root.
- Support ordered classic scripts and a prepared ES-module graph. `srcdoc` plus relative imports does not automatically provide `/modules/<id>/...`. A service worker is not a universal solution for `file://`.
- First pilot: use a trusted, reproducible offline preparation tool to bundle supported static imports and record rewrites. No Node/toolchain should be required to **play** the resulting world. Browser-side preparation can follow once its code size and isolation are measured.
- Dynamic imports, `import.meta.url`, local `fetch`, CSS URLs and template loading need individually tested policies. Initially admit only declared local targets; reject computed/remote loading unless a profile genuinely handles it. Do not enable unrestricted `eval`/`Function` merely because a bundled dependency expects it.
- Bulk code/assets/snapshots need separately bounded transfer, not a global increase of the 64 KiB RPC ceiling. Revoke all object URLs and resource handles when an island stops.

Compendium content is a separate problem: Foundry v11 moved packs to LevelDB directories, including binary files. Preserve raw packs inertly; use an audited converter/export route into ArenaStar's native content format before exposing them through a compendium facade. Storing a binary pack does not make it queryable in a browser. [1](https://foundryvtt.com/article/v11-leveldb-packs/)

## 5. Synchronous views, settings and supported mutations

### 5.1 A projected local mirror, not a remote object proxy

Before guest `init`/`setup`/`ready`, prepare the appropriate metadata, settings and document views at a known sequence. Hydration timing follows the chosen Foundry lifecycle profile—do not fire `ready` merely because the SDK loaded.

Implement only tested parts of `Collection`, Actor/Item/Token/Scene facades, flags, UUID resolution and ownership checks:

- `game.scenes.get`, `getFlag`, `game.settings.get`, iteration and supported `fromUuidSync` reads stay synchronous.
- Maintain stable facade identity, embedded parent/child references and document-versus-placeable distinctions where the profile requires them. JSON field renaming alone does not satisfy `instanceof`, getters or `.document`/`.actor` relationships.
- Hydrate only the view allowed by both the island's grants and the effective user. GM-private data is never sent to a player realm. Expanding beyond today's visible-scene slice needs explicit additional scopes.
- A declared complete collection must actually be complete within that authorized scope. Do not return an empty collection for “not loaded yet,” and do not pretend active-scene-only Tagger search is full `allScenes` support.
- Carry revisions and ordered projected deltas, including deletes, visibility loss and ownership changes. On a gap, stop commands and rehydrate. `await update()` should leave the local facade at least at that acknowledged revision.
- UUID aliases need canonical host `DocRef` mapping, including embedded documents; guessed/unauthorized references are never resolved by the guest's assertion alone.
- Direct local changes are not persistence. Permit `updateSource` only on explicitly supported draft/local-model contexts; reject unsupported live-model mutation semantics.

`game.user` must have a stable meaning per realm. Never temporarily mutate one GM-global facade into “the current player” across overlapping asynchronous callbacks. GM automation and player UI runtimes are separate, and delegation carries an immutable host-side original-caller context.

### 5.2 Settings and UI

Add schema-checked setting registration, synchronous hydrated reads, acknowledged writes and scoped change notifications. Preserve **world / user / client** distinctions; current module-local storage is not a substitute for every scope. World settings use host authority and world persistence; client settings belong to that client, not the GM browser on its behalf. Local approvals remain separate from all settings and from exported data.

Use native forms/actions for the initial profile. Treat custom settings menus, `Dialog`/`DialogV2`, Handlebars templates, jQuery and `ApplicationV2` subclasses as distinct compatibility features. Templates or CSS must never be inserted into the unrestricted parent DOM. Unsupported fields/menu classes produce a diagnostic, not a fake successful registration.

### 5.3 Write translation: narrow intents, not `submit(Op[])`

A guest may call `token.update`, but that does not create a generic host write capability. The adapter converts **supported fields** into domain requests and the host independently validates them.

Examples:

| Guest request | Native operation / validation |
| --- | --- |
| `setFlag("tagger", "tags", ...)` | Namespaced tag intent; authorized targets, tag limits, rule semantics and atomic bulk updates through the native tag service |
| Torch-owned state flags | An approved guest namespace, with schema/size limits; no writing another package's state |
| Token light changes | Native light intent; grid-distance/unit conversion, light/animation bounds, provider policy and current token permission |
| `Item.update({"system.quantity": n})` in a supported Torch flow | Narrow inventory operation, linked actor/item validation and revision/precondition checks; no unrestricted `system.*` patch |
| `Roll` / system action / damage result | Host/system roll or action service; imported totals are not mechanical evidence |
| FX call | Authorized native FX request, projected recipients and approved asset handles; no raw PIXI handle |

Unsupported paths or options fail the **whole requested operation**. Do not silently discard fields and report success. Preserve meaningful deletion keys, embedded-document rules and return behavior only where a profile explicitly implements them.

## 6. The broader AIS workflow kernel this requires

### 6.1 Add an actual staged executor

Proposed native lifecycle:

```text
request → authenticate → snapshot/read-set → prepare/validate contributions
        → optional explicit prompt/suspension → re-read/revalidate
        → deterministic proposal reduction → atomic host commit + durable receipt
        → projected post-commit hooks → chat/FX/UI presentation
```

Each registered stage needs a versioned input/result schema, allowed contribution modes, ordering/conflict policy, scope, budget and failure policy. A runtime-provider package cannot grant itself a host hook or veto right simply by naming a Foundry function.

Reuse AIS's existing `observe` / `augment` / `transform` / `exclusive` / `register` declarations, but now execute the resolved plan. Translate compatible local hook registration order into a fixed island order; across islands use explicit AIS ordering. No arbitrary “last module wins” for exclusive light/action resolvers.

### 6.2 Pre-hooks must be real pre-commit stages

1. Core authenticates the request and constructs a projected draft with a read-set/version baseline.
2. The adapter invokes supported legacy pre-hooks **synchronously inside its realm**, using the appropriate originating-client semantics.
3. It returns a bounded draft delta or veto. It does not mutate host state during preparation.
4. Core checks the delta against the stage's allowed output, current permissions and system invariants.
5. Immediately before commit, check the read-set again, including collection/query revisions where a result depends on absence or counting (for example Tagger's next-number allocation). Conflicts produce a visible refusal or a contract-approved bounded restart of a pure stage—not blind replay of arbitrary guest code.
6. Commit once, reconcile the mirror, then emit post-hooks. Post-hooks cannot veto that commit.

`HostSync.handleIntent` needs an asynchronous **admission/staging** layer with a short final synchronous commit section. Do not hold a global document lock while awaiting plugin code or a human; keep save/disable/exit controls independent. Reject reentrant writes during prepare rather than deadlocking the same transaction queue.

Hook coverage must include **native ArenaStar entry points** for the supported operation types, not only writes originating in the adapter. For example, a declared token pre-update integration must be tested against native token edits and movement. Mark other document/action families unsupported until their intake paths have been integrated.

Arbitrate built-in automation too. ArenaStar already has tag-rule operations; select or explicitly
compose the native rule allocator and the upstream Tagger pre-create handler rather than expanding
the same rule twice. The equivalent light-provider conflict must be resolved between native Torch
and guest Torch. Reading/writing a shared semantic tag service is not permission to run duplicate
rule transformations.

### 6.3 Do not promise atomicity that an unchanged module never requested

Foundry code can make several sequential awaited writes. Torch's flag, light and inventory calls are a concrete example.

Two explicit execution contracts are needed:

- **Native staged workflow:** modules return proposals, then one atomic commit applies the accepted mechanics. No real writes during prepare; staged values are explicitly staged.
- **Compatibility imperative command:** each supported `await document.update()` commits and returns an acknowledgement. Later failure can leave earlier commits in place. Record step receipts and show partial completion; never imply a rollback or blindly rerun the whole command.

A reviewed recipe can turn a known compound interaction into one native atomic intent, but that is **recipe-assisted adaptation**, with documented semantic differences. Silently resolving `update()` before commit to batch everything at the end would be false compatibility.

### 6.4 Identity, side effects and durable recovery

Use host-issued invocation IDs and per-step idempotency keys, tied to the composition hash, user, world and stage. Same key/different payload is rejected. Repeated transport delivery returns the known receipt rather than spending inventory twice. Persist receipts where recovery across reload matters; per-port request-ID deduplication alone is insufficient.

Track causation/depth to stop `update → hook → update` feedback loops; bound service fan-out, proposals, stage calls and event queues. Denied, stale, cancelled, timed-out and partially committed outcomes must be distinguishable. Host-authored action provenance remains governed by [ACTION_SYSTEM.md](ACTION_SYSTEM.md); a module's returned result never upgrades it to verified rules evidence.

### 6.5 Prompts are not a longer eight-second command

Keep compute budgets separate from a human response deadline. Native workflows suspend at serializable boundaries, then reauthorize and revalidate when resumed.

An arbitrary imported JavaScript closure/Promise **cannot be serialized into a durable continuation**. A compatibility dialog may keep a reviewed realm alive in memory; on world reload, realm loss or revocation, cancel that command and preserve its known receipts. Do not auto-resume or replay it as if it were a native durable workflow. This extends the current command-scoped `ui.select` restriction through an explicit new protocol, not by weakening its timeout.

## 7. Dependencies, multiplayer and difficult API families

### 7.1 `libWrapper`

Support wrapping selected **facade methods** only when their synchronous/async return, `this`, argument and error contracts match the selected profile. Preserve the distinction between `LISTENER`, `WRAPPER`, `MIXED` and `OVERRIDE`, or reject the unsupported mode/target. The library's own documentation describes these different signatures and chain behavior. [3](https://github.com/ruipin/fvtt-lib-wrapper)

A renderer target such as Sequencer's PIXI upload wrapper is a blocker, not a candidate for an empty stub. Installing libWrapper by itself does not provide the missing renderer.

### 7.2 `socketlib` and `game.socket`

The upstream API can execute a registered function on a selected GM and return its result. [1](https://github.com/farling42/foundryvtt-socketlib)

Translate only declared named services with validated JSON inputs/results and explicit recipient policies. A player request retains that authenticated player as the original caller. A separately approved GM automation policy may authorize a specific action; a guest-provided `isGM`, target user ID, function name or socket payload cannot create that authority.

The first pilot is **GM-local**. Player-initiated compatibility requires host/client feature negotiation, consented client code, hash-verified bounded delivery, per-user projections, disconnect handling, and duplicate-execution prevention. Do not emulate every connected user by executing the same mechanics repeatedly on the GM.

### 7.3 UI and renderer access

Offer, in order:

1. Native schema-driven actions/forms/settings.
2. Tested isolated compatibility panels with their own DOM/CSS and package assets.
3. Curated UI recipes for a specific module's HUD/dialog behavior.

Arbitrary Foundry sheet surgery, private canvas internals, shader subclasses and global CSS are outside the initial guarantee. Matching the name `PIXI` or using Pixi in both products does not supply Foundry's object graph, layers, visibility semantics or lifecycle.

### 7.4 Systems and mechanics

A narrow PF1 light/inventory profile can expose the properties Torch needs. It does not certify arbitrary modules that call Foundry PF1 actor methods, preparation logic or combat automation. Do not change `game.system.id` and call that system support.

Later expose native actions such as checks, targeting, damage/effects and summons through AIS's staged contracts, reusing validated host logic. Extract shared host services from the macro path where necessary; **do not grant the adapter the entire reviewed-GM script interface**. Full Foundry system execution is a separate project and not proposed here.

### 7.5 Reuse the existing native FX system early

The backend is already substantial: `src/core/fx.ts` defines and resolves `FxSequence`;
`src/ui/macros/FxSequencePanel.svelte` is the authoring wizard; `src/client/fxPlayer.ts`,
`src/canvas/layers/FxLayer.ts` and the audio modules perform playback. Existing behavior includes
visual/text/audio sections, signed timing overlaps, parallel lanes, source/target anchoring and
following, stretching, transforms/filters, persistent runs, cancellation, viewer filtering and
host-clock scheduling. Reviewed scripts also have `api.fx.sequence()`, `play`, `list` and stop APIs.
These are existing implementations to reuse, not work to commission again.

What is still missing for foreign modules is the **API boundary**, not that whole backend:

1. Expose appropriately authorized native FX services to AIS (the current AIS RPC list has no FX family).
2. Translate a declared subset of Foundry `Sequence` builder / manager calls into native sequence data
   and projected run handles, preserving supported return/timing semantics.
3. Resolve module asset paths or library keys to locally imported, approved asset handles.
4. Reuse current validation, scheduling, audience/asset checks and playback. Our current reviewed-script
   `fx.play` accepts a saved macro ID; dynamic guest-built sequences need a separately validated transient
   submission path to the same backend, not hidden macro creation or direct renderer access.
5. Test chain completion, persistent list/stop behavior and unsupported-method diagnostics. Long playback
   waits must fit the explicit AIS job/workflow lifetime, not inherit an unrelated short script timeout.

Do not claim all Sequencer options are covered: the current native model itself has documented bounds,
including restrictions on persistent timelines and on source/target anchors. Extend individual native
primitives only when a real required call lacks an equivalent. Keep the original Sequencer renderer
out of the initial plan; its familiar public API can be the useful compatibility surface instead.

## 8. Licensing and provenance gate

Foundry's published EULA restricts distribution of its software and has a limited package-development license, including conditions on packages referencing/including its code and functioning without the base software. An open repository or a top-level MIT notice is not by itself clearance for every bundled component. [1](https://foundryvtt.com/article/license/)

Observed notices, not legal approvals:

| Source inspected | Notice / issue requiring review |
| --- | --- |
| Tagger | MIT notice in the pinned LICENSE, including attribution requirement |
| Torch | Beer-Ware notice in README and source headers; package metadata points to README |
| socketlib | MIT notice |
| libWrapper | LGPL-3.0 for the main library; a separate license exists for its shim—evaluate the actual selected files |
| Sequencer | MIT text plus additional notices; LICENSE explicitly says Foundry core code was included/refactored, alongside other upstream sources |

Sequencer's [pinned LICENSE](https://github.com/fantasycalendar/FoundryVTT-Sequencer/blob/d8529e70ac91cee705f3dd0803231ca1c147e1e3/LICENSE) makes the provenance issue concrete. This proposal does not decide whether any particular reuse is legally permitted.

Follow [LEGAL.md](LEGAL.md) and [the existing adoption process](tools/adopt/README.md): per-artifact inventory, source pin, legal case/sign-off, notices and conformance fixtures. Independently implement supported public API behavior; do not copy Foundry core, bundled icons/templates/shaders, or license keys into ArenaStar. Do not assume user-supplied commercial modules become redistributable because they are placed in a world ZIP. Provide export warnings/reference-only or omission options where portability rights are absent; a portable complete world is conditional on rights to its contents.

The initial proposal added no upstream implementation code. The subsequent user-requested feasibility slice includes the three byte-pinned Tagger source files and their notices; legal review was explicitly deferred as a separate workstream. This document does not change any legal approval status.

## 9. Implementation plan and acceptance gates

Complexities below are relative, not calendar promises. Implement as bounded changes with native AIS 1 regressions remaining green.

| Phase | Deliverable | Gate before proceeding | Relative size |
| --- | --- | --- | --- |
| **P0 — evidence and feasibility spike** | Rights inventory; exact release ZIP hashes; concrete licensed v13 reference build; API-use/feature matrix; loader/CSP/Worker experiments; upstream behavior fixtures | No prohibited core copying; prove real entry loading under file and HTTPS; record unsupported dynamic loading/eval/UI needs; select exact pilot feature sets | M / research-heavy |
| **P1 — generic runtime/package foundation** | Versioned runtime-provider/wrapper schema; binary-safe resources and VFS; composition locks/consent; inert import/export; reproducible preparation; manager diagnostics | Adapter + guest round-trip in a world ZIP; neither runs on import; changing/revoking any executable dependency stops the island; old archives/native modules still work | L |
| **P2 — mirrors + first real guest slice** | v13 facade for collections, documents, settings/lifecycle and acknowledged namespaced tag operations; explicit GM-local scope | Original Tagger 1.5.4 entry executes, synchronous queries and selected tag writes match fixtures; no native Tagger substitute secretly answering in its place | L |
| **P2b — native-backed FX dependency facade** | AIS access to shared native FX services; bounded `Sequence`/manager API mapping; local asset aliases and validated dynamic submissions where needed | A real guest call drives the existing FX runtime through AIS, with correct timing, rights, persistence and stop behavior; no second renderer | M–L |
| **P3 — workflow prepare/commit integration** | Typed registration/execution; projected drafts, vetoes, read-set conflict checks, idempotent receipts and native intake hooks | Real Tagger pre-create/update rules run once; supported native edits pass through the same stage; no early writes, duplicate tags, reentrancy deadlock or hidden-data leak | L / architectural |
| **P4 — real Torch + safe interaction** | Narrow PF1 profile; light/inventory/state translation; supported HUD/settings/dialog recipe; imperative step receipts; optional explicit atomic adaptation | Torch 3.3.0 behavior, consumption timing and prototype restoration tested; native/guest light-provider arbitration; settings survive export/reload; partial failure is visible | L |
| **P5 — dependency services and multiplayer** | Curated libWrapper/socketlib substitutes; explicit shared-island policy where needed; player projections, feature negotiation and prompt/reconnect handling | Two real guest packages interoperate through a declared dependency; multiplayer actions commit once; a player cannot obtain GM authority or private data | XL |
| **P6 — broader action/UI coverage** | PF1 action/effect/roll services; further UI profiles; expansion of the early native-backed Sequencer API subset; additional certified module versions | Add modules only with version-specific API and behavior conformance; reject unsupported features explicitly | Open-ended, incremental |

**First useful milestone:** P0–P3, producing one genuinely loaded upstream module and reusable AIS workflow stages. P4 gives a visible end-user proof. Full unchanged Sequencer, entire Foundry systems, arbitrary native-code/server extensions, transparent `eval`, automatic marketplace installation and general renderer emulation are not part of that milestone.

### Preliminary size estimate—not a measured implementation

For an initial **GM-local profile covering Tagger/Torch slices and common native-backed FX calls**, a
rough planning range is:

| New authored code | Approximate lines |
| --- | ---: |
| World-packaged Foundry adapter, facades, narrow profiles and API wrappers | 4,000–8,000 |
| Generic AIS/core runtime, projection, workflow, resource and service additions | 3,000–6,000 |
| New tests and fixtures | 7,000–15,000 |

The common native-backed FX wrapper might account for roughly **500–1,500 lines within the adapter
range**, not an additional FX engine. These are low-confidence, order-of-magnitude estimates, to be
replaced after P0/P2. They exclude existing ArenaStar code, upstream guest code, vendored libraries,
generated bundles and full multiplayer/UI/system compatibility. Tests do not ship in the runtime.

Broad Foundry API compatibility could grow to many tens of thousands of lines; rebuilding its
renderer or system implementations is not an implicit extension of this estimate. LOC is neither a
compatibility score nor a bundle-size estimate. The optional adapter lives in the world ZIP, while
shared AIS/core additions still count against the main-file budget.

### Planned repository changes

| Area | Existing seam / proposed new component |
| --- | --- |
| Contracts and resolution | `src/core/automationInterconnect.ts`, `src/core/packageManifest.ts`; new `aisWorkflow.ts` / runtime-provider and compatibility contract types |
| Resources and portability | `src/packages/packageLoader.ts`, `src/packages/packageHash.ts`, `src/storage/idb.ts`, `src/host/worldFile.ts`, `src/core/capabilities.ts`; generic package resource/VFS layer |
| Runtime/consent | `src/packages/aisModuleIframe.ts`, `src/packages/aisModuleRuntimeSource.ts`, `src/app/aisRuntime.ts`, `src/app/hostBoot.ts`; preserve native AIS 1 path, add adapter-backed runtime instances |
| Host staging and services | `src/host/sync.ts`, `src/core/projection.ts`, `src/core/permissions.ts`, native tags/FX/roll/action code; new scheduler, intent handlers and durable receipt support |
| UI and diagnostics | `src/ui/packages/RulesetSection.svelte`, window/settings components; compatibility status, dependency graph, aggregate rights, trace, safe action/panel slots |
| Adapter payload | Proposed `modules/ais-foundry-v13/` and narrow system/profile packages; Foundry names and recipes live here, not in the core bundle |
| Preparation and tests | Proposed preparation tool and compatibility fixture manifests; new unit/host/browser specs in a dedicated bounded batch |

Do not let `HostSync` become an even larger adapter switchboard: extract reusable authorized services and keep version-specific translations in packages. Measure every phase against the **6 MiB raw main-file cap**. The D-461 build is 5,305,166 bytes, leaving 986,290 bytes below 6 MiB; this is headroom, not a spending target. Bundlers, compatibility libraries and guest payloads should not be baked into `index.html`.

## 10. Definition of “compatible” and verification

Manager statuses should be separate from runtime “ready”:

- **Unassessed / blocked:** imported safely, missing contracts or dependencies, or review pending.
- **Verified unchanged-code subset:** original executable behavior is exercised for named features; preparation/linking does not silently rewrite those semantics.
- **Recipe-assisted:** explicit UI, loading or behavior adaptations; differences are shown.
- **Dependency substituted:** an API-compatible subset is supplied by an adapter/native service, not the original library implementation.
- **Experimental / unsupported:** no production compatibility assertion.

Also record the preparation mode: **artifact-preserving** (the published executable bytes), **source-preserving/rebundled** (original guest source, different linking/build), or **patched** (reviewed source changes). A substituted bundled dependency or rebuilt distribution must not be advertised as an untouched upstream artifact.

Certification is a tuple: **core/AIS build + adapter/profile/hash + upstream artifact/hash + dependency closure + system profile + execution role + tested features/browsers**. A successful import or a `ready` hook is not certification. No “90% compatible” score based only on symbol counts.

Minimum acceptance coverage:

1. Real upstream code provenance: exact artifact/input and prepared-output hashes; show which code actually handled each action.
2. Load/lifecycle under `file://` and HTTPS; ordered scripts, static imports, package-local resources, cold start and reload.
3. Synchronous reads, stable document identity, complete declared views, mirror ordering, deletes and gap recovery.
4. Settings defaults, world/client separation, permission failures and persistence; no imported approvals.
5. Native and guest pre-hooks: ordering, explicit veto, draft edits, exactly-once post-hooks and unsupported async veto detection.
6. Host rejection, concurrent edits, stale read-sets, same-ID/different-payload rejection and deduplicated resource consumption.
7. Partial imperative-command failure versus atomic native workflows; receipts survive the recovery policy actually promised.
8. Revocation/disablement/replacement of adapter, guest or dependency; navigation, frame/worker failure, expired prompts and late replies cannot regain authority.
9. Player/GM projection and original-caller checks; cross-island impersonation and `executeAsGM` escalation are denied.
10. Capability-conflict handling when native `pf1e-torch` and the foreign light provider coexist.
11. Unsupported APIs, dynamic imports, arbitrary remote fetch/eval, prototype/renderer access and unauthorized UUIDs fail explicitly.
12. CPU-hang tests only where the selected runtime promises termination; otherwise a prominent reviewed-UI limitation. Measure boot time, mirror memory, message volume and bundle growth on the two-CPU baseline.

Use public upstream tests where licensed and appropriate, plus behavior traces from an authorized Foundry installation. Trace collection must exclude campaign secrets and proprietary implementation code. Without a licensed reference run, report source-derived expectations as such—not proven parity.

Continue running `test:e2e:ais` and the native module tests; add each new browser spec to exactly one capped batch. The later D-462 feasibility slice adds its own real-browser and host regression coverage, documented in the demo guide; that does not certify the other proposed profiles.

## 11. Alternatives and proposed decision

| Alternative | Why not the default |
| --- | --- |
| Put `game`, `canvas` and Foundry globals in ArenaStar's main page | Weakens isolation, couples the core to unstable/private APIs, creates prototype conflicts and unload problems |
| Keep adapter and guest as ordinary sibling AIS iframes | Cannot provide synchronous shared globals, live class identities or a normal foreign module environment |
| Port every module natively | Safest for some deep integrations, but fails the goal of reusing existing module code; retain this as a fallback |
| Reimplement the entire Foundry client | Effectively a second VTT engine, large cost/version surface, major legal/provenance risks and poor fit for the single-file constraint |
| Require a running licensed Foundry server | A different integration product with network/offline/deployment requirements; not the requested self-contained world-ZIP adapter |
| Pretend missing methods succeeded | Produces wrong inventory, rules and state while appearing to work; unacceptable |

**Proposed decision:** pursue the bounded runtime-provider design and fund P0–P3 first. Keep Foundry compatibility as an optional, versioned world package; keep host authority and generic workflow machinery in AIS. Add Torch as the next visible proof, not as a shortcut around the kernel. Defer renderer/system-wide compatibility until actual supported modules justify it.

Stop or change approach if the pilots require copying restricted core code, arbitrary host access, a mandatory server for file-origin play, or rebuilding substantial Foundry internals before one small supported feature works. A successful thin vertical slice should make later native AIS workflows better even if a particular foreign module is rejected.

## 12. Research source pins and limits

Official documentation was read on 2026-10-13, using **versioned v13 API pages** for behavioral contracts and the live official articles for packaging/licensing. Unversioned guides contain older examples; they are not evidence that an old version is current.

GitHub source snapshots inspected (full hashes make the audit reproducible):

| Repository / purpose | Source commit | Files inspected / notes |
| --- | --- | --- |
| `League-of-Foundry-Developers/torch` — release 3.3.0 | `f1ee45a8148ad6e7029043ad2fe829472720144c` | `module.json`, README/license, package metadata, `src/{torch,token,hud,api,settings,library,topology,socket,request,sources}.mjs`; commit also resolves from release tag `v3.3.0` |
| `fantasycalendar/FoundryVTT-Tagger` — selected v13 pilot 1.5.4 | `e7936bc9ee01e4445624fbc82a11e887e5cd0075` | `module.json`, LICENSE, `docs/api.md`, `scripts/module.js`, `scripts/hotkeys.js`; source manifest has a build-time version placeholder, so pin the actual release artifact too |
| `fantasycalendar/FoundryVTT-Tagger` — current-source comparison | `6adacd842c74a6a8eee33403c67a3d58342d4edd` | LICENSE, manifest/README and `src/{module,tagger,tagger-handler,config-ui,sidebar-tab}.js`; branch snapshot, not the 1.6.0 release commit (`b15870d91a8f8e2c65ad419856120785412a292e`) |
| `fantasycalendar/FoundryVTT-Sequencer` — release 4.3.0 | `d8529e70ac91cee705f3dd0803231ca1c147e1e3` | LICENSE, manifest/package/README, `src/{module,libwrapper,sockets,layers}.js`, `src/canvas-effects/canvas-effect.js`; commit also resolves from release tag `4.3.0` |
| `ruipin/fvtt-lib-wrapper` — API/license survey | `ad83e8b339bb38d4feea21c3a2896804454178a2` | README, manifest, package metadata, LICENSE and shim LICENSE; branch snapshot, not release `v1.13.5.1`'s commit (`c0521af50e7a6239c2cf4bbd6fb224c2d675e2e6`) |
| `farling42/foundryvtt-socketlib` — service API survey | `3cae17890800852478c973b14b612bef2b16df3e` | README, LICENSE, manifest, `src/socketlib.js`; development snapshot, not release `v1.1.4`'s commit (`310798e6e1230484f94c100e1d58e88895591938`) |

**Not established by this research:** executable compatibility of any upstream release, full license clearance, differential results against a running Foundry instance, cross-browser containment, or a reliable calendar estimate. Those are explicit P0/implementation gates, not hidden assumptions.
Not established by this research:** executable compatibility of any upstream release, full license clearance, differential results against a running Foundry instance, cross-browser containment, or a reliable calendar estimate. Those are explicit P0/implementation gates, not hidden assumptions.
