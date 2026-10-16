# Writing an AIS module — the author's guide

**Status (2026-10-15, after D-479).** This is the surface a third-party module can rely on today:
what a manifest declares, how the module is started on the GM's and on each player's device, the
`AIS.*` API inside the sandbox, the capabilities each call needs, the hard bounds, and what the
shells show for you. Everything here is tested in `tests/packages/aisModule*.test.ts`,
`tests/app/aisRuntimeSharing.test.ts` and `tests/app/playerAisRuntime.test.ts`; the architecture
and its reasons are in [AUTOMATION_INTERCONNECT_DESIGN.md](AUTOMATION_INTERCONNECT_DESIGN.md), the
wire format in [PROTOCOL.md](PROTOCOL.md) (`ais.profile`), and the decisions in `DECISIONS.md`
(D-461, D-468…D-479). The shipped worked example is `modules/pf1e-torch/`.

## 1. The package

A module is a ZIP (or a folder under `modules/` for the build) with a `manifest.json`:

```json
{
  "id": "my-module",                 // lowercase slug; becomes the package id everywhere
  "name": "My Module", "version": "1.0.0", "type": "module",
  "interconnect": {
    "api": "arena.ais/1",
    "entry": "automation/entry.js",  // one classic script, ≤ 1 MiB, run inside a sandboxed iframe
    "capabilities": ["action.observe", "ui.notify"],
    "commands": [{ "id": "toggle", "contract": 1 }],
    "emits": ["my-module.changed"],
    "requires": [{ "id": "pf1e-torch", "version": "1.0.0", "optional": false }],
    "provides": [{ "id": "scene.token.light.action", "mode": "exclusive", "contract": 1 }],
    "sharing": "players",            // or "host-only" — never delivered to player devices
    "tokenActions": [{ "id": "light", "label": "Light / extinguish" }],   // ≤ 16, needs ui.interaction
    "panel": { "title": "My Panel", "width": 360, "height": 240 },        // needs ui.panel
    "settings": [                    // ≤ 32 (D-476)
      { "key": "radius", "scope": "world", "type": "number", "label": "Radius (ft)", "default": 20, "min": 0, "max": 120, "step": 5 },
      { "key": "quiet", "scope": "device", "type": "boolean", "label": "No notifications", "default": false },
      { "key": "style", "scope": "world", "type": "choice", "label": "Style", "default": "warm",
        "choices": [{ "value": "warm", "label": "Warm" }, { "value": "cold", "label": "Cold" }] }
    ]
  }
}
```

Validation is strict and by name (`src/core/packageManifest.ts`): unknown fields, bad slugs,
too many entries, a `tokenActions` without `ui.interaction`, a `panel` without `ui.panel`, a
`choice` setting without 2–32 distinct choices, `min > max`, a non-positive `step`, all fail the
import with that message. The content hash of every file is the module's identity: approvals,
player consent and the world's enabled profile are all keyed on it, so any byte change is a new
module.

## 2. Lifecycle — who runs your code, when

1. **Import** never executes anything. The GM enables the module in the world profile
   (`requires` must already be enabled — "X requires enabled module Y"), reviews the entry source
   and the requested capabilities, and approves the exact hash on that device. Approval grants a
   *subset* of the requested capabilities; your code must cope with any subset.
2. **Boot.** The host starts one sandboxed iframe per approved module (no DOM access to the shell,
   no network, no storage but the kernel's), in dependency order, with a 5 s readiness deadline.
   Register everything synchronously at the top level (`AIS.commands.on`, `AIS.events.on`,
   `AIS.runtime.initialize(async fn)` for async setup, ≤ 8 initialisers).
3. **Sharing (D-468/D-469).** Unless the manifest says `host-only` or the GM unticks "Players run
   this module too", the same archive travels to every player in `ais.profile`. Each player
   consents once per device and hash; then an identical iframe runs on their machine against
   their **own replica**. Every write it produces is that player's intent: the host's ownership
   rules decide (a torch module can light the player's tokens and nothing else). Un-sharing,
   revoking or a hash change stop the player's copy without a reload. Capabilities that only make
   sense on the host (`fx.play`, `scene.tags.write`, `ui.theme`, `compendium.read`) are stripped
   at the player; design for both copies observing the same events.
4. **Stop.** Revocation, disabling, replacing the package, a startup timeout, an uncaught error,
   or the breaker (D-479: 50 failed or rejected requests inside 10 s) stop the frame; its status
   and reason appear in Settings → Packages (GM) and the *Shared modules* card (player), both with
   **Restart**.

## 3. The API inside the sandbox

`globalThis.AIS` (`AIS.api === "arena.ais/1"`), all calls promise-returning JSON RPC with a 10 s
timeout (`ui.select`: 5 min). The capability column is what the GM (and, for players, the
intersection with the player-runnable set) must have granted.

| Call | Capability | Notes |
|---|---|---|
| `AIS.events.on(event, cb)` → off | `action.observe` (host events) | `world.snapshot`, `world.ops.committed`, `scene.token.light.changed`, `turn.phase.changed`, `turn.report.committed`, `ui.token.action`, `module.event` (other modules' custom events), `module.settings.changed` (no capability), `ui.panel.closed` (your own panel; `ui.panel`) |
| `AIS.events.emit(eventId, payload)` | `event.emit` | `eventId` must be in `emits`; payload ≤ 16 KiB |
| `AIS.commands.on(commandId, (input, ctx) => …)` | — | `commandId` must be in `commands`; invoked by GM macros (`ais.invoke` grant), the shells' command runner, token actions and the module bus |
| `AIS.scene.readVisible()` | `scene.read.visible` | the caller's projection, never the raw store |
| `AIS.token.applyLight({...})` | `scene.token.light.manage` | host-validated op; ownership decides |
| `AIS.actor.readInventory(actorId)` / `AIS.lighting.*` | `actor.inventory.read` / `.consume` | |
| `AIS.sceneTags.snapshot()` / `.update()` | `scene.tags.read` / `.write` | |
| `AIS.fx.list()` / `.play()` / `.stop()` | `fx.play` | GM device only |
| `AIS.chat.post(content)` | `chat.post` | |
| `AIS.ui.notify(message, level)` | `ui.notify` | |
| `AIS.ui.select({ title, options, … })` | `ui.interaction` | a host-rendered choice dialog; waits for the human |
| `AIS.ui.panel.open()` / `.close()` / `.root()` | `ui.panel` | your own document is the panel body (D-470); the shell draws the chrome. When the user presses the chrome's Close you receive `ui.panel.closed { reason: "user" }` through `AIS.events.on` (D-483; needs only `ui.panel`, not `action.observe`) — the frame is hidden, not stopped |
| `AIS.storage.get(key)` / `.set(key, value)` | `module.storage.read` / `.write` | per device, per module: 128 KiB, 256 keys, 16 KiB per value |
| `AIS.resources.readText(path)` | `package.resources.read` | files listed under `runtime.resources` |
| `AIS.settings.list()` / `.get(key)` / `.set(key, value)` / `.onChange(cb)` | set: `module.settings.write` | D-476; world scope is GM-authority only — a player frame's world write fails with "GM authority" before any op is built |
| `AIS.settings.register(declaration)` | `module.settings.write` | D-482; same schema as `interconnect.settings[]`, declared from code (per boot; 64 on top of the 32 manifest entries); identical re-registration → `{ registered: false }`, a different shape for a known key is refused; `hidden: true` keeps a setting out of the forms (JSON text up to 16 384 chars fits a `string`) |
| `AIS.compendium.list()` / `.search(query, { packId?, limit? })` / `.get(packId, entryId)` | `compendium.read` | D-477; GM device only; pack ids are `<packageId>/<packFile>`; entries are copies ≤ 48 KiB |
| `AIS.modules.list()` / `.invoke(moduleId, commandId, input)` | invoke: `modules.invoke` | D-478; target must be in your `requires`; depth ≤ 8; runs with the device's authority |
| `AIS.documents.context()` / `.list(collection, offset?, limit?)` / `.get({ collection, id, parent? })` | `documents.read` | D-485; this device user's own view of `actors, items, journals, rollTables, macros, folders, playlists, combats, users, messages`; pages ≤ 500 rows / ≈256 KiB; one document ≤ 1 MiB |
| `AIS.documents.mutate(ops)` | `documents.write` | D-485; `[{ kind: "create", collection, data, parent? } \| { kind: "update", collection, id, diff, parent? } \| { kind: "delete", collection, id, parent? }]`, ≤ 32 ops, one atomic host transaction **with this device user's authority** (a player cannot create actors; a GM device can). `_id`/`type` are kernel-owned; defaults (`ownership` = creator owns, `items: []`, …) are filled for you, recursively for inline embedded rows |
| `AIS.events.on("documents.changed", cb)` | `documents.read` | D-485; `{ seq, by, changes: [{ kind, collection, id, parent?, diff? }] }` per committed transaction on the exposed collections (diffs ≤ 16 KiB inline; re-`get` the root otherwise) |
| `AIS.bus.emit(channel, data)` / `AIS.bus.on(channel, cb)` / `AIS.bus.off(channel, cb)` | `bus.transmit` | D-487: your module's cross-device channel — every running instance of **your** package on every device of the table hears the frame (the sender included; `cb(data, by)` with the host-stamped sender `{id, name}`). Channels are 1–128 chars of `A-Z a-z 0-9 . _ : -`, payloads bounded JSON ≤ 16 KiB; no other package can listen in and there is no arbitrary fan-out. `game.socket` is this channel for Foundry-profile modules |

Errors are ordinary rejections with a sentence you can show (`"compendium.read is not shared"`,
`"Declare lamp in interconnect.requires"`, `"pf1e-torch declares no setting radius"`, `"between
min and max"`, …). A capability you were not granted rejects at admission; it is counted toward
the breaker, so check `AIS.settings.list()`-style feature probes once, not per call.

## 4. Bounds you design against

RPC frame ≤ 64 KiB, bounded JSON (depth ≤ 12, finite numbers); 120 requests/s, 32 concurrent;
commands 30/s, input and result ≤ 16 KiB, 8 s each; event payloads ≤ 16 KiB; storage as above;
startup 5 s; trace ring 64 entries. Exceeding a bound rejects that call; exceeding the breaker's
window stops the module.

## 5. Settings in practice (D-476)

- *World* scope: campaign configuration — the GM edits it in Settings → Packages, it replicates
  to every player as the document `ais-settings:<your id>`, exports with the world and undoes
  like any edit. Your player-side copy reads it the same way and gets `module.settings.changed`
  `{ scope: "world", key, value }` when the GM changes it.
- *Device* scope: per-person preferences — editable on the GM's and on every player's own device
  from the same form; never leaves the device.
- Values are coerced against your declaration on both read and write; a key not in the manifest
  does not exist. Keep `module.storage` for state that is not configuration (caches, last
  selections).
- Worked example (D-481): `modules/pf1e-torch` declares four world keys (`ignoreInventory`,
  `consumeConsumables`, `fallbackLight`, `defaultSourceId`) and one device key (`quietNotices`),
  reads them with `AIS.settings.list()` before every action, and writes them from its own
  "Torch settings…" menu with `AIS.settings.set` — the same document the generated form edits.
  On a player's device the world writes are refused and the module explains whose rules they are.

## 6. Talking to other modules (D-478)

Declare the dependency; the GM must enable it first; then `AIS.modules.invoke("pf1e-torch",
"current-state", { tokenId })` runs the sibling's declared command in *its* frame with *its*
grant. The sibling sees `ctx.requestId === "ais-module:<your id>:<n>"`. Prefer this to custom
events when you need an answer; prefer `AIS.events.emit` when you are telling the table something.
The bus never elevates authority: on a player's device the sibling runs as that player.

## 7. UI you can offer

- **Token actions** (both shells' right-click menu) → `ui.token.action { sceneId, tokenId, action }`.
- **Commands** — the player's *Shared modules* card runs any declared command on the selected token;
  GM macros call them with the reviewed grant.
- **Panel** — your sandboxed document in a shell-chromed window (`panel` + `ui.panel`).
- **Settings form** — generated from your declarations in both shells.
- **Choice dialogs / notices** — `AIS.ui.select`, `AIS.ui.notify`.
- Not available by design: raw access to the shell DOM, shell routes or another module's frame.
  First-party component packages (`ui.js`, D-475) exist for ArenaStar's own system packages and are
  bound to the shell's Svelte build.

## 8. What the shells show for you

Settings → Packages (GM): hash, approval, runtime state and reason, declared panel/commands/events,
`requires`/`provides`, the settings form, a **Health** block (request/command/event counters,
circuit state, last traces) and **Restart**. *Shared modules* (player): state, consent controls,
panel button, command runner, device settings, **Restart** when failed.

## 9. Known gaps (so you do not look for them)

- One classic script per module: no ES-module graph, no `import` of sibling files (R-09). Bundle
  before packaging.
- No binary resources in packages and no file storage (R-07).
- Documents (R-02) are open since D-485 for the world collections listed in §3; scenes and
  placeables still go through the typed scene intents (tags, token light) until the next slice.
  Authority is the device user's: a player frame cannot create actors, exactly as its own UI cannot.
- Player devices (D-487): a manifest with `interconnect.sharing: "players"` (the default) runs on
  every device the GM shares it with — the same code, with `game.user`/`AIS.documents.context()`
  naming that device's player and every write authorized as that player. The player consents once
  per device before the first run; un-sharing stops the instance without a reload.
- Cross-device messaging is the bounded per-package channel (`AIS.bus`, D-487) — same package on
  every device, sender stamped by the host, no arbitrary fan-out and no cross-package delivery
  (R-06). Coordination that documents can carry should still ride replication and ownership.
- No system namespace or `CONFIG` (R-08 — by design).
