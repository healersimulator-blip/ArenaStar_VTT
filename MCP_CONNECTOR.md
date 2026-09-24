# MCP connector

An MCP-speaking client — Claude Desktop, a coding agent, anything that speaks the Model Context
Protocol over stdio — can sit at this table. It reads the world, rolls dice the table can see, moves
tokens, and writes documents, all as **its own user with its own session**. This file is the
reference for that surface: what is on it, what is not, and who decides.

## What it is

Three pieces, because the browser cannot listen for a socket:

```
  LLM client ──stdio (JSON-RPC)──▶ vtt-mcp (sidecar) ──ws://127.0.0.1:8787──▶ the GM's tab
```

The **tab dials out**. Nothing listens for inbound connections except the sidecar, on loopback, and
only for the one tab that presents the pairing token — which is what lets this work from `file://`,
behind a router, and inside a browser sandbox. The sidecar answers `initialize` and `ping` so a
client can handshake before a tab exists, and proxies everything else to the app. **One registry, one
gate**: a sidecar that kept its own copy of the tool table would be a second place to forget to
enforce a grant.

## Connecting

1. **Settings → Agents → Add** — give the agent a name (it becomes the user the table sees) and a
   preset. Its grant lives in a replicated document, so it survives a reload and every replica can
   see what was allowed.
2. **Start the sidecar** — `pnpm mcp` from a clone. It prints the port and the pairing token to
   **stderr** (stdout is the protocol channel and nothing else).
3. **Connect** — paste `ws://127.0.0.1:8787` and the token into the agent's Connect row. The tab
   dials *out* to the sidecar; the app never listens on a port.
4. In your client's MCP config:

   ```json
   {
     "mcpServers": {
       "arenastar": {
         "command": "node",
         "args": ["tools/mcp/server.mjs", "--port", "8787", "--token", "<token>"]
       }
     }
   }
   ```

The client then handshakes — `initialize` is answered by the sidecar, so a client can connect before
a tab exists — and the tools, resources and prompts appear.

Revoking is one click: **Revoke** marks the grant revoked, and every op it ever submitted stays
attributed to it in the OpLog, so the undo stack and the world file keep the record. Tick **Post a
GM-only chat card for every write** and the table sees what it did as it does it.

## The security model, in one paragraph

**The host remains the only authority.** An agent's ops go through the same `Intent` pipeline, and
the same `can()` check, as a human's — so a bug in the bridge cannot hand a player-scoped agent a GM
write. The capability vocabulary below is *not* the boundary; it is the UX of the boundary plus
defence in depth. On top of that:

- An agent is a **user with a session**, so `OpEnvelope.by` carries its id — attribution for free.
- **Projection**, not the world: an agent reads the same document a player's screen holds, so
  `gmOnly` content it may not see is *absent from the answer*, not blanked out after the fact.
- **Refusals explain themselves**: "this agent may not delete documents — ask the GM to change its
  grant". A model told *why* a door is closed stops pushing on it; one told "error" does not.
- **The dice are the host's.** An agent may *ask* for a roll and may *apply* a roll's card; it may
  never name the numbers.

## Tools

`tools/list` serves this table. Every tool declares the one capability it needs; `null` means it
needs nothing (`whoami` is always answerable, because an agent that cannot ask who it is cannot route
around any other refusal).

The table below is **generated** — rendered from the registry by `src/core/agents/docs.ts` and
asserted by `tests/core/agentsDocs.test.ts`, so the reference cannot drift from the code. Add a tool
and forget this file, and the suite fails.

<!-- BEGIN GENERATED TOOLS -->

**57 tools**, each naming the one capability it needs. Scan the table, then read the tool you want.

| Tool | Capability |
|---|---|
| `whoami` | `— (always answerable)` |
| `world.info` | `world.read` |
| `world.snapshot` | `world.read` |
| `scene.list` | `world.read` |
| `scene.read` | `world.read` |
| `scene.describe` | `world.read` |
| `map.render` | `world.read` |
| `document.list` | `world.read` |
| `document.read` | `world.read` |
| `token.list` | `world.read` |
| `chat.read` | `chat.read` |
| `sheet.read` | `world.read` |
| `bestiary.search` | `world.read` |
| `hexcrawl.cells` | `hexcrawl.read` |
| `hex.read` | `hexcrawl.read` |
| `hex.describe` | `hexcrawl.read` |
| `hexmap.render` | `hexcrawl.read` |
| `time.get` | `time.control` |
| `time.of_day` | `world.read` |
| `combat.state` | `world.read` |
| `fog.state` | `fog.control` |
| `strategic.snapshot` | `strategic.read` |
| `strategic.report` | `strategic.read` |
| `document.create` | `doc.create` |
| `document.update` | `doc.update` |
| `document.delete` | `doc.delete` |
| `actor.from_compendium` | `doc.create` |
| `actor.from_statblock` | `doc.create` |
| `travel.plan` | `hexcrawl.travel` |
| `travel.advance` | `hexcrawl.travel` |
| `encounter.roll` | `hexcrawl.read` |
| `encounter.place` | `hexcrawl.travel` |
| `time.advance` | `time.control` |
| `time.set` | `time.control` |
| `combat.start` | `combat.control` |
| `combat.add` | `combat.control` |
| `combat.next` | `combat.control` |
| `combat.end` | `combat.control` |
| `dice.roll` | `dice.roll` |
| `dice.apply` | `dice.apply` |
| `fog.reveal` | `fog.reveal` |
| `fog.hide` | `fog.reveal` |
| `strategic.order` | `strategic.order` |
| `hex.write` | `hexcrawl.author` |
| `hex.reveal` | `hexcrawl.author` |
| `hexcrawl.configure` | `hexcrawl.author` |
| `encounterTable.create` | `hexcrawl.author` |
| `encounterTable.update` | `hexcrawl.author` |
| `encounterTable.delete` | `hexcrawl.author` |
| `asset.import` | `assets.write` |
| `token.move` | `token.move` |
| `token.properties` | `token.properties` |
| `scene.create` | `scene.manage` |
| `scene.update` | `scene.manage` |
| `scene.activate` | `scene.activate` |
| `chat.post` | `chat.speak` |
| `undo.last` | `undo` |

<!-- GENERATED: this table is rendered from the tool registry by
`src/core/agents/docs.ts` and asserted by `tests/core/agentsDocs.test.ts`. Edit the tools,
then re-run that test with `UPDATE_AGENT_DOCS=1` — do not hand-edit the rows below. -->

### World and scenes

What the table is looking at.

**`scene.list`** — capability `world.read`

Every scene this agent may see: id, name, size, grid and scale, token and wall counts. The active one is marked with *.

  _Takes no arguments._

**`scene.read`** — capability `world.read`

One scene's metadata: size, grid and layout, scale, darkness, fog configuration and counts. Pass no id for the active scene. Use scene.describe for the contents, map.render for the picture.

  Arguments:
    - `sceneId` (string) — Scene id; omit for the active scene

**`scene.describe`** — capability `world.read`

The scene as an agent would want it: metadata, every token with its cell and disposition, the wall count, fog, and the rendered text map inline. One call instead of four.

  Arguments:
    - `sceneId` (string) — Scene id; omit for the active scene

**`scene.create`** — capability `scene.manage`

Create an empty scene: name, size in pixels, grid type and cell scale. It is not activated — scene.activate does that, as its own call. Answer: the new scene's id and a read-back.

  Arguments:
    - `name` (string, required) — the scene's name
    - `width` (integer) — width in pixels (10–20000)
    - `height` (integer) — height in pixels (10–20000)
    - `gridType` (string) — "square" or "hex"
    - `gridSize` (integer) — pixels per cell (10–1000, default 100)
    - `gridDistance` (number) — world units per cell (default 5)
    - `gridUnits` (string) — the unit name (default "ft")
    - `hexLayout` (string) — "oddQ" or "evenQ", for hex grids
    - `darkness` (number) — 0–1
    - `dryRun` (boolean) — describe the op without applying it

**`scene.update`** — capability `scene.manage`

Change a scene's name, darkness, image or grid (`grid.size`, `grid.distance`, `grid.type`, …). One call, one envelope; dryRun: true describes it first.

  Arguments:
    - `sceneId` (string) — the scene id; the active scene when omitted
    - `diff` (object, required) — the flat diff, e.g. `{"name": "Goblinwood", "grid.size": 150}`
    - `dryRun` (boolean) — describe the op without applying it

**`scene.activate`** — capability `scene.activate`

Make one scene the active scene — what the table is looking at. One envelope: the new scene is switched on and the old one off together, so the world is never briefly showing two.

  Arguments:
    - `sceneId` (string, required) — the scene to activate
    - `dryRun` (boolean) — describe the ops without applying them

### The map

The canvas as text.

**`map.render`** — capability `world.read`

The scene as text: one character per cell, with column and row rulers, a glyph key and a legend of token ids. format 'json' returns the same grid with ids so you can point at things; 'ascii' is the picture. Region: omit for the whole scene, or give a rect in world pixels.

  Arguments:
    - `sceneId` (string) — Scene id; omit for the active scene
    - `format` (string) — ascii (default) or json
    - `rect` (object) — World-pixel region {x, y, w, h} to render instead of the whole scene
    - `showWalls` (boolean) — Draw walls (default true)
    - `showFog` (boolean) — Draw fog (default true)
    - `showTokens` (boolean) — Draw tokens (default true)

### Documents

The world's own records.

**`document.list`** — capability `world.read`

Id, name and type of the documents in one collection, capped and cursor-paged. collections: users, folders, scenes, actors, items, journals, rollTables, encounterTables, playlists, macros, automations, actionReceipts, prefabs, fxInstances, cards, combats, messages, settings, compendia, factions, armies, turns, depots, routes, reinforcements

  Arguments:
    - `coll` (string, required) — Collection name
    - `limit` (integer) — Rows to return (default 50, max 500)
    - `cursor` (string) — Cursor from a previous call, e.g. "o:50"

**`document.read`** — capability `world.read`

One document whole, as the view holds it (already redacted for this session). Prefer the typed tools when one exists — this is the escape hatch for the long tail.

  Arguments:
    - `coll` (string, required) — Collection name
    - `id` (string, required) — Document id

**`document.create`** — capability `doc.create`

Create one document (actor, item, journal, folder, message, macro, playlist, cards or roll table) with a name and optional fields. The document is created as the agent, in one envelope the GM can undo in one click. Answer: the created id and a read-back of the stored document.

  Arguments:
    - `coll` (string, required) — the collection to create in — actors, items, journals, folders, messages, macros, playlists, cards, rollTables
    - `name` (string, required) — the document's name
    - `fields` (object) — extra fields, under `system.*` (or `content` for a message, `command` for a macro)
    - `content` (string) — for a message: the text
    - `command` (string) — for a macro: the command
    - `targetType` (string) — for a folder: the collection it holds
    - `formula` (string) — for a roll table: the dice formula
    - `dryRun` (boolean) — describe the ops without applying them

**`document.update`** — capability `doc.update`

Patch one document with a flat diff (`{"system.hp": 5}`), on a whitelist of writable paths — `name` and `system.*`, never `_id`, `ownership` or `flags`. One call, one envelope. Answer: the paths that changed and a read-back.

  Arguments:
    - `coll` (string, required) — the collection the document lives in
    - `id` (string, required) — the document id (from document.list or scene.read)
    - `diff` (object, required) — the flat diff: `{"system.attributes.hp": 12, "name": "Vex"}`
    - `dryRun` (boolean) — describe the ops without applying them

**`document.delete`** — capability `doc.delete`

Delete one document. Destructive: `dryRun: true` describes what it would remove (including the children a scene takes with it), and the real thing needs `confirm: true`. The GM can still undo it — that is what the OpLog is for — but an agent does not get to delete by accident.

  Arguments:
    - `coll` (string, required) — the collection the document lives in
    - `id` (string, required) — the document id
    - `dryRun` (boolean) — describe what would be removed, change nothing
    - `confirm` (boolean) — required: this really is the document to delete

### Actors and sheets

Derived numbers, not stored ones.

**`sheet.read`** — capability `world.read`

An actor's derived sheet, trimmed: hp, AC (normal/touch/flat-footed), saves, initiative, BAB, CMB/CMD, speed, conditions, attacks, the skills that matter and feats. Not the whole derivation — the numbers you act on.

  Arguments:
    - `actorId` (string, required) — Actor id (see document.list actors, or a token's actorId)

### Bestiary

Search the compendia, and import from them.

**`bestiary.search`** — capability `world.read`

Ranked search over the installed compendia: names, kinds and packs. Returns ids to hand to actor.from_compendium (Phase 2). Capped — ask for what you want, not for everything.

  Arguments:
    - `query` (string) — What to look for; empty browses the packs
    - `limit` (integer) — Hits to return (default 20, max 100)

### The hexcrawl

The overworld: cells, the map, the march and what finds you on it.

**`hexcrawl.cells`** — capability `hexcrawl.read`

The authored cells of a hexcrawl scene: key ("col,row"), terrain, travel cost, whether the table has been shown it, encounter tables and features. Paged — ask for a page, not for the world. A cell the party has not been shown is not here at all, not flagged.

  Arguments:
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `limit` (integer) — Cells to return (default 50, max 500)
    - `cursor` (string) — Cursor from a previous call, e.g. "o:50"

**`hex.read`** — capability `hexcrawl.read`

One cell of a hexcrawl scene, as this agent may read it: terrain and travel cost, the text the table may see (or the GM's own, when the grant covers it), the encounter tables bound to it, and its features with the rule each is found by. A cell the party has not been shown is not here at all.

  Arguments:
    - `key` (string, required) — the cell key, "col,row" — hexcrawl.cells lists them
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted

**`hex.describe`** — capability `hexcrawl.read`

The same cell as `hex.read`, plus the ground around it — the paragraph to quote when the party arrives somewhere: what the land is, what a march costs here, what is written, what is still hidden, and what the neighbouring cells are.

  Arguments:
    - `key` (string, required) — the cell key, "col,row"
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `radius` (integer) — how many rings of neighbours to include (default 1, max 3)

**`hexmap.render`** — capability `hexcrawl.read`

The hexcrawl as a text map: one character per cell, lettered by terrain, the party marked, unrevealed ground left as cover. Column and row rulers and a legend of the terrain letters, so "12,7" in the legend and "12,7" on the map are the same hex. A big world is drawn as a window around the party — name `around` to look elsewhere. The answer always carries the JSON grid (a key per glyph), so you can point instead of count.

  Arguments:
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `around` (string) — centre the map on this cell key, "col,row"
    - `radius` (integer) — with `around`: how many cells either way (default 6, max 12)

**`travel.plan`** — capability `hexcrawl.travel`

Commit a route for the party: an ordered list of cell keys ("col,row"), with an optional pace and speed. An empty path calls the march off. One call, one envelope. Answer: the route as it now stands, and the seconds walking the rest of it costs.

  Arguments:
    - `path` (string[]) — the cell keys, in order — ["0,0", "1,0", "1,1"]
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `speedPerDay` (integer) — cells a day at open-ground cost (the scene's own when omitted)
    - `pace` (string) — "normal" or "forced"
    - `dryRun` (boolean) — describe the ops without applying them

**`travel.advance`** — capability `hexcrawl.travel`

Advance the world clock by `seconds` and walk the party along its route for exactly that long: the terrain prices each step, the party stops where the time ran out, and any feature whose time has come is revealed. One call, one envelope. Answer: where the party stands, the borders crossed, and what was found.

  Arguments:
    - `seconds` (integer, required) — how long to march (seconds; an hour is 3600, a day 86400)
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `dryRun` (boolean) — describe the ops without applying them

**`encounter.roll`** — capability `hexcrawl.read`

Ask the encounter engine what happens in one cell right now: the tables attached to it, the daylight band, and — when one fires — the die face, the table it came from and the entry it drew. A firing table writes its ledger entry (cooldown included) in one envelope. Nothing is put on the map: encounter.place does that.

  Arguments:
    - `key` (string) — the cell key, "col,row"; the party's own cell when omitted
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `trigger` (string) — what the party did — "entering", "moving" (default), "exploring" or "fighting"

**`encounter.place`** — capability `hexcrawl.travel`

Put creatures on a hexcrawl scene: one actor id with a count (or several), placed spiralling out from a cell — the drop point first, then outwards, never inside a wall. One call, one envelope. Answer: the tokens as they now stand.

  Arguments:
    - `actors` (object[], required) — e.g. [{"actorId": "a-goblin", "count": 3}]
    - `key` (string) — the cell to drop them on, "col,row"; the party's cell when omitted
    - `col` (integer) — instead of a key: the column
    - `row` (integer) — instead of a key: the row
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `dryRun` (boolean) — describe the ops without applying them

**`hex.write`** — capability `hexcrawl.author`

Author one hex of a hexcrawl scene: its name, terrain, what is really there, what the party reads once you open it, the encounter tables attached to it, and the hidden features inside it with the rule that finds each one. A hex that does not exist yet is created; one that does is rewritten. `open: true` opens it to the party, `open: false` closes it again, and `delete: true` removes it. One call, one envelope.

  Arguments:
    - `key` (string, required) — the cell key, "col,row" — on a gridless map, the zone id you choose
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `name` (string) — the hex's name, as the map's legend shows it
    - `terrain` (string) — a terrain id from this world's catalog — plains, road, hills, forest, marsh, mountains, water, city, …
    - `description` (string) — what is actually here (GM only)
    - `playerText` (string) — what the party reads once the hex is open
    - `tables` (string[]) — encounter table ids to attach — encounterTable.create makes one
    - `features` (object[]) — hidden things in this hex
    - `removeFeatures` (string[]) — feature ids to drop from this hex
    - `poly` (number[]) — zone geometry, flat [x1,y1,x2,y2,…] — gridless scenes only
    - `open` (boolean) — true opens the hex to the party; false closes it
    - `delete` (boolean) — drop this cell and everything authored on it
    - `dryRun` (boolean) — describe the ops without applying them

**`hex.reveal`** — capability `hexcrawl.author`

Open hexes to the party, or (with `open: false`) close them again. A closed hex is one the party has no document for at all — its text, its picture and its features are not on their replica. One call, one envelope, however many hexes it names.

  Arguments:
    - `keys` (string[], required) — the cell keys, "col,row" — hexcrawl.cells lists them
    - `sceneId` (string) — the hexcrawl scene; the active one when omitted
    - `open` (boolean) — true (default) opens them; false closes them
    - `dryRun` (boolean) — describe the ops without applying them

**`hexcrawl.configure`** — capability `hexcrawl.author`

Make a scene an overland map, or change how one behaves: the scale (what one hex means — 1, 3, 6 or 12 miles, or any number of `units`), the party's sight ring, the day/night window, how encounters are announced, the terrain catalog and the party token. `enable: false` takes the profile off the scene and leaves the map alone. Setting a scale on a scene that is not a hexcrawl yet switches it on — deciding a map is an overland map and choosing its scale are usually the same act.

  Arguments:
    - `sceneId` (string) — the scene; the active one when omitted
    - `enable` (boolean) — true (default) switches the profile on; false off
    - `cellDistance` (number) — what one hex means: 6 with units "mi" is a six-mile hex
    - `units` (string) — the unit name — "mi", "km", "leagues"
    - `hexLayout` (string) — "oddQ" or "evenQ", for hex grids
    - `sightMode` (string) — "gm" (the GM opens hexes) or "gm+party"
    - `radiusCells` (integer) — how far the party sees, in cells (0–12)
    - `dawnHour` (number) — the hour the sun comes up (0–24)
    - `duskHour` (number) — the hour it goes down (0–24)
    - `encounterMode` (string) — "auto" rolls itself, "prompt" asks the GM, "manual" never rolls
    - `encounterAnnounce` (string) — "names" tells the table what it met; "hidden" says only that something happened
    - `terrain` (string) — the terrain catalog id (default pf1e-overland)
    - `partyTokenId` (string) — the token that walks; null to unname it
    - `dryRun` (boolean) — describe the ops without applying them

**`encounterTable.create`** — capability `hexcrawl.author`

Write a random-encounter table: a name, a mode ("weighted" rolls 1d100, "dice" rolls your own formula), its rows, when it may fire (day/night, entering/moving/exploring/fighting), an optional cooldown, and — with `sceneId` — a battle scene to copy when the encounter resolves. A row can point at world actors or at compendium entries, which is how an NPC, a monster or an item ends up on the map rather than merely named. Answer: the new table and the id to attach to hexes.

  Arguments:
    - `name` (string, required) — the table's name, as the GM reads it
    - `mode` (string) — "weighted" (default) or "dice"
    - `formula` (string) — dice mode only: "1d6", "2d6+1", …
    - `entries` (object[], required) — the rows, in order
    - `sceneId` (string) — a battle scene to copy when this fires
    - `cooldownSeconds` (integer) — how long before it may fire in the same hex
    - `day` (boolean) — may fire by day (default true)
    - `night` (boolean) — may fire by night (default true)
    - `entering` (boolean) — may fire on entering (default true)
    - `moving` (boolean) — may fire while moving (default true)
    - `exploring` (boolean) — may fire while exploring (default false)
    - `fighting` (boolean) — may fire in a fight (default false)
    - `dryRun` (boolean) — describe the ops without applying them

**`encounterTable.update`** — capability `hexcrawl.author`

Rewrite an encounter table wholesale: its name, mode, formula, rows, tags, cooldown or battle scene. Only what changed is written, so a save that changes nothing is no ops at all. `tableId` is the id `encounterTable.create` answered with (hexcrawl.cells lists the ones attached to a hex).

  Arguments:
    - `tableId` (string, required) — the table to rewrite
    - `name` (string) — the table's name
    - `mode` (string) — "weighted" or "dice"
    - `formula` (string) — dice mode only
    - `entries` (object[]) — the rows, in order
    - `sceneId` (string) — a battle scene to copy, or null to unlink it
    - `cooldownSeconds` (integer) — how long before it may fire in the same hex; null to clear
    - `dryRun` (boolean) — describe the ops without applying them

**`encounterTable.delete`** — capability `hexcrawl.author`

Delete an encounter table. Hexes that pointed at it keep the dead id, so the honest order is to detach it from the hexes first (hex.write with `tables`) or rewrite them — the refusal names the table if you try to delete one that is still attached.

  Arguments:
    - `tableId` (string, required) — the table to delete
    - `dryRun` (boolean) — describe the op without applying it

### Chat

Speaking, whispering and reading.

**`chat.read`** — capability `chat.read`

The most recent chat messages this agent may see, newest last. Use since=<seq> to poll for new ones. Whispers it is not in, and GM-only roll results, are not here — the card is public, the dice may not be.

  Arguments:
    - `limit` (integer) — Messages to return (default 20, max 500)
    - `since` (integer) — Only messages after this sequence number

**`chat.post`** — capability `chat.speak`

Post one chat message as the agent — public, or a whisper to named users. The card carries the agent's own name, so the table can see who is speaking. One call, one envelope.

  Arguments:
    - `text` (string, required) — the message
    - `to` (array) — user ids to whisper to; leave it out to speak to everyone
    - `flavor` (string) — how to label it: "ooc", "emote", or empty
    - `dryRun` (boolean) — describe the op without applying it

### The clock

One clock, in seconds, and the hour it means.

**`time.get`** — capability `time.control`

The world's one clock: the integral seconds every subsystem spends, the seconds a combat round costs here, and whether a round wrap moves the clock at all. Effects with a duration, the hexcrawl's day/night and the tracker's rounds are all counted against this number.

  _Takes no arguments._

**`time.of_day`** — capability `world.read`

What the clock means in the world's own terms: the hour and minute, day or night, and the day number — derived from the one clock, never stored, so it cannot drift from it. What an agent wants before it says whether the sun is up.

  _Takes no arguments._

**`time.advance`** — capability `time.control`

Pass time: seconds, or `rounds`/`minutes`/`hours`/`days` on the world's own ladder (a round is secondsPerRound, an hour 600 rounds, a day 14 400). The clock and the effect sweep it triggers are one envelope, so "a night passes" ends what a night ends. A negative amount is a GM correction and expires nothing. Answer: the clock afterwards, and anything the new time ended.

  Arguments:
    - `seconds` (number) — seconds to add (negative rewinds the clock and expires nothing)
    - `rounds` (integer) — combat rounds to pass (6 s each by default)
    - `minutes` (integer) — minutes to pass
    - `hours` (integer) — hours to pass
    - `days` (integer) — days to pass
    - `dryRun` (boolean) — describe the ops without applying them

**`time.set`** — capability `time.control`

Set the world clock to an absolute number of seconds — a GM correction, or a campaign that starts at a given hour. Moving forward sweeps clock-counted effects; moving backward expires nothing, because time un-passing has not cast a spell in reverse.

  Arguments:
    - `seconds` (integer, required) — the clock, in seconds from the world's zero (never negative)
    - `dryRun` (boolean) — describe the ops without applying them

### The turn tracker

The encounter's round structure.

**`combat.state`** — capability `world.read`

The turn tracker on a scene, as the table sees it: whose turn it is, the initiative order with the current combatant marked, the round, and whether the encounter has started (a PF1e surprise round is running before round 1). Nothing here rolls a die or moves a turn — combat.next does that.

  Arguments:
    - `sceneId` (string) — the scene whose encounter to read; the active one when omitted

**`combat.start`** — capability `combat.control`

Begin the encounter on a scene: initiative, the surprise round (PF1e), and who is caught flat-footed, all as the tracker itself decides them. With no encounter on the scene, one is opened from its tokens. Answer: the order, whose turn it is, and — when the world advances the clock on a round wrap — the seconds that moved.

  Arguments:
    - `sceneId` (string) — the scene whose encounter to start; the active one when omitted
    - `name` (string) — the name to give an encounter opened here (the scene's tokens are its combatants)
    - `initiative` (object) — combatant id → the initiative rolled for them, for the ones not yet rolled
    - `unaware` (string[]) — combatant ids the GM declares caught unaware (PF1e surprise round)
    - `dryRun` (boolean) — describe the ops without applying them

**`combat.add`** — capability `combat.control`

Put combatants into the encounter — by token, by actor, or by name — with their initiative when it is already rolled. With no encounter on the scene, one is opened first. Answer: the order as it now stands.

  Arguments:
    - `sceneId` (string) — the scene whose encounter to add to; the active one when omitted
    - `name` (string) — the name to give an encounter opened here
    - `combatants` (object[], required) — one per combatant: { tokenId } or { actorId } or { name }, plus an optional initiative — [{ "tokenId": "t-3", "initiative": 18 }]
    - `dryRun` (boolean) — describe the ops without applying them

**`combat.next`** — capability `combat.control`

Advance the turn — the tracker's own transition, so effect durations tick, actions refresh, held actions come due, and a round wrap moves the world clock by the round this world says a round costs. A dying creature that owes a stabilization check is named, not rolled: this tool never rolls a die.

  Arguments:
    - `sceneId` (string) — the scene whose encounter to advance; the active one when omitted
    - `count` (integer) — turns to advance (default 1, max 20) — a whole round is one per combatant
    - `dryRun` (boolean) — describe the ops without applying them

**`combat.end`** — capability `combat.control`

End the encounter: the round structure is cleared and nobody's turn it is. The combatants stay on the document, so a second fight in the same room is combat.start again.

  Arguments:
    - `sceneId` (string) — the scene whose encounter to end; the active one when omitted
    - `dryRun` (boolean) — describe the ops without applying them

### Dice

Rolled by the host, never by the agent.

**`dice.roll`** — capability `dice.roll`

Roll dice as this agent, through the host's own dice (commit-reveal, so the number is the table's and not the agent's to choose): "1d20+5", "2d6+3", "4d6k3". The card lands in chat as this agent unless the mode says otherwise, and the answer is the total plus the individual dice. The one tool here that waits, because the host rolls it.

  Arguments:
    - `formula` (string, required) — the dice expression — "1d20+5", "2d6", "1d8+1d4+2"
    - `mode` (string) — who sees it: "roll" (public, default), "gmroll" (GM only), "blindroll" (GM sees, players see a hidden roll) or "selfroll" (only this agent)
    - `to` (string[]) — user ids to whisper the roll to
    - `flavor` (string) — why the roll was made — "attack: goblin 2"; it rides the card as its flavor

**`dice.apply`** — capability `dice.apply`

Apply a roll card's own total to an actor as damage or healing. No amount travels: the agent names the card and the actor, and the host re-reads the card's total and does the arithmetic (temporary hit points absorb first; healing also removes nonlethal). Answer: the amount, and the hit points before and after.

  Arguments:
    - `messageId` (string, required) — the roll card — dice.roll and chat.read name them
    - `actorId` (string, required) — the actor it lands on
    - `mode` (string, required) — "damage" or "healing"

### Fog

What the table can see.

**`fog.state`** — capability `fog.control`

A scene's fog: whether it is on, the sight range, how many manual reveal/hide strokes the mask carries, and — on a hexcrawl map — how many cells the table has been shown out of how many. Read-only: fog.reveal and fog.hide do the painting.

  Arguments:
    - `sceneId` (string) — the scene; the active one when omitted

**`fog.reveal`** — capability `fog.reveal`

Show the table part of a scene: named cells, a rectangle, a polygon, or the whole scene. On a hexcrawl map, opening cells writes **both** the mask and the reveal set, so the map cannot end up open on one screen and shut on another. Answer: what was painted, and the fog as it stands.

  Arguments:
    - `sceneId` (string) — the scene; the active one when omitted
    - `cells` (string[]) — cell keys to open or close — ["0,0", "1,0"]; on a hexcrawl scene this is the reveal set, not just a shape to paint
    - `rect` (number[]) — a world-space rectangle as [x1, y1, x2, y2]
    - `poly` (number[]) — an explicit polygon as a flat list — [x1, y1, x2, y2, x3, y3]
    - `all` (boolean) — paint the whole scene
    - `dryRun` (boolean) — describe the ops without applying them

**`fog.hide`** — capability `fog.reveal`

Put part of a scene back under cover: named cells, a rectangle, a polygon, or the whole scene. On a hexcrawl map, closing cells writes **both** the mask and the reveal set, so a hex shut here is shut for the tools too.

  Arguments:
    - `sceneId` (string) — the scene; the active one when omitted
    - `cells` (string[]) — cell keys to open or close — ["0,0", "1,0"]; on a hexcrawl scene this is the reveal set, not just a shape to paint
    - `rect` (number[]) — a world-space rectangle as [x1, y1, x2, y2]
    - `poly` (number[]) — an explicit polygon as a flat list — [x1, y1, x2, y2, x3, y3]
    - `all` (boolean) — paint the whole scene
    - `dryRun` (boolean) — describe the ops without applying them

### The strategic layer

Armies, their orders, and the turn's report.

**`strategic.snapshot`** — capability `strategic.read`

The strategic layer: the armies, their units with strengths, morale, supply and fatigue, where each unit stands (the centre of its living models), the orders it is carrying out and the ones queued behind them, the factions, and the theatre's turn with its phase. A unit's models are counted in the simulation pool, not the document — so the numbers here are the ones a commander would see.

  _Takes no arguments._

**`strategic.report`** — capability `strategic.read`

The last turn report this replica received: the sub-phases in the order they ran, every event with the unit it happened to, and the summary counts. It is the turn's own record, retained on the replica after the fact — not a live feed, so an agent can ask what happened without having been watching when it did.

  Arguments:
    - `limit` (integer) — Events to print (default 40, max 200) — the JSON carries them all

**`strategic.order`** — capability `strategic.order`

Issue orders to units for the turn: move along a path, attack a named unit, hold with a stance, change formation, retreat toward a point, or a supply action. One call is one envelope of one turn's orders, stamped with the turn that is open and the user who gave them. The shape is checked here; whether the order is *legal* is the rules module's verdict when the turn resolves.

  Arguments:
    - `orders` (object[], required) — one per unit: { unitId, kind, … }. `move` needs a flat `path` [x1,y1,x2,y2] and an optional `pace` ("march"|"run"|"charge"); `attack` needs `targetUnitId`; `hold` takes an optional `stance`; `formation` needs `formation`; `retreat` needs `toward` [x,y]; `supply` needs `action`; `custom` needs `type`.
    - `dryRun` (boolean) — describe the ops without applying them

### Tokens

Moving and changing what is on the canvas.

**`token.list`** — capability `world.read`

The tokens on a scene with their ids, world positions, grid cells and dispositions. Hidden tokens appear only for a grant with gmOnly.read, and the ones you own are marked "yours" — token.move moves those, and only those, unless your grant is the GM's.

  Arguments:
    - `sceneId` (string) — Scene id; omit for the active scene
    - `limit` (integer) — Rows to return (default 50, max 500)
    - `cursor` (string) — Cursor from a previous call, e.g. "o:50"

**`token.move`** — capability `token.move`

Move one token to a cell (`col`/`row`) or a point (`x`/`y` in pixels), snapped to the scene's grid. One call, one envelope. Answer: where the token stands now, in both cells and pixels.

  Arguments:
    - `tokenId` (string, required) — the token id (from token.list)
    - `sceneId` (string) — the scene; the active one when omitted
    - `col` (integer) — the target column
    - `row` (integer) — the target row
    - `x` (number) — the target x in pixels (ignored when col/row are given)
    - `y` (number) — the target y in pixels (ignored when col/row are given)
    - `dryRun` (boolean) — describe the op without applying it

**`token.properties`** — capability `token.properties`

Change a token's properties — name, disposition (friendly/hostile/neutral), hidden, image, elevation, rotation. One call, one envelope. Answer: the token as it now stands.

  Arguments:
    - `tokenId` (string, required) — the token id (from token.list)
    - `sceneId` (string) — the scene; the active one when omitted
    - `name` (string) — the token's label
    - `disposition` (string) — friendly, hostile or neutral
    - `hidden` (boolean) — whether players can see it
    - `img` (string) — asset hash or URL for the token art
    - `elevation` (number) — elevation in feet
    - `rotation` (number) — rotation in degrees
    - `dryRun` (boolean) — describe the op without applying it

### Images

Pictures, and the hash every other tool names one by.

**`asset.import`** — capability `assets.write`

Put an image into the world's asset store and answer its content hash — the hash a scene's map, a token's picture and a hidden feature's picture are named by. Send the file as base64 with its name and mime type. Nothing else in the tool table can produce a hash, and a tool that invented one would point a hex at a picture that is not there.

  Arguments:
    - `name` (string, required) — the file name, "overland.png"
    - `mime` (string, required) — the mime type, "image/png"
    - `base64` (string, required) — the file, base64-encoded

<!-- END GENERATED TOOLS -->

## Resources

`resources/list` and `resources/read`. The open-ended ones are advertised as **templates** rather
than enumerated — 5,000 actor URIs is a resource list no client can read.

Enumerated by `resources/list`:

| URI | What it is |
|---|---|
| `vtt://world/{id}/overview` | name and system, the clock, and how many documents each collection holds |
| `vtt://world/{id}/tokens` | the tokens on the active scene, with cells and dispositions |
| `vtt://world/{id}/chat` | the messages this agent may see (`?since=<seq>` for only what is new) |
| `vtt://world/{id}/packages` | the installed rulesets and content packs |
| `vtt://world/{id}/hexmap` | the active hexcrawl scene as text — terrain, the party, unrevealed ground as cover |
| `vtt://world/{id}/scene/{sceneId}` | a known scene, as JSON |
| `vtt://world/{id}/scene/{sceneId}/map.txt` | the same scene, one character per cell |

Advertised as templates (`resources/templates/list`):

| URI | What it is |
|---|---|
| `vtt://world/{worldId}/scene/{sceneId}` | any scene, as JSON |
| `vtt://world/{worldId}/scene/{sceneId}/map.txt` | any scene, one character per cell |
| `vtt://world/{worldId}/sheet/{actorId}` | any actor's derived sheet, as markdown |

## Prompts

`prompts/list` and `prompts/get`. A prompt is a **recipe**: a named way to use the tool table for one
job, so a client can offer "Run this encounter as the GM" as a single action instead of hoping its
model invents the sequence. Each one names the tools it reaches for — and a test asserts every one of
those names is in the catalogue, because a recipe that names a tool the bridge does not serve is
invisible until a client follows it.

| Prompt | The job |
|---|---|
| `gm.narrate_scene` | Read the scene and open it for the table in the GM's voice. |
| `gm.run_encounter` | Take a fight from the top of the order to the end of a round. |
| `gm.improvise_npc` | Make up a person the party has just met, from the compendia if possible. |
| `player.describe_action` | Speak and act as one character, dice in the open. |
| `referee.rule_question` | Answer a rules question from what this world has loaded — and admit to guessing when it has not. |
| `strategic.advise_turn` | Read the order of battle and say what the orders should be. |
| `hexcrawl.travel_day` | Run a day on the road: the ground, the hours, what finds them. |
| `hexcrawl.author_region` | Build an overland map: the picture, the scale, the hexes, what is hidden in them, and the tables that populate them. |

Every recipe closes with the same rule: **a refusal is an answer.** Say so plainly, do not work
around it, and quote what was missing.

## Capabilities and presets

A **capability** is one verb class the GM may withhold. A **preset** is a starting bundle; a **grant**
is a preset plus a role, and the grant may only *narrow* the role, never widen it.

| Preset | Role | Holds |
|---|---|---|
| `gm` | `GM` | everything |
| `gm-no-delete` | `ASSISTANT` | everything but `doc.delete` |
| `player` | `PLAYER` | read, chat, dice, `token.move` — and the hexcrawl map the party has revealed |
| `observer` | `PLAYER` | read only |

`player` deliberately does **not** hold `hexcrawl.travel`: a march spends the table's clock and moves
the party token every player shares, so walking is the GM's call unless the GM narrows a grant to say
otherwise. Reading where the party is and what the ground costs is not.

## Room left

- **No browser e2e.** Everything here is proved at the projection and protocol level; the Agents
  window itself has never been put on screen by a test, because this environment has no Chromium.
  Any environment that does should write `e2e/agent_connector.spec.ts` next.
- **Rate classes.** The catalogue is not yet rate-limited per class; Phase 6 tunes them against a
  25k-entry world.

## Decisions

The reasoning behind this surface, in order: `DECISIONS.md` — D-278 (Phase 0), D-279 (Phase 1,
grants), D-280 (Phase 2, writes), D-281 (Phase 3, projection), D-282 and D-283 (Phase 5, the
hexcrawl), D-284 to D-287 (Phase 4: the clock, dice, fog and the strategic layer), D-288 (the
prompts). The plan that scheduled them is `MCP_CONNECTOR_SPEC_AND_PLAN.md`.
