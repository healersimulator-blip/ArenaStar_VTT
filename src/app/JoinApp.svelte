<script lang="ts">
  import { onMount } from "svelte";
  import { bootPlayerApp, type PlayerApp } from "./joinBoot";
  import { parseInvite } from "./hostShare";
  import { createStage, type Stage } from "../canvas/stage";
  import { screenToWorld, worldToScreen, zoomAt } from "../canvas/camera";
  import CrosshairOverlay from "../ui/macros/CrosshairOverlay.svelte";
  import { resolveCrosshairPick, summonCrosshairOptions } from "../ui/macros/crosshairPicker";
  import type { RequestSummonPick, SummonPickOptions, SummonPickPoint } from "../ui/macros/summonPicker";
  import { displayDistance } from "../canvas/grid/measure";
  import { rulerLabel } from "../canvas/ephemera";
  import CanvasToolbar, {
    type CanvasAction,
    type CanvasTool,
    type RollMode,
  } from "../ui/canvas/CanvasToolbar.svelte";
  import {
    DEFAULT_TOOL_OPTIONS,
    ToolInteractionController,
    type MeasurePreview,
    type ShapePreview,
    type ToolOptions,
  } from "../canvas/tools/controller";
  import { drawingForText } from "../canvas/tools/drawing";
  import { templateOutline } from "../canvas/layers/templateGeometry";
  import { DEFAULT_BINDINGS, isTypingTarget } from "../core/keys";
  import {
    CanvasController,
    domPointerSource,
    pickToken,
    type TokenView,
  } from "../canvas/interactions";
  import { can } from "../core/permissions";
  import { tileContainsPoint } from "../core/automation";
  import { sceneFogSettings } from "../core/fogExploration";
  import { createHexOverlaySync, repaintHexOverlay, syncHexOverlay } from "./hexOverlay";
  import { cellAtPoint } from "../core/hexcrawl/cells";
  import { terrainCatalogOrDefault } from "../core/hexcrawl/terrain";
  import { isHexcrawlScene } from "../core/hexcrawl/types";
  import {
    hexContextMenuModel,
    type HexMenuEntry,
  } from "../ui/hexcrawl/hexContextMenu";
  import {
    NO_ONBOARDING_FACTS,
    onboardingSteps,
    type OnboardingFacts,
  } from "../core/onboarding";
  import OnboardingPanel from "../ui/onboarding/OnboardingPanel.svelte";
  import Icon from "../ui/icons/Icon.svelte";
  import { ChatPanel } from "../ui/chat";
  import { QuickbarRow } from "../ui/quickbar";
  import { SvelteMap } from "svelte/reactivity";
  import { WindowManager } from "../core/windows";
  import { WindowHost } from "../ui/windows";
  import { openPF1eSheetWindow } from "../ui/sheets/pf1eSheetWindow";
  import { SheetPanel } from "../ui/sheets";
  import type {
    ActorDocument,
    SceneDocument,
    SceneGrid,
  } from "../core/documents";
  import type { Op } from "../core/ops";
  import { copyText } from "../ui/clipboard";
  import { FogExploration } from "../client/fogExploration";
  import { FxPlayer } from "../client/fxPlayer";
  import FxViewPrefsPanel from "../ui/macros/FxViewPrefsPanel.svelte";
  import { fogMaskLog } from "../core/fogMask";
  import { drawingBounds } from "../canvas/layers/drawingGeometry";
  import { createVisionComputer } from "../workers/visionComputer";
  import { buildChatMessage, parseChatCommand } from "../core/chat";
  import { tokenHpBarsMap } from "../packages/pf1e/tokenHpBars";
  import { tokenHpBarsOf, worldSettingsFrom } from "../core/worldSettings";

  let app = $state<PlayerApp | null>(null);
  let phase = $state<"invite" | "exchange" | "live" | "dead">("invite");
  let joinError = $state<string | null>(null);
  let inviteText = $state("");
  let answerText = $state("");
  let hostCode = $state("");

  let worldName = $state("—");
  let seq = $state(0);
  let tokenCount = $state(0);
  let playerName = $state("");
  let playerTab = $state<"chat" | "actors">("chat");
  let guideOpen = $state(false);
  /** SQ-13: one-line FX delivery warnings for this viewer (max 4, newest last). */
  let fxNotices = $state<string[]>([]);
  let guideFocus = $state<HTMLDivElement | null>(null);
  let guideTrigger = $state<HTMLButtonElement | null>(null);
  function openGuide(): void {
    guideOpen = true;
    queueMicrotask(() => guideFocus?.focus());
  }
  function closeGuide(): void {
    guideOpen = false;
    queueMicrotask(() => guideTrigger?.focus());
  }
  let connState = $state("new");
  let copyStatus = $state("");
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  const wm = new WindowManager({ width: 800, height: 600 });
  let wmVersion = $state(0);
  /** Bumped by `refresh()` (snapshot/ops) so `$derived` blocks re-read the store. */
  let storeVersion = $state(0);
  const wmWindows = $derived.by(() => {
    void wmVersion;
    return [...wm.list()];
  });

  function openActorSheet(actorId: string): void {
    if (!app?.client) return;
    const rect = canvasHost?.getBoundingClientRect();
    openPF1eSheetWindow(
      wm,
      app.client,
      actorId,
      rect ? { width: rect.width, height: rect.height } : undefined,
    );
  }

  let canvasHost = $state<HTMLDivElement | null>(null);
  let canvasError = $state<string | null>(null);
  /** §2.2 item 3 (G-20/D-261): the tokens this player has selected — an apply verb's target. */
  let selection = $state<string[]>([]);
  let canvasTool = $state<CanvasTool>("select");
  let canvasToolbarCollapsed = $state(false);
  /** D-256: the player's sub-tool settings (players never get the GM-only tools). */
  let toolOptions = $state<ToolOptions>({
    ...DEFAULT_TOOL_OPTIONS,
    drawingStyle: { ...DEFAULT_TOOL_OPTIONS.drawingStyle },
  });
  /** D-256: the in-flight shape / brush gesture, drawn as an SVG overlay. */
  let shapePreview = $state<ShapePreview | null>(null);
  /** D-256: the in-canvas text editor (Roll20 types in place; `window.prompt` is gone). */
  let textDraft = $state<{ at: { x: number; y: number }; value: string; editingId: string | null } | null>(null);
  /** Roll20's own dice tray: the last five rolls are re-rollable. */
  const GESTURE_TOOLS: ReadonlySet<CanvasTool> = new Set<CanvasTool>([
    "draw",
    "text",
    "measure",
  ]);
  const rollFromToolbar = (formula: string, mode: RollMode = "roll") => {
    if (!app?.client?.user) return;
    const built = buildChatMessage({ author: app.client.user?.id ?? "", parsed: parseChatCommand(`/${mode} ${formula}`) });
    app.client.submit([{ kind: "create", coll: "messages", data: built.message }]);
  };
  const nextId = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const playerUserId = () => app?.client.user?.id ?? "";
  /** Commit the player's text tool editor (same contract as the GM shell). */
  function commitTextDraft() {
    const draft = textDraft;
    textDraft = null;
    const scene = activeScene();
    if (!draft || !scene || !draft.value.trim()) return;
    if (draft.editingId) {
      app?.client.submit([
        {
          kind: "update",
          ref: { coll: "drawings", id: draft.editingId, parent: { coll: "scenes", id: scene._id } },
          diff: { text: draft.value, name: draft.value.slice(0, 80), strokeWidth: toolOptions.textSize },
        },
      ]);
      return;
    }
    const drawing = drawingForText(nextId("drawing"), draft.at, draft.value, playerUserId(), {
      color: toolOptions.drawingStyle.stroke,
      width: Math.max(80, draft.value.length * toolOptions.textSize * 0.7),
      height: toolOptions.textSize + 12,
    });
    drawing.strokeWidth = toolOptions.textSize;
    app?.client.submit([
      { kind: "create", coll: "drawings", parent: { coll: "scenes", id: scene._id }, data: drawing },
    ]);
  }
  /** Double-clicking a label re-opens it in the editor (Roll20's double-click to edit). */
  function editTextAt(world: { x: number; y: number }): boolean {
    const scene = activeScene();
    if (!scene) return false;
    for (let i = scene.drawings.length - 1; i >= 0; i--) {
      const drawing = scene.drawings[i];
      if (!drawing || drawing.kind !== "text" || !drawing.text) continue;
      const bounds = drawingBounds(drawing);
      if (!bounds) continue;
      if (
        world.x >= bounds.x &&
        world.x <= bounds.x + bounds.width &&
        world.y >= bounds.y &&
        world.y <= bounds.y + bounds.height
      ) {
        textDraft = { at: { x: bounds.x, y: bounds.y }, value: drawing.text, editingId: drawing._id };
        return true;
      }
    }
    return false;
  }
  /** The rail's actions a player has: view + windows (no GM fog/placement tools). */
  function runCanvasAction(action: CanvasAction) {
    const view = stage;
    switch (action) {
      case "zoom-in":
      case "zoom-out": {
        if (!view) return;
        const host = canvasHost?.getBoundingClientRect();
        view.setCamera(
          zoomAt(
            view.camera,
            (host?.width ?? 0) / 2,
            (host?.height ?? 0) / 2,
            action === "zoom-in" ? 1.25 : 1 / 1.25,
          ),
        );
        break;
      }
      case "zoom-fit": {
        const scene = activeScene();
        if (view && scene) view.fit(scene.width, scene.height);
        break;
      }
      case "turn-order":
        openTurnOrder();
        break;
      case "help":
        openHelp();
        break;
      case "recall-measure":
        toolController?.recall();
        break;
      case "escape":
        if (!toolController || toolController.current() === null) canvasTool = "select";
        else toolController.dismissGesture();
        break;
      default:
        break;
    }
  }
  /** Player-callable scripts are projected as input-only stubs; code stays with the host. */
  function openMacros() {
    const rect = canvasHost?.getBoundingClientRect();
    if (rect) wm.setBounds({ width: rect.width, height: rect.height });
    wm.open({ id: "macros", title: "Published macros", kind: "macros",
      x: 55, y: 50, width: 550, height: 580 });
  }

  /** Roll20's Turn Tracker for a player: the shared list, read-only where they lack rights. */
  function openTurnOrder() {
    const rect = canvasHost?.getBoundingClientRect();
    if (rect) wm.setBounds({ width: rect.width, height: rect.height });
    wm.open({
      id: "turn-order",
      title: "Turn order",
      kind: "combat",
      x: 60,
      y: 60,
      width: 380,
      height: 420,
    });
  }
  function openHelp() {
    const rect = canvasHost?.getBoundingClientRect();
    if (rect) wm.setBounds({ width: rect.width, height: rect.height });
    wm.open({
      id: "help",
      title: "Keyboard shortcuts",
      kind: "help",
      x: 40,
      y: 40,
      width: 380,
      height: 520,
    });
  }
  let loadedMapHash: string | null = null;
  /** `$state.raw`: the stage is a Pixi object graph — assignment must re-run the
   *  effects that read it, but it must never be deep-proxied. */
  let stage = $state.raw<Stage | null>(null);
  let fxPlayer: FxPlayer | null = null;
  let fxClockTimer: ReturnType<typeof setInterval> | null = null;
  let controller: CanvasController | null = null;
  let toolController: ToolInteractionController | null = null;
  let measurePreview = $state<MeasurePreview | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Canvas tool listeners are attached after `await createStage(...)`, i.e. after the
   * component-init context is gone — `onDestroy` may only be *called* synchronously
   * (Svelte 5 throws `lifecycle_outside_component` otherwise, aborting the rest of the
   * boot wiring). The teardown is registered in onMount and fills itself in later.
   */
  let toolCleanup: (() => void) | null = null;
  /** Bumped when the (async) tool controller exists — the activation effect below re-runs. */
  let toolReady = $state(0);
  /**
   * The player shell's active tool owns the next gesture — the same contract as the GM
   * shell (D-255): draw/text/measure arm the tool controller, select disarms it, and
   * `interactionMode` keeps token/marquee gestures from firing underneath a stroke.
   */
  $effect(() => {
    void toolReady;
    const tool = toolController;
    if (!tool) return;
    if (GESTURE_TOOLS.has(canvasTool)) {
      tool.activate(canvasTool);
    } else {
      tool.cancel();
      shapePreview = null;
    }
  });
  /** D-250: this player's explored fog — revealed by the tokens they control, kept by the host. */
  let fog: FogExploration | null = null;
  /** D-271: the hexcrawl overlay's plan cache (a player always sees the covered view). */
  const hexOverlay = createHexOverlaySync();
  /**
   * D-251: token ids fog lets this player see (null = fog off, all). The stage draws only
   * these, and the controller never picks a hidden one (no select, sheet or menu through fog).
   */
  let fogVisible: ReadonlySet<string> | null = null;

  async function connect(inviteRaw: string): Promise<void> {
    joinError = null;
    const invite = parseInvite(inviteRaw);
    if (!invite) {
      joinError = "invite must look like #room=<id>&k=<secret>";
      return;
    }
    phase = "exchange";
    try {
      const playerApp = await bootPlayerApp({ invite });
      app = playerApp;
      playerName = playerApp.displayName;
      playerApp.onDisconnected = (reason) => {
        phase = "dead";
        connState = `disconnected (${reason})`;
      };
      playerApp.onConnectionState = (state) => {
        connState = state;
        if (state === "connected" && playerApp.client) phase = "live";
      };
      void playerApp.ready.then(() => {
        phase = "live";
        mountCanvas();
      });
      if (new URLSearchParams(globalThis.location.search).has("e2e")) {
        void import("./e2eHook").then((m) => m.installPlayerE2e(playerApp));
      }
    } catch (err) {
      joinError = err instanceof Error ? err.message : String(err);
      phase = "invite";
    }
  }

  function applyAnswer(): void {
    const code = answerText.trim();
    if (code && app) {
      void app.receiveCode(code).catch((err: unknown) => {
        joinError = err instanceof Error ? err.message : String(err);
        phase = "exchange";
      });
    }
    answerText = "";
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

  /**
   * D-271 (plan §5.2): a player's right-click on ground they *have* been shown. The model gives
   * them the one entry that is theirs (the hex's player text) plus the party's own marker, and
   * returns nothing at all for a hex they have not been shown — so no menu appears there.
   */
  let hexMenu = $state<{
    x: number;
    y: number;
    key: string;
    title: string;
    subtitle: string | null;
    entries: HexMenuEntry[];
  } | null>(null);

  function closeHexMenu(): void {
    hexMenu = null;
  }

  function openHexMenu(
    screen: { x: number; y: number },
    world: { x: number; y: number },
  ): void {
    if (!app?.client) return;
    const scene = activeScene();
    if (!scene || !isHexcrawlScene(scene)) return;
    const key = cellAtPoint(scene, world.x, world.y);
    if (!key) return;
    const model = hexContextMenuModel({
      scene,
      key,
      user: app.client.user ?? null,
      catalog: terrainCatalogOrDefault(
        worldSettingsFrom(app.client.store.getAll("settings"))["hexTerrain"],
      ),
    });
    if (model.entries.length === 0) return;
    hexMenu = { x: screen.x, y: screen.y, key, ...model };
  }

  function runHexMenuEntry(entryId: string): void {
    const menu = hexMenu;
    closeHexMenu();
    if (!menu) return;
    // A player's menu only ever offers "open" — everything else the model already refused to
    // list (the GM's entries are gated by the scene's write permission).
    if (entryId === "open") openHexWindow(menu.key);
  }

  function openHexWindow(key: string): void {
    const scene = activeScene();
    if (!scene) return;
    const rect = canvasHost?.getBoundingClientRect();
    if (rect) wm.setBounds({ width: rect.width, height: rect.height });
    wm.open({
      id: `hex-${scene._id}-${key}`,
      title: `Hex ${key}`,
      kind: "hex",
      x: 40 + (wm.list().length % 5) * 24,
      y: 40 + (wm.list().length % 5) * 24,
      width: 380,
      height: 460,
      data: { sceneId: scene._id, key },
    });
  }

  /**
   * The scene the player is looking at — **the active one**, like the GM shell's (D-271).
   *
   * This used to read `scene-1` by id with a fallback, which was invisible for as long as every
   * player-facing spec played in scene 1: a table whose GM switches to a second scene leaves its
   * players staring at the first one's map, tokens and fog. The hexcrawl gate found it (the GM's
   * map was a new scene, and the player's canvas kept painting scene 1), and the fix is the same
   * expression `App.svelte` uses: the `active` flag wins, `scene-1` is only the fallback for a
   * replica that has not been told yet.
   */
  // A shared, cancellable canvas crosshair for GM/player summon windows. The
  // UI owns the preview only; HostSync rechecks every point and permission.
  let pendingSummonPick = $state.raw<{ options: SummonPickOptions;
    resolve: (at: SummonPickPoint | null) => void } | null>(null);
  function settleSummonPick(at: SummonPickPoint | null): void {
    const pending = pendingSummonPick;
    pendingSummonPick = null;
    pending?.resolve(activeScene()?._id === pending.options.sceneId ? at : null);
  }
  const requestSummonPick: RequestSummonPick = (options) => {
    if (options.sceneId !== activeScene()?._id || !stage) return Promise.resolve(null);
    settleSummonPick(null); // starting a new gesture cancels the old one
    return new Promise((resolve) => { pendingSummonPick = { options, resolve }; });
  };

  function activeScene(): SceneDocument | null {
    const client = app?.client;
    if (!client) return null;
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    return (
      scenes.find((sc) => sc.active) ??
      client.store.get("scenes", "scene-1") ??
      scenes[0] ??
      null
    );
  }

  /**
   * §2.3 tail (D-263): the player's own first-run list. A player arrives at somebody else's table,
   * so every fact here is read from *their* replica — what they can see, and what they may touch.
   */
  const onboardingFacts = $derived.by((): OnboardingFacts => {
    void storeVersion;
    const client = app?.client;
    const user = client?.user;
    if (!client || !user) return NO_ONBOARDING_FACTS;
    const scene = activeScene();
    const data = (scene ?? null) as SceneDocument | null;
    const owned = data
      ? data.tokens.filter((t) => can(user, "update", t, "tokens", { parent: data })).length
      : 0;
    return {
      scenes: client.store.getAll("scenes").length,
      map: typeof data?.img === "string" && data.img !== "",
      tokens: data?.tokens.length ?? 0,
      character: typeof user.character === "string" && user.character !== "",
      owned,
      players: 1,
      invited: true,
      fog: sceneFogSettings(data).enabled,
      messages: client.store.getAll("messages").length,
    };
  });
  const onboarding = $derived(onboardingSteps(onboardingFacts, "PLAYER"));

  /**
   * §2.2 item 2 (G-10b/D-261): a player plays **their own** character — the first token the fog
   * shows them that they may update (a player whose tokens are all hidden keeps the bar empty
   * rather than guessing). The target is a separate choice in the bar itself.
   */
  const quickbarActor = $derived.by(() => {
    void storeVersion;
    const client = app?.client;
    const user = client?.user;
    if (!client || !user) return null;
    for (const view of tokenViews()) {
      const actorId = view.token.actorId ?? null;
      if (actorId === null) continue;
      const scene = activeScene();
      if (!can(user, "update", view.token, "tokens", scene ? { parent: scene } : {})) continue;
      const actor = client.store.get("actors", actorId) as ActorDocument | undefined;
      if (actor) return actor;
    }
    return null;
  });
  const quickbarTargets = $derived.by(() => {
    void storeVersion;
    const client = app?.client;
    const user = client?.user;
    if (!client || !user) return [];
    return [
      ...((client.store.getAll("actors") as readonly ActorDocument[]) ?? []),
    ].filter((a) => can(user, "read", a, "actors"));
  });

  function tokenViews(): TokenView[] {
    const scene = activeScene();
    if (!scene) return [];
    const visible = fogVisible;
    return scene.tokens
      .filter((token) => visible === null || visible.has(token._id))
      .map((token) => ({ token, sceneId: scene._id }));
  }

  /**
   * D-277: an asset hash → a URL a DOM `<img>` can load, for **this** replica. A revealed
   * feature's picture reaches a player as a hash in the cell document (`core/projection.ts` keeps
   * it, because a revealed feature is the players' to look at) — but a hash is not a picture, and
   * until the player's client fetched the bytes behind it there was nothing for the `<img>` to
   * draw: the player shell handed `HexWindow` no resolver at all, so the art was simply absent
   * from the one window whose whole job is to show it. The first ask starts the fetch and answers
   * `null`; the bytes land in a reactive map, so the asking component re-renders on its own.
   *
   * URLs pass straight through — a feature's picture may be a link the GM pasted.
   */
  const assetUrls = new SvelteMap<string, string>();

  function resolveAsset(hash: string | null | undefined): string | null {
    if (!hash) return null;
    if (/^(https?:|data:|blob:)/.test(hash)) return hash;
    const ready = assetUrls.get(hash);
    if (ready) return ready;
    const current = app;
    if (!current) return null;
    void current.fetcher
      .request(hash, "ui")
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        assetUrls.set(hash, url);
      })
      .catch(() => undefined);
    return null;
  }

  function squareGrid(
    grid: SceneGrid | undefined,
  ): { type: "square"; size: number } | null {
    if (grid && grid.type === "square" && grid.size > 0)
      return { type: "square", size: grid.size };
    return null;
  }

  function refresh(): void {
    const current = app;
    const view = stage;
    const client = current?.client;
    if (!current || !view || !client) return;
    // §2.2 item 2: the quickbar's slots live on the actor document, so the sidebar has to re-derive
    // them whenever a snapshot or an op lands (the GM shell tracks its store the same way).
    storeVersion++;
    const scene = activeScene();
    fxPlayer?.syncScene();
    worldName = client.world?.name ?? "—";
    seq = client.store.seq;
    tokenCount = scene?.tokens.length ?? 0;
    // §2.2/G-10a: a player's canvas draws the bars the world setting allows — none under the
    // default `"gm"`, every bar it was handed under `"all"`/`"hover"` (the stage hides a
    // `"hover"` bar until the pointer arrives).
    const tokens = scene?.tokens ?? [];
    const hpBarMode = tokenHpBarsOf(worldSettingsFrom(client.store.getAll("settings")));
    view.setTokenHpBarMode(hpBarMode === "hover" ? "hover" : "all");
    view.syncTokens(
      tokens,
      undefined,
      tokenHpBarsMap(tokens, {
        actors: client.store.getAll("actors") as ActorDocument[],
        mode: hpBarMode,
        isGM: false,
      }),
    );
    void fog?.sync(scene, { style: "opaque" });
    // D-256: the GM's manual mask + visible map pins (the projection already withheld every
    // pin the GM has not made visible, so this layer only ever draws player-visible pins).
    view.peekFogLayer()?.applyManualMask(fogMaskLog(scene));
    view.getNotesLayer().sync(scene?.notes ?? [], view.camera);
    // D-271: the hexcrawl overlay — on a player's shell the closed cells are covered, and the
    // cover is painted from this replica's open cells alone (a closed hex is not sent to a
    // player at all, so there is nothing else to paint it from).
    syncHexOverlay(view, hexOverlay, scene, "player", client.store.getAll("settings"));
    const img = scene?.img ?? null;
    if (img !== null && img !== loadedMapHash && current.fetcher) {
      loadedMapHash = img;
      const manifest = client.store.world.assetManifest[img];
      const mime = manifest?.mime ?? "image/png";
      // §7 thumbnail-first: preview paints immediately; full replaces async
      const thumb = manifest?.thumb;
      if (thumb && thumb.hash !== img) {
        void current.fetcher
          .request(thumb.hash, "ui")
          .then((bytes) => view.setBackgroundImage(bytes, thumb.mime))
          .catch(() => undefined);
      }
      void current.fetcher
        .request(img, "scene")
        .then((bytes) => view.setBackgroundImage(bytes, mime))
        .catch(() => undefined);
    }
    const grid = squareGrid(scene?.grid);
    if (grid) view.setGrid(grid);
  }

  /** Overlay coordinates are the canvas's own screen space (stage root = top-left origin). */
  const measurePoint = (point: { x: number; y: number }) =>
    stage ? worldToScreen(stage.camera, point.x, point.y) : point;
  /** What the ruler reads out: world units → the scene grid's own distance units. */
  const measureReadout = (distance: number): string => {
    const grid = activeScene()?.grid;
    if (!grid) return rulerLabel(distance, "ft");
    return rulerLabel(
      displayDistance(
        { type: grid.type, size: grid.size, distance: grid.distance, diagonals: grid.diagonals },
        distance,
      ),
      grid.units || "ft",
    );
  };

  function mountCanvas(): void {
    void (async () => {
      try {
        const current = app;
        if (!current?.client) return;
        const client = current.client;
        await current.ready;
        const scene = activeScene();
        const hostElement = canvasHost;
        if (!hostElement) return;
        const width = Math.max(320, hostElement.clientWidth);
        const height = Math.max(240, hostElement.clientHeight);
        const view = await createStage({ width, height, hostElement });
        stage = view;
        const fetcher = current.fetcher;
        if (fetcher) {
          fxPlayer = new FxPlayer({
            client, bus: current.bus, stage: view,
            fetchAsset: (hash) => fetcher.request(hash, "ui"),
            sceneId: () => activeScene()?._id ?? null,
            onError: (message) => console.warn(message),
            // A player whose device could not show a cue on time is told so here;
            // the timeline keeps playing for everyone else (A10).
            onDelivery: (report) => { fxNotices = [...fxNotices.slice(-3), report.message]; },
            macroName: (macroId) => client.store.get("macros", macroId)?.name ?? null,
            assetName: (hash) => client.store.world.assetManifest[hash]?.name ?? null,
          });
        }
        client.sendPing();
        fxClockTimer = globalThis.setInterval(() => client.sendPing(), 30_000);
        // e2e readback (camera / stage introspection) — the player shell's own global, so a
        // page that hosts both shells never confuses the two stages.
        (globalThis as unknown as { __canvasStage?: unknown }).__canvasStage = view;
        view.fit(scene?.width ?? 2000, scene?.height ?? 1500);
        fog = new FogExploration({
          surfaceFor: (sc) => view.getFogLayer({ width: sc.width, height: sc.height }),
          hideSurface: () => view.hideFogLayer(),
          computer: createVisionComputer(),
          transport: client,
          user: () => client.user,
          actors: () => client.store.getAll("actors") as readonly ActorDocument[],
          onVisibility: (ids) => {
            fogVisible = ids;
            view.setTokenVisibility(ids);
          },
          onError: (where, error) => console.warn(`fog ${where} failed`, error),
        });
        // a reconnect may reach a host session holding a map this tab never saw
        client.bus.on("welcome", () => void fog?.refreshStored());
        if (new URLSearchParams(globalThis.location.search).has("e2e")) {
          const fogLoop = fog;
          void import("./e2eHook").then((m) =>
            m.installPlayerCanvasE2e({
              fogState: async () => {
                await fogLoop.settle();
                const stats = fogLoop.stats();
                const layer = view.peekFogLayer();
                return {
                  sceneId: stats.sceneId,
                  enabled: stats.enabled,
                  restored: stats.restored,
                  reveals: stats.reveals,
                  saves: stats.saves,
                  explored: layer ? layer.exploredFraction() : 0,
                  shown: layer ? layer.shown : null,
                  style: layer ? layer.style : null,
                  visibleTokenIds: stats.visibleTokenIds,
                };
              },
              drawnTokens: () => view.drawnTokenIds(),
              // D-271: what this player's hexcrawl overlay painted (its own cover included).
              hexOverlay: () => {
                const layer = view.peekHexOverlayLayer();
                if (!layer) return null;
                return {
                  viewer: layer.planViewer ?? "player",
                  cells: layer.cellCount,
                  openCells: layer.openCells,
                  cover: layer.coverWidth > 0,
                  coverHoles: layer.coverHoles,
                  coverWidth: layer.coverWidth,
                  coverHeight: layer.coverHeight,
                };
              },
              screenOf: (point: { x: number; y: number }) => {
                const rect = view.app.canvas.getBoundingClientRect();
                const p = worldToScreen(view.camera, point.x, point.y);
                return { x: rect.left + p.x, y: rect.top + p.y };
              },
              // §2.2/G-10a: what this canvas drew (empty under the default `"gm"` setting).
              tokenHpBars: () => view.tokenHpBars(),
              pickableTokens: () => tokenViews().map((t) => t.token._id).sort(),
            }),
          );
        }
        const canvas = view.app.canvas as HTMLCanvasElement;
        const toWorld = (event: PointerEvent) => { const r = canvas.getBoundingClientRect(); return screenToWorld(view.camera, event.clientX - r.left, event.clientY - r.top); };
        toolController = new ToolInteractionController({
          nextId: () => `drawing-${globalThis.crypto.randomUUID().slice(0, 8)}`,
          userId: client.user?.id ?? "",
          grid: () => squareGrid(activeScene()?.grid),
          createDrawing: (drawing) => { const sc = activeScene(); if (sc) client.submit([{ kind: "create", coll: "drawings", parent: { coll: "scenes", id: sc._id }, data: drawing }]); },
          options: () => toolOptions,
          promptText: (at) => { textDraft = { at: { ...at }, value: "", editingId: null }; },
          createWall: () => undefined,
          createLight: () => undefined,
          createNote: () => undefined,
          measurePreview: (value) => { measurePreview = value; },
          shapePreview: (value) => { shapePreview = value; },
          broadcastMeasure: (points) => {
            view.getEffectsLayer().showRuler(client.user?.id ?? "player", points, squareGrid(activeScene()?.grid) as never, activeScene()?.grid.units ?? "ft");
            client.sendEphemeral("ruler", { points: points.map((p) => ({ x: p.x, y: p.y })) });
          },
          fogPaint: () => undefined,
        });
        toolReady++;
        const toolPointer = (e: PointerEvent) => ({
          world: toWorld(e),
          button: e.button,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        });
        const toolDown = (e: PointerEvent) => { if (GESTURE_TOOLS.has(canvasTool)) toolController.pointerDown(toolPointer(e)); };
        const toolMove = (e: PointerEvent) => { if (GESTURE_TOOLS.has(canvasTool)) toolController.pointerMove(toolPointer(e)); };
        const toolUp = (e: PointerEvent) => { if (GESTURE_TOOLS.has(canvasTool)) toolController.pointerUp(toolPointer(e)); };
        const onToolContext = (e: MouseEvent) => {
          if (canvasTool !== "draw") return;
          e.preventDefault();
          toolController.finishPoly();
        };
        const onToolKey = (e: KeyboardEvent) => {
          if (e.key !== "Escape" || isTypingTarget(e.target)) return;
          closeHexMenu(); // D-271: the hex menu dismisses like every other canvas menu
          if (GESTURE_TOOLS.has(canvasTool)) toolController.finishPoly();
        };
        const onTextEdit = (e: MouseEvent) => {
          if (canvasTool !== "text" || e.button !== 0) return;
          editTextAt(toWorld({ clientX: e.clientX, clientY: e.clientY } as PointerEvent));
        };
        let tileDown: { x: number; y: number; tokenId?: string } | null = null;
        const onTileDown = (e: PointerEvent) => {
          // Capture selection before the canvas controller clears it on an empty-space click.
          tileDown = { x: e.clientX, y: e.clientY,
            ...(selection.length === 1 && selection[0] ? { tokenId: selection[0] } : {}) };
        };
        const onTileClick = (e: MouseEvent) => {
          if (canvasTool !== "select" || e.button !== 0 || e.detail > 1 ||
              e.altKey || e.ctrlKey || e.shiftKey || !tileDown ||
              Math.hypot(e.clientX - tileDown.x, e.clientY - tileDown.y) > 4) return;
          const scene = activeScene();
          if (!scene) return;
          const world = toWorld({ clientX: e.clientX, clientY: e.clientY } as PointerEvent);
          if (pickToken(tokenViews(), world)) return; // a token click is not also a tile click
          const tile = [...scene.tiles].reverse().find((item) => tileContainsPoint(item, world));
          if (tile) client.requestAutomationClick(scene._id, tile._id, world, tileDown.tokenId);
        };
        canvas.addEventListener("pointerdown", onTileDown);
        canvas.addEventListener("click", onTileClick);
        canvas.addEventListener("pointerdown", toolDown); canvas.addEventListener("pointermove", toolMove); canvas.addEventListener("pointerup", toolUp);
        canvas.addEventListener("contextmenu", onToolContext);
        canvas.addEventListener("dblclick", onTextEdit);
        globalThis.addEventListener("keydown", onToolKey);
        toolCleanup = () => {
          canvas.removeEventListener("pointerdown", onTileDown);
          canvas.removeEventListener("click", onTileClick);
          canvas.removeEventListener("pointerdown", toolDown);
          canvas.removeEventListener("pointermove", toolMove);
          canvas.removeEventListener("pointerup", toolUp);
          canvas.removeEventListener("contextmenu", onToolContext);
          canvas.removeEventListener("dblclick", onTextEdit);
          globalThis.removeEventListener("keydown", onToolKey);
        };
        controller = new CanvasController({
          onSelectionChange: (ids) => {
            selection = [...ids];
            closeHexMenu(); // any new gesture supersedes the menu
          },
          onTokenActivate: ({ token }) => {
            if (token.actorId) openActorSheet(token.actorId);
          },
          // D-271: the same gesture where no token was hit — a hex a player has been shown.
          onCanvasContextMenu: ({ screen, world }) => openHexMenu(screen, world),
          // D-294: the same yield in the player shell — a player who drags the map
          // during a GM-cued pan keeps their own view.
          onCameraInput: () => fxPlayer?.cancelCamera(),
          stage: view,
          source: domPointerSource(view.app.canvas as HTMLCanvasElement),
          client: {
            submit: (ops: Op[]) => client.submit(ops),
          },
          getTokens: tokenViews,
          getGrid: () => squareGrid(activeScene()?.grid),
          // §10/D-255: the active tool owns the canvas (no token drag under a stroke); the
          // Pan tool pans on left-drag, exactly like the GM shell.
          interactionMode: () =>
            canvasTool === "select" ? "select" : canvasTool === "pan" ? "pan" : "suppress",
          // §5: players move only tokens they own (host re-validates anyway)
          canMove: (tokenView) => {
            const user = client.user;
            if (!user) return false;
            const scene = activeScene();
            return can(
              user,
              "update",
              tokenView.token,
              "tokens",
              scene ? { parent: scene } : {},
            );
          },
        });
        client.bus.on("snapshot", refresh);
        client.bus.on("ops", refresh);
        refresh();
        // D-271: the hex overlay's outlines are screen-constant, so a zoom restrokes them; the
        // plan itself is untouched (the layer's zoom bucket keeps this to one redraw per notch).
        let lastHexCamera = "";
        const onHexCameraTick = () => {
          const cam = view.camera;
          const key = `${cam.x}|${cam.y}|${cam.scale}`;
          if (key === lastHexCamera) return;
          lastHexCamera = key;
          repaintHexOverlay(view, hexOverlay);
        };
        view.app.ticker.add(onHexCameraTick);
        // The tool listeners' cleanup was installed earlier; chain rather than replace it.
        const cleanupTools = toolCleanup;
        toolCleanup = () => {
          cleanupTools?.();
          view.app.ticker.remove(onHexCameraTick);
        };
        view.render();
      } catch (err) {
        canvasError = err instanceof Error ? err.message : String(err);
      }
    })();
  }

  onMount(() => {
    const offWm = wm.onChange(() => wmVersion++);
    // auto-join from an invite fragment (?…#room=<id>&k=<secret>)
    const hash = globalThis.location.hash;
    if (hash.length > 1 && hash.includes("room=")) {
      inviteText = hash.slice(1);
      void connect(hash);
    }
    // Mirror poll (non-destructive): shows the latest code without draining
    // the outbox — e2e surfaces drain it directly (D-062).
    pollTimer = setInterval(() => {
      const code = app?.adapter.lastSentCode;
      if (code) hostCode = code;
    }, 250);
    const onPageHide = (): void => void fog?.flush(); // D-250: last reveal before unload
    globalThis.addEventListener("pagehide", onPageHide);
    return () => {
      globalThis.removeEventListener("pagehide", onPageHide);
      settleSummonPick(null);
      offWm();
      toolCleanup?.();
      toolCleanup = null;
      if (fxClockTimer !== null) clearInterval(fxClockTimer);
      fxClockTimer = null;
      fxPlayer?.dispose();
      fxPlayer = null;
      clearCopyTimer();
      if (pollTimer !== null) clearInterval(pollTimer);
      controller?.destroy();
      fog?.destroy();
      fog = null;
      stage?.destroy();
      stage = null;
      app?.close();
    };
  });
</script>

<main class="vtt-ui" class:player-live={phase === "live" || phase === "dead"}>
  <header class="join-header" class:live-header={phase === "live" || phase === "dead"}>
    {#if phase === "live" || phase === "dead"}
      <div class="brand-badge" aria-hidden="true">✦</div>
      <div class="player-identity">
        <p class="eyebrow">ARENASTAR <span> / PLAYER TABLE</span></p>
        <h1 title={worldName}>{worldName}</h1>
      </div>
      <div id="pstatus" aria-live="polite">
        <strong class="sr-only">{worldName}</strong>
        <span class="connection-badge" class:disconnected={phase === "dead"}><span class="connection-dot"></span>{phase === "dead" ? "Disconnected" : "Connected"}</span>
        <span>{playerName}</span>
        <span>seq {seq} · tokens {tokenCount}</span>
      </div>
      <div class="notify-stack" aria-live="polite" data-player-notify-stack>
        {#each fxNotices as message, i (message + ":" + String(i))}
          <div class="notify" data-player-notify>{message}</div>
        {/each}
      </div>
      <div class="player-actions" aria-label="Player actions">
        <button data-icon-button data-player-macros type="button" aria-label="Published macros" title="Published macros" onclick={openMacros}><Icon name="macro" /></button>
        <button data-icon-button data-player-setup type="button" bind:this={guideTrigger} aria-expanded={guideOpen}
          aria-label="Session & guide" title="Session & guide" onclick={openGuide}><Icon name="sliders" /></button>
      </div>
    {:else}
      <p class="eyebrow">ARENASTAR</p>
      <h1>Join a game</h1>
      <p class="sub">Connect to a host with an invite link and a short manual code exchange.</p>
    {/if}
  </header>
  {#if joinError}<p class="error" role="alert">{joinError}</p>{/if}
  {#if phase === "invite"}
    <section class="join-panel" aria-label="Join a game">
      <div class="panel-heading">
        <h2>Game invite</h2>
        <p>
          Paste the invite link or the full <code>#room=…&amp;k=…</code> fragment
          from the host.
        </p>
      </div>
      <label for="invite-input">Invite link or room fragment</label>
      <textarea
        id="invite-input"
        rows="3"
        bind:value={inviteText}
        placeholder="#room=…&amp;k=…"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"></textarea>
      <button
        id="join-connect"
        type="button"
        onclick={() => void connect(inviteText)}
      >
        Connect to game
      </button>
    </section>
  {:else if phase === "exchange" || phase === "dead"}
    <section class="join-panel exchange-panel" class:reconnect={phase === "dead"} aria-label="Signaling exchange">
      {#if phase === "dead"}
        <p class="error" id="disconnect-notice" role="alert">
          Host disconnected — connection lost.
        </p>
      {/if}
      <div class="panel-heading">
        <h2>Secure connection</h2>
        <p>
          Copy your code to the host. Then paste the host's answer below and
          apply it.
        </p>
      </div>
      <div class="code-field">
        <label for="offer-out"
          >Your player code <span class="required-note">(send to host)</span
          ></label
        >
        <textarea
          id="offer-out"
          class="signal-code"
          rows="5"
          readonly
          value={hostCode}
          spellcheck="false"
          aria-describedby="offer-help"></textarea>
        <div class="field-actions">
          <button
            id="copy-offer-out"
            class="secondary"
            type="button"
            disabled={!hostCode}
            onclick={() => void copyCode(hostCode, "player code")}
            >Copy player code</button
          >
          <p id="offer-help" class="hint">
            Give this one-time code to the host.
          </p>
        </div>
      </div>
      <div class="code-field">
        <label for="answer-input">Host's answer code</label>
        <textarea
          id="answer-input"
          class="signal-code"
          rows="5"
          bind:value={answerText}
          placeholder="Paste the host's answer here"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"></textarea>
      </div>
      <button id="answer-apply" type="button" onclick={applyAnswer}
        >Apply host code</button
      >
      <p class="hint status-line" aria-live="polite">
        Connection state: <strong>{connState}</strong>
      </p>
      {#if copyStatus}<p class="copy-status" role="status">{copyStatus}</p>{/if}
    </section>
  {/if}


  {#if phase === "live" || phase === "dead"}
    {#if canvasError}<p class="error" role="alert">canvas: {canvasError}</p>{/if}
    <section class="shell" aria-label="Player shell">
      <div class="canvas-area">
        <div class="board">
          <div class="toolrail">
            <CanvasToolbar
              bind:active={canvasTool}
              bind:collapsed={canvasToolbarCollapsed}
              settings={toolOptions}
              cellSize={activeScene()?.grid.size ?? 100}
              onRoll={rollFromToolbar}
              onAction={runCanvasAction}
            />
          </div>
          <div
          class="canvas-host"
          bind:this={canvasHost}
          role="application"
          aria-label="Game board"
          tabindex="-1"
          onpointerdown={() => closeHexMenu()}
        >
          {#if measurePreview}
            {@const pts = measurePreview.points.map(measurePoint)}
            {@const tail = pts.at(-1) ?? null}
            {@const areaPts = measurePreview.area ? templateOutline(measurePreview.area).map(measurePoint) : null}
            <svg class="measure-preview" aria-label={`Measurement ${measureReadout(measurePreview.distance)}`}>
              <polyline points={pts.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#f4c95d" stroke-width="3" stroke-dasharray="8 5" />
              {#if measurePreview.radiusPx && pts[0]}
                <circle cx={pts[0].x} cy={pts[0].y} r={measurePreview.radiusPx * (stage?.camera.scale ?? 1)} fill="#f4c95d22" stroke="#f4c95d" stroke-width="2" />
              {/if}
              {#if areaPts && areaPts.length > 1}
                <polygon points={areaPts.map((p) => `${p.x},${p.y}`).join(" ")} fill="#f4c95d1a" stroke="#f4c95d" stroke-width="2" stroke-dasharray="4 4" />
              {/if}
              {#if tail}
                <text x={tail.x + 8} y={tail.y - 8} fill="#fff" stroke="#111" stroke-width="3" paint-order="stroke">{measureReadout(measurePreview.distance)}</text>
              {/if}
            </svg>
          {/if}
          {#if shapePreview}
            {@const preview = shapePreview}
            <svg class="shape-preview" aria-label="Tool preview" data-shape-preview={preview.kind}>
              {#if preview.kind === "draw"}
                {@const a = measurePoint(preview.from)}
                {@const b = measurePoint(preview.to)}
                {#if preview.shape === "rect" || preview.shape === "ellipse"}
                  <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} rx={preview.shape === "ellipse" ? Math.abs(b.x - a.x) / 2 : 0} ry={preview.shape === "ellipse" ? Math.abs(b.y - a.y) / 2 : 0} fill={`${preview.style.stroke}22`} stroke={preview.style.stroke} stroke-width={preview.style.strokeWidth} />
                {:else}
                  <polyline points={[...preview.points, preview.to].map((p) => { const q = measurePoint(p); return `${q.x},${q.y}`; }).join(" ")} fill="none" stroke={preview.style.stroke} stroke-width={preview.style.strokeWidth} stroke-dasharray="6 4" />
                {/if}
              {:else if preview.kind === "fog"}
                {@const a = measurePoint(preview.from)}
                {@const b = measurePoint(preview.to)}
                <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} fill={preview.brush === "hide" ? "#0a0f1599" : "#ffd47933"} stroke={preview.brush === "hide" ? "#8892a6" : "#ffd479"} stroke-width="2" stroke-dasharray="6 4" />
              {:else}
                {@const a = measurePoint(preview.from)}
                {@const b = measurePoint(preview.to)}
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#ff9f6e" stroke-width="4" stroke-dasharray="10 5" />
              {/if}
            </svg>
          {/if}
          {#if textDraft}
            {@const anchor = measurePoint(textDraft.at)}
            <div class="text-editor" style={`left:${anchor.x}px; top:${anchor.y}px;`}>
              <!-- svelte-ignore a11y_autofocus -->
              <textarea
                data-text-editor
                autofocus
                aria-label="Text label"
                bind:value={textDraft.value}
                onkeydown={(event) => {
                  if (event.key === "Escape") { event.preventDefault(); commitTextDraft(); }
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commitTextDraft(); }
                }}
              ></textarea>
              <div class="text-editor-actions">
                <button type="button" data-text-commit onclick={() => commitTextDraft()}>Done</button>
                <button type="button" onclick={() => (textDraft = null)}>Cancel</button>
              </div>
            </div>
          {/if}
          {#if hexMenu}
            <!-- D-271: a player's reduced hex menu — the player text, and where the party is. -->
            <div
              class="hex-menu"
              data-hex-menu={hexMenu.key}
              data-hex-menu-title={hexMenu.title}
              onpointerdown={(ev) => ev.stopPropagation()}
              style={`left: ${Math.round(hexMenu.x)}px; top: ${Math.round(hexMenu.y)}px;`}
              role="menu"
              tabindex="-1"
              aria-label={`Hex ${hexMenu.key} actions`}
            >
              <span class="hex-menu-title">{hexMenu.title}</span>
              {#if hexMenu.subtitle}
                <span class="hex-menu-static" data-hex-menu-subtitle>{hexMenu.subtitle}</span>
              {/if}
              {#each hexMenu.entries as entry (entry.id)}
                {#if entry.statik}
                  <span class="hex-menu-static" data-hex-menu-static={entry.id}>{entry.label}</span>
                {:else}
                  <button
                    type="button"
                    role="menuitem"
                    data-hex-menu-action={entry.id}
                    disabled={entry.disabled}
                    title={entry.reason ?? ""}
                    onclick={() => runHexMenuEntry(entry.id)}
                    >{entry.label}</button
                  >
                {/if}
              {/each}
            </div>
          {/if}
          </div>
        </div>
        {#if app?.client}
          <WindowHost
            manager={wm}
            windows={wmWindows}
            client={app.client}
            bus={app.bus}
            sceneId={activeScene()?._id ?? null}
            onPickSummon={requestSummonPick}
            onUndo={() => undefined}
            onRedo={() => undefined}
            bindings={DEFAULT_BINDINGS}
            {resolveAsset}
            isGM={false}
          />
        {/if}
        {#if pendingSummonPick}
          {@const summonScene = activeScene()}
          {#if summonScene && summonScene._id === pendingSummonPick.options.sceneId}
            {@const resolved = resolveCrosshairPick(summonScene,
              summonCrosshairOptions(summonScene, pendingSummonPick.options))}
            <CrosshairOverlay options={resolved.options} request={resolved.request}
              camera={() => stage?.camera ?? { x: 0, y: 0, scale: 1 }}
              pick={(placement) => settleSummonPick(placement.point)} cancel={() => settleSummonPick(null)} />
          {/if}
        {/if}
      </div>
      <aside class="sidebar" data-player-dock aria-label="Player content">
        <div class="dock-heading"><div><span class="dock-eyebrow">AT YOUR TABLE</span><h2>{playerTab === "chat" ? "Chat" : "Characters"}</h2></div></div>
        <nav class="player-tabs" aria-label="Player content tabs">
          <button data-player-tab="chat" type="button" class:active={playerTab === "chat"}
            aria-label="Chat" title="Chat" onclick={() => (playerTab = "chat")}><Icon name="chat" size={19}/><span>Chat</span></button>
          <button data-player-tab="actors" type="button" class:active={playerTab === "actors"}
            aria-label="Characters" title="Characters" onclick={() => (playerTab = "actors")}><Icon name="actors" size={19}/><span>Characters</span></button>
        </nav>
        <div class="tabbody" data-player-active-tab={playerTab}>
          {#if app?.client}
            {#if playerTab === "chat"}
              <ChatPanel client={app.client} bus={app.bus}
                targetTokenId={selection.length === 1 ? (selection[0] ?? null) : null} />
            {:else}
              <SheetPanel client={app.client} bus={app.bus} onOpenActor={openActorSheet} />
            {/if}
          {/if}
        </div>
        {#if app?.client}<div class="dock-footer"><QuickbarRow client={app.client} actor={quickbarActor} targets={quickbarTargets} /></div>{/if}
      </aside>
    </section>
    {#if guideOpen}
      <div class="player-guide" data-player-guide role="dialog" aria-modal="false" aria-labelledby="guide-title" tabindex="-1"
        bind:this={guideFocus} onkeydown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeGuide(); } }}>
        <header class="guide-heading"><div><span class="dock-eyebrow">TABLE GUIDE</span><h2 id="guide-title">Session & guide</h2></div>
          <button data-icon-button class="guide-close" type="button" aria-label="Close guide" title="Close guide" onclick={closeGuide}><Icon name="x" /></button>
        </header>
        <div class="guide-content">
          <p>Everything you need to join the adventure. You can return here anytime from the top bar.</p>
          {#if app?.client}
            <section class="guide-card"><h3>Getting started</h3>
              <OnboardingPanel steps={onboarding} storageKey="vtt-onboarding-player" title="Getting started" />
            </section>
          {/if}
          <section class="guide-card"><h3>Effects on this device</h3>
            <FxViewPrefsPanel />
          </section>
          <section class="guide-card"><h3>Connection</h3>
            <p>Playing as <strong>{playerName}</strong> in {worldName}.</p>
            <p>Connection state: <strong>{connState}</strong></p>
            <p class="hint">If your connection drops, the code exchange will appear here so you can reconnect.</p>
          </section>
        </div>
      </div>
    {/if}
  {/if}
</main>
<style>
  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    padding: clamp(24px, 4vw, 48px) clamp(16px, 4vw, 56px);
    background:
      radial-gradient(circle at 78% 3%, #19423e 0%, transparent 43%),
      radial-gradient(circle at 18% 75%, #203142 0%, transparent 45%), #0c141d;
  }
  .join-header {
    width: min(100%, 760px);
    text-align: center;
  }
  .eyebrow {
    margin: 0 0 8px;
    color: #8ce5cf;
    font-size: 0.8rem;
    font-weight: 800;
    letter-spacing: 0.18em;
  }
  h1 {
    margin: 0;
    color: #f4f7fb;
    font-size: clamp(2rem, 5vw, 3.25rem);
    line-height: 1.1;
    letter-spacing: -0.03em;
  }
  .sub {
    max-width: 620px;
    margin: 10px auto 0;
    color: #bdc9d6;
    font-size: 1.05rem;
  }
  .join-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(100%, 720px);
    margin: 0;
    padding: clamp(18px, 3vw, 28px);
    border: 1px solid #48646a;
    border-radius: 14px;
    background: #192b35f5;
    box-shadow: 0 20px 58px #0007;
  }
  .panel-heading h2 {
    margin: 0;
    color: #f2f5f8;
    font-size: 1.35rem;
  }
  .panel-heading p {
    margin: 6px 0 0;
    color: #bdc9d6;
    font-size: 0.95rem;
  }
  code {
    padding: 2px 5px;
    border: 1px solid #405369;
    border-radius: 4px;
    background: #0d151f;
    color: #c6e5ff;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  label {
    font-weight: 700;
  }
  textarea {
    width: 100%;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 1rem;
    line-height: 1.5;
    background: #0d151f;
    color: #edf6ff;
    border: 1px solid #50677f;
    border-radius: 8px;
    padding: 12px;
  }
  textarea::placeholder {
    color: #7f93a7;
  }
  textarea:read-only {
    background: #101d2b;
    border-color: #5b7895;
  }
  #invite-input {
    min-height: 96px !important;
  }
  .signal-code {
    min-height: 138px !important;
    white-space: pre;
    overflow-x: auto;
    overflow-y: auto;
    overflow-wrap: normal;
    resize: vertical;
  }
  button {
    padding: 12px 18px;
    border: 1px solid #52708e;
    border-radius: 9px;
    background: #1c2d3e;
    color: #f2f5f8;
    cursor: pointer;
    font-weight: 700;
  }
  button:hover:not(:disabled) {
    background: #2a4862;
    border-color: #79c5ff;
  }
  button:disabled {
    opacity: 0.55;
  }
  .join-panel > button:not(.secondary) {
    background: #28675d;
    border-color: #72cdb9;
  }
  .join-panel > button:not(.secondary):hover:not(:disabled) {
    background: #377e71;
  }
  .code-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .required-note {
    color: #aebdcb;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .field-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .field-actions .secondary {
    flex: 0 0 auto;
    padding-inline: 14px;
  }
  .field-actions .hint {
    flex: 1 1 220px;
  }
  .hint {
    margin: 0;
    color: #aebdcb;
    font-size: 0.875rem;
  }
  .status-line {
    padding-top: 4px;
    border-top: 1px solid #2f4153;
  }
  .copy-status {
    margin: 0;
    color: #81e0b4;
    font-size: 0.9rem;
  }
  .error {
    width: min(100%, 720px);
    margin: 0;
    color: #ffb4b4;
    font-size: 1rem;
  }
  .shell {
    display: flex;
    gap: 14px;
    width: min(100%, 1440px);
    height: min(780px, calc(100vh - 180px));
    min-height: 520px;
    padding: 12px;
    border: 1px solid #2f4052;
    border-radius: 14px;
    background: #101923;
    box-shadow: 0 16px 40px #0005;
  }
  .sidebar {
    width: 280px;
    flex: 0 0 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .notify-stack {
    display: grid;
    gap: 4px;
    max-width: 34ch;
    margin: 0 10px;
  }
  .notify {
    padding: 4px 8px;
    border: 1px solid #7a5a2a;
    border-radius: 4px;
    background: #2a2113;
    color: #ffdca6;
    font-size: 0.75rem;
    line-height: 1.25;
  }
  #pstatus {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 12px;
    border: 1px solid #40566d;
    border-radius: 9px;
    background: #172331;
    font-size: 0.95rem;
    color: #cbd8e5;
  }
  #pstatus strong {
    color: #f2f5f8;
    font-size: 1.1rem;
  }
  .canvas-area {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .board {
    display: flex;
    height: 100%;
    min-height: 280px;
  }
  /* D-255: the rail is a column of its own — it never covers the map or a window. */
  .toolrail {
    flex: 0 0 auto;
    display: flex;
  }
  .canvas-host {
    flex: 1;
    min-width: 0;
    height: 100%;
    min-height: 280px;
    border: 1px solid #40566d;
    border-radius: 10px;
    overflow: hidden;
    background: #0a0f15;
  }
  .canvas-host :global(canvas) {
    display: block;
  }
  /* D-271: the player's hex menu (the canvas area is the positioned ancestor). */
  .hex-menu {
    position: absolute;
    z-index: 14;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 220px;
    padding: 8px;
    background: #1a2a24;
    border: 1px solid #4f7f66;
    border-radius: 9px;
    box-shadow: 0 8px 24px #0009;
  }
  .hex-menu-title {
    font-weight: 700;
    padding: 4px 8px;
  }
  .hex-menu-static {
    opacity: 0.85;
    padding: 6px 8px;
  }
  .hex-menu button {
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    padding: 6px 8px;
    cursor: pointer;
  }
  .hex-menu button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  /* D-256: draw/fog gesture preview and the in-canvas text editor (player shell) */
  .shape-preview,
  .measure-preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 10;
    overflow: visible;
  }
  .shape-preview {
    z-index: 11;
  }
  .text-editor {
    position: absolute;
    z-index: 12;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border: 1px solid #4c5b7d;
    border-radius: 5px;
    background: #111827f2;
  }
  .text-editor textarea {
    width: 220px;
    height: 62px;
    padding: 5px;
    color: #fff;
    background: #0c111b;
    border: 1px solid #3a455e;
    border-radius: 3px;
    resize: both;
  }
  .text-editor-actions {
    display: flex;
    gap: 4px;
  }
  @media (max-width: 760px) {
    main {
      align-items: stretch;
      padding: 20px 12px;
    }
    .join-header {
      text-align: left;
    }
    .join-panel,
    .error {
      width: 100%;
    }
    .shell {
      flex-direction: column;
      height: auto;
      min-height: 0;
    }
    .sidebar {
      width: 100%;
      flex-basis: auto;
      max-height: 420px;
    }
    .canvas-area {
      min-height: 58vh;
    }
  }

  /* Once connected, the player's board uses the same full-viewport workspace
     as the GM. The initial invite/code exchange remains a focused setup page. */
  main.player-live {
    width: 100%;
    height: 100dvh;
    min-height: 480px;
    padding: 0;
    gap: 0;
    align-items: stretch;
    overflow: hidden;
    background: #0c141d;
  }
  .join-header.live-header {
    flex: 0 0 70px;
    width: 100%;
    min-height: 70px;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 16px;
    border-bottom: 1px solid #344352;
    background: #17222e;
    box-shadow: 0 2px 16px #0004;
    text-align: left;
    z-index: 23;
  }
  .live-header .brand-badge {
    flex: 0 0 36px;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 11px;
    background: linear-gradient(145deg, #8be8d0, #459d99);
    color: #142933;
    font-size: 1.55rem;
    line-height: 1;
  }
  .player-identity { flex: 0 1 190px; min-width: 95px; overflow: hidden; }
  .live-header .eyebrow { margin: 0 0 2px; color: #7ce3ca; font-size: .63rem; font-weight: 800; letter-spacing: .13em; white-space: nowrap; }
  .live-header .eyebrow span { color: #96aaaf; font-weight: 650; }
  .live-header h1 { overflow: hidden; color: #f5fafb; font-size: 1.12rem; font-weight: 750; line-height: 1.2; letter-spacing: -.018em; white-space: nowrap; text-overflow: ellipsis; }
  #pstatus {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    overflow: hidden;
    padding: 0;
    border: 0;
    background: transparent;
    color: #b6c7d0;
    font-size: .76rem;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  #pstatus .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .connection-badge {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 9px;
    border: 1px solid #335850;
    border-radius: 20px;
    background: #1a3537;
    color: #b8e9d9;
    font-size: .72rem;
    font-weight: 650;
  }
  .connection-badge.disconnected { border-color: #835455; background: #3f292e; color: #ffc0b8; }
  .connection-dot { width: 7px; height: 7px; border-radius: 50%; background: #66dbc0; box-shadow: 0 0 7px #6cebd28c; }
  .disconnected .connection-dot { background: #f1a995; box-shadow: none; }
  .player-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; }
  .player-actions button {
    display: grid;
    place-items: center;
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: #bacbd3;
  }
  .player-actions button:hover, .player-actions button[aria-expanded="true"] { background: #2a3e49; border-color: #52998d; color: #eafff9; }
  .player-live .error { width: 100%; padding: 8px 16px; background: #38262a; font-size: .85rem; }
  .player-live .shell {
    flex: 1 1 auto;
    display: flex;
    flex-direction: row;
    gap: 0;
    width: 100%;
    min-width: 0;
    min-height: 0;
    height: auto;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: #101a24;
    box-shadow: none;
  }
  .player-live .canvas-area { order: 0; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .player-live .board { flex: 1 1 auto; height: auto; min-height: 0; }
  .player-live .toolrail { min-height: 0; }
  .player-live .canvas-host { flex: 1 1 auto; min-width: 0; min-height: 0; height: auto; overflow: hidden; border: 0; border-radius: 0; background: #0d151e; }
  .player-live .sidebar {
    order: 1;
    flex: 0 0 clamp(312px, 25vw, 376px);
    width: clamp(312px, 25vw, 376px);
    min-height: 0;
    max-height: none;
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow: hidden;
    padding: 0;
    border-left: 1px solid #344657;
    background: #16222e;
  }
  .dock-heading { flex: 0 0 60px; min-height: 60px; display: flex; align-items: center; padding: 8px 15px; }
  .dock-eyebrow { color: #81d4c5; font-size: .64rem; font-weight: 800; letter-spacing: .13em; }
  .dock-heading h2, .guide-heading h2 { margin: 1px 0 0; font-size: .98rem; font-weight: 700; color: #f0f8f9; }
  .player-tabs { flex: 0 0 auto; display: flex; min-height: 46px; padding: 0 10px; border-bottom: 1px solid #3b4b59; }
  .player-tabs button {
    flex: 1 1 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 44px;
    padding: 7px 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: #a8b9c4;
    font-size: .83rem;
    font-weight: 600;
  }
  .player-tabs button:hover { background: #243440; color: #effcfa; }
  .player-tabs button.active { border-bottom-color: #74d9c5; background: #1b3037; color: #b9f7e4; }
  .tabbody { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 13px 14px; background: #15222d; }
  .tabbody :global(.chat) { min-height: 100%; height: 100%; }
  .tabbody :global(#chat-log) { flex: 1 1 auto; max-height: none; min-height: 120px; border-color: #344957; background: #101a24; }
  .dock-footer { flex: 0 0 auto; max-height: 170px; overflow-y: auto; padding: 9px 12px; border-top: 1px solid #3a4b59; background: #192834; }
  .player-guide {
    position: fixed;
    top: 70px;
    right: 0;
    bottom: 0;
    z-index: 70;
    width: min(440px, 100vw);
    display: flex;
    flex-direction: column;
    border: 1px solid #4b6d73;
    border-right: 0;
    border-bottom: 0;
    border-radius: 14px 0 0 0;
    background: #172530;
    box-shadow: -20px 0 60px #050a11a8;
  }
  .guide-heading { flex: 0 0 70px; display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; border-bottom: 1px solid #405460; background: #1a2b36; border-radius: 14px 0 0 0; }
  .guide-heading h2 { font-size: 1.25rem; }
  .guide-close { display: grid; place-items: center; width: 36px; min-width: 36px; height: 36px; min-height: 36px; padding: 0; border: 1px solid #49616c; border-radius: 9px; background: #293d48; color: #d2e1e4; }
  .guide-content { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; padding: 18px; color: #b0c5cb; font-size: .87rem; }
  .guide-content > p, .guide-card p { margin: 0 0 8px; }
  .guide-card { padding: 15px; border: 1px solid #405564; border-radius: 11px; background: #1c2b37; }
  .guide-card h3 { margin: 0 0 10px; font-size: .92rem; color: #eff7f7; }
  .join-panel.exchange-panel.reconnect {
    position: fixed;
    top: 70px;
    right: 0;
    bottom: 0;
    z-index: 81;
    width: min(440px, 100vw);
    overflow-y: auto;
    border-radius: 14px 0 0 0;
    border-right: 0;
    border-bottom: 0;
    background: #1a2a36;
    box-shadow: -20px 0 60px #050a11a8;
  }
  @media (max-width: 930px) {
    .player-live .sidebar { flex-basis: 306px; width: 306px; }
  }
  @media (max-width: 710px) {
    .join-header.live-header { flex-basis: 60px; min-height: 60px; gap: 8px; padding-inline: 8px; }
    .live-header .brand-badge { display: none; }
    .player-identity { flex: 0 0 125px; min-width: 0; }
    .player-identity .eyebrow span { display: none; }
    #pstatus { flex: 1 1 auto; justify-content: flex-end; }
    #pstatus > span:not(.connection-badge) { display: none; }
    .player-live .shell { flex-direction: column; }
    .player-live .canvas-area { flex: 1 1 auto; min-height: 0; }
    .player-live .sidebar { order: 1; flex: 0 0 min(42dvh, 360px); width: 100%; max-height: none; border-left: 0; border-top: 1px solid #344657; }
    .dock-heading { flex-basis: 44px; min-height: 44px; }
    .dock-eyebrow { display: none; }
    .tabbody :global(#chat-log) { min-height: 80px; }
    .dock-footer { display: block; max-height: 80px; overflow-y: auto; padding: 4px 12px; }
    .player-guide, .join-panel.exchange-panel.reconnect { top: 60px; }
  }
</style>
