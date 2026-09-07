/**
 * §9A Strategic↔tactical scene linking & token mapping helpers.
 * Converts strategic units/armies into tactical tokens on linked tactical scenes,
 * and syncs tactical battle outcomes back to strategic unit strength.
 */
import type { TokenDocument } from "./documents";
import type { DocId } from "./ids";
import type { Op } from "./ops";
import type { ArmyDocument } from "./strategic";

export interface TacticalTokenGenOptions {
  armies: readonly ArmyDocument[];
  targetSceneId: DocId;
  gridSize?: number;
  startX?: number;
  startY?: number;
}

/**
 * Generates tactical TokenDocuments from strategic armies for deployment on a linked tactical scene (§9A).
 */
export function generateTacticalTokens(options: TacticalTokenGenOptions): TokenDocument[] {
  const { armies, gridSize = 100, startX = 200, startY = 200 } = options;
  const tokens: TokenDocument[] = [];

  let row = 0;
  for (const army of armies) {
    let col = 0;
    for (const unit of army.units) {
      const x = startX + col * (gridSize * 1.5);
      const y = startY + row * (gridSize * 2.0);

      const token: TokenDocument = {
        _id: `token-tac-${unit._id}`,
        type: "token",
        name: `${unit.name} (${army.name})`,
        ownership: { ...army.ownership },
        flags: {
          core: {
            unitId: unit._id,
            armyId: army._id,
            factionId: army.factionId,
            strategicLink: true,
          },
        },
        system: {
          strength: unit.stats.strength,
          maxStrength: unit.stats.strength,
          morale: unit.stats.morale,
        },
        x,
        y,
        rotation: 0,
        width: gridSize,
        height: gridSize,
        img: "",
        hidden: false,
        disposition: "friendly",
        vision: true,
        light: { radius: 0, color: "#ffffff", alpha: 0.5 },
      };

      tokens.push(token);
      col++;
    }
    row++;
  }

  return tokens;
}

/**
 * Computes update Ops to sync tactical token outcomes (e.g. current strength / HP)
 * back to strategic unit documents (§9A).
 */
export function syncTacticalOutcomeOps(
  tacticalTokens: readonly TokenDocument[],
  armies: readonly ArmyDocument[],
): Op[] {
  const ops: Op[] = [];

  for (const army of armies) {
    let updated = false;
    const units = army.units.map((unit) => {
      const tacToken = tacticalTokens.find(
        (t) => t.flags["core"]?.["unitId"] === unit._id,
      );
      if (!tacToken) return unit;

      const currentTacStrength =
        typeof tacToken.system["strength"] === "number"
          ? Math.max(0, tacToken.system["strength"])
          : unit.stats.strength;

      if (currentTacStrength !== unit.stats.strength) {
        updated = true;
        return {
          ...unit,
          stats: {
            ...unit.stats,
            strength: currentTacStrength,
          },
        };
      }

      return unit;
    });

    if (updated) {
      ops.push({
        kind: "update",
        ref: { coll: "armies", id: army._id },
        diff: { units: units as unknown as import("./documents").Json },
      });
    }
  }

  return ops;
}
