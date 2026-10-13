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

const automationModule = (options: {
  id: string;
  capabilities?: string[];
  requires?: Array<{ id: string; version?: string; optional?: boolean }>;
  provides?: Array<{ id: string; mode: string; contract: number }>;
}): Uint8Array => {
  const entry = `AIS.events.on("turn.phase.changed", (event) => console.log(event.phase));`;
  return zipOf({
    "manifest.json": JSON.stringify({
      id: options.id,
      name: options.id,
      version: "1.0.0",
      type: "module",
      interconnect: {
        api: "arena.ais/1",
        entry: "automation/entry.js",
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
        ...(options.requires ? { requires: options.requires } : {}),
        ...(options.provides ? { provides: options.provides } : {}),
      },
    }),
    "automation/entry.js": entry,
  });
};

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

describe("HostPackages — AIS activation, approval and arbitration", () => {
  test("imports disabled, enables an exact package lock, and boots only after exact-hash approval", async () => {
    const app = await freshApp();
    const imported = await app.packages.importZip(automationModule({
      id: "observe-mod",
      capabilities: ["action.observe", "ui.notify"],
    }));
    expect(imported.ok).toBe(true);
    expect(app.automationBoot.modules).toEqual([]);
    expect(await app.packages.previewAutomationModule("observe-mod")).toMatchObject({
      ok: true,
      entry: "automation/entry.js",
      source: expect.stringContaining("AIS.events.on"),
      truncated: false,
    });
    expect(await app.packages.enableAutomationModule("observe-mod")).toEqual({ ok: true });
    let state = await app.packages.automation();
    expect(state.modules[0]).toMatchObject({ enabled: true, approved: false });
    expect(state.profile.modules[0]).toMatchObject({ id: "observe-mod", version: "1.0.0", hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await app.packages.grantAutomationCapabilities("observe-mod", ["action.observe"])).toEqual({ ok: true });
    await app.persister.flush();
    const world = await getWorld(app.db, app.worldId);
    expect(world?.automationGrants?.["observe-mod"]).toMatchObject({ capabilities: ["action.observe"] });
    await app.close();

    const second = await bootHostApp({
      db: await openVttDb(),
      root: new MemDirHandle(),
      codec: new FakeCodec(),
      simRunner: new InlineSimRunner(),
      worldId: app.worldId,
    });
    expect(second.automationBoot.modules).toHaveLength(1);
    expect(second.automationBoot.modules[0]).toMatchObject({
      packageId: "observe-mod",
      capabilities: ["action.observe"],
    });
    state = await second.packages.automation();
    expect(state.modules[0]).toMatchObject({ enabled: true, approved: true, grantedCapabilities: ["action.observe"] });
    expect(await second.packages.disableAutomationModule("observe-mod")).toEqual({ ok: true });
    expect((await getWorld(second.db, second.worldId))?.automationGrants?.["observe-mod"]).toBeUndefined();
    expect(await second.packages.enableAutomationModule("observe-mod")).toEqual({ ok: true });
    expect((await second.packages.automation()).modules[0]).toMatchObject({ enabled: true, approved: false });
    await second.persister.flush();
    await second.close();
  });

  test("changing the active system revokes grants for modules that stop resolving", async () => {
    const app = await freshApp();
    expect((await app.packages.importZip(ruleset({ dependencies: undefined }))).ok).toBe(true);
    expect(await app.packages.activate("probe-rules")).toEqual({ ok: true });
    expect((await app.packages.importZip(automationModule({
      id: "system-addon",
      capabilities: ["action.observe"],
      requires: [{ id: "probe-rules", version: "3.1.0" }],
    }))).ok).toBe(true);
    expect(await app.packages.enableAutomationModule("system-addon")).toEqual({ ok: true });
    expect(await app.packages.grantAutomationCapabilities("system-addon", ["action.observe"])).toEqual({ ok: true });
    await app.persister.flush();
    expect((await getWorld(app.db, app.worldId))?.automationGrants?.["system-addon"]).toBeDefined();

    expect(await app.packages.deactivate()).toEqual({ ok: true });
    expect((await getWorld(app.db, app.worldId))?.automationGrants?.["system-addon"]).toBeUndefined();
    expect((await app.packages.automation()).modules[0]).toMatchObject({ enabled: true, approved: false });
    await app.persister.flush();
    await app.close();
  });

  test("a missing optional dependency warns but does not suppress an approved module", async () => {
    const app = await freshApp();
    const worldId = app.worldId;
    expect((await app.packages.importZip(automationModule({
      id: "optional-consumer",
      capabilities: ["action.observe"],
      requires: [{ id: "late-addon", version: "1.0.0", optional: true }],
    }))).ok).toBe(true);
    expect(await app.packages.enableAutomationModule("optional-consumer")).toEqual({ ok: true });
    expect(await app.packages.grantAutomationCapabilities("optional-consumer", ["action.observe"])).toEqual({ ok: true });
    await app.persister.flush();
    await app.close();

    const restarted = await bootHostApp({
      db: await openVttDb(),
      root: new MemDirHandle(),
      codec: new FakeCodec(),
      simRunner: new InlineSimRunner(),
      worldId,
    });
    expect(restarted.automationBoot.modules.map((module) => module.packageId)).toEqual(["optional-consumer"]);
    expect(restarted.automationBoot.resolution.issues.some((issue) => !issue.blocking)).toBe(true);
    await restarted.persister.flush();
    await restarted.close();
  });

  test("exact capability allow-lists reject unrequested grants and track a package update by hash", async () => {
    const app = await freshApp();
    expect((await app.packages.importZip(automationModule({ id: "hash-mod", capabilities: ["ui.notify"] }))).ok).toBe(true);
    expect(await app.packages.grantAutomationCapabilities("hash-mod", ["chat.post"])).toMatchObject({ ok: false });
    expect(await app.packages.enableAutomationModule("hash-mod")).toEqual({ ok: true });
    expect(await app.packages.grantAutomationCapabilities("hash-mod", ["ui.notify"])).toEqual({ ok: true });

    const before = (await app.packages.automation()).modules[0]?.hash;
    const replacement = zipOf({
      "manifest.json": JSON.stringify({
        id: "hash-mod", name: "hash-mod", version: "1.0.1", type: "module",
        interconnect: { api: "arena.ais/1", entry: "automation/entry.js", capabilities: ["ui.notify"] },
      }),
      "automation/entry.js": "AIS.ui.notify('updated code');",
    });
    expect((await app.packages.importZip(replacement)).ok).toBe(true);
    const after = (await app.packages.automation()).modules[0];
    expect(after?.hash).not.toBe(before);
    expect(after).toMatchObject({ enabled: false, approved: false, grantedCapabilities: [] });
    await app.persister.flush();
    await app.close();
  });

  test("exclusive-provider conflicts block enablement until the GM selects a provider", async () => {
    const app = await freshApp();
    const slot = "pf1e.damage.resolve";
    expect((await app.packages.importZip(automationModule({
      id: "resolver-one",
      provides: [{ id: slot, mode: "exclusive", contract: 1 }],
    }))).ok).toBe(true);
    expect((await app.packages.importZip(automationModule({
      id: "resolver-two",
      provides: [{ id: slot, mode: "exclusive", contract: 1 }],
    }))).ok).toBe(true);
    expect(await app.packages.enableAutomationModule("resolver-one")).toEqual({ ok: true });
    const conflict = await app.packages.enableAutomationModule("resolver-two");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toContain("select one explicitly");
    expect(await app.packages.selectAutomationProvider(slot, `resolver-two/${slot}`)).toEqual({ ok: true });
    const state = await app.packages.automation();
    expect(state.profile.modules.map((row) => row.id)).toEqual(["resolver-one", "resolver-two"]);
    expect(state.profile.providers[slot]).toBe(`resolver-two/${slot}`);
    expect(state.resolution.issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(state.resolution.providers[0]?.selected).toBe(`resolver-two/${slot}`);
    const worldId = app.worldId;
    expect(await app.packages.grantAutomationCapabilities("resolver-one", [])).toEqual({ ok: true });
    expect(await app.packages.grantAutomationCapabilities("resolver-two", [])).toEqual({ ok: true });
    await app.persister.flush();
    await app.close();

    const restarted = await bootHostApp({
      db: await openVttDb(),
      root: new MemDirHandle(),
      codec: new FakeCodec(),
      simRunner: new InlineSimRunner(),
      worldId,
    });
    expect(restarted.automationBoot.modules.map((module) => module.packageId)).toEqual([
      "resolver-one",
      "resolver-two",
    ]);
    expect(await restarted.packages.disableAutomationModule("resolver-two")).toEqual({ ok: true });
    expect((await restarted.packages.automation()).profile.providers[slot]).toBeUndefined();
    await restarted.persister.flush();
    await restarted.close();
  });
});
