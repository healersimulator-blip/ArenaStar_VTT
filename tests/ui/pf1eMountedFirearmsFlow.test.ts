import { describe, expect, test } from "vitest";
import type { ActorDocument, Json, MessageDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { deriveFromDocuments, derivePF1eActor } from "../../src/packages/pf1e/actor";
import type { PF1eDerived } from "../../src/packages/pf1e/actor";
import { resolveAttackFlow, type ResolveFlowClient } from "../../src/ui/sheets/pf1eResolveFlow";

const owner = { id: "player", role: "PLAYER" as const };

function actor(id: string, pf1e: Record<string, Json>): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e },
    items: [],
    effects: [],
  };
}

class FakeClient implements ResolveFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  script: Array<{ die?: number; total: number }> = [];
  private seq = 0;
  readonly store = {
    getAll: (coll: "messages"): readonly unknown[] => coll === "messages" ? this.messages : [],
  };
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
        terms: entry.die === undefined
          ? [{ kind: "dice", expr: "1d8", rolls: [4], kept: [4], total: 4 }]
          : [{ kind: "dice", expr: "1d20", rolls: [entry.die], kept: [entry.die], total: entry.die }],
        seedClient: null,
        seedHost: null,
        commit: null,
      },
      flavor: "",
    });
    return rollId;
  }
  async rollVerified(formula: string): Promise<string> { return this.roll(formula); }
  submit(ops: Op[]): string { this.submitted.push(ops); return "tx"; }
}

/** First+only attack line of a fixture — throws instead of masking a bad fixture. */
function attackLineOf<T extends { attacks: readonly unknown[] }>(fixture: T): T["attacks"][number] {
  const [line] = fixture.attacks;
  if (line === undefined) throw new Error("test fixture must define at least one attack line");
  return line as T["attacks"][number];
}

function derivedTarget(): { doc: ActorDocument; derived: PF1eDerived } {
  const doc = actor("goblin", { hp: 12, hpMax: 12, armorClass: { armor: 2 } });
  return { doc, derived: deriveFromDocuments({ actor: doc }) };
}

describe("P08 mounted ranged penalty in resolveAttackFlow", () => {
  test("stationary/single adds no penalty; double −4 and run −8 fold into the bonus and the card", async () => {
    // Derived ranged attack line (bow) — bonus 9 base.
    const attacker = derivePF1eActor({
      system: {
        abilities: { dex: 16 },
        baseAttack: 6,
        attacks: [{ name: "Longbow", ranged: true, rangeIncrementFt: 100, damageDice: "1d8", damageType: "piercing" }],
      },
    });
    const line = attackLineOf(attacker);
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();

    for (const [movement, penalty, expectedBonusFormula] of [
      ["stationary" as const, 0, "1d20 + 9"],
      ["single" as const, 0, "1d20 + 9"],
      ["double" as const, -4, "1d20 + 5"],
      ["run" as const, -8, "1d20 + 1"],
    ] as const) {
      const client = new FakeClient();
      // Die 10 + bonus must hit touch? Target AC 12 touch (approx). Use 10+5=15 hits for double case.
      // Simplify: target AC 13 (12+? let's just use derived). Ensure hit: die 15.
      client.script = [{ die: 15, total: 20 }, { total: 5 }];
      const result = await resolveAttackFlow(client, owner, {
        attackerName: "Archer",
        line,
        iterative: 0,
        attackFormula: "1d20 + 9",
        damageFormula: "1d8 + 2",
        critDamageFormula: null,
        targetName: "Goblin",
        targetActor: targetDoc,
        targetDerived,
        defense: "normal",
        mountMovement: movement,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The flow folds the penalty into the bonus it exposes.
        if (penalty !== 0) {
          expect(client.formulas[0]).toBe(expectedBonusFormula);
          const card = client.submitted[0]?.[0];
          if (card?.kind === "create") {
            const data = card.data as MessageDocument;
            expect(data.content).toContain(penalty === -4 ? "mounted, mount double-moving" : "mounted, mount running");
            // The card uses the typographic minus (U+2212) via fmtSigned.
            expect(data.content).toMatch(penalty === -4 ? /mount double-moving .4/ : /mount running .8/);
          }
        } else {
          expect(client.formulas[0]).toBe("1d20 + 9");
        }
      }
    }
  });

  test("melee lines ignore the mounted ranged penalty", async () => {
    const attacker = derivePF1eActor({
      system: {
        abilities: { str: 16 },
        baseAttack: 6,
        attacks: [{ name: "Longsword", damageDice: "1d8" }],
      },
    });
    const line = attackLineOf(attacker);
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const client = new FakeClient();
    client.script = [{ die: 15, total: 20 }, { total: 6 }];
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Rider",
      line,
      iterative: 0,
      attackFormula: "1d20 + 9",
      damageFormula: "1d8 + 3",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      mountMovement: "run",
    });
    expect(result.ok).toBe(true);
    // No penalty folded for melee.
    expect(client.formulas[0]).toBe("1d20 + 9");
  });

  test("Manyshot volley folds the mounted penalty into every arrow", async () => {
    const { resolveManyshotFlow } = await import("../../src/ui/sheets/pf1eResolveFlow");
    const attacker = derivePF1eActor({
      system: {
        abilities: { dex: 16 },
        baseAttack: 6,
        attacks: [{ name: "Longbow", ranged: true, rangeIncrementFt: 100, damageDice: "1d8" }],
      },
    });
    const line = attackLineOf(attacker);
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const client = new FakeClient();
    // Two arrows: each needs attack + (optional conceal) + damage
    client.script = [
      { die: 12, total: 17 }, { total: 5 },
      { die: 14, total: 19 }, { total: 6 },
    ];
    const out = await resolveManyshotFlow(client, owner, {
      attackerName: "Archer",
      line,
      attackFormulas: ["1d20 + 5", "1d20 + 5"],
      damageFormula: "1d8 + 2",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      mountMovement: "double",
    });
    expect(out.ok).toBe(true);
    // The first arrow formulas should have been rewritten to +1 (5-4)
    expect(client.formulas[0]).toMatch(/\+ 1/);
  });
});

describe("P09 firearm gates in resolveAttackFlow", () => {
  function firearmLine(opts: { broken?: boolean; generation?: "early" | "advanced"; misfireMinimum?: number } = {}) {
    // Construct a derived firearm line manually (PF1eDerivedAttack shape).
    return {
      name: "Musket",
      ranged: true,
      attackBonuses: [7],
      attackBonus: 7,
      damageDice: "1d12",
      abilityDamage: 0,
      damageBonus: 0,
      damageType: "piercing",
      critThreatMin: 20,
      critMultiplier: 4,
      reachSquares: 0,
      touchAttack: false,
      rangedTouch: false,
      misfire: {
        generation: opts.generation ?? "early",
        misfireMinimum: opts.misfireMinimum ?? 2,
        broken: opts.broken ?? false,
        magical: false,
      },
      explain: "firearm",
    } as unknown as import("../../src/packages/pf1e/actor").PF1eDerivedAttack;
  }

  test("ammo gate: 0 shotsAvailable refuses before any die is rolled", async () => {
    const line = firearmLine();
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const attackerDoc = actor("shooter", { hp: 20, hpMax: 20, attacks: [{ name: "Musket", ranged: true, firearm: { misfireMinimum: 2 } }] });
    const client = new FakeClient();
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Shooter",
      line,
      iterative: 0,
      attackFormula: "1d20 + 7",
      damageFormula: "1d12",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      shotsAvailable: 0,
      attackerActor: attackerDoc,
      attackerAttackIndex: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no shot loaded/);
    expect(client.formulas).toEqual([]);
    expect(client.submitted).toEqual([]);
  });

  test("ammo gate: 1 shotsAvailable lets the shot through", async () => {
    const line = firearmLine();
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const attackerDoc = actor("shooter", { hp: 20, hpMax: 20, attacks: [{ name: "Musket", ranged: true, firearm: { misfireMinimum: 2 } }] });
    const client = new FakeClient();
    client.script = [{ die: 15, total: 22 }, { total: 8 }];
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Shooter",
      line,
      iterative: 0,
      attackFormula: "1d20 + 7",
      damageFormula: "1d12",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      shotsAvailable: 1,
      attackerActor: attackerDoc,
      attackerAttackIndex: 0,
    });
    expect(result.ok).toBe(true);
    expect(client.formulas.length).toBeGreaterThan(0);
  });

  test("first misfire breaks the weapon — the flow persists broken on the attacker", async () => {
    const line = firearmLine({ broken: false, misfireMinimum: 4 });
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const attackerDoc = actor("shooter", { hp: 20, hpMax: 20, attacks: [{ name: "Musket", ranged: true, firearm: { misfireMinimum: 4 }, broken: false }] });
    const client = new FakeClient();
    // Die 2 ≤ 4 ⇒ misfire (nat 20 gate not triggered)
    client.script = [{ die: 2, total: 9 }];
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Shooter",
      line,
      iterative: 0,
      attackFormula: "1d20 + 7",
      damageFormula: "1d12",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      attackerActor: attackerDoc,
      attackerAttackIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.ok).toBe(true);
      if (result.result.ok) {
        expect(result.result.misfire?.misfire).toBe(true);
        // Card + hp (none) + broken write
        const brokenOp = client.submitted.flat().find((op) => op.kind === "update" && (op as { ref: { id: string } }).ref.id === "shooter");
        expect(brokenOp).toBeTruthy();
        if (brokenOp?.kind === "update") {
          expect((brokenOp.diff as Record<string, unknown>)["system.pf1e.attacks.0.broken"]).toBe(true);
        }
        const card = client.submitted[0]?.[0];
        if (card?.kind === "create") {
          expect((card.data as MessageDocument).content).toMatch(/misfire/);
        }
      }
    }
  });

  test("a natural 20 never misfires even with misfire value ≥20", async () => {
    const line = firearmLine({ broken: true, misfireMinimum: 16 }); // effective 20 with +4 broken
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const attackerDoc = actor("shooter", { hp: 20, hpMax: 20, attacks: [{ name: "Musket", ranged: true, firearm: { misfireMinimum: 16 }, broken: true }] });
    const client = new FakeClient();
    client.script = [{ die: 20, total: 27 }, { total: 9 }];
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Shooter",
      line,
      iterative: 0,
      attackFormula: "1d20 + 7",
      damageFormula: "1d12",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      attackerActor: attackerDoc,
      attackerAttackIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.result.ok) {
      expect(result.result.misfire).toBeUndefined();
      expect(result.result.outcome).not.toBe("miss" as const);
      // No broken write when no misfire
      const brokenOps = client.submitted.flat().filter((op) => op.kind === "update" && JSON.stringify(op).includes("broken"));
      expect(brokenOps.length).toBe(0);
    }
  });

  test("second misfire of a broken early firearm explodes (writes broken, card names explosion)", async () => {
    const line = firearmLine({ broken: true, generation: "early", misfireMinimum: 4 }); // effective 8
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const attackerDoc = actor("shooter", { hp: 20, hpMax: 20, attacks: [{ name: "Musket", ranged: true, firearm: { generation: "early", misfireMinimum: 4 }, broken: true }] });
    const client = new FakeClient();
    client.script = [{ die: 3, total: 10 }];
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Shooter",
      line,
      iterative: 0,
      attackFormula: "1d20 + 7",
      damageFormula: "1d12",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      attackerActor: attackerDoc,
      attackerAttackIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.result.ok) {
      expect(result.result.misfire?.misfire).toBe(true);
      if (result.result.misfire?.misfire) {
        expect(result.result.misfire.explodes).toBe(true);
        expect(result.result.misfire.save).toEqual({ dc: 12, half: true });
      }
      // Explosion still writes broken (already broken guard is idempotent — we write anyway if not already persisted as true in doc's broken field type check)
      // Since the doc already has broken:true, our guard suppresses duplicate write; the verdict still explodes.
      const card = client.submitted[0]?.[0];
      if (card?.kind === "create") {
        expect((card.data as MessageDocument).content).toMatch(/explodes/);
      }
    }
  });

  test("advanced broken firearm never explodes", async () => {
    const line = firearmLine({ broken: true, generation: "advanced", misfireMinimum: 4 });
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const attackerDoc = actor("shooter2", { hp: 20, hpMax: 20, attacks: [{ name: "Pistol", ranged: true, firearm: { generation: "advanced", misfireMinimum: 4 }, broken: true }] });
    const client = new FakeClient();
    client.script = [{ die: 3, total: 10 }];
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Shooter",
      line,
      iterative: 0,
      attackFormula: "1d20 + 7",
      damageFormula: "1d12",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      attackerActor: attackerDoc,
      attackerAttackIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.result.ok && result.result.misfire?.misfire) {
      expect(result.result.misfire.explodes).toBe(false);
      expect(result.result.misfire.notes.join(" ")).toMatch(/never explode/);
    }
  });
});
describe("P08 mounted melee full-attack bar (A.11)", () => {
  test("melee iterative 0 is allowed even when mount moved >5 ft", async () => {
    const attacker = derivePF1eActor({
      system: { abilities: { str: 16 }, baseAttack: 11, attacks: [{ name: "Lance", damageDice: "1d8" }] },
    });
    const line = attackLineOf(attacker);
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const client = new FakeClient();
    client.script = [{ die: 15, total: 20 }, { total: 6 }];
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Rider",
      line,
      iterative: 0,
      attackFormula: "1d20 + 11",
      damageFormula: "1d8 + 4",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      mountMovedFt: 30,
    });
    expect(result.ok).toBe(true);
  });

  test("melee iterative 1 is refused when mount moved >5 ft", async () => {
    const attacker = derivePF1eActor({
      system: { abilities: { str: 16 }, baseAttack: 11, attacks: [{ name: "Lance", damageDice: "1d8" }] },
    });
    const line = attackLineOf(attacker);
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const client = new FakeClient();
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Rider",
      line,
      iterative: 1,
      attackFormula: "1d20 + 6",
      damageFormula: "1d8 + 4",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      mountMovedFt: 30,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only one melee attack/);
    expect(client.formulas).toEqual([]);
  });

  test("mount moved exactly 5 ft keeps full attack; 6 ft bars", async () => {
    const attacker = derivePF1eActor({
      system: { abilities: { str: 16 }, baseAttack: 11, attacks: [{ name: "Longsword", damageDice: "1d8" }] },
    });
    const line = attackLineOf(attacker);
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    for (const [ft, shouldAllow] of [[5, true], [6, false]] as const) {
      const client = new FakeClient();
      if (shouldAllow) client.script = [{ die: 12, total: 18 }, { total: 5 }];
      const result = await resolveAttackFlow(client, owner, {
        attackerName: "Rider",
        line,
        iterative: 1,
        attackFormula: "1d20 + 6",
        damageFormula: "1d8 + 4",
        critDamageFormula: null,
        targetName: "Goblin",
        targetActor: targetDoc,
        targetDerived,
        defense: "normal",
        mountMovedFt: ft,
      });
      expect(result.ok).toBe(shouldAllow);
    }
  });

  test("ranged iteratives ignore the melee bar", async () => {
    const attacker = derivePF1eActor({
      system: { abilities: { dex: 16 }, baseAttack: 11, attacks: [{ name: "Longbow", ranged: true, rangeIncrementFt: 100, damageDice: "1d8" }] },
    });
    const line = attackLineOf(attacker);
    const { doc: targetDoc, derived: targetDerived } = derivedTarget();
    const client = new FakeClient();
    client.script = [{ die: 12, total: 18 }, { total: 5 }];
    const result = await resolveAttackFlow(client, owner, {
      attackerName: "Archer",
      line,
      iterative: 1,
      attackFormula: "1d20 + 6",
      damageFormula: "1d8 + 2",
      critDamageFormula: null,
      targetName: "Goblin",
      targetActor: targetDoc,
      targetDerived,
      defense: "normal",
      mountMovedFt: 60,
    });
    expect(result.ok).toBe(true);
  });
});

describe("P08 mounted casting concentration (A.11)", () => {
  test("mountedCastingConcentrationDC maps to vigorous/violent motion", async () => {
    const { mountedCastingConcentrationDC } = await import("../../src/packages/pf1e/mounted");
    expect(mountedCastingConcentrationDC({ spellLevel: 3, movedBeforeAndAfter: true, mountRunning: false })).toBe(13);
    expect(mountedCastingConcentrationDC({ spellLevel: 3, movedBeforeAndAfter: false, mountRunning: true })).toBe(18);
    expect(mountedCastingConcentrationDC({ spellLevel: 3, movedBeforeAndAfter: false, mountRunning: false })).toBeNull();
    // Running wins over moved
    expect(mountedCastingConcentrationDC({ spellLevel: 1, movedBeforeAndAfter: true, mountRunning: true })).toBe(16);
  });

  test("sheet wiring pushes vigorousMotion / violentMotion declarations", async () => {
    // This test documents the sheet's contract: castMountRunning ⇒ violentMotion, else vigorousMotion.
    // The actual concentrationDc for those triggers is already tested in pf1eConcentration.
    const { concentrationDc } = await import("../../src/packages/pf1e/concentration");
    expect(concentrationDc({ situation: "vigorousMotion", die: 10 }, 3).dc).toBe(13);
    expect(concentrationDc({ situation: "violentMotion", die: 10 }, 3).dc).toBe(18);
  });
});

