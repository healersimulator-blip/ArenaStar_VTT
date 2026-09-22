# MCP-style LLM connector — specification additions and implementation plan

**Status:** proposal 2026-09-21 · **Phase 0 landed 2026-09-22 (D-278)** · **Phase 1 landed 2026-09-22
(D-279)** · **Phase 2 landed 2026-09-22 (D-280)** · **Phase 3 landed 2026-09-22 (D-281)**; Phases 4–6
unstarted.
**Reads with:** `PROTOCOL.md` (§4 ops, §5 projection, §6 transports,
§13 message reference), `PLAN.md` (§12 packages/modules), `DECISIONS.md` (D-013 roles, D-045 the typed
`__vttE2E` surfaces, D-262 view-as), `HEXCRAWL_SCENE_SPEC_AND_PLAN.md` (the hexcrawl tools depend on it),
`GAP_ANALYSIS_Roll20_Foundry.md` §5.1.
**Author's note:** every symbol named below was read in the tree before it was written; proposals are
marked as such.

---

## 1. TL;DR

An **agent connector** lets a Large Language Model sit at the table as a participant with a *bounded
identity* — as a GM, as an assistant, as one player, or as a read-only observer — by giving it a typed
tool surface over the world the app already has.

The design in one paragraph:

> The connector is **MCP-shaped** (JSON-RPC 2.0; `initialize`, `tools/list`, `tools/call`,
> `resources/list|read`, `prompts/list|get`, notifications) and it is implemented as a small **sidecar
> process** that an MCP-speaking client (Claude Desktop, an IDE, a custom agent) launches and talks to
> over stdio. The VTT side is the **GM's browser tab**, which dials *out* to the sidecar over a loopback
> WebSocket — the browser never listens on a port, exactly like every other connection this app makes.
> The agent is a **real session**: it holds a `user` document with a role, it submits **ops** through the
> host's own `Intent` path, and it therefore inherits validation, `can()`, rate limits, the OpLog, undo,
> projection and the world file **for free**. Rights are the GM's choice: the agent is approved like any
> other peer (`HostSync.approve(session, role)`), and on top of the role the GM grants a **capability
> mask** (create yes / delete no / GM-only data yes or no / assets yes or no / …). A player-scoped agent
> is not a special code path — it is a `PLAYER`-role user whose reads go through the same projection a
> human player's do, which is what makes "the LLM plays a character" safe to say out loud.

What the agent can do is deliberately **not** "everything the app can do": it gets ~40 **typed tools**
(§5) built on the domain's own builders — never a raw `ops.submit` escape hatch, for the same reason
§12 modules get eight methods rather than the document store.

**No protocol change is required for the base feature.** The single optional wire addition is an
`asset.put` message (§7.2), needed only if the agent should *upload* map images or token art.

**Not a parity item.** Like the hexcrawl feature, this is a differentiator: neither Roll20 nor Foundry
ships an MCP surface. Per `GAP_ANALYSIS_Roll20_Foundry.md` §5.1's ordering (parity first), it is a
Wave-4/candidate item unless the product decision makes "run your table with an AI at it" a headline.

---

## 2. Where it runs (three architectures, one recommendation)

```
┌────────────────────┐        stdio (MCP)         ┌───────────────────────────┐
│  LLM client        │ ◀────────────────────────▶ │  vtt-mcp sidecar (Node)   │
│  (Claude Desktop,  │                            │  • MCP server             │
│   IDE, agent loop) │                            │  • tool registry + gate   │
└────────────────────┘                            │  • world replica cache    │
                                                  └──────────────┬────────────┘
                                                                 │ ws://127.0.0.1:<port>
                                                                 │ (the TAB dials out)
                                                  ┌──────────────▼────────────┐
                                                  │  GM's browser tab         │
                                                  │  src/app/agentBridge.ts   │
                                                  │  → ClientSync.submit(ops) │
                                                  │  → projection for reads   │
                                                  └──────────────┬────────────┘
                                                                 │ the app's own host path
                                                     ops · projection · rate limits · undo
```

- **A — loopback sidecar (recommended).** `node tools/mcp/server.mjs` (a `pnpm mcp` script). The GM
  enables it from a new **Agent** section in the Settings window; the tab opens
  `ws://127.0.0.1:<port>/bridge?token=…` with a one-time pairing token the sidecar prints. No inbound
  port ever opens in the browser, the sidecar binds loopback by default, and the whole thing works from
  `file://` because the tab is only making an outbound WebSocket.
  *Sandbox note:* in this repo's e2e environment the sidecar must bind `0.0.0.0` (the platform serves the
  preview from outside the container), which the test harness passes as an explicit flag — the
  *product* default stays loopback.
- **B — the connector joins the room as a peer.** Reuses `src/net/signaling/{manual,nostr,mqtt,websocket}`
  + `net/webrtc.ts` + `client/sync.ts` in Node to become a real peer with its own `hello`. This is the
  shape for a **remote** agent (a hosted assistant, a second machine), it needs no local port, and it is
  the reason to keep the bridge behind a `BridgeTransport` interface — Phase 0 defines that interface
  with A's implementation, and B becomes a second implementation later. It is deliberately *not* first:
  a full protocol + WebRTC client in Node is a week of work on its own.
- **C — in-tab only.** A typed `window.__vttAgent` surface (the D-045 `__vttE2E` pattern, without the
  `?e2e` gate). Rejected as a product: an LLM cannot reach a page object. Kept as the **test** surface —
  the e2e specs drive the same registry the sidecar does, with the transport mocked.

---

## 3. Identity, roles and rights

### 3.1 The agent is a user, and the existing permission engine is the boundary

`src/core/permissions.ts` already implements the whole policy this feature needs:

| Agent kind | Role | Effect (existing code, not new) |
|---|---|---|
| **GM agent** (full) | `GM` or `ASSISTANT` | `can()` returns true for everything; projection is unfiltered (`projection.ts:67`); GM-only data (hidden tokens, `blindroll` results, `<secret>` journal blocks) is readable |
| **Partial agent** (create but not delete, no GM-only data, no fog control, …) | `ASSISTANT` or `TRUSTED` + a **capability mask** | role gives a base; the mask *removes* tool classes the GM unticks; reads of GM-only data are withheld by the bridge's own projection pass |
| **Player agent** (its own character only) | `PLAYER` + an owned actor | `can()` gives it create-on `messages`, `TRUSTED`-style token/drawing creates only if promoted, and `update`/`delete` only on documents it owns (owner ≥ OWNER); `projection.ts` strips hidden tokens, whispers it is not in, GM-only roll results and journal secrets |
| **Observer** (read-only analyst) | `PLAYER` + `read` capabilities only | Every write tool is refused by the mask before it reaches the host |

Two consequences worth stating plainly:

1. **The host remains the only authority.** The capability mask is UX plus defence in depth; the real
   enforcement is the host's validation of every `Intent` (§4/§5) — so even a bug in the bridge cannot
   grant a player-scoped agent a GM write.
2. **Attribution is free.** `OpEnvelope.by` is the agent's user id, so the OpLog, undo, the chat cards
   and the world file all say which agent did what — no parallel audit system is needed for
   attribution (an audit *log* for the GM's eyes is still proposed, §7.4).

### 3.2 Granting it

- The agent connects (over the bridge) as a **pending session**, the same state a joining human sits in:
  `HostSync` exposes `approve(role)` (`host/sync.ts:99`, `:633`, default `"PLAYER"`), which creates the
  `user` document and sends `welcome`.
- A new **Agents** window (Settings → Agents) lists pending/approved agents and lets the GM pick: role,
  capability checkboxes, scene scope ("only scene *Goblinwood*"), and a **Revoke** button that kicks the
  session (`kick`/`ban` already exist).
- The grant itself is a replicated `settings` document (`_id = "agents"`, key `grants`), so it survives a
  reload, is visible to every replica, and is itself undo-able — the same posture as `worldSettings`.
- Strings and identity: the `user.name` is `"<name> (agent)"` so chat and the turn tracker label it
  honestly, and the agent's `flags.core.agent = {client, version, session}` marks documents it authored.

---

## 4. Capabilities

```ts
// src/core/agents/capabilities.ts — pure, unit-tested
type AgentCapability =
  | "world.read" | "gmOnly.read" | "chat.read" | "chat.speak" | "chat.whisper"
  | "doc.create" | "doc.update" | "doc.delete"
  | "token.move" | "token.properties" | "scene.manage" | "scene.activate"
  | "fog.control" | "fog.reveal" | "time.control" | "dice.roll" | "dice.apply"
  | "combat.control" | "strategic.read" | "strategic.order" | "hexcrawl.read" | "hexcrawl.travel"
  | "assets.write" | "undo";

const PRESETS: Record<AgentPreset, AgentCapability[]> = { /* gm, gm-no-delete, player, observer */ };
```

Every tool declares the capability it needs (§5, one column); the bridge refuses a call whose capability
the grant lacks and answers with an MCP tool error carrying the reason in plain words ("this agent may
not delete documents — ask the GM to change its grant"), which is exactly what an LLM needs to route
around a refusal instead of retrying it.

---

## 5. The tool catalogue (proposal)

Names are `namespace.verb`; every tool returns JSON (and a short human sentence an LLM can quote). Rows
marked **[F1]** depend on `HEXCRAWL_SCENE_SPEC_AND_PLAN.md`.

### 5.1 Session and world

| Tool | Does | Authority path | Cap |
|---|---|---|---|
| `whoami` | id, role, capabilities, bound actor, active scene | bridge | — |
| `world.info` | world id, name, system, clock, scene list (name, id, scale, active) | store read | `world.read` |
| `world.snapshot` | counts per collection + last seq (cheap "what has changed" poll) | store read | `world.read` |
| `undo.last` | undo the last envelope *this agent* authored | `UndoStack` | `undo` |

### 5.2 Scenes, grids, maps

| Tool | Does | Cap |
|---|---|---|
| `scene.list` / `scene.read` | scene metadata: name, size, grid type/layout, cell scale, darkness, fog flags, token counts | `world.read` |
| `scene.create` | new scene (name, width/height, grid) | `scene.manage` |
| `scene.update` | name, darkness, grid (`type/size/distance/units/diagonals/hexLayout`), fog flags | `scene.manage` |
| `scene.duplicate` | copy a scene (all embedded docs re-keyed; assets shared by hash) — the missing primitive the hexcrawl hand-off (F1 5d) also needs | `scene.manage` |
| `scene.activate` | make a scene active for the table | `scene.activate` |
| `scene.upload_map` | bytes → `ImportPipeline.importImage` → `{img,width,height}` (needs `asset.put`, §7.2) | `assets.write` |
| `scene.describe` | the *representation*: grid, scale, fog summary, token list with cells, wall count, a rendered text map (below) | `world.read` |
| `map.render` | `format: "ascii" \| "json"`, region (whole scene / around a token / a rect), options `showWalls`, `showFog`, `showTokens` | `world.read` |
| `grid.cells` | the cell set with terrain/revealed flags (hexcrawl) **[F1]** | `hexcrawl.read` |

`map.render` is the piece that makes "LLM as GM" real. Proposal for the ASCII form — 1 character per
cell, token glyphs by disposition (`@` party, `H` hostile, `N` neutral, `F` friendly, letters from the
name when several share a cell), walls as `|`/`-`/`/`/`\`, fog as `▓` (unexplored) and `░` (GM-only), and
a legend with ids beneath. Coordinates are printed as column/row headers, and every glyph carries the id
in the JSON form, so the model can *point* at things (`token.move` by id) instead of guessing.

### 5.3 Documents (typed CRUD, per collection)

| Tools | Collections | Cap |
|---|---|---|
| `actor.*`, `item.*`, `journal.*`, `playlist.*`, `macro.*`, `card.*`, `folder.*` | the top-level collections in `documents.ts:417` | `doc.create` / `doc.update` / `doc.delete` |
| `document.read` / `document.list` | any collection + embedded parent, with field filters and pagination | `world.read` |
| `document.update` | a flat diff (`FlatDiff`) on a whitelisted path set — never a wholesale replace | `doc.update` |
| `token.*` | list/create/update/delete; `token.move` (cell or world point, snapped to the grid), `token.properties` (vision, light, disposition, hidden, size) | `token.move` / `token.properties` |

The whitelist matters: the whole point of typed tools is that the agent cannot write `ownership`, `flags`
internals or `_id`s it should not touch. Unknown paths are refused with the list of writable ones.

### 5.4 Actors and sheets

| Tool | Does | Cap |
|---|---|---|
| `bestiary.search` | ranked search over the compendium index (`rankIndex`) — names, kinds, packs | `world.read` |
| `actor.from_compendium` | import one compendium entry as an actor (**the D-264/D-267 import front door**: `importCharacter` with a compendium entry) and optionally place a linked token | `doc.create` + `token.move` |
| `actor.from_statblock` | paste text → the D-267 statblock reader → actor (the agent can be handed a monster write-up and put it on the table) | `doc.create` |
| `sheet.read` | the *derived* PF1e sheet for an actor (the derivation `e2eHook.pf1eActorSystem` reads) — AC, saves, hp, attacks, skills, feats | `world.read` |
| `sheet.set` | a whitelisted patch (hp, conditions, prepared spells, notes) | `doc.update` |

### 5.5 Table flow

| Tool | Does | Cap |
|---|---|---|
| `chat.post` | a message as the agent (public, or `gmroll`/`blindroll` per the mode rules) | `chat.speak` |
| `chat.whisper` | a message to named users (GM grant decides whether the agent may whisper *to players*) | `chat.whisper` |
| `chat.read` | the last N messages it may see (projection applies: a player agent does not read GM-only results) | `chat.read` |
| `dice.roll` | a formula through the verified dice path (`rollVerified` semantics, host seed) | `dice.roll` |
| `dice.apply` | apply a roll's damage/heal to an actor (`rollApply`) | `dice.apply` |
| `combat.start` / `combat.add` / `combat.next` / `combat.end` | the turn tracker, including the round-wrap clock delta | `combat.control` |
| `time.get` / `time.advance` / `time.set` | the replicated world clock (`advanceWorldClockOps`) — "three days pass" is one call. There is one integral clock: a round is 6 s, an hour 600 rounds, a day 14,400 rounds (`HEXCRAWL_SCENE_SPEC_AND_PLAN.md` §3.7), so the agent reasons about time in the same units the combat tracker and the hexcrawl travel spend | `time.control` |
| `fog.reveal` / `fog.hide` / `fog.state` | the manual mask and, on a hexcrawl scene, the cell reveal set **[F1]** | `fog.reveal` / `fog.control` |
| `encounter.roll` / `encounter.place` | draw from a random-encounter table and put the rolled tokens on the map or a battle scene **[F1]** | `hexcrawl.read` + `token.move` |

### 5.6 Strategic and hexcrawl play

| Tool | Does | Cap |
|---|---|---|
| `strategic.snapshot` | armies/units/factions with positions and strengths (the §9A model) | `strategic.read` |
| `strategic.order` | submit movement/attack orders for a turn | `strategic.order` |
| `strategic.report` | the last turn report (the same data `turn.report` carries) | `strategic.read` |
| `hexmap.render` | text hex map with terrain letters, the party marker and revealed/unrevealed marks **[F1]** | `hexcrawl.read` |
| `time.of_day` | derived day/night phase and hour from the one clock (never stored) **[F1]** | `world.read` |
| `hex.read` / `hex.describe` | one cell's terrain, description, tables, features (GM-scoped data withheld from a player agent) **[F1]** | `hexcrawl.read` |
| `travel.plan` / `travel.advance` | set a party path and advance along it, with the terrain-priced time and the encounter checks **[F1]** | `hexcrawl.travel` |

### 5.7 Resources and prompts (the other two MCP primitives)

**Resources** (read-only, subscribable) — URIs are stable and cheap to fetch:

| URI | Content |
|---|---|
| `vtt://world/<id>/overview` | world + collection counts + clock (markdown) |
| `vtt://world/<id>/scene/<sceneId>` | JSON scene + the rendered map |
| `vtt://world/<id>/scene/<sceneId>/map.txt` | the ASCII map as `text/plain` |
| `vtt://world/<id>/tokens` | token table with ids, cells, actor links |
| `vtt://world/<id>/chat?since=<seq>` | messages the agent may see |
| `vtt://world/<id>/sheet/<actorId>` | the derived sheet (markdown) |
| `vtt://world/<id>/hexmap` **[F1]** | the hexcrawl text map + cell index |
| `vtt://world/<id>/packages` | installed packages/rulesets (§12) |

Subscriptions: `resources/subscribe` on `scene/<active>` and `chat` turns the replica's change events
into throttled `notifications/resources/updated` — an agent that is *watching* the table, not polling it.

**Prompts**: `gm.narrate_scene`, `gm.run_encounter`, `gm.improvise_npc`, `player.describe_action`,
`referee.rule_question`, `strategic.advise_turn`, `hexcrawl.travel_day` — each a template that names the
tools it expects to use, so a client can offer "Run this encounter as the GM" as a one-click action.

---

## 6. The bridge (in-tab piece)

`src/app/agentBridge.ts` + `src/core/agents/{capabilities,grants,toolArgs}.ts`:

1. **Connect**: Settings → Agents → **Connect agent** mints a pairing token, opens the outbound
   WebSocket, and shows the agent as pending.
2. **Serve**: each request from the sidecar is one `tools/call`; the bridge
   (a) checks the capability mask, (b) validates the arguments against the tool's schema,
   (c) **reads** by projecting the store **as the agent's user** (`projection.ts`; for a player-scoped
   agent hosted by the GM's tab this is exactly D-262's view-as read path), or
   (d) **writes** by building an `Op[]` with the domain builder and submitting it through
   `ClientSync.submit` — one tool call, one envelope, one undo.
3. **Answer**: the tool result is the *post-state read back from the replica* (not an echo of the
   request), so a refusal or a partial application is visible to the model.
4. **Audit**: every call appends to an in-memory ring (the Agents window shows the last 200: time, tool,
   args summary, result, txId, ms) and, for writes, the GM may opt into a GM-only chat note
   ("agent Vex: created 3 tokens in *Goblinwood*").
5. **Kill**: Revoke closes the session, clears the token, and the agent's writes stay (undo is the GM's
   tool, not the connector's).

---

## 7. Specification additions

### 7.1 Proposed spec §21 (drop-in text)

> **§21 LLM connector (MCP-style).** A world MAY expose a connector that lets an external LLM act as a
> participant. The connector speaks JSON-RPC 2.0 with the MCP method set (initialize, tools, resources,
> prompts, notifications) over stdio to a client, and attaches to the host through a bridge the host
> itself dials; the app never listens for inbound connections. An agent is a session with a user
> document, a role (GM, ASSISTANT, TRUSTED, PLAYER) and a **capability grant** selected by the GM; the
> grant may add restrictions (no delete, no GM-only reads, no assets, no whispers, one scene only) but
> can never exceed the role. Every agent write travels the ordinary operation path and is therefore
> validated, rate-limited, replicated, attributed and undoable exactly like a human's. Reads are the
> projection of the world for that agent's user. The connector exposes typed tools only: no raw
> document-store access, no arbitrary op submission. Tools cover world and scene inspection, map
> rendering as text, document and token manipulation, sheets, chat and dice, the turn tracker, the world
> clock, fog, the strategic layer, and — where the world uses them — hexcrawl cells, travel and random
> encounter tables. Agent grants, pending agents and the call audit are GM-visible and revocable at any
> time.

### 7.2 The one protocol addition (optional, phase-gated)

`asset.get`/`asset.chunk` are client→host reads — there is no way for a client to *put* bytes today
(assets are host-authored, §7). If an agent should upload an image (map, token art), the protocol needs
**`asset.put`**, the next free client→host kind — `0x35` is free at the time of writing (`MsgKind` runs
`0x30..0x34` for the roll ledger; the byte is fixed when the slice lands and `PROTOCOL.md` records it):
client → host, chunked like `asset.chunk`, refused
unless the sender's grant has `assets.write`, rate-limited by the existing asset bucket, size-capped, and
answered with the content hash. It must land with `PROTOCOL.md` updated in the same commit — the repo's
`tests/core/protocol-doc.test.ts` exists precisely to catch a kind added without its documentation
(proven on `roll.apply`, D-261).

### 7.3 Documents and code this plan adds

| Where | Change |
|---|---|
| `src/core/agents/capabilities.ts` | capability enum, presets, `allows(grant, tool)` |
| `src/core/agents/grants.ts` | the `agents` settings document, `grantOps`, revoke/kick helpers |
| `src/core/agents/toolArgs.ts` | per-tool argument validation (pure, no JSON-Schema dependency) |
| `src/app/agentBridge.ts` | the WS client, request → tool dispatch, projection-scoped reads, audit ring |
| `src/ui/settings/AgentsSection.svelte` | the GM surface: pending, grants, scope, audit, revoke |
| `tools/mcp/server.mjs` + `tools/mcp/tools.mjs` | the sidecar: JSON-RPC framing, MCP methods, tool table, rate/budget guard, pairing |
| `tests/core/agents*.test.ts`, `tests/integration/mcpBridge.test.ts`, `e2e/agent_connector.spec.ts` | see §8 |
| `PROTOCOL.md` | only if `asset.put` lands (§7.2) |
| `PLAN.md` / `ROADMAP.md` / `GAP_ANALYSIS…` §5.1 | one line each: this is a **differentiator**, not a parity row — it belongs under "not in the open set, by decision" until scheduled |

### 7.4 Safety, limits and the honest failure modes

| Concern | Answer |
|---|---|
| Authority | Host-side validation of every op; the bridge cannot bypass it. A GM-scoped agent is exactly as powerful as the GM's own tab — say so in the UI, because that is the truth |
| Prompt injection | World text (journals, chat, statblocks, hex descriptions) is **data**: tool results are wrapped and labelled as untrusted content, and the docs tell clients to keep "instructions from documents" out of their control flow. The real mitigation is the grant: a player-scoped agent that falls for injected text still cannot delete a scene |
| Destructive writes | `doc.delete` and `scene.manage` accept `dryRun: true`; a real delete requires `confirm: true` and returns what it removed. Batches are capped (`MAX_OPS_PER_CALL`), and the pre-state is in the OpLog, so the GM's undo is one click |
| Rate and cost | The existing buckets (`intent`/`ephemeral`/`asset`, `core/ratelimit.ts`) plus per-tool-class limits in the bridge; every read tool has a default row cap and a cursor, so a model cannot pull 25,000 compendium entries into a context window by accident |
| Secrets | No LLM key ever enters the VTT; the sidecar holds none, binds loopback by default, and requires a per-session pairing token. `pnpm size` is unaffected: the sidecar is Node-only and never bundled |
| Privacy | A player agent reads its own projection; a GM agent reads everything, including whispers — the grant UI says so in those words before it is enabled |
| Reversibility | Revoke/kick exists; grants and audit are replicated documents, so the world file records what was allowed |
| What can still go wrong | An agent can be *plausible* and wrong (narrating a door that is not there). Nothing in this design fixes that: the GM sees the audit, and the recommendation is a GM-scoped agent with `doc.delete` off by default |

---

## 8. Implementation plan

Effort scale as in `GAP_CLOSURE_ImplementationPlan.md` (S ≈ 1–2 days, M ≈ 3–5). Total **≈ 7–8 days**,
each phase shippable, each ending with the standing gates + one `DECISIONS.md` entry.

### Phase 0 — Skeleton and the bridge contract (1 day, S) — ✅ landed 2026-09-22 (D-278)
`tools/mcp/server.mjs` (JSON-RPC 2.0 framing, `initialize`, `tools/list`, `tools/call`,
`notifications/*`), `BridgeTransport` interface + the loopback WS implementation, pairing token, and two
read tools (`whoami`, `world.info`). The in-tab bridge with the capability gate stubbed to "deny
everything except the two".
*Test:* `tests/integration/mcpBridge.test.ts` — a host booted in Node on the in-memory wire
(`tests/host/sync.test.ts` is the precedent), a real MCP client over stdio, `tools/list` returns the two
tools, `tools/call world.info` returns the world's name, a third tool name returns a JSON-RPC error.

**As landed.** `tools/mcp/server.mjs` — stdio JSON-RPC with `initialize`/`ping` answered **locally**
(an MCP client handshakes the instant it spawns us, which is before any tab exists) and everything else
proxied to the tab by request id; a 30 s timeout and a `-32603` that names the Settings button when no
tab is paired, because a client waiting on an id nobody will answer is the worst failure this shape has;
HTTP **401** on a bad token and **409** on a second tab (a world has one GM, and silently stealing the
session from a browser the GM forgot about is worse than saying so); every log line on **stderr**,
because one `console.log` on stdout is a corrupt protocol stream · `src/core/agents/bridge.ts` — the
JSON-RPC 2.0 + MCP method core over `BridgeTransport`. §7.3 put this in the app; it is in `core` so the
method table, the error codes and the refusal semantics are unit-testable without a browser and
identical in the tab and in Node · `src/core/agents/tools.ts` — the catalogue, the argument validator
(a JSON-Schema subset with no dependency, §9 risk 1) and `callTool`; this is §7.3's `toolArgs.ts` under
a name that says what it holds, because the two are one table · `src/core/agents/capabilities.ts` — the
vocabulary, the four presets and `allows()` · `src/net/agentLink.ts` — the outbound WebSocket
transport, beside the app's other transports, on the platform `WebSocket` so the integration test
drives the real thing · `src/app/agentBridge.ts` — the app's wiring and nothing else: the
`AgentWorldView` over `ClientSync` and `connectAgentBridge()`.
*Deferred, and §7.3's file table updated accordingly:* `grants.ts` — the replicated `agents` settings
document, the scene scope and the Agents window belong to Phase 2. A grant document with no UI to grant
it from is a document nobody can explain.
*Two decisions the plan left open, taken in D-278:* a **refusal is a tool result** (`isError` plus §4's
plain words) while a **malformed call is `-32602`** — "you may not delete" is information, "no tool
named `scene.delete`" is a client bug, and conflating them teaches an agent the world is closed to it;
and `whoami` names the **session** (whose replica the reads come from) and the **grant** (the ceiling)
apart, because Phase 0 hosts the bridge in the GM's tab and an agent that reads "role GM" and stops
there would draw exactly the wrong conclusion.
*Tests:* `tests/core/agentsCapabilities.test.ts` (7) · `tests/core/agentsTools.test.ts` (10) ·
`tests/integration/mcpBridge.test.ts` (8 — host in Node, the **real sidecar as a child process**, a real
socket, a JSON-RPC client over stdio). The bundle is **byte-identical** to the Phase 0 baseline
(3 142 835 B raw): nothing in the app graph imports the bridge yet, and it starts costing when Phase 2's
Agents window does.

### Phase 1 — The read surface and the representations (1.5 days, M) — ✅ landed 2026-09-22 (D-279)
`scene.list/read/describe`, `map.render` (ASCII + JSON, with the legend and ids), `document.read/list`,
`token.list`, `chat.read`, `sheet.read`, `bestiary.search` (over `rankIndex`), resources
(`vtt://world/...`) + pagination + the read caps, and **redaction** for a non-GM agent.
*Test:* renderer unit tests (a 12×9 fixture scene: tokens, a wall, fog) with byte-exact expected output;
a player-scoped read of a hidden token returns nothing; pagination boundaries.

**As landed.** `src/core/agents/types.ts` — the `AgentWorldView` **port** the tools read through, so the
tool table never touches `ClientSync` and the whole read surface is testable without a browser ·
`src/app/agentBridge.ts` — the app's one implementation of it · `src/core/agents/paging.ts` (§7.4 caps:
50 default, 500 hard, opaque-but-readable `o:<offset>` cursors) · `src/core/agents/mapRender.ts` — the
text map · `src/core/agents/{baseTools,readTools}.ts` — the ten new tools behind the two from Phase 0 ·
`src/core/agents/resources.ts` — §5.7's `vtt://world/...` resources, dispatched **through the tools**.

*Five decisions the plan left open, taken in D-279:*
- **A resource is the tool's answer wearing a URI.** `resources/read` calls `callTool`, so the grant that
  refuses `token.list` refuses `vtt://world/<id>/tokens` and there is one place to get a redaction wrong.
- **A third way a call can end.** A refusal (`isError` + §4's plain words) is information; a **malformed
  call** (`{ invalid }` → `-32602`) is a client bug; and a **thrown** tool becomes an error result, never
  an unanswered id. A bad cursor is the second kind specifically: treating it as "start again" would let
  an agent with a self-built cursor re-read page 1 forever and look like it was making progress.
- **Walls paint over fog, never over a token.** Precedence is tokens > walls > fog > empty: fog says what
  a *player* has seen, and a map that hides every door behind an unexplored cell is unnavigable.
- **`@` is the party, `F` is an ally** — friendly *with* an `actorId` versus friendly without; two tokens
  sharing a cell fall back to a letter from the name, and the legend carries the ids, because the glyph
  is not the answer, the id is.
- **Redaction is two gates, not one.** The capability gate (`world.read`, `chat.read`) and then
  `gmOnly.read` on hidden tokens and GM-only roll results — and the answer says how many were withheld,
  because "2 tokens" from a grant that can see 3 is a lie by omission.

*Tests:* `tests/core/agentsMapRender.test.ts` (8, byte-exact over a 12×9 fixture with a wall, fog, hex
placement and a shared cell) · `tests/core/agentsReadTools.test.ts` (21, over a shared fixture world in
`tests/core/agentsFixture.ts`) · `tests/core/agentsTools.test.ts` (10, updated for the grown catalogue) ·
`tests/integration/mcpBridge.test.ts` (10 — `scene.list` and `map.render` answered out of a **host's
replica** over the real sidecar, plus `resources/list`, `resources/templates/list` and `resources/read`).
The bundle stays **byte-identical** (3 142 835 B raw): still nothing in the app graph imports the bridge.

*Two caveats, stated in `agentBridge.ts` itself:* the reads are the **GM's replica** — §5.3's
`projectWorld()` routing is Phase 3 and no agent should meet a live table before it lands — and there is
**no UI**: Phase 2's Agents window is the production entry point, so today the bridge is reachable only
from a test or a console.

### Phase 2 — Writes, grants and the GM surface (1.5 days, M) — ✅ landed 2026-09-22 (D-280)
`document.create/update/delete`, `token.*`, `scene.create/update/duplicate/activate`, `chat.post`,
`dice.roll`, one-envelope-per-call, `dryRun`/`confirm`, the Agents window (pending, role picker,
capability checkboxes, scene scope, audit ring, revoke), and the GM-only chat note option.
*Test:* grant matrix (each preset × each tool class → allowed/refused with the documented reason);
an agent with `gm-no-delete` gets a refusal from *both* the bridge and the host; a `doc.create` call
appears as exactly one `OpEnvelope` with `by = agent`, undoable by the GM in one click.

**As landed — and the decision everything else follows from: the agent is a *user with its own
session*, not a mask on the GM's.** `OpEnvelope.by` is host-stamped from the session's user id
(`host/sync.ts:842`), so there is no way to claim a different author, and a write made through the
GM's `ClientSync` is the GM's write. `src/app/agentSession.ts` therefore mints a user document
(`"Vex (agent)"`, role from the preset) **and** the grant in one system envelope, then opens a second
`ClientSync` over the same in-memory loopback the GM's own session rides. Three things fall out of
it rather than being implemented: attribution is free; the host sends this session a *projected*
envelope (`host/sync.ts:1004`), so Phase 3's redaction is the projection's job in the one place it is
already proved; and the host validates against the agent's role, so the mask stays UX plus defence in
depth.

- **`src/core/agents/grants.ts`** (§3.2) — the grant is a replicated `settings` document
  (`_id = "agents"`): it survives a reload, every replica can read what is allowed, and a grant
  changed by accident is one Ctrl+Z away. Revoked records are kept.
- **`src/core/agents/writeTools.ts`** — ten tools. **One call, one envelope** (capped at 25 ops);
  the answer is the **post-state read back**, never an echo; `dryRun` before `confirm`; and a refusal
  is the **host's own sentence** (`the host refused this change (forbidden): delete scenes`), not a
  summary of it. The whitelist is why they are typed: `name` and `system.*` are writable, `ownership`
  /`_id`/`flags` never are. Redaction gates writes too — an agent that cannot read a hidden token
  cannot move it, wherever it guessed the id from.
- **`src/core/agents/types.ts`** — the §6.2 write port. `submit()` **waits for the host's verdict**:
  `ClientSync.submit` only returns a txId, and answering "done" at submit time would be a lie about
  the world.
- **`src/app/agentManager.ts` + `src/ui/settings/AgentsSection.svelte`** — the GM surface: presets
  with §7.4's warning on screen, capability boxes that can only narrow a preset, scene scope, the
  GM-only chat note, and the §6.4 **audit ring** — which records *attempts*, not just successes,
  because what an agent tried is the half the OpLog cannot show.

*Three decisions the plan left open, taken in D-280:* a **pending or revoked agent holds no
capabilities at all** (an agent that connects before the GM has looked at it must not be able to read
the world); `undo.last` pops only when the top of the stack is the agent's **own** change, because
inverses for an older envelope were computed against a world that has moved on; and **`users` is
never creatable by an agent** — an agent that can mint an identity is the security model inverted.

*Tests:* `tests/core/agentsGrants.test.ts` (12) · `tests/core/agentsWriteTools.test.ts` (28 — the
grant matrix over four presets × ten tools, the whitelist, dryRun/confirm, the cap, cell→pixel, the
host's refusal verbatim) · `tests/integration/agentManager.test.ts` (8) ·
`tests/integration/mcpBridge.test.ts` (14 — a write tool lands as **one envelope, one op, `by =
agent`**, `undo.last` takes it back, the mask refuses a `gm-no-delete` delete, and a `player` agent
whose grant *allows* `token.move` is still refused **by the host**, because the token is the GM's and
`can()` wants OWNER). **The bundle moves for the first time: 3 213 166 B raw / 926 492 B gzip
(+70 331 B)** — the connector is now in the app graph, and that is the number to watch.

### Phase 3 — Player-scoped agents and the projection proof (1 day, S) — ✅ landed 2026-09-22 (D-281)
`actor.from_compendium` / `actor.from_statblock` (the D-264/D-267 importers), `token.move` restricted to
owned tokens, `chat.whisper` policy, and the *proof* test: a `PLAYER` agent's replica is compared
field-by-field with `projectWorld()` for that user, with hidden tokens, whispers and GM-only rolls
asserted absent — the same posture the player shell's own e2e already takes.
*e2e (`agent_connector.spec.ts`, Chromium):* start the sidecar, boot the app, pair, call
`bestiary.search` + `actor.from_compendium` + `token.move`, and assert the canvas shows the token; then
connect a second agent as `PLAYER` and assert a `scene.delete` call is refused and nothing changes.

**As landed — and the one thing the proof found.** `tests/integration/agentProjection.test.ts` (12)
boots a real `HostSync`, opens a `player`-preset agent session, and compares the replica it holds
against `projectWorld()` collection by collection and **document by document** (`JSON.parse(JSON.stringify(doc))`),
so a projection that keeps a document but forgets a field fails the test rather than a player. It then
asserts the three must-never-see items are absent from the documents: the hidden token is not a row at
all, the whisper the agent was not in is not in the replica, and the `gmroll` card is there with
`roll: null`. A `gm` agent on the same world sees all three, and `<secret>` journal text is stripped
while the visible text survives — the projection's own rules, proved at the connector's boundary.

*The hole the proof found:* `projectMessage` redacts a GM-only roll by nulling `roll`, but the total is
in the content too, as an inline `[[16|1d20+5]]` chip — which the player's chat renders, and an agent
reads as text. `agentWorldView` strips it (`[rolled 1d20+5]`) and `chat.read` says
`[result withheld from this grant]`. Being **stricter** than the player shell is allowed; being wider
never is.

*Three decisions taken in D-281:* `token.move` is **ownership-scoped** (the bridge mirrors `can()`, one
layer earlier, so the refusal can name what to ask for — and `mcpBridge.test.ts` proves the mirror is a
convenience by handing the GM's token back *without* letting the replica catch up, where the host is
the one that refuses); `actor.from_compendium` imports the **pack's own payload** rather than running it
through `importCharacter`, because a pack entry is already this app's document shape and re-reading it
as an export would author an actor that opens as a blank sheet — `actor.from_statblock` is where the
D-264/D-267 reader belongs, and it hands the importer's report (`read`/`warnings`) back to the agent;
and the Phase 3 **e2e is not run** — this environment has no Chromium, and the repo's e2e needs
Playwright's — so the run that puts the Agents window on screen stays outstanding. What replaces it
here is a real-host integration test: `bestiary.search → actor.from_compendium` lands an actor and its
token in **one envelope stamped `by` the agent**, and a pasted `Goblin Warrior` stat block becomes a
real actor (hp 6, Dex 15, owned by the session that imported it) with a token on the table.

### Phase 4 — Table flow, time, strategic (1 day, S) — 🚧 clock + tracker landed 2026-09-22 (D-284)
`combat.*`, `time.*`, `dice.apply`, `fog.*` (mask + state), `strategic.snapshot/order/report`.

**As landed so far — the clock and the tracker (D-284).** `time.get` / `time.of_day` /
`time.advance` / `time.set`, and `combat.state` / `start` / `add` / `next` / `end`. Time passing is
**one call with the sweep in the same envelope** — byte-for-byte the ops the Settings window's
*day* button submits, proved by deep equality rather than by "the clock moved" — on the world's own
ladder (a minute is 10 rounds, not 60 wall-clock seconds), and a backward jump expires nothing
because time un-passing has not cast a spell in reverse. `time.get` is the control-plane number
(`time.control`); `time.of_day` is the derived hour, phase and day (`world.read`). The tracker calls
the app's own engine — PF1e's `startWithSurprise` and `pf1eNextTurn`, so a surprise round and an
unresolved initiative tie are the rules' own verdicts — moves the world clock by the transition's
`clockDeltaSeconds` **only** where the world advances it on a round wrap, and reports a dying
creature's stabilization check instead of rolling it. `combat.state` is an addition to §5.5's table:
`combat.next` without a way to read the order advances a tracker it cannot see. **Still to come:**
`dice.roll` / `dice.apply` (host-executed, so these two are async: the client sends, the host rolls
and commits the card, and the tool reads the number back off the replica), `fog.*`, and
`strategic.*`.
*Test:* the agent runs a full round (start combat, next turn, apply damage) and the clock advances by
exactly `secondsPerRound`; a `time.advance` of 3 days sweeps the clock-counted effects exactly as the
Settings buttons do.

### Phase 5 — Hexcrawl tools (1 day, S) — ✅ landed 2026-09-22 (D-282, D-283) — **depends on `HEXCRAWL_SCENE_SPEC_AND_PLAN.md`**
`hexmap.render`, `hex.read/describe` (GM fields withheld from a player agent), `hexcrawl.cells`,
`travel.plan/advance`, `encounter.roll/place`.
*e2e:* the agent walks the party three hexes along a path, the clock advances by the terrain-priced
amount, the encounter engine fires the expected table, and the rolled tokens land on the copied battle
scene (the F1 acceptance, driven by the agent instead of the UI).

**As landed so far — the read surface (D-282).** `hexcrawl.cells`, `hex.read`, `hex.describe` and
`hexmap.render`, all `hexcrawl.read`, plus the `vtt://world/<worldId>/hexmap` resource. They read the
replica and add nothing to it: **a closed cell is not on a player's replica at all** (D-271), so the
tools never check a "revealed" flag — a cell the party has not been shown is simply not there, and
`hex.read` refuses with "hexcrawl.cells names the ones you may see" rather than inventing an empty hex.
`hexmap.render` draws a **window, not the world** — 48×24 cells, centred on the party or on the cell
the agent names with `around`, and it says when it clamped, because a 20 000-hex map pasted into a
context is a denial of service dressed as an answer. Both forms come back on every call: the ASCII a
model quotes, and the JSON grid (a key per glyph) it points with. Terrain letters are derived from the
catalog's own names, so a custom catalog reads the same way, and the legend counts only the glyphs
actually drawn — a hex under cover is not a "P" the reader can find on the map. The renderer is pure
(`src/core/agents/hexRender.ts`, byte-exact tested); the region is decided in the view, where the data
is. `hex.read` prints the GM's text and the table's text as two lines (`Notes (GM):` / `Reads (table):`)
rather than whichever the replica happens to carry, because they are different facts and only one of
them is on a player's replica.

**As landed so far — the walk and the fight (D-283).** `travel.plan`, `travel.advance`,
`encounter.roll` and `encounter.place`. A march is **one envelope** — clock sweep, then progress,
then the party's new position, then the feature reveals — so there is no moment at which the world
says the party is in the next hex with the old time on the clock, and `undo` takes the whole march
back rather than half of one. Reveals are judged at `startClock + delta` with the **party's own
perception** (the party token's actor, else the best Perception among the party's sheets), so a
scout in the party changes what a march finds and no tool call has to say who. `encounter.roll`
rolls and reports — and writes the check's ledger, so the same check cannot be re-rolled inside its
cooldown — while `encounter.place` is what puts tokens on the table; the split is deliberate, since
a GM agent may want to describe the warband before three goblins appear. Placing needs
`hexcrawl.travel` **and** `token.move`, and says which is missing. `hexcrawl.read` joins the `player`
and `observer` presets (the party's map is part of the world a player sees, and the projection
decides how much of it); `hexcrawl.travel` does not, because a march spends the table's clock and
moves the token every player shares. Phase 5 is **complete**, and it is proved end-to-end on a real
`HostSync` hexcrawl world: a player replica holding one cell of three, and a march that moves the
clock and the party in one envelope by the agent.

### Phase 6 — Hardening, budgets, docs (1 day, S)
Rate classes and read caps tuned against a real 25k-entry world; the `dryRun`/`confirm` ergonomics; the
prompts (`gm.narrate_scene`, `hexcrawl.travel_day`, …); Help → *Agents* page (what it is, what it can
see, how to revoke); a `MCP_CONNECTOR.md` reference for the tool table; and the closing decisions.

### Sequencing note
Phases 0–2 give a GM-scoped agent that can run a table. Phase 3 is what makes "the LLM plays a character"
defensible, and it should not be skipped before letting any agent near a live table — it has landed, and
the one gate it leaves open is the **e2e**: no browser here, so no run has put the Agents window on
screen. Any environment with Chromium should write `e2e/agent_connector.spec.ts` next.

---

## 9. Risks and open questions

1. **MCP revision churn.** The protocol is young and its transports have already changed once
   (HTTP+SSE → Streamable HTTP). Recommendation: implement the *method subset* ourselves (no SDK
   dependency in the sidecar's runtime path), version the tool schemas in one table, and declare the
   protocol revision we speak in `initialize`. *Needs a product call on whether to depend on the official
   SDK for cheap future-proofing.*
2. **Which side owns the LLM loop.** This document deliberately stops at "a client can drive a tool
   surface". Autonomous GM-ing (the agent deciding to roll encounters without being asked) is a *client*
   concern; the connector only provides events (`notifications/resources/updated`) and tools.
3. **Latency vs the table.** A model takes seconds per call; the turn tracker is instant. Recommendation:
   agent actions are **never** on the critical path of a human's turn — the design has no auto-commit and
   no blocking prompt.
4. **Multi-agent.** Two agents are two users; nothing in the design prevents it, and the grants make it
   explicit. Recommend shipping one-agent-at-a-time UX first.
5. **Whisper policy.** Whether an agent may whisper *to players* (channel use) is a real table question,
   not a technical one; the default is off and it is a grant toggle.
6. **Should the agent write chat as a "user"?** Recommended yes (`"<name> (agent)"`), because the
   alternative (an invisible narrator) makes attribution lies the default.
7. **`asset.put`.** Only needed for image upload; it is the sole wire change. If the product never wants
   an agent uploading art, delete §7.2 and the tool, and the feature adds no protocol kinds at all.
8. **Exposing the strategic simulator.** `strategic.order` is a small call with a large consequence (a
   10k-model turn). Recommendation: keep `strategic.order` behind an explicit opt-in and never batch it
   with `turn.advance`.

---

## 10. What this plan deliberately does not do

- **No raw store access, no `ops.submit`, no arbitrary SQL-like query tool.** Typed tools only; the
  model's affordances are the app's own domain verbs.
- **No server-side LLM.** The connector never hosts a model, never stores API keys, never calls out to a
  provider. It is a socket and a permission gate.
- **No browser-side listener.** The tab dials out; there is no new attack surface behind the GM's browser.
- **No bypass of projection for "convenience".** A player-scoped agent reads exactly what a player reads,
  including the failure modes (a hidden token simply is not there) — anything else would make the
  permission model a lie.
- **No autonomy, no scheduling, no background agents** in v1: every write is a call the client made.
- **No public exposure.** Loopback by default; remote agents are Phase-Later and ride the existing
  signaling/WebRTC stack (architecture B), not a new internet-facing service.
- **No edits to `PF1e_Unified_TODO.md`** (`scripts/coverage.mjs` derives from its checkboxes).

---

## Appendix A — why the bound identity is the whole design

The interesting requirement in the request is not "an LLM can move tokens" — that is a socket and a
switch statement. It is *"the GM chooses the rights, up to and including full GM access, down to
one-character play"*. This app already answers that question for humans: `can()` decides, projection
filters, the host enforces, the OpLog attributes. So the connector's job is to *reuse* that answer rather
than invent a parallel one — an agent is a user, a grant is a subtraction from what the role already
allows, and every tool is a domain verb the app itself would run. Everything else in this document is
detail hanging off that one decision.
