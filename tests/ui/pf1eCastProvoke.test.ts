/**
 * P06/D-191 — the cast provoke: which triggers a declared cast earns (Table 7-2's
 * `cast-spell`, AoN 133's ranged touch), and the sheet-scoped glue that resolves or reports
 * them through the action seam. Fixtures follow `pf1eAooFlow.test.ts`: a `grid.size` of
 * 100 world units, a token's `x`/`y` its centre, and a Medium token at `(col + 0.5) * 100`.
 */
import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CombatDocument,
  Json,
  MessageDocument,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import {
  castProvokes,
  provokeDamageTaken,
  resolveCastProvokes,
  type CastProvokeClient,
} from "../../src/ui/combat/pf1eCastProvoke";
import type { OpportunityResolution } from "../../src/ui/combat/pf1eAooFlow";

const gm = { id: "gm", role: "GM" as const };

describe("castProvokes — which triggers a declared cast earns", () => {
  test("a standard cast provokes, and so does a full-round or longer one", () => {
    expect(castProvokes({ castingTime: "standard" })).toEqual([
      { actionId: "cast-spell" },
    ]);
    expect(castProvokes({ castingTime: "full-round" })).toEqual([
      { actionId: "cast-spell" },
    ]);
    expect(castProvokes({ castingTime: "longer" })).toEqual([
      { actionId: "cast-spell" },
    ]);
  });

  test("a swift or free cast, and a quickened spell, provoke nothing (AoN 158)", () => {
    expect(castProvokes({ castingTime: "swift" })).toEqual([]);
    expect(castProvokes({ castingTime: "free" })).toEqual([]);
    expect(castProvokes({ castingTime: "standard", quickened: true })).toEqual([]);
  });

  test("a defensively cast spell provokes nothing from the casting", () => {
    expect(castProvokes({ castingTime: "standard", defensively: true })).toEqual(
      [],
    );
  });

  test("a ranged touch provokes even from a defensively cast spell (AoN 133)", () => {
    expect(castProvokes({ castingTime: "standard", touch: "ranged" })).toEqual([
      { actionId: "cast-spell" },
      { trigger: { kind: "ranged-touch" } },
    ]);
    // The cast is replaced by the concentration gate, but the touch still provokes.
    expect(
      castProvokes({
        castingTime: "standard",
        defensively: true,
        touch: "ranged",
      }),
    ).toEqual([{ trigger: { kind: "ranged-touch" } }]);
  });

  test("a melee touch adds no touch trigger of its own — the cast is the provoke", () => {
    expect(castProvokes({ castingTime: "standard", touch: "melee" })).toEqual([
      { actionId: "cast-spell" },
    ]);
  });
});

describe("provokeDamageTaken — the damage the cast gate feeds the concentration DC", () => {
  const entry = (provokerId: string, damage: number) => ({
    reactorId: "fighter",
    provokerId,
    square: null,
    combatantId: "c-fighter",
    attackName: "Longsword — attack of opportunity",
    outcome: "hit" as const,
    attackTotal: 20,
    defenseAc: 16,
    damage,
    ledgerError: null,
    hpWriteError: null,
    used: 1,
    max: 1,
    hpBefore: 12,
    hpAfter: 12 - damage,
    line: "",
  });

  test("sums only the damage dealt to the caster", () => {
    const resolution: OpportunityResolution = {
      entries: [entry("wizard", 4), entry("wizard", 3), entry("other", 9)],
      skipped: [],
      needsEncounter: false,
      error: null,
    };
    expect(provokeDamageTaken(resolution, "wizard")).toBe(7);
    expect(provokeDamageTaken(resolution, "other")).toBe(9);
  });

  test("an empty resolution is zero damage", () => {
    const resolution: OpportunityResolution = {
      entries: [],
      skipped: [],
      needsEncounter: false,
      error: null,
    };
    expect(provokeDamageTaken(resolution, "wizard")).toBe(0);
  });
});

/** A reactor: an authored longsword, plain stats. */
function fighter(pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: "a-fighter",
    type: "actor",
    name: "Fighter",
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: {
      pf1e: {
        abilities: { str: 16, dex: 14, con: 14 },
        baseAttack: 6,
        hp: 30,
        hpMax: 30,
        armorClass: { armor: 5 },
        attacks: [
          {
            name: "Longsword",
            damageDice: "1d8",
            damageBonus: 3,
            damageType: "slashing",
            critThreatMin: 20,
            critMultiplier: 2,
          },
        ],
        ...pf1e,
      },
    },
  };
}

/** The caster: AC 16 (10 + armor 4 + Dex 2), 12 HP. */
function wizard(): ActorDocument {
  return {
    _id: "a-wizard",
    type: "actor",
    name: "Wizard",
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: {
      pf1e: {
        abilities: { dex: 14, con: 12 },
        hp: 12,
        hpMax: 12,
        armorClass: { armor: 4 },
      },
    },
  };
}

function token(
  id: string,
  actorId: string,
  col: number,
  row: number,
  disposition: TokenDocument["disposition"] = "hostile",
): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: id,
    x: (col + 0.5) * 100,
    y: (row + 0.5) * 100,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    actorId,
    hidden: false,
    disposition,
    vision: true,
    light: { radius: 0, color: "#000000", alpha: 0 },
    ownership: { default: 3 },
    flags: {},
    system: {},
  };
}

function scene(tokens: TokenDocument[]): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Scene",
    active: true,
    img: null,
    width: 2000,
    height: 1500,
    grid: {
      type: "square",
      size: 100,
      distance: 5,
      units: "ft",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    darkness: 0,
    tokens,
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    ownership: { default: 3 },
    flags: {},
    system: {},
  };
}

function combatant(
  id: string,
  tokenId: string,
  actorId: string,
  initiative: number,
  pf1e: Record<string, Json>,
): Record<string, unknown> {
  return {
    _id: id,
    type: "combatant",
    name: id,
    tokenId,
    actorId,
    initiative,
    hidden: false,
    defeated: false,
    ownership: { default: 3 },
    flags: { pf1e },
    system: {},
  };
}

/** A running encounter: both combatants have acted, so nobody is flat-footed. */
function combat(fighterAoo: { used: number; max: number }): CombatDocument {
  return {
    _id: "combat-1",
    type: "combat",
    name: "Fight",
    round: 1,
    turn: 0,
    ownership: { default: 3 },
    flags: {
      pf1e: {
        phase: "rounds",
        secondsPerRound: 6,
        surpriseOrder: [],
        surpriseTurn: 0,
        surprised: [],
        ties: [],
        clockSeconds: 0,
        roundRolled: false,
      },
    },
    system: {},
    combatants: [
      combatant("c-fighter", "fighter", "a-fighter", 20, {
        acted: true,
        aooUsed: fighterAoo.used,
        aooMax: fighterAoo.max,
      }),
      combatant("c-wizard", "wizard", "a-wizard", 10, { acted: true }),
    ],
  } as unknown as CombatDocument;
}

/** Fake client: scripted roll totals, real message shapes, recorded submits. */
class FakeClient implements CastProvokeClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  script: Array<{ die?: number; total: number }> = [];
  private seq = 0;
  private readonly scene: SceneDocument;
  private readonly actors: readonly ActorDocument[];

  constructor(scene: SceneDocument, actors: readonly ActorDocument[]) {
    this.scene = scene;
    this.actors = actors;
  }

  readonly store = {
    getAll: (coll: "messages" | "scenes" | "actors"): readonly unknown[] => {
      if (coll === "messages") return this.messages;
      if (coll === "scenes") return [this.scene];
      if (coll === "actors") return this.actors;
      return [];
    },
  } as CastProvokeClient["store"];

  roll(formula: string): string {
    this.formulas.push(formula);
    const rollId = `r${this.seq++}`;
    const entry = this.script.shift() ?? { total: 0 };
    this.messages.push(this.record(rollId, formula, entry));
    return rollId;
  }

  async rollVerified(formula: string): Promise<string> {
    return this.roll(formula);
  }

  submit(ops: Op[]): string {
    this.submitted.push(ops);
    return "tx";
  }

  private record(
    rollId: string,
    formula: string,
    entry: { die?: number; total: number },
  ): MessageDocument {
    return {
      _id: `m-${rollId}`,
      type: "message",
      name: formula.slice(0, 40),
      ownership: { default: 1 },
      flags: { core: { rollId } },
      system: {},
      author: "gm",
      content: formula,
      whisper: [],
      roll: {
        formula,
        total: entry.total,
        terms:
          entry.die === undefined
            ? [{ kind: "dice", expr: "1d8", rolls: [4], kept: [4], total: 4 }]
            : [
                {
                  kind: "dice",
                  expr: "1d20",
                  rolls: [entry.die],
                  kept: [entry.die],
                  total: entry.die,
                },
              ],
        seedClient: null,
        seedHost: null,
        commit: null,
      },
      flavor: "",
    };
  }
}

describe("resolveCastProvokes — the sheet-scoped glue (D-191)", () => {
  test("an auto-resolved cast provoke rolls the attack and returns the caster's damage", async () => {
    const scene_ = scene([
      token("wizard", "a-wizard", 0, 0, "friendly"),
      token("fighter", "a-fighter", 0, 1),
    ]);
    const client = new FakeClient(scene_, [fighter(), wizard()]);
    // 11 + 9 = 20 vs AC 16 hits; the longsword deals 1d8 (4) + 3 = 7, no DR.
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const result = await resolveCastProvokes({
      client,
      user: gm,
      provokerTokenId: "wizard",
      provokes: [{ actionId: "cast-spell" }],
      autoResolve: true,
      combat: combat({ used: 0, max: 1 }),
    });
    expect(result.damage).toBe(7);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toBe(
      "Fighter hits Wizard for 7 (20 vs AC 16) — 1/1 opportunities this round",
    );
    // The card, the HP write, then the ledger — the same three submits a move AoO makes.
    expect(client.submitted).toHaveLength(3);
  });

  test("a non-threatened caster reports nothing and takes no damage", async () => {
    const scene_ = scene([
      token("wizard", "a-wizard", 0, 0, "friendly"),
      token("fighter", "a-fighter", 0, 8),
    ]);
    const client = new FakeClient(scene_, [fighter(), wizard()]);
    const result = await resolveCastProvokes({
      client,
      user: gm,
      provokerTokenId: "wizard",
      provokes: [{ actionId: "cast-spell" }],
      autoResolve: true,
      combat: combat({ used: 0, max: 1 }),
    });
    expect(result.lines).toEqual([]);
    expect(result.damage).toBe(0);
    expect(client.submitted).toHaveLength(0);
  });

  test("with no encounter the provoke is reported, never resolved", async () => {
    const scene_ = scene([
      token("wizard", "a-wizard", 0, 0, "friendly"),
      token("fighter", "a-fighter", 0, 1),
    ]);
    const client = new FakeClient(scene_, [fighter(), wizard()]);
    const result = await resolveCastProvokes({
      client,
      user: gm,
      provokerTokenId: "wizard",
      provokes: [{ actionId: "cast-spell" }],
      autoResolve: true,
      combat: null,
    });
    expect(result.damage).toBe(0);
    expect(result.lines).toEqual([
      "fighter may strike wizard as it acts (0,0)",
      "(no encounter — the AoO budget is per round and per combatant, so these were left to the table)",
    ]);
    expect(client.submitted).toHaveLength(0);
  });

  test("the cast and its ranged touch share one queue, so a 1/round reactor takes only the first", async () => {
    const scene_ = scene([
      token("wizard", "a-wizard", 0, 0, "friendly"),
      token("fighter", "a-fighter", 0, 1),
    ]);
    const client = new FakeClient(scene_, [fighter(), wizard()]);
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const result = await resolveCastProvokes({
      client,
      user: gm,
      provokerTokenId: "wizard",
      provokes: [
        { actionId: "cast-spell" },
        { trigger: { kind: "ranged-touch" } },
      ],
      autoResolve: true,
      combat: combat({ used: 0, max: 1 }),
    });
    // One attack and one damage roll — the second provoke never produced a d20.
    expect(client.formulas.filter((f) => f.includes("d20"))).toHaveLength(1);
    expect(
      result.lines.some((l) => l.includes("no opportunities left (1/1)")),
    ).toBe(true);
    expect(result.damage).toBe(7);
  });
});
