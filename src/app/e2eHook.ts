/**
 * Test-only hook (D-045): `?e2e` gates a window surface for Playwright to
 * drive the real bundled modules (WebRTC loopback, §14). Inert otherwise.
 */
import type { LoopbackResult } from "../net/webrtc";
import type { HostApp } from "./hostBoot";
import type { PlayerApp } from "./joinBoot";
import type { HostShare } from "./hostShare";
import { sightSegments } from "../canvas/vision/wallSight";
import {
  affectedTokens,
  areaPreviewRects,
  cellKey,
  pf1eAreaGridFromScene,
  resolveAreaCells,
  type PF1eAreaKind,
  type PF1eAreaIssue,
} from "../packages/pf1e/targeting";
import { deriveFromDocuments } from "../packages/pf1e/actor";
import { pf1eSpellSlotReadout, sheetRecord } from "../ui/sheets/pf1eSheetModel";
import {
  resolveCastingAttempt,
  type PF1eCastingTime,
  type PF1eConcentrationTrigger,
  type PF1eSpellTradition,
} from "../packages/pf1e/concentration";
import {
  resolveSpellTarget,
  spellResistanceCheck,
  spellSaveDc,
  type PF1eSaveSeverity,
  type PF1eSaveType,
} from "../packages/pf1e/casting";
import type { PF1eEnergyType } from "../packages/pf1e/healthState";

export interface CanvasSmokeResult {
  ok: boolean;
  layers: string[];
  canvasWidth: number;
  tokenCount: number;
  error?: string;
}

export interface ModelsSmokeResult {
  ok: boolean;
  lod0: number;
  lod1Units: number;
  lod2Armies: number;
  culled: number;
  hitUnit: string | null;
  boxUnits: string[];
  syncMs: number;
  /** §7 atlas readbacks (D-085). */
  atlasBound: number;
  atlasFrames: number;
  atlasDropped: number;
  error?: string;
}

/** Live app introspection (null when boot failed). */
export interface AppSurface {
  worldId(): string;
  seq(): number;
  tokenCount(): number;
  tokenPos(): { x: number; y: number } | null;
  sceneImg(): string | null;
  activeSceneId(): string | null;
  gridSize(): number | null;
  sceneCount(): number;
  lastRejected(): string | null;
  /** §12 rules-package boot state + management readbacks. */
  rulesBoot(): {
    source: "package" | "builtin";
    packageId: string | null;
    version: string;
    error: string | null;
  };
  /** §12 world-load migration record (null = versions already current). */
  migrationBoot(): {
    systemId: string;
    from: string;
    to: string;
    applied: string[];
    changedDocs: number;
    error: string | null;
  } | null;
  /** §5A/N01: the battle the host announced in the GM's welcome (null = none). */
  simInfo(): {
    sceneId: string;
    packageId: string | null;
    version: string;
    schema: Record<string, string>;
  } | null;
  packages(): Promise<
    Array<{
      id: string;
      name: string;
      version: string;
      type: string;
      packCount: number;
      active: boolean;
    }>
  >;
  importPackageZip(bytes: number[]): Promise<{ ok: boolean; error?: string }>;
  activatePackage(id: string): Promise<{ ok: boolean; error?: string }>;
  deactivatePackage(): Promise<{ ok: boolean; error?: string }>;
  /**
   * P5/C01: resolve a PF1e area against the **live** scene — its grid metadata,
   * its sight-blocking walls and its tokens — through the same pure module the
   * unit tests exercise. This is the seam the canvas preview overlay and
   * affected-token highlighting will read, so the browser spec asserts the real
   * scene→cells→tokens path rather than a re-implementation.
   */
  pf1eArea(spec: {
    kind: string;
    originCol: number;
    originRow: number;
    radiusFt: number;
  }): {
    ok: boolean;
    cellSize: number;
    feetPerCell: number;
    diagonals: string;
    cells: number;
    cellKeys: string[];
    affectedTokenIds: string[];
    previewRects: number;
    issues: Array<{ field: string; message: string }>;
  };
  /**
   * P5/C02: resolve one spell save through the **real** bundled chain —
   * authored `system.pf1e` → `deriveFromDocuments` save totals → DC → save →
   * severity → energy mitigation. The caller supplies the die faces (the
   * resolver is diceless), so the browser spec asserts the wiring, not a
   * re-implementation of the rules.
   */
  pf1eCastResolve(spec: {
    system: Record<string, unknown>;
    attributes?: Record<string, unknown>;
    damage: number;
    energyType?: string;
    severity: string;
    saveType: string;
    spellLevel: number;
    keyAbilityMod: number;
    saveDie: number;
    casterLevel?: number;
    spellResistance?: number;
    srDie?: number;
    energyResistance?: Record<string, number>;
  }): {
    ok: boolean;
    error: string | null;
    dc: number;
    saveBonus: number;
    resisted: boolean;
    passed: boolean;
    automatic: string | null;
    dealt: number;
    notes: string[];
  };
  /**
   * P5/C03: run the pre-save casting gate. The caster's deafened/grappled/pinned
   * state comes from the **authored actor document** via `deriveFromDocuments`, not
   * from the spec, so the browser path proves real data reaches the rules.
   */
  pf1eCastAttempt(spec: {
    system: Record<string, unknown>;
    components: string;
    tradition: string;
    castingTime: string;
    spellLevel: number;
    casterLevel: number;
    keyAbilityMod: number;
    armorChance?: number;
    shieldChance?: number;
    arcaneDie?: number;
    deafenedDie?: number;
    canSpeak?: boolean;
    hasFreeHand?: boolean;
    componentsInHand?: boolean;
    castingDefensively?: boolean;
    concentrationDie?: number;
    injury?: number;
    injuryDie?: number;
  }): {
    ok: boolean;
    error: string | null;
    outcome: string;
    legal: boolean;
    reasons: string[];
    conditions: string[];
    asfChance: number;
    asfFailed: boolean | null;
    deafenedFailed: boolean | null;
    concentrationDc: number | null;
    concentrationTotal: number | null;
    concentrationPassed: boolean | null;
    notes: string[];
  };
  /**
   * P5/C04: the summary tab's level 0-9 spell slot readout. Runs the same
   * `pf1eSpellSlotReadout` adapter the sheet renders, so the browser path proves
   * the sheet's own code reaches the rules rather than a copy of it.
   */
  pf1eSpellSlots(spec: { system: Record<string, unknown> }): {
    summary: string;
    grantedLevels: number[];
    rows: {
      level: number;
      label: string;
      text: string;
      over: boolean;
      total: number | null;
      spent: number;
    }[];
    warnings: string[];
    mode: "prepared" | "spontaneous";
    keyAbility: string;
    keyAbilityScore: number | null;
    ok: boolean;
    issues: string[];
  };
}

export interface PlayerSurface {
  userId(): string;
  worldId(): string;
  worldName(): string;
  seq(): number;
  /** Hash of the active scene's map (null until imported), §7. */
  sceneImg(): string | null;
  tokenCount(): number;
  tokenPos(): { x: number; y: number } | null;
  role(): string | null;
  connected(): boolean;
  /** Test-only direct manual-signaling access (atomic code exchange). */
  takeOutbox(): string[];
  receiveCode(code: string): Promise<void>;
  connState(): string;
  /** "nostr" | "manual" — which transport the session rides. */
  transport(): string;
  /** Asset chunks received over the wire this session (§7 cache-hit tests). */
  assetChunks(): number;
  /** §5A strategic replica readbacks (null before the first snapshot). */
  simCount(): number | null;
  simVersion(): number;
  /** §5A/N01: the battle adopted from the host's welcome (null = none). */
  simInfo(): {
    sceneId: string;
    packageId: string | null;
    version: string;
    schema: Record<string, string>;
  } | null;
  turnPhase(): string;
  /** Events in the last received turn.report (0 until one arrives). */
  reportEvents(): number;
  /** §11 distributions from the last received report (null before one). */
  reportByType(): Record<string, number> | null;
  cacheHas(hash: string): Promise<boolean>;
}

export interface ShareSurface {
  invite(): string;
  receiveCode(code: string): Promise<void>;
  takeOutbox(): string[];
}

export interface GridsSmokeResult {
  ok: boolean;
  snapped: { x: number; y: number };
  isCenter: boolean;
  error?: string;
}

export interface ParitySmokeResult {
  ok: boolean;
  clockOffsetMs: number | null;
  rttMs: number | null;
  audioLanded: boolean;
  scheduledDelayMs: number | null;
  soundState: string | null;
  secretVisible: boolean;
  tablePosted: boolean;
  error?: string;
}

export interface VisionSmokeResult {
  ok: boolean;
  workerPoly: number;
  wallSegments: number;
  fogReadbackBytes: number;
  fogPutLanded: boolean;
  error?: string;
}

export interface ArmiesSmokeResult {
  ok: boolean;
  cards: number;
  treeUnits: number;
  rosterTotal: number;
  rosterRendered: number;
  orderLanded: boolean;
  orderPending: number;
  error?: string;
}

export interface GmFogSurface {
  /** Per-faction ownership maps (asserting §4A grants landed). */
  factionOwnership(): Record<string, Record<string, number>>;
  /** Strategic-fog cover rects currently drawn (0 = clear / god view). */
  rectCount(): number;
  /** Active scene flags.core.scale ("tactical" when unset). */
  sceneScale(): string;
  godView(): boolean;
  viewAsFaction(): string;
  /** GM client pool replica model count (null before the first snapshot). */
  simCount(): number | null;
  /** Last turn.phase frame phase ("idle" before any campaign). */
  turnPhase(): string;
  /** §9 ephemera readbacks: live pings/rulers on the effects layer. */
  effectsSummary(): { pings: number; rulers: number };
  /** §9 tile occlusion alpha per tile id (null = not rendered). */
  tileAlphas(): Record<string, number | null>;
  /** §9 e2e: create a tile doc through the client op path; returns its id. */
  seedTile(spec: {
    x: number;
    y: number;
    width: number;
    height: number;
    above: boolean;
    mode: "roof" | "fade";
    alpha: number;
  }): string;
  /** §12: rulesVersion of the last resolved turn's report. */
  reportRulesVersion(): string;
  /** §11 distributions byType of the last report the GM received. */
  reportByType(): Record<string, number>;
  /** §12 module notifications log (last 50, oldest first). */
  notifications(): { message: string; level: string }[];
  /** §12 module-scope setting readback (null = no module / unset key). */
  moduleSetting(key: string): Promise<unknown>;
  /** §12 where the active module runs: "inPage" | "iframe" | "none". */
  moduleMode(): string;
  /** §12 compendia census {packs, entries} across imported packages. */
  compendiumStats(): Promise<{ packs: number; entries: number }>;
  /** §12 migration probe: first army's system.schemaNote + units[0].stats.drill. */
  firstArmyProbe(): { schemaNote: unknown; drill: unknown } | null;
  /** §12 world-load migration record (null = versions already current). */
  migrationBoot(): {
    systemId: string;
    from: string;
    to: string;
    applied: string[];
    changedDocs: number;
    error: string | null;
  } | null;
  /** Actor documents in the world store. */
  actorCount(): number;
  /** §12 drag-imported tokens (name/actorId/img), newest last. */
  importedTokens(): { name: string; actorId: string; img: string }[];
  /** §11 3D dice overlay stats (lazy three.js loads, settled values). */
  dice3d(): {
    loads: number;
    rolls: number;
    settled: number;
    lastValues: number[];
    lastTotal: number | null;
    disposed: boolean;
  };
  /** §5A realtime clock telemetry + client interpolation stats. */
  realtimeInfo(): {
    running: boolean;
    phase: string;
    simHz: number;
    flushHz: number;
    reportHz: number;
    tick: number;
    ticksTotal: number;
    deltaFrames: number;
    coalescedMax: number;
    reports: number;
    checkpoints: number;
    version: number;
    pushes: number;
    interpolatedMoves: number;
    interpolating: boolean;
    replicaVersion: number;
    models: number;
    probeRaw: [number, number] | null;
    probeSampled: [number, number] | null;
  };
  /** Point the first unit at a far waypoint (realtime movement). */
  setFirstUnitMoveOrder(
    x: number,
    y: number,
  ): { ok: boolean; unitId: string | null; error: string | null };
  /** Fire a GM sim.control (start/pause/resume/rate/…) through the client. */
  simControl(
    action:
      | "pause"
      | "resume"
      | "rate"
      | "advance"
      | "next"
      | "undoTurn"
      | "mode"
      | "start",
    extra?: {
      rateHz?: number;
      mode?: "stepwise" | "realtime";
      deadlineMs?: number;
    },
  ): void;
  /** §11 commit-reveal audit: newest roll record + in-app verification. */
  committedRoll(): Promise<{
    formula: string;
    total: number;
    seedClient: string | null;
    seedHost: string | null;
    commit: string | null;
    verified: boolean;
    verifyError: string | null;
  } | null>;
  /** Army/unit census for GM-extras assertions. */
  armySnapshot(): {
    armies: number;
    factions: number;
    units: number;
    pendingOrders: number;
    strengths: number[];
    allyLists: Record<string, string[]>;
  };
  /** P5/C01 (D-154): resolve an area against the active scene and show the preview overlay. */
  pf1eAreaPreviewShow(spec: {
    kind: string;
    originCol: number;
    originRow: number;
    radiusFt: number;
  }): {
    ok: boolean;
    issues: Array<{ field: string; message: string }>;
    cells: number;
    affectedTokenIds: string[];
    label: string;
  };
  /** P5/C01 (D-154): clear the preview overlay. */
  pf1eAreaPreviewClear(): void;
  /** P5/C01 (D-154): what the overlay layer actually drew last. */
  pf1eAreaPreviewState(): {
    visible: boolean;
    rectsDrawn: number;
    highlights: number;
  };
}

export interface RulesPackageSmokeResult {
  ok: boolean;
  /** False on engines whose workers cannot import/eval packages (WebKit). */
  supported: boolean;
  unsupportedReason: string;
  version: string;
  urlScheme: string;
  subPhases: string[];
  orderTypes: string[];
  rulesVersion: string;
  eventTypes: string[];
  /** typeof [fetch, importScripts, XMLHttpRequest, WebSocket, indexedDB] as seen by the package inside the sandbox. */
  sandbox: string[];
  /** Built-in mass-battle rules still run after the package flow (resilience). */
  builtinRulesVersion: string;
  syntaxError: string;
  badShapeError: string;
  cpuAbuseError: string;
  error?: string;
}

export interface VttE2eSurface {
  gm?: GmFogSurface | null;
  webrtcLoopback(): Promise<LoopbackResult>;
  canvasSmoke(): Promise<CanvasSmokeResult>;
  modelsSmoke(): Promise<ModelsSmokeResult>;
  rulesPackageSmoke(): Promise<RulesPackageSmokeResult>;
  armiesSmoke(): Promise<ArmiesSmokeResult>;
  visionSmoke(): Promise<VisionSmokeResult>;
  gridsSmoke(): Promise<GridsSmokeResult>;
  paritySmoke(): Promise<ParitySmokeResult>;
  app: AppSurface | null;
  player: PlayerSurface | null;
  share: ShareSurface | null;
}

function playerSurface(playerApp: PlayerApp): PlayerSurface {
  const client = () => playerApp.client;
  let lastPhase = "idle";
  let lastReportEvents = 0;
  playerApp.bus.on("turnPhase", (m) => {
    lastPhase = m.phase;
  });
  let lastByType: Record<string, number> | null = null;
  playerApp.bus.on("turnReport", (m) => {
    lastReportEvents = m.report.events.length;
    const dist = (
      m.report.summary as unknown as {
        distributions?: { byType?: Record<string, number> };
      }
    ).distributions;
    lastByType = dist?.byType ?? {};
  });
  const scene = () => {
    const c = client();
    if (!c) return null;
    const s = c.store.get("scenes", "scene-1");
    return s ?? c.store.getAll("scenes")[0] ?? null;
  };
  return {
    userId: () => client()?.user?.id ?? playerApp.identity.publicKeyHex,
    worldId: () => playerApp.roomId,
    worldName: () => client()?.world?.name ?? "—",
    seq: () => client()?.store.seq ?? 0,
    sceneImg: () => scene()?.img ?? null,
    tokenCount: () => scene()?.tokens.length ?? 0,
    tokenPos: () => {
      const token = scene()?.tokens[0];
      return token ? { x: token.x, y: token.y } : null;
    },
    role: () => client()?.user?.role ?? null,
    connected: () => playerApp.session.stats.state === "connected",
    takeOutbox: () => playerApp.takeOutbox(),
    receiveCode: (code) => playerApp.receiveCode(code),
    connState: () => playerApp.session.stats.state,
    transport: () => playerApp.transportKind,
    assetChunks: () => playerApp.assetChunks,
    simCount: () => client()?.simReplica?.count ?? null,
    simVersion: () => client()?.simReplicaVersion ?? -1,
    simInfo: () => client()?.simInfo ?? null,
    turnPhase: () => lastPhase,
    reportEvents: () => lastReportEvents,
    reportByType: () => lastByType,
    cacheHas: (hash) => playerApp.cacheHas(hash),
  };
}

export async function installPlayerE2e(playerApp: PlayerApp): Promise<void> {
  const surface = (globalThis as { __vttE2E?: VttE2eSurface }).__vttE2E;
  if (surface) surface.player = playerSurface(playerApp);
}

export function installGmFogE2e(surface: GmFogSurface): void {
  const s = (globalThis as { __vttE2E?: VttE2eSurface }).__vttE2E;
  if (s) s.gm = surface;
}

export async function installShareE2e(share: HostShare): Promise<void> {
  const surface = (globalThis as { __vttE2E?: VttE2eSurface }).__vttE2E;
  if (surface) {
    surface.share = {
      invite: () => share.inviteLink,
      receiveCode: (code) => share.receiveCode(code),
      takeOutbox: () => share.takeOutbox(),
    };
  }
}

function appSurface(app: HostApp): AppSurface {
  const client = app.gm.client;
  const scene = () => client.store.get("scenes", "scene-1");
  const firstToken = () => scene()?.tokens[0];
  return {
    worldId: () => app.worldId,
    seq: () => client.store.seq,
    tokenCount: () => scene()?.tokens.length ?? 0,
    tokenPos: () => {
      const token = firstToken();
      return token ? { x: token.x, y: token.y } : null;
    },
    sceneImg: () => scene()?.img ?? null,
    activeSceneId: () => {
      const scenes = client.store.getAll("scenes");
      return (scenes.find((sc) => sc.active) ?? scenes[0])?._id ?? null;
    },
    sceneCount: () => client.store.getAll("scenes").length,
    lastRejected: () =>
      globalThis.localStorage.getItem("vtt-e2e-last-rejected"),
    rulesBoot: () => app.rulesBoot,
    migrationBoot: () => app.migrationBoot,
    simInfo: () => app.gm.client.simInfo,
    packages: () => app.packages.list(),
    importPackageZip: (bytes) =>
      app.packages
        .importZip(new Uint8Array(bytes))
        .then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error })),
    activatePackage: (id) => app.packages.activate(id),
    deactivatePackage: () => app.packages.deactivate(),
    gridSize: () => {
      const scenes = client.store.getAll("scenes");
      return ((scenes.find((sc) => sc.active) ?? scenes[0])?.grid.size ??
        null) as number | null;
    },
    pf1eArea: (spec) => {
      const s = scene();
      const fail = (issues: PF1eAreaIssue[]) => ({
        ok: false,
        cellSize: 0,
        feetPerCell: 0,
        diagonals: "",
        cells: 0,
        cellKeys: [] as string[],
        affectedTokenIds: [] as string[],
        previewRects: 0,
        issues,
      });
      if (!s) return fail([{ field: "scene", message: "no active scene" }]);
      const { grid, issues } = pf1eAreaGridFromScene(s.grid);
      if (issues.length > 0) return fail(issues);
      // Solid barriers only — LoE is "like line of sight … except that it isn't
      // blocked by fog, darkness", so the sight axis is the right one (AoN 212).
      const segments = sightSegments(s.walls);
      const res = resolveAreaCells(
        {
          kind: spec.kind as PF1eAreaKind,
          origin: { col: spec.originCol, row: spec.originRow },
          radiusFt: spec.radiusFt,
        },
        grid,
        { segments },
      );
      const hit = affectedTokens(res.cells, s.tokens, grid);
      return {
        ok: res.issues.length === 0,
        cellSize: grid.cellSize,
        feetPerCell: grid.feetPerCell,
        diagonals: grid.diagonals,
        cells: res.cells.length,
        cellKeys: res.cells.map(cellKey),
        affectedTokenIds: hit.map((t) => t._id),
        previewRects: areaPreviewRects(res.cells, grid).length,
        issues: res.issues,
      };
    },
    pf1eCastResolve: (spec) => {
      const blank = {
        ok: false,
        error: "" as string | null,
        dc: 0,
        saveBonus: 0,
        resisted: false,
        passed: false,
        automatic: null as string | null,
        dealt: 0,
        notes: [] as string[],
      };
      const derived = deriveFromDocuments({
        actor: { system: spec.system, attributes: spec.attributes },
      });
      const saveBonus =
        spec.saveType === "fort"
          ? derived.saves.fort
          : spec.saveType === "ref"
            ? derived.saves.ref
            : derived.saves.will;
      const { dc, issues } = spellSaveDc({
        spellLevel: spec.spellLevel,
        keyAbilityMod: spec.keyAbilityMod,
      });
      if (issues.length > 0) {
        return {
          ...blank,
          error: issues.map((i) => `${i.field}: ${i.message}`).join("; "),
        };
      }
      const sr = spellResistanceCheck({
        die: spec.srDie,
        casterLevel: spec.casterLevel ?? 0,
        spellResistance: spec.spellResistance ?? 0,
      });
      if (sr.issues.length > 0) {
        return {
          ...blank,
          dc,
          saveBonus,
          error: sr.issues[0]?.message ?? "sr",
        };
      }
      const res = resolveSpellTarget({
        damage: spec.damage,
        energyType: spec.energyType as PF1eEnergyType | undefined,
        severity: spec.severity as PF1eSaveSeverity,
        saveType: spec.saveType as PF1eSaveType,
        dc,
        saveBonus,
        saveDie: spec.saveDie,
        sr,
        defender:
          spec.energyResistance === undefined
            ? {}
            : {
                energyResistance: spec.energyResistance as Partial<
                  Record<PF1eEnergyType, number>
                >,
              },
      });
      if (!res.ok) return { ...blank, dc, saveBonus, error: res.error };
      return {
        ok: true,
        error: null,
        dc,
        saveBonus,
        resisted: res.resisted,
        passed: res.passed,
        automatic: res.automatic,
        dealt: res.dealt,
        notes: res.notes,
      };
    },
    pf1eCastAttempt: (spec) => {
      const derived = deriveFromDocuments({ actor: { system: spec.system } });
      const conditions = derived.conditions;
      const triggers: PF1eConcentrationTrigger[] = [];
      if (
        spec.castingDefensively === true &&
        spec.concentrationDie !== undefined
      ) {
        triggers.push({
          situation: "castDefensively",
          die: spec.concentrationDie,
        });
      }
      if (spec.injury !== undefined && spec.injuryDie !== undefined) {
        triggers.push({
          situation: "injured",
          damage: spec.injury,
          die: spec.injuryDie,
        });
      }
      const res = resolveCastingAttempt({
        components: spec.components,
        tradition: spec.tradition as PF1eSpellTradition,
        castingTime: spec.castingTime as PF1eCastingTime,
        spellLevel: spec.spellLevel,
        casterLevel: spec.casterLevel,
        keyAbilityMod: spec.keyAbilityMod,
        caster: {
          canSpeak: spec.canSpeak !== false,
          hasFreeHand: spec.hasFreeHand !== false,
          componentsInHand: spec.componentsInHand !== false,
          deafened: conditions.includes("deafened"),
          grappled: conditions.includes("grappled"),
          pinned: conditions.includes("pinned"),
        },
        armor:
          spec.armorChance === undefined
            ? undefined
            : { chance: spec.armorChance },
        shield:
          spec.shieldChance === undefined
            ? undefined
            : { chance: spec.shieldChance },
        arcaneDie: spec.arcaneDie,
        deafenedDie: spec.deafenedDie,
        triggers,
      });
      const first = res.concentration.checks[0];
      return {
        ok: res.ok,
        error: res.error,
        outcome: res.outcome,
        legal: res.legal,
        reasons: res.reasons,
        conditions,
        asfChance: res.asfChance,
        asfFailed: res.asfFailed,
        deafenedFailed: res.deafenedFailed,
        concentrationDc: first ? first.dc : null,
        concentrationTotal: first ? first.total : null,
        concentrationPassed: first ? first.passed : null,
        notes: res.notes,
      };
    },
    pf1eSpellSlots: (spec) => {
      const derived = deriveFromDocuments({ actor: { system: spec.system } });
      // D-155: the persisted ledger (`slotsUsed`) and prepared list ride the same
      // adapter the sheet renders, so the browser path proves their projection too.
      const pf1e = spec.system.pf1e;
      const authoredSpells =
        pf1e && typeof pf1e === "object" && !Array.isArray(pf1e)
          ? (pf1e as Record<string, unknown>).spells
          : null;
      const readout = pf1eSpellSlotReadout(
        derived,
        sheetRecord(authoredSpells),
      );
      return {
        summary: readout.view.summary,
        grantedLevels: readout.view.grantedLevels,
        rows: readout.view.rows.map((row) => ({
          level: row.level,
          label: row.label,
          text: row.text,
          over: row.over,
          total: row.total,
          spent: row.spent,
        })),
        warnings: readout.view.warnings,
        mode: readout.mode,
        keyAbility: readout.keyAbility,
        keyAbilityScore: readout.keyAbilityScore,
        ok: readout.ok,
        issues: readout.issues.map(
          (issue) => `${issue.field}: ${issue.message}`,
        ),
      };
    },
  };
}

async function runCanvasSmoke(): Promise<CanvasSmokeResult> {
  try {
    const { createStage, LAYER_ORDER } = await import("../canvas/stage");
    const host = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(host);
    const stage = await createStage({
      width: 320,
      height: 240,
      hostElement: host,
    });
    stage.setGrid({ type: "square", size: 64 });
    stage.fit(640, 480);
    stage.syncTokens([
      {
        _id: "t1",
        type: "token",
        name: "Rex",
        ownership: { default: 0 },
        flags: {},
        system: {},
        x: 320,
        y: 240,
        rotation: 0,
        width: 64,
        height: 64,
        img: "",
        hidden: false,
        disposition: "friendly",
        vision: true,
        light: { radius: 0, color: "#fff", alpha: 0.5 },
      },
    ]);
    stage.setMarquee({ x: 16, y: 16 }, { x: 400, y: 300 });
    stage.render();
    const layers = stage.root.children.map((c) => c.label);
    const tokens = stage.root.getChildByLabel("tokens");
    const tokenCount = tokens ? tokens.children.length : -1;
    const canvasWidth = stage.app.canvas.width;
    stage.destroy();
    host.remove();
    const ok =
      layers.length === LAYER_ORDER.length &&
      layers.every((label, i) => label === LAYER_ORDER[i]) &&
      tokenCount === 1 &&
      canvasWidth === 320;
    return { ok, layers, canvasWidth, tokenCount };
  } catch (err) {
    return {
      ok: false,
      layers: [],
      canvasWidth: 0,
      tokenCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** §9A scale smoke: 13k models through LOD0/1/2 + hit-test + box-select. */
async function runModelsSmoke(): Promise<ModelsSmokeResult> {
  try {
    const { createStage } = await import("../canvas/stage");
    const { createModelPool, allocModel } = await import("../sim/pool");
    const { drawableUnits } = await import("../canvas/layers/ModelLayer/units");
    const { planAtlases } = await import("../canvas/layers/ModelLayer/atlases");
    const { ModelStatus } = await import("../core/strategic");
    type UnitDocument = import("../core/strategic").UnitDocument;
    type ArmyDocument = import("../core/strategic").ArmyDocument;
    type FactionDocument = import("../core/strategic").FactionDocument;
    const host = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(host);
    const stage = await createStage({
      width: 640,
      height: 480,
      hostElement: host,
    });
    const layer = stage.getModelLayer();

    const unit = (
      id: string,
      name: string,
      range: [number, number],
      unitType = "infantry",
    ): UnitDocument =>
      ({
        _id: id,
        type: unitType as UnitDocument["type"],
        name,
        ownership: { default: 0 },
        flags: {},
        system: {},
        profile: {},
        formation: "line" as const,
        sceneId: null,
        modelRange: range,
        orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
        stats: {
          strength: range[1] - range[0],
          morale: 5,
          supply: 5,
          fatigue: 0,
        },
      }) as UnitDocument;
    const army = (
      id: string,
      name: string,
      factionId: string,
      units: UnitDocument[],
    ) =>
      ({
        _id: id,
        type: "army" as const,
        name,
        ownership: { default: 0 },
        flags: {},
        system: {},
        factionId,
        commander: [],
        supply: { level: 5 },
        units,
      }) as ArmyDocument;
    const armies = [
      army("army-red", "Red Host", "f-red", [
        unit("u-r1", "Red 1st", [0, 5000]),
        unit("u-r2", "Red 2nd", [5000, 10000], "cavalry"),
      ]),
      army("army-blue", "Blue Host", "f-blue", [
        unit("u-b1", "Blue 1st", [10000, 13000], "artillery"),
      ]),
    ];
    const factions: FactionDocument[] = [
      {
        _id: "f-red",
        type: "faction",
        name: "Red",
        color: "#c0392b",
        allies: [],
        ownership: { default: 0 },
        flags: {},
        system: {},
      },
      {
        _id: "f-blue",
        type: "faction",
        name: "Blue",
        color: "#2e6f9e",
        allies: [],
        ownership: { default: 0 },
        flags: {},
        system: {},
      },
    ];
    const units = drawableUnits(armies, factions);

    // §7 sprite atlases (D-085): frames per (unit type × faction palette),
    // hash-addressed, ≤16 atlas textures bound
    const { plans: atlasPlans, dropped } = planAtlases(
      units.map((u) => ({ unitType: u.type, palette: u.color })),
    );
    layer.registerAtlases(atlasPlans);
    const atlasStats = layer.atlasStats();

    const pool = createModelPool(13000);
    for (let i = 0; i < 10000; i++) {
      allocModel(pool, {
        id: i + 1,
        unitIdx: i < 5000 ? 0 : 1,
        x: 100 + (i % 90),
        y: 100 + Math.floor(i / 90) * 1.1,
        hp: 1,
        hpMax: 1,
        facing: 64,
      });
    }
    for (let i = 0; i < 3000; i++) {
      allocModel(pool, {
        id: 20000 + i,
        unitIdx: 2,
        x: 420 + (i % 50),
        y: 380 + Math.floor(i / 50) * 1.1,
        hp: 1,
        hpMax: 1,
      });
    }
    pool.status[42] = (pool.status[42] ?? 0) | ModelStatus.hidden; // projected-slot stand-in: must not draw/hit
    pool.status[43] = (pool.status[43] ?? 0) | ModelStatus.dead;

    const cam = { x: 0, y: 0, scale: 1 };
    const stats0 = layer.sync(pool, units, cam, stage.viewport);
    stage.render();
    const hitUnit = layer.hitTest(100.5, 100.5, pool);
    const boxUnits = [
      ...layer.unitsInRect({ x: 95, y: 95, width: 30, height: 30 }, pool),
    ].sort();

    const stats1 = layer.sync(
      pool,
      units,
      { ...cam, scale: 0.3 },
      stage.viewport,
    );
    stage.render();
    const stats2 = layer.sync(
      pool,
      units,
      { ...cam, scale: 0.1 },
      stage.viewport,
    );
    stage.render();

    const again = layer.sync(pool, units, cam, stage.viewport); // warm path timing
    stage.render();

    // §9A order overlays: committed geometry + live preview draw from file://
    const { orderOverlayGeometry, orderVisibility } =
      await import("../canvas/interactions/orderOverlays");
    const { OrderOverlayLayer } = await import("../canvas/layers/OrderOverlay");
    const { measurePath } = await import("../canvas/grid/measure");
    const anchors = new Map<string, { x: number; y: number }>();
    for (const u of units) {
      const range = u.modelRange;
      if (!range) continue;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = range[0]; i < Math.min(range[1], pool.count); i++) {
        if (((pool.status[i] ?? 0) & 3) !== 0) continue; // dead|hidden
        sx += pool.x[i] ?? 0;
        sy += pool.y[i] ?? 0;
        n++;
      }
      if (n > 0) anchors.set(u.id, { x: sx / n, y: sy / n });
    }
    const overlayUnits = units.map((u) => ({
      ...u,
      anchor: anchors.get(u.id) ?? null,
      orders:
        u.id === "u-r1"
          ? {
              pending: [
                {
                  kind: "move" as const,
                  path: [
                    { x: 300, y: 140 },
                    { x: 320, y: 160 },
                  ],
                  pace: "march" as const,
                },
              ],
              issuedBy: "gm",
              issuedTurn: 1,
            }
          : u.id === "u-b1"
            ? {
                pending: [{ kind: "attack" as const, targetUnitId: "u-r1" }],
                issuedBy: "gm",
                issuedTurn: 1,
              }
            : null,
    }));
    const geometry = orderOverlayGeometry(overlayUnits, orderVisibility(null)); // GM sees all
    const overlay = new OrderOverlayLayer();
    stage.root.addChild(overlay.container);
    const lengths = new Map<string, number>();
    for (const path of [...geometry.paths, ...geometry.charges]) {
      lengths.set(path.unitId, measurePath(null, path.points));
    }
    overlay.sync(geometry, cam, lengths);
    overlay.syncPreview(
      {
        kind: "move",
        from: { x: 100, y: 100 },
        points: [{ x: 120, y: 100 }],
        pace: "march",
        lengthWorld: 20,
      },
      cam,
      20,
    );
    stage.render();
    overlay.destroy();

    stage.destroy();
    host.remove();
    const ok =
      stats0.lod0Models === 7998 && // 12,998 drawable − density-demoted u-r1 (5,000)
      stats0.lod1Units === 1 &&
      stats0.lod2Armies === 0 &&
      hitUnit === "u-r1" &&
      boxUnits.length === 1 &&
      stats1.lod1Units === 3 &&
      stats1.lod0Models === 0 &&
      stats2.lod2Armies === 2 &&
      stats2.lod0Models === 0 &&
      again.syncMs < 500 &&
      geometry.paths.length === 1 &&
      geometry.targets.length === 1 &&
      geometry.charges.length === 0;
    return {
      ok,
      lod0: stats0.lod0Models,
      atlasBound: atlasStats.bound,
      atlasFrames: atlasStats.frames,
      atlasDropped: dropped.length,
      lod1Units: stats1.lod1Units,
      lod2Armies: stats2.lod2Armies,
      culled: stats0.culledUnits,
      hitUnit,
      boxUnits,
      syncMs: again.syncMs,
    };
  } catch (err) {
    return {
      ok: false,
      lod0: 0,
      lod1Units: 0,
      lod2Armies: 0,
      culled: 0,
      hitUnit: null,
      boxUnits: [],
      syncMs: 0,
      atlasBound: 0,
      atlasFrames: 0,
      atlasDropped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** §10 Armies tab + Army Management Window smoke (real ClientSync + components). */
async function runArmiesSmoke(): Promise<ArmiesSmokeResult> {
  try {
    type HostEvents = import("../host/sync").HostEvents;
    type ClientEvents = import("../client/sync").ClientEvents;
    const [
      { DocumentStore },
      { OpLog },
      { UndoStack },
      { createEventBus },
      { HostSync, gmSessionUser },
      { ClientSync },
      { createTransportPair, flushMicrotasks },
      { mount, unmount },
    ] = await Promise.all([
      import("../core/store"),
      import("../core/oplog"),
      import("../core/undo"),
      import("../core/events"),
      import("../host/sync"),
      import("../client/sync"),
      import("../net/memory"),
      import("svelte"),
    ]);
    const store = new DocumentStore({
      meta: {
        worldId: "w-amw",
        name: "AMW",
        system: "mass-battle-basic",
        systemVersion: "1",
      },
    });
    const host = new HostSync({
      store,
      log: new OpLog(),
      undo: new UndoStack(),
      bus: createEventBus<HostEvents>(),
      systemUserId: "gm",
      roomId: "r",
      verifyHelloSig: async () => true,
    });
    const pair = createTransportPair();
    const clientBus = createEventBus<ClientEvents>();
    const client = new ClientSync({
      transport: pair.a,
      bus: clientBus,
      meta: {
        worldId: "w-amw",
        name: "AMW",
        system: "mass-battle-basic",
        systemVersion: "1",
      },
    });
    host.addSession("g", pair.b, gmSessionUser("gm"));
    await flushMicrotasks();

    type FactionDocument = import("../core/strategic").FactionDocument;
    type UnitDocument = import("../core/strategic").UnitDocument;
    type ArmyDocument = import("../core/strategic").ArmyDocument;
    const unit = (
      id: string,
      type: string,
      range: [number, number] | null,
    ): UnitDocument => ({
      _id: id,
      type,
      name: id,
      ownership: { default: 0 },
      flags: {},
      system: {},
      profile: {},
      formation: "line",
      sceneId: null,
      modelRange: range,
      orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
      stats: { strength: 10, morale: 5, supply: 5, fatigue: 0 },
    });
    const armyDoc = (
      id: string,
      name: string,
      factionId: string,
      units: UnitDocument[],
    ): ArmyDocument => ({
      _id: id,
      type: "army",
      name,
      ownership: { default: 0 },
      flags: {},
      system: {},
      factionId,
      commander: [],
      supply: { level: 4 },
      units,
    });
    const faction = (id: string, color: string): FactionDocument => ({
      _id: id,
      type: "faction",
      name: id.slice(2),
      color,
      allies: [],
      ownership: { default: 0 },
      flags: {},
      system: {},
    });
    const many = Array.from({ length: 120 }, (_, i) =>
      unit(`u-b-${i}`, i % 2 ? "cavalry" : "infantry", null),
    );
    host.commitSystem([
      { kind: "create", coll: "factions", data: faction("f-red", "#c0392b") },
      { kind: "create", coll: "factions", data: faction("f-blue", "#2e6f9e") },
      {
        kind: "create",
        coll: "armies",
        data: armyDoc("army-r", "Red Host", "f-red", [
          unit("u-r-0", "infantry", [0, 6]),
          unit("u-r-1", "cavalry", null),
        ]),
      },
      {
        kind: "create",
        coll: "armies",
        data: armyDoc("army-b", "Blue Host", "f-blue", many),
      },
    ]);
    await flushMicrotasks();
    await flushMicrotasks();

    const { default: ArmiesTab } =
      await import("../ui/armies/ArmiesTab.svelte");
    const { default: ArmyWindow } =
      await import("../ui/armies/ArmyWindow.svelte");
    const { createMassBattleBasic } =
      await import("../packages/massBattleBasic");
    const host0 = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(host0);
    let opened = "";
    const tab = mount(ArmiesTab, {
      target: host0,
      props: { client, bus: clientBus, onOpen: (id: string) => (opened = id) },
    });
    await flushMicrotasks(); // Svelte effects flush on the microtask queue
    const cards = host0.querySelectorAll(".card").length;

    const firstCard = host0.querySelector(".card") as HTMLElement | null;
    if (!firstCard) {
      return {
        ok: false,
        cards,
        treeUnits: 0,
        rosterTotal: 0,
        rosterRendered: 0,
        orderLanded: false,
        orderPending: -1,
        error: JSON.stringify({
          empty: host0.querySelector(".empty") !== null,
          html: host0.innerHTML.slice(0, 300),
        }),
      };
    }
    firstCard.click();
    const win0 = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(win0);
    const win = mount(ArmyWindow, {
      target: win0,
      props: {
        client,
        bus: clientBus,
        armyId: opened,
        rules: createMassBattleBasic(),
        onClose: () => undefined,
      },
    });
    await flushMicrotasks();
    const treeUnits = win0.querySelectorAll("[data-unit]").length;

    // select the first unit, issue the "Advance" template, assert the op lands
    const firstUnitRow = win0.querySelector(
      "[data-unit]",
    ) as HTMLElement | null;
    if (!firstUnitRow) {
      return {
        ok: false,
        cards,
        treeUnits,
        rosterTotal: 0,
        rosterRendered: 0,
        orderLanded: false,
        orderPending: -1,
        error: `no tree unit rows (opened=${opened})`,
      };
    }
    firstUnitRow.click();
    await flushMicrotasks();
    (win0.querySelector('[data-tab="orders"]') as HTMLElement).click();
    await flushMicrotasks();
    const templateBtn = win0.querySelector(
      '[data-template="advance"]',
    ) as HTMLElement | null;
    if (!templateBtn) {
      return {
        ok: false,
        cards,
        treeUnits,
        rosterTotal: 0,
        rosterRendered: 0,
        orderLanded: false,
        orderPending: -1,
        error: "advance template button missing/disabled",
      };
    }
    templateBtn.click();
    await flushMicrotasks();
    await flushMicrotasks();
    const armyAfter = client.store.get("armies", "army-r");
    // the tree click selected the FIRST unit row (echelons sort alphabetically)
    const orderPending = Math.max(
      ...(armyAfter?.units.map((u) => u.orders.pending.length) ?? [-1]),
    );

    // roster virtualization on the 120-unit army
    const win1El = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(win1El);
    const win1 = mount(ArmyWindow, {
      target: win1El,
      props: {
        client,
        bus: clientBus,
        armyId: "army-b",
        rules: createMassBattleBasic(),
        onClose: () => undefined,
      },
    });
    (win1El.querySelector('[data-tab="roster"]') as HTMLElement).click();
    await flushMicrotasks();
    await flushMicrotasks();
    const grid = win1El.querySelector("[data-roster-rows]") as HTMLElement;
    const rosterTotal = Number(grid.dataset.total ?? "-1");
    const rosterRendered = grid.querySelectorAll(".row").length;

    unmount(tab);
    unmount(win);
    unmount(win1);
    host0.remove();
    win0.remove();
    win1El.remove();

    const ok =
      cards === 2 &&
      opened === "army-r" &&
      treeUnits === 2 &&
      orderLandedCheck(orderPending) &&
      rosterTotal === 120 &&
      rosterRendered < 60;
    return {
      ok,
      cards,
      treeUnits,
      rosterTotal,
      rosterRendered,
      orderLanded: orderPending === 1,
      orderPending,
    };
  } catch (err) {
    return {
      ok: false,
      cards: 0,
      treeUnits: 0,
      rosterTotal: 0,
      rosterRendered: 0,
      orderLanded: false,
      orderPending: -1,
      error:
        (err instanceof Error ? err.message : String(err)) +
        " | " +
        String(err instanceof Error ? err.stack : "")
          .split("\n")
          .slice(1, 4)
          .join(" <= "),
    };
  }
}

function orderLandedCheck(pending: number): boolean {
  return pending === 1;
}

/** §9 vision stack smoke: real vision worker + walls/lighting/fog from file://. */
async function runVisionSmoke(): Promise<VisionSmokeResult> {
  try {
    const { createStage } = await import("../canvas/stage");
    const { sightSegments } = await import("../canvas/vision/wallSight");
    const { WorkerVisionComputer } =
      await import("../workers/visionWorkerClient");
    const { pointInPolygon } = await import("../canvas/vision/polygon");
    const VisionWorkerCtor = (
      await import("../workers/vision.worker.ts?worker&inline")
    ).default;
    const { DocumentStore } = await import("../core/store");
    const { OpLog } = await import("../core/oplog");
    const { UndoStack } = await import("../core/undo");
    const { createEventBus } = await import("../core/events");
    type HostEvents = import("../host/sync").HostEvents;
    type ClientEvents = import("../client/sync").ClientEvents;
    const { HostSync, gmSessionUser } = await import("../host/sync");
    const { ClientSync } = await import("../client/sync");
    const { createTransportPair, flushMicrotasks } =
      await import("../net/memory");

    // room with one lit interior; polygon computed by the REAL worker
    type WallDoc = import("../core/documents").WallDocument;
    const wall = (
      id: string,
      c: [number, number, number, number],
      over: Partial<WallDoc> = {},
    ): WallDoc => ({
      _id: id,
      type: "wall" as const,
      name: id,
      ownership: { default: 0 },
      flags: {},
      system: {},
      door: 0,
      oneWay: false,
      move: 0,
      sight: 0,
      sound: 0,
      light: 0,
      c,
      ...over,
    });
    const walls = [
      wall("w1a", [0, 0, 150, 0]),
      wall("w5", [150, 0, 250, 0], { sight: 1, door: 1, move: 1 }), // open doorway (gap)
      wall("w1b", [250, 0, 400, 0]),
      wall("w2", [400, 0, 400, 300]),
      wall("w3", [400, 300, 0, 300]),
      wall("w4", [0, 300, 0, 0]),
    ];
    const segs = sightSegments(walls);
    const flat = new Float32Array(segs.length * 4);
    segs.forEach((sg, i) => {
      flat[i * 4] = sg.x1;
      flat[i * 4 + 1] = sg.y1;
      flat[i * 4 + 2] = sg.x2;
      flat[i * 4 + 3] = sg.y2;
    });
    const computer = new WorkerVisionComputer(
      VisionWorkerCtor as unknown as new () => Worker,
    );
    const poly = await computer.compute(200, 120, flat, 260);
    const seesDoorway = pointInPolygon(poly, 200, -10);
    const shadowBehindWall = !pointInPolygon(poly, 20, -10);
    computer.terminate();

    // layers draw from file://
    const host = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(host);
    const stage = await createStage({
      width: 320,
      height: 240,
      hostElement: host,
    });
    stage.fit(400, 300);
    const cam = stage.camera;
    const wallsLayer = stage.getWallsLayer();
    wallsLayer.sync(walls, cam);
    const lighting = stage.getLightingLayer();
    lighting.sync(
      [
        {
          light: {
            _id: "l1",
            type: "light",
            name: "l1",
            ownership: { default: 0 },
            flags: {},
            system: {},
            x: 200,
            y: 150,
            dim: 100,
            bright: 40,
            color: "#ffcf8a",
            alpha: 0.9,
          },
          poly,
        },
      ],
      { darkness: 0.8, color: "#0a0e1a" },
      cam,
      stage.viewport,
    );
    const fog = stage.getFogLayer({ width: 400, height: 300 });
    fog.reveal(poly);
    fog.reveal(new Float32Array([0, 0, 40, 0, 40, 40, 0, 40]));
    stage.render();
    const png = await fog.readbackPng();
    const layers = stage.root.children.map((c) => c.label);
    stage.destroy();
    host.remove();

    // fog.put round trip over the real sync pair
    const store = new DocumentStore({
      meta: {
        worldId: "w-vision",
        name: "V",
        system: "mass-battle-basic",
        systemVersion: "1",
      },
    });
    const hostSync = new HostSync({
      store,
      log: new OpLog(),
      undo: new UndoStack(),
      bus: createEventBus<HostEvents>(),
      systemUserId: "gm",
      roomId: "r",
      verifyHelloSig: async () => true,
    });
    const pair = createTransportPair();
    const clientBus = createEventBus<ClientEvents>();
    const client = new ClientSync({
      transport: pair.a,
      bus: clientBus,
      meta: {
        worldId: "w-vision",
        name: "V",
        system: "mass-battle-basic",
        systemVersion: "1",
      },
    });
    hostSync.addSession("g", pair.b, gmSessionUser("gm"));
    await flushMicrotasks();
    client.sendFogPng("scene-1", png);
    await flushMicrotasks();
    const fogPutLanded =
      (hostSync.fogPngs.get("scene-1:gm")?.length ?? 0) === png.length;

    const ok =
      poly.length > 16 &&
      seesDoorway &&
      shadowBehindWall &&
      png.length > 100 &&
      layers.includes("walls") &&
      layers.includes("lighting") &&
      layers.includes("fog") &&
      fogPutLanded;
    return {
      ok,
      workerPoly: poly.length / 2,
      wallSegments: segs.length,
      fogReadbackBytes: png.length,
      fogPutLanded,
      ...(ok
        ? {}
        : {
            error: JSON.stringify({
              seesDoorway,
              shadowBehindWall,
              png: png.length,
              layers,
            }),
          }),
    };
  } catch (err) {
    return {
      ok: false,
      workerPoly: 0,
      wallSegments: 0,
      fogReadbackBytes: 0,
      fogPutLanded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** §9 grids/templates/drawings smoke: hex snap + layers draw from file://. */
async function runGridsSmoke(): Promise<GridsSmokeResult> {
  try {
    const { hexCenter, hexFromPixel, snapPoint } =
      await import("../canvas/grid");
    const { pointInTemplate } =
      await import("../canvas/layers/templateGeometry");
    const { createStage } = await import("../canvas/stage");

    const hex = { type: "hex" as const, size: 20, layout: "oddR" as const };
    const center = hexCenter(hex, 3, 2);
    const snapped = snapPoint(hex, center.x + 4, center.y - 3);
    const isCenter =
      Math.abs(snapped.x - center.x) < 1e-6 &&
      Math.abs(snapped.y - center.y) < 1e-6;
    const containing = hexFromPixel(hex, center.x, center.y);

    const host = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(host);
    const stage = await createStage({
      width: 320,
      height: 240,
      hostElement: host,
    });
    stage.setGrid(hex);
    stage.getTemplatesLayer().sync(
      [
        {
          _id: "tpl-1",
          type: "template",
          name: "cone",
          ownership: { default: 0 },
          flags: {},
          system: {},
          kind: "cone",
          x: 100,
          y: 100,
          distance: 60,
          direction: Math.PI / 2,
          width: 60,
        },
      ],
      stage.camera,
    );
    stage.getDrawingsLayer().sync(
      [
        {
          _id: "d-1",
          type: "drawing",
          name: "scribble",
          ownership: { default: 0 },
          flags: {},
          system: {},
          kind: "freehand",
          points: [10, 200, 40, 190, 70, 210, 100, 195],
          box: null,
          stroke: "#53b7ff",
          fill: "",
          strokeWidth: 2,
          text: null,
        },
      ],
      stage.camera,
    );
    await new Promise((r) => setTimeout(r, 60)); // let the grid ticker draw
    stage.render();
    const templateHit = pointInTemplate(
      {
        kind: "cone",
        x: 100,
        y: 100,
        distance: 60,
        direction: Math.PI / 2,
        width: 60,
      },
      100,
      150,
    );
    stage.destroy();
    host.remove();

    const ok =
      isCenter && containing.q === 3 && containing.r === 2 && templateHit;
    return {
      ok,
      snapped,
      isCenter,
      ...(ok
        ? {}
        : {
            error: `containing=${containing.q},${containing.r} templateHit=${templateHit}`,
          }),
    };
  } catch (err) {
    return {
      ok: false,
      snapped: { x: 0, y: 0 },
      isCenter: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Tiny valid WAV (mono 16-bit, ~80 ms) as a data: URI — offline-playable. */
function tinyWavDataUri(): string {
  const rate = 8000;
  const samples = 12_000; // ~1.5 s so the state check lands mid-playback
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++)
      view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(
      44 + i * 2,
      Math.round(1200 * Math.sin((i / rate) * 2 * Math.PI * 440)),
      true,
    );
  }
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i] as number);
  return "data:audio/wav;base64," + globalThis.btoa(binary);
}

/** §10/§7 parity smoke: clock sync, audio loop, journals <secret>, tables → chat. */
async function runParitySmoke(): Promise<ParitySmokeResult> {
  const fail = (error: string): ParitySmokeResult => ({
    ok: false,
    clockOffsetMs: null,
    rttMs: null,
    audioLanded: false,
    scheduledDelayMs: null,
    soundState: null,
    secretVisible: false,
    tablePosted: false,
    error,
  });
  let cleanup: Array<() => void> = [];
  type JournalDocument = import("../core/documents").JournalDocument;
  type RollTableDocument = import("../core/documents").RollTableDocument;
  type PlaylistDocument = import("../core/documents").PlaylistDocument;
  try {
    type HostEvents = import("../host/sync").HostEvents;
    type ClientEvents = import("../client/sync").ClientEvents;
    const [
      { DocumentStore },
      { OpLog },
      { UndoStack },
      { createEventBus },
      { HostSync, gmSessionUser },
      { ClientSync },
      { createTransportPair, flushMicrotasks },
      { mount, unmount },
      { AudioPlayer },
      { JournalsPanel },
      { TablesPanel },
      { PlaylistsPanel },
    ] = await Promise.all([
      import("../core/store"),
      import("../core/oplog"),
      import("../core/undo"),
      import("../core/events"),
      import("../host/sync"),
      import("../client/sync"),
      import("../net/memory"),
      import("svelte"),
      import("../client/audioPlayer"),
      import("../ui/journals"),
      import("../ui/tables"),
      import("../ui/playlists"),
    ]);
    const meta = {
      worldId: "w-parity",
      name: "Parity",
      system: "mass-battle-basic",
      systemVersion: "1",
    };
    const host = new HostSync({
      store: new DocumentStore({ meta }),
      log: new OpLog(),
      undo: new UndoStack(),
      bus: createEventBus<HostEvents>(),
      systemUserId: "gm",
      roomId: "r",
      verifyHelloSig: async () => true,
    });
    const pair = createTransportPair();
    host.addSession("gm", pair.a, gmSessionUser("gm"));
    const bus = createEventBus<ClientEvents>();
    const client = new ClientSync({ transport: pair.b, bus, meta });
    await flushMicrotasks();

    // ── clock sync (three probes → best-RTT estimate)
    client.sendPing();
    client.sendPing();
    client.sendPing();
    await flushMicrotasks();
    const clock = client.clockOffset();
    if (!clock) return fail("no clock estimate after 3 probes");
    if (Math.abs(clock.offsetMs) > 5000)
      return fail(`offset out of range: ${clock.offsetMs}`);

    // ── seed journal (with <secret>), table, playlist via GM ops
    const wav = tinyWavDataUri();
    const journalId = globalThis.crypto.randomUUID();
    const journalDoc: JournalDocument = {
      _id: journalId,
      type: "journal",
      name: "Quest",
      ownership: { default: 1 },
      flags: {},
      system: {},
      pages: [
        {
          _id: "p1",
          type: "page",
          name: "Page 1",
          ownership: { default: 1 },
          flags: {},
          system: {},
          text: "# Dawn\n\nThe **tower** looms.\n\n<secret>The baron is a vampire.</secret>",
          src: null,
        },
      ],
    };
    const tableDoc: RollTableDocument = {
      _id: "tbl1",
      type: "rollTable",
      name: "Omens",
      ownership: { default: 1 },
      flags: {},
      system: {},
      formula: "1d2",
      results: [
        { range: [1, 1], text: "a red moon", documentRef: null },
        { range: [2, 2], text: "a black crow", documentRef: null },
      ],
    };
    const playlistDoc: PlaylistDocument = {
      _id: "pl1",
      type: "playlist",
      name: "Ambient",
      ownership: { default: 1 },
      flags: {},
      system: {},
      mode: "off",
      sounds: [
        {
          _id: "snd1",
          type: "playlistSound",
          name: "hum",
          ownership: { default: 1 },
          flags: {},
          system: {},
          audio: wav,
          volume: 0.8,
          loop: false,
        },
      ],
    };
    client.submit([
      { kind: "create", coll: "journals", data: journalDoc },
      { kind: "create", coll: "rollTables", data: tableDoc },
      { kind: "create", coll: "playlists", data: playlistDoc },
    ]);
    await flushMicrotasks();

    // ── panels on real DOM
    const hostEl = globalThis.document.createElement("div");
    globalThis.document.body.appendChild(hostEl);
    cleanup.push(() => hostEl.remove());
    const journalsMount = mount(JournalsPanel, {
      target: hostEl,
      props: { client, bus },
    });
    cleanup.push(() => unmount(journalsMount));
    const tablesMount = mount(TablesPanel, {
      target: hostEl,
      props: { client, bus },
    });
    cleanup.push(() => unmount(tablesMount));
    const player = new AudioPlayer({ client, bus });
    const plMount = mount(PlaylistsPanel, {
      target: hostEl,
      props: { client, bus, player },
    });
    cleanup.push(() => {
      unmount(plMount);
      player.dispose();
    });
    await flushMicrotasks();

    // GM sees the secret block (projection strips it for players — core-tested)
    const secretVisible = hostEl.querySelector("[data-secret]") !== null;
    const heading = hostEl.querySelector(".page h1")?.textContent ?? "";

    // table draw lands in the messages store
    const drawBtn = hostEl.querySelector(
      "#table-draw",
    ) as HTMLButtonElement | null;
    if (!drawBtn) return fail("no #table-draw button");
    drawBtn.click();
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 30));
    const messages = client.store.getAll("messages");
    const tablePosted = messages.some((m) => m.name === "table-draw");

    // ── audio loop: play cmd → host stamps → rebroadcast → player schedules
    let audioLanded = false;
    const offAudio = bus.on("audio", () => (audioLanded = true));
    client.sendAudioCmd({
      playlistId: "pl1",
      soundId: "snd1",
      action: "play",
      offset: 0,
    });
    await flushMicrotasks();
    offAudio();
    await new Promise((r) => setTimeout(r, 400)); // lead 120 ms + decode
    const soundState = player.state("snd1");
    const scheduledDelayMs = player.lastDelays.get("snd1") ?? null;
    for (const fn of cleanup) fn();
    cleanup = [];

    const ok =
      audioLanded &&
      secretVisible &&
      heading === "Dawn" &&
      tablePosted &&
      scheduledDelayMs !== null &&
      scheduledDelayMs >= 0 &&
      (soundState === "playing" || soundState === "suspended");
    return {
      ok,
      clockOffsetMs: clock.offsetMs,
      rttMs: clock.rttMs,
      audioLanded,
      scheduledDelayMs,
      soundState,
      secretVisible,
      tablePosted,
      ...(ok
        ? {}
        : {
            error: `audio=${audioLanded} secret=${secretVisible} h=${heading} table=${tablePosted} delay=${scheduledDelayMs} state=${soundState}`,
          }),
    };
  } catch (err) {
    for (const fn of cleanup) fn();
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * §12 RulesModule-in-worker smoke: import a package from a blob URL inside
 * the REAL sandboxed sim worker (dynamically imported ?worker&inline build),
 * reject bad syntax/shape, resolve a turn with the custom module, probe the
 * sandbox globals and the CPU-limit termination on a hostile package.
 */
async function runRulesPackageSmoke(): Promise<RulesPackageSmokeResult> {
  const fail = (error: string): RulesPackageSmokeResult => ({
    ok: false,
    supported: false,
    unsupportedReason: error,
    version: "",
    urlScheme: "",
    subPhases: [],
    orderTypes: [],
    rulesVersion: "",
    eventTypes: [],
    sandbox: [],
    builtinRulesVersion: "",
    syntaxError: "",
    badShapeError: "",
    cpuAbuseError: "",
    error,
  });
  const GOOD_SOURCE =
    "export default { schema: { version: '1.0.0-smoke', modelColumns: { morale: 'u8' }, unitTypes: {}, orderTypes: ['probe'], subPhases: ['probe'] }, validateOrder() { return { ok: true }; }, resolveTurn(ctx, pool, units, orders, rng, emit) { emit({ subPhase: 'probe', type: 'probe', unitId: 'u-probe', text: 'package ran inside the sim worker', data: { sandbox: [typeof fetch, typeof importScripts, typeof XMLHttpRequest, typeof WebSocket, typeof indexedDB] } }); }, detection() { return 5; } };";
  try {
    const { WorkerSimRunner } = await import("../workers/simWorkerClient");
    const SimWorkerCtor = (
      await import("../workers/sim.worker.ts?worker&inline")
    ).default;
    const runner = new WorkerSimRunner(SimWorkerCtor);

    const msg = (e: unknown): string =>
      e instanceof Error ? e.message : String(e);
    let syntaxError = "";
    try {
      await runner.loadRules("export default {{{{", 4_000);
      syntaxError = "unexpectedly loaded";
    } catch (e) {
      syntaxError = msg(e);
    }
    let badShapeError = "";
    try {
      await runner.loadRules(
        "export default { schema: { version: '9', modelColumns: {}, unitTypes: {}, orderTypes: [], subPhases: [] }, validateOrder(){}, detection(){} };",
        4_000,
      );
      badShapeError = "unexpectedly loaded";
    } catch (e) {
      badShapeError = msg(e);
    }

    const ctx = {
      sceneId: "s-rules",
      grid: {
        type: "gridless",
        size: 5,
        distance: 5,
        units: "m",
        diagonals: "ignore",
      },
      walls: {
        x1: new Float32Array(0),
        y1: new Float32Array(0),
        x2: new Float32Array(0),
        y2: new Float32Array(0),
        restriction: new Uint8Array(0),
      },
      factions: [],
      armies: [],
      leaderActors: {},
      // Deliberately empty: this is a synthetic context for a sandbox probe inside the sim worker,
      // which has no store. World settings reach the engine through host/turnChannel's rulesCtx().
      worldSettings: {},
    } as import("../core/rules").RulesContext;

    // package flow — engines without worker module import AND without eval
    // (WebKit CSP) degrade cleanly: record why and keep the worker usable
    let supported = true;
    let unsupportedReason = "";
    let info: import("../sim/rulesLoader").RulesPackageInfo | null = null;
    let result: import("../sim/runner").SimResolveResult | null = null;
    try {
      info = await runner.loadRules(GOOD_SOURCE, 4_000);
      await runner.load({
        sceneId: "s-rules",
        sys: { morale: "u8" },
        ctx,
        units: [],
        rulesSource: GOOD_SOURCE,
      });
      result = await runner.resolve({ orders: [], seed: 7, turnNumber: 1 });
    } catch (e) {
      supported = false;
      unsupportedReason = msg(e);
    }

    // hostile top-level code: host-side CPU limit terminates the worker
    let cpuAbuseError = "";
    try {
      // hangs at module evaluation on the loader paths that execute packages
      await runner.loadRules(
        "export default (() => { while (true) {} })();",
        800,
      );
      cpuAbuseError = "unexpectedly loaded";
    } catch (e) {
      cpuAbuseError = msg(e);
    }

    // resilience: the (possibly fresh, post-termination) worker still runs
    // the built-in mass-battle rules
    await runner.load({
      sceneId: "s-builtin",
      sys: { ammo: "u8" },
      ctx,
      units: [],
    });
    const builtin = await runner.resolve({
      orders: [],
      seed: 7,
      turnNumber: 1,
    });
    runner.terminate();

    const first = result?.report.events[0];
    const sandboxRaw = (first?.data?.sandbox ?? []) as unknown;
    return {
      ok: true,
      supported,
      unsupportedReason,
      version: info?.version ?? "",
      urlScheme: info?.urlScheme ?? "",
      subPhases: info?.subPhases ?? [],
      orderTypes: info?.orderTypes ?? [],
      rulesVersion: result?.report.rulesVersion ?? "",
      eventTypes: result?.report.events.map((e) => e.type) ?? [],
      sandbox: Array.isArray(sandboxRaw) ? sandboxRaw.map(String) : [],
      builtinRulesVersion: builtin.report.rulesVersion,
      syntaxError,
      badShapeError,
      cpuAbuseError,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function installE2eHook(app?: HostApp | null): Promise<void> {
  const { runWebrtcLoopback } = await import("../net/webrtc");
  // A late-resolving null-install must never clobber surfaces already
  // attached (JoinApp/GM panels install concurrently).
  const existing = (globalThis as { __vttE2E?: VttE2eSurface }).__vttE2E;
  const surface: VttE2eSurface = {
    webrtcLoopback: () => runWebrtcLoopback(),
    canvasSmoke: () => runCanvasSmoke(),
    modelsSmoke: () => runModelsSmoke(),
    rulesPackageSmoke: () => runRulesPackageSmoke(),
    armiesSmoke: () => runArmiesSmoke(),
    visionSmoke: () => runVisionSmoke(),
    gridsSmoke: () => runGridsSmoke(),
    paritySmoke: () => runParitySmoke(),
    app: app ? appSurface(app) : (existing?.app ?? null),
    player: existing?.player ?? null,
    share: existing?.share ?? null,
  };
  (globalThis as { __vttE2E?: VttE2eSurface }).__vttE2E = surface;
}
