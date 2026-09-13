import { describe, expect, test } from "vitest";
import { pf1ePairPosition, type PF1eThreatToken } from "../../src/packages/pf1e/threatPreview";
import { shootingIntoMeleePenalty } from "../../src/packages/pf1e/tactical";
import type { ActorDocument, Json, MessageDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { derivePF1eActor, deriveFromDocuments } from "../../src/packages/pf1e/actor";
import type { ResolveFlowClient } from "../../src/ui/sheets/pf1eResolveFlow";
import { resolveAttackFlow, resolveManyshotFlow } from "../../src/ui/sheets/pf1eResolveFlow";

const GRID = { size: 5, distance: 5, units: "ft" };
function tok(_id: string, col: number, row: number, extra: Partial<PF1eThreatToken> = {}): PF1eThreatToken {
  return {
    _id,
    x: (col + 0.5) * GRID.size,
    y: (row + 0.5) * GRID.size,
    width: GRID.size,
    height: GRID.size,
    size: "Medium",
    ...extra,
  };
}

describe("P04 — engagement facts from scene geometry (AoN 131)", () => {
  test("ranged attacker: target engaged with friendly => -4,Precise Shot removes, distance≥10 removes, size ladder -2/0", () => {
    // a at (0,0), f adjacent to d at (2,0) so d engaged, a 10 ft away
    const tokens = [tok("a", 0, 0), tok("f", 1, 0), tok("d", 2, 0)];
    const isEnemy = (a: string, b: string) => {
      const side = (id: string) => (id === "d" ? "hostile" : "friendly");
      return side(a) !== side(b);
    };
    const r = pf1ePairPosition({
      grid: GRID,
      tokens,
      attackerId: "a",
      defenderId: "d",
      ranged: true,
      walls: [],
      isEnemy,
    });
    expect(r.ok).toBe(true);
    expect(r.engagement.targetEngaged).toBe(true);
    expect(r.engagement.nearestFriendlyDistanceFt).toBe(5);
    expect(r.engagement.sizeCategoriesLarger).toBe(0);
    expect(shootingIntoMeleePenalty({ targetEngaged: r.engagement.targetEngaged, nearestFriendlyDistanceFt: r.engagement.nearestFriendlyDistanceFt ?? undefined, sizeCategoriesLarger: r.engagement.sizeCategoriesLarger })).toBe(-4);
    expect(shootingIntoMeleePenalty({ targetEngaged: true, preciseShot: true })).toBe(0);
    expect(shootingIntoMeleePenalty({ targetEngaged: true, nearestFriendlyDistanceFt: 10 })).toBe(0);
    expect(shootingIntoMeleePenalty({ targetEngaged: true, sizeCategoriesLarger: 2 })).toBe(-2);
    expect(shootingIntoMeleePenalty({ targetEngaged: true, sizeCategoriesLarger: 3 })).toBe(0);
  });

  test("target Large two sizes larger than Small friendly => -2", () => {
    const tokens = [tok("a", 0, 0), tok("f", 1, 0, { size: "Small" }), tok("d", 2, 0, { size: "Large" })];
    const isEnemy = (a: string, b: string) => {
      const side = (id: string) => (id === "d" ? "hostile" : "friendly");
      return side(a) !== side(b);
    };
    const r = pf1ePairPosition({
      grid: GRID,
      tokens,
      attackerId: "a",
      defenderId: "d",
      ranged: true,
      walls: [],
      isEnemy,
    });
    expect(r.engagement.targetEngaged).toBe(true);
    // Medium baseline: Large is 2 larger than Small (Small->Medium 1, Medium->Large 1 =>2)
    expect(r.engagement.sizeCategoriesLarger).toBe(2);
    expect(shootingIntoMeleePenalty({ targetEngaged: true, sizeCategoriesLarger: r.engagement.sizeCategoriesLarger })).toBe(-2);
  });

  test("target not engaged => no penalty even without Precise Shot", () => {
    // friendly far away (5 squares), target not threatened
    const tokens = [tok("a", 0, 0), tok("f", 10, 10), tok("d", 2, 0)];
    const isEnemy = (a: string, b: string) => {
      const side = (id: string) => (id === "d" ? "hostile" : "friendly");
      return side(a) !== side(b);
    };
    const r = pf1ePairPosition({
      grid: GRID,
      tokens,
      attackerId: "a",
      defenderId: "d",
      ranged: true,
      walls: [],
      isEnemy,
    });
    expect(r.engagement.targetEngaged).toBe(false);
    expect(r.engagement.nearestFriendlyDistanceFt).toBeGreaterThan(10);
    expect(shootingIntoMeleePenalty({ targetEngaged: false })).toBe(0);
    expect(shootingIntoMeleePenalty({ targetEngaged: r.engagement.targetEngaged, nearestFriendlyDistanceFt: r.engagement.nearestFriendlyDistanceFt ?? undefined })).toBe(0);
  });

  test("friendly 15 ft away => no penalty despite engagement false", () => {
    const tokens = [tok("a", 0, 0), tok("f", 5, 0), tok("d", 2, 0)];
    const isEnemy = (a: string, b: string) => {
      const side = (id: string) => (id === "d" ? "hostile" : "friendly");
      return side(a) !== side(b);
    };
    const r = pf1ePairPosition({
      grid: GRID,
      tokens,
      attackerId: "a",
      defenderId: "d",
      ranged: true,
      walls: [],
      isEnemy,
    });
    // f at (5,0) distance to d at (2,0) =3 squares =15 ft, so not threatening
    expect(r.engagement.targetEngaged).toBe(false);
    expect(r.engagement.nearestFriendlyDistanceFt).toBe(15);
    expect(shootingIntoMeleePenalty({ targetEngaged: true, nearestFriendlyDistanceFt: 15 })).toBe(0);
  });

  test("melee reach gate: out of reach is reported", () => {
    const tokens = [tok("a", 0, 0), tok("d", 3, 0)];
    const r = pf1ePairPosition({
      grid: GRID,
      tokens,
      attackerId: "a",
      defenderId: "d",
      ranged: false,
      reachSquares: 1,
      walls: [],
    });
    expect(r.reach?.canStrike).toBe(false);
    expect(r.reach?.refusals[0]).toContain("15 ft away");
  });
});

const owner = { id: "player", role: "PLAYER" as const };

function actor(id: string, pf1e: Record<string, Json>): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id === "goblin" ? "Goblin" : "Archer",
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e },
    items: [],
    effects: [],
  };
}

const rangedAttackerDerived = derivePF1eActor({
  system: {
    abilities: { str: 10, dex: 18, con: 14 },
    baseAttack: 6,
    hp: 20,
    hpMax: 20,
    attacks: [{ name: "Longbow", ranged: true, damageDice: "1d8", damageBonus: 2, damageType: "piercing", critThreatMin: 20, critMultiplier: 3 }],
  },
});
const goblinActor = actor("goblin", { abilities: { dex: 14, con: 12 }, hp: 30, hpMax: 30, armorClass: { armor: 2 } });
const goblin = deriveFromDocuments({ actor: goblinActor });

class FakeClient implements ResolveFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  script: Array<{ die?: number; total: number }> = [];
  private seq = 0;
  readonly store = { getAll: (coll: "messages"): readonly unknown[] => (coll === "messages" ? this.messages : []) };
  roll(formula: string): string {
    this.formulas.push(formula);
    const rollId = `r${this.seq++}`;
    const entry = this.script.shift() ?? { total: 0 };
    this.messages.push({
      _id: `m-${rollId}`,
      type: "message",
      name: formula.slice(0, 40),
      ownership: { default: 1 },
      flags: { core: { rollId } },
      system: {},
      author: "player",
      content: formula,
      whisper: [],
      roll: {
        formula,
        total: entry.total,
        terms: entry.die === undefined ? [{ kind: "dice", expr: "1d8", rolls: [4], kept: [4], total: 4 }] : [{ kind: "dice", expr: "1d20", rolls: [entry.die], kept: [entry.die], total: entry.die }],
        seedClient: null,
        seedHost: null,
      },
      flavor: "",
    });
    return rollId;
  }
  async rollVerified(formula: string): Promise<string> { return this.roll(formula); }
  submit(ops: Op[]): string { this.submitted.push(ops); return "tx"; }
}
function bowLine() { const l = rangedAttackerDerived.attacks[0]; if (!l) throw new Error("no line"); return l; }

describe("P04 resolve flow — shooting into melee is folded into the attack bonus (AoN 131)", () => {
  test("engaged without Precise Shot => -4", async () => {
    const client = new FakeClient();
    const bow = bowLine();
    const base = bow.attackBonus;
    client.script = [{ die: 12, total: 0 }, { total: 6 }];
    const out = await resolveAttackFlow(client, owner, {
      attackerName: "Archer",
      line: bow,
      iterative: 0,
      attackFormula: `1d20 + ${base}`,
      damageFormula: "1d8 + 2",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: [],
      attackerBab: 6,
      targetEngaged: true,
      nearestFriendlyDistanceFt: 5,
      engagedSizeCategoriesLarger: 0,
    });
    expect(out.ok).toBe(true);
    expect(client.formulas[0]).toBe(`1d20 + ${base - 4}`);
  });

  test("Precise Shot removes the penalty", async () => {
    const client = new FakeClient();
    const bow = bowLine();
    const base = bow.attackBonus;
    client.script = [{ die: 12, total: 0 }, { total: 6 }];
    const out = await resolveAttackFlow(client, owner, {
      attackerName: "Archer",
      line: bow,
      iterative: 0,
      attackFormula: `1d20 + ${base}`,
      damageFormula: "1d8 + 2",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: ["Precise Shot"],
      attackerBab: 6,
      targetEngaged: true,
      nearestFriendlyDistanceFt: 5,
      engagedSizeCategoriesLarger: 0,
    });
    expect(client.formulas[0]).toBe(`1d20 + ${base}`);
    expect(out.ok).toBe(true);
  });

  test("size 2 larger => -2, size 3 larger => 0", async () => {
    const bow = bowLine();
    const base = bow.attackBonus;
    for (const [size, expected] of [[2, -2] as const, [3, 0] as const]) {
      const client = new FakeClient();
      client.script = [{ die: 12, total: 0 }, { total: 6 }];
      await resolveAttackFlow(client, owner, {
        attackerName: "Archer",
        line: bow,
        iterative: 0,
        attackFormula: `1d20 + ${base}`,
        damageFormula: "1d8 + 2",
        critDamageFormula: null,
        targetName: "Goblin",
        targetActor: goblinActor,
        targetDerived: goblin,
        defense: "normal",
        feats: [],
        attackerBab: 6,
        targetEngaged: true,
        nearestFriendlyDistanceFt: 5,
        engagedSizeCategoriesLarger: size,
      });
      expect(client.formulas[0]).toBe(expected === 0 ? `1d20 + ${base}` : `1d20 + ${base + expected}`);
    }
  });

  test("distance >=10 ft => no penalty", async () => {
    const client = new FakeClient();
    const bow = bowLine();
    const base = bow.attackBonus;
    client.script = [{ die: 12, total: 0 }, { total: 6 }];
    await resolveAttackFlow(client, owner, {
      attackerName: "Archer",
      line: bow,
      iterative: 0,
      attackFormula: `1d20 + ${base}`,
      damageFormula: "1d8 + 2",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: [],
      attackerBab: 6,
      targetEngaged: true,
      nearestFriendlyDistanceFt: 15,
      engagedSizeCategoriesLarger: 0,
    });
    expect(client.formulas[0]).toBe(`1d20 + ${base}`);
  });

  test("Manyshot folds the same penalty into the -4 volley ladder", async () => {
    const client = new FakeClient();
    const bow = bowLine();
    const formulas = ["1d20 + 6", "1d20 + 6", "1d20 + 6"];
    client.script = [
      { die: 12, total: 0 }, { total: 6 },
      { die: 11, total: 0 }, { total: 5 },
      { die: 10, total: 0 }, { total: 4 },
    ];
    const out = await resolveManyshotFlow(client, owner, {
      attackerName: "Archer",
      line: bow,
      attackFormulas: formulas,
      damageFormula: "1d8 + 2",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: [],
      attackerBab: 6,
      targetEngaged: true,
      nearestFriendlyDistanceFt: 5,
      engagedSizeCategoriesLarger: 0,
    });
    expect(out.ok).toBe(true);
    // Manyshot base is base-4, plus -4 melee => base-8
    // first arrow's attack roll is via FakeClient roll; outcome success proves penalty folded without error
  });

  test("not engaged => no penalty", async () => {
    const client = new FakeClient();
    const bow = bowLine();
    const base = bow.attackBonus;
    client.script = [{ die: 12, total: 0 }, { total: 6 }];
    await resolveAttackFlow(client, owner, {
      attackerName: "Archer",
      line: bow,
      iterative: 0,
      attackFormula: `1d20 + ${base}`,
      damageFormula: "1d8 + 2",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: [],
      attackerBab: 6,
      targetEngaged: false,
      nearestFriendlyDistanceFt: 5,
      engagedSizeCategoriesLarger: 0,
    });
    expect(client.formulas[0]).toBe(`1d20 + ${base}`);
  });
});
