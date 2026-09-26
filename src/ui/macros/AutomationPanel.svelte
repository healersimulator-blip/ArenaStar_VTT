<script lang="ts">
  import { onMount } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { AutomationDocument, DocRef, Json, MacroDocument, RollTableDocument, SceneDocument,
    TileDocument } from "../../core/documents";
  import { listTaggable } from "../../core/tags";
  import {
    validateAutomation, type AutomationDefinition, type AutomationGates, type AutomationMethod,
    type AutomationSelector, type AutomationStep, type AutomationScriptBinding, type AutomationTileTarget,
  } from "../../core/automation";

  let { client, bus }: { client: ClientSync; bus: EventBus<ClientEvents> } = $props();
  const METHODS: AutomationMethod[] = ["enter", "exit", "stop", "create", "rotate", "click", "manual"];
  const KINDS: AutomationStep["kind"][] = ["select", "filter", "checkVariable", "checkValue", "shuffle", "position", "distance", "attributes", "checkData", "condition", "inventory", "tokenTriggerCount", "routeMethod", "routeUser", "forEach", "endEach", "resetHistory", "batchFlush", "collection", "triggerTile", "setActive", "stopOthers", "set", "gameTime", "hurtHeal", "random", "tags", "visibility", "door", "move", "rotate", "delete", "chat", "sequence", "script", "summon", "rollTable", "landing", "jump", "stop"];
  const ADD_KINDS = KINDS.filter((kind) => kind !== "endEach");
  const KIND_LABEL: Record<string, string> = { batchFlush: "Run All Batch Actions", gameTime: "Game Time",
    hurtHeal: "Hurt / Heal", move: "Move", rotate: "Rotation", delete: "Delete Entities", rollTable: "Roll Table" };
  const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? kind;
  const canEdit = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");
  let scenes = $state<SceneDocument[]>([]);
  let macros = $state<MacroDocument[]>([]);
  let scripts = $state<MacroDocument[]>([]);
  let summons = $state<MacroDocument[]>([]);
  let rollTables = $state<RollTableDocument[]>([]);
  let saved = $state<AutomationDocument[]>([]);
  let editing = $state("");
  let name = $state("");
  let sceneId = $state("");
  let tileId = $state("");
  let tileName = $state("Active zone");
  let tileX = $state(100), tileY = $state(100);
  let tileWidth = $state(200), tileHeight = $state(200), tileRotation = $state(0);
  let tileSort = $state(0), tileHidden = $state(false);
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
  const selectedTile = $derived(scene?.tiles.find((t) => t._id === tileId));
  const tagOptions = $derived(scene ? listTaggable(client.store.world, { sceneId: scene._id }) : []);

  function refresh(): void {
    scenes = [...client.store.getAll("scenes")];
    saved = [...client.store.getAll("automations")];
    macros = [...client.store.getAll("macros")].filter((m) => m.kind === "sequence");
    scripts = [...client.store.getAll("macros")].filter((m) => m.kind === "script");
    summons = [...client.store.getAll("macros")].filter((m) => m.kind === "summon");
    rollTables = [...client.store.getAll("rollTables")];
    if (!scenes.some((s) => s._id === sceneId)) sceneId = scenes.find((s) => s.active)?._id ?? scenes[0]?._id ?? "";
    if (!scene?.tiles.some((tile) => tile._id === tileId)) tileId = scene?.tiles[0]?._id ?? "";
  }
  function pick(doc: AutomationDocument): void {
    const checked = validateAutomation(doc.definition);
    if (!checked.ok) { error = `Imported graph is invalid: ${checked.error}`; return; }
    editing = doc._id;
    name = doc.name;
    definition = { ...$state.snapshot(checked.definition), gates: { ...checked.definition.gates } };
    sceneId = checked.definition.sceneId;
    tileId = checked.definition.tileId;
    triggerMethod = checked.definition.methods[0] ?? "manual";
    error = "";
    status = "Editing saved graph (history is kept separately)";
  }
  function reset(): void {
    editing = "";
    name = "";
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
  }
  function newStep(kind: AutomationStep["kind"], id = `step-${crypto.randomUUID().slice(0, 8)}`): AutomationStep {
    switch (kind) {
      case "select": return { id, kind, selector: { kind: "triggering" } };
      case "filter": return { id, kind, test: { kind: "count", min: 1 } };
      case "checkVariable": return { id, kind, name: "charge", compare: "gte", value: 1 };
      case "checkValue": return { id, kind, source: "darkness", compare: "gte", value: 0.5 };
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
      case "set": return { id, kind, name: "value", value: 1 };
      case "gameTime": return { id, kind, minutes: 60 };
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
      ? { kind, query: "trap", pattern: "literal", caseSensitive: true } : { kind };
    definition.steps[index] = { ...step, selector };
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
        step.kind === "checkData" || step.kind === "routeMethod" || step.kind === "routeUser") ||
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
  function createTile(): void {
    error = ""; status = "";
    if (!canEdit || !scene) { error = "Choose a scene first"; return; }
    if (!tileName.trim() || tileName.length > 128 ||
        ![tileX, tileY, tileWidth, tileHeight, tileRotation].every(Number.isFinite) ||
        !Number.isSafeInteger(tileSort) || Math.abs(tileSort) > 1_000_000 ||
        tileWidth <= 0 || tileHeight <= 0 || tileX < 0 || tileY < 0 ||
        tileX + tileWidth > scene.width || tileY + tileHeight > scene.height ||
        Math.abs(tileRotation) > 360) {
      error = "Tile zone needs a name and a finite rectangle inside this scene (rotation ±360°, sort ±1,000,000).";
      return;
    }
    const doc: TileDocument = { _id: crypto.randomUUID(), type: "tile", name: tileName.trim(),
      ownership: { default: tileHidden ? 0 : 1 }, flags: {}, system: {},
      x: tileX, y: tileY, width: tileWidth, height: tileHeight, rotation: tileRotation, sort: tileSort,
      img: "", hidden: tileHidden, above: false, occlusion: { mode: "roof", alpha: 0.5 } };
    client.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: scene._id }, data: doc }]);
    tileId = doc._id;
    status = `Creating ${tileHidden ? "concealed" : "visible"} zone tile; save the graph after it appears in the tile list.`;
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
    if (!name.trim() || !sceneId || !tileId) { error = "Choose a name, scene and zone tile"; return; }
    const candidate: AutomationDefinition = { ...$state.snapshot(definition), sceneId, tileId };
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
  function invoke(id: string, dryRun = false, method = triggerMethod): void {
    error = "";
    if (!sceneId) { error = "Choose a scene"; return; }
    client.requestAutomation(id, sceneId, method, tokenId || undefined, dryRun);
    status = dryRun ? "Host planning dry-run…" : "Requested saved graph…";
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offTrace = bus.on("automationTrace", (msg) => { lastTrace = msg; status = `${msg.result}: ${msg.detail}`; });
    const offRejected = bus.on("rejected", (msg) => { error = `${msg.reason}: ${msg.detail}`; });
    refresh();
    return () => { offSnapshot(); offOps(); offTrace(); offRejected(); };
  });
</script>

<section class="active-zones" aria-label="Active zone graph" data-active-zones>
  <header><h3>Active zones · trigger graph</h3><button type="button" onclick={reset}>New</button></header>
  <p class="hint">GM-published graphs evaluate committed movement and live tags on the host. Action and gate support is growing toward §5.4 parity; no client sends executable steps.</p>
  {#if !canEdit}
    <p>Active zone definitions and traces are GM-only.</p>
  {:else}
    <div class="row"><label>Name <input bind:value={name} placeholder="e.g. Gate trap" data-zone-name /></label>
      <label>Scene <select bind:value={sceneId} onchange={() => tileId = scene?.tiles[0]?._id ?? ""} data-zone-scene>
        {#each scenes as sc (sc._id)}<option value={sc._id}>{sc.name}</option>{/each}
      </select></label>
      <label>Tile / zone <select bind:value={tileId} data-zone-tile><option value="">Select tile…</option>
        {#each scene?.tiles ?? [] as tile (tile._id)}<option value={tile._id}>{tile.name} ({tile.x},{tile.y})</option>{/each}
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
    {/if}
    <details data-zone-tile-create><summary>Create a rotated tile / zone in this scene</summary>
      <div class="row">
        <label>Tile name <input bind:value={tileName} /></label>
        <label>X <input type="number" bind:value={tileX} /></label>
        <label>Y <input type="number" bind:value={tileY} /></label>
        <label>Width <input type="number" min="1" bind:value={tileWidth} /></label>
        <label>Height <input type="number" min="1" bind:value={tileHeight} /></label>
        <label>Trigger sort <input type="number" step="1" min="-1000000" max="1000000" bind:value={tileSort} /></label>
        <label>Rotation ° <input type="number" min="-360" max="360" bind:value={tileRotation} /></label>
        <label title="Concealed tiles trigger movement but players cannot click what they cannot see">
          <input type="checkbox" bind:checked={tileHidden} />Concealed trap tile</label>
        <button type="button" data-zone-create-tile onclick={createTile}>Create zone tile</button>
      </div>
      <p class="hint">Visible tiles can receive player clicks on the canvas; concealed tiles trigger movement without exposing their zone or media to players.</p>
    </details>
    <div class="methods">Methods:
      {#each METHODS as method (method)}
        <label><input type="checkbox" checked={definition.methods.includes(method)} onchange={() => toggle(method)} />{method}</label>
      {/each}
    </div>
    <div class="row gates">
      <label><input type="checkbox" checked={definition.gates?.paused ?? false} onchange={(e) => setGate("paused", e.currentTarget.checked)} /> Paused</label>
      <label><input type="checkbox" checked={definition.gates?.playerRunnable ?? false} onchange={(e) => setGate("playerRunnable", e.currentTarget.checked)} /> Player click (published)</label>
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
              <option value="triggering">Triggering token</option><option value="inside">Tokens in tile</option><option value="tile">This tile</option><option value="tag">Live tag selector</option>
            </select></label>
            {#if step.selector.kind === "tag"}
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
            {#if step.test.kind === "method"}<label>Method <select bind:value={step.test.method}>{#each METHODS as method (method)}<option value={method}>{method}</option>{/each}</select></label>{/if}
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
              <label>{method} → landing <input aria-label={`${method} landing`} value={step.routes[method] ?? ""} placeholder="(fall through)"
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
                <option value="triggering">Triggering token</option><option value="inside">Tokens in tile</option><option value="tile">This tile</option><option value="tag">Live tag selector</option>
              </select></label>
              {#if step.selector?.kind === "tag"}
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
            <label>Value type <select value={typeof step.value} onchange={(e) => changeSetType(i, e.currentTarget.value as "string" | "number" | "boolean")}>
              <option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option>
            </select></label>
            {#if typeof step.value === "number"}
              <label>Operation <select aria-label="Variable operation" value={step.operation ?? "assign"}
                onchange={(e) => { if (step.kind === "set") step.operation = e.currentTarget.value as "assign" | "add"; }}>
                <option value="assign">Set value</option><option value="add">Add to previous (starts at 0)</option>
              </select></label>
            {/if}
            {#if typeof step.value === "boolean"}
              <label>Value <select value={String(step.value)} onchange={(e) => changeSetValue(i, e.currentTarget.value)}>
                <option value="true">True</option><option value="false">False</option>
              </select></label>
            {:else}
              <label>Value <input type={typeof step.value === "number" ? "number" : "text"} value={String(step.value)} onchange={(e) => changeSetValue(i, e.currentTarget.value)} /></label>
            {/if}
            <small>Private, persisted graph variables survive history reset and undo with this graph. Targeting an ID, current tiles or Tagger tiles writes each graph's separate variable map (at most 32 tiles / 128 graph states) within one atomic plan; later Trigger Tile calls read staged values. Filters and {"{{name}}"} on the current graph read its own values. No expression evaluation or cross-scene targets; numeric additions are bounded to ±1,000,000,000.</small>
          {:else if step.kind === "gameTime"}
            <label>World clock change (minutes) <input aria-label="Game Time minutes" type="number"
              step="1" min="-525600" max="525600" bind:value={step.minutes} /></label>
            <small>Game Time advances or rewinds the host-owned, replicated world clock by whole minutes (±1 year per step). Later Check Value steps, including child tiles, read the new time. It is one undoable graph transaction; failed actions leave the clock unchanged. A published player trigger uses only this GM-authored amount. The clock stays within 0–3153600000 seconds. Expressions and automatic time-trigger scheduling are not supported yet.</small>
          {:else if step.kind === "hurtHeal"}
            <label>HP change (negative hurts, positive heals) <input aria-label="Hurt / Heal HP change"
              type="number" step="1" min="-100000" max="100000" bind:value={step.amount} /></label>
            <label>Token targets <select aria-label="Hurt / Heal targets" bind:value={step.targets}>
              <option value="triggering">Triggering token</option>
              <option value="current">Current token collection (Inside / Tagger selection)</option>
            </select></label>
            <small>Uses PF1e hit points, temporary HP and nonlethal healing. Every token needs a linked actor with authored HP; 1–32 tokens, one application per actor. No damage type, dice expression or inline script. Changes share the graph's GM Revert receipt and refuse later conflicting edits.</small>
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
            <label>Point X <input aria-label="Move X" type="number" step="1" bind:value={step.x} /></label>
            <label>Point Y <input aria-label="Move Y" type="number" step="1" bind:value={step.y} /></label>
            <label>Token targets <select aria-label="Move targets" bind:value={step.targets}>
              <option value="current">Current token collection (Inside / Tagger selection)</option>
              <option value="triggering">Triggering token</option>
            </select></label>
            <small>Host-authorized reposition inside this scene (pixel coordinates within the scene rectangle). The committed move goes through the normal movement-trigger dispatch, so a destination that crosses a tile can fire that tile; add Stop Additional Tiles Triggering to suppress it. One update op per moved token; unchanged positions commit nothing.</small>
          {:else if step.kind === "rotate"}
            <label>Rotation (degrees) <input aria-label="Rotation angle" type="number" step="1" bind:value={step.angle} /></label>
            <label>Token targets <select aria-label="Rotation targets" bind:value={step.targets}>
              <option value="current">Current token collection (Inside / Tagger selection)</option>
              <option value="triggering">Triggering token</option>
            </select></label>
            <small>Absolute rotation, normalized to 0–360. A committed rotation of a token inside a tile can fire that tile's rotate method.</small>
          {:else if step.kind === "delete"}
            <small>Deletes the current collection's tokens, tiles, walls, drawings or map pins — one delete op each, atomic with the rest of the graph (undo restores them). Deleting a token never touches its linked actor; the collection is empty afterwards. Lights, sounds, templates and other documents are refused.</small>
          {:else if step.kind === "rollTable"}
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
            <small>Runs after the graph commits. Host actions make their own commits; failures appear only in GM trace.</small>
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
            <small>GM-approved preset ID; players cannot choose the actor or override its data. A player-triggered graph requires an owned caster token. The summon is a separate host commit after the graph, bounded by the preset's range/LOS and still private when its source is private. Failed source lookup produces a GM-only trace, not a rolled-back graph.</small>
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
      <label>Simulate method <select bind:value={triggerMethod}>{#each definition.methods as method (method)}<option value={method}>{method}</option>{/each}</select></label>
      {#if editing}<button type="button" data-zone-dry-run onclick={() => invoke(editing, true)}>Dry-run saved</button>
        <button type="button" data-zone-run onclick={() => invoke(editing)}>Fire saved manually</button>{/if}
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
          <button type="button" onclick={() => { sceneId = checked.definition.sceneId; invoke(doc._id, true, checked.definition.methods[0] ?? "manual"); }}>Dry-run</button>
          <button type="button" onclick={() => { sceneId = checked.definition.sceneId; invoke(doc._id, false, checked.definition.methods[0] ?? "manual"); }}>Fire</button>
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
