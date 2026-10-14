# PF1e Torch and Light Sources (ArenaStar AIS)

An independent, classic-script AIS module that reproduces Torch's core light-source workflow using ArenaStar-native services. It does not import Foundry APIs or run in the main VTT bundle.

## Source catalog

Radii are authored in PF1e feet and converted through the scene grid to ArenaStar pixels. Values below are **bright / dim** radii.

| Source           | Bright / dim | Beam | Consumable |
| ---------------- | -----------: | ---: | ---------- |
| Candle           |    0 / 5 ft. | 360° | Yes        |
| Lamp             |  15 / 30 ft. | 360° | No         |
| Lantern          |  30 / 60 ft. | 360° | No         |
| Bullseye Lantern | 60 / 120 ft. |  90° | No         |
| Hooded Lantern   |  30 / 60 ft. | 360° | No         |
| Miner's Lantern  |  30 / 60 ft. |  90° | No         |
| Torch            |  20 / 40 ft. | 360° | Yes        |

The Lantern cycles through declared High and Low light modes before extinguishing; source entries use ordered state arrays, so further modes can be added without changing the host API. Names and aliases are matched case-insensitively against the linked actor's inventory. Duplicate stacks of the same source are presented once; consumption is host-authoritative against the selected stack.

## Controls

Right-click a token and choose **Turn carried light on**, **Next carried light source**, **Choose carried light source…**, **Extinguish carried light**, or **Torch settings…**. The source chooser is a text-only dialog rendered by the ArenaStar host. A per-module, per-browser preference panel controls inventory bypass, optional candle/torch consumption, the default source, and a configurable all-around fallback (10/20, 20/40, 30/60, or 60/120 ft.). When inventory bypass is enabled, the module skips actor-inventory reads and offers the full source list.

The module's source data uses ordered state arrays, so sources can have several lit modes; the token action advances through those states and then extinguishes. Source cycling, token state, and optional inventory decrements are serialized by the host rather than written directly by module code.

Directional beams are 90° cones oriented along the token's current rotation. ArenaStar's lighting renderer, light-range checks, fog reveal, worker polygon computation, and Foundry-scene importer carry that direction. A source's beam is used as a token's sight cone in total darkness when it is the only illumination at that token; ordinary ambient light and darkvision retain ArenaStar's existing full-circle perception model. Flame sources carry declarative `torch` shimmer metadata; the host renderer supports bounded `torch` and `pulse` effects for placed and carried lights, honors reduced-motion preferences, and never changes vision/range calculations.

### At the players' tables (D-468)

The GM's approval shares the module with the table by default (Settings → Packages → *Players run
this module too*). A player is asked once per device and code hash; once allowed, this same module
runs in a sandbox on the player's machine and the right-click entries above appear on the tokens
that player controls. Every change it makes is the player's own intent: lighting a torch on an
owned token (and consuming it from the owned actor's inventory) is accepted by the host, any other
token is refused. *Torch settings…* are stored per browser, so a player's preferences apply to
their own copy only. Unsharing or revoking the module on the GM device stops the player's copy
immediately.

## Macro commands and source-change events

The manifest declares eight macro-callable commands: `toggle`, `extinguish`, `current-source`, `current-state`, `equipped-sources`, `select-source`, `inventory`, and `source-exhausted`. A GM-reviewed ArenaStar script macro with the separate **ais.invoke** grant can call, for example:

```js
await api.ais.invoke("pf1e-torch", "toggle", { tokenId: args.tokenId });
```

The script must explicitly run as reviewed GM authority. The bridge accepts only a declared command on a module that is enabled and locally approved on the GM host; input and result JSON are size-bounded, execution is time-bounded, and each actual AIS host request still rechecks the module's exact-hash capability grants. This invokes module-owned functions—it does not expose `eval`, arbitrary AIS source, Foundry globals, or a way to skip ArenaStar's reviewed macro policy.

AIS publishes the typed `scene.token.light.changed` hook after a visible token light is committed, with only a bounded light snapshot (not raw operations or hidden-token data). This module consumes that host hook and emits `torch.changed` with its package-owned source state; explicit source selections also emit `torch.selected`. Other approved observers can subscribe to `module.event` and receive a host-authenticated `{ packageId, eventId, payload }` envelope. Event names are declared in the emitting package manifest and require the separately granted `event.emit` capability. A recipient additionally needs `action.observe`.

## AIS permissions and trust

The PF1e starter world carries a version/hash-locked enabled profile and explicitly selects `pf1e-torch/scene.token.light.action`. This profile is portable; it does **not** approve executable code or grant capabilities. On each host, a human must review the package and separately approve the exact local code and requested capabilities in **Settings → Packages → Automation**. The host re-checks the profile lock and grants for every RPC and every macro command dispatch.

The module requests visible-scene reads, linked-actor inventory reads, optional inventory consumption, module-scoped storage, host-rendered selection/notifications, token-light management, typed action subscription, and declared event emission. ArenaStar's token context action is the native UI replacement for a Foundry HUD hook; macro calls go through ArenaStar's existing reviewed script worker and the new typed AIS command bridge. The package never accesses Foundry globals or assumes the Foundry macro API exists.
