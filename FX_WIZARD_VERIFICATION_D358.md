# D-358 — First-class convex scene regions and Active Zone triggers

D-358 began as a region-document/rendering foundation and is now extended through authoring, graph binding, swept trigger dispatch, and production behavior. Regions are optional scene-embedded documents, preserving legacy scenes. The host validates bounded convex geometry and limits authoring/update authority to GM/assistant roles. Hidden regions are excluded from player projections (including whole-scene embedded-array updates), copied regions receive new IDs, and GM/player canvas replicas render region outlines.

The production wizard supports region authoring/selection and active-zone graph binding. HostSync resolves region-anchored definitions, computes swept enter/exit contacts for movement, and dispatches the graph; Stop Token Movement uses the region crossing in preflight. `automation.fire` resolves region sources and rejects non-GM script callers for region-anchored graphs.

A movement-interruption follow-up now lets users grab a token at its locally rendered point while an authored movement tween is active. The drag rebases from that displayed position, so the next committed move supersedes the tween instead of requiring a click on the token's already-committed destination. The stage exposes visual positions only while a duration-based animation is running; legacy glides, Undo and static token hit testing retain their prior document-position behavior.

## Executed verification

| Gate | Result |
| --- | --- |
| Focused region-trigger HostSync tests | **2/2 passed**, including region-anchored enter/exit and region Stop Token Movement |
| Full production Chromium `e2e/active_zones.spec.ts` | **19/19 passed in 4.6 minutes**, one worker, zero retries; includes region creation, graph binding, and dispatch |
| Full production Chromium `e2e/movement_actions.spec.ts` | **14/14 passed in 4.9 minutes**, one worker, zero retries; includes a real drag interrupting a five-second authored Move at its rendered point, plus region, shape, movement, Stop/Original Destination and rotated-zone cases |
| Focused canvas interaction/animation Vitest | **39/39 passed** |
| Full Vitest | **4,616 passed / 12 skipped**, 323 files passed / 2 skipped (325 total), 98.45 s |
| Production build | Pass; **3,964,170 raw / 1,142,840 gzip bytes** |
| Typecheck | Pass; Svelte reports one existing advisory in `src/ui/sim/ReplayPanel.svelte:29` |
| Lint and whitespace | Pass; `git diff --check` passes |

An earlier full Vitest run had one timing failure in `tests/client/fxDeliveryFlow.test.ts` (mid-cue fader expected gain `0.25`, got `1`). The test passed alone and in both clean full reruns; record this as a transient timing flake, not a code fix or a remaining test failure. The first full movement-action run after adding the new interruption scenario had one browser failure because that scenario's graph still had Enter/Stop methods enabled and re-fired while the test dragged back through its tile. The fixture was corrected to a manual-only movement graph; the full 14-case production suite then passed without reducing assertions or timeout limits.

## Remaining parity gaps

Region authoring and swept event wiring are implemented. A real drag now interrupts an authored client-side tween at the rendered point. Automatic Stop interruption of every in-flight presentation and waypoint-path behavior remain open. Cross-browser coverage is still unverified: the Firefox Active Zones attempt could not launch because Playwright's Firefox binary is absent; `playwright install firefox` was attempted but all download mirrors failed with TLS `ECONNRESET`. This is an environment/install blocker, not a Firefox behavior result. Cross-browser and performance gates and broader A01–A41 parity remain open. The latest passing production-browser proof is Chromium-only. No full-parity claim.
