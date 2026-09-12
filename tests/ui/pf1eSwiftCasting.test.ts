import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CombatDocument,
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

/**
 * P5/C03 swift/quickened timing (D-163). Transcribed before encoding: AoN
 * Rules ID 157 ("Swift Actions", CRB pg. 188) — "You can, however, perform
 * only one single swift action per turn, regardless of what other actions
 * you take"; Rules ID 158 ("Cast a Quickened Spell", CRB pg. 188) — "You can
 * cast a quickened spell (see the Quicken Spell feat), or any spell whose
 * casting time is designated as a free or swift action, as a swift action.
 * Only one such spell can be cast in any round, and such spells don't count
 * toward your normal limit of one spell per round. Casting a spell as a
 * swift action doesn't incur an attack of opportunity." The per-turn swift
 * bucket is the D-131 action ledger; these flows exercise it end to end.
 */

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

/** Int 16 (+3), CL 5, level-1 slots: DC 14 for level 1. */
function wizard(): ActorDocument {
  return actor("wizard", {
    abilities: { int: 16 },
    spells: {
      keyAbility: "int",
      mode: "prepared",
      casterLevel: 5,
      slotsPerDay: { 0: 3, 1: 4 },
    },
  });
}

function ogre(): ActorDocument {
  return actor("ogre", {
    abilities: { dex: 8, con: 14 },
    hp: 20,
    hpMax: 20,
    saves: { fort: 2, ref: 0, will: 1 },
  });
}

/** The wizard fights as combatant `wiz-c`; pre-set ledger flags optional. */
function combatWithWizard(
  actionFlags: Record<string, unknown> | null = null,
): CombatDocument {
  return {
    _id: "fight",
    type: "combat",
    name: "fight",
    ownership: { default: 3 },
    flags: {},
    system: {},
    round: 1,
    turn: 0,
    combatants: [
      {
        _id: "wiz-c",
        type: "combatant",
        name: "wizard",
        tokenId: null,
        actorId: "wizard",
        initiative: null,
        hidden: false,
        defeated: false,
        ownership: { default: 3 },
        flags: actionFlags !== null ? { pf1e: { actions: actionFlags } } : {},
        system: {},
      },
    ],
  } as unknown as CombatDocument;
}

class FakeClient implements CastFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  private seq = 0;
  readonly store = {
    getAll: (coll: "messages"): readonly unknown[] =>
      coll === "messages" ? this.messages : [],
  };

  roll(formula: string): string {
    this.formulas.push(formula);
    const rollId = `r${this.seq++}`;
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
        total: 5,
        terms: [
          { kind: "dice", expr: formula, rolls: [5], kept: [5], total: 5 },
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

/** A die-less, save-less cast — the only state in play is the action budget. */
function castParams(
  overrides: Partial<PF1eCastFlowParams> = {},
): PF1eCastFlowParams {
  const caster = wizard();
  const target = ogre();
  return {
    casterActor: caster,
    casterDerived: deriveFromDocuments({ actor: caster }),
    spell: { name: "Shield", level: 1 },
    authored: { saveType: "ref", severity: "none", damageFormula: "" },
    targetName: "ogre",
    targetActor: target,
    targetDerived: deriveFromDocuments({ actor: target }),
    ...overrides,
  };
}

function combatUpdates(client: FakeClient): Op[] {
  return client.submitted
    .flat()
    .filter((op) => op.kind === "update" && op.ref.coll === "combats");
}

function cardContent(client: FakeClient): string {
  const create = client.submitted
    .flat()
    .find((op) => op.kind === "create" && op.coll === "messages");
  if (create?.kind !== "create") return "";
  return String((create.data as MessageDocument).content ?? "");
}

function ledgerOf(op: Op | undefined): Record<string, unknown> | null {
  if (op === undefined || op.kind !== "update") return null;
  const combatants = (op.diff as Record<string, unknown>).combatants as Array<
    Record<string, unknown>
  >;
  const wiz = combatants.find((c) => c._id === "wiz-c");
  if (!wiz) return null;
  const flags = wiz.flags as Record<string, unknown>;
  const pf1e = flags.pf1e as Record<string, unknown>;
  return (pf1e.actions as Record<string, unknown>) ?? null;
}

describe("P5/C03 swift/quickened timing (D-163, Rules IDs 157/158)", () => {
  test("a swift cast spends the linked combatant's swift action", async () => {
    const client = new FakeClient();
    const combat = combatWithWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams({ castingTime: "swift", combat, combatantId: "wiz-c" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No dice in play for a die-less cast.
    expect(client.formulas).toEqual([]);
    const updates = combatUpdates(client);
    expect(updates).toHaveLength(1);
    expect(ledgerOf(updates[0])).toMatchObject({ swiftUsed: true });
    expect(cardContent(client)).toMatch(
      /cast as a swift action — does not provoke/,
    );
  });

  test("a spell with a free casting time also rides the swift bucket", async () => {
    const client = new FakeClient();
    const combat = combatWithWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams({ castingTime: "free", combat, combatantId: "wiz-c" }),
    );
    expect(res.ok).toBe(true);
    expect(ledgerOf(combatUpdates(client)[0])).toMatchObject({
      swiftUsed: true,
    });
  });

  test("a second swift spell in the same turn is refused by name", async () => {
    const client = new FakeClient();
    const combat = combatWithWizard({ swiftUsed: true });
    const res = await resolveCastFlow(
      client,
      owner,
      castParams({ castingTime: "swift", combat, combatantId: "wiz-c" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/swift action already used/);
    // Nothing is spent, nothing is rolled, nothing is published.
    expect(client.submitted).toEqual([]);
    expect(client.formulas).toEqual([]);
  });

  test("an off-turn immediate action already consumed this swift action", async () => {
    const client = new FakeClient();
    const combat = combatWithWizard({ swiftReserved: true });
    const res = await resolveCastFlow(
      client,
      owner,
      castParams({ castingTime: "swift", combat, combatantId: "wiz-c" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/immediate action/);
    expect(client.submitted).toEqual([]);
  });

  test("a quickened cast spends the swift action and narrates the timing", async () => {
    const client = new FakeClient();
    const combat = combatWithWizard();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams({ quickened: true, combat, combatantId: "wiz-c" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(ledgerOf(combatUpdates(client)[0])).toMatchObject({
      swiftUsed: true,
    });
    const content = cardContent(client);
    expect(content).toMatch(/quickened swift action/);
    expect(content).toMatch(/does not count against the one-spell-per-round/);
  });

  test("a quickened spell cannot take a casting time of 1 round or more", async () => {
    const client = new FakeClient();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams({
        quickened: true,
        castingTime: "longer",
        combat: combatWithWizard(),
        combatantId: "wiz-c",
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/swift action this round/);
    expect(client.submitted).toEqual([]);
  });

  test("without an encounter the swift usage stays the GM's call", async () => {
    const client = new FakeClient();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams({ castingTime: "swift" }),
    );
    expect(res.ok).toBe(true);
    expect(combatUpdates(client)).toEqual([]);
    if (!res.ok) return;
    if (res.lost || res.held || res.pending) return;
    expect(res.warnings.join(" ")).toMatch(/swift action/);
  });

  test("an unknown combatant id casts on without spending a ledger", async () => {
    const client = new FakeClient();
    const res = await resolveCastFlow(
      client,
      owner,
      castParams({
        castingTime: "swift",
        combat: combatWithWizard(),
        combatantId: "ghost",
      }),
    );
    expect(res.ok).toBe(true);
    expect(combatUpdates(client)).toEqual([]);
  });
});
