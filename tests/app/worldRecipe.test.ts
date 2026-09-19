/**
 * D-249 — a world created from a recipe boots on its strategic ruleset the FIRST time, with
 * its content packs indexed, and no activate/reload step in between. Tactical scenes are
 * untouched by the choice: the seeded scene is tactical whatever the recipe says.
 */
import "fake-indexeddb/auto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { bootHostApp, BUILTIN_SYSTEM_ID, DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import {
  checkRecipe,
  createWorldFromRecipe,
  describeRecipePackage,
  loadRecipePackage,
  type RecipePackage,
} from "../../src/app/worldRecipe";
import { sceneIsStrategic } from "../../src/core/strategicFog";
import type { SceneDocument } from "../../src/core/documents";
import { getWorld, listPackages, listWorlds, openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "./fakes";

const RULES_JS =
  "export default { schema: { version: '4.0.0', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] }, validateOrder(){ return {ok:true}; }, resolveTurn(){}, detection(){ return 5; } };";

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const rulesetZip = zipOf({
  "manifest.json": JSON.stringify({
    id: "recipe-rules",
    name: "Recipe Rules",
    version: "4.0.0",
    type: "system",
    dependencies: ["recipe-content"],
    rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
  }),
  "rules.js": RULES_JS,
});
const contentZip = zipOf({
  "manifest.json": JSON.stringify({
    id: "recipe-content",
    name: "Recipe Content",
    version: "1.0.0",
    type: "data",
    packs: [{ name: "Beasts", type: "actors", file: "packs/beasts.json" }],
  }),
  "packs/beasts.json": JSON.stringify({
    name: "Beasts",
    type: "actors",
    entries: [{ id: "wolf", name: "Wolf", data: { type: "actor", name: "Wolf", system: {} } }],
  }),
});

async function load(bytes: Uint8Array): Promise<RecipePackage> {
  const res = await loadRecipePackage(bytes);
  if (!res.ok) throw new Error(res.error);
  return res.pkg;
}

const boot = async (worldId: string): Promise<HostApp> =>
  bootHostApp({
    db: await openVttDb(),
    root: new MemDirHandle(),
    codec: new FakeCodec(),
    simRunner: new InlineSimRunner(),
    worldId: worldId as HostApp["worldId"],
  });

describe("createWorldFromRecipe", () => {
  test("ruleset + content: the first boot runs the package, packs are compendia, scene stays tactical", async () => {
    const db = await openVttDb();
    const ruleset = await load(rulesetZip);
    const content = await load(contentZip);
    expect(describeRecipePackage(ruleset)).toMatchObject({
      kind: "strategic ruleset",
      modelColumns: ["ammo"],
      dependencies: ["recipe-content"],
    });
    expect(describeRecipePackage(content)).toMatchObject({ kind: "content pack", packCount: 1 });

    const { worldId, warnings } = await createWorldFromRecipe(
      { name: "  Siege of Absalom ", ruleset: { kind: "package", pkg: ruleset }, content: [content] },
      { db, worldId: "w-recipe-1" as HostApp["worldId"] },
    );
    expect(worldId).toBe("w-recipe-1");
    expect(warnings).toEqual([]);
    const rec = await getWorld(db, worldId);
    expect(rec).toMatchObject({
      name: "Siege of Absalom",
      system: "recipe-rules",
      version: "4.0.0",
      activeRulesPackage: "recipe-rules",
      flushedSeq: 0,
    });
    expect(rec?.trustedPackages).toBeUndefined();
    expect((await listPackages(db, worldId)).map((p) => p.id)).toEqual([
      "recipe-content",
      "recipe-rules",
    ]);

    const app = await boot(worldId);
    expect(app.rulesBoot).toEqual({
      source: "package",
      packageId: "recipe-rules",
      version: "4.0.0",
      error: null,
    });
    expect(app.meta.system).toBe("recipe-rules");
    const scene = app.gm.client.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument;
    expect(sceneIsStrategic(scene)).toBe(false); // heroes-only until the GM says otherwise
    const packs = await app.packages.compendia();
    expect(packs.map((p) => p.pack.name)).toEqual(["Beasts"]);
    const rows = await app.packages.list();
    expect(rows.find((r) => r.id === "recipe-rules")).toMatchObject({
      active: true,
      missingDependencies: [],
    });
    // a fresh world: the pin is still changeable (no checkpoint) — the guard is not tripped
    // by creation itself
    expect((await app.packages.deactivate()).ok).toBe(true);
    await app.persister.flush();
    await app.close();
  });

  test("built-in recipe writes the built-in pair and no packages", async () => {
    const db = await openVttDb();
    const { worldId } = await createWorldFromRecipe(
      { name: "Plain", ruleset: { kind: "builtin" }, content: [] },
      { db },
    );
    expect(worldId).toMatch(/^w-/);
    expect(await getWorld(db, worldId)).toMatchObject({
      name: "Plain",
      system: BUILTIN_SYSTEM_ID,
      version: "1.0.0",
    });
    expect(await listPackages(db, worldId)).toEqual([]);
    const app = await boot(worldId);
    expect(app.rulesBoot.source).toBe("builtin");
    await app.persister.flush();
    await app.close();
  });

  test("checkRecipe: kinds are enforced, companions are advised", async () => {
    const ruleset = await load(rulesetZip);
    const content = await load(contentZip);
    expect(checkRecipe({ name: " ", ruleset: { kind: "builtin" }, content: [] }).errors).toEqual([
      "the world needs a name",
    ]);
    // content pack in the ruleset slot
    expect(
      checkRecipe({ name: "x", ruleset: { kind: "package", pkg: content }, content: [] }).errors[0],
    ).toContain("content pack, not a strategic ruleset");
    // ruleset in the content list
    expect(
      checkRecipe({ name: "x", ruleset: { kind: "builtin" }, content: [ruleset] }).errors[0],
    ).toContain("is a strategic ruleset");
    // duplicate
    expect(
      checkRecipe({ name: "x", ruleset: { kind: "builtin" }, content: [content, content] }).errors,
    ).toEqual(["package recipe-content is listed twice"]);
    // missing companion is a warning, not an error
    const advised = checkRecipe({
      name: "x",
      ruleset: { kind: "package", pkg: ruleset },
      content: [],
    });
    expect(advised.errors).toEqual([]);
    expect(advised.warnings).toEqual([
      "Recipe Rules expects recipe-content alongside it — not added",
    ]);
    const db = await openVttDb();
    const created = await createWorldFromRecipe(advised.errors.length ? (null as never) : {
      name: "Advised",
      ruleset: { kind: "package", pkg: ruleset },
      content: [],
    }, { db });
    expect(created.warnings).toHaveLength(1);
    // and an invalid recipe never reaches the database
    const before = (await listWorlds(db)).length;
    await expect(
      createWorldFromRecipe({ name: "", ruleset: { kind: "builtin" }, content: [] }, { db }),
    ).rejects.toThrow(/needs a name/);
    expect((await listWorlds(db)).length).toBe(before);
  });
});
