import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CombatDocument,
  FlagStore,
  Json,
  MessageDocument,
  Ownership,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type { ActionArea, ActionCard } from "../../src/core/action";
import { validateActionCard } from "../../src/core/action";
import type { PF1eConditionActionRequest } from "../../src/core/messages";
import type { PermissionUser } from "../../src/core/ownership";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import type { CastFlowClient } from "../../src/ui/sheets/pf1eCastFlow";
import {
  resolveAreaCastFlow,
  type PF1eAreaCastFlowParams,
  type PF1eAreaCastTarget,
} from "../../src/ui/sheets/pf1eAreaCastFlow";

const owner: PermissionUser = { id: "player", role: "PLAYER" };

function actor(
  id: string,
  pf1e: Record<string, Json>,
  ownership: Ownership = { default: 2, player: 3 },
): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership,
    flags: {},
    system: { pf1e },
    items: [],
    effects: [],
  };
}

/** Wis 16 prepared druid: level-1 DC 14, caster level 3, one prepared Entangle. */
const druidActor = actor("druid", {
  abilities: { wis: 16 },
  spells: {
    keyAbility: "wis",
    mode: "prepared",
    tradition: "divine",
    casterLevel: 3,
    slotsPerDay: { 0: 4, 1: 3, 2: 2 },
    prepared: [{ name: "Entangle", level: 1 }],
  },
});
const druid = deriveFromDocuments({ actor: druidActor });

/** Int 16 prepared wizard (arcane, for the spell-failure test). */
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

function ogre(id: string, pf1e: Record<string, Json> = {}): PF1eAreaCastTarget {
  const target = actor(id, {
    abilities: { con: 14 },
    hp: 20,
    hpMax: 20,
    saves: { fort: 2, ref: 0, will: 1 },
    ...pf1e,
  });
  return { name: id, actor: target, derived: deriveFromDocuments({ actor: target }) };
}

function spread(): ActionArea {
  return {
    sceneId: "scene",
    shape: "spread",
    origin: { x: 0, y: 0 },
    radius: 40,
    units: "ft",
  };
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
 * and `total` the reported total; `badTotal` plants a non-numeric total so a
 * row can fail mid-cast without waiting out the replication timeout.
 */
class FakeClient implements CastFlowClient {
  user = owner;
  messages: MessageDocument[] = [];
  conditionRequests: Array<{ request: PF1eConditionActionRequest; requestId?: string }> = [];
  settings: unknown[] = [];
  scenes: unknown[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  script: Array<{ die?: number; total?: number; badTotal?: boolean }> = [];
  private seq = 0;
  readonly store = {
    getAll: (coll: string): readonly unknown[] =>
      coll === "messages" ? this.messages : coll === "settings" ? this.settings
        : coll === "scenes" ? this.scenes : [],
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

  requestPF1eConditionAction(request: PF1eConditionActionRequest, requestId?: string): string {
    this.conditionRequests.push({ request, ...(requestId !== undefined ? { requestId } : {}) });
    return requestId ?? "condition-tx";
  }

  private record(
    rollId: string,
    formula: string,
    entry: { die?: number; total?: number; badTotal?: boolean },
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
        total: entry.badTotal === true ? ("oops" as unknown as number) : (entry.total ?? die),
        terms: [{ kind: "dice", expr: formula, rolls: [die], kept: [die], total: die }],
        seedClient: null,
        seedHost: null,
        commit: null,
      },
      flavor: "",
    };
  }
}

type AreaOverrides = {
  [K in keyof PF1eAreaCastFlowParams]?: PF1eAreaCastFlowParams[K] | undefined;
};

function areaParams(overrides: AreaOverrides = {}): PF1eAreaCastFlowParams {
  const out = {
    casterActor: druidActor,
    casterDerived: druid,
    casterTokenId: "t-caster",
    spell: { name: "Entangle", level: 1, preparedIndex: 0 },
    authored: { saveType: "ref", severity: "negates", damageFormula: "" },
    area: spread(),
    targets: [ogre("ogre1"), ogre("ogre2")],
    spellEffectId: "entangle",
    ...overrides,
  };
  // `exactOptionalPropertyTypes`: an explicit `undefined` override must vanish, not linger.
  for (const key of Object.keys(out) as Array<keyof typeof out>)
    if (out[key] === undefined) delete out[key];
  return out as PF1eAreaCastFlowParams;
}

/** The one committed batch's card action. */
function committedCard(client: FakeClient): { message: MessageDocument; action: ActionCard } {
  expect(client.submitted.length).toBe(1);
  const batch = client.submitted[0] as Op[];
  const create = batch.find((op) => op.kind === "create");
  if (create?.kind !== "create") throw new Error("card create missing");
  const message = create.data as unknown as MessageDocument;
  const checked = validateActionCard(
    (message.system as { action?: unknown }).action,
  );
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error(checked.error);
  return { message, action: checked.action };
}

describe("D-408 area cast flow", () => {
  test("resolves N rows through one atomic commit with per-row delivery", async () => {
    const client = new FakeClient();
    // ogre1 (ref +0) rolls 1 vs DC 14 → fails → entangled; ogre2 (ref +5) rolls
    // 10 (+5 = 15) → passes → no condition.
    client.script = [{ die: 1 }, { die: 10 }];
    const p = areaParams({
      targets: [ogre("ogre1"), ogre("ogre2", { saves: { fort: 2, ref: 5, will: 1 } })],
    });
    const res = await resolveAreaCastFlow(client, owner, p);
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost) return;
    expect(res.dc).toBe(14); // 10 + level 1 + Wis +3
    expect(res.rows.length).toBe(2);
    expect(res.rows[0]?.result.passed).toBe(false);
    expect(res.rows[1]?.result.passed).toBe(true);
    expect(res.rows[0]?.delivered).toEqual(["Entangled"]);
    expect(res.rows[1]?.delivered).toEqual([]);

    // One commit: the card plus every row's writes, never one card per row.
    const { message, action } = committedCard(client);
    expect(message._id).toBe(res.cardId);
    expect(message.name).toBe("Entangle cast");
    expect(action.targets.length).toBe(2);
    expect(action.targets.map((row) => row.outcome)).toEqual(["failedSave", "saved"]);
    expect(action.area).toEqual(p.area);
    expect(message.content).toContain("40-ft-radius spread");
    expect(message.content).toContain("2 target rows");
    expect(message.content).toContain("ogre2 avoided it");
    // Each row carries its own verifiable evidence with a distinct save roll.
    const payloads = action.targets.map(
      (row) => (row.evidence as { adapter: string; payload: { saveRollId: string } }).payload,
    );
    expect(action.targets[0]?.evidence).toMatchObject({ adapter: "pf1e.spellTarget.v1" });
    expect(payloads[0]?.saveRollId).not.toBe(payloads[1]?.saveRollId);

    // The slot is spent exactly once across all rows.
    const diffs = (client.submitted[0] as Op[]).flatMap((op) =>
      op.kind === "update" ? [op.diff as Record<string, unknown>] : [],
    );
    // A first-ever spend writes the whole `slotsUsed` object; either way it lands once.
    expect(
      diffs.filter((diff) =>
        Object.keys(diff).some((key) => key.startsWith("system.pf1e.spells.slotsUsed")),
      ).length,
    ).toBe(1);

    // Only the failed row delivers, under a row-discriminated idempotency key.
    expect(client.conditionRequests).toEqual([{
      request: { action: "apply", actorId: "ogre1", condition: "Entangled",
        spell: { effectId: "entangle", actionId: res.cardId, targetKey: "ogre1" } },
      requestId: `speffect-${res.cardId}-r0-0`,
    }]);
  });

  test("a failing row fails the whole cast with nothing committed", async () => {
    const client = new FakeClient();
    client.script = [
      { die: 4, total: 7 }, // row 1 damage
      { die: 1 }, // row 1 save: fails
      { badTotal: true }, // row 2 damage: the roll message carries no total
    ];
    const res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({
        spellEffectId: undefined,
        authored: { saveType: "ref", severity: "half", damageFormula: "2d6" },
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no total");
    expect(client.formulas).toEqual(["2d6", "1d20", "2d6"]);
    expect(client.submitted.length).toBe(0);
    expect(client.conditionRequests.length).toBe(0);
  });

  test("area and target validation refuses before any die rolls", async () => {
    const fresh = () => new FakeClient();
    // No affected creatures.
    let client = fresh();
    let res = await resolveAreaCastFlow(client, owner, areaParams({ targets: [] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("at least one affected creature");
    // More than 24 affected creatures.
    client = fresh();
    res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({ targets: Array.from({ length: 25 }, (_, i) => ogre(`ogre${i}`)) }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("at most 24");
    // The same actor twice.
    client = fresh();
    const twice = ogre("ogre1");
    res = await resolveAreaCastFlow(client, owner, areaParams({ targets: [twice, ogre("ogre1")] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("listed twice");
    // A malformed area.
    client = fresh();
    res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({ area: { ...spread(), shape: "blob" as unknown as ActionArea["shape"] } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("area is unusable");
    expect(client.formulas).toEqual([]);
    expect(client.submitted.length).toBe(0);
  });

  test("concentration declarations and exotic gate timing are refused by name", async () => {
    const gateBase = {
      components: "V, S, DF",
      caster: {
        canSpeak: true, hasFreeHand: true, componentsInHand: true,
        deafened: false, grappled: false, pinned: false,
      },
      castingTime: "standard" as const,
    };
    let client = new FakeClient();
    let res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({ gate: { ...gateBase, declarations: [{ situation: "entangled" }] } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("concentration checks");
    expect(res.error).toContain("entangled");
    client = new FakeClient();
    res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({ gate: { ...gateBase, castingTime: "swift" } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('"swift"');
    client = new FakeClient();
    res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({ gate: { ...gateBase, castingTime: "longer" } }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('"longer"');
    expect(client.formulas).toEqual([]);
    expect(client.submitted.length).toBe(0);
  });

  test("a ruined gate loses the spell with one skipped row per creature", async () => {
    const client = new FakeClient();
    client.script = [{ die: 50 }]; // d100 ≤ 100% spell failure: always lost
    const plated = actor("wizard", {
      ...(wizardActor.system as { pf1e: Record<string, Json> }).pf1e,
      armor: { spellFailure: 100 },
    });
    const res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({
        casterActor: plated,
        casterDerived: wizard,
        spell: { name: "Magic Missile", level: 1, preparedIndex: 0 },
        authored: { saveType: "ref", severity: "half", damageFormula: "2d6" },
        spellEffectId: undefined,
        gate: {
          components: "V, S",
          caster: {
            canSpeak: true, hasFreeHand: true, componentsInHand: true,
            deafened: false, grappled: false, pinned: false,
          },
          castingTime: "standard",
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.lost) return;
    expect(res.affected).toBe(2);
    // Only the spell-failure die rolled; no row ever resolved.
    expect(client.formulas).toEqual(["1d100"]);
    const { message, action } = committedCard(client);
    expect(message.name).toBe("Magic Missile lost");
    expect(action.state).toBe("failed");
    expect(action.targets.length).toBe(2);
    expect(action.targets.every((row) => row.state === "skipped" && row.outcome === "unaffected")).toBe(true);
    expect(client.conditionRequests.length).toBe(0);
  });

  test("a row that would defer its save names the table setting", async () => {
    const client = new FakeClient();
    client.settings = [{ type: "settings", system: { playerPendingRollMode: "manual" } }];
    const res = await resolveAreaCastFlow(client, owner, areaParams());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("cannot defer saves");
    expect(res.error).toContain("ogre1");
    expect(res.error).toContain("one by one");
    expect(client.formulas).toEqual([]);
    expect(client.submitted.length).toBe(0);
  });

  test("SR ledger rows compose per target in the one commit", async () => {
    const client = new FakeClient();
    // CL 3 + d20 10 = 13 vs SR 10: overcome on both rows; both saves fail.
    client.script = [{ die: 10 }, { die: 1 }, { die: 10 }, { die: 1 }];
    const res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({
        combat: combat(2),
        targets: [ogre("ogre1", { spellResistance: 10 }), ogre("ogre2", { spellResistance: 10 })],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost) return;
    expect(res.rows.every((row) => row.sr.resisted === false && row.sr.reused === false)).toBe(true);
    expect(client.submitted.length).toBe(1);
    const diffs = (client.submitted[0] as Op[]).flatMap((op) =>
      op.kind === "update" ? [op.diff as Record<string, unknown>] : [],
    );
    expect(diffs.some((diff) => diff["flags.pf1e.srOvercome.druid:ogre1"] === 2)).toBe(true);
    expect(diffs.some((diff) => diff["flags.pf1e.srOvercome.druid:ogre2"] === 2)).toBe(true);
    // Both failed rows deliver under distinct row keys.
    expect(client.conditionRequests.map((entry) => entry.requestId)).toEqual([
      `speffect-${res.cardId}-r0-0`,
      `speffect-${res.cardId}-r1-0`,
    ]);
  });

  test("a refused HP write narrates per row without a raw write", async () => {
    const client = new FakeClient();
    client.script = [
      { die: 4, total: 7 }, // row 1 damage
      { die: 1 }, // row 1 save: fails → full 7
      { die: 3, total: 5 }, // row 2 damage
      { die: 1 }, // row 2 save: fails → full 5
    ];
    const unowned = ogre("ogre2");
    unowned.actor = actor(
      "ogre2",
      { ...(unowned.actor.system as { pf1e: Record<string, Json> }).pf1e },
      { default: 0 },
    );
    const res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({
        spellEffectId: undefined,
        authored: { saveType: "ref", severity: "half", damageFormula: "2d6" },
        targets: [ogre("ogre1"), unowned],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost) return;
    expect(res.rows[0]?.hpWriteError).toBeNull();
    expect(res.rows[1]?.hpWriteError).toContain("own");
    // No write of any kind touches the unowned actor — the area flow never
    // takes the host-verified raw-HP fast path.
    const updates = (client.submitted[0] as Op[]).filter((op) => op.kind === "update") as Array<{
      kind: "update";
      ref: { coll: string; id: string };
      diff: Record<string, unknown>;
    }>;
    expect(updates.some((op) => op.ref.id === "ogre2")).toBe(false);
    expect(updates.some((op) => op.ref.id === "ogre1")).toBe(true);
    const { message } = committedCard(client);
    expect(message.content).toContain("HP write rejected");
  });

  test("spatial context fills tokens from the caller's visible scenes", async () => {
    const client = new FakeClient();
    client.script = [{ die: 1 }, { die: 1 }];
    client.scenes = [{
      _id: "scene",
      active: true,
      tokens: [
        { _id: "t-caster", actorId: "druid" },
        { _id: "t-1", actorId: "ogre1" },
        { _id: "t-2", actorId: "ogre2" },
      ],
    }];
    const targets = [ogre("ogre1"), ogre("ogre2")];
    const res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({ casterTokenId: undefined, targets }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost) return;
    expect(res.rows.map((row) => row.tokenId)).toEqual(["t-1", "t-2"]);
    const { action } = committedCard(client);
    expect(action.source).toMatchObject({ actorId: "druid", tokenId: "t-caster" });
    expect(action.targets.map((row) => row.tokenId)).toEqual(["t-1", "t-2"]);
  });

  test("an unknown spell effect id narrates instead of delivering", async () => {
    const client = new FakeClient();
    client.script = [{ die: 1 }, { die: 1 }];
    const res = await resolveAreaCastFlow(
      client,
      owner,
      areaParams({ spellEffectId: "nope" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.lost) return;
    expect(res.rows.map((row) => row.delivered)).toEqual([[], []]);
    expect(client.conditionRequests.length).toBe(0);
    const { message } = committedCard(client);
    expect(message.content).toContain('unknown spell effect "nope"');
  });
});
