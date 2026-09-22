# Hexcrawl scene — specification additions and implementation plan

**Status:** proposal, 2026-09-21 · **Reads with:** `PLAN.md` (§1–§19 spec map), `PROTOCOL.md` (§4/§5/§13),
`DECISIONS.md` (D-250 fog, D-251 visibility, D-256/257 GM tools + wall kinds, D-146 world clock),
`GAP_ANALYSIS_Roll20_Foundry.md` (§5.1 — where this sits relative to the open set),
`HEXCRAWL_SCENE_SPEC_AND_PLAN.md` (this file).
**Author's note:** every file and symbol named below was read in the tree at `19c821a`+G-45+G-08 before it
was written. Where this document proposes something, it says *proposal*; where it describes the app as it
is, it names the anchor.

---

## 1. TL;DR

A **hexcrawl scene is a scene profile, not a new kind of document.** The scene keeps being
`SceneDocument` — its map image, its `SceneGrid` (which already supports `square | hex | gridless`), its
tokens, walls, lights and its fog — and gains one flag block, `flags.core.hexcrawl`, whose *presence* is
the switch. Off by default, so no existing scene changes (the same trick `flags.core.fog === true` uses).

On top of that profile the plan adds six things:

1. **A sparse cell layer** — an embedded `cells` collection (parent = scene) holding authored hexes,
   squares or, on a gridless map, drawn **zones**: terrain, a GM description, a player description,
   attached encounter tables, and hidden features with reveal rules.
2. **A terrain catalog** — world-scoped data (`plains 1`, `road 1 road:true`, `forest 2`, `mountains 3`, …;
   the number is the share of a travelling day one grid unit costs), read by a pure travel-cost function,
   not hardcoded in the canvas.
3. **An encounter-table library** — a new `encounterTables` collection: the roll (a dice formula *or* a
   weighted `1d100` ladder, both editable in a wizard) plus typed entries (free text, a bestiary/compendium
   link with a count, or an actor already in the world) and activation tags
   (`day/night/entering/moving/exploring/fighting`, all on by default).
4. **An encounter engine** — one pure module that answers "is anything eligible right now?" at four
   trigger points (token crosses a cell border, the party advances along a path, the GM rules a hex
   explored, a fight starts on the cell), honours the scene's activation mode
   (`auto roll` / `GM-only pending message` / `manual`), and produces either a chat card or a GM popup
   listing every eligible table to pick from.
5. **A party and a travel plan** — a party token, a path the GM (or the party) clicks out on the map, the
   seconds each step costs per terrain, and a hook into the **existing replicated world clock**
   (`advanceWorldClockOps`) so that "advance time" moves the party and checks encounters as it goes.
6. **Fog built from what the app already has** — the GM's open/close hexes are a *shared* reveal set on
   the scene (the hexcrawl reading of `fogMask`), and the party's sight radius is a radius in cells
   (hex distance) or, on a gridless map, plain distance in world units.

**No protocol change is required.** Every one of the above is a document plus an `Op` (§4), so it inherits
sync, undo, projection, permissions and the world file for free. The only wire-adjacent item the plan
carries is optional (`asset.put`, §7.4) and is not needed for the base feature.

**Scope check, honestly:** this is **not** a Roll20/Foundry parity item — it is the opposite, a
differentiator neither product ships out of the box (both rely on third-party hexcrawl modules). Per the
ordering rule in `GAP_ANALYSIS_Roll20_Foundry.md` §5.1 ("market-differentiating work last"), it should be
scheduled *after* the open parity set unless the product decision is to make hexcrawl a headline feature.

---

## 2. Requirement traceability

| # | Asked for | What it becomes | Already in the tree | New |
|---|---|---|---|---|
| 1 | Upload a map image | `ImportPipeline.importImage(bytes, name, mime)` → `{hash, entry}` then a `scenes` update `{img, width, height}`. Today `importMap()` (`App.svelte:1441`) hardcodes `DEFAULT_SCENE_ID`; the slice generalises it to the **active** scene. | `src/host/import.ts`, asset manifest, `sceneImg()` surface | active-scene target, a hexcrawl-scene wizard step |
| 2 | Choose hex / square / gridless + reference scale | `SceneGrid` already is `square\|hex\|gridless` with `size`, `distance`, `units`, `diagonals`, `hexLayout` (`documents.ts:307`), editable in the Settings scene editor (`data-grid-type`…). The **reference scale** *is* the existing `size px ↔ distance units` pair; gridless measurement already uses it. | `src/canvas/grid/hex.ts` (all four layouts, `hexDistance`, `hexNeighbors`, `hexCorners`, `hexesInView`), `src/canvas/grid/index.ts` | cells-per-map derivation, "1 cell = N miles" surfaced in the wizard, zone authoring for gridless |
| 3 | Working fog; GM opens areas; party sight 0/1/2/… hexes | A **shared reveal set** (`flags.core.hexcrawl.revealed: string[]` of cell keys) painted by every client, plus an optional party-sight layer computed from the party token's cell and a radius in cells. Reuses `fogMask`'s paint model and the per-user explored fog for the tactical case. | `src/core/fogExploration.ts`, `src/core/fogMask.ts` (`FOG_MASK_MAX_OPS = 512`), `src/canvas/layers/FogLayer.ts`, `client/fogExploration.ts` | the set, the cell radius primitive, "sight mode" flag, GM open/close verbs |
| 4 | Description per hex, opened from a right-click menu | `CellDocument.description` (+ `playerText`), a window kind `hex`, and a canvas context menu modelled on `ui/combat/tokenContextMenu.ts`. | `WindowHost.svelte`, `core/windows.ts`, note/pin right-click precedent | the menu, the window, the cell document |
| 5 | Several encounter tables per hex; day/night, entering, moving through, exploring, fighting tags; all on by default; GM can turn one off; multiple eligible → GM popup listing them | Per **table** a tag mask `{day, night, entering, moving, exploring, fighting}`, default all true; per **cell** a list of table refs; eligibility is a pure predicate over `(tags, time of day, trigger)`; ties produce the picker popup. | chat `RollMode` (`gmroll` = GM-only), `core/rollTable.ts` (`drawFromTable`, `validateTable`), dice engine seeding | the collection, the mask, the engine, the popup |
| 5a | Activation mode: auto-roll / GM-only pending chat message / manual | Scene flag `encounterMode: "auto" \| "prompt" \| "manual"`. `prompt` posts a `gmroll`-mode message whose body is the eligible-table list; the message carries the roll request so one click resolves it. | `MessageDocument.rollMode`, `rollPending` flow (`ClientSync.rollPending`) | the three modes and the pending-card shape |
| 5b | Encounter wizard: dice roll *or* weighted percentage (like the attachment) | Window kind `encounterTable`; weighted mode stores `formula: "1d100"` with cumulative ranges derived from integer weights (so the *roll* stays one dice-engine call and the stored table stays a valid `RollTableDocument`-shaped thing). | `TablesPanel.svelte` is the dice-mode precedent; `validateTable` already refuses overlaps and gaps | the wizard, the weight→range compiler, the preview roll |
| 5c | Entry = plain text, bestiary entity (e.g. "goblin warrior ×2"), or a unique actor in the world; rolled results open a window with entities + tokens to drag | `EncounterEntry = {weight, text, refs: EncounterRef[], count}` where `EncounterRef` is `{kind: "compendium", packId, entryId}` or `{kind: "actor", actorId}`; the results window is a new `WindowHost` kind that renders a row per entry with its image and a drag payload. | compendium drag payload `application/x-vtt-compendium` (`CompendiaPanel.svelte:153`, consumed `App.svelte:1469`), `compendiumLoader.ts`, `rankIndex` for the picker | the results window, the payload/`Place all` path, count semantics |
| 5d | Link a scene to a table; on a hit, offer "create battle scene"; copy the linked scene and place the rolled tokens near each other | `EncounterTable.sceneId` + a `duplicateSceneOps(scene, parents, tokens)` core function (new — the app has no scene duplication today) + a scatter/ring placement helper. | `sceneLink.ts` (`generateTacticalTokens`) is the *spatial* precedent for placing generated tokens; `tokens` creation path (`App.svelte:1500`) | duplicate-scene ops, placement geometry, the confirm flow |
| 6 | Terrain per hex (highway…mountains) affecting party movement | World-scoped terrain catalog + `cell.terrain`; `travelCost(from, to, catalog)` + `secondsForCost(step, catalog)` price a step (landed, D-269). The tactical sibling already prices difficult terrain (`packages/pf1e/movement.ts`). | — | the catalog, the cost function, the terrain brush |
| 7 | Path travel for the party token; advancing world time moves the party; encounters checked correctly | `flags.core.travel = {path: cellKeys[], cursor, progressSeconds}` + `travelAdvance({scene, plan, elapsedSeconds, catalog, startClock})` + `travelProgressOps`/`partyPositionOps` driven by the clock (landed, D-269); every crossed border runs the trigger pipeline of §6. Time is one integral clock — 6-second rounds, hours and days derived (§3.7) — and travel *spends* clock seconds at the terrain's rate. | `packages/pf1e/worldClock.ts` (`advanceWorldClockOps`, `setWorldClockOps`, `TICKS_PER_DAY`, `MAX_CLOCK_SECONDS`), Settings window clock buttons (`data-clock-minute/hour/day`) | the path planner UI, the advance function, the border-crossing detection, the §3.7 duration-ladder correction (`effects.ts:486`, `TICKS_PER_DAY`) |
| 8 | Hidden features with images, revealed by criteria (perception / time exploring / dice) automatically or manually | `CellFeature = {id, name, text, img, reveal, autoReveal, state}` with `reveal` a union: `manual` / `perception(dc)` / `time(seconds)` / `dice(formula, target)`; evaluation is pure, the *state* write goes through ops so every replica agrees. | `stealthPerception.ts` (`calculatePerceptionDc`, `evaluateDetection`), `projection.ts` note/pin visibility precedent ("ownership alone cannot express it; the flag is the gate", D-256) | the feature model, the evaluator, the reveal gate in projection, the GM checkbox |

---

## 3. The model (proposal)

### 3.1 Scene profile

```ts
// flags.core.hexcrawl — presence is the switch (no existing scene changes).
interface HexcrawlScene {
  version: 1;
  /** Authoring unit. Hex/square scenes derive cells from SceneGrid; gridless scenes use zones. */
  cellUnit: "cell";
  /** GM's open/close state: the readable, diffable form of "what the table has seen". */
  revealed: string[];              // cell keys ("q,r" | "x,y" | zone id)
  sight: {
    mode: "gm" | "gm+party";       // gm = only the set above; gm+party adds the party's ring
    radiusCells: number;           // 0 = the party's own cell only, 1 = one ring, …
    gridlessRadiusFt: number;      // used when SceneGrid.type === "gridless"
  };
  partyTokenId: DocId | null;
  encounterMode: "auto" | "prompt" | "manual";
  /** Day/night boundaries in hours of the one integral clock (§3.7). No calendar field. */
  daylight: { dawnHour: number; duskHour: number };            // default 6 / 18
  travel: { path: string[]; cursor: number; progressSeconds: number; speedFtPerDay: number } | null;
  terrain: string;                 // catalog id, default "pf1e-overland"
}
```

Written only through ops by builders in `src/core/hexcrawl/scene.ts` (`hexcrawlSceneOps(scene, patch)`,
`revealCellsOps(scene, keys, "open" | "close")`), so the scene editor stays a thin form over a tested
builder — the same split `fogSettingsOps` / `worldSettingsOps` already use.

### 3.2 Cells

`CellDocument` joins the **embedded** collection list (`documents.ts:444`) as `cells`, parent = the scene —
exactly the addressing `walls`/`notes` use (`{coll: "cells", parent: {coll: "scenes", id}}`), so
ownership cascade, projection and the world file pick it up with no new machinery.

```ts
interface CellDocument extends BaseDocument {
  type: "cell";
  /** Grid key "q,r" (hex) / "x,y" (square) / a zone id when gridless. */
  key: string;
  /** Zone geometry for gridless scenes (flat [x,y,…]); absent for gridded cells. */
  poly?: number[];
  terrain?: string;
  description?: string;        // GM text
  playerText?: string;         // what players read once the cell is revealed
  tables?: string[];           // encounterTables ids
  features?: CellFeature[];
}
```

Two design decisions worth stating:

- **Sparse authoring, dense derivation.** Cells are written only where the GM authored something. The
  grid's cell set is *derived* (`hexesInView` already walks a hex range; a `cellsInMap(scene)` helper
  does the same for the whole map, capped and lazy), so a 40×30 map has 1,200 playable cells and
  typically a dozen documents. Unknown cells answer "unexplored, terrain = the scene default".
- **Gridless is zones, not a fake grid.** Requirement 2 says gridless should "work more like vector
  crawl": on such a scene the GM draws polygons (reusing the *drawings* tool's polygon gesture and
  `polygon.ts`) and the polygon becomes the cell. `pointInPolygon` already exists for pin hit-testing, so
  "which zone is the party in?" is a solved primitive.

### 3.3 Terrain catalog

Data, not code: a world-scoped catalog (`settings` doc key `hexTerrain`) with the default PF1e-ish ladder.
**Landed in D-269 as `PF1E_TERRAIN_CATALOG` (`src/core/hexcrawl/terrain.ts`)** — the numbers below are the
shipped ones, and they are the *share of a travelling day* one grid unit costs (`speedPerDay = 24` miles ⇒
24 plains cells, 12 forest, 8 mountains a day), not a multiplier on speed:

| id | label | `cost` (day share) | note |
|---|---|---|---|
| `plains` | Plains / farmland | 1 | the catalog default, and what a cell with no terrain costs |
| `road` | Highway / road | 1 (`road: true`) | crosses as open ground whatever it crosses — **a road removes the penalty, it never adds speed** (`ROAD_COST 1`; the earlier draft's 0.5/0.75 was wrong: a mountain road would have beaten a clear plains day) |
| `hills` | Hills / scrub | 1.5 | |
| `tundra` | Tundra / steppe | 1.5 | |
| `forest` | Forest / woods | 2 | |
| `marsh` | Marsh / swamp | 2 | |
| `desert` | Desert / dunes | 2 | |
| `jungle` | Jungle / rainforest | 3 | |
| `mountains` | Mountains | 3 | |
| `water` | Lake / sea | 4 | impassable on foot; a boat travels at its own pace (Phase 3) |
| `city` | City / ruins | 1 | |

`travelCost(from, to, catalog)`, `secondsForCost(step, catalog)`, `secondsPerCell(cell, catalog)` and
`paceMultiplier(pace)` (`normal` ×1, `forced` ×1.1 — PF1e's forced march) are pure, integer-seconds, and
separately unit-tested — the same posture as `packages/pf1e/movement.ts` (which stays the *tactical*
pricer; a hexcrawl step and a 5-ft step must not share a function, or the terrain table becomes a combat
rule). `validateTerrainCatalog`/`terrainCatalogOrDefault` read whatever a world actually stores (costs
clamped to `(0, 10]`, one default filled for the unknown).

### 3.4 Encounter tables

New **top-level** collection `encounterTables` (touching `documents.ts` types +
`TOP_LEVEL_COLLECTIONS`, `emptyCollections()` in `store.ts`, the projection switch, the permissions
panel's document list — the `factions`/`armies` slices are the precedent):

```ts
interface EncounterTableDocument extends BaseDocument {
  type: "encounterTable";
  /** "dice" = the formula's own range; "weighted" = integer weights compiled to a 1d100 ladder. */
  mode: "dice" | "weighted";
  formula: string;                  // dice mode only ("1d20", "2d6+1")
  entries: EncounterEntry[];
  tags: EncounterTags;              // all true by default
  /** Optional linked battle scene (requirement 5d). */
  sceneId?: DocId;
  /** Per-table cooldown so a "night" table cannot fire twice in the same night. */
  cooldownSeconds?: number;
  tableId?: DocId;                  // when mode === "dice", the rollTable it may mirror
}

interface EncounterTags { day: boolean; night: boolean; entering: boolean; moving: boolean; exploring: boolean; fighting: boolean; }

interface EncounterEntry {
  weight: number;                   // weighted mode: any positive integer; the compiler normalises
  range?: [number, number];         // dice mode: inclusive, validated by the existing `validateTable`
  text: string;                     // "Goblin bandits"
  count: number;                    // "goblin warrior ×2" → ref with count 2
  refs: EncounterRef[];             // [] = pure text
}

type EncounterRef =
  | { kind: "compendium"; packId: string; entryId: string }
  | { kind: "actor"; actorId: DocId };
```

The weighted compiler (`weightsToRanges(entries) → WeightCompilation`, **landed in D-269**) is what makes
the attachment's percentage model safe: weights are scaled to the die (a 25/25/25 table becomes 33/33/34
rather than leaving a quarter of the die silent; a 200/200 table stays 50/50), the remainder goes to the
largest fractional parts (earliest entry first on a tie) so the ladder always covers `1..100` exactly, a
row with weight 0 is a note that never takes space, and a *tiny* weight that scaled to zero faces gets
one instead — **moved from the largest row, never added**, so the ladder still totals exactly 100. Which
`validateTable`'s "no overlap, gaps re-roll" contract then holds by construction. Both modes draw through the **existing dice engine** with a
host-seeded roll (the `rollVerified` path), so an encounter roll is as auditable as a chat roll and
appears in the ledger.

### 3.5 Hidden features

```ts
interface CellFeature {
  id: string;
  name: string;                     // "The old shrine"
  text: string;
  img?: string;                     // asset hash
  reveal:
    | { kind: "manual" }
    | { kind: "perception"; dc: number }        // party's best passive perception, or an active check
    | { kind: "time"; seconds: number }         // spent exploring/resting in the cell
    | { kind: "dice"; formula: string; target: number };
  autoReveal: boolean;              // true = the engine flips it; false = the GM checkbox does
  state: { revealed: boolean; atClock?: number; by?: UserId };
}
```

**The gate is the document, not the pixels** (D-256's lesson for map pins, generalised): a feature that is
not revealed must not be *projected* to players, because the world asset manifest lists every hash and the
only thing standing between a curious player and the art is which documents they receive. So
`projection.ts` learns one rule — an unrevealed `CellFeature` is stripped from the cell document for a
non-GM viewer — and the art is fetched only after the reveal write. This is the single security-relevant
line in the whole feature.

### 3.6 Party and travel

- **Party**: a token flagged `flags.core.party = true`, with `hexcrawl.partyTokenId` caching the pick.
  One party per scene; a second flagged token is a validation error surfaced in the hex panel.
- **Path**: a list of cell keys. The UI is a new canvas mode (`tool: "path"`) that appends the cell under
  the pointer, draws the route, and previews **time and distance** live (`+3 h 20 m · 24 miles · 2 forest
  cells`).
- **Advance**: `travelAdvance({scene, plan, elapsedSeconds, catalog, startClock})` is pure and returns the
  plan for one call (**landed**, D-269): it walks the cursor forward by `elapsedSeconds`, converting each
  step into `progressSeconds` at the step's cost, and returns the ordered `TravelStep`s whose border
  crossings carry the trigger evaluation of §6 — `travelProgressOps`/`partyPositionOps` then write exactly
  one `travel` flag update, and a completed step is what moves the clock forward. The GM's existing clock buttons (`+1 min`, `+1 h`, `+1 day`) and the combat round wrap
  both already funnel through `advanceWorldClockOps`; the hexcrawl slice adds `advanceWorldClockOps`'s
  *hexcrawl counterpart* to the same call site (one new caller, no change to the clock module).

### 3.7 Time: one clock, real hours (decided 2026-09-21)

**Decision (product owner, 2026-09-21): there is exactly one clock, and it is integral.** A round is 6
seconds; minutes, hours and days are *derived* from that, not a second calendar:

```
1 round = 6 s · 1 minute = 10 rounds = 60 s · 1 hour = 600 rounds = 3 600 s
1 day  = 14 400 rounds = 86 400 s (24 h)
```

So there is no `calendar` field at all: the hexcrawl layer reads the replicated `world-settings`
`clockSeconds` (`worldClock.ts`, D-146) and derives

```ts
/** 0 = midnight, 6 = dawn, 12 = noon, 18 = dusk. Derived; never stored. */
export function hourOfDay(clockSeconds: number, dayStartHour = 0): number;
export function timeOfDay(clockSeconds: number): { hour: number; phase: "day" | "night" };
```

with day/night boundaries from the scene's `hexcrawl.daylight = {dawnHour: 6, duskHour: 18}` (defaults;
a coastal or arctic map may move them, and a GM may set `phaseAllowsDayOnly` on a table in the same place
the tags live). The encounter tag mask is evaluated against this, so "night" means the same thing to the
engine, the chat card, the itinerary preview and the clock buttons without any of them consulting a
second time source.

**The consistency fix that decision implies.** The landed PF1e duration ladder is *not* real-time, and it
was a deliberate choice recorded at the time — `worldClock.ts` even notes that a day is "not the 6,000
rounds a real-clock day would imply" (that figure is itself short: 86,400 s ÷ 6 s = **14,400** rounds, so
the comment's own arithmetic confirms the ladder was built as an abstraction rather than a conversion).
**The correction landed as D-268 (2026-09-21), Phase 0a.** Before → after:

| unit | before | before, seconds at 6 s/round | landed | seconds at 6 s/round |
|---|---|---|---|---|
| round | `n` | 6 s | `n` | 6 s ✓ |
| minute | `n * 10` | 60 s | `n * ROUNDS_PER_MINUTE` (10) | 60 s ✓ |
| hour | `n * 100` | **600 s (10 min)** | `n * ROUNDS_PER_HOUR` (600) | 3,600 s ✓ |
| day | `TICKS_PER_DAY = 2400` | **14,400 s (4 h)** | `TICKS_PER_DAY = ROUNDS_PER_DAY` (14,400) | 86,400 s ✓ |

The reason it had to change: an integral clock cannot host a "1-hour" effect that ends after ten minutes,
and the two consumers of a duration (the turn engine's `flags.core.duration` ticks and the clock's
`clockExpiredIds` → `ttlSeconds`) must not disagree about what an hour is. The rungs now live **once**, in
`src/core/clock.ts`, so they cannot drift again — `ROUNDS_PER_HOUR = ROUNDS_PER_MINUTE * 60` is
arithmetic, not a second literal. This was a **behaviour change to a shipped feature**, so it got its own
`DECISIONS.md` entry that says so in those words, including the only real consequence:
`clockExpiredIds` derives seconds from the effect's own `ttl` payload, so an effect *already applied*
under the old ladder ends later than its label used to imply, while its stored `core.duration` ticks stay
as written (the sweep never rewrites them — D-146's rule). The mitigation is a deterministic one-liner the
GM can run once — rewrite `flags.core.duration` for clock-counted effects from their payloads — or simply
accept the correction on the next session; both are recorded, neither is silent (D-268 accepts the
correction, and does not touch the ticks).

**The calendar half landed with it** (`src/core/clock.ts`, re-exported by `pf1e/worldClock.ts` so existing
callers keep reading it from the clock that spends it): `hourOfDay`, `minuteOfHour`, `secondOfMinute`,
`dayNumber`, `formatClockTime` (`"14:30"`) / `formatClockStamp` (`"Day 2, 14:30"`), `hourFractionOfDay`,
`phaseOf`, `timeOfDay`, `secondsUntilHour`, `secondsUntilPhaseEnd`, `elapsedBetween`, `normalizeClock`, and
`DEFAULT_DAYLIGHT {dawnHour: 6, duskHour: 18}` — the default a scene's `hexcrawl.daylight` overrides.
There is still exactly one clock and no `calendar` field: hours and days are derived from the 6-second
round.

Everything else about the clock is untouched: `advanceClockOnRound`, `setWorldClockOps`,
`advanceWorldClockOps`, `MAX_CLOCK_SECONDS` (100 years), the round wrap in the combat tracker, and the
Settings window's `+1 min` / `+1 h` / `+1 day` buttons — the last of which now advances exactly what the
party's travel costs (`+1 day` = 14,400 rounds of travel).

---

## 4. Fog and vision on a hexcrawl scene (proposal)

| Need | Mechanism | Why this one |
|---|---|---|
| "GM opens a hex for the table" | `revealed` set on the scene flag; the client paints closed ⟺ not-in-set over the map | Replicated, diffable, undo-able as one op per brush stroke; immune to the 512-stroke bound `FOG_MASK_MAX_OPS` imposes on the freehand mask |
| "GM paints freehand reveal/hide" | unchanged — `fogMask` keeps working | two fog systems side by side is a smell; the hexcrawl set is the *cell-granular* layer and the mask remains the *brush* |
| "The party sees 0/1/2 hexes around it" | `cellsWithin(scene, centerKey, radiusCells)` → the ring; each cell's polygon is painted open on the shared layer | Hex distance is already implemented (`hexDistance`), and a ring is exactly what a hexcrawl table wants |
| "Gridless: plain distance" | circle of `gridlessRadiusFt` converted through `grid.size`/`grid.distance` | The gridless scene already measures that way |
| "What a player may see" | `projection` strips unrevealed cells' `features`, and any cell outside the reveal set loses its `playerText` | One rule, one place (§3.5) |
| Per-user explored fog (the tactical model) | *not* used for the reveal set; still available and untouched for tactical scenes | Hexcrawl exploration is a property of the **party**, not of the player who happened to be driving the token — mixing the two produces the classic "one player sees the map, the other does not" bug |

Modes are explicit: `sight.mode: "gm"` (a pure "the GM decides what is open" hexcrawl, e.g. a published
map with numbered hexes) or `"gm+party"` (the party's ring adds to the set every time it moves). Both are
one flag, so a table can switch mid-campaign.

---

## 5. UX flows (proposal)

### 5.1 Making a hexcrawl scene
Scene nav (`#scene-add`) gains a chooser: **Blank scene** / **Hexcrawl scene…**, the second opening a
wizard with four steps: *map image* (drag a file or reuse a world asset), *grid* (hex layout + cell size in
px + "1 cell = N miles" + the hex orientation preview), *origin* (which cell is the map's top-left, so
authored keys survive a re-import), *party* (create the party token now or pick an existing one). For
gridless: *reference scale* (`1 inch = 6 miles`, expressed with the existing `size`/`distance`/`units`).

### 5.2 The canvas menu (requirement 4)
With the hexcrawl profile active, a GM right-click on the canvas opens a small menu built like
`ui/combat/tokenContextMenu.ts`: **Open hex / Close hex**, **Describe this hex…**, **Terrain →**
(submenu of the catalog), **Attach encounter table…**, **Roll from a table…**, **Explore this hex**
(costs time, may reveal), **Reveal feature…**, **Move party here**, **Add to path**. Players get a reduced
menu (their own cell's `playerText`, "the party is here").

*As landed (D-271/D-273):* the GM menu is real for the terrain rows, *Open hex / Close hex*, *Attach
encounter table…*, **Roll from a table…** and **Explore this hex**. Rolling opens the hex window rather than
drawing dice in a menu (the window's rows *are* the manual trigger, §6 rule 6 — one place decides what
"roll this hex" means); exploring submits the clock envelope in the shell and then asks the `exploring`
trigger. *Reveal feature…*, *Move party here* and *Add to path* are still the disabled rows Phase 6 lands,
and their tooltips now say Phase 6.

### 5.3 The hex window
Window kind `hex`, `data: {sceneId, key}`: terrain select, GM description (textarea, markdown as
elsewhere), player description, the attached tables as rows with their tag chips (a chip that is *off* is
visibly off — turning it back on is a click, which is requirement 5's "GM can turn off Night"), feature
rows with their reveal rule and a GM reveal checkbox (requirement 8's manual path), and the roll buttons
for manual mode (5a).

*As landed (D-273):* the rows roll. The window states the scene's own mode above them — *auto* ("rolls by
itself when the party enters, moves or fights here"), *prompt* ("asks the GM … a row below rolls one right
now") or *manual* ("nothing rolls on its own, and these rows are the trigger") — and every roll goes through
the same `rollTableNow` pair (one host draw, one ledger write) the `auto` path uses, so a table rolled by
hand is a table the next footstep will not roll again.

### 5.4 The encounter wizard (requirement 5b)
Window kind `encounterTable`, opened from the *Tables* sidebar (**New encounter table**) or from a hex's
**Attach encounter table…** → **New…**. One screen, no steps — an encounter table is small data and a
wizard that pages through it is slower than a form:

```
┌ Encounter table ──────────────────────────────────────────────── ⌄ ─┐
│ Name  [ Forest road — day                    ]   Roll type: ( )Dice  (•)Weighted % │
│ ─────────────────────────────────────────────────────────────────── │
│  #   weight   %      entry                                    count  ref        │
│  1   [ 30  ]  30 %   Goblin bandits                            [ 2 ]  ▸ bestiary │
│  2   [ 25  ]  25 %   A merchant caravan, wary                  [ 1 ]  text       │
│  3   [ 25  ]  25 %   Wolves, hunting                           [ 1 ]  ▸ bestiary │
│  4   [ 20  ]  20 %   Diego Montoya, goblin cavalier            [ 1 ]  ▸ world    │
│      ─────────────────────────────────────────────────████████      │
│      total 100 %            ＋ Add row    ⤒ paste rows                     │
│ ─────────────────────────────────────────────────────────────────── │
│ Activates:  [day ✓] [night ✓] [entering ✓] [moving ✓] [exploring ✓] [fighting ✓] │
│ Linked battle scene  [ (none) ▾ ]     Cooldown  [ 1 phase ▾ ]        │
│ [ Test roll ]                                        [ Cancel ] [ Save ] │
└──────────────────────────────────────────────────────────────────────┘
```

- **Roll type** is the one mode switch; switching converts *losslessly in one direction only* — dice →
  weighted is refused when the formula is not a single flat range (`2d6+1` has no percentage reading), and
  the wizard says so in those words rather than inventing weights. Weighted → dice is offered as
  "express as 1d100 with these ranges" for tables a GM wants to keep as a formula.
- **Weight column** accepts any positive integer; the **% column and the bar recompute live** from the
  normalised total, so what the GM sees *is* the probability — that is the whole point of the attachment's
  percentage model, and it is why the compiler (`weightsToRanges`) normalises to 100 and gives the
  rounding remainder to the last row (so the ladder always covers `1..100` and `validateTable`'s
  no-gap/no-overlap contract holds by construction).
- **Entry column** is either free text (typed in place) or a reference: the *▸ bestiary* / *▸ world*
  picker searches through `rankIndex` (the compendium index the reader and the sheet pickers already use)
  and stores `{kind: "compendium" | "actor", …}` plus the count; the results window resolves each ref to the
  name and image the world actually holds. The model carries an *array* of refs per row (the requirement's
  "goblin bandits" plus a leader, with *count* applying per ref and the results window listing them
  separately) — the Phase 3 wizard writes one per row, and the picker replaces it.
- **Activates** is the six-chip mask, all on for a new table (requirement 5's default), each chip a plain
  checkbox so "turn Night off for this table" is one click — and the same chips appear, read-only, in the
  hex window so the GM can see *why* a table did or did not fire without opening the wizard.
- **Test roll** draws once with the real engine and renders the result in the results window in preview
  (nothing is created, no message is posted) — the fastest way to sanity-check a percentage ladder, and
  the reason the wizard does not need a "weights must sum to 100" validation wall.
- **Paste rows** accepts TSV/CSV (`weight, text, count`) so a table written in a spreadsheet arrives in
  one paste. (This is a guess at a useful affordance, not a requirement — see Appendix A.)

*As landed (D-272): the screen above is what shipped — `Roll type` radio, weight column, live `%` column
with its total, per-row entry/count/ref (`▸ bestiary` through the real picker, `▸ world` through the world's
actors), the six chips, the linked battle scene, the cooldown, *Test roll*, *Add row*, *paste rows* and
Cancel/Save. The attached `EncounterGen4_GPT.html` never reached this workspace (Appendix A), so the layout
above was written from the requirement's description — "either by choosing dice to roll, or by using weighted
percentage system like in attachment". The model underneath is unaffected; what a re-send would let me
finalise is the widget: exact column set and labels, whether weights are entered as integers or
percentages, whether the reference pickers are inline or modal, and any generator-specific affordance
(creature-count rules, per-phase sub-tables, treasure rows). Paste the file's markup into chat, or tell
me its column headers and I will reconcile this section line by line.*

### 5.5 The results window (requirement 5c)
One window kind `encounterResult` listing what was rolled: per entry a row with the creature image, the
name, the count, and — for entity refs — a resolved actor thumbnail and its token image. Two ways out:

- **Drag one row** onto the map → the same create path a compendium drag uses today (`App.svelte:1500`),
  so the resulting token is a normal, sheet-linked token.
- **Place all** → a ring/spiral placement around the drop point: tokens are positioned with ≥ 1 cell
  between them so the GM can arrange them, never stacked (the requirement's "not in one spot, but near
  each other"). `placeEncounterTokens(originX, originY, count, layout)` is pure geometry, unit-tested,
  and refuses positions that would overlap walls (querying `scene.walls` with `distanceToSegment` — the
  same primitive `wallPickAt` uses).

### 5.6 Battle-scene hand-off (requirement 5d)
When an entry (or the table) links a scene and the GM chooses **Create battle scene**, the app:
prompts (`Create "Goblin ambush" from "Forest road"?`), duplicates the linked scene
(`duplicateSceneOps` — all tokens/walls/lights/notes/tiles/drawings re-keyed, the *image* shared by
asset hash so no bytes are copied), places the rolled tokens via §5.5's placement, marks the new scene
`active`, and posts one chat card ("Encounter: Goblin bandits — battle scene *Goblin ambush* created").
The encounter's origin cell links to the new scene (`cell.encounters[]` log) so the return trip is one
click.

### 5.7 Travel (requirement 7)
Path mode on the canvas: click cells to extend the route (clicking the last cell again removes it),
`Esc` clears, **Commit** writes `travel`. The party token then sits on the path's cursor cell, and the
hex panel shows the itinerary with per-cell cost, terrain and *encounter state*. The time controls gain a
**Travel until…** affordance: advance to the next cell border / to dawn / to dusk / by N hours — each of
which is just `advanceWorldClockOps` with the encounter pipeline hanging off it.

---

## 6. The encounter engine (proposal)

`src/core/hexcrawl/encounter.ts`, pure and DOM-free (its unit tests are the feature's contract):

```ts
type Trigger = "entering" | "moving" | "exploring" | "fighting";

interface EncounterContext {
  scene: SceneDocument; cells: CellDocument[]; tables: EncounterTableDocument[]; settings: CoreWorldSettings;
  cellKey: string; trigger: Trigger; clockSeconds: number; rng: RngFn;
  /** What already fired, per (cell, table, phase) — the cooldown ledger. */
  fired: ReadonlyArray<{ cellKey: string; tableId: DocId; atClock: number }>;
}

/** Which tables are candidates, in stable order (authored order, then id). */
function eligibleTables(ctx: EncounterContext): EncounterTableDocument[];

/** The scene's mode decides what happens next: "auto" | "prompt" | "manual". */
function encounterDecision(ctx: EncounterContext): EncounterDecision;   // { kind: "none" | "roll" | "prompt" | "manual", tables }
```

Rules, each with a test:

1. **Tag eligibility** — a table is eligible when `tags[trigger] && tags[phase]`, where `phase` is
   `day | night` from §3.7. All six default true, so a fresh table fires on everything until the GM
   narrows it.
2. **Trigger points** — `entering` fires once per cell border crossing; `moving` fires per *step* while
   travelling (rate-limited by the table's cooldown, so a 3-day march across one forest cell cannot
   demand 30 checks); `exploring` fires when the GM (or a player action) marks a cell explored;
   `fighting` fires when a combat starts on the cell (hook: the existing combat creation path).
3. **Cooldown / once-per-period** — `cooldownSeconds`, defaulting to one day phase (a night table cannot
   fire twice in the same night). The ledger is `cell.flags.core.encounters` — replicated, so two GMs
   cannot double-fire.
4. **Ties** — more than one eligible table produces the picker popup **listing every candidate** with its
   tags and a *Use* button each (requirement 5's explicit ask), never a silent first-match.
5. **Determinism** — the roll is host-seeded through the dice engine, so the result is reproducible from
   the ledger and auditable; `rng` is injected for tests.
6. **Manual** — `manual` mode does nothing on its own; the hex window's table rows are the trigger.

Output is a chat card (mode `prompt` → `gmroll`, mode `auto` → public with the creature names revealed or
hidden per a flag), or a `WindowHost` window when tokens must be placed.

---

## 7. Specification additions

### 7.1 Proposed spec §20 (drop-in text)

> **§20 Hexcrawl scenes.** A scene MAY declare a hexcrawl profile (`flags.core.hexcrawl`). A hexcrawl
> scene keeps a single map image and one of the three grid modes (hex, square, gridless); on a gridless
> map the GM authors **zones** as polygons and the reference scale is the grid's `size px ↔ distance
> units` pair. The scene MAY carry: a party token; a shared reveal set naming the cells the table has
> seen; a sight mode with a radius in cells (gridless: a radius in world units); a terrain assignment per
> cell drawn from a world-scoped terrain catalog with travel multipliers; per-cell GM and player
> descriptions; per-cell hidden features whose reveal rule is manual, a Perception DC, a time spent, or a
> dice check, each declaring whether it resolves automatically; and a set of encounter tables with
> activation tags (day, night, entering, moving, exploring, fighting; all enabled by default). An
> encounter table rolls by a dice formula or by integer weights normalised to a 1d100 ladder; its entries
> are free text, compendium references with a count, or references to actors already in the world; a
> table MAY link a battle scene, in which case resolving the encounter MAY create a copy of that scene
> with the rolled tokens placed near the encounter's origin. Encounter activation is one of: automatic,
> a GM-only pending message, or manual from the cell's panel. Where a party has a travel path, advancing
> the world clock moves the party along it at the terrain's cost and evaluates encounter triggers at every
> cell border crossed. Hexcrawl state is documents and operations; it introduces no new transport.

### 7.2 Documents this plan adds

| Where | Change |
|---|---|
| `src/core/documents.ts` | `CellDocument`, `EncounterTableDocument`, `EncounterEntry`, `EncounterRef`, `CellFeature`, `HexcrawlScene` flags type; `cells` added to `EmbeddedCollectionName`; `encounterTables` added to `CollectionName` + `TOP_LEVEL_COLLECTIONS` + `WorldCollections` |
| `src/core/store.ts` | `cells`/`encounterTables` initialised in `emptyCollections()` |
| `src/core/projection.ts` | the one rule: unrevealed features strip for non-GM viewers; cell `playerText` gated by the reveal set |
| `src/core/migrations.ts` | world-file schema stays compatible (new keys are additive and absent-safe); a migration entry only if `encounterTables` must be seeded |
| `src/app/e2eHook.ts` | new readback surfaces (`hexcrawl()`, `cells()`, `encounterTables()`, `travel()`) — the acceptance gates need to read state off documents, not off the DOM |
| `src/ui/canvas/HelpPanel.svelte`, `CanvasToolbar.svelte` | the two hint lines the new mode needs |
| `PROTOCOL.md` | **no change** (§7.4 states why) |

### 7.3 Where it plugs into what exists

| Existing module | Reused as-is | Touched |
|---|---|---|
| `canvas/grid/hex.ts` | all geometry | a `cellsInMap` helper beside `hexesInView` |
| `core/fogMask.ts` | `appendFogMask`, `pointInFogMask` | the hexcrawl set is a *second*, cell-granular layer |
| `client/fogExploration.ts` | tactical scenes untouched | hexcrawl scenes paint from the set instead |
| `packages/pf1e/worldClock.ts` | clock ops, clamps | a new *caller* (travel advance), no change to the module |
| `core/rollTable.ts`, `dice/engine.ts` | validation + seeded rolls | a weight→range compiler in front of them |
| `ui/combat/tokenContextMenu.ts` | the menu shape | the hex context menu is a sibling |
| `core/sceneLink.ts` | token generation for strategic scenes | `duplicateSceneOps` is the new piece |
| `host/import.ts` | `importImage` | the map path targets the active scene, not `DEFAULT_SCENE_ID` |

### 7.4 Why no protocol change

Everything above is documents written by `create/update/delete` ops (§4) — the same ops the wall, note and
drawing tools already emit — so validation, permissions, rate limiting, the OpLog, undo, projection and
the world file all apply without a new message. The one place a hexcrawl *could* want the wire is a
GM-pushed "reveal a hex" to a player who is not currently subscribed to the scene flag; the ops channel
already broadcasts every envelope, so that case is covered too. If a later slice wants the connector
(`MCP_CONNECTOR_SPEC_AND_PLAN.md`) to push map bytes, that feature owns the `asset.put` addition, not this
one.

---

## 8. Implementation plan

Effort scale matches `GAP_CLOSURE_ImplementationPlan.md` (S ≈ 1–2 days, M ≈ 3–5). The whole feature is
**M–L (≈ 7 focused days)**; every phase below is independently shippable and ends with the standing gate
set (`pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm size`, `pnpm build` + content + worlds, and a
Chromium e2e run), with one `DECISIONS.md` entry per phase.

### Phase 0 — Clock truth, then the model and pure core (1.5 days, S) — ✅ landed 2026-09-21 (D-268 + D-269)
**0a — the duration ladder (§3.7), first, because everything else measures time.** ✅ **Landed (D-268).**
`ttlToTicks` (`packages/pf1e/effects.ts`) hour → `n * ROUNDS_PER_HOUR` (600); `TICKS_PER_DAY` →
`ROUNDS_PER_DAY` (14,400, re-exported from `src/core/clock.ts`) with both doc comments corrected; the tests
that pin the old numbers updated (`tests/packages/pf1eEffects.test.ts`,
`tests/packages/pf1eWorldClock.test.ts` — the day sweep now ends at 86,400 s, not 14,400); a new test
asserting the ladder's own arithmetic (6 s/round → 10/600/14,400 rounds for minute/hour/day, and
`hour = 60 × minute`, `day = 24 × hour` in seconds) so the next divergence fails loudly; and its
`DECISIONS.md` entry recording the behaviour change and the in-flight option. `hourOfDay`/`timeOfDay` and
the rest of the calendar half landed in `src/core/clock.ts` (pure, derived from `clockSeconds`).
**0b — the hexcrawl model.** ✅ **Landed (D-269).** `src/core/hexcrawl/{types,scene,cells,terrain,encounter,tables,travel}.ts`
plus `index.ts`, with `CellDocument`/`EncounterTableDocument` in `documents.ts` and the `cells` embedded
collection wired through `store.ts`.
Deliverable: cells/terrain/tables/travel **as pure functions and op builders**, no UI at all. The tests do
what this plan asked — weight→range normalisation (a single entry, weights that do not sum to 100, a zero
weight, 30 entries, a 10000:1 row), the eligibility matrix (tags × phase × trigger), the cooldown ledger,
the terrain cost table, `cellsWithin` rings on all four hex layouts plus square and gridless, `timeOfDay`
— as `tests/core/hexcrawl{Cells,Terrain,Tables,Encounter,Travel,Scene}.test.ts`, **89 tests**.
*Gate to leave the phase:* ✅ the fake-host test is `tests/core/hexcrawlTravel.test.ts` — it builds a scene
with a real `DocumentStore`, reveals cells, attaches a table, marches the party three days by pumping the
real `advanceWorldClockOps` through the store, and asserts the emitted op stream (border steps, the
`entering`+`moving` triggers, arrival clearing the route) — done entirely in Node, no browser.

### Phase 1 — Scene wizard, map upload, grid (1 day, S) — ✅ landed 2026-09-21 (D-270)
Wizard window, `importMap` targeting the active scene, `cellsInMap`, the scene editor's hexcrawl block
(sight mode, radius, encounter mode, daylight hours).
*e2e (`hexcrawl_scene.spec.ts`):* create a hexcrawl scene from the start screen with a bundled PNG, pick a
hex layout, read back `[data-scene]` state, and see the cell count and the reference scale in the panel.
What landed: the `+` in the scene nav is a menu (`Blank scene` / `Hexcrawl scene…`) opening
`ui/hexcrawl/HexcrawlWizard.svelte` — three steps (map → grid → party), the gridly/hexless choice falling
back to a GM reference scale, the party size feeding `newHexcrawlPartyOps`, and a live cell census from
`cellsInMap`; a scene made this way installs `PF1E_TERRAIN_CATALOG` into the world setting on first use and
puts `importMap`/`#map-input` on the *active* scene instead of `DEFAULT_SCENE_ID`; the scene editor grew a
hexcrawl block (hexcrawl on/off, sight mode + radius, encounter mode, party token, dawn/dusk, march speed,
cell census, terrain table with costs and the road rule).
Two things the browser gate taught, both worth keeping: **the host validates an intent against the store as
it stands**, so an op that references a document created in the *same* envelope is refused
(`invalid_schema: create: parent not found`) — the wizard therefore submits two envelopes, batch 1
`newHexcrawlSceneOps` (scene + deactivate actives + terrain catalog) and batch 2 `newHexcrawlPartyOps`
(party token + profile) from the `ops` bus once the scene exists, which is why `scene.ts` splits those two
builders; and `catalogToJson` was dropping `road`, so a catalog read back out of the world setting priced
roads as ordinary terrain — found by the spec, pinned by a round-trip test.

### Phase 2 — Hex overlay, menu, window, fog (1.5 days, M) — ✅ landed 2026-09-21 (D-271)
`HexOverlayLayer` (grid + terrain fills + reveal dimming), the canvas context menu, the `hex` window, the
reveal set, GM open/close, party sight ring.
*e2e:* GM opens a hex → the player's shell sees it revealed and sees *nothing* of the neighbours; the party
token moves one cell → the ring opens exactly one more cell; a closed hex's description never reaches the
player (asserted off the player's replica, not off the DOM).

**As landed.** `core/hexcrawl/visibility.ts` (the open set, the party's ring, `sightReconcileOps`, and
`projectCellForViewer` — the projection rule) and `core/hexcrawl/overlay.ts` (the plan both viewers paint,
with `hexOverlayKey` as the cheap rebuild signature) · `HexOverlayLayer` (terrain tints and outlines below the
tokens; the player's cover as whole-map-minus-open-cells via `Graphics.cut()`, mounted at the bottom of the
fog holder) driven by one shared call site, `src/app/hexOverlay.ts`, and painted by **both** shells · the
closed-cell rule: **a closed cell is never sent to a player** — revealing is a `create` for that session and
closing is a `delete`, rewritten per session by `host/sync.ts` (`cellRevealCrossings`/`withCellReveals`), which
is what lets a player's cover be painted from the grid instead of from documents · `ui/hexcrawl/hexContextMenu.ts`
(the §5.2 menu as a pure model: permission-gated entries, and the Phase 3–6 entries present but disabled with
the reason) + `HexWindow.svelte` (§5.3's terrain select, GM/player texts, table rows with tag chips, feature
rows with reveal rules and the GM's checkbox; a cell is created by its first edit) + a `hex` window kind in
both shells · `gm+party` sight reconciled off the ops bus, so any party move by any client extends the ring.
*Two findings the browser forced:* the player shell read `scene-1` by id, so a table that activated a second
scene left its players on the first scene's map (now the `active` flag wins, as in `App.svelte`); and
`TokenDocument.x/y` is a token's **centre** with `width/height` in **pixels**, which the Phase 0b readers got
wrong by a factor of a hundred cells (one reader now: `partyCentreOf`).

### Phase 3 — Encounter tables and the wizard (1 day, S) — ✅ landed 2026-09-21 (D-272)
Collection + wizard + validation + test roll + tag chips + the results-window shell.
*e2e:* build a weighted table with a compendium ref in the wizard, test-roll it, save it, and read it back
from the world (entries, weights, tags).

**As landed.** `ui/hexcrawl/tableEditor.ts` (the wizard's whole model as pure functions: the live `%` column
**counts the ladder's faces** so 30/30/30 reads 34/33/33 and always totals 100, the dice↔weighted switch is
lossless in one direction and *refuses* `2d6` in the GM's words, `parsePastedRows` reads TSV **or** CSV with
reported failures, `savePlan` diffs the draft so an unchanged save writes no ops, and attaching creates a
cell nobody has described) · `EncounterTableWizard.svelte` (kind `encounterTable`: name, roll type, formula,
rows with weight/percent/entry/count/ref, add/move/remove, paste, the engine's own validation lines, six tag
chips all on, linked battle scene, cooldown, **Test roll**, Save) · `EncounterTablesWindow.svelte` (kind
`encounterTables`: the world's library — New/Edit/Duplicate/Delete, with the delete also detaching the table
from every cell — or, given a scene+key, the hex's attach list) · `EncounterResultWindow.svelte` (kind
`encounterResult`: the roll, the text, the count, the resolved entity rows, a `Test roll` preview banner, and
*Place all* / *Create battle scene* present-but-disabled for Phase 5) · `ui/hexcrawl/encounterResult.ts` (the
roll carried out-of-band, since `WindowSpec.data` is a string map, plus `resolveEncounterRefs` and the two
actor-image readers) · `core/hexcrawl/tableOps.ts` (create/update/duplicate/delete ops, the `-=field`
removals, `detachTableFromCellsOps`) · `core/hexcrawl/tables.ts` gained `rowShares`/`rowPercents`,
`convertTableToWeighted`/`convertTableToDice`, `formulaIsReadable` and `parsePastedRows` · the picker gained
`kind: "actor"`; the canvas menu's *Attach encounter table…* is live (it asks the shell for the tables window
via `HexMenuResult.openTables`) and *Roll from a table…* now waits for Phase 4; the hex window gained its
own attach button and its roll button re-labelled Phase 4; the GM toolbar gained **Tables**.
*Two bugs the browser found:* an unguarded `win.data` made the library window unrenderable (a `pageerror`
with an empty window manager), and the tables window carried the hex as `cellKey` while the host reads
`data.key`, so a wizard opened from a hex silently lost its attach target. *One gate fix:* a window over the
canvas eats the next right-click, so the spec closes each window explicitly before the map's own gesture —
and `e2e/hexcrawl_scene.spec.ts` now carries the explicit 90 s budget its slow siblings have.

### Phase 4 — The engine and its three modes (1.5 days, M) — ✅ landed 2026-09-22 (D-273)
Trigger wiring (token move, travel step, explore, combat start), cooldown ledger, tie popup, `auto` chat
card, `prompt` GM-only pending message, `manual` roll from the hex window.
*e2e:* with `prompt` mode, walking the party into a tagged hex posts a GM-only card naming the eligible
table; the player shell never receives it; clicking it rolls and produces the results window.

**As landed.** `core/hexcrawl/encounterFlow.ts` (the engine's *calling* half, DOM-free: `hexcrawlClockSeconds`
reads the world clock the D-268 ladder writes, `encounterCheck` filters the cell's tables and hands them to
`encounterDecision`, `rollTableNow` is the one draw-plus-ledger pair both the `auto` and the manual path use,
`readyIn`/`firedAtIn`/`formatCooldown` state the cooldown in the GM's own units, `encounterPromptMessage` /
`encounterResultMessage` build the cards, `answerPromptOps` / `openPromptFor` are the prompt's lifecycle, and
`EXPLORE_SECONDS = 3600` is what *explore* costs) · `core/hexcrawl/encounter.ts` gained `EncounterAnnounce`,
`EncounterNoneReason` and the trigger helpers · `ui/chat/EncounterCard.svelte` (the card as one component:
a prompt lists **every** candidate with its tag mask and one *Roll this* per row — a tie is a list, never a
silent first match — and a result shows the roll, the text, the count, and the not-yet-placeable token verb;
its `data-encounter-*` hooks are what the spec asserts) · the shell's wiring in `App.svelte`: one
`runEncounterTrigger(trigger, key)` that submits the decision's ledger ops, posts the prompt (deduped by
`openPromptFor`) or the `auto` result card, `runEncounterTriggers` asking `entering` then `moving` and stopping
at the first decision that did anything, `rollEncounterTable(messageId | null, tableId, key)` for both the
card's answer (GM-only card, prompt marked answered) and the hex window's own roll (public card, names per the
scene's flag), and `exploreCell(key)` submitting the clock envelope *before* asking `exploring` · the trigger
hooks themselves: the ops listener (after `reconcilePartySight`) for a **border crossing** — computed from
`lastPartyCell`, so a GM's drag, a player's drag, an undo and a rejoin all trigger the same way, and the first
reading is a baseline rather than a crossing — and the combat-creation path for `fighting` · the hex window's
table rows now roll (`onRollTable` up through `WindowHost.onHexRollTable`), with the scene's mode stated in the
window; the canvas menu's *Roll from a table…* opens that window and *Explore this hex* asks the shell for the
clock envelope; the settings panel gained one control, *Public encounter cards* (`encounterAnnounce`), because
a flag nothing can set is not a flag.
*Two findings the browser forced:* the prompt card carried no `gmOnly`, so a GM-only message did not say so
(the whisper was the enforcement, but the card is the label), and the results window's *Close* button only
forgot the roll — leaving the frame on screen reading "no longer available" — instead of closing the window.
*A gate note:* this sandbox re-cloned the repository, so the earlier sessions' commit objects (D-266…D-272)
were gone; the tree — which is the source of truth — was re-landed in one commit whose message says so, and
the per-decision records with their gate numbers live in `DECISIONS.md` as always.

### Phase 5 — Resolution: tokens, placement, battle scene (1 day, S) — ✅ landed 2026-09-22 (D-274)
Results window, drag payload, `Place all` scatter, `duplicateSceneOps`, the linked-scene confirm flow, the
cell's encounter log.
*e2e:* roll a two-entry table, `Place all`, assert both tokens exist and are not co-located (distance ≥
one cell), then create the battle scene and assert the copy has the original's walls and the new tokens.

**As landed.** `core/hexcrawl/placement.ts` (the geometry, DOM-free and unit-tested: `placementSpacing`
reads the grid — 100 px when there is none — `placeEncounterTokens` walks the origin and then rings of `6·r`
points at `r·spacing`, refusing positions a wall cuts through via the vision layer's `distanceToSegment`,
and taking the blocked points anyway when the rings run out so a count always places; `encounterTokenData`
turns rows into hostile tokens, `ownership {default: 3}`, with the token literal built inline because core
does not import the app's `makeToken`) · `core/sceneCopy.ts` (`duplicateSceneOps` — one `create` re-keying
every embedded child in a fixed order, tokens → walls → notes → cells → lights → sounds → tiles → drawings →
templates, the map image shared by asset hash rather than copied, and the copy's own `active` **inside** the
create, because the host refuses an op that touches a document created beside it — D-270's rule, which cost
this phase its first browser run; `copyName` for the "… (copy)" convention) · `core/hexcrawl/encounter.ts`
gained the cell's log (`LOG_FLAG "encounterLog"`, `encounterLogOf`, `logEncounterOps`, bounded to the last
20) · `EncounterResultWindow.svelte`: the entity rows are draggable (`application/x-vtt-encounter`,
`{resultId, rowIndex, name, count}`), *Place all* is live, and *Create battle scene* opens the §5.6 confirm
as two buttons plus a cancel (`data-result-battle-confirm` / `-yes` / `-no`) instead of a `window.confirm`;
the linked scene's name is read off `client.store` (`roll.tableId` → the table's `sceneId` → that scene's
name) rather than passed in · the shell's own verbs: `placementEntriesFor` (a bestiary ref is imported
through the packages path, exactly as a compendium drag does, so the creature on the map is an actor-backed
token), `placementOrigin`, `placeEncounterAt` (drag a row, or *Place all*, and the token creates plus one
log row travel in one envelope), `createBattleScene` (copy + tokens inside the copy + the copy active + one
chat card + the log row naming it) and `onEncounterDrop` on the canvas's drop handler · the hex window
lists the cell's encounter log (GM-only) and its scene row activates the copy, so §5.6's "the return trip is
one click" is a click.
*Two notes from the browser:* the phase's first run failed because the copy's `active` was a follow-up
`update` on a document the same envelope had just created — the host validated the ref against the
pre-batch store, refused the intent, and the scene, the log and the card disappeared together; and a window
over the canvas still eats the next right-click (the spec closes the results window before the canvas
gesture, and the still-open hex window is what proves the log's one-click row).

### Phase 6 — Travel, terrain, hidden features (1.5 days, M) — ✅ landed 2026-09-22 (D-275)
Path mode, itinerary preview, the `travelAdvance` call site (the model landed in Phase 0b, this is the
  clock/UI wiring), terrain brush, feature model and
evaluator (manual / perception / time / dice), auto vs manual reveal, the projection gate.
*e2e:* commit a three-cell forest path, advance one day on the clock, and assert the party moved by the
terrain-priced amount, the clock advanced exactly that, and an exploration-timed feature revealed itself on
the third day.

### Phase 7 — Polish, docs, decisions (0.5 day) — ✅ landed 2026-09-22 (D-276)
Help panel entries, toolbar hints, keyboard (`H` for the hex menu?), the i18n strings kept in one table
(G-38 is open; this feature must not add scattered literals), `STATUS_ASSESSMENT` + `GAP_ANALYSIS` §5.1
note (this feature is *not* a parity row — it gets its own line under "not in the open set, by decision"
unless the product decision is otherwise), and the closing `DECISIONS.md` entries.

### Sequencing note
Phases 0–2 are the *walking skeleton* (a hexcrawl scene you can look at); 3–5 make it a game; 6 makes it a
campaign. If the product wants a demo sooner, ship 0–2 + a hand-authored encounter table (3) and stop.

*Status after Phase 6 (2026-09-22):* Phases 0–6 are landed (D-268…D-275). The party now **walks**: path
mode draws a route one hex at a time (`Esc` gives it up, *Commit route* writes it), the itinerary prices it
per cell off the same `stepSecondsOf` the march will charge, and the six travel buttons spend the **world
clock** — *To the next hex*, *Travel the route*, *To dawn*, *To dusk*, *+1 day* — walking the party as far
as that time and the terrain allow and leaving the rest of it spent where the party stopped. Every cell the
march touched keeps the seconds it was given (`flags.core.exploredSeconds`), which is the counter a hidden
feature's *time* rule reads: a shrine that waits for 40 h in a hex reveals itself on the third day with no
GM click, and posts one plain card in the chat — `Found at 6,3: the old well` — because a feature the
players are allowed to hold is not a secret. The three canvas-menu rows that were disabled after Phase 5
are live: *Features of this hex…*, *Move party here* and *Add to path*. What was left is Phase 7 (polish,
help, the closing docs), and the acceptance line is the Phase 6 e2e spec: **a three-cell forest path, one
border and one day, and the ledger summing to exactly what the clock advanced** — plus the third-day
reveal.

*Status after Phase 7 (2026-09-22):* **the feature is complete** — Phases 0–7, D-268…D-276. Phase 7
paid the plan's own debts: the help window carries a **hexcrawl sheet** (right-click, `Y`, `Esc`,
`Shift+H`, and the model in words — the clock walks the party and a hex keeps the hours), `Shift+H`
opens the hex the party stands in from anywhere on the map (`h` alone is Roll20's hand tool, so the
modifier buys the mnemonic), the travel panel says beside its buttons that they spend the **world
clock**, and every sentence the feature speaks — a rule label, a note, a log line, a menu entry, a
hint — lives in **one table** (`src/core/hexcrawl/strings.ts`) instead of being scattered across
modules, so G-38's eventual extraction is one file's worth of work. `GAP_ANALYSIS_Roll20_Foundry.md`
§5.1 records the standing decision that this was never a parity row, and `STATUS_ASSESSMENT_2026-09-21.md`
§5 carries the dated note.

*Status after Phase 5 (2026-09-22):* Phases 0–5 are landed (D-268…D-274). A table a GM writes now fires —
automatically when the party enters or moves through a tagged hex, as a GM-only pending card whose roll the
GM answers, or by hand from the hex window — the cooldown ledger keeps it quiet, and the result **reaches the
map**: drag a row where you want it, or *Place all* to scatter the creatures at least a cell apart on a
wall-aware spiral, and take the whole thing to the linked battle scene, which is a copy of the linked map
with the encounter's tokens already in it and a row in the hex that remembers it. What is left of the
requirement set is Phase 6 (path travel priced by terrain and advanced by the clock, and hidden features
revealed by their own rules — requirements 6, 7 and 8's automatic half) and Phase 7 (polish, help, the
closing docs). The disabled rows in the canvas menu say which: *Reveal feature…*, *Move party here*, *Add to
path*.

---

## 9. Risks, and the open questions this document cannot decide alone

1. **Reveal-set growth.** A 60×40 hex map has 2,400 keys ≈ 20 KB of flag JSON, replicated on every write.
   Mitigation: the set is written per brush stroke, and the compaction path (a `revealedAll` boolean plus a
   *closed* set instead of an *open* set) is trivial to add if a table ever hits it. Recommend shipping the
   open set and measuring (the repo's habit: assert the footprint in a test — the compendium index's
   `indexFootprintBytes` is the precedent).
2. **Two fog models on one map.** A hexcrawl scene that also wants the tactical per-user explored fog is
   out of scope; the profile's `sight.mode` is the only switch. If a table wants both, the honest answer is
   "use a tactical scene for the dungeon, a hexcrawl scene for the overland" — and the scene copy flow
   (§5.6) is exactly how they get there.
3. **The duration-ladder correction (§3.7).** Decided, but it is the one item in this plan that changes
   shipped behaviour: an effect labelled "1 hour" currently ends after ten in-game minutes. Phase 0 makes
   the ladder real-time; the open part is only *how* to treat effects already in flight, and §3.7 records
   both acceptable answers (one deterministic recompute, or accept it at the next session).
4. **Night tables and the clock.** "Night" is evaluated at the moment of the check; a party that enters a
   hex at 17:55 and leaves at 18:05 gets the day table. Deterministic, documented — and the reason the
   picker popup exists.
5. **Perception as a *check* vs a DC.** Requirement 8 says "perception check". The plan reads the party's
   *passive* value by default and offers an active check (roll the best modifier, `evaluateDetection`
   already exists) as a per-feature setting; a hostile reading (a hidden roll per step) would spam the
   table.
6. **Encounter spam.** Cooldowns default to one phase per table; the `moving` trigger is rate-limited to at
   most one check per cell *per table*. If the playtest says that is still too many dice, the knob is data.
7. **Image leakage for unrevealed features** (§3.5) — handled by projection, but it *must* be asserted in
   the player shell e2e or the bug returns the first time someone writes a new window.
8. **Not asked for, deliberately not designed here:** weather, foraging/supply, hex-level lairs with their
   own maps, road-building, faction ownership of hexes (the `factions` collection exists and could carry
   it — a later slice), and automatic XP/rewards for exploration.

---

## 10. What this plan deliberately does not do

- **No new document *kind* for the scene.** A parallel `HexcrawlSceneDocument` would fork the canvas,
   fog, projection, world file and every tool. A flag is additive and reversible (`flags.core.hexcrawl`).
- **No second travel or clock system.** The replicated world clock stays the only time — one integral
  clock whose hours and days are derived from 6-second rounds (§3.7) — and travel is a consumer of
  `advanceWorldClockOps`, not a scheduler of its own. The one change this plan makes *to* that clock is
  the ladder correction its own consistency requires; it is named, phased first, and gets its own entry.
- **No new dice machinery.** Every roll (table, feature, perception) goes through the existing engine with
  a host seed, so the audit story is unchanged.
- **No silent re-use of the combat "encounter" name.** `ui/combat/encounters.ts` and `combat` documents
  mean "the turn tracker's encounter"; this document always says **random-encounter table** for the
  hexcrawl object to keep the two apart in code, UI strings and tests.
- **No Monte-Carlo weather, no PDF parsing of published hexcrawl maps, no OCR of hex numbers.** The GM
  authors cells; the map image is a picture.
- **No change to `PF1e_Unified_TODO.md`** (§12 coverage derives from its checkboxes).

---

## Appendix A — the attachment (still not delivered)

The request names `EncounterGen4_GPT.html` as the reference for the weighted-percentage roll type. It has
been attached twice and **has not reached this sandbox either time**: `/home/user/uploads/` does not exist
after the message, and a filesystem-wide search for `*EncounterGen*` (and for any HTML file newer than the
session start outside the repo's own `index.html`) returns nothing. That is a delivery problem on the
attachment path, not a mis-named file — the client shows the attachment as sent.

What that means for this document: §5.4's *weighted mode* is written from the requirement's own words and
from what the surrounding app already does, and the parts that could only come from the file are marked in
place. To finish it, either paste the file's markup (or just its table's column headers and the controls
around it) into chat, or drop it anywhere under `/home/user/` in the next message; reconciling §5.4 with
it is then a small edit that touches no other section — the data model, the compiler
(`weightsToRanges`), the tag mask and every phase in §8 are independent of the widget's layout.

## Appendix B — the one-line pitch for the roadmap

> **Hexcrawl scenes** turn the hex map into a first-class table surface: the GM uploads the map, picks a
> hex, square or gridless grid, brushes terrain, writes hex descriptions, hangs encounter tables on the
> hexes with day/night and travel triggers, opens hexes for the party as they cross them, keeps the clock
> honest while the party walks a path — and gets the encounter's tokens on a copied battle scene in one
> click.
