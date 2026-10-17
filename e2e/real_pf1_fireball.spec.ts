import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openRealPf1World } from "./realPf1";

const worldPath = fileURLToPath(
  new URL("../dist/worlds/real-pf1-minimal-test-1.0.0.zip", import.meta.url),
);
// This is content retrieval + sandbox Roll coverage, NOT spell-casting/damage/revert acceptance.
test("Real PF1 Fireball document loads and adapter Roll evaluates dice under the sandbox CSP", async ({
  page,
}) => {
  test.setTimeout(400000);
  test.skip(
    !existsSync(worldPath),
    "Build the external real-PF1 fixture first",
  );
  await openRealPf1World(page, worldPath, "Real PF1 Minimal", ["pf1"]);
  const result = await page
    .frameLocator('iframe[title="AIS module:pf1"]')
    .locator("body")
    .evaluate(async () => {
      const realm = globalThis as unknown as {
        game: {
          packs: Map<
            string,
            {
              getIndex(): Promise<Array<{ _id: string; name: string }>>;
              getDocument(
                id: string,
              ): Promise<{
                name: string;
                toObject(): { system?: unknown };
              } | null>;
            }
          >;
        };
        Roll: new (formula: string) => {
          evaluate(): Promise<{
            total: number;
            dice: Array<{ results: number[] }>;
          }>;
        };
      };
      const spells = realm.game.packs.get("pf1.spells");
      if (!spells) throw new Error("pf1.spells missing");
      const entry = (await spells.getIndex()).find(
        (e) => e.name === "Fireball",
      );
      if (!entry) throw new Error("Fireball index entry missing");
      const spell = await spells.getDocument(entry._id);
      if (!spell) throw new Error("Fireball document missing");
      const roll = await new realm.Roll("5d6").evaluate();
      return {
        name: spell.name,
        system: spell.toObject().system,
        total: roll.total,
        diceSum: roll.dice
          .flatMap((die) => die.results)
          .reduce((sum, value) => sum + value, 0),
      };
    });
  expect(result.name).toBe("Fireball");
  expect(result.system).toBeTruthy();
  expect(result.total).toBeGreaterThanOrEqual(5);
  expect(result.total).toBeLessThanOrEqual(30);
  expect(result.total).toBe(result.diceSum);
});
