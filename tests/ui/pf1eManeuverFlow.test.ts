import { describe, expect, test } from "vitest";
import type { ActorDocument, CombatDocument, MessageDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type { Json } from "../../src/core/documents";
import { resolveManeuverFlow, type ManeuverFlowClient } from "../../src/ui/combat/pf1eManeuverFlow";
import type { PermissionUser } from "../../src/core/ownership";

const owner: PermissionUser = { id: "player", role: "PLAYER" };

function actor(id: string, name: string, pf1e: Record<string, Json>): ActorDocument {
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
  abilities: { str: 18, dex: 14, con: 14 },
  baseAttack: 6,
  hp: 20,
  hpMax: 20,
  attacks: [
    {
      name: "Longsword",
      damageDice: "1d8",
      damageBonus: 4,
      damageType: "slashing",
      critThreatMin: 19,
      critMultiplier: 2,
    },
  ],
});

const goblin = actor("goblin", "Goblin", {
  abilities: { dex: 14, con: 12 },
  hp: 12,
  hpMax: 12,
  armorClass: { armor: 2 },
  // CMD will be 10 + 1 (BAB?) + str/dex + size + 0. For goblin with no BAB => CMD 13? We just need deterministic.
});

class FakeClient implements ManeuverFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  script: Array<{ die?: number; total: number }> = [];
  verifiable = false;
  private seq = 0;
  readonly store = {
    getAll: (coll: "messages"): readonly unknown[] => (coll === "messages" ? this.messages : []),
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
    // For this test, verified is just roll
    return this.roll(formula);
  }
  submit(ops: Op[]): string {
    this.submitted.push(ops);
    return "tx";
  }
}

describe("resolveManeuverFlow", () => {
  test("trip succeeds on high die, posts a card and condition ops", async () => {
    const client = new FakeClient();
    // Derive to know CMD — but we can just make die 20 to ensure success
    client.script = [{ die: 20, total: 20 }];
    const result = await resolveManeuverFlow(client, owner, {
      attacker: fighter,
      defender: goblin,
      kind: "trip",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(client.formulas).toEqual(["1d20"]);
    // One card + condition ops (possibly one submit for card and one for ops, or combined)
    const allCreates = client.submitted.flat().filter((op) => op.kind === "create");
    expect(allCreates.length).toBe(1);
    const card = allCreates[0];
    if (card?.kind !== "create") throw new Error("expected create");
    const doc = card.data as MessageDocument;
    expect(doc.content).toContain("Fighter — trip vs Goblin");
    expect(doc.content).toContain("SUCCESS");
  });

  test("a maneuver that provokes threads defender AoO damage as penalty (the 20+ AoO path)", async () => {
    // Defender is fighter (has a melee line), attacker is goblin (provokes trip)
    const defenderFighter = actor("def-fighter", "Defender", {
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
    });
    const attackerGoblin = actor("atk-goblin", "Goblin", {
      abilities: { dex: 14 },
      hp: 12,
      hpMax: 12,
    });
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
        { _id: "c-atk", actorId: attackerGoblin._id, tokenId: "t-atk", initiative: 10, defeated: false, flags: {}, type: "combatant", hidden: false, name: "Goblin", ownership: { default: 1 }, system: {} },
        { _id: "c-def", actorId: defenderFighter._id, tokenId: "t-def", initiative: 5, defeated: false, flags: { pf1e: { acted: true } }, type: "combatant", hidden: false, name: "Defender", ownership: { default: 1 }, system: {} },
      ],
    } as unknown as CombatDocument;
    const tokens = [
      { _id: "t-atk", actorId: attackerGoblin._id },
      { _id: "t-def", actorId: defenderFighter._id },
    ];
    const client = new FakeClient();
    // Sequence: defender AoO attack die, defender AoO damage, then attacker maneuver die
    // Goblin's trip: we want it to fail because AoO damage is huge penalty
    // First roll: AoO attack 11 + 9 = 20 vs Goblin AC — hits, damage 10
    // Second roll: damage 10
    // Third roll: maneuver die 10 vs CMD — should be penalized by 10, so likely fails even if would succeed
    client.script = [
      { die: 11, total: 20 },
      { total: 10 },
      { die: 10, total: 10 },
    ];
    const result = await resolveManeuverFlow(client, owner, {
      attacker: attackerGoblin,
      defender: defenderFighter,
      kind: "trip",
      combat,
      tokens,
      hasImprovedFeat: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // AoO damage should be captured
    expect(result.aooDamage).toBe(10);
    // The maneuver card should mention the AoO penalty
    const cardOps = client.submitted.flat().filter((op) => op.kind === "create");
    const last = cardOps[cardOps.length - 1] as unknown as { kind: "create"; data: MessageDocument } | undefined;
    const cardDoc = last?.data ?? null;
    expect(cardDoc?.content).toContain("AoO 10 as penalty");
  });

  test("Improved maneuver does not trigger AoO", async () => {
    const defenderFighter = actor("def2", "Defender", {
      abilities: { str: 16, dex: 14 },
      baseAttack: 6,
      hp: 20,
      hpMax: 20,
      attacks: [{ name: "Longsword", damageDice: "1d8", damageBonus: 3, damageType: "slashing" }],
    });
    const attackerGoblin = actor("atk2", "Goblin", { abilities: { dex: 14 }, hp: 12, hpMax: 12 });
    const combat = {
      _id: "enc2",
      type: "combat",
      name: "Encounter",
      ownership: { default: 1 },
      flags: {},
      system: {},
      round: 1,
      turn: 0,
      combatants: [
        { _id: "c-atk2", actorId: attackerGoblin._id, tokenId: "t-atk2", initiative: 10, defeated: false, flags: {}, type: "combatant", hidden: false, name: "Goblin", ownership: { default: 1 }, system: {} },
        { _id: "c-def2", actorId: defenderFighter._id, tokenId: "t-def2", initiative: 5, defeated: false, flags: {}, type: "combatant", hidden: false, name: "Defender", ownership: { default: 1 }, system: {} },
      ],
    } as unknown as CombatDocument;
    const tokens = [
      { _id: "t-atk2", actorId: attackerGoblin._id },
      { _id: "t-def2", actorId: defenderFighter._id },
    ];
    const client = new FakeClient();
    client.script = [{ die: 20, total: 20 }];
    const result = await resolveManeuverFlow(client, owner, {
      attacker: attackerGoblin,
      defender: defenderFighter,
      kind: "trip",
      combat,
      tokens,
      hasImprovedFeat: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("ok");
    expect(result.aooDamage).toBeNull();
    // Only one die should have been rolled (the maneuver), not the AoO attack+damage
    expect(client.formulas).toEqual(["1d20"]);
  });

  test("concealment d% is rolled after the maneuver die and can cause a miss on otherwise success", async () => {
    const client = new FakeClient();
    // High maneuver die would succeed, but d% 15 ≤ 20 causes concealment miss
    client.script = [
      { die: 20, total: 20 },
      { die: 15, total: 15 },
    ];
    const result = await resolveManeuverFlow(client, owner, {
      attacker: fighter,
      defender: goblin,
      kind: "drag",
      concealment: { percent: 20, label: "fog" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("ok");
    expect(client.formulas).toEqual(["1d20", "1d100"]);
    const cardOps2 = client.submitted.flat().filter((op) => op.kind === "create");
    const first = cardOps2[0] as unknown as { kind: "create"; data: MessageDocument } | undefined;
    const cardDoc = first?.data ?? null;
    expect(cardDoc?.content).toContain("concealment miss");
  });

  test("grapple initial posts grappled conditions on both", async () => {
    const client = new FakeClient();
    client.script = [{ die: 20, total: 20 }];
    const result = await resolveManeuverFlow(client, owner, {
      attacker: fighter,
      defender: goblin,
      kind: "grapple",
      grappleOpts: { targetAdjacent: true, hasAdjacentSpace: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("ok");
    // Should have condition ops for both
    const updateOps = client.submitted.flat().filter((op) => op.kind === "update");
    expect(updateOps.length).toBeGreaterThanOrEqual(1);
  });
});
