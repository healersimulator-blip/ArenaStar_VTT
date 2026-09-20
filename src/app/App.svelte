<script lang="ts">
  import { onMount } from "svelte";
  import { detectCapabilities } from "./capabilities";
  import { DEFAULT_SCENE_ID, GM_USER_ID, makeToken, type HostApp } from "./hostBoot";
  import { createStage, type Stage } from "../canvas/stage";
  import { tokenRect } from "../canvas/tokens";
  import type { RollHighlightRect } from "../canvas/layers/RollHighlightLayer";
  import { tokenBadgesMap } from "../packages/pf1e/tokenBadges";
  import { isPF1eActor } from "../ui/sheets/pf1eSheetModel";
  import {
    pf1eAreaPreviewModel,
    type PF1eAreaPreviewModel,
  } from "../packages/pf1e/areaPreview";
  import type { PF1eAreaKind, PF1eAreaSpec } from "../packages/pf1e/targeting";
  import { moveSegments, sightSegments } from "../canvas/vision";
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
  import { FogExploration } from "../client/fogExploration";
  import { createVisionComputer } from "../workers/visionComputer";
  import { ModuleIframe } from "../packages/moduleIframe";
  import { dice3dStats, diceInfoFromRecord, showDice3D } from "../dice/dice3d";
  import { verifyCommitRoll } from "../dice/commitReveal";
  import { PoolInterpolator } from "../sim/interpolate";
  import { TrustedModuleHost } from "../packages/trustedModule";
  import { screenToWorld } from "../canvas/camera";
  import CanvasToolbar, { type CanvasTool } from "../ui/canvas/CanvasToolbar.svelte";
  import { ToolInteractionController } from "../canvas/tools/controller";
  import { drawingForText } from "../canvas/tools/drawing";
  import { buildChatMessage, parseChatCommand } from "../core/chat";
  import CompendiaPanel from "../ui/compendia/CompendiaPanel.svelte";
  import {
    createModuleHandlers,
    type ModuleHost,
  } from "../packages/moduleHandlers";
  import type { ModuleHookName } from "../core/moduleApi";
  import { getFog, getSetting } from "../storage/idb";
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
  import { pf1eMovementOpportunities } from "../packages/pf1e/tacticalOpportunity";
  import { pf1eMovePlan } from "../packages/pf1e/movement";
  import { sceneDifficultCells } from "../core/rules";
  import { pf1eThreatModel } from "../packages/pf1e/threatPreview";
  import { deriveFromDocuments } from "../packages/pf1e/actor";
  import { copyText } from "../ui/clipboard";
  import { autoResolveAoosOf } from "../packages/pf1e/aooSettings";
  import {
    attackOfOpportunityBudget,
    combatantForToken,
  } from "../ui/combat/actionBudget";
  import {
    planHeldMove,
    resolutionLines,
    resolveMovementOpportunities,
  } from "../ui/combat/pf1eAooFlow";
  import {
    decideReactor,
    forgoLines,
    forgoReaction,
    isSettled,
    openReaction,
    opportunityForReactor,
    pendingRows,
    type PendingReaction,
  } from "../ui/combat/pf1eReactionPrompt";

  let {
    app = null,
    bootError = null,
    onExit = null,
  }: {
    app?: HostApp | null;
    bootError?: string | null;
    /**
     * D-249 "Close world": the host (Root) closes the HostApp and returns to the start
     * screen, where worlds are listed, opened, imported, exported and deleted. Null hides
     * the button (embedding without a start screen).
     */
    onExit?: (() => void) | null;
  } = $props();

  const caps = detectCapabilities();
  const rows: Array<[string, boolean]> = Object.entries(caps);
  const ready = rows.filter(([, ok]) => ok).length;

  let canvasHost = $state<HTMLDivElement | null>(null);
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
  let canvasTool = $state<CanvasTool>("select");
  let canvasToolbarCollapsed = $state(false);
  let loadedMapHash: string | null = null;
  let stage: Stage | null = null;
  let controller: CanvasController | null = null;
  let toolController: ToolInteractionController | null = null;
  let measurePreview = $state<{ kind: "line" | "path" | "radius"; points: Array<{ x: number; y: number }>; distance: number; radiusPx?: number } | null>(null);
  const rollFromToolbar = (formula: string) => {
    if (!app) return;
    const built = buildChatMessage({ author: app.gm.client.user._id, parsed: parseChatCommand(`/roll ${formula}`) });
    app.gm.client.submit([{ kind: "create", coll: "messages", data: built.message }]);
  };
  const eraseAllDrawings = () => {
    const scene = activeScene();
    if (!scene || !globalThis.confirm("Erase all drawings in this scene?")) return;
    app?.gm.client.submit(scene.drawings.map((drawing) => ({ kind: "delete" as const, ref: { coll: "drawings" as const, id: drawing._id, parent: { coll: "scenes" as const, id: scene._id } } })));
  };
  const measurePoint = (point: { x: number; y: number }) => {
    const camera = stage?.camera;
    const rect = canvasHost?.getBoundingClientRect();
    return { x: (point.x - (camera?.x ?? 0)) * (camera?.scale ?? 1) + (rect?.width ?? 0) / 2, y: (point.y - (camera?.y ?? 0)) * (camera?.scale ?? 1) + (rect?.height ?? 0) / 2 };
  };
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
  let copyStatus = $state("");
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let shareTimer: ReturnType<typeof setInterval> | null = null;
  let fogTimer: ReturnType<typeof setInterval> | null = null;
  /** D-250: §9 explored fog loop (restore → reveal → persist) for the GM's own map. */
  let fog: FogExploration | null = null;
  let lastTurnPhase = "idle";
  let lastRulesVersion = "";
  let lastByType: Record<string, number> = {};
  let notifyLog = $state<{ message: string; level: string }[]>([]);
  /**
   * D-187: the held move whose attacks of opportunity are the table's to take. While this
   * is set the token has *not* moved (the controller restored the render on `"cancel"`),
   * and `pendingCommit` is the deferred Op that will move it once the prompt settles.
   * Kept outside `$state` on purpose: a function is not a thing to make reactive, and it
   * must never be a stale render's value.
   */
  let pendingReaction = $state<PendingReaction | null>(null);
  let pendingCommit: (() => void) | null = null;
  /**
   * D-188: true for exactly the span of an auto-resolved attack of opportunity, so a
   * second provoking drag during the rolls is refused by `planHeldMove`'s `"busy"` mode
   * instead of starting a second resolution. Not reactive: it is read only inside the
   * drag handler, never rendered.
   */
  let resolvingAoos = false;
  let importedTokens = $state<{ name: string; actorId: string; img: string }[]>(
    [],
  );
  let dice3dHost = $state<HTMLElement | null>(null);
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

  /** Push lines onto the notification stack, newest last, capped like every other writer. */
  function pushLog(messages: string[], level: "info" | "warn" | "error"): void {
    if (messages.length === 0) return;
    notifyLog = [
      ...notifyLog.slice(-49),
      ...messages.map((message) => ({ message, level })),
    ];
  }

  /** D-187: run the held move. The prompt is cleared first: it owns this commit, once. */
  function commitHeldMove(): void {
    const commit = pendingCommit;
    pendingCommit = null;
    pendingReaction = null;
    commit?.();
  }

  /**
   * D-187: the GM's answer for one reactor — resolve **that reactor's** queued attacks
   * through the same flow the automatic path uses (rolls, damage, ledger), report it, and
   * settle the prompt. When the last row is answered the move commits itself.
   */
  async function strikeReaction(reactorId: string): Promise<void> {
    const pending = pendingReaction;
    if (!pending || !app) return;
    const gm = app.gm;
    const scene = activeScene();
    if (!scene || scene._id !== pending.sceneId) {
      // The prompt outlived its scene (a switch, an undo): never resolve against another.
      pushLog(
        ["the attack of opportunity was dropped — the scene changed"],
        "warn",
      );
      pendingReaction = null;
      pendingCommit = null;
      return;
    }
    const combat =
      pending.combatId === null
        ? null
        : (gm.client.store.get("combats", pending.combatId) ?? null);
    const resolution = await resolveMovementOpportunities(
      gm.client,
      gm.client.user,
      {
        opportunity: opportunityForReactor(pending, reactorId),
        combat,
        actors: gm.client.store.getAll("actors"),
        tokens: scene.tokens,
        scene,
      },
    );
    pushLog(
      resolutionLines(resolution, {
        hostilityAssumed: pending.hostilityAssumed,
      }),
      "warn",
    );
    if (resolution.error !== null) pushLog([resolution.error], "warn");
    const next = decideReactor(pending, reactorId);
    if (isSettled(next)) commitHeldMove();
    else pendingReaction = next;
  }

  /** D-187: "let it pass" — the opportunity is optional, so one click answers for all. */
  function forgoReactionPrompt(): void {
    const pending = pendingReaction;
    if (!pending) return;
    pushLog(forgoLines(pending), "info");
    // Record the answer for every row (the state machine's own settled form) before the
    // commit clears the prompt, so "who was offered what" survives in one place.
    pendingReaction = forgoReaction(pending);
    commitHeldMove();
  }

  /** D-187: "stay put" — the move is dropped and the token keeps its committed square. */
  function cancelHeldMove(): void {
    if (pendingReaction === null) return;
    pushLog(["the move was cancelled — the token stays put"], "info");
    pendingReaction = null;
    pendingCommit = null;
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
      // Settings carries the ruleset section on top of the scene options (D-249): taller.
      height: kind === "settings" ? 560 : 420,
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

  /**
   * P02/D-197: draw the threatened squares of the **single selected token** —
   * G §4.5's highlighting, straight off the threat model's own draw list
   * (`threatRects`). Local selection UI, never replicated: no selection, a
   * multi-selection or a scene without the token clears the layer.
   */
  function syncPF1eThreatOverlay(): void {
    if (!stage) return;
    const layer = stage.getThreatOverlayLayer();
    const scene = activeScene();
    const selectedId =
      tokenSelection.ids.length === 1 ? tokenSelection.ids[0] : null;
    const token =
      selectedId !== null
        ? (scene?.tokens.find((t) => t._id === selectedId) ?? null)
        : null;
    if (scene === null || token === null) {
      layer.sync([], null, stage.camera);
      return;
    }
    const actors = app?.gm.client.store.getAll("actors") as ActorDocument[];
    const model = pf1eThreatModel({
      grid: scene.grid,
      tokens: scene.tokens.map((t) => {
        const actor = t.actorId
          ? (actors.find((a) => a._id === t.actorId) ?? null)
          : null;
        const derived = actor
          ? deriveFromDocuments({ actor: { system: actor.system } })
          : null;
        return {
          _id: t._id,
          x: t.x,
          y: t.y,
          width: t.width,
          height: t.height,
          ...(derived ? { size: derived.size, shape: derived.reachShape } : {}),
        };
      }),
    });
    const entry = model.entries.find((e) => e.tokenId === token._id);
    if (!model.ok || entry === undefined) {
      layer.sync([], null, stage.camera);
      return;
    }
    layer.sync(
      entry.threatRects,
      entry.cellRects.length === 1
        ? entry.cellRects[0]
        : {
            x: token.x - token.width / 2,
            y: token.y - token.height / 2,
            width: token.width,
            height: token.height,
          },
      stage.camera,
    );
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
    if (
      pf1ePreviewSceneId !== null &&
      pf1ePreviewSceneId !== (scene?._id ?? null)
    )
      clearPF1eAreaPreview();
    syncPF1eAreaPreview();
    // P02: the threat overlay follows the selected token through every store
    // update, so a moved token re-reads its own threatened squares.
    syncPF1eThreatOverlay();
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
    // D-250/D-251: explored fog follows the replica — tokens moved, doors opened, scene
    // switched. The GM's cover is translucent (everything stays visible under it); god view
    // off previews the opaque cover players get.
    void fog?.sync(scene, { style: gmState.godView ? "translucent" : "opaque" });
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
    if (code && share) {
      void share.receiveCode(code).catch((err: unknown) => {
        shareError = err instanceof Error ? err.message : String(err);
      });
    }
    peerCode = "";
  }

  async function copyCode(value: string, label: string): Promise<void> {
    const copied = await copyText(value);
    copyStatus = copied
      ? `${label} copied to clipboard.`
      : `Select the ${label.toLowerCase()} and copy it manually.`;
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copyStatus = ""), 4_000);
  }

  function clearCopyTimer(): void {
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = null;
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
        const hostElement = canvasHost;
        if (!hostElement) return;
        const width = Math.max(320, hostElement.clientWidth);
        const height = Math.max(240, hostElement.clientHeight);
        const view = await createStage({
          width,
          height,
          hostElement,
        });
        stage = view;
        const canvas = view.app.canvas as HTMLCanvasElement;
        const toWorld = (event: PointerEvent) => {
          const rect = canvas.getBoundingClientRect();
          return screenToWorld(view.camera, event.clientX - rect.left, event.clientY - rect.top);
        };
        toolController = new ToolInteractionController({
          nextId: () => `drawing-${globalThis.crypto.randomUUID().slice(0, 8)}`,
          userId: current.gm.client.user._id,
          grid: () => {
            const sc = activeScene();
            return sc?.grid ? { ...sc.grid, size: sc.grid.size, feetPerCell: sc.grid.distance } : null;
          },
          createDrawing: (drawing) => {
            const sc = activeScene();
            if (sc) current.gm.client.submit([{ kind: "create", coll: "drawings", parent: { coll: "scenes", id: sc._id }, data: drawing }]);
          },
          promptText: (at) => {
            const text = globalThis.prompt("Text label");
            const sc = activeScene();
            if (text && sc) current.gm.client.submit([{ kind: "create", coll: "drawings", parent: { coll: "scenes", id: sc._id }, data: drawingForText(`drawing-${globalThis.crypto.randomUUID().slice(0, 8)}`, at, text, current.gm.client.user._id) }]);
          },
          measurePreview: (value) => { measurePreview = value; },
        });
        const onToolDown = (e: PointerEvent) => { if (canvasTool === "draw" || canvasTool === "text" || canvasTool === "measure") toolController?.pointerDown({ world: toWorld(e), button: e.button, ctrlKey: e.ctrlKey }); };
        const onToolMove = (e: PointerEvent) => { if (canvasTool === "draw" || canvasTool === "measure") toolController?.pointerMove({ world: toWorld(e), button: e.button, ctrlKey: e.ctrlKey }); };
        const onToolUp = (e: PointerEvent) => { if (canvasTool === "draw" || canvasTool === "measure") toolController?.pointerUp({ world: toWorld(e), button: e.button, ctrlKey: e.ctrlKey }); };
        canvas.addEventListener("pointerdown", onToolDown);
        canvas.addEventListener("pointermove", onToolMove);
        canvas.addEventListener("pointerup", onToolUp);
        onDestroy(() => { canvas.removeEventListener("pointerdown", onToolDown); canvas.removeEventListener("pointermove", onToolMove); canvas.removeEventListener("pointerup", onToolUp); });
        // F01 — expose for chat roll-card highlights & e2e (canvasSmoke)
        (globalThis as unknown as { __stage?: unknown }).__stage = view;
        view.fit(scene?.width ?? 2000, scene?.height ?? 1500);
        // D-250: the GM's explored map — every vision token reveals; persisted through the
        // same fog.put/fog.get the players use (the GM UI only ever speaks ClientSync, §2).
        fog = new FogExploration({
          surfaceFor: (sc) => view.getFogLayer({ width: sc.width, height: sc.height }),
          hideSurface: () => view.hideFogLayer(),
          computer: createVisionComputer(),
          transport: current.gm.client,
          user: () => current.gm.client.user,
          actors: () =>
            current.gm.client.store.getAll("actors") as readonly ActorDocument[],
          onError: (where, error) => console.warn(`fog ${where} failed`, error),
        });
        controller = new CanvasController({
          onSelectionChange: (ids) => {
            tokenSelection = {
              sceneId: activeScene()?._id ?? null,
              ids: [...ids],
            };
            closeTokenMenu(); // any new gesture supersedes the menu
            syncPF1eThreatOverlay(); // P02: one selected token shows its threat
          },
          onContextMenu: ({ screen, tokenId }) => {
            tokenMenu = { x: screen.x, y: screen.y, tokenId };
          },
          onTokenActivate: ({ token }) => {
            if (token.actorId) openActorSheet(token.actorId);
          },
          /**
           * P06/D-185: the AoO verdict is asked **before** the move Op commits, through the
           * same pure seam the unit and app suites pin, and reports what it finds.
           *
           * D-186: who resolves the queue is a replicated world option
           * (`autoResolveAoos`, on unless a world turns it off). On, this is no longer only
           * a report: the move is *held* — `"cancel"` — the queued attacks are resolved
           * through the sheet's own resolve flow, in resolution order, before the mover
           * leaves the square, and only then does the deferred `commit` submit the move Op.
           * Off (or with no encounter to spend a per-round budget against), the same call
           * builds the queue, reports its lines, and the table resolves them by hand. The
           * decision itself is `planHeldMove`, so it is unit-tested rather than implied by
           * this handler.
           */
          onTokenMove: ({ view: moved, to, commit }) => {
            const scene = activeScene();
            if (!scene) return;
            const actors = current.gm.client.store.getAll("actors");
            const tokens = scene.tokens.map((t) => {
              const actor = t.actorId
                ? (actors.find((a) => a._id === t.actorId) ?? null)
                : null;
              const derived = actor
                ? deriveFromDocuments({ actor: { system: actor.system } })
                : null;
              return {
                _id: t._id,
                x: t.x,
                y: t.y,
                width: t.width,
                height: t.height,
                ...(derived
                  ? { size: derived.size, shape: derived.reachShape }
                  : {}),
              };
            });
            // Hostility is a caller fact (the seam never invents one). The scene's own
            // dispositions are the only side information a token carries, so a pair is
            // hostile when both sides named a disposition and they differ — and anything
            // less explicit is reported as an assumption instead of being assumed silently.
            const dispositionOf = new Map(
              scene.tokens.map((t) => [t._id, t.disposition]),
            );
            const explicit = tokens.every(
              (t) => (dispositionOf.get(t._id) ?? "neutral") !== "neutral",
            );
            // P03/D-198: the move's own legality — the walk's cost against the
            // mover's derived speed, occupied ending squares, through-enemy
            // pass-through and move-blocking walls — asked BEFORE the
            // opportunity queue, so an illegal drag never provokes. A drag is
            // a walk (a move action); run/withdraw/charge and the 5-foot step
            // are the seam's other modes, with no drag UI declaring them yet.
            {
              const moverActor = moved.token.actorId
                ? (actors.find((a) => a._id === moved.token.actorId) ?? null)
                : null;
              // The gate is a PF1e rule for PF1e actors: a systemless token's
              // drag owns no speed and no action economy, so it stays free.
              if (moverActor !== null && isPF1eActor(moverActor)) {
                const moverDerived = moverActor
                  ? deriveFromDocuments({
                      actor: { system: moverActor.system },
                    })
                  : null;
                const sceneTerrain = sceneDifficultCells(scene);
                const plan = pf1eMovePlan({
                  grid: scene.grid,
                  tokens,
                  mover: {
                    tokenId: moved.token._id,
                    to,
                    ...(moverDerived ? { speedFt: moverDerived.speedFt } : {}),
                  },
                  walls: moveSegments(scene.walls),
                  // M05: the scene's authored difficult squares (flags.pf1e.difficultCells).
                  // With no flag authored this stays the P03 module's named default.
                  ...(sceneTerrain ?? { difficultCells: undefined }),
                  ...(explicit
                    ? {
                        isAlly: (a: string, b: string) =>
                          dispositionOf.get(a) === dispositionOf.get(b),
                      }
                    : {}),
                });
                if (plan.refusal !== null) {
                  notifyLog = [
                    ...notifyLog.slice(-49),
                    {
                      message: `${moved.token.name} can't move there — ${plan.refusal}`,
                      level: "warn" as const,
                    },
                  ];
                  return "cancel";
                }
                if (plan.minimumMovement) {
                  notifyLog = [
                    ...notifyLog.slice(-49),
                    {
                      message: `${moved.token.name} moves by the minimum-movement rule — a full-round action moves 5 ft despite the reduced speed (A.7); it provokes`,
                      level: "info" as const,
                    },
                  ];
                }
              }
            }
            // D-187: the prompt's rows read each reactor's AoO budget off the seam's
            // `used`/`max`, so the move must hand the encounter's ledgers in — otherwise
            // every row shows `null` and a reactor that has already spent its opportunity
            // cannot be refused before the queue is built.
            const combat = activeCombat();
            const ledgers: Record<string, { used: number; max: number }> = {};
            if (combat !== null) {
              for (const t of scene.tokens) {
                const combatant = combatantForToken(combat, t._id);
                if (combatant === null) continue;
                const budget = attackOfOpportunityBudget(
                  combat,
                  combatant._id,
                  actors,
                );
                if (budget !== null) {
                  ledgers[t._id] = { used: budget.used, max: budget.max };
                }
              }
            }
            const result = pf1eMovementOpportunities({
              grid: scene.grid,
              tokens,
              mover: { tokenId: moved.token._id, to },
              // P04 — the scene's sight-blocking walls, so AoN 181's cover
              // exclusion applies to the queued reactions.
              coverWalls: sightSegments(scene.walls),
              ...(explicit
                ? {
                    isEnemy: (a: string, b: string) =>
                      dispositionOf.get(a) !== dispositionOf.get(b),
                  }
                : {}),
              ...(combat !== null ? { ledgers } : {}),
            });
            if (result.queued.length === 0 && result.refused.length === 0)
              return;
            const push = (messages: string[], level: "info" | "warn"): void => {
              notifyLog = [
                ...notifyLog.slice(-49),
                ...messages.map((message) => ({ message, level })),
              ];
            };
            const settings = worldSettingsFrom(
              current.gm.client.store.getAll("settings"),
            );
            const plan = planHeldMove({
              opportunity: result,
              autoResolve: autoResolveAoosOf(settings),
              hasEncounter: combat !== null,
              hostilityAssumed: !explicit,
              // D-188: one seam, one decision at a time — a second provoking move while a
              // prompt is open or an auto-resolution is in flight is refused, never
              // silently replacing the first decision.
              held:
                pendingReaction !== null
                  ? "prompt"
                  : resolvingAoos
                    ? "resolving"
                    : null,
            });
            if (plan.mode === "busy") {
              // Refuse the move and leave the open decision untouched: the mover stays on
              // its committed square and the first prompt/commit is exactly as it was.
              push(plan.lines, "warn");
              return "cancel";
            }
            if (plan.mode === "report") {
              // No encounter to spend against: report the queue, as D-185 did.
              push(plan.lines, "warn");
              return;
            }
            if (plan.mode === "prompt") {
              // D-187: the world resolves these by hand. Hold the move and ask — the
              // attacks happen before the mover leaves the square, so the commit waits.
              pendingReaction = openReaction({
                sceneId: scene._id,
                opportunity: result,
                combatId: combat?._id ?? null,
                hostilityAssumed: !explicit,
              });
              pendingCommit = commit;
              push(
                [
                  `attack of opportunity available — ${
                    result.queued.length === 1
                      ? "1 creature may strike"
                      : `${result.queued.length} creatures may strike`
                  } (${result.reactors.map((r) => r.tokenId).join(", ")})`,
                ],
                "warn",
              );
              return "cancel";
            }
            // Held: the attacks resolve before the mover leaves the square. `resolvingAoos`
            // is set for exactly the span of the resolution, so a re-entrant drag while the
            // rolls are in flight is refused by `planHeldMove`'s "busy" mode (D-188) instead
            // of starting a second, interleaved resolution.
            resolvingAoos = true;
            void resolveMovementOpportunities(
              current.gm.client,
              current.gm.client.user,
              {
                opportunity: result,
                combat,
                actors: actors as ActorDocument[],
                tokens: scene.tokens,
                scene,
              },
            )
              .then((resolution) => {
                const lines = resolutionLines(resolution, {
                  hostilityAssumed: !explicit,
                });
                if (lines.length > 0) push(lines, "warn");
                if (resolution.error !== null) push([resolution.error], "warn");
                // Committing is what actually moves the token: the attack happened while
                // the mover was still standing in the square it provoked from.
                commit();
              })
              .finally(() => {
                resolvingAoos = false;
              });
            return "cancel";
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
        // F01/F03 — roll-card highlight: the chat card emits a semantic request;
        // the App owns the stage, so rects are computed here against the ACTIVE
        // scene (real token rects, real grid px/ft for areas) and the camera
        // centers on the clicked initiator/target/epicenter.
        current.gm.bus.on("rollHighlight", (req) => {
          try {
            const scene = activeScene();
            const tokens = scene?.tokens ?? [];
            const rects: RollHighlightRect[] = [];
            let center: { x: number; y: number } | null = null;
            if (req.kind === "area" && req.area) {
              const grid = scene?.grid;
              const distance = grid && grid.distance > 0 ? grid.distance : 5;
              const size = grid && grid.size > 0 ? grid.size : 50;
              const rPx = (req.area.radiusFt / distance) * size;
              rects.push({
                x: req.area.origin.x - rPx,
                y: req.area.origin.y - rPx,
                width: rPx * 2,
                height: rPx * 2,
                kind: "area",
              });
              for (const tokenId of req.affectedTokenIds) {
                const t = tokens.find((tok) => tok._id === tokenId);
                if (t) rects.push({ ...tokenRect(t), kind: "target" });
              }
              center = req.area.origin;
            } else if (req.tokenId !== null) {
              const t = tokens.find((tok) => tok._id === req.tokenId);
              if (t) {
                const r = tokenRect(t);
                rects.push({
                  ...r,
                  kind: req.kind === "target" ? "target" : "initiator",
                });
                center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
            if (rects.length === 0) return; // token gone / nothing resolvable
            view.getRollHighlightLayer().sync(rects, view.camera, req.fadeSec);
            if (center !== null) {
              const cam = view.camera;
              view.setCamera({
                x: center.x - view.viewport.width / (2 * cam.scale),
                y: center.y - view.viewport.height / (2 * cam.scale),
                scale: cam.scale,
              });
            }
          } catch (err) {
            console.warn("rollHighlight failed (best-effort overlay)", err);
          }
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
          fogState: async () => {
            await fog?.settle();
            const stats = fog?.stats() ?? {
              sceneId: null,
              enabled: false,
              restored: false,
              restoredBytes: 0,
              reveals: 0,
              saves: 0,
              lastSaveBytes: 0,
              dirty: false,
            };
            const layer = view.peekFogLayer();
            const stored = stats.sceneId
              ? ((await getFog(current.db, current.worldId, stats.sceneId, GM_USER_ID))
                  ?.png.length ?? 0)
              : 0;
            return {
              sceneId: stats.sceneId,
              enabled: stats.enabled,
              restored: stats.restored,
              restoredBytes: stats.restoredBytes,
              reveals: stats.reveals,
              saves: stats.saves,
              lastSaveBytes: stats.lastSaveBytes,
              explored: layer ? layer.exploredFraction() : 0,
              shown: layer ? layer.shown : null,
              style: layer ? layer.style : null,
              stored,
            };
          },
          fogFlush: async () => {
            await fog?.flush();
            return fog?.stats().saves ?? 0;
          },
          fogExploredAt: ({ x, y }) => view.peekFogLayer()?.exploredAt(x, y) ?? null,
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
          pf1eThreatOverlayState: () => {
            const layer = view.getThreatOverlayLayer();
            return {
              tokenId:
                tokenSelection.ids.length === 1
                  ? (tokenSelection.ids[0] ?? null)
                  : null,
              rectsDrawn: layer.rectCount,
              originDrawn: layer.originDrawn,
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
          sceneCoreFlags: () => {
            const core = (activeScene()?.flags as { core?: unknown } | undefined)?.core;
            return core !== null && typeof core === "object"
              ? { ...(core as Record<string, unknown>) }
              : {};
          },
          godView: () => gmState.godView,
          viewAsFaction: () => gmState.viewAsFaction,
          simCount: () => current.gm.client.simReplica?.count ?? null,
          turnPhase: () => lastTurnPhase,
          reportRulesVersion: () => lastRulesVersion,
          reportByType: () => lastByType,
          notifications: () => [...notifyLog],
          reaction: () =>
            pendingReaction === null
              ? null
              : {
                  sceneId: pendingReaction.sceneId,
                  combatId: pendingReaction.combatId,
                  hostilityAssumed: pendingReaction.hostilityAssumed,
                  settled: isSettled(pendingReaction),
                  rows: pendingRows(pendingReaction),
                },
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
    // D-250: the explored map is uploaded after a quiet 1.5 s; a reload or tab close inside
    // that window would lose the last reveal, so flush on pagehide (synchronous readback).
    const onPageHide = (): void => void fog?.flush();
    globalThis.addEventListener("pagehide", onPageHide);
    return () => {
      globalThis.removeEventListener("pagehide", onPageHide);
      if (shareTimer !== null) clearInterval(shareTimer);
      clearCopyTimer();
      share?.close();
      controller?.destroy();
      fog?.destroy();
      fog = null;
      stage?.destroy();
      stage = null;
    };
  });

  // D-250/D-251: god view toggles (Settings / GM extras) restyle the cover at once.
  $effect(() => {
    const style = gmState.godView ? "translucent" : "opaque";
    void fog?.sync(activeScene(), { style });
  });
</script>

<main class="vtt-ui">
  <header class="app-header">
    <div>
      <p class="eyebrow">ARENASTAR</p>
      <h1>VTT</h1>
    </div>
    <p class="sub">
      Browser-only virtual tabletop · bootstrap v{__APP_VERSION__}
    </p>
  </header>
  {#if bootError}
    <p class="error" role="alert">Boot failed: {bootError}</p>
  {/if}

  <section class="capabilities" aria-labelledby="caps-h">
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
          <!-- D-248: which strategic ruleset this world runs (strategic scenes only) -->
          <span
            data-rules-status
            data-rules-source={app.rulesBoot.source}
            title="Strategic ruleset — applies to strategic-scale scenes; tactical scenes are heroes only"
            >strategic rules: {app.rulesBoot.source === "package"
              ? `${app.rulesBoot.packageId} v${app.rulesBoot.version}`
              : `built-in v${app.rulesBoot.version}`}</span
          >
        </div>
        {#if app.rulesBoot.error}
          <p class="error rules-boot-error" role="alert" data-rules-boot-error>
            Strategic ruleset {app.rulesBoot.packageId ?? ""} could not load — running built-in
            rules instead: {app.rulesBoot.error}
          </p>
        {/if}
        <label class="btn file-control" for="map-input">
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
        <section class="invite-panel" aria-labelledby="invite-heading">
          <div class="section-heading">
            <h2 id="invite-heading">Invite players</h2>
            <p>Share the link, then complete the one-time code exchange.</p>
          </div>
          {#if !share}
            <button id="share" type="button" onclick={() => void beginShare()}>
              Create invite link
            </button>
          {:else}
            <div class="code-field">
              <label for="invite-link">Invite link</label>
              <textarea
                id="invite-link"
                class="signal-code"
                rows="3"
                readonly
                value={share.inviteLink}
                spellcheck="false"
                aria-describedby="invite-help"></textarea>
              <div class="field-actions">
                <button
                  id="copy-invite-link"
                  class="secondary"
                  type="button"
                  onclick={() =>
                    void copyCode(share?.inviteLink ?? "", "invite link")}
                  >Copy invite link</button
                >
                <p id="invite-help" class="hint">
                  Send this link to each player.
                </p>
              </div>
            </div>
            <div class="code-field">
              <label for="peer-code">Player's code</label>
              <textarea
                id="peer-code"
                class="signal-code"
                rows="5"
                bind:value={peerCode}
                placeholder="Paste the player's code here"
                spellcheck="false"
                autocapitalize="off"
                autocomplete="off"
                aria-describedby="peer-help"></textarea>
              <p id="peer-help" class="hint">
                Paste a player's code, then apply it.
              </p>
            </div>
            <button id="code-apply" type="button" onclick={applyPeerCode}
              >Apply player code</button
            >
            <div class="code-field">
              <label for="share-out"
                >Your answer code <span class="required-note"
                  >(send to player)</span
                ></label
              >
              <textarea
                id="share-out"
                class="signal-code"
                rows="5"
                readonly
                value={hostAnswer}
                spellcheck="false"
                aria-describedby="answer-help"></textarea>
              <div class="field-actions">
                <button
                  id="copy-share-out"
                  class="secondary"
                  type="button"
                  disabled={!hostAnswer}
                  onclick={() => void copyCode(hostAnswer, "answer code")}
                  >Copy answer code</button
                >
                <p id="answer-help" class="hint">
                  Send this answer back to the player.
                </p>
              </div>
            </div>
            {#if copyStatus}<p class="copy-status" role="status">
                {copyStatus}
              </p>{/if}
          {/if}
          {#if shareError}
            <p class="error" role="alert">{shareError}</p>
          {/if}
        </section>
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
            id="gm-armies"
            type="button"
            onclick={() => openWindow("armies", "Armies", "armies")}
            title="Army management (M14)"
          >
            Armies
          </button>
          <button
            id="gm-undo"
            type="button"
            onclick={undo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo (Ctrl+Z)">↩</button
          >
          <button
            id="gm-redo"
            type="button"
            onclick={redo}
            title="Redo (Ctrl+Y)"
            aria-label="Redo (Ctrl+Y)">↪</button
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
        <p class="hint" data-world-name title={app.worldId}>{app.meta.name}</p>
        <button id="export-world" type="button" onclick={exportWorld}>
          Export world (.zip)
        </button>
        {#if typeof globalThis.showDirectoryPicker === "function"}
          <button id="export-folder" type="button" onclick={exportToFolder}>
            Save to folder…
          </button>
        {/if}
        {#if onExit}
          <!--
            D-249: opening/importing another world happens on the start screen, not from
            inside a running one — so the sidebar offers the way back instead of a second
            importer. The world is saved continuously; closing loses nothing.
          -->
          <button
            id="close-world"
            type="button"
            onclick={async () => {
              await fog?.flush(); // D-250: the last reveal lands before the world closes
              onExit?.();
            }}
          >
            Close world…
          </button>
        {/if}
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
            title="New scene"
            aria-label="New scene">+</button
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
          role="application"
          aria-label="Game board"
          tabindex="-1"
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
          <CanvasToolbar bind:active={canvasTool} bind:collapsed={canvasToolbarCollapsed} isGM={true} onEraseAll={eraseAllDrawings} onRoll={rollFromToolbar} />
          {#if measurePreview}
            {@const pts = measurePreview.points.map(measurePoint)}
            <svg class="measure-preview" aria-label={`Measurement ${measurePreview.distance}`}>
              <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#f4c95d" stroke-width="3" stroke-dasharray="8 5" />
              {#if measurePreview.radiusPx && pts[0]}
                <circle cx={pts[0].x} cy={pts[0].y} r={measurePreview.radiusPx * (stage?.camera.scale ?? 1)} fill="#f4c95d22" stroke="#f4c95d" stroke-width="2" />
              {/if}
              {#if pts.at(-1)}
                <text x={pts.at(-1)!.x + 8} y={pts.at(-1)!.y - 8} fill="#fff" stroke="#111" stroke-width="3" paint-order="stroke">{measurePreview.distance}</text>
              {/if}
            </svg>
          {/if}
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
                tabindex="-1"
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
          rulesBoot={app.rulesBoot}
        />
        {#if pendingReaction}
          <!--
            D-187: the held move's queue. Nothing has moved yet — each row is the seam's
            own line for one reactor, and answering the last row commits the move.
          -->
          <div class="reaction-prompt" data-reaction-prompt>
            <strong>Attack of opportunity?</strong>
            <span class="hint"
              >the move is held until every creature is answered</span
            >
            {#each pendingRows(pendingReaction) as row (row.reactorId)}
              <div class="reaction-row" data-reaction-row={row.reactorId}>
                <span class="line">{row.line}</span>
                <span class="budget"
                  >{row.used === null || row.max === null
                    ? ""
                    : `${row.used}/${row.max} used`}</span
                >
                <button
                  type="button"
                  data-reaction-strike={row.reactorId}
                  onclick={() => void strikeReaction(row.reactorId)}
                  >Strike</button
                >
              </div>
            {/each}
            <div class="reaction-actions">
              <button
                type="button"
                data-reaction-forgo
                onclick={forgoReactionPrompt}>Let it pass</button
              >
              <button
                type="button"
                data-reaction-cancel
                onclick={cancelHeldMove}>Stay put</button
              >
            </div>
          </div>
        {/if}
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
  .reaction-prompt {
    position: fixed;
    right: 16px;
    bottom: 104px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: min(420px, calc(100vw - 32px));
    padding: 16px;
    background: #2a2115f5;
    border: 1px solid #8b6d2b;
    border-left: 4px solid #f0c04a;
    border-radius: 10px;
    font-size: 1rem;
    z-index: 61;
    box-shadow: 0 8px 24px #0009;
  }
  .reaction-prompt .hint,
  .reaction-row .budget {
    color: #b7c5d5;
    font-size: 0.875rem;
  }
  .reaction-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .reaction-row .line {
    flex: 1;
  }
  .reaction-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .notify-stack {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(420px, calc(100vw - 32px));
    z-index: 60;
    pointer-events: none;
  }
  .notify {
    background: #1d2a3aee;
    border: 1px solid #506b8d;
    border-left: 4px solid #6ea8fe;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 0.9375rem;
    line-height: 1.4;
    box-shadow: 0 4px 14px #0007;
  }
  .notify[data-notify-level="warn"] {
    border-left-color: #f0c04a;
  }
  .notify[data-notify-level="error"] {
    border-left-color: #e05656;
  }
  main {
    width: min(100%, 1440px);
    margin: 0 auto;
    padding: 24px clamp(16px, 3vw, 42px) 36px;
  }
  .app-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 20px;
  }
  .eyebrow {
    margin: 0 0 4px;
    color: #66b7ff;
    font-size: 0.75rem;
    font-weight: 800;
    letter-spacing: 0.18em;
  }
  h1 {
    margin: 0;
    color: #f4f7fb;
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.05;
    letter-spacing: -0.03em;
  }
  .sub {
    margin: 0;
    color: #bdc9d6;
    font-size: 0.95rem;
  }
  .error {
    margin: 0 0 16px;
    color: #ffb4b4;
    font-size: 1rem;
  }
  .capabilities {
    margin-bottom: 20px;
    padding: 16px 18px;
    border: 1px solid #293d52;
    border-radius: 12px;
    background: #111a25;
  }
  .capabilities h2 {
    margin: 0 0 12px;
    color: #dce8f4;
    font-size: 1rem;
  }
  .capabilities ul {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px 18px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .capabilities li {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 28px;
    color: #d5e0eb;
    font-size: 0.9rem;
  }
  .capabilities li.missing {
    opacity: 0.7;
  }
  .dot {
    width: 10px;
    height: 10px;
    flex: 0 0 10px;
    border-radius: 50%;
    background: #69798a;
    box-shadow: 0 0 0 3px #69798a22;
  }
  .capabilities li.ok .dot {
    background: #4fd09a;
    box-shadow: 0 0 0 3px #4fd09a22;
  }
  .capabilities .state {
    margin-left: auto;
    color: #aebdcb;
  }
  .shell {
    display: flex;
    gap: 14px;
    min-height: 650px;
    height: min(780px, calc(100vh - 230px));
    border: 1px solid #304458;
    border-radius: 14px;
    overflow: visible; /* windows may hang past the canvas (§10) */
    background: #101923;
    box-shadow: 0 16px 40px #0005;
  }
  .gmtools {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .gmtools button {
    padding: 8px 10px;
  }
  .hotbar {
    display: flex;
    gap: 5px;
  }
  .hotbar .slot {
    flex: 1;
    min-width: 0;
    padding: 5px 3px;
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
    gap: 6px;
    padding: 8px;
    border-bottom: 1px solid #2f4052;
    background: #141d28;
    flex-wrap: wrap;
  }
  .scenenav button {
    padding: 8px 12px;
    border-radius: 7px;
  }
  .scenenav button.active {
    background: #2c5a84;
    border-color: #71b9ef;
  }
  .players {
    display: flex;
    gap: 10px;
    min-height: 32px;
    align-items: center;
    padding: 5px 8px;
    color: #cbd8e5;
    border-bottom: 1px solid #2f4052;
    background: #121a24;
  }
  .players small {
    color: #aebdcb;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tabs button {
    padding: 8px 10px;
    border-radius: 7px 7px 0 0;
    border: 1px solid #3a5068;
    background: #171f2a;
    color: #c4d2e0;
    cursor: pointer;
  }
  .tabs button.active {
    background: #2c5a84;
    color: #eff7ff;
    border-color: #71b9ef;
  }
  .tabbody {
    overflow: auto;
    border: 1px solid #3a5068;
    border-radius: 0 8px 8px 8px;
    padding: 10px;
    min-height: 140px;
    max-height: min(46vh, 480px);
    flex: 1 1 auto;
    background: #121a24;
  }
  .sidebar {
    width: 300px;
    flex: 0 0 300px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    padding: 16px;
    border-right: 1px solid #2f4052;
    background: #141d28;
  }
  #status {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 12px;
    border: 1px solid #40566d;
    border-radius: 9px;
    background: #172331;
    color: #cbd8e5;
    font-size: 0.95rem;
  }
  #status strong {
    color: #f2f5f8;
    font-size: 1.1rem;
  }
  #status [data-rules-status] {
    font-size: 0.8rem;
    color: #b1bdca;
  }
  .rules-boot-error {
    margin: 8px 0 0;
    font-size: 0.85rem;
  }
  .btn,
  button {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: 9px;
    border: 1px solid #40566d;
    background: #1c2a38;
    color: #f2f5f8;
    cursor: pointer;
    text-align: center;
  }
  .btn:hover,
  button:hover:not(:disabled) {
    background: #29445d;
    border-color: #6fb8ef;
  }
  .file-control {
    font-weight: 700;
  }
  .invite-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border: 1px solid #40566d;
    border-radius: 10px;
    background: #172331;
  }
  .section-heading h2 {
    margin: 0;
    color: #eff7ff;
    font-size: 1.1rem;
  }
  .section-heading p {
    margin: 4px 0 0;
    color: #aebdcb;
    font-size: 0.875rem;
  }
  .code-field {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .code-field label {
    font-weight: 700;
  }
  .required-note {
    color: #aebdcb;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .signal-code {
    width: 100%;
    min-width: 0;
    min-height: 122px !important;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    line-height: 1.45;
    white-space: pre;
    overflow-x: auto;
    overflow-y: auto;
    overflow-wrap: normal;
    background: #0d151f;
    color: #edf6ff;
    border: 1px solid #50677f;
    border-radius: 8px;
    padding: 10px;
  }
  .signal-code::placeholder {
    color: #7f93a7;
  }
  .signal-code:read-only {
    background: #101d2b;
    border-color: #5b7895;
  }
  .field-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .field-actions .secondary {
    flex: 0 0 auto;
    width: auto !important;
    padding-inline: 12px;
  }
  .field-actions .hint {
    flex: 1 1 120px;
  }
  .hint {
    margin: 0;
    color: #aebdcb;
  }
  .copy-status {
    margin: 0;
    color: #81e0b4;
  }
  .token-menu {
    position: absolute;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 230px;
    padding: 8px;
    background: #1c2b3a;
    border: 1px solid #56718e;
    border-radius: 9px;
    box-shadow: 0 8px 24px #0009;
  }
  .token-menu-title {
    font-weight: 700;
    padding: 4px 8px;
  }
  .token-menu-static {
    opacity: 0.85;
    padding: 6px 8px;
  }
  .token-menu button {
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    padding: 8px 10px;
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
    background: #0a0f15;
  }
  .measure-preview { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; overflow: visible; }
  .canvas-host :global(canvas) {
    display: block;
  }
  @media (max-width: 980px) {
    .shell {
      min-height: 600px;
    }
    .sidebar {
      width: 260px;
      flex-basis: 260px;
      padding: 12px;
    }
  }
  @media (max-width: 760px) {
    main {
      padding: 20px 12px 28px;
    }
    .app-header {
      align-items: flex-start;
      flex-direction: column;
      gap: 8px;
    }
    .shell {
      height: auto;
      min-height: 0;
      flex-direction: column;
    }
    .sidebar {
      width: 100%;
      flex-basis: auto;
      max-height: 580px;
      border-right: 0;
      border-bottom: 1px solid #2f4052;
    }
    .canvas-col {
      min-height: 58vh;
    }
    .tabbody {
      max-height: 420px;
    }
  }
</style>
