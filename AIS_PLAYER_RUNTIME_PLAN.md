# AIS player runtime — route (b) plan and the P1a slice

_Status: P1a implemented 2026-10-14 (D-468). Later phases are plans with the estimates from
[PF1E_FOUNDRY_PORT_COST_ANALYSIS.md](PF1E_FOUNDRY_PORT_COST_ANALYSIS.md) §(b); nothing below P1a
is started unless its row says so._

## 1. Why this document exists

Until D-468 the implemented AIS kept a posture that was never a design goal: **modules and their
UI ran on the GM device only**, the player shell loaded no packages, and the readiness and cost
documents described "zero AIS in the player shell" as a fact to design around. The owner's
correction (round 5) is the rule for everything that follows:

> The GM must be able to share modules, UI and sheets with players. A module like the torch must
> work on a player's own token, and the player must have UI to drive it.

The route chosen is **(b)** — upgrade AIS and its adapters so that *any* module gains player-side
execution, rather than reworking each module — and, in the same programme, **move the native PF1e
implementation into the world file** so the main file carries the framework and the world carries
the game. The route comparison and the numbers behind it are in the cost analysis (D-467); this
document is the execution plan.

## 2. Principles (binding for every phase)

1. **The host stays the only authority.** A module on a player's device produces ordinary intents
   under that player's identity; `validateOps` and Foundry-default ownership decide. No new
   trust is granted to code because it is "approved by the GM" — approval chooses *what runs*,
   ownership chooses *what it may change*.
2. **Two consents, both necessary, neither sufficient alone.** The GM approves the exact hash on
   the GM device (existing review/approve flow). Each player allows the exact hash on their own
   device. A module that is not approved never leaves the host; a module that is not allowed never
   starts at the player.
3. **Hash is identity — and the player verifies the bytes.** Delivery and revocation are keyed
   by `(worldId, packageId, hash)`, where `hash` is the package hash the GM reviewed. The player's
   consent record additionally binds a digest this device computes over the delivered code
   (`deliveredDigest`: entry source, resources, runtime composition) and the capability list it was
   shown. A changed hash is a new question; the same hash with different code is refused and
   flagged ("integrity: mismatch"); a wider capability list asks again, a narrower one does not.
4. **The same code everywhere.** The player runtime reuses the sandboxed iframe, the kernel RPC
   handlers (`createAisModuleHandlers`) and the module archives unchanged. Only the context
   differs: `ClientSync` replica instead of the host store, `submitAndWait` instead of the host
   commit path, per-browser IndexedDB instead of host settings.
5. **Capabilities travel, services may not.** A player shell has no FX service, no scene-tag
   authority and no theme slot; those capabilities are stripped from what is advertised to players
   (`GM_DEVICE_ONLY_CAPABILITIES`) so modules fail at the manifest, not mid-action.
6. **Sharing is the default, opt-out is per module.** An approved automation module is shared
   unless the GM unticks it. Appearance-only packages and bare runtime providers are never shared
   (themes remain a local activation, D-456/D-463).

## 3. Phases

| Phase | Scope | State |
| --- | --- | --- |
| **P1a — delivery, consent, authority, torch UI** | `ais.profile` message; GM-side profile builder and sharing policy; player runtime over `ClientSync`; per-device consent; player token menu with light entries; GM sharing checkbox; `flags.ais` namespace fix in the light handler | **Done** (D-468). 17 new unit tests + 4 menu tests + e2e spec `e2e/ais_player.spec.ts` (not executed in the authoring sandbox — no browser download allowed; run `pnpm test:e2e:ais`). |
| **P1b — player-side module UI beyond the light slot** | manifest `interconnect.sharing` (`host-only` modules never travel) and `interconnect.tokenActions` (generic token-menu entries in both shells → `ui.token.action`); `runAs: "player"` command invocation inside the player's frame (`PlayerAisRuntime.invokeCommand`) with a command runner in the *Shared modules* card | **Done** (D-469). Player quickbar *binding* of module commands is still open (the hotbar is macro-only); notices/choices already existed. |
| **P2a — sandboxed module panels** | `interconnect.panel` + capability `ui.panel`; the module's own iframe document is the panel, the shell draws the chrome (`src/packages/aisPanel.ts`, one implementation for both shells); `AIS.ui.panel.open()/close()`; GM and player open buttons | **Done** as a vertical slice (D-470): no images/fonts inside panels (CSP unchanged), one panel per module, no drag/resize. |
| P2b — first-party component packages (sheets) | Svelte component-package contract (externalised `svelte/internal/client`) for **ArenaStar-built** system UI only, loaded by both shells under build-signed hashes; actor-sheet contribution slot; GM "share with players" per UI package | **Mechanism done** (D-475), re-sequenced ahead of P3 T2 because the import survey showed no logic-only cut shrinks the download: a system package ships `ui.js` (`manifest.ui.entry`, `{ api: "arena.ui/1", components }`) compiled against the shell's own Svelte runtime (`globalThis.__ARENASTAR_SVELTE__`, published by `main.ts`), imported in-page by the host (`HostApp.uiModule`), published as a second sha256 artifact (`sim.ui`), fetched/verified/loaded by players under the **same** consent record (`uiHash`) or first-party trust (both hashes), and mounted through known slots (`battleAnalysis` first). First payload: the per-army battle-analysis view (9,790 B `ui.js`). Fixed cost +45,427 B raw (38,978 B of it = the un-tree-shaken `svelte/internal/client` namespace), headroom 388,700 B. Remaining: the actor-sheet slot and the GM per-package share switch — done together with T2 + T3. |
| P3 — native PF1e logic into the world file | package the 348 KB of PF1e logic behind the dispatch interface the host already consumes (now 179 symbols / 143 edges / 27 host files), player shell loads the same package | **Step 1 done** (D-471): the strategic ruleset (`massBattlePf1e` + its exclusive deps) left the main bundle — the host consumes the active package in-page through `RulesModule.leaderStats` / `HostApp.rulesModule`; **−50,252 B** measured. **Step 2 done** (D-472): the package's `rules.js` (329,288 B) travels to players as a sha256-addressed artifact on the §7 assets channel (11 × 32 KB chunks, no new framing), the player shell verifies, asks per device/hash, imports in-page and feeds its army window; +8,367 B. **Step 3 done** (D-473): the build embeds its own packages (`pf1e-mass-battles` + `pf1e-core` as zips, 164 KB base64) — the wizard default and `?e2e=1&rules=pf1e` create worlds on the first-party ruleset with no file, Settings can add the packages to an existing world, and build-signed hashes load on player devices without the consent prompt (third-party still prompts); +168,761 B, headroom 426,137 B. **T1 done** (D-474): the character importers ride in `rules.js` behind `RulesModule.characterImport`; the Actors tab (both shells) and the agent bridge consume the seam and import nothing from `packages/pf1e/import`; rules.js +110,457 B (49 KB importers + 61 KB shared helpers now duplicated), main file −7,990 B raw / +13,185 B gzip. **T2 survey** (D-475): every tactical module the host imports is also imported by shell UI, so a logic-only T2 cannot shrink the download — T2 and T3 go as one coordinated move over the D-475 `ui.js` mechanism. Remaining: T2+T3 (+T4) ≈ 5–9 k LOC. |
| P4 — Foundry-shaped runtime (renamed: Target A, all modules) | the R1–R11 runtime from the cost analysis — delivered NOT as pf1-family code but as the generic kernel services + the `ais-foundry-v13` emulator adapter, so every Foundry core-API module runs unmodified (owner's Target A) | **Delivered D-482…D-487** (import/profile/UI/core-library/documents/`game.socket` + player devices; readiness R-01…R-06, R-09). The old 15–27 k LOC estimate is now **Target B** (executing the `pf1` system itself: TypeDataModels/sheets/CONFIG over the same documents) — owner decides when. Remaining Target A tails in `AIS_FOUNDRY_ARCHITECTURE.md` §5. |

## 4. P1a — what was built

### 4.1 Protocol: `ais.profile` (0x5e, host → client, ops channel)

```ts
interface AisProfileMsg {
  kind: "ais.profile";
  worldId: WorldId;
  seq: number;                         // host seq at publication, for ordering diagnostics
  providers: Record<string, string>;   // slotId → "packageId/contributionId"
  modules: AisSharedModule[];          // packageId, name, version, hash, source, resources?,
}                                      // runtimeHash?, runtimeContext?, commands, capabilities,
                                       // emittedEvents
```

Sent to every authenticated session right after its welcome snapshot/catch-up, and re-sent to all
sessions whenever the GM's approvals, grants, provider selections or sharing decisions change
(`HostSync.setAisProfileProvider` / `publishAisProfile`). A module absent from a later profile must
stop at the player; a module whose hash changed is a new consent question. Full field
documentation: [PROTOCOL.md](PROTOCOL.md) → `ais.profile`.

### 4.2 GM side

- `src/app/aisPlayerProfile.ts` — pure builder with the policy of §2: boot-set only; never
  appearance or bare runtime providers; never a module the host could not start; never a module
  whose GM-device consent is not currently active; honours the live per-module opt-out
  (`WorldsRecord.automationSharing[packageId] === false`, a device preference kept across
  re-imports like grants). Capabilities are the host grant minus `fx.play`, `scene.tags.write`,
  `ui.theme`.
- `src/app/aisRuntime.ts` — registers the provider with the host and republishes on every package
  change and on dispose (so a late joiner after a GM reload sees nothing until the runtime is up
  again).
- `HostPackages.setAutomationSharing(id, shared)` + the checkbox "Players run this module too" in
  the module review (`RulesetSection.svelte`). Default on.

### 4.3 Player side

- `src/app/playerAisRuntime.ts` — `PlayerAisRuntime`: reconciles each `ais.profile` against
  per-device consent (`settings` scope `ais.player-consent:<worldId>`, key `packageId`, value
  `{hash, digest, capabilities, decision, at}`); prompts for unknown/changed hashes (an "update"
  prompt when an earlier hash was allowed) and for widened capability lists; refuses and flags the
  same hash with different delivered code; starts `AisModuleIframe` with the unchanged kernel handlers over a
  `ClientSync`-backed context; stops modules that leave the profile ("No longer shared by the GM")
  or whose consent is withdrawn; exposes `tokenLightState(token)` / `tokenLightAction(tokenId,
  action)` for the shell. A `forbidden` rejection from the host surfaces as a notice — it is the
  design working, not a fault.
- `JoinApp.svelte` — consent dialog (`[data-ais-consent]`, capability descriptions in player
  wording), choice dialog for `ui.select`, status notices, and a token context menu
  (`playerTokenContextMenuModel`: *Open sheet* + the light entries when a light provider is shared;
  disabled with a reason when the player does not control the token or the module is not running).
- Host authorization needed **no change**: owners may already update their token's `light` and
  `flags.ais.*` and their actor's item quantities (`validateOps` + `can()`); the player's torch
  intents are accepted and everyone else's token is refused.

### 4.4 Fix found by the player path

`scene.token.light.apply` wrote `flags.ais.<pkg>` as a dotted key, which `src/core/diff.ts`
rejects when `flags.ais` does not exist yet. The GM e2e masked this by seeding `"flags.ais": {}`
in its fixture. The handler now creates the namespace when absent and addresses only its own key
otherwise (other modules' state survives). Tests in `tests/packages/aisModule.test.ts` and
`tests/packages/aisReliability.test.ts` assert both shapes.

### 4.5 Measured (this slice)

- Product code: ≈ +600/−11 lines across 15 files, +515 lines in two new files
  (`aisPlayerProfile.ts` 94, `playerAisRuntime.ts` ≈ 420); tests ≈ +700 new lines in three files
  plus updates in six; e2e spec 132 lines.
- `dist/index.html` **5,723,400 B** (was 5,698,896 B at D-467): **+24,504 B** for delivery,
  consent, integrity binding, runtime and UI; headroom under the 6 MiB gate 568,056 B.
- Gates: `tsc --noEmit` clean, `checkSvelte` 0 blocking, `eslint .` clean, `vitest run`
  **5,775 passed / 12 skipped** (was 5,721 / 12 at D-463).

### 4.6 Not done in P1a

- The browser batch `test:e2e:ais` (now three specs) was **not executed** here: the sandbox cannot
  download Playwright browsers. `e2e/ais_player.spec.ts` was written against the exact DOM hooks
  of the shells and the proven join/approve dances; run it before claiming the batch green.
- Player quickbar/chat commands, module-declared player actions, shared sheets (P1b/P2). *P1b
  landed in D-469: token actions + command runner; the quickbar binding remains open.*
- Delivery over the asset channel for large modules: `ais.profile` is one ops-channel message
  (same path as the unfragmented `snapshot`); packages stay within the existing 1 MiB script /
  8 MiB resource caps, so this is adequate for P1 and must be revisited when P2 ships components.

## 4.7 Review of the plan (2026-10-14, before commit)

Reviewed against the code as implemented; findings and what was done about each:

| # | Finding | Verdict | Action |
| --- | --- | --- | --- |
| 1 | Consent was keyed on the **host-asserted** package hash only; the player could not recompute `packageContentHash` (it covers the whole file map, not the delivered subset), so a misbehaving host could substitute code under an already-allowed identity. | Real gap — contradicted principle 3. | **Fixed in P1a:** `deliveredDigest` + capability list bound into the consent record; mismatch refuses and flags; two new tests. |
| 2 | The GM copy and every player copy receive the same observation events (`scene.token.light.changed`). A module that *writes* in reaction to an observation would act once per device. | Constraint, not a defect for torch (its observer only emits `torch.changed`). | Rule for P1: shared modules treat observations as read-only; the GM's per-module checkbox is the control. P1b adds a manifest declaration so reactive writers stay host-only automatically. |
| 3 | `ais.profile` travels as one ops-channel message; there is no application-level fragmentation on that channel (the `snapshot` has the same shape). Torch is 31 KB; the package caps (1 MiB script / 8 MiB resources) exceed what one WebRTC data-channel message is guaranteed to carry across browsers. | Shared constraint with large snapshots; adequate for P1. | ~~Chunked ops framing is a kernel item (not P1a). Measure before P2b, which ships component bundles.~~ **Resolved by reuse (D-472):** large package bytes are published under their sha256 and fetched on the §7 assets channel (32 KB chunks, resume, pacing); only the small descriptor rides an ops message. A 329,288 B rules artifact is 11 chunks. P2b and large AIS modules take the same path. |
| 4 | An older player build that does not know kind `0x5e` drops the frame (`decoded.ok === false`) and simply has no modules; there is no protocol version negotiation. | Acceptable degradation; pre-existing gap. | Note only; compatibility negotiation is design §12. |
| 5 | The original P2 row would have delivered third-party sheets as in-page Svelte components — foreign code with DOM access in the player's page, against the design's isolation tiers. | Plan error. | **Split:** P2a sandboxed panels for third-party modules; P2b component packages for first-party system UI under build-signed hashes. |
| 6 | A player who clicked "Not now" needs a way back. | Covered. | The player panel's *Shared modules* card lists each module with *Ask again* / *Stop and ask again* (`forget`). |
| 7 | Authority: no host authorization changed; every player-module write is an ordinary intent. | Sound. | Asserted by `tests/app/playerAisRuntime.test.ts` (owned token accepted, another player's token `forbidden`). |

## 5. Capability matrix at the player (P1a)

| Capability | At the GM device | At a player device |
| --- | --- | --- |
| `scene.read.visible`, `action.observe`, `actor.inventory.read`, `scene.tags.read` | host store | the player's replica (already visibility-filtered by the host) |
| `scene.token.light.manage`, `actor.inventory.consume`, `chat.post` | host commit | the player's own intents through `submitAndWait`; the host's `validateOps` + ownership decide |
| `ui.notify`, `ui.interaction`, `module.storage.read/write`, `event.emit` | host UI / host settings | the shell's notices and choice dialog; per-browser IndexedDB; events between modules on the same device |
| `runtime.execute`, `package.resources.read` | host | same (archive and runtime context travel in the profile) |
| `ui.panel` (D-470) | the GM shell's panel layer | the player shell's panel layer — the module's own sandboxed document in a host-chromed window |
| `fx.play`, `scene.tags.write`, `ui.theme` | host services | **not offered** (stripped from the shared grant by `GM_DEVICE_ONLY_CAPABILITIES`) |
