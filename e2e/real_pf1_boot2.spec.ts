import { test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openRealPf1World } from "./realPf1";

const worldPath = fileURLToPath(
  new URL("../dist/worlds/real-pf1-minimal-test-1.0.0.zip", import.meta.url),
);
test("Real pf1 minimal boots without synchronous lifecycle hook failures", async ({
  page,
}) => {
  test.setTimeout(240000);
  test.skip(
    !existsSync(worldPath),
    "Build the external real-PF1 fixture first",
  );
  await openRealPf1World(page, worldPath, "Real PF1 Minimal", ["pf1"]);
});
