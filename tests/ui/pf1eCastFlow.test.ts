import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CombatDocument,
  FlagStore,
  Json,
  MessageDocument,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type { PermissionUser } from "../../src/core/ownership";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import {
  castResolutionCardContent,
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

/** Int 16 prepared wizard: level-1 DC 14, caster level 5, one prepared MM. */
const wizardActor = actor("wizard", {
  abilities: { int: 16 },
  spells: {
    keyAbility: "int",
    mode: "prepared",
    casterLevel: 5,
    slotsPerDay: { 0: 4, 1: 4, 2: 4, 3: 3, 4: 2 },
    prepared: [{ name: "Magic Missile", level: 1 }],
  },
});
const wizard = deriveFromDocuments({ actor: wizardActor });

function targetActor(pf1e: Record<string, Json> = {}): ActorDocument {
  return actor("ogre", {
    abilities: { con: 14 },
    hp: 20,
    hpMax: 20,
    saves: { fort: 2, ref: 0, will: 1 },
    ...pf1e,
  });
}

function combat(round: number, flags: FlagStore = {}): CombatDocument {
  return {
    _id: "fight",
    type: "combat",
    name: "fight",
    ownership: { default: 1 },
    flags,
    system: {},
    round,
    turn: 0,
    combatants: [],
  };
}

/**
 * Fake client: rolls are scripted in call order. `die` populates the d20 face
 * (first kept result) and `total` the reported total; damage reads the total.
 */
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
    this.messages.push(this.record(rollId, formula, entry));
    return rollId;
  }

  submit(ops: Op[]): string {
    this.submitted.push(ops);
    return "tx";
  }

  private record(
    rollId: string,
    formula: string,
    entry: { die?: number; total?: number },
  ): MessageDocument {
    const die = entry.die ?? 10;
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
    };
  }
}

function params(
  overrides: Partial<PF1eCastFlowParams> = {},
): PF1eCastFlowParams {
  const target = targetActor();
  return {
    casterActor: wizardActor,
    casterDerived: wizard,
    spell: { name: "Magic Missile", level: 1, preparedIndex: 0 },
    authored: {
      saveType: "ref",
      severity: "half",
      damageFormula: "2d6",
    },
    targetName: "ogre",
    targetActor: target,
    targetDerived: deriveFromDocuments({ actor: target }),
    ...overrides,
  };
}

/** The second submit (the authoritative state Ops), flattened. */
function stateOps(client: FakeClient): Op[] {
  return client.submitted.flatMap((batch) => batch);
}

describe("P5/C02 tactical cast flow (D-156)", () => {
  test("a damaging cast rolls host dice, spends the slot, expends the prepared spell and writes HP", async () => {
    const client = new FakeClient();
    // damage 2d6 = 7; ogre's ref save rolls a 1 (+0) vs DC 14 → fails → full 7.
    client.script = [
      { die: 4, total: 7 }, // damage
      { die: 1 }, // ref save
    ];
    const p = params();
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(res.dc).toBe(14); // 10 + level 1 + Int +3
    expect(res.result.dealt).toBe(7);
    expect(res.result.passed).toBe(false);
    expect(res.warnings).toEqual([]);
    expect(res.hpWriteError).toBeNull();
    // Damage + save only (the ogre has no SR).
    expect(client.formulas).toEqual(["2d6", "1d20"]);

    const ops = stateOps(client);
    // Slot 1 spent (dotted when a ledger exists, materialized on first spend),
    // prepared row expended, ogre 20 → 13 HP.
    expect(
      ops.some((op) => {
        if (op.kind !== "update") return false;
        const diff = op.diff as Record<string, unknown>;
        if (diff["system.pf1e.spells.slotsUsed.1"] === 1) return true;
        const whole = diff["system.pf1e.spells.slotsUsed"];
        return (
          whole !== undefined &&
          whole !== null &&
          typeof whole === "object" &&
          (whole as Record<string, unknown>)["1"] === 1
        );
      }),
    ).toBe(true);
    expect(
      ops.some((op) => {
        if (op.kind !== "update") return false;
        const prepared = (op.diff as Record<string, unknown>)[
          "system.pf1e.spells.prepared"
        ];
        return (
          Array.isArray(prepared) &&
          (prepared[0] as Record<string, unknown>)?.expended === true
        );
      }),
    ).toBe(true);
    expect(
      ops.some(
        (op) =>
          op.kind === "update" &&
          (op.diff as Record<string, unknown>)["system.pf1e.hp"] === 13,
      ),
    ).toBe(true);
    // A resolution card was posted first.
    const cardBatch = client.submitted[0];
    expect(cardBatch?.[0]?.kind).toBe("create");
  });

  test("a successful Reflex-half save halves the rolled damage (round down)", async () => {
    const client = new FakeClient();
    client.script = [
      { die: 6, total: 11 }, // damage 11
      { die: 14 }, // ref save 14 + 0 = DC 14 → passes
    ];
    const res = await resolveCastFlow(client, owner, params());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(res.result.passed).toBe(true);
    expect(res.result.dealt).toBe(5); // floor(11/2)
  });

  test("no saving throw is rolled when the severity is none", async () => {
    const client = new FakeClient();
    client.script = [{ die: 3, total: 8 }];
    const res = await resolveCastFlow(
      client,
      owner,
      params({
        authored: { saveType: "ref", severity: "none", damageFormula: "2d6" },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(client.formulas).toEqual(["2d6"]); // no save roll
    expect(res.result.dealt).toBe(8);
  });

  test("spell resistance is a caster-level check with no natural-20 auto success", async () => {
    // SR 30 vs caster level 5: even a natural 20 only reaches 25 → resisted.
    const sr = targetActor({ spellResistance: 30 });
    const client = new FakeClient();
    client.script = [
      { die: 5, total: 12 }, // damage (rolled, but never applied)
      { die: 20 }, // SR check: 20 + 5 = 25 < 30
    ];
    const res = await resolveCastFlow(
      client,
      owner,
      params({
        targetActor: sr,
        targetDerived: deriveFromDocuments({ actor: sr }),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(res.sr.resisted).toBe(true);
    expect(res.result.dealt).toBe(0);
    // A resisted target gets no saving throw.
    expect(client.formulas).toEqual(["2d6", "1d20"]);
    // No HP write for a resisted spell; slot still spent.
    const ops = stateOps(client);
    expect(
      ops.some(
        (op) =>
          op.kind === "update" &&
          (op.diff as Record<string, unknown>)["system.pf1e.hp"] !== undefined,
      ),
    ).toBe(false);
  });

  test("overcome SR is recorded once per round on the combat document and reused", async () => {
    const sr = targetActor({ spellResistance: 12 });
    const fight = combat(2);
    const first = new FakeClient();
    // SR check 8 + 5 = 13 ≥ 12 → overcome; save then fails.
    first.script = [{ die: 4, total: 7 }, { die: 8 }, { die: 2 }];
    const p1 = params({
      targetActor: sr,
      targetDerived: deriveFromDocuments({ actor: sr }),
      combat: fight,
    });
    const r1 = await resolveCastFlow(first, owner, p1);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.lost).toBe(false);
    if (r1.lost) return;
    if (r1.held) return;
    expect(r1.sr.resisted).toBe(false);
    expect(r1.sr.reused).toBe(false);
    // The ledger write rides the combat document.
    const ledgerOp = stateOps(first).find(
      (op) =>
        op.kind === "update" &&
        op.ref.coll === "combats" &&
        (op.diff as Record<string, unknown>)[
          "flags.pf1e.srOvercome.wizard:ogre"
        ] === 2,
    );
    expect(ledgerOp).toBeDefined();

    // Second cast the same round reuses the overcome check: no SR roll.
    const second = new FakeClient();
    const fightAfter = combat(2, {
      pf1e: { srOvercome: { "wizard:ogre": 2 } },
    });
    second.script = [{ die: 4, total: 7 }, { die: 2 }];
    const r2 = await resolveCastFlow(
      second,
      owner,
      params({
        targetActor: sr,
        targetDerived: deriveFromDocuments({ actor: sr }),
        combat: fightAfter,
      }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.lost).toBe(false);
    if (r2.lost) return;
    if (r2.held) return;
    expect(r2.sr.reused).toBe(true);
    expect(second.formulas).toEqual(["2d6", "1d20"]); // damage + save only
  });

  test("a new round re-rolls SR: the previous round's ledger entry is stale", async () => {
    const sr = targetActor({ spellResistance: 12 });
    const fight = combat(3, { pf1e: { srOvercome: { "wizard:ogre": 2 } } });
    const client = new FakeClient();
    client.script = [{ die: 4, total: 7 }, { die: 8 }, { die: 2 }];
    const res = await resolveCastFlow(
      client,
      owner,
      params({
        targetActor: sr,
        targetDerived: deriveFromDocuments({ actor: sr }),
        combat: fight,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(res.sr.reused).toBe(false);
    // damage + SR + save
    expect(client.formulas).toEqual(["2d6", "1d20", "1d20"]);
  });

  test("a natural 1 always fails and a natural 20 always succeeds the save", async () => {
    const one = new FakeClient();
    // ogre's ref is +0; a natural 1 must fail even though DC is low.
    one.script = [{ die: 3, total: 4 }, { die: 1 }];
    const r1 = await resolveCastFlow(one, owner, params());
    expect(r1.ok).toBe(true);
    if (!r1.ok || r1.lost || r1.held) return;
    expect(r1.result.passed).toBe(false);

    const twenty = new FakeClient();
    // A high-save target still succeeds on a natural 20.
    const tough = targetActor({ saves: { fort: 2, ref: -5, will: 1 } });
    twenty.script = [{ die: 3, total: 4 }, { die: 20 }];
    const r2 = await resolveCastFlow(
      twenty,
      owner,
      params({
        targetActor: tough,
        targetDerived: deriveFromDocuments({ actor: tough }),
      }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok || r2.lost || r2.held) return;
    expect(r2.result.passed).toBe(true);
  });

  test("energy resistance applies after the save halves, once per type", async () => {
    // Fire spell, 2d6 = 12; save fails → 12; ogre resists fire 5 → 7 dealt.
    const fiery = targetActor({
      energyResistance: { fire: 5 },
    });
    const client = new FakeClient();
    client.script = [{ die: 6, total: 12 }, { die: 1 }];
    const res = await resolveCastFlow(
      client,
      owner,
      params({
        targetActor: fiery,
        targetDerived: deriveFromDocuments({ actor: fiery }),
        authored: {
          saveType: "ref",
          severity: "half",
          damageFormula: "2d6",
          energyType: "fire",
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(res.result.dealt).toBe(7); // 12 - 5
    expect(res.result.erApplied).toEqual({ fire: 5 });
  });

  test("Evasion negates a passed Reflex-half spell, and only that", async () => {
    // Reflex half vs an Evasion target that passes: no damage at all.
    const rogue = targetActor({ feats: ["Evasion"] });
    const client = new FakeClient();
    client.script = [{ die: 6, total: 11 }, { die: 14 }];
    const res = await resolveCastFlow(
      client,
      owner,
      params({
        targetActor: rogue,
        targetDerived: deriveFromDocuments({ actor: rogue }),
        targetFeats: ["Evasion"],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(res.result.passed).toBe(true);
    expect(res.result.dealt).toBe(0);

    // The same feat does nothing to a Fortitude-half spell (it is defined
    // against Reflex-half only): a passed save still halves.
    const fort = new FakeClient();
    fort.script = [{ die: 6, total: 11 }, { die: 14 }];
    const resFort = await resolveCastFlow(
      fort,
      owner,
      params({
        targetActor: rogue,
        targetDerived: deriveFromDocuments({ actor: rogue }),
        targetFeats: ["Evasion"],
        authored: { saveType: "fort", severity: "half", damageFormula: "2d6" },
      }),
    );
    expect(resFort.ok).toBe(true);
    if (!resFort.ok) return;
    expect(resFort.lost).toBe(false);
    if (resFort.lost) return;
    if (resFort.held) return;
    expect(resFort.result.dealt).toBe(5); // floor(11/2), not 0
  });

  test("Improved Evasion halves even a failed Reflex save", async () => {
    const rogue = targetActor({ feats: ["Improved Evasion"] });
    const client = new FakeClient();
    client.script = [{ die: 6, total: 11 }, { die: 1 }]; // save fails
    const res = await resolveCastFlow(
      client,
      owner,
      params({
        targetActor: rogue,
        targetDerived: deriveFromDocuments({ actor: rogue }),
        targetFeats: ["Improved Evasion"],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(res.result.passed).toBe(false);
    expect(res.result.dealt).toBe(5); // half despite the failed save
  });

  test("a refused cast rolls nothing and writes nothing", async () => {
    const client = new FakeClient();
    // Level 6 has no slots for this wizard → no DC → refused before any roll.
    const res = await resolveCastFlow(
      client,
      owner,
      params({
        spell: { name: "Chain Lightning", level: 6, preparedIndex: 0 },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no slots at that level/i);
    expect(client.formulas).toEqual([]);
    expect(client.submitted).toEqual([]);
  });

  test("a non-owner cannot spend the caster's slots, so the cast is refused", async () => {
    const stranger: PermissionUser = { id: "stranger", role: "PLAYER" };
    const client = new FakeClient();
    const res = await resolveCastFlow(client, stranger, params());
    expect(res.ok).toBe(false);
    expect(client.formulas).toEqual([]);
    expect(client.submitted).toEqual([]);
  });

  test("overuse is warned, not refused, exactly as the ledger decides", async () => {
    // Spend the 5th+ level-1 slot (budget 4 + Int-16 bonus 1 = 5): the 6th warns.
    const spent = actor("wizard", {
      abilities: { int: 16 },
      spells: {
        keyAbility: "int",
        mode: "prepared",
        casterLevel: 5,
        slotsPerDay: { 0: 4, 1: 4 },
        slotsUsed: { 1: 5 },
        prepared: [{ name: "Magic Missile", level: 1 }],
      },
    });
    const client = new FakeClient();
    client.script = [{ die: 3, total: 4 }, { die: 1 }];
    const res = await resolveCastFlow(
      client,
      owner,
      params({
        casterActor: spent,
        casterDerived: deriveFromDocuments({ actor: spent }),
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    if (res.lost) return;
    if (res.held) return;
    expect(res.warnings.join(" ")).toMatch(/over budget/i);
  });
});

describe("cast resolution card (D-156)", () => {
  test("the card names the DC, the save, and the damage", () => {
    const card = castResolutionCardContent(
      {
        casterName: "wizard",
        spellName: "Burning Hands",
        spellLevel: 1,
        slotLevel: 1,
        targetName: "ogre",
        damageFormula: "2d6",
        saveType: "ref",
        severity: "half",
        hpBefore: 20,
        hpAfter: 13,
      },
      {
        dc: 14,
        sr: { resisted: false, total: null, reused: false, issues: [] },
        saveBonus: 0,
        saveTotal: 9,
        result: {
          ok: true,
          resisted: false,
          passed: false,
          automatic: null,
          outcome: { kind: "full", multiplier: 1, note: null },
          dealt: 7,
          saveReduced: 0,
          erApplied: {},
          notes: [],
        },
      },
      [],
      null,
    );
    expect(card.name).toBe("Burning Hands cast");
    expect(card.content).toContain("DC 14");
    expect(card.content).toContain("REF save");
    expect(card.content).toContain("[[7|2d6]] damage dealt");
    expect(card.content).toContain("ogre 20 → 13 HP");
  });
});
