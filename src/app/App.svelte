<script lang="ts">
  import { onMount } from "svelte";
  import { detectCapabilities } from "./capabilities";
  import { DEFAULT_SCENE_ID, makeToken, type HostApp } from "./hostBoot";
  import { createStage, type Stage } from "../canvas/stage";
  import { tokenRect } from "../canvas/tokens";
  import { tokenBadgesMap } from "../packages/pf1e/tokenBadges";
  import {
    pf1eAreaPreviewModel,
    type PF1eAreaPreviewModel,
  } from "../packages/pf1e/areaPreview";
  import type { PF1eAreaKind, PF1eAreaSpec } from "../packages/pf1e/targeting";
  import { sightSegments } from "../canvas/vision";
  import { SvelteMap } from "svelte/reactivity";
  // static import: a dynamic import("pixi.js") would inline a SECOND copy of
  // pixi into the single-file bundle (+290 KB, D-083)
  import { Assets } from "pixi.js";
  import {
    CanvasController,
    domPointerSource,
    type TokenView,
  } from "../canvas/interactions";
  import {
    exportWorldToFolder,
    exportWorldZip,
    importWorldZip,
  } from "../host/worldFile";
  import { ChatPanel } from "../ui/chat";
  import { CombatPanel } from "../ui/combat";
  import {
    applyTokenMenuEntry,
    tokenContextMenuModel,
  } from "../ui/combat/tokenContextMenu";
  import { selectedEncounter } from "../ui/combat/encounters";
  import { JournalsPanel } from "../ui/journals";
  import { WindowHost } from "../ui/windows";
  import { WindowManager } from "../ui/windows";
  import { macroSlots, runChatMacro } from "../ui/macros";
  import { gmState } from "../ui/armies/gmState.svelte";
  import { buildStrategicFog, sceneIsStrategic } from "../core/strategicFog";
  import { ModuleIframe } from "../packages/moduleIframe";
  import { dice3dStats, diceInfoFromRecord, showDice3D } from "../dice/dice3d";
  import { verifyCommitRoll } from "../dice/commitReveal";
  import { PoolInterpolator } from "../sim/interpolate";
  import { TrustedModuleHost } from "../packages/trustedModule";
  import { screenToWorld } from "../canvas/camera";
  import CompendiaPanel from "../ui/compendia/CompendiaPanel.svelte";
  import {
    createModuleHandlers,
    type ModuleHost,
  } from "../packages/moduleHandlers";
  import type { ModuleHookName } from "../core/moduleApi";
  import { getSetting } from "../storage/idb";
  import { createMassBattleBasic } from "../packages/massBattleBasic";
  import type {
    ArmyDocument,
    FactionDocument,
    UnitDocument,
  } from "../core/strategic";
  import { actionForCombo, comboOf, isTypingTarget } from "../core/keys";
  import { globalHooks } from "../core/events";
  import type { GridSpec } from "../canvas/grid";
  import { TablesPanel } from "../ui/tables";
  import { PlaylistsPanel } from "../ui/playlists";
  import { AudioPlayer } from "../client/audioPlayer";
  import { onDestroy } from "svelte";
  import { openPF1eSheetWindow } from "../ui/sheets/pf1eSheetWindow";
  import { SheetPanel } from "../ui/sheets";
  import { startHostShare, type HostShare } from "./hostShare";
  import type {
    ActorDocument,
    CombatDocument,
    SceneDocument,
    SceneGrid,
  } from "../core/documents";
  import type { Op } from "../core/ops";
  import { worldSettingsFrom } from "../core/worldSettings";
  import { installGmFogE2e } from "./e2eHook";

  let {
    app = null,
    bootError = null,
  }: { app?: HostApp | null; bootError?: string | null } = $props();

  const caps = detectCapabilities();
  const rows: Array<[string, boolean]> = Object.entries(caps);
  const ready = rows.filter(([, ok]) => ok).length;

  let canvasHost: HTMLDivElement;
  /** T01 token context menu: opened by a right-CLICK on a token (right-drag pans). */
  let tokenMenu = $state<{ x: number; y: number; tokenId: string } | null>(
    null,
  );
  let worldName = $state("—");
  let seq = $state(0);
  let tokenCount = $state(0);
  let activeTab = $state("chat");
  let player = $state<AudioPlayer | null>(null);
  const wm = new WindowManager({ width: 900, height: 700 });
  (globalThis as unknown as { __wm?: WindowManager }).__wm = wm;
  /** Bumped on every store ops/snapshot so non-panel reads re-render. */
  let storeVersion = $state(0);
  let wmVersion = $state(0);
  const TABS: Array<{ id: string; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "combat", label: "Combat" },
    { id: "journals", label: "Journals" },
    { id: "tables", label: "Tables" },
    { id: "playlists", label: "Playlists" },
    { id: "actors", label: "Actors" },
    { id: "compendia", label: "Compendia" },
  ];
  let canvasError = $state<string | null>(null);
  let loadedMapHash: string | null = null;
  let stage: Stage | null = null;
  let controller: CanvasController | null = null;
  let tokenSelection = $state.raw<{
    sceneId: string | null;
    ids: readonly string[];
  }>({
    sceneId: null,
    ids: [],
  });
  function clearTokenSelection(): void {
    controller?.clearSelection();
    tokenSelection = { sceneId: activeScene()?._id ?? null, ids: [] };
  }
  // P5/C01 (D-154): the PF1e area preview is local caster UI state — it is
  // computed from the replica on demand and never replicated.
  let pf1ePreview: PF1eAreaPreviewModel | null = null;
  let pf1ePreviewSceneId: string | null = null;
  /** §9 tile textures by asset hash/URL (session cache; blob URLs stay alive).
   * SvelteMap satisfies the reactive-state lint rule; used as a plain cache. */
  let tileTextureCache: SvelteMap<string, Promise<unknown>> | null = null;
  let share = $state<HostShare | null>(null);
  let shareError = $state<string | null>(null);
  let peerCode = $state("");
  let hostAnswer = $state("");
  let shareTimer: ReturnType<typeof setInterval> | null = null;
  let fogTimer: ReturnType<typeof setInterval> | null = null;
  let lastTurnPhase = "idle";
  let lastRulesVersion = "";
  let lastByType: Record<string, number> = {};
  let notifyLog = $state<{ message: string; level: string }[]>([]);
  let importedTokens = $state<{ name: string; actorId: string; img: string }[]>(
    [],
  );
  let dice3dHost: HTMLElement | null = null;
  let last3dRollId: string | null = null;
  /** §5A realtime: client-side position interpolation over the replica. */
  const rtInterp = new PoolInterpolator();
  let rtSampleTimer: ReturnType<typeof setInterval> | null = null;
  let offSimBus: (() => void) | null = null;
  let moduleHost: ModuleHost | null = null;

  /** The active encounter of the active scene (null before any is activated). */
  function activeCombat(): CombatDocument | null {
    if (!app) return null;
    const scenes = app.gm.client.store.getAll(
      "scenes",
    ) as readonly SceneDocument[];
    const scene = scenes.find((sc) => sc.active) ?? scenes[0] ?? null;
    if (!scene) return null;
    const combats = app.gm.client.store.getAll(
      "combats",
    ) as readonly CombatDocument[];
    return selectedEncounter(combats, scene, scenes[0]?._id ?? "");
  }

  function closeTokenMenu(): void {
    tokenMenu = null;
  }

  /** Apply one T01/E02 menu entry: roster transitions go through the combat update
   *  path, token visibility through its own op, and "apply-effect" opens the
   *  actor's sheet on the Effects tab; the canvas menu closes either way. */
  function runTokenMenuEntry(
    entryId:
      "add-combatant" | "remove-combatant" | "toggle-hidden" | "apply-effect",
  ): void {
    if (!tokenMenu || !app) return;
    const scene = activeScene();
    if (!scene) {
      closeTokenMenu();
      return;
    }
    const token = scene.tokens.find((tk) => tk._id === tokenMenu?.tokenId);
    if (!token) {
      closeTokenMenu();
      return;
    }
    const result = applyTokenMenuEntry({
      combat: activeCombat(),
      scene,
      token,
      user: app.gm.client.user,
      actors: app.gm.client.store.getAll("actors") as readonly ActorDocument[],
      entryId,
      nextId: () => globalThis.crypto.randomUUID(),
    });
    if (result.error) {
      notifyLog = [
        ...notifyLog.slice(-49),
        { message: result.error, level: "error" },
      ];
      closeTokenMenu();
      return;
    }
    if (result.ops.length) {
      app.gm.client.submit(result.ops);
    }
    if (result.transition) {
      const combat = result.transition.combat;
      for (const hook of result.transition.hooks)
        globalHooks.callAll(hook, combat);
      app.gm.client.submit([
        {
          kind: "update",
          ref: { coll: "combats", id: combat._id },
          diff: {
            round: combat.round,
            turn: combat.turn,
            combatants: combat.combatants,
          },
        },
      ]);
    }
    closeTokenMenu();
    if (result.openEffectEditorActorId !== null)
      openActorSheet(result.openEffectEditorActorId, "effects");
  }

  function activeScene(): SceneDocument | null {
    if (!app) return null;
    const scenes = app.gm.client.store.getAll(
      "scenes",
    ) as readonly SceneDocument[];
    return (
      scenes.find((sc) => sc.active) ??
      app.gm.client.store.get("scenes", DEFAULT_SCENE_ID) ??
      null
    );
  }

  function openWindow(
    id: string,
    title: string,
    kind: string,
    data?: Record<string, string>,
  ): void {
    const hostEl = canvasHost?.getBoundingClientRect();
    if (hostEl) wm.setBounds({ width: hostEl.width, height: hostEl.height });
    wm.open({
      id,
      title,
      kind,
      x: 40 + (wm.list().length % 5) * 24,
      y: 40 + (wm.list().length % 5) * 24,
      width: 380,
      height: 420,
      ...(data ? { data } : {}),
    });
  }

  function openActorSheet(actorId: string, tab?: string): void {
    if (!app) return;
    const rect = canvasHost?.getBoundingClientRect();
    openPF1eSheetWindow(
      wm,
      app.gm.client,
      actorId,
      rect ? { width: rect.width, height: rect.height } : undefined,
      tab,
    );
  }

  function undo(): void {
    if (app) app.host.undo();
  }

  function redo(): void {
    if (app) app.host.redo();
  }

  const hotbarSlots = $derived.by(() => {
    void storeVersion;
    return macroSlots(
      (app?.gm.client.store.getAll("macros") ?? []) as Parameters<
        typeof macroSlots
      >[0],
    );
  });
  // NOTE: spread-copy — store.getAll returns a LIVE array and a keyed {#each}
  // bails on identical references (the new scene button never appeared).
  const scenes = $derived.by(() => {
    void storeVersion;
    return [
      ...((app?.gm.client.store.getAll("scenes") ??
        []) as readonly SceneDocument[]),
    ];
  });
  const playerUsers = $derived.by(() => {
    void storeVersion;
    return [
      ...((app?.gm.client.store.getAll("users") ?? []) as ReadonlyArray<{
        _id: string;
        name: string;
        role: string;
      }>),
    ];
  });
  const wmWindows = $derived.by(() => {
    void wmVersion;
    return [...wm.list()];
  });

  function runSlot(i: number): void {
    const macro = hotbarSlots[i];
    if (macro && app) runChatMacro(app.gm.client, macro);
  }

  function activateScene(id: string): void {
    if (!app) return;
    const scenes = app.gm.client.store.getAll(
      "scenes",
    ) as readonly SceneDocument[];
    const ops = scenes
      .filter((sc) => sc.active !== (sc._id === id))
      .map((sc) => ({
        kind: "update" as const,
        ref: { coll: "scenes" as const, id: sc._id },
        diff: { active: sc._id === id },
      }));
    if (ops.length > 0) app.gm.client.submit(ops);
  }

  function addScene(): void {
    if (!app) return;
    const scene = activeScene();
    const id = `scene-${globalThis.crypto.randomUUID().slice(0, 6)}`;
    app.gm.client.submit([
      {
        kind: "create",
        coll: "scenes",
        data: {
          _id: id,
          type: "scene",
          name: `Scene ${(app.gm.client.store.getAll("scenes") as readonly SceneDocument[]).length + 1}`,
          ownership: { default: 1 },
          flags: {},
          system: {},
          active: false,
          img: null,
          width: scene?.width ?? 2000,
          height: 1500,
          darkness: 0,
          grid: scene?.grid ?? {
            type: "square",
            size: 100,
            distance: 5,
            units: "ft",
            diagonals: "555",
            hexLayout: "oddR",
          },
          tokens: [],
          walls: [],
          lights: [],
          drawings: [],
          templates: [],
          notes: [],
          tiles: [],
          sounds: [],
        },
      },
    ]);
  }

  function tokenViews(): TokenView[] {
    const scene = activeScene();
    if (!scene) return [];
    return scene.tokens.map((token) => ({ token, sceneId: scene._id }));
  }

  /** §9 full grid spec for the stage + snapping (square/hex/gridless). */
  function sceneGridSpec(grid: SceneGrid | undefined): GridSpec | null {
    if (!grid || grid.size <= 0) return null;
    if (grid.type === "square") return { type: "square", size: grid.size };
    if (grid.type === "hex")
      return { type: "hex", size: grid.size, layout: grid.hexLayout };
    return { type: "gridless" };
  }

  const massBattle = createMassBattleBasic();

  /** §9: resolve a tile image (asset hash or URL) to a pixi texture. */
  function tileTexture(img: string): Promise<unknown> {
    tileTextureCache ??= new SvelteMap<string, Promise<unknown>>();
    let cached = tileTextureCache.get(img);
    if (!cached) {
      cached = (async () => {
        if (/^(https?:|data:|blob:)/.test(img)) {
          return Assets.load(img).catch(() => null);
        }
        const owner = app;
        if (!owner) return null;
        const bytes = await owner.gm.fetcher
          .request(img, "scene")
          .catch(() => null);
        if (!bytes) return null;
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        return Assets.load(url).catch(() => null);
      })();
      tileTextureCache.set(img, cached);
    }
    return cached;
  }

  /** §9A: strategic fog from the local replica (god view = no cover). */
  function syncStrategicFog(): void {
    if (!app || !stage) return;
    const scene = activeScene();
    if (
      !scene ||
      !sceneIsStrategic(scene) ||
      gmState.godView ||
      !gmState.viewAsFaction
    ) {
      stage.getStrategicFogLayer().sync([], stage.camera);
      return;
    }
    const client = app.gm.client;
    const pool = client.simReplica;
    if (!pool || pool.count === 0) {
      stage.getStrategicFogLayer().sync([], stage.camera);
      return;
    }
    const armies = client.store.getAll("armies") as readonly ArmyDocument[];
    const factions = client.store.getAll(
      "factions",
    ) as readonly FactionDocument[];
    const { grid, allyFactionIds } = buildStrategicFog({
      pool,
      armies,
      factions,
      factionId: gmState.viewAsFaction,
      radiusOf: (unit: UnitDocument) =>
        massBattle.detection(
          {
            worldSettings: worldSettingsFrom(client.store.getAll("settings")),
          } as Parameters<typeof massBattle.detection>[0],
          {
            id: unit._id,
            armyId: "",
            factionId: "",
            type: unit.type,
            name: unit.name,
            profile: unit.profile,
            stats: { ...unit.stats },
            orders: unit.orders,
            formation: unit.formation,
            sceneId: unit.sceneId,
            modelRange: unit.modelRange,
            leaderTokenId: unit.leaderTokenId ?? null,
          },
        ),
    });
    const cam = stage.camera;
    const w = canvasHost?.clientWidth ?? 800;
    const h = canvasHost?.clientHeight ?? 600;
    const rects = grid.undetectedRectsInView(
      { x: cam.x, y: cam.y, width: w / cam.scale, height: h / cam.scale },
      gmState.viewAsFaction,
      allyFactionIds.slice(1),
    );
    stage.getStrategicFogLayer().sync(rects, cam);
  }

  /** P5/C01 (D-154): draw the PF1e area preview from its local model. */
  function syncPF1eAreaPreview(): void {
    if (!stage) return;
    const layer = stage.getAreaPreviewLayer();
    if (pf1ePreview && pf1ePreview.ok) {
      layer.sync(pf1ePreview.rects, pf1ePreview.highlightRects, stage.camera);
    } else {
      layer.sync([], [], stage.camera);
    }
  }

  /**
   * P5/C01 (D-154): resolve an area spec against the active scene (grid,
   * tokens, wall LoE) and show the overlay. Returns the resolved model so
   * callers can surface the named issues. The casting flow (C02 UI) is the
   * in-product consumer; every refusal is an issue, never a guess.
   */
  function showPF1eAreaPreview(spec: PF1eAreaSpec): PF1eAreaPreviewModel {
    const scene = activeScene();
    if (!scene) {
      pf1ePreview = null;
      pf1ePreviewSceneId = null;
      syncPF1eAreaPreview();
      return {
        ok: false,
        issues: [{ field: "scene", message: "no active scene" }],
        cells: 0,
        rects: [],
        affectedTokenIds: [],
        highlightRects: [],
        label: "",
      };
    }
    pf1ePreview = pf1eAreaPreviewModel(
      {
        grid: scene.grid,
        tokens: scene.tokens,
        segments: sightSegments(scene.walls),
      },
      spec,
    );
    pf1ePreviewSceneId = scene._id;
    syncPF1eAreaPreview();
    return pf1ePreview;
  }

  function clearPF1eAreaPreview(): void {
    pf1ePreview = null;
    pf1ePreviewSceneId = null;
    syncPF1eAreaPreview();
  }

  /** Re-render tokens + background from the GM client replica (never host internals). */
  function refresh(): void {
    storeVersion++;
    const current = app;
    const view = stage;
    if (!current || !view) return;
    const scene = activeScene();
    if (tokenSelection.sceneId !== (scene?._id ?? null)) clearTokenSelection();
    // A preview belongs to the scene it was resolved against; switching scenes
    // clears it rather than repainting stale cells.
    if (pf1ePreviewSceneId !== null && pf1ePreviewSceneId !== (scene?._id ?? null))
      clearPF1eAreaPreview();
    syncPF1eAreaPreview();
    worldName = current.meta.name;
    seq = current.gm.client.store.seq;
    tokenCount = scene?.tokens.length ?? 0;
    const tokens = scene?.tokens ?? [];
    // E06 (D-147): condition/effect chips derive on read from the client replica, so apply,
    // suppress and expiry all re-render the badges with no invalidation step.
    view.syncTokens(
      tokens,
      tokenBadgesMap(tokens, {
        actors: current.gm.client.store.getAll("actors") as ActorDocument[],
        combats: current.gm.client.store.getAll("combats") as CombatDocument[],
      }),
    );
    // §9 tiles: roofs fade over tokens with vision (D-083)
    const occupied = (scene?.tokens ?? [])
      .filter((t) => t.vision)
      .map((t) => tokenRect(t));
    view
      .getTilesLayer({ loadTexture: tileTexture })
      .sync(scene?.tiles ?? [], occupied);
    const img = scene?.img ?? null;
    if (img !== null && img !== loadedMapHash) {
      loadedMapHash = img;
      const manifest = current.gm.client.store.world.assetManifest[img];
      const mime = manifest?.mime ?? "image/png";
      // §7 thumbnail-first: paint the 256px preview, upgrade to full async
      const thumb = manifest?.thumb;
      if (thumb && thumb.hash !== img) {
        void current.gm.fetcher
          .request(thumb.hash, "ui")
          .then((bytes) => view.setBackgroundImage(bytes, thumb.mime))
          .catch(() => undefined);
      }
      void current.gm.fetcher
        .request(img, "scene")
        .then((bytes) => view.setBackgroundImage(bytes, mime))
        .catch(() => undefined);
    }
    view.setGrid(sceneGridSpec(scene?.grid));
  }

  async function beginShare(): Promise<void> {
    if (share || !app) return;
    try {
      share = await startHostShare(app);
      if (new URLSearchParams(globalThis.location.search).has("e2e")) {
        void import("./e2eHook").then((m) =>
          m.installShareE2e(share as HostShare),
        );
      }
      shareTimer = setInterval(() => {
        const code = share?.adapter.lastSentCode;
        if (code) hostAnswer = code;
      }, 250);
    } catch (err) {
      shareError = err instanceof Error ? err.message : String(err);
    }
  }

  function applyPeerCode(): void {
    const code = peerCode.trim();
    if (code && share) void share.receiveCode(code);
    peerCode = "";
  }

  async function exportWorld(): Promise<void> {
    if (!app) return;
    try {
      const blob = await exportWorldZip({
        db: app.db,
        worldId: app.worldId,
        root: app.root,
        persister: app.persister,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `world-${app.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      canvasError = `export failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function exportToFolder(): Promise<void> {
    if (!app || typeof window.showDirectoryPicker !== "function") return;
    try {
      const handle = await window.showDirectoryPicker();
      const res = await exportWorldToFolder(
        {
          db: app.db,
          worldId: app.worldId,
          root: app.root,
          persister: app.persister,
        },
        handle as unknown as import("../storage/opfs").DirHandleLike,
      );
      canvasError = null;
      console.info(`vtt: exported ${res.filesCount} files to folder`);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      canvasError = `folder export failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function importWorld(ev: Event): Promise<void> {
    if (!app) return;
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { db, root } = app;
      app.close(); // stop live writes; import replaces the world rows
      const imported = await importWorldZip({ db, root, file });
      console.info(
        `vtt: imported world ${imported.name} at seq ${imported.seq}`,
      );
      globalThis.location.reload(); // reboot into the restored world
    } catch (err) {
      canvasError = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function importMap(ev: Event): Promise<void> {
    const current = app;
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!current || !file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { hash, entry } = await current.pipeline.importImage(
      bytes,
      file.name,
      file.type || "image/png",
    );
    current.gm.client.submit([
      {
        kind: "update",
        ref: { coll: "scenes", id: DEFAULT_SCENE_ID },
        diff: {
          img: hash,
          ...(entry.width !== undefined ? { width: entry.width } : {}),
          ...(entry.height !== undefined ? { height: entry.height } : {}),
        },
      },
    ]);
    input.value = "";
  }

  /** §12 compendium drag-import: drop an entry on the canvas → import the
   * document; actor packs additionally place a linked token at the drop. */
  async function onCompendiumDrop(ev: DragEvent): Promise<void> {
    const raw = ev.dataTransfer?.getData("application/x-vtt-compendium");
    if (!raw || !app) return;
    ev.preventDefault();
    let payload: { packName?: unknown; entryId?: unknown };
    try {
      payload = JSON.parse(raw) as { packName?: unknown; entryId?: unknown };
    } catch {
      return;
    }
    const list = await app.packages.compendia();
    const found = list.find((r) => r.pack.name === payload.packName);
    const entry = found?.pack.entries.find((e) => e.id === payload.entryId);
    if (!found || !entry) return;

    const scene = activeScene();
    const docId = `${found.pack.type.slice(0, -1)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const ops: Op[] = [
      {
        kind: "create",
        coll: found.pack.type,
        data: { ...entry.data, _id: docId },
      },
    ];
    if (found.pack.type === "actors" && scene) {
      const canvas = stage?.app.canvas;
      let x = scene.width / 2;
      let y = scene.height / 2;
      if (canvas && ev.clientX !== 0) {
        const rect = canvas.getBoundingClientRect();
        const world = screenToWorld(
          stage.camera,
          ev.clientX - rect.left,
          ev.clientY - rect.top,
        );
        x = Math.round(world.x);
        y = Math.round(world.y);
      }
      const token = makeToken(
        `t-${globalThis.crypto.randomUUID().slice(0, 8)}`,
        x,
        y,
        entry.name,
      );
      token.img = entry.img ?? "";
      token.actorId = docId;
      ops.push({
        kind: "create",
        coll: "tokens",
        parent: { coll: "scenes", id: scene._id },
        data: token,
      });
      importedTokens = [
        ...importedTokens.slice(-19),
        { name: entry.name, actorId: docId, img: token.img },
      ];
    }
    app.gm.client.submit(ops);
  }

  function addToken(): void {
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return;
    const id = `t-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    current.gm.client.submit([
      {
        kind: "create",
        coll: "tokens",
        parent: { coll: "scenes", id: scene._id },
        data: makeToken(
          id,
          scene.width / 2,
          scene.height / 2,
          `Token ${scene.tokens.length + 1}`,
        ),
      },
    ]);
  }

  onMount(() => {
    const current = app;
    if (!current) return;
    // §7: GM audio player + periodic clock probes (NTP-style offset via pong)
    const audioPlayer = new AudioPlayer({
      client: current.gm.client,
      bus: current.gm.bus,
      fetchAsset: (hash) => current.gm.fetcher.request(hash, "audio"),
    });
    player = audioPlayer;
    current.gm.client.sendPing();
    const clockTimer = globalThis.setInterval(
      () => current.gm.client.sendPing(),
      30_000,
    );
    const offWm = wm.onChange(() => wmVersion++);
    const offRejected = current.gm.bus.on("rejected", (r) => {
      globalThis.localStorage.setItem(
        "vtt-e2e-last-rejected",
        `${r.reason}: ${r.detail}`,
      );
    });
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "Escape") {
        controller?.clearRuler(); // §9 ruler dismiss
        closeTokenMenu(); // T01 menu dismiss
      }
      const action = actionForCombo(comboOf(e));
      if (action?.startsWith("hotbar.")) {
        e.preventDefault();
        runSlot(Number(action.slice(7)) - 1);
      } else if (action === "edit.undo") {
        e.preventDefault();
        undo();
      } else if (action === "edit.redo") {
        e.preventDefault();
        redo();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    onDestroy(() => {
      moduleHost?.dispose();
      if (rtSampleTimer !== null) globalThis.clearInterval(rtSampleTimer);
      offSimBus?.();
      if (fogTimer !== null) globalThis.clearInterval(fogTimer);
      globalThis.clearInterval(clockTimer);
      audioPlayer.dispose();
      offRejected();
      offWm();
      globalThis.removeEventListener("keydown", onKey);
    });
    void (async () => {
      try {
        const scene = activeScene();
        const width = Math.max(320, canvasHost.clientWidth);
        const height = Math.max(240, canvasHost.clientHeight);
        const view = await createStage({
          width,
          height,
          hostElement: canvasHost,
        });
        stage = view;
        view.fit(scene?.width ?? 2000, scene?.height ?? 1500);
        controller = new CanvasController({
          onSelectionChange: (ids) => {
            tokenSelection = {
              sceneId: activeScene()?._id ?? null,
              ids: [...ids],
            };
            closeTokenMenu(); // any new gesture supersedes the menu
          },
          onContextMenu: ({ screen, tokenId }) => {
            tokenMenu = { x: screen.x, y: screen.y, tokenId };
          },
          onTokenActivate: ({ token }) => {
            if (token.actorId) openActorSheet(token.actorId);
          },
          stage: view,
          source: domPointerSource(view.app.canvas as HTMLCanvasElement),
          client: {
            submit: (ops: Op[]) => current.gm.client.submit(ops),
          },
          getTokens: tokenViews,
          getGrid: () => sceneGridSpec(activeScene()?.grid),
          canMove: () => true, // GM (players get the ownership gate, §5/§10)
          onPing: (world) => {
            const at = { x: Math.round(world.x), y: Math.round(world.y) };
            view.getEffectsLayer().spawnPing(at);
            current.gm.client.sendEphemeral("ping", { ...at });
          },
          onRulerChange: (points) => {
            const scene = activeScene();
            const grid = sceneGridSpec(scene?.grid);
            const measure = grid
              ? {
                  type: grid.type,
                  size: grid.size,
                  diagonals: scene?.grid.diagonals ?? "555",
                }
              : null;
            const units = scene?.grid.units ?? "ft";
            const own = current.gm.client.user?.id ?? "gm";
            if (points.length === 0) {
              view.getEffectsLayer().clearRuler(own);
            } else {
              view.getEffectsLayer().showRuler(own, points, measure, units);
            }
            current.gm.client.sendEphemeral("ruler", {
              points: points.map((p) => ({ x: p.x, y: p.y })),
              units,
            });
          },
        });
        current.gm.bus.on("snapshot", refresh);
        current.gm.bus.on("ops", (m) => {
          refresh();
          // §11 3D dice: a created chat message with a roll record drives the
          // overlay — the animation settles on the ALREADY determined values
          for (const op of m.envelope.ops) {
            if (op.kind !== "create" || op.coll !== "messages") continue;
            const data = op.data as {
              _id?: string;
              roll?: {
                formula: string;
                total: number;
                terms: unknown[];
              } | null;
            };
            if (!data.roll || !data._id || data._id === last3dRollId) continue;
            last3dRollId = data._id;
            const info = diceInfoFromRecord(data.roll);
            if (info.dice.length > 0 && dice3dHost)
              void showDice3D(dice3dHost, info);
          }
        });
        current.gm.bus.on("ephemeral", (m) => {
          if (m.t === "ping") {
            const x = Number(m.data.x);
            const y = Number(m.data.y);
            if (Number.isFinite(x) && Number.isFinite(y)) {
              view.getEffectsLayer().spawnPing({ x, y });
            }
            return;
          }
          if (m.t === "ruler") {
            const raw = m.data.points;
            const points = Array.isArray(raw)
              ? raw
                  .map((p) => ({
                    x: Number((p as { x?: unknown }).x),
                    y: Number((p as { y?: unknown }).y),
                  }))
                  .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
              : [];
            const scene = activeScene();
            const grid = sceneGridSpec(scene?.grid);
            const measure = grid
              ? {
                  type: grid.type,
                  size: grid.size,
                  diagonals: scene?.grid.diagonals ?? "555",
                }
              : null;
            view
              .getEffectsLayer()
              .showRuler(
                m.from,
                points,
                measure,
                typeof m.data.units === "string" ? m.data.units : "ft",
              );
          }
        });
        current.gm.bus.on("turnPhase", (m) => {
          lastTurnPhase = m.phase;
        });
        current.gm.bus.on("turnReport", (m) => {
          lastRulesVersion = m.report.rulesVersion;
          const dist = m.report.summary.distributions as
            { byType?: Record<string, number> } | undefined;
          lastByType = dist?.byType ?? {};
        });
        // §12 module host: the active system package's module entry runs
        // either in the sandboxed iframe (default) or — when the manifest
        // requests trust AND the GM granted it — in-page (TrustedModuleHost)
        const moduleBoot = current.moduleBoot;
        if (moduleBoot) {
          const handlers = createModuleHandlers({
            worldId: current.worldId,
            worldName: current.meta.name,
            packageId: moduleBoot.packageId,
            db: current.db,
            user: () => ({
              id: current.gm.client.user?.id ?? "gm",
              name: current.gm.client.user?.name ?? "GM",
            }),
            activeScene: () => {
              const scene = activeScene();
              return scene
                ? {
                    id: scene._id,
                    tokens: scene.tokens.map((t) => ({
                      id: t._id,
                      name: t.name,
                      x: t.x,
                      y: t.y,
                    })),
                  }
                : null;
            },
            submit: (ops) => current.gm.client.submit(ops),
            notify: (message, level) => {
              notifyLog = [...notifyLog.slice(-49), { message, level }];
            },
            newId: (prefix) =>
              `${prefix}${globalThis.crypto.randomUUID().slice(0, 8)}`,
          });
          const onSubscribe = (event: ModuleHookName): void => {
            if (event === "ready") moduleHost?.emitHook("ready", {});
          };
          moduleHost =
            moduleBoot.mode === "inPage"
              ? new TrustedModuleHost({
                  packageId: moduleBoot.packageId,
                  source: moduleBoot.source,
                  handlers,
                  onSubscribe,
                })
              : new ModuleIframe({
                  packageId: moduleBoot.packageId,
                  source: moduleBoot.source,
                  handlers,
                  onSubscribe,
                });
          current.gm.bus.on("snapshot", (m) =>
            moduleHost?.emitHook("snapshot", { seq: m.seq }),
          );
          current.gm.bus.on("ops", (m) =>
            moduleHost?.emitHook("snapshot", { seq: m.envelope.seq }),
          );
          current.gm.bus.on("turnPhase", (m) =>
            moduleHost?.emitHook("turnPhase", { phase: m.phase }),
          );
          current.gm.bus.on("turnReport", (m) =>
            moduleHost?.emitHook("turnReport", {
              turn: m.report.turn,
              rulesVersion: m.report.rulesVersion,
            }),
          );
        }
        const offSim = current.gm.bus.on("sim", () => {
          const pool = current.gm.client.simReplica;
          if (pool) rtInterp.push(pool, performance.now());
        });
        offSimBus = offSim;
        rtSampleTimer = globalThis.setInterval(() => {
          rtInterp.sampleXY(performance.now()); // render-side sample cadence
        }, 100);
        fogTimer = globalThis.setInterval(syncStrategicFog, 300);
        installGmFogE2e({
          rectCount: () => view.getStrategicFogLayer().rectCount,
          pf1eAreaPreviewShow: (spec) => {
            const model = showPF1eAreaPreview({
              kind: spec.kind as PF1eAreaKind,
              origin: { col: spec.originCol, row: spec.originRow },
              radiusFt: spec.radiusFt,
            });
            return {
              ok: model.ok,
              issues: model.issues.map((i) => ({ ...i })),
              cells: model.cells,
              affectedTokenIds: [...model.affectedTokenIds],
              label: model.label,
            };
          },
          pf1eAreaPreviewClear: () => clearPF1eAreaPreview(),
          pf1eAreaPreviewState: () => {
            const layer = view.getAreaPreviewLayer();
            return {
              visible: pf1ePreview !== null && pf1ePreview.ok,
              rectsDrawn: layer.rectCount,
              highlights: layer.highlightCount,
            };
          },
          sceneScale: () => {
            const scene = activeScene();
            const flags = scene?.flags as
              { core?: { scale?: unknown } } | undefined;
            return flags?.core?.scale === "strategic"
              ? "strategic"
              : "tactical";
          },
          godView: () => gmState.godView,
          viewAsFaction: () => gmState.viewAsFaction,
          simCount: () => current.gm.client.simReplica?.count ?? null,
          turnPhase: () => lastTurnPhase,
          reportRulesVersion: () => lastRulesVersion,
          reportByType: () => lastByType,
          notifications: () => [...notifyLog],
          moduleSetting: (key: string) =>
            current.moduleBoot
              ? getSetting(
                  current.db,
                  `module:${current.moduleBoot.packageId}`,
                  key,
                ).then((r) => r?.value ?? null)
              : Promise.resolve(null),
          moduleMode: () => current.moduleBoot?.mode ?? "none",
          migrationBoot: () => current.migrationBoot ?? null,
          firstArmyProbe: () => {
            const armies = current.gm.client.store.getAll(
              "armies",
            ) as readonly ArmyDocument[];
            const first = armies[0];
            if (!first) return null;
            return {
              schemaNote:
                (first.system as Record<string, unknown>).schemaNote ?? null,
              drill: first.units[0]?.stats.drill ?? null,
            };
          },
          compendiumStats: () =>
            current.packages.compendia().then((list) => ({
              packs: list.length,
              entries: list.reduce((n, r) => n + r.pack.entries.length, 0),
            })),
          actorCount: () =>
            (current.gm.client.store.getAll("actors") as readonly unknown[])
              .length,
          importedTokens: () => [...importedTokens],
          dice3d: () => ({
            ...dice3dStats,
            lastValues: [...dice3dStats.lastValues],
          }),
          realtimeInfo: () => {
            const interp = rtInterp.stats;
            const pool = current.gm.client.simReplica;
            const sampled = rtInterp.sampleXY(performance.now());
            let probeRaw: [number, number] | null = null;
            let probeSampled: [number, number] | null = null;
            if (pool && pool.count > 0) {
              probeRaw = [pool.x[0] ?? 0, pool.y[0] ?? 0];
              probeSampled = [sampled.x[0] ?? 0, sampled.y[0] ?? 0];
            }
            return {
              ...current.gm.channel.realtimeStats(),
              pushes: interp.pushes,
              interpolatedMoves: interp.interpolatedMoves,
              interpolating: interp.interpolating,
              replicaVersion: current.gm.client.simReplicaVersion,
              models: pool?.count ?? 0,
              probeRaw,
              probeSampled,
            };
          },
          setFirstUnitMoveOrder: (x: number, y: number) => {
            const armies = current.gm.client.store.getAll(
              "armies",
            ) as ReadonlyArray<{
              _id: string;
              units: ReadonlyArray<{ _id: string }>;
            }>;
            for (const army of armies) {
              const unit = army.units[0];
              if (!unit) continue;
              current.gm.client.submit([
                {
                  kind: "update",
                  ref: {
                    coll: "units",
                    id: unit._id,
                    parent: { coll: "armies", id: army._id },
                  },
                  diff: {
                    orders: {
                      pending: [
                        { kind: "move", path: [{ x, y }], pace: "march" },
                      ],
                      issuedBy: "gm",
                      issuedTurn: 0,
                    },
                  },
                },
              ]);
              return { ok: true, unitId: unit._id, error: null };
            }
            return { ok: false, unitId: null, error: "no units" };
          },
          simControl: (
            action:
              | "pause"
              | "resume"
              | "rate"
              | "advance"
              | "next"
              | "undoTurn"
              | "mode"
              | "start",
            extra: {
              rateHz?: number;
              mode?: "stepwise" | "realtime";
              deadlineMs?: number;
            } = {},
          ) => {
            current.gm.client.simControl(action, extra);
          },
          committedRoll: async () => {
            const msgs = current.gm.client.store.getAll(
              "messages",
            ) as ReadonlyArray<{
              roll?: {
                formula: string;
                total: number;
                seedClient: string | null;
                seedHost: string | null;
                commit?: string | null;
              } | null;
            }>;
            let last: (typeof msgs)[number]["roll"] = null;
            for (const m of msgs) if (m.roll) last = m.roll;
            if (!last) return null;
            const res = await verifyCommitRoll(last);
            return {
              formula: last.formula,
              total: last.total,
              seedClient: last.seedClient,
              seedHost: last.seedHost,
              commit: last.commit ?? null,
              verified: res.ok,
              verifyError: res.ok ? null : res.error,
            };
          },
          effectsSummary: () => {
            const layer = view.getEffectsLayer();
            return { pings: layer.pingCount, rulers: layer.rulerCount };
          },
          tileAlphas: () => {
            const tiles = activeScene()?.tiles ?? [];
            const layer = view.getTilesLayer();
            return Object.fromEntries(
              tiles.map((t) => [t._id, layer.alphaOf(t._id)]),
            );
          },
          seedTile: (spec) => {
            const scene = activeScene();
            if (!scene) return "";
            const id = `tile-${globalThis.crypto.randomUUID().slice(0, 8)}`;
            current.gm.client.submit([
              {
                kind: "create",
                coll: "tiles",
                parent: { coll: "scenes", id: scene._id },
                data: {
                  _id: id,
                  type: "tile" as const,
                  name: "Roof",
                  ownership: { default: 0 },
                  flags: {},
                  system: {},
                  x: spec.x,
                  y: spec.y,
                  width: spec.width,
                  height: spec.height,
                  img: "",
                  above: spec.above,
                  occlusion: { mode: spec.mode, alpha: spec.alpha },
                },
              },
            ]);
            return id;
          },
          factionOwnership: () => {
            const factions = current.gm.client.store.getAll(
              "factions",
            ) as readonly FactionDocument[];
            return Object.fromEntries(
              factions.map((f) => [
                f._id,
                { ...f.ownership } as Record<string, number>,
              ]),
            );
          },
          armySnapshot: () => {
            const store = current.gm.client.store;
            const armies = store.getAll("armies") as readonly ArmyDocument[];
            const factions = store.getAll(
              "factions",
            ) as readonly FactionDocument[];
            const units = armies.flatMap((a) => a.units);
            return {
              armies: armies.length,
              factions: factions.length,
              units: units.length,
              pendingOrders: units.reduce(
                (n, u) => n + u.orders.pending.length,
                0,
              ),
              strengths: units.map((u) => u.stats.strength),
              allyLists: Object.fromEntries(
                factions.map((f) => [f._id, [...f.allies]]),
              ),
            };
          },
        });
        refresh();
        view.render();
      } catch (err) {
        canvasError = err instanceof Error ? err.message : String(err);
      }
    })();
    return () => {
      if (shareTimer !== null) clearInterval(shareTimer);
      share?.close();
      controller?.destroy();
      stage?.destroy();
      stage = null;
    };
  });
</script>

<main>
  <h1>VTT</h1>
  <p class="sub">
    browser-only virtual tabletop · bootstrap v{__APP_VERSION__}
  </p>

  {#if bootError}
    <p class="error">boot failed: {bootError}</p>
  {/if}

  <section aria-labelledby="caps-h">
    <h2 id="caps-h">Runtime capabilities ({ready}/{rows.length} available)</h2>
    <ul>
      {#each rows as [name, ok] (name)}
        <li class:ok class:missing={!ok}>
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{name}</span>
          <span class="state">{ok ? "available" : "unavailable"}</span>
        </li>
      {/each}
    </ul>
  </section>

  {#if app}
    {#if canvasError}
      <p class="error">canvas: {canvasError}</p>
    {/if}
    <section class="shell" aria-label="GM shell">
      <aside class="sidebar">
        <div id="status">
          <strong>{worldName}</strong>
          <span>seq {seq}</span>
          <span>tokens {tokenCount}</span>
        </div>
        <label class="btn">
          Import map
          <input
            id="map-input"
            type="file"
            accept="image/*"
            onchange={importMap}
            hidden
          />
        </label>
        <button id="add-token" type="button" onclick={addToken}
          >Add token</button
        >
        <h3>Invite (§6.2)</h3>
        {#if !share}
          <button id="share" type="button" onclick={() => void beginShare()}>
            Share invite
          </button>
        {:else}
          <textarea id="invite-link" rows="3" readonly value={share.inviteLink}
          ></textarea>
          <label for="peer-code">Player's code</label>
          <textarea id="peer-code" rows="4" bind:value={peerCode}></textarea>
          <button id="code-apply" type="button" onclick={applyPeerCode}
            >Apply player code</button
          >
          <label>Your answer code</label>
          <textarea id="share-out" rows="4" readonly value={hostAnswer}
          ></textarea>
        {/if}
        {#if shareError}
          <p class="error">{shareError}</p>
        {/if}
        <div class="gmtools" aria-label="GM tools">
          <button
            id="gm-perms"
            type="button"
            onclick={() =>
              openWindow("permissions", "Permissions", "permissions")}
          >
            Perms
          </button>
          <button
            id="gm-macros"
            type="button"
            onclick={() => openWindow("macros", "Macros", "macros")}
            >Macros</button
          >
          <button
            id="gm-settings"
            type="button"
            onclick={() => openWindow("settings", "Settings", "settings")}
          >
            Settings
          </button>
          <button
            id="gm-extras"
            type="button"
            onclick={() => openWindow("gmextras", "GM Extras", "gmextras")}
          >
            Extras
          </button>
          <button
            id="gm-undo"
            type="button"
            onclick={undo}
            title="Undo (Ctrl+Z)">↩</button
          >
          <button
            id="gm-redo"
            type="button"
            onclick={redo}
            title="Redo (Ctrl+Y)">↪</button
          >
        </div>
        <nav class="tabs" aria-label="Sidebar tabs">
          {#each TABS as t (t.id)}
            <button
              type="button"
              class:active={activeTab === t.id}
              data-tab={t.id}
              onclick={() => (activeTab = t.id)}
            >
              {t.label}
            </button>
          {/each}
        </nav>
        <div class="hotbar" aria-label="Hotbar">
          {#each hotbarSlots as macro, i (i)}
            <button
              type="button"
              class="slot"
              data-slot={i + 1}
              title={macro?.command ?? ""}
              onclick={() => runSlot(i)}
            >
              {macro ? macro.name.slice(0, 6) : i + 1}
            </button>
          {/each}
        </div>
        <div class="tabbody" data-active-tab={activeTab}>
          {#if activeTab === "chat"}
            <ChatPanel client={app.gm.client} bus={app.gm.bus} />
          {:else if activeTab === "combat"}
            <CombatPanel
              client={app.gm.client}
              bus={app.gm.bus}
              selection={tokenSelection}
              onClearSelection={clearTokenSelection}
            />
          {:else if activeTab === "journals"}
            <JournalsPanel
              client={app.gm.client}
              bus={app.gm.bus}
              popout={(journalId, pageId) =>
                openWindow(`journal:${pageId}`, "Journal", "journal", {
                  journalId,
                  pageId,
                })}
            />
          {:else if activeTab === "tables"}
            <TablesPanel client={app.gm.client} bus={app.gm.bus} />
          {:else if activeTab === "playlists"}
            <PlaylistsPanel client={app.gm.client} bus={app.gm.bus} {player} />
          {:else if activeTab === "actors"}
            <SheetPanel
              client={app.gm.client}
              bus={app.gm.bus}
              onOpenActor={openActorSheet}
            />
          {:else if activeTab === "compendia"}
            <CompendiaPanel client={app.gm.client} packages={app.packages} />
          {/if}
        </div>
        <h3>World file (§8)</h3>
        <button id="export-world" type="button" onclick={exportWorld}>
          Export world (.zip)
        </button>
        {#if typeof globalThis.showDirectoryPicker === "function"}
          <button id="export-folder" type="button" onclick={exportToFolder}>
            Save to folder…
          </button>
        {/if}
        <label class="btn">
          Import world (.zip)
          <input
            id="import-world"
            type="file"
            accept=".zip,application/zip"
            onchange={importWorld}
            hidden
          />
        </label>
      </aside>
      <div class="canvas-col">
        <nav class="scenenav" aria-label="Scenes" data-testid="scene-nav">
          {#each scenes as sc (sc._id)}
            <button
              type="button"
              class:active={activeScene()?._id === sc._id}
              data-scene={sc._id}
              onclick={() => activateScene(sc._id)}
            >
              {sc.name}
            </button>
          {/each}
          <button
            id="scene-add"
            type="button"
            onclick={addScene}
            title="New scene">+</button
          >
        </nav>
        <div class="players" aria-label="Players">
          {#each playerUsers as u (u._id)}
            <span class="player" data-player={u._id}
              >{u.name} <small>{u.role}</small></span
            >
          {/each}
        </div>
        <div class="dice3d-host" bind:this={dice3dHost}></div>
        <div
          class="canvas-host"
          bind:this={canvasHost}
          ondragover={(ev) => {
            if (
              ev.dataTransfer?.types.includes("application/x-vtt-compendium")
            ) {
              ev.preventDefault();
            }
          }}
          ondrop={(ev) => void onCompendiumDrop(ev)}
          onpointerdown={() => closeTokenMenu()}
        >
          {#if tokenMenu && activeScene()}
            {@const menuScene = activeScene()}
            {@const menuToken = menuScene?.tokens.find(
              (tk) => tk._id === tokenMenu?.tokenId,
            )}
            {#if menuScene && menuToken}
              {@const model = tokenContextMenuModel({
                combat: activeCombat(),
                scene: menuScene,
                token: menuToken,
                user: app?.gm.client.user ?? null,
                actors: (app?.gm.client.store.getAll("actors") ??
                  []) as readonly ActorDocument[],
              })}
              <div
                class="token-menu"
                data-token-menu={menuToken._id}
                onpointerdown={(ev) => ev.stopPropagation()}
                style={`left: ${Math.round(tokenMenu.x)}px; top: ${Math.round(tokenMenu.y)}px;`}
                role="menu"
                aria-label="{model.title} actions"
              >
                <span class="token-menu-title">{model.title}</span>
                {#each model.entries as entry (entry.id)}
                  {#if entry.id === "initiative"}
                    <span
                      class="token-menu-static"
                      data-token-menu-initiative
                      title={entry.reason ?? ""}>{entry.label}</span
                    >
                  {:else}
                    <button
                      type="button"
                      role="menuitem"
                      data-token-menu-action={entry.id}
                      disabled={entry.disabled}
                      title={entry.reason ?? ""}
                      onclick={() =>
                        runTokenMenuEntry(
                          entry.id as
                            | "add-combatant"
                            | "remove-combatant"
                            | "toggle-hidden"
                            | "apply-effect",
                        )}>{entry.label}</button
                    >
                  {/if}
                {/each}
              </div>
            {/if}
          {/if}
        </div>
        <WindowHost
          manager={wm}
          windows={wmWindows}
          client={app.gm.client}
          bus={app.gm.bus}
          sceneId={activeScene()?._id ?? null}
          onUndo={undo}
          onRedo={redo}
          packages={app.packages}
        />
        <div class="notify-stack" aria-live="polite">
          {#each notifyLog.slice(-4) as n, i (n.message + ":" + String(i))}
            <div class="notify" data-notify data-notify-level={n.level}>
              {n.message}
            </div>
          {/each}
        </div>
      </div>
    </section>
  {/if}
</main>

<style>
  .dice3d-host {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 65;
    overflow: visible;
  }
  .notify-stack {
    position: fixed;
    right: 12px;
    bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 60;
    pointer-events: none;
  }
  .notify {
    background: #1d2330ee;
    border: 1px solid #3a4a66;
    border-left: 3px solid #6ea8fe;
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 12px;
    max-width: 320px;
    box-shadow: 0 2px 8px #0007;
  }
  .notify[data-notify-level="warn"] {
    border-left-color: #f0c04a;
  }
  .notify[data-notify-level="error"] {
    border-left-color: #e05656;
  }
  :global(body) {
    margin: 0;
    background: #101014;
    color: #e8e8ee;
    font-family: system-ui, sans-serif;
  }
  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 12px 16px 24px;
  }
  h1 {
    font-size: 2.2rem;
    margin: 0;
  }
  .sub {
    color: #8a8a97;
    margin: 2px 0 12px;
  }
  .error {
    color: #ff9c9c;
  }
  section[aria-labelledby="caps-h"] {
    margin-bottom: 14px;
  }
  section[aria-labelledby="caps-h"] h2 {
    font-size: 1rem;
    margin: 0 0 6px;
  }
  ul {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0;
    margin: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid #2a2a33;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.8rem;
  }
  li.missing {
    opacity: 0.55;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #555;
  }
  li.ok .dot {
    background: #4cc38a;
  }
  .state {
    color: #8a8a97;
  }
  .shell {
    display: flex;
    gap: 12px;
    border: 1px solid #2a2a33;
    border-radius: 10px;
    overflow: visible; /* windows may hang past the canvas (§10) */
    height: 62vh;
    min-height: 360px;
  }
  .gmtools {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }
  .gmtools button {
    font-size: 11px;
    padding: 3px 6px;
  }
  .hotbar {
    display: flex;
    gap: 3px;
  }
  .hotbar .slot {
    flex: 1;
    min-width: 0;
    font-size: 10px;
    padding: 3px 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .canvas-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .scenenav {
    display: flex;
    gap: 3px;
    padding: 4px;
    border-bottom: 1px solid #2a2a33;
    background: #14161c;
    flex-wrap: wrap;
  }
  .scenenav button {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 3px;
  }
  .scenenav button.active {
    background: #2c4a6e;
  }
  .players {
    display: flex;
    gap: 6px;
    padding: 2px 4px;
    font-size: 10px;
    border-bottom: 1px solid #2a2a33;
    background: #12141a;
  }
  .players small {
    opacity: 0.6;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .tabs button {
    font-size: 11px;
    padding: 3px 7px;
    border-radius: 4px 4px 0 0;
    border: 1px solid #2a323d;
    background: #171b22;
    color: #9fb0c3;
    cursor: pointer;
  }
  .tabs button.active {
    background: #2c4a6e;
    color: #e8f1fb;
  }
  .tabbody {
    border: 1px solid #2a323d;
    border-radius: 0 4px 4px 4px;
    padding: 4px;
    min-height: 100px;
    flex: 0 0 auto; /* never compress: overflow would paint UNDER later siblings */
  }
  .sidebar {
    width: 168px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
    padding: 12px;
    border-right: 1px solid #2a2a33;
    background: #14161c;
  }
  #status {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.85rem;
    color: #b8b8c4;
  }
  .btn,
  button {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid #3a3f4b;
    background: #1d2127;
    color: #e8e8ee;
    font-size: 0.9rem;
    cursor: pointer;
    text-align: center;
  }
  .btn:hover,
  button:hover {
    background: #262b33;
  }
  .token-menu {
    position: absolute;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 180px;
    padding: 4px;
    background: #1c2430;
    border: 1px solid #3c4a5e;
    border-radius: 4px;
    font-size: 12px;
  }
  .token-menu-title {
    font-weight: bold;
    padding: 0 4px;
  }
  .token-menu-static {
    opacity: 0.85;
    padding: 2px 4px;
  }
  .token-menu button {
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    padding: 2px 4px;
    cursor: pointer;
  }
  .token-menu button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .canvas-host {
    flex: 1;
    min-width: 0;
    position: relative;
  }
  .canvas-host :global(canvas) {
    display: block;
  }
</style>
