import { describe, expect, it } from "vitest";
import { generateTacticalTokens, syncTacticalOutcomeOps } from "../../src/core/sceneLink";
import type { ArmyDocument } from "../../src/core/strategic";

describe("Strategic↔Tactical Scene Linking (§9A)", () => {
  it("generates tactical tokens from strategic armies", () => {
    const armies: ArmyDocument[] = [
      {
        _id: "army-1",
        type: "army",
        name: "First Army",
        factionId: "f1",
        ownership: { default: 3 },
        flags: {},
        system: {},
        commander: [],
        supply: {},
        units: [
          {
            _id: "unit-1",
            type: "infantry",
            name: "Cohort A",
            ownership: { default: 3 },
            flags: {},
            system: {},
            profile: {},
            formation: "line",
            sceneId: "scene-strat",
            modelRange: [0, 10],
            orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
            stats: { strength: 50, morale: 5, supply: 5, fatigue: 0 },
          },
        ],
      },
    ];

    const tokens = generateTacticalTokens({
      armies,
      targetSceneId: "scene-tactical",
      gridSize: 100,
    });

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.name).toBe("Cohort A (First Army)");
    expect(tokens[0]?.flags["core"]?.["unitId"]).toBe("unit-1");
    expect(tokens[0]?.system["strength"]).toBe(50);
  });

  it("syncs tactical battle outcome back to strategic units", () => {
    const armies: ArmyDocument[] = [
      {
        _id: "army-1",
        type: "army",
        name: "First Army",
        factionId: "f1",
        ownership: { default: 3 },
        flags: {},
        system: {},
        commander: [],
        supply: {},
        units: [
          {
            _id: "unit-1",
            type: "infantry",
            name: "Cohort A",
            ownership: { default: 3 },
            flags: {},
            system: {},
            profile: {},
            formation: "line",
            sceneId: "scene-strat",
            modelRange: [0, 10],
            orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
            stats: { strength: 50, morale: 5, supply: 5, fatigue: 0 },
          },
        ],
      },
    ];

    const tokens = generateTacticalTokens({
      armies,
      targetSceneId: "scene-tactical",
      gridSize: 100,
    });

    const token = tokens[0];
    expect(token).toBeDefined();
    if (token) {
      token.system["strength"] = 32;
    }

    const ops = syncTacticalOutcomeOps(tokens, armies);
    expect(ops).toHaveLength(1);
    const armyDiff = (ops[0] as unknown as { diff: { units: Array<{ stats: { strength: number } }> } }).diff.units;
    expect(armyDiff[0]?.stats.strength).toBe(32);
  });
});
