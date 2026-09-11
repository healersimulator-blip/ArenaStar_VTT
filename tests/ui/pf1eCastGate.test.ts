import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  Json,
  MessageDocument,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type { PermissionUser } from "../../src/core/ownership";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import {
  resolveCastFlow,
  type CastFlowClient,
  type PF1eCastFlowParams,
} from "../../src/ui/sheets/pf1eCastFlow";

const owner: PermissionUser = { id: "player", role: "PLAYER" };

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

/**
 * Int 16 prepared wizard: level-1 DC 14, caster level 5, concentration
 * +8 (CL 5 + Int 3). Defensive-casting DC for a level-1 spell is 17.
 */
function wizardActor(pf1e: Record<string, Json> = {}): ActorDocument {
  return actor("wizard", {
    abilities: { int: 16 },
    spells: {
      keyAbility: "int",
      mode: "prepared",
      casterLevel: 5,
      slotsPerDay: { 1: 4 },
      prepared: [{ name: "Shield", level: 1, components: "V, S" }],
    },
    ...pf1e,
  });
}

function targetActor(): ActorDocument {
  return actor("ogre", {
    abilities: { con: 14 },
    hp: 20,
    hpMax: 20,
    saves: { fort: 2, ref: 0, will: 1 },
  });
}

/** Scripted host rolls in call order; `die` is the first kept face. */
class FakeClient implements CastFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  script: Array<{ die?: number; total?: number }> = [];
  private seq = 0;
  readonly store = {
    getAll: (coll: "messages"): readonly unknown[] =>
      coll === "messages" ? this.messages : [],
  };

  roll(formula: string): string {
    this.formulas.push(formula);
    const rollId = `r${this.seq++}`;
    const entry = this.script.shift() ?? {};
    const die = entry.die ?? 10;
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
        total: entry.total ?? die,
        terms: [
          {
            kind: "dice",
            expr: formula,
            rolls: [die],
            kept: [die],
            total: die,
          },
        ],
        seedClient: null,
        seedHost: null,
        commit: null,
      },
      flavor: "",
    });
    return rollId;
  }

  submit(ops: Op[]): string {
    this.submitted.push(ops);
    return "tx";
  }
}

function params(
  client: FakeClient,
  overrides: Partial<PF1eCastFlowParams> = {},
): PF1eCastFlowParams {
  const caster = wizardActor();
  const target = targetActor();
  void client;
  return {
    casterActor: caster,
    casterDerived: deriveFromDocuments({ actor: caster }),
    spell: { name: "Shield", level: 1, preparedIndex: 0 },
    authored: { saveType: "ref", severity: "none", damageFormula: "" },
    targetName: "ogre",
    targetActor: target,
    targetDerived: deriveFromDocuments({ actor: target }),
    gate: {
      components: "V, S",
      caster: {
        canSpeak: true,
        hasFreeHand: true,
        componentsInHand: true,
      },
      castingTime: "standard",
    },
    ...overrides,
  };
}

/** The card content of the first submitted message op. */
function cardContent(client: FakeClient): string {
  const create = client.submitted
    .flat()
    .find((op) => op.kind === "create" && op.coll === "messages");
  if (create?.kind !== "create") return "";
  return String((create.data as MessageDocument).content ?? "");
}

function stateOps(client: FakeClient): Op[] {
  return client.submitted.flatMap((batch) => batch);
}

describe("P5/C03a casting gate in the cast flow (D-157)", () => {
  test("an illegal casting is refused by name, rolls nothing and spends nothing", async () => {
    const client = new FakeClient();
    const p = params(client);
    if (p.gate) p.gate.caster = { ...p.gate.caster, canSpeak: false };
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot speak/i);
    expect(client.formulas).toEqual([]);
    expect(client.submitted).toEqual([]);
  });

  test("a pinned caster cannot cast a spell with a somatic component", async () => {
    const client = new FakeClient();
    const p = params(client);
    if (p.gate) p.gate.caster = { ...p.gate.caster, pinned: true };
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/pinned/i);
    expect(client.formulas).toEqual([]);
  });

  test("grappling refuses casting times longer than one standard action", async () => {
    const client = new FakeClient();
    const p = params(client);
    if (p.gate) {
      p.gate.caster = { ...p.gate.caster, grappled: true };
      p.gate.castingTime = "full-round";
    }
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/grappling/i);
  });

  test("a malformed components line is a named refusal", async () => {
    const client = new FakeClient();
    const p = params(client);
    if (p.gate) p.gate.components = "V, Z9";
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/components/i);
    expect(client.formulas).toEqual([]);
    expect(client.submitted).toEqual([]);
  });

  test("arcane spell failure ruins the spell: the slot is spent but nothing is rolled after", async () => {
    const caster = wizardActor({ armor: { spellFailure: 30 } });
    const client = new FakeClient();
    // 1d100 = 12 <= 30% → the spell is ruined.
    client.script = [{ die: 12 }];
    const p = params(client, {
      casterActor: caster,
      casterDerived: deriveFromDocuments({ actor: caster }),
    });
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    if (!res.lost) return;
    // Only the gate's d100 rolled — no damage, SR check or save.
    expect(client.formulas).toEqual(["1d100"]);
    expect(res.gateNotes.join(" ")).toMatch(/arcane spell failure/i);
    // The card says the spell is ruined…
    expect(cardContent(client)).toMatch(/loses Shield/i);
    expect(cardContent(client)).toMatch(/ruined/i);
    // …and the slot spend + prepared expense still landed.
    const updates = stateOps(client).filter((op) => op.kind === "update");
    expect(updates.length).toBeGreaterThan(0);
    const slotSpent = updates.some((op) => {
      if (op.kind !== "update") return false;
      const diff = op.diff as Record<string, unknown>;
      if (diff["system.pf1e.spells.slotsUsed.1"] === 1) return true;
      const whole = diff["system.pf1e.spells.slotsUsed"];
      return (
        typeof whole === "object" &&
        whole !== null &&
        (whole as Record<string, unknown>)["1"] === 1
      );
    });
    expect(slotSpent).toBe(true);
    const expended = updates.some((op) => {
      if (op.kind !== "update") return false;
      const diff = op.diff as Record<string, unknown>;
      const prepared = diff["system.pf1e.spells.prepared"];
      return (
        Array.isArray(prepared) &&
        (prepared[0] as Record<string, unknown>)?.expended === true
      );
    });
    expect(expended).toBe(true);
  });

  test("a passed arcane spell failure check lets the cast continue", async () => {
    const caster = wizardActor({ armor: { spellFailure: 30 } });
    const client = new FakeClient();
    client.script = [{ die: 87 }, { die: 4, total: 6 }];
    const p = params(client, {
      casterActor: caster,
      casterDerived: deriveFromDocuments({ actor: caster }),
      authored: { saveType: "ref", severity: "none", damageFormula: "1d6" },
    });
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    if (res.pending) return;
    // d100 first, then the effect roll.
    expect(client.formulas).toEqual(["1d100", "1d6"]);
    expect(res.result.dealt).toBe(6);
  });

  test("armour never applies arcane spell failure to a spell without a somatic component", async () => {
    const caster = wizardActor({ armor: { spellFailure: 30 } });
    const client = new FakeClient();
    const p = params(client, {
      casterActor: caster,
      casterDerived: deriveFromDocuments({ actor: caster }),
    });
    if (p.gate) p.gate.components = "V";
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    // No d100: the gate rolled nothing for a harmless, no-save spell.
    expect(client.formulas).toEqual([]);
  });

  test("a divine caster's armour causes no arcane spell failure", async () => {
    const caster = wizardActor({
      armor: { spellFailure: 30 },
      spells: {
        keyAbility: "int",
        mode: "prepared",
        casterLevel: 5,
        tradition: "divine",
        slotsPerDay: { 1: 4 },
        prepared: [{ name: "Shield", level: 1, components: "V, S" }],
      },
    });
    const client = new FakeClient();
    const res = await resolveCastFlow(
      client,
      owner,
      params(client, {
        casterActor: caster,
        casterDerived: deriveFromDocuments({ actor: caster }),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    expect(client.formulas).toEqual([]);
  });

  test("a deafened caster's spoiled verbal component loses the spell", async () => {
    const client = new FakeClient();
    // 1d100 = 7 <= 20% → spoiled.
    client.script = [{ die: 7 }];
    const p = params(client);
    if (p.gate) p.gate.caster = { ...p.gate.caster, deafened: true };
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    if (!res.lost) return;
    expect(client.formulas).toEqual(["1d100"]);
    expect(res.gateNotes.join(" ")).toMatch(/deafened/i);
    expect(cardContent(client)).toMatch(/loses Shield/i);
  });

  test("a deafened caster keeps the spell on a high spoilage roll", async () => {
    const client = new FakeClient();
    client.script = [{ die: 79 }];
    const p = params(client);
    if (p.gate) p.gate.caster = { ...p.gate.caster, deafened: true };
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
  });

  test("a failed defensive-casting concentration check loses the spell", async () => {
    const client = new FakeClient();
    // DC 15 + 2×1 = 17; d20 1 + 8 = 9 → fails.
    client.script = [{ die: 1 }];
    const p = params(client);
    if (p.gate) p.gate.declarations = [{ situation: "castDefensively" }];
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    if (!res.lost) return;
    expect(client.formulas).toEqual(["1d20"]);
    expect(res.gateNotes.join(" ")).toMatch(/concentration failed/i);
    // The ruined spell still spends its slot.
    const updates = stateOps(client).filter((op) => op.kind === "update");
    expect(updates.length).toBeGreaterThan(0);
  });

  test("a passed defensive-casting check continues into the effect rolls", async () => {
    const client = new FakeClient();
    // DC 17; d20 20 + 8 passes — then the spell's own damage rolls.
    client.script = [{ die: 20 }, { die: 3, total: 5 }];
    const p = params(client, {
      authored: { saveType: "ref", severity: "none", damageFormula: "1d6" },
    });
    if (p.gate) p.gate.declarations = [{ situation: "castDefensively" }];
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    if (res.pending) return;
    expect(client.formulas).toEqual(["1d20", "1d6"]);
    expect(res.result.dealt).toBe(5);
  });

  test("the injured-while-casting trigger uses 10 + damage dealt + spell level", async () => {
    const client = new FakeClient();
    // DC 10 + 4 + 1 = 15; d20 2 + 8 = 10 → fails → lost.
    client.script = [{ die: 2 }];
    const p = params(client);
    if (p.gate) p.gate.declarations = [{ situation: "injured", damage: 4 }];
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    if (!res.lost) return;
    expect(res.gateNotes.join(" ")).toMatch(/injured \(10 vs DC 15\)/);
  });

  test("a divine M/DF line needs the focus in hand; the arcane reading needs materials", async () => {
    const divine = wizardActor({
      spells: {
        keyAbility: "int",
        mode: "prepared",
        casterLevel: 5,
        tradition: "divine",
        slotsPerDay: { 1: 4 },
        prepared: [{ name: "Shield", level: 1, components: "M/DF" }],
      },
    });
    const client = new FakeClient();
    const p = params(client, {
      casterActor: divine,
      casterDerived: deriveFromDocuments({ actor: divine }),
    });
    if (p.gate) {
      p.gate.components = "M/DF";
      p.gate.caster = { ...p.gate.caster, componentsInHand: false };
    }
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/components not in hand/i);
    expect(client.formulas).toEqual([]);
  });

  test("an empty components line skips the gate entirely", async () => {
    const client = new FakeClient();
    const p = params(client);
    if (p.gate) p.gate.components = "   ";
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    expect(res.gateNotes).toEqual([]);
    expect(client.formulas).toEqual([]);
  });
});

describe("P5/C03 Table 9-1 concentration triggers in the gate (D-160)", () => {
  // Wizard: CL 5, Int +3 → concentration +8; spell level 1.

  async function castWith(
    declarations: PF1eCastFlowParams["gate"] extends infer G
      ? G extends { declarations?: infer D }
        ? D
        : never
      : never,
    script: Array<{ die?: number; total?: number }>,
  ) {
    const client = new FakeClient();
    client.script = script;
    const p = params(client);
    if (p.gate) p.gate.declarations = declarations;
    const res = await resolveCastFlow(client, owner, p);
    return { client, res };
  }

  test("a failed vigorous-motion check loses the spell", async () => {
    // DC 11; d20 1 + 8 = 9 → fail.
    const { client, res } = await castWith(
      [{ situation: "vigorousMotion" }],
      [{ die: 1 }],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    expect(client.formulas).toEqual(["1d20"]);
    expect(res.gateNotes.join(" ")).toMatch(
      /concentration failed on vigorousMotion \(9 vs DC 11\)/,
    );
  });

  test("a passed violent-motion check lets the spell land", async () => {
    // DC 16; d20 10 + 8 = 18 → pass.
    const { client, res } = await castWith(
      [{ situation: "violentMotion" }],
      [{ die: 10 }],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    expect(client.formulas).toEqual(["1d20"]);
  });

  test("continuous damage uses half the damage in the DC", async () => {
    // damage 12 → DC 10 + 6 + 1 = 17; d20 8 + 8 = 16 → fail.
    const { res } = await castWith(
      [{ situation: "continuousDamage", damage: 12 }],
      [{ die: 8 }],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    expect(res.gateNotes.join(" ")).toMatch(/16 vs DC 17/);
  });

  test("a distracting non-damaging spell adds its DC to the spell level", async () => {
    // spell DC 15 → 16; d20 12 + 8 = 20 → pass.
    const { res } = await castWith(
      [{ situation: "nonDamagingSpell", spellDc: 15 }],
      [{ die: 12 }],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
  });

  test("grappling uses the grappler's CMB in the DC", async () => {
    // CMB 12 → DC 10 + 12 + 1 = 23; d20 20 + 8 = 28 → pass.
    const { res } = await castWith(
      [{ situation: "grappledOrPinned", grapplerCmb: 12 }],
      [{ die: 20 }],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
  });

  test("wind and entangled triggers each get their own d20", async () => {
    // windHailDebris DC 11 (pass: 5+8=13), entangled DC 16 (fail: 2+8=10).
    const { client, res } = await castWith(
      [{ situation: "windHailDebris" }, { situation: "entangled" }],
      [{ die: 5 }, { die: 2 }],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    expect(client.formulas).toEqual(["1d20", "1d20"]);
    expect(res.gateNotes.join(" ")).toMatch(
      /concentration failed on entangled \(10 vs DC 16\)/,
    );
  });

  test("a lost concentration check still spends the slot", async () => {
    const { client, res } = await castWith(
      [{ situation: "extremelyViolentMotion" }],
      [{ die: 1 }], // DC 21; 1+8=9 → fail
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    const updates = stateOps(client).filter((op) => op.kind === "update");
    expect(updates.length).toBeGreaterThan(0);
  });
});
