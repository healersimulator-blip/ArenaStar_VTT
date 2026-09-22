/**
 * A fixture world for the connector's tool tests — small enough to hold in your head, complete
 * enough to exercise every rule: two scenes, three tokens (one hidden), two walls, three messages
 * (one with a GM-only roll), one sheet, one bestiary hit and one package.
 *
 * It is deliberately **not** a mock of the app: it is the `AgentWorldView` interface implemented over
 * plain arrays, so a test that passes against it proves the tool's own logic (paging, redaction,
 * formatting) and nothing about any particular replica.
 */
import { paginate } from "../../src/core/agents/paging";
import type {
  AgentClock,
  AgentCombatTurn,
  AgentCompendiumEntry,
  AgentDiceApply,
  AgentDiceRoll,
  AgentHexCell,
  AgentHexMapPlan,
  AgentHexSummary,
  AgentDocument,
  AgentDocumentRow,
  AgentMessageRow,
  AgentPackageRow,
  AgentSceneDetail,
  AgentSceneSummary,
  AgentSheet,
  AgentTimeOps,
  AgentTokenRow,
  AgentWorldView,
  PageOptions,
} from "../../src/core/agents/types";
import type { BaseDocument, Json } from "../../src/core/documents";
import { terrainLetters, type HexGlyph } from "../../src/core/agents/hexRender";

const SCENE_ONE: AgentSceneSummary = {
  id: "s1",
  name: "Goblinwood",
  active: true,
  width: 1200,
  height: 900,
  grid: {
    type: "square",
    size: 100,
    distance: 5,
    units: "ft",
    hexLayout: "oddQ",
  },
  darkness: 0,
  tokens: 3,
  walls: 2,
  fog: { enabled: true, mode: "none" },
};

const SCENE_TWO: AgentSceneSummary = {
  ...SCENE_ONE,
  id: "s2",
  name: "The Barrow",
  active: false,
  tokens: 0,
  walls: 0,
};

/** The clock the fixture's world starts at: day 1, 02:00 by the clock's own readout. */
export const CLOCK_SECONDS = 93_600;

const CLOCK_OPS = [
  {
    kind: "update" as const,
    ref: { coll: "settings" as const, id: "core" },
    diff: { clockSeconds: CLOCK_SECONDS + 6 },
  },
];

/** An encounter in progress: round 1, and Vex's turn. */
export const COMBAT: AgentCombatTurn = {
  id: "cb-1",
  name: "Goblinwood ambush",
  round: 1,
  turn: 0,
  started: true,
  phase: null,
  current: {
    id: "c-vex",
    name: "Vex",
    initiative: 18,
    defeated: false,
    hidden: false,
    tokenId: "t-vex",
    actorId: "a-vex",
    isCurrent: true,
  },
  order: [
    {
      id: "c-vex",
      name: "Vex",
      initiative: 18,
      defeated: false,
      hidden: false,
      tokenId: "t-vex",
      actorId: "a-vex",
      isCurrent: true,
    },
    {
      id: "c-goblin",
      name: "Goblin",
      initiative: 12,
      defeated: false,
      hidden: false,
      tokenId: "t-goblin",
      actorId: "a-goblin",
      isCurrent: false,
    },
  ],
  clockDeltaSeconds: 0,
  ops: [],
  note: null,
  dyingChecks: [],
};

const COMBAT_UPDATE = [
  {
    kind: "update" as const,
    ref: { coll: "combats" as const, id: "cb-1" },
    diff: { round: 1, turn: 1 },
  },
];

/** `combat.start` on the fixture: round 1 and the first combatant's turn. */
const STARTED: AgentCombatTurn = { ...COMBAT, note: "round 1", ops: COMBAT_UPDATE };

/** Two turns: the round wrapped, and the world clock moved a round's worth. */
const ROUND_TWO: AgentCombatTurn = {
  ...COMBAT,
  round: 2,
  note: "round 2",
  current: { ...(COMBAT.order[1] as NonNullable<AgentCombatTurn["current"]>), isCurrent: true },
  order: COMBAT.order.map((row) => ({ ...row, isCurrent: row.id === "c-goblin" })),
};

/** `combat.end`: the round structure is cleared and nobody's turn it is. */
const ENDED: AgentCombatTurn = {
  ...COMBAT,
  round: 0,
  turn: 0,
  started: false,
  current: null,
  order: COMBAT.order.map((row) => ({ ...row, isCurrent: false })),
  note: "combat ended",
};

export const TOKENS: AgentTokenRow[] = [
  {
    id: "t-vex",
    name: "Vex",
    x: 350,
    y: 150,
    col: 3,
    row: 1,
    disposition: "friendly",
    hidden: false,
    actorId: "a-vex",
    // Vex is the agent's own token: `token.move` moves it for any grant.
    owned: true,
  },
  {
    id: "t-gob",
    name: "Goblin",
    x: 750,
    y: 450,
    col: 7,
    row: 4,
    disposition: "hostile",
    hidden: false,
    actorId: null,
    owned: false,
  },
  // A hidden token is the whole redaction question in one row: the replica has it, the grant may not.
  {
    id: "t-amb",
    name: "Ambush",
    x: 950,
    y: 850,
    col: 9,
    row: 8,
    disposition: "hostile",
    hidden: true,
    actorId: null,
    owned: false,
  },
];

export const MESSAGES: AgentMessageRow[] = [
  {
    id: "m1",
    author: "u-gm",
    authorName: "GM",
    content: "You enter the woods.",
    whisper: [],
    hasRoll: false,
    rollMode: null,
    resultWithheld: false,
  },
  {
    id: "m2",
    author: "u-vex",
    authorName: "Vex",
    content: "I check for tracks.",
    whisper: [],
    hasRoll: true,
    rollMode: "gmroll",
    resultWithheld: false, // the roll is in the replica: this grant may read it
  },
  {
    id: "m3",
    author: "u-gm",
    authorName: "GM",
    content: "Something moves.",
    whisper: ["u-vex"],
    hasRoll: false,
    rollMode: null,
    resultWithheld: false,
  },
];

export const SHEET: AgentSheet = {
  actorId: "a-vex",
  name: "Vex",
  hp: { current: 18, max: 24, nonlethal: 2 },
  ac: { normal: 17, touch: 13, flatFooted: 14 },
  saves: { fort: 4, ref: 7, will: 2 },
  initiative: 3,
  baseAttack: 2,
  cmb: 3,
  cmd: 16,
  speedFt: 30,
  conditions: ["flat-footed"],
  attacks: [{ name: "Longsword", bonus: 5, damage: "1d8+3", ranged: false }],
  skills: [
    { name: "Perception", bonus: 6 },
    { name: "Stealth", bonus: 8 },
  ],
  feats: ["Weapon Focus (longsword)"],
};


/**
 * A hexcrawl small enough to read at a glance: five authored cells, one of them still under cover
 * (which for a player's replica means absent, not flagged — D-271), one carrying a table and a
 * feature that has not been found yet.
 */
export const HEX_CELLS: AgentHexCell[] = [
  {
    key: "0,0",
    col: 0,
    row: 0,
    terrain: "plains",
    terrainName: "Plains / farmland",
    cost: 1,
    open: true,
    description: "The road west, and a milestone nobody has read.",
    playerText: "A road runs west.",
    tables: [],
    features: [],
    exploredSeconds: 0,
  },
  {
    key: "1,0",
    col: 1,
    row: 0,
    terrain: "forest",
    terrainName: "Forest / woods",
    cost: 2,
    open: true,
    description: null,
    playerText: null,
    tables: ["tbl-goblin"],
    features: [
      {
        id: "f-shrine",
        name: "Ruined shrine",
        revealed: false,
        rule: "found after 1 hour",
      },
    ],
    exploredSeconds: 1800,
  },
  {
    key: "2,0",
    col: 2,
    row: 0,
    terrain: "hills",
    terrainName: "Hills / scrub",
    cost: 1.5,
    open: false,
    description: "The ambush the party has not walked into yet.",
    playerText: null,
    tables: [],
    features: [],
    exploredSeconds: 0,
  },
  {
    key: "0,1",
    col: 0,
    row: 1,
    terrain: "plains",
    terrainName: "Plains / farmland",
    cost: 1,
    open: true,
    description: null,
    playerText: null,
    tables: [],
    features: [],
    exploredSeconds: 0,
  },
  {
    key: "1,1",
    col: 1,
    row: 1,
    terrain: "road",
    terrainName: "Highway / road",
    cost: 1,
    open: true,
    description: null,
    playerText: null,
    tables: [],
    features: [],
    exploredSeconds: 0,
  },
];

export const HEX_TERRAINS = [
  { id: "plains", name: "Plains / farmland", cost: 1 },
  { id: "road", name: "Highway / road", cost: 1 },
  { id: "hills", name: "Hills / scrub", cost: 1.5 },
  { id: "forest", name: "Forest / woods", cost: 2 },
];

/** `as const`, so the map's options keep their literal grid type (the renderer wants the real one). */
const HEX_GRID = {
  type: "hex",
  size: 100,
  distance: 6,
  units: "mi",
  hexLayout: "oddQ",
} as const;

export const HEX_SUMMARY: AgentHexSummary = {
  sceneId: "s1",
  sceneName: "Goblinwood",
  grid: HEX_GRID,
  cells: HEX_CELLS.length,
  open: HEX_CELLS.filter((cell) => cell.open).length,
  byTerrain: [
    { id: "plains", name: "Plains / farmland", count: 2, cost: 1 },
    { id: "road", name: "Highway / road", count: 1, cost: 1 },
    { id: "hills", name: "Hills / scrub", count: 1, cost: 1.5 },
    { id: "forest", name: "Forest / woods", count: 1, cost: 2 },
  ],
  party: { key: "1,1", col: 1, row: 1 },
  catalog: "Pathfinder overland",
  travel: { speedPerDay: 24, pace: "normal" },
};

function page<T>(rows: readonly T[], options: PageOptions) {
  return paginate(rows, options);
}

/** The fixture view; override anything a test needs to be different. */
export function fakeView(
  overrides: Partial<AgentWorldView> = {},
): AgentWorldView {
  const view: AgentWorldView = {
    worldInfo: () => ({
      id: "w1",
      name: "World One",
      system: "pf1e-core",
      version: "1.0.0",
      seq: 42,
      collections: { scenes: 2, actors: 1, messages: 3 },
    }),
    snapshot: () => ({
      seq: 42,
      collections: { scenes: 2, actors: 1, messages: 3 },
    }),
    identity: () => ({ id: "u-agent", name: "Vex (agent)", role: "ASSISTANT" }),
    clockSeconds: () => 8 * 3600 + 10 * 60,
    scenes: () => [SCENE_ONE, SCENE_TWO],
    scene: (id) => {
      const summary =
        id === null
          ? SCENE_ONE
          : [SCENE_ONE, SCENE_TWO].find((s) => s.id === id);
      if (!summary) return null;
      const detail: AgentSceneDetail = {
        ...summary,
        tokenRows: summary.id === "s1" ? TOKENS : [],
        walls:
          summary.id === "s1"
            ? [
                { c: [500, 0, 500, 400], door: 0, move: 0, sight: 0 },
                { c: [0, 500, 300, 500], door: 0, move: 0, sight: 0 },
              ]
            : [],
        fogCells: null,
      };
      return detail;
    },
    tokens: (sceneId, options) => {
      if (sceneId !== null && sceneId !== "s1")
        return { rows: [], total: 0, next: null, cap: 0 };
      const paged = page(TOKENS, options);
      return {
        rows: paged.rows,
        total: paged.total,
        next: paged.next,
        cap: paged.cap,
      };
    },
    documents: (coll, options) => {
      const rows: AgentDocumentRow[] =
        coll === "scenes"
          ? [SCENE_ONE, SCENE_TWO].map((s) => ({
              id: s.id,
              name: s.name,
              type: "scene",
              parent: null,
            }))
          : coll === "actors"
            ? [{ id: "a-vex", name: "Vex", type: "actor", parent: null }]
            : coll === "messages"
              ? MESSAGES.map((m) => ({
                  id: m.id,
                  name: m.authorName,
                  type: "message",
                  parent: null,
                }))
              : [];
      const paged = page(rows, options);
      return {
        rows: paged.rows,
        total: paged.total,
        next: paged.next,
        cap: paged.cap,
      };
    },
    document: (coll, id) => {
      if (coll === "scenes" && (id === "s1" || id === "s2")) {
        const found = [SCENE_ONE, SCENE_TWO].find((s) => s.id === id);
        if (!found) return null;
        return {
          id: found.id,
          type: "scene",
          name: found.name,
          fields: {
            width: found.width,
            height: found.height,
          } as unknown as Record<string, Json>,
        } satisfies AgentDocument;
      }
      return null;
    },
    // The fixture numbers messages 1..3 and treats that as the sequence; the real replica filters
    // by its own seq, which is why a row does not carry one.
    messages: (options) => {
      const since = options.since ?? 0;
      const rows = MESSAGES.filter((_, i) => i + 1 > since);
      const paged = page(rows, options);
      return {
        rows: paged.rows,
        total: paged.total,
        next: paged.next,
        cap: paged.cap,
      };
    },
    sheet: (actorId) => (actorId === "a-vex" ? SHEET : null),
    bestiary: async (query: string, limit: number) =>
      query === ""
        ? []
        : [
            { id: "goblin", name: "Goblin", type: "actor", pack: "bestiary" },
          ].slice(0, limit),
    packages: () => [
      { id: "c1", label: "Bestiary", entries: 1284 } satisfies AgentPackageRow,
    ],
    compendiumEntry: async (id: string) =>
      id === "goblin"
        ? ({
            id,
            name: "Goblin",
            pack: "bestiary",
            coll: "actors",
            data: {
              type: "actor",
              name: "Goblin",
              system: { pf1e: { size: "Small", bab: 1, hp: 6, hpMax: 6 } },
              items: [],
              effects: [],
            } as unknown as Json,
          } satisfies AgentCompendiumEntry)
        : id === "fireball"
          ? ({
              id,
              name: "Fireball",
              pack: "spells",
              coll: "items",
              data: { type: "item", name: "Fireball" } as unknown as Json,
            } satisfies AgentCompendiumEntry)
          : null,
    importCharacter: (text: string, options: { id: string }) =>
      text.includes("CR")
        ? {
            name: "Goblin Warrior",
            format: "stat block",
            ops: [
              {
                kind: "create" as const,
                coll: "actors" as const,
                data: {
                  _id: options.id,
                  type: "actor",
                  name: "Goblin Warrior",
                } as unknown as BaseDocument,
              },
            ],
            read: ["hit points: 6/6", "AC: 16"],
            warnings: ["no ability scores in the text — left unauthored"],
          }
        : { error: "that text is not a stat block — a stat block starts with the creature's name and its CR" },
    hexSummary: (sceneId) =>
      sceneId === null || sceneId === "s1" ? HEX_SUMMARY : null,
    hexCells: (sceneId, options) => {
      if (sceneId !== null && sceneId !== "s1")
        return { rows: [], total: 0, next: null, cap: 0 };
      const paged = page(HEX_CELLS, options);
      return {
        rows: paged.rows,
        total: paged.total,
        next: paged.next,
        cap: paged.cap,
      };
    },
    hexCell: (sceneId, key) =>
      sceneId !== null && sceneId !== "s1"
        ? null
        : (HEX_CELLS.find((cell) => cell.key === key) ?? null),
    // Drawn by the real renderer: a fixture that hand-wrote its map could drift from the one the
    // app draws, and the map is the one answer a model reads as picture rather than as records.
    hexMap: (sceneId): AgentHexMapPlan | null => {
      if (sceneId !== null && sceneId !== "s1") return null;
      const letters = terrainLetters(HEX_TERRAINS);
      const glyphs: HexGlyph[] = HEX_CELLS.map((cell) => ({
        key: cell.key,
        col: cell.col,
        row: cell.row,
        letter: cell.terrain === null ? "" : (letters[cell.terrain] ?? ""),
        name: cell.terrainName ?? "",
        open: cell.open,
        party: cell.key === HEX_SUMMARY.party?.key,
      }));
      return {
        options: {
          sceneName: HEX_SUMMARY.sceneName,
          grid: HEX_GRID,
          col0: 0,
          row0: 0,
          cols: 3,
          rows: 2,
          totalCells: HEX_CELLS.length,
          terrains: HEX_TERRAINS.map((terrain) => ({
            ...terrain,
            letter: letters[terrain.id] ?? "?",
            count: 0,
          })),
        },
        glyphs,
      };
    },
    hexTravel: (sceneId) =>
      sceneId === null || sceneId === "s1"
        ? {
            sceneId: "s1",
            path: ["0,0", "1,0", "1,1"],
            cursor: 0,
            progressSeconds: 0,
            speedPerDay: 24,
            pace: "normal",
            remaining: ["0,0", "1,0", "1,1"],
            remainingSeconds: 3 * 3600,
            party: { key: "1,1", tokenId: "t-vex" },
          }
        : null,
    travelPlanOps: (_sceneId, spec) =>
      spec.path.length === 0
        ? []
        : [
            {
              kind: "update" as const,
              ref: { coll: "scenes" as const, id: "s1" },
              diff: { "flags.core.hexcrawl.travel.path": spec.path },
            },
          ],
    travelAdvanceOps: (_sceneId, seconds) => ({
      ops: [
        {
          kind: "update" as const,
          ref: { coll: "scenes" as const, id: "s1" },
          diff: { "flags.core.hexcrawl.travel.cursor": 1 },
        },
      ],
      seconds,
      arrival: "1,0",
      arrived: false,
      steps: [{ cellKey: "1,0", seconds, triggers: ["moving"] }],
      revealed: [],
      spent: { "1,0": seconds },
    }),
    encounterCheckOps: (_sceneId, spec) => ({
      // A firing table writes the ledger, so the fixture writes one too: the cooldown is the point.
      ops: [
        {
          kind: "update" as const,
          ref: { coll: "scenes" as const, id: "s1" },
          diff: { "flags.core.encounters.ledger": "1" },
        },
      ],
      action: "roll" as const,
      reason: null,
      cellKey: spec.cellKey ?? "1,0",
      phase: "day",
      eligible: [{ id: "tbl-goblin", name: "Goblinwood raids" }],
      roll: {
        tableId: "tbl-goblin",
        tableName: "Goblinwood raids",
        formula: "1d20",
        roll: 12,
        die: 20,
        text: "Goblin warband",
        count: 3,
        actorIds: ["a-goblin"],
      },
    }),
    encounterPlaceOps: (_sceneId, spec) =>
      spec.actors.length === 0
        ? { error: "encounter.place needs at least one actor with a count" }
        : [
            {
              kind: "create" as const,
              coll: "tokens" as const,
              parent: { coll: "scenes" as const, id: "s1" },
              data: {
                _id: "t-enc",
                type: "token",
                name: "Goblin",
                actorId: spec.actors[0]?.actorId ?? null,
              } as unknown as BaseDocument,
            },
          ],
    clock: (): AgentClock => ({
      seconds: CLOCK_SECONDS,
      stamp: "1d 02:00:00",
      hour: 2,
      minute: 0,
      phase: "night",
      day: 1,
      label: "02:00",
      secondsPerRound: 6,
      advanceOnRound: true,
    }),
    timeOps: (spec): AgentTimeOps | { error: string } => {
      const delta =
        typeof spec.delta === "number" && Number.isFinite(spec.delta)
          ? Math.trunc(spec.delta)
          : null;
      const absolute =
        typeof spec.seconds === "number" && Number.isFinite(spec.seconds)
          ? Math.trunc(spec.seconds)
          : null;
      if (delta === null && absolute === null) {
        return { error: "say `seconds` to set the clock, or `days`/`hours`/`rounds` to move it" };
      }
      // Three days is the plan's Phase 4 test: the sweep is what it is really asking about.
      const next = absolute === null ? CLOCK_SECONDS + (delta as number) : absolute;
      const moved = next - CLOCK_SECONDS;
      return {
        seconds: next,
        delta: moved,
        ops: [
          {
            kind: "update" as const,
            ref: { coll: "settings" as const, id: "core" },
            diff: { clockSeconds: next },
          },
        ],
        // A forward jump of three days ends the mage's hour-long shield; a backward one ends
        // nothing. The fixture knows this because the world clock's rule says so.
        expired: moved > 0 ? [{ home: "actors", ownerId: "a-vex", effectId: "fx-shield" }] : [],
      };
    },
    combatState: (sceneId) => (sceneId === null || sceneId === "s1" ? COMBAT : null),
    combatStartOps: (_sceneId, spec) => {
      if (spec.initiative === undefined || Object.keys(spec.initiative).length === 0) {
        return { error: "a PF1e encounter needs an initiative for every combatant" };
      }
      return { ...STARTED, ops: COMBAT_UPDATE };
    },
    combatAddOps: (_sceneId, spec) =>
      spec.combatants.length === 0
        ? { error: "combat.add needs at least one combatant" }
        : {
            ...COMBAT,
            order: [
              ...COMBAT.order,
              ...spec.combatants.map((entry, index) => ({
                id: `c-new-${index}`,
                name: entry.name ?? "Goblin",
                initiative: entry.initiative ?? null,
                defeated: false,
                hidden: false,
                tokenId: entry.tokenId ?? null,
                actorId: entry.actorId ?? null,
                isCurrent: false,
              })),
            ],
            note: `${spec.combatants.length} combatant(s) added`,
            ops: COMBAT_UPDATE,
          },
    combatNextOps: (_sceneId, count) => {
      const steps = Math.min(Math.max(Math.trunc(count) || 1, 1), 20);
      return {
        ...(steps > 1 ? ROUND_TWO : STARTED),
        // One turn is not a round wrap; two are, and a round costs six seconds.
        clockDeltaSeconds: steps > 1 ? 6 : 0,
        ops: steps > 1 ? [...COMBAT_UPDATE, ...CLOCK_OPS] : COMBAT_UPDATE,
      };
    },
    combatEndOps: () => ({ ...ENDED, ops: COMBAT_UPDATE }),
    async diceRoll(spec): Promise<AgentDiceRoll | { error: string }> {
      // The fixture is not a dice engine, and it does not pretend to be one: it answers with the
      // one thing a fake can honestly claim — that the number came from somewhere else.
      if (spec.formula.trim() === "" || !/^[0-9d+\- */()]+$/i.test(spec.formula)) {
        return { error: `"${spec.formula}" is not a formula this world can roll` };
      }
      return {
        messageId: "m-roll",
        formula: spec.formula,
        total: 17,
        terms: [
          { faces: 20, result: 12 },
          { operator: "+", value: 5 },
        ] as unknown as Json[],
        mode: spec.mode ?? "roll",
        to: spec.to ?? [],
        flavor: spec.flavor ?? null,
      };
    },
    async diceApply(spec): Promise<AgentDiceApply | { error: string }> {
      if (spec.messageId !== "m-roll") {
        return { error: `no message "${spec.messageId}" — chat.read names the cards you may see` };
      }
      if (spec.actorId !== "a-vex") {
        return { error: `no actor "${spec.actorId}" — document.list actors names them` };
      }
      // The card's total is 17, and Vex has 12 hp with 4 temporary: temp absorbs first, so four
      // points vanish into the pool and the rest comes off the hit points.
      return {
        messageId: spec.messageId,
        actorId: spec.actorId,
        actorName: "Vex",
        mode: spec.mode,
        amount: 17,
        hpBefore: 12,
        hpAfter: spec.mode === "damage" ? 0 : 12,
        note: null,
      };
    },
    tokenCreate: (spec) => ({
      kind: "create" as const,
      coll: "tokens" as const,
      parent: { coll: "scenes", id: spec.sceneId },
      data: {
        _id: "t-new",
        type: "token",
        name: spec.name,
        actorId: spec.actorId ?? null,
      } as unknown as BaseDocument,
    }),
  };
  return { ...view, ...overrides };
}
