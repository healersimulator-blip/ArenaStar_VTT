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
  AgentDocument,
  AgentDocumentRow,
  AgentMessageRow,
  AgentPackageRow,
  AgentSceneDetail,
  AgentSceneSummary,
  AgentSheet,
  AgentTokenRow,
  AgentWorldView,
  PageOptions,
} from "../../src/core/agents/types";
import type { Json } from "../../src/core/documents";

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
  },
  {
    id: "m2",
    author: "u-vex",
    authorName: "Vex",
    content: "I check for tracks.",
    whisper: [],
    hasRoll: true,
    rollMode: "gmroll",
  },
  {
    id: "m3",
    author: "u-gm",
    authorName: "GM",
    content: "Something moves.",
    whisper: ["u-vex"],
    hasRoll: false,
    rollMode: null,
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
  };
  return { ...view, ...overrides };
}
