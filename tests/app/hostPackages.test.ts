/**
 * D-248 Phase 0 — the §12 package surface tells the truth about the strategic ruleset:
 * the world record names the ruleset it runs, declared companions that are missing are
 * reported (never enforced, D-110), and the fresh-campaign pin holds for a checkpoint on ANY
 * scene — a world may run several strategic scenes beside its tactical ones.
 */
import "fake-indexeddb/auto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  bootHostApp,
  BUILTIN_SYSTEM_ID,
  BUILTIN_SYSTEM_VERSION,
  type HostApp,
} from "../../src/app/hostBoot";
import { getWorld, openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { HostPersister } from "../../src/storage/persistence";
import { putCheckpoint } from "../../src/storage/strategicStore";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "./fakes";

const RULES_JS =
  "export default { schema: { version: '3.1.0', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] }, validateOrder(){ return {ok:true}; }, resolveTurn(){}, detection(){ return 5; } };";

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const ruleset = (over: Record<string, unknown> = {}): Uint8Array =>
  zipOf({
    "manifest.json": JSON.stringify({
      id: "probe-rules",
      name: "Probe Rules",
      version: "3.1.0",
      type: "system",
      dependencies: ["probe-content"],
      rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
      ...over,
    }),
    "rules.js": RULES_JS,
  });

const content = (): Uint8Array =>
  zipOf({
    "manifest.json": JSON.stringify({
      id: "probe-content",
      name: "Probe Content",
      version: "1.0.0",
      type: "data",
    }),
  });

let n = 0;
async function freshApp(): Promise<HostApp> {
  const db = await openVttDb();
  const worldId = `w-pkg-${++n}` as HostApp["worldId"];
  await HostPersister.createWorld(db, {
    worldId,
    name: "Pkg",
    system: BUILTIN_SYSTEM_ID,
    systemVersion: BUILTIN_SYSTEM_VERSION,
  });
  return bootHostApp({
    db,
    root: new MemDirHandle(),
    codec: new FakeCodec(),
    simRunner: new InlineSimRunner(),
    worldId,
  });
}

describe("HostPackages — the record names the ruleset it runs", () => {
  test("activate writes system + version; deactivate restores the built-in pair", async () => {
    const app = await freshApp();
    expect((await app.packages.importZip(ruleset())).ok).toBe(true);
    expect((await app.packages.importZip(content())).ok).toBe(true);

    expect(await app.packages.activate("probe-rules")).toEqual({ ok: true });
    let rec = await getWorld(app.db, app.worldId);
    expect(rec).toMatchObject({
      activeRulesPackage: "probe-rules",
      system: "probe-rules",
      version: "3.1.0",
    });

    expect(await app.packages.deactivate()).toEqual({ ok: true });
    rec = await getWorld(app.db, app.worldId);
    expect(rec?.activeRulesPackage).toBeUndefined();
    expect(rec?.system).toBe(BUILTIN_SYSTEM_ID);
    expect(rec?.version).toBe(BUILTIN_SYSTEM_VERSION);
    await app.persister.flush();
    await app.close();
  });

  test("a missing declared companion is reported on the row and as an activate warning", async () => {
    const app = await freshApp();
    expect((await app.packages.importZip(ruleset())).ok).toBe(true);

    const [row] = await app.packages.list();
    expect(row).toMatchObject({
      id: "probe-rules",
      dependencies: ["probe-content"],
      missingDependencies: ["probe-content"],
    });

    const activated = await app.packages.activate("probe-rules");
    expect(activated.ok).toBe(true); // advisory: PF1e must stay loadable alone (D-110)
    if (activated.ok) {
      expect(activated.warnings).toHaveLength(1);
      expect(activated.warnings?.[0]).toContain("probe-content");
    }

    // importing the companion clears both signals
    expect((await app.packages.importZip(content())).ok).toBe(true);
    const rows = await app.packages.list();
    expect(rows.find((r) => r.id === "probe-rules")?.missingDependencies).toEqual([]);
    expect(rows.find((r) => r.id === "probe-content")).toMatchObject({
      type: "data",
      dependencies: [],
      missingDependencies: [],
    });
    await app.persister.flush();
    await app.close();
  });

  test("the fresh-campaign pin holds for a checkpoint on ANY scene, not only scene-1", async () => {
    const app = await freshApp();
    expect((await app.packages.importZip(ruleset())).ok).toBe(true);
    // a second strategic scene resolved a turn; the default scene never did
    await putCheckpoint(app.db, {
      worldId: app.worldId,
      sceneId: "scene-northern-front",
      slot: 1,
      turnNumber: 1,
      tick: null,
      pool: new Uint8Array([1]),
      maxHpMax: 1,
      version: 0,
      unitStats: {},
      seed: 1,
      rulesVersion: "1.0.0",
      hash: "h",
    });
    const blocked = await app.packages.activate("probe-rules");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("pinned");
    const blocked2 = await app.packages.deactivate();
    expect(blocked2.ok).toBe(false);
    // the record was not touched by the refused activation
    expect((await getWorld(app.db, app.worldId))?.system).toBe(BUILTIN_SYSTEM_ID);
    await app.persister.flush();
    await app.close();
  });

  test("the reboot after activation announces the package as the world's system", async () => {
    const app = await freshApp();
    const worldId = app.worldId;
    expect((await app.packages.importZip(ruleset({ dependencies: undefined }))).ok).toBe(true);
    expect(await app.packages.activate("probe-rules")).toEqual({ ok: true });
    await app.persister.flush();
    await app.close();

    const second = await bootHostApp({
      db: await openVttDb(),
      root: new MemDirHandle(),
      codec: new FakeCodec(),
      simRunner: new InlineSimRunner(),
      worldId,
    });
    expect(second.rulesBoot).toEqual({
      source: "package",
      packageId: "probe-rules",
      version: "3.1.0",
      error: null,
    });
    // meta.system feeds the join welcome's world block — it now agrees with rulesBoot
    expect(second.meta.system).toBe("probe-rules");
    expect(second.meta.systemVersion).toBe("3.1.0");
    await second.persister.flush();
    await second.close();
  });
});
