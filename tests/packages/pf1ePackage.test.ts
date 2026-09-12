/**
 * Gap List §1.1 — PF1e as a real §12 package.
 *
 * Everything a GM touches when installing PF1e, exercised without a browser: the manifests and
 * content packs validate against the platform's own contracts, `scripts/buildSystemPackages.mjs`
 * bundles a self-contained `rules.js` in the single-expression form the loader's WebKit fallback
 * accepts, the zipped folders survive `readZipPackage`, and the *loaded* module — not the in-repo
 * import — fights a real deployed turn.
 *
 * The build runs once for the whole file: a vite build in a subprocess (~2 s).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import "fake-indexeddb/auto";
import type { SimEvent } from "../../src/core/sim";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { OrderQueue } from "../../src/core/strategic";
import { parseCompendiumPack } from "../../src/core/compendium";
import { validatePackageManifest } from "../../src/core/packageManifest";
import {
  compilePF1eProfile,
  PF1E_MODEL_SCHEMA,
  PF1eDamageType,
  PF1eDrType,
  PRECREATED_PF1E_UNITS,
  type RawPF1eProfile,
} from "../../src/packages/pf1e/schema";
import { readZipPackage } from "../../src/packages/packageLoader";
import { evalRulesModule, importRulesModule } from "../../src/sim/rulesLoader";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { XoshiroPRNG } from "../../src/sim/prng";
import { FakeCodec, settle } from "../app/fakes";
import { bootHostApp, type HostApp } from "../../src/app/hostBoot";
import { openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const systemsDir = join(repoRoot, "systems");
const outDir = mkdtempSync(join(tmpdir(), "pf1e-pkg-"));

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/**
 * Node boots the app with `simRunner` injected: there is no DOM `Worker` here, and the sandbox
 * runner only fails once it is asked to import a package — which is precisely the path under test.
 */
const bootWithRunner = async (): Promise<HostApp> =>
  bootHostApp({
    db: await openVttDb(),
    root: new MemDirHandle(),
    codec: new FakeCodec(),
    simRunner: new InlineSimRunner(),
  });

interface PackManifest {
  id: string;
  name: string;
  version: string;
  type: string;
  dependencies?: string[];
  rules?: { entry: string; modelColumns: Record<string, string> };
  module?: { entry: string };
  packs?: Array<{ name: string; type: string; file: string }>;
}

const coreManifest = readJson<PackManifest>(join(systemsDir, "pf1e-core/manifest.json"));
const battlesManifest = readJson<PackManifest>(
  join(systemsDir, "pf1e-mass-battles/manifest.json"),
);

let rulesSource = "";

beforeAll(() => {
  execFileSync(
    process.execPath,
    [join(repoRoot, "scripts/buildSystemPackages.mjs"), "--out", outDir, "--zip-dir", outDir],
    { cwd: repoRoot, encoding: "utf8", timeout: 120_000, stdio: "pipe" },
  );
  rulesSource = readFileSync(join(outDir, "pf1e-mass-battles", "rules.js"), "utf8");
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const listFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
};

/** Zip a staged folder exactly like the build script does. */
const zipFolder = (folder: string): Uint8Array => {
  const dir = join(outDir, folder);
  const files = Object.fromEntries(
    listFiles(dir).map((rel) => [rel, strToU8(readFileSync(join(dir, rel), "utf8"))]),
  );
  return zipSync(files);
};

// ── a deployed PF1e arena, same shape as deploySnapshot leaves it ──────────────

const context = (): RulesContext => ({
  sceneId: "scene-1",
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555" },
  walls: {
    x1: new Float32Array(),
    y1: new Float32Array(),
    x2: new Float32Array(),
    y2: new Float32Array(),
    restriction: new Uint8Array(),
  },
  factions: [],
  armies: [],
  leaderActors: {},
  worldSettings: {},
});

function unit(id: string, stats: Record<string, number>, type = "infantry"): UnitView {
  return {
    id,
    armyId: `army-${id}`,
    factionId: `f-${id}`,
    type,
    name: `Unit ${id}`,
    profile: {},
    stats,
    orders: null,
    formation: "line",
    sceneId: "scene-1",
    modelRange: null,
    leaderTokenId: null,
  };
}

function arena(): {
  pool: ReturnType<typeof createModelPool>;
  units: UnitView[];
  orders: Map<string, OrderQueue>;
  ctx: RulesContext;
  rng: XoshiroPRNG;
  events: SimEvent[];
} {
  const units = [
    unit("u-a", { bab: 6, strMod: 3, ac: 16, touchAc: 12, flatFootedAc: 16, hp: 12, fort: 5 }),
    unit("u-b", { bab: 5, strMod: 2, ac: 15, touchAc: 12, flatFootedAc: 15, hp: 12, fort: 4 }),
  ];
  const pool = createModelPool(64, PF1E_MODEL_SCHEMA);
  for (const [i, u] of units.entries()) {
    const start = pool.count;
    for (let m = 0; m < 4; m++) {
      allocModel(pool, {
        id: pool.count + 1,
        unitIdx: i,
        x: m * 3,
        y: i * 6,
        hp: 1,
        hpMax: 1,
        status: 0,
        facing: 0,
        sys: {},
      });
    }
    u.modelRange = [start, pool.count];
  }
  const orders = new Map<string, OrderQueue>();
  const order = { kind: "attack", targetUnitId: "u-b" } as const;
  const counter = { kind: "attack", targetUnitId: "u-a" } as const;
  orders.set("u-a", { issuedBy: "gm", issuedTurn: 1, pending: [order], active: order });
  orders.set("u-b", { issuedBy: "gm", issuedTurn: 1, pending: [counter], active: counter });
  return { pool, units, orders, ctx: context(), rng: new XoshiroPRNG(20260908), events: [] };
}

describe("PF1e package manifests + packs (§1.1)", () => {
  test("both manifests satisfy the §12 contract", () => {
    // pf1e-core declared `type: "system"` with a module + packs and no rules block, which
    // `validatePackageManifest` rejects outright ("system packages need a rules block"): the
    // content pack could never be installed.
    const core = validatePackageManifest(coreManifest);
    expect(core.ok ? null : core.error).toBeNull();
    expect(core.ok && core.value.type).toBe("data");
    expect(core.ok && core.value.module).toBeUndefined();
    expect(core.ok && core.value.packs?.map((p) => p.file)).toEqual([
      "packs/spells.json",
      "packs/bestiary.json",
    ]);

    const battles = validatePackageManifest(battlesManifest);
    expect(battles.ok ? null : battles.error).toBeNull();
    expect(battles.ok && battles.value.rules?.entry).toBe("rules.js");
    // `dependencies` is documentation only — nothing in the platform enforces it, so it must
    // not be load-bearing (see Gap List §1.1 note in DECISIONS D-110).
    expect(battlesManifest.dependencies).toEqual(["pf1e-core"]);
  });

  test("the manifest columns still match the module schema (what ships in the zip)", () => {
    expect(battlesManifest.rules?.modelColumns).toEqual({ ...PF1E_MODEL_SCHEMA });
  });

  test("both packs parse as compendia", () => {
    for (const descriptor of coreManifest.packs ?? []) {
      const pack = parseCompendiumPack(
        readJson<unknown>(join(systemsDir, "pf1e-core", descriptor.file)),
      );
      expect(pack.ok ? null : pack.error).toBeNull();
      if (!pack.ok) continue;
      expect(pack.value.name).toBe(descriptor.name);
      expect(pack.value.type).toBe(descriptor.type);
      expect(pack.value.entries.length).toBeGreaterThan(0);
      for (const entry of pack.value.entries) {
        expect(entry.data.type).toBe(descriptor.type === "items" ? "item" : "actor");
        expect(entry.data).not.toHaveProperty("_id");
      }
    }
  });

  test("the bestiary pack compiles to the profiles the sim ships (no drift)", () => {
    const raw = readJson<{
      entries: Array<{ id: string; name: string; data: { system: Record<string, unknown> } }>;
    }>(join(systemsDir, "pf1e-core/packs/bestiary.json"));
    const bypass: Record<string, number> = {
      magic: PF1eDrType.MAGIC,
      cold_iron: PF1eDrType.COLD_IRON,
      silver: PF1eDrType.SILVER,
      adamantine: PF1eDrType.ADAMANTINE,
      slashing: PF1eDrType.SLASHING,
      piercing: PF1eDrType.PIERCING,
      bludgeoning: PF1eDrType.BLUDGEONING,
    };
    const damage: Record<string, number> = {
      fire: PF1eDamageType.FIRE,
      acid: PF1eDamageType.ACID,
      cold: PF1eDamageType.COLD,
      electricity: PF1eDamageType.ELECTRICITY,
    };

    for (const entry of raw.entries) {
      const pf1e = entry.data.system["pf1e"] as RawPF1eProfile & {
        dr?: { bypass?: string[]; val?: number };
        regeneration?: { value?: number; suppress?: string[] };
        trampleDamage?: { diceCount?: number; diceSides?: number };
        fastHealing?: number;
      };
      expect(pf1e, `bestiary entry ${entry.id} has no system.pf1e`).toBeDefined();
      if (!pf1e) continue;

      // The pack speaks in readable names, the profile table in bitfields: translate, then
      // require the compiled profiles to agree.
      const { dr, regeneration, trampleDamage, fastHealing, ...rest } = pf1e;
      const rawProfile = {
        name: entry.name,
        ...rest,
        ...(dr !== undefined
          ? {
              dr: {
                val: dr.val ?? 0,
                typeFlags: (dr.bypass ?? []).reduce((acc, k) => acc | (bypass[k] ?? 0), 0),
              },
            }
          : {}),
        ...(regeneration !== undefined
          ? {
              regenerationVal: regeneration.value ?? 0,
              regenerationSuppressFlags: (regeneration.suppress ?? []).reduce(
                (acc, k) => acc | (damage[k] ?? 0),
                0,
              ),
            }
          : {}),
        ...(trampleDamage !== undefined
          ? {
              trampleDamageDiceCount: trampleDamage.diceCount,
              trampleDamageDiceSides: trampleDamage.diceSides,
            }
          : {}),
        ...(fastHealing !== undefined ? { fastHealingVal: fastHealing } : {}),
      } as RawPF1eProfile;

      // Matched by display name, not by id: the pack is content and its ids are slugs, while the
      // in-repo table is keyed by unit role (`infantry`, `troll`). Name is the one field both must
      // agree on, and compilePF1eProfile carries it into the comparison.
      const table = Object.values(PRECREATED_PF1E_UNITS).find((p0) => p0.name === entry.name);
      expect(table, `PRECREATED_PF1E_UNITS has no profile named "${entry.name}"`).toBeDefined();
      expect(compilePF1eProfile(1, rawProfile)).toEqual(compilePF1eProfile(1, table ?? {}));
    }
  });

  test("the spell pack carries what a mass-battle cast needs", () => {
    const raw = readJson<{
      entries: Array<{ id: string; data: { system: Record<string, unknown> } }>;
    }>(join(systemsDir, "pf1e-core/packs/spells.json"));
    const fireball = raw.entries.find((e) => e.id === "fireball");
    expect(fireball).toBeDefined();
    // SRD: 20-ft.-radius spread, Reflex half, 1d6 per caster level capped at 10d6. The sim's
    // hardcoded test cast still uses radius 15 and never reads this pack (Gap List §5).
    expect(fireball?.data.system["massBattle"]).toMatchObject({
      shape: "circle",
      radiusFeet: 20,
      saveType: "ref",
      damageDiceCount: 1,
      damageDiceSides: 6,
      maxDice: 10,
    });
    expect(fireball?.data.system["savingThrow"]).toBe("Reflex half");
    // CRB pg. 251 (R02, D-171): 15-ft cone-shaped burst, 1d4/level capped at 5d4, Reflex half.
    const burningHands = raw.entries.find((e) => e.id === "burning-hands");
    expect(burningHands).toBeDefined();
    expect(burningHands?.data.system["massBattle"]).toMatchObject({
      shape: "cone",
      radiusFeet: 15,
      saveType: "ref",
      damageDiceCount: 1,
      damageDiceSides: 4,
      maxDice: 5,
    });
    expect(burningHands?.data.system["savingThrow"]).toBe("Reflex half");
    expect(raw.entries.map((e) => e.id)).toEqual([
      "fireball",
      "burning-hands",
      "magic-missile",
      "shield",
      "true-strike",
    ]);
  });
});

describe("the built rules.js (D-086 single-file constraint)", () => {
  test("is one self-contained expression, so evalRulesModule accepts it too", () => {
    expect(rulesSource.startsWith("export default (() => {")).toBe(true);
    // No static imports and no other exports: the SimWorker sandbox resolves nothing else.
    expect(rulesSource.slice(1).match(/^\s*(import|export)\b/m)).toBeNull();
    const evaled = evalRulesModule(rulesSource);
    expect(evaled.ok ? null : evaled.error).toBeNull();
  });

  test("imports through the loader and echoes the manifest's version", async () => {
    const loaded = await importRulesModule(rulesSource);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.value.info.version).toBe(battlesManifest.version);
    expect(loaded.value.info.subPhases).toEqual(["move", "heal", "shoot", "melee", "spell", "morale"]);
    expect(loaded.value.module.schema.modelColumns).toEqual({
      ...battlesManifest.rules?.modelColumns,
    });
    expect(typeof loaded.value.module.resolveTurn).toBe("function");
    expect(typeof loaded.value.module.detection).toBe("function");
  });

  test("a deployed battle resolves under the LOADED module, not the in-repo import", () => {
    const loaded = evalRulesModule(rulesSource);
    if (!loaded.ok) throw new Error(loaded.error);
    const { pool, units, orders, ctx, rng, events } = arena();

    loaded.value.resolveTurn(ctx, pool, units, orders, rng, (e: SimEvent) => events.push(e));

    expect(pool.hpMax[0] ?? 0).toBeGreaterThan(1); // seeded hp survived the wrap
    expect(pool.hp[0] ?? 0).toBeLessThan(pool.hpMax[0] ?? 0); // and someone got hurt
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => /attacks/i.test(e.text))).toBe(true);
  });

  test("the build guard rejects a non-self-contained bundle", () => {
    // The rewrite step throws instead of emitting a file the loader would refuse at boot; keep the
    // guard string present so the CLI stays honest about it.
    const script = readFileSync(join(repoRoot, "scripts/buildSystemPackages.mjs"), "utf8");
    expect(script).toContain("bundle is not self-contained");
    expect(rulesSource.split("\n").length).toBeGreaterThan(50);
  });
});

describe("installing the built zips", () => {
  test("readZipPackage accepts both PF1e packages", async () => {
    const battles = await readZipPackage(zipFolder("pf1e-mass-battles"));
    expect(battles.ok ? null : battles.error).toBeNull();
    if (!battles.ok) return;
    expect(battles.value.files["rules.js"]?.length).toBeGreaterThan(1000);
    expect(battles.value.files["manifest.json"]).toBeDefined();

    const core = await readZipPackage(zipFolder("pf1e-core"));
    expect(core.ok ? null : core.error).toBeNull();
    if (!core.ok) return;
    expect(Object.keys(core.value.files).sort()).toEqual([
      "manifest.json",
      "packs/bestiary.json",
      "packs/spells.json",
    ]);
  });

  test("a zip without the generated rules.js is refused (the entry must ship)", () => {
    const dir = join(outDir, "pf1e-mass-battles-noRules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(battlesManifest));
    const zip = zipSync({ "manifest.json": strToU8(readFileSync(join(dir, "manifest.json"), "utf8")) });
    rmSync(dir, { recursive: true, force: true });
    return readZipPackage(zip).then((res) => {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("rules entry rules.js is missing");
    });
  });
});

describe("activating PF1e in a world (§1.1 acceptance, no browser)", () => {
  test("import both zips → activate → reload boots the package, and its packs are compendia", async () => {
    const app = await bootWithRunner();
    const worldId = app.worldId;

    const battles = await app.packages.importZip(zipFolder("pf1e-mass-battles"));
    expect(battles.ok ? null : battles.error).toBeNull();
    const core = await app.packages.importZip(zipFolder("pf1e-core"));
    expect(core.ok ? null : core.error).toBeNull();

    // data-only package: installed, indexed, and NOT activatable as rules
    const packs = await app.packages.compendia();
    expect(packs.map((p) => p.pack.name).sort()).toEqual(["PF1e Bestiary", "PF1e Spells"]);
    // Bestiary 6 + spells 5 (fireball, burning-hands, magic-missile, shield, true-strike).
    expect(packs.reduce((n, p) => n + p.pack.entries.length, 0)).toBe(11);

    const activated = await app.packages.activate("pf1e-mass-battles");
    expect(activated.ok ? null : activated.error).toBeNull();
    const dataActivate = await app.packages.activate("pf1e-core");
    expect(dataActivate.ok).toBe(false);
    if (!dataActivate.ok) expect(dataActivate.error).toContain("data-only");

    await settle();
    await app.persister.drain();
    // The reload is the interesting half, so the record must survive the persister's final flush:
    // §12 world-record patches (activate/trust/migration version) go through
    // `HostPersister.patchWorld`, because the persister rewrites its cached copy on every tick.
    await app.close();
    await settle();

    // The reload is the real gate: hostBoot re-reads the world record, hands the package
    // source to the SimWorker/InlineSimRunner, and only keeps it if the module validates.
    const second = await bootWithRunner();
    expect(second.worldId).toBe(worldId);
    expect(second.rulesBoot).toEqual({
      source: "package",
      packageId: "pf1e-mass-battles",
      version: "1.0.0",
      error: null,
    });
    // `version` above is echoed from the loaded module's own schema, not the manifest — so it
    // proves the bundle loaded, not just that a record existed.
    await second.persister.drain();
    second.close();
  });
});
