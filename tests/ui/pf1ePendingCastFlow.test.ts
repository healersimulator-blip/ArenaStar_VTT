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
  resolvePendingCompletion,
  resolvePendingDisruption,
  type CastFlowClient,
  type PF1eCastFlowParams,
  type PF1ePendingCompletionParams,
  type PF1ePendingDisruptionParams,
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

/** Int 16 prepared wizard: level-1 DC 14, CL 5, concentration +8. */
function wizardActor(pf1e: Record<string, Json> = {}): ActorDocument {
  return actor("wizard", {
    abilities: { int: 16 },
    spells: {
      keyAbility: "int",
      mode: "prepared",
      casterLevel: 5,
      slotsPerDay: { 1: 4 },
      prepared: [{ name: "Summon Monster I", level: 1, components: "V, S" }],
    },
    ...pf1e,
  });
}

function ogre(): ActorDocument {
  return actor("ogre", {
    abilities: { con: 14 },
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

function beginParams(
  caster: ActorDocument,
  overrides: Partial<PF1eCastFlowParams> = {},
): PF1eCastFlowParams {
  const target = ogre();
  return {
    casterActor: caster,
    casterDerived: deriveFromDocuments({ actor: caster }),
    spell: { name: "Summon Monster I", level: 1, preparedIndex: 0 },
    authored: { saveType: "will", severity: "none", damageFormula: "" },
    targetName: "ogre",
    targetActor: target,
    targetDerived: deriveFromDocuments({ actor: target }),
    castingTime: "longer",
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

function pendingOp(client: FakeClient): Record<string, unknown> | undefined {
  return stateOps(client)
    .filter((op) => op.kind === "update")
    .map((op) => op.diff as Record<string, unknown>)
    .find((diff) => "system.pf1e.pendingCast" in diff);
}

function pendingClearOps(client: FakeClient): Op[] {
  return stateOps(client).filter((op) => {
    if (op.kind !== "update") return false;
    return "-=system.pf1e.pendingCast" in (op.diff as Record<string, unknown>);
  });
}

const pendingBlock = {
  name: "Summon Monster I",
  level: 1,
  damageFormula: "",
  saveType: "will",
  severity: "none",
  targetId: "ogre",
};

const pendingWizard = () => wizardActor({ pendingCast: pendingBlock });

describe("P5/C03 multi-round casting — beginning the spell (D-161)", () => {
  test("a longer cast spends the slot and prepared row, writes pendingCast, rolls nothing", async () => {
    const client = new FakeClient();
    const res = await resolveCastFlow(
      client,
      owner,
      beginParams(wizardActor()),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pending).toBe(true);
    if (res.pending !== true) return;
    expect(res.pendingSpell).toEqual({ name: "Summon Monster I", level: 1 });
    // No dice at all: the effect is deferred.
    expect(client.formulas).toEqual([]);
    // Slot spend + prepared expense + the pending write.
    const write = pendingOp(client);
    expect(write).toBeDefined();
    expect(write?.["system.pf1e.pendingCast"]).toEqual(pendingBlock);
    const spent = stateOps(client).filter(
      (op) =>
        op.kind === "update" && JSON.stringify(op.diff).includes("slotsUsed"),
    );
    expect(spent.length).toBeGreaterThan(0);
    expect(cardContent(client)).toMatch(
      /begins casting Summon Monster I \(level 1\) at ogre/,
    );
    expect(cardContent(client)).toMatch(/just before their next turn/);
  });

  test("beginning a second long casting forfeits the first", async () => {
    const client = new FakeClient();
    const res = await resolveCastFlow(
      client,
      owner,
      beginParams(pendingWizard()),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pending).toBe(true);
    expect(res.warnings.join(" ")).toMatch(
      /the pending Summon Monster I is lost as Summon Monster I begins/,
    );
    // One clear of the old pending, one write of the new.
    expect(pendingClearOps(client).length).toBe(1);
    expect(pendingOp(client)).toBeDefined();
  });

  test("beginning a long casting dissipates a held charge", async () => {
    const client = new FakeClient();
    const caster = wizardActor({
      heldCharge: {
        name: "Shocking Grasp",
        level: 1,
        damageFormula: "1d6",
        saveType: "ref",
        severity: "none",
      },
    });
    const res = await resolveCastFlow(client, owner, beginParams(caster));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pending).toBe(true);
    expect(res.warnings.join(" ")).toMatch(/Shocking Grasp charge dissipates/);
    const heldClears = stateOps(client).filter((op) => {
      if (op.kind !== "update") return false;
      return "-=system.pf1e.heldCharge" in (op.diff as Record<string, unknown>);
    });
    expect(heldClears.length).toBe(1);
  });

  test("a touch spell refuses a 1-round-plus casting time", async () => {
    const client = new FakeClient();
    const res = await resolveCastFlow(
      client,
      owner,
      beginParams(wizardActor(), { touch: "melee" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/touch delivery is not modeled/i);
    expect(pendingOp(client)).toBeUndefined();
  });

  test("an illegal gate still refuses before any begin", async () => {
    const client = new FakeClient();
    const p = beginParams(wizardActor(), {
      gate: {
        components: "V, S",
        caster: { canSpeak: false, hasFreeHand: true, componentsInHand: true },
        castingTime: "longer",
      },
    });
    const res = await resolveCastFlow(client, owner, p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot speak/i);
    expect(pendingOp(client)).toBeUndefined();
  });
});

describe("P5/C03 multi-round casting — completion (D-161)", () => {
  function completionParams(
    caster: ActorDocument,
    overrides: Partial<PF1ePendingCompletionParams> = {},
  ): PF1ePendingCompletionParams {
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

  test("completing the pending cast runs the pipeline and clears the state", async () => {
    const client = new FakeClient();
    const damaging = pendingWizard();
    (
      (damaging.system as Record<string, Json>).pf1e as Record<string, Json>
    ).pendingCast = { ...pendingBlock, damageFormula: "2d6", severity: "half" };
    // Damage 11; ogre's will +1 vs DC 14, die 1 → 2 → fails → full 11.
    client.script = [{ die: 11, total: 11 }, { die: 1 }];
    const res = await resolvePendingCompletion(
      client,
      owner,
      completionParams(damaging),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.completed).toBe(true);
    expect(res.dc).toBe(14);
    expect(res.result.dealt).toBe(11);
    expect(client.formulas).toEqual(["2d6", "1d20"]);
    expect(pendingClearOps(client).length).toBe(1);
    expect(cardContent(client)).toMatch(
      /completes Summon Monster I \(level 1\) at ogre — the casting began before this turn/,
    );
  });

  test("completion refuses when there is no pending casting", async () => {
    const client = new FakeClient();
    const res = await resolvePendingCompletion(
      client,
      owner,
      completionParams(wizardActor()),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no pending casting/i);
  });

  test("completion refuses a different target than the spell was begun at", async () => {
    const client = new FakeClient();
    const other = actor("gnoll", { abilities: { con: 12 }, hp: 10, hpMax: 10 });
    const res = await resolvePendingCompletion(
      client,
      owner,
      completionParams(pendingWizard(), {
        targetName: "gnoll",
        targetActor: other,
        targetDerived: deriveFromDocuments({ actor: other }),
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/begun at a different target/i);
  });

  test("a stranger cannot complete someone else's pending casting", async () => {
    const client = new FakeClient();
    const res = await resolvePendingCompletion(
      client,
      stranger,
      completionParams(pendingWizard()),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/permission/i);
  });
});

describe("P5/C03 multi-round casting — disruption (D-161)", () => {
  function disruptionParams(
    caster: ActorDocument,
    damage: number,
  ): PF1ePendingDisruptionParams {
    return {
      casterActor: caster,
      casterDerived: deriveFromDocuments({ actor: caster }),
      damage,
    };
  }

  test("a failed concentration check loses the pending spell", async () => {
    const client = new FakeClient();
    // damage 5 → DC 10 + 5 + 1 = 16; die 1 + 8 = 9 → fail.
    client.script = [{ die: 1 }];
    const res = await resolvePendingDisruption(
      client,
      owner,
      disruptionParams(pendingWizard(), 5),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(true);
    expect(res.dc).toBe(16);
    expect(res.total).toBe(9);
    expect(pendingClearOps(client).length).toBe(1);
    expect(cardContent(client)).toMatch(/loses Summon Monster I/);
    expect(cardContent(client)).toMatch(/9 vs DC 16|DC 16/);
  });

  test("a passed concentration check keeps the casting pending", async () => {
    const client = new FakeClient();
    // damage 5 → DC 16; die 20 + 8 = 28 → pass.
    client.script = [{ die: 20 }];
    const res = await resolvePendingDisruption(
      client,
      owner,
      disruptionParams(pendingWizard(), 5),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lost).toBe(false);
    expect(res.total).toBe(28);
    expect(pendingClearOps(client)).toEqual([]);
    expect(cardContent(client)).toMatch(/keeps concentrating/);
  });

  test("disruption refuses when nothing is pending", async () => {
    const client = new FakeClient();
    const res = await resolvePendingDisruption(
      client,
      owner,
      disruptionParams(wizardActor(), 5),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no pending casting/i);
    expect(client.formulas).toEqual([]);
  });
});
