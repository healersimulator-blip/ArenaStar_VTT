/**
 * §2/§14 GM-tab composition root — boots Host Core + Client Core in one
 * browser tab over the InMemoryTransport loopback.
 *
 * Boot order (§8 startup + §2 star topology):
 *   IDB → world record (create or most-recent) → HostPersister.attach
 *   (documents + oplog-tail replay) → seed envelope for fresh worlds
 *   (GM user + default scene) → AssetServer + ImportPipeline → HostSync
 *   → GM loopback session (trusted; the GM UI speaks ONLY ClientSync, §2)
 *   → GM AssetCache/Fetcher → §6.5 lifecycle hooks.
 */
import { DocumentStore, type StoreMeta } from "../core/store";
import { OpLog } from "../core/oplog";
import { UndoStack } from "../core/undo";
import { createEventBus } from "../core/events";
import type { SceneDocument, TokenDocument, UserDocument } from "../core/documents";
import type { WorldId } from "../core/ids";
import { HostSync, gmSessionUser, type HostEvents } from "../host/sync";
import { AssetServer, wireManifestToStore } from "../host/assets";
import { ImportPipeline } from "../host/import";
import { HostPersister } from "../storage/persistence";
import { listWorlds, openVttDb, type IDBPDatabase } from "../storage/idb";
import type { DirHandleLike } from "../storage/opfs";
import { opfsRoot } from "../storage/opfs";
import { ClientSync, type ClientEvents } from "../client/sync";
import { AssetCache, AssetFetcher } from "../client/assets";
import { createTransportPair } from "../net/memory";
import { AssetWorkerCodec } from "../workers/assetWorkerClient";
import type { ImageCodec } from "../workers/assetJob";
import { installHostLifecycle } from "../host/lifecycle";
import { SimBridge } from "../host/simBridge";
import { TurnChannel } from "../host/turnChannel";
import SimWorkerCtor from "../workers/sim.worker.ts?worker&inline";
import { InlineSimRunner, WorkerSimRunner, type SimRunner } from "../workers/simWorkerClient";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../packages";
import { readZipPackage } from "../packages/packageLoader";
import { parseCompendiumPack, type CompendiumPack } from "../core/compendium";
import {
  codeSteps,
  compareVersions,
  migrateDocuments,
  planMigrationChain,
  type MigrationStep,
} from "../core/migrations";
import { getPackage, getWorld, listPackages, putPackage } from "../storage/idb";
import type { BaseDocument, CollectionName } from "../core/documents";
import { TOP_LEVEL_COLLECTIONS } from "../core/documents";
import { diffFlat, type JsonRecord } from "../core/diff";
import type { Op, OpEnvelope } from "../core/ops";
import type { PackageRecord, WorldsRecord } from "../storage/idb";
import { latestCheckpoint } from "../storage/strategicStore";
import type { SysSchema } from "../sim/pool";
import { verifyHello } from "../net/identity";

export const GM_USER_ID = "gm";
export const DEFAULT_SCENE_ID = "scene-1";

export interface HostAppOptions {
  /** Injected DB handle (tests); default opens "vtt". */
  db?: IDBPDatabase;
  /** Reopen a specific world; default: most recent, or create one. */
  worldId?: WorldId;
  /** Image codec (tests inject fakes); default: the asset worker client. */
  codec?: ImageCodec;
  /** OPFS root (tests: MemDirHandle); default: real OPFS when available. */
  root?: DirHandleLike | null;
  /**
   * Sim runner override. Default: the sandboxed SimWorker, degrading to the inline runner when it
   * cannot be constructed. Node hosts/tests have no DOM `Worker` global, where the *construction*
   * still succeeds and only `loadRules` fails — so without this seam the §12 package-boot path
   * (rules.entry → blob/data-URL import → schema echo) is untestable outside a browser.
   */
  simRunner?: SimRunner;
  now?: () => number;
}

export interface PackageSummary {
  id: string;
  name: string;
  version: string;
  type: "system" | "data";
  packCount: number;
  active: boolean;
  /** §12 module asks for in-page execution (GM must grant). */
  trustRequested: boolean;
  /** §12 GM granted in-page trust for this world. */
  trusted: boolean;
}

export interface HostModuleBoot {
  packageId: string;
  source: string;
  /** Where the module runs: sandboxed "iframe" | GM-granted in-page "inPage". */
  mode: "iframe" | "inPage";
}

export interface HostMigrationBoot {
  systemId: string;
  from: string;
  to: string;
  applied: string[];
  changedDocs: number;
  /** Why a needed migration did not run (missing link / bad manifest). */
  error: string | null;
}

export interface HostRulesBoot {
  source: "package" | "builtin";
  packageId: string | null;
  version: string;
  /** Why a package was refused at boot (validation/import error). */
  error: string | null;
}

export interface HostPackages {
  list(): Promise<PackageSummary[]>;
  importZip(
    bytes: Uint8Array,
  ): Promise<{ ok: true; summary: PackageSummary } | { ok: false; error: string }>;
  activate(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  deactivate(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** §12 grant/revoke in-page execution trust (per package, this world). */
  grantTrust(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  revokeTrust(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** §12 compendia: parsed read-only packs from every imported package. */
  compendia(): Promise<Array<{ packageId: string; pack: CompendiumPack }>>;
}

export interface HostApp {
  readonly worldId: WorldId;
  readonly meta: StoreMeta;
  readonly db: IDBPDatabase;
  /** OPFS root the AssetServer writes through (null → IDB blob fallback). */
  readonly root: DirHandleLike | null;
  readonly store: DocumentStore;
  readonly log: OpLog;
  readonly host: HostSync;
  readonly persister: HostPersister;
  readonly assets: AssetServer;
  readonly pipeline: ImportPipeline;
  /** §12 what the sim booted with this world load. */
  readonly rulesBoot: HostRulesBoot;
  /** §12 active package module entry for the sandboxed iframe (null = none). */
  readonly moduleBoot: HostModuleBoot | null;
  /** §12 world-load migration record (null = versions already current). */
  readonly migrationBoot: HostMigrationBoot | null;
  /** §12 package management (import/activate world-scoped). */
  readonly packages: HostPackages;
  readonly gm: {
    readonly client: ClientSync;
    readonly bus: ReturnType<typeof createEventBus<ClientEvents>>;
    readonly cache: AssetCache;
    readonly fetcher: AssetFetcher;
    /** §5A turn/sim channel for the default scene (drives sim.control). */
    readonly channel: TurnChannel;
  };
  close(): void;
}

function sceneDoc(): SceneDocument {
  return {
    _id: DEFAULT_SCENE_ID,
    type: "scene",
    name: "Scene 1",
    ownership: { default: 2 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 2000,
    height: 1500,
    darkness: 0,
    grid: {
      type: "square",
      size: 100,
      distance: 5,
      units: "ft",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  };
}

function gmUserDoc(): UserDocument {
  return {
    _id: GM_USER_ID,
    type: "user",
    name: "GM",
    ownership: { default: 3 },
    flags: {},
    system: {},
    role: "GM",
    character: null,
    color: "#e0b341",
  };
}

export function makeToken(id: string, x: number, y: number, name = id): TokenDocument {
  return {
    _id: id,
    type: "token",
    name,
    ownership: { default: 3, [GM_USER_ID]: 3 }, // D-061: tabletop default — players see & move
    flags: {},
    system: {},
    x,
    y,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  };
}

export async function bootHostApp(options: HostAppOptions = {}): Promise<HostApp> {
  const db = options.db ?? (await openVttDb());
  const now = options.now ?? (() => Date.now());

  // ── world selection: explicit → most recent → fresh ────────────────────────
  let persister: HostPersister;
  let meta: StoreMeta;
  let worldRec: WorldsRecord | undefined;
  if (options.worldId) {
    persister = await HostPersister.open(db, options.worldId, { now });
    const rec = (await listWorlds(db)).find((w) => w.worldId === options.worldId);
    worldRec = rec;
    meta = {
      worldId: options.worldId,
      name: rec?.name ?? "World",
      system: rec?.system ?? "mass-battle-basic",
      systemVersion: rec?.version ?? "1.0.0",
    };
  } else {
    const worlds = await listWorlds(db);
    const latest = worlds[0];
    if (latest) {
      persister = await HostPersister.open(db, latest.worldId, { now });
      worldRec = latest;
      meta = {
        worldId: latest.worldId,
        name: latest.name,
        system: latest.system,
        systemVersion: latest.version,
      };
    } else {
      const worldId = `w-${globalThis.crypto.randomUUID().slice(0, 8)}`;
      meta = { worldId, name: "World One", system: "mass-battle-basic", systemVersion: "1.0.0" };
      persister = await HostPersister.createWorld(db, meta, { now });
      worldRec = await getWorld(db, worldId);
    }
  }

  // ── Host Core (§8 startup: documents + oplog tail replay) ──────────────────
  const log = new OpLog();
  const store = new DocumentStore({ meta });
  await persister.attach(store, log);

  if (store.seq === 0) {
    // Fresh world: one seed envelope (GM user + default scene) — a normal
    // envelope so the OpLog stays the single source of truth.
    const seed = {
      seq: 1,
      ts: now(),
      by: GM_USER_ID,
      ops: [
        { kind: "create" as const, coll: "users" as const, data: gmUserDoc() },
        { kind: "create" as const, coll: "scenes" as const, data: sceneDoc() },
      ],
      txId: globalThis.crypto.randomUUID(),
    };
    const applied = store.applyEnvelope(seed);
    if (!applied.ok) throw new Error(`boot: seed failed: ${applied.error}`);
    const appended = log.append(seed, applied.value.inverses);
    if (!appended.ok) throw new Error(`boot: seed log: ${appended.error}`);
    await persister.drain();
  }

  // ── §12 migrations per dataSchema version on world load ────────────────────
  // Runs against the HYDRATED store (documents store + oplog tail replay);
  // changes ride a normal op envelope — persisted, replayable, idempotent.
  const BUILTIN_VERSION = "1.0.0";
  const activePkgRec: PackageRecord | undefined = worldRec?.activeRulesPackage
    ? await getPackage(db, meta.worldId, worldRec.activeRulesPackage)
    : undefined;
  const effectiveSystemId = worldRec?.activeRulesPackage ?? meta.system;
  const currentVersion =
    activePkgRec?.manifest.version ??
    (effectiveSystemId === "mass-battle-basic" ? BUILTIN_VERSION : null);
  const persistedVersion = worldRec?.version ?? BUILTIN_VERSION;
  let migrationBoot: HostMigrationBoot | null = null;
  if (currentVersion !== null && compareVersions(persistedVersion, currentVersion) < 0) {
    const base: HostMigrationBoot = {
      systemId: effectiveSystemId,
      from: persistedVersion,
      to: currentVersion,
      applied: [],
      changedDocs: 0,
      error: null,
    };
    const declared: MigrationStep[] = activePkgRec?.manifest.migrations ?? [];
    const chain = planMigrationChain(declared, persistedVersion, currentVersion);
    if (!chain.ok) {
      migrationBoot = { ...base, error: chain.error };
    } else {
      const all: Array<{ coll: CollectionName; doc: BaseDocument }> = [];
      for (const coll of TOP_LEVEL_COLLECTIONS) {
        for (const doc of store.getAll(coll) as readonly BaseDocument[]) {
          all.push({ coll, doc });
        }
      }
      const applied = migrateDocuments(
        all.map((a) => a.doc),
        chain.value,
      );
      const code = codeSteps(effectiveSystemId).filter(
        (s) =>
          compareVersions(s.from, persistedVersion) >= 0 &&
          compareVersions(s.to, currentVersion) <= 0,
      );
      let finalDocs = applied.docs;
      let changed = applied.changed;
      if (code.length > 0) {
        finalDocs = finalDocs.map((doc) => {
          let current = doc;
          for (const step of code) current = step.migrate(current);
          if (current !== doc) changed++;
          return current;
        });
      }
      const ops: Op[] = [];
      for (let i = 0; i < finalDocs.length; i++) {
        const before = all[i]?.doc;
        const after = finalDocs[i];
        if (!before || !after || after === before) continue;
        const coll = all[i]?.coll;
        if (!coll) continue;
        ops.push({
          kind: "update",
          ref: { coll, id: before._id },
          diff: diffFlat(before as unknown as JsonRecord, after as unknown as JsonRecord),
        });
      }
      if (ops.length > 0) {
        const envelope: OpEnvelope = {
          seq: store.seq + 1,
          ts: now(),
          by: GM_USER_ID,
          ops,
          txId: globalThis.crypto.randomUUID(),
        };
        const appliedEnv = store.applyEnvelope(envelope);
        if (!appliedEnv.ok) {
          migrationBoot = { ...base, error: `migration envelope rejected: ${appliedEnv.error}` };
        } else {
          const appended = log.append(envelope, appliedEnv.value.inverses);
          if (!appended.ok) {
            migrationBoot = { ...base, error: `migration log: ${appended.error}` };
          } else {
            await persister.drain();
            await persister.patchWorld({ version: currentVersion });
            migrationBoot = {
              ...base,
              applied: [
                ...chain.value.map((st) => `${st.from}→${st.to}`),
                ...code.map((st) => `${st.from}→${st.to} (code)`),
              ],
              changedDocs: changed,
            };
          }
        }
      } else {
        await persister.patchWorld({ version: currentVersion });
        migrationBoot = {
          ...base,
          applied: [
            ...chain.value.map((st) => `${st.from}→${st.to}`),
            ...code.map((st) => `${st.from}→${st.to} (code)`),
          ],
          changedDocs: 0,
        };
      }
    }
  }

  // ── Assets (§7) ─────────────────────────────────────────────────────────────
  const root = options.root !== undefined ? options.root : await opfsRoot();
  const assets = await AssetServer.open({ worldId: meta.worldId, db, root });
  wireManifestToStore(assets, store);
  const pipeline = new ImportPipeline(assets, options.codec ?? new AssetWorkerCodec());

  // ── HostSync + GM loopback (§2: GM UI never calls host internals) ──────────
  const hostBus = createEventBus<HostEvents>();
  const host = new HostSync({
    store,
    log,
    undo: new UndoStack(),
    bus: hostBus,
    systemUserId: GM_USER_ID,
    roomId: meta.worldId,
    verifyHelloSig: (hello, roomId) => verifyHello(hello, roomId),
    now,
    assets,
  });

  // ── §5A turn/sim channel: sandboxed SimWorker + §12 package boot ──────────
  const activeRec: PackageRecord | undefined = worldRec?.activeRulesPackage
    ? await getPackage(db, meta.worldId, worldRec.activeRulesPackage)
    : undefined;
  const pkg =
    activeRec && activeRec.manifest.type === "system" && activeRec.manifest.rules
      ? activeRec
      : undefined;
  const pkgSource = pkg ? pkg.files[pkg.manifest.rules?.entry ?? ""] : undefined;

  let runner: SimRunner;
  try {
    runner = options.simRunner ?? new WorkerSimRunner(SimWorkerCtor);
  } catch {
    runner = new InlineSimRunner();
  }

  let rulesBoot: HostRulesBoot = {
    source: "builtin",
    packageId: null,
    version: "1.0.0",
    error: null,
  };
  let simSys: SysSchema = MASS_BATTLE_SCHEMA_COLUMNS;
  let rulesSource: string | undefined;
  if (pkg && pkgSource !== undefined) {
    // §12 gate: the package is imported (blob URL) + validated INSIDE the
    // worker sandbox before any campaign may start; failure degrades cleanly
    // to the built-in mass-battle rules.
    try {
      if (!runner.loadRules) throw new Error("runner cannot load packages");
      const info = await runner.loadRules(pkgSource, 5_000);
      rulesBoot = { source: "package", packageId: pkg.id, version: info.version, error: null };
      simSys = pkg.manifest.rules?.modelColumns ?? MASS_BATTLE_SCHEMA_COLUMNS;
      rulesSource = pkgSource;
    } catch (e) {
      rulesBoot = {
        source: "builtin",
        packageId: pkg.id,
        version: pkg.manifest.version,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } else if (worldRec?.activeRulesPackage) {
    rulesBoot = {
      source: "builtin",
      packageId: worldRec.activeRulesPackage,
      version: "1.0.0",
      error: "active package record missing or not a system package",
    };
  }
  const moduleSource =
    pkg?.manifest.module !== undefined ? (pkg.files[pkg.manifest.module.entry] ?? null) : null;
  const trustGranted =
    pkg !== undefined && (worldRec?.trustedPackages ?? []).includes(pkg.id) === true;
  const trustRequested = pkg?.manifest.module?.trusted === true;
  const moduleBoot: HostModuleBoot | null =
    pkg && moduleSource !== null && rulesBoot.source === "package"
      ? {
          packageId: pkg.id,
          source: moduleSource,
          mode: trustRequested && trustGranted ? "inPage" : "iframe",
        }
      : null;
  const bridge = new SimBridge(DEFAULT_SCENE_ID, {
    db,
    worldId: meta.worldId,
    runner,
    sys: simSys,
    ...(rulesSource !== undefined ? { rulesSource } : {}),
  });
  let campaignSeed = 0;
  for (const ch of meta.worldId) campaignSeed = (campaignSeed * 31 + ch.charCodeAt(0)) >>> 0;
  const channel = new TurnChannel({
    host,
    store,
    bridge,
    sceneId: DEFAULT_SCENE_ID,
    sys: simSys,
    seed: campaignSeed || 1,
  });

  const pair = createTransportPair();
  host.addSession("gm", pair.a, gmSessionUser(GM_USER_ID));
  const gmBus = createEventBus<ClientEvents>();
  const gmClient = new ClientSync({
    transport: pair.b,
    bus: gmBus,
    meta,
    simSys,
    simSceneId: DEFAULT_SCENE_ID,
  });
  gmClient.connect({
    kind: "hello",
    pubkey: GM_USER_ID,
    displayName: "GM",
    ts: now(),
    sig: "gm-loopback",
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0)); // loopback settle

  // ── GM asset fetch path (same wire as players) ──────────────────────────────
  const cache = await AssetCache.open();
  const fetcher = new AssetFetcher({
    cache,
    request: (assetId, priority, offset) => gmClient.requestAsset(assetId, priority, offset),
  });
  gmBus.on("asset", (msg) => fetcher.onChunk(msg));

  const removeLifecycle = installHostLifecycle(persister);

  // ── §12 package management (world-scoped; activation applies at load) ──────
  const summarize = (
    rec: PackageRecord,
    active: string | null,
    trustedIds: readonly string[],
  ): PackageSummary => ({
    id: rec.id,
    name: rec.name,
    version: rec.version,
    type: rec.type,
    packCount: rec.manifest.packs?.length ?? 0,
    active: active === rec.id,
    trustRequested: rec.manifest.module?.trusted === true,
    trusted: trustedIds.includes(rec.id),
  });
  const activePackageId = async (): Promise<string | null> =>
    (await getWorld(db, meta.worldId))?.activeRulesPackage ?? null;
  const guardFreshCampaign = async (): Promise<string | null> => {
    // rules are pinned per campaign: swapping after the first checkpoint
    // would break §5A determinism/replay
    const cp = await latestCheckpoint(db, meta.worldId, DEFAULT_SCENE_ID);
    return cp ? "campaign already started — packages apply to fresh worlds only" : null;
  };
  const trustedIds = async (): Promise<string[]> =>
    (await getWorld(db, meta.worldId))?.trustedPackages ?? [];
  const writeTrusted = async (next: string[]): Promise<{ ok: true }> => {
    // §12: world-record patches go through the persister — a bare putWorld is reverted by its
    // next write-behind flush (the cached record is the authority).
    await persister.patchWorld({ trustedPackages: next });
    return { ok: true };
  };
  const packages: HostPackages = {
    async list() {
      const active = await activePackageId();
      const trusted = await trustedIds();
      return (await listPackages(db, meta.worldId)).map((r) => summarize(r, active, trusted));
    },
    async importZip(bytes) {
      const loaded = await readZipPackage(bytes);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const { manifest, files } = loaded.value;
      const rec: PackageRecord = {
        worldId: meta.worldId,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        importedAt: now(),
        manifest,
        files,
      };
      await putPackage(db, rec);
      return {
        ok: true,
        summary: summarize(rec, await activePackageId(), await trustedIds()),
      };
    },
    async activate(id) {
      const rec = await getPackage(db, meta.worldId, id);
      if (!rec) return { ok: false, error: `package not imported: ${id}` };
      if (rec.type !== "system" || !rec.manifest.rules) {
        return { ok: false, error: "data-only packages cannot provide rules" };
      }
      if (rec.files[rec.manifest.rules.entry] === undefined) {
        return { ok: false, error: "package rules entry is missing" };
      }
      const guarded = await guardFreshCampaign();
      if (guarded) return { ok: false, error: guarded };
      // §12: the world's version tracks the ACTIVE system (migration baseline)
      await persister.patchWorld({ activeRulesPackage: id, version: rec.manifest.version });
      return { ok: true };
    },
    async deactivate() {
      const guarded = await guardFreshCampaign();
      if (guarded) return { ok: false, error: guarded };
      await persister.patchWorld({ activeRulesPackage: undefined });
      return { ok: true };
    },
    async grantTrust(id) {
      const rec = await getPackage(db, meta.worldId, id);
      if (!rec) return { ok: false, error: `package not imported: ${id}` };
      if (rec.manifest.module?.trusted !== true) {
        return { ok: false, error: "package does not request in-page execution" };
      }
      const current = await trustedIds();
      if (!current.includes(id)) await writeTrusted([...current, id]);
      return { ok: true };
    },
    async revokeTrust(id) {
      const current = await trustedIds();
      if (!current.includes(id)) return { ok: true };
      return writeTrusted(current.filter((x) => x !== id));
    },
    async compendia() {
      const out: Array<{ packageId: string; pack: CompendiumPack }> = [];
      for (const rec of await listPackages(db, meta.worldId)) {
        for (const descriptor of rec.manifest.packs ?? []) {
          const text = rec.files[descriptor.file];
          if (text === undefined) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            continue;
          }
          const pack = parseCompendiumPack(parsed);
          if (pack.ok) out.push({ packageId: rec.id, pack: pack.value });
        }
      }
      return out;
    },
  };

  return {
    rulesBoot,
    moduleBoot,
    migrationBoot,
    packages,
    worldId: meta.worldId,
    meta,
    db,
    root,
    store,
    log,
    host,
    persister,
    assets,
    pipeline,
    gm: { client: gmClient, bus: gmBus, cache, fetcher, channel },
    close(): void {
      removeLifecycle();
      runner.terminate();
      gmClient.close();
      host.removeSession("gm");
      assets.close();
      void persister.close();
    },
  };
}
