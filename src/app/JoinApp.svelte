<script lang="ts">
  import { onMount } from "svelte";
  import { bootPlayerApp, type PlayerApp } from "./joinBoot";
  import { parseInvite } from "./hostShare";
  import { createStage, type Stage } from "../canvas/stage";
  import { screenToWorld, worldToScreen, zoomAt } from "../canvas/camera";
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
    type TokenView,
  } from "../canvas/interactions";
  import { can } from "../core/permissions";
  import { ChatPanel } from "../ui/chat";
  import { QuickbarRow } from "../ui/quickbar";
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

  function activeScene(): SceneDocument | null {
    const client = app?.client;
    if (!client) return null;
    const scene = client.store.get("scenes", "scene-1");
    return (
      scene ??
      (client.store.getAll("scenes") as readonly SceneDocument[])[0] ??
      null
    );
  }

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
          if (GESTURE_TOOLS.has(canvasTool)) toolController.finishPoly();
        };
        const onTextEdit = (e: MouseEvent) => {
          if (canvasTool !== "text" || e.button !== 0) return;
          editTextAt(toWorld({ clientX: e.clientX, clientY: e.clientY } as PointerEvent));
        };
        canvas.addEventListener("pointerdown", toolDown); canvas.addEventListener("pointermove", toolMove); canvas.addEventListener("pointerup", toolUp);
        canvas.addEventListener("contextmenu", onToolContext);
        canvas.addEventListener("dblclick", onTextEdit);
        globalThis.addEventListener("keydown", onToolKey);
        toolCleanup = () => {
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
          },
          onTokenActivate: ({ token }) => {
            if (token.actorId) openActorSheet(token.actorId);
          },
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
      offWm();
      toolCleanup?.();
      toolCleanup = null;
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

<main class="vtt-ui">
  <header class="join-header">
    <p class="eyebrow">ARENASTAR</p>
    <h1>Join a game</h1>
    <p class="sub">
      Connect to a host with an invite link and a short manual code exchange.
    </p>
  </header>
  {#if joinError}
    <p class="error" role="alert">{joinError}</p>
  {/if}

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
    <section class="join-panel exchange-panel" aria-label="Signaling exchange">
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
    {#if canvasError}
      <p class="error">canvas: {canvasError}</p>
    {/if}
    <section class="shell" aria-label="Player shell">
      <aside class="sidebar">
        <div id="pstatus">
          <strong>{worldName}</strong>
          <span>{playerName}</span>
          <span>seq {seq}</span>
          <span>tokens {tokenCount}</span>
        </div>
        {#if app?.client}
          <QuickbarRow
            client={app.client}
            actor={quickbarActor}
            targets={quickbarTargets}
          />
          <ChatPanel
            client={app.client}
            bus={app.bus}
            targetTokenId={selection.length === 1 ? (selection[0] ?? null) : null}
          />
          <SheetPanel
            client={app.client}
            bus={app.bus}
            onOpenActor={openActorSheet}
          />
        {/if}
      </aside>
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
          </div>
        </div>
        {#if app?.client}
          <WindowHost
            manager={wm}
            windows={wmWindows}
            client={app.client}
            bus={app.bus}
            onUndo={() => undefined}
            onRedo={() => undefined}
            bindings={DEFAULT_BINDINGS}
            isGM={false}
          />
        {/if}
      </div>
    </section>
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
      radial-gradient(circle at 85% 0%, #203d56 0%, transparent 42%), #0d1117;
  }
  .join-header {
    width: min(100%, 760px);
    text-align: center;
  }
  .eyebrow {
    margin: 0 0 8px;
    color: #66b7ff;
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
    border: 1px solid #41566d;
    border-radius: 14px;
    background: #151f2aee;
    box-shadow: 0 16px 40px #0005;
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
    background: #1f689b;
    border-color: #69baf2;
  }
  .join-panel > button:not(.secondary):hover:not(:disabled) {
    background: #2d82bb;
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
</style>
