import { describe, expect, test } from "vitest";
import type { ActorDocument, Json, MessageDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { derivePF1eActor, deriveFromDocuments } from "../../src/packages/pf1e/actor";
import type { ResolveFlowClient } from "../../src/ui/sheets/pf1eResolveFlow";
import { resolveAttackFlow } from "../../src/ui/sheets/pf1eResolveFlow";

const owner = { id: "player", role: "PLAYER" as const };

function actor(id: string, pf1e: Record<string, Json>): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id === "goblin" ? "Goblin" : "Fighter",
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e },
    items: [],
    effects: [],
  };
}

const attackerDerived = derivePF1eActor({
  system: {
    abilities: { str: 16, dex: 14, con: 14 },
    baseAttack: 6,
    hp: 20,
    hpMax: 20,
    attacks: [
      {
        name: "Longsword",
        damageDice: "1d8",
        damageBonus: 3,
        damageType: "slashing",
        critThreatMin: 19,
        critMultiplier: 2,
      },
    ],
  },
});

const rangedAttackerDerived = derivePF1eActor({
  system: {
    abilities: { str: 10, dex: 18, con: 14 },
    baseAttack: 6,
    hp: 20,
    hpMax: 20,
    attacks: [
      {
        name: "Longbow",
        ranged: true,
        damageDice: "1d8",
        damageBonus: 2,
        damageType: "piercing",
        critThreatMin: 20,
        critMultiplier: 3,
      },
    ],
  },
});

const goblinActor = actor("goblin", {
  abilities: { dex: 14, con: 12 },
  hp: 30,
  hpMax: 30,
  armorClass: { armor: 2 },
});
const goblin = deriveFromDocuments({ actor: goblinActor });

class FakeClient implements ResolveFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  script: Array<{ die?: number; total: number }> = [];
  private seq = 0;
  readonly store = {
    getAll: (coll: "messages"): readonly unknown[] => (coll === "messages" ? this.messages : []),
  };
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
  private record(rollId: string, formula: string, entry: { die?: number; total: number }): MessageDocument {
    return {
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
        terms:
          entry.die === undefined
            ? [{ kind: "dice", expr: "1d8", rolls: [4], kept: [4], total: 4 }]
            : [{ kind: "dice", expr: "1d20", rolls: [entry.die], kept: [entry.die], total: entry.die }],
        seedClient: null,
        seedHost: null,
      },
      flavor: "",
    };
  }
}

function swordLine() {
  const l = attackerDerived.attacks[0];
  if (!l) throw new Error("no line");
  return l;
}
function bowLine() {
  const l = rangedAttackerDerived.attacks[0];
  if (!l) throw new Error("no line");
  return l;
}

describe("A07 stance wiring — resolveAttackFlow feat deltas", () => {
  test("Power Attack: -2 attack at BAB 6, +4 damage (×2 on crit)", async () => {
    const client = new FakeClient();
    // baseBonus 9, Power Attack step 2 => effective 7; die 12 +7=19 hits AC 14
    client.script = [{ die: 12, total: 19 }, { total: 7 }];
    const outcome = await resolveAttackFlow(client, owner, {
      attackerName: "Fighter",
      line: swordLine(),
      iterative: 0,
      attackFormula: "1d20 + 9",
      damageFormula: "1d8 + 6",
      critDamageFormula: "1d8 + 6 + 1d8 + 6",
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: ["Power Attack"],
      attackerBab: 6,
      powerAttack: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("failed");
    // attack formula should be adjusted
    expect(client.formulas[0]).toBe("1d20 + 7");
    // damage: rolled 7 + Power Attack 4 =11, vs goblin no DR => dealt 11
    expect(outcome.result.ok && outcome.result.damage?.dealt).toBe(11);
    expect(outcome.result.ok && outcome.result.notes.join(" ")).toContain("Power Attack");
  });

  test("Power Attack crit multiplies the static bonus", async () => {
    const client = new FakeClient();
    client.script = [
      { die: 19, total: 26 }, // 19 +7=26 hits and threatens
      { die: 15, total: 22 }, // 15+7=22 confirms
      { total: 10 }, // crit dice total (2 rolls)
    ];
    const outcome = await resolveAttackFlow(client, owner, {
      attackerName: "Fighter",
      line: swordLine(),
      iterative: 0,
      attackFormula: "1d20 + 9",
      damageFormula: "1d8 + 6",
      critDamageFormula: "1d8 + 6 + 1d8 + 6",
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: ["Power Attack"],
      attackerBab: 6,
      powerAttack: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("fail");
    // 10 + 4*2 =18
    expect(outcome.result.ok && outcome.result.damage?.dealt).toBe(18);
    expect(outcome.result.ok && outcome.result.outcome).toBe("crit");
  });

  test("Weapon Focus adds +1 without a stance toggle", async () => {
    const client = new FakeClient();
    client.script = [{ die: 10, total: 20 }, { total: 5 }];
    const outcome = await resolveAttackFlow(client, owner, {
      attackerName: "Fighter",
      line: swordLine(),
      iterative: 0,
      attackFormula: "1d20 + 9",
      damageFormula: "1d8 + 6",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: ["Weapon Focus (longsword)"],
      attackerBab: 6,
    });
    expect(outcome.ok).toBe(true);
    expect(client.formulas[0]).toBe("1d20 + 10");
    if (!outcome.ok) throw new Error("fail");
    expect(outcome.result.ok && outcome.result.notes.join(" ")).toContain("Weapon Focus");
  });

  test("Fighting defensively is -4 attack, feat-gated notes surface", async () => {
    const client = new FakeClient();
    client.script = [{ die: 10, total: 15 }, { total: 5 }];
    const outcome = await resolveAttackFlow(client, owner, {
      attackerName: "Fighter",
      line: swordLine(),
      iterative: 0,
      attackFormula: "1d20 + 9",
      damageFormula: "1d8 + 6",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: [],
      attackerBab: 6,
      fightingDefensively: true,
    });
    expect(client.formulas[0]).toBe("1d20 + 5");
    expect(outcome.ok && (outcome as { result: { notes: string[] } }).result.notes.join(" ")).toContain(
      "fighting defensively",
    );
  });

  test("Deadly Aim and Point-Blank Shot apply to ranged lines", async () => {
    const client = new FakeClient();
    // Bow base bonus: dex 18 (+4), bab6, size0 => +10? but fixture says attackBonus derived? Use swordLine? For bow, compute base 10
    const bow = bowLine();
    const base = bow.attackBonus;
    // Deadly Aim step 2 => -2, Point-Blank +1 net -1 so effective base-1
    client.script = [{ die: 12, total: 21 }, { total: 6 }];
    const outcome = await resolveAttackFlow(client, owner, {
      attackerName: "Archer",
      line: bow,
      iterative: 0,
      attackFormula: `1d20 + ${base}`,
      damageFormula: "1d8 + 2",
      critDamageFormula: "1d8 + 2 + 1d8 + 2 + 1d8 + 2",
      targetName: "Goblin",
      targetActor: goblinActor,
      targetDerived: goblin,
      defense: "normal",
      feats: ["Deadly Aim", "Point-Blank Shot"],
      attackerBab: 6,
      deadlyAim: true,
      pointBlankShot: true,
      distanceFt: 20,
    });
    expect(client.formulas[0]).toBe(`1d20 + ${base - 1}`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("fail");
    // Deadly Aim damage +4 (step2*2), PBS +1 => +5; rolled 6+5=11
    expect(outcome.result.ok && outcome.result.damage?.dealt).toBe(11);
  });

  test("stance without the feat does nothing", async () => {
    const client = new FakeClient();
    client.script = [{ die: 12, total: 21 }, { total: 6 }];
    const bow = bowLine();
    const base = bow.attackBonus;
    const outcome = await resolveAttackFlow(client, owner, {
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
      deadlyAim: true,
    });
    expect(client.formulas[0]).toBe(`1d20 + ${base}`);
    expect(outcome.ok).toBe(true);
  });
});
