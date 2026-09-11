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
  resolveTouchDelivery,
  type CastFlowClient,
  type PF1eCastFlowParams,
  type PF1eTouchDeliveryParams,
} from "../../src/ui/sheets/pf1eCastFlow";

const owner: PermissionUser = { id: "player", role: "PLAYER" };
const stranger: PermissionUser = { id: "other", role: "PLAYER" };

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

/** Str 12 / Dex 18, BAB +2: melee touch +3, ranged touch +6. */
function touchWizard(pf1e: Record<string, Json> = {}): ActorDocument {
  return actor("wizard", {
    abilities: { str: 12, dex: 18, int: 16 },
    baseAttack: 2,
    spells: {
      keyAbility: "int",
      mode: "prepared",
      casterLevel: 5,
      slotsPerDay: { 0: 3, 1: 4 },
      prepared: [{ name: "Shocking Grasp", level: 1 }],
    },
    ...pf1e,
  });
}

/** Dex 8 (−1), Medium: touch AC 9. */
function ogre(): ActorDocument {
  return actor("ogre", {
    abilities: { dex: 8, con: 14 },
    hp: 20,
    hpMax: 20,
    saves: { fort: 2, ref: 0, will: 1 },
  });
}

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

function castParams(
  caster: ActorDocument,
  overrides: Partial<PF1eCastFlowParams> = {},
): PF1eCastFlowParams {
  const target = ogre();
  return {
    casterActor: caster,
    casterDerived: deriveFromDocuments({ actor: caster }),
    spell: { name: "Shocking Grasp", level: 1, preparedIndex: 0 },
    authored: { saveType: "ref", severity: "none", damageFormula: "1d6" },
    targetName: "ogre",
    targetActor: target,
    targetDerived: deriveFromDocuments({ actor: target }),
    ...overrides,
  };
}

function deliveryParams(
  caster: ActorDocument,
  overrides: Partial<PF1eTouchDeliveryParams> = {},
): PF1eTouchDeliveryParams {
  const target = ogre();
  return {
    casterActor: caster,
    casterDerived: deriveFromDocuments({ actor: caster }),
    targetName: "ogre",
    targetActor: target,
    targetDerived: deriveFromDocuments({ actor: target }),
    ...overrides,
  };
}

function stateOps(client: FakeClient): Op[] {
  return client.submitted.flatMap((batch) => batch);
}

function cardContent(client: FakeClient): string {
  const create = client.submitted
    .flat()
    .find((op) => op.kind === "create" && op.coll === "messages");
  if (create?.kind !== "create") return "";
  return String((create.data as MessageDocument).content ?? "");
}

describe("P5/C03 touch spells in the cast flow (D-158)", () => {
  test("a melee touch attack that hits delivers the effect", async () => {
    const client = new FakeClient();
    // Touch d20 6 + 3 = 9 vs touch AC 9 → hit; damage 1d6 = 4.
    client.script = [{ die: 6 }, { die: 4, total: 4 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost || res.held) return;
    expect(res.touch).toEqual({
      kind: "melee",
      total: 9,
      hit: true,
      threat: false,
    });
    expect(res.result.dealt).toBe(4);
    expect(client.formulas).toEqual(["1d20", "1d6"]);
    expect(cardContent(client)).toMatch(/touch attack \[\[9\|1d20 \+ 3\]\]/);
  });

  test("a melee touch miss spends the slot and holds the charge", async () => {
    const client = new FakeClient();
    // Touch d20 5 + 3 = 8 vs touch AC 9 → miss.
    client.script = [{ die: 5 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.held).toBe(true);
    if (!res.held) return;
    expect(res.touch).toEqual({
      kind: "melee",
      total: 8,
      hit: false,
      threat: false,
    });
    expect(res.touchAc).toBe(9);
    // Only the touch attack rolled — no damage, SR or save.
    expect(client.formulas).toEqual(["1d20"]);
    // The slot is spent even though the touch missed.
    const updates = stateOps(client).filter((op) => op.kind === "update");
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
    // The charge is written to the caster.
    const heldWrite = updates.find((op) => {
      if (op.kind !== "update") return false;
      const diff = op.diff as Record<string, unknown>;
      return diff["system.pf1e.heldCharge"] !== undefined;
    });
    expect(heldWrite).toBeDefined();
    const charge = (heldWrite as Extract<Op, { kind: "update" }>).diff[
      "system.pf1e.heldCharge"
    ] as Record<string, unknown>;
    expect(charge.name).toBe("Shocking Grasp");
    expect(charge.level).toBe(1);
    expect(charge.damageFormula).toBe("1d6");
    expect(cardContent(client)).toMatch(/charge is held/i);
  });

  test("a natural 20 on the touch attack threatens a critical", async () => {
    const client = new FakeClient();
    client.script = [{ die: 20 }, { die: 5, total: 5 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost || res.held) return;
    expect(res.touch?.threat).toBe(true);
    expect(cardContent(client)).toMatch(/threatens a critical/i);
  });

  test("a ranged touch attack rides the cast and cannot be held on a miss", async () => {
    const client = new FakeClient();
    // Ranged: d20 1 + 6 = 7 vs touch AC 9 → miss → spent, not held.
    client.script = [{ die: 1 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, {
        touch: "ranged",
        spell: { name: "Ray of Frost", level: 0 },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    expect(res.held).toBe(false);
    if (!res.lost) return;
    expect(res.touch).toEqual({
      kind: "ranged",
      total: 7,
      hit: false,
      threat: false,
    });
    expect(client.formulas).toEqual(["1d20"]);
    expect(res.warnings.join(" ")).toMatch(/cannot be held/i);
    // No held-charge write.
    const heldWrite = stateOps(client).find((op) => {
      if (op.kind !== "update") return false;
      const diff = op.diff as Record<string, unknown>;
      return diff["system.pf1e.heldCharge"] !== undefined;
    });
    expect(heldWrite).toBeUndefined();
  });

  test("a ranged touch hit resolves the full effect", async () => {
    const client = new FakeClient();
    // Ranged d20 5 + 6 = 11 → hit; damage 3.
    client.script = [{ die: 5 }, { die: 3, total: 3 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, {
        touch: "ranged",
        spell: { name: "Ray of Frost", level: 0 },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost || res.held) return;
    expect(res.touch).toEqual({
      kind: "ranged",
      total: 11,
      hit: true,
      threat: false,
    });
    expect(res.result.dealt).toBe(3);
  });

  test("casting another spell dissipates a held charge", async () => {
    const client = new FakeClient();
    const caster = touchWizard({
      heldCharge: {
        name: "Shocking Grasp",
        level: 1,
        damageFormula: "1d6",
        saveType: "ref",
        severity: "none",
      },
    });
    const res = await resolveCastFlow(client, owner, castParams(caster));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings.join(" ")).toMatch(
      /held Shocking Grasp charge dissipates/i,
    );
    const clear = stateOps(client).find((op) => {
      if (op.kind !== "update") return false;
      const diff = op.diff as Record<string, unknown>;
      return "-=system.pf1e.heldCharge" in diff;
    });
    expect(clear).toBeDefined();
  });

  test("a missed touch cast replaces an older held charge", async () => {
    const client = new FakeClient();
    client.script = [{ die: 5 }]; // miss
    const caster = touchWizard({
      heldCharge: {
        name: "Old Flame",
        level: 1,
        damageFormula: "1d4",
        saveType: "ref",
        severity: "none",
      },
    });
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.held).toBe(true);
    // The ops delete the old charge first, then write the new one.
    const chargeOps = stateOps(client).filter((op) => {
      if (op.kind !== "update") return false;
      const diff = op.diff as Record<string, unknown>;
      return (
        "system.pf1e.heldCharge" in diff || "-=system.pf1e.heldCharge" in diff
      );
    });
    expect(chargeOps.length).toBe(2);
    const first = (chargeOps[0] as Extract<Op, { kind: "update" }>).diff;
    const second = (chargeOps[1] as Extract<Op, { kind: "update" }>).diff[
      "system.pf1e.heldCharge"
    ];
    expect("-=system.pf1e.heldCharge" in first).toBe(true);
    expect((second as Record<string, unknown>).name).toBe("Shocking Grasp");
  });
});

describe("P5/C03 held-charge delivery (D-158)", () => {
  const chargedWizard = () =>
    touchWizard({
      heldCharge: {
        name: "Shocking Grasp",
        level: 1,
        damageFormula: "1d6",
        saveType: "ref",
        severity: "none",
      },
    });

  test("a delivered charge takes effect and clears itself", async () => {
    const client = new FakeClient();
    // Touch d20 6 + 3 = 9 vs touch AC 9 → hit; damage 5.
    client.script = [{ die: 6 }, { die: 5, total: 5 }];
    const caster = chargedWizard();
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(caster),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.delivered) return;
    expect(res.result.dealt).toBe(5);
    expect(client.formulas).toEqual(["1d20", "1d6"]);
    // The charge clears.
    const clear = stateOps(client).find((op) => {
      if (op.kind !== "update") return false;
      const diff = op.diff as Record<string, unknown>;
      return "-=system.pf1e.heldCharge" in diff;
    });
    expect(clear).toBeDefined();
    expect(cardContent(client)).toMatch(/delivers the held Shocking Grasp/);
  });

  test("a missed delivery keeps the charge", async () => {
    const client = new FakeClient();
    client.script = [{ die: 1 }]; // miss
    const caster = chargedWizard();
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(caster),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivered).toBe(false);
    if (res.delivered) return;
    expect(res.chargeName).toBe("Shocking Grasp");
    expect(res.touch.hit).toBe(false);
    // Only the card was submitted — no state writes at all.
    expect(client.submitted.length).toBe(1);
    expect(stateOps(client).every((op) => op.kind === "create")).toBe(true);
    expect(cardContent(client)).toMatch(/still held/i);
  });

  test("no held charge is a named refusal that rolls nothing", async () => {
    const client = new FakeClient();
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(touchWizard()),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no held charge/i);
    expect(client.formulas).toEqual([]);
    expect(client.submitted).toEqual([]);
  });

  test("a stranger cannot deliver someone else's charge", async () => {
    const client = new FakeClient();
    const res = await resolveTouchDelivery(
      client,
      stranger,
      deliveryParams(chargedWizard()),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/permission/i);
    expect(client.formulas).toEqual([]);
  });
});

describe("P5/C03 critical confirmation and willing auto-touch (D-159)", () => {
  const chargedWizard = (damageFormula: string) =>
    touchWizard({
      heldCharge: {
        name: "Shocking Grasp",
        level: 1,
        damageFormula,
        saveType: "ref",
        severity: "none",
      },
    });

  test("a confirmed critical doubles the rolled damage", async () => {
    const client = new FakeClient();
    // Touch d20 20 → 23, threat and hit; confirmation 10 → 13, confirmed;
    // damage 5 doubled to 10.
    client.script = [{ die: 20 }, { die: 10 }, { die: 5, total: 5 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost || res.held) return;
    expect(res.touch).toEqual({
      kind: "melee",
      total: 23,
      hit: true,
      threat: true,
      critical: true,
    });
    expect(res.result.dealt).toBe(10);
    expect(client.formulas).toEqual(["1d20", "1d20", "1d6"]);
    expect(cardContent(client)).toMatch(/CRITICAL HIT \(damage doubled\)/);
  });

  test("an unconfirmed threat is a regular hit", async () => {
    const client = new FakeClient();
    // Touch d20 20 → threat; confirmation 1 + 3 = 4 vs touch AC 9 → miss.
    client.script = [{ die: 20 }, { die: 1 }, { die: 5, total: 5 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost || res.held) return;
    expect(res.touch).toEqual({
      kind: "melee",
      total: 23,
      hit: true,
      threat: true,
      critical: false,
    });
    expect(res.result.dealt).toBe(5);
    expect(cardContent(client)).toMatch(/not confirmed \(regular hit\)/);
  });

  test("a threat with a damageless touch spell skips the confirmation", async () => {
    const client = new FakeClient();
    // Only the touch die is rolled — "critical hits ... as long as the
    // spell deals damage."
    client.script = [{ die: 20 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, {
        touch: "melee",
        authored: { saveType: "ref", severity: "none", damageFormula: "" },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost || res.held) return;
    expect(client.formulas).toEqual(["1d20"]);
    expect(res.result.dealt).toBe(0);
    expect(cardContent(client)).toMatch(/cannot score a critical hit/);
  });

  test("a willing target is touched automatically at cast time", async () => {
    const client = new FakeClient();
    client.script = [{ die: 5, total: 5 }]; // only the damage roll
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee", willing: true }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost || res.held) return;
    expect(res.touch).toEqual({
      kind: "melee",
      total: null,
      hit: true,
      threat: false,
      auto: true,
    });
    expect(client.formulas).toEqual(["1d6"]);
    expect(res.result.dealt).toBe(5);
    expect(cardContent(client)).toMatch(/automatically — no attack roll/);
  });

  test("delivery: a willing friend takes the charge without an attack roll", async () => {
    const client = new FakeClient();
    client.script = [{ die: 5, total: 5 }]; // only the damage roll
    const caster = chargedWizard("1d6");
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(caster, { willing: true }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.delivered) return;
    expect(res.touch).toEqual({
      total: null,
      hit: true,
      threat: false,
      auto: true,
    });
    expect(client.formulas).toEqual(["1d6"]);
    expect(res.result.dealt).toBe(5);
    const clear = stateOps(client).find((op) => {
      if (op.kind !== "update") return false;
      const diff = op.diff as Record<string, unknown>;
      return "-=system.pf1e.heldCharge" in diff;
    });
    expect(clear).toBeDefined();
    expect(cardContent(client)).toMatch(/automatically — no attack roll/);
  });

  test("delivery: a confirmed critical doubles the charge damage", async () => {
    const client = new FakeClient();
    client.script = [{ die: 20 }, { die: 15 }, { die: 5, total: 5 }];
    const caster = chargedWizard("1d6");
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(caster),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.delivered) return;
    expect(res.touch).toEqual({
      total: 23,
      hit: true,
      threat: true,
      critical: true,
    });
    expect(res.result.dealt).toBe(10);
    expect(client.formulas).toEqual(["1d20", "1d20", "1d6"]);
  });

  test("delivery: a damageless charge's threat skips the confirmation", async () => {
    const client = new FakeClient();
    client.script = [{ die: 20 }];
    const caster = chargedWizard("");
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(caster),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.delivered) return;
    expect(client.formulas).toEqual(["1d20"]);
    expect(res.result.dealt).toBe(0);
    expect(cardContent(client)).toMatch(/cannot score a critical hit/);
  });
});
