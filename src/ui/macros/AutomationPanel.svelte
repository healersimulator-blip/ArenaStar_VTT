<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { AssetManifest, AutomationDocument, DocRef, Json, MacroDocument, RollTableDocument, SceneDocument,
    RegionDocument, TileDocument } from "../../core/documents";
  import { listTaggable } from "../../core/tags";
  import { COMBAT_TRIGGER_METHODS } from "../../core/combat";
  import {
    PINNABLE_COLLECTIONS, automationImageError, isHostDispatchedMethod, validateAutomation, type AutomationDefinition, type AutomationGates, type AutomationMethod,
    type AutomationSelector, type AutomationStep, type AutomationScriptBinding, type AutomationTileTarget,
  } from "../../core/automation";
  import { tileAlphaMaskFromRgba, tileTriggerCirclePolygon, type TileTriggerZone } from "../../core/tileTriggerZone";
  import { regionGeometryError } from "../../core/regionGeometry";
  import { macroAutomationGraphId } from "../../core/macroAutomation";

  let { client, bus, getAsset = null }: { client: ClientSync; bus: EventBus<ClientEvents>;
    getAsset?: ((hash: string) => Promise<Uint8Array | undefined>) | null } = $props();
  const METHODS: AutomationMethod[] = ["enter", "exit", "stop", "elevation", "create", "sceneChange", "sceneLoad", "rotate", "click", "rightClick", "doubleClick", "hoverIn", "hoverOut", "doorOpen", "doorClose", "doorLock", "doorUnlock", ...COMBAT_TRIGGER_METHODS, "lightingChange", "timeChange", "manual"];
  const KINDS: AutomationStep["kind"][] = ["select", "filter", "checkVariable", "checkValue", "checkScriptResult", "shuffle", "position", "distance", "attributes", "checkData", "condition", "inventory", "tokenTriggerCount", "routeMethod", "routeUser", "forEach", "endEach", "resetHistory", "batchFlush", "collection", "triggerTile", "setActive", "stopOthers", "stopMovement", "set", "gameTime", "sceneLighting", "sceneBackground", "tileImage", "hurtHeal", "random", "tags", "visibility", "door", "move", "rotate", "delete", "chat", "sequence", "script", "summon", "rollTable", "landing", "jump", "stop"];
  const ADD_KINDS = KINDS.filter((kind) => kind !== "endEach");
  const KIND_LABEL: Record<string, string> = { stopMovement: "Stop Token Movement", checkScriptResult: "Check Script Result",
    batchFlush: "Run All Batch Actions", gameTime: "Game Time",
    sceneLighting: "Scene Lighting", sceneBackground: "Scene Background", tileImage: "Switch Tile Image",
    hurtHeal: "Hurt / Heal", move: "Move", rotate: "Rotation", delete: "Delete Entities", rollTable: "Roll Table" };
  const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;
  const methodLabel = (method: AutomationMethod): string => method === "rightClick" ? "right click"
    : method === "doubleClick" ? "double click" : method === "hoverIn" ? "hover in"
      : method === "hoverOut" ? "hover out" : method === "sceneChange" ? "scene change"
        : method === "sceneLoad" ? "scene load"
        : method === "doorOpen" ? "door open" : method === "doorClose" ? "door close"
          : method === "doorLock" ? "door lock" : method === "doorUnlock" ? "door unlock"
            : method === "combatStart" ? "combat start" : method === "combatRound" ? "combat round"
              : method === "combatTurnStart" ? "combat turn start" : method === "combatTurnEnd" ? "combat turn end"
                : method === "combatEnd" ? "combat end"
                  : method === "lightingChange" ? "lighting change"
                    : method === "timeChange" ? "time change" : method;
  const firstSimulatableMethod = (methods: readonly AutomationMethod[]): AutomationMethod | undefined =>
    methods.find((method) => !isHostDispatchedMethod(method));
  /** What the wizard says instead of offering a Simulate control for host-observed events. */
  const hostEventHint = (methods: readonly AutomationMethod[]): string => {
    const events = methods.filter(isHostDispatchedMethod).map(methodLabel);
    return `${events.join(", ")} fire${events.length === 1 ? "s" : ""} automatically from committed world state; no manual simulation is offered.`;
  };
  const canEdit = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  let scenes = $state<SceneDocument[]>([]);
  let macros = $state<MacroDocument[]>([]);
  let automationMacros = $state<MacroDocument[]>([]);
  let scripts = $state<MacroDocument[]>([]);
  let summons = $state<MacroDocument[]>([]);
  let rollTables = $state<RollTableDocument[]>([]);
  let assets = $state<AssetManifest>({});
  const imageAssets = $derived(Object.entries(assets).filter(([hash]) => !automationImageError(hash, assets)));
  let saved = $state<AutomationDocument[]>([]);
  let editing = $state("");
  let name = $state("");
  let sceneId = $state("");
  let sourceKind = $state<"tile" | "region">("tile");
  let tileId = $state("");
  let tileName = $state("Active zone");
  let tileX = $state(100), tileY = $state(100);
  let tileWidth = $state(200), tileHeight = $state(200), tileRotation = $state(0);
  let tileSort = $state(0), tileHidden = $state(false);
  let tileElevationLimited = $state(false), tileElevationMin = $state(0), tileElevationMax = $state(10);
  let tileTriggerShape = $state<"rectangle" | "triangle" | "diamond" | "circle" | "alpha">("rectangle");
  let tileTriggerImage = $state("");
  let tileCreating = $state(false);
  let regionName = $state("Scene region");
  let regionX = $state(100), regionY = $state(100), regionWidth = $state(200), regionHeight = $state(200);
  let regionRotation = $state(0), regionSort = $state(0), regionHidden = $state(false);
  let regionShape = $state<"rectangle" | "triangle" | "diamond" | "circle">("rectangle");
  let regionElevationLimited = $state(false), regionElevationMin = $state(0), regionElevationMax = $state(10);
  let tokenId = $state("");
  let triggerMethod = $state<AutomationMethod>("enter");
  let definition = $state<AutomationDefinition>({
    version: 1, sceneId: "", tileId: "", methods: ["enter", "stop", "manual"], gates: { paused: false },
    steps: [
      { id: "select", kind: "select", selector: { kind: "triggering" } },
      { id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" },
    ],
  });
  let status = $state("");
  let error = $state("");
  let lastTrace = $state<ClientEvents["automationTrace"] | null>(null);
  const scene = $derived(scenes.find((s) => s._id === sceneId) ?? null);
  const selectedTile = $derived(sourceKind === "tile" ? scene?.tiles.find((t) => t._id === tileId) : undefined);
  const selectedRegion = $derived(sourceKind === "region" ? scene?.regions?.find((region) => region._id === tileId) : undefined);
  const tagOptions = $derived(scene ? listTaggable(client.store.world, { sceneId: scene._id }) : []);

  function refresh(): void {
    scenes = [...client.store.getAll("scenes")];
    assets = { ...client.store.world.assetManifest };
    saved = [...client.store.getAll("automations")];
    macros = [...client.store.getAll("macros")].filter((m) => m.kind === "sequence");
    automationMacros = [...client.store.getAll("macros")].filter((m) => m.kind === "automation");
    scripts = [...client.store.getAll("macros")].filter((m) => m.kind === "script");
    summons = [...client.store.getAll("macros")].filter((m) => m.kind === "summon");
    rollTables = [...client.store.getAll("rollTables")];
    if (!scenes.some((s) => s._id === sceneId)) sceneId = scenes.find((s) => s.active)?._id ?? scenes[0]?._id ?? "";
    const sources = sourceKind === "region" ? scene?.regions ?? [] : scene?.tiles ?? [];
    if (!sources.some((source) => source._id === tileId)) tileId = sources[0]?._id ?? "";
  }
  function pick(doc: AutomationDocument): void {
    const checked = validateAutomation(doc.definition);
    if (!checked.ok) { error = `Imported graph is invalid: ${checked.error}`; return; }
    editing = doc._id;
    name = doc.name;
    definition = { ...$state.snapshot(checked.definition), gates: { ...checked.definition.gates } };
    sceneId = checked.definition.sceneId;
    sourceKind = checked.definition.sourceKind ?? "tile";
    tileId = checked.definition.tileId;
    triggerMethod = firstSimulatableMethod(checked.definition.methods) ?? "sceneChange";
    error = "";
    status = "Editing saved graph (history is kept separately)";
  }
  function reset(): void {
    editing = "";
    name = "";
    sourceKind = "tile";
    triggerMethod = "enter";
    definition = { version: 1, sceneId: "", tileId: "", methods: ["enter", "stop", "manual"],
      gates: { paused: false }, steps: [
        { id: "select", kind: "select", selector: { kind: "triggering" } },
        { id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" },
      ] };
    error = ""; status = ""; lastTrace = null;
  }
  function toggle(method: AutomationMethod): void {
    definition.methods = definition.methods.includes(method)
      ? definition.methods.filter((m) => m !== method) : [...definition.methods, method];
    if (!definition.methods.includes(triggerMethod) || isHostDispatchedMethod(triggerMethod))
      triggerMethod = firstSimulatableMethod(definition.methods) ?? "sceneChange";
  }
  function newStep(kind: AutomationStep["kind"], id = `step-${crypto.randomUUID().slice(0, 8)}`): AutomationStep {
    switch (kind) {
      case "select": return { id, kind, selector: { kind: "triggering" } };
      case "filter": return { id, kind, test: { kind: "count", min: 1 } };
      case "checkVariable": return { id, kind, name: "charge", compare: "gte", value: 1 };
      case "checkValue": return { id, kind, source: "darkness", compare: "gte", value: 0.5 };
      case "checkScriptResult": return { id, kind,
        scriptStepId: definition.steps.find((step) => step.kind === "script" && step.captureResult)?.id ?? "",
        path: "ok", compare: "eq", value: true };
      case "shuffle": return { id, kind };
      case "position": return { id, kind, index: 1 };
      case "distance": return { id, kind, from: "tile", max: 30 };
      case "attributes": return { id, kind, path: "name", compare: "eq", value: "" };
      case "checkData": return { id, kind, path: "width", compare: "gte", value: 100 };
      case "condition": return { id, kind, effect: "Prone", mode: "has" };
      case "inventory": return { id, kind, item: "Potion*", compare: "gte", count: 1 };
      case "tokenTriggerCount": return { id, kind, compare: "gte", count: 1 };
      case "routeMethod": return { id, kind, routes: { enter: "landing" } };
      case "routeUser": return { id, kind, gm: "landing" };
      case "forEach": return { id, kind, endId: `end-${id}` };
      case "endEach": return { id, kind, startId: "" }; // only created by newLoop()
      case "resetHistory": return { id, kind };
      case "batchFlush": return { id, kind };
      case "collection": return { id, kind, mode: "add", selector: { kind: "inside" } };
      case "triggerTile": return { id, kind, target: { kind: "id", tileId: scene?.tiles.find((t) => t._id !== tileId)?._id ?? "" },
        tokens: "triggering" };
      case "setActive": return { id, kind, mode: "deactivate",
        target: { kind: "id", tileId: scene?.tiles.find((t) => t._id !== tileId)?._id ?? tileId } };
      case "stopOthers": return { id, kind };
      case "stopMovement": return { id, kind, snapToGrid: false };
      case "set": return { id, kind, name: "value", value: 1 };
      case "gameTime": return { id, kind, minutes: 60 };
      case "sceneLighting": return { id, kind, mode: "set", darkness: 0.5 };
      case "sceneBackground": return { id, kind, image: null };
      case "tileImage": return { id, kind, image: "" };
      case "hurtHeal": return { id, kind, amount: -5, targets: "triggering" };
      case "random": return { id, kind, name: "roll", min: 1, max: 20 };
      case "tags": return { id, kind, edit: "add", tags: ["activated"] };
      case "visibility": return { id, kind, mode: "show" };
      case "door": return { id, kind, mode: "open" };
      case "move": return { id, kind, x: 0, y: 0, targets: "current" };
      case "rotate": return { id, kind, angle: 90, targets: "current" };
      case "delete": return { id, kind };
      case "rollTable": return { id, kind, tableId: rollTables[0]?._id ?? "", audience: "scene" };
      case "chat": return { id, kind, audience: "gm", content: "{{method}} by {{user}}" };
      case "sequence": return { id, kind, macroId: macros[0]?._id ?? "", audience: "gm" };
      case "script": return { id, kind, macroId: scripts.find((m) => m.script?.sceneId === sceneId)?._id ?? "" };
      case "summon": return { id, kind, presetId: summons.find((m) => m.summon?.sceneId === sceneId)?._id ?? "",
        anchor: "tile" };
      case "landing": return { id, kind, name: `landing-${id}` };
      case "jump": return { id, kind, to: "landing" };
      case "stop": return { id, kind };
    }
  }
  function newLoop(id = `step-${crypto.randomUUID().slice(0, 8)}`): AutomationStep[] {
    return [{ id, kind: "forEach", endId: `end-${id}` },
      { id: `end-${id}`, kind: "endEach", startId: id }];
  }
  function addStep(kind: AutomationStep["kind"], before = definition.steps.length): void {
    if (kind === "endEach") return;
    const additions = kind === "forEach" ? newLoop() : [newStep(kind)];
    definition.steps = [...definition.steps.slice(0, before), ...additions, ...definition.steps.slice(before)];
  }
  function insertInsideLoop(index: number, kind: AutomationStep["kind"]): void {
    const step = definition.steps[index];
    if (step?.kind !== "forEach") return;
    const end = definition.steps.findIndex((candidate) => candidate.id === step.endId);
    if (end > index) addStep(kind, end);
  }
  function removeStep(index: number): void {
    const step = definition.steps[index];
    if (!step) return;
    if (step.kind === "forEach" || step.kind === "endEach") {
      const start = step.kind === "forEach" ? index : definition.steps.findIndex((candidate) => candidate.id === step.startId);
      const end = step.kind === "forEach" ? definition.steps.findIndex((candidate) => candidate.id === step.endId) : index;
      if (start < 0 || end < start) { error = "Repair the loop pair before removing it."; return; }
      definition.steps = definition.steps.filter((_, i) => i < start || i > end);
    } else definition.steps = definition.steps.filter((_, i) => i !== index);
  }
  function replaceStep(index: number, kind: AutomationStep["kind"]): void {
    const old = definition.steps[index];
    if (!old || kind === "endEach" || old.kind === "forEach" || old.kind === "endEach") return;
    if (kind === "forEach") {
      definition.steps = [...definition.steps.slice(0, index), ...newLoop(old.id), ...definition.steps.slice(index + 1)];
    } else definition.steps = definition.steps.map((candidate, i) => i === index ? newStep(kind, old.id) : candidate);
  }
  function changeSelector(index: number, kind: AutomationSelector["kind"]): void {
    const step = definition.steps[index];
    if (step?.kind !== "select" && step?.kind !== "collection") return;
    const selector: AutomationSelector = kind === "tag"
      ? { kind, query: "trap", pattern: "literal", caseSensitive: true } : kind === "ids" ? {kind, refs: []} : { kind };
    definition.steps[index] = { ...step, selector };
  }
  const pinKey = (ref: DocRef) => JSON.stringify([ref.parent?.id, ref.coll, ref.id]);
  function pinnedChoices(refs: DocRef[]) {
    const live = tagOptions.filter((item) => PINNABLE_COLLECTIONS.includes(item.ref.coll as typeof PINNABLE_COLLECTIONS[number]))
      .map((item) => ({ref:item.ref, name:`${item.collection}: ${item.doc.name} (${item.ref.id})`}));
    // Saved order is meaningful to Position/For Each; Undo may reorder scene arrays.
    // Keep selected references first in authored order, including unavailable ones.
    return [...refs.map((ref) => live.find((item) => pinKey(item.ref) === pinKey(ref))
      ?? {ref, name:`Unavailable: ${ref.coll}/${ref.id}`}),
      ...live.filter((item) => !refs.some((ref) => pinKey(item.ref) === pinKey(ref)))];
  }
  function changeMoveDestination(index: number, source: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "move") return;
    delete step.destination; delete step.destinationTag; delete step.destinationResult; delete step.destinationOriginal;
    delete step.destinationChoice; delete step.destinationPosition;
    if (source === "tokens" || source === "tiles") step.destination = { coll: source, id: scene?.[source][0]?._id ?? "" };
    else if (source === "rollTable") step.destinationResult = "rollTable";
    else if (source === "original") step.destinationOriginal = true;
    else if (source === "tag") step.destinationTag = { kind: "tag", query: "destination", collections: ["tokens", "tiles"], mode: "all", pattern: "literal" };
    delete step.mode; delete step.xMode; delete step.yMode;
    delete step.xFormula; delete step.yFormula; step.x = 0; step.y = 0;
  }
  function changeMoveTagRefs(index: number, field: "includeRefs" | "excludeRefs", element: HTMLSelectElement): void {
    const step = definition.steps[index];
    if (step?.kind !== "move" || !step.destinationTag) return;
    const choices = pinnedChoices(step.destinationTag[field] ?? []);
    step.destinationTag[field] = [...element.selectedOptions].flatMap((option) => {
      const item = choices.find((choice) => pinKey(choice.ref) === option.value);
      return item ? [item.ref] : [];
    });
  }
  function changePinned(index: number, element: HTMLSelectElement): void {
    const step = definition.steps[index];
    if ((step?.kind !== "select" && step?.kind !== "collection") || step.selector?.kind !== "ids") return;
    const choices = pinnedChoices(step.selector.refs);
    const refs = Array.from(element.selectedOptions).flatMap((option) => {
      const found = choices.find((item) => pinKey(item.ref) === option.value);
      return found ? [found.ref] : [];
    });
    if (refs.length > 100) { error = "Pin at most 100 entities."; return; }
    error = ""; step.selector.refs = refs;
  }
  function changeCollectionMode(index: number, mode: Extract<AutomationStep, { kind: "collection" }>["mode"]): void {
    const step = definition.steps[index];
    if (step?.kind !== "collection") return;
    definition.steps[index] = mode === "clear" ? { id: step.id, kind: "collection", mode }
      : { ...step, mode, selector: step.selector ?? { kind: "inside" } };
  }
  function changeTileTarget(index: number, kind: AutomationTileTarget["kind"]): void {
    const step = definition.steps[index];
    if (step?.kind !== "triggerTile" && step?.kind !== "setActive") return;
    const target: AutomationTileTarget = kind === "id"
      ? { kind, tileId: scene?.tiles.find((t) => t._id !== tileId)?._id ?? "" }
      : kind === "tag" ? { kind, query: "trap", pattern: "literal", caseSensitive: true }
        : { kind };
    definition.steps[index] = { ...step, target };
  }
  function setTileLanding(index: number, name: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "triggerTile") return;
    const next = { ...step };
    if (name.trim()) next.landing = name.trim();
    else Reflect.deleteProperty(next, "landing");
    definition.steps[index] = next;
  }
  function changeTagRefs(index: number, field: "includeRefs" | "excludeRefs", element: HTMLSelectElement): void {
    const step = definition.steps[index];
    const selected = step?.kind === "select" || step?.kind === "collection" ? step.selector
      : step?.kind === "triggerTile" || step?.kind === "setActive" || step?.kind === "set" ||
        step?.kind === "checkVariable" ? step.target : undefined;
    if (selected?.kind !== "tag") return;
    const refs = Array.from(element.selectedOptions).flatMap((option): DocRef[] => {
      const found = tagOptions[Number(option.value)];
      return found && (step?.kind !== "triggerTile" && step?.kind !== "setActive" &&
        step?.kind !== "checkVariable" || found.ref.coll === "tiles") ? [found.ref] : [];
    });
    if (refs.length > 100) { error = "Tag reference filters support at most 100 explicit refs."; return; }
    error = "";
    const selector = { ...selected };
    if (refs.length) selector[field] = refs;
    else Reflect.deleteProperty(selector, field);
    if (step?.kind === "triggerTile" || step?.kind === "setActive" || step?.kind === "set" ||
        step?.kind === "checkVariable")
      definition.steps[index] = { ...step, target: selector };
    else if (step?.kind === "select" || step?.kind === "collection")
      definition.steps[index] = { ...step, selector };
  }
  function changeVariableScope(index: number, scope: "run" | "tile"): void {
    const step = definition.steps[index];
    if (step?.kind !== "set") return;
    if (scope === "run") {
      const next = { ...step, scope };
      Reflect.deleteProperty(next, "target");
      definition.steps[index] = next;
    } else step.scope = scope;
  }
  function changeVariableTarget(index: number, kind: AutomationTileTarget["kind"] | "self"): void {
    const step = definition.steps[index];
    if (step?.kind !== "checkVariable" && (step?.kind !== "set" || step.scope !== "tile")) return;
    if (kind === "self") {
      const next = { ...step };
      Reflect.deleteProperty(next, "target");
      definition.steps[index] = next;
      return;
    }
    step.target = kind === "id" ? { kind, tileId: scene?.tiles.find((t) => t._id !== tileId)?._id ?? tileId }
      : kind === "tag" ? { kind, query: "trap", pattern: "literal", caseSensitive: true }
        : { kind };
  }
  function changeFilter(index: number, kind: "count" | "tileCount" | "tokenCount" | "method" | "variable"): void {
    const step = definition.steps[index];
    if (step?.kind !== "filter") return;
    const test: Extract<AutomationStep, { kind: "filter" }>["test"] =
      kind === "count" || kind === "tileCount" || kind === "tokenCount"
        ? { kind, min: 1 } : kind === "method" ? { kind, method: "enter" } : { kind, name: "value", equals: 1 };
    definition.steps[index] = { ...step, test };
  }
  function setCountMax(index: number, input: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "filter" || (step.test.kind !== "count" && step.test.kind !== "tileCount" && step.test.kind !== "tokenCount")) return;
    const test = { ...step.test };
    if (input.trim()) test.max = Number(input);
    else Reflect.deleteProperty(test, "max");
    definition.steps[index] = { ...step, test };
  }
  function setOptionalLanding(index: number, field: "otherwise" | "gm" | "player", input: string): void {
    const step = definition.steps[index];
    if (!step || !(step.kind === "filter" || step.kind === "checkVariable" || step.kind === "checkValue" ||
        step.kind === "checkScriptResult" || step.kind === "checkData" || step.kind === "routeMethod" || step.kind === "routeUser") ||
        (field !== "otherwise" && step.kind !== "routeUser")) return;
    const value = input.trim();
    const next = { ...step };
    if (value) Object.assign(next, { [field]: value });
    else Reflect.deleteProperty(next, field);
    definition.steps[index] = next;
  }
  function setMethodRoute(index: number, method: AutomationMethod, input: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "routeMethod") return;
    const routes = { ...step.routes };
    const value = input.trim();
    if (value) routes[method] = value;
    else Reflect.deleteProperty(routes, method);
    definition.steps[index] = { ...step, routes };
  }
  function changeCheckCompare(index: number, compare: Extract<AutomationStep, { kind: "checkVariable" }>["compare"]): void {
    const step = definition.steps[index];
    if (step?.kind !== "checkVariable") return;
    step.compare = compare;
    if (compare === "mod") {
      Reflect.deleteProperty(step, "value");
      step.divisor = 2; step.remainder = 0;
    } else {
      Reflect.deleteProperty(step, "divisor");
      Reflect.deleteProperty(step, "remainder");
      if (!["eq", "ne"].includes(compare) || step.value === undefined) step.value = 0;
    }
  }
  function changeCheckType(index: number, kind: "string" | "number" | "boolean" | "null"): void {
    const step = definition.steps[index];
    if (step?.kind !== "checkVariable" || step.compare === "mod") return;
    if (kind !== "number" && step.compare !== "eq" && step.compare !== "ne") step.compare = "eq";
    step.value = kind === "number" ? 0 : kind === "boolean" ? false : kind === "null" ? null : "";
  }
  function changeCheckValue(index: number, input: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "checkVariable" || step.compare === "mod") return;
    step.value = typeof step.value === "number" ? Number(input)
      : typeof step.value === "boolean" ? input === "true" : input;
  }
  function changeCheckValueSource(index: number, source: Extract<AutomationStep, { kind: "checkValue" }>["source"]): void {
    const step = definition.steps[index];
    if (step?.kind !== "checkValue") return;
    step.source = source;
    step.compare = source === "darkness" || source === "time" ? "gte" : "eq";
    step.value = source === "darkness" ? 0.5 : source === "time" ? 720
      : source === "direction.x" ? "right" : "down";
  }
  function clockLabel(value: number | string): string {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1439) return "";
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }
  function changeCheckTime(index: number, input: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "checkValue" || step.source !== "time") return;
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input);
    step.value = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  }
  function changeSetOperation(index: number, operation: "assign" | "add" | "delete"): void {
    const step = definition.steps[index];
    if (step?.kind !== "set") return;
    step.operation = operation;
    // Omit the key on the wire: msgpack encodes an undefined property as null.
    if (operation === "delete") Reflect.deleteProperty(step, "value");
    else if (step.value === undefined || operation === "add" && typeof step.value !== "number") step.value = 0;
  }
  function changeSetType(index: number, kind: "string" | "number" | "boolean"): void {
    const step = definition.steps[index];
    if (step?.kind !== "set") return;
    step.value = kind === "number" ? 0 : kind === "boolean" ? false : "";
    if (kind !== "number") step.operation = "assign";
  }
  function changeSetValue(index: number, input: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "set") return;
    step.value = typeof step.value === "number" ? Number(input)
      : typeof step.value === "boolean" ? input === "true" : input;
  }
  function changeEqualsType(index: number, kind: "string" | "number" | "boolean"): void {
    const step = definition.steps[index];
    if (step?.kind !== "filter" || step.test.kind !== "variable") return;
    step.test.equals = kind === "number" ? 0 : kind === "boolean" ? false : "";
  }
  function changeEquals(index: number, input: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "filter" || step.test.kind !== "variable") return;
    step.test.equals = typeof step.test.equals === "number" ? Number(input)
      : typeof step.test.equals === "boolean" ? input === "true" : input;
  }
  function changeAttributeType(index: number, kind: "string" | "number" | "boolean"): void {
    const step = definition.steps[index];
    if (step?.kind !== "attributes" && step?.kind !== "checkData") return;
    step.value = kind === "number" ? 0 : kind === "boolean" ? false : "";
    if (kind !== "number" && ["gt", "gte", "lt", "lte"].includes(step.compare)) step.compare = "eq";
  }
  function changeAttributeCompare(index: number, compare: Extract<AutomationStep, { kind: "attributes" }>["compare"]): void {
    const step = definition.steps[index];
    if (step?.kind !== "attributes" && step?.kind !== "checkData") return;
    step.compare = compare;
    if (["gt", "gte", "lt", "lte"].includes(compare) && typeof step.value !== "number") step.value = 0;
  }
  function changeAttributeValue(index: number, input: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "attributes" && step?.kind !== "checkData") return;
    step.value = typeof step.value === "number" ? Number(input)
      : typeof step.value === "boolean" ? input === "true" : input;
  }
  function scriptFor(step: Extract<AutomationStep, { kind: "script" }>): MacroDocument | undefined {
    return scripts.find((macro) => macro._id === step.macroId);
  }
  function resultCaptureSteps(): Array<Extract<AutomationStep, { kind: "script" }>> {
    return definition.steps.filter((step): step is Extract<AutomationStep, { kind: "script" }> =>
      step.kind === "script" && step.captureResult === true);
  }
  function setScriptRunAs(index: number, runAs: "approved" | "caller" | "gm"): void {
    const step = definition.steps[index];
    if (step?.kind === "script") step.runAs = runAs;
  }
  function setPostActionErrorPolicy(index: number, onError: "stop" | "continue"): void {
    const step = definition.steps[index];
    if (step?.kind === "script" || step?.kind === "summon") step.onError = onError;
  }
  function setScriptCaptureResult(index: number, enabled: boolean): void {
    const step = definition.steps[index];
    if (step?.kind !== "script") return;
    if (enabled) step.captureResult = true;
    else Reflect.deleteProperty(step, "captureResult");
  }
  function setScriptResultValueType(index: number, kind: "string" | "number" | "boolean" | "null"): void {
    const step = definition.steps[index];
    if (step?.kind !== "checkScriptResult") return;
    if (kind !== "number" && !["eq", "ne"].includes(step.compare)) step.compare = "eq";
    step.value = kind === "number" ? 0 : kind === "boolean" ? false : kind === "null" ? null : "";
  }
  function changeScriptResultValue(index: number, input: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "checkScriptResult") return;
    step.value = typeof step.value === "number" ? Number(input)
      : typeof step.value === "boolean" ? input === "true" : step.value === null ? null : input;
  }
  function changeScriptMacro(index: number, macroId: string): void {
    const step = definition.steps[index];
    if (step?.kind !== "script") return;
    definition.steps[index] = { ...step, macroId, args: {}, bindings: {} };
  }
  function setScriptBinding(index: number, name: string, source: AutomationScriptBinding | ""): void {
    const step = definition.steps[index];
    if (step?.kind !== "script") return;
    const bindings = { ...step.bindings }, args = { ...step.args };
    Reflect.deleteProperty(bindings, name); Reflect.deleteProperty(args, name);
    if (source) bindings[name] = source;
    definition.steps[index] = { ...step, args, bindings };
  }
  function setScriptArg(index: number, name: string, kind: "string" | "number" | "boolean" | "token", raw: string | boolean): void {
    const step = definition.steps[index];
    if (step?.kind !== "script") return;
    const args = { ...step.args };
    if (raw === "") Reflect.deleteProperty(args, name);
    else args[name] = kind === "number" ? Number(raw) : raw;
    definition.steps[index] = { ...step, args };
  }
  function shift(index: number, direction: -1 | 1): void {
    const next = [...definition.steps];
    const other = index + direction;
    const first = next[index], second = next[other];
    if (!first || !second || [first.kind, second.kind].some((kind) => kind === "forEach" || kind === "endEach")) return;
    next[index] = second; next[other] = first;
    definition.steps = next;
  }
  function setGate(key: keyof AutomationGates, value: boolean | number | undefined): void {
    const gates = { ...definition.gates };
    if (value === undefined) Reflect.deleteProperty(gates, key);
    else Object.assign(gates, { [key]: value });
    definition.gates = gates;
  }
  async function createTile(): Promise<void> {
    error = ""; status = "";
    if (tileCreating) return;
    if (!canEdit || !scene) { error = "Choose a scene first"; return; }
    if (!tileName.trim() || tileName.length > 128 ||
        ![tileX, tileY, tileWidth, tileHeight, tileRotation].every(Number.isFinite) ||
        !Number.isSafeInteger(tileSort) || Math.abs(tileSort) > 1_000_000 ||
        tileWidth <= 0 || tileHeight <= 0 || tileX < 0 || tileY < 0 ||
        tileX + tileWidth > scene.width || tileY + tileHeight > scene.height ||
        Math.abs(tileRotation) > 360 ||
        (tileElevationLimited && (!Number.isFinite(tileElevationMin) || !Number.isFinite(tileElevationMax) ||
          tileElevationMin < -1_000_000 || tileElevationMax > 1_000_000 || tileElevationMin > tileElevationMax))) {
      error = "Tile zone needs a name and a finite rectangle inside this scene; elevation must be an ordered scene-unit range.";
      return;
    }
    let triggerZone: TileTriggerZone | undefined = tileTriggerShape === "triangle"
      ? { kind: "polygon", points: [[0.5, 0], [1, 1], [0, 1]] }
      : tileTriggerShape === "diamond"
        ? { kind: "polygon", points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] }
        : tileTriggerShape === "circle" ? tileTriggerCirclePolygon() : undefined;
    tileCreating = true;
    try {
      if (tileTriggerShape === "alpha") {
        if (!tileTriggerImage || !imageAssets.some(([hash]) => hash === tileTriggerImage)) {
          error = "Choose an available imported image for its alpha trigger shape."; return;
        }
        if (!getAsset) { error = "Image bytes are unavailable in this session; reload the GM asset cache and retry."; return; }
        const bytes = await getAsset(tileTriggerImage);
        if (!bytes) { error = "The selected image is not cached on this GM. Open its asset preview and retry."; return; }
        const mime = assets[tileTriggerImage]?.mime ?? "image/png";
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: mime }));
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 64; canvas.height = 64;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) { error = "This browser cannot read the selected image alpha."; return; }
          context.imageSmoothingEnabled = false;
          context.clearRect(0, 0, 64, 64);
          context.drawImage(bitmap, 0, 0, 64, 64);
          const rgba = context.getImageData(0, 0, 64, 64).data;
          triggerZone = tileAlphaMaskFromRgba(rgba, 64, 64, tileTriggerImage) ?? undefined;
          if (!triggerZone) {
            error = "Image alpha is empty or too complex for the safe 64×64 trigger mask (maximum 1,024 opaque runs).";
            return;
          }
        } finally { bitmap.close(); }
      }
      const doc: TileDocument = { _id: crypto.randomUUID(), type: "tile", name: tileName.trim(),
        ownership: { default: tileHidden ? 0 : 1 }, flags: {}, system: {},
        x: tileX, y: tileY, width: tileWidth, height: tileHeight, rotation: tileRotation, sort: tileSort,
        ...(triggerZone ? { triggerZone } : {}),
        ...(tileElevationLimited ? { triggerElevation: { min: tileElevationMin, max: tileElevationMax } } : {}),
        img: tileTriggerShape === "alpha" ? tileTriggerImage : "", hidden: tileHidden, above: false,
        occlusion: { mode: "roof", alpha: 0.5 } };
      client.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: scene._id }, data: doc }]);
      tileId = doc._id;
      status = `Creating ${tileHidden ? "concealed" : "visible"} zone tile; save the graph after it appears in the tile list.`;
    } catch (cause) {
      error = cause instanceof Error ? `Could not read image alpha: ${cause.message}` : "Could not read image alpha.";
    } finally { tileCreating = false; }
  }
  function createRegion(): void {
    error = ""; status = "";
    if (!canEdit || !scene) { error = "Choose a scene first"; return; }
    if (!regionName.trim() || regionName.length > 128 ||
        ![regionX, regionY, regionWidth, regionHeight, regionRotation].every(Number.isFinite) ||
        !Number.isSafeInteger(regionSort) || Math.abs(regionSort) > 1_000_000 ||
        regionWidth <= 0 || regionHeight <= 0 || regionX < 0 || regionY < 0 ||
        regionX + regionWidth > scene.width || regionY + regionHeight > scene.height || Math.abs(regionRotation) > 360 ||
        (regionElevationLimited && (!Number.isFinite(regionElevationMin) || !Number.isFinite(regionElevationMax) ||
          regionElevationMin < -1_000_000 || regionElevationMax > 1_000_000 || regionElevationMin > regionElevationMax))) {
      error = "Region needs a finite convex shape inside this scene; elevation must be an ordered scene-unit range.";
      return;
    }
    const shape = regionShape === "triangle"
      ? { kind: "polygon" as const, points: [[0.5, 0], [1, 1], [0, 1]] as Array<[number, number]> }
      : regionShape === "diamond"
        ? { kind: "polygon" as const, points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] as Array<[number, number]> }
        : regionShape === "rectangle"
          ? { kind: "polygon" as const, points: [[0, 0], [1, 0], [1, 1], [0, 1]] as Array<[number, number]> }
          : tileTriggerCirclePolygon();
    const doc: RegionDocument = { _id: crypto.randomUUID(), type: "region", name: regionName.trim(),
      ownership: { default: regionHidden ? 0 : 1 }, flags: {}, system: {},
      x: regionX, y: regionY, width: regionWidth, height: regionHeight, rotation: regionRotation, shape,
      sort: regionSort, hidden: regionHidden,
      ...(regionElevationLimited ? { triggerElevation: { min: regionElevationMin, max: regionElevationMax } } : {}) };
    const invalid = regionGeometryError(doc);
    if (invalid) { error = invalid; return; }
    client.submit([{ kind: "create", coll: "regions", parent: { coll: "scenes", id: scene._id }, data: doc }]);
    sourceKind = "region";
    tileId = doc._id;
    status = `Creating ${regionHidden ? "concealed" : "visible"} region; save its graph after it appears in the source list.`;
  }
  function updateTileSort(raw: string): void {
    if (!canEdit || !scene || !selectedTile) return;
    const sort = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(sort) || Math.abs(sort) > 1_000_000) {
      error = "Tile sort must be an integer between -1,000,000 and 1,000,000.";
      return;
    }
    error = "";
    client.submit([{ kind: "update", ref: { coll: "tiles", id: selectedTile._id,
      parent: { coll: "scenes", id: scene._id } }, diff: { sort } }]);
    status = "Tile trigger sort submitted.";
  }
  function save(): void {
    error = ""; status = "";
    if (!canEdit) return;
    if (!name.trim() || !sceneId || !tileId) { error = "Choose a name, scene and zone source"; return; }
    const candidate: AutomationDefinition = { ...$state.snapshot(definition), sceneId, sourceKind, tileId };
    const valid = validateAutomation(candidate);
    if (!valid.ok) { error = valid.error; return; }
    if (editing) {
      if (!saved.some((doc) => doc._id === editing)) { error = "Saved graph no longer exists"; return; }
      client.submit([{ kind: "update", ref: { coll: "automations", id: editing },
        diff: { name: name.trim(), definition: candidate as unknown as Json } }]);
    } else {
      const doc: AutomationDocument = { _id: crypto.randomUUID(), type: "automation", name: name.trim(),
        ownership: { default: 0 }, flags: {}, system: {}, definition: candidate };
      client.submit([{ kind: "create", coll: "automations", data: doc }]);
      editing = doc._id;
    }
    status = "Graph submitted to host for validation";
  }
  function resetHistory(doc: AutomationDocument): void {
    error = "";
    client.submit([{ kind: "update", ref: { coll: "automations", id: doc._id },
      diff: { state: { count: 0, lastAt: 0, byToken: {}, recent: [],
        ...(doc.state?.variables ? { variables: doc.state.variables } : {}) } } }]);
    status = `Requested host reset of ${doc.name}'s gates and recent trigger history (tile variables kept)`;
  }
  function clearVariables(doc: AutomationDocument): void {
    if (!doc.state) return;
    error = "";
    const state = $state.snapshot(doc.state);
    Reflect.deleteProperty(state, "variables");
    client.submit([{ kind: "update", ref: { coll: "automations", id: doc._id },
      diff: { state: state as unknown as Json } }]);
    status = `Requested clearing ${doc.name}'s tile variables (history kept)`;
  }
  /**
   * TR-12/MC-01: publish (or refresh) a macro that runs this graph by reference.
   * The macro stores the graph id — players receive only its name and hotbar slot,
   * and the host re-checks publication on every run.
   */
  function publishMacro(doc: AutomationDocument): void {
    error = ""; status = "";
    const checked = validateAutomation(doc.definition);
    if (!checked.ok) { error = checked.error; return; }
    if (!checked.definition.methods.includes("manual")) {
      error = "Add the manual method before publishing this graph as a macro."; return;
    }
    const existing = automationMacros.find((m) => macroAutomationGraphId(m) === doc._id);
    if (existing) {
      client.submit([{ kind: "update", ref: { coll: "macros", id: existing._id }, diff: { name: doc.name } }]);
      status = `Refreshed automation macro "${doc.name}" — run it from the Macros window or a hotbar slot.`;
      return;
    }
    const macro: MacroDocument = { _id: globalThis.crypto.randomUUID(), type: "macro",
      name: doc.name.slice(0, 64) || "Automation", ownership: { default: 1 }, flags: {}, system: {},
      kind: "automation", command: "", automation: { graphId: doc._id } };
    client.submit([{ kind: "create", coll: "macros", data: macro }]);
    status = `Published automation macro "${macro.name}" — assign a hotbar slot in the Macros window.`;
  }

  function invoke(id: string, dryRun = false, method = triggerMethod): void {
    error = "";
    if (isHostDispatchedMethod(method)) { error = hostEventHint([method]); return; }
    if (!sceneId) { error = "Choose a scene"; return; }
    client.requestAutomation(id, sceneId, method, tokenId || undefined, dryRun);
    status = dryRun ? "Host planning dry-run…" : "Requested saved graph…";
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offAssets = bus.on("assetManifest", refresh);
    const offTrace = bus.on("automationTrace", (msg) => { lastTrace = msg; status = `${msg.result}: ${msg.detail}`; });
    const offRejected = bus.on("rejected", (msg) => { error = `${msg.reason}: ${msg.detail}`; });
    refresh();
    return () => { offSnapshot(); offOps(); offAssets(); offTrace(); offRejected(); };
  });
</script>

<section class="active-zones" aria-label="Active zone graph" data-active-zones>
  <header><h3>Active zones · trigger graph</h3><button type="button" onclick={reset}>New</button></header>
  <p class="hint">GM-published graphs evaluate committed movement and live tags on the host. Action and gate support is growing toward §5.4 parity; no client sends executable steps.</p>
  {#if !canEdit}
    <p>Active zone definitions and traces are GM-only.</p>
  {:else}
    <div class="row"><label>Name <input bind:value={name} placeholder="e.g. Gate trap" data-zone-name /></label>
      <label>Scene <select bind:value={sceneId} onchange={() => tileId = sourceKind === "region"
        ? scene?.regions?.[0]?._id ?? "" : scene?.tiles[0]?._id ?? ""} data-zone-scene>
        {#each scenes as sc (sc._id)}<option value={sc._id}>{sc.name}</option>{/each}
      </select></label>
      <label>Source kind <select bind:value={sourceKind} onchange={() => tileId = sourceKind === "region"
        ? scene?.regions?.[0]?._id ?? "" : scene?.tiles[0]?._id ?? ""} data-zone-source-kind>
        <option value="tile">Tile zone</option><option value="region">Scene region</option>
      </select></label>
      <label>{sourceKind === "region" ? "Region source" : "Tile source"} <select bind:value={tileId} data-zone-tile><option value="">Select source…</option>
        {#if sourceKind === "region"}
          {#each scene?.regions ?? [] as region (region._id)}<option value={region._id}>{region.name} ({region.x},{region.y})</option>{/each}
        {:else}
          {#each scene?.tiles ?? [] as tile (tile._id)}<option value={tile._id}>{tile.name} ({tile.x},{tile.y})</option>{/each}
        {/if}
      </select></label>
      <label>Origin token <select bind:value={tokenId}><option value="">None</option>
        {#each scene?.tokens ?? [] as tok (tok._id)}<option value={tok._id}>{tok.name}</option>{/each}
      </select></label>
    </div>
    {#if selectedTile}
      <label>Selected tile trigger sort (higher runs first when crossings tie)
        <input type="number" step="1" min="-1000000" max="1000000" value={selectedTile.sort ?? 0}
          onchange={(event) => updateTileSort(event.currentTarget.value)} />
      </label>
    {:else if selectedRegion}
      <p class="hint">Region {selectedRegion.name}: convex polygon, {selectedRegion.rotation ?? 0}° rotation
        {selectedRegion.hidden ? " · concealed from players" : " · projected to players"}.</p>
    {/if}
    {#if sourceKind === "tile"}
    <details data-zone-tile-create><summary>Create a rotated tile / zone in this scene</summary>
      <div class="row">
        <label>Tile name <input bind:value={tileName} /></label>
        <label>X <input type="number" bind:value={tileX} /></label>
        <label>Y <input type="number" bind:value={tileY} /></label>
        <label>Width <input type="number" min="1" bind:value={tileWidth} /></label>
        <label>Height <input type="number" min="1" bind:value={tileHeight} /></label>
        <label>Trigger sort <input type="number" step="1" min="-1000000" max="1000000" bind:value={tileSort} /></label>
        <label>Rotation ° <input type="number" min="-360" max="360" bind:value={tileRotation} /></label>
        <label>Trigger shape <select bind:value={tileTriggerShape} data-zone-trigger-shape>
          <option value="rectangle">Rectangle</option><option value="triangle">Triangle</option><option value="diamond">Diamond</option>
          <option value="circle">Circle (32-point convex approximation)</option><option value="alpha">Image alpha</option>
        </select></label>
        {#if tileTriggerShape === "alpha"}
          <label>Alpha mask image <select bind:value={tileTriggerImage} data-zone-alpha-image>
            <option value="">Choose an imported image…</option>
            {#each imageAssets as [hash, asset] (hash)}<option value={hash}>{asset.name} ({hash.slice(0, 8)})</option>{/each}
          </select></label>
        {/if}
        <label><input type="checkbox" bind:checked={tileElevationLimited} />Limit trigger elevation</label>
        {#if tileElevationLimited}
          <label>Min elevation ({scene?.grid.units ?? "scene units"}) <input type="number" bind:value={tileElevationMin} /></label>
          <label>Max elevation ({scene?.grid.units ?? "scene units"}) <input type="number" bind:value={tileElevationMax} /></label>
        {/if}
        <label title="Concealed tiles trigger movement but players cannot click what they cannot see">
          <input type="checkbox" bind:checked={tileHidden} />Concealed trap tile</label>
        <button type="button" data-zone-create-tile disabled={tileCreating} onclick={createTile}>{tileCreating ? "Reading trigger image…" : "Create zone tile"}</button>
      </div>
      <p class="hint">Visible tiles can receive published left-, right- and double-click triggers on the canvas; concealed tiles trigger movement without exposing their zone or media to players. Image alpha is sampled at tile creation into a bounded 64×64 mask, saved with its source hash, and host-validated; later art changes do not reshape this authored trigger mask.</p>
    </details>
    {:else}
    <details data-zone-region-create><summary>Create a convex scene region</summary>
      <div class="row">
        <label>Region name <input bind:value={regionName} /></label>
        <label>X <input type="number" bind:value={regionX} /></label>
        <label>Y <input type="number" bind:value={regionY} /></label>
        <label>Width <input type="number" min="1" bind:value={regionWidth} /></label>
        <label>Height <input type="number" min="1" bind:value={regionHeight} /></label>
        <label>Rotation ° <input type="number" min="-360" max="360" bind:value={regionRotation} /></label>
        <label>Trigger sort <input type="number" step="1" min="-1000000" max="1000000" bind:value={regionSort} /></label>
        <label>Convex shape <select bind:value={regionShape} data-zone-region-shape>
          <option value="rectangle">Rectangle</option><option value="triangle">Triangle</option>
          <option value="diamond">Diamond</option><option value="circle">Circle (32-point approximation)</option>
        </select></label>
        <label><input type="checkbox" bind:checked={regionElevationLimited} />Limit trigger elevation</label>
        {#if regionElevationLimited}
          <label>Min elevation ({scene?.grid.units ?? "scene units"}) <input type="number" bind:value={regionElevationMin} /></label>
          <label>Max elevation ({scene?.grid.units ?? "scene units"}) <input type="number" bind:value={regionElevationMax} /></label>
        {/if}
        <label title="Concealed regions are omitted from player scene projections"><input type="checkbox" bind:checked={regionHidden} />Concealed region</label>
        <button type="button" data-zone-create-region onclick={createRegion}>Create scene region</button>
      </div>
      <p class="hint">This creates a bounded convex region document in the scene. Choose it as this graph’s source; movement Enter/Exit/Stop and elevation contacts are swept by the host. Region click triggers are not supported.</p>
    </details>
    {/if}
    <div class="methods">Methods:
      {#each METHODS as method (method)}
        <label><input type="checkbox" checked={definition.methods.includes(method)} onchange={() => toggle(method)} />{methodLabel(method)}</label>
      {/each}
    </div>
    <div class="row gates">
      <label><input type="checkbox" checked={definition.gates?.paused ?? false} onchange={(e) => setGate("paused", e.currentTarget.checked)} /> Paused</label>
      <label><input type="checkbox" checked={definition.gates?.playerRunnable ?? false} onchange={(e) => setGate("playerRunnable", e.currentTarget.checked)} /> Player canvas triggers (published)</label>
      <label><input type="checkbox" checked={definition.gates?.oncePerToken ?? false} onchange={(e) => setGate("oncePerToken", e.currentTarget.checked)} /> Once per token</label>
      <label>Cooldown ms <input type="number" min="0" max="86400000" value={definition.gates?.cooldownMs ?? 0} onchange={(e) => setGate("cooldownMs", Number(e.currentTarget.value))} /></label>
      <label>Chance 0–1 <input type="number" min="0" max="1" step="0.05" value={definition.gates?.chance ?? 1} onchange={(e) => setGate("chance", Number(e.currentTarget.value))} /></label>
      <label>Max runs <input type="number" min="1" max="1000000" value={definition.gates?.maxRuns ?? ""} onchange={(e) => setGate("maxRuns", e.currentTarget.value ? Number(e.currentTarget.value) : undefined)} /></label>
    </div>
    <div class="steps">
      {#each definition.steps as step, i (step.id)}
        <fieldset data-zone-step={step.id}>
          <legend>{i + 1}. {kindLabel(step.kind)}</legend>
          <div class="row">
            <select aria-label={`Action ${i + 1}`} value={step.kind} disabled={step.kind === "forEach" || step.kind === "endEach"}
              onchange={(e) => replaceStep(i, (e.target as HTMLSelectElement).value as AutomationStep["kind"])}>
              {#each ADD_KINDS as kind (kind)}<option value={kind}>{kindLabel(kind)}</option>{/each}
              {#if step.kind === "endEach"}<option value="endEach">endEach</option>{/if}
            </select>
            <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0 || [step.kind, definition.steps[i - 1]?.kind].some((kind) => kind === "forEach" || kind === "endEach")} onclick={() => shift(i, -1)}>↑</button>
            <button type="button" aria-label={`Move step ${i + 1} down`} disabled={i >= definition.steps.length - 1 || [step.kind, definition.steps[i + 1]?.kind].some((kind) => kind === "forEach" || kind === "endEach")} onclick={() => shift(i, 1)}>↓</button>
            <button type="button" aria-label={`Remove step ${i + 1}`} onclick={() => removeStep(i)}>×</button>
          </div>
          {#if step.kind === "select"}
            <label>Current collection <select value={step.selector.kind} onchange={(e) => changeSelector(i, (e.target as HTMLSelectElement).value as AutomationSelector["kind"])}>
              <option value="triggering">Triggering token</option><option value="inside">Tokens in tile</option><option value="tile">This tile</option><option value="tag">Live tag selector</option><option value="ids">Pinned entities</option>
            </select></label>
            {#if step.selector.kind === "ids"}
              <label>Pinned entities <select aria-label="Pinned entities" multiple size="5" value={step.selector.refs.map(pinKey)} onchange={(e) => changePinned(i, e.currentTarget)}>
                {#each pinnedChoices(step.selector.refs) as item (pinKey(item.ref))}
                  <option value={pinKey(item.ref)}>{item.name}</option>
                {/each}
              </select></label>
              <small>Choose 1–100 exact scene entities, including untagged ones. Missing entities reject the whole graph; unavailable saved choices stay visible. Prefab copies rebind internal pins and reject external pins.</small>
            {:else if step.selector.kind === "tag"}
              <label>Tags <input value={Array.isArray(step.selector.query) ? step.selector.query.join(", ") : step.selector.query}
                onchange={(e) => { if (step.kind === "select" && step.selector.kind === "tag") {
                  const value = (e.target as HTMLInputElement).value;
                  const terms = value.split(",").map((v) => v.trim());
                  step.selector.query = step.selector.pattern === "regex" ? value
                    : terms.length === 1 ? terms[0] ?? "" : terms;
                } }} placeholder="door-1, guardian*" /></label>
              <label>Match <select bind:value={step.selector.mode}><option value="all">All</option><option value="any">Any</option><option value="exactSet">Exact set</option></select></label>
              <label>Pattern <select bind:value={step.selector.pattern}><option value="literal">Exact</option><option value="wildcard">Wildcard</option><option value="regex">Safe regex</option></select></label>
              <label><input type="checkbox" checked={step.selector.caseSensitive !== false} onchange={(e) => { if (step.kind === "select" && step.selector.kind === "tag") step.selector.caseSensitive = e.currentTarget.checked; }} />Case sensitive</label>
              <label><input type="checkbox" disabled={step.selector.pattern !== "literal" && step.selector.pattern !== undefined} checked={step.selector.contains ?? false}
                onchange={(e) => { if (step.kind === "select" && step.selector.kind === "tag") step.selector.contains = e.currentTarget.checked; }} />Substring</label>
              <label>Collections <input value={step.selector.collections?.join(", ") ?? ""}
                onchange={(e) => { if (step.kind === "select" && step.selector.kind === "tag") {
                  const names = (e.target as HTMLInputElement).value.split(",").map((v) => v.trim()).filter(Boolean);
                  step.selector.collections = names.length ? names as NonNullable<typeof step.selector.collections> : undefined;
                } }} placeholder="tokens, tiles (blank = all)" /></label>
              <label>Only these refs (none = all)
                <select aria-label="Include tag refs" multiple size="3" onchange={(e) => changeTagRefs(i, "includeRefs", e.currentTarget)}>
                  {#each tagOptions as item, at (`${item.collection}/${item.ref.id}`)}
                    <option value={at} selected={step.selector.includeRefs?.some((ref) =>
                      ref.coll === item.ref.coll && ref.id === item.ref.id && ref.parent?.id === item.ref.parent?.id) ?? false}>
                      {item.collection}: {item.doc.name} ({item.ref.id})
                    </option>
                  {/each}
                </select></label>
              <label>Exclude these refs
                <select aria-label="Exclude tag refs" multiple size="3" onchange={(e) => changeTagRefs(i, "excludeRefs", e.currentTarget)}>
                  {#each tagOptions as item, at (`${item.collection}/${item.ref.id}`)}
                    <option value={at} selected={step.selector.excludeRefs?.some((ref) =>
                      ref.coll === item.ref.coll && ref.id === item.ref.id && ref.parent?.id === item.ref.parent?.id) ?? false}>
                      {item.collection}: {item.doc.name} ({item.ref.id})
                    </option>
                  {/each}
                </select></label>
            {/if}
          {:else if step.kind === "filter"}
            <label>Check <select value={step.test.kind} onchange={(e) => changeFilter(i, (e.target as HTMLSelectElement).value as Extract<AutomationStep, { kind: "filter" }>["test"]["kind"])}>
              <option value="count">Current collection count</option><option value="tileCount">Tile trigger count</option>
              <option value="tokenCount">This token/user trigger count</option>
              <option value="method">Trigger method</option><option value="variable">Variable equals</option>
            </select></label>
            {#if step.test.kind === "count" || step.test.kind === "tileCount" || step.test.kind === "tokenCount"}
              <label>At least <input type="number" min="0" bind:value={step.test.min} /></label>
              <label>At most <input type="number" min="0" value={step.test.max ?? ""} placeholder="Any" onchange={(e) => setCountMax(i, e.currentTarget.value)} /></label>
            {/if}
            {#if step.test.kind === "method"}<label>Method <select bind:value={step.test.method}>{#each METHODS as method (method)}<option value={method}>{methodLabel(method)}</option>{/each}</select></label>{/if}
            {#if step.test.kind === "variable"}
              <label>Variable <input bind:value={step.test.name} /></label>
              <label>Compare as <select value={typeof step.test.equals} onchange={(e) => changeEqualsType(i, e.currentTarget.value as "string" | "number" | "boolean")}>
                <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
              </select></label>
              {#if typeof step.test.equals === "boolean"}
                <label>Equals <select value={String(step.test.equals)} onchange={(e) => changeEquals(i, e.currentTarget.value)}>
                  <option value="true">True</option><option value="false">False</option>
                </select></label>
              {:else}
                <label>Equals <input type={typeof step.test.equals === "number" ? "number" : "text"} value={String(step.test.equals)} onchange={(e) => changeEquals(i, e.currentTarget.value)} /></label>
              {/if}
            {/if}
            <label>On failure jump to <input value={step.otherwise ?? ""} onchange={(e) => setOptionalLanding(i, "otherwise", e.currentTarget.value)} placeholder="(stop) or landing name" /></label>
          {:else if step.kind === "checkVariable"}
            <label>Variable name <input data-zone-check-name bind:value={step.name} placeholder="charge" /></label>
            <label>Check tile <select aria-label="Check Variable target" value={step.target?.kind ?? "self"}
              onchange={(e) => changeVariableTarget(i, e.currentTarget.value as AutomationTileTarget["kind"] | "self")}>
              <option value="self">This graph</option><option value="id">All graphs on one tile</option>
              <option value="current">All graphs on current tiles</option><option value="tag">All graphs on Tagger tiles</option>
            </select></label>
            {#if step.target?.kind === "id"}
              <label>Tile <select aria-label="Check Variable tile" bind:value={step.target.tileId}>
                <option value="">Choose a tile…</option>
                {#each scene?.tiles ?? [] as target (target._id)}<option value={target._id}>{target.name} ({target._id})</option>{/each}
              </select></label>
            {:else if step.target?.kind === "tag"}
              <label>Tags <input aria-label="Check Variable tile tags"
                value={Array.isArray(step.target.query) ? step.target.query.join(", ") : step.target.query}
                onchange={(e) => { if (step.kind === "checkVariable" && step.target?.kind === "tag") {
                  const input = e.currentTarget.value;
                  const terms = input.split(",").map((v) => v.trim());
                  step.target.query = step.target.pattern === "regex" ? input : terms.length === 1 ? terms[0] ?? "" : terms;
                } }} placeholder="relay*" /></label>
              <label>Match <select bind:value={step.target.mode}><option value="all">All</option><option value="any">Any</option><option value="exactSet">Exact set</option></select></label>
              <label>Pattern <select bind:value={step.target.pattern}><option value="literal">Exact</option><option value="wildcard">Wildcard</option><option value="regex">Safe regex</option></select></label>
              <label><input type="checkbox" checked={step.target.caseSensitive !== false}
                onchange={(e) => { if (step.kind === "checkVariable" && step.target?.kind === "tag") step.target.caseSensitive = e.currentTarget.checked; }} />Case sensitive</label>
              <label><input type="checkbox" disabled={step.target.pattern !== "literal" && step.target.pattern !== undefined}
                checked={step.target.contains ?? false}
                onchange={(e) => { if (step.kind === "checkVariable" && step.target?.kind === "tag") step.target.contains = e.currentTarget.checked; }} />Substring</label>
              <label>Only these tiles <select aria-label="Include checked tiles" multiple size="3"
                onchange={(e) => changeTagRefs(i, "includeRefs", e.currentTarget)}>
                {#each tagOptions.filter((item) => item.ref.coll === "tiles") as item (item.ref.id)}
                  <option value={tagOptions.indexOf(item)} selected={step.target.includeRefs?.some((ref) => ref.id === item.ref.id) ?? false}>
                    {item.doc.name} ({item.ref.id})</option>
                {/each}
              </select></label>
              <label>Exclude these tiles <select aria-label="Exclude checked tiles" multiple size="3"
                onchange={(e) => changeTagRefs(i, "excludeRefs", e.currentTarget)}>
                {#each tagOptions.filter((item) => item.ref.coll === "tiles") as item (item.ref.id)}
                  <option value={tagOptions.indexOf(item)} selected={step.target.excludeRefs?.some((ref) => ref.id === item.ref.id) ?? false}>
                    {item.doc.name} ({item.ref.id})</option>
                {/each}
              </select></label>
            {/if}
            <label>Require <select aria-label="Check Variable aggregation" value={step.mode ?? "all"}
              onchange={(e) => { if (step.kind === "checkVariable") step.mode = e.currentTarget.value as "all" | "any" | "none"; }}>
              <option value="all">All matching</option><option value="any">Any matching</option>
              <option value="none">None matching</option>
            </select></label>
            <label>Compare <select aria-label="Check Variable comparison" value={step.compare}
              onchange={(e) => changeCheckCompare(i, e.currentTarget.value as Extract<AutomationStep, { kind: "checkVariable" }>["compare"])}>
              <option value="eq">Equals</option><option value="ne">Not equal</option><option value="gt">Greater than</option>
              <option value="gte">At least</option><option value="lt">Less than</option><option value="lte">At most</option>
              <option value="mod">Modulo equals</option>
            </select></label>
            {#if step.compare === "mod"}
              <label>Divisor <input aria-label="Check Variable divisor" type="number" min="1" max="1000000" step="1" bind:value={step.divisor} /></label>
              <label>Remainder <input aria-label="Check Variable remainder" type="number" min="0" step="1" bind:value={step.remainder} /></label>
            {:else}
              <label>Value type <select aria-label="Check Variable value type" value={step.value === null ? "null" : typeof step.value}
                onchange={(e) => changeCheckType(i, e.currentTarget.value as "string" | "number" | "boolean" | "null")}>
                <option value="number">Number</option><option value="string">Text</option>
                <option value="boolean">Boolean</option><option value="null">Missing (null)</option>
              </select></label>
              {#if typeof step.value === "boolean"}
                <label>Value <select aria-label="Check Variable value" value={String(step.value)}
                  onchange={(e) => changeCheckValue(i, e.currentTarget.value)}>
                  <option value="true">True</option><option value="false">False</option>
                </select></label>
              {:else if step.value !== null}
                <label>Value <input aria-label="Check Variable value" type={typeof step.value === "number" ? "number" : "text"}
                  value={String(step.value ?? "")} onchange={(e) => changeCheckValue(i, e.currentTarget.value)} /></label>
              {/if}
            {/if}
            <label>On failure jump to <input aria-label="Check Variable failure landing" value={step.otherwise ?? ""}
              onchange={(e) => setOptionalLanding(i, "otherwise", e.currentTarget.value)} placeholder="(stop) or landing name" /></label>
            <small>Checks the host's current private tile variables, including writes staged earlier in this fire. Missing values are null; 0 is a different value. No matching tiles stops the chain (even with None). Changes and nested calls remain one undoable transaction.</small>
          {:else if step.kind === "checkValue"}
            <label>Host value <select aria-label="Check Value source" value={step.source}
              onchange={(e) => changeCheckValueSource(i, e.currentTarget.value as Extract<AutomationStep, { kind: "checkValue" }>["source"])}>
              <option value="darkness">Committed scene darkness</option>
              <option value="time">World-clock time of day</option>
              <option value="direction.x">Token movement left/right</option>
              <option value="direction.y">Token movement up/down</option>
            </select></label>
            <label>Compare <select aria-label="Check Value comparison" bind:value={step.compare}>
              <option value="eq">Equals</option><option value="ne">Not equal</option>
              {#if step.source === "darkness" || step.source === "time"}
                <option value="gt">Greater than</option><option value="gte">At least</option>
                <option value="lt">Less than</option><option value="lte">At most</option>
              {/if}
            </select></label>
            {#if step.source === "darkness"}
              <label>Value (0–1) <input aria-label="Check Value threshold" type="number" min="0" max="1" step="0.01"
                value={step.value} onchange={(e) => { if (step.kind === "checkValue") step.value = Number(e.currentTarget.value); }} /></label>
            {:else if step.source === "time"}
              <label>Time of day <input aria-label="Check Value world time" type="time" value={clockLabel(step.value)}
                onchange={(e) => changeCheckTime(i, e.currentTarget.value)} /></label>
              <small>The host compares minutes after midnight, 00:00–23:59, from the replicated world clock (not your local computer time).</small>
            {:else}
              <label>Direction <select aria-label="Check Value direction" value={String(step.value)}
                onchange={(e) => { if (step.kind === "checkValue") step.value = e.currentTarget.value as "left" | "right" | "up" | "down"; }}>
                {#if step.source === "direction.x"}<option value="left">Left</option><option value="right">Right</option>
                {:else}<option value="up">Up</option><option value="down">Down</option>{/if}
              </select></label>
            {/if}
            <label>On failure jump to <input aria-label="Check Value failure landing" value={step.otherwise ?? ""}
              onchange={(e) => setOptionalLanding(i, "otherwise", e.currentTarget.value)} placeholder="(stop) or landing name" /></label>
            <small>Checks committed scene darkness, the replicated world clock or a host-observed token movement vector. Time defaults to midnight if unset and wraps each day; a click has no movement direction. Client-provided key presses are not trusted Check Value inputs.</small>
          {:else if step.kind === "checkScriptResult"}
            <label>Awaited script result
              <select aria-label="Check Script Result source" bind:value={step.scriptStepId}>
                <option value="">Choose a result-capturing script…</option>
                {#each resultCaptureSteps() as source (source.id)}<option value={source.id}>{source.id} · {scriptFor(source)?.name ?? source.macroId}</option>{/each}
              </select>
            </label>
            <label>Result path <input aria-label="Check Script Result path" bind:value={step.path}
              placeholder="ok, error, value.hit" /></label>
            <label>Compare <select aria-label="Check Script Result comparison" bind:value={step.compare}>
              <option value="eq">Equals</option><option value="ne">Not equal</option>
              <option value="gt">Greater than</option><option value="gte">At least</option>
              <option value="lt">Less than</option><option value="lte">At most</option>
            </select></label>
            <label>Value type <select aria-label="Check Script Result value type"
              value={step.value === null ? "null" : typeof step.value}
              onchange={(e) => setScriptResultValueType(i, e.currentTarget.value as "string" | "number" | "boolean" | "null")}>
              <option value="boolean">Boolean</option><option value="number">Number</option>
              <option value="string">Text</option><option value="null">Null</option>
            </select></label>
            {#if typeof step.value === "boolean"}
              <label>Value <select aria-label="Check Script Result value" value={String(step.value)}
                onchange={(e) => changeScriptResultValue(i, e.currentTarget.value)}>
                <option value="true">True</option><option value="false">False</option>
              </select></label>
            {:else if step.value !== null}
              <label>Value <input aria-label="Check Script Result value" type={typeof step.value === "number" ? "number" : "text"}
                value={String(step.value)} onchange={(e) => changeScriptResultValue(i, e.currentTarget.value)} /></label>
            {/if}
            <label>On failure jump to <input aria-label="Check Script Result failure landing" value={step.otherwise ?? ""}
              onchange={(e) => setOptionalLanding(i, "otherwise", e.currentTarget.value)} placeholder="(stop) or landing name" /></label>
            <small>Run Macro must enable “Expose result to later branches” before this step. The graph commits before invoking the reviewed script, then resumes at this branch with the returned JSON or an opted-in ordinary error. Paths are bounded own properties only (no expressions or prototype keys); script-result data is never interpolated into player-visible chat.</small>
          {:else if step.kind === "shuffle"}
            <small>Fisher–Yates shuffle of the current collection using host randomness; dry-runs use a stable preview seed.</small>
          {:else if step.kind === "position"}
            <label>Pick position (1-based) <input type="number" min="1" max="10000" step="1" bind:value={step.index} /></label>
          {:else if step.kind === "distance"}
            <label>Measure from <select bind:value={step.from}><option value="tile">Tile center</option><option value="trigger">Triggering token center</option></select></label>
            <label>At least (scene units) <input type="number" min="0" value={step.min ?? ""} placeholder="0"
              onchange={(e) => { if (step.kind === "distance") step.min = e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value); }} /></label>
            <label>At most (scene units) <input type="number" min="0" bind:value={step.max} /></label>
            <small>Token targets only; uses scene grid distance and centers, regardless of square/hex/gridless geometry.</small>
          {:else if step.kind === "attributes" || step.kind === "checkData"}
            <label>{step.kind === "checkData" ? "Triggering tile path" : "Attribute path"}
              <input aria-label={step.kind === "checkData" ? "Check Data tile path" : "Attribute path"}
                bind:value={step.path} placeholder={step.kind === "checkData" ? "width or flags.core.state" : "actor.system.attributes.hp.value"} /></label>
            <label>Compare <select aria-label="Attribute comparison" value={step.compare}
              onchange={(e) => changeAttributeCompare(i, e.currentTarget.value as typeof step.compare)}>
              <option value="eq">Equals (=)</option><option value="ne">Not equal (≠)</option>
              <option value="gt">Greater than (&gt;)</option><option value="gte">At least (≥)</option>
              <option value="lt">Less than (&lt;)</option><option value="lte">At most (≤)</option>
              <option value="has">Array contains value</option>
            </select></label>
            <label>Value type <select aria-label="Attribute value type" value={typeof step.value}
              onchange={(e) => changeAttributeType(i, e.currentTarget.value as "string" | "number" | "boolean")}>
              <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
            </select></label>
            {#if typeof step.value === "boolean"}
              <label>Compare value <select aria-label="Attribute value" value={String(step.value)}
                onchange={(e) => changeAttributeValue(i, e.currentTarget.value)}>
                <option value="true">True</option><option value="false">False</option>
              </select></label>
            {:else}
              <label>Compare value <input aria-label="Attribute value" type={typeof step.value === "number" ? "number" : "text"}
                value={String(step.value)} onchange={(e) => changeAttributeValue(i, e.currentTarget.value)} /></label>
            {/if}
            {#if step.kind === "checkData"}
              <label>On failure jump to <input aria-label="Check Data failure landing" value={step.otherwise ?? ""}
                onchange={(e) => setOptionalLanding(i, "otherwise", e.currentTarget.value)} placeholder="(stop) or landing name" /></label>
              <small>Checks only the triggering tile's staged, own-data value. Ignores the current collection; a failed check stops or jumps to a top-level landing. Missing or mismatched values do not match, even for ≠. No expressions, linked actor fields or player-supplied tile data. Shares Filter by Attributes' bounded host-read budget.</small>
            {:else}
              <small>Filter selected tokens, tiles, walls and drawings by exact, own-data paths (e.g. name, door, system.*, flags.*, actor.system.* on linked tokens). Missing paths and mismatched types do not match; numeric order is number-only, membership requires an array. No code, templates or prototype access. This only changes the current collection; add a count check to branch. Host reads staged scene data and linked actors; up to 1024 selected targets / 4096 elements per value / 100,000 comparisons per plan.</small>
            {/if}
          {:else if step.kind === "condition"}
            <label>Condition or effect name <input aria-label="Condition or effect name" bind:value={step.effect} placeholder="Prone" maxlength="128" /></label>
            <label>Token <select aria-label="Condition mode" bind:value={step.mode}>
              <option value="has">Has condition/effect</option><option value="lacks">Lacks condition/effect</option>
            </select></label>
            <small>Filters only selected tokens with a linked actor. Checks active embedded effect names, PF1e effect condition labels and PF1e native conditions, trimmed and case-insensitive; disabled effects do not count. Missing actors never pass even “lacks.” Host reads private actor data, not the player's replica. Add a count check to branch.</small>
          {:else if step.kind === "inventory"}
            <label>Item name <input aria-label="Inventory item name" bind:value={step.item} placeholder="Potion* or *Healing*" maxlength="128" /></label>
            <label>Item records <select aria-label="Inventory comparison" bind:value={step.compare}>
              <option value="eq">Exactly (=)</option><option value="ne">Not equal (≠)</option>
              <option value="gt">More than (&gt;)</option><option value="gte">At least (≥)</option>
              <option value="lt">Less than (&lt;)</option><option value="lte">At most (≤)</option>
            </select></label>
            <label>Count <input aria-label="Inventory item count" type="number" step="1" min="0" max="4096" bind:value={step.count} /></label>
            <small>Only selected linked-actor tokens. Names are trimmed and case-insensitive; a leading/trailing * matches a suffix/prefix (both = contains), not a regex. Counts matching item records, not stack quantity. Missing actors never count as empty. Host reads private inventory; up to 4096 records per actor and 100,000 actor-filter reads per nested plan. Add a count check to branch.</small>
          {:else if step.kind === "tokenTriggerCount"}
            <label>Trigger history <select aria-label="Token trigger count comparison" bind:value={step.compare}>
              <option value="eq">Exactly (=)</option><option value="ne">Not equal (≠)</option>
              <option value="gt">More than (&gt;)</option><option value="gte">At least (≥)</option>
              <option value="lt">Less than (&lt;)</option><option value="lte">At most (≤)</option>
            </select></label>
            <label>Count <input aria-label="Token trigger count" type="number" step="1" min="0" max="1000000" bind:value={step.count} /></label>
            <small>Filters the current scene's token collection by how often each token has triggered this graph, including this fire. Unseen tokens have count zero. This is different from “This token/user trigger count,” which checks only the caller's history. Non-token targets fail the entire plan. Add an Entity count filter to branch; reset-history clears these counts but not tile variables.</small>
          {:else if step.kind === "routeMethod"}
            {#each METHODS as method (method)}
              <label>{methodLabel(method)} → landing <input aria-label={`${methodLabel(method)} landing`} value={step.routes[method] ?? ""} placeholder="(fall through)"
                onchange={(e) => setMethodRoute(i, method, e.currentTarget.value)} /></label>
            {/each}
            <label>Other → landing <input value={step.otherwise ?? ""} placeholder="(fall through)"
              onchange={(e) => setOptionalLanding(i, "otherwise", e.currentTarget.value)} /></label>
          {:else if step.kind === "routeUser"}
            <label>GM/assistant → landing <input value={step.gm ?? ""} placeholder="(fall through)"
              onchange={(e) => setOptionalLanding(i, "gm", e.currentTarget.value)} /></label>
            <label>Trusted/player → landing <input value={step.player ?? ""} placeholder="(fall through)"
              onchange={(e) => setOptionalLanding(i, "player", e.currentTarget.value)} /></label>
            <label>Otherwise → landing <input value={step.otherwise ?? ""} placeholder="(fall through)"
              onchange={(e) => setOptionalLanding(i, "otherwise", e.currentTarget.value)} /></label>
          {:else if step.kind === "forEach"}
            <small>Each of up to 1024 selected entities runs the enclosed actions with one current target. Use {"{{currentId}}"} and {"{{index}}"}; current selection is restored afterwards. Remove either marker to remove the entire loop.</small>
            <label>Add inside loop <select aria-label={`Add inside loop ${step.id}`} value="" onchange={(e) => { insertInsideLoop(i, e.currentTarget.value as AutomationStep["kind"]); e.currentTarget.value = ""; }}>
              <option value="">Choose action…</option>{#each ADD_KINDS.filter((kind) => kind !== "landing") as kind (kind)}<option value={kind}>{kindLabel(kind)}</option>{/each}
            </select></label>
          {:else if step.kind === "endEach"}
            <small>End of loop {step.startId}. Nested loops and outward jumps are allowed; landings cannot be inside a loop.</small>
          {:else if step.kind === "resetHistory"}
            <small>Clear this graph's total, per-token/user counts and recent-fire audit after gates have passed, but keep its persistent variables. This reset is committed with the other graph actions.</small>
          {:else if step.kind === "batchFlush"}
            <small>Run All Batch Actions: execute pending tag, door and visibility writes here, combining edits on each target. Later actions begin a new batch. The host still commits every batch in one atomic envelope after the complete graph succeeds; scripts/FX run after commit.</small>
          {:else if step.kind === "collection"}
            <label>Change current collection <select value={step.mode} onchange={(e) => changeCollectionMode(i, e.currentTarget.value as typeof step.mode)}>
              <option value="add">Add</option><option value="remove">Remove</option><option value="replace">Replace</option><option value="clear">Clear</option>
            </select></label>
            {#if step.mode !== "clear"}
              <label>Entities <select value={step.selector?.kind ?? "inside"} onchange={(e) => changeSelector(i, e.currentTarget.value as AutomationSelector["kind"])}>
                <option value="triggering">Triggering token</option><option value="inside">Tokens in tile</option><option value="tile">This tile</option><option value="tag">Live tag selector</option><option value="ids">Pinned entities</option>
              </select></label>
              {#if step.selector?.kind === "ids"}
                <label>Pinned collection entities <select aria-label="Pinned collection entities" multiple size="5" value={step.selector.refs.map(pinKey)} onchange={(e) => changePinned(i, e.currentTarget)}>
                  {#each pinnedChoices(step.selector.refs) as item (pinKey(item.ref))}
                    <option value={pinKey(item.ref)}>{item.name}</option>
                  {/each}
                </select></label>
                <small>Exact same-scene entities. A missing pin rejects even a Remove operation; no silent partial selection.</small>
              {:else if step.selector?.kind === "tag"}
                <label>Tags <input value={Array.isArray(step.selector.query) ? step.selector.query.join(", ") : step.selector.query}
                  onchange={(e) => { if (step.kind === "collection" && step.selector?.kind === "tag") {
                    const value = e.currentTarget.value;
                    const terms = value.split(",").map((v) => v.trim());
                    step.selector.query = step.selector.pattern === "regex" ? value : terms.length === 1 ? terms[0] ?? "" : terms;
                  } }} placeholder="door-1, guardian*" /></label>
                <label>Match <select bind:value={step.selector.mode}><option value="all">All</option><option value="any">Any</option><option value="exactSet">Exact set</option></select></label>
                <label>Pattern <select bind:value={step.selector.pattern}><option value="literal">Exact</option><option value="wildcard">Wildcard</option><option value="regex">Safe regex</option></select></label>
                <label><input type="checkbox" checked={step.selector.caseSensitive !== false} onchange={(e) => { if (step.kind === "collection" && step.selector?.kind === "tag") step.selector.caseSensitive = e.currentTarget.checked; }} />Case sensitive</label>
                <label><input type="checkbox" disabled={step.selector.pattern !== "literal" && step.selector.pattern !== undefined} checked={step.selector.contains ?? false}
                  onchange={(e) => { if (step.kind === "collection" && step.selector?.kind === "tag") step.selector.contains = e.currentTarget.checked; }} />Substring</label>
                <label>Collections <input value={step.selector.collections?.join(", ") ?? ""} placeholder="tokens, tiles (blank = all)"
                  onchange={(e) => { if (step.kind === "collection" && step.selector?.kind === "tag") {
                    const names = e.currentTarget.value.split(",").map((v) => v.trim()).filter(Boolean);
                    step.selector.collections = names.length ? names as NonNullable<typeof step.selector.collections> : undefined;
                  } }} /></label>
                <label>Only these refs (none = all) <select aria-label="Include collection refs" multiple size="3"
                  onchange={(e) => changeTagRefs(i, "includeRefs", e.currentTarget)}>
                  {#each tagOptions as item, at (`${item.collection}/${item.ref.id}`)}
                    <option value={at} selected={step.selector.includeRefs?.some((ref) =>
                      ref.coll === item.ref.coll && ref.id === item.ref.id && ref.parent?.id === item.ref.parent?.id) ?? false}>
                      {item.collection}: {item.doc.name} ({item.ref.id})
                    </option>
                  {/each}
                </select></label>
                <label>Exclude these refs <select aria-label="Exclude collection refs" multiple size="3"
                  onchange={(e) => changeTagRefs(i, "excludeRefs", e.currentTarget)}>
                  {#each tagOptions as item, at (`${item.collection}/${item.ref.id}`)}
                    <option value={at} selected={step.selector.excludeRefs?.some((ref) =>
                      ref.coll === item.ref.coll && ref.id === item.ref.id && ref.parent?.id === item.ref.parent?.id) ?? false}>
                      {item.collection}: {item.doc.name} ({item.ref.id})
                    </option>
                  {/each}
                </select></label>
              {/if}
            {/if}
            <small>Stable scene-local references. Add deduplicates in order; remove/replace/clear change only selection, not world objects.</small>
          {:else if step.kind === "triggerTile"}
            <label>Target tiles <select value={step.target.kind} onchange={(e) => changeTileTarget(i, e.currentTarget.value as AutomationTileTarget["kind"])}>
              <option value="id">One tile in this scene</option><option value="current">Tiles in current collection</option><option value="tag">Tiles matching tags</option>
            </select></label>
            {#if step.target.kind === "id"}
              <label>Tile <select bind:value={step.target.tileId}><option value="">Choose another tile…</option>
                {#each scene?.tiles ?? [] as target (target._id)}<option value={target._id}>{target.name} ({target._id})</option>{/each}
              </select></label>
            {:else if step.target.kind === "tag"}
              <label>Tags <input value={Array.isArray(step.target.query) ? step.target.query.join(", ") : step.target.query}
                onchange={(e) => { if (step.kind === "triggerTile" && step.target.kind === "tag") {
                  const value = e.currentTarget.value;
                  const terms = value.split(",").map((v) => v.trim());
                  step.target.query = step.target.pattern === "regex" ? value : terms.length === 1 ? terms[0] ?? "" : terms;
                } }} placeholder="trap*" /></label>
              <label>Match <select bind:value={step.target.mode}><option value="all">All</option><option value="any">Any</option><option value="exactSet">Exact set</option></select></label>
              <label>Pattern <select bind:value={step.target.pattern}><option value="literal">Exact</option><option value="wildcard">Wildcard</option><option value="regex">Safe regex</option></select></label>
              <label><input type="checkbox" checked={step.target.caseSensitive !== false} onchange={(e) => { if (step.kind === "triggerTile" && step.target.kind === "tag") step.target.caseSensitive = e.currentTarget.checked; }} />Case sensitive</label>
              <label><input type="checkbox" disabled={step.target.pattern !== "literal" && step.target.pattern !== undefined} checked={step.target.contains ?? false}
                onchange={(e) => { if (step.kind === "triggerTile" && step.target.kind === "tag") step.target.contains = e.currentTarget.checked; }} />Substring</label>
              <label>Only these tiles (none = all) <select aria-label="Include target tiles" multiple size="3"
                onchange={(e) => changeTagRefs(i, "includeRefs", e.currentTarget)}>
                {#each tagOptions.filter((item) => item.ref.coll === "tiles") as item (item.ref.id)}
                  <option value={tagOptions.indexOf(item)} selected={step.target.includeRefs?.some((ref) => ref.id === item.ref.id) ?? false}>
                    {item.doc.name} ({item.ref.id})
                  </option>
                {/each}
              </select></label>
              <label>Exclude these tiles <select aria-label="Exclude target tiles" multiple size="3"
                onchange={(e) => changeTagRefs(i, "excludeRefs", e.currentTarget)}>
                {#each tagOptions.filter((item) => item.ref.coll === "tiles") as item (item.ref.id)}
                  <option value={tagOptions.indexOf(item)} selected={step.target.excludeRefs?.some((ref) => ref.id === item.ref.id) ?? false}>
                    {item.doc.name} ({item.ref.id})
                  </option>
                {/each}
              </select></label>
            {/if}
            <label>Pass tokens <select bind:value={step.tokens}>
              <option value="triggering">Triggering token (or none)</option><option value="current">Tokens in current collection</option>
              <option value="inside">Tokens inside each target tile</option>
            </select></label>
            <label>Child landing <input value={step.landing ?? ""} onchange={(e) => setTileLanding(i, e.currentTarget.value)} placeholder="(start of graph)" /></label>
            <label><input type="checkbox" checked={step.propagateStop ?? false}
              onchange={(e) => { if (step.kind === "triggerTile") step.propagateStop = e.currentTarget.checked; }} />Return child Stop to caller</label>
            <small>Runs this scene's manual-method graphs on matching tiles. All nested world edits/history share one atomic transaction; child scripts and FX still have their existing post-commit rules. Max 8 depths / 32 tiles or tokens per call / 128 graph invocations.</small>
          {:else if step.kind === "setActive"}
            <label>Tile graphs <select aria-label="Set tile graph activity" bind:value={step.mode}>
              <option value="activate">Activate (unpause)</option><option value="deactivate">Deactivate (pause)</option>
              <option value="toggle">Toggle activity</option>
            </select></label>
            <label>Target tiles <select aria-label="Activity target tiles" value={step.target.kind}
              onchange={(e) => changeTileTarget(i, e.currentTarget.value as AutomationTileTarget["kind"])}>
              <option value="id">One tile in this scene</option><option value="current">Tiles in current collection</option>
              <option value="tag">Tiles matching tags</option>
            </select></label>
            {#if step.target.kind === "id"}
              <label>Target tile <select aria-label="Activity tile" bind:value={step.target.tileId}>
                <option value="">Choose tile…</option>
                {#each scene?.tiles ?? [] as target (target._id)}<option value={target._id}>{target.name} ({target._id})</option>{/each}
              </select></label>
            {:else if step.target.kind === "tag"}
              <label>Tags <input aria-label="Activity tile tags" value={Array.isArray(step.target.query) ? step.target.query.join(", ") : step.target.query}
                onchange={(e) => { if (step.kind === "setActive" && step.target.kind === "tag") {
                  const input = e.currentTarget.value;
                  const terms = input.split(",").map((v) => v.trim());
                  step.target.query = step.target.pattern === "regex" ? input : terms.length === 1 ? terms[0] ?? "" : terms;
                } }} placeholder="door*" /></label>
              <label>Match <select bind:value={step.target.mode}><option value="all">All</option><option value="any">Any</option><option value="exactSet">Exact set</option></select></label>
              <label>Pattern <select bind:value={step.target.pattern}><option value="literal">Exact</option><option value="wildcard">Wildcard</option><option value="regex">Safe regex</option></select></label>
              <label><input type="checkbox" checked={step.target.caseSensitive !== false}
                onchange={(e) => { if (step.kind === "setActive" && step.target.kind === "tag") step.target.caseSensitive = e.currentTarget.checked; }} />Case sensitive</label>
              <label><input type="checkbox" disabled={step.target.pattern !== "literal" && step.target.pattern !== undefined}
                checked={step.target.contains ?? false}
                onchange={(e) => { if (step.kind === "setActive" && step.target.kind === "tag") step.target.contains = e.currentTarget.checked; }} />Substring</label>
              <label>Only these tiles <select aria-label="Include activity tiles" multiple size="3"
                onchange={(e) => changeTagRefs(i, "includeRefs", e.currentTarget)}>
                {#each tagOptions.filter((item) => item.ref.coll === "tiles") as item (item.ref.id)}
                  <option value={tagOptions.indexOf(item)} selected={step.target.includeRefs?.some((ref) => ref.id === item.ref.id) ?? false}>
                    {item.doc.name} ({item.ref.id})</option>
                {/each}
              </select></label>
              <label>Exclude these tiles <select aria-label="Exclude activity tiles" multiple size="3"
                onchange={(e) => changeTagRefs(i, "excludeRefs", e.currentTarget)}>
                {#each tagOptions.filter((item) => item.ref.coll === "tiles") as item (item.ref.id)}
                  <option value={tagOptions.indexOf(item)} selected={step.target.excludeRefs?.some((ref) => ref.id === item.ref.id) ?? false}>
                    {item.doc.name} ({item.ref.id})</option>
                {/each}
              </select></label>
            {/if}
            <small>Changes the host-published paused gate on all graphs bound to each matching tile (up to 32 tiles / 128 graphs). It does not hide the tile. Later Trigger Tile calls in this plan see the new gate; the entire plan is undoable. Changing this graph's own gate does not interrupt the current fire.</small>
          {:else if step.kind === "stopOthers"}
            <small>After a successful movement-trigger commit, suppress later tiles for this moving token; already-committed tiles and other tokens are unaffected. Canvas click currently dispatches only one tile.</small>
          {:else if step.kind === "set"}
            <label>Name <input bind:value={step.name} /></label>
            <label>Scope <select aria-label="Variable scope" value={step.scope ?? "run"}
              onchange={(e) => changeVariableScope(i, e.currentTarget.value as "run" | "tile")}>
              <option value="run">This trigger only</option><option value="tile">Keep on tile graph(s)</option>
            </select></label>
            {#if step.scope === "tile"}
              <label>Variable target <select aria-label="Variable target" value={step.target?.kind ?? "self"}
                onchange={(e) => changeVariableTarget(i, e.currentTarget.value as AutomationTileTarget["kind"] | "self")}>
                <option value="self">This graph only</option><option value="id">All graphs on one tile</option>
                <option value="current">All graphs on current tiles</option><option value="tag">All graphs on tagged tiles</option>
              </select></label>
              {#if step.target?.kind === "id"}
                <label>Variable tile <select aria-label="Variable tile" bind:value={step.target.tileId}>
                  <option value="">Choose a tile…</option>
                  {#each scene?.tiles ?? [] as target (target._id)}<option value={target._id}>{target.name} ({target._id})</option>{/each}
                </select></label>
              {:else if step.target?.kind === "tag"}
                <label>Variable tile tags <input aria-label="Variable tile tags"
                  value={Array.isArray(step.target.query) ? step.target.query.join(", ") : step.target.query}
                  onchange={(e) => { if (step.kind === "set" && step.target?.kind === "tag") {
                    const input = e.currentTarget.value;
                    const terms = input.split(",").map((v) => v.trim());
                    step.target.query = step.target.pattern === "regex" ? input : terms.length === 1 ? terms[0] ?? "" : terms;
                  } }} placeholder="relay*" /></label>
                <label>Match <select bind:value={step.target.mode}><option value="all">All</option><option value="any">Any</option><option value="exactSet">Exact set</option></select></label>
                <label>Pattern <select bind:value={step.target.pattern}><option value="literal">Exact</option><option value="wildcard">Wildcard</option><option value="regex">Safe regex</option></select></label>
                <label><input type="checkbox" checked={step.target.caseSensitive !== false}
                  onchange={(e) => { if (step.kind === "set" && step.target?.kind === "tag") step.target.caseSensitive = e.currentTarget.checked; }} />Case sensitive</label>
                <label><input type="checkbox" disabled={step.target.pattern !== "literal" && step.target.pattern !== undefined}
                  checked={step.target.contains ?? false}
                  onchange={(e) => { if (step.kind === "set" && step.target?.kind === "tag") step.target.contains = e.currentTarget.checked; }} />Substring</label>
                <label>Only these tiles <select aria-label="Include variable tiles" multiple size="3"
                  onchange={(e) => changeTagRefs(i, "includeRefs", e.currentTarget)}>
                  {#each tagOptions.filter((item) => item.ref.coll === "tiles") as item (item.ref.id)}
                    <option value={tagOptions.indexOf(item)} selected={step.target.includeRefs?.some((ref) => ref.id === item.ref.id) ?? false}>
                      {item.doc.name} ({item.ref.id})</option>
                  {/each}
                </select></label>
                <label>Exclude these tiles <select aria-label="Exclude variable tiles" multiple size="3"
                  onchange={(e) => changeTagRefs(i, "excludeRefs", e.currentTarget)}>
                  {#each tagOptions.filter((item) => item.ref.coll === "tiles") as item (item.ref.id)}
                    <option value={tagOptions.indexOf(item)} selected={step.target.excludeRefs?.some((ref) => ref.id === item.ref.id) ?? false}>
                      {item.doc.name} ({item.ref.id})</option>
                  {/each}
                </select></label>
              {/if}
            {/if}
            <label>Operation <select aria-label="Variable operation" value={step.operation ?? "assign"}
              onchange={(e) => changeSetOperation(i, e.currentTarget.value as "assign" | "add" | "delete")}>
              <option value="assign">Set value</option><option value="add">Add to previous (starts at 0)</option>
              <option value="delete">Delete variable</option>
            </select></label>
            {#if step.operation !== "delete"}
            <label>Value type <select value={typeof step.value} onchange={(e) => changeSetType(i, e.currentTarget.value as "string" | "number" | "boolean")}>
              <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
            </select></label>
            {#if typeof step.value === "boolean"}
              <label>Value <select value={String(step.value)} onchange={(e) => changeSetValue(i, e.currentTarget.value)}>
                <option value="true">True</option><option value="false">False</option>
              </select></label>
            {:else}
              <label>Value <input type={typeof step.value === "number" ? "number" : "text"} value={String(step.value)} onchange={(e) => changeSetValue(i, e.currentTarget.value)} /></label>
            {/if}
            {:else}
              <small>Remove this exact name. A missing variable is a no-op; later Check Variable reads a deleted tile value as null. Other variables and trigger history are preserved.</small>
            {/if}
            <small>Private, persisted graph variables survive history reset and undo with this graph. Targeting an ID, current tiles or Tagger tiles writes each graph's separate variable map (at most 32 tiles / 128 graph states) within one atomic plan; later Trigger Tile calls read staged values. Filters and {"{{name}}"} on the current graph read its own values. No expression evaluation or cross-scene targets; numeric additions are bounded to ±1,000,000,000.</small>
          {:else if step.kind === "gameTime"}
            <label>Amount source <select aria-label="Game Time source" value={step.formula !== undefined ? "formula" : "fixed"}
              onchange={(event) => {
                if (event.currentTarget.value === "formula") { step.formula = String(step.minutes ?? 60); delete step.minutes; }
                else { step.minutes = 60; delete step.formula; }
              }}><option value="fixed">Fixed minutes</option><option value="formula">Dice / math</option></select></label>
            {#if step.formula !== undefined}
              <label>Minute expression <input aria-label="Game Time formula" maxlength="128" bind:value={step.formula} placeholder="1d6 * 10 - 30" /></label>
            {:else}
              <label>World clock change (minutes) <input aria-label="Game Time minutes" type="number"
                step="1" min="-525600" max="525600" bind:value={step.minutes} /></label>
            {/if}
            <small>Game Time advances or rewinds the host-owned clock by whole minutes (±1 year per step). Safe dice/math resolves once per step on the host; no scripts, document paths or templates. Up to 64 random draws per formula and 1024 across the nested plan. Later time checks read the staged clock; any failed action rolls back the whole transaction. The clock stays within 0–3153600000 seconds. Automatic time-trigger scheduling is not supported yet.</small>
          {:else if step.kind === "sceneLighting"}
            <label>Lighting operation <select aria-label="Lighting operation" bind:value={step.mode}>
              <option value="set">Set darkness</option><option value="add">Add to darkness</option>
            </select></label>
            <label>Darkness <input aria-label="Scene Lighting darkness" type="number" min={step.mode === "add" ? -1 : 0}
              max="1" step="0.05" bind:value={step.darkness} /></label>
            <label>Visual transition (ms) <input aria-label="Scene Lighting duration" type="number" min="0" max="60000" step="100"
              value={step.durationMs ?? ""} onchange={(e) => { if (e.currentTarget.value === "") delete step.durationMs; else step.durationMs = Number(e.currentTarget.value); }} /></label>
            <small>0 is bright, 1 is dark; additions outside that range reject the whole graph. Optional 0–60000 ms fades the ambient tint locally; blank or zero cuts immediately. Vision rules, later checks and child tiles use the committed value immediately. New fades start from the drawn value; reduced motion, first appearance and reload cut to the endpoint. Undo restores lighting and graph history together. Not a shared-clock or deferred-mechanics transition.</small>
          {:else if step.kind === "sceneBackground" || step.kind === "tileImage"}
            {#if step.kind === "sceneBackground"}
              <label>Background scene <select aria-label="Background scene" value={step.targetSceneId ?? ""}
                onchange={(e) => { if (step.kind === "sceneBackground") {
                  if (e.currentTarget.value) step.targetSceneId = e.currentTarget.value;
                  else delete step.targetSceneId;
                } }}>
                <option value="">This graph's scene</option>
                {#if step.targetSceneId && !scenes.some((s) => s._id === step.targetSceneId)}
                  <option value={step.targetSceneId}>Unavailable scene</option>
                {/if}
                {#each scenes as target (target._id)}<option value={target._id}>{target.name}</option>{/each}
              </select></label>
            {/if}
            {#if step.kind === "tileImage"}
              <label>Image source <select aria-label="Tile image source" value={step.images ? "list" : "direct"}
                onchange={(e) => { if (step.kind === "tileImage") {
                  definition.steps[i] = e.currentTarget.value === "list"
                    ? { id: step.id, kind: "tileImage", images: step.image ? [step.image] : [], selection: "next" }
                    : { id: step.id, kind: "tileImage", image: step.images?.[0] ?? step.image ?? "" };
                } }}>
                <option value="direct">One image / clear</option><option value="list">Ordered image list</option>
              </select></label>
            {/if}
            {#if step.kind === "tileImage" && step.images}
              <label>Change to <select aria-label="Tile image selection" value={step.selection}
                onchange={(e) => { if (step.kind === "tileImage" && step.images) {
                  step.selection = e.currentTarget.value as typeof step.selection;
                  if (step.selection === "index") step.index = 1; else delete step.index;
                  if (step.selection === "numbers") step.numbers = "1"; else delete step.numbers;
                  if (step.selection === "formula") step.formula = "1d1"; else delete step.formula;
                } }}>
                <option value="first">First</option><option value="last">Last</option>
                <option value="next">Next (wrap)</option><option value="previous">Previous (wrap)</option>
                <option value="index">Number</option><option value="random">Random</option>
                <option value="other">Random other (no repeat)</option>
                <option value="numbers">Number list / range</option><option value="formula">Dice / math formula</option>
              </select></label>
              {#if step.selection === "index"}
                <label>Image number <input aria-label="Tile image number" type="number" min="1" max={step.images.length}
                  step="1" bind:value={step.index} /></label>
              {/if}
              {#if step.selection === "numbers"}
                <label>Image numbers <input aria-label="Tile image numbers" maxlength="128" bind:value={step.numbers} placeholder="1-3, 5" /></label>
                <small>Choose randomly from these 1-based numbers. Inclusive ranges and optional brackets, e.g. [1, 3-5]. No repeats/overlaps; every number must exist in the image list. A single number needs no roll.</small>
              {:else if step.selection === "formula"}
                <label>Image formula <input aria-label="Tile image formula" maxlength="128" bind:value={step.formula} placeholder="1d6 or floor(5 / 2)" /></label>
                <small>The host evaluates dice/math separately per tile. The result must be a whole image number in this list, otherwise the entire graph is rejected without writes. Arithmetic, parentheses and the dice engine's math functions/modifiers are supported. No JavaScript, document paths or Handlebars. At most 64 random draws per formula and 1024 per nested graph plan.</small>
              {/if}
              {#each step.images as image, imageIndex (imageIndex)}
                <div class="row">
                  <label>Image {imageIndex + 1} <select aria-label={`Tile list image ${imageIndex + 1}`} value={image}
                    onchange={(e) => { if (step.kind === "tileImage" && step.images) step.images[imageIndex] = e.currentTarget.value; }}>
                    {#if !imageAssets.some(([hash]) => hash === image)}<option value={image}>Unavailable image</option>{/if}
                    {#each imageAssets as [hash, asset] (hash)}<option value={hash}>{asset.name} ({hash.slice(0, 8)})</option>{/each}
                  </select></label>
                  <button type="button" aria-label={`Remove tile list image ${imageIndex + 1}`}
                    onclick={() => { if (step.kind === "tileImage" && step.images) step.images.splice(imageIndex, 1); }}>Remove</button>
                </div>
              {/each}
              <button type="button" aria-label="Add tile list image" disabled={step.images.length >= 32 || !imageAssets.some(([hash]) => !step.images?.includes(hash))}
                onclick={() => { if (step.kind === "tileImage" && step.images) {
                  const next = imageAssets.find(([hash]) => !step.images?.includes(hash));
                  if (next) step.images.push(next[0]);
                } }}>Add image</button>
              <small>1–32 distinct images, stored privately on this action. Each tile uses its current image to find the next/previous entry; if absent, Next starts at first and Previous at last. Number is 1-based. Random other requires at least two images. The host chooses separately per tile and validates every entry on every fire. No transitions, temporary art or loops yet.</small>
            {:else}
            <label>Owned image <select aria-label="World action image" value={step.image ?? ""}
              onchange={(e) => { if (step.kind === "sceneBackground" || step.kind === "tileImage" && !step.images) {
                step.image = e.currentTarget.value || (step.kind === "sceneBackground" ? null : "");
              } }}>
              <option value="">Clear image</option>
              {#if step.image && !imageAssets.some(([hash]) => hash === step.image)}
                <option value={step.image}>Unavailable image — import or approve sharing</option>
              {/if}
              {#each imageAssets as [hash, asset] (hash)}<option value={hash}>{asset.name} ({hash.slice(0, 8)})</option>{/each}
            </select></label>
            {/if}
            <small>Import images in FX timelines and approve player sharing first. Only owned PNG/JPEG/WebP/GIF/AVIF assets are accepted; no remote URLs. The host rechecks availability and sharing on every fire. {step.kind === "tileImage" ? "Select 1–32 tiles first (This tile or Tagger); geometry, visibility and other fields are unchanged." : "Changes the selected saved scene's background without activating it or changing dimensions/grid. A deleted target rejects the whole graph."} Changes and history share one undoable transaction; export rights remain separate.</small>
          {:else if step.kind === "hurtHeal"}
            <label>Amount source <select aria-label="Hurt / Heal amount source" value={step.formula === undefined ? "fixed" : "formula"}
              onchange={(e) => { if (e.currentTarget.value === "formula") { delete step.amount; step.formula = "-1d6"; }
                else { delete step.formula; step.amount = -5; } }}>
              <option value="fixed">Fixed HP change</option><option value="formula">Dice/math formula</option>
            </select></label>
            {#if step.formula !== undefined}
            <label>HP formula (negative hurts, positive heals) <input aria-label="Hurt / Heal formula" maxlength="128" bind:value={step.formula} /></label>
            <small>Host rolls independently once per linked actor. A nonzero whole result within ±100000 is required; invalid results reject the whole graph. Up to 64 random draws per formula, 1024 across nested HP actions. No document paths or scripts.</small>
            {:else}
            <label>HP change (negative hurts, positive heals) <input aria-label="Hurt / Heal HP change"
              type="number" step="1" min="-100000" max="100000" bind:value={step.amount} /></label>
            {/if}
            <label>Token targets <select aria-label="Hurt / Heal targets" bind:value={step.targets}>
              <option value="triggering">Triggering token</option>
              <option value="current">Current token collection (Inside / Tagger selection)</option>
            </select></label>
            <small>Uses PF1e hit points, temporary HP and nonlethal healing. Every token needs a linked actor with authored HP; 1–32 tokens, one application per actor. No damage type or inline script. Changes share the graph's GM Revert receipt and refuse later conflicting edits.</small>
          {:else if step.kind === "random"}
            <label>Variable <input bind:value={step.name} /></label>
            <label>Minimum <input type="number" step="1" bind:value={step.min} /></label>
            <label>Maximum <input type="number" step="1" bind:value={step.max} /></label>
          {:else if step.kind === "tags"}
            <label>Edit <select bind:value={step.edit}><option value="add">Add</option><option value="remove">Remove</option><option value="toggle">Toggle</option><option value="replace">Replace</option></select></label>
            <label>Tags <input value={step.tags.join(", ")} onchange={(e) => step.kind === "tags" && (step.tags = (e.target as HTMLInputElement).value.split(",").map((t) => t.trim()).filter(Boolean))} /></label>
          {:else if step.kind === "visibility"}
            <label>Token/tile/pin visibility <select bind:value={step.mode}><option value="show">Show</option><option value="hide">Hide</option><option value="toggle">Toggle</option></select></label>
          {:else if step.kind === "door"}
            <label>Tagged door state <select bind:value={step.mode}><option value="open">Open</option><option value="close">Close</option><option value="lock">Lock</option><option value="unlock">Unlock</option><option value="toggle">Toggle</option></select></label>
          {:else if step.kind === "move"}
            <label>Destination source <select aria-label="Move destination source" value={step.destinationOriginal ? "original" : step.destinationResult ?? (step.destinationTag ? "tag" : step.destination?.coll ?? "coordinates")}
              onchange={(e) => changeMoveDestination(i, e.currentTarget.value)}>
              <option value="coordinates">Coordinates / offsets</option><option value="tokens">Token center</option><option value="tiles">Tile center</option><option value="tag">Live Tagger destination</option><option value="rollTable">Last Roll Table coordinates</option><option value="original">Original Destination</option>
            </select></label>
            {#if step.destinationOriginal}
              <small>Uses the triggering token's host-observed committed endpoint from this movement crossing, before this graph changes it. Requires an actual enter/exit/stop movement event for that same token; manual/click/dry-run and unrelated child tokens have no endpoint context. This does not intercept or cancel movement, and does not restore the endpoint unless this graph moves a token to it.</small>
            {:else if step.destinationResult}
              <small>Uses the latest Roll Table action executed in this graph invocation, not a chat message, named variable or nested graph's result. Text must be at most 256 characters and contain exactly numeric {'{"x": 600, "y": 400}'} coordinates. X/Y below are offsets from that point. Missing, missed, malformed or out-of-scene results reject the entire graph, including the roll message. Table RNG is host-owned and capped at 1024 draws across nested calls.</small>
            {:else if step.destinationTag}
              <label>Multiple destinations <select aria-label="Move destination choice" value={step.destinationChoice ?? "unique"}
                onchange={(e) => step.destinationChoice = e.currentTarget.value === "random" ? "random" : "unique"}>
                <option value="unique">Require exactly one match</option><option value="random">Host chooses one at random</option>
              </select></label>
              <label>Destination tags <input aria-label="Move destination tags" value={Array.isArray(step.destinationTag.query) ? step.destinationTag.query.join(", ") : step.destinationTag.query}
                onchange={(e) => { if (step.destinationTag) step.destinationTag.query = step.destinationTag.pattern === "regex" ? e.currentTarget.value : e.currentTarget.value.split(",").map((v) => v.trim()); }} /></label>
              <label>Destination match <select aria-label="Move destination match" bind:value={step.destinationTag.mode}>
                <option value="all">All</option><option value="any">Any</option><option value="exactSet">Exact set</option>
              </select></label>
              <label>Destination pattern <select aria-label="Move destination pattern" bind:value={step.destinationTag.pattern}>
                <option value="literal">Exact</option><option value="wildcard">Wildcard</option><option value="regex">Safe regex</option>
              </select></label>
              <label>Destination types <select aria-label="Move destination types" value={step.destinationTag.collections?.join(",") ?? "tokens,tiles"}
                onchange={(e) => { if (step.destinationTag) step.destinationTag.collections = e.currentTarget.value.split(",") as ("tokens" | "tiles")[]; }}>
                <option value="tokens,tiles">Tokens and tiles</option><option value="tokens">Tokens</option><option value="tiles">Tiles</option>
              </select></label>
              <label><input type="checkbox" aria-label="Move destination case sensitive" checked={step.destinationTag.caseSensitive !== false}
                onchange={(e) => { if (step.destinationTag) step.destinationTag.caseSensitive = e.currentTarget.checked; }} />Case sensitive destination tags</label>
              <label><input type="checkbox" aria-label="Move destination substring" checked={step.destinationTag.contains ?? false}
                disabled={step.destinationTag.pattern !== "literal" && step.destinationTag.pattern !== undefined}
                onchange={(e) => { if (step.destinationTag) step.destinationTag.contains = e.currentTarget.checked; }} />Substring destination tags</label>
              {#each ["includeRefs", "excludeRefs"] as field (field)}
                {@const refField = field as "includeRefs" | "excludeRefs"}
                <label>{field === "includeRefs" ? "Only destination refs (none = all)" : "Exclude destination refs"}
                  <select multiple size="3" aria-label={field === "includeRefs" ? "Include Move destination refs" : "Exclude Move destination refs"}
                    value={(step.destinationTag[refField] ?? []).map(pinKey)} onchange={(e) => changeMoveTagRefs(i, refField, e.currentTarget)}>
                    {#each pinnedChoices(step.destinationTag[refField] ?? []).filter((item) => item.ref.coll === "tokens" || item.ref.coll === "tiles") as item (pinKey(item.ref))}
                      <option value={pinKey(item.ref)}>{item.name}</option>
                    {/each}
                  </select>
                </label>
              {/each}
              <small>The default requires exactly one match. Random choice selects one shared destination from up to 1024 matching tokens/tiles. Zero matches always reject; ambiguity rejects unless random choice is explicitly enabled. Reads staged tags and positions, including hidden GM targets. Ref filters narrow tag matches; they do not substitute missing matches.</small>
            {:else if step.destination}
              <label>Destination entity <select aria-label="Move destination entity" bind:value={step.destination.id}>
                <option value="">Choose destination…</option>
                {#if step.destination.id && !scene?.[step.destination.coll].some((item) => item._id === step.destination?.id)}
                  <option value={step.destination.id}>Unavailable destination</option>
                {/if}
                {#each scene?.[step.destination.coll] ?? [] as entity (entity._id)}<option value={entity._id}>{entity.name}</option>{/each}
              </select></label>
            {:else}
            <label>Move mode <select aria-label="Move mode" value={step.mode ?? "set"}
              onchange={(e) => step.mode = e.currentTarget.value === "add" ? "add" : "set"}>
              <option value="set">Set destination</option><option value="add">Add relative offset</option>
            </select></label>
            {/if}
            {#if step.destination || step.destinationTag}
              <label>Destination positioning <select aria-label="Move destination positioning" value={step.destinationPosition ?? "center"}
                onchange={(e) => step.destinationPosition = e.currentTarget.value === "entry" ? "entry" : e.currentTarget.value === "random" ? "random" : "center"}>
                <option value="center">Center</option><option value="random">Random within tile</option><option value="entry">Relative to entry</option>
              </select></label>
              <small>Relative to entry maps the triggering token's host-observed boundary contact into the destination tile's local rectangle, scaling between sizes and rotating with both tiles. Requires this tile's enter event; manual/click/stop/exit and nested Trigger Tile calls have no entry context and reject the graph. All movers share that contact. Token destinations ignore positioning and use their center. Offsets and snap apply afterwards; no footprint fitting or retries.</small>
              <small>The destination geometry is captured once per action. Random within tile samples a separate point for each mover inside its rotated rectangle; token destinations still use their center. X/Y are scene-axis offsets added afterwards, before snap/collision/speed. Offsets, snapping or the mover's footprint may extend beyond the tile; blocked/out-of-scene results reject the whole plan without retries. Choice, placement and offset dice share 1024 host draws per plan. Prefabs rebind internal entity IDs and unambiguous Tagger templates; unsafe template bindings are refused.</small>
            {/if}
            {#each ["x", "y"] as axis (axis)}
              {@const coordinate = axis as "x" | "y"}
              {@const formula = coordinate === "x" ? "xFormula" : "yFormula"}
              {@const mode = coordinate === "x" ? "xMode" : "yMode"}
              {#if !step.destination && !step.destinationTag && !step.destinationResult && !step.destinationOriginal}
              <label>{axis.toUpperCase()} operation <select aria-label={`Move ${axis.toUpperCase()} mode`} value={step[mode] ?? "inherit"}
                onchange={(e) => { if (e.currentTarget.value === "inherit") { if (coordinate === "x") delete step.xMode; else delete step.yMode; } else step[mode] = e.currentTarget.value === "add" ? "add" : "set"; }}>
                <option value="inherit">Use Move mode</option><option value="set">Set coordinate</option><option value="add">Add offset</option>
              </select></label>
              {/if}
              <label>{axis.toUpperCase()} source <select aria-label={`Move ${axis.toUpperCase()} source`} value={step[formula] === undefined ? "fixed" : "formula"}
                onchange={(e) => { if (e.currentTarget.value === "formula") { if (coordinate === "x") delete step.x; else delete step.y; step[formula] = "0"; }
                  else { if (coordinate === "x") delete step.xFormula; else delete step.yFormula; step[coordinate] = 0; } }}>
                <option value="fixed">Fixed pixels</option><option value="formula">Dice/math formula</option>
              </select></label>
              {#if step[formula] !== undefined}
                <label>{axis.toUpperCase()} formula <input aria-label={`Move ${axis.toUpperCase()} formula`} maxlength="128" bind:value={step[formula]} /></label>
              {:else}
                <label>{axis.toUpperCase()} / offset <input aria-label={`Move ${axis.toUpperCase()}`} type="number" step="any" bind:value={step[coordinate]} /></label>
              {/if}
            {/each}
            <small>X and Y can independently set a coordinate or add an offset. The host evaluates X then Y separately per target before snapping, collision and speed. Safe dice/math only, no scripts/templates/document paths. Each formula is limited to 128 characters and 64 draws; nested Move actions share 1024 draws. Nonfinite/out-of-bounds results reject the whole plan.</small>
            <small>Moves tokens, tiles, drawings, lights, sounds and templates. Drawings translate around their bounding center without changing shape; lights/sounds/templates use their point anchor. Only tokens/tiles animate: duration and speed have no visual effect on other types. Footprint collision uses drawing bounds and point paths for emitters/templates, not their displayed area. Walls and map pins are not Move targets.</small>
            <label>Entity targets <select aria-label="Move targets" bind:value={step.targets}>
              <option value="current">Current movable collection (tokens, tiles, drawings, lights, sounds, templates)</option>
              <option value="triggering">Triggering token</option>
            </select></label>
            <label><input type="checkbox" aria-label="Move snap to grid" checked={step.snapToGrid ?? false}
              onchange={(e) => step.snapToGrid = e.currentTarget.checked} /> Snap destination to grid</label>
            <label>Wall collision <select aria-label="Move wall collision" value={step.wallCollision ?? "ignore"}
              onchange={(e) => step.wallCollision = e.currentTarget.value === "footprint" ? "footprint" : e.currentTarget.value === "block" ? "block" : "ignore"}>
              <option value="ignore">Ignore walls (legacy)</option><option value="block">Reject blocked center path</option><option value="footprint">Reject swept footprint collision</option>
            </select></label>
            <label>Animation duration (ms; blank uses speed or native behavior) <input aria-label="Move duration" type="number" min="0" max="60000" step="100"
              value={step.durationMs ?? ""} onchange={(e) => { if (e.currentTarget.value === "") delete step.durationMs; else step.durationMs = Number(e.currentTarget.value); }} /></label>
            <label>Movement speed (grid sizes/second; optional) <input aria-label="Move speed" type="number" min="0.01" max="10000" step="0.1"
              value={step.speed ?? ""} onchange={(e) => { if (e.currentTarget.value === "") delete step.speed; else step.speed = Number(e.currentTarget.value); }} /></label>
            <label><input type="checkbox" aria-label="Move trigger tiles" checked={step.triggerTiles ?? true}
              onchange={(e) => step.triggerTiles = e.currentTarget.checked} /> Trigger tiles while moving</label>
            <small>Duration overrides speed, including zero. Speed uses final snapped distance divided by grid.size (also in gridless scenes); over 60 seconds rejects the plan rather than clamping. Disabling triggers suppresses enter/exit/stop for explicitly moved tokens in this commit, not future manual moves or Rotation. For multiple actual moves of one token in a nested plan, the last Move controls the final committed path.</small>
            <small>Animation is local presentation of the committed destination, not delayed game state. Existing visible entities move from their drawn position; newly visible/reloaded entities appear at the destination. Zero cuts instantly. Clients may start at different receipt times. Wall checks use the final snapped destination and staged door state. Footprint mode sweeps the native token rectangle or rotated tile rectangle along the straight path; it does not rotate during travel or find detours. One-way walls remain conservatively two-sided.</small>
            <small>Host-authorized movement in this scene, in pixels. Set uses the token or tile center; Add offsets each target's staged position. Optional snapping runs after offsets and uses the nearest square-cell or hex center; gridless scenes are unchanged. Negative offsets are allowed, but the resulting center (and tile top-left) must remain inside the scene. Other collection types reject the graph. Undo restores movement and history. Token movement can fire other tiles unless Trigger tiles while moving is disabled. Moving a tile over stationary tokens does not fire movement triggers. The host validates all targets before committing; a blocked path rejects the entire graph.</small>
          {:else if step.kind === "rotate"}
            <label>Rotation mode <select aria-label="Rotation mode" value={step.mode ?? "set"}
              onchange={(e) => step.mode = e.currentTarget.value === "add" ? "add" : "set"}>
              <option value="set">Set absolute angle</option><option value="add">Add relative angle</option>
            </select></label>
            <label>Angle source <select aria-label="Rotation angle source" value={step.formula === undefined ? "fixed" : "formula"}
              onchange={(e) => { if (e.currentTarget.value === "formula") { delete step.angle; step.formula = "1d4 * 90"; }
                else { delete step.formula; step.angle = 90; } }}>
              <option value="fixed">Fixed degrees</option><option value="formula">Dice/math formula</option>
            </select></label>
            {#if step.formula !== undefined}
            <label>Angle formula <input aria-label="Rotation formula" maxlength="128" bind:value={step.formula} /></label>
            <small>Host evaluates separately per token/tile. Zero and fractional results are allowed; finite degrees within ±1000000 are required. Invalid results reject the whole graph. At most 64 random draws per formula and 1024 across nested rotation actions. No scripts, templates or document paths.</small>
            {:else}
            <label>Rotation (degrees) <input aria-label="Rotation angle" type="number" step="any" min="-1000000" max="1000000" bind:value={step.angle} /></label>
            {/if}
            <label>Visual transition (ms) <input aria-label="Rotation duration" type="number" min="0" max="60000" step="100"
              value={step.durationMs ?? ""} onchange={(e) => { if (e.currentTarget.value === "") delete step.durationMs; else step.durationMs = Number(e.currentTarget.value); }} /></label>
            <small>Optional 0–60000 ms animates the shortest turn from the currently drawn angle (180° ties turn clockwise). Blank or zero cuts. Full revolutions are not replayed. Reduced motion and first appearance/reload cut to the endpoint; labels and HP bars stay upright. Local receipt-time presentation, not deferred mechanics or shared-clock playback.</small>
            <label>Entity targets <select aria-label="Rotation targets" bind:value={step.targets}>
              <option value="current">Current token/tile collection (This tile / Inside / Tagger)</option>
              <option value="triggering">Triggering token</option>
            </select></label>
            <small>Set or add degrees, normalized to [0, 360). Negative additions subtract degrees; visual animation still takes the shortest arc. Reads each target's staged rotation, including earlier and nested actions. Only live tokens/tiles are supported; other collection types reject the graph. Mechanical rotation commits immediately and is undoable. A committed token rotation inside a tile can fire that tile's rotate method.</small>
          {:else if step.kind === "delete"}
            <small>Deletes the current collection's scene tokens, tiles, walls, drawings, map pins, lights, ambient sounds or measured templates — one delete op each, atomic with the rest of the graph (Undo restores them). Deleting a token never touches its linked actor; deleting a sound never removes its audio asset. The collection is empty afterwards. Pending tag/visibility/door edits on deleted entities are superseded; edits to surviving entities remain. Scenes, strategic cells and other documents are refused.</small>
          {:else if step.kind === "rollTable"}
            <small>The result text also becomes this invocation's latest Roll Table result for a following Move → Last Roll Table coordinates. It does not replace the current entity collection or pass into/out of nested graphs.</small>
            <label>Roll table <select bind:value={step.tableId}><option value="">Choose table…</option>{#each rollTables as table (table._id)}<option value={table._id}>{table.name} ({table.formula})</option>{/each}</select></label>
            <label>Audience <select bind:value={step.audience}><option value="scene">Scene</option><option value="gm">GM only</option></select></label>
            <label>Store result text in variable (optional)
              <input value={step.variable ?? ""} aria-label="Roll Table result variable" placeholder="loot"
                onchange={(e) => { if (step.kind === "rollTable") { const value = (e.target as HTMLInputElement).value.trim(); step.variable = value ? value : undefined; } }} /></label>
            <small>The host rolls the table's formula with its own RNG and posts the result as a roll message. The optional variable receives the result text (at most 256 characters; a miss stores the empty string) for later filters and chat interpolation.</small>
          {:else if step.kind === "chat"}
            <label>Text <input bind:value={step.content} placeholder={'{{user}}, {{count}}, {{method}}'} /></label>
            <label>Audience <select bind:value={step.audience}><option value="gm">GM only</option><option value="scene">Scene</option></select></label>
            <small>Scene messages intentionally publish interpolated text, including IDs of selected hidden targets. Use GM only unless that disclosure is intended.</small>
          {:else if step.kind === "sequence"}
            <label>Saved FX macro <select bind:value={step.macroId}><option value="">Choose…</option>{#each macros as macro (macro._id)}<option value={macro._id}>{macro.name}</option>{/each}</select></label>
            <label>Audience <select bind:value={step.audience}><option value="gm">GM only</option><option value="scene">Entitled scene viewers</option></select></label>
          {:else if step.kind === "script"}
            <label>Reviewed script <select value={step.macroId} onchange={(e) => changeScriptMacro(i, e.currentTarget.value)}>
              <option value="">Choose approved script…</option>
              {#each scripts.filter((m) => m.script?.sceneId === sceneId) as macro (macro._id)}
                <option value={macro._id}>{macro.name} ({macro.script?.playerCallable ? "players may invoke" : "GM only"})</option>
              {/each}
            </select></label>
            {#if scriptFor(step)?.script?.inputs.length}
              {#each scriptFor(step)?.script?.inputs ?? [] as field (field.name)}
                <label>{field.name}{field.required ? " *" : ""}
                  {#if field.type !== "boolean"}
                    <select aria-label={`Bind ${field.name}`} value={step.bindings?.[field.name] ?? ""}
                      onchange={(e) => setScriptBinding(i, field.name, e.currentTarget.value as AutomationScriptBinding | "")}>
                      <option value="">Literal input</option>
                      {#if field.type === "token" || field.type === "string"}
                        <option value="triggerToken">Triggering token</option><option value="currentToken">Selected token</option>
                      {/if}
                      {#if field.type === "string"}
                        <option value="method">Trigger method</option><option value="user">Caller</option>
                        <option value="scene">Scene ID</option><option value="tile">Tile ID</option>
                      {/if}
                      {#if field.type === "number"}<option value="count">Run count</option>{/if}
                    </select>
                  {/if}
                  {#if !step.bindings?.[field.name]}
                    {#if field.type === "boolean"}
                      <input type="checkbox" checked={step.args?.[field.name] === true}
                        onchange={(e) => setScriptArg(i, field.name, field.type, e.currentTarget.checked)} />
                    {:else}
                      <input type={field.type === "number" ? "number" : "text"} value={String(step.args?.[field.name] ?? "")}
                        placeholder={field.type === "token" ? "Visible token ID" : field.type}
                        onchange={(e) => setScriptArg(i, field.name, field.type, e.currentTarget.value)} />
                    {/if}
                  {/if}
                </label>
              {/each}
            {/if}
            <label><input type="checkbox" aria-label={`Expose script result ${step.id}`}
              checked={step.captureResult ?? false} onchange={(e) => setScriptCaptureResult(i, e.currentTarget.checked)} />
              Expose awaited result to later branches</label>
            <label>Run as
              <select aria-label={`Run as ${step.id}`} value={step.runAs ?? "approved"}
                onchange={(e) => setScriptRunAs(i, e.currentTarget.value as "approved" | "caller" | "gm")}>
                <option value="approved">Saved macro policy ({scriptFor(step)?.script?.runAs ?? "unavailable"})</option>
                <option value="caller">Invoking user</option>
                <option value="gm">GM (only if the saved policy approves it)</option>
              </select>
            </label>
            <label>If this action fails
              <select aria-label={`On failure ${step.id}`} value={step.onError ?? "stop"}
                onchange={(e) => setPostActionErrorPolicy(i, e.currentTarget.value as "stop" | "continue")}>
                <option value="stop">Cancel remaining actions</option>
                <option value="continue">Continue remaining authorized actions</option>
              </select>
            </label>
            <small>Runs after the graph commits and is awaited. Results and errors go to the GM trace. Enabling result branching yields at this step, then resumes the remaining graph in a new host transaction; earlier commits are not rolled back. To branch on an ordinary failure, select Continue and check the result’s `ok` path. A step can only narrow the saved macro's approved run-as; it cannot turn a caller-only script into GM code. Continuing never overrides disconnect, timeout, graph revocation or stale authorization.</small>
          {:else if step.kind === "summon"}
            <label>Saved summon preset <select data-zone-summon-preset bind:value={step.presetId}>
              <option value="">Choose approved preset…</option>
              {#each summons.filter((m) => m.summon?.sceneId === sceneId) as preset (preset._id)}
                <option value={preset._id}>{preset.name} · {preset.summon?.playerCallable ? "published" : "GM-only"}</option>
              {/each}
            </select></label>
            <label>Placement point <select data-zone-summon-anchor bind:value={step.anchor}>
              <option value="tile">Tile center</option><option value="trigger">Triggering token</option>
              <option value="current">First selected token</option>
            </select></label>
            <label>If this action fails
              <select aria-label={`On failure ${step.id}`} value={step.onError ?? "stop"}
                onchange={(e) => setPostActionErrorPolicy(i, e.currentTarget.value as "stop" | "continue")}>
                <option value="stop">Cancel remaining actions</option>
                <option value="continue">Continue remaining authorized actions</option>
              </select>
            </label>
            <small>GM-approved preset ID; players cannot choose the actor or override its data. A player-triggered graph requires an owned caster token. The summon is a separate host commit after the graph, bounded by the preset's range/LOS and still private when its source is private. Failed source lookup produces a GM-only trace, not a rolled-back graph.</small>
          {:else if step.kind === "stopMovement"}
            <label><input type="checkbox" aria-label="Stop movement snap to grid" checked={step.snapToGrid ?? false}
              onchange={(e) => step.snapToGrid = e.currentTarget.checked} /> Snap to Grid</label>
            <small>Only valid on this tile's host-observed Enter or Exit movement trigger. The token settles at its swept boundary contact; optional grid snap moves it to the nearest cell/hex center. A sole unconditional Stop action with no earlier competing movement trigger is clipped into the initial movement commit. Conditional or multi-step graphs use a follow-up atomic correction instead. Neither path cancels an in-flight client animation or waypoint movement; a later Original Destination Move can continue to the host-saved endpoint.</small>
          {:else if step.kind === "landing"}<label>Landing name <input bind:value={step.name} /></label>
          {:else if step.kind === "jump"}<label>Go to landing <input bind:value={step.to} /></label>{/if}
        </fieldset>
      {/each}
    </div>
    <div class="row">Add:
      {#each ADD_KINDS as kind (kind)}<button type="button" data-zone-add={kind} onclick={() => addStep(kind)}>{kindLabel(kind)}</button>{/each}
    </div>
    <p class="hint">Counts include this fire; a missing trigger token uses the caller's history key. Loops snapshot the selection, use bounded host execution and restore it after the closing step. Graph mutations commit atomically; reviewed scripts and saved-preset summons run separately in authored order after commit.</p>
    <div class="row">
      <button type="button" data-zone-save onclick={save}>Save graph</button>
      {#if firstSimulatableMethod(definition.methods)}
        <label>Simulate method <select bind:value={triggerMethod}>{#each definition.methods.filter((method) => !isHostDispatchedMethod(method)) as method (method)}<option value={method}>{methodLabel(method)}</option>{/each}</select></label>
      {:else if definition.methods.some((method) => isHostDispatchedMethod(method))}
        <small>{hostEventHint(definition.methods)}</small>
      {/if}
      {#if editing}<button type="button" data-zone-dry-run disabled={!firstSimulatableMethod(definition.methods)} onclick={() => invoke(editing, true)}>Dry-run saved</button>
        <button type="button" data-zone-run disabled={!firstSimulatableMethod(definition.methods)} onclick={() => invoke(editing)}>Fire saved manually</button>{/if}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if status}<p role="status">{status}</p>{/if}
    {#if lastTrace}<details open><summary>Host trace: {lastTrace.method}, {lastTrace.result}</summary>
      <p>{lastTrace.detail}{lastTrace.seq ? ` · committed seq ${lastTrace.seq}` : ""}</p>
      <ol>{#each lastTrace.trace as step, i (i)}<li>{step}</li>{/each}</ol></details>{/if}
    <h4>Saved zones</h4>
    <ul>{#each saved as doc (doc._id)}
      {@const checked = validateAutomation(doc.definition)}
      <li>{doc.name} · {checked.ok ? checked.definition.methods.join("/") : "Invalid imported graph"} · {doc.state?.count ?? 0} run(s)
        {#if checked.ok}
          <button type="button" onclick={() => pick(doc)}>Edit</button>
          <button type="button" data-zone-macro={doc._id} onclick={() => publishMacro(doc)}>{automationMacros.some((m) => macroAutomationGraphId(m) === doc._id) ? "Refresh macro" : "Publish macro"}</button>
          <button type="button" disabled={!firstSimulatableMethod(checked.definition.methods)} onclick={() => { sceneId = checked.definition.sceneId; invoke(doc._id, true, firstSimulatableMethod(checked.definition.methods) ?? "sceneChange"); }}>Dry-run</button>
          <button type="button" disabled={!firstSimulatableMethod(checked.definition.methods)} onclick={() => { sceneId = checked.definition.sceneId; invoke(doc._id, false, firstSimulatableMethod(checked.definition.methods) ?? "sceneChange"); }}>Fire</button>
          {#if doc.state?.count}
            <button type="button" data-zone-reset-history={doc._id} onclick={() => resetHistory(doc)}>Reset gates/history</button>
            <details data-zone-history={doc._id}>
              <summary>Recent fires ({doc.state.recent?.length ?? 0} shown, {doc.state.count} total)</summary>
              {#if doc.state.recent?.length}
                <ol>{#each doc.state.recent.slice().reverse() as entry, index (index)}
                  <li>{new Date(entry.at).toLocaleString()}: {entry.method} · {entry.userId}{entry.tokenId ? ` · ${entry.tokenId}` : ""}</li>
                {/each}</ol>
              {:else}<p>Legacy graph history: aggregate counts only.</p>{/if}
            </details>
          {/if}
          {#if doc.state?.variables && Object.keys(doc.state.variables).length}
            <details data-zone-variables={doc._id}>
              <summary>Tile variables ({Object.keys(doc.state.variables).length})</summary>
              <ul>{#each Object.entries(doc.state.variables) as [key, value] (key)}
                <li><strong>{key}</strong>: {String(value)}</li>
              {/each}</ul>
            </details>
            <button type="button" data-zone-clear-variables={doc._id} onclick={() => clearVariables(doc)}>Clear tile variables</button>
          {/if}
        {:else}<span title={checked.error}>Requires repair or removal</span>{/if}
      </li>
    {/each}</ul>
  {/if}
</section>

<style>
  .active-zones { display: grid; gap: 7px; font-size: .8rem; }
  header, .row, .methods { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
  header { justify-content: space-between; } h3, h4 { margin: 0; }
  .hint { margin: 0; color: #aab6c6; }
  label { display: inline-flex; align-items: center; gap: 4px; }
  input:not([type="checkbox"]), select { min-width: 65px; max-width: 210px; }
  input[type="number"] { width: 78px; }
  .steps { display: grid; gap: 6px; max-height: 260px; overflow-y: auto; }
  fieldset { min-width: 0; border: 1px solid #53586a; border-radius: 4px; padding: 5px; display: flex; flex-wrap: wrap; gap: 6px; }
  legend { color: #e6d6a1; }
  .error { color: #ff9e9e; }
  details { border: 1px solid #53586a; padding: 5px; max-height: 180px; overflow: auto; }
  ol { margin: 3px 0; padding-left: 20px; }
  li { margin: 3px 0; }
</style>
