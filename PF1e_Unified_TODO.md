# PF1e — Unified TODO

Consolidated on **2026-09-08**, against repository base `4d6658a`.

One execution checklist for tactical PF1e play, strategic mass battles, and their integration. This is a documentation synthesis, not a fresh rules audit or a claim that the test suite was executed. The four source documents remain supporting design/history references; use this file to track work without duplicating tasks across them.

## Sources and status conventions

| Key | Source                                                             | Use                                                            |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| G   | [Combat Fidelity Gap List](PF1e_Combat_Fidelity_GapList.md)        | Detailed gaps, historical fixes, Appendix A rule inventory     |
| I   | [Implementation Plan](PF1e_ImplementationPlan.md)                  | Current contracts, P0–P8 delivery sequence, tabletop scenarios |
| M   | [MVP Work Plan](PF1e_MVP_WorkPlan.md)                              | Combat_Resolver_5 strategic feature inventory and acceptance   |
| B   | [Mass Battles Integration Plan](PF_MassBattles_IntegrationPlan.md) | Dual-scale architecture and longer-term system scope           |

References below use source sections, phases, or task numbers. `[x]` means documented as landed with corresponding code/test files present; it does **not** mean independently revalidated in this pass. `[ ]` means remaining work, including completion of partial implementations. Deferred items are explicitly separated, not silently dropped.

### Project context

ArenaStar_VTT is a browser-only, GM-authoritative VTT, built with TypeScript, Svelte 5, PixiJS and Vite into one self-contained `index.html`. Host-authorized Ops replicate documents to players; mass combat uses a worker, deterministic RNG, columnar ModelPool storage, and compiled unit profiles. Relevant areas:

- `src/core/`, `src/host/`, `src/client/`, `src/net/`: documents, permissions, persistence, replication, combat and world settings.
- `src/packages/pf1e/`: tactical data contracts and strategic PF1e rules; `src/packages/massBattlePf1e.ts`: strategic orchestration.
- `src/sim/`: deployment, rules loading, worker execution, codecs, checkpoints and replay.
- `src/canvas/`, `src/ui/sheets/`, `src/ui/combat/`, `src/ui/armies/`: playable surfaces still needing PF1e integration.
- `systems/pf1e-core/`: data-only seed packs; `systems/pf1e-mass-battles/`: packaged strategic rules. `scripts/buildSystemPackages.mjs` emits ignored build artifacts.
- `tests/packages/pf1e*.test.ts` and `e2e/pf1e_mass_battles.spec.ts`: existing rule/contract/scale tests and browser package flow.

## 0. Controlling decisions and reconciliation

These constraints override older proposals, not additional implementation tasks:

1. **Separate tactical and strategic resolvers, shared data/tables only.** No shared resolution kernel, sim adapter rewrite, or mandatory cross-scale numerical parity gate. Test each scale independently; document intentional differences. (G §10.1; I §2)
2. **Do not extend core ActorDocument or EffectDocument shapes.** Authored tactical data belongs in `system.pf1e`; effect and encounter semantics belong in `flags.pf1e`. Derive statistics on read, never persist derived totals. (I §§2–3; G §10.1)
3. **P0 is landed.** Use `rulesTables.ts`, `actor.ts`, `statBlock.ts`, `effects.ts`, `combatState.ts` and the replicated `settings` document `_id="world-settings"`. Do not recreate the contracts, put the clock on local WorldsRecord, or invent a P0 migration/version bump. (I P0, §10; DECISIONS D-113)
4. **Keep the existing packaging boundary.** Tactical UI is trusted in-repo code; `pf1e-core` is data-only and the mass-battle rules ship as a real package. The older `module.js` and core-system manifest sketches are superseded. (G §1.10; I §§2, 7)
5. **Keep per-model seeded d20 resolution.** B's probability-table optimization proposal is not approval to replace it with aggregate probability resolution. Preserve determinism and measure optimizations. (G §5; M Task 3)
6. **Budget changes must be measured.** No new pool columns without manifest/codec/replica coverage and a ≤200 B/model check. Keep the single-file ≤6 MB raw budget. The 50 ms strategic target and existing 250 ms portable regression gate are different requirements. (G §1.11; I §7)

### Reconciliation tasks — before encoding disputed rules

- [x] **R01 — Correct source-to-test rule references.** I refers to nonexistent Appendix A.19–A.21 and mislabels several others. Actual G headings: A.5 space/reach; A.6 actions; A.7 movement; A.8 cover; A.9 maneuvers; A.10 AoO; A.11 mounted; A.12 splash; A.13 injury; A.14 conditions; A.15 stances; A.16 spells; A.17 mitigation; A.18 regeneration/massive damage. Locate a canonical source for charge and any missing rules before writing fixtures. (I P3–P7; G Appendix A) — **done 2026-09-09 (D-127):** all 23 remaining `A.x` references in I now point at real headings with correct targets (verified against G's transcribed appendix): P1 accept → A.2/A.9/A.14; concealment block → A.8; splash → A.12; initiative-Dex → A.1; diagonals → A.7; defensive casting → A.16; cover accept → A.8; maneuver aftermath → A.9; AoO exclusions → A.10; mounted → A.11; object rules → A.17. SR's A.16 citation was verified correct (the no-auto-success SR rules close A.16). TWF penalties and Charge have **no appendix entry yet** — I now cites the SRD Two-Weapon Fighting / Charge pages explicitly with a transcribe-before-fixtures requirement, so V01 cannot snapshot a missing table.
- [x] **R02 — Verify contradictory rules and repair acceptance scenarios.** Do not blindly copy the appendix or current code as an oracle. Recheck surprise participation; touch AC/Dex; AoO budgets/Combat Reflexes; delay/ready; Bull's Strength magnitude and whether Str should change initiative; mid-combat initiative reordering; charge modifiers; Evasion versus ordinary half damage; defensive casting versus injury concentration; prone/grapple consequences; mounted higher-ground bonus; dying/stabilization/nonlethal thresholds; coup-de-grace critical/save; temporary HP stacking; DR/precision/riders; firearm threat/misfire/clearing rules; invisibility Stealth modifiers; spell-per-round/component restrictions. These have conflicting or suspect statements within/across G, I and B. Require authoritative rule citations and discriminating fixtures before closure. (G §§2–4, Appendix A; I S1–S5/P2–P7; B §4) — **done 2026-09-09 (D-129):** all eighteen flagged areas verified against authoritative text (AoN rule IDs / verbatim PRD) and repaired where wrong. Biggest corrections: surprise round is aware-combatants-act (G/I had it backwards); initiative ties break by total initiative modifier, and a Str buff never reorders initiative; delay keeps your full action economy; ready now transcribed (initiative moves ahead of the trigger); touch AC includes Dex; AoO = 1/round with +Dex only via Combat Reflexes (the appendix had encoded the strategic house rule); charge is +2 attack/−2 AC (I had −2 attack); Bull's Strength is +4 enhancement for 1 min/level; ordinary saves take half (round down, no minimum) while Evasion takes 0; defensive casting DC 15+2×SL vs injury 10+damage+SL; grapple does not flat-foot anyone; mounted +1 applies vs foes smaller than your mount; disabled at 0 = staggered with no Con check; dying check penalty = negative HP total; coup de grâce Fort save is mandatory; temp HP stack across different sources; precision damage IS reduced by DR; invisibility Stealth +40 stationary/+20 moving; firearms §2.9 verified (misfire/clearing remain untranscribed, like TWF/Charge). No code changed; the corrected appendix/scenarios are the fixture oracle for P3–P7.
- [x] **R03 — Resolve intentional variants explicitly.** Decide removal versus documented opt-in treatment of invented spell scatter, heroic overkill carryover, and total-envelopment +4/flat-footed effects. Distinguish SRD Cleave from damage spillover. Add decisions and named deviations/settings only with consumers; do not label Combat_Resolver_5 parity as SRD fidelity. Fireball's agreed baseline is the pack's 20 ft. (G §§5, 10.1–10.2; I P5/P8; M Tasks 4–7; B §4) — **done 2026-09-09 (D-130):** scatter **removed** from the fidelity path (resolve SR/save in your square; P5 deletes the unconditional 5-ft step-and-escape; no toggle unless a consumer asks); overkill carryover **rejected** (overkillDamage stays a report metric; SRD Cleave = standard action, second attack at full BAB vs an adjacent foe, −2 AC, not drop-triggered); total-envelopment +4/flat-footed **rejected** (SRD flanking is +2; per-round set/clear); Combat_Resolver_5 parity relabeled as metric compatibility, not fidelity; fireball 20 ft baseline affirmed with the 15-ft literal filed as DEVIATIONS D-2. DEVIATIONS.md now indexes the two live code deviations (D-1/D-2) and the rejected inventions; no code changed this slice.

## 1. Landed baseline — preserve, do not re-plan

- [x] **D01 — Pure spatial grid extraction** with Node tests in `tests/core/spatialGrid.test.ts`. Fidelity of distance/reach consumers remains open below. (M Task 1; B §6.1)
- [x] **D02 — PF1e schema/profile/deploy foundation:** manifest-schema alignment, content-addressed profiles, deterministic interning and pool seeding, plus signed `i8` codec support. (G §1.2–1.4/1.3b; M Task 2)
- [x] **D03 — Seeded strategic attack/spell plumbing** and foundational AC/flanking/minimum-nonlethal fixes. Full rule coverage, nonlethal thresholds and stale flanking flags remain open. (G §1.5, §2.1–2.3; M Tasks 3–5)
- [x] **D04 — Buildable/importable packages and initial content:** four spells, six bestiary entries, pack/profile equality tests, persisted activation via `HostPersister.patchWorld`. Feats and expanded content are not delivered by this checkbox. (G §1.1/1.1b/1.10; M Task 9)
- [x] **D05 — Portable 10k-model scale/replay gate and real-package browser spec.** Recorded baseline: 66 B/model, checkpoint ≤1.5 MB, warmed timing reports and 250 ms regression ceiling. This does not close the two-peer battle/hero flow or dense-army 50 ms target. (G §1.8/1.11; M Task 10)
- [x] **D06 — Tactical P0 contracts and replicated rules settings** with actor/effect/round/table/stat-block tests; derivation supports partial shipped pack input without a migration. Pure helpers are not equivalent to working sheet, tracker or timer UI. (I P0/§10; G §10.2)

## 2. Multiplayer correctness — early integration blocker

Can proceed alongside sheet work; required before claiming multiplayer mass-battle completion.

- [ ] **N01 — Announce active sim schema and scene on the wire.** Replace joinBoot's hardcoded `MASS_BATTLE_SCHEMA_COLUMNS` and `DEFAULT_SCENE_ID` with host-announced package schema/scene adopted before the first sim delta. Update host/joiner/ClientSync and `PROTOCOL.md`; cover initial join, package/schema changes and resync ordering. (G §1.6/1.10)
- [ ] **N02 — Prove a second peer receives PF1e state.** Test signed saves and PF1e HP/AC/status/profile columns across snapshots/deltas; browser joiner renders the correct scene and state without decode errors. (G §1.6; M Task 10)

### Multiplayer progress — 2026-09-09, protocol slice (D-126)

- **N01 implemented end-to-end at the wire/Node level:** `welcome` now carries optional `sim` info (scene id, SysSchema column map, package id, version). `HostSync.setSimInfo` publishes the §12-resolved schema before the GM loopback session is added; identical re-announcements are no-ops, changed ones re-welcome live sessions. `ClientSync` adopts the announcement in its welcome handler — joinBoot's hardcoded mass-battle-basic/`scene-1` guess is deleted (a wrong constructor guess is overridden and mis-decoded replicas discarded; a changed announcement resets the replica, re-requests a snapshot and queues deltas until it lands). Pre-start `sim.snapshot.get` is a host-side no-op behind a `SimBridge.started` gate. `PROTOCOL.md` welcome section updated; doc-consistency test green.
- **N02 proven in Node:** `tests/host/simAnnounce.test.ts` (5 cases) covers welcome verbatim, no-guess adoption, wrong-guess override, idempotent vs. changed re-announce, and a mid-battle joiner receiving seeded PF1e columns (u8 AC, signed i8 fort −2, u16 profile ids) across BOTH the snapshot and the delta path, against the real `createMassBattlePf1e` rules with faction projection (owned faction visible, hidden slots keep indices).
- **Browser half collected, not executed:** `e2e/pf1e_join.spec.ts` drives import/activate → reload → PF1e rules boot → manual-signaling joiner adopting the identical announced schema → 10-model campaign + resolved turn reaching the player's replica with zero page errors. Playwright collects it across 3 projects, but no browser binaries exist in this environment, so N01/N02 stay unchecked pending executed browser acceptance (Chromium first, then the Firefox/WebKit matrix), matching the D-119 precedent.
- **Evidence:** 905 unit/integration tests passed / 3 skipped (116 files + 1 skipped); typecheck, lint, touched-file Prettier pass; build 2,020,346 bytes raw / 584,769 gzip; `build:systems` emits both PF1e packages. Live package switching stays reload-based (D-087/D-110); the re-announce path is the protocol-level resync for future hot switching.

### Multiplayer progress — 2026-09-11, executed Chromium browser half (D-153)

- **The browser half of N01/N02 is now executed, not collected:** the first
  full-Chromium run of the suite (74/74) drives `e2e/pf1e_join.spec.ts`
  end-to-end — both shipped zips import and activate, a manual-signaling
  joiner adopts the announced PF1e schema (identical sceneId/schema/version),
  the GM's two-faction 10-model campaign reaches the player replica through
  BOTH the snapshot and the delta path, faction OBSERVER projection grants
  land, and a resolved turn advances the joiner's `simVersion` with zero page
  errors on either peer.
- **The spec itself was repaired, not just run:** it called `armySnapshot`,
  `factionOwnership` and the GM-side `simCount` on the app surface; they live
  on the gm surface (`GmFogSurface`). A `gmCall` helper mirroring
  `gmextras.spec.ts` replaced the three `appCall` sites. Also: `dist/packages`
  is wiped by `pnpm build`, so `build:systems` must follow `build` (the
  `test:e2e` script order).
- **Still open:** Firefox/WebKit matrix runs — the Playwright CDN and Debian
  mirrors are unreachable in this environment (D-082 precedent). N01/N02 stay
  unchecked pending that, per the D-119 convention.

## 3. P1 — Playable actor and monster sheets

Depends on D06. Primary surfaces: `PF1eActorSheet.svelte`, `SheetPanel.svelte`, `WindowHost.svelte`, token interactions.

- [ ] **S01 — Mount the PF1e sheet** from actor rows and token double-click, selected by PF1e actor/world context; preserve generic sheets for other systems. (I P1; G §1.7/§4.1; M Task 8)
- [x] **S02 — Replace hand-entered totals with authored fields + derived readouts:** six abilities/modifiers, HP/temp/nonlethal/ability damage, AC breakdown, attacks, saves, CMB/CMD, DR/ER/SR, speed, feats/traits and conditional monster CR/type/alignment/senses/special-attacks tab. (I P1; B §6.2)
- [x] **S03 — Route edits through authorized submit Ops**, remove the orphan sheet's fabricated `applyEnvelope` sequence path, and test ownership/rejection and player replication. (I P1; B §5)
- [ ] **S04 — Complete compendium-to-token-to-sheet flow** using shipped bestiary actors and normalization metadata; test derived UI values against `derivePF1eActor`, including the planned AC 18/13/15 fixture. Memoize on authored data/effect changes, not animation frames. (I P1; B §7)

### P1 progress — 2026-09-08, first implementation slice (D-114)

- **S01 partial:** the specialized sheet is mounted in the shared Sheets panel for actors with an explicit object-shaped `system.pf1e`, on both GM and player paths. Generic actors/items keep their existing editor. Floating WindowHost sheets and token double-click are still open.
- **S02 partial:** summary, six authored abilities, numeric HP/nonlethal/BAB/initiative/speed/save editors, derived AC/saves/CMB/CMD/DR/SR/conditions, attack readouts and calculation/import diagnostics are connected to the P0 reader. Do not mistake this for the full editor: temp HP/ability damage, armor/weapon/feat/trait authoring, dedicated monster tab and other unsupported P0 fields remain open. No combat rules changed.
- **S03 complete for the mounted sheet:** removed direct `applyEnvelope` writes; allowlisted authored edits use `ClientSync.submit`, with current-document ownership checks, input validation and rejection feedback. Tests prove host/GM/two-player replication and host rejection of a forged non-owner update. Imported save edits preserve sibling totals and `savesAsTotal`, rather than double-adding ability modifiers.
- **S04 partial:** all six shipped bestiary records pass the same sheet/contract reader tests; active versus disabled effects and the AC 18/13/15 fixture are covered. A browser compendium-import → sheet → edit/recompute scenario was added, but was only collected, not executed. Drag-to-token/double-click acceptance remains open.
- **Evidence:** full Vitest run: 106 files passed, 1 skipped; 828 tests passed, 3 skipped. Typecheck and lint passed. Build/size: 1,975,252 bytes raw (1.884 MB), below 6 MB. Chromium installation failed with `ECONNRESET` downloading from cdn.playwright.dev; Playwright collected 6 sheet tests across 3 projects, not a browser pass.

### P1 progress — 2026-09-08, floating-sheet/navigation slice (D-115)

- **S01 implementation delivered; browser acceptance pending:** both GM and player Sheets panels can open one restoreable WindowHost window per PF1e actor. Both canvas controllers route an unmodified left double-click on a linked token to the same projected-store/actor-read-permission gate. Generic actors retain the generic sheet; merely owning a token never grants access to a private actor.
- **Live-window safety:** actor content is read by ID, refreshed on snapshots/Ops/rejections/welcome, and removed when access is revoked or the actor is deleted. Window titles are generic so revoked names do not survive in chrome. Subscriptions are disposed on close. Unit/integration tests cover current HP, Dex/AC, effects, renaming, regrant, deletion and a real host-to-player visibility crossing.
- **S04 progress:** browser scenario now includes compendium drag-to-token, token double-click, popout edits reflected in the sidebar, rename, singleton reopening and minimize/restore/close. This remains a collected specification, not an executed browser pass, so S01/S04 stay unchecked until browser acceptance is verified.
- **Interaction regression:** with token activation enabled, clicks within a 4-screen-pixel dead zone submit no movement and never snap off-grid tokens. Real drags still emit their usual snapped Ops; modifier gestures and topmost picking at non-default camera transforms are tested. Non-activation consumers keep their existing behavior.
- **Evidence:** 107 Vitest files passed, 1 skipped; 835 tests passed, 3 skipped. Typecheck, lint, touched-code formatting, build and size passed (1,978,647 raw bytes / 1.887 MB). Six sheet browser tests collected across three projects; browser execution still unavailable following the recorded download failure. Remaining P1 work is the fuller authored/monster editors and browser acceptance, not more sheet-navigation scaffolding.

### P1 progress — 2026-09-08, authored armor/features/monster editors (D-116)

- **S02 further implemented:** an Armor tab edits existing P0 component fields (armor/shield/natural/dodge/misc AC and maximum Dex); a Features tab edits string-list feats/traits; a conditional Monster tab edits descriptive CR/type/alignment/senses/languages/special attacks/qualities/treasure. “Add monster details” explicitly creates the metadata block without guessing creature identity from a pack or name. No new combat rules or automatic class/feat/vision behavior were introduced.
- **Import safety:** actors using published AC totals cannot use component editors until an explicit conversion is authored; the UI never silently drops those totals or submits ineffective component edits. Structured feat/trait/monster fields remain read-only and their complete data stays visible. Unknown metadata survives edits; list/text proposals detect a changed expected value in the current local document. This is a local stale-edit guard, not a new host-side compare-and-swap protocol.
- **S03 regression repaired:** first-time nested ability/save edits could fail because FlatDiff requires intermediate objects to exist. A shared authored-patch builder now creates only the missing group, preserving normalized sibling data. Tests actually apply Ops to partial actors and all six shipped bestiary actors, rather than merely inspecting the proposed diff.
- **Still open:** weapon/attack authoring, richer HP/temp/ability-damage fields, broader defensive fields such as ER, explicit conversion from published AC totals, and actual browser acceptance. Armor check penalty and arcane spell failure are record-only fields with visible labels; skill/casting enforcement is not implied. S02 remains unchecked.
- **Evidence:** 108 Vitest files passed, 1 skipped; 843 tests passed, 3 skipped. Typecheck, lint, formatting, build and size passed (1,987,523 bytes raw / 1.895 MB). Extended browser spec covers component AC recomputation, feat names and monster creation/editing; 6 sheet tests collected across 3 projects, not executed. Chromium executable remains absent in this environment.

### P1 progress — 2026-09-08, weapon authoring and supported defenses (D-117)

- **S02 further implemented:** Weapons tab adds/edits/removes authored tactical attack lines: name, bounded NdM weapon dice, static damage bonus, damage type, threat/multiplier, range/reach and existing ranged/touch/handedness/natural/ability-included flags. Blank optional fields remove the authored property and restore existing defaults. Derived attack bonuses/damage stay read-only; no attack, damage or critical rolls were added.
- **Import/Op safety:** first legacy weapon edit materializes the existing normalized tactical lines, leaving the original strategic `weapon` object untouched and visible. Existing tactical edits use one-property dotted Ops; add/remove replace the array and preserve all surviving rows/unknown fields. Removing the last row stores `[]` so the legacy weapon is not reactivated. Malformed/structured data is not silently replaced; stale local lists, indices, input types and bounded list/dice values are validated. The local expected-list guard is not a host-side concurrency guarantee.
- **Supported defense/HP readouts:** numeric DR, SR, fast healing and regeneration can be authored through the existing contract, with imported DR/regeneration objects updated in place to preserve bypass/suppression/unknown fields. Recovery and mitigation automation are not implied. Added a clamped HP progress indicator, retaining the exact numeric HP readout (including negative HP).
- **Contract bug fixed:** `normalizePF1eSystem` dropped already-canonical numeric DR/regeneration values. Those values now survive, including mixed stat-block inputs and repeated normalization. This is authored-data preservation, not a new mitigation/healing rule.
- **Still open:** temporary HP, ability damage/drain and ER have no usable P0 derived contract; they were not added as pretend working controls. Explicit published-AC conversion and actual browser acceptance also remain. S02 stays unchecked. Weapon authoring is no longer a remaining P1 item; attack legality/rolling belongs to P3/P6.
- **Evidence:** 109 Vitest files passed, 1 skipped; 853 tests passed, 3 skipped. Tests include all six shipped legacy weapons, actual FlatDiff application, unknown-field retention, owner enforcement, and host/GM/player add/edit/remove replication. Typecheck/lint/edited-UI formatting/build/size passed (1,998,905 raw bytes / 1.906 MB); browser spec expanded and 6 sheet tests collected across 3 projects, but Chromium remains absent and browser execution is unverified.

### P1 progress — 2026-09-08, explicit AC conversion and manual health contracts (D-118)

- **S02 further implemented:** a preview-required tactical AC source workflow accepts explicitly supplied components (no reconstruction), uses the same effect-aware derivation on both preview sides, and preserves original published/strategic AC totals. `acMode` selects components or retained published totals; no-mode actors keep prior behavior. Component editors unlock only after applying component mode. Apply rebuilds Ops against the latest projected document, rejecting a stale local preview or lost permission; this is not host CAS.
- **Real but deliberately manual contracts:** canonical `tempHp` is a separate remaining pool, never added into current/max HP. `energyResistance` holds adjudicated acid/cold/electricity/fire/sonic amounts with derived readouts, validation, default-zero diagnostics and metadata-preserving Ops. They are not source aggregators or automatic mitigation/healing controls. Opaque imports remain protected, and unsupported energy entries are retained and reported.
- **Rules boundary:** checked CRB p.191 Temporary Hit Points (AoN Rules ID 171) and Special Abilities → Energy Resistance (d20pfsrd). No automatic absorption, source stacking/expiration, Constitution/HD HP calculation, resistance mitigation or healing was added. Ability damage/drain still needs its full contract and verified propagation; S02 remains unchecked. Existing source-plan HP/damage disputes are not declared resolved.
- **Evidence:** 111 Vitest files passed / 1 skipped; 862 tests passed / 3 skipped. Tests apply real FlatDiff Ops, preserve legacy/canonical sources, check reversible AC/effect previews and permission/staleness, and replicate HP/resistance/source changes through real HostSync/ClientSync. Typecheck/lint/new and edited UI/test formatting/build/size/build:systems passed; HTML 2,006,409 raw bytes (1.913 MB), gzip 579,755. Six browser cases collected, with conversion/reversal and manual health flows added; Chromium installation retried and failed with CDN TLS ECONNRESET, so no browser execution claim.

### P1 progress — 2026-09-08, executed Chromium acceptance and runtime repairs (D-119)

- **Browser acceptance now executed, not just collected:** four sheet scenarios pass on a real Chromium 149.0.7827.0 headless binary, booting built `dist/index.html` via `file://`. Coverage includes generic GM/player ownership, full PF1e editing/popup/conversion/stale-preview flow, all six shipped bestiary sheets against shared derivation, and a shipped actor drag → token → player double-click → live edit → observer downgrade → revoke → regrant. Runtime page errors are asserted absent in the PF1e flows.
- **Runtime repairs:** rename the Weapons `derived` prop, which made Svelte interpret `$derived` as a store subscription; snapshot the reactive actor before AC-preview FlatDiff cloning and keep preview/request objects non-proxied. These failures were not caught by plain TypeScript/model tests.
- **Multiplayer import repair:** raw sparse compendium creates omitted ownership, which the store defaulted on its clone but projection accessed on the original envelope. Apply the same private default during create projection; one private actor no longer aborts broadcasting its public linked token. Real host/GM/two-player regression proves the actor stays private until explicitly granted, while the token reaches both peers.
- **Shared-window regression:** broader window acceptance exposed Settings reading `DEFAULT_RULES` before initialization; move initialization after its constant. All five existing window tests now pass, for **9 actual browser tests passed** across sheets/windows.
- **Evidence:** 863 unit/integration tests passed / 3 skipped; 111 files passed / 1 skipped. Typecheck/lint/edited-code formatting/build/size passed; HTML 2,006,541 raw bytes (1.914 MB), gzip 579,746. Alternate binary came from external `@sparticuz/chromium@149.0.0`; no added browser-security bypass flags, no browser assets/dependency added to the repo. Optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` config documented; default pinned-browser behavior unchanged.
- **Remaining:** S01/S04 Chromium flows are verified; their full supported-browser acceptance remains unchecked pending Firefox/WebKit. S02 still needs ability damage/drain and verified propagation. No new injury, resistance, attack or strategic rules were implemented; the existing manual-field limitations stand.

### P1 progress — 2026-09-09, ability damage and drain (D-128, S02 closed)

- **The CRB p.555 contract is authored and propagated, not approximated:** `abilitiesDamage`/`abilitiesDrain` accumulators (non-negative integers per ability) plus `hitDice` feed a derivation where damage never reduces the score but applies `floor(damage/2)` to every ability-based statistic — AC/touch (flat-footed exempt), component saves, initiative, CMB/CMD, attack to-hit and melee damage (×1.5/×0.5), AoO count, spell DCs; published save/AC totals take the penalty on top; drain reduces the score itself and stacks with damage; Con moves current AND max HP by `HD × (drain Δmod − damage penalty)` when Hit Dice are authored (otherwise an unsupported note, never a guess); damage ≥ score ⇒ unconscious (Con ⇒ dead). Ranged lines and `abilityDamageIncluded` stat-block lines follow their own rules; healing 1/day is a runtime concern, not derivation.
- **Sheet surface:** 13 new fields route through the existing op editor (first edit materializes only the missing accumulator; structured imports are read-only per the D-118 policy); the attributes tab shows effective scores/modifiers and a damage/drain readout with per-ability penalties, plus new derived `abilityDamageTaken`/`abilityDrainTaken`/`abilityDamagePenalty` and `explain.abilities`/`explain.hp`.
- **Evidence:** 19 new tests (hand-computed fixtures from the rule text; bestiary parity with empty accumulators). 924 passed / 3 skipped across 117 files; typecheck/lint/format/build/size green; dist 2,025,106 raw / 586,250 gzip. **S02 is now checked off** — temp HP, ER, weapons, armor, features and the conditional monster tab landed in earlier slices and this was the last listed gap.
- **Still open:** in-journey ability healing (1/day, penalties-vs-damage floor 1), and S01/S04 full supported-browser acceptance pending Firefox/WebKit.

### P1 progress — 2026-09-11, executed Chromium acceptance for S01/S04 (D-153)

- **S01/S04 Chromium acceptance now executed:** the first full-Chromium e2e
  run (74/74) executes every previously collected sheet scenario — the four
  D-119 flows plus the later-added A06/A06b/E02 and scoped-roster specs —
  against the built `dist/index.html` over `file://`, with zero page errors in
  the PF1e flows. Compendium import → token drag → double-click → floating
  window → live edit → ownership crossings are all browser-verified.
- **Two product repairs were needed to get there (both invisible to Node
  tests):** the E02 effect editor's eight numeric inputs used `bind:value` on
  `type="number"`, which Svelte 5 coerces to a number, so `row.value.trim()`
  threw `e.trim is not a function` on every typed value and no effect ever
  applied through the form — they now store the raw string via `oninput`,
  keeping the model's string contract. And the effective-scores readout
  (`data-pf1e-effective-scores`) rendered only on the attributes tab, so the
  effects tab — where E02 applies/suppresses/removes — could not show the
  live numbers moving; the effects tab now carries the same read-only line.
- **The A06/A06b roll-card specs were corrected to the real product flow:**
  `ChatPanel` mounts only on the chat sidebar tab, which unmounts the embedded
  sheet, so the specs now open the sheet via `[data-open-pf1e-sheet]` and
  drive the floating `.wm-window [data-pf1e-sheet]` while chat stays visible.
  A06b's hp write (`PF Dummy 12 → N HP`) through the op path is asserted live.
- **Still open:** S01/S04 full supported-browser acceptance remains pending
  Firefox/WebKit (blocked: the Playwright CDN and Debian mirrors are
  unreachable in this environment — D-082/D-119 precedent).

## 4. P2 — Initiative, encounter selection and action foundations

Depends on P1 for the approved sheet-before-tracker flow and on R02 for disputed semantics. Reuse `combatState.ts`, do not rebuild it.

- [x] **T01 — Add selection-aware token context menu:** initiative count, add/remove combatant, hidden state; retain a pan gesture. Add effect/spell actions only when P4/P5 handlers exist. (I P2)
- [x] **T02 — Roll actor-aware initiative** with linked `actorId`, derived Dex/feat/misc modifiers, tie-break/reroll policy, selected-token fallback and active-scene scoping. Support verifiable hidden GM rolls without leaking values. (I P2; G §4.3)
- [x] **T03 — Wire surprise and flat-footed-before-first-turn transitions**, round resets and encounter flags into actual tracker flow. Correct the `flags.core.delayed` round-wrap lookup bug with a regression test. (I P2; G §4.3/4.11)
- [x] **T04 — Add create/activate encounter list** rather than taking `getAll("combats")[0]`; test multiple scenes/encounters and unchanged non-PF1e behavior. (I P2/§7)
- [x] **T05 — Implement visible action budgets and legality:** standard/move/full-round/free/swift/immediate, move substitution, restricted activity, start/complete full-round actions, 5-foot-step eligibility and next-turn swift consumption. Add the verified action/provoke table as shared data. Interrupt execution completes in P6. (G §3/§4.4; I P6)

### P2 prerequisite repair — 2026-09-08 (D-120)

- **T03 scope-lookup bug fixed:** round wrap now delegates to the existing scoped `clearDelayed` helper for every combatant. Previously the loop looked for a top-level flag although the writer uses `flags.core.delayed`; only the newly starting combatant was reliably cleared. Regression covers a marked non-starting combatant, input immutability, other scopes/metadata, initiative preservation and exactly-once ending-owner effect expiration.
- **UI honesty:** “Mark delayed” and its tooltip now identify a manual marker. Corrected core comments that incorrectly promised last-in-round scheduling. No initiative change, automatic turn advance, PF1e resume/interrupt logic, surprise or flat-footed transitions were added. This is the generic compatibility repair explicitly called out by the plan, not completion of T03 or a bypass of remaining P1 work.
- **Evidence:** 866 unit/integration tests passed / 3 skipped; 11 actual Chromium tests passed across combat/sheets/windows, including a new three-combatant round-wrap regression. Typecheck/lint/edited-code formatting/build/size passed; raw HTML 2,006,597 bytes, gzip 579,796. Same alternate Chromium 149 setup as D-119; Firefox/WebKit remain unverified.

### P2 encounter selection — 2026-09-08 (D-121)

- **T04 implemented:** GM tracker has a named encounter create control and scene-scoped selector. New encounters copy only the active scene's tokens, retain linked actor IDs, and start at round zero. Switching does not start/restart encounters or change initiative, rounds, turns or combatants. Start-without-an-encounter still creates and starts in one user action.
- **Replicated contract:** `combat.flags.core.sceneId` binds new encounters; `scene.flags.core.activeCombatId` is the single selected encounter pointer per scene. Create+activate is one submit transaction. Explicit dangling or cross-scene pointers resolve to no encounter, never silently select another. Unbound legacy combats appear only under the first stored scene, with the old first-encounter fallback only when no pointer was authored. No schema migration or system-specific rules dependency.
- **Validation/safety:** latest-store scene/encounter permission checks, rejection refresh, narrow flag writes preserving siblings, unit cases for legacy/cross-scene/deleted selection and generic actor links, and real host/GM/player pointer replication without resetting inactive rounds. Browser proves two encounters retain separate turns while switching between two scenes. Fixed Add token's hard-coded bootstrap parent discovered by that test; it now writes to the active scene.
- **Evidence:** 871 tests passed / 3 skipped (112 files passed / 1 skipped); 12 actual Chromium tests passed across combat/sheets/windows. Typecheck/lint/edited-code formatting/build/size passed; HTML 2,009,452 raw bytes (1.916 MB), gzip 580,819. Firefox/WebKit remain unverified. T01/T02/T03/T05 and P1 ability damage/drain remain open; actor-aware initiative, hidden-roll verification and selection-aware rosters are not claimed here.

### P2 public actor-aware initiative — 2026-09-08 (D-122)

- **T02 partial:** Roll init reads the current selected encounter, resolves linked actors from the projected store (with token-link fallback for legacy rosters), and uses the existing PF1e derived initiative modifier. Generic/unlinked actors retain flat d20 behavior. Per-combatant `flags.core.initiativeRoll` records die, modifier, total, explanation and actor ID; manual overrides clear that record. These are public local rolls, not commit/reveal proofs, and feat-name strings are not newly interpreted as mechanics.
- **Turn policy:** the first roll at round 1 / turn 0 with all initiatives unrolled establishes the highest result as the first combatant. Subsequent explicit rerolls/manual changes retain the current combatant's identity even if its sorted index moves. Later actor/effect changes do not automatically reroll/resort the encounter. Ties remain stable pending GM adjudication, with the missing automatic tie policy explicitly stated in the UI.
- **Rules correction:** flat-footed/denied-Dex-to-AC previously suppressed Dex in derived initiative. CRB p.178 Initiative is a Dexterity check; remove that erroneous coupling and correct its regression expectation and explanation. Full tie resolution must compare total initiative modifiers, then roll remaining ties—not just compare Dexterity. This rule is verified but not yet automated.
- **Safety:** validate the complete roster before RNG. Missing/wrong-scene tokens, unavailable linked actors, malformed PF1e data/effects and unauthorized updates produce no transition. Hidden combatants/tokens block the public batch rather than leak a hidden roll. Verified hidden rolls and selected-token initiation remain open.
- **Evidence:** 879 tests passed / 3 skipped (113 files passed / 1 skipped); 12 actual Chromium combat/sheet/window tests passed. Browser checks the linked dragged token's +3 modifier, not the unrelated selected actor, and manual receipt removal. Host/GM/player replication preserves public totals/receipts without publishing the private actor document. Typecheck/lint/new and edited UI/test formatting/build/size passed; HTML 2,012,386 raw bytes (1.919 MB), gzip 582,120. Full browser matrix, T01/T02 remainder, T03/T05 and P1 ability damage/drain remain open.

### P2 automatic public initiative ties — 2026-09-08 (D-123)

- **T02 further implemented:** public roll batches containing a PF1e actor order equal initiative totals by total initiative modifier, then roll remaining tied groups with unmodified d20s. Only still-tied subgroups reroll; already-resolved positions stay fixed. This follows the CRB p.178 Initiative rule verified in D-122. Generic-only encounters and manual overrides keep their previous stable-tie behavior, explicitly labeled in the UI.
- **Persistence without core rule coupling:** persist resolved equal-total order in the combatant array, reusing core's existing stable sort. No fractional initiatives, live-actor comparator, hidden core PF1e dependency or schema change. Core next/start/round-wrap operations retain the order, and explicit rerolls retain the active combatant under D-122's policy. Receipt fields `tiePolicy` and `tieRolls` document the actual policy and complete per-combatant roll-off history; initiative totals remain unchanged.
- **Safety:** invalid tie dice or 20 unresolved roll-off rounds discard the entire proposal, preserving prior totals/order/receipts. The cap prevents a broken RNG from hanging the UI; it never silently chooses a winner. Hidden-roll blocking remains unchanged. These public local rolls are not cryptographic verification.
- **Evidence:** 889 tests passed / 3 skipped (114 files passed / 1 skipped); 13 actual Chromium combat/sheet/window tests passed. Six pure rule fixtures and four adapter regressions cover modifier-vs-total ordering, multiple/repeated subgroups, invalid RNG, immutability, generic fallback and turn/round stability. Host/GM/player regression verifies the resolved order and tie receipts; a deterministic real DOM browser roll between two shipped bestiary actors survives round wrap. Typecheck/lint/edited-code formatting/build/size/build:systems passed; raw HTML 2,013,894 bytes (1.921 MB), gzip 582,633.
- **Still open:** T02's selected-token workflow and verified hidden rolls, the rest of T01/T03/T05, P1 ability damage/drain and Firefox/WebKit acceptance. T02 remains unchecked; automatic ties for the implemented public PF1e roll path are no longer a remaining item.

### P2 selected-token workflows — 2026-09-08 (D-124)

- **T01/T02 selection path implemented:** the existing GM canvas click/marquee selection now feeds the tracker with a scene ID and token IDs. Selected count/names, clear, Add selected, Remove selected, Roll selected and explicit Roll all controls are mounted. New encounters use only selected tokens, falling back to all current-scene tokens only when selection is genuinely empty. Existing encounter Start does not silently rebuild its roster.
- **Scene/staleness guards:** scene changes clear selection and cancel stale canvas gestures without submitting movement. Deleted/partly stale token selections remain visibly invalid until cleared/reselected; they never degrade into an all-token operation. Selected non-roster tokens must be added before initiative. Selection is local UI state, not ownership or replicated document state. Right/middle/Shift panning and existing generic workflows remain unchanged.
- **Roster safety:** additions are idempotent and preserve existing records/metadata. Removal touches only matching members, preserves active identity, emits no turn/effect ticks, and refuses to remove the current combatant until advancing or ending combat. Ended encounters may remove their full roster. Latest selected encounter and host permissions remain decisive.
- **Partial initiative scope:** roll only selected roster members and retain unselected totals/receipts exactly. Ties within the selected batch use D-123. A newly rolled result tying an unselected result rejects the whole proposal with an explicit Roll all/manual-adjudication prompt: never silently reroll an unselected combatant or infer a modifier for a manual old result. Explicit Roll all deliberately ignores local selection.
- **Evidence:** 899 unit/integration tests passed / 3 skipped (115 files passed / 1 skipped); 15 real Chromium combat/sheet/window tests passed. Ten new regressions cover selected creation, stale/foreign/deleted selections, no-op additions, active-removal guard, partial-roll preservation/collisions, gesture cancellation and host/GM/player replication. Two browser flows cover real marquee/click selection, scoped creation, add/remove, partial receipts, scene reset, all-token fallback and undo-deletion without scope broadening. Typecheck/lint/edited-code formatting/build/size passed; HTML 2,018,741 raw bytes (1.925 MB), gzip 584,344.
- **Still open:** T01's context-menu/hidden-state controls and T02's verified hidden-roll workflow; T01/T02 stay unchecked. No player tracker surface, new injury/ability-damage mechanics, surprise/action budgets or full browser-matrix acceptance is claimed.

### P2 action economy — 2026-09-09 (D-131, T05 closed)

- **The verified action/provoke table now exists as shared data:** Gap List A.6's 2026-09-07 transcription had wrong rows (run "no"→**yes**, mount/dismount "yes"→**no**) and invented entries ("snipe", "remove curse", "draw a weapon and move"); it was replaced with the authoritative Table 7-2 (CRB p.182, AoN Rules ID 128) before `PF1E_ACTIONS` was encoded — no snapshot of a wrong table.
- **Budget + legality (pure, no dice):** per-combatant `PF1eActionLedger` under `combatant.flags.pf1e.actions` with standard/move/swift slots, off-turn-immediate reservation (consumes the NEXT turn's swift, CRB p.183), 5-ft-step/movement mutual lock (p.189), surviving full-round pending, and a "single-standard-or-move" restriction. Encoded: standard+move OR full-round; move substitutes for standard (two moves, never two standards); restricted activity allows free/swift (verified: swift is legal in surprise rounds) and start/complete-full-round with a standard (p.181/185), refuses full-round; `actionRefusal` returns the rule reason for the UI and the future P3+/P6 legality gates.
- **Wiring:** the ledger resets at turn start inside `pf1eNextTurn` (reservation converts to "swift used"; pending survives the round wrap); `startWithSurprise` and the surprise→round-1 boundary give the first actor a fresh ledger — the boundary now also marks that actor `acted`, fixing the adjacent bug where the first regular actor stayed flat-footed during their own turn.
- **Visible in the tracker:** the active combatant gets budget chips (STD/MOVE/SWIFT/5-ft, moved ft, pending) and spend buttons whose disabled-tooltips are the refusal reasons, plus per-row off-turn "Immediate" buttons — only for encounters with a PF1e-linked actor; generic combats are untouched.
- **Evidence:** 20 new tests (11 table/budget fixtures against CRB p.181–185/189, 5 wiring fixtures, 4 panel-helper tests). 944 passed / 3 skipped across 119 files; typecheck/lint/edited-file formatting/build/size green; dist 2,035,684 raw / 588,837 gzip.
- **Still open:** interrupt execution is P6 as planned; the restriction is not yet SET from the surprise round (lands with T03's tracker wiring) or from conditions like staggered (condition library).

### P2 surprise and tracker wiring — 2026-09-09 (D-132, T03 closed)

- **The surprise rule the code ran was the pre-D-129 one and is corrected:** awareness is per combatant (a defender noticing ANY one attacker is aware), a surprise round happens when some but not all are aware — even if another defender noticed — and **aware defenders act in it**; only the unaware are flat-footed. `startWithSurprise` also accepts explicit GM awareness marks (the tracker path — no invented dice); "no one / everyone surprised" still yields no surprise round. The `flags.core.delayed` round-wrap bug named here was already fixed in D-120.
- **The wiring the TODO asked for is real now:** the tracker's update diff carries `combat.flags` (previously the PF1e round state was computed and silently dropped on submit); PF1e encounters route Start through `startWithSurprise` (initiative must be rolled, ties resolved; GM marks are pre-start input), Next through `pf1eNextTurn` (AoO refresh, held delivery, clock and T05 budget resets flow), End through the new `pf1eEndCombat` (fresh setup state, no stale phase/clock on restart). A surprise round renders as a running state ("Surprise round · 2/3 aware") while core's round is still 0; the active row/budget bar follow `activePF1eCombatant`; every roster row shows a flat-footed chip with its reason.
- **Surprise actors are marked as having acted** ("unaware combatants are flat-footed because they have not acted yet") and get the single-standard-or-move restricted budget (the restriction-setting T05 deferred); the restriction lifts when regular rounds begin.
- **Evidence:** 3 surprise tests rewritten/added against the corrected rule + strengthened existing fixtures; 947 passed / 3 skipped across 119 files; typecheck/lint/edited-file formatting/build/size green; dist 2,044,962 raw / 591,474 gzip.
- **Still open:** delay/ready rescheduling and held-action interrupts (P6), full browser-matrix acceptance, T01's context menu and T02's verified hidden rolls.

### P2 token menu and hidden rolls — 2026-09-09 (D-133, T01+T02 closed)

- **T01 implemented:** right-CLICK on a token (a right-drag still pans, per D-057; <4 px movement discriminates) opens a context menu with the token's initiative state, add/remove combatant and a hidden toggle. Add/remove reuses `editSelectedRoster` (idempotent adds, D-125 active-removal policy, no implicit ticks); hidden is one narrow `tokens` update op. Players see state but mutations are permission-gated with reasons. No effect/spell entries until P4/P5 handlers exist, per the item. The menu closes on Escape, new gestures or entry run; empty-canvas right-click opens nothing.
- **T02 completed (hidden rolls):** hidden scope = combatant.hidden OR token.hidden; `rollHiddenInitiative` writes real initiative totals (order is table-observable) but stores die/modifier/explanation/actorId/tieRolls only in `flags.pf1e.hiddenInitiative`, deletes any stale public `flags.core.initiativeRoll` for rolled members, applies D-122 modifier derivation/refusals and D-123 tie policy inside the batch. Permission/scene failures abort before any RNG call. `verifyHiddenInitiativeReceipt` re-derives each receipt (die 1–20, total = die+mod, valid tie faces) and the GM panel shows ✓/✗; players see a disabled "?" input via `hiddenInitiativeDisplay`.
- **Evidence:** 18 new tests (5 canvas gesture, 8 pure menu model, 5 hidden-roll). 965 passed / 3 skipped across 119 files; typecheck/lint/touched-file formatting/build/size green; dist 2,054,484 raw / 591,545 gzip. Browser matrix still unverified (§2 S01/S04 track that).
- **P2 status:** all five tracker items closed at the unit level. Remaining P2-adjacent work lives where the plan puts it: menu effect/spell entries (P4/P5), delay/ready rescheduling and held-action interrupts (P6/T05 follow-up), full browser-matrix acceptance.

### GM-control correction — 2026-09-08 (D-125, supersedes D-124 restrictions)

- **Standing user requirement:** the GM must be able to remove or change active and non-active combatants whenever desired. Do not impose gameplay-phase restrictions on GM authoring to simplify scheduling. Ownership checks and malformed/stale-reference validation remain data-safety checks, not turn-state vetoes.
- **Active removal allowed:** remove the active member immediately, including multi-remove or the last remaining member. If needed, move the current pointer to the next surviving member in the old order, wrapping without incrementing the round. Never tick effects or emit turn-start/end hooks as a side effect of a roster edit. Empty running encounters retain the round and show “No combatants.” Manual initiative edits already work on active/non-active members.
- **Selected tie no longer blocks:** accept the selected results and preserve stable cross-selection tie order, without rerolling/replacing unselected results. Mark affected selected receipts `crossSelectionTie: "stable-order"`; Roll all remains an optional full tie-resolution operation. This supersedes D-124's rejection policy.
- **Evidence:** 900 unit/integration tests passed / 3 skipped; 15 Chromium browser tests passed. Core-adapter tests cover next surviving successor, wrap, multiple/last removal, no implicit ticks and accepted partial ties. Browser and host/GM/player tests cover removal of active/last members. Typecheck/lint/edited-code formatting/build/size passed; HTML 2,018,848 bytes raw, gzip 584,394. No additional battle rules or browser-matrix coverage claimed.

### P2 tracker reachability repair — 2026-09-11 (D-153, scoped-roster spec executed)

- **The D-132 initiative gate is now satisfiable:** D-132 routes PF1e starts
  through `startWithSurprise` and refuses to Start until initiative is rolled
  and ties are resolved — but every roll control rendered only in the running
  branch, so a pre-created PF1e encounter could never satisfy its own gate
  (the create-and-start shortcut bypasses it, which hid the gap). The
  pre-start branch now renders the same three controls (Roll init / Roll all /
  Roll hidden) for `combat && pf1e`, with a note that PF1e starts are
  surprise-aware. `rollInitiative` needs only a selected encounter, so no
  rules or handler changes — the branches are mutually exclusive, the
  `#combat-init` id is never duplicated.
- **The scoped-roster browser spec (D-124) now executes green:** marquee
  selection → scoped 2-member start → selected-only rolls → receipt
  preservation across adds → cross-selection tie acceptance → remove-selected
  down to zero → scene-switch isolation → empty-selection create falling back
  to all scene tokens. The final step rolls initiative through the new
  pre-start control before Start, matching the D-132 gate instead of the
  pre-D-132 behavior the spec was written against.

## 5. P3 — Tactical attack, damage and equipment mechanics

Depends on D06 and R01–R02. Implement actor-based resolution (planned `tactical.ts`), independent of ModelPool loops. Strategic consumption/fixes are tracked in §10.

- [x] **A01 — Build typed weapon/equipment attack descriptors** for melee/ranged/touch, handedness/off-hand/light/double/natural/unarmed, proficiency, range, crits, material/alignment/enhancement, ammo, armor/max Dex/ACP/ASF, item HP/hardness/broken state. (I P3; G §§2.4–2.10, 3, 6)
- [x] **A02 — Implement attack eligibility and arithmetic:** BAB iteratives, Str/Dex and size, natural 1/20, normal/touch/flat-footed defense, TWF table, natural primary/secondary attacks, unarmed/lethal conversion, nonproficiency and shooting-into-melee exceptions. (I P3; G §2.6/§4.7)
- [x] **A03 — Complete damage and critical arithmetic:** threat/confirmation, expanded threat sources, base dice/static versus bonus/precision dice, additive multipliers, handedness Str rules, enhancement, minimum nonlethal damage and precision immunity. (I P3; G §2.4–2.7)
- [x] **A04 — Implement range and ranged/splash legality:** range penalties/max thrown/projectile increments, reach restrictions, grid-intersection targeting and miss scatter for splash weapons (not invented spell scatter). (I P3; G §2.8/§4.7; Appendix A.12)
- [x] **A05 — Apply verified defensive mitigation:** defender-owned compound DR/bypass thresholds, alignment/epic/ammunition interactions, energy resistance per type, immunity/vulnerability, damage-dependent riders, and separate object hardness. (I P3/P7; G §2.10/Appendix A.17)
- [x] **A06 — Connect attacks/saves/checks to sheet roll buttons**, actor `rollData`, chat breakdown and optional commit-roll verification; apply HP Ops authoritatively and add full-attack controls plus preliminary AoO prompts. (I P3; B §5)
- [ ] **A07 — Encode supported feat/stance modifiers and exceptions** from verified tables: Power Attack/Deadly Aim, Combat Expertise, fighting defensively/total defense, Weapon Focus/Specialization/Finesse, Improved Critical, TWF tree, Point-Blank Shot, and unarmed-related prerequisites. Manyshot and Precise Shot's remaining geometry/volley consumers stay with their owning attack/positioning slices; content entries alone do not close their mechanical behavior. (G §§3, 6, Appendix A.15; I P3/P8; B §4.3)

### P3 feat/stance progress — 2026-09-10 (A07 modifier slice; decision backfilled as D-141)

- **Implemented:** pure `feats.ts` normalization and modifier helpers for explicit Power Attack/Deadly Aim (including handedness scaling), Combat Expertise, fighting defensively/total defense, weapon-scoped Weapon Focus/Specialization/Improved Critical, Weapon Finesse stat selection, Point-Blank Shot's 30-foot boundary, and Improved/Greater Two-Weapon Fighting off-hand attack counts.
- **Wired:** `tactical.ts` now consumes the attack/damage helpers when callers explicitly activate a stance, uses Weapon Finesse for eligible light melee weapons, and lays out additional off-hand attacks. No feat is silently activated from authored content; prerequisites not represented in the actor contract remain caller-owned.
- **Also added:** `manyshotPlan` validates the feat/ranged/BAB gate and returns the standard-action arrow count (2–4) plus the −4 volley penalty; `pf1eManyshotRollSpecs` now exposes one same-bonus roll per arrow, and the Combat tab renders a Manyshot button when the authored feat and derived ranged line qualify. Precision/extra-dice handling remains with the damage consumer.
- **UI validation:** the Features tab now reports unmet prerequisites for supported feats without deleting or disabling authored entries (Power Attack, Deadly Aim, Combat Expertise, Weapon Finesse, Improved Critical, Precise Shot, Manyshot and the TWF upgrades).
- **Scene geometry:** `shootingIntoMeleePenalty` now accepts explicit `targetEngaged` and `nearestFriendlyDistanceFt` facts; non-engaged targets and targets at least 10 ft from the nearest friendly no longer receive the −4/−2 penalty, while Precise Shot still removes it unconditionally. The scene/detection caller still owns producing those facts.
- **Manyshot resolution:** added pure `pf1eResolveManyshot`, which applies 2–4 host-evaluated arrows in order against one evolving defender state, including per-arrow hit/miss, confirmation, mitigation, HP and nonlethal transitions. It rejects non-ranged attacks and invalid volley sizes before resolving any arrow.
- **Wired:** `resolveManyshotFlow` now performs host attack/confirmation/damage rolls for every arrow, resolves the ordered volley, emits one public Manyshot card, and writes final HP/nonlethal through the normal authorized sheet path. The Combat tab exposes `Resolve Manyshot ×N` alongside the target/defense controls.
- **Still open:** browser acceptance. A07 remains open until the browser flow is executed and verified.

### P3 weapon and equipment descriptors — 2026-09-10 (D-134, A01 closed)

- **Two shipped rules corrected against primary texts while encoding:** the unarmed damage ladder (Medium is **1d3**, Large 1d4 per AoN Rules ID 131 — `actor.ts` previously carried 1d2/1d3 and now imports the shared corrected table from `weapons.ts`), and the broken threshold (damage **in excess of** half HP, `hp < hpMax/2` — exact half is not broken; the A.9 paraphrase "≤ ½ HP" is tightened against the glossary).
- **`src/packages/pf1e/weapons.ts` (new):** authored `system.pf1e.weapons[]` shape + total `resolvePF1eWeapon` (garbage ⇒ named issues + usable fallback). Resolves class-derived facts on read (max range increments thrown 5 / projectile 10 / early firearm 5 / advanced 10; firearm touch-AC window 1st/5th increment; broken misfire +4) and carries handedness, proficiency, dice/type, nonlethal, threat/multiplier, enhancement + special-ability bonus with the /epic `effectiveBonusTotal`, material (spelled `cold iron`/`silver`/`adamantine`, matching `drBypass`), alignment, double head, natural/secondary, unarmed, touch, reach, trip/disarm, splash, ammo (capacity + A.6 load-action reference), item wear. `brokenWeaponAdjustments` encodes AoN ID 413: −2 attack/damage, crit on natural 20 only at ×2.
- **`src/packages/pf1e/items.ts` (new):** armor/shield descriptor + total validator (slot, proficiency, bonuses, max Dex, ACP non-negative, ASF), `brokenArmorAdjustments` (AC halved rounding down, ACP doubled, no ASF change), `itemHpAfterDamage` (hardness first, A.17), `isBrokenFromDamage`, `sunderVerdict` (arithmetic only — the maneuver is P6). No material HP/hardness table invented (none verified); item HP/hardness are authored per item.
- **Not encoded on purpose:** TWF penalty numbers (SRD table not yet transcribed in Appendix A), Gun Training +2 broken-misfire variant (A07 feat), nonproficiency −4 and DR bypass ladder (A02/A05 resolvers read the carried data).
- **Evidence:** 18 new tests; two `pf1eActor` unarmed expectations corrected. 983 passed / 3 skipped across 120 files; typecheck/lint/touched-file formatting/build/size green; dist 2,054,514 raw / 591,568 gzip. A02–A07 open; no attack-path consumer yet.

### P3 tactical attack layer — 2026-09-10 (D-135, A02 closed)

- **`src/packages/pf1e/tactical.ts` (new, pure, no dice — callers pass the d20 result):** `attackModifierParts` assembles the labeled stack (BAB, Str/Dex by mode, size, enhancement, broken −2, weapon nonproficiency −4, nonproficient-armor ACP, TWF, secondary-natural −5, unarmed-lethal −4, flanking/charge/invisible/squeezing, shooting-into-melee, misc); `resolveAttackRoll` encodes nat 1/20 and the threat caveats (a sub-20 threat range is not an auto-hit; a miss is never a threat); `selectDefenseAc` covers the touch × flat-footed AC combination; `fullAttackPlan` lays out iteratives + the one TWF off-hand attack + natural attacks; `attackEligibility` refuses only ranged use of increment-less weapons.
- **Verified against primary texts before encoding:** Table 8-7 (CRB p.202 / AoN ID 198: −6/−10, light −4/−8, feat −4/−4, feat+light −2/−2; double-weapon off end is light; unarmed is always light), natural attacks (CRB p.182 + Bestiary UMR: primary full BAB / secondary −5, no iteratives, mixed-with-weapon ⇒ all naturals secondary, one-type-only ⇒ all primary regardless of authored type, sole natural attack always full BAB + 1½ Str flag for A03), unarmed (AoN ID 131: provokes from the armed target unless armed via IUS/natural weapons; −4 to deal lethal without IUS), nonproficiency (weapons −4, CRB p.144; nonproficient armor ACP on attack rolls, armor+shield stack, CRB p.153), shooting into melee (−4 / −2 at two size categories larger / none at three; Precise Shot; the 10-ft and "engaged" tests are caller geometry).
- **Not interpreted on purpose:** the ambiguous "TWF and Multiattack can reduce these [natural secondary] penalties" sentence (−5 stands unreduced; Multiattack is A07); fighting defensively's now-verified −4/+2 (A07 stance slice); improvised melee use of bows (noted, no rule invented).
- **Evidence:** 25 new tests named after the SRD headings. 1008 passed / 3 skipped across 121 files; typecheck/lint/touched-file formatting/build/size green; dist 2,054,514 raw / 591,568 gzip (no importer yet — A06 wires the layer into the sheet). A03–A07 remain open.

### P3 damage and critical arithmetic — 2026-09-10 (D-136, A03 closed)

- **A03 extends `tactical.ts`, still pure and diceless** — callers supply rolled values, so every fixture is exact: `effectiveCritThreatMin` (a broken weapon threatens on a natural 20 only and **no expansion re-widens it**, AoN ID 413; otherwise a single doubling re-anchors the range 20→19–20, 19–20→17–20, 18–20→15–20 — Improved Critical/keen "don't stack with any other effect that expands the threat range", so one boolean, never two); `confirmCritical` (the confirmation is "another attack roll with all the same modifiers" — natural 20 always confirms, natural 1 never does, otherwise it must hit AC; it does not need to be a 20 again); `combinedDamageMultiplier` (multipliers are **added**, each contributing one less than its value: ×2+×2⇒×3, ×3+×3⇒×5; a broken weapon's confirmed crit is ×2 whatever its authored multiplier; a crit-immune defender contributes no crit multiplier while non-crit multipliers such as a charge still apply); `damageModifierParts` (the labeled static stack: Str ×1/×1½/×½ by hand, handedness and natural status with bonuses rounded down and **penalties never multiplied** — "the entire penalty applies" off-hand, "not multiplied" two-handed; ranged Str as full (thrown, a thrown melee weapon, the sling exception) / penalty-only (non-composite bow) / none (everything else — a composite bow's rating is authored flat damage, never guessed); enhancement adds to damage but the special-ability equivalent never does, AoN ID 377; broken −2); `resolveDamageRoll` (one weapon-dice roll per multiplier step — "roll the damage (with all modifiers) multiple times and total the results" — every static modifier multiplies with the dice while precision damage and extra damage dice (flaming) are added exactly once; lethal/nonlethal buckets follow the weapon with both swap directions; the minimum rule converts a sub-1 result to 1 point of nonlethal; crit and precision immunities are **separate** defender flags — swarms are crit-immune but take sneak attack, elementals/oozes/incorporeal take neither).
- **Rule correction the encoding surfaced (A02's guard was too narrow):** the −4 lethal-swap penalty was coded for unarmed strikes only; CRB p.191 (AoN ID 172) covers every nonlethal weapon — "a weapon that deals nonlethal damage, **including an unarmed strike**" — and Improved Unarmed Strike waives it for unarmed strikes only, never for a sap or whip. The guard is fixed, the part relabeled "lethal damage with a nonlethal weapon", and the mirror `nonlethalIntent` (−4 with a lethal weapon, no feat waives it) added to `attackModifierParts`/`fullAttackPlan` with pass-through on every call site.
- **Not encoded on purpose:** DR/ER/hardness consume the carried base/precision split in A05; Improved Critical / Power Attack / fighting-defensively wiring is A07 (the `threatRangeExpanded` boolean and `misc` static are the seams); mounted-lance charge multipliers arrive as caller `extraMultipliers` in P06/P08; no dice are rolled anywhere.
- **Evidence:** 32 new tests named after the SRD headings, hand-computed (the two initial failures were test arithmetic — a missed third static application and a one-roll ×2 crit — the code was right). Full suite **1040 passed / 3 skipped** across 121 files; typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist 2,054,514 raw, byte-identical to D-135 (still no importer — A06 wires the layer into the sheet); gzip 594,184 in this environment (D-135's 591,568 figure was measured under another environment's zlib — same raw content). A04–A07 remain open.

### P3 range and splash legality — 2026-09-10 (D-137, A04 closed)

- **Range arithmetic in `tactical.ts` (A04 section):** `rangeIncrementsSpanned` — fractions count as a full increment, pinned by the CRB p.144 dagger example (10-ft increment, target 25 ft away ⇒ 3 increments ⇒ −4); `rangedAttackRange` — −2 cumulatively per increment beyond the first, **no attack at all** beyond the weapon's maximum (5 thrown / 10 projectile / 5 early firearm / 10 advanced), plus the firearm touch-AC window flag (early ≤ 1st increment, advanced ≤ 5th) for the caller's defense selection. The strategic engine's §2.8 range bugs are **not** touched — that path is M01's per the separate-resolvers decision.
- **Melee reach legality (`meleeReachLegality`):** normal weapons strike within natural reach; a reach weapon strikes up to **double** natural reach but never within it (the adjacent dead zone, CRB p.182 + A.5); natural reach 0 (Tiny−) strikes only inside the target's square with the provoke rule named — occupancy enforcement stays P06's. Natural reach itself is caller-supplied from A.5's table.
- **Splash weapons (CRB p.202, AoN ID 197):** the attack is a ranged **touch** attack (`resolvePF1eWeapon` now derives `touch` for splash — an authored `touch:false` cannot opt out); thrown splash weapons take **no** nonproficiency penalty (guard added to `attackModifierParts`); precision damage is rejected outright by `resolveDamageRoll`; grid-intersection targeting is a ranged attack against **AC 5** (`resolveSplashIntersectionRoll`, no threat — no creature, no crit) with no direct-hit damage; a miss scatters via `splashMissScatter` — 1d8 (1 = toward the thrower, 2–8 clockwise), then a number of squares equal to **the range increments of the throw** (per the rule's own worked clarification: a 25-ft throw at a 20-ft increment lands 2 squares off; the A.12 paraphrase "move that many range increments" was garbled and is superseded by the verbatim text). Weapon scatter only — D-130's removal of the invented spell scatter stands.
- **A01 derivation corrected:** a **melee weapon with an authored range increment is thrown at range** — max 5 increments (CRB p.182 "maximum range for a thrown weapon is five range increments"; p.468 "some of the weapons listed as melee weapons can also be used as ranged weapons"). A01 had marked the increment display-only with `maxRangeIncrements = 0`, which refused the SRD's own dagger/spear listing at range; the descriptor's `class` stays "melee" (melee use still ignores increments) and the dead-data issue is gone because the data is live.
- **Not encoded on purpose:** line-of-sight and distance measurement (caller geometry — C01/P03), the occupied-intersection targeting ban (enforced where targets are chosen), splash damage amounts and 5-ft membership (content + C01 area queries), Point-Blank Shot (+1 within 30 ft — A07), and any dice.
- **Evidence:** 21 new tests (19 tactical + 2 weapons-derivation), hand-computed from the verified texts — the dagger/25-ft example, the 45-ft alchemist's-fire −8 ceiling, firearm touch windows at the 1st/5th boundary, the reach dead zone at (5,10] and (10,20], Tiny in-square striking, the full clockwise 1d8 rose from an eastern thrower, the 25-ft/20-ft scatter clarification, and the angled-thrower compass snap. Full suite **1061 passed / 3 skipped** across 121 files; typecheck, lint, touched-file Prettier, build, size, `build:systems` green; dist 2,054,514 raw, byte-identical (no importer yet). A05–A07 remain open.

### P3 defensive mitigation — 2026-09-10 (D-138, A05 closed)

- **`src/packages/pf1e/mitigation.ts` (new, pure):** defender-side DR/ER/immunity/vulnerability/hardness applied to the typed damage components A03 produces. `drAttackFacts` builds the attack's bypass facts (weapon + optional launcher context), `drBypasses` encodes the verified ladder (+1 magic; +3 cold iron/silver; +4 adamantine **without** hardness bypass; +5 alignment; epic = +6 enhancement **or** +6 total effective — special abilities count only there, Bestiary UMR + Mythic/FAQ), `applyMitigation` resolves the whole defense, and `damageComponentsFromRoll` converts an A03 result into components (weapon physical by its bucket; energy riders by `energyType`; precision flagged but still physical — D-129).
- **Verified against primary texts:** DR verbatim (CRB p.561/AoN ID 424 — riders negated only when DR fully negates damage; touch attacks, energy riders and energy drains never DR-negated; spells/SLAs/energy attacks ignore DR; multiple DRs never stack), the ammunition rule verbatim (a +1+ launcher makes the ammo magic and transfers alignment — never the +3/+4/+5 ladder; the ammo's own enhancement does count), ER per attack per type (AoN ID 429), immunity/vulnerability (+50% floored, Bestiary UMR), and object hardness (CRB p.173/AoN ID 126 — subtract once, energy and ranged damage halve **before** hardness, objects immune to nonlethal, actual adamantine ignores hardness but the +4 equivalent does not).
- **Two disputed points resolved with named decisions:** (1) **vulnerability ×1.5 applies before resistance/hardness** — PF1e print is silent (3.5's resist-first frost-giant paragraph was dropped); the Paizo developer rulings (the Iron Gods robot answer) direct "determine the damage the creature would take first." The 3.5 alternative is recorded in D-138, not encoded. (2) **DR applies to nonlethal damage** ("DR makes no consideration whether the damage is lethal or not" — Paizo rules forum) and can negate A03's minimum 1 nonlethal; the strategic `combatEngine.ts` comment claiming DR never applies to nonlethal is wrong and is M01's to fix. The allocation of DR against a mixed lethal/nonlethal attack is unspecified in print — lethal-first, named in the result notes.
- **A03 additive extensions:** `PF1eBonusDamageLine.energyType` (energy riders — DR-immune, ER-mitigated), `bonusContributions` now carry `precision`/`energyType`, and the result exposes `weaponContribution` buckets (post minimum/clamp) so A05 builds the physical component without re-deriving anything. The A.17 paraphrase "DR does negate ability damage/drain… touch attacks" was backwards against the verbatim text and is superseded by it.
- **Not encoded on purpose:** spell resistance (C02), regeneration/fast healing (H03), temp-HP absorption, saving-throw halves (C02), the natural-weapons-of-a-DR-creature count-as-magic/epic rule (caller authoring), and any strategic wiring (M01). Unknown DR tokens never bypass and are named in notes.
- **Evidence:** 22 new tests in `tests/packages/pf1eMitigation.test.ts` (ladder boundaries, the +5-flaming-is-epic-but-not-cold-iron discrimination, ammunition transfer both directions, rider negation, best-of-multiple-DR, per-type ER across components, the vulnerability order with the 30/10 ⇒ 35 worked case, hardness halvings, adamantine-vs-+4, nonlethal object immunity, the A03→A05 seam end-to-end, and validation refusals). Full suite **1083 passed / 3 skipped** across 122 files; typecheck, lint, touched-file Prettier, build, size, `build:systems` green; dist 2,054,514 raw, byte-identical (no importer yet — A06 wires the layer). A06–A07 remain open.

### P3 sheet roll bridge — 2026-09-10 (D-139, A06a slice landed; A06 stays open for A06b)

- **`src/packages/pf1e/rollData.ts` (new, pure):** the sheet-roll bridge — `pf1eAttackRollGroups` (standard attack, one spec per full-attack iterative, damage, crit damage per derived attack line), `pf1eSaveRollSpecs` (Fort/Ref/Will) and `pf1eInitiativeRollSpec`, each with a human breakdown line. Buttons and sheet readout share the one `derivePF1eActor` derivation, so they cannot disagree; the A02–A05 resolver layers are deliberately not consulted for button totals — their importer is the A06b attack-resolution flow where a chosen defense exists. Crit formula = N groups of "dice + static" (`1d8 + 4 + 1d8 + 4`, CRB p.179 via D-136), never `(1d8+4) × 2`; multipliers <2 refused; unarmed-provoke flag from AoN ID 131 with sheet-supplied context (no core shape extension).
- **Flavor rides the existing roll protocol:** optional `RollMsg.flavor` (PROTOCOL.md updated) through `roll`/`rollVerified`, host-sliced to 300 chars on both the plain and commit-reveal paths; ChatPanel renders it as a breakdown line under the total (touched-lines-only patch on the legacy file). PF1eActorSheet Combat tab gains Attack / Full Attack / Damage / Crit buttons per line, save buttons and an Initiative button — all public chat rolls through the existing seeded machinery.
- **Not yet (A06b, the open half of A06):** defense selection, A02 hit resolution, A03 confirmation, A05 mitigation, HP application via the pf1eSheetEdit path, the _Verify_ chip (`rollVerified`), targeting and AoO prompts — nothing in this slice applies damage or writes HP.
- **Evidence:** 12 new tests in `tests/packages/pf1eRollData.test.ts` + 1 host flavor test; 1 new e2e specification (24 collected in `e2e/sheets.spec.ts` across 3 projects, not executed — no browser binaries, D-119 precedent). Full suite **1096 passed / 3 skipped** across 124 files; typecheck/lint/touched-file formatting/build/size/`build:systems` green; dist 2,059,693 raw / 595,828 gzip (+5,179 over D-138, within the 6 MB budget). A06b and A07 remain open.

### P3 attack resolution — 2026-09-10 (D-140, A06 closed)

- **`src/packages/pf1e/resolve.ts` (new, pure):** the composition layer — `pf1eResolveAttack` runs A02's attack roll against the derived AC trio (touch attacks force touch), A03's confirmation on a threat (multiplier <2 downgrades to a normal hit), the minimum-1-nonlethal rule, A05's DR/ER mitigation, and the HP arithmetic with the nonlethal max-HP conversion (regeneration suppresses it, CRB p.191). Dead-at-−Con/dying/disabled/unconscious/staggered are card annotations only — P7 owns the writes; P6 owns the AoO interrupt (the provocation is a note). `pf1eResolvePrepare` is the exported first half the flow orchestrates with. The situational/intent numbers now live once: `tactical.ts` exports `situationalAttackParts` + `damageIntentPenaltyPart` (76/76 existing tests unchanged).
- **`src/ui/sheets/pf1eResolveFlow.ts` (new):** every die is a public host-evaluated roll found back by `flags.core.rollId` (the natural face read from the message terms); a threat rolls the confirmation at the effective bonus; the card is a `messages` create op with `[[total|formula]]` chips; HP writes ride `pf1eSheetEdit` ("hp"/"nonlethalDamage") — a resolver without target ownership narrates but cannot write, and the card says so. The **Verify chip** is the commit-reveal toggle: rolls ride `rollVerified` and the card carries the `verifyCommitRoll` verdict. The PF1eActorSheet Combat tab gains the resolve panel (attack/target/defense with the target's derived trio/flanking/charge/nonlethal/verifiable).
- **Not encoded on purpose:** defender crit immunity and energy immunity/vulnerability (no authored fields — E03/P4), DR facts beyond the mundane default (`attackFacts` is the A07/Weapons seam), riders on derived lines, dying/stable bookkeeping (P7), AoO interrupts (P6).
- **Evidence:** 20 resolver tests (the plan §6.2 discriminating fixtures: the 22/16/17 trio, flanked 18-vs-19 with dropped/doubled controls, min-damage 1 nonlethal + DR bypass + unconscious; the equals-case staggers) + 9 flow tests on a fake client (hit/miss/confirmed-crit formula choice/rejected write/Verify chip from a legitimately verifiable record) + 1 e2e specification (27 collected in `e2e/sheets.spec.ts` across 3 projects, not executed — no browser binaries, D-119). Full suite **1125 passed / 3 skipped** across 126 files; typecheck/lint/touched-file formatting/build/size/`build:systems` green; dist 2,080,869 raw / 602,541 gzip (+21,176 over D-139, within the 6 MB budget). A07 remains open.

## 6. P4 — Effects, conditions and real duration handling

Depends on P3 and D06; keep core EffectDocument unchanged.

### P4 progress — 2026-09-10, token badges + recompute slice (D-147, E06 closed — P4 complete)

- **Badges are read-only derivation, like every stat:** `tokenBadgesFor` assembles a token's chips from the two effect homes — the linked combatant's `flags.core.effects` (combat copy wins id collisions; an under-way encounter, round ≥ 1, wins the token claim) plus the token actor's embedded home — skipping suppressed (disabled) and unparseable documents, sorting SRD conditions (E03 `payload.condition`) first under their condition label. Chips carry a deterministic code ("Flat-Footed" → "FF") and stable tint; the stage renders at most 3 chips + "+N", rebuilding only on a signature change. `App.refresh` feeds them straight from the client replica, so apply/suppress/expire re-render with no invalidation step — recompute-on-effect-change is structural, not a listener.
- **Proven through the real flow, not mocks:** the E06 test applies a +4 Str morale effect (duration 1) to a token-linked combatant, asserts the badge and `deriveFromDocuments` = 14, advances the real `pf1eNextTurn` (core drops it at the owner's turn end), and asserts derivation back to 10, badges gone, and the combatant array's order and initiative values untouched — the R02 initiative policy check: effect changes never re-sort (order is frozen at start; the tracker mutates only state/effects).
- **Evidence:** 10 new tests in `tests/packages/pf1eTokenBadges.test.ts`; full suite **1219 passed / 3 skipped** across 133 files; typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist 2,141,938 raw / 619,453 gzip (+2,367, within the 6 MB budget). **P4 is complete**: E01 apply/persist, E02 editor, E03 conditions, E04 turn boundaries, E05 world clock, E06 badges/recompute all landed on PR #9.

### P4 progress — 2026-09-10, world clock slice (D-146, E05 closed)

- **The clock is a replicated setting, not local state:** the world time is the `clockSeconds` key of the `world-settings` document (the D-113 seam — players read it at LIMITED, GM/ASSISTANT writes), so a joiner reads the same time their buffs are anchored against. Writers are exactly two, both op-driven: the combat tracker's round wrap (applies `pf1eNextTurn`'s `clockDeltaSeconds` when `advanceClockOnRound` is on) and the settings window's GM out-of-combat controls (+1 min/+1 h/+1 day scaled to this world's duration ladder, plus a reset that sweeps nothing — a backward jump expires nothing).
- **Durations anchor at apply:** payloads now stamp `appliedAtClock` (validated, round-tripped through `readTacticalEffect`), so round/minute/hour effects — whose `flags.core.duration` ticks stay the turn engine's in-combat consumer (E04) — can also be ended while _out_ of combat; `day` (2 400 rounds = 24 of this world's hours under the landed `ttlToTicks` abstraction) has the clock as its only consumer; instant/concentration/permanent are never clock-counted. The sweep only removes, never rewrites durations — an effect the turn engine consumed first is simply already gone, and pre-E05 unanchored effects are refused a guessed anchor.
- **Evidence:** 21 new tests in `tests/packages/pf1eWorldClock.test.ts` (read normalization + joiner merge, create/no-op/clamp op shapes, the wrap→clock integration through a real `pf1eNextTurn` wrap, the tick ladder incl. per-level and configured round lengths, anchor stamping through `buildEffectDoc` and the authorized apply ops, minute/per-level/day boundaries, legacy and non-counted survival, both sweep homes incl. unparseable-effect preservation, validator range rule, readout format). Full suite **1209 passed / 3 skipped** across 132 files; typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist 2,139,571 raw / 618,239 gzip (+4,235, within the 6 MB budget). Remaining open in P4: E06 (token condition icons + recompute-on-effect-change).

### P4 progress — 2026-09-10, turn-boundary durations slice (D-145, E04 closed except per-level conversion)

- **No double-decrement, by construction:** core's `nextTurn` ticks every duration (including `endsOn: "round-start"` payloads) at the owner's turn end — the opposite of the intended round-start semantics. `pf1eNextTurn` therefore restores the ending owner's round-start effect documents from the input combat (captured before the advance) and strips core's expiry records for them, then decrements each carrier's remaining duration exactly once per round wrap, dropping at ≤ 0. A four-step timeline test proves the interleave: own-turn ttl 3 and round-start ttl 2 on the same carrier decay on their own boundaries only.
- **Concentration/sustained lapse (A.16):** a payload with `concentration: true` is dropped when the owner's turn ends with `actions.standardUsed === false` — an unmaintained concentration effect lapses even if it has no duration key (core never ticks those). Lapsed effects are reported in the new `lapsed` return (`{combatantId, effectId}[]`), and are filtered out of `expired` so the two lists stay disjoint. Sustaining (spending the standard) keeps the effect at its pre-wrap value; the next wrap ticks it.
- **Inert markers stay inert:** round-start ids require a remaining duration (`durationLeft !== null`); an undurationed round-start marker (e.g. a flavor "marked") is never restored or ticked — tested.
- **Evidence:** 10 new tests in `tests/packages/pf1eTurnBoundaries.test.ts` — the 4-step timeline, core-equivalence on effect boundaries, inert markers, sustain/lapse/combined, the surprise-round short-circuit, and durationLeft derivation through the real `readTacticalEffects`. Full suite **1188 passed / 3 skipped** across 131 files; typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist 2,135,336 raw / 616,970 gzip (+1,439, within the 6 MB budget). Remaining open in P4: per-level conversion (with E05's clock), E05 (the replicated world clock), E06 (token condition icons + recompute-on-effect-change).

### P4 progress — 2026-09-10, condition library slice (D-144, E03 closed)

- **27 conditions as payloads:** `src/packages/pf1e/conditions.ts` encodes the canonical combat conditions (E03's 26 + Staggered) as validated `flags.pf1e` payloads — typed mods, structural flags, and action deny tokens — so the P0 derivation/stacking/expiry machinery consumes them with zero new rules code. Every number was transcribed from the canonical Conditions text fetched for this slice (R02 discipline); the in-repo A.14 modifier table agrees.
- **The pairs do not conflate:** fatigued −2 vs exhausted −6 Str/Dex; shaken/frightened (attack+saves, forced flee as note) vs panicked (saves only — the panicked attack roll is not penalized); stunned (−2 AC + denied Dex + no AoOs) vs dazed (no AC change); grappled (attack/CMB/Dex penalties) vs pinned (denied Dex + −4 AC, narrower actions, no stacking); prone (−4 melee attack; the ranged/melee AC split is a named attacker-side note, not an invented mod). Fear penalties are typed morale, so fear never stacks with fear (tested through the real resolver: shaken+frightened ⇒ −2; shaken+sickened ⇒ −4).
- **The immunity hook:** fear + Confused tag mind-affecting; `conditionRefusalFor` refuses against `immuneMindAffecting`/`immune.conditions`, and the Effects tab's new condition quick-apply row surfaces the refusal as a visible error. Applying a condition = applying the payload through D-142's authorized ops path.
- **Evidence:** 20 new tests; full suite **1178 passed / 3 skipped** across 129 files; typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist 2,133,897 raw / 616,537 gzip (+13,175, within the 6 MB budget). Remaining open in P4: E04 (turn-end/round-start expiry + concentration/sustained), E05 (the replicated world clock), E06 (token condition icons + recompute-on-effect-change).

### P4 progress — 2026-09-10, custom effect editor slice (D-143, E02 closed at the logic level)

- **The editor covers the whole payload:** `PF1eEffectEditor.svelte` + the pure `pf1eEffectEditorModel` author typed mod rows (closed key list, per-mod source for untyped/circumstance stacking), damage boosts (dice/sides/flat/energy/precision), deny/grant tokens, the immunity block, flat-footed/denied-Dex/no-AoO flags, stacking groups, concentration, ttl (unit/value/per-level/ends-on) and the origin block. Empty numerics are absent, garbage numerics are named errors — never a silent zero — and the request revalidates through the P0 validator before any write. "Open-ended stat keys" was resolved against P0's closed `PF1E_MOD_KEYS`: a key the derivation cannot consume would be a stored no-op; custom buffs stay first-class through the free-form fields.
- **Edits are in place:** new `pf1eEditActorEffect`/`pf1eEditCombatantEffect` keep the effect id and suppression state, swap the validated payload and re-seed the duration from the edited ttl; the sheet routes each edit to the effect's current home (combatant map wins, matching the read side). The Effects tab list gained per-effect Edit; the round-trip (effect → form → request → doc → read) is tested fact-preserving both ways.
- **Token application landed (the T01 deferral resolved):** the token context menu's "Apply effect…" entry appears for PF1e-linked tokens, is gated by actor ownership (players included — same `can(update, actor)` as the sheet), and opens that actor's sheet directly on the Effects tab via the new optional `tab` on `openPF1eSheetWindow` → window data → `PF1eActorSheet.initialTab`. Non-PF1e tokens keep the entry disabled with the reason visible.
- **Evidence:** 9 new editor tests + extended token-menu fixtures; full suite **1158 passed / 3 skipped** across 128 files; typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist 2,120,722 raw / 612,628 gzip (+17,317, within the 6 MB budget); e2e 159 collected across 28 files (new editor flow spec, not executed — D-119 precedent). Condition mechanics remain E03.

### P4 progress — 2026-09-10, effect apply/persist slice (D-142, E01 closed at the logic level)

- **The write path exists:** `src/packages/pf1e/effectOps.ts` is the single sanctioned place that turns a `PF1eEffectPayload` into an `EffectDocument` (validated payload, empty `changes`, `flags.core.duration` seeded from the ttl) and Ops for both homes core already reads — the actor's embedded `effects[]` and the combatant's `flags.core.effects` map that `core/combat.ts` ticks at the owner's turn end and the CombatPanel badges. Apply/suppress/restore/remove for both homes carry the sheet/tracker's own permission gates, refuse duplicate ids, and cap at 50 with named errors.
- **The read side is bridged:** `combinedTacticalEffects` merges the homes with the ticking combatant copy winning an id collision (the embedded twin is shadowed, not deleted); `pf1eSheetView(actor, { combat, combatantId })` takes the linked encounter, so sheet numbers and tracker badges cannot disagree. Expiry needs no undo: the acceptance test drives a real 2-round effect through `startCombat`/`nextTurn` and proves the base derivation returns when the owner's turn-end tick exhausts it (other combatants' turns never tick it).
- **Denies and boosts found their consumers:** deny tokens refuse spends in `actionRefusal`/`spendAction`/`spendCombatantAction` by action id or kind (computed per combatant from the linked actor's combined effects; "aoo" stays inert for P6), and effect damage boosts append named rider terms to the Combat tab's damage rolls — never multiplied on a critical, with the caveat note on the crit roll.
- **UI:** the new Effects tab (`PF1eEffectsTab.svelte`) proves the path end-to-end — typed form (one mod row from the closed key/type lists, ttl, condition label, actor-vs-combatant home), the R02-verified Bull's Strength preset, suppress/enable/remove. The open-ended editor stays E02; condition math stays E03; clock/round-start expiry stays E04/E05.
- **Evidence:** 14 new tests in `tests/packages/pf1eEffectOps.test.ts`; full suite **1149 passed / 3 skipped** across 127 files; typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist 2,103,405 raw / 607,994 gzip (+14,112, within the 6 MB budget). Browser acceptance pending (no browser binaries in this environment, D-119 precedent).

- [x] **E01 — Persist/apply effects through PF1e helpers** using actor embedded effects and combatant effect references expected by core badge/tick code; resolve typed/source stacking, penalties, suppression, boosts and action denies. (I P4; G §4.2; B §6.3) — **logic-complete 2026-09-10 (D-142)**: `effectOps.ts` writes both homes (actor-embedded + `combatant.flags.core.effects`) as authorized Ops; `combinedTacticalEffects` bridges the ticking combatant copy into `pf1eSheetView`; deny tokens gate `actionRefusal`/`spendCombatantAction` and boosts join the damage rolls. Browser acceptance of the Effects tab pending.
- [x] **E02 — Build custom effect editor/application flow:** name/icon, open-ended stat keys, typed/source groups, conditions, boosts/denies, origin, duration units/per-level/end boundary, concentration/sustained flags; support token application and player permissions. (I P4) — **logic-complete 2026-09-10 (D-143)**: full-payload editor (typed mod rows, boosts, deny/grant tokens, immunity block, structural flags, stack group, concentration, ttl with endsOn, origin); "open-ended keys" resolved against P0's closed `PF1E_MOD_KEYS` (a key the derivation cannot consume would be a silent no-op); in-place edit ops preserve id/suppression and re-seed duration; token menu "Apply effect…" opens the actor's sheet on the Effects tab, gated by actor ownership. Condition _mechanics_ stay with E03.
- [x] **E03 — Complete the mathematical condition library** including flat-footed, prone, blinded/invisible, entangled, grappled/pinned, stunned/dazed, dazzled, shaken/frightened/panicked, fatigued/exhausted, sickened/nauseated, helpless/cowering, disabled/dying/stable/unconscious, paralyzed/petrified/confused and mind-affecting immunity. Do not conflate conditions with different consequences. (I P4; G §3/Appendix A.14; B §4.5) — **done 2026-09-10 (D-144)**: 27 conditions (the 26 enumerated + Staggered) encoded as effect payloads in `conditions.ts`, transcribed from the canonical Conditions text fetched this slice; fear typed morale (fear doesn't stack with fear), everything else untyped-with-source; severity/adjacent pairs have discriminating fixtures; the mind-affecting/named immunity hook refuses applications visibly. Geometry-dependent consequences (concealment, dex-0 statics, prone AC split, forced flee) are per-definition notes aimed at their owning P/C phases.
- [x] **E04 — Wire turn-end and round-start expiration**, per-level conversion, concentration interruption and sustained-action maintenance; reuse core ticking without double-decrementing. (I P4) — done 2026-09-10 (D-145): owner-turn-end restore of round-start effects + single decrement on round wrap; unmaintained concentration lapses when the owner's turn ends without a spent standard (A.16); `pf1eNextTurn` reports `lapsed`. Per-level conversion remains open (E05-adjacent, with the clock).
- [x] **E05 — Advance the replicated clock** on configured round boundaries and GM out-of-combat time controls; implement minute/hour/day expiration and consistent joiner readback. Never write the clock only to local storage. (I P4 corrected by §10) — done 2026-09-10 (D-146): `clockSeconds` on the replicated `world-settings` document; the tracker's round wrap and the settings window's GM controls are the only writers; round/minute/hour/day payloads anchor `appliedAtClock` at apply and a sweep ends them from both homes when the clock passes their end.
- [x] **E06 — Recompute UI/roll statistics on effect changes**, render token condition icons/badges, and prove expiry restores base values. Verify initiative policy under R02 before any re-sort behavior. (I P4/S2) — done 2026-09-10 (D-147): badges derive on read from both effect homes into canvas chips; the real-flow test proves expiry clears badges and restores base derivation; initiative order verified frozen (no auto re-sort).

## 7. P5 — Spellcasting, targeting and awareness

Depends on effects, attacks, action foundations and verified rule fixtures. Tactical targeting and strategic spell resolution remain independent implementations using common spell data.

### P5 progress — 2026-09-11, touch criticals confirm and willing targets auto-touch (D-159, C03 partial)

- **Critical confirmation is live on touch attacks.** R02 transcribed the CRB
  "Critical Hits" section (Rules ID 131, "Attack", pg. 182) first: a natural
  20 threatens; confirming is "another attack roll with all the same
  modifiers as the attack roll you just made" against the same touch AC; the
  multiplier is ×2 ("roll your damage more than once ... and add the rolls
  together"). Both the cast-time touch attack and the held-charge delivery
  roll the confirmation on a threat — but only when the spell deals damage
  ("as long as the spell deals damage", Rules ID 133), and the doubled total
  feeds the shared pipeline before SR/save/energy resistance. An
  unconfirmed threat stays a regular hit.
- **Willing targets are auto-touched.** "You can automatically touch one
  friend or use the spell on yourself" (Rules ID 133) and "You can touch one
  friend as a standard action" while holding the charge: both flows take a
  `willing` declaration and skip the attack roll entirely — no dice, the
  effect resolves (or the charge discharges) directly. The sheet gains a
  willing checkbox in the cast panel and an Auto-touch button on the
  held-charge panel next to Deliver/Dissipate.
- **Pure layer pins the rulings:** `touchCriticalNeedsConfirmation` (threat ∧
  damage-dealing) and `criticalDamageTotal` (×2) in
  `src/packages/pf1e/touchSpell.ts`; the confirmation roll itself reuses
  `resolveTouchAttack` since it carries all the same modifiers.
- **Executed browser proof:** a 3rd test in `e2e/pf1e_touch.spec.ts`
  (Chromium, **86/86** overall), fully deterministic because no dice are
  involved: the authored Chill Touch charge is auto-touched onto a willing
  ogre (panel gone, card narrates the automatic touch, no touch-attack chip),
  then a melee touch cast of Shocking Grasp with the willing checkbox skips
  the attack too and holds no charge. Random-die paths (threat/confirmation
  branches) stay pinned by 9 new unit tests — 7 in
  `tests/ui/pf1eTouchFlow.test.ts` (confirmed crit doubles damage, threat
  unconfirmed stays regular, damageless threat skips confirmation, willing
  cast and delivery) and 2 pure-layer tests.
- **Still open for C03 (stays unchecked):** unarmed/natural-weapon delivery
  of a held charge, touching up to six friends as a full-round action,
  multi-charge touch spells (Chill Touch's extra charges), attacks of
  opportunity against ranged-touch casters, multi-round casting,
  swift/quickened/metamagic timing, and the remaining Table 9-1 UI triggers.
- **Evidence:** unit **1462 passed / 3 skipped** across 144 files; typecheck
  /lint/touched-file Prettier green; dist **2,220,480 raw / 646,400 gzip**;
  Chromium e2e **86/86** (+1).

### P5 progress — 2026-09-11, touch spells and held charges ride the actor document (D-158, C03 partial)

- **The C03 touch half is now live.** R02 transcribed the CRB "Cast a Spell"
  touch section first (touch spells in combat, touch attacks, holding the
  charge, ranged touch); `src/packages/pf1e/touchSpell.ts` encodes it as pure
  functions — `resolveTouchAttack` (d20 + BAB + the matching ability mod +
  size attack bonus versus derived touch AC: full AC minus armour, shield and
  natural armor; critical-threat confirmation stays out of slice), and
  `PF1eHeldCharge` with a null-tolerant `heldChargeFromSystem` reader.
- **The charge rides the actor document.** `system.pf1e.heldCharge` is an
  optional authored field (name, level, damage formula, save type/severity);
  casting a touch-range spell that misses holds the charge, and **any later
  cast dissipates it** with a warning on the card — both paths are tested.
  A miss costs the slot and posts a card naming the held charge; a hit runs
  the shared damage→SR→save→HP pipeline under a touch-attack line.
- **Delivery is its own flow.** `resolveTouchDelivery` re-reads the freshest
  documents, refuses when the caster's DC for the charge's level is
  unavailable or ownership fails, rolls the touch attack against the same
  derived touch AC, and on a hit delivers the full pipeline and clears the
  charge; a miss keeps it. The sheet shows a held-charge panel with Deliver
  (needs a target) and Dismiss handlers.
- **Store-roundtrip repair found by the e2e pass.** Clearing the charge must
  emit the repo's `-=` delete marker (`{"-=system.pf1e.heldCharge": null}`)
  — `applyDiff` writes a literal `null` otherwise, which fails the actor's
  re-parse and blanks the whole derived block (slots readout gone, DCs null).
  The parser now also treats `heldCharge: null` as absent, and a new
  write→clear→re-parse regression test pins the round-trip.
- **Executed browser proof:** `e2e/pf1e_touch.spec.ts` (Chromium, **85/85**
  overall): casting another spell dissipates an authored Chill Touch charge
  with the warning and the panel gone; a touch cast of Shocking Grasp spends
  the slot, posts the melee-touch line against touch AC 9, then conditionally
  delivers the held charge or keeps the panel. Rules arithmetic stays pinned
  by 20 new unit tests (9 in `tests/packages/pf1eTouchSpell.test.ts`
  including the store round-trip, 11 in `tests/ui/pf1eTouchFlow.test.ts`
  covering both flows and the ownership/DC refusals).
- **Still open for C03 (stays unchecked):** critical-threat confirmation on
  touch attacks, unarmed/natural-weapon delivery, the six-friends full-round
  touch, multi-target touch spells (Chill Touch's extra charges), attacks of
  opportunity against ranged touch casters, multi-round casting,
  swift/quickened/metamagic timing, and the remaining Table 9-1 UI triggers.
- **Evidence:** unit **1453 passed / 3 skipped** across 144 files; typecheck
  /lint/touched-file Prettier green; dist **2,217,984 raw / 645,780 gzip**;
  Chromium e2e **85/85** (+2).

### P5 progress — 2026-09-11, the C03a casting gate wired into the cast path (D-157, C03 partial)

- **The D-150 layer is now product-reachable.** D-150 encoded C03's pre-save
  gate as pure functions (`concentration.ts`: component parsing with
  per-tradition `M/DF` resolution, named legality refusals, per-item arcane
  spell failure, deafened spoilage, Table 9-1 concentration) but nothing in
  the product called it. D-157 wires it into the D-156 cast flow with **zero
  new rule encoding** — `resolveCastFlow` gains an optional `gate` input and
  delegates every ruling to `resolveCastingAttempt`.
- **Ordering preserved.** The gate's diceless half (component parse +
  legality) runs in the validation block: an illegal casting is refused by
  name **before any die rolls and spends nothing**. The dice half (d100 for
  armour failure when it applies, d100 for deafened spoilage, one d20 per
  declared concentration trigger) rolls after slot/prepared bookkeeping and
  before the effect rolls. A ruined spell still spends its slot and prepared
  row — "you lose the spell just as if you had cast it to no effect" — posts
  a `Spell lost` card naming the failed check, and skips damage/SR/save/HP.
- **Authoring.** Prepared rows gain an optional `components` line and the
  spells block an optional `tradition` ("arcane" | "divine", both validated);
  the prepare form authors the line, the row displays it, and a pinned row
  prefills the cast panel's gate. Armour failure reads the authored
  `armor.spellFailure` for arcane casters only (a spell without a somatic
  component is exempt, per the table); the concentration check adds the
  derived `concentration` bonus and key ability modifier to caster level.
- **The sheet panel** gains the gate fieldset: components line, casting time,
  cannot speak / no free hand / components not in hand / deafened /
  grappling / pinned, casting defensively, and injured-while-casting with
  the damage taken. Of Table 9-1's eleven situations these two cover the headline C03
  cases; the rest remain available in the pure layer.
- **Executed browser proof:** a 4th test in `e2e/pf1e_cast_flow.spec.ts`
  (Chromium, **83/83** overall): a silenced caster's V/S cast is refused with
  the named reason, no slot spent, no prepared expense, no card; the same
  cast with the voice restored passes the gate silently and lands. The first
  cast-flow test now also rides the gate's pass path via the prepared row's
  components line. Rules arithmetic stays pinned by 15 new unit tests in
  `tests/ui/pf1eCastGate.test.ts` (legality refusals, malformed lines, ASF
  ruin/pass/no-somatic/divine-exempt, deafened spoilage both ways, defensive
  casting pass/fail, injured trigger DC, `M/DF` tradition split, empty-line
  gate skip) plus one schema test.
- **Still open for C03 (stays unchecked):** touch/held charges, multi-round
  casting, swift/quickened/metamagic timing, threatened-casting attacks of
  opportunity, the remaining Table 9-1 UI triggers, per-item ASF exemptions
  and shield ASF authoring, and condition-driven caster state (the panel's
  checkboxes are the GM's declaration). C05's profile-driven payloads remain
  the area/multi-target path.
- **Evidence:** unit **1432 passed / 3 skipped** across 142 files; typecheck
  /lint/touched-file Prettier green; dist **2,206,360 raw / 643,280 gzip**;
  Chromium e2e **83/83** (+1).

### P5 progress — 2026-09-11, tactical casting/save flow slice (D-156, C02 closed)

- **The cast flow.** `src/ui/sheets/pf1eCastFlow.ts` (new) orchestrates one
  chosen-target cast end to end on top of D-149's pure layer (`casting.ts`):
  `resolveCastFlow(client, user, params)` validates slot and prepared state
  **before any roll is made**, rolls damage → SR check → save in that order
  (each via the host roll service), posts a single `cast resolution` card,
  then submits the card op first and the state writes (slot/prepared/HP, plus
  the SR ledger) as one batched op. DC comes from the caster's derived
  `spellSaveDc[level]` (null → named refusal, no roll); severity is the full
  `PF1E_SAVE_SEVERITIES` set (negates/half/partial/disbelief/none); Evasion
  and Improved Evasion read from the target's authored feats through
  `hasPF1eFeat`; per-type ER feeds `resolveSpellTarget`'s defender block; SR
  uses `spellResistanceCheck` (no natural-roll auto outcomes by design). The
  card text names caster, spell, level, target and DC, carries
  `[[total|formula]]` chips, an HP-transition line ("PF Ogre 20 → 15 HP."),
  and ⚠ lines for over-budget or otherwise-warned effects.
- **Target-specific resistance bookkeeping.** `src/packages/pf1e/srLedger.ts`
  (new, pure) keeps the round-scoped SR ledger on the combat document:
  `flags.pf1e.srOvercome` maps `"casterId:targetId" → round`, so a caster who
  overcame a target's SR this round does not re-roll it on later casts this
  round; a new round re-rolls; outside combat every cast rolls. The GM can
  force a re-roll per cast (`srOvercomeByCaller`). All reads/writes go
  through the four pure helpers (`srOvercomeKey`/`srAlreadyOvercome`/
  `srOvercomeDiff`/`srOvercomeBlobFromFlags`).
- **The sheet wiring.** `PF1eActorSheet.svelte` gains a cast panel on the
  Spells tab (save type, severity, damage formula, energy type, SR-override
  checkbox, target picker) plus a per-prepared-row Cast button that pins the
  panel to that row — name, level and slot ride the prepared row, and a
  successful cast expends it. Over-budget casting stays warn-not-refuse per
  C04, with the warning shown in the panel, the ledger row and the card.
- **Executed browser proof:** 3 new tests in `e2e/pf1e_cast_flow.spec.ts`
  (Chromium, **82/82** overall): a harmless over-budget cast spends the slot
  (5→6 of 5), expends the prepared row, disables its Cast button, pins the
  panel, warns in ledger + panel, and posts the no-save card; a damaging cast
  rolls host dice, lands the target's HP within the 2d6 range with the
  transition line, and the summary reads `1st 6/5`; refusals (no target, bad
  dice) are named and spend nothing. Rules arithmetic stays pinned by 18 new
  unit tests — 4 in `tests/packages/pf1eSrLedger.test.ts`, 14 in
  `tests/ui/pf1eCastFlow.test.ts` (validation order, roll order, DC null
  refusal, all severities, Evasion/Improved Evasion, ER halving + floor, SR
  reuse/re-roll/override, card content).
- **Still open for P5:** multi-target and area casts ride C05's
  profile/pack-driven payloads (one chosen target per cast today);
  components, concentration, touch/holding, multi-round and metamagic timing
  are C03; resting/recovery stays manual (P7).
- **Evidence:** unit **1416 passed / 3 skipped** across 141 files; typecheck
  /lint/touched-file Prettier green; dist **2,198,130 raw / 641,330 gzip**;
  Chromium e2e **82/82** (+3).

### P5 progress — 2026-09-11, persisted slot ledger + spellbook sheet slice (D-155, C04 closed)

- **The daily state now rides the actor document.** D-152 shipped the pure
  ledger (`spendSlot`, `reviewPreparation`, `slotLedgerView`, Table 1-3
  bonuses, `10 + spell level` minimum) but nothing consumed it. D-155 adds
  the authored schema it was missing: `system.pf1e.spells.slotsUsed`
  (level→spent integers, keys validated 0–9, non-negative) and
  `system.pf1e.spells.prepared` (name/level/optional `slotLevel`/`expended`
  rows, capped at `MAX_PREPARED_SPELLS` 200), validated in the same actor
  block that guards the rest of `system.pf1e`.
- **One edit surface, one read surface.** `src/ui/sheets/pf1eSpellbook.ts`
  (new) follows the Weapons-tab contract (D-117): `pf1eSpellbookView` maps
  the actor + derivation onto `slotLedgerView`/`reviewPreparation`, and
  `pf1eSpellbookEdit` builds ownership-gated Ops — dotted
  `slotsUsed.<level>` writes that preserve siblings (full materialization on
  first spend), array replacement for the prepared list, named errors, and
  over-budget spends written with a warning rather than refused (C04's
  "warnings, not hard enforcement"). Restore clamps at zero as a no-op;
  spontaneous casters get no prepared list.
- **The Spells tab.** `PF1eActorSheet.svelte` gains a casting-only `spells`
  tab: per-granted-level base/total/spent/remaining rows with Spend/Restore,
  the prepare form (name, spell level, optional cast slot), expend-toggle +
  remove per prepared row, and the preparation warnings. The summary tab's
  slot readout now projects the persisted ledger through the same
  `pf1eSpellSlotReadout` adapter the e2e surface calls.
- **Executed browser proof:** 4 new tests in `e2e/pf1e_spellbook.spec.ts`
  (Chromium, 79/79 overall): the adapter projects authored `slotsUsed`/
  prepared counts and over-budget warnings; a full store round-trip —
  spend×2, restore, overuse to 6 of 5 with the visible warning, prepare,
  expend, remove, and the summary reading `1st 6/5`; a non-caster shows no
  tab; zero page errors. Rules arithmetic stays pinned by
  `tests/packages/pf1eSpellSlots.test.ts`, edit builders by 15 new tests in
  `tests/ui/pf1eSpellbook.test.ts`.
- **Still open for P5:** cast→spend coupling and chosen targets arrive with
  the C02 casting UI (the preview overlay's consumer); resting/recovery
  automation is P7 — until then Restore is the manual reset. Cone/line stay
  refused under C01b.
- **Evidence:** unit **1398 passed / 3 skipped** across 139 files; typecheck
  /lint/touched-file Prettier green; dist **2,185,403 raw / 637,840 gzip**;
  Chromium e2e **79/79**. D-152's tree-shake gap closed in the bundle:
  `"no slots granted at that level"` and `"which grants no slots"` now each
  grep to 1 in `dist/index.html` (both were 0), so the ledger layer is
  reachable from the product, not just the tests.

### P5 progress — 2026-09-11, canvas preview overlay slice (D-154, C01 closed)

- **One seam for the overlay:** `src/packages/pf1e/areaPreview.ts` (new, pure)
  composes D-148's targeting into `pf1eAreaPreviewModel` — scene grid +
  tokens + wall segments in, world-space cell rects + affected token ids +
  highlight rects + label out, or `ok: false` with named issues. The canvas
  layer, any future casting UI and the e2e surfaces all consume this one
  function; nothing re-derives the chain.
- **The overlay itself:** `src/canvas/layers/AreaPreviewLayer.ts` draws the
  cell fills and a highlight ring per affected token, version-keyed, with
  `rectCount`/`highlightCount` readbacks. It rides the controls holder —
  local caster UI, never a replicated document — so the §9 `LAYER_ORDER`
  constant and the `canvasSmoke` layer-order assertion stay untouched.
  `App.svelte` owns the preview state; a scene switch clears it rather than
  repainting stale cells.
- **Surfaces + executed browser proof:** `GmFogSurface.pf1eAreaPreviewShow/
Clear/State` drive the loop in Chromium (75/75): the burst that is exactly
  the added token's 2×2 draws 4 rects + 1 highlight, a refused cone is
  reported and never drawn, clear empties the overlay, zero page errors.
- **Cone/line still refused, now visibly:** the model returns the named C01b
  issue for them; their square-grid discretization stays contested
  (transcribe-before-encoding, R01). Cover _modifiers_ remain P04; the
  preview's wall respect is the LoE C01 asks for.
- **Evidence:** 7 new tests in `tests/packages/pf1eAreaPreview.test.ts`; full
  suite **1383 passed / 3 skipped** across 138 files; typecheck/lint/
  touched-file Prettier green; dist **2,173,082 raw / 629,122 gzip**;
  Chromium e2e **75/75**. The preview's in-product consumer arrives with the
  C02 casting UI.

- [x] **C01 — Add pure grid targeting + canvas preview overlay:** burst, cone, line, emanation, spread/cylinder where supported; scene distance/units/diagonals, affected-token highlighting, walls/line of effect and cover. (I P5; G §4.10; B §4.4) — **done 2026-09-11 (D-148 pure layer + D-154 overlay):** burst/emanation/cylinder/spread with 5-10-5 counting, far-corner inclusion, scene grid bridging, wall line-of-effect; `pf1eAreaPreviewModel` is the single seam, rendered by `AreaPreviewLayer` (controls holder) with affected-token highlight rings, browser-tested in Chromium. Cone/line stay refused under their named C01b issue (contested square-grid discretization — transcribe-before-encoding, R01); cover as a targeting _modifier_ is P04's positional defenses (the preview respects walls via LoE, which is C01's ask).
- [x] **C02 — Implement tactical casting/save flow:** chosen targets, DC from spell level/key ability/focus, Fort/Ref/Will, save-negates/half/no-save distinctions, Evasion/Improved Evasion, per-type damage/ER and SR without natural-roll auto outcomes. Respect target-specific resistance bookkeeping. (I P5; G §2.11/Appendix A.16; M Task 5) — **done 2026-09-11 (D-149 rules layer + D-156 flow and UI):** D-149 encoded DC/saves/ER/SR/evasion as pure functions (`casting.ts`); D-156 wires them into the product: `resolveCastFlow` in `src/ui/sheets/pf1eCastFlow.ts` validates slot/prepared state before any roll, rolls damage → SR check → save in order, posts a host card with the HP-transition line, then writes slot/prepared/HP in one batched submit. The round-scoped SR ledger (`src/packages/pf1e/srLedger.ts`, `flags.pf1e.srOvercome` on the combat doc, GM override flag) is the target-specific resistance bookkeeping. One chosen target per cast; area payloads and multiple simultaneous targets ride C05's profile-driven cast, components/concentration/touch-charge timing ride C03.
- [ ] **C03 — Implement concentration/components and timing:** defensive casting versus taking-damage checks, spell loss, threatened casting, armor spell failure, verbal/somatic/material/focus requirements, touch/held charge, multi-round casting, swift/quickened/metamagic timing. Validate dubious source restrictions under R02. (I P5; G §4.10; B §4.4)
- [x] **C04 — Add level 0–9 spellbook/preparation/slot readouts**, prepared versus spontaneous data and bonus slots; MVP overuse produces warnings, not hard enforcement. (I P5; B §6.2) — **done 2026-09-11 (D-152 rules layer + D-155 persistence and UI):** the 0–9 readout with Table 1-3 bonus slots and prepared/spontaneous data shipped in D-152; D-155 persists the daily state on the actor (`system.pf1e.spells.slotsUsed`, `.prepared`, both validated), adds the sheet's Spells tab (Spend/Restore per granted level, prepare/expend/remove rows) built on the tested `spendSlot`/`reviewPreparation`/`slotLedgerView` layer, and keeps overuse as warnings rather than refusals. Cast→spend coupling landed with D-156's casting flow.
- [ ] **C05 — Replace hardcoded strategic Fireball with profile/pack-driven cast payloads** for location, shape, range, radius, CL, DC, dice and targets; use the agreed 20-ft Fireball. Remove or explicitly document scatter under R03 and keep spatial membership/ranges consistent if displacement remains. (G §5; I P5; M Task 5)
- [ ] **C06 — Connect Stealth/Perception to host detection and ambush state:** verified distance/environment/cover modifiers, spatial queries and hidden-target legality; distinguish presence detection from locating/seeing a target. (B §§4.2, 6, 9; G §4.5–4.6)
- [ ] **C07 — Add verified sensory-mode behavior** for normal/low-light/darkvision, scent, tremorsense, blindsight and true seeing, with appropriate ranges, lighting/LOS/concealment exceptions and faction projection. Avoid treating distinct senses as interchangeable. (B §§4.2, 10)
- [ ] **C08 — Define and document mass stealth aggregation** (unit-level policy and entry-triggered checks) rather than per-model all-pairs checks; test ambush/flat-footed effects and scale cost. (B §§4.2, 7)

### P5 progress — 2026-09-11, pure grid targeting slice (C01a; decision backfilled as D-148)

- **Rules verified before encoding (R02), because the Gap List has no spell-shape appendix:** AoN Rules ID 212 "Aiming a Spell" (CRB pp.214–216) transcribed and cross-checked against d20pfsrd.com/magic and d20srd.org. This is the transcribe-before-fixtures step R01 filed for TWF/Charge, applied to the missing area tables.
- **`src/packages/pf1e/targeting.ts` (new, pure, cell coordinates — no Pixi import):** burst, emanation, cylinder and spread. Counting reuses the existing `cellDistance` (`src/canvas/grid/measure.ts`) instead of adding a second distance kernel, and all sizes come from a caller-supplied `PF1eAreaGrid {cellSize, feetPerCell, diagonals}` — scene metadata, not hardcoded 5/15/30 (P01).
- **The inclusion rule is the far-corner rule,** the only reading that reproduces the published templates: a 5-ft. radius from an intersection covers exactly the four cells sharing that corner (a 10-ft. square), and a 15-ft. radius covers the canonical 24-cell burst (rows 2/4/6/6/4/2). Both are hand-derived fixtures, not captured outputs (V01). Near-corner and cell-centre readings are pinned as wrong by the same fixtures.
- **Line of effect** is a 5-probe (4 corners + centre) test where any unblocked probe wins, because total cover means _no_ line reaches the square; bursts "don't extend around corners", and the "hole of at least 1 square foot does not block" clause needs no special case since this model authors such a barrier as two segments with a gap. `hasLineOfEffectToOrigin` enforces "you must have a clear line of effect to the point of origin of any spell you cast" before placement.
- **The cylinder/LoE contradiction is reconciled explicitly, not silently:** AoN 212 says both that a cylinder "ignores any obstructions within its area" and that it needs LoE "from its origin (… a cylinder's circle …)". Encoded reading: LoE to the point of origin is required, after which the cylinder fills its whole circle — so per-cell LoE is not applied to cylinders. One fixture pins the split against a single wall (burst loses everything behind it, cylinder keeps it all).
- **Spread is path cost, not radius:** Dijkstra over `(cell, diagonal-parity)` with diagonal steps alternating 1/2, reproducing `ortho + diag + floor(diag/2)` exactly, counting "around walls, not through them" and refusing diagonals across blocked corners. The four cells around the origin intersection seed at cost 1 (the effect starts at the intersection), so a 5-ft. spread matches the 5-ft. burst's 2×2. A spread legitimately reaches further diagonally than a burst of equal radius — at 25 ft it includes (3,3), which the burst's far-corner rule excludes.
- **Cone and line refused on purpose (C01b).** Their grid discretization is genuinely unsettled and encoding either would be inventing a rule: the cone's published templates disagree (1/2/3 vs 2/4/6 rows for 15 ft.) and the rules designer's own answer is "Cones can't be perfect on a square grid. Just pick one…"; the line's "squares through which the line passes" differs from the published 5-ft.-wide corridor on every axis-aligned and 45° cast. `resolveAreaCells` returns a named `kind` issue pointing at C01b instead of guessing. C01's "where supported" wording permits the subset.
- **The scene bridge, and a bug wiring to a real scene exposed:** `pf1eAreaGridFromScene` maps `SceneGrid` → `PF1eAreaGrid` and pins the diagonal rule to `PF1E_AREA_DIAGONALS` ("5105"). The first draft let the scene's `SceneGrid.diagonals` drive area counting, which is wrong — that setting configures the VTT **ruler**, and the default scene ships `diagonals: "555"` (`hostBoot.ts:178`), so a GM retuning the ruler would have silently changed which squares a fireball covers. AoN 212 states 5-10-5 as a rule of spell areas, so the scene supplies cell size and feet-per-cell while the counting rule stays the rules'. Metric scenes get a named `grid.units` issue rather than an invented conversion.
- **Wired to the existing Playwright surface, not left dormant:** `AppSurface.pf1eArea(spec)` (`src/app/e2eHook.ts`) resolves an area against the **live** scene — its grid metadata, its sight-blocking walls (the existing `sightSegments`, since AoN 212 makes LoE "like line of sight … except that it isn't blocked by fog, darkness") and its tokens — returning cells, affected token ids, preview-rect count and named issues. `e2e/pf1e_targeting.spec.ts` drives it: the 24-cell 15-ft. burst from scene metadata, the ruler-vs-rules pin (scene says `555`, areas count `5105`), a 5-ft. burst on intersection (10,8) selecting exactly the 2×2 the centred token occupies and nothing when moved away, and the `cone` refusal naming C01b. This is the seam the overlay/highlight will read, so the browser path asserts real scene→cells→tokens rather than a re-implementation.
- **Still open for C01:** the Pixi preview overlay and the visible affected-token highlight, plus cone/line once a canonical template is transcribed. C01 stays unchecked. No casting, saves, concentration or spellbook behaviour is implied — that is C02–C04.
- **Evidence:** 36 new unit tests in `tests/packages/pf1eTargeting.test.ts` + `e2e/pf1e_targeting.spec.ts` (4 tests × 3 projects); full suite **1255 passed / 3 skipped** across 134 files (+36 tests, +1 file over D-147); typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist **2,147,525 raw / 621,553 gzip** (+5,587 over D-147 — `e2eHook.ts` imports the module, so unlike D-135's `tactical.ts` it is genuinely in the bundle, within the 6 MB budget); e2e **171 collected across 29 files** (was 159/28), still not executed (D-119 precedent — `cdn.playwright.dev` still returns `ECONNRESET` and no browser binary exists on this machine).

### P5 progress — 2026-09-11, tactical casting and saving throws (C02 partial; decision backfilled as D-149)

- **Rules verified before encoding (R02):** AoN Rules ID 230 "Saving Throw" for the automatic outcomes ("A natural 1 … is always a failure … A natural 20 … is always a success") and for voluntary surrender ("A creature can voluntarily forego a saving throw and willingly accept a spell's result"); the magic overview for the DC formula ("10 + the level of the spell + your bonus for the relevant ability … Always use the spell level applicable to your class"); the severity keywords verbatim (Negates/Partial/Half round down/None/Disbelief/(object), with "A magic item's saving throw bonuses are each equal to 2 + 1/2 the item's caster level"); and the universal monster rules for SR ("a caster level check (1d20 + caster level). If the result equals or exceeds the creature's spell resistance, the spell works normally, although the creature is still allowed a saving throw", overcome once per spell per round).
- **`src/packages/pf1e/casting.ts` (new, pure, diceless):** `spellSaveDc` (10 + level + ability modifier, `focusBonus` an explicit caller input — Spell Focus is a feat, A07 does not author it, and D-141 forbids silently activating feats), `resolveSpellSave` (natural 1 always fails, natural 20 always succeeds, and **no die is read** when the save is voluntarily foregone), `spellSaveOutcome`, `spellResistanceCheck`, `resolveSpellTarget`, plus `magicItemSaveBonus` / `objectSaveBonus` / `describeSave`.
- **Evasion applies only to Reflex half,** because that is how the ability is defined ("an attack that normally allows a Reflex saving throw for half damage"). A Fortitude-half success with Improved Evasion still takes half, and a Reflex-negates spell is unaffected — both pinned by fixtures, so the distinction cannot regress.
- **SR has no natural-die special cases.** A natural 20 from a 5th-level caster does not reach SR 30; a natural 1 from a 20th-level caster still overcomes SR 10. This is the deliberate contrast with the strategic engine's `if (srRoll !== 20)` short-circuit in `spells.ts`, which is **not** changed here — so DEVIATIONS D-1 stays live and now records a divergence between the strategic and tactical paths rather than one house rule. Closing it is C05's work.
- **Ordering is named, not incidental:** the save halves first (floor, per "round down"), then energy mitigation runs on what the creature actually takes — because A.17 spends energy resistance once per attack per type against damage actually dealt, and halving afterwards would let a creature apply resistance to damage the save already removed. DR is never applied to spell damage (CRB p.561 scopes it to weapons and natural attacks); a fixture pins that a 20/— DR creature takes a full untyped spell.
- **One energy pipeline, not two:** the energy half of A05's `applyMitigation` was extracted into an exported `applyEnergyMitigation(components, defender)` in `mitigation.ts`, and `applyMitigation` now calls it. Spells cannot reuse `applyMitigation` itself — it is weapon-shaped and requires `PF1eDrAttackFacts`, and inventing weapon facts to model a fireball would fabricate input. The extraction is behaviour-preserving: all 22 existing mitigation fixtures pass unchanged.
- **Partial and Disbelief get no invented multiplier** — both return `kind: "lesser"` with a note, because the text says "some lesser effect occurs" and "lets the subject ignore the spell's effect" without quantifying either.
- **Wired to the existing Playwright surface:** `AppSurface.pf1eCastResolve(spec)` (`src/app/e2eHook.ts`) runs the **real** bundled chain — authored `system.pf1e` → `deriveFromDocuments` → save total → `spellSaveDc` → `resolveSpellTarget` → `applyEnergyMitigation` — and `e2e/pf1e_casting.spec.ts` drives it with the SRD's own worked example (Int 18 ⇒ +4, 3rd-level fireball, DC 17) plus the natural-1 forfeiture, resistance-after-halving, the resisted target, and the spell-level refusal.
- **Still open for C02:** chosen-target selection, the round-scoped resistance bookkeeping (`alreadyOvercomeThisRound` is currently a caller-supplied flag rather than a tracked store), and the casting UI. **C02 stays unchecked.**
- **Note on a phantom item:** an earlier reading of this file logged "pf1e barrel export" as outstanding. Re-checked: `src/packages/pf1e/` has no `index.ts` and this TODO never asks for one — direct module imports are the convention throughout. Dropped, not deferred.
- **Evidence:** 34 new unit tests in `tests/packages/pf1eCasting.test.ts`; full suite **1289 passed / 3 skipped** across 134 files (+34 tests over D-148); typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist **2,153,859 raw / 623,545 gzip** (+6,334 over D-148, within the 6 MB budget); e2e **186 collected across 30 files** (was 171/29), still collected-not-executed per D-119.

### P5 progress — 2026-09-11, casting legality and concentration (C03 partial; decision backfilled as D-150)

- **Rules verified before encoding (R02):** AoN Rules ID 203 / CRB pp.206–208, Table 9-1 "Concentration Check DCs" transcribed row by row (cast defensively "15 + double spell level"; injured "10 + damage dealt + spell level"; continuous damage "10 + 1/2 damage dealt + spell level"; non-damaging spell "DC of the spell + spell level"; grappled or pinned "10 + grappler's CMB + spell level"; motion 10/15/20 + spell level; weather 5/10 + spell level; entangled 15 + spell level), plus "you roll d20 and add your caster level and the ability score modifier used to determine bonus spells of the same type", "If you fail the check, you lose the spell just as if you had cast it to no effect", "Pinned creatures can only cast spells that do not have somatic components", and the grappling restriction to "no more than 1 standard action … no somatic component … in hand any material components or focuses". From the Armor table: the failure chance "is the percentage chance that the spell fails and is ruined", "If the spell lacks a somatic component, however, it can be cast with no chance of arcane spell failure", "add the two numbers together to get a single arcane spell failure chance", and the deafened caster's 20% spoilage on a verbal component.
- **`src/packages/pf1e/concentration.ts` (new, pure, diceless):** `parseSpellComponents` → `componentNeeds` → `checkCastingLegality` → `arcaneSpellFailureChance` → `resolveConcentration` → `resolveCastingAttempt`, plus `castingAction` and `resolveDeafenedSpoilage`. This is the gate _in front of_ C02's save flow: the strategic engine cast unconditionally and `casting.ts` began at the saving throw, after the casting had already succeeded.
- **Components are parsed per tradition, not flattened,** because "If the Components line includes F/DF or M/DF, the arcane version … has a focus component or a material component (the abbreviation before the slash) and the divine version has a divine focus component (the abbreviation after the slash)" — so `M/DF` means M for a wizard and DF for a cleric, not both for everyone.
- **Legality returns named refusals, not a boolean** (cannot speak / no free hand / components not in hand / pinned / grappling), because the table has to say _why_ a spell could not be attempted.
- **Arcane spell failure resolves per item before summing,** so an exemption (bard light armour, mithral, Arcane Armour Training) applies to its own item rather than to the total — the Paizo-clarified reading. A spell with no somatic component returns chance 0 with `applies: false`, so a verbal-only spell in full plate is never at risk; a fixture pins that.
- **Concentration takes one die per trigger** because several checks can apply to one casting and each is a separate roll; any single failure loses the spell, but every check is still evaluated and reported so the table can show which one failed. A fixture covers the case where casting defensively passes and the injury check fails.
- **Table 7-2 is read, not re-encoded:** `castingAction` resolves casting times through the existing `pf1eActionById` in `actions.ts` ("cast-spell" ⇒ standard/provokes yes, "cast-quickened" ⇒ swift/provokes no), so a swift-action spell inherits "doesn't incur an attack of opportunity" from the same row the action ledger already uses. Metamagic moves a 1-standard-action spell to a full-round action for a sorcerer or bard, and Quicken Spell overrides that back to swift.
- **Refused rather than guessed:** Table 7-2 lists only the 1-standard-action row, so a full-round or longer casting time returns `provokes: null` with a note instead of an inherited `yes`. Combat Casting (+4) and item exemptions are caller inputs (D-141), and casting times arrive as a caller-assigned bucket because PF1e casting times are free text.
- **One assumption, named rather than dressed as verified:** the continuous-damage row says "10 + 1/2 damage dealt + spell level" with no rounding rule, so this floors it on Pathfinder's general round-down convention. Flagged in code and in D-150 for R03 review.
- **Wired to the existing Playwright surface:** `AppSurface.pf1eCastAttempt(spec)` derives deafened/grappled/pinned from the **authored actor document** via `deriveFromDocuments` before running the gate, and `e2e/pf1e_concentration.spec.ts` drives it — a clean cast at exactly DC 21, chain shirt + buckler at 25% ruining the spell, a deafened caster's spoiled verbal component, a pinned caster blocked from a somatic spell before any roll, and the grappling casting-time limit.
- **Still open for C03:** touch spells and holding the charge, multi-round casting completion, the prepared-caster metamagic cost, and the attack-of-opportunity trigger that produces "injured while casting" (that is P06's interrupt queue — this slice takes the damage as an input). No casting UI. **C03 stays unchecked.**
- **Evidence:** 29 new unit tests in `tests/packages/pf1eConcentration.test.ts`; full suite **1318 passed / 3 skipped** across 135 files (+29 tests, +1 file over D-149); typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist **2,162,913 raw / 626,059 gzip** (+9,054 over D-149, within the 6 MB budget); e2e **201 collected across 31 files** (was 186/30), still collected-not-executed per D-119.

### P5 progress — 2026-09-11, pack-driven cast payloads (C05 partial; decision backfilled as D-151; **DEVIATIONS now empty**)

- **Both live deviations closed.** D-1 (the strategic spell scatter step) and D-2 (the hard-coded Fireball order) were the only two entries DEVIATIONS.md carried, and P5 owned both. The scatter block is deleted from `spells.ts` and `modelsScattered` is gone from `PF1eSpellMetrics` — a model now resolves SR and the save **in the square it occupies**, with a fixture placing one 14.5 ft from the epicenter of a 15-ft blast, exactly where the old 5-ft step pushed it to 15.5 ft and reported it as having escaped.
- **`src/packages/pf1e/spellPacks.ts` (new, pure):** `parsePackSpellOrder({entry, casterLevel})` reads the `system.massBattle` block a content pack ships and returns a validated payload — radius, shape, save type, half-vs-negates, evasion applicability, damage type and the dice all come from the pack rather than a literal at the call site. It resolves "1d6 per caster level (maximum 10d6)" from `dicePerCasterLevel` + `maxDice`.
- **The parser audits the pack as it reads it:** a pack whose Saving Throw line says "Reflex half" while driving `halfOnSave: false`, or which flags `evasion` on a spell that is not Reflex half, is reported as a named content bug instead of silently resolved.
- **One DC formula, not two.** The save DC is deliberately _not_ derived from the pack's class table; it comes from `spellSaveDc` in `casting.ts` with a caller-supplied spell level, so the strategic and tactical paths share the verified 10 + level + ability-modifier formula and cannot drift.
- **Three rules fixes surfaced by reading the strategic resolver closely,** each pinned by a fixture: (1) the scatter, above; (2) `if (srRoll !== 20 && srTotal < targetSr)` → `if (srTotal < targetSr)`, removing the automatic-success-on-20 that a caster level check does not have — this was the divergence D-149 recorded between the strategic and tactical paths; (3) Evasion was applied to _any_ save type and _any_ severity, so a Fortitude-half spell was negated outright by it — it is now gated on `saveType === "ref" && halfOnSave`, and `halfOnSave: false` negates on a success instead of halving.
- **Packs stay content, not code.** Nothing in `src/` reads `systems/**` at runtime, so `PF1E_PACK_FIREBALL_MASS_BATTLE` mirrors the shipped block and `tests/packages/pf1eSpellPacks.test.ts` asserts the mirror against the real `spells.json` the same way `pf1eActor.test.ts` reads the bestiary. That test caught genuine drift on its first run (the mirror omitted `notes`); it now asserts `notes` is the _only_ omission rather than loosening the comparison.
- **Content bug found and deliberately left alone:** `systems/pf1e-core/packs/spells.json` lists Fireball at **level 5** against CRB p.283's "sorcerer/wizard 3", with range "100 ft. + 50 ft./level" against "long (400 ft. + 40 ft./level)", and a `target` line an area spell does not have; secondary sources also suggest it is not on the alchemist or investigator list at all. Only `massBattle.notes` was edited, because it described the sim's old hard-coded DC 16 and this change made it false. The level/range/target fields were **not** touched: correcting a combined `sorcererWitch` key and deleting class entries needs the whole class list verified against primary text (R02), and the negative claims are only supported by secondary sources. It is inert — nothing reads the pack's `level` table. **Open item: pack content audit.**
- **Still open for C05:** location, range and targets are a named demo origin rather than order-driven, and only `circle` is wired. **C05 stays unchecked.**
- **Every fix was mutation-checked.** Re-running green tests says nothing about whether they would catch a regression, so all four changes were reverted one at a time and the suite re-run. Three failed immediately as intended (SR house rule → `srBlocked` 0 not 1; scatter restored → `affectedModels` empty; old Evasion branch → 0 not 6 on Fort-half and 6 not 0 on negates). **Restoring the hard-coded `radius: 15` / `dc: 16` left the suite fully green** — the pack-parity test pins only the mirror constant, not the order actually built. A first call-site guard also passed under the mutation, because it asserted the _reported_ parameters while the mutated code still reported pack values and only the resolution used the literal. The discriminator that works is an outcome: a model at (10, 27), 17 ft out, is inside the pack's 20-ft spread but outside a 15-ft literal, so `modelsTargeted` is 3 versus 2. Asserted in `tests/packages/massBattlePf1e.test.ts`; the mutation now fails it with `expected 2 to be 3`.
- **Formatting discipline corrected.** This repo is _not_ uniformly Prettier-formatted — `pnpm format` is a manual script, not a gate, and many files (all of `e2e/`, both mass-battle test files, `DEVIATIONS.md`, `spells.json`) are unclean at HEAD. `prettier --write` on those reformatted hundreds of untouched lines; that was reverted and the edits re-applied in each file's existing style. The rule to follow: **check `git show HEAD:<file> | prettier --check --stdin-filepath <file>` first and only format files that were already clean.** Verified by diffing deletions afterwards — every deleted line in `spells.ts` (25) and `massBattlePf1e.ts` (13) is one this change replaces, and the appended tests show 0 deletions.
- **Evidence:** 16 new tests (11 in `tests/packages/pf1eSpellPacks.test.ts`, 4 added to `pf1eSpells.test.ts`, whose first test was also renamed — it advertised the scatter it no longer performs, and 1 in `massBattlePf1e.test.ts`); full suite **1334 passed / 3 skipped** across 136 files (+16 tests, +1 file over D-150); typecheck, lint, build, size and `build:systems` green. `dist/index.html` is byte-identical to D-150 because `massBattlePf1e.ts` is **not in the app bundle** — verified, not assumed: `grep -c massBattle dist/index.html` returns 0. It ships in the rules artifact, verified by unpacking: `rules.js` grew 46.7 kB → **55.1 kB** and contains the new payload message, no `modelsScattered` and no `srRoll`; `pf1e-core-1.0.0.zip` was unpacked and its `spells.json` confirmed to carry radius 20 and the corrected note. `e2e/pf1e_mass_battles.spec.ts` imports and activates that exact zip in a real browser Worker and asserts `packCount === 2`, covering the edited pack and rules bundle at the load-and-activate level; the resolution itself is unit-tested and not browser-executed (D-119).

### P5 progress — 2026-09-11, spell slots, bonus spells and prepared/spontaneous data (C04 partial; decision backfilled as D-152)

- **The repo had no bonus-spell computation at all** (`grep -rn bonusSpell src/` → 0 hits), and `PF1eDerived.spellSlots` was the **authored** budget copied through verbatim — no Table 1-3 bonuses, no `10 + spell level` check, no ledger, and nothing in `src/ui/` read it.
- **CRB Table 1-3 transcribed, not computed** (`src/packages/pf1e/spellSlots.ts`, all 23 rows, verified against d20pfsrd.com and cross-checked against two mirrors). Written out rather than derived because two properties of the table defeat the obvious formula: **0th level never receives a bonus spell at any score**, and the progression is **not linear** (20–21 grants 2/1/1/1/1, not 2 everywhere). Scores 46+ are **reported as out of range rather than extrapolated** — the published table ends with "etc. . .", so inventing a row would be a fabricated fixture (V01).
- **A bonus is usable only where the class already grants the slot** (the CRB's own gloss), so a bonus at a slotless level is a **warning**, never a granted slot — a 1st-level wizard with Intelligence 18 sees three warnings, not three extra spells.
- **Ability drain costs bonus spells; ability damage does not** (CRB p.555, already implemented in `actor.ts`). Drain reduces the score, damage only penalises the modifier, and Table 1-3 is a _score_ table. This produced the slice's one wrong expectation rather than one wrong implementation: the test asserted damage would drop Intelligence 18 to 12 and failed with 18. The rule was corrected in the test, and both directions are now pinned.
- **Overuse warns, it never refuses.** Every over-budget path returns `allowed: true` plus a `warning`, per C04's "warnings, not hard enforcement".
- **The sheet now shows it.** Summary tab, under Spell resistance: `0th 0/4 · 1st 0/5 · 2nd 0/4 · 3rd 0/3 · 4th 0/2 (INT 18, prepared)`, with each budget warning rendered separately. `pf1eSpellSlotReadout` in `pf1eSheetModel.ts` is a thin adapter — that file's "no rules arithmetic" rule holds, because Table 1-3 and the minimum-score check live in the package. Levels are **0–9 only**: the derived 0–10 array is truncated, and a fixture asserts a 10th-level slot stays out rather than being silently widened in.
- **Browser surface written and used, not deferred.** `AppSurface.pf1eSpellSlots({system})` calls the _same_ `pf1eSpellSlotReadout` the sheet renders, and `e2e/pf1e_spell_slots.spec.ts` (7 tests) drives it, so the spec proves the sheet's own code reaches the rules rather than a copy of it. Collected, not executed (D-119).
- **All five mutations caught.** Making the 20–21 row linear (2 failed), shifting the row so 0th level takes the 1st-level bonus (9 failed), turning overuse into a hard refusal (2 failed), ignoring bonuses entirely (8 failed), dropping the slotless-bonus warning (1 failed); restored baseline 36/36.
- **Prettier has no Svelte parser in this repo** — `prettier --check <file>.svelte` exits 2 with "No parser could be inferred", while the `git show HEAD:<f> | prettier --check --stdin-filepath` form silently no-ops and exits 0. The apparent HEAD→now "flip" on `PF1eActorSheet.svelte` is that artifact, not a formatting regression. **Svelte files are covered by `pnpm lint` instead**, which caught the one real issue (`svelte/require-each-key`).
- **Still open for C04:** the bundle confirms the boundary instead of leaving it assumed — `grep -c "Spell slots (0th-9th)" dist/index.html` → 1 and `"is below the required"` → 1, but `"no slots granted at that level"` → 0, `"which grants no slots"` → 0, `"no unspent slot at level"` → 0. The **readout** ships; the **spending and preparation** path is tree-shaken out because nothing in `src/` calls it, so no cast decrements a slot and the overuse warnings are not yet observable in the product. A **rendered spellbook/prepared list** is also missing — there is no authored prepared-spell list on the actor document at all, so that needs a schema field plus validation and an editor, not just markup. **C04 stays unchecked.**
- **Evidence:** 42 new tests (36 in `tests/packages/pf1eSpellSlots.test.ts`, 6 added to `tests/ui/pf1eSheetModel.test.ts`, 13 → 19); full suite **1376 passed / 3 skipped** across 137 files (+42 tests, +1 file over D-151); typecheck, lint, touched-file Prettier, build, size and `build:systems` green; dist **2,169,035 raw / 627,929 gzip** (+6,122 / +1,870, within the 6 MB budget); `rules.js` unchanged at **55.1 kB**; e2e **222 collected across 32 files** (was 201/31). DEVIATIONS.md unchanged — 2 rows, both CLOSED (D-151), none live.

## 8. P6 — Positioning, maneuvers, real interrupts and mounted/firearm combat

Depends on P2–P5. Complete action costs and modifiers together with their legal execution.

- [ ] **P01 — Normalize scene/model/feet conversions** across deploy spacing, envelopment reach, aura radii and spells. Use scene grid metadata, not incompatible hardcoded 1.5/5/15/30 constants. (G §2.15; B §6.1)
- [ ] **P02 — Implement space/reach/threat geometry:** token footprints, size/tall/long reach, reach-weapon dead zones, tiny-creature occupancy/zero reach, diagonals and threatened-square highlighting. (G §4.5; I P6)
- [ ] **P03 — Implement movement legality and cost:** terrain multipliers, obstacles/occupied squares/allies, squeezing, minimum movement, run/withdraw, legal ending squares, 5-foot steps and charge path/action restrictions. (I P6; G §3/§4.5)
- [ ] **P04 — Implement positional defenses/modifiers:** corner-based soft/partial/standard/improved/total cover, concealment non-stacking, invisibility/denied Dex, helplessness, higher ground, opposite-border flanking and threatening-ally requirements. Use independently verified fixtures. (I P3/P6; G §4.6)
- [ ] **P05 — Complete maneuver checks and aftermath:** bull rush, trip, disarm, sunder, grapple/maintain/pin/escape/tie-up, overrun, dirty trick, drag, reposition, steal; aid another/feint separately. Include special CMB/CMD size, Tiny Dex substitution, legality/limbs/free hands, size limits, improved/greater feat exceptions, attack substitution, failed-check consequences and item hardness/HP. Verify I's ambiguous “reverse” rather than inventing a maneuver. (I P6; G §4.8/Appendix A.9)
- [ ] **P06 — Implement authoritative interrupt queue** before movement/action Ops commit: AoO trigger table, verified budgets and owner-turn reset, one opportunity per triggering action, exclusions, damage effects on maneuvers/casting, and ready-before-trigger ordering. UI prompts alone are not completion. (I P6; G §2.14/§4.11)
- [ ] **P07 — Complete delay/ready execution and UI:** triggers, interrupt resolution, initiative adjustment, unused/lost actions and re-ready; prevent extra-turn/action exploits. (G §4.11; I P2/P6)
- [ ] **P08 — Add mount/companion linkage and mounted rules:** shared initiative/space, Ride DCs, movement/full-attack limits, mounted ranged penalties, charge/lance multipliers, casting concentration, falls/unconscious riders and supported mounted feats. (I P6; G Appendix A.11)
- [ ] **P09 — Complete firearms independently at both scales:** early/advanced touch windows and max range, ammo/capacity/loading/provoke, weapon-owned broken/misfire state, penalties/escalation/Gun Training/nonproficient loading, early explosion saves/destruction and clearing actions. Reverify questionable G firearm formulas before encoding; measure any new strategic state columns. (G §2.9/2.9b; I P6/D-113 normalization notes)

## 9. P7 — Injury, recovery and death

Depends on damage/effects/turns and corrected S5 rules from R02.

- [ ] **H01 — Implement disabled/dying/stable/dead progression** with negative-HP bookkeeping, Constitution-based stabilization, Heal assistance, ongoing turn effects, natural recovery and helpless/coup-de-grace resolution. (I P7; G §4.9/Appendix A.13)
- [ ] **H02 — Complete nonlethal and temporary HP semantics:** separate accumulation, staggered/unconscious thresholds, excess conversion, absorption/stacking/expiry and lethal/nonlethal healing relationships. Do not equate tactical 0 HP with strategic compaction death. (G §2.12/§4.9; I P7)
- [ ] **H03 — Add healing, fast healing and regeneration** including suppression sources/timing and death implications; ensure damage/healing state and analytics agree. (I P7; M Tasks 3/6; G Appendix A.18)
- [ ] **H04 — Add ability damage/drain and energy drain/negative levels**, recovery and derived-stat consequences. Ability burn/massive damage remain explicit optional follow-ups below unless separately approved. (I P7; G §4.9)

## 10. P8 — Strategic fidelity, hero bridge, analytics and content

Split into reviewable sub-slices. Depends on the relevant tactical data/effect/spell work, N01–N02 for multiplayer acceptance, and R03 for variants. These are not a shared-kernel rewrite.

### Strategic resolver completion

- [ ] **M01 — Bring strategic attack/damage rules up to the verified data contract:** outstanding G §2.4–2.10 (crit/bonus dice, ranged Dex/size, handedness/enhancement, range/firearms and defender mitigation) using independent sim loops; add scale-specific fixtures, not a cross-scale equality gate. (G §§2, 5; I P8)
- [ ] **M02 — Reconcile strategic compile differences** in AoO budget, CMB/CMD special size and save bases/modifiers using verified shared tables; keep legacy/stat-block conversion differences explicit and measure changed fixtures. (G §10.2; I P8)
- [ ] **M03 — Fix condition/status bit collisions** with a budgeted separate column or safe allocation; update manifest, codec, spatial filters, compaction and joiner tests so prone/flanked never masquerade as hidden/pinned. (G §2.13; I P8; B §4.5)
- [ ] **M04 — Replace heuristic engagement with scale-appropriate contact/reach/flanking geometry** and clear/recompute stale FLANKED bits each turn; handle envelopment movement and document any non-SRD bonuses. (G §2.2/§5; M Task 4)
- [ ] **M05 — Execute declared movement/shoot/melee/spell order phases** rather than accepting no-op move/hold/retreat/custom orders; implement range/terrain/charge/withdraw/run and movement-triggered AoOs. Decide adopted morale behavior explicitly; a broader morale subsystem is deferred below. (G §5; M Tasks 3–5)
- [ ] **M06 — Complete strategic SR/save, nonlethal, healing and regeneration paths** with correct counters and model lifecycle handling; retain independently seeded deterministic resolution. (G §2.11–2.12/§5; I P5/P7/P8)

### Player hero bridge

- [ ] **M07 — Produce real hero identity and actor inputs:** `leaderTokenId` → actor → profile/`isHeroUnit`; populate `RulesContext.leaderActors` at production construction sites instead of empty maps or fixture IDs. (G §4.12/§5; I P8; M Task 7)
- [ ] **M08 — Implement bidirectional position/HP/condition sync** between hero documents and model slots; snapshot/lock inputs for advance and reconcile worker results through atomic authorized Ops, with movement-during-turn race tests. (B §§4.1, 7; G §4.12; M Task 7)
- [ ] **M09 — Fix aura application/removal and stacking:** radius/bonuses from feat/class data, spatially eligible allies only, no per-model/per-turn accumulation into base stats; leaving formation or losing the leader removes benefits. (G §5; B §4.1; M Task 7)
- [ ] **M10 — Wire hero melee/casting/direct targeting and approved cleave behavior** into normal player controls and reports. Treat bodyguard/rank shielding/duels as separately scoped extensions below, not hidden requirements for initial bridge delivery. (I P8; M Task 7; B §4.1)

### Analytics and battle UI

- [ ] **M11 — Populate all advertised metrics at their real event sources:** attacks/hits/misses/percentage, damage dealt/taken/overkill, threats/confirms, kills/deaths/remaining, DR absorbed/SR blocked, saves, AoO executed/hits, CMB success, healing/regeneration/channel-energy counts. Specifically close the six unincremented fields identified by I P8. (M Task 6; G §5; I P8)
- [ ] **M12 — Call `generateReport()` from actual turn resolution**, reconcile per-model/per-unit totals into TurnReport summaries, and test resets/aggregation/attribution rather than collector-only fixtures. (M Task 6; G §5)
- [ ] **M13 — Implement RFC-4180 CSV escaping** for commas, quotes and newlines with round-trip tests. (M Tasks 6/8; I P8)
- [ ] **M14 — Mount ArmyWindow, PF1eBattleAnalysis and TurnReportTimeline** in normal WindowHost navigation, not just e2eHook; reactive analysis/table/report readback and CSV export must work after real turns. (G §1.7; I P8; M Task 8)

### Data and content

- [ ] **M15 — Expand spells from 4 to approximately 40** with textual school/descriptors/components/casting time/range/target/area/duration/save/SR and tactical + mass-battle payloads; distinguish descriptive-only entries from automated ones. (I P5; G §6; M Task 9)
- [ ] **M16 — Expand bestiary from 6 to approximately 30 CR-appropriate entries**, add equipment/armor/shield tables and an explicitly selected six-class starter table. Include feats that affect calculations (initiative, Toughness, Dodge/Mobility/Spring Attack, Combat Casting, save feats and the attack/maneuver feats above). (I P8; G §6)
- [ ] **M17 — Complete and verify shared SRD data coverage** for size, reach, speed/armor, cover/concealment, TWF, actions/provokes, weapons and armor properties; do not treat P0 table presence as complete coverage. (G §6; B §6.3)
- [ ] **M18 — Keep packs, normalization and compiled profiles aligned**, generate or validate PRECREATED_PF1E_UNITS from packs, declare added packs in manifests, test every mechanical field and enforce the 2,000-entry pack cap. Load content on demand from IndexedDB instead of inflating the base HTML. (G §6; I P5/P8; B §10)

## 11. Verification and release gates — part of every relevant slice

- [ ] **V01 — Build independently sourced, heading-cited rule fixtures**, approximately 500 worked examples in the proposed `tests/packages/pf1eFixtures.json`, covering modifier/size/reach/TWF/provoke/save/cover tables and exceptions. Never snapshot current outputs as expected truth. Close R01–R02 as fixtures are verified. (G §7; I §6)
- [ ] **V02 — Add seeded probability oracles** at 100k iterations for fixed builds/defenses with tolerances, plus exact single-roll assertions. Include discriminating AC 22/16/17, flank boundary and minimum-nonlethal regressions. Test tactical and strategic paths independently. (I P3/§6; G §7)
- [ ] **V03 — Execute corrected S1–S5 tabletop flows** with pure logic tests and browser interactions: fighter/bestiary/initiative/attack; timed buff and revert; 20-ft Fireball cluster; trip and defensive/injury concentration as distinct cases; dying/stabilization/coup de grace. Use R02-corrected expectations, not contradictory source prose. (I §1)
- [ ] **V04 — Add the broader tactical encounter flow:** 2 PCs vs 3 goblins, surprise, step, AoO, charge, cover/concealment, maneuver and injury progression, with player ownership/replication assertions. (G §7.5)
- [ ] **V05 — Run the full two-peer mass-battle acceptance flow:** import/activate real zips, deploy 10k, resolve 20 turns, move/cast/attack with a hero, inspect exact analytics and CSV, assert clean rules boot/console and joiner state. Browser package activation alone does not satisfy this. (M Task 10; G §7.5)
- [ ] **V06 — Preserve deploy/manifest/codec/replay gates with every strategic change:** seeded hashes and decompressed wire equality, checkpoint ≤1.5 MB at 10k, ≤200 B/model, warm-up before timing and genuine combat events rather than empty late-turn work. (G §1.11; I §7)
- [ ] **V07 — Address dense-army performance:** benchmark at least 20×500 and 40×250 models, reduce per-unit overhead to pursue warmed p95 <50 ms, report environment/distributions separately from the existing 250 ms regression gate. Avoid hot-loop `Math.hypot` dependence where integer/squared-distance geometry suffices. Do not loosen tests to conceal misses. (G §5; I P8; B §7)
- [ ] **V08 — Gate 200-actor tactical refresh/resolution within a documented frame budget**, including sheet derivation, effects, tracker and relevant detection work; recheck single-file size after UI mounts. (I P8; B §7)
- [ ] **V09 — Generate rules-coverage dashboard** from test `@srd` headings (proposed `scripts/coverage.mjs`), with implemented/tested/deviated/deferred rows and links to this checklist. (G §7.6; I P8)
- [ ] **V10 — Run and report quality checks per slice:** `pnpm test`, `pnpm typecheck`, `pnpm lint`, touched-file Prettier check; `pnpm build` + `pnpm size` for UI, `pnpm build:systems` for rules/packs, and actual browser tests where binaries are available. Test collection (`playwright test --list`) is not a passing browser run. Respect https/file boot and supported browser matrix. (I §§5, 7; M §3; README)
- [ ] **V11 — Keep decisions/deviations and checklist synchronized** in the same reviewable phase slice; record changed contracts, verified rule citations, measured budgets and test evidence. No drive-by platform refactors or dormant rule toggles. (I §2/§5)

## 12. Deferred / expanded-system backlog — retained from the sources

These are not prerequisites for the scoped S1–S5 MVP unless promoted explicitly. Core combat behavior listed above must not be deferred merely because an advanced variant appears here.

- [ ] **L01 — Full character-building depth:** full skills/ranks/class-skill/ACP UI, point buy, inventory/encumbrance/loot management, broader class progression and feature automation beyond starter combat requirements. Retain the integration plan's full-sheet vision without expanding P1 silently. (B §§4.3, 6.2; I §9; G §8)
- [ ] **L02 — Broader class/feat mechanics:** Sneak Attack, Smite Evil, Rage, Clustered Shots, school-specific spell feats and remaining leadership/commander features, with verified rules rather than B's simplified formulas. Promote needed starter features into A07/E03/C02/M09 individually. (B §4.3; G §3)
- [ ] **L03 — Advanced hero interactions:** In Harm's Way/bodyguards, rank shielding, capture/duels and formation exit/re-entry actions beyond basic direct targeting. (B §4.1; G §4.12)
- [ ] **L04 — Full spell catalog and advanced preparation/metamagic automation**, complete equipment pricing/crafting and non-combat skills beyond the selected combat subset. (B §§1, 6.2; I §9; G §8)
- [ ] **L05 — Optional/house-rule systems:** massive damage, ability burn, grouped/modern initiative, facing, knockback, mounted overrun, pursuit and advanced illusion/invisibility variants. Require explicit scope, sourced behavior, named settings and default policy; do not silently change core rules. (G §8; I P7/§9)
- [ ] **L06 — Third-party and wider strategic subsystems:** interleaved 3PP maneuvers/wounds/crippling variants, vehicles/siege/domain/politics and mass-battle morale rework. Gate 3PP data with `flags.pf1e.thirdParty` if adopted. (G §8; I §9)
- [ ] **L07 — Optional player-sidebar parity and visual polish:** journals/tables/tracker exposure beyond scoped ownership/rolls/effects, portrait frames/themes, extra dice/token animation and richer template dragging. Existing platform dice infrastructure is not a new PF1e engine task. (I §9; G §8; B §5)

## Recommended execution order

1. **Reconcile R01–R03**, preserve D01–D06; start **N01–N02** as an independent protocol slice.
2. **P1 sheets → P2 tracker/actions → P3 attacks → P4 effects → P5 casting/awareness → P6 interrupts/movement → P7 injury**. Verify disputed rules before each affected slice; implement only context-menu options that work.
3. Split **P8** into strategic fixes, hero sync, analytics/UI and content PR-sized changes. Pull schema collisions/scale conversions forward if they block an earlier consumer. Content can proceed with its owning rule phase rather than waiting for all of P8.
4. Apply **V01–V11 throughout**, then complete the combined multiplayer/scale acceptance. Promote **L** items only by explicit scope decision.

Original I PR labels map to this sequence: PR-A/P0 is already landed; B/P1, C/P2, D/P3, E/P4, F–H/P5–P7, I/P8. The old G milestone estimates and M task numbers are historical cross-references, not a second schedule or additional copies of these tasks.
