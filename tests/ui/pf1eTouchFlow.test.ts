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
    if (!res.ok || res.lost || res.held || res.pending) return;
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
    if (!res.ok || res.lost || res.held || res.pending) return;
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
    if (!res.ok || res.lost || res.held || res.pending) return;
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
    if (!res.ok || res.lost || res.held || res.pending) return;
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
    if (!res.ok || res.lost || res.held || res.pending) return;
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
    if (!res.ok || res.lost || res.held || res.pending) return;
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
    if (!res.ok || res.lost || res.held || res.pending) return;
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

/* ------------------------------------------------------------------ *
 * P5/C03 held-charge consumers (D-162)
 * ------------------------------------------------------------------ */

import {
  resolveChargeAllyTouches,
  resolveChargeWeaponRelease,
  type PF1eAllyTouchesParams,
  type PF1eChargeReleaseParams,
} from "../../src/ui/sheets/pf1eCastFlow";

/** Ogre wearing a breastplate: normal AC 13 (10 + 4 − 1 Dex), touch AC 9. */
function armoredOgre(): ActorDocument {
  return actor("armored-ogre", {
    abilities: { dex: 8, con: 14 },
    hp: 20,
    hpMax: 20,
    saves: { fort: 2, ref: 0, will: 1 },
    armor: { armorBonus: 4 },
  });
}

/** A touch wizard holding a Chill Touch with the given charge count. */
function chillWizard(charges?: number): ActorDocument {
  return touchWizard({
    heldCharge: {
      name: "Chill Touch",
      level: 1,
      damageFormula: "1d6",
      saveType: "fort",
      severity: "half",
      ...(charges !== undefined ? { charges } : {}),
    },
  });
}

function heldChargeOps(client: FakeClient): Op[] {
  return stateOps(client).filter((op) => {
    if (op.kind !== "update") return false;
    const diff = op.diff as Record<string, unknown>;
    return (
      diff["system.pf1e.heldCharge"] !== undefined ||
      diff["-=system.pf1e.heldCharge"] !== undefined
    );
  });
}

describe("P5/C03 cast flow — multi-touch charges (D-162)", () => {
  test("a missed melee touch holds every declared charge", async () => {
    const client = new FakeClient();
    // Touch d20 1 + 3 = 4 vs touch AC 9 → miss.
    client.script = [{ die: 1 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee", charges: 4 }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.held).toBe(true);
    const write = heldChargeOps(client)[0] as Extract<Op, { kind: "update" }>;
    const charge = write.diff["system.pf1e.heldCharge"] as Record<
      string,
      unknown
    >;
    expect(charge.charges).toBe(4);
    expect(cardContent(client)).toMatch(/4 deliveries remaining/);
  });

  test("a single charge is not recorded as multi-charge", async () => {
    const client = new FakeClient();
    client.script = [{ die: 1 }];
    const caster = touchWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams(caster, { touch: "melee", charges: 1 }),
    );
    expect(res.ok).toBe(true);
    const write = heldChargeOps(client)[0] as Extract<Op, { kind: "update" }>;
    const charge = write.diff["system.pf1e.heldCharge"] as Record<
      string,
      unknown
    >;
    expect(charge.charges).toBeUndefined();
  });

  test("charges are refused by name for ranged touch and non-touch casts", async () => {
    const ranged = new FakeClient();
    const rangedRes = await resolveCastFlow(
      ranged,
      owner,
      castParams(touchWizard(), { touch: "ranged", charges: 3 }),
    );
    expect(rangedRes.ok).toBe(false);
    if (!rangedRes.ok) expect(rangedRes.error).toMatch(/cannot be held/);
    expect(ranged.submitted).toEqual([]);
    expect(ranged.formulas).toEqual([]);

    const plain = new FakeClient();
    const plainRes = await resolveCastFlow(
      plain,
      owner,
      castParams(touchWizard(), { charges: 3 }),
    );
    expect(plainRes.ok).toBe(false);
    expect(plain.submitted).toEqual([]);
  });

  test("charge counts outside 1–50 are refused by name", async () => {
    for (const charges of [0, 51, Number.NaN, 2.5]) {
      const client = new FakeClient();
      const res = await resolveCastFlow(
        client,
        owner,
        castParams(touchWizard(), { touch: "melee", charges }),
      );
      expect(res.ok).toBe(false);
      expect(client.submitted).toEqual([]);
      expect(client.formulas).toEqual([]);
    }
  });
});

describe("P5/C03 held-charge delivery — charge accounting (D-162)", () => {
  test("a hit consumes one of several charges and keeps holding the rest", async () => {
    const client = new FakeClient();
    // Touch d20 10 + 3 = 13 vs touch AC 9 → hit; damage 4; save 5 + 2 = 7 vs 14 fails.
    client.script = [{ die: 10 }, { die: 4, total: 4 }, { die: 5 }];
    const caster = chillWizard(3);
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(caster),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivered).toBe(true);
    if (!res.delivered) return;
    expect(res.chargesRemaining).toBe(2);
    const writes = heldChargeOps(client);
    expect(writes).toHaveLength(1);
    const write = writes[0] as Extract<Op, { kind: "update" }>;
    const charge = write.diff["system.pf1e.heldCharge"] as Record<
      string,
      unknown
    >;
    expect(charge.charges).toBe(2);
    expect(cardContent(client)).toMatch(/Charges remaining: 2/);
  });

  test("the last charge clears the path exactly as before D-162", async () => {
    const client = new FakeClient();
    client.script = [{ die: 10 }, { die: 4, total: 4 }, { die: 5 }];
    const caster = chillWizard(1);
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(caster),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.delivered) return;
    expect(res.chargesRemaining).toBeUndefined();
    const write = heldChargeOps(client)[0] as Extract<Op, { kind: "update" }>;
    expect(write.diff["-=system.pf1e.heldCharge"]).toBeNull();
  });

  test("a missed delivery keeps every charge untouched", async () => {
    const client = new FakeClient();
    // Touch d20 1 + 3 = 4 vs touch AC 9 → miss.
    client.script = [{ die: 1 }];
    const caster = chillWizard(3);
    const res = await resolveTouchDelivery(
      client,
      owner,
      deliveryParams(caster),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivered).toBe(false);
    expect(heldChargeOps(client)).toEqual([]);
  });
});

describe("P5/C03 touching willing allies with a held charge (D-162)", () => {
  function allyParams(
    caster: ActorDocument,
    targets: ActorDocument[],
    overrides: Partial<PF1eAllyTouchesParams> = {},
  ): PF1eAllyTouchesParams {
    return {
      casterActor: caster,
      casterDerived: deriveFromDocuments({ actor: caster }),
      targets: targets.map((t) => ({
        name: t.name,
        actor: t,
        derived: deriveFromDocuments({ actor: t }),
      })),
      ...overrides,
    };
  }

  test("two willing allies each take the spell and two charges are consumed", async () => {
    const client = new FakeClient();
    // Ally 1: damage 4, save 5 (+2 fort = 7) fails DC 14 → full 4.
    // Ally 2: damage 3, save 15 (+2 = 17) passes DC 14 → half 1.
    client.script = [
      { die: 4, total: 4 },
      { die: 5 },
      { die: 3, total: 3 },
      { die: 15 },
    ];
    const caster = chillWizard(3);
    const allyA = actor("ally-a", { abilities: {}, hp: 20, hpMax: 20 });
    const allyB = actor("ally-b", { abilities: {}, hp: 12, hpMax: 12 });
    const res = await resolveChargeAllyTouches(
      client,
      owner,
      allyParams(caster, [allyA, allyB]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.touched).toBe(2);
    expect(res.chargesRemaining).toBe(1);
    // One damage roll and one save per touched ally, in order.
    expect(client.formulas).toEqual(["1d6", "1d20", "1d6", "1d20"]);
    // The charge is decremented, not cleared.
    const write = heldChargeOps(client)[0] as Extract<Op, { kind: "update" }>;
    expect(
      (write.diff["system.pf1e.heldCharge"] as Record<string, unknown>).charges,
    ).toBe(1);
    // Both allies' HP writes landed: 20 − 4 and 12 − 1.
    const hpWrites = stateOps(client).filter((op) => {
      if (op.kind !== "update" || op.ref.coll !== "actors") return false;
      const diff = op.diff as Record<string, unknown>;
      return diff["system.pf1e.hp"] !== undefined;
    });
    expect(hpWrites).toHaveLength(2);
    expect(cardContent(client)).toMatch(/full-round action/);
    expect(cardContent(client)).toMatch(/ally-a/);
    expect(cardContent(client)).toMatch(/ally-b/);
    expect(cardContent(client)).toMatch(/Charges remaining: 1/);
  });

  test("touching the last allies fully discharges the spell", async () => {
    const client = new FakeClient();
    client.script = [{ die: 2, total: 2 }, { die: 20 }];
    const caster = chillWizard(1);
    const allyA = actor("ally-a", { abilities: {}, hp: 8, hpMax: 8 });
    const res = await resolveChargeAllyTouches(
      client,
      owner,
      allyParams(caster, [allyA]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.chargesRemaining).toBeUndefined();
    const write = heldChargeOps(client)[0] as Extract<Op, { kind: "update" }>;
    expect(write.diff["-=system.pf1e.heldCharge"]).toBeNull();
    expect(cardContent(client)).toMatch(/fully discharged/);
  });

  test("the named limits hold: no targets, more than six, duplicates, too few charges", async () => {
    const caster = chillWizard(1);
    const ally = actor("ally-a", { abilities: {}, hp: 8, hpMax: 8 });

    const empty = new FakeClient();
    const emptyRes = await resolveChargeAllyTouches(
      empty,
      owner,
      allyParams(caster, []),
    );
    expect(emptyRes.ok).toBe(false);

    const seven = new FakeClient();
    const sevenAllies = Array.from({ length: 7 }, (_, i) =>
      actor(`ally-${i}`, { abilities: {}, hp: 5, hpMax: 5 }),
    );
    const sevenRes = await resolveChargeAllyTouches(
      seven,
      owner,
      allyParams(chillWizard(7), sevenAllies),
    );
    expect(sevenRes.ok).toBe(false);
    if (!sevenRes.ok) expect(sevenRes.error).toMatch(/up to 6/);

    const dupe = new FakeClient();
    const dupeRes = await resolveChargeAllyTouches(
      dupe,
      owner,
      allyParams(caster, [ally, ally]),
    );
    expect(dupeRes.ok).toBe(false);
    if (!dupeRes.ok) expect(dupeRes.error).toMatch(/more than once/);

    const short = new FakeClient();
    const shortRes = await resolveChargeAllyTouches(
      short,
      owner,
      allyParams(caster, [
        ally,
        actor("ally-b", { abilities: {}, hp: 5, hpMax: 5 }),
      ]),
    );
    expect(shortRes.ok).toBe(false);
    if (!shortRes.ok) expect(shortRes.error).toMatch(/deliver(y|ies) left/);

    // Nothing was rolled or submitted in any refusal.
    for (const c of [empty, seven, dupe, short]) {
      expect(c.submitted).toEqual([]);
      expect(c.formulas).toEqual([]);
    }
  });

  test("no held charge and no permission are both named refusals", async () => {
    const none = new FakeClient();
    const noneRes = await resolveChargeAllyTouches(
      none,
      owner,
      allyParams(touchWizard(), [
        actor("ally-a", { abilities: {}, hp: 5, hpMax: 5 }),
      ]),
    );
    expect(noneRes.ok).toBe(false);
    if (!noneRes.ok) expect(noneRes.error).toMatch(/no held charge/i);

    const denied = new FakeClient();
    const deniedRes = await resolveChargeAllyTouches(
      denied,
      stranger,
      allyParams(chillWizard(2), [
        actor("ally-a", { abilities: {}, hp: 5, hpMax: 5 }),
      ]),
    );
    expect(deniedRes.ok).toBe(false);
    if (!deniedRes.ok) expect(deniedRes.error).toMatch(/permission/);
    expect(denied.submitted).toEqual([]);
  });
});

describe("P5/C03 releasing a held charge through a weapon attack (D-162)", () => {
  const claw = {
    name: "Claw",
    attackBonus: 4,
    damageFormula: "1d4",
    damageBonus: 1,
  };

  function releaseParams(
    caster: ActorDocument,
    overrides: Partial<PF1eChargeReleaseParams> = {},
  ): PF1eChargeReleaseParams {
    const target = armoredOgre();
    return {
      casterActor: caster,
      casterDerived: deriveFromDocuments({ actor: caster }),
      targetName: target.name,
      targetActor: target,
      targetDerived: deriveFromDocuments({ actor: target }),
      weapon: claw,
      ...overrides,
    };
  }

  test("a hit deals weapon damage AND discharges the spell in one HP write", async () => {
    const client = new FakeClient();
    // Attack d20 10 + 4 = 14 vs normal AC 13 → hit.
    // Weapon 1d4 = 3 (+1 bonus) = 4; spell 1d6 = 4; save 5 (+2 fort = 7) fails DC 14.
    client.script = [
      { die: 10 },
      { die: 3, total: 3 },
      { die: 4, total: 4 },
      { die: 5 },
    ];
    const caster = chillWizard();
    const res = await resolveChargeWeaponRelease(
      client,
      owner,
      releaseParams(caster),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.released) return;
    expect(res.weaponDamage).toBe(4);
    expect(res.weaponCritical).toBe(false);
    expect(res.result.dealt).toBe(4);
    expect(client.formulas).toEqual(["1d20", "1d4", "1d6", "1d20"]);
    // ONE combined HP write: 20 − (4 weapon + 4 spell) = 12.
    const hpWrites = stateOps(client).filter((op) => {
      if (op.kind !== "update" || op.ref.coll !== "actors") return false;
      const diff = op.diff as Record<string, unknown>;
      return diff["system.pf1e.hp"] !== undefined;
    });
    expect(hpWrites).toHaveLength(1);
    const hpOp = hpWrites[0] as Extract<Op, { kind: "update" }>;
    expect(hpOp.diff["system.pf1e.hp"]).toBe(12);
    // The single charge cleared.
    const chargeOp = heldChargeOps(client)[0] as Extract<
      Op,
      { kind: "update" }
    >;
    expect(chargeOp.diff["-=system.pf1e.heldCharge"]).toBeNull();
    expect(cardContent(client)).toMatch(/vs AC 13/);
    expect(cardContent(client)).toMatch(/not considered armed/);
  });

  test("the release rolls against normal AC, never touch AC", async () => {
    const client = new FakeClient();
    // Attack d20 8 + 4 = 12: hits touch AC 9, misses normal AC 13.
    client.script = [{ die: 8 }];
    const res = await resolveChargeWeaponRelease(
      client,
      owner,
      releaseParams(chillWizard()),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.released).toBe(false);
    if (res.released) return;
    expect(res.ac).toBe(13);
    // Nothing but the attack was rolled; the charge is untouched.
    expect(client.formulas).toEqual(["1d20"]);
    expect(heldChargeOps(client)).toEqual([]);
    expect(cardContent(client)).toMatch(/still held/);
  });

  test("a confirmed critical doubles the weapon damage but not the spell", async () => {
    const client = new FakeClient();
    // Attack 20 threatens; confirmation 10 + 4 = 14 vs AC 13 → confirmed.
    // Weapon 1d4 = 3 (+1) = 4, doubled to 8; spell 1d6 = 2; save fails.
    client.script = [
      { die: 20 },
      { die: 10 },
      { die: 3, total: 3 },
      { die: 2, total: 2 },
      { die: 5 },
    ];
    const res = await resolveChargeWeaponRelease(
      client,
      owner,
      releaseParams(chillWizard()),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.released) return;
    expect(res.weaponCritical).toBe(true);
    expect(res.weaponDamage).toBe(8);
    expect(res.result.dealt).toBe(2);
    // 20 − (8 + 2) = 10.
    const hpOp = stateOps(client).find((op) => {
      if (op.kind !== "update" || op.ref.coll !== "actors") return false;
      return (
        (op.diff as Record<string, unknown>)["system.pf1e.hp"] !== undefined
      );
    }) as Extract<Op, { kind: "update" }>;
    expect(hpOp.diff["system.pf1e.hp"]).toBe(10);
    expect(cardContent(client)).toMatch(/CRITICAL HIT/);
  });

  test("an unconfirmed threat is a regular hit — the weapon is not doubled", async () => {
    const client = new FakeClient();
    // Attack 20 threatens; confirmation 1 + 4 = 5 vs AC 13 → not confirmed.
    client.script = [
      { die: 20 },
      { die: 1 },
      { die: 3, total: 3 },
      { die: 2, total: 2 },
      { die: 5 },
    ];
    const res = await resolveChargeWeaponRelease(
      client,
      owner,
      releaseParams(chillWizard()),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.released) return;
    expect(res.weaponCritical).toBe(false);
    expect(res.weaponDamage).toBe(4);
    expect(cardContent(client)).toMatch(/not confirmed/);
  });

  test("a weapon line without dice still adds its static bonus", async () => {
    const client = new FakeClient();
    client.script = [{ die: 10 }, { die: 4, total: 4 }, { die: 5 }];
    const res = await resolveChargeWeaponRelease(
      client,
      owner,
      releaseParams(chillWizard(), {
        weapon: {
          name: "Slam",
          attackBonus: 4,
          damageFormula: "",
          damageBonus: 2,
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.released) return;
    expect(res.weaponDamage).toBe(2);
    // No damage die was rolled for the weapon.
    expect(client.formulas).toEqual(["1d20", "1d6", "1d20"]);
  });

  test("a multi-charge release keeps holding the remaining deliveries", async () => {
    const client = new FakeClient();
    client.script = [
      { die: 10 },
      { die: 3, total: 3 },
      { die: 4, total: 4 },
      { die: 5 },
    ];
    const res = await resolveChargeWeaponRelease(
      client,
      owner,
      releaseParams(chillWizard(2)),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.released) return;
    expect(res.chargesRemaining).toBe(1);
    const write = heldChargeOps(client)[0] as Extract<Op, { kind: "update" }>;
    expect(
      (write.diff["system.pf1e.heldCharge"] as Record<string, unknown>).charges,
    ).toBe(1);
  });

  test("malformed weapons and missing charges are named refusals", async () => {
    const noCharge = new FakeClient();
    const noChargeRes = await resolveChargeWeaponRelease(
      noCharge,
      owner,
      releaseParams(touchWizard()),
    );
    expect(noChargeRes.ok).toBe(false);
    if (!noChargeRes.ok) expect(noChargeRes.error).toMatch(/no held charge/i);

    const badDice = new FakeClient();
    const badDiceRes = await resolveChargeWeaponRelease(
      badDice,
      owner,
      releaseParams(chillWizard(), {
        weapon: { ...claw, damageFormula: "lots" },
      }),
    );
    expect(badDiceRes.ok).toBe(false);

    const denied = new FakeClient();
    const deniedRes = await resolveChargeWeaponRelease(
      denied,
      stranger,
      releaseParams(chillWizard()),
    );
    expect(deniedRes.ok).toBe(false);
    if (!deniedRes.ok) expect(deniedRes.error).toMatch(/permission/);
    for (const c of [noCharge, badDice, denied]) {
      expect(c.submitted).toEqual([]);
      expect(c.formulas).toEqual([]);
    }
  });
});
