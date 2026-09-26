import { describe, expect, test } from "vitest";
import { planAutomation, sweptTileEvents, tileContainsPoint, validateAutomation, validateAutomationState, type AutomationDefinition } from "../../src/core/automation";
import type { ActorDocument, AutomationDocument, EffectDocument, ItemDocument, MessageDocument, SceneDocument, TileDocument, TokenDocument, WallDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";
import { worldSettingsDoc } from "../../src/core/worldSettings";

const tile: TileDocument = { _id: "zone", type: "tile", name: "Zone", ownership: { default: 0 }, flags: {}, system: {},
  x: 100, y: 100, width: 200, height: 200, img: "", above: false, occlusion: { mode: "roof", alpha: 0.5 } };
function token(id: string, x: number, y: number, tags: string[] = []): TokenDocument {
  return { _id: id, type: "token", name: id, ownership: { default: 2 }, flags: {}, system: {}, taggerTags: tags,
    x, y, width: 20, height: 20, rotation: 0, img: "", hidden: false, vision: true,
    light: { radius: 0, alpha: 0, color: "#fff" }, disposition: "friendly" };
}
const scene: SceneDocument = { _id: "s1", type: "scene", name: "Scene", ownership: { default: 2 }, flags: {}, system: {},
  active: true, width: 500, height: 500, img: null, darkness: 0,
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  tokens: [token("runner", 150, 150), token("gate", 180, 160, ["door-1"])], tiles: [tile],
  walls: [], lights: [], sounds: [], drawings: [], templates: [], notes: [] };
function automation(definition: AutomationDefinition): AutomationDocument {
  return { _id: "a1", type: "automation", name: "Trap", ownership: { default: 0 }, flags: {}, system: {}, definition };
}
const base: AutomationDefinition = { version: 1, sceneId: "s1", tileId: "zone", methods: ["enter", "click"],
  gates: { oncePerToken: true, cooldownMs: 500, chance: 1 }, steps: [
    { id: "sel", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
    { id: "gate", kind: "filter", test: { kind: "count", min: 1 } },
    { id: "edit", kind: "tags", edit: "add", tags: ["opened"] },
    { id: "fx", kind: "sequence", macroId: "pulse", audience: "scene" },
    { id: "notice", kind: "chat", audience: "gm", content: "Moved by {{user}}: {{count}}" },
  ] };
const actor = { id: "p1", role: "PLAYER" as const };
const world = emptyWorld();
world.scenes.push(scene);
const runner = scene.tokens[0], gate = scene.tokens[1];
if (!runner || !gate) throw new Error("automation fixture needs two tokens");

function plan(def = base, at = 1000) {
  const token = scene.tokens[0];
  if (!token) throw new Error("automation fixture lost the runner");
  return planAutomation(world, automation(def), { scene, tile, token, method: "enter",
    caller: actor, at, rng: () => 0.25 }, "gm");
}

describe("host-side active-zone graph", () => {
  test("validates version, strict fields, tags, target references and named landings", () => {
    expect(validateAutomation(base).ok).toBe(true);
    expect(validateAutomation({ ...base, steps: [{ id: "oops", kind: "runCode", source: "eval(1)" }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "jump", kind: "jump", to: "nowhere" }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "x", kind: "tags", tags: ["bad\u0000"], edit: "add" }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, methods: ["enter", "enter"] }).ok).toBe(false);
    expect(validateAutomation({ ...base, gates: { playerRunnable: "yes" } }).ok).toBe(false);
  });

  test("Filter by Token Trigger Count uses each selected token's staged per-graph history, not a global count", () => {
    const s: SceneDocument = { ...scene, tokens: [...scene.tokens, token("new", 160, 170)] };
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "select", kind: "select", selector: { kind: "inside" } },
      { id: "unseen", kind: "tokenTriggerCount", compare: "eq", count: 0 },
      { id: "mark", kind: "tags", edit: "add", tags: ["first-time"] },
      { id: "count", kind: "filter", test: { kind: "count", min: 1 } },
      { id: "chat", kind: "chat", audience: "gm", content: "one unseen token" },
    ] };
    const doc: AutomationDocument = { ...automation(def), state: { count: 2, lastAt: 900,
      byToken: { gate: { count: 2, lastAt: 900 } } } };
    const w = emptyWorld(); w.scenes.push(s);
    const fire = (definition = def) => planAutomation(w, { ...doc, definition },
      { scene: s, tile, token: runner, method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    const first = fire();
    if (!first.ok || !("plan" in first)) throw new Error("count filter must plan");
    expect(first.plan.trace).toContain("token trigger count filter: 1 matching token(s), including this fire");
    expect(first.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens"))
      .toEqual([{ kind: "update", ref: { coll: "tokens", id: "new", parent: { coll: "scenes", id: "s1" } },
        diff: { taggerTags: ["first-time"] } }]);
    expect(first.plan.ops.some((op) => op.kind === "create" && op.coll === "messages")).toBe(true);
    expect(first.plan.state.byToken.runner?.count).toBe(1);
    expect(first.plan.state.byToken.gate?.count).toBe(2);
    expect(doc.state?.byToken.runner).toBeUndefined(); // dry plan cannot mutate committed state
    const current = fire({ ...def, steps: def.steps.map((step) => step.kind === "tokenTriggerCount"
      ? { ...step, count: 1 } : step) });
    expect(current.ok && "plan" in current ? current.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens") : [])
      .toMatchObject([{ ref: { id: "runner" } }]);
    const afterReset = fire({ ...def, steps: [
      { id: "reset", kind: "resetHistory" }, ...def.steps,
    ] });
    expect(afterReset.ok && "plan" in afterReset ? afterReset.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens") : [])
      .toHaveLength(3); // all three counts were reset to zero before filtering
    const wrongTarget = fire({ ...def, steps: [
      { id: "select", kind: "select", selector: { kind: "tile" } },
      { id: "unseen", kind: "tokenTriggerCount", compare: "eq", count: 0 },
    ] });
    expect(wrongTarget).toMatchObject({ ok: false, error: expect.stringMatching(/token targets/) });
    for (const invalid of [
      { compare: "gte", count: -1 }, { compare: "gte", count: 1.5 },
      { compare: "gte", count: 1_000_001 }, { compare: "gte", count: Number.NaN },
      { compare: "unknown", count: 1 }, { compare: "eq", count: 1, code: "eval()" },
    ]) expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "tokenTriggerCount", ...invalid }] }).ok).toBe(false);
  });

  test("MATT-style random-number variable is host-rolled, typed and filterable", () => {
    const def: AutomationDefinition = { ...base, steps: [
      { id: "die", kind: "random", name: "roll", min: 1, max: 6 },
      { id: "if", kind: "filter", test: { kind: "variable", name: "roll", equals: 2 }, otherwise: "miss" },
      { id: "hit", kind: "chat", audience: "gm", content: "Rolled {{roll}}" },
      { id: "done", kind: "stop" },
      { id: "miss", kind: "landing", name: "miss" },
      { id: "fallback", kind: "chat", audience: "gm", content: "Other: {{roll}}" },
    ] };
    const rolled = plan(def);
    expect(rolled.ok && "plan" in rolled ? rolled.plan.ops[1] : null)
      .toMatchObject({ kind: "create", data: { content: "Rolled 2" } });
    const high = planAutomation(world, automation(def), {
      scene, tile, method: "enter", token: runner, caller: actor, at: 1000, rng: () => 0.99,
    }, "gm");
    expect(high.ok && "plan" in high ? high.plan.ops[1] : null)
      .toMatchObject({ kind: "create", data: { content: "Other: 6" } });
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "random", name: "roll",
      min: 0, max: 1_000_001 }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "random", name: "roll",
      min: -1, max: Number.NaN }] }).ok).toBe(false);
    const broken = planAutomation(world, automation(def), {
      scene, tile, method: "enter", token: runner, caller: actor, at: 1000, rng: () => Number.NaN,
    }, "gm");
    expect(broken.ok).toBe(false);
  });

  test("script steps bind typed live context without executing code in the pure graph planner", () => {
    const def: AutomationDefinition = { ...base, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "run", kind: "script", macroId: "reviewed-code", args: { message: "hello" },
        bindings: { target: "currentToken", source: "triggerToken", ordinal: "count", method: "method" } },
      { id: "end", kind: "stop" },
    ] };
    const result = plan(def);
    expect(result.ok && "plan" in result ? result.plan.scripts : []).toEqual([{ stepId: "run",
      macroId: "reviewed-code", args: { message: "hello", target: "gate", source: "runner",
        ordinal: 1, method: "enter" } }]);
    expect(result.ok && "plan" in result ? result.plan.ops : []).toHaveLength(1); // history only
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "script", macroId: "reviewed-code",
      args: { target: "a" }, bindings: { target: "triggerToken" } }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "script", macroId: "reviewed-code",
      bindings: { target: "__proto__.id" } }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "script", macroId: "reviewed-code",
      args: { count: Number.POSITIVE_INFINITY } }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "script", macroId: "reviewed-code",
      source: "return 123" }] }).ok).toBe(false); // inline code cannot smuggle a grant
  });

  test("a tile graph queues exact summon presets alongside scripts in graph order, never a cosmetic token", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "start", kind: "script", macroId: "approved", args: { note: "before" } },
      { id: "summon", kind: "summon", presetId: "wolf", anchor: "tile" },
      { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "other", kind: "summon", presetId: "wolf", anchor: "current" },
      { id: "end", kind: "script", macroId: "approved", args: { note: "after" } },
    ] };
    const result = plan(def);
    expect(result.ok && "plan" in result ? result.plan.postActions : []).toEqual([
      { kind: "script", stepId: "start", macroId: "approved", args: { note: "before" } },
      { kind: "summon", stepId: "summon", presetId: "wolf", at: { x: 200, y: 200 }, summonerTokenId: "runner" },
      { kind: "summon", stepId: "other", presetId: "wolf", at: { x: 180, y: 160 }, summonerTokenId: "runner" },
      { kind: "script", stepId: "end", macroId: "approved", args: { note: "after" } },
    ]);
    expect(result.ok && "plan" in result ? result.plan.ops : []).toHaveLength(1); // history; actor isn't faked
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "summon", presetId: "../wolf", anchor: "tile" }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "summon", presetId: "wolf",
      anchor: "tile", sourceActorId: "hidden" }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: Array.from({ length: 17 }, (_, i) =>
      ({ id: `summon${i}`, kind: "summon", presetId: "wolf", anchor: "tile" })) }).ok).toBe(false);
    const missing = plan({ ...def, steps: [{ id: "bad", kind: "summon", presetId: "wolf", anchor: "trigger" }] });
    expect(missing.ok && "plan" in missing ? missing.plan.postActions[0] : null)
      .toMatchObject({ at: { x: 150, y: 150 }, summonerTokenId: "runner" });
    const withoutCaster = planAutomation(world, automation(def), { scene, tile, method: "enter",
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(withoutCaster.ok).toBe(false);
  });

  test("Run All Batch Actions combines edits per target, executes ordered batches, and advances baselines", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "mark", kind: "tags", edit: "add", tags: ["temporary"] },
      { id: "hide", kind: "visibility", mode: "hide" },
      { id: "flush1", kind: "batchFlush" },
      { id: "msg", kind: "chat", audience: "gm", content: "between batches" },
      { id: "unmark", kind: "tags", edit: "remove", tags: ["temporary"] },
      { id: "show", kind: "visibility", mode: "show" },
      { id: "flush2", kind: "batchFlush" },
    ] };
    expect(validateAutomation(def).ok).toBe(true);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "batchFlush", inert: true }] }).ok).toBe(false);
    const result = plan(def);
    if (!result.ok || !("plan" in result)) throw new Error("batch graph did not plan");
    expect(result.plan.ops).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "a1" } },
      { kind: "update", ref: { coll: "tokens", id: "gate" },
        diff: { taggerTags: ["door-1", "temporary"], hidden: true } },
      { kind: "create", coll: "messages", data: { content: "between batches" } },
      { kind: "update", ref: { coll: "tokens", id: "gate" },
        diff: { taggerTags: ["door-1"], hidden: false } },
    ]);
    expect(result.plan.trace).toContain("batch executed: 1 target(s), 1 combined world update(s)");
    expect(gate.taggerTags).toEqual(["door-1"]); // the plan never mutates the source world
    expect(gate.hidden).toBe(false);
    const coalesced = plan({ ...def, steps: def.steps.slice(0, 3).concat(def.steps.slice(5, 7)) });
    expect(coalesced.ok && "plan" in coalesced ? coalesced.plan.ops : []).toHaveLength(1);
  });

  test("a child graph can execute a parent's pending batch and its own edits without an early commit", () => {
    const local = structuredClone(scene);
    local.tiles.push({ ...structuredClone(tile), _id: "child" });
    const root = automation({ ...base, gates: {}, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "parent", kind: "tags", edit: "add", tags: ["parent"] },
      { id: "relay", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
      { id: "done", kind: "tags", edit: "remove", tags: ["parent"] },
    ] });
    const child = { ...automation({ ...base, tileId: "child", methods: ["manual"], gates: {}, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "childTag", kind: "tags", edit: "add", tags: ["child"] },
      { id: "flush", kind: "batchFlush" },
    ] }), _id: "a-child" };
    const current = emptyWorld(); current.scenes.push(local); current.automations.push(root, child);
    const originTile = local.tiles[0], originToken = local.tokens[0];
    if (!originTile || !originToken) throw new Error("batch fixture has no origin");
    const planned = planAutomation(current, root, { scene: local, tile: originTile, token: originToken,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    if (!planned.ok || !("plan" in planned)) throw new Error("child batch did not plan");
    expect(planned.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens"))
      .toMatchObject([
        { diff: { taggerTags: ["door-1", "parent", "child"] } },
        { diff: { taggerTags: ["door-1", "child"] } },
      ]);
    expect(local.tokens[1]?.taggerTags).toEqual(["door-1"]);
  });

  test("current collection follows live Tagger selector, GM notification is escaped and ops are planned together", () => {
    const res = plan();
    expect(res.ok).toBe(true);
    if (!res.ok || !('plan' in res)) return;
    expect(res.plan.ops).toHaveLength(3); // one state, one chat, one tag update
    expect(res.plan.ops[0]).toMatchObject({ kind: "update", ref: { coll: "automations", id: "a1" }, diff: { state: { count: 1, byToken: { runner: { count: 1 } } } } });
    expect(res.plan.ops[1]).toMatchObject({ kind: "create", coll: "messages", data: { whisper: ["gm"], content: "Moved by p1: 1" } });
    expect(res.plan.ops[2]).toMatchObject({ kind: "update", ref: { coll: "tokens", id: "gate" }, diff: { taggerTags: ["door-1", "opened"] } });
    expect(res.plan.cues).toEqual([{ macroId: "pulse", audience: "scene", sourceTokenId: "runner", targetTokenId: "gate" }]);
    expect(gate.taggerTags).toEqual(["door-1"]); // planning never mutates world
    gate.taggerTags = ["old"];
    const changed = plan();
    expect(changed.ok && 'plan' in changed ? changed.plan.ops : []).toHaveLength(1); // filter stops, history only
    gate.taggerTags = ["door-1"];
    const escaped = planAutomation(world, automation({ ...base, steps: [
      { id: "set", kind: "set", name: "evil", value: "<script>" },
      { id: "chat", kind: "chat", audience: "scene", content: "{{evil}}" },
    ] }), { scene, tile, method: "enter", token: runner, caller: actor, at: 1000, rng: () => 0 }, "gm");
    expect(escaped.ok && 'plan' in escaped ? escaped.plan.ops[1] : null).toMatchObject({ kind: "create", data: { content: "&lt;script&gt;" } });
  });

  test("graph Tagger selectors use live multi-term wildcard/case/collection rules; unsafe regex fails publication", () => {
    const local: SceneDocument = { ...scene, tokens: [...scene.tokens,
      token("sentinel", 120, 150, ["GUARDIAN-2"])] };
    const current = emptyWorld();
    current.scenes.push(local);
    const steps: AutomationDefinition["steps"] = [
      { id: "find", kind: "select", selector: { kind: "tag", query: ["DOOR-*", "guardian*"],
        mode: "any", pattern: "wildcard", caseSensitive: false, collections: ["tokens"] } },
      { id: "mark", kind: "tags", edit: "add", tags: ["highlighted"] },
    ];
    const definition: AutomationDefinition = { ...base, steps };
    expect(validateAutomation(definition).ok).toBe(true);
    const result = planAutomation(current, automation(definition), {
      scene: local, tile, method: "enter", token: runner, caller: actor, at: 1000, rng: () => 0,
    }, "gm");
    expect(result.ok && "plan" in result ? result.plan.ops.flatMap((op) =>
      op.kind === "update" && op.ref.coll === "tokens" ? [op.ref.id] : [])
      : []).toEqual(["gate", "sentinel"]);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "select",
      selector: { kind: "tag", query: "(a+)+", pattern: "regex" } }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "select",
      selector: { kind: "tag", query: ["x", 1] } }] }).ok).toBe(false);
  });

  test("graph Tagger selectors honor parent-qualified include/exclude refs without cross-scene targeting", () => {
    const parent = { coll: "scenes" as const, id: "s1" };
    const gateRef = { coll: "tokens" as const, id: "gate", parent };
    const steps: AutomationDefinition["steps"] = [
      { id: "find", kind: "select", selector: { kind: "tag", query: "door-1",
        collections: ["tokens"], includeRefs: [gateRef], excludeRefs: [{ ...gateRef, id: "runner" }] } },
      { id: "mark", kind: "tags", edit: "add", tags: ["chosen"] },
    ];
    const found = plan({ ...base, steps });
    expect(found.ok && "plan" in found ? found.plan.ops.at(-1) : null).toMatchObject({
      kind: "update", ref: gateRef, diff: { taggerTags: ["door-1", "chosen"] },
    });
    const exclude = plan({ ...base, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "door-1",
        collections: ["tokens"], includeRefs: [gateRef], excludeRefs: [gateRef] } },
      { id: "mark", kind: "tags", edit: "add", tags: ["chosen"] },
    ] });
    expect(exclude.ok && "plan" in exclude ? exclude.plan.ops.length : -1).toBe(1);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "select",
      selector: { kind: "tag", query: "door-1", includeRefs: [{ ...gateRef,
        parent: { coll: "scenes", id: "other" } }] } }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "select",
      selector: { kind: "tag", query: "door-1", excludeRefs: [gateRef, gateRef] } }] }).ok).toBe(false);
  });

  test("show/hide/toggle plans typed token and pin ops atomically, repeated toggles cancel", () => {
    const hidden = plan({ ...base, steps: [
      { id: "select", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "hide", kind: "visibility", mode: "hide" },
    ] });
    expect(hidden.ok && "plan" in hidden ? hidden.plan.ops.at(-1) : null).toMatchObject({
      kind: "update", ref: { coll: "tokens", id: "gate" }, diff: { hidden: true },
    });
    const toggled = plan({ ...base, steps: [
      { id: "select", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "first", kind: "visibility", mode: "toggle" },
      { id: "second", kind: "visibility", mode: "toggle" },
    ] });
    expect(toggled.ok && "plan" in toggled ? toggled.plan.ops.length : -1).toBe(1); // history only
    const local: SceneDocument = { ...scene, notes: [{ _id: "pin", type: "note", name: "Hint",
      x: 100, y: 120, text: "GM text", icon: "", taggerTags: ["door-1"],
      ownership: { default: 1 }, flags: {}, system: {}, visible: true }] };
    const pins = emptyWorld(); pins.scenes.push(local);
    const pinned = planAutomation(pins, automation({ ...base, steps: [
      { id: "select", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["notes"] } },
      { id: "hide", kind: "visibility", mode: "hide" },
    ] }), { scene: local, tile, method: "enter", caller: actor, at: 1000, rng: () => 0 }, "gm");
    expect(pinned.ok && "plan" in pinned ? pinned.plan.ops.at(-1) : null).toMatchObject({
      kind: "update", ref: { coll: "notes", id: "pin" }, diff: { visible: false, ownership: { default: 0 } },
    });
    const tileHidden = plan({ ...base, steps: [
      { id: "select", kind: "select", selector: { kind: "tile" } },
      { id: "hide", kind: "visibility", mode: "hide" },
    ] });
    expect(tileHidden.ok && "plan" in tileHidden ? tileHidden.plan.ops.at(-1) : null).toMatchObject({
      kind: "update", ref: { coll: "tiles", id: "zone" }, diff: { hidden: true },
    });
    const taggedScene: SceneDocument = { ...scene, taggerTags: ["zone"] };
    const scenes = emptyWorld(); scenes.scenes.push(taggedScene);
    const invalid = planAutomation(scenes, automation({ ...base, steps: [
      { id: "select", kind: "select", selector: { kind: "tag", query: "zone", collections: ["scenes"] } },
      { id: "hide", kind: "visibility", mode: "hide" },
    ] }), { scene: taggedScene, tile, method: "enter", caller: actor, at: 1000, rng: () => 0 }, "gm");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatch(/visibility needs/);
  });

  test("tagged doors open/close/lock by explicit state, never turn a plain wall into a door", () => {
    const door: WallDocument = { _id: "d1", type: "wall", name: "Gate",
      ownership: { default: 0 }, flags: {}, system: {}, taggerTags: ["door-1"],
      c: [0, 0, 100, 0], move: 1, sight: 1, sound: 1, light: 1, oneWay: false, door: 0 };
    const plain = { ...door, _id: "wall", taggerTags: ["plain"],
      move: 0 as const, sight: 0 as const, sound: 0 as const, light: 0 as const };
    const local: SceneDocument = { ...scene, walls: [door, plain] };
    const walls = emptyWorld(); walls.scenes.push(local);
    const selectDoor = { id: "find", kind: "select" as const,
      selector: { kind: "tag" as const, query: "door-1", collections: ["walls" as const] } };
    const run = (steps: AutomationDefinition["steps"]) => planAutomation(walls,
      automation({ ...base, steps: [selectDoor, ...steps] }),
      { scene: local, tile, method: "click", caller: actor, at: 1000, rng: () => 0 }, "gm");
    const opened = run([{ id: "open", kind: "door", mode: "open" }]);
    expect(opened.ok && "plan" in opened ? opened.plan.ops.at(-1) : null).toMatchObject({
      kind: "update", ref: { coll: "walls", id: "d1" }, diff: { door: 1 },
    });
    const twice = run([{ id: "toggle1", kind: "door", mode: "toggle" },
      { id: "toggle2", kind: "door", mode: "toggle" }]);
    expect(twice.ok && "plan" in twice ? twice.plan.ops.length : -1).toBe(1); // history only
    const locked = run([{ id: "lock", kind: "door", mode: "lock" },
      { id: "toggle", kind: "door", mode: "toggle" }]);
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toMatch(/explicitly unlock/);
    const unlocked = run([{ id: "lock", kind: "door", mode: "lock" },
      { id: "unlock", kind: "door", mode: "unlock" },
      { id: "open", kind: "door", mode: "open" }]);
    expect(unlocked.ok && "plan" in unlocked ? unlocked.plan.ops.at(-1) : null).toMatchObject({
      kind: "update", diff: { door: 1 },
    });
    door.taggerTags = ["nope"];
    const invalid = planAutomation(walls, automation({ ...base, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "plain", collections: ["walls"] } },
      { id: "open", kind: "door", mode: "open" },
    ] }), { scene: local, tile, method: "click", caller: actor, at: 1000, rng: () => 0 }, "gm");
    expect(invalid.ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "door", kind: "door", mode: "explode" }] }).ok).toBe(false);
  });

  test("gates survive reload via persisted state; chance failure and budget produce no ops", () => {
    const doc = automation(base);
    doc.state = { count: 1, lastAt: 1000, byToken: { runner: { count: 1, lastAt: 1000 } } };
    const once = planAutomation(world, doc, { scene, tile, method: "enter", token: runner, caller: actor, at: 2000, rng: () => 0 }, "gm");
    expect(once.ok && 'skipped' in once ? once.skipped : '').toMatch(/already fired/);
    const chance = planAutomation(world, automation({ ...base, gates: { chance: 0 } }),
      { scene, tile, method: "enter", token: runner, caller: actor, at: 2000, rng: () => 0.5 }, "gm");
    expect(chance.ok && 'skipped' in chance ? chance.skipped : '').toMatch(/chance/);
    const sixHundred: AutomationDefinition = { ...base, steps: [
      ...Array.from({ length: 600 }, (_, i) => ({ id: `s${i}`, kind: "set" as const, name: "n", value: i })),
      { id: "stop", kind: "stop" },
    ] };
    expect(validateAutomation(sixHundred).ok).toBe(true);
    const long = plan(sixHundred);
    expect(long.ok && 'plan' in long ? long.plan.trace.length : 0).toBe(601);
    const loop: AutomationDefinition = { ...base, steps: [
      { id: "label", kind: "landing", name: "again" }, { id: "jump", kind: "jump", to: "again" },
    ] };
    const cyclic = plan(loop);
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) expect(cyclic.error).toMatch(/cycle\/resource budget/);
  });

  test("GM-only recent fires have a bounded persistent audit and strict legacy-compatible validation", () => {
    const def = { ...base, gates: {}, steps: [{ id: "end", kind: "stop" } as const] };
    const doc = automation(def);
    for (let i = 0; i < 110; i++) {
      const fired = planAutomation(world, doc, { scene, tile, method: "click", caller: actor,
        at: 2000 + i, rng: () => 0 }, "gm");
      expect(fired.ok && "plan" in fired).toBe(true);
      if (fired.ok && "plan" in fired) doc.state = fired.plan.state;
    }
    expect(doc.state?.count).toBe(110);
    expect(doc.state?.recent).toHaveLength(100);
    expect(doc.state?.recent?.[0]).toEqual({ at: 2010, method: "click", userId: "p1" });
    expect(doc.state?.recent?.at(-1)).toEqual({ at: 2109, method: "click", userId: "p1" });
    expect(validateAutomationState(doc.state)).toBe(true);
    expect(validateAutomationState({ count: 1, lastAt: 2000,
      byToken: { runner: { count: 1, lastAt: 2000 } } })).toBe(true); // imported legacy state
    expect(validateAutomationState({ ...doc.state, recent: Array(101).fill(doc.state?.recent?.[0]) })).toBe(false);
    expect(validateAutomationState({ ...doc.state, recent: [{ at: 2000, method: "arbitrary", userId: "p1" }] })).toBe(false);
  });

  test("canvas clicks and host verification share rotated rectangle geometry", () => {
    const strip = { ...tile, x: 100, y: 100, width: 200, height: 40, rotation: 90 };
    expect(tileContainsPoint(strip, { x: 200, y: 205 })).toBe(true);
    expect(tileContainsPoint(strip, { x: 285, y: 120 })).toBe(false);
    expect(tileContainsPoint({ ...strip, rotation: 0 }, { x: 285, y: 120 })).toBe(true);
    expect(tileContainsPoint(strip, { x: Number.NaN, y: 150 })).toBe(false);
  });

  test("swept paths use token centers, not top-left offsets, at narrow zone boundaries", () => {
    const narrow = { ...tile, x: 200, y: 100, width: 100, height: 100, rotation: 0 };
    expect(sweptTileEvents(narrow, undefined, token("outside", 180, 150))).toEqual([]);
    expect(sweptTileEvents(narrow, undefined, token("inside", 220, 150)))
      .toEqual([{ method: "create", fraction: 1 }]);
    expect(sweptTileEvents(narrow, token("moving", 180, 150), token("moving", 220, 150))
      .map((event) => event.method)).toEqual(["enter", "stop"]);
  });

  test("swept paths produce enter, exit, stop, rotation and fast pass-through in order", () => {
    const a = token("a", 40, 190);
    const b = token("a", 140, 190);
    const c = token("a", 320, 190);
    expect(sweptTileEvents(tile, a, b).map((e) => e.method)).toEqual(["enter", "stop"]);
    expect(sweptTileEvents(tile, b, c).map((e) => e.method)).toEqual(["exit"]);
    expect(sweptTileEvents(tile, a, c).map((e) => e.method)).toEqual(["enter", "exit"]);
    expect(sweptTileEvents(tile, undefined, b).map((e) => e.method)).toEqual(["create"]);
    expect(sweptTileEvents(tile, b, { ...b, rotation: 45 }).map((e) => e.method)).toEqual(["rotate"]);
    const vertical = { ...tile, x: 80, y: 0, width: 40, height: 200, rotation: 0 };
    const horizontal = { ...vertical, rotation: 90 };
    const left = token("a", -10, 20), right = token("a", 190, 20);
    expect(sweptTileEvents(vertical, left, right).map((e) => e.method)).toEqual(["enter", "exit"]);
    expect(sweptTileEvents(horizontal, left, right)).toEqual([]); // rotated rectangle is elsewhere
  });
  test("Shuffle Collection is host-rolled, deterministic in a preview and keeps original target IDs", () => {
    const def: AutomationDefinition = { ...base, steps: [
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "shuffle", kind: "shuffle" },
      { id: "first", kind: "position", index: 1 },
      { id: "mark", kind: "tags", edit: "add", tags: ["shuffled"] },
    ] };
    const result = plan(def);
    expect(result.ok && "plan" in result ? result.plan.ops : []).toEqual([
      expect.objectContaining({ kind: "update", ref: { coll: "automations", id: "a1" } }),
      expect.objectContaining({ kind: "update", ref: { coll: "tokens", id: "gate", parent: { coll: "scenes", id: "s1" } },
        diff: { taggerTags: ["door-1", "shuffled"] } }),
    ]);
    const invalid = planAutomation(world, automation(def), { scene, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => Number.NaN }, "gm");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatch(/RNG/);
    expect(validateAutomation({ ...def, steps: [{ id: "shuffle", kind: "shuffle", seed: "caller" }] }).ok).toBe(false);
  });

  test("Position in List uses a 1-based index and an out-of-range position selects nobody", () => {
    const steps: AutomationDefinition["steps"] = [
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "second", kind: "position", index: 2 },
      { id: "mark", kind: "tags", edit: "replace", tags: ["only-second"] },
    ];
    const second = plan({ ...base, steps });
    expect(second.ok && "plan" in second ? second.plan.ops[1] : null)
      .toMatchObject({ ref: { coll: "tokens", id: "gate" }, diff: { taggerTags: ["only-second"] } });
    const empty = plan({ ...base, steps: steps.map((s) => s.kind === "position" ? { ...s, index: 3 } : s) });
    expect(empty.ok && "plan" in empty ? empty.plan.ops : []).toHaveLength(1);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "position", index: 0 }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "position", index: 1.5 }] }).ok).toBe(false);
  });

  test("Filter Tokens by Distance measures centers in scene units from tile or trigger", () => {
    const steps: AutomationDefinition["steps"] = [
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "near", kind: "distance", from: "tile", min: 3, max: 4 },
      { id: "mark", kind: "tags", edit: "add", tags: ["near"] },
    ];
    const tileRange = plan({ ...base, steps });
    expect(tileRange.ok && "plan" in tileRange ? tileRange.plan.ops[1] : null)
      .toMatchObject({ ref: { coll: "tokens", id: "runner" }, diff: { taggerTags: ["near"] } });
    const triggerRange = plan({ ...base, steps: steps.map((s) => s.kind === "distance"
      ? { ...s, from: "trigger" as const, min: 1.5, max: 2 } : s) });
    expect(triggerRange.ok && "plan" in triggerRange ? triggerRange.plan.ops[1] : null)
      .toMatchObject({ ref: { coll: "tokens", id: "gate" } });
    const nonToken = plan({ ...base, steps: [
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "near", kind: "distance", from: "tile", max: 20 },
    ] });
    expect(nonToken.ok).toBe(false);
    if (!nonToken.ok) expect(nonToken.error).toMatch(/token targets/);
    const noTrigger = planAutomation(world, automation({ ...base, steps: [
      { id: "near", kind: "distance", from: "trigger", max: 5 },
    ] }), { scene, tile, method: "click", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(noTrigger.ok).toBe(false);
    if (!noTrigger.ok) expect(noTrigger.error).toMatch(/triggering token/);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "distance", from: "tile", min: 9, max: 8 }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "distance", from: "tile", max: Number.NaN }] }).ok).toBe(false);
  });

  test("Filter by Attributes reads linked actor system/flags, preserves selection order and branches via Check Entity Count", () => {
    const localWorld = structuredClone(world), local = localWorld.scenes[0];
    const first = local?.tokens[0], second = local?.tokens[1], localTile = local?.tiles[0];
    if (!local || !first || !second || !localTile) throw new Error("missing local scene targets");
    local.tokens[0] = { ...first, actorId: "a-runner", flags: { core: { modes: ["alert", "ready"] } } };
    local.tokens[1] = { ...second, actorId: "a-gate", flags: { core: { modes: ["sleep"] } } };
    const linked = (id: string, hp: number): ActorDocument => ({ _id: id, type: "actor", name: id,
      ownership: { default: 0 }, flags: { pf1e: { roles: ["defender", "scout"] } },
      system: { attributes: { hp: { value: hp } } }, items: [], effects: [] });
    localWorld.actors = [linked("a-runner", 3), linked("a-gate", 12)];
    const run = (steps: AutomationDefinition["steps"]) => planAutomation(localWorld,
      automation({ ...base, gates: {}, steps }),
      { scene: local, tile: localTile, token: first, method: "enter",
        caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    const hp = run([
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "hp", kind: "attributes", path: "actor.system.attributes.hp.value", compare: "lte", value: 5 },
      { id: "one", kind: "filter", test: { kind: "count", min: 1, max: 1 } },
      { id: "tag", kind: "tags", edit: "add", tags: ["wounded"] },
      { id: "notice", kind: "chat", audience: "gm", content: "One wounded" },
    ]);
    if (!hp.ok || !("plan" in hp)) throw new Error("actor attribute filter did not plan");
    expect(hp.plan.trace).toContain("attribute filter: 1 matching placeable(s)");
    expect(hp.plan.ops).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "a1" } },
      { kind: "create", coll: "messages", data: { content: "One wounded" } },
      { kind: "update", ref: { coll: "tokens", id: "runner" }, diff: { taggerTags: ["wounded"] } },
    ]);
    expect(local.tokens[0]?.taggerTags).toEqual([]); // planning cannot change source world
    expect(localWorld.actors[0]?.system.attributes).toEqual({ hp: { value: 3 } });

    const membership = run([
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "array", kind: "attributes", path: "flags.core.modes", compare: "has", value: "alert" },
      { id: "member", kind: "attributes", path: "actor.flags.pf1e.roles", compare: "has", value: "scout" },
      { id: "mark", kind: "tags", edit: "replace", tags: ["eligible"] },
    ]);
    expect(membership.ok && "plan" in membership ? membership.plan.ops[1] : null).toMatchObject({
      ref: { coll: "tokens", id: "runner" }, diff: { taggerTags: ["eligible"] },
    });
    const missing = run([
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "no-actor", kind: "attributes", path: "actor.system.unset", compare: "ne", value: "none" },
      { id: "mark", kind: "tags", edit: "add", tags: ["never"] },
    ]);
    expect(missing.ok && "plan" in missing ? missing.plan.ops : []).toHaveLength(1); // missing != value is NOT true
    const direct = run([
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "name", kind: "attributes", path: "name", compare: "eq", value: "gate" },
      { id: "mark", kind: "tags", edit: "add", tags: ["found"] },
    ]);
    expect(direct.ok && "plan" in direct ? direct.plan.ops[1] : null).toMatchObject({
      ref: { coll: "tokens", id: "gate" }, diff: { taggerTags: ["door-1", "found"] },
    });
  });

  test("attribute filter sees staged writes, rejects unsupported targets and discards over-budget reads", () => {
    const staged = plan({ ...base, gates: {}, steps: [
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "hide", kind: "visibility", mode: "hide" },
      { id: "hidden", kind: "attributes", path: "hidden", compare: "eq", value: true },
      { id: "mark", kind: "tags", edit: "add", tags: ["hidden-by-zone"] },
    ] });
    expect(staged.ok && "plan" in staged ? staged.plan.ops.slice(1) : []).toMatchObject([
      { ref: { coll: "tokens", id: "runner" }, diff: { hidden: true, taggerTags: ["hidden-by-zone"] } },
      { ref: { coll: "tokens", id: "gate" }, diff: { hidden: true, taggerTags: ["door-1", "hidden-by-zone"] } },
    ]);
    expect(scene.tokens.every((t) => !t.hidden)).toBe(true);
    const mixed = plan({ ...base, gates: {}, steps: [
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "sort", kind: "attributes", path: "name", compare: "eq", value: "Zone" },
      { id: "mark", kind: "tags", edit: "add", tags: ["found"] },
    ] });
    expect(mixed.ok && "plan" in mixed ? mixed.plan.ops[1] : null).toMatchObject({ ref: { coll: "tiles", id: "zone" } });
    const localWorld = structuredClone(world), local = localWorld.scenes[0];
    const first = local?.tokens[0], localTile = local?.tiles[0];
    if (!local || !first || !localTile) throw new Error("missing local scene targets");
    local.taggerTags = ["unsafe"];
    first.flags = { core: { modes: Array.from({ length: 4097 }, () => "x") } };
    const run = (steps: AutomationDefinition["steps"]) => planAutomation(localWorld,
      automation({ ...base, gates: {}, steps }), { scene: local, tile: localTile,
        token: first, method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    const tooBig = run([
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "mark", kind: "tags", edit: "add", tags: ["queued"] },
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "array", kind: "attributes", path: "flags.core.modes", compare: "has", value: "x" },
    ]);
    expect(tooBig).toMatchObject({ ok: false, error: expect.stringMatching(/read budget/) });
    expect(local.tiles[0]?.taggerTags).toBeUndefined();
    first.flags = { core: { modes: Array.from({ length: 4096 }, () => "x") } };
    const repeated = run([
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "mark", kind: "tags", edit: "add", tags: ["queued"] },
      { id: "trigger", kind: "select", selector: { kind: "triggering" } },
      ...Array.from({ length: 26 }, (_, i) => ({ id: `f${i}`, kind: "attributes" as const,
        path: "flags.core.modes", compare: "has" as const, value: "x" })),
    ]);
    expect(repeated).toMatchObject({ ok: false, error: expect.stringMatching(/100000 comparisons/) });
    expect(local.tiles[0]?.taggerTags).toBeUndefined();
    const unsupported = run([
      { id: "scene", kind: "select", selector: { kind: "tag", query: "unsafe", collections: ["scenes"] } },
      { id: "bad", kind: "attributes", path: "name", compare: "eq", value: "Scene" },
    ]);
    expect(unsupported).toMatchObject({ ok: false, error: expect.stringMatching(/needs tokens, tiles/) });
  });

  test("attribute data paths and comparators are strictly validated at publication", () => {
    const check = (path: unknown, compare: unknown = "eq", value: unknown = "x", extras = {}) =>
      validateAutomation({ ...base, steps: [{ id: "attr", kind: "attributes", path, compare, value, ...extras }] }).ok;
    for (const path of ["name", "door", "system.attributes.hp.value", "flags.core.modes",
      "actor.name", "actor.system.attributes.hp.value", "actor.flags.pf1e.roles"]) expect(check(path)).toBe(true);
    for (const path of ["", "name.x", "actor.ownership.default", "ownership.default", "flags", "actor.system", "0",
      "system.0", "actor.system.__proto__.polluted", "flags.core.constructor", "system.prototype", "name[0]",
      "actor..system", "system." + "tooLong".repeat(30), "system." + "n.".repeat(9) + "hp"]) expect(check(path)).toBe(false);
    expect(check("x", "gte", 0)).toBe(true);
    expect(check("system.tags", "has", "alert")).toBe(true);
    expect(check("system.hp", "gt", "1")).toBe(false);
    expect(check("system.hp", "has", ["alert"])).toBe(false);
    expect(check("system.hp", "eq", Number.POSITIVE_INFINITY)).toBe(false);
    expect(check("system.hp", "ne", "x".repeat(257))).toBe(false);
    expect(check("name", "eq", "x", { source: "return secret" })).toBe(false);
    expect(check("name", "includes", "x")).toBe(false);
  });

  test("condition filters active effect names, PF1e labels/native conditions, and never treat an unlinked token as lacking", () => {
    const localWorld = structuredClone(world), local = localWorld.scenes[0];
    const first = local?.tokens[0], second = local?.tokens[1], localTile = local?.tiles[0];
    if (!local || !first || !second || !localTile) throw new Error("missing local targets");
    first.actorId = "a-runner"; second.actorId = "a-gate";
    local.tokens.push(token("unlinked", 180, 180));
    const effect = (id: string, name: string, disabled = false, condition?: string): EffectDocument => ({
      _id: id, type: "effect", name, ownership: { default: 0 }, flags: condition ? { pf1e: { condition } } : {},
      system: {}, changes: [], disabled,
    });
    const linked = (id: string, effects: EffectDocument[], conditions: string[]): ActorDocument => ({
      _id: id, type: "actor", name: id, ownership: { default: 0 }, flags: {},
      system: { pf1e: { conditions } }, items: [], effects,
    });
    localWorld.actors = [
      linked("a-runner", [effect("aura", "Special aura", false, "  PRONE  "),
        effect("dispelled", "Sleep", true), effect("bless", "  Bless ")], [" Fatigued "]),
      linked("a-gate", [effect("disabled", "Prone", true)], []),
    ];
    const run = (steps: AutomationDefinition["steps"]) => planAutomation(localWorld,
      automation({ ...base, gates: {}, steps }), { scene: local, tile: localTile, token: first,
        method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    const matched = (effectName: string, mode: "has" | "lacks") => run([
      { id: "all", kind: "select", selector: { kind: "inside" } },
      { id: "cond", kind: "condition", effect: effectName, mode },
      { id: "any", kind: "filter", test: { kind: "count", min: 1 } },
      { id: "mark", kind: "tags", edit: "add", tags: ["selected"] },
    ]);
    const targets = (result: ReturnType<typeof run>) => result.ok && "plan" in result
      ? result.plan.ops.flatMap((op) => op.kind === "update" && op.ref.coll === "tokens" ? [op.ref.id] : []) : [];
    expect(targets(matched("prone", "has"))).toEqual(["runner"]); // active PF1e effect payload
    expect(targets(matched(" bLESS ", "has"))).toEqual(["runner"]); // active named effect
    expect(targets(matched("FATIGUED", "has"))).toEqual(["runner"]); // native condition array
    expect(targets(matched("Prone", "lacks"))).toEqual(["gate"]); // disabled is not active, unlinked is unknown
    expect(targets(matched("Sleep", "lacks"))).toEqual(["runner", "gate"]);
    expect(targets(matched("Sleep", "has"))).toEqual([]);
    expect(local.tokens.map((t) => t.taggerTags)).toEqual([[], ["door-1"], []]); // pure plan
    const tileTarget = run([
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "condition", kind: "condition", effect: "Prone", mode: "lacks" },
    ]);
    expect(tileTarget).toMatchObject({ ok: false, error: expect.stringMatching(/needs token targets/) });
    const runnerActor = localWorld.actors[0];
    if (!runnerActor) throw new Error("missing runner actor");
    runnerActor.effects = Array.from({ length: 4097 }, (_, index) => effect(`e-${index}`, "Test"));
    const tooMany = run([
      { id: "mark", kind: "tags", edit: "add", tags: ["staged"] },
      { id: "condition", kind: "condition", effect: "Prone", mode: "lacks" },
    ]);
    expect(tooMany).toMatchObject({ ok: false, error: expect.stringMatching(/4096-record/) });
    expect(local.tokens[0]?.taggerTags).toEqual([]); // failed plan discarded staged write
    runnerActor.effects = [];
    runnerActor.system.pf1e = { conditions: "Prone" }; // malformed imported native condition set
    expect(run([{ id: "condition", kind: "condition", effect: "Prone", mode: "lacks" }]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/4096-record/) });
  });

  test("inventory filters count matching item documents, not quantities; name wildcards are bounded and literal", () => {
    const localWorld = structuredClone(world), local = localWorld.scenes[0];
    const first = local?.tokens[0], second = local?.tokens[1], localTile = local?.tiles[0];
    if (!local || !first || !second || !localTile) throw new Error("missing local targets");
    first.actorId = "a-runner"; second.actorId = "a-gate";
    local.tokens.push(token("unlinked", 180, 180));
    const item = (id: string, name: string, quantity: number): ItemDocument => ({
      _id: id, type: "item", name, ownership: { default: 0 }, flags: {},
      system: { quantity }, effects: [],
    });
    const linked = (id: string, items: ItemDocument[]): ActorDocument => ({
      _id: id, type: "actor", name: id, ownership: { default: 0 }, flags: {},
      system: {}, items, effects: [],
    });
    localWorld.actors = [linked("a-runner", [item("p1", "  Potion of Healing ", 999),
      item("p2", "POTION of Greater HEALING", 1), item("r", "Rope", 1)]),
      linked("a-gate", [item("p3", "Potion of Healing", 5)])];
    const run = (steps: AutomationDefinition["steps"]) => planAutomation(localWorld,
      automation({ ...base, gates: {}, steps }), { scene: local, tile: localTile, token: first,
        method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    const matches = (pattern: string, compare: "eq" | "ne" | "gt" | "gte" | "lt" | "lte", count: number) => {
      const result = run([
        { id: "all", kind: "select", selector: { kind: "inside" } },
        { id: "items", kind: "inventory", item: pattern, compare, count },
        { id: "mark", kind: "tags", edit: "add", tags: ["selected"] },
      ]);
      if (!result.ok || !("plan" in result)) throw new Error("inventory filter did not plan");
      return result.plan.ops.flatMap((op) => op.kind === "update" && op.ref.coll === "tokens" ? [op.ref.id] : []);
    };
    expect(matches("potion*", "gte", 2)).toEqual(["runner"]);
    expect(matches("*HEALING", "eq", 1)).toEqual(["gate"]); // runner has two item records
    expect(matches("  *of HeALiNg*  ", "eq", 1)).toEqual(["runner", "gate"]);
    expect(matches("*HEALING", "ne", 1)).toEqual(["runner"]); // unlinked never matches !=
    expect(matches("*potion", "eq", 0)).toEqual(["runner", "gate"]); // unlinked is not empty
    expect(local.tokens[0]?.taggerTags).toEqual([]);
    expect(run([{ id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "items", kind: "inventory", item: "Potion", compare: "gte", count: 1 }]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/needs token targets/) });
    const runnerActor = localWorld.actors[0];
    if (!runnerActor) throw new Error("missing runner actor");
    runnerActor.items = Array.from({ length: 16 }, (_, index) => item(`p${index}`, "P".repeat(256), 1));
    const exhausted = run([
      { id: "mark", kind: "tags", edit: "add", tags: ["staged"] },
      ...Array.from({ length: 25 }, (_, index) => ({ id: `i${index}`, kind: "inventory" as const,
        item: "P*", compare: "gte" as const, count: 0 })),
    ]);
    expect(exhausted).toMatchObject({ ok: false, error: expect.stringMatching(/100000 reads/) });
    expect(local.tokens[0]?.taggerTags).toEqual([]);
    runnerActor.items = Array.from({ length: 4097 }, (_, index) => item(`p${index}`, "P", 1));
    expect(run([{ id: "items", kind: "inventory", item: "P", compare: "eq", count: 0 }]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/4096-record/) });

    // The two filter kinds share a budget across the entire nested plan, not
    // separate allowances a graph could alternate to exceed the cap.
    runnerActor.items = Array.from({ length: 16 }, (_, index) => item(`p${index}`, "P".repeat(256), 1));
    runnerActor.effects = [{ _id: "long", type: "effect", name: "A".repeat(4096),
      ownership: { default: 0 }, flags: {}, system: {}, changes: [], disabled: false }];
    const combined = run([
      { id: "mark", kind: "tags", edit: "add", tags: ["staged"] },
      ...Array.from({ length: 13 }, (_, index) => ({ id: `c${index}`, kind: "condition" as const,
        effect: "Prone", mode: "lacks" as const })),
      ...Array.from({ length: 13 }, (_, index) => ({ id: `i${index}`, kind: "inventory" as const,
        item: "P*", compare: "gte" as const, count: 0 })),
    ]);
    expect(combined).toMatchObject({ ok: false, error: expect.stringMatching(/100000 reads/) });
    expect(local.tokens[0]?.taggerTags).toEqual([]);
  });

  test("condition and inventory definitions reject extra fields, controls, invalid wildcards and counts", () => {
    const check = (step: Record<string, unknown>) => validateAutomation({ ...base, steps: [{ id: "query", ...step }] }).ok;
    expect(check({ kind: "condition", effect: "  Prone ", mode: "lacks" })).toBe(true);
    expect(check({ kind: "condition", effect: "", mode: "has" })).toBe(false);
    expect(check({ kind: "condition", effect: "Prone\n", mode: "has" })).toBe(false);
    expect(check({ kind: "condition", effect: "P".repeat(129), mode: "has" })).toBe(false);
    expect(check({ kind: "condition", effect: "Prone", mode: "missing" })).toBe(false);
    expect(check({ kind: "condition", effect: "Prone", mode: "has", code: "actor.flags" })).toBe(false);
    expect(check({ kind: "inventory", item: " *Potion* ", compare: "lte", count: 4096 })).toBe(true);
    for (const itemName of ["", "*", "**", "Po*tion", "Po**", "P".repeat(129), "Potion\u0000"])
      expect(check({ kind: "inventory", item: itemName, compare: "eq", count: 1 })).toBe(false);
    for (const count of [-1, 4097, 0.5, Number.NaN, "1", null])
      expect(check({ kind: "inventory", item: "Potion", compare: "eq", count })).toBe(false);
    expect(check({ kind: "inventory", item: "Potion", compare: "has", count: 1 })).toBe(false);
    expect(check({ kind: "inventory", item: "Potion", compare: "gte", count: 1, args: "{{user}}" })).toBe(false);
  });

  test("Check Tile Trigger Count includes this fire, honors inclusive min/max and branches on failure", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "check", kind: "filter", test: { kind: "tileCount", min: 4, max: 4 }, otherwise: "miss" },
      { id: "hit", kind: "chat", audience: "gm", content: "tile {{count}}" },
      { id: "stop", kind: "stop" },
      { id: "miss", kind: "landing", name: "miss" },
      { id: "fallback", kind: "chat", audience: "gm", content: "not yet" },
    ] };
    const doc = automation(def);
    doc.state = { count: 3, lastAt: 900, byToken: { runner: { count: 1, lastAt: 900 } } };
    const fire = (at: number) => planAutomation(world, doc, { scene, tile, token: runner, method: "enter",
      caller: actor, at, rng: () => 0.25 }, "gm");
    const hit = fire(1000);
    expect(hit.ok && "plan" in hit ? hit.plan.ops[1] : null).toMatchObject({ data: { content: "tile 4" } });
    if (hit.ok && "plan" in hit) doc.state = hit.plan.state;
    const miss = fire(1100);
    expect(miss.ok && "plan" in miss ? miss.plan.ops[1] : null).toMatchObject({ data: { content: "not yet" } });
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "filter", test: { kind: "tileCount", min: 2, max: 1 } }] }).ok).toBe(false);
  });

  test("Check Token Trigger Count is keyed by triggering token or user without exposing history", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "check", kind: "filter", test: { kind: "tokenCount", min: 2, max: 2 } },
      { id: "notice", kind: "chat", audience: "gm", content: "token fired twice" },
    ] };
    const doc = automation(def);
    doc.state = { count: 4, lastAt: 900, byToken: {
      runner: { count: 1, lastAt: 900 }, gate: { count: 3, lastAt: 880 },
      "user:p1": { count: 1, lastAt: 850 },
    } };
    const runnerFire = planAutomation(world, doc, { scene, tile, token: runner, method: "click",
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(runnerFire.ok && "plan" in runnerFire ? runnerFire.plan.ops : []).toHaveLength(2);
    const gateFire = planAutomation(world, doc, { scene, tile, token: gate, method: "click",
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(gateFire.ok && "plan" in gateFire ? gateFire.plan.ops : []).toHaveLength(1);
    const userFire = planAutomation(world, doc, { scene, tile, method: "click",
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(userFire.ok && "plan" in userFire ? userFire.plan.ops : []).toHaveLength(2);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "filter", test: { kind: "tokenCount", min: -1 } }] }).ok).toBe(false);
  });

  test("Redirect Based on Method branches to named landings with explicit fallback or fallthrough", () => {
    const def: AutomationDefinition = { ...base, steps: [
      { id: "router", kind: "routeMethod", routes: { enter: "entry" }, otherwise: "other" },
      { id: "entry", kind: "landing", name: "entry" },
      { id: "notice", kind: "chat", audience: "gm", content: "entered" },
      { id: "done", kind: "stop" },
      { id: "other", kind: "landing", name: "other" },
      { id: "fallback", kind: "chat", audience: "gm", content: "other method" },
    ] };
    const entry = plan(def);
    expect(entry.ok && "plan" in entry ? entry.plan.ops[1] : null)
      .toMatchObject({ data: { content: "entered" } });
    const click = planAutomation(world, automation(def), { scene, tile, method: "click", token: runner,
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(click.ok && "plan" in click ? click.plan.ops[1] : null).toMatchObject({ data: { content: "other method" } });
    expect(validateAutomation({ ...def, steps: [{ id: "router", kind: "routeMethod", routes: { manual: "entry" } },
      { id: "entry", kind: "landing", name: "entry" }] }).ok).toBe(true); // non-enabled methods are harmless
    expect(validateAutomation({ ...def, steps: [{ id: "router", kind: "routeMethod", routes: { enter: "missing" } }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "router", kind: "routeMethod", routes: { forged: "entry" } },
      { id: "entry", kind: "landing", name: "entry" }] }).ok).toBe(false);
  });

  test("Redirect Based on Player Type distinguishes GM/assistant from trusted/player and falls through", () => {
    const def: AutomationDefinition = { ...base, steps: [
      { id: "router", kind: "routeUser", gm: "staff", player: "visitors" },
      { id: "staff", kind: "landing", name: "staff" },
      { id: "notice", kind: "chat", audience: "gm", content: "staff" },
      { id: "done", kind: "stop" },
      { id: "visitors", kind: "landing", name: "visitors" },
      { id: "other", kind: "chat", audience: "gm", content: "visitors" },
    ] };
    for (const role of ["GM", "ASSISTANT", "TRUSTED", "PLAYER"] as const) {
      const result = planAutomation(world, automation(def), { scene, tile, token: runner, method: "enter",
        caller: { id: "who", role }, at: 1000, rng: () => 0.25 }, "gm");
      expect(result.ok && "plan" in result ? result.plan.ops[1] : null)
        .toMatchObject({ data: { content: role === "GM" || role === "ASSISTANT" ? "staff" : "visitors" } });
    }
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "routeUser", gm: "none" }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "routeUser", player: 5 }] }).ok).toBe(false);
  });

  test("Loop Through Entities snapshots the collection, nests lexically, restores context and combines writes atomically", () => {
    const def: AutomationDefinition = { ...base, steps: [
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "outer", kind: "forEach", endId: "endOuter" },
      { id: "mark", kind: "tags", edit: "add", tags: ["looped"] },
      { id: "notice", kind: "chat", audience: "gm", content: "{{index}}:{{currentId}}" },
      { id: "trigger", kind: "select", selector: { kind: "triggering" } },
      { id: "inner", kind: "forEach", endId: "endInner" },
      { id: "nested", kind: "chat", audience: "gm", content: "inner {{index}}:{{currentId}}" },
      { id: "endInner", kind: "endEach", startId: "inner" },
      { id: "endOuter", kind: "endEach", startId: "outer" },
      { id: "after", kind: "chat", audience: "gm", content: "after {{index}}:{{currentId}}" },
      { id: "all", kind: "tags", edit: "add", tags: ["after-loop"] },
    ] };
    const result = plan(def);
    if (!result.ok || !("plan" in result)) throw new Error("loop plan failed");
    expect(result.plan.ops).toHaveLength(8); // state, five messages, two coalesced tag edits
    const contents = result.plan.ops.filter((op) => op.kind === "create").map((op) =>
      op.kind === "create" && "content" in op.data ? op.data.content : null);
    expect(contents).toEqual(["1:runner", "inner 1:runner", "2:gate", "inner 1:runner", "after :"]);
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens"))
      .toMatchObject([{ ref: { id: "runner" }, diff: { taggerTags: ["looped", "after-loop"] } },
        { ref: { id: "gate" }, diff: { taggerTags: ["door-1", "looped", "after-loop"] } }]);
  });

  test("Loop Through Entities skips empty selections and restores targets when branching outward", () => {
    const empty = plan({ ...base, steps: [
      { id: "none", kind: "select", selector: { kind: "tag", query: "not-a-tag" } },
      { id: "each", kind: "forEach", endId: "endEach" },
      { id: "never", kind: "chat", audience: "gm", content: "not reached" },
      { id: "endEach", kind: "endEach", startId: "each" },
      { id: "after", kind: "chat", audience: "gm", content: "after" },
    ] });
    expect(empty.ok && "plan" in empty ? empty.plan.ops : []).toHaveLength(2);
    const exit = plan({ ...base, steps: [
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "each", kind: "forEach", endId: "endEach" },
      { id: "jump", kind: "jump", to: "out" },
      { id: "endEach", kind: "endEach", startId: "each" },
      { id: "out", kind: "landing", name: "out" },
      { id: "mark", kind: "tags", edit: "add", tags: ["both"] },
      { id: "notice", kind: "chat", audience: "gm", content: "restored {{index}}:{{currentId}}" },
    ] });
    expect(exit.ok && "plan" in exit ? exit.plan.ops : []).toMatchObject([
      { kind: "update", ref: { coll: "automations" } },
      { kind: "create", data: { content: "restored :" } },
      { kind: "update", ref: { id: "runner" } }, { kind: "update", ref: { id: "gate" } },
    ]);
  });

  test("lexical loop validation rejects wrong pairs, inner landings, excessive depth and forged fields", () => {
    const badSteps: unknown[][] = [
      [{ id: "one", kind: "forEach", endId: "two" }],
      [{ id: "two", kind: "endEach", startId: "one" }],
      [{ id: "one", kind: "forEach", endId: "two" }, { id: "two", kind: "endEach", startId: "other" }],
      [{ id: "one", kind: "forEach", endId: "two" }, { id: "label", kind: "landing", name: "inside" },
        { id: "two", kind: "endEach", startId: "one" }],
      [{ id: "one", kind: "forEach", endId: "two", times: 1 }, { id: "two", kind: "endEach", startId: "one" }],
      [...Array.from({ length: 9 }, (_, i) => ({ id: `begin${i}`, kind: "forEach", endId: `end${i}` })),
        ...Array.from({ length: 9 }, (_, i) => ({ id: `end${8 - i}`, kind: "endEach", startId: `begin${8 - i}` }))],
    ];
    for (const steps of badSteps) expect(validateAutomation({ ...base, steps }).ok).toBe(false);
  });

  test("Reset Tile Trigger History clears the current fire, token counts and audit in the same plan", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "reset", kind: "resetHistory" },
      { id: "zero", kind: "filter", test: { kind: "tileCount", min: 0, max: 0 } },
      { id: "token", kind: "filter", test: { kind: "tokenCount", min: 0, max: 0 } },
      { id: "notice", kind: "chat", audience: "gm", content: "count {{count}}" },
    ] };
    const doc = automation(def);
    doc.state = { count: 12, lastAt: 990, byToken: { runner: { count: 3, lastAt: 990 } },
      recent: [{ at: 990, method: "enter", userId: "p1", tokenId: "runner" }] };
    const result = planAutomation(world, doc, { scene, tile, token: runner, method: "enter",
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    if (!result.ok || !("plan" in result)) throw new Error("reset plan failed");
    expect(result.plan.state).toEqual({ count: 0, lastAt: 0, byToken: {}, recent: [] });
    expect(result.plan.ops).toMatchObject([{ kind: "update", diff: { state: result.plan.state } },
      { kind: "create", data: { content: "count 0" } }]);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "resetHistory", scope: "world" }] }).ok).toBe(false);
  });

  test("loop resource and post-commit script caps fail planning without producing a partial commit", () => {
    const many = Array.from({ length: 1025 }, (_, i) => token(`t${i}`, 150, 150));
    const busyScene = { ...scene, tokens: many };
    const busyWorld = { ...world, scenes: [busyScene] };
    const loop: AutomationDefinition = { ...base, steps: [
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "each", kind: "forEach", endId: "endEach" },
      { id: "do", kind: "set", name: "value", value: 1 },
      { id: "endEach", kind: "endEach", startId: "each" },
    ] };
    const first = many[0];
    if (!first) throw new Error("missing first token in resource fixture");
    const cap = planAutomation(busyWorld, automation(loop), { scene: busyScene, tile, token: first,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(cap.error).toMatch(/1024 targets/);
    const scripts: AutomationDefinition = { ...base, steps: [
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "each", kind: "forEach", endId: "endEach" },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `script${i}`, kind: "script" as const, macroId: "approved" })),
      { id: "endEach", kind: "endEach", startId: "each" },
    ] };
    const tooMany = plan(scripts); // 9 script steps × 2 targets = 18 post-commit invocations
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toMatch(/16 post-commit actions/);
  });
  test("history cap and imported overfull target tags reject before any graph mutations", () => {
    const capped = automation({ ...base, gates: {}, steps: [{ id: "reset", kind: "resetHistory" }] });
    capped.state = { count: 1_000_000, lastAt: 1000, byToken: { runner: { count: 1_000_000, lastAt: 1000 } } };
    const full = planAutomation(world, capped, { scene, tile, token: runner, method: "enter",
      caller: actor, at: 2000, rng: () => 0.25 }, "gm");
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error).toMatch(/history count cap/);
    expect(capped.state.count).toBe(1_000_000);
    const dense = { ...runner, taggerTags: Array.from({ length: 64 }, (_, i) => `tag${i}`) };
    const denseScene = { ...scene, tokens: [dense, gate] };
    const denseWorld = { ...world, scenes: [denseScene] };
    const edit = planAutomation(denseWorld, automation({ ...base, steps: [
      { id: "select", kind: "select", selector: { kind: "triggering" } },
      { id: "add", kind: "tags", edit: "add", tags: ["one-too-many"] },
    ] }), { scene: denseScene, tile, token: dense, method: "enter", caller: actor,
      at: 1000, rng: () => 0.25 }, "gm");
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error).toMatch(/tag edit failed.*at most 64 tags/);
    expect(dense.taggerTags).toHaveLength(64);
  });
  test("Set Active Tiles Current Collection adds, removes, replaces and clears stable scene refs", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "replace", kind: "collection", mode: "replace", selector: { kind: "tag", query: "door-1",
        collections: ["tokens"] } },
      { id: "runner", kind: "collection", mode: "add", selector: { kind: "triggering" } },
      { id: "remove", kind: "collection", mode: "remove", selector: { kind: "tag", query: "door-1",
        collections: ["tokens"] } },
      { id: "add", kind: "collection", mode: "add", selector: { kind: "tag", query: "door-1",
        collections: ["tokens"] } },
      { id: "duplicate", kind: "collection", mode: "add", selector: { kind: "tag", query: "door-1",
        collections: ["tokens"] } },
      { id: "second", kind: "position", index: 2 },
      { id: "one", kind: "filter", test: { kind: "count", min: 1, max: 1 } },
      { id: "script", kind: "script", macroId: "approved", bindings: { selected: "currentToken" } },
      { id: "clear", kind: "collection", mode: "clear" },
      { id: "zero", kind: "filter", test: { kind: "count", min: 0, max: 0 } },
      { id: "message", kind: "chat", content: "empty", audience: "gm" },
    ] };
    const result = plan(def);
    expect(result.ok && "plan" in result ? result.plan.scripts : []).toEqual([
      { stepId: "script", macroId: "approved", args: { selected: "gate" } },
    ]);
    expect(result.ok && "plan" in result ? result.plan.ops : []).toHaveLength(2); // history, chat
    expect(result.ok && "plan" in result ? result.plan.trace : []).toContain("collection clear: 0 target(s)");
    expect(validateAutomation({ ...def, steps: [{ id: "clear", kind: "collection", mode: "clear",
      selector: { kind: "tile" } }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "collection", mode: "add" }] }).ok).toBe(false);
    expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "collection", mode: "add",
      selector: { kind: "tag", query: "x", collections: ["actors"] } }] }).ok).toBe(false);
  });

  test("Trigger Tile sees earlier staged tag edits, returns to parent and coalesces both histories in one plan", () => {
    const local = structuredClone(scene);
    const childTile: TileDocument = { ...structuredClone(tile), _id: "child", taggerTags: ["child"] };
    local.tiles.push(childTile);
    const root = automation({ ...base, gates: {}, steps: [
      { id: "tile", kind: "select", selector: { kind: "tag", query: "child", collections: ["tiles"] } },
      { id: "mark-tile", kind: "tags", edit: "add", tags: ["call-me"] },
      { id: "gate", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "mark-token", kind: "tags", edit: "add", tags: ["lit"] },
      { id: "call", kind: "triggerTile", target: { kind: "tag", query: "call-me" }, tokens: "triggering" },
      { id: "find-return", kind: "select", selector: { kind: "tag", query: "from-child", collections: ["tokens"] } },
      { id: "after", kind: "tags", edit: "add", tags: ["after-child"] },
    ] });
    const child = { ...automation({ ...base, tileId: "child", methods: ["manual"], gates: {}, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "lit", collections: ["tokens"] } },
      { id: "edit", kind: "tags", edit: "add", tags: ["from-child"] },
      { id: "chat", kind: "chat", audience: "gm", content: "{{method}}/{{originMethod}}/{{originTile}}/{{count}}" },
    ] }), _id: "a-child" };
    const current = emptyWorld(); current.scenes.push(local); current.automations.push(root, child);
    const result = planAutomation(current, root, { scene: local, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(result.ok && "plan" in result).toBe(true);
    if (!result.ok || !("plan" in result)) return;
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "automations"))
      .toMatchObject([{ ref: { id: "a1" }, diff: { state: { count: 1 } } },
        { ref: { id: "a-child" }, diff: { state: { count: 1 } } }]);
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens"))
      .toEqual([{ kind: "update", ref: { coll: "tokens", id: "gate", parent: { coll: "scenes", id: "s1" } },
        diff: { taggerTags: ["door-1", "lit", "from-child", "after-child"] } }]);
    expect(result.plan.ops).toContainEqual(expect.objectContaining({ kind: "create",
      data: expect.objectContaining({ content: "manual/enter/zone/1" }) }));
    expect(result.plan.trace).toContain("tile child -> graph a-child [runner]");
    expect(local.tokens[1]?.taggerTags).toEqual(["door-1"]);
    expect(childTile.taggerTags).toEqual(["child"]);
    expect(root.state).toBeUndefined();
    expect(child.state).toBeUndefined();
  });

  test("repeated Trigger Tile invocations update child history once, respecting staged run gates", () => {
    const local = structuredClone(scene);
    local.tiles.push({ ...structuredClone(tile), _id: "child" });
    const root = automation({ ...base, gates: {}, steps: [
      { id: "first", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
      { id: "second", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
    ] });
    const child = { ...automation({ ...base, tileId: "child", methods: ["manual"],
      gates: { maxRuns: 1 }, steps: [{ id: "chat", kind: "chat", content: "child", audience: "gm" }] }), _id: "a-child" };
    const current = emptyWorld(); current.scenes.push(local); current.automations.push(root, child);
    const result = planAutomation(current, root, { scene: local, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(result.ok && "plan" in result ? result.plan.ops : []).toHaveLength(3); // root + child histories, chat
    expect(result.ok && "plan" in result ? result.plan.trace : []).toContain("graph a-child skipped: run limit");
    expect(result.ok && "plan" in result ? result.plan.ops.filter((op) => op.kind === "update") : [])
      .toMatchObject([{ ref: { id: "a1" }, diff: { state: { count: 1 } } },
        { ref: { id: "a-child" }, diff: { state: { count: 1 } } }]);
    child.definition.gates = {}; // two manual calls must still have only one final history op
    const repeat = planAutomation(current, root, { scene: local, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(repeat.ok && "plan" in repeat ? repeat.plan.ops.filter((op) => op.kind === "update") : [])
      .toMatchObject([{ ref: { id: "a1" }, diff: { state: { count: 1 } } },
        { ref: { id: "a-child" }, diff: { state: { count: 2, byToken: { runner: { count: 2 } } } } }]);
    expect(repeat.ok && "plan" in repeat ? repeat.plan.ops.filter((op) => op.kind === "create") : [])
      .toHaveLength(2);
  });

  test("Trigger Tile uses tile refs from current collection and distinguishes current from inside tokens", () => {
    const local = structuredClone(scene);
    local.tiles.push({ ...structuredClone(tile), _id: "child", taggerTags: ["child"] });
    const root = automation({ ...base, gates: {}, steps: [
      { id: "tile", kind: "select", selector: { kind: "tag", query: "child", collections: ["tiles"] } },
      { id: "gate", kind: "collection", mode: "add", selector: { kind: "tag",
        query: "door-1", collections: ["tokens"] } },
      { id: "current", kind: "triggerTile", target: { kind: "current" }, tokens: "current" },
      { id: "inside", kind: "triggerTile", target: { kind: "current" }, tokens: "inside" },
    ] });
    const child = { ...automation({ ...base, tileId: "child", methods: ["manual"], gates: {},
      steps: [{ id: "chat", kind: "chat", content: "{{count}}", audience: "gm" }] }), _id: "a-child" };
    const current = emptyWorld(); current.scenes.push(local); current.automations.push(root, child);
    const result = planAutomation(current, root, { scene: local, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    if (!result.ok || !("plan" in result)) throw new Error("nested current/inside call did not plan");
    expect(result.plan.ops.flatMap((op) => op.kind === "create" && op.coll === "messages"
      ? [(op.data as MessageDocument).content] : [])).toEqual(["1", "2", "3"]);
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "automations"))
      .toMatchObject([{ ref: { id: "a1" } }, { ref: { id: "a-child" },
        diff: { state: { count: 3, byToken: { gate: { count: 2 }, runner: { count: 1 } } } } }]);
    expect(result.plan.trace.filter((entry) => entry.startsWith("tile child -> graph a-child")))
      .toEqual(["tile child -> graph a-child [gate]", "tile child -> graph a-child [runner]",
        "tile child -> graph a-child [gate]"]);
  });

  test("named child landing and propagated Stop can end the parent without committing earlier child steps", () => {
    const local = structuredClone(scene);
    local.tiles.push({ ...structuredClone(tile), _id: "child" });
    const child = { ...automation({ ...base, tileId: "child", methods: ["manual"], gates: {}, steps: [
      { id: "before", kind: "chat", audience: "gm", content: "before" },
      { id: "start", kind: "landing", name: "start" },
      { id: "after", kind: "chat", audience: "gm", content: "after" },
      { id: "stop", kind: "stop" },
    ] }), _id: "a-child" };
    const root = automation({ ...base, gates: {}, steps: [
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering",
        landing: "start", propagateStop: true },
      { id: "parent", kind: "chat", audience: "gm", content: "parent" },
    ] });
    const current = emptyWorld(); current.scenes.push(local); current.automations.push(root, child);
    const fire = () => planAutomation(current, root, { scene: local, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    let result = fire();
    expect(result.ok && "plan" in result ? result.plan.ops.filter((op) => op.kind === "create")
      .map((op) => op.data.name) : []).toEqual(["Automation: Trap"]);
    expect(result.ok && "plan" in result ? result.plan.ops.filter((op) => op.kind === "create")
      .map((op) => (op.data as MessageDocument).content) : []).toEqual(["after"]);
    if (root.definition.steps[0]?.kind === "triggerTile") root.definition.steps[0].propagateStop = false;
    result = fire();
    expect(result.ok && "plan" in result ? result.plan.ops.filter((op) => op.kind === "create")
      .map((op) => (op.data as MessageDocument).content) : []).toEqual(["after", "parent"]);
    if (root.definition.steps[0]?.kind === "triggerTile") root.definition.steps[0].landing = "missing";
    result = fire();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/landing missing not found/);
    expect(root.state).toBeUndefined();
    expect(child.state).toBeUndefined();
  });

  test("Trigger Tile rejects self-cycles, excessive tile fanout and forged cross-scene/unsafe targets", () => {
    const local = structuredClone(scene);
    const root = automation({ ...base, gates: {}, methods: ["enter", "manual"], steps: [
      { id: "edit", kind: "select", selector: { kind: "triggering" } },
      { id: "tag", kind: "tags", edit: "add", tags: ["would-rollback"] },
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "zone" }, tokens: "triggering" },
    ] });
    const current = emptyWorld(); current.scenes.push(local); current.automations.push(root);
    const fire = () => planAutomation(current, root, { scene: local, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    const loop = fire();
    expect(loop.ok).toBe(false);
    if (!loop.ok) expect(loop.error).toMatch(/trigger tile recursion/);
    expect(local.tokens[0]?.taggerTags).toEqual([]);
    expect(root.state).toBeUndefined();
    root.definition.steps[2] = { id: "call", kind: "triggerTile", target: { kind: "tag", query: "many" },
      tokens: "triggering" };
    local.tiles.push(...Array.from({ length: 33 }, (_, i) => ({ ...structuredClone(tile),
      _id: `many-${i}`, taggerTags: ["many"] })));
    const overfull = fire();
    expect(overfull.ok).toBe(false);
    if (!overfull.ok) expect(overfull.error).toMatch(/fanout exceeds 32/);
    expect(local.tokens[0]?.taggerTags).toEqual([]);
    expect(validateAutomation({ ...base, steps: [{ id: "x", kind: "triggerTile", target: { kind: "id",
      tileId: "other:scene" }, tokens: "triggering" }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "x", kind: "triggerTile", target: { kind: "tag",
      query: "(a+)+", pattern: "regex" }, tokens: "triggering" }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "x", kind: "triggerTile", target: { kind: "tag",
      query: "many", includeRefs: [{ coll: "tokens", id: "runner", parent: { coll: "scenes", id: "s1" } }] },
      tokens: "triggering" }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "x", kind: "stopOthers", action: "inject" }] }).ok).toBe(false);
  });

  test("tile variables persist across triggers, filter and interpolate without mutating source history", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "add", kind: "set", name: "visits", value: 1, scope: "tile", operation: "add" },
      { id: "check", kind: "filter", test: { kind: "variable", name: "visits", equals: 2 } },
      { id: "notice", kind: "chat", audience: "gm", content: "Visitors: {{visits}}" },
    ] };
    const doc = automation(def);
    const first = planAutomation(world, doc, { scene, tile, method: "enter", token: runner,
      caller: actor, at: 1000, rng: () => 0 }, "gm");
    if (!first.ok || !("plan" in first)) throw new Error("first tile variable plan failed");
    expect(first.plan.ops).toHaveLength(1); // private state + count, no chat yet
    expect(first.plan.state).toMatchObject({ count: 1, variables: { visits: 1 } });
    expect(doc.state).toBeUndefined(); // dry-run never mutates the store
    doc.state = first.plan.state; // simulate authoritative commit/reload
    const second = planAutomation(world, doc, { scene, tile, method: "enter", token: runner,
      caller: actor, at: 2000, rng: () => 0 }, "gm");
    if (!second.ok || !("plan" in second)) throw new Error("second tile variable plan failed");
    expect(second.plan.state).toMatchObject({ count: 2, variables: { visits: 2 } });
    expect(second.plan.ops).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "a1" }, diff: { state: { variables: { visits: 2 } } } },
      { kind: "create", coll: "messages", data: { content: "Visitors: 2" } },
    ]);
    expect(first.plan.state.variables).toEqual({ visits: 1 }); // no alias to previous state
    const shadow = automation({ ...base, gates: {}, steps: [
      { id: "temp", kind: "set", name: "visits", value: "temporary", scope: "run" },
      { id: "persist", kind: "set", name: "visits", value: 1, scope: "tile", operation: "add" },
    ] });
    shadow.state = second.plan.state;
    const shadowed = planAutomation(world, shadow, { scene, tile, method: "enter", token: runner,
      caller: actor, at: 3000, rng: () => 0 }, "gm");
    expect(shadowed.ok && "plan" in shadowed ? shadowed.plan.state.variables : null)
      .toEqual({ visits: 3 }); // adds to persisted 2, not temporary string
    // Reset of the *persisted* graph keeps its variables.
    doc.definition.steps = [{ id: "clear", kind: "resetHistory" }];
    doc.state = second.plan.state;
    const kept = planAutomation(world, doc, { scene, tile, method: "enter", token: runner,
      caller: actor, at: 3000, rng: () => 0 }, "gm");
    expect(kept.ok && "plan" in kept ? kept.plan.state : null)
      .toMatchObject({ count: 0, variables: { visits: 2 } });
  });

  test("tile variables are isolated per child graph but shared by repeated nested calls in one atomic plan", () => {
    const local = structuredClone(scene);
    local.tiles.push({ ...structuredClone(tile), _id: "child" });
    const root = automation({ ...base, gates: {}, steps: [
      { id: "parent", kind: "set", name: "visits", value: 20, scope: "tile" },
      { id: "first", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
      { id: "second", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
    ] });
    const child = { ...automation({ ...base, tileId: "child", methods: ["manual"], gates: {}, steps: [
      { id: "increment", kind: "set", name: "visits", value: 1, scope: "tile", operation: "add" },
      { id: "check", kind: "filter", test: { kind: "variable", name: "visits", equals: 2 } },
      { id: "notice", kind: "chat", audience: "gm", content: "Child {{visits}}" },
    ] }), _id: "a-child" };
    const current = emptyWorld(); current.scenes.push(local); current.automations.push(root, child);
    const rootTile = local.tiles[0];
    if (!rootTile) throw new Error("nested test requires root tile");
    const result = planAutomation(current, root, { scene: local, tile: rootTile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0 }, "gm");
    if (!result.ok || !("plan" in result)) throw new Error("nested tile variables failed");
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "automations"))
      .toMatchObject([
        { ref: { id: "a1" }, diff: { state: { variables: { visits: 20 } } } },
        { ref: { id: "a-child" }, diff: { state: { count: 2, variables: { visits: 2 } } } },
      ]);
    expect(result.plan.ops.filter((op) => op.kind === "create").map((op) => (op.data as MessageDocument).content))
      .toEqual(["Child 2"]);
    expect(root.state).toBeUndefined();
    expect(child.state).toBeUndefined();
  });

  test("Set Active Tiles Variable targets current/Tagger tiles, fans out to each graph and feeds a same-plan child", () => {
    const local = structuredClone(scene);
    local.tiles.push({ ...structuredClone(tile), _id: "relay-one", taggerTags: ["relay"], hidden: true });
    local.tiles.push({ ...structuredClone(tile), _id: "relay-two", taggerTags: ["relay"], hidden: true });
    const parent = automation({ ...base, gates: {}, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "relay", collections: ["tiles"] } },
      { id: "seed", kind: "set", name: "charge", scope: "tile", value: 1, target: { kind: "current" } },
      { id: "mark", kind: "tags", edit: "add", tags: ["ready"] },
      { id: "add", kind: "set", name: "charge", scope: "tile", value: 2, operation: "add",
        target: { kind: "tag", query: "ready" } },
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "relay-one" }, tokens: "triggering" },
    ] });
    const child = { ...automation({ ...base, tileId: "relay-one", methods: ["manual"], gates: {}, steps: [
      { id: "check", kind: "filter", test: { kind: "variable", name: "charge", equals: 3 } },
      { id: "notice", kind: "chat", audience: "gm", content: "Charged {{charge}}" },
    ] }), _id: "child-one" };
    const sibling = { ...automation({ ...base, tileId: "relay-one", methods: ["manual"], gates: {},
      steps: [{ id: "done", kind: "stop" }] }), _id: "sibling-one" };
    const other = { ...automation({ ...base, tileId: "relay-two", methods: ["manual"], gates: { paused: true },
      steps: [{ id: "done", kind: "stop" }] }), _id: "child-two" };
    const localWorld = emptyWorld(); localWorld.scenes.push(local); localWorld.automations.push(parent, child, sibling, other);
    const rootTile = local.tiles[0], rootToken = local.tokens[0];
    if (!rootTile || !rootToken) throw new Error("test missing tile/token");
    const event = { scene: local, tile: rootTile, token: rootToken, caller: actor,
      method: "enter" as const, at: 1000, rng: () => 0.25 };
    const result = planAutomation(localWorld, parent, event, "gm");
    if (!result.ok || !("plan" in result)) throw new Error("remote variable relay did not plan");
    expect(result.plan.trace).toContain("tile variable charge += on 3 graph(s) of 2 tile(s) (private)");
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "automations"))
      .toMatchObject([
        { ref: { id: "a1" }, diff: { state: { count: 1 } } },
        { ref: { id: "child-one" }, diff: { state: { count: 1, variables: { charge: 3 } } } },
        { ref: { id: "sibling-one" }, diff: { state: { count: 1, variables: { charge: 3 } } } },
        { ref: { id: "child-two" }, diff: { state: { count: 0, variables: { charge: 3 } } } },
      ]);
    expect(result.plan.ops.filter((op) => op.kind === "create")
      .map((op) => (op.data as MessageDocument).content)).toEqual(["Charged 3"]);
    expect(child.state).toBeUndefined();
    expect(other.state).toBeUndefined();
    expect(local.tiles[1]?.taggerTags).toEqual(["relay"]);
    expect(result.plan.state.variables).toBeUndefined(); // remote variables do not contaminate parent

    const prior = structuredClone(other);
    prior.state = { count: 0, lastAt: 0, byToken: {}, variables: { charge: 1_000_000_000 } };
    localWorld.automations[3] = prior;
    const failingParent = { ...parent, definition: { ...parent.definition, steps: [
      { id: "find", kind: "select" as const, selector: { kind: "tag" as const, query: "relay",
        collections: ["tiles" as const] } },
      { id: "mark", kind: "tags" as const, edit: "add" as const, tags: ["queued"] },
      { id: "add", kind: "set" as const, name: "charge", scope: "tile" as const, value: 1,
        operation: "add" as const, target: { kind: "current" as const } },
    ] } };
    const failed = planAutomation(localWorld, failingParent, event, "gm");
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/exceeds its bounds/) });
    expect(local.tiles[1]?.taggerTags).toEqual(["relay"]);
    expect(prior.state.variables?.charge).toBe(1_000_000_000);
    expect(parent.state).toBeUndefined();
  });

  test("Check Value reads committed darkness/movement, rejects missing direction even for inequality, and lands on failure", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "darkness", kind: "checkValue", source: "darkness", compare: "gte", value: 0.6,
        otherwise: "not-ready" },
      { id: "direction", kind: "checkValue", source: "direction.x", compare: "eq", value: "right",
        otherwise: "not-ready" },
      { id: "lit", kind: "chat", audience: "gm", content: "ready" },
      { id: "stop", kind: "stop" },
      { id: "not-ready", kind: "landing", name: "not-ready" },
      { id: "blocked", kind: "chat", audience: "gm", content: "blocked" },
    ] };
    const event = { scene: { ...scene, darkness: 0.6 }, tile, token: runner, method: "enter" as const,
      caller: actor, at: 1000, rng: () => 0.5 };
    const result = planAutomation(world, automation(def), { ...event, direction: { x: "right", y: "up" } }, "gm");
    expect(result.ok && "plan" in result ? result.plan.ops.at(-1) : null)
      .toMatchObject({ kind: "create", data: { content: "ready" } });
    expect(result.ok && "plan" in result ? result.plan.trace : []).toContain("Check Value direction.x: right eq right -> pass");
    const tooBright = planAutomation(world, automation(def), { ...event, scene: { ...scene, darkness: 0.59 },
      direction: { x: "right" } }, "gm");
    expect(tooBright.ok && "plan" in tooBright ? tooBright.plan.ops.at(-1) : null)
      .toMatchObject({ kind: "create", data: { content: "blocked" } });
    const noMovement = planAutomation(world, automation({ ...def, steps: [
      { id: "direction", kind: "checkValue", source: "direction.x", compare: "ne", value: "left",
        otherwise: "not-ready" }, ...def.steps.slice(2),
    ] }), event, "gm");
    expect(noMovement.ok && "plan" in noMovement ? noMovement.plan.ops.at(-1) : null)
      .toMatchObject({ kind: "create", data: { content: "blocked" } });
    for (const step of [
      { id: "bad", kind: "checkValue", source: "darkness", compare: "gte", value: 1.1 },
      { id: "bad", kind: "checkValue", source: "direction.x", compare: "gt", value: "right" },
      { id: "bad", kind: "checkValue", source: "direction.y", compare: "eq", value: "right" },
      { id: "bad", kind: "checkValue", source: "event.shiftKey", compare: "eq", value: true },
      { id: "bad", kind: "checkValue", source: "darkness", compare: "eq", value: 0.5, otherwise: "missing" },
    ]) expect(validateAutomation({ ...def, steps: [step] }).ok).toBe(false);
  });

  test("Check Data reads only the staged triggering tile, branches without changing selection, and enforces read limits", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "hide", kind: "visibility", mode: "hide" },
      { id: "tokens", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
      { id: "test", kind: "checkData", path: "hidden", compare: "eq", value: true,
        otherwise: "failed" },
      { id: "mark", kind: "tags", edit: "add", tags: ["passed"] },
      { id: "done", kind: "stop" },
      { id: "failed", kind: "landing", name: "failed" },
      { id: "blocked", kind: "chat", audience: "gm", content: "tile check failed" },
    ] };
    const success = plan(def);
    if (!success.ok || !("plan" in success)) throw new Error("Check Data graph did not plan");
    expect(success.plan.trace).toContain("Check Data hidden: pass");
    expect(success.plan.ops).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "a1" } },
      { kind: "update", ref: { coll: "tokens", id: "gate" }, diff: { taggerTags: ["door-1", "passed"] } },
      { kind: "update", ref: { coll: "tiles", id: "zone" }, diff: { hidden: true } },
    ]);
    expect(tile.hidden).toBeUndefined();
    expect(gate.taggerTags).toEqual(["door-1"]);
    const failure = plan({ ...def, steps: def.steps.map((step) => step.kind === "checkData"
      ? { ...step, value: false } : step) });
    expect(failure.ok && "plan" in failure ? failure.plan.trace : []).toContain("Check Data hidden: fail");
    expect(failure.ok && "plan" in failure ? failure.plan.ops.find((op) => op.kind === "create") : null)
      .toMatchObject({ data: { content: "tile check failed" } });
    for (const step of [
      { id: "invalid", kind: "checkData", path: "actor.system.hp", compare: "eq", value: 2 },
      { id: "invalid", kind: "checkData", path: "ownership.default", compare: "ne", value: 3 },
      { id: "invalid", kind: "checkData", path: "__proto__.polluted", compare: "eq", value: "x" },
      { id: "invalid", kind: "checkData", path: "hidden", compare: "gt", value: "true" },
      { id: "invalid", kind: "checkData", path: "name", compare: "eq", value: "Zone", otherwise: "missing" },
    ]) expect(validateAutomation({ ...def, steps: [step] }).ok).toBe(false);
    const localScene = structuredClone(scene);
    const largeTile = localScene.tiles[0], localToken = localScene.tokens[0];
    if (!largeTile || !localToken) throw new Error("missing Check Data tile/token");
    largeTile.system.large = "a".repeat(4097);
    const localWorld = { ...world, scenes: [localScene] };
    const failed = planAutomation(localWorld, automation({ ...def, steps: [
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "hide", kind: "visibility", mode: "hide" },
      { id: "bad-read", kind: "checkData", path: "system.large", compare: "ne", value: "x" },
    ] }), { scene: localScene, tile: largeTile, token: localToken, method: "enter",
      caller: actor, at: 1000, rng: () => 0.5 }, "gm");
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/4096/) });
    expect(largeTile.hidden).toBeUndefined();
  });

  test("Game Time stages bounded minute deltas in one clock op; Check Value sees them, failure mutates nothing", () => {
    const s = structuredClone(scene);
    const w = emptyWorld(); w.scenes.push(s);
    const anchor = s.tiles[0], mover = s.tokens[0];
    if (!anchor || !mover) throw new Error("missing Game Time tile/token");
    const event = { scene: s, tile: anchor, token: mover, method: "click" as const,
      caller: actor, at: 1000, rng: () => 0.25 };
    const run = (steps: AutomationDefinition["steps"]) =>
      planAutomation(w, automation({ ...base, gates: {}, steps }), event, "gm");
    const created = run([
      { id: "advance", kind: "gameTime", minutes: 90 },
      { id: "first", kind: "checkValue", source: "time", compare: "eq", value: 90 },
      { id: "rewind", kind: "gameTime", minutes: -30 },
      { id: "second", kind: "checkValue", source: "time", compare: "eq", value: 60 },
      { id: "notice", kind: "chat", audience: "gm", content: "staged clock passed" },
    ]);
    if (!created.ok || !("plan" in created)) throw new Error("Game Time create plan failed");
    expect(created.plan.ops.filter((op) => op.kind === "create" && op.coll === "settings"))
      .toMatchObject([{ data: { system: { clockSeconds: 3600 } } }]);
    expect(created.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "settings")).toEqual([]);
    expect(created.plan.ops).toContainEqual(expect.objectContaining({ kind: "create",
      data: expect.objectContaining({ content: "staged clock passed" }) }));
    expect(created.plan.trace).toContain("Check Value time: 60 eq 60 -> pass");
    expect(w.settings).toEqual([]); // dry runs cannot mutate the authoritative clock

    const canonical = worldSettingsDoc({ clockSeconds: 23 * 3600 + 50 * 60, detectionMultiplier: 2 });
    w.settings.push(canonical);
    const updated = run([
      { id: "midnight", kind: "gameTime", minutes: 30 },
      { id: "after", kind: "checkValue", source: "time", compare: "eq", value: 20 },
      { id: "back", kind: "gameTime", minutes: -15 },
      { id: "last", kind: "checkValue", source: "time", compare: "eq", value: 5 },
    ]);
    if (!updated.ok || !("plan" in updated)) throw new Error("Game Time update plan failed");
    expect(updated.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "settings"))
      .toEqual([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
        diff: { "system.clockSeconds": 86_700 } }]);
    expect(canonical.system).toEqual({ clockSeconds: 85_800, detectionMultiplier: 2 });
    const invalid = run([
      { id: "change", kind: "gameTime", minutes: 60 },
      { id: "select", kind: "select", selector: { kind: "tile" } },
      { id: "bad-door", kind: "door", mode: "open" },
    ]);
    expect(invalid).toMatchObject({ ok: false, error: expect.stringMatching(/door action requires/) });
    expect(canonical.system.clockSeconds).toBe(85_800);
    canonical.system.clockSeconds = 0;
    expect(run([{ id: "underflow", kind: "gameTime", minutes: -1 }])).toMatchObject({ ok: false,
      error: expect.stringMatching(/outside 0/) });
    canonical.system.clockSeconds = 3_153_600_000;
    expect(run([{ id: "overflow", kind: "gameTime", minutes: 1 }])).toMatchObject({ ok: false,
      error: expect.stringMatching(/outside 0/) });
    canonical.system.clockSeconds = 0;
    w.settings.push({ ...worldSettingsDoc({ clockSeconds: 5 }), _id: "zz-other-settings" });
    expect(run([{ id: "shadow", kind: "gameTime", minutes: 1 }])).toMatchObject({ ok: false,
      error: expect.stringMatching(/overrides the world clock/) });
    expect(canonical.system.clockSeconds).toBe(0);
    for (const minutes of [525_601, -525_601, 1.5, "60", NaN, Infinity])
      expect(validateAutomation({ ...base, gates: {}, steps: [{ id: "bad", kind: "gameTime", minutes }] }).ok)
        .toBe(false);
    expect(validateAutomation({ ...base, gates: {}, steps: [
      { id: "bad", kind: "gameTime", minutes: 30, code: "eval(1)" },
    ] }).ok).toBe(false);
  });

  test("Check Value time uses the committed world clock, rolls over at midnight and rejects malformed clocks", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "time", kind: "checkValue", source: "time", compare: "gte", value: 60,
        otherwise: "too-early" },
      { id: "day", kind: "chat", audience: "gm", content: "after one" },
      { id: "stop", kind: "stop" },
      { id: "too-early", kind: "landing", name: "too-early" },
      { id: "night", kind: "chat", audience: "gm", content: "before one" },
    ] };
    const local = structuredClone(world);
    const event = { scene, tile, token: runner, method: "click" as const, caller: actor,
      at: 1000, rng: () => 0.5 };
    const fire = () => planAutomation(local, automation(def), event, "gm");
    const content = () => {
      const result = fire();
      return result.ok && "plan" in result ? result.plan.ops.at(-1) : null;
    };
    // An unset world clock is midnight on day zero; absent is not wall time.
    expect(content()).toMatchObject({ kind: "create", data: { content: "before one" } });
    local.settings.push(worldSettingsDoc({ clockSeconds: 3599 }));
    expect(content()).toMatchObject({ kind: "create", data: { content: "before one" } });
    const settings = local.settings[0];
    if (!settings) throw new Error("missing clock fixture");
    settings.system.clockSeconds = 3600;
    expect(content()).toMatchObject({ kind: "create", data: { content: "after one" } });
    const pass = fire();
    expect(pass.ok && "plan" in pass ? pass.plan.trace : []).toContain("Check Value time: 60 gte 60 -> pass");
    settings.system.clockSeconds = 86_400;
    expect(content()).toMatchObject({ kind: "create", data: { content: "before one" } });
    settings.system.clockSeconds = 86_400 + 3600;
    expect(content()).toMatchObject({ kind: "create", data: { content: "after one" } });
    settings.system.clockSeconds = "local-time-hint";
    expect(fire()).toMatchObject({ ok: false, error: "invalid committed world clock" });
    for (const value of [-1, 1440, 1.5, "01:00", null]) {
      expect(validateAutomation({ ...def, steps: [{ id: "bad", kind: "checkValue", source: "time",
        compare: "eq", value }] }).ok).toBe(false);
    }
  });

  test("Check Variable has typed order/modulo, null-not-zero semantics and a fail landing", () => {
    const steps: AutomationDefinition["steps"] = [
      { id: "test", kind: "checkVariable", name: "charge", compare: "mod", divisor: 2,
        remainder: 1, otherwise: "failed" },
      { id: "pass", kind: "chat", audience: "gm", content: "odd charge" },
      { id: "done", kind: "stop" },
      { id: "failed", kind: "landing", name: "failed" },
      { id: "fallback", kind: "chat", audience: "gm", content: "other" },
    ];
    const def: AutomationDefinition = { ...base, gates: {}, steps };
    const run = (value?: string | number | boolean, check: AutomationDefinition["steps"][number] = steps[0] as AutomationDefinition["steps"][number]) => {
      const doc = automation({ ...def, steps: [check, ...steps.slice(1)] });
      doc.state = { count: 0, lastAt: 0, byToken: {},
        ...(value === undefined ? {} : { variables: { charge: value } }) };
      return planAutomation(world, doc, { scene, tile, token: runner, method: "enter",
        caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    };
    const message = (result: ReturnType<typeof run>) => result.ok && "plan" in result
      ? (result.plan.ops.find((op) => op.kind === "create") as Extract<(typeof result.plan.ops)[number], { kind: "create" }> | undefined)?.data as MessageDocument | undefined
      : undefined;
    expect(message(run(-3))?.content).toBe("odd charge"); // positive remainder even for negative integers
    expect(message(run(-4))?.content).toBe("other");
    expect(message(run("-3"))?.content).toBe("other"); // strict types
    expect(message(run(undefined, { id: "test", kind: "checkVariable", name: "charge",
      compare: "eq", value: null, otherwise: "failed" }))?.content).toBe("odd charge");
    expect(message(run(undefined, { id: "test", kind: "checkVariable", name: "charge",
      compare: "eq", value: 0, otherwise: "failed" }))?.content).toBe("other");
    expect(message(run(true, { id: "test", kind: "checkVariable", name: "charge",
      compare: "ne", value: false, otherwise: "failed" }))?.content).toBe("odd charge");
    expect(message(run("10", { id: "test", kind: "checkVariable", name: "charge",
      compare: "gte", value: 2, otherwise: "failed" }))?.content).toBe("other");
    const invalid = (check: unknown) => validateAutomation({ ...def, steps: [check] }).ok;
    expect(invalid({ id: "test", kind: "checkVariable", name: "charge", compare: "mod",
      divisor: 0, remainder: 0 })).toBe(false);
    expect(invalid({ id: "test", kind: "checkVariable", name: "charge", compare: "mod",
      divisor: 2, remainder: 2 })).toBe(false);
    expect(invalid({ id: "test", kind: "checkVariable", name: "charge", compare: "gt",
      value: "2" })).toBe(false);
    expect(invalid({ id: "test", kind: "checkVariable", name: "__proto__", compare: "eq",
      value: null })).toBe(false);
    expect(invalid({ id: "test", kind: "checkVariable", name: "charge", compare: "eq",
      value: null, otherwise: "missing" })).toBe(false);
    expect(invalid({ id: "test", kind: "checkVariable", name: "charge", compare: "eq",
      value: null, target: { kind: "tag", query: "(a+)+", pattern: "regex" } })).toBe(false);
  });

  test("Tagger-selected Check Variable reads staged remote states across child graphs atomically", () => {
    const local = structuredClone(scene);
    local.tiles.push({ ...structuredClone(tile), _id: "relay-one", taggerTags: ["relay"], hidden: true });
    local.tiles.push({ ...structuredClone(tile), _id: "relay-two", taggerTags: ["relay"], hidden: true });
    const target = { kind: "tag" as const, query: "relay" };
    const parent = automation({ ...base, gates: {}, steps: [
      { id: "write", kind: "set", name: "charge", value: 3, scope: "tile", target },
      { id: "all", kind: "checkVariable", name: "charge", target, compare: "gte", value: 3 },
      { id: "none", kind: "checkVariable", name: "charge", target, mode: "none", compare: "eq", value: 2 },
      { id: "yes", kind: "chat", audience: "gm", content: "relays charged" },
    ] });
    const child1 = { ...automation({ ...base, tileId: "relay-one", methods: ["manual"], gates: {},
      steps: [{ id: "done", kind: "stop" }] }), _id: "child-one" };
    const child2 = { ...automation({ ...base, tileId: "relay-two", methods: ["manual"], gates: {},
      steps: [{ id: "done", kind: "stop" }] }), _id: "child-two" };
    child2.state = { count: 0, lastAt: 0, byToken: {}, variables: { charge: 2 } };
    const localWorld = emptyWorld(); localWorld.scenes.push(local);
    localWorld.automations.push(parent, child1, child2);
    const rootTile = local.tiles[0];
    if (!rootTile) throw new Error("missing root tile");
    const event = { scene: local, tile: rootTile, token: runner, caller: actor,
      method: "enter" as const, at: 1000, rng: () => 0.25 };
    const result = planAutomation(localWorld, parent, event, "gm");
    if (!result.ok || !("plan" in result)) throw new Error("staged remote Check Variable did not plan");
    expect(result.plan.ops).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "a1" } },
      { kind: "update", ref: { coll: "automations", id: "child-one" }, diff: { state: { variables: { charge: 3 } } } },
      { kind: "update", ref: { coll: "automations", id: "child-two" }, diff: { state: { variables: { charge: 3 } } } },
      { kind: "create", coll: "messages", data: { content: "relays charged" } },
    ]);
    expect(result.plan.trace).toContain("Check Variable charge: 2/2 graph value(s) match (all)");
    expect(result.plan.trace).toContain("Check Variable charge: 0/2 graph value(s) match (none)");
    expect(child2.state.variables?.charge).toBe(2); // planning never mutates source state
    parent.definition.steps = [{ id: "check", kind: "checkVariable", name: "charge", target,
      mode: "any", compare: "eq", value: null }, { id: "no", kind: "chat", audience: "gm", content: "missing" }];
    const missing = planAutomation(localWorld, parent, event, "gm");
    expect(missing.ok && "plan" in missing ? missing.plan.ops.at(-1) : null)
      .toMatchObject({ kind: "create", data: { content: "missing" } }); // child-one is missing, not 0
    parent.definition.steps = [{ id: "check", kind: "checkVariable", name: "charge",
      target: { kind: "tag", query: "nonexistent" }, mode: "none", compare: "eq", value: 3 },
    { id: "no", kind: "chat", audience: "gm", content: "should not fire" }];
    const empty = planAutomation(localWorld, parent, event, "gm");
    expect(empty.ok && "plan" in empty ? empty.plan.ops : []).toHaveLength(1);
    expect(localWorld.scenes[0]?.tiles[1]?.taggerTags).toEqual(["relay"]);
  });

  test("targeted tile variables reject cross-scene/invalid modes and cap tile fanout before any write", () => {
    const target = { kind: "id" as const, tileId: "relay" };
    for (const step of [
      { id: "bad", kind: "set", name: "charge", value: 1, target },
      { id: "bad", kind: "set", name: "charge", value: 1, scope: "run", target },
      { id: "bad", kind: "set", name: "charge", value: 1, scope: "tile", target: { kind: "id", tileId: "other:s1" } },
      { id: "bad", kind: "set", name: "charge", value: 1, scope: "tile", target: { kind: "tag", query: "(a+)+", pattern: "regex" } },
      { id: "bad", kind: "set", name: "charge", value: 1, scope: "tile", target: { kind: "tag", query: "relay",
        includeRefs: [{ coll: "tiles", id: "relay", parent: { coll: "scenes", id: "other" } }] } },
    ]) expect(validateAutomation({ ...base, steps: [step] }).ok).toBe(false);
    const unavailable = plan({ ...base, gates: {}, steps: [
      { id: "set", kind: "set", name: "charge", value: 1, scope: "tile", target },
    ] });
    expect(unavailable).toMatchObject({ ok: false, error: expect.stringMatching(/tile target .* unavailable/) });
    const local = structuredClone(scene);
    local.tiles.push(...Array.from({ length: 33 }, (_, i) => ({ ...structuredClone(tile),
      _id: `relay-${i}`, taggerTags: ["relay"] })));
    const parent = automation({ ...base, gates: {}, steps: [
      { id: "set", kind: "set", name: "charge", value: 1, scope: "tile",
        target: { kind: "tag", query: "relay" } },
    ] });
    const localWorld = emptyWorld(); localWorld.scenes.push(local); localWorld.automations.push(parent);
    const rootTile = local.tiles[0], rootToken = local.tokens[0];
    if (!rootTile || !rootToken) throw new Error("test missing tile/token");
    expect(planAutomation(localWorld, parent, { scene: local, tile: rootTile, token: rootToken,
      method: "enter", caller: actor, at: 1000, rng: () => 0.25 }, "gm"))
      .toMatchObject({ ok: false, error: expect.stringMatching(/fanout exceeds 32/) });
    expect(parent.state).toBeUndefined();
  });

  test("durable variables reject overflow, forged state/fields and reserved event names", () => {
    const plain: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "overflow", kind: "set", scope: "tile", operation: "add", name: "score", value: 1 },
      { id: "unsafe", kind: "chat", audience: "scene", content: "NEVER" },
    ] };
    const doc = automation(plain);
    doc.state = { count: 3, lastAt: 1000, byToken: {}, variables: { score: 1_000_000_000 } };
    const over = planAutomation(world, doc, { scene, tile, method: "enter", token: runner,
      caller: actor, at: 2000, rng: () => 0 }, "gm");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/exceeds its bounds/);
    expect(doc.state).toMatchObject({ count: 3, variables: { score: 1_000_000_000 } });
    expect(validateAutomationState({ ...doc.state, variables: Object.fromEntries(Array.from({ length: 65 },
      (_, i) => [`v${i}`, i])) })).toBe(false);
    expect(validateAutomationState({ ...doc.state, variables: { method: "spoof" } })).toBe(false);
    expect(validateAutomationState({ ...doc.state, variables: { score: Number.POSITIVE_INFINITY } })).toBe(false);
    expect(validateAutomation({ ...plain, steps: [{ id: "bad", kind: "set", name: "method", value: "spoof", scope: "tile" }] }).ok).toBe(false);
    expect(validateAutomation({ ...plain, steps: [{ id: "bad", kind: "set", name: "score", value: "text",
      scope: "tile", operation: "add" }] }).ok).toBe(false);
    expect(validateAutomation({ ...plain, steps: [{ id: "bad", kind: "set", name: "score", value: 1,
      scope: "global" }] }).ok).toBe(false);
    const inheritedName = automation({ ...plain, steps: [
      { id: "safe", kind: "set", scope: "tile", operation: "add", name: "isPrototypeOf", value: 2 },
    ] });
    const own = planAutomation(world, inheritedName, { scene, tile, method: "enter", token: runner,
      caller: actor, at: 2000, rng: () => 0 }, "gm");
    expect(own.ok && "plan" in own ? own.plan.state.variables : null).toEqual({ isPrototypeOf: 2 });
  });

  test("Activate/Deactivate resolves staged Tagger tiles and unpauses a child before a same-plan Trigger Tile", () => {
    const local = structuredClone(scene);
    local.tiles.push({ ...structuredClone(tile), _id: "relay", hidden: true, taggerTags: ["sleep"] });
    const parent = automation({ ...base, gates: {}, steps: [
      { id: "find", kind: "select", selector: { kind: "tag", query: "sleep", collections: ["tiles"] } },
      { id: "rename", kind: "tags", edit: "add", tags: ["wake"] },
      { id: "activate", kind: "setActive", mode: "activate", target: { kind: "tag", query: "wake" } },
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "relay" }, tokens: "triggering" },
    ] });
    const child: AutomationDocument = { ...automation({ ...base, tileId: "relay", methods: ["manual"],
      gates: { paused: true }, steps: [{ id: "notice", kind: "chat", audience: "gm", content: "Child ran" }] }),
    _id: "child" };
    const staged = emptyWorld(); staged.scenes.push(local); staged.automations.push(parent, child);
    const result = planAutomation(staged, parent, { scene: local, tile: local.tiles[0] ?? tile,
      token: runner, method: "enter", caller: actor, at: 1000, rng: () => 0 }, "gm");
    if (!result.ok || !("plan" in result)) throw new Error("staged activation failed");
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "automations"))
      .toMatchObject([
        { ref: { id: "a1" }, diff: { state: { count: 1 } } },
        { ref: { id: "child" }, diff: { definition: { gates: { paused: false } }, state: { count: 1 } } },
      ]);
    expect(result.plan.ops.filter((op) => op.kind === "create")
      .map((op) => (op.data as MessageDocument).content)).toEqual(["Child ran"]);
    expect(result.plan.ops.at(-1)).toMatchObject({ kind: "update", ref: { coll: "tiles", id: "relay" },
      diff: { taggerTags: ["sleep", "wake"] } });
    expect(child.definition.gates?.paused).toBe(true); // pure plan; no host edits before commit
    expect(child.state).toBeUndefined();
    expect(local.tiles[1]?.taggerTags).toEqual(["sleep"]);
  });

  test("deactivating a graph does not interrupt its own fire; toggles coalesce and invalid/fanout targets fail", () => {
    const local = structuredClone(scene);
    const graph = automation({ ...base, gates: {}, steps: [
      { id: "off", kind: "setActive", mode: "deactivate", target: { kind: "id", tileId: "zone" } },
      { id: "last", kind: "chat", audience: "gm", content: "Current fire finishes" },
    ] });
    const staged = emptyWorld(); staged.scenes.push(local); staged.automations.push(graph);
    const event = { scene: local, tile: local.tiles[0] ?? tile, token: runner,
      method: "enter" as const, caller: actor, at: 1000, rng: () => 0 };
    const result = planAutomation(staged, graph, event, "gm");
    if (!result.ok || !("plan" in result)) throw new Error("self-deactivation failed");
    expect(result.plan.ops.filter((op) => op.kind === "update"))
      .toMatchObject([{ ref: { id: "a1" }, diff: { state: { count: 1 }, definition: { gates: { paused: true } } } }]);
    expect(result.plan.ops.filter((op) => op.kind === "create")
      .map((op) => (op.data as MessageDocument).content)).toEqual(["Current fire finishes"]);
    expect(graph.definition.gates?.paused).toBeUndefined();
    const next = planAutomation(staged, { ...graph, definition: { ...graph.definition, gates: { paused: true } } },
      { ...event, at: 2000 }, "gm");
    expect(next.ok && "skipped" in next ? next.skipped : null).toBe("paused");

    const toggle = automation({ ...base, gates: {}, steps: [
      { id: "first", kind: "setActive", mode: "toggle", target: { kind: "id", tileId: "zone" } },
      { id: "again", kind: "setActive", mode: "toggle", target: { kind: "id", tileId: "zone" } },
    ] });
    const repeated = planAutomation(staged, toggle, event, "gm");
    expect(repeated.ok && "plan" in repeated ? repeated.plan.ops : null)
      .toMatchObject([{ kind: "update", diff: { definition: { gates: { paused: false } }, state: { count: 1 } } }]);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "setActive", mode: "override",
      target: { kind: "id", tileId: "zone" } }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "setActive", mode: "activate",
      target: { kind: "id", tileId: "zone", privileged: true } }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "bad", kind: "setActive", mode: "activate",
      target: { kind: "tag", query: "*", pattern: "wildcard", includeRefs: [
        { coll: "tiles", id: "outside", parent: { coll: "scenes", id: "other" } },
      ] } }] }).ok).toBe(false);
    const missing = automation({ ...base, gates: {}, steps: [
      { id: "missing", kind: "setActive", mode: "activate", target: { kind: "id", tileId: "absent" } },
    ] });
    expect(planAutomation(staged, missing, event, "gm")).toMatchObject({ ok: false,
      error: expect.stringContaining("absent") });
    const crowded = structuredClone(local);
    crowded.tiles.push(...Array.from({ length: 33 }, (_, i) => ({ ...structuredClone(tile),
      _id: `match-${i}`, taggerTags: ["match"] })));
    const oversized = automation({ ...base, gates: {}, steps: [
      { id: "wide", kind: "setActive", mode: "activate", target: { kind: "tag", query: "match" } },
    ] });
    const crowdedWorld = emptyWorld(); crowdedWorld.scenes.push(crowded); crowdedWorld.automations.push(oversized);
    expect(planAutomation(crowdedWorld, oversized, { ...event, scene: crowded, tile: crowded.tiles[0] ?? tile }, "gm"))
      .toMatchObject({ ok: false, error: expect.stringContaining("32 tiles") });
  });

  test("Stop Additional Tiles Triggering records a post-commit suppression signal", () => {
    const result = plan({ ...base, steps: [{ id: "stop-other", kind: "stopOthers" }] });
    expect(result.ok && "plan" in result ? result.plan.stopOthers : false).toBe(true);
    expect(result.ok && "plan" in result ? result.plan.ops : []).toHaveLength(1);
  });
});

describe("MATT Hurt / Heal planning", () => {
  const healActor: ActorDocument = { _id: "health", type: "actor", name: "Health",
    ownership: { default: 0 }, flags: {}, system: { hp: 10 }, items: [], effects: [] };
  test("validates fixed authored amount and token targets, never evaluates expressions", () => {
    for (const amount of [0, 0.5, Infinity, NaN, 100_001, -100_001, "-1d6"]) {
      expect(validateAutomation({ ...base, steps: [{ id: "hurt", kind: "hurtHeal", amount,
        targets: "triggering" }] }).ok).toBe(false);
    }
    expect(validateAutomation({ ...base, steps: [{ id: "hurt", kind: "hurtHeal", amount: -5,
      targets: "GM-controlled" }] }).ok).toBe(false);
    expect(validateAutomation({ ...base, steps: [{ id: "hurt", kind: "hurtHeal", amount: 5,
      targets: "current" }] }).ok).toBe(true);
  });

  test("two steps and shared linked tokens read staged HP, hit once per actor, and leave the host world unmutated", () => {
    const linked = { ...scene, tokens: scene.tokens.map((t) => ({ ...t, actorId: "health" })) };
    const w = emptyWorld(); w.scenes.push(linked); w.actors.push(healActor);
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "select", kind: "select", selector: { kind: "tag", query: "hurt", collections: ["tokens"] } },
      { id: "heal", kind: "hurtHeal", amount: 5, targets: "current" },
      { id: "hurt", kind: "hurtHeal", amount: -3, targets: "triggering" },
    ] };
    linked.tokens.forEach((token) => { token.taggerTags = ["hurt"]; });
    const actorHp: number[] = [];
    const first = linked.tokens[0];
    if (!first) throw new Error("missing linked token");
    const plan = planAutomation(w, automation(def), { scene: linked, tile, token: first,
      method: "enter", caller: actor, at: 1000, rng: () => 0.5,
      hurtHeal: (target, amount) => {
        const hp = target.system.hp as number;
        actorHp.push(hp);
        return { ok: true, diff: { "system.hp": hp + amount }, note: "staged" };
      },
    }, "gm");
    expect(plan.ok).toBe(true);
    if (!plan.ok || !("plan" in plan)) return;
    expect(actorHp).toEqual([10, 15]); // current targets contain two linked tokens; one actor write
    expect(plan.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "actors"))
      .toMatchObject([{ diff: { "system.hp": 15 } }, { diff: { "system.hp": 12 } }]);
    expect(w.actors[0]?.system.hp).toBe(10);
  });

  test("missing actor/health adapter fails the entire plan before committing history", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "hurt", kind: "hurtHeal", amount: -5, targets: "triggering" },
    ] };
    expect(planAutomation(world, automation(def), { scene, tile, token: runner, method: "enter",
      caller: actor, at: 1000, rng: () => 0.5 }, "gm")).toMatchObject({ ok: false });
  });
});

describe("MATT Move / Rotation / Delete Entities / Roll Table actions", () => {
  const fire = (def: AutomationDefinition, at = 1000,
    rng: () => number = () => 0.25) => planAutomation(world, automation(def),
    { scene, tile, token: runner, method: "enter", caller: actor, at, rng }, "gm");

  test("publish validation rejects malformed Move, Rotation, Delete and Roll Table steps", () => {
    const def = (steps: AutomationDefinition["steps"]): AutomationDefinition =>
      ({ ...base, gates: {}, steps });
    for (const bad of [
      { id: "m", kind: "move", x: Number.NaN, y: 10, targets: "current" },
      { id: "m", kind: "move", x: 10, y: -1, targets: "current" },
      { id: "m", kind: "move", x: 10, y: 10, targets: "all" },
      { id: "m", kind: "move", x: 10, targets: "current" },
      { id: "r", kind: "rotate", angle: Number.NaN, targets: "current" },
      { id: "r", kind: "rotate", angle: 1e7, targets: "current" },
      { id: "r", kind: "rotate", angle: 90, targets: "player" },
      { id: "d", kind: "delete", extra: true },
      { id: "t", kind: "rollTable", tableId: "has space", audience: "scene" },
      { id: "t", kind: "rollTable", tableId: "t1", audience: "player" },
      { id: "t", kind: "rollTable", tableId: "t1", audience: "scene", variable: "count" },
      { id: "t", kind: "rollTable", tableId: "t1", audience: "scene", variable: "bad name" },
    ]) expect(validateAutomation(def([bad as never])).ok).toBe(false);
    for (const good of [
      { id: "m", kind: "move", x: 0, y: 0, targets: "triggering" },
      { id: "r", kind: "rotate", angle: -359, targets: "current" },
      { id: "d", kind: "delete" },
      { id: "t", kind: "rollTable", tableId: "t1", audience: "gm" },
    ]) expect(validateAutomation(def([good as never])).ok).toBe(true);
  });

  test("Move repositions the current collection with one host update op per token, in-scene only", () => {
    const def: AutomationDefinition = { ...base, gates: {}, methods: ["click"], steps: [
      { id: "select", kind: "select", selector: { kind: "inside" } },
      { id: "move", kind: "move", x: 400, y: 400, targets: "current" },
    ] };
    const fired = planAutomation(world, automation(def), { scene, tile, method: "click",
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(fired.ok).toBe(true);
    if (!fired.ok || !("plan" in fired)) return;
    expect(fired.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens"))
      .toEqual([
        { kind: "update", ref: { coll: "tokens", id: "runner", parent: { coll: "scenes", id: "s1" } }, diff: { x: 400, y: 400 } },
        { kind: "update", ref: { coll: "tokens", id: "gate", parent: { coll: "scenes", id: "s1" } }, diff: { x: 400, y: 400 } },
      ]);
    expect(scene.tokens[0]?.x).toBe(150); // the staged clone moved, the committed world did not
    const outside = fire({ ...def, methods: ["enter"], steps: [
      { id: "move", kind: "move", x: 501, y: 400, targets: "triggering" } ] });
    expect(outside).toMatchObject({ ok: false, error: expect.stringMatching(/outside the 500x500 scene/) });
    const same = fire({ ...def, methods: ["enter"], steps: [
      { id: "move", kind: "move", x: 150, y: 150, targets: "triggering" } ] });
    if (same.ok && "plan" in same) {
      expect(same.plan.ops.some((op) => op.kind === "update" && op.ref.coll === "tokens")).toBe(false);
    } else {
      throw new Error("an unchanged position must plan, not fail");
    }
  });

  test("Move with no live target token fails closed, including after its own delete", () => {
    const noTokens = fire({ ...base, steps: [
      { id: "move", kind: "move", x: 100, y: 100, targets: "current" },
    ] });
    // current starts as the triggering token, so this still has a target:
    expect(noTokens.ok).toBe(true);
    const deletedFirst = fire({ ...base, steps: [
      { id: "select", kind: "select", selector: { kind: "triggering" } },
      { id: "delete", kind: "delete" },
      { id: "move", kind: "move", x: 100, y: 100, targets: "triggering" },
    ] });
    expect(deletedFirst).toMatchObject({ ok: false, error: expect.stringMatching(/live target token/) });
    const clicked = planAutomation(world, automation({ ...base, gates: {}, methods: ["click"], steps: [
      { id: "move", kind: "move", x: 100, y: 100, targets: "current" },
    ] }), { scene, tile, method: "click", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(clicked).toMatchObject({ ok: false, error: expect.stringMatching(/live target token/) });
  });

  test("Rotation normalizes to 0-360 and commits one rotation op per token", () => {
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "select", kind: "select", selector: { kind: "inside" } },
      { id: "spin", kind: "rotate", angle: 450, targets: "current" },
    ] };
    const fired = planAutomation(world, automation(def), { scene, tile, method: "click",
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    if (!fired.ok || !("plan" in fired)) throw new Error("rotation must plan");
    expect(fired.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens"))
      .toMatchObject([
        { ref: { id: "runner" }, diff: { rotation: 90 } },
        { ref: { id: "gate" }, diff: { rotation: 90 } },
      ]);
    const negative = fire({ ...base, steps: [
      { id: "spin", kind: "rotate", angle: -90, targets: "triggering" } ] });
    if (negative.ok && "plan" in negative) {
      expect(negative.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tokens"))
        .toMatchObject([{ ref: { id: "runner" }, diff: { rotation: 270 } }]);
    } else {
      throw new Error("negative angle must normalize to 270");
    }
    const wallsOnly = fire({ ...base, steps: [
      { id: "select", kind: "select", selector: { kind: "tile" } },
      { id: "spin", kind: "rotate", angle: 45, targets: "current" },
    ] });
    expect(wallsOnly).toMatchObject({ ok: false, error: expect.stringMatching(/live target token/) });
  });

  test("Delete Entities removes the staged placeables, commits delete ops and empties the collection", () => {
    const def: AutomationDefinition = { ...base, gates: {}, methods: ["click"], steps: [
      { id: "select", kind: "select", selector: { kind: "inside" } },
      { id: "delete", kind: "delete" },
      { id: "notice", kind: "chat", audience: "gm", content: "swept" },
    ] };
    const fired = planAutomation(world, automation(def), { scene, tile, method: "click",
      caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    if (!fired.ok || !("plan" in fired)) throw new Error("delete must plan");
    expect(fired.plan.ops.filter((op) => op.kind === "delete")).toEqual([
      { kind: "delete", ref: { coll: "tokens", id: "runner", parent: { coll: "scenes", id: "s1" } } },
      { kind: "delete", ref: { coll: "tokens", id: "gate", parent: { coll: "scenes", id: "s1" } } },
    ]);
    expect(fired.plan.trace.some((line) => line.startsWith("delete 2 placeable(s): runner, gate"))).toBe(true);
    expect(scene.tokens).toHaveLength(2); // committed world untouched until the host commits
    const emptyAgain = planAutomation(world, automation({ ...def, steps: [
      { id: "select", kind: "select", selector: { kind: "inside" } },
      { id: "delete", kind: "delete" },
      { id: "delete2", kind: "delete" },
    ] }), { scene, tile, method: "click", caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    expect(emptyAgain).toMatchObject({ ok: false, error: expect.stringMatching(/non-empty/) });
  });

  test("Delete Entities removes walls, drawings and notes, and refuses collections it cannot remove", () => {
    const withWall: SceneDocument = { ...scene, walls: [{ _id: "w1", type: "wall", name: "w1",
      ownership: { default: 0 }, flags: {}, system: {}, taggerTags: ["wall-x"],
      c: [0, 0, 200, 0], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0 }],
      drawings: [{ _id: "d1", type: "drawing", name: "d1", ownership: { default: 0 }, flags: {}, system: {},
        taggerTags: ["draw-x"], kind: "line", points: [0, 0, 10, 0], box: null,
        stroke: "#000", fill: "#000", strokeWidth: 1, text: null }],
      notes: [{ _id: "n1", type: "note", name: "n1", ownership: { default: 0 }, flags: {}, system: {},
        taggerTags: ["note-x"], x: 0, y: 0, text: "pin", icon: "", visible: true }],
      lights: [{ _id: "l1", type: "light", name: "l1", ownership: { default: 0 }, flags: {}, system: {},
        taggerTags: ["light-x"], x: 0, y: 0, color: "#fff", alpha: 0.5, bright: 10, dim: 20 }] };
    const fireIn = (query: string, collections: Array<"walls" | "drawings" | "notes" | "lights">) => {
      const w = emptyWorld(); w.scenes.push(withWall);
      const def: AutomationDefinition = { ...base, gates: {}, steps: [
        { id: "select", kind: "select", selector: { kind: "tag", query, collections } },
        { id: "delete", kind: "delete" },
      ] };
      return planAutomation(w, automation(def), { scene: withWall, tile, method: "click",
        caller: actor, at: 1000, rng: () => 0.25 }, "gm");
    };
    for (const [query, coll, id] of [["wall-x", "walls", "w1"], ["draw-x", "drawings", "d1"],
      ["note-x", "notes", "n1"]] as Array<[string, "walls" | "drawings" | "notes", string]>) {
      const fired = fireIn(query, [coll]);
      if (!fired.ok || !("plan" in fired)) throw new Error(`${query} delete must plan`);
      expect(fired.plan.ops.filter((op) => op.kind === "delete"))
        .toEqual([{ kind: "delete", ref: { coll, id, parent: { coll: "scenes", id: "s1" } } }]);
    }
    const refused = fireIn("light-x", ["lights"]);
    expect(refused).toMatchObject({ ok: false,
      error: expect.stringMatching(/only removes tokens, tiles, walls, drawings or map pins/) });
  });

  test("Roll Table posts a host roll to the audience, stores the optional variable and branches on it", () => {
    const table = { _id: "t1", type: "rollTable" as const, name: "events", ownership: { default: 1 as const },
      flags: {}, system: {}, formula: "1d20",
      results: [
        { range: [1, 10] as [number, number], text: "safe", documentRef: null },
        { range: [11, 20] as [number, number], text: "danger", documentRef: null },
      ] };
    const tableWorld = () => { const w = emptyWorld(); w.scenes.push(scene); w.rollTables.push(table); return w; };
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "roll", kind: "rollTable", tableId: "t1", audience: "scene", variable: "loot" },
      { id: "if", kind: "filter", test: { kind: "variable", name: "loot", equals: "danger" }, otherwise: "else" },
      { id: "hit", kind: "chat", audience: "gm", content: "branch: {{loot}}" },
      { id: "done", kind: "stop" },
      { id: "else", kind: "landing", name: "else" },
      { id: "miss", kind: "chat", audience: "gm", content: "else: {{loot}}" },
    ] };
    const fired = planAutomation(tableWorld(), automation(def), { scene, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0.6 }, "gm"); // 1d20 -> 13 -> danger
    if (!fired.ok || !("plan" in fired)) throw new Error("roll table must plan");
    const messages = fired.plan.ops.filter((op) => op.kind === "create" && op.coll === "messages")
      .map((op) => (op as Extract<typeof op, { kind: "create" }>).data as MessageDocument);
    expect(messages.find((msg) => msg.name === "Roll table: events"))
      .toMatchObject({ content: "danger", whisper: [], roll: { formula: "1d20", total: 13 } });
    expect(messages.filter((msg) => msg.content === "branch: danger")).toHaveLength(1);
    expect(messages.some((msg) => msg.content === "else: danger")).toBe(false);
    const safe = planAutomation(tableWorld(), automation(def), { scene, tile, token: runner,
      method: "enter", caller: actor, at: 1000, rng: () => 0.2 }, "gm"); // 1d20 -> 5 -> safe
    if (!safe.ok || !("plan" in safe)) throw new Error("safe roll must plan through the else landing");
    const safeMessages = safe.plan.ops.filter((op) => op.kind === "create" && op.coll === "messages")
      .map((op) => (op as Extract<typeof op, { kind: "create" }>).data as MessageDocument);
    expect(safeMessages.find((msg) => msg.name === "Roll table: events"))
      .toMatchObject({ content: "safe", roll: { formula: "1d20", total: 5 } });
    expect(safeMessages.filter((msg) => msg.content === "else: safe")).toHaveLength(1);
    const missing = planAutomation(tableWorld(), automation({ ...def, steps: [
      { id: "roll", kind: "rollTable", tableId: "nope", audience: "scene" } ] }),
      { scene, tile, token: runner, method: "enter", caller: actor, at: 1000, rng: () => 0.2 }, "gm");
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/missing from the world/) });
    const broken = emptyWorld();
    broken.scenes.push(scene);
    broken.rollTables.push({ _id: "t2", type: "rollTable", name: "broken", ownership: { default: 1 },
      flags: {}, system: {}, formula: "1d20",
      results: [
        { range: [1, 10] as [number, number], text: "a", documentRef: null },
        { range: [10, 20] as [number, number], text: "b", documentRef: null },
      ] });
    const invalid = planAutomation(broken, automation({ ...def, steps: [
      { id: "roll", kind: "rollTable", tableId: "t2", audience: "scene" } ] }),
      { scene, tile, token: runner, method: "enter", caller: actor, at: 1000, rng: () => 0.2 }, "gm");
    expect(invalid).toMatchObject({ ok: false, error: expect.stringMatching(/overlaps/) });
  });

  test("Roll Table misses post the roll with no result, and an oversized result refuses the variable", () => {
    const w = emptyWorld();
    w.scenes.push(scene);
    w.rollTables.push({ _id: "sparse", type: "rollTable", name: "sparse", ownership: { default: 1 },
      flags: {}, system: {}, formula: "1d20",
      results: [{ range: [10, 20] as [number, number], text: "late", documentRef: null }] });
    const def: AutomationDefinition = { ...base, gates: {}, steps: [
      { id: "roll", kind: "rollTable", tableId: "sparse", audience: "gm", variable: "loot" },
      { id: "chat", kind: "chat", audience: "gm", content: "loot: {{loot}}" },
    ] };
    const missed = planAutomation(w, automation(def), { scene, tile, token: runner, method: "enter",
      caller: actor, at: 1000, rng: () => 0.05 }, "gm"); // 1d20 -> 2, never in [10,20]
    if (!missed.ok || !("plan" in missed)) throw new Error("a miss must still plan");
    const tableMsg = missed.plan.ops.find((op) => op.kind === "create" && op.coll === "messages"
      && (op.data as MessageDocument).name === "Roll table: sparse");
    expect(tableMsg && (tableMsg as Extract<typeof missed.plan.ops[number], { kind: "create" }>).data)
      .toMatchObject({ content: "(no matching result)", roll: null, whisper: ["gm"] });
    const chatMsg = missed.plan.ops.find((op) => op.kind === "create" && op.coll === "messages"
      && (op.data as MessageDocument).name !== "Roll table: sparse");
    expect(chatMsg && (chatMsg as Extract<typeof missed.plan.ops[number], { kind: "create" }>).data)
      .toMatchObject({ content: "loot: " });
    const big = emptyWorld();
    big.scenes.push(scene);
    big.rollTables.push({ _id: "big", type: "rollTable", name: "big", ownership: { default: 1 },
      flags: {}, system: {}, formula: "1d20",
      results: [{ range: [1, 20] as [number, number], text: "x".repeat(257), documentRef: null }] });
    const oversized = planAutomation(big, automation({ ...def, steps: [
      { id: "roll", kind: "rollTable", tableId: "big", audience: "scene", variable: "loot" } ] }),
      { scene, tile, token: runner, method: "enter", caller: actor, at: 1000, rng: () => 0.5 }, "gm");
    expect(oversized).toMatchObject({ ok: false, error: expect.stringMatching(/256-character variable bound/) });
  });
});
