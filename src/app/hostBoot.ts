import { getFogEpoch, putFogEpoch } from "../storage/idb";
import {
  emptyAisProfile,
  resolveAisProfile,
  validateAisActivationProfile,
  withAisModule,
  type AisActivationProfile,
  type AisCapability,
  type AisModuleCommandDeclaration,
  type AisPackageCandidate,
  type AisResolution,
} from "../core/automationInterconnect";
import { packageContentHash } from "../packages/packageHash";
import { CloudBackupController } from "../storage/cloud/cloudBackup";
import { acquireWorldLock } from "../storage/worldLock";
import { SaveCoordinator, SaveWork } from "../storage/saveCoordinator";
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
import type {
  ActorDocument,
  SceneDocument,
  TokenDocument,
  UserDocument,
} from "../core/documents";
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
import {
  InlineSimRunner,
  WorkerSimRunner,
  type SimRunner,
} from "../workers/simWorkerClient";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../packages";
import { readZipPackage } from "../packages/packageLoader";
import { type CompendiumPack } from "../core/compendium";
import {
  clearParsedPackCache,
  packCacheKey,
  parsePackCached,
} from "../core/compendiumCache";
import {
  codeSteps,
  compareVersions,
  migrateDocuments,
  planMigrationChain,
  type MigrationStep,
} from "../core/migrations";
import {
  getFog,
  getPackage,
  getWorld,
  listPackages,
  putFog,
  putPackage,
} from "../storage/idb";
import type { BaseDocument, CollectionName } from "../core/documents";
import { TOP_LEVEL_COLLECTIONS } from "../core/documents";
import { diffFlat, type JsonRecord } from "../core/diff";
import type { Op, OpEnvelope } from "../core/ops";
import type { PackageRecord, WorldsRecord } from "../storage/idb";
import { listCheckpointsForWorld } from "../storage/strategicStore";
import type { SysSchema } from "../sim/pool";
import { verifyHello } from "../net/identity";

export const GM_USER_ID = "gm";
export const DEFAULT_SCENE_ID = "scene-1";
/**
 * The built-in strategic ruleset (`src/packages/massBattleBasic.ts`) — what a world runs when
 * no §12 system package is active. `WorldsRecord.system` is either this id or the active
 * package's id, so the record (and the join welcome that echoes it) always names the ruleset
 * the sim actually boots with.
 */
export const BUILTIN_SYSTEM_ID = "mass-battle-basic";
export const BUILTIN_SYSTEM_VERSION = "1.0.0";

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
  type: "system" | "data" | "module";
  packCount: number;
  active: boolean;
  enabled: boolean;
  /** Content hash for AIS modules; null for non-executable system/data packages. */
  hash: string | null;
  requestedCapabilities: AisCapability[];
  grantedCapabilities: AisCapability[];
  /** Manifest-declared callable entry points; these are not arbitrary string dispatch. */
  commands: AisModuleCommandDeclaration[];
  emittedEvents: string[];
  /** Exact-hash local code approval (separate from the world-shared enabled profile). */
  approved: boolean;
  /** §12 module asks for in-page execution (GM must grant). */
  trustRequested: boolean;
  /** §12 GM granted in-page trust for this world. */
  trusted: boolean;
  /** Package ids the manifest names as companions (advisory, D-110). */
  dependencies: string[];
  /** The subset of `dependencies` not imported into this world — what the GM still has to add. */
  missingDependencies: string[];
}

export interface HostAutomationModuleBoot {
  packageId: string;
  version: string;
  hash: string;
  source: string;
  capabilities: AisCapability[];
  commands: AisModuleCommandDeclaration[];
  emittedEvents: string[];
}

export interface HostAutomationBoot {
  /** World-shared intent only; local capability grants are excluded. */
  profile: AisActivationProfile;
  resolution: AisResolution;
  /** Only exact-hash enabled modules with local execution approval appear here. */
  modules: HostAutomationModuleBoot[];
}

export interface HostAutomationModuleSummary {
  id: string;
  name: string;
  version: string;
  hash: string;
  enabled: boolean;
  approved: boolean;
  requestedCapabilities: AisCapability[];
  grantedCapabilities: AisCapability[];
  commands: AisModuleCommandDeclaration[];
  emittedEvents: string[];
}

export interface HostAutomationState {
  profile: AisActivationProfile;
  modules: HostAutomationModuleSummary[];
  resolution: AisResolution;
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
  /**
   * Pin a strategic ruleset for this world (applies at the next load; fresh campaigns only).
   * `warnings` is present only when something is worth telling the GM — today: declared
   * dependencies that are not imported.
   */
  activate(
    id: string,
  ): Promise<{ ok: true; warnings?: string[] } | { ok: false; error: string }>;
  deactivate(): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * True once any scene has resolved a turn (a checkpoint exists): the strategic ruleset is
   * pinned for this campaign and activate/deactivate will refuse (D-249 UI reads this to say so
   * up front instead of after a click).
   */
  campaignStarted(): Promise<boolean>;
  /** §12 grant/revoke in-page execution trust (per package, this world). */
  grantTrust(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  revokeTrust(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** §12 compendia: parsed read-only packs from every imported package. */
  compendia(): Promise<Array<{ packageId: string; packFile: string; pack: CompendiumPack }>>;
  /** Current AIS profile, module approvals and provider diagnostics. */
  automation(): Promise<HostAutomationState>;
  /** Bounded, text-only view of an entry file so local approval can be informed. */
  previewAutomationModule(id: string): Promise<
    | { ok: true; entry: string; source: string; truncated: boolean }
    | { ok: false; error: string }
  >;
  /** Add an exact version/hash lock to the world-shared profile; code consent is separate. */
  enableAutomationModule(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  disableAutomationModule(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Choose a declared exclusive provider, enabling that provider if needed. */
  selectAutomationProvider(slotId: string, providerRef: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Replace this package's local capability allow-list (hash-bound to installed bytes). */
  grantAutomationCapabilities(id: string, capabilities: AisCapability[]): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Clear this package's local code/capability approval. */
  revokeAutomationApproval(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
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
  readonly saves: SaveCoordinator;
  readonly cloudBackups: CloudBackupController;
  readonly assets: AssetServer;
  readonly pipeline: ImportPipeline;
  /** §12 what the sim booted with this world load. */
  readonly rulesBoot: HostRulesBoot;
  /** §12 active package module entry for the sandboxed iframe (null = none). */
  readonly moduleBoot: HostModuleBoot | null;
  /** AIS independent multi-module runtime plan (local grants never enter its profile). */
  readonly automationBoot: HostAutomationBoot;
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
  /**
   * Stop live writes and settle persistence. Awaitable because `close()` runs
   * the persister's FINAL flush (§8 write-behind batches documents on a
   * ~500 ms timer): a caller that replaces the world rows next — the §8
   * world.zip restore — must not race that flush, or the last batched write
   * lands after the restore's delete and resurrects documents the archive
   * does not contain (D-179). Callers that only tear down may `void` it.
   */
  close(): Promise<void>;
}

function aisCandidates(records: readonly PackageRecord[]): AisPackageCandidate[] {
  return records.map((rec) => ({
    id: rec.id,
    version: rec.version,
    hash: packageContentHash(rec.files),
    type: rec.type,
    ...(rec.manifest.interconnect ? { interconnect: rec.manifest.interconnect } : {}),
  }));
}

function resolveAutomationState(
  records: readonly PackageRecord[],
  world: WorldsRecord | undefined,
): { state: HostAutomationState; boot: HostAutomationBoot } {
  const profileValidation = validateAisActivationProfile(world?.automationProfile ?? emptyAisProfile());
  const profile = profileValidation.ok ? profileValidation.value : emptyAisProfile();
  const candidates = aisCandidates(records);
  const resolution = resolveAisProfile(candidates, profile, world?.activeRulesPackage ?? world?.system ?? BUILTIN_SYSTEM_ID);
  if (!profileValidation.ok) resolution.issues.unshift({
    kind: "invalid-profile",
    message: profileValidation.error,
    blocking: true,
  });

  const conflictingPackages = new Set<string>();
  let blocksAll = false;
  for (const issue of resolution.issues) {
    if (!issue.blocking) continue;
    if (issue.kind === "invalid-profile") blocksAll = true;
    if (issue.packageId) conflictingPackages.add(issue.packageId);
    if (issue.slotId) {
      for (const module of resolution.modules) {
        if (module.interconnect?.provides?.some((entry) => entry.id === issue.slotId))
          conflictingPackages.add(module.id);
      }
    }
  }

  const modules: HostAutomationModuleSummary[] = [];
  const bootModules: HostAutomationModuleBoot[] = [];
  for (const rec of records) {
    if (rec.type !== "module" || !rec.manifest.interconnect) continue;
    const hash = packageContentHash(rec.files);
    const requestedCapabilities = [...(rec.manifest.interconnect.capabilities ?? [])];
    const commands = [...(rec.manifest.interconnect.commands ?? [])];
    const emittedEvents = [...(rec.manifest.interconnect.emits ?? [])];
    const lock = profile.modules.find((entry) => entry.id === rec.id);
    const enabled = lock?.version === rec.version && lock.hash === hash;
    const savedGrant = world?.automationGrants?.[rec.id];
    const approved = savedGrant?.hash === hash && Array.isArray(savedGrant.capabilities);
    const grantedCapabilities = approved
      ? savedGrant.capabilities.filter((capability) => requestedCapabilities.includes(capability))
      : [];
    modules.push({
      id: rec.id,
      name: rec.name,
      version: rec.version,
      hash,
      enabled,
      approved,
      requestedCapabilities,
      grantedCapabilities,
      commands,
      emittedEvents,
    });

    if (!enabled || !approved || blocksAll || conflictingPackages.has(rec.id)) continue;
    const resolved = resolution.modules.find((candidate) => candidate.id === rec.id);
    if (!resolved) continue;
    bootModules.push({
      packageId: rec.id,
      version: rec.version,
      hash,
      source: rec.files[rec.manifest.interconnect.entry] ?? "",
      capabilities: grantedCapabilities,
      commands,
      emittedEvents,
    });
  }
  modules.sort((a, b) => a.id.localeCompare(b.id));
  const orderIndex = new Map(resolution.order.map((id, index) => [id, index]));
  bootModules.sort((a, b) => (orderIndex.get(a.packageId) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.packageId) ?? Number.MAX_SAFE_INTEGER));
  return {
    state: { profile, modules, resolution },
    boot: { profile, resolution, modules: bootModules },
  };
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

export function makeToken(
  id: string,
  x: number,
  y: number,
  name = id,
): TokenDocument {
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

export async function bootHostApp(
  options: HostAppOptions = {},
): Promise<HostApp> {
  const lock = { release: () => {} };
  try {
    return await bootHostAppLocked(options, lock);
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function bootHostAppLocked(
  options: HostAppOptions,
  lock: { release: () => void },
): Promise<HostApp> {
  const db = options.db ?? (await openVttDb());
  const now = options.now ?? (() => Date.now());

  // ── world selection: explicit → most recent → fresh ────────────────────────
  let persister: HostPersister;
  let meta: StoreMeta;
  let worldRec: WorldsRecord | undefined;
  if (options.worldId) {
    lock.release = await acquireWorldLock(options.worldId);
    persister = await HostPersister.open(db, options.worldId, { now });
    const rec = (await listWorlds(db)).find(
      (w) => w.worldId === options.worldId,
    );
    worldRec = rec;
    meta = {
      worldId: options.worldId,
      name: rec?.name ?? "World",
      system: rec?.system ?? BUILTIN_SYSTEM_ID,
      systemVersion: rec?.version ?? "1.0.0",
    };
  } else {
    const worlds = await listWorlds(db);
    const latest = worlds[0];
    if (latest) {
      lock.release = await acquireWorldLock(latest.worldId);
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
      meta = {
        worldId,
        name: "World One",
        system: BUILTIN_SYSTEM_ID,
        systemVersion: BUILTIN_SYSTEM_VERSION,
      };
      lock.release = await acquireWorldLock(meta.worldId);
      persister = await HostPersister.createWorld(db, meta, { now });
      worldRec = await getWorld(db, worldId);
    }
  }

  // ── Host Core (§8 startup: documents + oplog tail replay) ──────────────────
  const log = new OpLog();
  const store = new DocumentStore({ meta });
  await persister.attach(store, log);
  const saves = new SaveCoordinator(persister, now);

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
  const BUILTIN_VERSION = BUILTIN_SYSTEM_VERSION;
  const activePkgRec: PackageRecord | undefined = worldRec?.activeRulesPackage
    ? await getPackage(db, meta.worldId, worldRec.activeRulesPackage)
    : undefined;
  const effectiveSystemId = worldRec?.activeRulesPackage ?? meta.system;
  const currentVersion =
    activePkgRec?.manifest.version ??
    (effectiveSystemId === BUILTIN_SYSTEM_ID ? BUILTIN_VERSION : null);
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
    const chain = planMigrationChain(
      declared,
      persistedVersion,
      currentVersion,
    );
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
          diff: diffFlat(
            before as unknown as JsonRecord,
            after as unknown as JsonRecord,
          ),
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
          migrationBoot = {
            ...base,
            error: `migration envelope rejected: ${appliedEnv.error}`,
          };
        } else {
          const appended = log.append(envelope, appliedEnv.value.inverses);
          if (!appended.ok) {
            migrationBoot = {
              ...base,
              error: `migration log: ${appended.error}`,
            };
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
  // The asset server exists before HostSync; the hook begins fan-out once sessions are available.
  let manifestHost: HostSync | null = null;
  wireManifestToStore(assets, store, () =>
    manifestHost?.broadcastAssetManifests(),
  );
  const pipeline = new ImportPipeline(
    assets,
    options.codec ?? new AssetWorkerCodec(),
  );

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
    pipeline,
    // Stable package/file/entry addressing: resolve only from this world's
    // imported actor pack, on the host, at invocation time. Never import or
    // mutate a compendium entry just to summon it.
    resolveSummonSource: async (ref): Promise<ActorDocument | undefined> => {
      const rec = await getPackage(db, meta.worldId, ref.packageId);
      const descriptor = rec?.manifest.packs?.find(
        (pack) => pack.file === ref.packFile && pack.type === "actors",
      );
      if (!rec || !descriptor) return undefined;
      const body = rec.files[descriptor.file];
      if (!body) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return undefined;
      }
      const pack = parsePackCached(
        packCacheKey({
          worldId: meta.worldId,
          packageId: rec.id,
          version: rec.version,
          importedAt: rec.importedAt,
          file: descriptor.file,
        }),
        parsed,
      );
      if (pack?.type !== "actors") return undefined;
      const entry = pack.entries.find((row) => row.id === ref.entryId);
      if (!entry || entry.data.type !== "actor") return undefined;
      const data = entry.data;
      return { ...data, _id: ref.entryId, type: "actor", name: data.name,
        ownership: { default: 0 }, flags: typeof data.flags === "object" && data.flags !== null &&
          !Array.isArray(data.flags) ? data.flags : {},
        system: typeof data.system === "object" && data.system !== null &&
          !Array.isArray(data.system) ? data.system : {},
        items: Array.isArray(data.items) ? data.items : [],
        effects: Array.isArray(data.effects) ? data.effects : [],
        ...(entry.img && data.img === undefined ? { img: entry.img } : {}),
      } as ActorDocument;
    },
    // D-250: explored fog per user + scene lives in the world's `fog` store, so a reload,
    // a player's reconnect and the world file all bring the same map back.
    fogStore: {
      getEpoch: (sceneId, levelId) => getFogEpoch(db, meta.worldId, sceneId, levelId),
      setEpoch: (sceneId, levelId, epoch) => saves.writeAndFlush(JSON.stringify(["fog-epoch", sceneId, levelId]), () => putFogEpoch(db, { worldId: meta.worldId, sceneId, levelId, epoch })),
      getState: async (userId, sceneId, levelId) => (await getFog(db, meta.worldId, sceneId, userId, levelId)) ?? null,
      put: async (userId, sceneId, png, levelId, epoch) => {
        const copy = new Uint8Array(png);
        saves.write(JSON.stringify(["fog", userId, sceneId, levelId ?? null]), () =>
          putFog(db, { worldId: meta.worldId, sceneId, userId, png: copy, ...(levelId === undefined ? {} : { levelId }), ...(epoch ? { epoch } : {}) }),
        );
      },
      get: async (userId, sceneId, levelId) =>
        (await getFog(db, meta.worldId, sceneId, userId, levelId))?.png ?? null,
    },
  });
  manifestHost = host;

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
      rulesBoot = {
        source: "package",
        packageId: pkg.id,
        version: info.version,
        error: null,
      };
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
  const initialAis = resolveAutomationState(
    await listPackages(db, meta.worldId),
    await getWorld(db, meta.worldId),
  );
  const automationBoot = initialAis.boot;
  // N01 (§1.6): announce the ACTIVE battle on the wire — every welcome carries
  // the resolved schema + scene, so joiners adopt the package's columns instead
  // of the mass-battle-basic guess (PF1e campaigns decode on join). Before the
  // GM loopback session is added, so the first welcome already includes it.
  host.setSimInfo({
    sceneId: DEFAULT_SCENE_ID,
    schema: simSys,
    packageId: rulesBoot.packageId,
    version: rulesBoot.version,
  });
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
    // N01: the GM loopback rides the SAME adoption path as remote joiners —
    // the welcome (already carrying simInfo from setSimInfo above) installs
    // the schema/scene. Constructor options remain a test-only escape hatch.
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

  saves.addDomain(() => host.saveWork.drain());
  saves.addDomain(() => pipeline.saveWork.drain());
  saves.addDomain(() => assets.saveWork.drain());
  saves.addDomain(() => channel.saveState());
  const packageWork = new SaveWork();
  saves.addDomain(() => packageWork.drain());
  const removeLifecycle = installHostLifecycle(saves);

  // ── §12 package management (world-scoped; activation applies at load) ──────
  const summarize = (
    rec: PackageRecord,
    active: string | null,
    trustedIds: readonly string[],
    importedIds: readonly string[],
    ais: HostAutomationState,
  ): PackageSummary => {
    const dependencies = rec.manifest.dependencies ?? [];
    const module = ais.modules.find((entry) => entry.id === rec.id);
    return {
      id: rec.id,
      name: rec.name,
      version: rec.version,
      type: rec.type,
      packCount: rec.manifest.packs?.length ?? 0,
      active: active === rec.id,
      enabled: module?.enabled ?? false,
      hash: module?.hash ?? null,
      requestedCapabilities: module?.requestedCapabilities ?? [],
      grantedCapabilities: module?.grantedCapabilities ?? [],
      commands: module?.commands ?? [],
      emittedEvents: module?.emittedEvents ?? [],
      approved: module?.approved ?? false,
      trustRequested: rec.manifest.module?.trusted === true,
      trusted: trustedIds.includes(rec.id),
      dependencies,
      missingDependencies: dependencies.filter((dep) => !importedIds.includes(dep)),
    };
  };
  const activePackageId = async (): Promise<string | null> =>
    (await getWorld(db, meta.worldId))?.activeRulesPackage ?? null;
  const importedIds = async (): Promise<string[]> =>
    (await listPackages(db, meta.worldId)).map((r) => r.id);
  const automationState = async (): Promise<HostAutomationState> => {
    const [records, world] = await Promise.all([
      listPackages(db, meta.worldId),
      getWorld(db, meta.worldId),
    ]);
    return resolveAutomationState(records, world).state;
  };
  const editableAutomationProfile = async (): Promise<{
    profile: AisActivationProfile;
    world: WorldsRecord | undefined;
    records: PackageRecord[];
  }> => {
    const [world, records] = await Promise.all([
      getWorld(db, meta.worldId),
      listPackages(db, meta.worldId),
    ]);
    const validated = validateAisActivationProfile(world?.automationProfile ?? emptyAisProfile());
    if (!validated.ok) throw new Error(`invalid saved AIS profile: ${validated.error}`);
    return { profile: validated.value, world, records };
  };
  const savedEnabledAutomationIds = (world: WorldsRecord | undefined): string[] => {
    const validated = validateAisActivationProfile(world?.automationProfile ?? emptyAisProfile());
    return validated.ok ? validated.value.modules.map((module) => module.id) : [];
  };
  const revokeUnresolvedAutomationGrants = async (previouslyEnabledIds: readonly string[]): Promise<void> => {
    if (previouslyEnabledIds.length === 0) return;
    const [world, records] = await Promise.all([
      getWorld(db, meta.worldId),
      listPackages(db, meta.worldId),
    ]);
    const grants = world?.automationGrants;
    if (!grants || Object.keys(grants).length === 0) return;
    const resolvedIds = new Set(resolveAutomationState(records, world).boot.modules.map((module) => module.packageId));
    const previouslyEnabled = new Set(previouslyEnabledIds);
    const next = Object.fromEntries(Object.entries(grants).filter(([id]) =>
      !previouslyEnabled.has(id) || resolvedIds.has(id),
    ));
    if (Object.keys(next).length !== Object.keys(grants).length)
      await persister.patchWorld({ automationGrants: Object.keys(next).length ? next : undefined });
  };
  const guardFreshCampaign = async (): Promise<string | null> => {
    // Rules are pinned per campaign: swapping after the first checkpoint would break §5A
    // determinism/replay. Checked across EVERY scene, not just the default one — a world may
    // run several strategic scenes, and a checkpoint on any of them was produced by the
    // current ruleset.
    const cps = await listCheckpointsForWorld(db, meta.worldId);
    return cps.length > 0
      ? "campaign already started — the strategic ruleset is pinned once a turn has been resolved (start a fresh world to change it)"
      : null;
  };
  const trustedIds = async (): Promise<string[]> =>
    (await getWorld(db, meta.worldId))?.trustedPackages ?? [];
  const writeTrusted = async (next: string[]): Promise<{ ok: true }> => {
    // §12: world-record patches go through the persister — a bare putWorld is reverted by its
    // next write-behind flush (the cached record is the authority).
    await persister.patchWorld({ trustedPackages: next });
    return { ok: true };
  };
  const packageImpl: HostPackages = {
    async list() {
      const [active, trusted, records, ais] = await Promise.all([
        activePackageId(),
        trustedIds(),
        listPackages(db, meta.worldId),
        automationState(),
      ]);
      const ids = records.map((r) => r.id);
      return records.map((r) => summarize(r, active, trusted, ids, ais));
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
      const previous = await getPackage(db, meta.worldId, rec.id);
      const beforeWorld = await getWorld(db, meta.worldId);
      const previouslyEnabledIds = savedEnabledAutomationIds(beforeWorld);
      const previousHash = previous?.type === "module" ? packageContentHash(previous.files) : null;
      const nextHash = rec.type === "module" ? packageContentHash(rec.files) : null;
      if (previousHash !== nextHash) {
        const grants = Object.fromEntries(
          Object.entries(beforeWorld?.automationGrants ?? {}).filter(([id]) => id !== rec.id),
        );
        await persister.patchWorld({ automationGrants: Object.keys(grants).length ? grants : undefined });
      }
      await putPackage(db, rec);
      // A package write invalidates the parsed-pack memo outright: two imports inside the same
      // millisecond would otherwise share an `importedAt` and serve the previous parse (G-45).
      clearParsedPackCache();
      await revokeUnresolvedAutomationGrants(previouslyEnabledIds);
      return {
        ok: true,
        summary: summarize(
          rec,
          await activePackageId(),
          await trustedIds(),
          await importedIds(),
          await automationState(),
        ),
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
      // §12: the world's version tracks the ACTIVE system (migration baseline), and `system`
      // names it — the record, the join welcome and the world file all read the same id.
      const beforeWorld = await getWorld(db, meta.worldId);
      const previouslyEnabledIds = savedEnabledAutomationIds(beforeWorld);
      await persister.patchWorld({
        activeRulesPackage: id,
        system: id,
        version: rec.manifest.version,
      });
      await revokeUnresolvedAutomationGrants(previouslyEnabledIds);
      const present = await importedIds();
      const missing = (rec.manifest.dependencies ?? []).filter(
        (dep) => !present.includes(dep),
      );
      return missing.length === 0
        ? { ok: true }
        : {
            ok: true,
            warnings: [
              `${rec.name} expects ${missing.join(", ")} alongside it — not imported into this world yet`,
            ],
          };
    },
    async campaignStarted() {
      return (await guardFreshCampaign()) !== null;
    },
    async deactivate() {
      const guarded = await guardFreshCampaign();
      if (guarded) return { ok: false, error: guarded };
      const beforeWorld = await getWorld(db, meta.worldId);
      const previouslyEnabledIds = savedEnabledAutomationIds(beforeWorld);
      await persister.patchWorld({
        activeRulesPackage: undefined,
        system: BUILTIN_SYSTEM_ID,
        version: BUILTIN_SYSTEM_VERSION,
      });
      await revokeUnresolvedAutomationGrants(previouslyEnabledIds);
      return { ok: true };
    },
    async grantTrust(id) {
      const rec = await getPackage(db, meta.worldId, id);
      if (!rec) return { ok: false, error: `package not imported: ${id}` };
      if (rec.manifest.module?.trusted !== true) {
        return {
          ok: false,
          error: "package does not request in-page execution",
        };
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
    async automation() {
      return automationState();
    },
    async previewAutomationModule(id) {
      const rec = await getPackage(db, meta.worldId, id);
      if (!rec || rec.type !== "module" || !rec.manifest.interconnect)
        return { ok: false, error: `AIS module not imported: ${id}` };
      const entry = rec.manifest.interconnect.entry;
      const source = rec.files[entry];
      if (source === undefined) return { ok: false, error: `AIS entry ${entry} is missing` };
      const limit = 120_000;
      return {
        ok: true,
        entry,
        source: source.slice(0, limit),
        truncated: source.length > limit,
      };
    },
    async enableAutomationModule(id) {
      try {
        const rec = await getPackage(db, meta.worldId, id);
        if (!rec || rec.type !== "module" || !rec.manifest.interconnect)
          return { ok: false, error: `AIS module not imported: ${id}` };
        const { profile, world, records } = await editableAutomationProfile();
        const next = withAisModule(profile, {
          id: rec.id,
          version: rec.version,
          hash: packageContentHash(rec.files),
        });
        const resolution = resolveAisProfile(
          aisCandidates(records),
          next,
          world?.activeRulesPackage ?? world?.system ?? BUILTIN_SYSTEM_ID,
        );
        const blockers = resolution.issues.filter((issue) => issue.blocking);
        if (blockers.length > 0)
          return { ok: false, error: blockers.map((issue) => issue.message).join("; ") };
        await persister.patchWorld({ automationProfile: next });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async disableAutomationModule(id) {
      try {
        const { profile } = await editableAutomationProfile();
        const previouslyEnabledIds = profile.modules.map((entry) => entry.id);
        const next: AisActivationProfile = {
          api: profile.api,
          modules: profile.modules.filter((entry) => entry.id !== id),
          providers: Object.fromEntries(
            Object.entries(profile.providers).filter(([, selected]) => !selected.startsWith(`${id}/`)),
          ),
        };
        await persister.patchWorld({ automationProfile: next });
        await revokeUnresolvedAutomationGrants(previouslyEnabledIds);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async selectAutomationProvider(slotId, providerRef) {
      try {
        const { profile, world, records } = await editableAutomationProfile();
        const slash = providerRef.indexOf("/");
        const packageId = slash > 0 ? providerRef.slice(0, slash) : "";
        const rec = records.find((entry) => entry.id === packageId && entry.type === "module");
        const declaration = rec?.manifest.interconnect?.provides?.find((entry) =>
          entry.id === slotId && `${rec.id}/${entry.id}` === providerRef,
        );
        if (!rec || !declaration)
          return { ok: false, error: `${providerRef} does not declare ${slotId}` };
        if (declaration.mode !== "exclusive")
          return { ok: false, error: `${slotId} is not an exclusive provider slot` };
        const slotDeclarations = records.flatMap((entry) => entry.type === "module"
          ? (entry.manifest.interconnect?.provides ?? []).filter((candidate) => candidate.id === slotId)
            .map((candidate) => ({ moduleId: entry.id, declaration: candidate }))
          : [],
        );
        if (slotDeclarations.some((entry) => entry.declaration.mode !== "exclusive" || entry.declaration.contract !== declaration.contract))
          return { ok: false, error: `${slotId} providers use incompatible modes or contract versions` };
        const next = withAisModule(profile, {
          id: rec.id,
          version: rec.version,
          hash: packageContentHash(rec.files),
        });
        next.providers[slotId] = providerRef;
        const resolution = resolveAisProfile(
          aisCandidates(records),
          next,
          world?.activeRulesPackage ?? world?.system ?? BUILTIN_SYSTEM_ID,
        );
        const blockers = resolution.issues.filter((issue) => issue.blocking);
        if (blockers.length > 0)
          return { ok: false, error: blockers.map((issue) => issue.message).join("; ") };
        await persister.patchWorld({ automationProfile: next });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async grantAutomationCapabilities(id, capabilities) {
      try {
        const rec = await getPackage(db, meta.worldId, id);
        if (!rec || rec.type !== "module" || !rec.manifest.interconnect)
          return { ok: false, error: `AIS module not imported: ${id}` };
        const requested = rec.manifest.interconnect.capabilities ?? [];
        const grants = [...new Set(capabilities)];
        const unsupported = grants.filter((capability) => !requested.includes(capability));
        if (unsupported.length > 0)
          return { ok: false, error: `module did not request ${unsupported.join(", ")}` };
        const world = await getWorld(db, meta.worldId);
        const next = { ...(world?.automationGrants ?? {}) };
        next[id] = { hash: packageContentHash(rec.files), capabilities: grants };
        await persister.patchWorld({ automationGrants: next });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async revokeAutomationApproval(id) {
      try {
        const world = await getWorld(db, meta.worldId);
        const next = Object.fromEntries(
          Object.entries(world?.automationGrants ?? {}).filter(([packageId]) => packageId !== id),
        );
        await persister.patchWorld({ automationGrants: Object.keys(next).length ? next : undefined });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async compendia() {
      const out: Array<{
        packageId: string;
        packFile: string;
        pack: CompendiumPack;
      }> = [];
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
          // World-origin packs: parsed from this world's own package records (world zip),
          // so the 2,000-entry app-body cap does not apply (size-domain decision, D-252).
          // Memoized per package record (G-45): reopening the compendium does not re-parse the
          // converted world, and a re-import wins because `importedAt` is part of the key.
          const pack = parsePackCached(
            packCacheKey({
              worldId: meta.worldId,
              packageId: rec.id,
              version: rec.version,
              importedAt: rec.importedAt,
              file: descriptor.file,
            }),
            parsed,
          );
          if (pack) out.push({ packageId: rec.id, packFile: descriptor.file, pack });
        }
      }
      return out;
    },
  };

  const packages: HostPackages = {
    ...packageImpl,
    importZip: (bytes) => packageWork.run(() => packageImpl.importZip(bytes)),
    activate: (id) => packageWork.run(() => packageImpl.activate(id)),
    deactivate: () => packageWork.run(() => packageImpl.deactivate()),
    grantTrust: (id) => packageWork.run(() => packageImpl.grantTrust(id)),
    revokeTrust: (id) => packageWork.run(() => packageImpl.revokeTrust(id)),
    automation: () => packageWork.run(() => packageImpl.automation()),
    enableAutomationModule: (id) => packageWork.run(() => packageImpl.enableAutomationModule(id)),
    disableAutomationModule: (id) => packageWork.run(() => packageImpl.disableAutomationModule(id)),
    selectAutomationProvider: (slotId, providerRef) => packageWork.run(() => packageImpl.selectAutomationProvider(slotId, providerRef)),
    grantAutomationCapabilities: (id, capabilities) => packageWork.run(() => packageImpl.grantAutomationCapabilities(id, capabilities)),
    revokeAutomationApproval: (id) => packageWork.run(() => packageImpl.revokeAutomationApproval(id)),
  };
  const cloudBackups = new CloudBackupController({
    worldId: meta.worldId,
    worldName: meta.name,
    archive: async () => {
      await saves.saveNow();
      const stamp = () =>
        [
          store.seq,
          host.saveWork.version,
          pipeline.saveWork.version,
          assets.saveWork.version,
          packageWork.version,
          channel.saveWork.version,
          saves.writeVersion,
        ].join(":");
      const before = stamp();
      const { exportWorldZip } = await import("../host/worldFile");
      const blob = await exportWorldZip({
        db,
        worldId: meta.worldId,
        root,
        persister,
      });
      if (stamp() !== before)
        throw new Error(
          "The world changed while preparing its backup. Retry between actions; pause realtime simulation first.",
        );
      return blob;
    },
  });
  void cloudBackups.restore();
  saves.start();
  let closed = false;

  return {
    rulesBoot,
    moduleBoot,
    automationBoot,
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
    saves,
    cloudBackups,
    assets,
    pipeline,
    gm: { client: gmClient, bus: gmBus, cache, fetcher, channel },
    async close(): Promise<void> {
      if (closed) return;
      // Fail before tearing down the live app: the GM can retry without losing the world UI.
      await saves.saveNow();
      // Final document flush must finish before a caller may replace world rows (D-179).
      await persister.close();
      closed = true;
      cloudBackups.dispose();
      saves.stop();
      channel.stop();
      removeLifecycle();
      runner.terminate();
      gmClient.close();
      host.removeSession("gm");
      host.dispose();
      assets.close();
      lock.release();
    },
  };
}
