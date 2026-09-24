<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { detectCapabilities } from "./capabilities";
  import { DEFAULT_SCENE_ID, GM_USER_ID, makeToken, type HostApp } from "./hostBoot";
  import { createAgentManager, type AgentManager } from "./agentManager";
  import { createStage, type Stage } from "../canvas/stage";
  import { tokenRect } from "../canvas/tokens";
  import type { RollHighlightRect } from "../canvas/layers/RollHighlightLayer";
  import { tokenBadgesMap } from "../packages/pf1e/tokenBadges";
  import { tokenHpBarsMap } from "../packages/pf1e/tokenHpBars";
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
    pickToken,
    type TokenView,
  } from "../canvas/interactions";
  import {
    exportWorldToFolder,
    exportWorldZip,
  } from "../host/worldFile";
  import { ChatPanel } from "../ui/chat";
  import { QuickbarRow } from "../ui/quickbar";
  import OnboardingPanel from "../ui/onboarding/OnboardingPanel.svelte";
  import { CombatPanel } from "../ui/combat";
  import {
    applyTokenMenuEntry,
    tokenContextMenuModel,
  } from "../ui/combat/tokenContextMenu";
  import {
    activateEncounter,
    newEncounter,
    selectedEncounter,
  } from "../ui/combat/encounters";
  import { JournalsPanel } from "../ui/journals";
  import { WindowHost } from "../ui/windows";
  import { WindowManager } from "../ui/windows";
  import { macroSlots, runChatMacro } from "../ui/macros";
  import { resolveFxSequence, type FxImportPermissions } from "../core/fx";
  import { gmState } from "../ui/armies/gmState.svelte";
  import { buildStrategicFog, sceneIsStrategic } from "../core/strategicFog";
  import { FogExploration } from "../client/fogExploration";
  import { createVisionComputer } from "../workers/visionComputer";
  import { ModuleIframe } from "../packages/moduleIframe";
  import { dice3dStats, diceInfoFromRecord, showDice3D } from "../dice/dice3d";
  import { verifyCommitRoll } from "../dice/commitReveal";
  import { PoolInterpolator } from "../sim/interpolate";
  import { TrustedModuleHost } from "../packages/trustedModule";
  import { screenToWorld, worldToScreen, zoomAt } from "../canvas/camera";
  import SummonCrosshair from "../ui/macros/SummonCrosshair.svelte";
  import type { RequestSummonPick, SummonPickOptions, SummonPickPoint } from "../ui/macros/summonPicker";
  import AnchorPicker from "../ui/macros/AnchorPicker.svelte";
  import type { AnchorPickOptions, AnchorPickPoint, RequestAnchorPick } from "../ui/macros/anchorPicker";
  import type { PreviewFxSequence } from "../ui/macros/fxPreview";
  import Icon from "../ui/icons/Icon.svelte";
  import CanvasToolbar, {
    type CanvasAction,
    type CanvasLayer,
    type CanvasTool,
    type RollMode,
  } from "../ui/canvas/CanvasToolbar.svelte";
  import { ToolInteractionController } from "../canvas/tools/controller";
  import {
    doorToggleDiff,
    wallFieldsFor,
    wallKindName,
    wallPickAt,
  } from "../canvas/vision/wallKinds";
  import { displayDistance } from "../canvas/grid/measure";
  import { rulerLabel } from "../canvas/ephemera";
  import { canEditDrawing, drawingForText } from "../canvas/tools/drawing";
  import { drawingBounds } from "../canvas/layers/drawingGeometry";
  import { buildChatMessage, parseChatCommand } from "../core/chat";
  import CompendiaPanel from "../ui/compendia/CompendiaPanel.svelte";
  import {
    createModuleHandlers,
    type ModuleHost,
  } from "../packages/moduleHandlers";
  import type { ModuleHookName } from "../core/moduleApi";
  import { getFog, getSetting } from "../storage/idb";
  import { viewAsOptions, viewAsUser, withoutHiddenTokens } from "../core/viewAs";
  import { can } from "../core/permissions";
  import { tileContainsPoint } from "../core/automation";
  import { sceneFogSettings } from "../core/fogExploration";
  import { createHexOverlaySync, repaintHexOverlay, syncHexOverlay } from "./hexOverlay";
  import {
    encounterCheck,
    encounterPromptMessage,
    encounterResultMessage,
    openPromptFor,
    rollTableNow,
  } from "../core/hexcrawl/encounterFlow";
  import { isCellOpen, partyCellKey } from "../core/hexcrawl/visibility";
  import { cellCenterOf } from "../core/hexcrawl/cells";
  import {
    partyTokenOf,
    routePointsOf,
    stepCostOf,
    routeSeconds,
    stepSecondsOf,
    partyPositionOps,
    travelAdvance,
    travelProgressOps,
  } from "../core/hexcrawl/travel";
  import {
    encounterPhase,
    triggersForExplore,
    triggersForFight,
    triggersForStep,
    type EncounterTrigger,
  } from "../core/hexcrawl/encounter";
  import { hexcrawlProfileOf } from "../core/hexcrawl/types";
  import { hexTravel } from "../core/hexcrawl/strings";
  import { encounterPayloadOf } from "../core/hexcrawl/encounterFlow";
  import {
    advanceWorldClockOps,
    pf1eClockSweepOps,
    readWorldClock,
  } from "../packages/pf1e/worldClock";
  import {
    secondsPerRoundOf,
    worldSettingsFrom as coreWorldSettingsFrom,
  } from "../core/worldSettings";
  import { DAY_SECONDS, HOUR_SECONDS, secondsUntilHour } from "../core/clock";
  import { EXPLORE_SECONDS } from "../core/hexcrawl/encounterFlow";
  import {
    encounterResultId,
    encounterResultOf,
    openEncounterResult,
    resolveEncounterRefs,
    type ResolvedRef,
  } from "../ui/hexcrawl/encounterResult";
  import {
    encounterTokenData,
    placeEncounterTokens,
    type PlacementEntry,
    type PlacementPoint,
  } from "../core/hexcrawl/placement";
  import { duplicateSceneOps } from "../core/sceneCopy";
  import { logEncounterOps } from "../core/hexcrawl/encounter";
  import { cellAtPoint } from "../core/hexcrawl/cells";
  import { terrainCatalogOrDefault } from "../core/hexcrawl/terrain";
  import {
    featureFoundMessage,
    formatDuration,
    revealDueFeatures,
    type FeatureFacts,
  } from "../core/hexcrawl/features";
  import {
    DEFAULT_SPEED_PER_DAY,
    type TravelPace,
    type TravelPlan,
  } from "../core/hexcrawl/types";
  import { isHexcrawlScene } from "../core/hexcrawl/types";
  import { sightReconcileOps } from "../core/hexcrawl/visibility";
  import {
    applyHexMenuEntry,
    hexContextMenuModel,
    type HexMenuEntry,
  } from "../ui/hexcrawl/hexContextMenu";
  import {
    NO_ONBOARDING_FACTS,
    onboardingSteps,
    type OnboardingFacts,
  } from "../core/onboarding";
  import {
    DEFAULT_TOOL_OPTIONS,
    type MeasurePreview,
    type ShapePreview,
    type ToolOptions,
    type WallKind,
  } from "../canvas/tools/controller";
  import { templateOutline } from "../canvas/layers/templateGeometry";
  import {
    appendFogMask,
    fogMaskLog,
    fogMaskOps,
    sceneRectPoly,
    type FogMaskOp,
  } from "../core/fogMask";
  import { createMassBattleBasic } from "../packages/massBattleBasic";
  import type {
    ArmyDocument,
    FactionDocument,
    UnitDocument,
  } from "../core/strategic";
  import { DEFAULT_BINDINGS, actionForCombo, comboOf, isTypingTarget } from "../core/keys";
  import { globalHooks } from "../core/events";
  import type { GridSpec } from "../canvas/grid";
  import { TablesPanel } from "../ui/tables";
  import { PlaylistsPanel } from "../ui/playlists";
  import { AudioPlayer } from "../client/audioPlayer";
  import { FxPlayer } from "../client/fxPlayer";
  import { onDestroy } from "svelte";
  import { openPF1eSheetWindow } from "../ui/sheets/pf1eSheetWindow";
  import { SheetPanel } from "../ui/sheets";
  import { startHostShare, type HostShare } from "./hostShare";
  import type {
    ActorDocument,
    CellFeature,
    CombatDocument,
    LightDocument,
    NoteDocument,
    SceneDocument,
    SceneGrid,
    UserDocument,
    WallDocument,
  } from "../core/documents";
  import { OWNERSHIP_LEVELS } from "../core/documents";
  import type { Op } from "../core/ops";
  import {
    encumbranceOptionsOf,
    tokenHpBarsOf,
    worldSettingsFrom,
  } from "../core/worldSettings";
  import { installGmFogE2e } from "./e2eHook";
  import { pf1eMovementOpportunities } from "../packages/pf1e/tacticalOpportunity";
  import { pf1eMovePlan } from "../packages/pf1e/movement";
  import { sceneDifficultCells } from "../core/rules";
  import { pf1eThreatModel } from "../packages/pf1e/threatPreview";
  import { deriveFromActorDocument } from "../packages/pf1e/actor";
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
    initialSetup = false,
    onExit = null,
  }: {
    app?: HostApp | null;
    bootError?: string | null;
    /** New-world entry only: give the GM a guided setup surface, not permanent clutter. */
    initialSetup?: boolean;
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

  /**
   * D-271 (plan §5.2): the empty-ground menu — the same gesture as the token menu, on a hex.
   * The *model* is captured when the menu opens (entries, labels, disabled reasons), so the DOM
   * cannot disagree with what the click will do.
   */
  let hexMenu = $state<{
    x: number;
    y: number;
    key: string;
    title: string;
    subtitle: string | null;
    entries: HexMenuEntry[];
  } | null>(null);
  let worldName = $state("—");
  let seq = $state(0);
  let tokenCount = $state(0);
  let activeTab = $state("chat");
  let sessionOpen = $state(untrack(() => initialSetup));
  let sessionFocus = $state<HTMLElement | null>(null);
  let sessionTrigger = $state<HTMLButtonElement | null>(null);
  function openSession(): void {
    sessionOpen = true;
    // The surface is not modal: keep the board usable during a code exchange.
    queueMicrotask(() => sessionFocus?.focus());
  }
  function closeSession(): void {
    sessionOpen = false;
    queueMicrotask(() => sessionTrigger?.focus());
  }
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
  /**
   * §3.2 the agent desk. Null until a host app exists (and for a joined player, who has no host to
   * mint agent users on — agents are a GM surface). The Settings window shows the section only
   * when this is non-null, which is how a player's replica stays unable to grant anything.
   */
  let agents = $state<AgentManager | null>(null);
  let canvasTool = $state<CanvasTool>("select");
  let canvasToolbarCollapsed = $state(false);
  /** D-256: Roll20's layer picker — the GM's active layer (players stay on `tokens`). */
  let canvasLayer = $state<CanvasLayer>("tokens");
  /** D-256: every sub-tool choice the rail edits (shapes, styles, brushes, sizes). */
  let toolOptions = $state<ToolOptions>({ ...DEFAULT_TOOL_OPTIONS, drawingStyle: { ...DEFAULT_TOOL_OPTIONS.drawingStyle } });
  /** D-256: the in-flight draw/fog/wall gesture, drawn as an SVG overlay. */
  let shapePreview = $state<ShapePreview | null>(null);
  /** D-256: the in-canvas text editor (Roll20 types in place instead of prompting). */
  let textDraft = $state<{ at: { x: number; y: number }; value: string; editingId: string | null } | null>(null);
  /** D-256: the open map-pin tooltip. */
  let pinTooltip = $state<{ id: string; x: number; y: number; title: string; body: string; visible: boolean } | null>(null);
  /** D-256: the GM's manual fog mask (strokes, newest last). */
  let fogMask = $state<FogMaskOp[]>([]);
  /** D-256: the last wall/light the rail placed, for "erase last". */
  let lastPlacement = $state<{ kind: "wall" | "light"; id: string } | null>(null);
  /** Screen-pixel pick radius for a map pin (the marker is drawn at a constant size). */
  const PIN_PICK_RADIUS = 16;
/** Wall pick tolerance in screen pixels (D-257). */
const WALL_PICK_RADIUS = 12;
  let loadedMapHash: string | null = null;
  /** `$state.raw`: the stage is a Pixi object graph — assignment must re-run the
   *  effects that read it, but it must never be deep-proxied. */
  let stage = $state.raw<Stage | null>(null);
  let fxPlayer: FxPlayer | null = null;
  let controller: CanvasController | null = null;
  let toolController: ToolInteractionController | null = null;
  /** Bumped when the (async) tool controller exists — the activation effect below re-runs. */
  let toolReady = $state(0);
  let measurePreview = $state<MeasurePreview | null>(null);
  const rollFromToolbar = (formula: string, mode: RollMode = "roll") => {
    if (!app) return;
    const built = buildChatMessage({ author: app.gm.client.user?.id ?? "", parsed: parseChatCommand(`/${mode} ${formula}`) });
    app.gm.client.submit([{ kind: "create", coll: "messages", data: built.message }]);
  };
  /** D-256: the tools whose gesture owns the canvas (everything but select/pan/dice). */
  const GESTURE_TOOLS: ReadonlySet<CanvasTool> = new Set<CanvasTool>([
    "draw",
    "text",
    "measure",
    "fog",
    "wall",
    "light",
    "pin",
  ]);
  const currentGrid = () => {
    const sc = activeScene();
    return sc?.grid
      ? {
          type: sc.grid.type,
          size: sc.grid.size,
          distance: sc.grid.distance,
          diagonals: sc.grid.diagonals,
          layout: sc.grid.hexLayout,
        }
      : null;
  };
  const nextId = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const gmUserId = () => app?.gm.client.user?.id ?? "";
  /** D-256: commit one GM fog brush stroke (op + the live layer). */
  function paintFog(mode: "reveal" | "hide", poly: number[]) {
    const scene = activeScene();
    if (!scene || poly.length < 6) return;
    fogMask = appendFogMask(fogMask, { mode, poly });
    app?.gm.client.submit(fogMaskOps(scene, fogMask));
    stage?.peekFogLayer()?.applyManualMask(fogMask);
  }
  function setWholeSceneFog(mode: "reveal" | "hide") {
    const scene = activeScene();
    if (!scene) return;
    paintFog(mode, sceneRectPoly(scene));
  }
  /** D-256/D-257: place a wall/door/window — grid-snapped, committed as a create. */
  function createWall(wall: {
    kind: WallKind;
    c: [number, number, number, number];
    door: 0 | 1 | 2;
  }) {
    const scene = activeScene();
    if (!scene) return;
    const id = nextId("wall");
    const doc: WallDocument = {
      _id: id,
      type: "wall",
      name: wallKindName(wall.kind),
      ownership: { default: 0 },
      flags: {},
      system: {},
      ...wallFieldsFor(wall.kind, wall.c, wall.door),
    };
    app?.gm.client.submit([
      { kind: "create", coll: "walls", parent: { coll: "scenes", id: scene._id }, data: doc },
    ]);
    lastPlacement = { kind: "wall", id };
  }
  function createLight(light: { x: number; y: number; radius: number; color: string }) {
    const scene = activeScene();
    if (!scene) return;
    const id = nextId("light");
    const doc: LightDocument = {
      _id: id,
      type: "light",
      name: "Light",
      ownership: { default: 0 },
      flags: {},
      system: {},
      x: light.x,
      y: light.y,
      dim: light.radius,
      bright: Math.max(1, Math.round(light.radius / 2)),
      color: light.color,
      alpha: 0.6,
    };
    app?.gm.client.submit([
      { kind: "create", coll: "lights", parent: { coll: "scenes", id: scene._id }, data: doc },
    ]);
    lastPlacement = { kind: "light", id };
  }
  /** D-256 map pin: hidden by default (Roll20), visible = `ownership.default = LIMITED`. */
  function createPin(at: { x: number; y: number }) {
    const scene = activeScene();
    if (!scene) return;
    const doc: NoteDocument = {
      _id: nextId("pin"),
      type: "note",
      name: "Map pin",
      ownership: { default: OWNERSHIP_LEVELS.NONE },
      flags: {},
      system: {},
      x: Math.round(at.x),
      y: Math.round(at.y),
      text: "New pin",
      icon: "pin",
      visible: false,
    };
    app?.gm.client.submit([
      { kind: "create", coll: "notes", parent: { coll: "scenes", id: scene._id }, data: doc },
    ]);
    pinTooltip = { id: doc._id, x: doc.x, y: doc.y, title: doc.text, body: "", visible: false };
  }
  /** The GM's edit of the open pin (text + visibility; visibility is the ownership default). */
  function updatePin(patch: { text?: string; playerText?: string; visible?: boolean; journalId?: string }) {
    const scene = activeScene();
    const pin = scene?.notes.find((n) => n._id === pinTooltip?.id);
    if (!scene || !pin) return;
    const next: NoteDocument = {
      ...pin,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.playerText !== undefined ? { playerText: patch.playerText } : {}),
      ...(patch.journalId !== undefined ? { journalId: patch.journalId } : {}),
      ...(patch.visible !== undefined
        ? { visible: patch.visible, ownership: { ...pin.ownership, default: patch.visible ? OWNERSHIP_LEVELS.LIMITED : OWNERSHIP_LEVELS.NONE } }
        : {}),
    };
    app?.gm.client.submit([
      {
        kind: "update",
        ref: { coll: "notes", id: pin._id, parent: { coll: "scenes", id: scene._id } },
        diff: {
          text: next.text,
          playerText: next.playerText ?? null,
          journalId: next.journalId ?? null,
          visible: next.visible ?? false,
          ownership: next.ownership,
        },
      },
    ]);
    pinTooltip = {
      id: next._id,
      x: next.x,
      y: next.y,
      title: next.text,
      body: next.playerText ?? "",
      visible: next.visible === true,
    };
  }
  /** Commit the text editor's value as a label (or an edit of an existing one). */
  function commitTextDraft() {
    const draft = textDraft;
    textDraft = null;
    const scene = activeScene();
    if (!draft || !scene || !draft.value.trim()) return;
    if (draft.editingId) {
      const existing = scene.drawings.find((d) => d._id === draft.editingId);
      app?.gm.client.submit([
        {
          kind: "update",
          ref: { coll: "drawings", id: draft.editingId, parent: { coll: "scenes", id: scene._id } },
          diff: { text: draft.value, name: draft.value.slice(0, 80), strokeWidth: toolOptions.textSize, ...(existing ? {} : {}) },
        },
      ]);
      return;
    }
    const drawing = drawingForText(nextId("drawing"), draft.at, draft.value, gmUserId(), {
      color: toolOptions.drawingStyle.stroke,
      width: Math.max(80, draft.value.length * toolOptions.textSize * 0.7),
      height: toolOptions.textSize + 12,
    });
    drawing.strokeWidth = toolOptions.textSize;
    app?.gm.client.submit([
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
      const inside =
        world.x >= bounds.x &&
        world.x <= bounds.x + bounds.width &&
        world.y >= bounds.y &&
        world.y <= bounds.y + bounds.height;
      if (inside) {
        canEditDrawing(drawing, gmUserId(), true);
        textDraft = { at: { x: bounds.x, y: bounds.y }, value: drawing.text, editingId: drawing._id };
        return true;
      }
    }
    return false;
  }
  /** The rail's non-tool buttons (zoom, windows, fog-all, erase-last). */
  function runCanvasAction(action: CanvasAction) {
    const view = stage;
    switch (action) {
      case "zoom-in":
      case "zoom-out": {
        if (!view) return;
        const host = canvasHost?.getBoundingClientRect();
        const centre = {
          x: (host?.width ?? view.app.canvas.width) / 2,
          y: (host?.height ?? view.app.canvas.height) / 2,
        };
        view.setCamera(
          zoomAt(view.camera, centre.x, centre.y, action === "zoom-in" ? 1.25 : 1 / 1.25),
        );
        break;
      }
      case "zoom-fit": {
        const scene = activeScene();
        if (view && scene) view.fit(scene.width, scene.height);
        break;
      }
      case "turn-order":
        openWindow("turn-order", "Turn order", "combat");
        break;
      case "add-turn":
        addSelectionToTurnOrder();
        break;
      case "settings":
        openWindow("settings", "Settings", "settings");
        break;
      case "help":
        activeTab = "chat";
        openWindow("help", "Keyboard shortcuts", "help");
        break;
      case "hex-party":
        openPartyHexWindow();
        break;
      case "reveal-all":
        setWholeSceneFog("reveal");
        break;
      case "hide-all":
        setWholeSceneFog("hide");
        break;
      case "delete-last-placement":
        deleteLastPlacement();
        break;
      case "recall-measure":
        toolController?.recall();
        break;
      case "escape":
        // D-275: in path mode the route being drawn *is* the pending gesture (plan §5.7's
        // "Esc clears"), so the key gives it up and leaves the tool armed for the next click
        // — falling through to `select` here would disarm the tool *before* the canvas key
        // layer could see `canvasTool === "path"` and clear the draft it owns.
        if (canvasTool === "path") {
          clearPathDraft();
          break;
        }
        if (!toolController || toolController.current() === null) canvasTool = "select";
        else toolController.dismissGesture();
        break;
    }
  }
  /**
   * D-256: Roll20's `U` — put the current selection in the turn order. Reuses the token
   * context menu's own `applyTokenMenuEntry("add-combatant")` so the rail and the menu can
   * never disagree about what "add to encounter" means; with no encounter in the scene it
   * starts one, exactly like opening the tracker and creating it.
   */
  function addSelectionToTurnOrder() {
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return;
    const selected = tokenSelection.sceneId === scene._id ? tokenSelection.ids : [];
    if (selected.length === 0) {
      activeTab = "combat";
      return;
    }
    let combat = activeCombat();
    if (!combat) {
      const created = newEncounter(scene, nextId("combat"), "Encounter", () => nextId("combatant"));
      combat = created;
      current.gm.client.submit([
        { kind: "create", coll: "combats", data: created },
        ...activateEncounter(scene, created, current.gm.client.user ?? null, scene._id).ops,
      ]);
      // D-273: a fight starting on a hex is the `fighting` trigger (plan §6 rule 2). Only on a
      // *new* combat — adding combatants to a running one is not a new fight.
      if (isHexcrawlScene(scene)) runEncounterTriggers(triggersForFight(), partyCellKey(scene) ?? undefined);
    }
    for (const tokenId of selected) {
      const token = scene.tokens.find((tk) => tk._id === tokenId);
      if (!token) continue;
      const result = applyTokenMenuEntry({
        combat,
        scene,
        token,
        user: current.gm.client.user ?? null,
        actors: current.gm.client.store.getAll("actors") as readonly ActorDocument[],
        entryId: "add-combatant",
        nextId: () => nextId("combatant"),
      });
      if (result.ops.length > 0) current.gm.client.submit(result.ops);
    }
    activeTab = "combat";
  }
  /** Open a pin's linked handout in its own window (§10 window host, kind "journal"). */
  function openJournalFromPin(pin: NoteDocument) {
    if (!pin.journalId) return;
    const journal = app?.gm.client.store.get("journals", pin.journalId);
    openWindow(`journal-${pin.journalId}`, journal?.name ?? "Handout", "journal", {
      journalId: pin.journalId,
    });
  }
  function deleteLastPlacement() {
    const scene = activeScene();
    const last = lastPlacement;
    if (!scene || !last) return;
    app?.gm.client.submit([
      {
        kind: "delete",
        ref:
          last.kind === "wall"
            ? { coll: "walls", id: last.id, parent: { coll: "scenes", id: scene._id } }
            : { coll: "lights", id: last.id, parent: { coll: "scenes", id: scene._id } },
      },
    ]);
    lastPlacement = null;
  }
  const eraseAllDrawings = () => {
    const scene = activeScene();
    if (!scene || !globalThis.confirm("Erase all drawings in this scene?")) return;
    app?.gm.client.submit(scene.drawings.map((drawing) => ({ kind: "delete" as const, ref: { coll: "drawings" as const, id: drawing._id, parent: { coll: "scenes" as const, id: scene._id } } })));
  };
  /** Overlay coordinates are the canvas's own screen space (stage root = top-left origin). */
  const measurePoint = (point: { x: number; y: number }) => {
    void cameraEpoch; // a pan/zoom re-renders every screen-space overlay (see `cameraEpoch`)
    return worldToScreen(stage?.camera ?? { x: 0, y: 0, scale: 1 }, point.x, point.y);
  };
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
  /**
   * The toolbar's active tool owns the next gesture: draw/text/measure arm the tool
   * controller, select disarms it (and `interactionMode` below stops the token/marquee
   * gestures from firing underneath a stroke).
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
  /** D-271: the hexcrawl overlay's plan cache (rebuilt only when `hexOverlayKey` moves). */
  const hexOverlay = createHexOverlaySync();
  /**
   * D-275: the camera's own version. The SVG overlays (the travel route, and the measure/shape
   * previews beside it) are drawn in **screen** space, so a pan or a zoom has to re-render them —
   * the Pixi layers get `repaintHexOverlay`, and this is the DOM's half of the same tick.
   */
  let cameraEpoch = $state(0);
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
    closeHexMenu(); // one click cannot leave two menus on the canvas
  }

  function closeHexMenu(): void {
    hexMenu = null;
  }

  /** D-271: the `hex` window, one per cell — the key is the window's identity. */
  function openHexWindow(key: string): void {
    const scene = activeScene();
    if (!scene) return;
    openWindow(`hex-${scene._id}-${key}`, `Hex ${key}`, "hex", {
      sceneId: scene._id,
      key,
    });
  }

  /**
   * D-276: Shift+H — the hex the party is standing in, from anywhere on the map. A key has no
   * pointer, so *which* hex it means has to be decided by something else, and the party's own
   * cell is the only answer a GM would expect from "where are we?". Both refusals say what they
   * are waiting for instead of doing nothing: a key that answers is worth more than a key that
   * sulks.
   */
  function openPartyHexWindow(): void {
    const scene = activeScene();
    if (!scene) return;
    if (!isHexcrawlScene(scene)) {
      pushLog([hexTravel.partyKeyNoScene], "info");
      return;
    }
    const key = partyCellKey(scene);
    if (!key) {
      pushLog([hexTravel.partyKeyNoToken], "info");
      return;
    }
    openHexWindow(key);
  }

  /**
   * D-272: the encounter-tables window. Without a hex it is the world's table library (the GM
   * toolbar's *Tables* button); with `key` it is the attach flow for that hex, which is where the
   * canvas menu's *Attach encounter table…* and the hex window's own button both land.
   */
  function openTablesWindow(options: { key?: string } = {}): void {
    const scene = activeScene();
    const key = options.key ?? "";
    const attach = key !== "" && scene !== null;
    openWindow(
      attach ? `encounter-tables:${scene._id}:${key}` : "encounter-tables",
      attach ? `Tables — hex ${key}` : "Encounter tables",
      "encounterTables",
      attach ? { sceneId: scene._id, key } : undefined,
    );
  }

  /** Right-click on empty ground, inside a hexcrawl scene: what does this hex offer? */
  function openHexMenu(
    screen: { x: number; y: number },
    world: { x: number; y: number },
  ): void {
    if (!app) return;
    const scene = activeScene();
    if (!scene || !isHexcrawlScene(scene)) return;
    const key = cellAtPoint(scene, world.x, world.y);
    if (!key) return;
    const model = hexContextMenuModel({
      scene,
      key,
      user: app.gm.client.user ?? null,
      catalog: hexTerrainCatalog(),
    });
    // A player right-clicking ground they have not been shown gets no menu at all: there is no
    // document for that hex on their replica, and nothing to open.
    if (model.entries.length === 0) return;
    hexMenu = { x: screen.x, y: screen.y, key, ...model };
  }

  function hexTerrainCatalog() {
    return terrainCatalogOrDefault(
      worldSettingsFrom(app?.gm.client.store.getAll("settings") ?? [])["hexTerrain"],
    );
  }

  /** Apply one §5.2 entry. The model decides *what* the click means; this submits its ops. */
  function runHexMenuEntry(entryId: string): void {
    if (!hexMenu) return;
    const key = hexMenu.key;
    closeHexMenu();
    const scene = activeScene();
    if (!scene || !app) return;
    const result = applyHexMenuEntry({
      scene,
      key,
      entryId,
      user: app.gm.client.user ?? null,
      nextId: () => globalThis.crypto.randomUUID(),
    });
    if (result.error !== null) {
      notifyLog = [
        ...notifyLog.slice(-49),
        { message: result.error, level: "error" },
      ];
      return;
    }
    if (result.ops.length) app.gm.client.submit(result.ops);
    if (result.openWindow) openHexWindow(key);
    if (result.openTables) openTablesWindow({ key });
    if (result.note !== null) pushLog([result.note], "info");
    // D-273: the clock envelope has to be submitted before the engine reads it back, so exploring
    // is the shell's job — the menu entry only says which hex.
    if (result.explore) exploreCell(key);
    // D-275: the route is the shell's own draft (*Add to path*), and moving the party is one
    // position op the model already built into `result.ops` — so the append is all that is left.
    if (result.addPath) onPathClick(key);
  }

  // ─── D-273: the encounter engine (plan §6) ────────────────────────────────

  /** Every encounter table in the world, for the engine's own filtering. */
  function encounterTables() {
    return app ? [...app.gm.client.store.getAll("encounterTables")] : [];
  }

  const encounterClock = () =>
    readWorldClock(app?.gm.client.store.getAll("settings") ?? []);

  /** The GM's own user ids — the audience of a pending prompt. */
  function gmUserIds(): string[] {
    if (!app) return [];
    const ids = app.gm.client.store
      .getAll("users")
      .filter((u) => u.role === "GM" || u.role === "ASSISTANT")
      .map((u) => u._id);
    return ids.length > 0 ? ids : [GM_USER_ID];
  }

  /**
   * One trigger, one decision (plan §6). `ops` is the ledger write; a `prompt` writes nothing, and
   * an already-open prompt for the same hex is not posted twice — the ledger is what keeps a table
   * quiet once it has fired, so only the *unanswered* case needs deduping.
   */
  function runEncounterTrigger(trigger: EncounterTrigger, keyOverride?: string) {
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return null;
    const cellKey = keyOverride ?? partyCellKey(scene);
    if (!cellKey || !isCellOpen(scene, cellKey)) return null;
    const check = encounterCheck({
      scene,
      tables: encounterTables(),
      cellKey,
      trigger,
      clockSeconds: encounterClock(),
    });
    if (check.ops.length > 0) current.gm.client.submit(check.ops);
    if (check.action === "prompt") {
      const log = current.gm.client.store.getAll("messages");
      if (!openPromptFor(log, scene._id, cellKey)) {
        current.gm.client.submit([
          {
            kind: "create",
            coll: "messages",
            data: encounterPromptMessage({
              scene,
              check,
              authorId: current.gm.client.user?.id ?? GM_USER_ID,
              gmIds: gmUserIds(),
            }),
          },
        ]);
      }
    } else if (check.action === "roll" && check.table && check.roll) {
      const profile = hexcrawlProfileOf(scene);
      current.gm.client.submit([
        {
          kind: "create",
          coll: "messages",
          data: encounterResultMessage({
            scene,
            cellKey,
            trigger,
            phase: check.phase,
            clockSeconds: check.clockSeconds,
            table: check.table,
            roll: check.roll,
            authorId: current.gm.client.user?.id ?? GM_USER_ID,
            gmIds: gmUserIds(),
            gmOnly: false,
            announceNames: profile?.encounterAnnounce !== "hidden",
          }),
        },
      ]);
    }
    if (check.action !== "none") encounterTickFlash(`${cellKey} · ${check.action}`);
    return check;
  }

  /**
   * Several triggers from one event (a border crossing is `entering` **and** `moving`), asked in the
   * plan's order and stopped at the first one that produced anything — one event is one encounter,
   * never a roll per trigger.
   */
  function runEncounterTriggers(
    triggers: readonly EncounterTrigger[],
    keyOverride?: string,
  ) {
    for (const trigger of triggers) {
      const check = runEncounterTrigger(trigger, keyOverride);
      if (check && check.action !== "none") return check;
    }
    return null;
  }

  /** One line of feedback in the notification stack (the engine's whole UI footprint otherwise). */
  function encounterTickFlash(text: string): void {
    notifyLog = [...notifyLog.slice(-49), { message: `Encounter: ${text}`, level: "info" }];
  }

  /**
   * The chat card's *Roll this* and the hex window's row (plan §6 rule 6): one named table, by
   * hand. The draw and the ledger write are `rollTableNow`, which is the same pair `auto` uses — so
   * a table rolled by hand is a table the next footstep will not roll again.
   *
   * `messageId` is the pending prompt being answered. With one, the card is GM-only (the prompt
   * was GM-only, and the GM narrates the result) and the prompt is marked answered so its buttons
   * never offer a second draw; without one — the hex window's row — the roll is the GM's own and
   * the card is as public as an `auto` roll, names revealed or hidden by the scene's own flag.
   *
   * Both paths open the results window: the plan's Phase 4 e2e is "clicking it rolls and produces
   * the results window", and the tokens it lists are dragged from there (Phase 5 owns placement).
   */
  function rollEncounterTable(
    messageId: string | null,
    tableId: string,
    cellKeyOverride?: string,
  ) {
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return;
    const payload = messageId
      ? encounterPayloadOf(current.gm.client.store.get("messages", messageId) ?? null)
      : null;
    const cellKey = payload?.cellKey ?? cellKeyOverride ?? partyCellKey(scene);
    const table = encounterTables().find((t) => t._id === tableId);
    if (!cellKey || !table) return;
    const clockSeconds = encounterClock();
    const { roll, ops } = rollTableNow({ scene, table, cellKey, clockSeconds });
    const profile = hexcrawlProfileOf(scene);
    current.gm.client.submit([
      ...ops,
      ...(messageId
        ? [
            {
              kind: "update" as const,
              ref: { coll: "messages" as const, id: messageId },
              diff: {
                "system.encounter.answered": true,
                "system.encounter.answeredRoll": roll.roll,
              },
            },
          ]
        : []),
      {
        kind: "create",
        coll: "messages",
        data: encounterResultMessage({
          scene,
          cellKey,
          trigger: payload?.trigger ?? "entering",
          phase: payload?.phase ?? encounterPhase(clockSeconds, scene),
          clockSeconds,
          table,
          roll,
          authorId: current.gm.client.user?.id ?? GM_USER_ID,
          gmIds: gmUserIds(),
          gmOnly: messageId !== null,
          announceNames: profile?.encounterAnnounce !== "hidden",
        }),
      },
    ]);
    encounterTickFlash(`${cellKey} · rolled ${roll.text}`);
    openEncounterResult(wm, encounterResultId(table._id, cellKey, roll.roll), {
      roll,
      preview: false,
      sceneId: scene._id,
      cellKey,
    });
  }

  /**
   * The hex window's row, for a hex that may not be the party's: the window names its own scene and
   * cell, so the roll happens on *that* hex. The engine works on the active scene (it reads the
   * scene's mode and the world clock), so a window belonging to another scene says so instead of
   * rolling something the shell cannot show.
   *
   * `SceneDocument.type` is `"scene"` — lowercase. The first version of this guard compared
   * `"Scene"`, and the browser spec caught it: the row's click returned silently.
   */
  function rollHexTable(sceneId: string, cellKey: string, tableId: string) {
    const current = app;
    if (!current || !cellKey) return;
    const scene = current.gm.client.store.get("scenes", sceneId) ?? null;
    if (!scene) return;
    if (scene._id !== activeScene()?._id) {
      notifyLog = [
        ...notifyLog.slice(-49),
        { message: "Open that scene before rolling its tables", level: "info" },
      ];
      return;
    }
    rollEncounterTable(null, tableId, cellKey);
  }

  /**
   * D-274 (plan §5.5): the creatures a roll named, as things to place. A compendium ref is *imported*
   * — the same create the compendium drag does (`onCompendiumDrop`), so the token is a normal,
   * sheet-linked token rather than a picture of one — and a world ref uses the actor it points at.
   * The count applies per ref (the wizard's own rule), so a row of "3 × dire wolf" places three.
   */
  async function placementEntriesFor(
    rows: readonly ResolvedRef[],
    count: number,
    opts: { importCompendium?: boolean } = {},
  ): Promise<{ entries: PlacementEntry[]; ops: Op[] }> {
    const current = app;
    if (!current) return { entries: [], ops: [] };
    const copies = Math.max(1, Math.trunc(count));
    const entries: PlacementEntry[] = [];
    const ops: Op[] = [];
    const rows0 = rows.length > 0 ? rows : [];
    if (rows0.length === 0) return { entries, ops };
    // Resolving a compendium row means reading the packs; do it once for the whole roll.
    const compendia = opts.importCompendium
      ? await current.packages.compendia().catch(() => [])
      : [];
    for (const row of rows0) {
      for (let i = 0; i < copies; i += 1) {
        if (row.ref.kind === "actor") {
          entries.push({
            actorId: row.actor?._id ?? null,
            name: row.name,
            img: row.img,
            width: row.token?.width,
            height: row.token?.height,
          });
          continue;
        }
        // A compendium entry becomes a real actor document (the drag-import path), with the token
        // linked to it, so the sheet opens from the board exactly as it does after a drag.
        const pack = compendia.find((r) => r.pack.name === row.ref.packId) ?? null;
        const entry = pack?.pack.entries.find((e) => e.id === row.ref.entryId) ?? null;
        if (!pack || !entry) {
          entries.push({ actorId: null, name: row.name, img: row.img });
          continue;
        }
        const actorId = `${pack.pack.type.slice(0, -1)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
        ops.push({
          kind: "create",
          coll: pack.pack.type,
          data: { ...entry.data, _id: actorId },
        });
        entries.push({
          actorId,
          name: row.name,
          img: row.img || pack.pack.entries.find((e) => e.id === row.ref.entryId)?.img || "",
        });
      }
    }
    return { entries, ops };
  }

  /** The origin a roll's tokens gather around: its own hex's centre, else the party, else the middle. */
  function placementOrigin(scene: SceneDocument, cellKey: string | null): { x: number; y: number } {
    const centre = cellKey ? cellCenterOf(scene, cellKey) : null;
    if (centre) return centre;
    const actor = partyTokenOf(scene);
    if (actor) return { x: actor.x, y: actor.y };
    return { x: Math.round(scene.width / 2), y: Math.round(scene.height / 2) };
  }

  /**
   * D-274 (plan §5.5) — the roll's tokens, placed and created. `origin` is the drop point when a row
   * was dragged onto the map, otherwise the encounter's own hex; `rowIndex` limits the placement to
   * one row (the drag's payload) instead of everything the roll named.
   */
  async function placeEncounterAt(input: {
    resultId: string;
    rowIndex?: number | null;
    origin?: { x: number; y: number } | null;
  }): Promise<void> {
    const current = app;
    const scene = activeScene();
    const result = encounterResultOf(input.resultId);
    if (!current || !scene || !result) return;
    const all = await resolveEncounterRefs(
      current.gm.client.store,
      result.roll.refs,
      current.world?.id,
    ).catch(() => []);
    const rows = input.rowIndex === null || input.rowIndex === undefined
      ? all
      : all.filter((_, i) => i === input.rowIndex);
    const { entries, ops } = await placementEntriesFor(rows, result.roll.count, {
      importCompendium: true,
    });
    if (entries.length === 0) {
      pushLog([`${result.roll.text} — nothing to place`], "info");
      return;
    }
    const origin = input.origin ?? placementOrigin(scene, result.cellKey);
    const points = placeEncounterTokens({ scene, origin, count: entries.length });
    const tokens = encounterTokenData(entries, points, () => `t-${globalThis.crypto.randomUUID().slice(0, 8)}`);
    current.gm.client.submit([
      ...ops,
      ...tokens.map((data) => ({
        kind: "create" as const,
        coll: "tokens" as const,
        parent: { coll: "scenes" as const, id: scene._id },
        data,
      })),
      ...(result.cellKey
        ? logEncounterOps(scene, result.cellKey, {
            tableId: result.roll.tableId,
            tableName: result.roll.tableName,
            roll: result.roll.roll,
            text: result.roll.text,
            sceneId: null,
            atClock: encounterClock(),
          })
        : []),
    ]);
    const blocked = points.some((p: PlacementPoint) => p.blocked);
    pushLog(
      [
        `Placed ${entries.length} × ${result.roll.text} at hex ${result.cellKey ?? "—"}${
          blocked ? " (some on walls — drag them clear)" : ""
        }`,
      ],
      "info",
    );
  }

  /**
   * D-274 (plan §5.6) — requirement 5d: *"optional linked battle scene (offer on trigger, copy,
   * spread tokens)"*. The linked scene is copied (`duplicateSceneOps` — every child re-keyed, the map
   * image shared), the encounter's tokens are created **inside the copy**, the copy becomes the active
   * scene, one chat card says so, and the origin cell's log remembers the scene so the return trip is
   * one click.
   */
  async function createBattleScene(input: { resultId: string; tableId?: string }): Promise<void> {
    const current = app;
    const scene = activeScene();
    const result = encounterResultOf(input.resultId);
    if (!current || !scene || !result) return;
    const tableId = input.tableId ?? result.roll.tableId;
    const table = encounterTables().find((t) => t._id === tableId) ?? null;
    const sourceId = table?.sceneId ?? null;
    const source = sourceId ? (current.gm.client.store.get("scenes", sourceId) ?? null) : null;
    if (!source) {
      pushLog(["That table links no battle scene to copy"], "info");
      return;
    }
    const rows = await resolveEncounterRefs(
      current.gm.client.store,
      result.roll.refs,
      current.world?.id,
    ).catch(() => []);
    const { entries, ops: actorOps } = await placementEntriesFor(rows, result.roll.count, {
      importCompendium: true,
    });
    // The context's own tokens land in the **copy's** middle; the encounter's arrive on the spiral.
    const centre = { x: Math.round(source.width / 2), y: Math.round(source.height / 2) };
    const points = placeEncounterTokens({ scene: source, origin: centre, count: entries.length });
    const tokens = encounterTokenData(entries, points, () => `t-${globalThis.crypto.randomUUID().slice(0, 8)}`);
    const newId = `scene-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const name = `${result.roll.tableName} — encounter`;
    const ops = duplicateSceneOps({
      scene: source,
      id: newId,
      name,
      activate: true,
      scenes: current.gm.client.store.getAll("scenes"),
      extraTokens: tokens,
    });
    const cellOps = result.cellKey
      ? logEncounterOps(scene, result.cellKey, {
          tableId,
          tableName: result.roll.tableName,
          roll: result.roll.roll,
          text: result.roll.text,
          sceneId: newId,
          atClock: encounterClock(),
        })
      : [];
    current.gm.client.submit([
      ...actorOps,
      ...ops,
      ...cellOps,
      // The plan's own card: "Encounter: Goblin bandits — battle scene *Goblin ambush* created".
      // It carries the roll, so the table is the card's own title line; with the table deleted out
      // from under the card there is nothing to name it, and the log line below is the fallback.
      ...(table
        ? [
            {
              kind: "create" as const,
              coll: "messages" as const,
              data: encounterResultMessage({
                scene,
                cellKey: result.cellKey ?? "",
                trigger: "entering",
                phase: encounterPhase(encounterClock(), scene),
                clockSeconds: encounterClock(),
                table,
                roll: result.roll,
                authorId: current.gm.client.user?.id ?? GM_USER_ID,
                gmIds: gmUserIds(),
                gmOnly: false,
                announceNames: true,
              }),
            },
          ]
        : []),
    ]);
    pushLog(
      [`Battle scene “${name}” — ${entries.length} tokens placed (hex ${result.cellKey ?? "—"})`],
      "info",
    );
  }

  /**
   * D-275: an asset hash → a URL a DOM `<img>` can load. The world's images are content-addressed
   * bytes (an imported picture is a hash, §7), so the first ask starts the fetch and answers
   * `null`; the moment the bytes are here the map has the URL and the asking component re-renders.
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
    void current.gm.fetcher
      .request(hash, "ui")
      .then((bytes) => {
        // The same bytes → blob URL the tile textures use (`new Blob([bytes])`, App's own pattern).
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        assetUrls.set(hash, url);
      })
      .catch(() => undefined);
    return null;
  }

  /**
   * Advance the world clock by `delta` **and sweep what expired on the way** — the exact pair the
   * settings window's own clock buttons perform (D-146/D-268). Travel is a consumer of the clock,
   * not a second one: a party that marches for a day must end a day-long buff the same way pressing
   * *+1 day* does, or the two ways of moving time would disagree about the rules.
   */
  function advanceClockWithSweep(delta: number): void {
    const current = app;
    const seconds = Math.trunc(delta);
    if (!current || seconds <= 0) return;
    const settingsDocs = current.gm.client.store.getAll("settings");
    const settings = coreWorldSettingsFrom(settingsDocs);
    const ops = advanceWorldClockOps(settingsDocs, seconds);
    if (ops.length === 0) return;
    const sweep = pf1eClockSweepOps(
      current.gm.client.store.getAll("actors") as never,
      current.gm.client.store.getAll("combats") as never,
      readWorldClock(settingsDocs) + seconds,
      secondsPerRoundOf(settings),
    );
    current.gm.client.submit([...ops, ...sweep.ops]);
  }

  // ─── D-275: travel, terrain time and hidden features (plan §5.7, §3.5) ─────

  /**
   * The route the GM is drawing in **path mode** (plan §5.7). A draft, not a document: it lives
   * here until *Commit* writes it into the profile as a `TravelPlan`. `sceneId` is carried so a
   * scene switch cannot leave half a route pointing at a map that is no longer in front of anyone.
   */
  let pathDraft = $state<{ sceneId: string; keys: string[] }>({ sceneId: "", keys: [] });
  /**
   * The route the party is walking (plan §5.7), read through the profile's own tolerant reader
   * rather than off the raw flag: `travel` is a **field of** `flags.core.hexcrawl`, not the
   * profile itself, so a reader handed the whole profile sees no `path` and answers "no route"
   * for a march that is already in the document.
   */
  const planOf = (scene: SceneDocument | null): TravelPlan | null =>
    hexcrawlProfileOf(scene)?.travel ?? null;

  /**
   * The path the travel panel shows and travels: the draft while one is being drawn (the party's
   * own cell first, because a route that does not start where the party stands is not a route),
   * else the committed plan's.
   */
  function travelPathOf(scene: SceneDocument | null): string[] {
    if (!scene) return [];
    const draft = pathDraft.sceneId === scene._id ? pathDraft.keys : [];
    if (draft.length > 0) {
      const party = partyCellKey(scene);
      const out: string[] = [];
      const push = (key: string) => {
        if (key !== "" && key !== out.at(-1)) out.push(key);
      };
      if (party) push(party);
      for (const key of draft) push(key);
      return out;
    }
    return planOf(scene)?.path ?? [];
  }

  /**
   * Whether the toolbar should offer *Travel path* (§5.7): a hexcrawl scene is the active one.
   * `storeVersion` is read on purpose — the toolbar is rendered once, before the wizard has made
   * anything, and a prop computed off `activeScene()` alone would never see it arrive (the store is
   * not a signal; D-271's `void storeVersion` convention is exactly this).
   */
  const pathToolAvailable = $derived.by(() => {
    void storeVersion;
    return isHexcrawlScene(activeScene());
  });

  /** The travel panel's own model: one row per step, priced by terrain, plus the total. */
  interface TravelRow {
    key: string;
    terrainName: string;
    cost: number;
    seconds: number;
  }

  const travelPanel = $derived.by((): {
    draft: boolean;
    committed: boolean;
    party: string | null;
    rows: TravelRow[];
    totalSeconds: number;
    travelledSeconds: number;
    units: string;
  } | null => {
    void storeVersion;
    const scene = activeScene();
    if (!app || !scene || !isHexcrawlScene(scene)) return null;
    const keys = travelPathOf(scene);
    const plan = planOf(scene);
    if (keys.length < 2 && pathDraft.sceneId !== scene._id) return null;
    if (keys.length === 0 && !plan) return null;
    const catalog = hexTerrainCatalog();
    const speed = plan?.speedPerDay ?? DEFAULT_SPEED_PER_DAY;
    const pace = plan?.pace ?? travelPace;
    const rows: TravelRow[] = [];
    let total = 0;
    for (let i = 0; i < keys.length - 1; i++) {
      const from = keys[i] as string;
      const to = keys[i + 1] as string;
      const terrain = cellTerrainName(scene, to);
      const seconds = stepSecondsOf(scene, catalog, from, to, speed, pace);
      const cost = stepCostOfValue(catalog, scene, from, to);
      total += seconds;
      rows.push({ key: to, terrainName: terrain, cost, seconds });
    }
    return {
      draft: keys.length > 0 && (plan === null || pathDraft.keys.length > 0),
      committed: plan !== null,
      party: partyCellKey(scene),
      rows,
      totalSeconds: total,
      travelledSeconds: plan?.progressSeconds ?? 0,
      units: scene.grid.units || "mi",
    };
  });

  /** The catalog's name for a cell's terrain ("Forest / woods"), defaulted when unauthored. */
  function cellTerrainName(scene: SceneDocument, key: string): string {
    const catalog = hexTerrainCatalog();
    const id = (scene.cells ?? []).find((c) => c.key === key)?.terrain ?? catalog.defaultTerrain;
    return catalog.terrains.find((t) => t.id === id)?.name ?? id;
  }

  function stepCostOfValue(
    catalog: ReturnType<typeof hexTerrainCatalog>,
    scene: SceneDocument,
    from: string,
    to: string,
  ): number {
    const terrainOf = (key: string): string | null =>
      (scene.cells ?? []).find((c) => c.key === key)?.terrain ?? null;
    return stepCostOf(catalog, terrainOf(from), terrainOf(to));
  }

  /** The pace the route is drawn at and committed with (plan §5.7's itinerary reads it). */
  let travelPace = $state<TravelPace>("normal");

  const travelSpeedPerDay = $derived.by(() => {
    void storeVersion;
    return planOf(activeScene())?.speedPerDay ?? DEFAULT_SPEED_PER_DAY;
  });

  /** One click in path mode: extend the route, or take the last cell back. */
  function onPathClick(key: string): void {
    const scene = activeScene();
    if (!scene) return;
    const keys = pathDraft.sceneId === scene._id ? pathDraft.keys : [];
    const next = keys.at(-1) === key ? keys.slice(0, -1) : [...keys, key];
    pathDraft = { sceneId: scene._id, keys: next };
  }

  function clearPathDraft(): void {
    pathDraft = { sceneId: activeScene()?._id ?? "", keys: [] };
  }

  /** Commit the drawn route: one profile write, cursor at the party's own cell. */
  function commitTravelRoute(): void {
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return;
    const keys = travelPathOf(scene);
    if (keys.length < 2) {
      pushLog([hexTravel.routeTooShort], "info");
      return;
    }
    const plan: TravelPlan = {
      path: keys,
      cursor: 0,
      progressSeconds: 0,
      speedPerDay: travelSpeedPerDay,
      pace: travelPace,
    };
    current.gm.client.submit(travelProgressOps(scene, plan));
    clearPathDraft();
    pushLog(
      [
        hexTravel.committed(
          keys.length,
          formatDuration(
            routeSeconds({
              scene,
              path: keys,
              speedPerDay: plan.speedPerDay,
              pace: plan.pace,
              catalog: hexTerrainCatalog(),
            }),
          ),
        ),
      ],
      "info",
    );
  }

  /** Give up on a route (committed or drawn): the party stops where it stands. */
  function clearTravelRoute(): void {
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return;
    if (planOf(scene)) current.gm.client.submit(travelProgressOps(scene, null));
    clearPathDraft();
    pushLog([hexTravel.calledOff], "info");
  }

  /**
   * **Travel** (plan §5.7). Every button is the same three steps: advance the world clock by
   * exactly what the button says, walk the party as far as that time and the route's terrain
   * allow, and let the encounter engine see every border that was crossed.
   *
   * The time is always `advanceWorldClockOps(delta)` — a "travel one day" click is a day of the
   * clock, not a private timer — and the *party* stops when its route ends, spending the rest of
   * the day where it arrived (`travelAdvance` charges that time to the cell, and the features that
   * were waiting for it evaluate on the same pass). `next` and `route` are the two deltas that are
   * *about* the route: the seconds to the next border, and the seconds the whole route still needs.
   */
  function advanceTravel(mode: "next" | "route" | "hour" | "dawn" | "dusk" | "day"): void {
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return;
    const plan = planOf(scene);
    if (!plan) {
      pushLog([hexTravel.noRoute], "info");
      return;
    }
    const catalog = hexTerrainCatalog();
    const now = encounterClock();
    const delta = travelDelta(mode, scene, plan, catalog, now);
    if (delta <= 0) return;
    const advance = travelAdvance({
      scene,
      plan,
      elapsedSeconds: delta,
      catalog,
      startClock: now,
    });
    const party = partyTokenOf(scene);
    // The party token's move is written *before* the clock, so a listener that wakes on either one
    // sees the same picture; `lastPartyCell` is set first so the ops listener does not report the
    // whole march as one crossing (the steps below already report each border, in order).
    const arrivalKey = advance.cellKey;
    lastPartyCell = arrivalKey ?? lastPartyCell;
    const ops = [
      ...(advance.plan ? travelProgressOps(scene, advance.plan) : travelProgressOps(scene, null)),
      ...(party && arrivalKey
        ? (() => {
            const centre = cellCenterOf(scene, arrivalKey);
            return centre ? partyPositionOps(scene, party._id, centre) : [];
          })()
        : []),
      // Features are judged at the reading the march *ended* at: the party has been there by then.
      ...advanceFeatureOps(scene, advance.spentSeconds, now + delta),
    ];
    if (ops.length > 0) current.gm.client.submit(ops);
    advanceClockWithSweep(delta);
    for (const step of advance.steps) {
      runEncounterTriggers(step.triggers, step.cellKey);
    }
    const where = arrivalKey ?? "—";
    pushLog(
      [
        advance.arrived
          ? hexTravel.arrives(
              where,
              formatDuration(delta),
              formatDuration(advance.leftoverSeconds),
            )
          : hexTravel.atCell(where, formatDuration(delta)),
      ],
      "info",
    );
  }

  /** What each travel button advances: the route's own steps are the two that mean "travel". */
  function travelDelta(
    mode: "next" | "route" | "hour" | "dawn" | "dusk" | "day",
    scene: SceneDocument,
    plan: TravelPlan,
    catalog: ReturnType<typeof hexTerrainCatalog>,
    clockSeconds: number,
  ): number {
    if (mode === "day") return DAY_SECONDS;
    if (mode === "hour") return HOUR_SECONDS;
    if (mode === "dawn") return secondsUntilHour(clockSeconds, 6);
    if (mode === "dusk") return secondsUntilHour(clockSeconds, 18);
    if (mode === "next") {
      const from = plan.path[plan.cursor] ?? null;
      const to = plan.path[plan.cursor + 1] ?? null;
      if (!from || !to) return 0;
      return Math.max(
        0,
        stepSecondsOf(scene, catalog, from, to, plan.speedPerDay, plan.pace) -
          plan.progressSeconds,
      );
    }
    // "Travel the route": exactly the seconds the rest of it needs, at its own pace and terrain.
    const rest = plan.path.slice(plan.cursor);
    return Math.max(
      0,
      routeSeconds({
        scene,
        path: rest,
        speedPerDay: plan.speedPerDay,
        pace: plan.pace,
        catalog,
      }) - plan.progressSeconds,
    );
  }

  /**
   * The time a march just spent, turned into feature reveals: the seconds `travelAdvance` charged
   * to each cell, the rules that were waiting for exactly that, and one envelope for both (see
   * `core/hexcrawl/features.ts`).
   */
  function advanceFeatureOps(
    scene: SceneDocument,
    spent: Record<string, number>,
    clockSeconds: number,
  ) {
    const current = app;
    const ops = [];
    const notes: string[] = [];
    const found: Array<{ cellKey: string; features: CellFeature[] }> = [];
    const facts = featureFacts(clockSeconds);
    for (const [key, seconds] of Object.entries(spent)) {
      const result = revealDueFeatures({ scene, cellKey: key, facts, spentSeconds: seconds });
      ops.push(...result.ops);
      notes.push(...result.notes);
      if (result.revealed.length > 0) found.push({ cellKey: key, features: result.revealed });
    }
    // A reveal is a line in the chat, not only a toast: the table hears it. One card per hex, in
    // the same envelope as the feature flip and the time that earned it — the log, the counter
    // and the document can never tell three different stories.
    if (current) {
      for (const card of found) {
        ops.push({
          kind: "create",
          coll: "messages",
          data: featureFoundMessage({
            authorId: current.gm.client.user?.id ?? GM_USER_ID,
            cellKey: card.cellKey,
            features: card.features,
          }),
        });
      }
    }
    if (notes.length > 0) pushLog(notes, "info");
    return ops;
  }

  /**
   * The party's Perception, read off the PF1e derivation the sheets use: the party token's own
   * actor when it has one (the scout), else the best of the world's characters — a party is a
   * group, and the lookout who spots the shrine is a member of it. Passive is `10 + the modifier`
   * (plan §9.5's "passive value by default").
   */
  function featureFacts(clockSeconds: number): FeatureFacts {
    const derived = partyPerception();
    return {
      clockSeconds,
      passivePerception: 10 + derived.modifier,
      perceptionModifier: derived.modifier,
      rng: currentRng,
    };
  }

  /**
   * The rng a `dice` rule rolls with: the same default the table draw uses (`drawEncounter`'s own
   * `Math.random` when no rng is passed, D-273). A feature's roll is a client-side evaluation of a
   * rule the GM authored, exactly like a table draw is.
   */
  const currentRng = (): number => Math.random();

  function partyPerception(): { modifier: number; source: string } {
    const scene = activeScene();
    if (!app || !scene) return { modifier: 0, source: "none" };
    const token = partyTokenOf(scene);
    const actors = [...app.gm.client.store.getAll("actors")] as ActorDocument[];
    const scoreOf = (actor: ActorDocument): number => {
      const derived = deriveFromActorDocument(
        actor,
        encumbranceOptionsOf(
          worldSettingsFrom(app?.gm.client.store.getAll("settings") ?? []),
        ),
      );
      return derived.skills.perception?.total ?? 0;
    };
    const own = token?.actorId ? actors.find((a) => a._id === token.actorId) : undefined;
    if (own) return { modifier: scoreOf(own), source: own.name };
    let best = { modifier: 0, source: "none" };
    for (const actor of actors) {
      if (actor.type !== "character") continue;
      const modifier = scoreOf(actor);
      if (modifier > best.modifier) best = { modifier, source: actor.name };
    }
    return best;
  }

  /**
   * *Explore this hex* (plan §5.2, §6 rule 2): the action costs real time on the world clock and
   * then asks the `exploring` trigger. The time comes first, in its own envelope, because the
   * engine reads the clock back off the store.
   */
  function exploreCell(key: string) {
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return;
    const startClock = encounterClock();
    // D-275: the hour the party spends here *is* the cell's `exploredSeconds` — the counter the
    // `time` rule reads — so the clock, the counter and the reveal are one envelope's worth of
    // story. The clock moves first, so the engine's own ledger records the reading the exploration
    // happened at rather than the one before it.
    advanceClockWithSweep(EXPLORE_SECONDS);
    const facts = featureFacts(startClock + EXPLORE_SECONDS);
    const due = revealDueFeatures({
      scene,
      cellKey: key,
      facts,
      spentSeconds: EXPLORE_SECONDS,
    });
    if (due.ops.length > 0) current.gm.client.submit(due.ops);
    // The same card the travel advance posts: one reveal, one line at the table (D-275).
    if (due.revealed.length > 0) {
      current.gm.client.submit([
        {
          kind: "create",
          coll: "messages",
          data: featureFoundMessage({
            authorId: current.gm.client.user?.id ?? GM_USER_ID,
            cellKey: key,
            features: due.revealed,
          }),
        },
      ]);
    }
    // The clock op is committed by now (submit is synchronous into the store), so the engine sees
    // the new reading and the ledger records it.
    runEncounterTriggers(triggersForExplore(), key);
  }

  /** The last cell the party was standing in — a crossing is a change of this value (D-273). */
  let lastPartyCell: string | null = null;

  /**
   * The party moved: if it crossed a border into a cell the table can see, that is the `entering`
   * trigger. Called from the ops listener (so the GM's drag, a player's drag, an undo and a rejoin
   * all work) and deliberately *not* from the drag handler itself.
   */
  function encounterAfterPartyMove(): void {
    const scene = activeScene();
    if (!scene || !isHexcrawlScene(scene)) return;
    const key = partyCellKey(scene);
    const from = lastPartyCell;
    lastPartyCell = key;
    if (!key || from === key) return;
    if (from === null) return; // the first reading is a starting point, not a crossing
    runEncounterTriggers(triggersForStep(from, key), key);
  }

  /**
   * D-271 (plan §4): after any batch of ops, the party's sight ring owes the world its cells.
   * `sightReconcileOps` is a no-op for every scene that is not a `gm+party` hexcrawl map, and a
   * no-op once the ring is already in the reveal set, so this can sit on the bus without any
   * "did the party move?" bookkeeping — a drag, a undo, a rejoin all reconcile the same way.
   */
  function reconcilePartySight(): void {
    if (!app) return;
    const scene = activeScene();
    if (!scene) return;
    const ops = sightReconcileOps(scene);
    if (ops.length > 0) app.gm.client.submit(ops);
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

  /**
   * D-293: the same gesture contract for FX anchors. It answers an **authored
   * point**, not a mechanical placement — the host still validates the whole
   * saved sequence, so this is UI convenience with no authority of its own.
   */
  let pendingAnchorPick = $state.raw<{ options: AnchorPickOptions;
    resolve: (at: AnchorPickPoint | null) => void } | null>(null);
  function settleAnchorPick(at: AnchorPickPoint | null): void {
    const pending = pendingAnchorPick;
    pendingAnchorPick = null;
    pending?.resolve(at !== null && activeScene()?._id === pending.options.sceneId ? at : null);
  }
  const requestAnchorPick: RequestAnchorPick = (options) => {
    if (options.sceneId !== activeScene()?._id || !stage) return Promise.resolve(null);
    settleAnchorPick(null);
    return new Promise((resolve) => { pendingAnchorPick = { options, resolve }; });
  };

  /**
   * D-293: render an **unsaved** FX draft for its author. Deliberately not a host
   * request: no world op, no durable `fxInstance`, no recipient — so a preview
   * cannot create state, survive the author's session or grant a player a read.
   * The sequence still goes through the same `resolveFxSequence` the host uses, so
   * what previews is what a save would accept (persistent drafts preview one pass).
   */
  const previewFxSequence: PreviewFxSequence = async (sequence, sceneId,
    sourceTokenId, targetTokenId) => {
    const current = app;
    const view = stage;
    if (!current || !view || !fxPlayer) return { ok: false, error: "The canvas is not ready yet" };
    const scene = activeScene();
    if (!scene || scene._id !== sceneId) return { ok: false, error: "Open the timeline's scene before previewing" };
    const source = sourceTokenId ? scene.tokens.find((token) => token._id === sourceTokenId) : undefined;
    const target = targetTokenId ? scene.tokens.find((token) => token._id === targetTokenId) : undefined;
    const resolved = resolveFxSequence({ ...sequence, persistent: false }, scene, source, target,
      (id) => current.gm.client.store.world.assetManifest[id]?.mime);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const runId = `preview-${globalThis.crypto.randomUUID()}`;
    fxPlayer.preview({ kind: "fx.start", runId, macroId: "preview", sceneId, sections: resolved.sections,
      atHostTime: Date.now() + 120 });
    return { ok: true, runId };
  }
  function stopFxPreview(): void {
    fxPlayer?.clearPreview();
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
      width: kind === "hexcrawl-wizard" ? 520 : kind === "macros" ? 560 : 380,
      // Settings carries the ruleset section on top of the scene options (D-249): taller;
      // the hexcrawl wizard has three steps and a readout to show at once (D-270).
      height: kind === "settings" ? 560 : kind === "hexcrawl-wizard" || kind === "macros" ? 580 : 420,
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
    if (!macro || !app) return;
    if (macro.kind === "chat") runChatMacro(app.gm.client, macro);
    else if (macro.kind === "script") {
      if (macro.script?.inputs.some((field) => field.required))
        openWindow("macros", "Macros", "macros"); // collect declared inputs in the script tab
      else app.gm.client.requestMacro(macro._id);
    } else if (macro.kind === "sequence") {
      const scene = activeScene();
      if (scene) app.gm.client.requestSequence(macro._id, scene._id);
    }
  }

  /**
   * §2.2 item 2 (G-10b/D-261): the quickbar plays the **selected** token's character — the same
   * rule on both shells — and offers every actor the GM can read as the target (the selected one
   * first), because a GM has no character of their own to play.
   */
  const quickbarActor = $derived.by(() => {
    void storeVersion;
    const current = app;
    const scene = activeScene();
    if (!current || !scene) return null;
    const id = tokenSelection.ids.length === 1 ? tokenSelection.ids[0] : null;
    if (id === null) return null;
    const actorId = scene.tokens.find((t) => t._id === id)?.actorId ?? null;
    if (actorId === null) return null;
    return (current.gm.client.store.get("actors", actorId) as ActorDocument | undefined) ?? null;
  });
  const quickbarTargets = $derived.by(() => {
    void storeVersion;
    // The selected token's actor is in the list too: a self-buff (or a self-attack) is a table's
    // business, and the bar chooses nothing on its own — an attack slot without a target refuses.
    return [
      ...((app?.gm.client.store.getAll("actors") ?? []) as readonly ActorDocument[]),
    ];
  });

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

  /** D-270: `+` asks *what kind* of scene — a blank board or a hexcrawl map. */
  let sceneMenu = $state(false);

  function toggleSceneMenu(): void {
    sceneMenu = !sceneMenu;
  }

  function openHexcrawlWizard(): void {
    openWindow("hexcrawl-wizard", "New hexcrawl scene", "hexcrawl-wizard");
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

  /**
   * §2.3 (G-25 remainder, D-262): **view as player X** — the GM's canvas runs the fog loop, the
   * token gate and the HP bars as the chosen player, so the GM sees the table that player sees.
   * The picker is built from the users the host replicated (players only: previewing a GM or an
   * assistant would show the GM's own view under another name), and the choice lives in `gmState`
   * because it is a *view*, not world data — nothing about it is written anywhere.
   */
  const viewAsPlayer = $derived.by(() => {
    void storeVersion;
    const current = app;
    if (!current || gmState.viewAsUser === "") return null;
    return viewAsUser(
      current.gm.client.store.getAll("users") as readonly UserDocument[],
      gmState.viewAsUser,
    );
  });
  const viewingAs = $derived(viewAsPlayer !== null);

  /**
   * §2.3 tail (D-263): the first-run checklist's facts. They are read from the same replica the
   * shell renders, so a step ticks the moment the GM's own action lands — and a table set up
   * before this feature existed arrives with most of them already satisfied.
   */
  const onboardingFacts = $derived.by((): OnboardingFacts => {
    void storeVersion;
    const current = app;
    if (!current) return NO_ONBOARDING_FACTS;
    const store = current.gm.client.store;
    const user = current.gm.client.user;
    const scene = activeScene();
    const users = store.getAll("users") as readonly UserDocument[];
    const data = (scene ?? null) as SceneDocument | null;
    const owned = data
      ? data.tokens.filter((t) =>
          can(user, "update", t, "tokens", { parent: data }),
        ).length
      : 0;
    return {
      scenes: store.getAll("scenes").length,
      map: typeof data?.img === "string" && data.img !== "",
      tokens: data?.tokens.length ?? 0,
      character: typeof user.character === "string" && user.character !== "",
      owned,
      players: users.filter((u) => u.role === "PLAYER").length,
      invited: share !== null || users.some((u) => u.role === "PLAYER"),
      fog: sceneFogSettings(data).enabled,
      messages: store.getAll("messages").length,
    };
  });
  const onboarding = $derived(
    onboardingSteps(onboardingFacts, app?.gm.client.user.role ?? null),
  );
  /** What the previewed player's gate currently shows — the GM's own pick list follows it. */
  let viewAsVisible = $state<ReadonlySet<string> | null>(null);

  /** The cover this shell draws: a preview is always opaque (D-262), else god view decides. */
  function fogStyle(): "opaque" | "translucent" {
    return viewingAs ? "opaque" : gmState.godView ? "translucent" : "opaque";
  }

  function tokenViews(): TokenView[] {
    const scene = activeScene();
    if (!scene) return [];
    // A preview is a view of the table, not only of the pixels: under it the GM's pointer plays
    // the player's part too, so a token the player cannot see is not selectable here either.
    const gate = viewingAs ? viewAsVisible : null;
    return scene.tokens
      .filter((token) => gate === null || gate.has(token._id))
      .map((token) => ({ token, sceneId: scene._id }));
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
          ? deriveFromActorDocument(actor, encumbranceOptionsOf(worldSettingsFrom(app?.gm.client.store.getAll("settings") ?? [])))
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
  /**
   * D-257: the **GM Info** layer draws the walls overlay — every segment with its restriction
   * colour, door-state dots, window strokes. It is the map of what blocks sight and movement
   * and the surface a door is clicked on, so it must be on screen exactly when the GM is
   * working on that layer.
   */
  function syncWallsOverlay(): void {
    const view = stage;
    if (!view) return;
    const scene = activeScene();
    const show = canvasLayer === "gm";
    view.getWallsLayer().sync(show ? (scene?.walls ?? []) : [], view.camera);
  }

  function refresh(): void {
    storeVersion++;
    const current = app;
    const view = stage;
    if (!current || !view) return;
    const scene = activeScene();
    fxPlayer?.syncScene();
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
      // §2.2/G-10a: the GM's canvas is `isGM`, so the default `"gm"` setting draws bars here and
      // nowhere else; `"hover"` hands the same numbers over and the stage hides all but one.
      // D-262: under a preview it is **not** the GM's canvas any more — the bars follow the same
      // rule the previewed player's shell would apply (a player under the default sees none).
      tokenHpBarsMap(tokens, {
        actors: current.gm.client.store.getAll("actors") as ActorDocument[],
        mode: tokenHpBarsOf(
          worldSettingsFrom(current.gm.client.store.getAll("settings")),
        ),
        isGM: viewAsPlayer === null,
      }),
    );
    view.setTokenHpBarMode(
      tokenHpBarsOf(worldSettingsFrom(current.gm.client.store.getAll("settings"))) ===
        "hover"
        ? "hover"
        : "all",
    );
    // D-250/D-251: explored fog follows the replica — tokens moved, doors opened, scene
    // switched. The GM's cover is translucent (everything stays visible under it); god view
    // off previews the opaque cover players get — and a **view as** preview is always the
    // opaque cover, because a see-through version of what a player sees is not what they see.
    void fog?.sync(scene, { style: fogStyle() });
    // D-256: the GM's manual Hide/Reveal mask is a replicated scene flag — replay it onto
    // the fog layer on every replica change (idempotent: later strokes win).
    const mask = fogMaskLog(scene);
    if (mask.length !== fogMask.length) fogMask = mask;
    view.peekFogLayer()?.applyManualMask(mask);
    // D-256 map pins: the notes layer draws whatever this replica holds (players only ever
    // hold pins the GM made visible — the projection withholds the rest).
    view.getNotesLayer().sync(scene?.notes ?? [], view.camera);
    // D-271: the hex overlay follows the replica — reveals, terrain, the party's ring. A scene
    // without a hexcrawl profile clears it (the feature switch), and a *view as* preview paints
    // what that player would see: the cover, not the GM's dimmed preparation view.
    syncHexOverlay(
      view,
      hexOverlay,
      scene,
      viewAsPlayer === null ? "gm" : "player",
      current.gm.client.store.getAll("settings"),
    );
    // D-257: walls overlay follows the replica too (a door toggled anywhere redraws here).
    syncWallsOverlay();
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

  /**
   * D-270: the file goes into the world's assets and comes back as a hash — one helper, because
   * both the sidebar's **Import map** and the hexcrawl wizard's map step need exactly this.
   */
  async function importMapFile(
    file: File,
  ): Promise<{ hash: string; width?: number; height?: number }> {
    const current = app;
    if (!current) throw new Error("the world is not open");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { hash, entry } = await current.pipeline.importImage(
      bytes,
      file.name,
      file.type || "image/png",
    );
    return {
      hash,
      ...(entry.width !== undefined ? { width: entry.width } : {}),
      ...(entry.height !== undefined ? { height: entry.height } : {}),
    };
  }

  /** Import an owned media file for host-authorized FX. Stored as bytes, not embedded in a macro. */
  async function importFxFile(file: File, permissions: FxImportPermissions): Promise<{ hash: string; mime: string; name: string }> {
    const current = app;
    if (!current) throw new Error("the world is not open");
    if (!/^(image\/(png|jpeg|webp|gif|avif)|video\/(webm|mp4)|audio\/(mpeg|mp3|wav|ogg|webm|mp4|aac))$/.test(file.type))
      throw new Error(`Unsupported FX media type: ${file.type || "unknown"}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { hash, entry } = await current.assets.import(bytes, file.name, file.type,
      permissions.shareWithPlayers ? "referenced" : "gm",
      permissions.includeInWorldFile ? "granted" : "restricted");
    return { hash, mime: entry.mime, name: entry.name };
  }

  async function setFxAssetRights(hash: string, permissions: FxImportPermissions): Promise<void> {
    const current = app;
    if (!current || !/^[a-f0-9]{64}$/.test(hash) || !await current.assets.has(hash))
      throw new Error("Media not found in this world");
    await current.assets.describe(hash, { visibility: permissions.shareWithPlayers ? "referenced" : "gm",
      exportRights: permissions.includeInWorldFile ? "granted" : "restricted" });
  }

  /**
   * The sidebar's map import writes to the scene the GM is **looking at** (D-270). It used to
   * hardcode `DEFAULT_SCENE_ID`, which meant a hexcrawl map uploaded while standing on a new
   * scene landed on scene 1 — 1,000 px away and invisible.
   */
  async function importMap(ev: Event): Promise<void> {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!app || !file) return;
    const target = activeScene()?._id ?? DEFAULT_SCENE_ID;
    const imported = await importMapFile(file);
    app.gm.client.submit([
      {
        kind: "update",
        ref: { coll: "scenes", id: target },
        diff: {
          img: imported.hash,
          ...(imported.width !== undefined ? { width: imported.width } : {}),
          ...(imported.height !== undefined ? { height: imported.height } : {}),
        },
      },
    ]);
    input.value = "";
  }

  /**
   * D-274 (plan §5.5): a row dragged out of the results window lands where the GM dropped it. The
   * payload says *which* result and row (`ui/hexcrawl/EncounterResultWindow.svelte` sets it), so the
   * placement runs the same code the window's *Place all* does — one implementation, two gestures.
   */
  function onEncounterDrop(ev: DragEvent): void {
    const raw = ev.dataTransfer?.getData("application/x-vtt-encounter");
    if (!raw) return;
    ev.preventDefault();
    let payload: { resultId?: unknown; rowIndex?: unknown };
    try {
      payload = JSON.parse(raw) as { resultId?: unknown; rowIndex?: unknown };
    } catch {
      return;
    }
    if (typeof payload.resultId !== "string") return;
    const rect = stage?.app.canvas.getBoundingClientRect();
    const origin =
      stage && rect
        ? screenToWorld(stage.camera, ev.clientX - rect.left, ev.clientY - rect.top)
        : null;
    void placeEncounterAt({
      resultId: payload.resultId,
      rowIndex: typeof payload.rowIndex === "number" ? payload.rowIndex : null,
      origin: origin ? { x: Math.round(origin.x), y: Math.round(origin.y) } : null,
    });
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
    // §3.2 the agent desk, built here rather than in `$props` init: it needs the live HostSync to
    // mint agent users on, and it is torn down with the app (onDestroy above).
    agents = createAgentManager({
      host: current.host,
      client: current.gm.client,
      meta: current.meta,
      // The packs the agent may search and import from: without this, `bestiary.search` and
      // `actor.from_compendium` say they cannot, rather than finding nothing.
      compendia: async () =>
        (await current.packages.compendia()).map((entry) => entry.pack),
      // The world's asset pipeline, the same one the sidebar's **Import map** and the hexcrawl
      // wizard use. Without it `asset.import` answers that it cannot — and an agent authoring an
      // overland map cannot hang a picture on a hex.
      importImage: async (bytes, name, mime) =>
        current.pipeline.importImage(bytes, name, mime || "image/png"),
    });
    // Canvas tool listeners are attached after `await createStage(...)`, i.e. after the
    // component-init context is gone — `onDestroy` may only be *called* synchronously
    // (Svelte 5 throws `lifecycle_outside_component` otherwise, which aborted the rest of
    // the boot wiring). The teardown is therefore registered here and fills itself in later.
    let toolCleanup: (() => void) | null = null;
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
        closeTokenMenu(); // T01 menu dismiss (which also drops the hex menu)
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
      settleSummonPick(null);
      agents?.dispose();
      agents = null;
      moduleHost?.dispose();
      if (rtSampleTimer !== null) globalThis.clearInterval(rtSampleTimer);
      offSimBus?.();
      if (fogTimer !== null) globalThis.clearInterval(fogTimer);
      globalThis.clearInterval(clockTimer);
      audioPlayer.dispose();
      fxPlayer?.dispose();
      fxPlayer = null;
      offRejected();
      offWm();
      globalThis.removeEventListener("keydown", onKey);
      toolCleanup?.();
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
        fxPlayer = new FxPlayer({
          client: current.gm.client, bus: current.gm.bus, stage: view,
          fetchAsset: (hash) => current.gm.fetcher.request(hash, "ui"),
          sceneId: () => viewAsPlayer === null ? (activeScene()?._id ?? null) : null,
          onError: (message) => console.warn(message),
        });
        const canvas = view.app.canvas as HTMLCanvasElement;
        const toWorld = (event: PointerEvent) => {
          const rect = canvas.getBoundingClientRect();
          return screenToWorld(view.camera, event.clientX - rect.left, event.clientY - rect.top);
        };
        toolController = new ToolInteractionController({
          nextId: () => `drawing-${globalThis.crypto.randomUUID().slice(0, 8)}`,
          userId: current.gm.client.user?.id ?? "",
          grid: () => {
            const sc = activeScene();
            return sc?.grid
              ? {
                  type: sc.grid.type,
                  size: sc.grid.size,
                  distance: sc.grid.distance,
                  diagonals: sc.grid.diagonals,
                  layout: sc.grid.hexLayout,
                }
              : null;
          },
          createDrawing: (drawing) => {
            const sc = activeScene();
            if (sc) current.gm.client.submit([{ kind: "create", coll: "drawings", parent: { coll: "scenes", id: sc._id }, data: drawing }]);
          },
          // D-256: the rail's live sub-tool settings (shapes, styles, brushes, light).
          options: () => toolOptions,
          promptText: (at) => {
            // Roll20 types in place: the editor overlay opens here (Esc/click-away commits).
            textDraft = { at: { ...at }, value: "", editingId: null };
          },
          createWall: (wall) => createWall(wall),
          createLight: (light) => createLight(light),
          createNote: (at) => createPin(at),
          measurePreview: (value) => { measurePreview = value; },
          shapePreview: (value) => { shapePreview = value; },
          broadcastMeasure: (points) => {
            view.getEffectsLayer().showRuler(current.gm.client.user?.id ?? "gm", points, currentGrid(), activeScene()?.grid.units ?? "ft");
            current.gm.client.sendEphemeral("ruler", { points: points.map((p) => ({ x: p.x, y: p.y })) });
          },
          fogPaint: ({ mode, poly }) => paintFog(mode, poly),
        });
        toolReady++;
        // D-256: every gesture tool (draw/text/measure/fog/wall/light/pin) sees the pointer
        // with its modifiers — Alt picks the ellipse, Shift snaps a shape to the grid.
        const toolPointer = (e: PointerEvent) => ({
          world: toWorld(e),
          button: e.button,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        });
        const onToolDown = (e: PointerEvent) => {
          // D-275 path mode (plan §5.7): a left click on a hex extends the route — or takes the
          // last one back when it is the same hex again. The tool owns no pointer capture: every
          // click is one decision, and a drag is still the map's.
          if (canvasTool === "path") {
            if (e.button !== 0) return;
            const sc = activeScene();
            if (!sc || !isHexcrawlScene(sc)) return;
            const world = toWorld(e);
            const key = cellAtPoint(sc, world.x, world.y);
            if (key) onPathClick(key);
            return;
          }
          if (GESTURE_TOOLS.has(canvasTool)) toolController?.pointerDown(toolPointer(e));
        };
        const onToolMove = (e: PointerEvent) => { if (GESTURE_TOOLS.has(canvasTool)) toolController?.pointerMove(toolPointer(e)); };
        const onToolUp = (e: PointerEvent) => { if (GESTURE_TOOLS.has(canvasTool)) toolController?.pointerUp(toolPointer(e)); };
        // Right-click / Escape finish a multi-click gesture instead of opening a menu.
        const onToolContext = (e: MouseEvent) => {
          if (!GESTURE_TOOLS.has(canvasTool)) return;
          if (canvasTool !== "draw" && canvasTool !== "fog") return;
          e.preventDefault();
          toolController?.finishPoly();
        };
        const onToolKey = (e: KeyboardEvent) => {
          if (e.key !== "Escape" || isTypingTarget(e.target)) return;
          // D-275: Esc gives up the route being drawn (plan §5.7) — the same key that finishes a
          // polygon gives up a path, and both leave the map as it was.
          if (canvasTool === "path") {
            clearPathDraft();
            return;
          }
          if (!GESTURE_TOOLS.has(canvasTool)) return;
          toolController?.finishPoly();
        };
        canvas.addEventListener("pointerdown", onToolDown);
        canvas.addEventListener("pointermove", onToolMove);
        canvas.addEventListener("pointerup", onToolUp);
        canvas.addEventListener("contextmenu", onToolContext);
        globalThis.addEventListener("keydown", onToolKey);
        // The GM's text tool: double-clicking a label re-opens the editor (Roll20 behaviour).
        const onTextEdit = (e: MouseEvent) => {
          if (canvasTool !== "text" || e.button !== 0) return;
          editTextAt(toWorld({ clientX: e.clientX, clientY: e.clientY } as PointerEvent));
        };
        canvas.addEventListener("dblclick", onTextEdit);
        // Map pins: click shows the tooltip, double-click opens the linked handout.
        const onPinClick = (e: MouseEvent) => {
          const world = toWorld({ clientX: e.clientX, clientY: e.clientY } as PointerEvent);
          const pin = view.getNotesLayer().pinAt(world, PIN_PICK_RADIUS / (view.camera.scale || 1));
          if (!pin) {
            pinTooltip = null;
            return;
          }
          pinTooltip = {
            id: pin._id,
            x: pin.x,
            y: pin.y,
            title: pin.text,
            body: pin.playerText ?? "",
            visible: pin.visible === true,
          };
        };
        const onPinOpen = (e: MouseEvent) => {
          const world = toWorld({ clientX: e.clientX, clientY: e.clientY } as PointerEvent);
          const pin = view.getNotesLayer().pinAt(world, PIN_PICK_RADIUS / (view.camera.scale || 1));
          if (pin?.journalId) openJournalFromPin(pin);
        };
        canvas.addEventListener("click", onPinClick);
        canvas.addEventListener("dblclick", onPinOpen);
        // D-257 (G-43): with the wall tool, a *click* on an existing wall edits it — a door
        // toggles closed ⇄ open, `Alt`-click deletes a wall, and a locked door ignores the
        // click. A drag that placed a wall moves more than a few pixels and is ignored.
        let wallDownAt: { x: number; y: number } | null = null;
        const onWallDown = (e: PointerEvent) => {
          wallDownAt = { x: e.clientX, y: e.clientY };
        };
        const onWallClick = (e: MouseEvent) => {
          if (canvasTool !== "wall" || e.button !== 0 || canvasLayer !== "gm") return;
          const down = wallDownAt;
          if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
          const scene = activeScene();
          if (!scene) return;
          const world = toWorld({ clientX: e.clientX, clientY: e.clientY } as PointerEvent);
          const pick = wallPickAt(scene.walls, world, WALL_PICK_RADIUS / (view.camera.scale || 1));
          if (!pick) return;
          const ref = {
            coll: "walls" as const,
            id: pick.wall._id,
            parent: { coll: "scenes" as const, id: scene._id },
          };
          if (e.altKey) {
            current.gm.client.submit([{ kind: "delete", ref }]);
            if (lastPlacement?.kind === "wall" && lastPlacement.id === pick.wall._id) lastPlacement = null;
            return;
          }
          const diff = doorToggleDiff(pick.wall);
          if (diff) current.gm.client.submit([{ kind: "update", ref, diff }]);
        };
        canvas.addEventListener("pointerdown", onWallDown);
        canvas.addEventListener("click", onWallClick);
        let tileDown: { x: number; y: number; tokenId?: string } | null = null;
        const onTileDown = (e: PointerEvent) => {
          tileDown = { x: e.clientX, y: e.clientY,
            ...(tokenSelection.ids.length === 1 && tokenSelection.ids[0] ? { tokenId: tokenSelection.ids[0] } : {}) };
        };
        const onTileClick = (e: MouseEvent) => {
          if (viewingAs || canvasTool !== "select" || !["map", "gm"].includes(canvasLayer) ||
              e.button !== 0 || e.detail > 1 || e.altKey || e.ctrlKey || e.shiftKey || !tileDown ||
              Math.hypot(e.clientX - tileDown.x, e.clientY - tileDown.y) > 4) return;
          const scene = activeScene();
          if (!scene) return;
          const world = toWorld({ clientX: e.clientX, clientY: e.clientY } as PointerEvent);
          if (pickToken(tokenViews(), world)) return;
          const tile = [...scene.tiles].reverse().find((item) => tileContainsPoint(item, world));
          if (tile) current.gm.client.requestAutomationClick(scene._id, tile._id, world, tileDown.tokenId);
        };
        canvas.addEventListener("pointerdown", onTileDown);
        canvas.addEventListener("click", onTileClick);
        // The overlay's stroke widths are screen-constant, so a pan/zoom redraws it (the key
        // inside WallsLayer.sync keeps this cheap — nothing is rebuilt when the camera is still).
        let lastCameraKey = "";
        const onCameraTick = () => {
          const cam = view.camera;
          const key = `${cam.x}|${cam.y}|${cam.scale}`;
          if (key === lastCameraKey) return;
          lastCameraKey = key;
          syncWallsOverlay();
          // D-271: the overlay's outlines are screen-constant, so a zoom restrokes them (the plan
          // itself is untouched — that is what the identity cache is for).
          repaintHexOverlay(view, hexOverlay);
          // D-275: …and the DOM overlays (a route line, a measurement) follow the same tick.
          cameraEpoch++;
        };
        view.app.ticker.add(onCameraTick);
        toolCleanup = () => {
          canvas.removeEventListener("pointerdown", onToolDown);
          canvas.removeEventListener("pointermove", onToolMove);
          canvas.removeEventListener("pointerup", onToolUp);
          canvas.removeEventListener("contextmenu", onToolContext);
          canvas.removeEventListener("dblclick", onTextEdit);
          canvas.removeEventListener("click", onPinClick);
          canvas.removeEventListener("dblclick", onPinOpen);
          canvas.removeEventListener("pointerdown", onWallDown);
          canvas.removeEventListener("click", onWallClick);
          canvas.removeEventListener("pointerdown", onTileDown);
          canvas.removeEventListener("click", onTileClick);
          view.app.ticker.remove(onCameraTick);
          globalThis.removeEventListener("keydown", onToolKey);
        };
        // F01 — expose for chat roll-card highlights & e2e (canvasSmoke)
        (globalThis as unknown as { __stage?: unknown }).__stage = view;
        view.fit(scene?.width ?? 2000, scene?.height ?? 1500);
        // D-250: the GM's explored map — every vision token reveals; persisted through the
        // same fog.put/fog.get the players use (the GM UI only ever speaks ClientSync, §2).
        fog = new FogExploration({
          surfaceFor: (sc) => view.getFogLayer({ width: sc.width, height: sc.height }),
          hideSurface: () => view.hideFogLayer(),
          computer: createVisionComputer(),
          // D-262: under a preview the transport is not the GM's session — the *previewed* player's
          // stored map is read from the host's own fog store (the host is this very tab) and
          // **nothing is ever uploaded for them**: a preview must not overwrite the map a player
          // explored. With no preview this is the ordinary GM session, exactly as before.
          transport: {
            requestFog: async (sceneId) => {
              const viewed = viewAsPlayer;
              if (viewed === null) return current.gm.client.requestFog(sceneId);
              try {
                const stored = await getFog(current.db, current.worldId, sceneId, viewed.id);
                return stored?.png ?? null;
              } catch {
                return null;
              }
            },
            sendFogPng: (sceneId, png) => {
              if (viewAsPlayer === null) current.gm.client.sendFogPng(sceneId, png);
            },
          },
          user: () => viewAsPlayer ?? current.gm.client.user,
          actors: () =>
            current.gm.client.store.getAll("actors") as readonly ActorDocument[],
          // §5: the host withholds `hidden` documents from a player's replica; the preview runs
          // client-side on the GM's own store, so the gate has to withhold them too (core/viewAs).
          visibilityFilter: (sc, ids) =>
            viewAsPlayer === null ? ids : withoutHiddenTokens(sc, ids),
          onVisibility: (ids) => {
            viewAsVisible = ids;
            // Only a preview gates the GM's canvas — the GM's own view stays ungated (`null`).
            view.setTokenVisibility(viewAsPlayer === null ? null : ids);
          },
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
          // D-271: the same gesture where no token was hit — empty ground. Non-hexcrawl scenes
          // have no cells, so this returns immediately and nothing changes for them.
          onCanvasContextMenu: ({ screen, world }) => openHexMenu(screen, world),
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
                ? deriveFromActorDocument(actor, encumbranceOptionsOf(worldSettingsFrom(current.gm.client.store.getAll("settings"))))
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
                  ? deriveFromActorDocument(
                      moverActor,
                      encumbranceOptionsOf(
                        worldSettingsFrom(current.gm.client.store.getAll("settings")),
                      ),
                    )
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
          // §10/D-255: draw/text/measure own the canvas (no marquee or token drag under a
          // stroke); the Pan tool pans on left-drag like Roll20's Pan mode.
          interactionMode: () =>
            canvasTool === "select" ? "select" : canvasTool === "pan" ? "pan" : "suppress",
          // D-256: only the Objects & Tokens layer answers a token pointer (Roll20's layers).
          tokenLayerActive: () => canvasLayer === "tokens",
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
                  distance: scene?.grid.distance ?? 1,
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
          // D-271: the party's ring is written by whoever has the scene's write permission —
          // the GM's replica sees every move (their own drag and a player's alike) here.
          reconcilePartySight();
          // D-273: …and the same listener is where a border crossing becomes `entering`/`moving`.
          encounterAfterPartyMove();
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
                  distance: scene?.grid.distance ?? 1,
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
          fogStoredBytesFor: async ({ sceneId, userId }) => {
            try {
              const stored = await getFog(current.db, current.worldId, sceneId, userId);
              return stored?.png.length ?? 0;
            } catch {
              return 0;
            }
          },
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
          sceneDarkness: () => {
            const value = activeScene()?.darkness;
            return typeof value === "number" && Number.isFinite(value)
              ? Math.max(0, Math.min(1, value))
              : 0;
          },
          godView: () => gmState.godView,
          viewAsFaction: () => gmState.viewAsFaction,
          viewAsState: () => ({
            user: viewAsPlayer?.id ?? null,
            followedPlayers: viewAsOptions(
              current.gm.client.store.getAll("users") as readonly UserDocument[],
              current.gm.client.user,
            ).length,
            drawnTokens: view.drawnTokenIds(),
            pickableTokens: tokenViews().map((t) => t.token._id).sort(),
            visibleTokenIds: fog?.stats().visibleTokenIds ?? null,
            tokenHpBars: view.tokenHpBars().map((bar) => bar.id).sort(),
          }),
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
          itemCount: () =>
            (current.gm.client.store.getAll("items") as readonly unknown[]).length,
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
          // §2.2/G-10a: what the GM canvas actually drew — the mode's own gate, read back.
          tokenHpBars: () => view.tokenHpBars(),
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

  // D-250/D-251: god view toggles (Settings / GM extras) restyle the cover at once — and so does
  // choosing (or leaving) a player to view as (D-262): the loop re-enters the scene as that user.
  $effect(() => {
    const style = fogStyle();
    fxPlayer?.syncScene();
    void fog?.sync(activeScene(), { style });
  });

  // D-262: a preview changes *who* the shell is for the parts of the paint that are not the fog
  // loop — above all the hit-point bars, which a player under the default setting has none of.
  // A view switch moves no document, so nothing else would re-run this. The dependency is the
  // *switch* alone and the body is untracked: `refresh()` bumps the store version it also reads
  // (`viewingAs` derives from it), and tracking that would be a self-feeding loop.
  $effect(() => {
    void gmState.viewAsUser;
    untrack(() => {
      refresh();
    });
  });
</script>

<main class="vtt-ui gm-app">
  <header class="app-header">
    <div class="brand-badge" aria-hidden="true">✦</div>
    <div class="header-identity">
      <p class="eyebrow">ARENASTAR <span> / GM TABLE</span></p>
      <h1 title={worldName}>{worldName}</h1>
    </div>
    <div id="status" class="header-status" aria-live="polite">
      <span class="status-connected" title="Local game master"><span class="status-indicator"></span> GM online</span>
      <span class="status-world"><strong class="sr-only">{worldName}.</strong> seq {seq} · tokens {tokenCount}</span>
      <span data-rules-status title="Strategic ruleset — applies to strategic-scale scenes; tactical scenes are heroes only">strategic rules: {app?.rulesBoot?.source === "package" ? `${app.rulesBoot.packageId} v${app.rulesBoot.version}` : `built-in v${app?.rulesBoot.version ?? "?"}`}</span>
    </div>
    <div class="header-actions" aria-label="Game master actions">
      <label class="header-icon file-control" title="Import map" aria-label="Import map">
        <Icon name="mapImport" /><span class="sr-only">Import map</span>
        <input id="map-input" type="file" accept="image/*" onchange={importMap} hidden />
      </label>
      <button data-icon-button id="add-token" class="header-icon" aria-label="Add token" title="Add token" onclick={addToken}><Icon name="addToken" /></button>
      <span class="header-separator" aria-hidden="true"></span>
      <button data-icon-button id="gm-undo" class="header-icon" aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" onclick={undo}><Icon name="undo" /></button>
      <button data-icon-button id="gm-redo" class="header-icon" aria-label="Redo (Ctrl+Y)" title="Redo (Ctrl+Y)" onclick={redo}><Icon name="redo" /></button>
      <button data-icon-button id="gm-macros" class="header-icon" aria-label="Macros" title="Macros" onclick={() => openWindow("macros", "Macros", "macros")}><Icon name="macro" /></button>
      <button data-icon-button id="gm-settings" class="header-icon" aria-label="World settings" title="World settings" onclick={() => openWindow("settings", "Settings", "settings")}><Icon name="settings" /></button>
      <span class="header-separator" aria-hidden="true"></span>
      <button data-icon-button id="export-world" class="header-icon optional-action" aria-label="Export world" title="Export world" onclick={exportWorld}><Icon name="export" /></button>
      <button data-icon-button id="close-world" class="header-icon optional-action" aria-label="Close world" title="Close world" onclick={async () => { await fog?.flush(); onExit?.(); }}><Icon name="close" /></button>
      <button data-icon-button id="session-open" class="header-icon session-trigger" bind:this={sessionTrigger} data-session-trigger
        aria-label="Session & world" aria-expanded={sessionOpen} title="Session & world" onclick={openSession}><Icon name="sliders" /></button>
      <button id="share" class="invite-trigger" title={share ? "Open session & invitation" : "Invite players"}
        aria-label={share ? "Open session & invitation" : "Invite players"}
        onclick={() => { openSession(); if (!share) void beginShare(); }}><Icon name="share" size={18} /><span>{share ? "Session" : "Invite"}</span></button>
    </div>
  </header>
  {#if bootError}<p class="error" role="alert">Boot failed: {bootError}</p>{/if}
  {#if canvasError}<p class="error" role="alert">canvas: {canvasError}</p>{/if}
  {#if app?.rulesBoot?.error}<p class="error rules-boot-error" role="alert">Strategic rules could not load: {app.rulesBoot.error}. Built-in rules are still available.</p>{/if}
  {#if app}
    <section class="shell" aria-label="Game table">
      <div class="canvas-col">
        <div class="scene-bar">
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
            onclick={toggleSceneMenu}
            title="New scene"
            aria-label="New scene"
            aria-expanded={sceneMenu}>+</button
          >
          {#if sceneMenu}
            <div class="scene-menu" data-scene-menu role="menu" aria-label="New scene">
              <button
                id="scene-new-blank"
                type="button"
                role="menuitem"
                onclick={() => {
                  sceneMenu = false;
                  addScene();
                }}>Blank scene</button
              >
              <button
                id="scene-new-hexcrawl"
                type="button"
                role="menuitem"
                data-scene-new-hexcrawl
                onclick={() => {
                  sceneMenu = false;
                  openHexcrawlWizard();
                }}>Hexcrawl scene…</button
              >
            </div>
          {/if}
        </nav>
        <div class="players" aria-label="Players">
          {#each playerUsers as u (u._id)}
            <span class="player" data-player={u._id}
              >{u.name} <small>{u.role}</small></span
            >
          {/each}
        </div>
        </div>
        <div class="dice3d-host" bind:this={dice3dHost}></div>
        <div class="board">
          <div class="toolrail">
            <CanvasToolbar
              bind:active={canvasTool}
              bind:collapsed={canvasToolbarCollapsed}
              bind:layer={canvasLayer}
              isGM={true}
              settings={toolOptions}
              cellSize={activeScene()?.grid.size ?? 100}
              fogStrokes={fogMask.length}
              onEraseAll={eraseAllDrawings}
              onRoll={rollFromToolbar}
              onAction={runCanvasAction}
              onChooseTool={() => { sessionOpen = false; }}
              pathTool={pathToolAvailable}
            />
          </div>
          <div
          class="canvas-host"
          bind:this={canvasHost}
          role="application"
          aria-label="Game board"
          tabindex="-1"
          ondragover={(ev) => {
            if (
              ev.dataTransfer?.types.includes("application/x-vtt-compendium") ||
              ev.dataTransfer?.types.includes("application/x-vtt-encounter")
            ) {
              ev.preventDefault();
            }
          }}
          ondrop={(ev) => {
            void onCompendiumDrop(ev);
            onEncounterDrop(ev);
          }}
          onpointerdown={() => {
            closeTokenMenu();
            // Returning to the board dismisses setup without moving focus away
            // from the canvas. The session remains one click away in the header.
            sessionOpen = false;
          }}
        >
          {#if travelPanel && (travelPanel.rows.length > 0 || travelPanel.committed)}
            {@const routeScene = activeScene()}
            {@const routePts = routeScene
              ? routePointsOf(routeScene, travelPathOf(routeScene)).map(measurePoint)
              : []}
            {#if routePts.length > 1}
              <svg class="travel-route" aria-label="Travel route" data-travel-route={routePts.length}>
                <polyline
                  points={routePts.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="#8ad9ff"
                  stroke-width="3"
                  stroke-dasharray="10 6"
                />
                {#each routePts as p, i (i)}
                  <circle cx={p.x} cy={p.y} r={i === 0 ? 7 : 5} fill={i === 0 ? "#8ad9ff" : "#0b0f14"} stroke="#8ad9ff" stroke-width="2" />
                {/each}
              </svg>
            {/if}
            <div class="travel-panel" data-travel-panel data-travel-draft={travelPanel.draft} data-travel-committed={travelPanel.committed}>
              <strong>Travel</strong>
              <span class="static" data-travel-party>from {travelPanel.party ?? "—"}</span>
              {#if travelPanel.rows.length === 0}
                <span class="static" data-travel-empty>click hexes to draw a route</span>
              {:else}
                {#each travelPanel.rows as row, i (i)}
                  <div class="travel-row" data-travel-row={row.key} data-travel-terrain={row.terrainName} data-travel-cost={row.cost} data-travel-seconds={row.seconds}>
                    <span class="step">{i + 1}</span>
                    <span class="key">{row.key}</span>
                    <span class="terrain">{row.terrainName}</span>
                    <span class="cost">×{row.cost}</span>
                    <span class="time">{formatDuration(row.seconds)}</span>
                  </div>
                {/each}
                <div class="travel-total" data-travel-total={travelPanel.totalSeconds}>
                  {travelPanel.rows.length} hex(es) · {formatDuration(travelPanel.totalSeconds)} on the road
                  {#if travelPanel.committed && travelPanel.travelledSeconds > 0}
                    · {formatDuration(travelPanel.totalSeconds - travelPanel.travelledSeconds)} left
                  {/if}
                </div>
              {/if}
              <label class="pace">
                Pace
                <select
                  data-travel-pace
                  value={travelPace}
                  onchange={(e) => (travelPace = (e.target as HTMLSelectElement).value as TravelPace)}
                >
                  <option value="normal">normal</option>
                  <option value="forced">forced march</option>
                </select>
              </label>
              {#if travelPanel.committed}
                <p class="hint" data-travel-hint>{hexTravel.hint}</p>
              {/if}
              <div class="travel-actions">
                {#if travelPanel.draft}
                  <button type="button" data-travel-commit onclick={() => commitTravelRoute()}>Commit route</button>
                {/if}
                {#if travelPanel.committed}
                  <button type="button" data-travel-advance="next" onclick={() => advanceTravel("next")}>To the next hex</button>
                  <button type="button" data-travel-advance="route" onclick={() => advanceTravel("route")}>Travel the route</button>
                  <button type="button" data-travel-advance="dawn" onclick={() => advanceTravel("dawn")}>To dawn</button>
                  <button type="button" data-travel-advance="dusk" onclick={() => advanceTravel("dusk")}>To dusk</button>
                  <button type="button" data-travel-advance="day" onclick={() => advanceTravel("day")}>+1 day</button>
                {/if}
                <button type="button" data-travel-clear onclick={() => clearTravelRoute()}>Clear</button>
              </div>
            </div>
          {/if}
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
                {#if preview.shape === "rect"}
                  <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} fill={preview.brush === "hide" ? "#0a0f1599" : "#ffd47933"} stroke={preview.brush === "hide" ? "#8892a6" : "#ffd479"} stroke-width="2" stroke-dasharray="6 4" />
                {:else}
                  <polyline points={preview.points.map((p) => { const q = measurePoint(p); return `${q.x},${q.y}`; }).join(" ")} fill={preview.brush === "hide" ? "#0a0f1599" : "#ffd47933"} stroke={preview.brush === "hide" ? "#8892a6" : "#ffd479"} stroke-width="2" stroke-dasharray="6 4" />
                {/if}
              {:else}
                {@const a = measurePoint(preview.from)}
                {@const b = measurePoint(preview.to)}
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={preview.wallKind === "door" ? "#8ad9ff" : preview.wallKind === "window" ? "#7ee0ff" : "#ff9f6e"} stroke-width="4" stroke-dasharray="10 5" />
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
          {#if pinTooltip}
            {@const anchor = measurePoint(pinTooltip)}
            <div class="pin-tooltip" data-pin-tooltip={pinTooltip.id} style={`left:${anchor.x}px; top:${anchor.y}px;`}>
              <strong>{pinTooltip.title}</strong>
              <input
                aria-label="Pin title"
                value={pinTooltip.title}
                onchange={(event) => updatePin({ text: event.currentTarget.value })}
              />
              <input
                aria-label="Player-facing note"
                placeholder="Players read this…"
                value={pinTooltip.body}
                onchange={(event) => updatePin({ playerText: event.currentTarget.value })}
              />
              <button
                type="button"
                data-pin-visibility
                onclick={() => updatePin({ visible: !pinTooltip?.visible })}>
                {pinTooltip.visible ? "Visible to players" : "Hidden (GM only)"}
              </button>
              {#if activeScene()?.notes.find((n) => n._id === pinTooltip?.id)?.journalId}
                <button type="button" data-pin-open-journal onclick={() => { const pin = activeScene()?.notes.find((n) => n._id === pinTooltip?.id); if (pin) openJournalFromPin(pin); }}>Open handout</button>
              {/if}
              <button type="button" data-pin-close onclick={() => (pinTooltip = null)}>Close</button>
            </div>
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
        </div>
          {#if hexMenu}
            <!--
              D-271 (plan §5.2): the empty-ground menu, rendered from the model captured when the
              pointer went down. Disabled rows carry their reason as a tooltip — the same honesty
              rule the token menu follows — and a terrain row shows which terrain is current.
            -->
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
              <span class="token-menu-title">{hexMenu.title}</span>
              {#if hexMenu.subtitle}
                <span class="token-menu-static" data-hex-menu-subtitle>{hexMenu.subtitle}</span>
              {/if}
              {#each hexMenu.entries as entry (entry.id)}
                {#if entry.statik}
                  <span class="token-menu-static" data-hex-menu-static={entry.id}>{entry.label}</span>
                {:else}
                  <button
                    type="button"
                    role="menuitem"
                    data-hex-menu-action={entry.id}
                    disabled={entry.disabled}
                    title={entry.reason ?? ""}
                    onclick={() => runHexMenuEntry(entry.id)}
                    >{entry.checked ? "● " : ""}{entry.label}</button
                  >
                {/if}
              {/each}
            </div>
          {/if}
        <WindowHost
          manager={wm}
          windows={wmWindows}
          client={app.gm.client}
          bus={app.gm.bus}
          sceneId={activeScene()?._id ?? null}
          importImage={importMapFile}
          onFxImport={importFxFile}
          onPickSummon={requestSummonPick}
          onPickAnchor={requestAnchorPick}
          onPreviewFx={previewFxSequence}
          onStopFxPreview={stopFxPreview}
          listFxAssets={() => Promise.resolve(app?.assets.manifest() ?? {})}
          {setFxAssetRights}
          getFxAsset={(hash) => app?.assets.get(hash) ?? Promise.resolve(undefined)}
          onUndo={undo}
          onRedo={redo}
          packages={app.packages}
          rulesBoot={app.rulesBoot}
          {agents}
          bindings={DEFAULT_BINDINGS}
          isGM={true}
          onHexRollTable={rollHexTable}
          onHexOpenScene={activateScene}
          onEncounterPlaceAll={(resultId) => void placeEncounterAt({ resultId })}
          onEncounterBattleScene={(resultId) => void createBattleScene({ resultId })}
          {resolveAsset}
        />
        {#if pendingSummonPick}
          {@const summonScene = activeScene()}
          {#if summonScene && summonScene._id === pendingSummonPick.options.sceneId}
            <SummonCrosshair scene={summonScene} options={pendingSummonPick.options}
              camera={() => stage?.camera ?? { x: 0, y: 0, scale: 1 }}
              pick={(at) => settleSummonPick(at)} cancel={() => settleSummonPick(null)} />
          {/if}
        {/if}
        {#if pendingAnchorPick}
          {@const anchorScene = activeScene()}
          {#if anchorScene && anchorScene._id === pendingAnchorPick.options.sceneId}
            <AnchorPicker scene={anchorScene} options={pendingAnchorPick.options}
              camera={() => stage?.camera ?? { x: 0, y: 0, scale: 1 }}
              pick={(at) => settleAnchorPick(at)} cancel={() => settleAnchorPick(null)} />
          {/if}
        {/if}
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
      <aside class="sidebar" data-gm-dock aria-label="Game content">
        <div class="dock-heading">
          <div><span class="dock-eyebrow">YOUR TABLE</span><h2>{TABS.find((tab) => tab.id === activeTab)?.label ?? "Game content"}</h2></div>
          <div class="dock-actions" aria-label="GM libraries">
            <button data-icon-button id="gm-perms" type="button" aria-label="Permissions" title="Permissions" onclick={() => openWindow("permissions", "Permissions", "permissions")}><Icon name="permissions" size={18} /></button>
            <button data-icon-button id="gm-extras" type="button" aria-label="GM extras" title="GM extras" onclick={() => openWindow("gmextras", "GM Extras", "gmextras")}><Icon name="extras" size={18} /></button>
            <button data-icon-button id="gm-armies" type="button" aria-label="Armies" title="Armies" onclick={() => openWindow("armies", "Armies", "armies")}><Icon name="armies" size={18} /></button>
            <button data-icon-button id="gm-tables" type="button" aria-label="Tables" title="Tables" onclick={() => openTablesWindow()}><Icon name="tables" size={18} /></button>
          </div>
        </div>
        <nav class="tabs" aria-label="Sidebar tabs">
          {#each TABS as t (t.id)}
            <button
              type="button"
              class:active={activeTab === t.id}
              data-tab={t.id}
              aria-label={t.label}
              title={t.label}
              onclick={() => (activeTab = t.id)}
            >
              <Icon name={t.id} size={19} /><span>{t.label}</span>
            </button>
          {/each}
        </nav>
        <div class="tabbody" data-active-tab={activeTab}>
          {#if activeTab === "chat"}
            <ChatPanel
              client={app.gm.client}
              bus={app.gm.bus}
              targetTokenId={tokenSelection.ids.length === 1
                ? (tokenSelection.ids[0] ?? null)
                : null}
              onEncounterRoll={rollEncounterTable}
              onEncounterExplore={exploreCell}
            />
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
        <div class="dock-footer">
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
        {#if app}
          <QuickbarRow
            client={app.gm.client}
            actor={quickbarActor}
            targets={quickbarTargets}
          />
        {/if}
        </div>
      </aside>
    </section>
    {#if sessionOpen}
      <div class="session-panel" data-session-panel role="dialog" aria-modal="false" aria-labelledby="session-title"
        tabindex="-1" bind:this={sessionFocus}
        onkeydown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeSession(); } }}>
        <header class="session-heading">
          <div><span class="dock-eyebrow">TABLE SETUP</span><h2 id="session-title">Session & world</h2></div>
          <button data-icon-button class="session-close" type="button" aria-label="Close session panel" title="Close session panel" onclick={closeSession}><Icon name="x" size={20} /></button>
        </header>
        <div class="session-content">
          <p class="session-intro">Get the table ready, invite your players, or manage this world. You can return here anytime from the top bar.</p>
          <section class="session-card">
            <h3>Get started</h3>
            <OnboardingPanel steps={onboarding} storageKey="vtt-onboarding-gm" title="Getting started" />
          </section>
        <section class="invite-panel" aria-labelledby="invite-heading">
          <div class="section-heading">
            <h2 id="invite-heading">Invite players</h2>
            <p>Share the link, then complete the one-time code exchange.</p>
          </div>
          {#if !share}
            <button id="create-invite" type="button" onclick={() => void beginShare()}>
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
          <section class="session-card world-card">
            <div class="section-heading"><h2>World files</h2><p data-world-name>{worldName}</p></div>
            <p class="hint">Your table saves locally as you play. Export a copy to keep or move it.</p>
            {#if typeof globalThis.showDirectoryPicker === "function"}<button id="export-folder" type="button" onclick={exportToFolder}>Save to folder…</button>{/if}
            <p class="hint">Use the export and close shortcuts in the top bar when you need them.</p>
          </section>
          <details class="capabilities"><summary>System health & capabilities ({ready}/{rows.length} available)</summary>
    <ul>
      {#each rows as [name, ok] (name)}
        <li class:ok class:missing={!ok}>
          <span class="dot" aria-hidden="true"></span>
          <span class="name">{name}</span>
          <span class="state">{ok ? "available" : "unavailable"}</span>
        </li>
      {/each}
    </ul>
          </details>
        </div>
      </div>
    {/if}
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
  /* The table is the product's home, not a card under a landing-page header. */
  main.gm-app {
    --gm-dock-width: clamp(312px, 25vw, 376px);
    width: 100%;
    height: 100dvh;
    min-height: 480px;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #0c141d;
  }
  .app-header {
    flex: 0 0 70px;
    min-height: 70px;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 16px;
    border-bottom: 1px solid #344352;
    background: #17222e;
    box-shadow: 0 2px 16px #0004;
    z-index: 23;
  }
  .brand-badge {
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
    box-shadow: 0 3px 16px #47d1aa22;
  }
  .header-identity { flex: 0 1 190px; min-width: 95px; overflow: hidden; }
  .eyebrow {
    margin: 0 0 2px;
    color: #7ce3ca;
    font-size: .63rem;
    font-weight: 800;
    letter-spacing: .13em;
    white-space: nowrap;
  }
  .eyebrow span { color: #96aaaF; font-weight: 650; }
  h1 {
    margin: 0;
    overflow: hidden;
    color: #f5fafb;
    font-size: 1.12rem;
    font-weight: 750;
    line-height: 1.2;
    letter-spacing: -.018em;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  #status {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    color: #b6c7d0;
    font-size: .76rem;
    font-variant-numeric: tabular-nums;
  }
  #status strong { color: #e9f1f3; font-weight: 600; }
  #status [data-rules-status] { overflow: hidden; text-overflow: ellipsis; color: #9daebb; font-size: .73rem; }
  .status-connected {
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
  .status-indicator { width: 7px; height: 7px; border-radius: 50%; background: #66dbc0; box-shadow: 0 0 7px #6cebd28c; }
  .status-world { flex: 0 0 auto; }
  .header-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 3px; }
  .header-actions .header-icon,
  .header-actions .invite-trigger {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: #bacbd3;
    cursor: pointer;
    text-align: center;
  }
  .header-actions .header-icon:hover { background: #2a3c4b; color: #f7fffd; border-color: #466270; }
  .header-actions .session-trigger { color: #a5e7d9; }
  .header-actions .session-trigger[aria-expanded="true"] { border-color: #48877e; background: #244b49; }
  .header-actions .invite-trigger {
    gap: 8px;
    width: auto;
    min-width: 87px;
    padding: 0 12px;
    margin-left: 5px;
    border-color: #529e90;
    background: #255a56;
    color: #eafff9;
    font-size: .85rem;
    font-weight: 700;
  }
  .header-actions .invite-trigger:hover { background: #306f65; border-color: #7adac4; }
  .header-separator { width: 1px; height: 23px; margin-inline: 5px; background: #41515e; }
  .file-control { position: relative; }
  .file-control input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .error { margin: 0; padding: 8px 16px; color: #ffb7ae; background: #372020; font-size: .85rem; }
  .shell {
    flex: 1 1 auto;
    display: flex;
    gap: 0;
    width: 100%;
    min-width: 0;
    min-height: 0;
    height: auto;
    border: 0;
    border-radius: 0;
    background: #101a24;
  }
  .canvas-col { order: 0; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .scene-bar {
    flex: 0 0 46px;
    min-height: 46px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid #354656;
    background: #15222e;
  }
  .scenenav {
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 5px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 5px 12px;
    border: 0;
    scrollbar-width: thin;
    scrollbar-color: #4d6971 transparent;
  }
  .scenenav button {
    flex: 0 0 auto;
    width: auto;
    min-height: 33px;
    padding: 5px 11px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: #afc0c9;
    font-size: .82rem;
    white-space: nowrap;
  }
  .scenenav button.active { border-color: #44877f; background: #21453f; color: #d4f9ec; }
  .scene-menu {
    position: absolute;
    top: 42px;
    left: 12px;
    z-index: 35;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px;
    border: 1px solid #536e7d;
    border-radius: 10px;
    background: #202f3d;
    box-shadow: 0 14px 30px #0008;
  }
  .scene-menu button { text-align: left; }
  .players {
    flex: 0 0 auto;
    max-width: min(40%, 360px);
    height: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    overflow-x: auto;
    white-space: nowrap;
    padding: 5px 12px;
    border-left: 1px solid #354656;
    color: #d6e5e7;
    font-size: .76rem;
  }
  .players small { color: #92aaaf; }
  .sidebar {
    order: 1;
    flex: 0 0 var(--gm-dock-width);
    width: var(--gm-dock-width);
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow: hidden;
    padding: 0;
    border-left: 1px solid #344657;
    background: #16222e;
  }
  .dock-heading {
    flex: 0 0 60px;
    min-height: 60px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 8px 10px 8px 15px;
  }
  .dock-eyebrow { color: #81d4c5; font-size: .64rem; font-weight: 800; letter-spacing: .13em; }
  .dock-heading h2, .session-heading h2 { margin: 1px 0 0; font-size: .98rem; font-weight: 700; color: #f0f8f9; }
  .dock-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 1px; }
  .dock-actions button {
    flex: 0 0 32px;
    display: grid;
    place-items: center;
    width: 32px;
    min-width: 32px;
    height: 32px;
    min-height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: #aabdc6;
    cursor: pointer;
  }
  .dock-actions button:hover { border-color: #527a7b; background: #293f49; color: #edfbf8; }
  .tabs {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: nowrap;
    gap: 2px;
    min-height: 46px;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    white-space: nowrap;
    padding: 0 10px;
    border-bottom: 1px solid #3b4b59;
    scrollbar-width: thin;
    scrollbar-color: #56737b transparent;
  }
  .tabs button {
    flex: 1 0 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: auto;
    min-width: 39px;
    min-height: 44px;
    padding: 7px;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: #a8b9c4;
    cursor: pointer;
  }
  .tabs button span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .tabs button:hover { color: #effcfa; background: #243440; }
  .tabs button.active { border-bottom-color: #74d9c5; background: #1b3037; color: #b9f7e4; }
  .tabbody {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    overflow: auto;
    padding: 13px 14px;
    border: 0;
    border-radius: 0;
    background: #15222d;
  }
  .tabbody :global(.chat) { min-height: 100%; height: 100%; }
  .tabbody :global(#chat-log) { flex: 1 1 auto; max-height: none; min-height: 120px; border-color: #344957; background: #101a24; }
  .dock-footer {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 190px;
    overflow-y: auto;
    padding: 8px 10px;
    border-top: 1px solid #3a4b59;
    background: #192834;
  }
  .hotbar { display: flex; gap: 3px; }
  .hotbar .slot { flex: 1 1 0; min-width: 0; overflow: hidden; padding: 4px 0; font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
  .board { flex: 1 1 auto; display: flex; min-width: 0; min-height: 0; }
  .toolrail { flex: 0 0 auto; display: flex; min-height: 0; }
  .canvas-host { flex: 1 1 auto; min-width: 0; min-height: 0; position: relative; background: #0d151e; }
  .session-panel {
    position: fixed;
    top: 70px;
    /* A nonmodal setup surface: keep chat and quick actions in the dock usable. */
    right: var(--gm-dock-width);
    bottom: 0;
    z-index: 70;
    width: min(440px, calc(100vw - var(--gm-dock-width) - 64px));
    display: flex;
    flex-direction: column;
    border: 1px solid #4b6d73;
    border-right: 0;
    border-bottom: 0;
    border-radius: 14px 0 0 0;
    background: #172530;
    box-shadow: -20px 0 60px #050a11a8, -2px 0 12px #050a1166;
  }
  .session-heading {
    flex: 0 0 70px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    border-bottom: 1px solid #405460;
    background: #1a2b36;
    border-radius: 14px 0 0 0;
  }
  .session-heading h2 { font-size: 1.25rem; letter-spacing: -.02em; }
  .session-close {
    display: grid;
    place-items: center;
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
    padding: 0;
    border: 1px solid #49616c;
    border-radius: 9px;
    background: #293d48;
    color: #d2e1e4;
    cursor: pointer;
  }
  .session-close:hover { background: #354f56; }
  .session-content { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; overscroll-behavior: contain; padding: 18px; }
  .session-intro { margin: 0; color: #b0c5cb; font-size: .87rem; line-height: 1.5; }
  .session-card, .capabilities { padding: 15px; border: 1px solid #405564; border-radius: 11px; background: #1c2b37; }
  .session-card h3 { margin: 0 0 10px; color: #eff7f7; font-size: .92rem; }
  .world-card { display: flex; flex-direction: column; gap: 9px; }
  .world-card .hint { margin: 0; }
  .capabilities { margin: 0; }
  .capabilities summary { cursor: pointer; color: #d1e4e5; font-size: .86rem; font-weight: 650; }
  .capabilities ul { display: grid; grid-template-columns: 1fr; gap: 8px; list-style: none; margin: 15px 0 0; padding: 0; }
  .capabilities li { display: flex; align-items: center; gap: 8px; min-height: 24px; color: #c8d9de; font-size: .83rem; }
  .capabilities li.missing { opacity: .65; }
  .capabilities .dot { flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%; background: #7a8c98; }
  .capabilities li.ok .dot { background: #73d8c5; }
  .capabilities .state { margin-left: auto; color: #91a6af; }
  .rules-boot-error { margin: 0; }
  button { display: block; width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 9px; border: 1px solid #465d6c; background: #243543; color: #f2f8f8; cursor: pointer; text-align: center; }
  button:hover:not(:disabled) { background: #30505c; border-color: #78c9b8; }
  @media (max-width: 1220px) {
    #status [data-rules-status] { display: none; }
    .app-header { gap: 9px; padding-inline: 12px; }
    .header-identity { flex-basis: 150px; }
  }
  @media (max-width: 1100px) {
    /* Narrow tables keep the full board in view while setup is open. */
    .session-panel { right: 0; width: min(440px, 100vw); }
  }
  @media (max-width: 930px) {
    main.gm-app { --gm-dock-width: 306px; }
    .header-status .status-world { display: none; }
    .header-actions { gap: 0; }
    .header-separator { margin-inline: 2px; }
  }
  @media (max-width: 710px) {
    .app-header { flex-basis: 60px; min-height: 60px; gap: 6px; padding-inline: 8px; }
    .brand-badge { display: none; }
    .header-identity { flex: 0 0 94px; min-width: 0; }
    .header-identity .eyebrow span { display: none; }
    .header-status { display: none !important; }
    .header-actions { flex: 1 1 auto; min-width: 0; justify-content: flex-end; overflow-x: auto; scrollbar-width: none; }
    .header-actions::-webkit-scrollbar { display: none; }
    .header-actions .header-icon { width: 32px; min-width: 32px; }
    .header-actions .invite-trigger { min-width: 40px; padding-inline: 9px; }
    .header-actions .invite-trigger span { display: none; }
    .shell { flex-direction: column; }
    .canvas-col { flex: 1 1 auto; min-height: 0; }
    .players { max-width: 30%; }
    .sidebar { order: 1; flex: 0 0 min(42dvh, 360px); width: 100%; min-height: 0; border-left: 0; border-top: 1px solid #344657; }
    .dock-heading { flex-basis: 44px; min-height: 44px; }
    .dock-eyebrow { display: none; }
    .session-panel { top: 60px; width: min(440px, 100vw); }
    .tabbody { padding: 9px 12px; }
    .tabbody :global(#chat-log) { min-height: 80px; }
    .dock-footer { display: flex; max-height: 80px; overflow-y: auto; padding: 4px 10px; }
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
  .hex-menu {
    position: absolute;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 250px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 8px;
    background: #1a2a24;
    border: 1px solid #4f7f66;
    border-radius: 9px;
    box-shadow: 0 8px 24px #0009;
  }
  .hex-menu button {
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    padding: 5px 8px;
    cursor: pointer;
  }
  .hex-menu button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .board {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  /* D-255: the toolbar is its own column (Roll20's rail), so it never swallows a click
     meant for the map, a token under it, or a window that opens over the board. */
  .toolrail {
    flex: 0 0 auto;
    display: flex;
  }
  .canvas-host {
    flex: 1;
    min-width: 0;
    position: relative;
    background: #0a0f15;
  }
  /* D-275: the route + itinerary. The line sits in the canvas-host's overlay space (the same
     one the measure preview uses) and the panel is a small HUD box under the rail. */
  .travel-route {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: visible;
  }
  .travel-panel {
    position: absolute;
    left: 12px;
    bottom: 12px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 260px;
    max-width: 340px;
    padding: 8px 10px;
    border: 1px solid #2a3446;
    border-radius: 8px;
    background: #0e141dee;
    color: #e7ecf5;
    font-size: 0.78rem;
  }
  .travel-panel .static {
    opacity: 0.75;
  }
  /* D-276: the one line the advance buttons need beside them — the clock is what they spend. */
  .travel-panel .hint {
    margin: 2px 0 0;
    color: #8b9bb1;
    line-height: 1.35;
  }
  .travel-row {
    display: grid;
    grid-template-columns: 1.4rem 3.2rem 1fr 2.4rem 3.4rem;
    gap: 4px;
    align-items: baseline;
  }
  .travel-row .step {
    opacity: 0.6;
  }
  .travel-row .terrain {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .travel-total {
    border-top: 1px solid #2a3446;
    padding-top: 4px;
    opacity: 0.85;
  }
  .travel-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }

  .measure-preview { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; overflow: visible; }
  /* D-256: draw/fog/wall gesture previews and the in-canvas editors */
  .shape-preview { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 11; overflow: visible; }
  .text-editor { position: absolute; z-index: 12; display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid #4c5b7d; border-radius: 5px; background: #111827f2; }
  .text-editor textarea { width: 220px; height: 62px; padding: 5px; color: #fff; background: #0c111b; border: 1px solid #3a455e; border-radius: 3px; resize: both; }
  .text-editor-actions { display: flex; gap: 4px; }
  .pin-tooltip { position: absolute; z-index: 12; display: flex; flex-direction: column; gap: 4px; width: 210px; padding: 7px; border: 1px solid #4c5b7d; border-radius: 5px; background: #111827f2; color: #dbe3f0; font-size: 12px; }
  .pin-tooltip input { padding: 4px; color: #fff; background: #0c111b; border: 1px solid #3a455e; border-radius: 3px; }
  .canvas-host :global(canvas) {
    display: block;
  }

</style>
