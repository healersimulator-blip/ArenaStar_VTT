import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  Json,
  MessageDocument,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import {
  deriveFromDocuments,
  derivePF1eActor,
} from "../../src/packages/pf1e/actor";
import { evaluateCommitRoll, sha256Hex } from "../../src/dice/commitReveal";
import type { PF1eResolveResult } from "../../src/packages/pf1e/resolve";
import {
  dieFaceOf,
  resolveAttackFlow,
  resolveDefenderFromDerived,
  resolutionCardContent,
  type ResolveFlowClient,
} from "../../src/ui/sheets/pf1eResolveFlow";

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

const attacker = derivePF1eActor({
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

const goblinActor = actor("goblin", {
  abilities: { dex: 14, con: 12 },
  hp: 12,
  hpMax: 12,
  armorClass: { armor: 4 },
  dr: 5,
  drBypass: ["magic"],
});
const goblin = deriveFromDocuments({ actor: goblinActor });

/** Fake client: scripted faces/totals, real message shapes, recorded submits. */
class FakeClient implements ResolveFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  /** One entry per roll: the die face (attack/confirm) and the total to report. */
  script: Array<{ die?: number; total: number }> = [];
  verifiable = false;
  private seq = 0;
  readonly store = {
    getAll: (coll: "messages"): readonly unknown[] =>
      coll === "messages" ? this.messages : [],
  };

  roll(formula: string): string {
    this.formulas.push(formula);
    const rollId = `r${this.seq++}`;
    const entry = this.script.shift() ?? { total: 0 };
    this.messages.push(this.record(rollId, formula, entry, false));
    return rollId;
  }

  async rollVerified(formula: string): Promise<string> {
    this.formulas.push(formula);
    const rollId = `r${this.seq++}`;
    // A legitimate commit-reveal record: fixed seeds, real commitment hash,
    // total and terms re-derived exactly as the host would.
    const seedClient = "00" + rollId.padStart(30, "c");
    const seedHost = "00" + rollId.padStart(30, "h");
    const commit = await sha256Hex(seedClient);
    const evaluation = await evaluateCommitRoll(formula, seedClient, seedHost);
    if (!evaluation.ok) throw new Error(evaluation.error);
    const scripted = this.script.shift();
    this.messages.push({
      ...this.record(rollId, formula, { total: evaluation.value.total }, true),
      roll: {
        formula,
        total: scripted !== undefined ? scripted.total : evaluation.value.total,
        terms: evaluation.value.terms,
        seedClient,
        seedHost,
        commit,
      },
    });
    return rollId;
  }

  submit(ops: Op[]): string {
    this.submitted.push(ops);
    return "tx";
  }

  private record(
    rollId: string,
    formula: string,
    entry: { die?: number; total: number },
    verified: boolean,
  ): MessageDocument {
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
            : [
                {
                  kind: "dice",
                  expr: "1d20",
                  rolls: [entry.die],
                  kept: [entry.die],
                  total: entry.die,
                },
              ],
        seedClient: verified ? "seed-c" : null,
        seedHost: verified ? "seed-h" : null,
        commit: verified ? "bogus" : null,
      },
      flavor: "",
    };
  }
}

function swordLine() {
  const line = attacker.attacks[0];
  if (line === undefined) throw new Error("fixture has no attack line");
  return line;
}

function params(
  overrides: Partial<Parameters<typeof resolveAttackFlow>[2]> = {},
) {
  return {
    attackerName: "Fighter",
    line: swordLine(),
    iterative: 0,
    attackFormula: "1d20 + 9",
    damageFormula: "1d8 + 6",
    critDamageFormula: "1d8 + 6 + 1d8 + 6",
    targetName: "Goblin",
    targetActor: goblinActor,
    targetDerived: goblin,
    defense: "normal" as const,
    ...(Object.keys(overrides).length > 0 ? overrides : {}),
  };
}

describe("resolveAttackFlow — the A06b chat flow", () => {
  test("a hit rolls attack and damage publicly, mitigates, and writes hp through the sheet path", async () => {
    const client = new FakeClient();
    // 11 + 9 = 20 vs AC 16 hits; the mundane longsword eats DR 5/magic: 7 − 5 = 2.
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const outcome = await resolveAttackFlow(client, owner, params());
    expect(outcome).toMatchObject({
      ok: true,
      hpWriteError: null,
      result: {
        ok: true,
        outcome: "hit",
        defenseAc: 16,
        damage: { dealt: 2, drApplied: 5 },
        hp: { before: 12, after: 10 },
      },
    });
    expect(client.formulas).toEqual(["1d20 + 9", "1d8 + 6"]);
    // One card create op, then the hp update through pf1eSheetEdit.
    expect(client.submitted).toHaveLength(2);
    expect(client.submitted[0]?.[0]).toMatchObject({ kind: "create" });
    expect(client.submitted[1]?.[0]).toMatchObject({
      kind: "update",
      diff: { "system.pf1e.hp": 10 },
    });
    const card = client.submitted[0]?.[0];
    if (card?.kind !== "create") throw new Error("expected a create op");
    const data = card.data as MessageDocument;
    expect(data.content).toContain("hits.");
    expect(data.content).toContain("[[2|1d8 + 6]]");
    expect(data.content).toContain("DR absorbed 5");
    expect(data.content).toContain("Goblin 12 → 10 HP");
  });

  test("a miss rolls no damage and writes nothing", async () => {
    const client = new FakeClient();
    client.script = [{ die: 3, total: 12 }];
    const outcome = await resolveAttackFlow(client, owner, params());
    expect(outcome).toMatchObject({
      ok: true,
      result: { ok: true, outcome: "miss", hp: { before: 12, after: 12 } },
    });
    expect(client.formulas).toEqual(["1d20 + 9"]);
    expect(client.submitted).toHaveLength(1);
    const card = client.submitted[0]?.[0];
    if (card?.kind !== "create") throw new Error("expected a create op");
    expect((card.data as MessageDocument).content).toContain("misses.");
  });

  test("a confirmed threat rolls the D-139 crit formula", async () => {
    const client = new FakeClient();
    // 19 threatens (19–20); 15 + 9 = 24 confirms; crit damage total 20 − DR 5 = 15.
    client.script = [
      { die: 19, total: 28 },
      { die: 15, total: 24 },
      { total: 20 },
    ];
    const outcome = await resolveAttackFlow(client, owner, params());
    expect(client.formulas).toEqual([
      "1d20 + 9",
      "1d20 + 9",
      "1d8 + 6 + 1d8 + 6",
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        ok: true,
        outcome: "crit",
        threat: true,
        confirmed: true,
        damage: { dealt: 15 },
        hp: { after: -3 },
      },
    });
  });

  test("an unconfirmed threat rolls the normal damage formula", async () => {
    const client = new FakeClient();
    client.script = [
      { die: 19, total: 28 },
      { die: 2, total: 11 },
      { total: 8 },
    ];
    const outcome = await resolveAttackFlow(client, owner, params());
    expect(client.formulas).toEqual(["1d20 + 9", "1d20 + 9", "1d8 + 6"]);
    expect(outcome).toMatchObject({
      ok: true,
      result: { ok: true, outcome: "hit", confirmed: false },
    });
  });

  test("a user without ownership narrates but cannot write hp — the card says so", async () => {
    const client = new FakeClient();
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const outcome = await resolveAttackFlow(client, null, params());
    expect(outcome).toMatchObject({
      ok: true,
      hpWriteError: "You do not own this PF1e actor.",
    });
    expect(client.submitted).toHaveLength(1);
    const card = client.submitted[0]?.[0];
    if (card?.kind !== "create") throw new Error("expected a create op");
    expect((card.data as MessageDocument).content).toContain(
      "⚠ HP write rejected: You do not own this PF1e actor.",
    );
  });

  test("the verifiable flow rides commit-reveal and posts the verification chip", async () => {
    const client = new FakeClient();
    client.verifiable = true;
    // The attack re-derives deterministically from the fixed seeds; script the
    // reported total to match so the verification passes. The face lands via
    // the re-derived terms, so learn it first and make AC 16 hittable.
    const seedClient = "00" + "r0".padStart(30, "c");
    const seedHost = "00" + "r0".padStart(30, "h");
    const evaluation = await evaluateCommitRoll(
      "1d20 + 9",
      seedClient,
      seedHost,
    );
    if (!evaluation.ok) throw new Error(evaluation.error);
    const face = dieFaceOf({
      roll: {
        formula: "1d20 + 9",
        total: 0,
        terms: evaluation.value.terms,
        seedClient: null,
        seedHost: null,
      },
    } as unknown as MessageDocument);
    expect(face).not.toBeNull();
    expect(face).not.toBe(1); // a natural 1 would auto-miss this fixture
    if (face !== null && face + 9 < 16) {
      throw new Error("pick different seeds — this face misses AC 16");
    }
    client.script = [{ total: evaluation.value.total }, { total: 7 }];
    const outcome = await resolveAttackFlow(client, owner, {
      ...params(),
      verifiable: true,
    });
    expect(outcome.ok).toBe(true);
    const card = client.submitted[0]?.[0];
    if (card?.kind !== "create") throw new Error("expected a create op");
    const content = (card.data as MessageDocument).content;
    expect(content).toContain("✓ verified");
  });
});

describe("resolve flow helpers", () => {
  test("dieFaceOf reads the first kept die face, and null without dice terms", () => {
    const message = {
      roll: {
        formula: "1d20 + 9",
        total: 20,
        terms: [
          { kind: "dice", expr: "1d20", rolls: [11], kept: [11], total: 11 },
        ],
        seedClient: null,
        seedHost: null,
      },
    } as unknown as MessageDocument;
    expect(dieFaceOf(message)).toBe(11);
    const roll = message.roll;
    if (roll === null) throw new Error("fixture roll missing");
    expect(dieFaceOf({ ...message, roll: { ...roll, terms: [] } })).toBeNull();
    expect(dieFaceOf({ ...message, roll: null })).toBeNull();
  });

  test("resolveDefenderFromDerived carries the defense trio, the DR entry and only nonzero ER", () => {
    const derived = derivePF1eActor({
      system: {
        abilities: { dex: 14, con: 12 },
        hp: 12,
        hpMax: 12,
        armorClass: { armor: 4 },
        dr: 5,
        drBypass: ["magic"],
        energyResistance: { fire: 10, cold: 0 },
      },
    });
    const defender = resolveDefenderFromDerived("Goblin", derived);
    expect(defender).toMatchObject({
      name: "Goblin",
      ac: { normal: 16, touch: 12, flatFooted: 14 },
      hp: 12,
      hpMax: 12,
      conScore: 12,
      dr: [{ value: 5, bypass: ["magic"] }],
      energyResistance: { fire: 10 },
    });
    expect(Object.keys(defender.energyResistance ?? {})).toEqual(["fire"]);
  });

  test("resolutionCardContent renders chips, condition notes and the verification verdict", () => {
    const derived = derivePF1eActor({
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
          },
        ],
      },
    });
    const result: PF1eResolveResult = {
      ok: true,
      outcome: "crit",
      attackTotal: 28,
      attackBonus: 9,
      situationalDelta: 2,
      intentPenalty: 0,
      defenseUsed: "normal",
      defenseAc: 16,
      threat: true,
      confirmed: true,
      damage: {
        rolled: 20,
        minimumApplied: false,
        dealt: 20,
        lethal: 20,
        nonlethal: 0,
        drApplied: 0,
        drBypassedVia: null,
        convertedToLethal: 0,
        notes: [],
      },
      hp: { before: 12, after: -8 },
      nonlethal: { before: 0, after: 0 },
      conditionNotes: [
        "unconscious and dying (below 0 HP, loses 1 HP per round — the stable/dying bookkeeping is P7)",
      ],
      notes: ["flanking: +2 on the attack roll"],
      provokes: false,
    };
    void derived;
    const card = resolutionCardContent(
      {
        attackerName: "Fighter",
        targetName: "Goblin",
        label: "Longsword",
        attackFormula: "1d20 + 9",
        damageFormula: "1d8 + 6 + 1d8 + 6",
        defense: "normal",
      },
      result,
      null,
      true,
    );
    expect(card.content).toContain("[[28|1d20 + 9]] CRITS!");
    expect(card.content).toContain("[[20|1d8 + 6 + 1d8 + 6]] damage dealt");
    expect(card.content).toContain("Goblin 12 → -8 HP");
    expect(card.content).toContain("Goblin is unconscious and dying");
    expect(card.content).toContain("✓ verified");
  });
});
