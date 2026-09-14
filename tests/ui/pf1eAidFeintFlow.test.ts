import { describe, expect, test } from "vitest";
import type { ActorDocument, CombatDocument, MessageDocument } from "../../src/core/documents";
import type { Json } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type { PermissionUser } from "../../src/core/ownership";
import { resolveAidAnotherFlow, resolveFeintFlow, type AidFeintFlowClient } from "../../src/ui/combat/pf1eAidFeintFlow";

const owner: PermissionUser = { id: "player", role: "PLAYER" };

function actor(id: string, name: string, pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name,
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e: pf1e as unknown as Record<string, Json> },
    items: [],
    effects: [],
  };
}

const fighter = actor("fighter", "Fighter", {
  abilities: { str: 16, dex: 14 },
  baseAttack: 6,
  hp: 20,
  hpMax: 20,
  attacks: [{ name: "Longsword", damageDice: "1d8", damageBonus: 3, damageType: "slashing", critThreatMin: 19, critMultiplier: 2 }],
});

const rogue = actor("rogue", "Rogue", {
  abilities: { cha: 16, str: 10, dex: 14 },
  baseAttack: 4,
  hp: 20,
  hpMax: 20,
  attacks: [{ name: "Rapier", damageDice: "1d6", damageBonus: 2, damageType: "piercing" }],
});

const goblin = actor("goblin", "Goblin", {
  abilities: { dex: 14, wis: 12 },
  baseAttack: 2,
  hp: 12,
  hpMax: 12,
  armorClass: { armor: 2 },
});

const ogre = actor("ogre", "Ogre", {
  abilities: { str: 20, wis: 8, int: 6 },
  baseAttack: 6,
  hp: 30,
  hpMax: 30,
  attacks: [{ name: "Greatclub", damageDice: "2d6", damageBonus: 7, damageType: "bludgeoning" }],
});

class FakeClient implements AidFeintFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  script: Array<{ die?: number; total: number }> = [];
  private seq = 0;
  readonly store = {
    getAll: (coll: string): readonly unknown[] => {
      if (coll === "messages") return this.messages as unknown as readonly unknown[];
      if (coll === "settings") return [{ _id: "world-settings", type: "settings", name: "World Settings", ownership: { default: 1 }, flags: {}, system: { playerPendingRollMode: "auto" } }] as unknown as readonly unknown[];
      return [];
    },
  };
  roll(formula: string): string {
    this.formulas.push(formula);
    const rollId = `r${this.seq++}`;
    const entry = this.script.shift() ?? { total: 10 };
    const terms =
      entry.die === undefined
        ? [{ kind: "dice", expr: formula, rolls: [4], kept: [4], total: 4 }]
        : [{ kind: "dice", expr: formula, rolls: [entry.die], kept: [entry.die], total: entry.die }];
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
        terms: terms as unknown as MessageDocument["roll"] extends { terms: infer T } ? T : never,
        seedClient: null,
        seedHost: null,
        commit: null,
      },
      flavor: "",
    } as MessageDocument);
    return rollId;
  }
  async rollVerified(formula: string): Promise<string> {
    return this.roll(formula);
  }
  submit(ops: Op[]): string {
    this.submitted.push(ops);
    return "tx";
  }
}

describe("resolveAidAnotherFlow", () => {
  test("aid succeeds on high die, posts a card", async () => {
    const client = new FakeClient();
    client.script = [{ die: 15, total: 15 }];
    const result = await resolveAidAnotherFlow(client, owner, {
      aider: fighter,
      aided: rogue,
      opponent: ogre,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("not ok");
    expect(client.formulas).toEqual(["1d20"]);
    const creates = client.submitted.flat().filter((op) => op.kind === "create");
    expect(creates.length).toBe(1);
    const doc = (creates[0] as unknown as { data: MessageDocument }).data;
    expect(doc.content).toContain("aid another");
    expect(doc.content).toContain("SUCCESS");
  });

  test("aid that provokes threads opponent AoO damage as penalty (conditional provoke)", async () => {
    const combat = {
      _id: "enc",
      type: "combat",
      name: "Encounter",
      ownership: { default: 1 },
      flags: {},
      system: {},
      round: 1,
      turn: 0,
      combatants: [
        { _id: "c-aider", actorId: fighter._id, tokenId: "t-aider", initiative: 10, defeated: false, flags: {}, type: "combatant", hidden: false, name: "Fighter", ownership: { default: 1 }, system: {} },
        { _id: "c-opp", actorId: ogre._id, tokenId: "t-opp", initiative: 5, defeated: false, flags: { pf1e: { acted: true } }, type: "combatant", hidden: false, name: "Ogre", ownership: { default: 1 }, system: {} },
        { _id: "c-aided", actorId: rogue._id, tokenId: "t-aided", initiative: 7, defeated: false, flags: {}, type: "combatant", hidden: false, name: "Rogue", ownership: { default: 1 }, system: {} },
      ],
    } as unknown as CombatDocument;
    const tokens = [
      { _id: "t-aider", actorId: fighter._id },
      { _id: "t-opp", actorId: ogre._id },
      { _id: "t-aided", actorId: rogue._id },
    ];
    const client = new FakeClient();
    // AoO attack die 12, AoO damage 8, then aid die 12
    // Without AoO, 12 + fighter attack (~+9) = 21 vs 10 => success
    // With AoO 8 penalty, 12+9-8=13 vs 10 => still success, but we check damage captured via card's AoO note
    client.script = [
      { die: 12, total: 21 },
      { total: 8 },
      { die: 12, total: 12 },
    ];
    const result = await resolveAidAnotherFlow(client, owner, {
      aider: fighter,
      aided: rogue,
      opponent: ogre,
      combat,
      tokens,
      aidedActionProvokes: true,
    });
    expect(result.ok).toBe(true);
    const creates2 = client.submitted.flat().filter((op) => op.kind === "create");
    const doc = (creates2[creates2.length - 1] as unknown as { data: MessageDocument }).data;
    expect(doc.content).toContain("AoO 8 as penalty");
  });
});

describe("resolveFeintFlow", () => {
  test("feint succeeds on high Bluff, posts a card with move action when Improved Feint", async () => {
    const client = new FakeClient();
    client.script = [{ die: 15, total: 15 }];
    const result = await resolveFeintFlow(client, owner, {
      feinter: rogue,
      target: goblin,
      bluffBonus: 12,
      hasImprovedFeint: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("not ok");
    expect(client.formulas).toEqual(["1d20"]);
    const creates = client.submitted.flat().filter((op) => op.kind === "create");
    expect(creates.length).toBe(1);
    const doc = (creates[0] as unknown as { data: MessageDocument }).data;
    expect(doc.content).toContain("feint vs Goblin");
    expect(doc.content).toContain("SUCCESS");
  });

  test("feint against mindless target refuses", async () => {
    const client = new FakeClient();
    client.script = [{ die: 20, total: 20 }];
    const result = await resolveFeintFlow(client, owner, {
      feinter: rogue,
      target: goblin,
      bluffBonus: 12,
      targetIntScore: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("lacking an Intelligence score");
  });
});
