import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRealPf1Caster, openRealPf1World } from "./realPf1";
import { freshTable } from "./realUsers";

/** Independent regression for the oversized/deep real-character write and read blocker. */
test("real PF1 Battle Mage plus Fireball imports losslessly through bounded document RPC", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const world = fileURLToPath(
    new URL("../dist/worlds/real-pf1-minimal-test-1.0.0.zip", import.meta.url),
  );
  expect(existsSync(world), "Run npm run test:e2e:real-users:prepare").toBe(
    true,
  );
  const table = await freshTable(browser, false);
  try {
    await openRealPf1World(table.gm, world, "Real PF1 Minimal", ["pf1"]);
    await createRealPf1Caster(table.gm);
    expect(table.errors).toEqual([]);
  } finally {
    await table.close();
  }
});
