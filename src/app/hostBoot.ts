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
  type AisContributionDeclaration,
  type AisPackageRequirement,
  type AisPanelDeclaration,
  type AisResolution,
  type AisSettingDeclaration,
  type AisTokenActionDeclaration,
  cloneAisSettingDeclaration,
} from "../core/automationInterconnect";
import { aisOwnSource, aisRuntimePackage, aisRuntimeResources } from "../packages/aisRuntimePackage";
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
import { AssetServer, sha256Hex, wireManifestToStore } from "../host/assets";
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
import { importRulesModule } from "../sim/rulesLoader";
import type { RulesModule } from "../core/rules";
import type { WelcomeRulesArtifact } from "../core/messages";
import { BUILTIN_SYSTEM_ID, BUILTIN_SYSTEM_VERSION } from "./builtinSystem";
import { createWorldFromRecipe } from "./worldRecipe";
import { loadFirstPartyRecipePackages, type FirstPartyPackage } from "./firstPartyPackages";
import { importUiModule, type PackageUiModule } from "../packages/uiModuleLoader";
export { BUILTIN_SYSTEM_ID, BUILTIN_SYSTEM_VERSION } from "./builtinSystem";
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
  /**
   * D-473: when no world exists and one has to be created, create it on the first-party PF1e
   * ruleset (with its content companion) instead of the built-in rules — the `?e2e=1&rules=pf1e`
   * host route. Ignored when this build carries no first-party package (built-in, as before) and
   * when a world already exists (nothing is created then).
   */
  firstPartyRules?: boolean;
  /** Test seam: the first-party list to use instead of the build's embedded one. */
  firstPartyPackages?: readonly FirstPartyPackage[];
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
  runtimeProvider?: boolean;
  runtimeProviderId?: string;
  runtimeHash?: string;
  runtimeError?: string;
  /** Manifest-declared callable entry points; these are not arbitrary string dispatch. */
  commands: AisModuleCommandDeclaration[];
  emittedEvents: string[];
  /** D-468: delivered to players once approved (GM opt-out per module); false for non-modules. */
  sharedWithPlayers: boolean;
  /** D-469: the manifest forbids player execution (`sharing: "host-only"`). */
  hostOnly: boolean;
  /** D-470: declared sandboxed panel. */
  panel?: AisPanelDeclaration;
  /** D-476: schema-declared settings the packages view renders as a form. */
  settings: AisSettingDeclaration[];
  /** D-478: sibling modules this one depends on / contribution slots it fills (from the manifest). */
  requires: AisPackageRequirement[];
  provides: AisContributionDeclaration[];
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
  resources?: Record<string, string>;
  appearance?: boolean;
  runtimeProvider?: boolean;
  runtimeHash?: string;
  runtimeContext?: import("../core/documents").Json;
  runtimeDependencies?: Array<{ packageId: string; version: string; hash: string; capabilities: AisCapability[] }>;
  blockedReason?: string;
  /** D-468: package display name, carried to players with the shared module. */
  name: string;
  /** D-468: false when the GM keeps this approved module on the host device only. */
  sharedWithPlayers: boolean;
  /** D-469: the manifest says `sharing: "host-only"` — never offered to players, whatever the GM ticks. */
  hostOnly?: boolean;
  /** D-469: manifest-declared token-menu entries (emitted back as `ui.token.action`). */
  tokenActions?: AisTokenActionDeclaration[];
  /** D-470: the module draws a panel in its own sandboxed document; the shell chromes it. */
  panel?: AisPanelDeclaration;
  /** D-476: schema-declared settings (world scope replicated, device scope local). */
  settings?: AisSettingDeclaration[];
  /** D-478: declared dependencies — the only modules this one may invoke through the kernel. */
  requires?: AisPackageRequirement[];
  /** D-478: contribution slots, shown to sibling modules through `modules.list`. */
  provides?: AisContributionDeclaration[];
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
  runtimeProvider?: boolean;
  runtimeProviderId?: string;
  runtimeHash?: string;
  runtimeError?: string;
  /** D-468: delivered to players once approved (default true; GM opt-out per module). */
  sharedWithPlayers: boolean;
  /** D-469: the manifest forbids player execution (`sharing: "host-only"`). */
  hostOnly: boolean;
  /** D-470: declared sandboxed panel (title only matters to the review UI). */
  panel?: AisPanelDeclaration;
  /** D-476: schema-declared settings. */
  settings: AisSettingDeclaration[];
  /** D-478: manifest dependencies / contribution slots (the review UI lists them). */
  requires: AisPackageRequirement[];
  provides: AisContributionDeclaration[];
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
  /**
   * D-471: whether the host page also holds the package's RulesModule (the same `rules.js` the
   * worker validated) for its own dispatch — order validation in the army window, hero stats on
   * resolve. `"builtin"` = mass-battle-basic (no package); a string = the in-page import failed
   * and those features fall back to the built-in rules while the worker still runs the package.
   */
  inPage: "package" | "builtin" | { error: string };
  /**
   * D-475: the package's `ui.js` (window components) imported in-page — `"package"` when it
   * loaded, `"none"` when the package declares no UI (or runs built-in), an error when the
   * declared entry did not evaluate or failed the shape gate (the rules still run).
   */
  ui: "package" | "none" | { error: string };
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
  /** Host-local explicit activation; never exposes code/resources to player RPC. */
  runtimePlan(): Promise<HostAutomationBoot>;
  /** Local runtime invalidation. Package edits do not hot-load newly approved code. */
  onAutomationChanged(listener: () => void | Promise<void>): () => void;
  /** Bounded, text-only view of an entry file so local approval can be informed. */
  previewAutomationModule(id: string): Promise<
    | { ok: true; entry: string; source: string; truncated: boolean; hash: string; runtimeHash?: string }
    | { ok: false; error: string }
  >;
  /** Add an exact version/hash lock to the world-shared profile; code consent is separate. */
  enableAutomationModule(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  disableAutomationModule(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Choose a declared exclusive provider, enabling that provider if needed. */
  selectAutomationProvider(slotId: string, providerRef: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Replace this package's local capability allow-list (hash-bound to installed bytes). */
  grantAutomationCapabilities(id: string, capabilities: AisCapability[], reviewedHash?: string, reviewedRuntimeHash?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Clear this package's local code/capability approval. */
  revokeAutomationApproval(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** D-468: keep an approved module on this device only (false) or deliver it to players (true, default). */
  setAutomationSharing(id: string, shared: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
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
  /**
   * D-471: the active system's RulesModule as loaded in the host page (null = built-in rules).
   * This is the dispatch instance host code consumes instead of importing system symbols.
   */
  readonly rulesModule: RulesModule | null;
  /** D-475: the active package's window components, or null (built-in rules / no UI / failed). */
  readonly uiModule: PackageUiModule | null;
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
    const hostOnly = rec.manifest.interconnect.sharing === "host-only";
    const sharedWithPlayers = !hostOnly && world?.automationSharing?.[rec.id] !== false;
    const tokenActions = rec.manifest.interconnect.tokenActions ?? [];
    const panel = rec.manifest.interconnect.panel ? { ...rec.manifest.interconnect.panel } : undefined;
    const settings = (rec.manifest.interconnect.settings ?? []).map((declaration) => cloneAisSettingDeclaration(declaration));
    const requires = (rec.manifest.interconnect.requires ?? []).map((requirement) => ({ ...requirement }));
    const provides = (rec.manifest.interconnect.provides ?? []).map((slot) => ({ ...slot }));
    let runtime: ReturnType<typeof aisRuntimePackage> = null;
    let runtimeError: string | undefined;
    try { runtime = aisRuntimePackage(rec, records); }
    catch (error) { runtimeError = error instanceof Error ? error.message : String(error); }
    const approved = savedGrant?.hash === hash && Array.isArray(savedGrant.capabilities) &&
      (!rec.manifest.interconnect.runtime || (!!runtime && runtime.hash === savedGrant.runtimeHash));
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
      ...(rec.manifest.interconnect.runtimeProvider ? { runtimeProvider: true } : {}),
      ...(rec.manifest.interconnect.runtime ? { runtimeProviderId: rec.manifest.interconnect.runtime.provider } : {}),
      ...(runtime ? { runtimeHash: runtime.hash } : {}),
      ...(runtimeError ? { runtimeError } : {}),
      sharedWithPlayers,
      hostOnly,
      ...(panel ? { panel } : {}),
      settings,
      requires,
      provides,
      commands,
      emittedEvents,
    });

    if (!enabled || !approved || blocksAll || conflictingPackages.has(rec.id)) continue;
    const resolved = resolution.modules.find((candidate) => candidate.id === rec.id);
    if (!resolved) continue;
    bootModules.push({
      packageId: rec.id,
      name: rec.name,
      version: rec.version,
      hash,
      sharedWithPlayers,
      ...(hostOnly ? { hostOnly: true } : {}),
      ...(tokenActions.length > 0 ? { tokenActions: tokenActions.map((action) => ({ ...action })) } : {}),
      ...(panel ? { panel: { ...panel } } : {}),
      ...(settings.length > 0 ? { settings: settings.map((declaration) => cloneAisSettingDeclaration(declaration)) } : {}),
      ...(requires.length > 0 ? { requires } : {}),
      ...(provides.length > 0 ? { provides } : {}),
      source: runtime?.source ?? aisOwnSource(rec),
      resources: aisRuntimeResources(rec),
      ...(rec.manifest.interconnect.provides?.some((slot) => slot.id === "ui.theme" && slot.mode === "exclusive" && slot.contract === 1)
        ? { appearance: true } : {}),
      ...(rec.manifest.interconnect.runtimeProvider ? { runtimeProvider: true } : {}),
      ...(runtime ? {
        runtimeHash: runtime.hash,
        runtimeContext: { profile: rec.manifest.interconnect.runtime?.profile ?? "",
          configuration: runtime.configuration, packageId: rec.id,
          providerId: runtime.provider.id, sourceHash: hash, runtimeHash: runtime.hash },
        runtimeDependencies: [{ packageId: runtime.provider.id, version: runtime.provider.version,
          hash: packageContentHash(runtime.provider.files),
          capabilities: world?.automationGrants?.[runtime.provider.id]?.capabilities ?? [] }],
        ...(!(world?.automationGrants?.[runtime.provider.id]?.hash === packageContentHash(runtime.provider.files) &&
          profile.modules.some((lock) => lock.id === runtime.provider.id && lock.hash === packageContentHash(runtime.provider.files)))
          ? { blockedReason: `Enable and locally approve runtime provider ${runtime.provider.id}, then reload` } : {}),
      } : {}),
      ...((rec.manifest.interconnect.runtimeProvider || runtime) &&
          (!grantedCapabilities.includes("runtime.execute") || (runtime &&
            !world?.automationGrants?.[runtime.provider.id]?.capabilities.includes("runtime.execute")))
        ? { blockedReason: "Enable and locally approve runtime provider and guest with runtime.execute, then reload" } : {}),
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
      lock.release = await acquireWorldLock(worldId);
      const firstParty = options.firstPartyRules
        ? await loadFirstPartyRecipePackages(...(options.firstPartyPackages ? [options.firstPartyPackages] : []))
        : null;
      if (firstParty) {
        // D-473: the recipe writes the package rows and the `activeRulesPackage` pin before the
        // first boot, exactly as the New-world wizard does — no activate-then-reload step.
        await createWorldFromRecipe(
          { name: "World One", ruleset: { kind: "package", pkg: firstParty.ruleset }, content: firstParty.content },
          { db, now, worldId },
        );
        persister = await HostPersister.open(db, worldId, { now });
        worldRec = await getWorld(db, worldId);
        meta = {
          worldId,
          name: "World One",
          system: worldRec?.system ?? firstParty.ruleset.manifest.id,
          systemVersion: worldRec?.version ?? firstParty.ruleset.manifest.version,
        };
      } else {
        meta = {
          worldId,
          name: "World One",
          system: BUILTIN_SYSTEM_ID,
          systemVersion: BUILTIN_SYSTEM_VERSION,
        };
        persister = await HostPersister.createWorld(db, meta, { now });
        worldRec = await getWorld(db, worldId);
      }
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
    inPage: "builtin",
    ui: "none",
  };
  let rulesModule: RulesModule | null = null;
  let uiModule: PackageUiModule | null = null;
  let simSys: SysSchema = MASS_BATTLE_SCHEMA_COLUMNS;
  let rulesSource: string | undefined;
  let rulesArtifact: WelcomeRulesArtifact | undefined;
  let uiArtifact: WelcomeRulesArtifact | undefined;
  if (pkg && pkgSource !== undefined) {
    // §12 gate: the package is imported (blob URL) + validated INSIDE the
    // worker sandbox before any campaign may start; failure degrades cleanly
    // to the built-in mass-battle rules.
    try {
      if (!runner.loadRules) throw new Error("runner cannot load packages");
      const info = await runner.loadRules(pkgSource, 5_000);
      // D-471: the host page keeps its own copy of the validated package for dispatch (order
      // validation, hero stats). Same source, same shape gate; the InlineSimRunner fallback has
      // always imported it in-page, so this adds no new execution tier.
      const inPage = await importRulesModule(pkgSource);
      if (inPage.ok) rulesModule = inPage.value.module;
      // D-475: the package's window components load in the page the same way; a UI that does
      // not evaluate is the package's error to show, never a reason to drop its rules.
      let uiBoot: HostRulesBoot["ui"] = "none";
      const uiEntry = pkg.manifest.ui?.entry;
      const uiSource = uiEntry === undefined ? undefined : pkg.files[uiEntry];
      if (uiEntry !== undefined) {
        if (uiSource === undefined) uiBoot = { error: `ui entry ${uiEntry} is missing from the package` };
        else {
          const imported = await importUiModule(uiSource);
          if (imported.ok) {
            uiModule = imported.value;
            uiBoot = "package";
          } else uiBoot = { error: imported.error };
        }
      }
      rulesBoot = {
        source: "package",
        packageId: pkg.id,
        version: info.version,
        error: null,
        inPage: inPage.ok ? "package" : { error: inPage.error },
        ui: uiBoot,
      };
      simSys = pkg.manifest.rules?.modelColumns ?? MASS_BATTLE_SCHEMA_COLUMNS;
      rulesSource = pkgSource;
      // D-472: the same bytes travel to players as a content-addressed artifact on the assets
      // channel, so a player shell can run the world's rules in-page after its own consent.
      const artifactBytes = new TextEncoder().encode(pkgSource);
      const artifactHash = await sha256Hex(artifactBytes);
      host.publishArtifact(artifactHash, artifactBytes);
      rulesArtifact = { hash: artifactHash, size: artifactBytes.byteLength, name: pkg.manifest.name };
      // D-475: the UI the GM page could evaluate is published beside it, under the same consent.
      if (uiBoot === "package" && uiSource !== undefined) {
        const uiBytes = new TextEncoder().encode(uiSource);
        const uiHash = await sha256Hex(uiBytes);
        host.publishArtifact(uiHash, uiBytes);
        uiArtifact = { hash: uiHash, size: uiBytes.byteLength, name: pkg.manifest.name };
      }
    } catch (e) {
      rulesBoot = {
        source: "builtin",
        packageId: pkg.id,
        version: pkg.manifest.version,
        error: e instanceof Error ? e.message : String(e),
        inPage: "builtin",
        ui: "none",
      };
    }
  } else if (worldRec?.activeRulesPackage) {
    rulesBoot = {
      source: "builtin",
      packageId: worldRec.activeRulesPackage,
      version: "1.0.0",
      error: "active package record missing or not a system package",
      inPage: "builtin",
      ui: "none",
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
    ...(rulesArtifact ? { artifact: rulesArtifact } : {}),
    ...(uiArtifact ? { ui: uiArtifact } : {}),
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
    ...(rulesModule?.leaderStats ? { leaderStats: rulesModule.leaderStats } : {}),
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
  const automationListeners = new Set<() => void | Promise<void>>();
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
      ...(module?.runtimeProvider ? { runtimeProvider: true } : {}),
      ...(module?.runtimeProviderId ? { runtimeProviderId: module.runtimeProviderId } : {}),
      ...(module?.runtimeHash ? { runtimeHash: module.runtimeHash } : {}),
      ...(module?.runtimeError ? { runtimeError: module.runtimeError } : {}),
      commands: module?.commands ?? [],
      emittedEvents: module?.emittedEvents ?? [],
      sharedWithPlayers: module?.sharedWithPlayers ?? false,
      hostOnly: module?.hostOnly ?? false,
      ...(module?.panel ? { panel: module.panel } : {}),
      settings: module?.settings ?? [],
      requires: module?.requires ?? [],
      provides: module?.provides ?? [],
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
    async runtimePlan() {
      const [records, world] = await Promise.all([listPackages(db, meta.worldId), getWorld(db, meta.worldId)]);
      return resolveAutomationState(records, world).boot;
    },
    onAutomationChanged(listener) {
      automationListeners.add(listener);
      return () => { automationListeners.delete(listener); };
    },
    async previewAutomationModule(id) {
      const rec = await getPackage(db, meta.worldId, id);
      if (!rec || rec.type !== "module" || !rec.manifest.interconnect)
        return { ok: false, error: `AIS module not imported: ${id}` };
      const entry = rec.manifest.interconnect.entry;
      let source: string;
      let runtime: ReturnType<typeof aisRuntimePackage>;
      try {
        source = aisOwnSource(rec);
        runtime = aisRuntimePackage(rec, await listPackages(db, meta.worldId));
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      const limit = 120_000;
      return {
        ok: true,
        entry,
        source: source.slice(0, limit),
        truncated: source.length > limit,
        hash: packageContentHash(rec.files),
        ...(runtime ? { runtimeHash: runtime.hash } : {}),
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
    async grantAutomationCapabilities(id, capabilities, reviewedHash, reviewedRuntimeHash) {
      try {
        const rec = await getPackage(db, meta.worldId, id);
        if (!rec || rec.type !== "module" || !rec.manifest.interconnect)
          return { ok: false, error: `AIS module not imported: ${id}` };
        const hash = packageContentHash(rec.files);
        if (reviewedHash !== undefined && reviewedHash !== hash)
          return { ok: false, error: "Package changed after the source preview. Review the new code before approving it." };
        const runtime = aisRuntimePackage(rec, await listPackages(db, meta.worldId));
        if (runtime && runtime.hash !== reviewedRuntimeHash)
          return { ok: false, error: "Runtime composition changed or was not reviewed. Preview guest and adapter code before approval." };
        const requested = rec.manifest.interconnect.capabilities ?? [];
        const grants = [...new Set(capabilities)];
        const unsupported = grants.filter((capability) => !requested.includes(capability));
        if (unsupported.length > 0)
          return { ok: false, error: `module did not request ${unsupported.join(", ")}` };
        const world = await getWorld(db, meta.worldId);
        const next = { ...(world?.automationGrants ?? {}) };
        next[id] = { hash, capabilities: grants, ...(runtime ? { runtimeHash: runtime.hash } : {}) };
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
    async setAutomationSharing(id, shared) {
      try {
        const world = await getWorld(db, meta.worldId);
        const next = Object.fromEntries(Object.entries(world?.automationSharing ?? {}).filter(([key]) => key !== id));
        if (!shared) next[id] = false;
        await persister.patchWorld({ automationSharing: Object.keys(next).length ? next : undefined });
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

  // Serialize package read/modify/write operations, then invalidate running modules before
  // acknowledging the edit. SaveWork also covers the invalidation barrier.
  let packageTail: Promise<unknown> = Promise.resolve();
  const mutatePackage = <T>(work: () => Promise<T>): Promise<T> => packageWork.run(() => {
    const next = packageTail.then(async () => {
      try { return await work(); }
      finally {
        for (const listener of automationListeners) {
          try { await listener(); }
          catch (error) { console.error("AIS runtime invalidation failed", error); }
        }
      }
    });
    packageTail = next.catch(() => {});
    return next;
  });
  const packages: HostPackages = {
    ...packageImpl,
    importZip: (bytes) => mutatePackage(() => packageImpl.importZip(bytes)),
    activate: (id) => mutatePackage(() => packageImpl.activate(id)),
    deactivate: () => mutatePackage(() => packageImpl.deactivate()),
    grantTrust: (id) => mutatePackage(() => packageImpl.grantTrust(id)),
    revokeTrust: (id) => mutatePackage(() => packageImpl.revokeTrust(id)),
    automation: () => packageWork.run(() => packageImpl.automation()),
    enableAutomationModule: (id) => mutatePackage(() => packageImpl.enableAutomationModule(id)),
    disableAutomationModule: (id) => mutatePackage(() => packageImpl.disableAutomationModule(id)),
    selectAutomationProvider: (slotId, providerRef) => mutatePackage(() => packageImpl.selectAutomationProvider(slotId, providerRef)),
    grantAutomationCapabilities: (id, capabilities, reviewedHash, reviewedRuntimeHash) => mutatePackage(() => packageImpl.grantAutomationCapabilities(id, capabilities, reviewedHash, reviewedRuntimeHash)),
    revokeAutomationApproval: (id) => mutatePackage(() => packageImpl.revokeAutomationApproval(id)),
    setAutomationSharing: (id, shared) => mutatePackage(() => packageImpl.setAutomationSharing(id, shared)),
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
    rulesModule,
    uiModule,
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
