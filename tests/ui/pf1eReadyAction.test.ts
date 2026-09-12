/**
 * P07/D-195 — the fired readied action resolves through the sheet's attack flow. Fixtures mirror
 * `pf1eActionProvoke.test.ts` (grid 100, a Medium token's centre at `(col + 0.5) * 100`); the
 * readied combatant (a fighter with a longsword) fires up against the triggerer (a wizard), and
 * the resolution is the same `resolveAttackFlow` the AoO path uses — but no budget is spent, the
 * provoker defends normally, and the initiative reorder is `resolveReady`'s.
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
  resolveReadiedAction,
  type ReadyActionClient,
} from "../../src/ui/combat/pf1eReadyAction";
import { readCombatantState } from "../../src/packages/pf1e/combatState";

const gm = { id: "gm", role: "GM" as const };

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

/** A ranged-only reactor: no melee line, so the readied attack cannot roll. */
function archer(): ActorDocument {
  return {
    _id: "a-archer",
    type: "actor",
    name: "Archer",
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: {
      pf1e: {
        abilities: { dex: 16, con: 12 },
        baseAttack: 4,
        hp: 20,
        hpMax: 20,
        armorClass: { armor: 3 },
        attacks: [
          {
            name: "Longbow",
            damageDice: "1d8",
            damageBonus: 3,
            damageType: "piercing",
            critThreatMin: 20,
            critMultiplier: 3,
            ranged: true,
          },
        ],
      },
    },
  };
}

/** The triggerer: AC 16 (10 + armor 4 + Dex 2), 12 HP. */
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

function token(id: string, actorId: string, col: number, row: number): TokenDocument {
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
    disposition: "hostile",
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

/** A running encounter. `readied` is the fighter's `flags.pf1e.ready` (null = no ready). */
function combat(
  readied: Record<string, Json> | null,
  readiedActorId = "a-fighter",
): CombatDocument {
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
      combatant(
        "c-fighter",
        "fighter",
        readiedActorId,
        2,
        readied === null ? { acted: true } : { acted: true, ready: readied },
      ),
      combatant("c-wizard", "wizard", "a-wizard", 5, { acted: true }),
    ],
  } as unknown as CombatDocument;
}

/** Fake client: scripted roll totals, real message shapes, recorded submits. */
class FakeClient implements ReadyActionClient {
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
  } as ReadyActionClient["store"];

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

const standardAttackReady: Record<string, Json> = {
  action: { kind: "standard", action: "attack" },
  trigger: { kind: "cast" },
  sinceRound: 1,
};

describe("resolveReadiedAction — the fired readied action resolves (D-195)", () => {
  test("a readied standard attack rolls, writes HP, and reorders initiative", async () => {
    const scene_ = scene([
      token("fighter", "a-fighter", 0, 1),
      token("wizard", "a-wizard", 0, 0),
    ]);
    const client = new FakeClient(scene_, [fighter(), wizard()]);
    // 11 + 9 = 20 vs AC 16 hits; the longsword deals 1d8 (4) + 3 = 7.
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const result = await resolveReadiedAction({
      client,
      user: gm,
      combat: combat(standardAttackReady),
      readiedCombatantId: "c-fighter",
      triggererCombatantId: "c-wizard",
    });
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.damage).toBe(7);
    expect(result.lines).toEqual(["Fighter hits Wizard for 7 (20 vs AC 16)"]);
    // The ready is spent and the initiative moved to just ahead of the triggerer (5 + 1).
    const readied = result.combat?.combatants.find((c) => c._id === "c-fighter");
    expect(readied?.initiative).toBe(6);
    expect(readied ? readCombatantState(readied).ready : undefined).toBeNull();
    expect(result.hooks).toEqual(["combat:combatant:ready:resolve"]);
    // The card and the HP write — but no ledger spend (the standard action was already paid).
    expect(client.submitted.length).toBeGreaterThanOrEqual(2);
  });

  test("a readied move action reorders without rolling and names the hand-off", async () => {
    const scene_ = scene([
      token("fighter", "a-fighter", 0, 1),
      token("wizard", "a-wizard", 0, 0),
    ]);
    const client = new FakeClient(scene_, [fighter(), wizard()]);
    const result = await resolveReadiedAction({
      client,
      user: gm,
      combat: combat({
        action: { kind: "move" },
        trigger: { kind: "move" },
        sinceRound: 1,
      }),
      readiedCombatantId: "c-fighter",
      triggererCombatantId: "c-wizard",
    });
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(false);
    expect(result.damage).toBe(0);
    expect(result.lines).toEqual([
      "c-fighter's readied move action fires — resolve it now (trigger: move).",
    ]);
    expect(client.formulas).toHaveLength(0);
    expect(client.submitted).toHaveLength(0);
    // The reorder still happened.
    expect(
      result.combat?.combatants.find((c) => c._id === "c-fighter")?.initiative,
    ).toBe(6);
  });

  test("a ranged-only readied combatant is reported by name, not given a melee strike", async () => {
    const scene_ = scene([
      token("fighter", "a-archer", 0, 1),
      token("wizard", "a-wizard", 0, 0),
    ]);
    const client = new FakeClient(scene_, [archer(), wizard()]);
    const result = await resolveReadiedAction({
      client,
      user: gm,
      combat: combat(standardAttackReady, "a-archer"),
      readiedCombatantId: "c-fighter",
      triggererCombatantId: "c-wizard",
    });
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(false);
    expect(result.lines).toEqual([
      "c-fighter's readied attack is ranged-only — a readied attack resolves as the primary melee attack, so resolve it through the sheet.",
    ]);
    expect(client.formulas).toHaveLength(0);
  });

  test("refuses when the combatant has no readied action to fire", async () => {
    const scene_ = scene([
      token("fighter", "a-fighter", 0, 1),
      token("wizard", "a-wizard", 0, 0),
    ]);
    const client = new FakeClient(scene_, [fighter(), wizard()]);
    const result = await resolveReadiedAction({
      client,
      user: gm,
      combat: combat(null),
      readiedCombatantId: "c-fighter",
      triggererCombatantId: "c-wizard",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("this combatant has no readied action to fire");
    expect(result.combat).toBeNull();
  });
});
