# Elevation test scene: "Ice Beacon"

A ready-made scene in the **Pathfinder 1e starter world** for human testers. It covers floors,
stairs, openings between floors, raised areas inside a floor, and height labels on tokens.

- **Where:** both PF1e starter archives built by `pnpm build:worlds`. One is
  `dist/worlds/pf1e-mass-battles-starter-1.0.0.zip` (the pf1e-core compendia: Spells, Bestiary,
  Classes, Equipment, Feats, Poisons). The other is `pf1e-mass-battles-tester-1.0.0.zip`, which
  also carries the converted PF1e content. Both seed the scene through `testerDocuments()` in
  `scripts/buildStarterWorlds.mjs`, which uses `scripts/starterIceBeacon.mjs`.
- **Scene:** `scene-ice-beacon`, named **"Ice Beacon — Elevation Test"**. Open it from the scene rail.
- **Decisions:** D-452 (height labels measured from the viewer), D-453 (raised areas) and
  D-454 (this scene). See `DECISIONS.md`.

## 1. What the scene must show, and where it shows it

| Requirement | Where in the scene |
|---|---|
| One hero (player character) | **Hosilla**, owned by players, starts inside the entrance of the Ground Hall |
| Opposition placed to show the features | 8 GM-controlled creatures across four floors (table in §3.5) |
| A building at least three storeys high | Ground Hall, Gallery and Crystal Ring, with the Beacon platform on top |
| Every floor joined by stairs | Two spiral stairs Hall↔Gallery, twin spirals Gallery↔Ring, one stair Ring↔Beacon |
| At least one hole between floors | The Gallery and the Ring each have a large central opening over the Hall. The Beacon is a disc floating over the Ring's opening |
| Floors of different heights, editable | Hall 20 ft, Gallery 15 ft, Ring 10 ft, Beacon open-topped. Change them in **Scenes → Floors** |
| Raised areas of different heights inside one floor | Hall crate stacks of **5, 10 and 15 ft** (solid), and a **10-ft scaffold** (open) |
| Height labels under tokens | `+10 ft` / `-20 ft` text is drawn under every visible token whose height differs |
| Players: relative to their own token | Measured from the selected token, else the followed token, else the player's first token |
| GM: relative to the ground | Measured from elevation 0 |
| Solid raised areas block sight; open ones do not | A hobgoblin hides behind the 15-ft stack. An orc stands visible behind the open scaffold |

## 2. Readiness at the start of this work

The request said that if the implementation was not ready for this scene, this document should
describe the scene and the work should continue. It was not ready:

| Needed | State before | Done in this change |
|---|---|---|
| Floors, floor heights, stairs, openings, seeing floors below | Ready (G-01…G-33: floor bands, stairwells, traced/drawn floor surfaces, lower floors and tokens seen through openings) | Used as is |
| Raised areas *inside* a floor (crates, scaffold) | **Missing.** A token's height was only ever set by hand or by stairs | **D-453:** a region can be a *raised area* `{height, solid}`. Walking onto one raises the token to its top, and walking off lowers it. Solid ones block sight for eyes below their top, both on the floor (fog + token visibility) and from the floor above (host cross-floor sight). Authored on the map with the **Raised area** tool and edited in the Floor play panel |
| Labels relative to the viewer (players) / ground (GM) | **Different rule.** D-440 drew a badge in the token's top-right corner showing the height above the token's *own floor*, for everyone | **D-452:** the label sits under the token. The GM's label is the height above 0. A player's label is the difference from their own token. Tokens seen on floors below are labelled too |
| A PF1e scene with this content | **Missing** | **D-454:** the Ice Beacon scene, art and actors added to the starter world |

## 3. Scene layout

### 3.1 Art and provenance

- **Floor art:** the "Ice Beacon" sample maps (`sample-maps/andythebrave/`) shipped inside
  `Examples/RipperLevels-7.0.3.zip`, the Levels module 7.0.3 by theripper93. It holds First,
  Second, Third and Fourth Floor (the Second Floor Bridge is not used).
- **Derived files:** `Assets/Maps/IceBeacon/*.webp`, downscaled 50 % from 4300 px to 2150 px with
  ImageMagick. That keeps each floor texture well under the 4096-px limit of some GPUs. The native
  grid of 100 px per 5 ft becomes 50 px. The scene draws each floor at 2150 px on a 100-px grid,
  so one square covers two of the map's own squares.
- **Props:** `crates-5ft/10ft/15ft.png` and `scaffold-10ft.png` were drawn for this scene with
  ImageMagick primitives. They are original.
- **Provenance and licence:** the module's README credits the sample maps as "using assets from
  Forgotten Adventures". **No licence grant was located** for the module or its sample maps
  (`tools/adopt/INVENTORY.md` rows 14 and 15, `LEGAL.md` §3). The floor art is for **internal
  testing only**. Replace it before any public distribution of the starter world.

### 3.2 Floors (scene 2200 × 2200 px, grid 100 px = 5 ft, isolated floor play on)

| Floor | Id | Band (ft) | Height | Art tile | Solid surface | Sees below |
|---|---|---|---|---|---|---|
| Ground Hall | `lvl-ib-hall` | 0 – 20 | 20 ft | First Floor + crate/scaffold props | everywhere (untraced) | – |
| Gallery | `lvl-ib-gallery` | 20 – 35 | 15 ft | Second Floor | ring + north balcony; central opening x 520–1700, y 480–1690 | Hall |
| Crystal Ring | `lvl-ib-ring` | 35 – 45 | 10 ft | Third Floor | ice ring; central opening ≈ x 430–1720, y 450–1740 | Gallery, Hall |
| Beacon | `lvl-ib-beacon` | 45 – ∞ | open sky | Fourth Floor | disc r ≈ 445 px at (1100, 1130) + stair stub | Ring, Gallery, Hall |

Each floor has walls along its outer ice wall. The Hall's entrance is a locked door. Ambient
darkness is 0 (everything lit), fog of war is on, and the backdrop is dark (`#1b2430`).

### 3.3 Stairs (both directions, move at once)

| Stairs | Joins | Area (px) | Arrive up at | Arrive down at |
|---|---|---|---|---|
| West spiral | Hall ↔ Gallery | 400–720 × 480–720 | (300, 600) on the Gallery | (600, 780) in the Hall |
| East spiral | Hall ↔ Gallery | 1480–1800 × 480–720 | (1880, 600) | (1600, 780) |
| Twin spirals | Gallery ↔ Ring | 850–1300 × 1700–1900 | (750, 1850) on the Ring | (700, 1850) on the Gallery |
| Beacon stair | Ring ↔ Beacon | 1000–1200 × 430–700 | (1100, 800) on the Beacon | (1100, 340) on the Ring |

### 3.4 Raised areas (Ground Hall)

| Area | Box (px) | Height | Solid | What to look for |
|---|---|---|---|---|
| Crates (5 ft) | 600–800 × 1400–1600 | 5 ft | yes | step up: Hosilla stands at +5 |
| Crates (10 ft) | 600–800 × 1200–1400 | 10 ft | yes | the middle step |
| Crates (15 ft) | 800–1000 × 1200–1400 | 15 ft | yes | hides the Ambusher from the entrance |
| Scaffold (10 ft, open) | 1300–1600 × 1100–1300 | 10 ft | **no** | the orc behind it stays visible |

### 3.5 Tokens

| Token | Floor | Centre (px) | Elevation | Purpose |
|---|---|---|---|---|
| **Hosilla** (player) | Hall | (1100, 1720) | 0 | the hero; starts at the entrance |
| Hobgoblin Lookout | Hall, on the 15-ft crates | (900, 1300) | 15 | visible over the crates, label `+15 ft` |
| Hobgoblin Ambusher | Hall, behind the 15-ft crates | (820, 1130) | 0 | **hidden** from the entrance by the solid stack |
| Hobgoblin Sentry | Hall, on the 5-ft crates | (700, 1500) | 5 | label `+5 ft` |
| Hobgoblin Archer | Hall, on the scaffold | (1450, 1200) | 10 | label `+10 ft` |
| Feral Orc | Hall, behind the scaffold | (1570, 1020) | 0 | **visible** through the open scaffold |
| Troll (Large) | Gallery, west walk | (350, 1300) | 20 | same height as Hosilla on the Gallery, so no label there |
| Vrock (Large, flying) | Gallery band, over the opening | (1100, 1000) | 30 | `+10 ft` from the Gallery, `-5 ft` from the Ring |
| Axe Beak (Large) | Crystal Ring, west | (500, 1000) | 35 | seen when Hosilla reaches the Ring |
| Oracle of Baphomet | Beacon | (1100, 1130) | 45 | top of the tower |

Hosilla reuses the Jungle demo's actor `hosilla`, so she is the same character in both scenes.
Each opponent has its own actor so hit points are never shared.

## 4. Tester script

Open the starter world as the GM and invite a player from the **Share** panel. On the player's
side, Hosilla is the player's token.

1. **GM, ground-relative labels.** Open the scene. Under each token: Lookout `+15 ft`, Sentry
   `+5 ft`, Archer `+10 ft`. The Ambusher, the Orc and Hosilla have no label (they are at 0).
   Switch floors with the floor picker: the Troll shows `+20 ft`, the Vrock `+30 ft`, the
   Axe Beak `+35 ft` and the Oracle `+45 ft`.
2. **Player, LOS by solid crates.** The player sees the Lookout (`+15 ft`), the Sentry
   (`+5 ft`), the Archer (`+10 ft`) and the Orc behind the open scaffold. The **Ambusher is
   not shown**, and the floor behind the 15-ft stack stays fogged.
3. **Player, climbing.** Move Hosilla onto the 5-ft crates. She rises to 5 ft on her own, and
   the labels now read from her: Lookout `+10 ft`, Sentry no label, Archer `+5 ft`, Orc `-5 ft`.
   Step onto the 10-ft crates, then the 15-ft crates: from up there the **Ambusher appears**
   (`-15 ft`). Step back down to the floor and she returns to 0.
4. **GM, solid vs open.** In **Scenes → Floor play & stairs → Raised areas**, untick *Solid* on
   *Crates (15 ft)*: the player now sees the Ambusher from the entrance. Tick *Solid* on the
   scaffold: the Orc disappears for a player standing at the entrance. Undo restores both.
5. **Player, stairs and openings.** Walk Hosilla into the west spiral. She arrives on the
   Gallery at 20 ft. Through the opening she sees Hall tokens with labels such as Ambusher
   `-20 ft` and Lookout `-5 ft`, and the Vrock `+10 ft`. Walking into the opening is refused
   ("No floor there"). The twin spirals at the south take her to the Crystal Ring (35 ft),
   where the Vrock reads `-5 ft`. The north stair leads up to the Beacon (45 ft).
6. **GM, editable floor heights.** In **Scenes → Floors**, change the Ground Hall's top from 20 to
   25 and apply. The floors above move up 5 ft, tokens with them, and the labels update.
7. **GM, authoring.** Pick the **Raised area** tool (⛰) and drag a rectangle on the Hall. It
   becomes a 5-ft solid raised area on the viewed floor, with a dashed outline and label that
   only the GM sees. Edit its height or *Solid* flag, or delete it, in the panel.

## 5. Known limitations

- A floor never sees the floors **above** it, so a Hall player does not see the Vrock or the
  Gallery's tokens. Looking up is a separate feature that is not built yet.
- Raised areas are boxes: solid all the way from their floor to their top. Overhangs, ramps and
  climbing rules (Climb checks, movement cost) are not modelled. Walking onto any raised area
  raises a token to its top, whatever the height difference.
- Solid raised areas do not cast light shadows on their own floor (light is unchanged). They do
  block light and sight in the cross-floor (3D) checks.
- A token that ends its move with its centre over a raised area stands on top of it. The
  footprint of a Large token is not considered.

## 6. Rebuilding

- The scene is generated by `scripts/starterIceBeacon.mjs`. Change coordinates there and run
  `pnpm build:systems && pnpm build:worlds`.
- To regenerate the floor art from the zip, extract `sample-maps/andythebrave/*.webp`, then run
  `convert "<Floor>.webp" -resize 2150x2150 -quality 80 Assets/Maps/IceBeacon/<floor>.webp`.
