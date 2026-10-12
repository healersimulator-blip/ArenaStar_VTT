/**
 * D-454: the "Ice Beacon — Elevation Test" scene of the PF1e starter worlds.
 *
 * A four-floor ice tower for human testers of floors, stairs, openings, raised areas (D-453) and
 * height labels (D-452). `ELEVATION_TEST_SCENE.md` is the design and the tester script; the
 * coordinates below are the ones it documents (scene pixels, 100 px = 5 ft, token x/y = centre,
 * tile and region x/y = top-left).
 *
 * Art: `Assets/Maps/IceBeacon/` — the Levels 7.0.3 sample maps (internal testing only, see
 * LEGAL.md §3) plus original crate/scaffold props. The floor surfaces were traced from the art's
 * alpha (> 50 %) with `traceSurface` (src/core/floorSurface.ts) on a 50-px cell, which grows to
 * 75 px for the Ring; they are stored here as integer pixel rings and normalized on build exactly
 * as the tracer does, so they pass `levelSurfaceError`.
 *
 * Plain JS on purpose (see scripts/buildStarterWorlds.mjs): the builder passes its own document
 * helpers so every row has the same shape as the rest of the starter world.
 */

/** Media of this scene, merged into the starter's demo media (key → repository path). */
export const ICE_BEACON_MEDIA = {
  ibHall: "Assets/Maps/IceBeacon/hall.webp",
  ibGallery: "Assets/Maps/IceBeacon/gallery.webp",
  ibRing: "Assets/Maps/IceBeacon/ring.webp",
  ibBeacon: "Assets/Maps/IceBeacon/beacon.webp",
  ibCrates5: "Assets/Maps/IceBeacon/crates-5ft.png",
  ibCrates10: "Assets/Maps/IceBeacon/crates-10ft.png",
  ibCrates15: "Assets/Maps/IceBeacon/crates-15ft.png",
  ibScaffold: "Assets/Maps/IceBeacon/scaffold-10ft.png",
  feralOrc: "Assets/Tokens/token_FeralOrc.png",
  vrock: "Assets/Tokens/token_Vrok1.png",
  axeBeak: "Assets/Tokens/token_AxeBeak.png",
  oracle: "Assets/Tokens/token_OracleBaphomet.png",
};

export const ICE_BEACON_SCENE_ID = "scene-ice-beacon";
export const ICE_BEACON_JOURNAL_ID = "journal-ice-beacon";

const HALL = "lvl-ib-hall";
const GALLERY = "lvl-ib-gallery";
const RING = "lvl-ib-ring";
const BEACON = "lvl-ib-beacon";

/** Each floor's art: 2150 px square, inset 25 px in the 2200-px scene. */
const ART = { x: 25, y: 25, size: 2150 };

/**
 * Traced floor surfaces: box [x, y, width, height] of the tracer's padded grid, then the solid
 * area's outer ring and its holes (openings) as flat [x0, y0, x1, y1, …] scene pixels.
 */
const SURFACES = {
  [GALLERY]: {
    box: [-50, -50, 2300, 2300],
    outer: [150, 0, 250, 0, 250, 50, 300, 50, 300, 0, 2000, 0, 2000, 50, 2100, 50, 2100, 150, 2150, 150, 2150, 2050, 2100, 2050,
      2100, 2100, 2050, 2100, 2050, 2150, 200, 2150, 200, 2100, 100, 2100, 100, 2050, 50, 2050, 50, 2000, 100, 2000, 100, 1950,
      50, 1950, 50, 1750, 0, 1750, 0, 1650, 50, 1650, 50, 1600, 0, 1600, 0, 1550, 50, 1550, 50, 1450, 0, 1450, 0, 1400, 50, 1400,
      50, 1150, 0, 1150, 0, 1100, 50, 1100, 50, 1000, 0, 1000, 0, 900, 50, 900, 50, 800, 0, 800, 0, 700, 50, 700, 50, 650, 0, 650,
      0, 550, 50, 550, 50, 500, 0, 500, 0, 450, 50, 450, 50, 150, 100, 150, 100, 100, 150, 100],
    holes: [
      // the great opening over the Hall, around the balcony and the two bridge stubs
      [550, 500, 550, 650, 650, 650, 650, 700, 600, 700, 600, 750, 550, 750, 550, 1700, 1700, 1700, 1700, 750, 1600, 750, 1600, 650,
        1700, 650, 1700, 500, 1550, 500, 1550, 550, 1500, 550, 1500, 800, 1150, 800, 1150, 750, 1100, 750, 1100, 800, 750, 800,
        750, 550, 700, 550, 700, 500],
      // the gaps either side of the bridge to the balcony
      [1250, 300, 1250, 500, 1450, 500, 1450, 450, 1500, 450, 1500, 300],
      [800, 300, 750, 300, 750, 450, 800, 450, 800, 500, 1000, 500, 1000, 300, 850, 300, 850, 350, 800, 350],
    ],
  },
  [RING]: {
    box: [-75, -75, 2400, 2400],
    outer: [900, 0, 1050, 0, 1050, 75, 2025, 75, 2025, 0, 2100, 0, 2100, 75, 2175, 75, 2175, 2175, 75, 2175, 75, 1050, 0, 1050,
      0, 975, 75, 975, 75, 75, 375, 75, 375, 150, 450, 150, 450, 75, 900, 75],
    holes: [
      // the ring's central opening (the Beacon floats over it)
      [525, 450, 525, 525, 450, 525, 450, 900, 600, 900, 600, 975, 675, 975, 675, 1050, 825, 1050, 825, 1125, 750, 1125, 750, 1350,
        825, 1350, 825, 1425, 900, 1425, 900, 1500, 525, 1500, 525, 1425, 450, 1425, 450, 1725, 525, 1725, 525, 1650, 600, 1650,
        600, 1800, 675, 1800, 675, 1725, 825, 1725, 825, 1800, 975, 1800, 975, 1725, 1350, 1725, 1350, 1800, 1425, 1800, 1425, 1725,
        1575, 1725, 1575, 1800, 1725, 1800, 1725, 1725, 1650, 1725, 1650, 1650, 1725, 1650, 1725, 1500, 1650, 1500, 1650, 1575,
        1575, 1575, 1575, 1500, 1425, 1500, 1425, 1350, 1500, 1350, 1500, 1275, 1425, 1275, 1425, 1200, 1500, 1200, 1500, 1050,
        1425, 1050, 1425, 975, 1350, 975, 1350, 900, 1500, 900, 1500, 975, 1725, 975, 1725, 600, 1575, 600, 1575, 525, 1650, 525,
        1650, 450, 1200, 450, 1200, 600, 1050, 600, 1050, 450, 900, 450, 900, 525, 825, 525, 825, 450],
      // the gap between the twin spirals' landings
      [975, 1875, 975, 1950, 1125, 1950, 1125, 1875],
    ],
  },
  [BEACON]: {
    box: [-50, -50, 2300, 2300],
    // the disc, its ice spikes and the stair stub on its north side
    outer: [1000, 600, 1250, 600, 1250, 750, 1550, 750, 1550, 800, 1650, 800, 1650, 850, 1700, 850, 1700, 950, 1600, 950, 1600, 1000,
      1550, 1000, 1550, 1050, 1700, 1050, 1700, 1100, 1650, 1100, 1650, 1150, 1750, 1150, 1750, 1200, 1600, 1200, 1600, 1300,
      1650, 1300, 1650, 1350, 1500, 1350, 1500, 1550, 1550, 1550, 1550, 1600, 1500, 1600, 1500, 1650, 1350, 1650, 1350, 1600,
      1250, 1600, 1250, 1550, 1200, 1550, 1200, 1600, 1100, 1600, 1100, 1650, 1050, 1650, 1050, 1600, 1000, 1600, 1000, 1550,
      900, 1550, 900, 1500, 850, 1500, 850, 1550, 800, 1550, 800, 1600, 750, 1600, 750, 1500, 800, 1500, 800, 1450, 750, 1450,
      750, 1400, 700, 1400, 700, 1350, 650, 1350, 650, 1300, 600, 1300, 600, 1250, 650, 1250, 650, 1150, 600, 1150, 600, 1100,
      650, 1100, 650, 1050, 700, 1050, 700, 900, 650, 900, 650, 850, 800, 850, 800, 750, 950, 750, 950, 700, 1000, 700],
    holes: [],
  },
};

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** A stored surface as a LevelSurface (normalized to its box, like `traceSurface`). */
function levelSurface({ box: [x, y, width, height], outer, holes }) {
  const ring = (flat) => {
    const points = [];
    for (let i = 0; i < flat.length; i += 2) points.push({ x: round6((flat[i] - x) / width), y: round6((flat[i + 1] - y) / height) });
    return points;
  };
  return { x, y, width, height, footprint: { version: 2, components: [{ outer: ring(outer), holes: holes.map(ring) }] }, source: "art" };
}

/**
 * Walls along each floor's outer ice wall, as closed loops of [x, y] corners (clockwise from the
 * north-west). The Hall's loop is open at its entrance, which gets a locked door.
 */
const WALL_LOOPS = {
  [HALL]: [[500, 440], [1760, 440], [1860, 540], [1860, 1770], [1760, 1870], [1220, 1870], null, [1020, 1870], [500, 1870],
    [400, 1770], [400, 540]],
  [GALLERY]: [[300, 170], [1900, 170], [2000, 270], [2000, 1900], [1900, 2000], [300, 2000], [200, 1900], [200, 270]],
  [RING]: [[370, 220], [1780, 220], [1925, 365], [1925, 1800], [1780, 1945], [370, 1945], [220, 1800], [220, 365]],
};
const HALL_DOOR = [1220, 1870, 1020, 1870];

/** Stairs: area [x, y, width, height], the two floors, and where a token lands on each. */
const STAIRS = [
  { id: "stairs-ib-west", label: "West spiral", area: [530, 530, 200, 200], levels: [HALL, GALLERY],
    arrive: { [GALLERY]: [450, 650], [HALL]: [650, 850] } },
  { id: "stairs-ib-east", label: "East spiral", area: [1520, 530, 200, 200], levels: [HALL, GALLERY],
    arrive: { [GALLERY]: [1750, 650], [HALL]: [1650, 850] } },
  { id: "stairs-ib-balcony", label: "Balcony stair", area: [1060, 775, 130, 155], levels: [HALL, GALLERY],
    arrive: { [GALLERY]: [1150, 650], [HALL]: [1150, 1000] } },
  { id: "stairs-ib-twin-west", label: "Twin spiral (west)", area: [870, 1810, 130, 135], levels: [GALLERY, RING],
    arrive: { [RING]: [1050, 1750], [GALLERY]: [1050, 1750] } },
  { id: "stairs-ib-twin-east", label: "Twin spiral (east)", area: [1200, 1810, 130, 135], levels: [GALLERY, RING],
    arrive: { [RING]: [1150, 1750], [GALLERY]: [1150, 1750] } },
  { id: "stairs-ib-beacon", label: "Beacon stair", area: [1020, 480, 200, 220], levels: [RING, BEACON],
    arrive: { [BEACON]: [1150, 850], [RING]: [1150, 350] } },
];

/** D-453 raised areas on the Ground Hall: [x, y, width, height], height in feet, solid. */
const RAISED = [
  { id: "raised-ib-crates-5", name: "Crates (5 ft)", area: [600, 1400, 200, 200], height: 5, solid: true, tile: "ibCrates5" },
  { id: "raised-ib-crates-10", name: "Crates (10 ft)", area: [600, 1200, 200, 200], height: 10, solid: true, tile: "ibCrates10" },
  { id: "raised-ib-crates-15", name: "Crates (15 ft)", area: [800, 1200, 200, 200], height: 15, solid: true, tile: "ibCrates15" },
  { id: "raised-ib-scaffold", name: "Scaffold (10 ft, open)", area: [1300, 1100, 300, 200], height: 10, solid: false, tile: "ibScaffold" },
];

const UNIT_SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]];

// ─── PF1e profiles (starter encounter stat lines, same shape as the Jungle demo's) ─────────────

const HOBGOBLIN = {
  size: "Medium", speedFt: 30,
  abilities: { str: 13, dex: 15, con: 12, int: 10, wis: 10, cha: 9 },
  baseAttack: 1, saves: { fort: 3, ref: 2, will: 0 }, savesAsTotal: true,
  hp: 11, hpMax: 11,
  attacks: [{ name: "Longsword", damageDice: "1d8", damageType: "slashing", critThreatMin: 19, critMultiplier: 2 }],
};
const HOBGOBLIN_ARCHER = {
  ...HOBGOBLIN,
  attacks: [{ name: "Longbow", damageDice: "1d8", damageType: "piercing", critThreatMin: 20, critMultiplier: 3, ranged: true, rangeIncrementFt: 100 }],
};
const FERAL_ORC = {
  size: "Medium", speedFt: 30,
  abilities: { str: 17, dex: 11, con: 12, int: 7, wis: 8, cha: 6 },
  baseAttack: 1, saves: { fort: 3, ref: 0, will: -1 }, savesAsTotal: true,
  hp: 6, hpMax: 6,
  attacks: [{ name: "Falchion", damageDice: "2d4", damageType: "slashing", critThreatMin: 18, critMultiplier: 2 }],
  notes: "Orc Warrior 1 (ferocity); starter encounter profile.",
};
const TROLL = {
  size: "Large", speedFt: 30,
  abilities: { str: 23, dex: 14, con: 23, int: 6, wis: 9, cha: 6 },
  baseAttack: 6, saves: { fort: 8, ref: 3, will: 2 }, savesAsTotal: true,
  hp: 63, hpMax: 63,
  attacks: [{ name: "Claw", damageDice: "1d6", damageType: "slashing", critThreatMin: 20, critMultiplier: 2, natural: true }],
  notes: "Troll, Large (2×2 squares); starter encounter profile.",
};
const VROCK = {
  size: "Large", speedFt: 30, flySpeedFt: 50,
  abilities: { str: 21, dex: 15, con: 25, int: 14, wis: 16, cha: 16 },
  baseAttack: 10, saves: { fort: 16, ref: 9, will: 11 }, savesAsTotal: true,
  hp: 112, hpMax: 112,
  attacks: [{ name: "Claw", damageDice: "2d6", damageType: "slashing", critThreatMin: 20, critMultiplier: 2, natural: true }],
  notes: "Vrock (demon), Large (2×2 squares), fly 50 ft. (average). Starts airborne at 30 ft over the Gallery's opening.",
};
const AXE_BEAK = {
  size: "Large", speedFt: 50,
  abilities: { str: 19, dex: 14, con: 17, int: 2, wis: 12, cha: 7 },
  baseAttack: 2, saves: { fort: 6, ref: 5, will: 2 }, savesAsTotal: true,
  hp: 22, hpMax: 22,
  attacks: [{ name: "Bite", damageDice: "1d8", damageType: "piercing", critThreatMin: 20, critMultiplier: 2, natural: true }],
  notes: "Axe beak, Large (2×2 squares); starter encounter profile.",
};
const ORACLE = {
  size: "Medium", speedFt: 30,
  abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 10, cha: 18 },
  baseAttack: 3, saves: { fort: 2, ref: 2, will: 4 }, savesAsTotal: true,
  hp: 33, hpMax: 33,
  attacks: [{ name: "Heavy mace", damageDice: "1d8", damageType: "bludgeoning", critThreatMin: 20, critMultiplier: 2 }],
  notes: "Oracle 5, cultist of Baphomet; the master of the Ice Beacon.",
};

const TESTER_SCRIPT = `# Ice Beacon — Elevation Test

A four-floor ice tower for testing floors, stairs, openings, raised areas and height labels.
The full design is ELEVATION_TEST_SCENE.md in the repository.

## Floors (Scenes → Floors)
| Floor | Band | Height |
|---|---|---|
| Ground Hall | 0–20 ft | 20 ft |
| Gallery | 20–35 ft | 15 ft |
| Crystal Ring | 35–45 ft | 10 ft |
| Beacon | 45 ft – open sky | – |

The Gallery and the Ring have large openings: you see the floors below through them.

## Raised areas on the Ground Hall
- **Crates 5 ft, 10 ft, 15 ft** — solid: they hide what is behind them from eyes below their top.
- **Scaffold 10 ft** — open: you see through it.
Walking onto one raises a token to its top; walking off lowers it again.

## Height labels
Text under a token shows its height difference: **+10 ft** above, **-20 ft** below.
- GM: measured from the ground (0 ft).
- Player: measured from your own (selected) token.

## Try this
1. **GM:** labels read Lookout +15 ft, Sentry +5 ft, Archer +10 ft. Switch floors: Troll +20 ft,
   Vrock +30 ft, Axe Beak +35 ft, Oracle +45 ft.
2. **Player (Hosilla, at the entrance):** you see the Lookout, the Sentry, the Archer and the orc
   behind the open scaffold — but **not the Ambusher** hiding behind the crates.
3. **Climb:** step onto the 5-ft crates (Hosilla rises to 5 ft, labels re-read from her), then the
   10-ft crates — the **Ambusher appears** (-10 ft) — then the 15-ft crates. Step down to 0.
4. **GM:** in Scenes → Floor play & stairs → Raised areas, untick Solid on Crates (15 ft) (the
   Ambusher shows from the entrance), or tick it on the scaffold (the orc disappears). Undo.
5. **Stairs:** the west/east spirals and the balcony stair lead to the Gallery (20 ft). Look down
   through the opening: Hall tokens read -20 ft, -10 ft…; the flying Vrock reads +10 ft. The twin
   spirals (south) lead to the Crystal Ring (35 ft), where the Vrock reads -5 ft. The north stair
   climbs to the Beacon (45 ft).
6. **GM:** change the Ground Hall's top from 20 to 25 ft in Scenes → Floors: the floors above move
   up and the labels follow.

Art: Levels 7.0.3 sample maps ("Ice Beacon"), internal testing only.
`;

/**
 * The scene, its actors and its guide, in deterministic order. `media` maps the keys of
 * `ICE_BEACON_MEDIA` (and the starter's `hosilla`/`hobgoblin`/`troll`) to asset hashes; `h` are
 * the builder's `baseDoc`, `sceneDoc2` and `tokenDoc` helpers.
 */
export function iceBeaconDocuments(media, h) {
  const { baseDoc, sceneDoc2, tokenDoc } = h;
  const playerOwnership = { default: 3, gm: 3 };
  const npcOwnership = { default: 2, gm: 3 };
  const gmTokenOwnership = { default: 0, gm: 3 };
  const medium = 100;

  // ── floors and their art ──────────────────────────────────────────────────────────────────
  const floorTile = (id, name, img) => baseDoc(id, "tile", name, {
    ownership: { default: 0 }, x: ART.x, y: ART.y, width: ART.size, height: ART.size, img, rotation: 0, sort: -1000,
    above: false, occlusion: { mode: "fade", alpha: 1 },
  });
  const propTiles = RAISED.map((r) => baseDoc(`tile-${r.id.slice("raised-".length)}`, "tile", r.name, {
    ownership: { default: 0 }, x: r.area[0], y: r.area[1], width: r.area[2], height: r.area[3], img: media[r.tile], rotation: 0,
    sort: 0, above: false, occlusion: { mode: "fade", alpha: 1 },
  }));
  const tiles = [
    floorTile("tile-ib-hall", "Ground Hall — map", media.ibHall), ...propTiles,
    floorTile("tile-ib-gallery", "Gallery — map", media.ibGallery),
    floorTile("tile-ib-ring", "Crystal Ring — map", media.ibRing),
    floorTile("tile-ib-beacon", "Beacon — map", media.ibBeacon),
  ];
  const level = (id, name, bottom, top, sort, extra) => ({
    _id: id, type: "level", name, ownership: { default: 0 }, flags: {}, system: {}, bottom, top, floorZ: bottom, sort, ...extra,
  });
  const levels = [
    level(HALL, "Ground Hall", 0, 20, 0, { visibleLevelIds: [], tileIds: ["tile-ib-hall", ...propTiles.map((t) => t._id)] }),
    level(GALLERY, "Gallery", 20, 35, 1, { visibleLevelIds: [HALL], tileIds: ["tile-ib-gallery"], surface: levelSurface(SURFACES[GALLERY]) }),
    level(RING, "Crystal Ring", 35, 45, 2, { visibleLevelIds: [GALLERY, HALL], tileIds: ["tile-ib-ring"], surface: levelSurface(SURFACES[RING]) }),
    level(BEACON, "Beacon", 45, null, 3, { visibleLevelIds: [RING, GALLERY, HALL], tileIds: ["tile-ib-beacon"], surface: levelSurface(SURFACES[BEACON]) }),
  ];

  // ── walls (scoped to their floor: unscoped walls do nothing in floor play) ─────────────────
  const walls = [];
  const wall = (id, c, levelId, door = 0) => walls.push(baseDoc(id, "wall", "", {
    ownership: { default: 0 }, levelScope: { mode: "levels", ids: [levelId] }, c, door, oneWay: false,
    ...(door ? { move: 1, sight: 1, sound: 1, light: 1 } : { move: 0, sight: 0, sound: 0, light: 0 }),
  }));
  for (const [levelId, loop] of Object.entries(WALL_LOOPS)) {
    const tag = levelId.slice("lvl-ib-".length);
    let n = 0;
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length];
      if (!a || !b) return; // the gap of a door
      wall(`wall-ib-${tag}-${++n}`, [a[0], a[1], b[0], b[1]], levelId);
    });
  }
  wall("door-ib-hall-entrance", HALL_DOOR, HALL, 2); // locked: the GM opens it

  // ── regions: stairwells (GM-only, players get markers) and raised areas ───────────────────
  const regions = [
    ...STAIRS.map((s) => baseDoc(s.id, "region", `Stairs: ${s.label}`, {
      ownership: { default: 0 }, hidden: true, x: s.area[0], y: s.area[1], width: s.area[2], height: s.area[3], rotation: 0,
      shape: { kind: "polygon", points: UNIT_SQUARE.map(([x, y]) => [x, y]) },
      stairs: { version: 2, levels: [...s.levels], mode: "auto", label: s.label,
        arrivals: s.levels.map((levelId) => ({ levelId, x: s.arrive[levelId][0], y: s.arrive[levelId][1] })) },
    })),
    ...RAISED.map((r) => baseDoc(r.id, "region", r.name, {
      ownership: { default: 0 }, x: r.area[0], y: r.area[1], width: r.area[2], height: r.area[3], rotation: 0,
      shape: { kind: "polygon", points: UNIT_SQUARE.map(([x, y]) => [x, y]) },
      raised: { height: r.height, solid: r.solid }, levelScope: { mode: "levels", ids: [HALL] },
    })),
  ];

  // ── tokens ────────────────────────────────────────────────────────────────────────────────
  const placed = (id, name, x, y, actorId, disposition, levelId, elevation, img, size = 1, ownership = gmTokenOwnership) => ({
    ...tokenDoc(id, name, x, y, actorId, disposition, { img, width: medium * size, height: medium * size, ownership }),
    levelId, elevation,
  });
  const tokens = [
    placed("tok-ib-hosilla", "Hosilla", 1150, 1750, "hosilla", "friendly", HALL, 0, media.hosilla, 1, playerOwnership),
    placed("tok-ib-lookout", "Hobgoblin Lookout", 950, 1350, "ib-hobgoblin-lookout", "hostile", HALL, 15, media.hobgoblin),
    placed("tok-ib-ambusher", "Hobgoblin Ambusher", 750, 1050, "ib-hobgoblin-ambusher", "hostile", HALL, 0, media.hobgoblin),
    placed("tok-ib-sentry", "Hobgoblin Sentry", 650, 1550, "ib-hobgoblin-sentry", "hostile", HALL, 5, media.hobgoblin),
    placed("tok-ib-archer", "Hobgoblin Archer", 1450, 1250, "ib-hobgoblin-archer", "hostile", HALL, 10, media.hobgoblin),
    placed("tok-ib-orc", "Feral Orc", 1650, 1050, "ib-feral-orc", "hostile", HALL, 0, media.feralOrc),
    placed("tok-ib-troll", "Troll", 1300, 650, "ib-troll", "hostile", GALLERY, 20, media.troll, 2),
    placed("tok-ib-vrock", "Vrock", 1100, 1000, "ib-vrock", "hostile", GALLERY, 30, media.vrock, 2),
    placed("tok-ib-axe-beak", "Axe Beak", 600, 1200, "ib-axe-beak", "hostile", RING, 35, media.axeBeak, 2),
    placed("tok-ib-oracle", "Oracle of Baphomet", 1150, 1150, "ib-oracle", "hostile", BEACON, 45, media.oracle),
  ];

  const note = baseDoc("note-ice-beacon", "note", "Elevation test — start here", {
    x: 1350, y: 1750, icon: "⛰", visible: true, journalId: ICE_BEACON_JOURNAL_ID, levelScope: { mode: "levels", ids: [HALL] },
    text: "Ice Beacon — Elevation Test. Four floors (Hall 0–20 ft, Gallery 20–35, Crystal Ring 35–45, Beacon 45+), stairs, "
      + "openings, crate stacks of 5/10/15 ft (solid) and a 10-ft scaffold (open). Labels under tokens show height differences: "
      + "from the ground for the GM, from your own token for players. The full script is in the Journal: \"Ice Beacon — Elevation Test\".",
    playerText: "Hosilla is yours. Climb the crates, take the stairs, look down through the openings: the text under each token "
      + "shows how far above (+) or below (-) you it is.",
  });

  const scene = sceneDoc2(ICE_BEACON_SCENE_ID, "Ice Beacon — Elevation Test", 2200, 2200, { core: { fog: true } }, tokens, [note], false);
  Object.assign(scene, {
    background: { color: "#1b2430" },
    levelMode: "isolated",
    levels,
    tiles,
    walls,
    regions,
  });

  const enemy = (id, name, pf1e) => baseDoc(id, "actor", name, { ownership: npcOwnership, system: { pf1e }, items: [], effects: [] });
  const hob = (role, profile = HOBGOBLIN) => ({ ...profile, notes: `Hobgoblin Fighter 1, ${role}; starter encounter profile.` });
  return [
    scene,
    enemy("ib-hobgoblin-lookout", "Hobgoblin Lookout", hob("on the 15-ft crates")),
    enemy("ib-hobgoblin-ambusher", "Hobgoblin Ambusher", hob("hiding behind the crates")),
    enemy("ib-hobgoblin-sentry", "Hobgoblin Sentry", hob("on the 5-ft crates")),
    enemy("ib-hobgoblin-archer", "Hobgoblin Archer", hob("on the scaffold", HOBGOBLIN_ARCHER)),
    enemy("ib-feral-orc", "Feral Orc", FERAL_ORC),
    enemy("ib-troll", "Troll (Ice Beacon)", TROLL),
    enemy("ib-vrock", "Vrock", VROCK),
    enemy("ib-axe-beak", "Axe Beak", AXE_BEAK),
    enemy("ib-oracle", "Oracle of Baphomet", ORACLE),
    baseDoc(ICE_BEACON_JOURNAL_ID, "journal", "Ice Beacon — Elevation Test", {
      pages: [{ name: "Elevation test — what to try", text: TESTER_SCRIPT, src: null }],
    }),
  ];
}
