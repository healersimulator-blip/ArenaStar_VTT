# Proposal — one file to load: world.zip carries its ruleset and content

Status: **all phases implemented — Phase 0/1 in D-248, Phases 2–5 in D-249 (2026-09-19)**.
Addresses tester feedback that loading zips for "world, ruleset and modes/modules" is
confusing.

> **Implemented (D-249, Phases 2–5):** start screen with the device's world list
> (Open / Export / Delete), one sniffing **Open file (.zip)** with *Open as new world*
> (copy) vs *Restore* (replace) and a **New world with it…** jump for packages, the
> **New world…** wizard (`src/app/worldRecipe.ts` + `src/ui/start/NewWorldWizard.svelte`:
> Name → Strategic ruleset → Content packs → Create; the world boots on the ruleset with no
> activate/reload), **Settings → Strategic ruleset & content** replacing the Extras section
> (status line, pinned message, add content pack, fresh-campaign Activate, D-089 trust),
> **Close world…** in the sidebar instead of a second importer, `importWorldZip({ mode:
> "copy", name })`, full `deleteWorldData` + `deleteWorldFiles`, and starter worlds from the
> build (`pnpm build:worlds` → `dist/worlds/pf1e-mass-battles-starter-1.0.0.zip`, format 2
> with `starter: true`, no documents, ruleset + `pf1e-core` pre-installed; always opens as a
> fresh copy). Deviations from the text below are listed in D-249: starters ship *without*
> seed documents (the host seeds on first boot exactly as for a new world), the starter writer
> is plain JS proved by parity tests rather than a shared TS writer, and in-world **Activate**
> stays available for fresh campaigns (the wizard is the primary path, not the only one).

> **Implemented (D-248):** `src/host/zipKind.ts` (sniffing), world file **format 2**
> (`packages.json` + `packages/<id>/…` + `rules.active`; format 1 still imports; trust
> never exported), honest `WorldsRecord.system`, advisory manifest `dependencies`,
> reload prompt + missing-companion warnings in Extras, sniffing importers in the role
> picker and the GM sidebar, rules status + boot-error banner. **Strategic-mode
> guarantee:** the ruleset applies to strategic-scale scenes only, so one world keeps
> mixing heroes-only (tactical) and heroes-plus-units (strategic) scenes — proved by the
> mixed-scene round trip in `tests/host/worldFilePackages.test.ts` and, in a real
> browser, by `e2e/worldfile.spec.ts` "D-248" (sidebar import → activate → export →
> fresh browser context → picker import → boots on the package; Chromium 148/148 via
> the D-222 recipe). Side find: the picker's *Host a world* / *Import world file*
> routes mounted a dead shell (pre-existing; fixed in `Root.svelte`, see D-248).
> Not done: everything from Phase 2 on.

> Terminology used below, mapped onto what actually exists in the repo today:
>
> | Tester word | Artifact in this project | Where it lives |
> |---|---|---|
> | **world** | `world-<name>.zip` (§8 world file, format 1) | `src/host/worldFile.ts` → IDB `worlds/documents/assets/checkpoints/turnReports` |
> | **ruleset** | `type: "system"` package zip, e.g. `pf1e-mass-battles-1.0.0.zip` (`rules.js` → SimWorker) | `src/packages/packageLoader.ts` → IDB `packages [worldId,id]`, pinned via `WorldsRecord.activeRulesPackage` |
> | **modes / modules** | `type: "data"` package zip, e.g. `pf1e-core-1.0.0.zip` (compendium packs), plus the optional `module.entry` *block* of a system package (sandboxed iframe / in-page script). There is no standalone "module zip" today. | same store; `HostPackages.compendia()`, `moduleBoot` |
>
> Assumption: "modes" = "modules" (typo). Game *modes* proper (stepwise/realtime,
> `strategicSimultaneous`, …) are world-settings documents and already travel inside the world file.

---

## 1. TL;DR

**Recommendation: Option B — make `world.zip` self-contained (ruleset + content packages
embedded, activation recorded) — combined with a single sniffing "Open file" entry point and a
"New world" wizard that consumes ruleset/content zips as *ingredients* at creation time.**

Why B fits this architecture and A does not:

- Packages are **already world-scoped** in IndexedDB (`packages` keyed `[worldId, id]`) and the
  active ruleset is **already pinned per campaign** (activation is refused once a checkpoint
  exists — §5A determinism). The storage model already says "a ruleset belongs to a world"; only
  the *file format* and the *UI* pretend otherwise.
- The world file already has restore semantics and already carries `checkpoints/` + `reports/`,
  whose bytes are only meaningful under the exact `rules.js` + `modelColumns` that produced them.
  Today that dependency is silently dropped on export (verified, see Appendix A).
- The product is one self-contained `index.html`, no server, no registry. Option A's natural
  end-state (a browser-local "library" of installed systems and modules that worlds reference) has
  nowhere to live except one browser profile — which is exactly what testers are struggling with.
- The artifacts are tiny: `pf1e-core` 25.6 kB, `pf1e-mass-battles` 65.9 kB compressed (measured
  via `pnpm build:systems`). Embedding them costs nothing.

Option A's *clarity* is kept where it matters — the New-world wizard shows "Ruleset" and
"Content" as visibly separate steps — but they are consumed into the world, never managed as
parallel top-level artifacts a tester has to sequence by hand.

The end state for a tester: **Import `pf1e-mass-battles-starter-1.0.0.zip` → play.** One file.

---

## 2. What a tester goes through today (traced through the code)

To play PF1e mass battles from a fresh browser profile:

| # | Step | Code | Friction |
|---|---|---|---|
| 1 | Picker → **Host a world** | `Root.svelte` → `bootHostApp()` | Silently creates "World One" on built-in `mass-battle-basic`. |
| 2 | Sidebar → **Extras** → scroll past Campaign / View / Factions / Mass spawn / Casualty / Batch orders → **System package (§12)** → unlabeled `<input type=file accept=".zip">` | `GmExtrasPanel.svelte:486-544` | Package import is buried in a strategic-controls window. |
| 3 | Pick `pf1e-core-1.0.0.zip` | `HostPackages.importZip` | Row appears, type `data`, **no Activate button** — no explanation why. |
| 4 | Pick `pf1e-mass-battles-1.0.0.zip` | same | Row appears with **Activate**. `dependencies: ["pf1e-core"]` in its manifest is ignored by the validator (D-110) — nothing tells the GM the order or the relationship. |
| 5 | Click **Activate** | `packages.activate` → `persister.patchWorld({activeRulesPackage})` | Only a hint: "Activation applies when the world reloads; fresh campaigns only." |
| 6 | Press F5 | `hostBoot.ts` reads `activeRulesPackage` → `runner.loadRules` | Nothing in the UI reloads for you. |
| 7 | If any turn was advanced before step 5 | `guardFreshCampaign()` | "campaign already started — packages apply to fresh worlds only". **There is no "New world" button anywhere** (`Host a world` always reopens the most recent world; `createWorld` is only called when the DB is empty). The advice is unactionable without wiping browser storage or importing a world zip. |
| 8 | Wrong slot | picker/sidebar "Import world (.zip)" vs Extras `#pkg-file` — all accept `.zip` | Package zip in world importer → `world file: missing world.json`. World zip in package importer → `package: manifest.json not found at the package root`. The *button* decides the type, not the *file*. |
| 9 | **Export world** → send to another GM → they **Import world** | `exportWorldZip` / `importWorldZip` | Archive contains only `world.json, documents.json, assets.json` (+checkpoints/reports). Packages, `activeRulesPackage`, trust grants are **not** exported. The other GM's world boots `rulesBoot: {source:"builtin", error:null}` — PF1e is gone, with no warning. Any exported checkpoints were encoded with the 16-column PF1e schema and would be decoded against `MASS_BATTLE_SCHEMA_COLUMNS`. |

Smaller inconsistencies that add to the "what am I running?" confusion:

- `WorldsRecord.system` is never updated on activation (`activate()` patches `version` but not
  `system`), so after activating PF1e the record reads `system: "mass-battle-basic", version: "2.0.0"`
  and the join `welcome.world.system` tells players `mass-battle-basic` while `welcome.sim.packageId`
  says `pf1e-mass-battles`.
- `deleteWorldData` removes `worlds/documents/oplog/fog` but leaves `packages`, `assets`,
  `checkpoints`, `turnReports` rows orphaned.
- PF1e's *tactical* rules (sheets, combat tracker, AoO, casting) are compiled into `index.html`
  (`App.svelte` imports `src/packages/pf1e/*`), while only its *strategic* rules ride the zip.
  So "is PF1e loaded?" has two different answers depending on which half you ask.

---

## 3. Root causes (architectural, not cosmetic)

1. **Three artifacts, one extension, two importers, zero sniffing.** `worldFile.ts` and
   `packageLoader.ts` each know how to recognise their own zip (marker file `world.json` vs
   `manifest.json`) but nothing routes a file to the right one.
2. **The world and its ruleset have separate lifecycles in the file format but not in storage.**
   IDB scopes packages *to* a world; the §8 archive omits them. A world zip therefore breaks the
   §8 "restore" promise for every world that isn't on the built-in ruleset.
3. **Activation is a deferred, reload-applied, checkpoint-gated state transition exposed as a
   button.** Its three constraints (system-only, fresh campaign, reload) are discovered by failing.
4. **No world lifecycle UI** (list / new / delete / import-as-copy), so "fresh world" is not a thing
   a tester can do.
5. **`data` vs `system` and `dependencies` are invisible contracts.** The UI shows a type string;
   it never says "this is content, it cannot be activated, it is used by X".

---

## 4. Option A — clean separation (Load World / Load Ruleset / Load Modules)

**What it would take to be coherent, not just three buttons:**

- Packages must become **global** (browser-level library) or the buttons are lies: you cannot
  "Load Ruleset" before a world exists because the store key is `[worldId, id]`. That means IDB v5
  (`packages` keyed `[id, version]`), `WorldsRecord.activeRulesPackage → {id, version}`, a
  "world requires ruleset X vY — not installed" resolution step on every open/import, and a
  migration for existing v4 rows.
- A new manifest kind for "modules" — today the iframe module is a *block inside a system
  package*, and `pf1e-core` is *content*, not a module. "Load Modules" would be a button for an
  artifact that does not exist yet.
- Every one of those buttons still needs kind-sniffing to reject the wrong file, i.e. the same
  `classifyZip` work Option B needs anyway.

**What it fixes:** discoverability (top-level buttons), the wrong-slot error (if each input
validates its kind).

**What it leaves unsolved:** still three files to shuttle; activation + reload + fresh-campaign
dance unchanged; world sharing still loses the ruleset unless the world file is *also* extended
(at which point you are doing B); no "new world"; the ordering problem moves from "which button
first" to "which library entry is compatible with this world". It is a Foundry-shaped install
model layered on a product whose whole pitch is "no install, one file".

**Verdict:** more code, more storage migration, and the tester still holds three zips.

## 5. Option B — bake everything into the world zip

**What it fixes:** the world file becomes genuinely self-contained (packages + activation travel
with it — closes the bug in Appendix A); sharing = one file; determinism story is complete (the
exact `rules.js` that produced the checkpoints is in the archive with them); the storage model
needs **no** key change (packages are already `[worldId, id]`); export size +~92 kB for PF1e.

**What it does not fix by itself:** how a GM *creates* a new PF1e world. The loose package zips
remain build artifacts that have to enter somewhere. Done naively, B leaves the Extras-panel
flow in place for creation and only fixes sharing.

**Therefore B needs two companions:**

1. A **New-world wizard** where ruleset/content are chosen *before* the world boots — activation
   becomes atomic (written into the world record at creation), so no reload, no fresh-campaign
   gate, no ordering.
2. **Starter world zips** emitted by the build (`dist/worlds/pf1e-mass-battles-starter-1.0.0.zip`:
   blank world + both packages + `rules.active = pf1e-mass-battles`) so the common path is a
   single import.

**Verdict:** matches the existing storage scoping, the §8 restore semantics, the §5A pinning
rule, and the one-file product identity. Chosen.

---

## 6. Target UX

### Start screen (`Root.svelte`)

```
ARENASTAR VTT
┌───────────────────────────────────────────────┐
│ Your worlds                                   │
│  • Siege of Absalom   PF1e Mass Battles 1.0.0 │  [Open] [Export] [⋯ Delete]
│  • World One          Mass Battle Basic       │  [Open] [Export] [⋯ Delete]
│                                               │
│ [ New world… ]   [ Open file (.zip)… ]         │
│ [ Join a game ]                               │
└───────────────────────────────────────────────┘
```

- **Open file (.zip)…** is the *only* file input on this screen. It sniffs the archive:
  - world file → "Import *Siege of Absalom*? This archive includes ruleset PF1e Mass Battles 1.0.0
    and 1 content pack." → if `worldId` already exists: **Replace (restore)** / **Import as copy**.
  - ruleset or content package → "This is a ruleset package, not a world. Start **New world…**
    to use it (or add it to an open world under Settings → Ruleset & content)." with a one-click
    jump into the wizard, file pre-attached.
- **New world…** → wizard: **Name** → **Ruleset** (radio: *Mass Battle Basic (built-in)* | *From
  package…* with a file input that accepts only `type:"system"`; shows name/version/model columns)
  → **Content & modules** (multi-add, accepts `type:"data"`; shows pack counts; flags declared
  `dependencies` of the chosen ruleset that are missing) → **Create**. The world boots with the
  ruleset active on first load.

### Inside a hosted world

- Sidebar "World file (§8)": **Export world (.zip)** (now self-contained) · **Save to folder…** ·
  the duplicate "Import world (.zip)" goes away (import is a start-screen action; it reboots anyway).
- Extras → "System package (§12)" section is replaced by **Settings → Ruleset & content**:
  - Read-mostly status: `Ruleset: PF1e Mass Battles 1.0.0 (package) · Content: PF1e Core 1.0.0 (5 packs)`.
  - **Add content pack (.zip)** — data packages stay addable mid-campaign (they never touch the sim).
  - **Change ruleset…** — only offered while the campaign is fresh; performs activate + immediate
    reload behind one confirm. Once a checkpoint exists it reads "pinned since turn N — start a
    new world to change rules", with a **New world with this ruleset** shortcut.
  - Trust grant/revoke UI for `module.trusted` stays exactly as D-089 built it.

---

## 7. World file format 2

```
world.json         { format: 2, worldId, name, system, version, seq, exportedAt,
                     rules: { active: "pf1e-mass-battles" | null } }
documents.json     (unchanged)
assets.json        (unchanged)
assets/<hash>      (unchanged)
checkpoints/…      (unchanged)
reports/…          (unchanged)
packages.json      [{ id, name, version, type, importedAt, packCount }]   ← index
packages/<id>/manifest.json
packages/<id>/<every PackageRecord.files entry, verbatim>
```

Rules:

- Export always writes format 2. Import accepts 1 and 2 (format 1 = no `packages/`, no
  `rules`; behaves as today).
- On import the embedded folders are **re-validated through `buildPackageFromFiles`** — the
  archive's `packages.json` is an index, not a source of truth. A package that fails validation
  aborts the import with the loader's own message (same contract as importing it as a zip).
- `WorldsRecord.system` is written as `rules.active ?? "mass-battle-basic"` and `version` as that
  package's manifest version (fixes the honesty bug in §2).
- **Trust never travels.** `trustedPackages` is not exported and is ignored if present. An
  imported world whose ruleset requests in-page execution runs it in the sandboxed iframe until
  *this* GM grants trust — that is D-089's consent model and it must not be bypassable by a zip
  someone sends you.
- `importWorldZip({ mode: "restore" | "copy" })`: `copy` mints a fresh `worldId` and rewrites it
  across documents / assets / checkpoints / reports / packages rows (documents do not embed the
  worldId; content-addressed assets are shared safely; `roomId` follows the new id).
- Text-only package files keep the current `PackageRecord.files: Record<string,string>` shape.
  When binary package assets arrive (§7-style), they slot in as `packages/<id>/assets/<hash>`
  without a format bump — leave a note, don't build it now.

Wire protocol (`PROTOCOL.md`) is untouched: players never receive packages; the host announces
schema via `welcome.sim` as today.

---

## 8. Implementation plan

Phased so each PR is shippable and e2e-covered. Effort is a rough solo estimate.

### Phase 0 — Stop the bleeding (no format change) · ~1 day

| Change | Files |
|---|---|
| `classifyZip(bytes): "world" \| "package" \| "unknown"` (fflate `unzip`, marker files at root or single nested root, reuse `resolveManifestPath`). Wire into all three inputs; wrong kind → human message naming the right place. | new `src/host/zipKind.ts`; `Root.svelte`, `App.svelte`, `GmExtrasPanel.svelte` |
| `activate()` / `deactivate()` also patch `system` (`id` / `"mass-battle-basic"`); welcome + status become honest. | `hostBoot.ts` |
| After a successful Activate show **Reload now** (calls `location.reload()`) instead of hint text; label rows *Ruleset* / *Content* instead of `system` / `data`; explain why content has no Activate. | `GmExtrasPanel.svelte` |
| Validate `dependencies?: string[]` in the manifest (ids, optional); on Activate warn (not block — D-110: PF1e must stay loadable alone) when a dependency is not imported. | `core/packageManifest.ts`, `hostBoot.ts` |
| Surface `rulesBoot.error` / "world expects ruleset X, not installed" as a visible banner, not just a readback. | `App.svelte` |
| Tests: `classifyZip` unit; manifest `dependencies`; system-field patch; e2e message assertions. | `tests/host/`, `tests/packages/packageLoader.test.ts`, `e2e/packages.spec.ts` |

### Phase 1 — World file format 2 (B core) · ~1.5 days

| Change | Files |
|---|---|
| `WORLD_FILE_FORMAT = 2`; extract a shared `buildWorldArchive(parts)` writer used by `exportWorldZip`, `exportWorldToFolder` and (Phase 4) the build script; add `packages.json` + `packages/<id>/…`; `world.json.rules.active`. | `src/host/worldFile.ts` |
| Import: accept 1 + 2; add `STORES.packages` to the restore transaction (delete-range + put); re-validate via `buildPackageFromFiles`; set `activeRulesPackage`/`system`/`version`; never import trust. | `worldFile.ts`, `storage/idb.ts` (no schema bump needed — store exists since v4) |
| Tests: activate → export → wipe → import → reboot ⇒ `rulesBoot.source === "package"` and identical `files`; format-1 archive still imports; archive with `trustedPackages` ⇒ not trusted; corrupt embedded package ⇒ import refused with loader message; folder export parity. | `tests/host/worldFile.test.ts`, `tests/host/folderExport.test.ts` |
| e2e: extend `worldfile.spec.ts` with a package round-trip through the UI. | `e2e/worldfile.spec.ts` |
| Record as a DECISIONS entry (format bump, trust rule, re-validation rule); update `PLAN.md` §8 line and `README.md`. | docs |

### Phase 2 — World lifecycle + import-as-copy · ~1.5 days

| Change | Files |
|---|---|
| `importWorldZip({ mode })` with `copy` remapping; `deleteWorldData` extended to packages / assets / OPFS dir / checkpoints / reports. | `worldFile.ts`, `storage/idb.ts`, `storage/strategicStore.ts`, `storage/opfs.ts` |
| Start screen: world list (`listWorlds`) with Open / Export / Delete; **Open file (.zip)…** single sniffing input with the Replace-vs-Copy dialog; remove the sidebar duplicate importer. | `Root.svelte` (or new `ui/start/StartScreen.svelte`), `App.svelte` |
| `bootHostApp({ worldId })` stays the only boot entry; "Host a world" becomes "Open" on a listed world. Invite-link fragment path unchanged. | `Root.svelte` |
| Tests: copy import yields new id with equal document count and shared asset hashes; delete leaves no rows in any store; e2e start-screen list + delete + copy. | `tests/host/`, `e2e/app.spec.ts` |

### Phase 3 — New-world wizard (A's clarity at creation time) · ~2 days

| Change | Files |
|---|---|
| `createWorldFromRecipe({ name, ruleset: builtin \| LoadedPackage, content: LoadedPackage[] })`: `HostPersister.createWorld` + `putPackage`s + `activeRulesPackage`/`system`/`version` set **before first boot**. No reload, no fresh-campaign gate. | new `src/app/worldRecipe.ts` |
| Wizard UI (Name → Ruleset → Content & modules → Create) with kind-gated file inputs (`classifyZip` + `manifest.type`), dependency hints, pack counts. Deep-linkable from the "that's a package, not a world" message with the file pre-attached. | new `src/ui/start/NewWorldWizard.svelte` |
| Settings window gains **Ruleset & content** section (status, Add content pack, Change ruleset… with immediate reload, pinned message + "New world with this ruleset"); Extras `data-pkg-section` retired. | `ui/settings/SettingsPanel.svelte`, `GmExtrasPanel.svelte`, `WindowHost.svelte` |
| e2e hook: `createWorldFromRecipe` surface so specs stop doing import → activate → reload. Migrate `packages.spec.ts`, `pf1e_mass_battles.spec.ts`, `gmextras.spec.ts`, `pf1e_join.spec.ts` selectors; keep one spec on the legacy activate path until Phase 5 removes it. | `app/e2eHook.ts`, `e2e/*` |

### Phase 4 — Starter worlds from the build · ~1 day

| Change | Files |
|---|---|
| `scripts/buildStarterWorlds.mjs` (or a stage in `buildSystemPackages.mjs`): for each system package, emit `dist/worlds/<id>-starter-<version>.zip` = format-2 archive with seed docs (GM user, default scene, `world-settings`), the system package, its declared `dependencies` that exist under `systems/`, `rules.active = <id>`. Uses `buildWorldArchive` from Phase 1 so build and app share one writer. | `scripts/`, `package.json` (`build:worlds`, add to `test:e2e`) |
| e2e: import starter through **Open file** → `rulesBoot` is package, compendia present, spawn 100 + advance one turn. | `e2e/pf1e_mass_battles.spec.ts` |
| README quickstart: "Open file → `pf1e-mass-battles-starter-1.0.0.zip` → play." | `README.md` |

### Phase 5 — Cleanup · ~0.5 day

Remove `#pkg-file` and the legacy activate-then-reload e2e path; drop `HostPackages.activate/
deactivate` from the public UI surface (keep the API for `worldRecipe` and tests); update
`PLAN.md`, `ROADMAP.md` ("GM join-approval…" list gains nothing; §8 line reads "self-contained
world.zip incl. packages"), `DEVIATIONS.md` if the spec's §8 layout is quoted anywhere.

Total: roughly 7–8 working days including e2e migration. Phases 0 and 1 alone remove the two
worst tester failures (wrong-slot errors, silently lost ruleset on share) and can ship first.

---

## 9. Risks, mitigations, open questions

| Risk | Mitigation |
|---|---|
| Format-2 archive opened by an older build → `unsupported format 2`. | Explicit error already exists; note in DECISIONS; older builds are pre-release. |
| Importing a world now writes executable text (`rules.js`, `module.js`) from a stranger's zip. | Identical trust boundary to importing a package zip today: worker sandbox for rules (D-086), iframe sandbox for modules, trust never imported (D-089). Re-validate through `buildPackageFromFiles`; keep the 64 KB RPC cap etc. untouched. |
| Ruleset version drift: a world pins v1.0.0, GM later adds v1.1.0 content. | Existing migration chain (D-091) keys off `WorldsRecord.version` vs manifest version — unchanged. `Change ruleset…` stays fresh-campaign only. |
| Duplicate package bytes across many world zips. | ~92 kB for PF1e; content-addressing packages across worlds is not worth a store migration now. |
| Two "PF1e" halves (tactical in-bundle, strategic in package). | Out of scope here; the status line in Settings names the *strategic* ruleset explicitly ("Strategic ruleset: …") so the wording does not over-claim. |
| e2e churn (many specs click `#gm-extras` → `#pkg-file`). | Phase 3 adds the recipe hook first; specs migrate to it; legacy path stays green until Phase 5. |

Open questions for the team:

1. Should **Export** offer "without packages" for GMs sharing a world with someone who already has
   the ruleset? (Default: always embed; the size argument does not exist today.)
2. Should the start screen also list **starter worlds bundled in `index.html`**? D-234 rejected
   inflating the bundle with packs; a starter-world *list* could point at `dist/worlds/` files
   the GM has to pick manually, which keeps the bundle clean. Recommend: no bundling; README +
   picker copy point at the file.
3. `dependencies` — warn or block in the wizard when the declared content package is not added?
   Recommend warn, consistent with D-110.

---

## Appendix A — evidence that world.zip drops the ruleset (probe run 2026-09-19)

Temporary vitest probe (deleted after the run) on `main` @ `7d96203`: boot a fresh world →
`packages.importZip(system zip "probe-rules" 2.0.0)` → `packages.activate("probe-rules")` →
`exportWorldZip` → wipe world + package rows → `importWorldZip` → reboot.

```
BEFORE export — WorldsRecord: { system: 'mass-battle-basic', version: '2.0.0', activeRulesPackage: 'probe-rules' }
ARCHIVE entries: [ 'world.json', 'documents.json', 'assets.json' ]
AFTER import  — WorldsRecord: { system: 'mass-battle-basic', version: '2.0.0', activeRulesPackage: undefined, packagesInDb: [] }
REBOOT rulesBoot: { source: 'builtin', packageId: null, version: '1.0.0', error: null }
```

Three facts fall out: the archive has no package payload; the import silently boots the
built-in ruleset with `error: null`; and `system` was already wrong before export (activation
never updates it).

## Appendix B — measured artifact sizes (`pnpm build:systems`, same commit)

```
pf1e-core:          1.0.0 → dist/packages/pf1e-core-1.0.0.zip          (25.6 kB)
pf1e-mass-battles:  rules.js 219.5 kB (from src/packages/pf1e/rulesEntry.ts)
pf1e-mass-battles:  1.0.0 → dist/packages/pf1e-mass-battles-1.0.0.zip  (65.9 kB)
```
