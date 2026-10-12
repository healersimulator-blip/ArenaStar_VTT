# Elevation test scene: "Ice Beacon"

A ready-made scene in the **Pathfinder 1e starter world** for human testers. It covers floors,
stairs, openings between floors, raised areas inside a floor, and height labels on tokens.

- **Where:** both PF1e starter archives built by `pnpm build:worlds`. One is
  `dist/worlds/pf1e-mass-battles-starter-1.0.0.zip` (the pf1e-core compendia: Spells, Bestiary,
  Classes, Equipment, Feats, Poisons). The other is `pf1e-mass-battles-tester-1.0.0.zip`, which
  also carries the converted PF1e content. Both seed the scene through `testerDocuments()` in
  `scripts/buildStarterWorlds.mjs`, which calls `scripts/starterIceBeacon.mjs`.
- **Scene:** `scene-ice-beacon`, named **"Ice Beacon — Elevation Test"**. Open it from the scene rail.
- **Tests:** `tests/scripts/iceBeaconScene.test.ts` (every claim below, against the real floor,
  sight and label code, from the builder's own documents) and `e2e/ice_beacon_scene.spec.ts`
  (a GM and a player in a real browser, over the built zip).
- **Decisions:** D-452 (height labels measured from the viewer), D-453 (raised areas) and
  D-454 (this scene). See `DECISIONS.md`.

## 1. What the scene must show, and where it shows it

| Requirement | Where in the scene |
|---|---|
| One hero (player character) | **Hosilla**, owned by players, starts inside the entrance of the Ground Hall |
| Opposition placed to show the features | 9 GM-controlled creatures across four floors (table in §3.5) |
| A building at least three storeys high | Ground Hall, Gallery and Crystal Ring, with the Beacon platform on top |
| Every floor joined by stairs | Two spirals and a balcony stair Hall↔Gallery, twin spirals Gallery↔Ring, one stair Ring↔Beacon |
| At least one hole between floors | The Gallery's great opening and the Ring's central opening over the Hall; the twin-spirals' gap; the balcony's two bridge gaps |
| Floors of different heights, editable | Hall 20 ft, Gallery 15 ft, Ring 10 ft, Beacon open-topped. Change them in **Scenes → Draft levels** |
| Raised areas of different heights inside one floor | Hall crate stacks of **5, 10 and 15 ft** (solid), and a **10-ft scaffold** (open) |
| Height labels under tokens | `+10 ft` / `-20 ft` text under every visible token whose height differs |
| Players: relative to their own token | Measured from the selected token, else the followed one, else the player's first token |
| GM: relative to the ground | Measured from elevation 0 |
| Solid raised areas block sight; open ones do not | A hobgoblin hides behind the 15-ft stack. An orc stands visible behind the open scaffold |

## 2. Readiness at the start of this work

The request said that if the implementation was not ready for this scene, this document should
describe the scene and the work should continue. It was not ready:

| Needed | State before | Done in this change |
|---|---|---|
| Floors, floor heights, stairs, openings, seeing floors below | Ready (G-01…G-33: floor bands, stairwells, traced/drawn floor surfaces, lower floors and tokens seen through openings) | Used as is |
| Raised areas *inside* a floor (crates, scaffold) | **Missing.** A token's height was only ever set by hand or by stairs | **D-453:** a region can be a *raised area* `{height, solid}`. Walking onto one raises a token to its top, walking off lowers it. Solid ones block sight for eyes below their top, on the floor (fog and token visibility) and from the floor above (cross-floor sight). Authored with the **Raised area** tool, edited in **Scenes → Raised areas** |
| Labels relative to the viewer (players) / ground (GM) | **Different rule.** D-440 drew a badge in the token's top-right corner showing the height above the token's *own floor*, for everyone | **D-452:** the label sits under the token. The GM's label is the height above 0; a player's is the difference from their own token. Tokens seen on floors below are labelled too |
| A starter world that can carry a floor scene at all | The writer emitted `format: 2`, and the reader refused format-3 features, so **a world with floors could not be re-imported** and a stairwell's capability was not even accepted | Format 3 with the required capabilities (`starterRequiredFeatures()`, parity-checked against `requiredWorldFeatures`), and `STAIRS_V2_FEATURE` admitted by `validateWorldMeta` |
| A PF1e scene with this content | **Missing** | **D-454:** the Ice Beacon scene, art and actors in the starter world |

## 3. Scene layout

Scene `2200 × 2200` px, grid `100 px = 5 ft`, isolated floor play on, darkness 0, fog on,
backdrop `#1b2430`. All coordinates are scene pixels; token x/y is its **centre**, tile and
region x/y its **top-left**.

### 3.1 Art and provenance

- **Floor art:** the "Ice Beacon" sample maps (`sample-maps/andythebrave/`) shipped inside
  `Examples/RipperLevels-7.0.3.zip`, the Levels module 7.0.3 by theripper93 — First, Second, Third
  and Fourth Floor (the Second Floor Bridge is not used).
- **Derived files:** `Assets/Maps/IceBeacon/*.webp`, downscaled 50 % from 4300 px to 2150 px with
  ImageMagick, which keeps each floor texture under the 4096-px limit of some GPUs. The maps' own
  grid is 50 px per 5 ft, so one scene square covers two of the map's squares. Each floor's art
  tile is placed at **(25, 25)**, size 2150.
- **Props:** `crates-5ft/10ft/15ft.png` (200²) and `scaffold-10ft.png` (300×200) were drawn for
  this scene with ImageMagick primitives. They are original.
- **Provenance and licence:** the module's README credits the sample maps as "using assets from
  Forgotten Adventures". **No licence grant was located** for the module or its sample maps
  (`tools/adopt/INVENTORY.md` rows 14–15, `LEGAL.md` §3). The floor art is for **internal testing
  only**; replace it before any public distribution of the starter world.

### 3.2 Floors

| Floor | Id | Band (ft) | Height | Art tile | Solid surface (traced from the art's alpha) | Sees below |
|---|---|---|---|---|---|---|
| Ground Hall | `lvl-ib-hall` | 0 – 20 | 20 ft | `tile-ib-hall` + the four prop tiles | untraced: solid everywhere | – |
| Gallery | `lvl-ib-gallery` | 20 – 35 | 15 ft | `tile-ib-gallery` | walk + north balcony; 3 openings: x 550–1700 y 500–1700 over the Hall, and the two bridge gaps | Hall |
| Crystal Ring | `lvl-ib-ring` | 35 – 45 | 10 ft | `tile-ib-ring` | ice ring; 2 openings: x 450–1725 y 450–1800, and the gap x 975–1125 y 1875–1950 between the twin spirals | Gallery, Hall |
| Beacon | `lvl-ib-beacon` | 45 – ∞ | open sky | `tile-ib-beacon` | the disc with its ice spikes and the stair stub on its north side; no openings | Ring, Gallery, Hall |

Surfaces were traced with `traceSurface` (`src/core/floorSurface.ts`) over the art's alpha
(> 50 %) at a 50-px cell, 75 px for the Ring, and are stored in the generator as integer rings.
Walls run along each floor's outer ice wall, scoped to their floor (unscoped walls do nothing in
floor play); the Hall's entrance is a **locked door** (`door-ib-hall-entrance`).

### 3.3 Stairs (both directions, `mode: "auto"`, hidden regions with player markers)

| Stairs | Joins | Area (x, y, w × h) | Lands on the upper floor at | Lands on the lower floor at |
|---|---|---|---|---|
| `stairs-ib-west` "West spiral" | Hall ↔ Gallery | 530, 530, 200 × 200 | (450, 650) | (650, 850) |
| `stairs-ib-east` "East spiral" | Hall ↔ Gallery | 1520, 530, 200 × 200 | (1750, 650) | (1650, 850) |
| `stairs-ib-balcony` "Balcony stair" | Hall ↔ Gallery | 1060, 775, 130 × 155 | (1150, 650) | (1150, 1000) |
| `stairs-ib-twin-west` "Twin spiral (west)" | Gallery ↔ Ring | 870, 1810, 130 × 135 | (1050, 1750) | (1050, 1750) |
| `stairs-ib-twin-east` "Twin spiral (east)" | Gallery ↔ Ring | 1200, 1810, 130 × 135 | (1150, 1750) | (1150, 1750) |
| `stairs-ib-beacon` "Beacon stair" | Ring ↔ Beacon | 1020, 480, 200 × 220 | (1150, 850) | (1150, 350) |

Every landing is on solid floor of its own level and outside the stairwell that grants it (the
test asserts both), so a token never arrives inside a wall or back in the well.

### 3.4 Raised areas (Ground Hall)

| Area | Box (x, y, w × h) | Height | Solid | What to look for |
|---|---|---|---|---|
| `raised-ib-crates-5` Crates (5 ft) | 600, 1400, 200 × 200 | 5 ft | yes | step up: Hosilla stands at +5 ft |
| `raised-ib-crates-10` Crates (10 ft) | 600, 1200, 200 × 200 | 10 ft | yes | the middle step |
| `raised-ib-crates-15` Crates (15 ft) | 800, 1200, 200 × 200 | 15 ft | yes | hides the Ambusher from the entrance |
| `raised-ib-scaffold` Scaffold (10 ft, open) | 1300, 1100, 300 × 200 | 10 ft | **no** | the orc behind it stays visible |

Each area also has an art tile (`tile-ib-crates-5` … `tile-ib-scaffold`) on the Hall's
`tileIds`, at the same rectangle.

### 3.5 Tokens

| Token | Floor | Centre (px) | Elevation | Purpose |
|---|---|---|---|---|
| **Hosilla** (player) | Hall | (1150, 1750) | 0 | the hero; at the entrance, no label |
| Hobgoblin Lookout | Hall, on the 15-ft crates | (950, 1350) | 15 | visible over the crates, label `+15 ft` |
| Hobgoblin Ambusher | Hall, behind the 15-ft stack | (750, 1050) | 0 | **hidden** from the entrance by the solid stack |
| Hobgoblin Sentry | Hall, on the 5-ft crates | (650, 1550) | 5 | label `+5 ft` |
| Hobgoblin Archer | Hall, on the scaffold | (1450, 1250) | 10 | label `+10 ft` |
| Feral Orc | Hall, behind the scaffold | (1650, 1050) | 0 | **visible** through the open scaffold |
| Troll (Large) | Gallery, balcony's east foot | (1300, 650) | 20 | `+20 ft` for the GM, no label for a player standing on the Gallery |
| Vrock (Large, flying) | Gallery band, over the opening | (1100, 1000) | 30 | `+30 ft` for the GM, `+10 ft` from the Gallery |
| Axe Beak (Large) | Crystal Ring, west walk | (600, 1200) | 35 | seen when Hosilla reaches the Ring |
| Oracle of Baphomet | Beacon | (1150, 1150) | 45 | top of the tower |

Hosilla reuses the Jungle demo's actor `hosilla`, so she is the same character in both scenes.
Each opponent has an actor of its own, so hit points are never shared.

## 4. Tester script

Open the starter world as the GM and invite a player from **Session & world**. Hosilla is the
player's token. One drag is one move action: at most 30 ft (6 squares) for Hosilla, and the PF1e
rules refuse a walk through an enemy's square — route around it.

1. **GM, ground-relative labels.** Open the scene. Under each Hall token: Lookout `+15 ft`, Sentry
   `+5 ft`, Archer `+10 ft`; the Ambusher, the Orc and Hosilla have no label (they are at 0). Use
   the **GM floor** picker to view the other floors: Troll `+20 ft`, Vrock `+30 ft`, Axe Beak
   `+35 ft`, Oracle `+45 ft`.
2. **Player, LOS by solid crates.** The player sees the Lookout (`+15 ft`), the Sentry (`+5 ft`),
   the Archer (`+10 ft`) and the Orc behind the open scaffold. The **Ambusher is not shown**, and
   the floor behind the 15-ft stack stays fogged.
3. **Player, climbing.** Drag Hosilla onto the 5-ft crates: she rises to 5 ft by herself and the
   labels now read from her — Lookout `+10 ft`, no label on the Sentry, Archer `+5 ft`, Orc `-5 ft`.
   Onto the 10-ft crates' north edge: the **Ambusher appears** at `-10 ft` (the Archer and the Orc
   are now behind the 15-ft stack). Down to the floor again and she is back at 0.
4. **GM, solid vs open.** In **Scenes → Raised areas**, untick *Solid* on *Crates (15 ft)*: the
   player now sees the Ambusher from the entrance. Tick *Solid* on the scaffold: the Orc
   disappears for a player standing at the entrance. Undo restores both.
5. **Player, stairs and openings.** Step down to the north-west (around the Ambusher) and walk into
   the west spiral: she arrives on the Gallery at 20 ft, `Gallery` in the floor banner. There the
   Troll is level with her (no label) and the Vrock reads `+10 ft`. Through the opening she sees
   Hall tokens labelled from her — Lookout `-5 ft`, Archer `-10 ft`, Orc and Ambusher `-20 ft`.
   Walking into the opening itself is refused ("No floor there"). The twin spirals (south) take her
   to the Crystal Ring (35 ft), where the Vrock reads `-5 ft`; the north stair climbs to the
   Beacon (45 ft).
6. **GM, editable floor heights.** In **Scenes → Draft levels**, change the Ground Hall's top from
   20 to 25 and apply: the floors above move up with it, tokens with them, and the labels follow.
7. **GM, authoring.** Pick the **Raised area** tool (⛰) and drag a rectangle on the Hall: a 5-ft
   solid raised area on the viewed floor, with a dashed outline and label only the GM sees. Edit
   its height or *Solid* flag, or delete it, in the panel.

## 5. Known limitations

- A floor never sees the floors **above** it, so a Hall player does not see the Vrock or the
  Gallery's tokens. Looking up is a separate feature that is not built yet.
- Raised areas are boxes: solid from their floor to their top. Overhangs, ramps and climbing rules
  (Climb checks, movement cost) are not modelled. Walking onto any raised area raises a token to
  its top, whatever the height difference.
- A solid raised area occludes with its **far sides** (the edges it stands behind): what is on top
  of it is revealed, what is behind it is not. Its own top surface is therefore walkable and
  visible, but the area is still a plain box for movement.
- Solid raised areas do not cast light shadows on their own floor (lighting is unchanged). They do
  block light and sight in the cross-floor (3D) checks.
- A token that ends its move with its centre over a raised area stands on top of it. The
  footprint of a Large token is not considered.
- The starter streams 2.6 MB of floor art to a player at the wire's 1 MiB/s cap, so a fresh
  client shows tinted placeholders for tens of seconds before the art appears. That is the
  asset path, not the scene.

## 6. Rebuilding

- The scene is generated by `scripts/starterIceBeacon.mjs` from `testerDocuments()`. Change
  coordinates there and run `pnpm build:systems && pnpm build:worlds`.
- To regenerate the floor art from the zip: extract `sample-maps/andythebrave/*.webp`, then
  `convert "<Floor>.webp" -resize 2150x2150 -quality 80 Assets/Maps/IceBeacon/<floor>.webp`.
- To re-trace a surface after changing the art: extract its alpha at half size
  (`convert <floor>.webp -alpha extract -resize 1075x1075 -depth 8 gray:/tmp/<floor>.gray`), sample
  it in `traceSurface` (cell 50 px, scene space = art space + 25 px, × 2), and paste the integer
  rings into `SURFACES` in the generator. Check the drawing before shipping: the tracer follows
  every opaque pixel, art debris included.
