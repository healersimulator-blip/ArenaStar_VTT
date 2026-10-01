import { describe, expect, test } from "vitest";
import type { AutomationDocument, SceneDocument, TileDocument, TokenDocument, WallDocument } from "../../src/core/documents";
import { DocumentStore } from "../../src/core/store";
import { attachedDeletionOps, attachedMovementOps, planPrefabPlacement, validatePrefab,
  type PrefabDefinition } from "../../src/core/prefabs";
import { emptyWorld } from "../net/fixtures";

const tile = (): TileDocument => ({ _id: "tile-a", type: "tile", name: "Trap", flags: {}, system: {},
  ownership: { default: 2 }, x: 100, y: 100, width: 200, height: 200, rotation: 0, hidden: false,
  img: "", above: false, occlusion: { mode: "roof", alpha: 0.5 }, taggerTags: ["trap-{#}"] });
const wall = (): WallDocument => ({ _id: "wall-a", type: "wall", name: "Secret door", flags: {}, system: {},
  ownership: { default: 0 }, taggerTags: ["door-{#}"], c: [200, 100, 300, 100],
  door: 0, oneWay: false, move: 1, sight: 1, sound: 1, light: 1 });
const token = (): TokenDocument => ({ _id: "child-a", type: "token", name: "Guard", flags: {}, system: {},
  ownership: { default: 0 }, taggerTags: ["guard-{id}"], x: 170, y: 170, width: 40, height: 40,
  rotation: 0, hidden: true, img: "", disposition: "hostile", vision: false,
  light: { radius: 0, color: "#ffffff", alpha: 0 } });
const graph = (): AutomationDocument => ({ _id: "graph-a", type: "automation", name: "Open own door",
  ownership: { default: 0 }, flags: {}, system: {}, definition: {
    version: 1, sceneId: "s1", tileId: "tile-a", methods: ["click"], gates: { playerRunnable: true },
    steps: [{ id: "find", kind: "select", selector: { kind: "tag", query: "door-{#}",
      collections: ["walls"], includeRefs: [{ coll: "walls", id: "wall-a", parent: { coll: "scenes", id: "s1" } }] } },
    { id: "open", kind: "door", mode: "open" }],
  } });
const scene = (): SceneDocument => ({ _id: "s1", type: "scene", name: "Scene", ownership: { default: 2 },
  flags: {}, system: {}, active: true, img: null, width: 2000, height: 1500, darkness: 0,
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  tokens: [], walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [] });
const def = (): PrefabDefinition => ({ version: 1, sourceSceneId: "s1", gridSize: 100,
  origin: { x: 100, y: 100 }, parts: [
    { id: "tile-a", coll: "tiles", doc: tile() },
    { id: "wall-a", coll: "walls", parentId: "tile-a", locked: true, doc: wall() },
    { id: "child-a", coll: "tokens", parentId: "wall-a", doc: token() },
  ], graphs: [{ id: "graph-a", doc: graph() }] });
const ids = (prefix = "fresh") => { let i = 0; return () => `${prefix}_${++i}`; };

describe("GM-owned prefab planner and transaction", () => {
  test("prefab Roll Table location remains an invocation result, not a rebound or captured coordinate",()=>{
    const world=emptyWorld();world.scenes.push({...scene(),_id:"s2"});
    const template=def(),graph=template.graphs[0]?.doc;if(!graph)throw new Error("missing graph");
    graph.definition.steps=[{id:"roll",kind:"rollTable",tableId:"locations",audience:"gm"},
      {id:"move",kind:"move",destinationResult:"rollTable",x:25,y:-25,targets:"triggering"}];
    const before=structuredClone(template);
    for(const prefix of ["first","second"]) {
      const placed=planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids(prefix));if(!placed.ok)throw new Error(placed.error);
      expect(placed.plan.ops.at(-1)).toMatchObject({data:{definition:{sceneId:"s2",tileId:placed.plan.ids["tile-a"],steps:graph.definition.steps}}});
    }
    expect(template).toEqual(before);
  });

  test("prefab preserves Stop Token Movement and Original Destination policies without a captured movement context",()=>{
    const world=emptyWorld();world.scenes.push({...scene(),_id:"s2"});const template=def(),graph=template.graphs[0]?.doc;if(!graph)throw new Error("missing graph");
    graph.definition.methods=["enter"];graph.definition.steps=[{id:"stop",kind:"stopMovement",snapToGrid:true},
      {id:"continue",kind:"move",destinationOriginal:true,x:25,y:-25,targets:"triggering"}];const before=structuredClone(template);
    for(const prefix of ["first","second"]){const result=planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids(prefix));if(!result.ok)throw new Error(result.error);
      expect(result.plan.ops.at(-1)).toMatchObject({data:{definition:{sceneId:"s2",tileId:result.plan.ids["tile-a"],steps:[{kind:"stopMovement",snapToGrid:true},{destinationOriginal:true,x:25,y:-25}]}}});}
    expect(template).toEqual(before);
  });

  test("prefab Original Destination policy remains invocation context, never a captured point",()=>{
    const world=emptyWorld();world.scenes.push({...scene(),_id:"s2"});const template=def(),graph=template.graphs[0]?.doc;if(!graph)throw new Error("missing graph");
    graph.definition.methods=["enter"];graph.definition.steps=[{id:"move",kind:"move",destinationOriginal:true,x:25,y:-25,targets:"triggering"}];const before=structuredClone(template);
    for(const prefix of ["first","second"]){const result=planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids(prefix));if(!result.ok)throw new Error(result.error);
      expect(result.plan.ops.at(-1)).toMatchObject({data:{definition:{sceneId:"s2",tileId:result.plan.ids["tile-a"],steps:[{destinationOriginal:true,x:25,y:-25}]}}});}
    expect(template).toEqual(before);
  });

  test.each(["random","entry"] as const)("prefab entity destination retains %s policy and clone reference",(position)=>{
    const world=emptyWorld();world.scenes.push({...scene(),_id:"s2"});
    const template=def(),graph=template.graphs[0]?.doc;if(!graph)throw new Error("missing graph");
    graph.definition.methods=["enter"];graph.definition.steps=[{id:"move",kind:"move",x:0,y:0,targets:"triggering",destinationPosition:position,destination:{coll:"tiles",id:"tile-a"}}];
    const before=structuredClone(template);
    for(const prefix of ["first","second"]){
      const result=planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids(prefix));if(!result.ok)throw new Error(result.error);
      expect(result.plan.ops.at(-1)).toMatchObject({data:{definition:{methods:["enter"],tileId:result.plan.ids["tile-a"],steps:[{destinationPosition:position,destination:{coll:"tiles",id:result.plan.ids["tile-a"]}}]}}});
    }
    expect(template).toEqual(before);
  });

  test.each(["entity","tag"] as const)("prefab %s destination keeps explicit random placement/choice policy and clone references",(source)=>{
    const world=emptyWorld();world.scenes.push({...scene(),_id:"s2"});
    const template=def(),graph=template.graphs[0]?.doc;if(!graph)throw new Error("missing graph");
    graph.definition.steps=[{id:"move",kind:"move",x:0,y:0,targets:"triggering",destinationPosition:"random",
      ...(source==="entity"?{destination:{coll:"tiles",id:"tile-a"}}:{destinationTag:{kind:"tag",query:"trap-{#}",collections:["tiles"]},destinationChoice:"random"})}];
    const before=structuredClone(template);
    for(const prefix of ["first","second"]){
      const result=planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids(prefix));if(!result.ok)throw new Error(result.error);
      expect(result.plan.ops.at(-1)).toMatchObject({data:{definition:{steps:[{destinationPosition:"random",...(source==="entity"?
        {destination:{coll:"tiles",id:result.plan.ids["tile-a"]}}:{destinationChoice:"random",destinationTag:{query:"trap-1"}})}]}}});
    }
    expect(template).toEqual(before);
  });

  test.each(["tiles","tokens"] as const)("Move live tag destination templates rebind %s tags and ref filters for two clones",(coll)=>{
    const world=emptyWorld();world.scenes.push({...scene(),_id:"s2"});
    const template=def(),source=template.graphs[0]?.doc;if(!source)throw new Error("missing graph");
    const query=coll==="tiles"?"trap-{#}":"guard-{id}",id=coll==="tiles"?"tile-a":"child-a";
    source.definition.steps=[{id:"move",kind:"move",destinationTag:{kind:"tag",query,
      includeRefs:[{coll,id,parent:{coll:"scenes",id:"s1"}}]},x:0,y:0,targets:"triggering"}];
    const before=structuredClone(template);
    for(const prefix of ["first","second"]) {
      const result=planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids(prefix));if(!result.ok)throw new Error(result.error);
      const mapped=result.plan.ids[id];
      expect(result.plan.ops.at(-1)).toMatchObject({kind:"create",coll:"automations",data:{definition:{steps:[{
        destinationTag:{query:coll==="tiles"?"trap-1":`guard-${mapped}`,collections:["tokens","tiles"],
          includeRefs:[{coll,id:mapped,parent:{coll:"scenes",id:"s2"}}]}
      }]}}});
    }
    expect(template).toEqual(before);
    const move=source.definition.steps[0];if(move?.kind!=="move"||!move.destinationTag)throw new Error("missing move");
    move.destinationTag.includeRefs=[{coll,id:"external",parent:{coll:"scenes",id:"s1"}}];
    expect(planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids())).toMatchObject({ok:false,error:expect.stringContaining("Move destination tag")});
    move.destinationTag.includeRefs=[];move.destinationTag.query="unknown-{#}";
    expect(planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids())).toMatchObject({ok:false,error:expect.stringContaining("Move destination tag")});
  });

  test.each(["tiles","tokens"] as const)("Move %s destinations rebind to each clone and external IDs fail", (coll) => {
    const world=emptyWorld();world.scenes.push({...scene(),_id:"s2"});
    const template=def(),source=template.graphs[0]?.doc;if(!source)throw new Error("missing graph");
    const id=coll==="tiles"?"tile-a":"child-a";
    source.definition.steps=[{id:"move",kind:"move",destination:{coll,id},x:0,y:0,targets:"triggering"}];
    for(const prefix of ["first","second"]) {
      const result=planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids(prefix));
      if(!result.ok)throw new Error(result.error);
      const part=result.plan.ops.find((op)=>op.kind==="create"&&op.coll===coll);
      if(!part||part.kind!=="create")throw new Error("missing clone part");
      expect(result.plan.ops.at(-1)).toMatchObject({kind:"create",coll:"automations",data:{definition:{steps:[{destination:{coll,id:part.data._id}}]}}});
    }
    expect(source.definition.steps[0]).toMatchObject({destination:{coll,id}});
    source.definition.steps=[{id:"move",kind:"move",destination:{coll,id:"external"},x:0,y:0,targets:"triggering"}];
    expect(planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids())).toMatchObject({ok:false,error:expect.stringContaining("dangling Move destination")});
  });

  test.each(["select","collection"] as const)("pinned %s references rebind in each clone, external/wrong-type refs fail closed",(kind)=>{
    const world=emptyWorld();world.scenes.push({...scene(),_id:"s2"});
    const template=def(),source=template.graphs[0]?.doc;if(!source)throw new Error("missing graph");
    const selector={kind:"ids" as const,refs:[{coll:"walls" as const,id:"wall-a",parent:{coll:"scenes" as const,id:"s1"}}]};
    source.definition.steps=[kind==="select"?{id:"pin",kind,selector}:{id:"pin",kind,mode:"replace",selector}];
    const before=structuredClone(template);
    for(const prefix of ["first","second"]){
      const result=planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids(prefix));if(!result.ok)throw new Error(result.error);
      const id=result.plan.ids["wall-a"];
      expect(result.plan.ops.at(-1)).toMatchObject({kind:"create",coll:"automations",data:{definition:{steps:[{selector:{kind:"ids",refs:[{coll:"walls",id,parent:{coll:"scenes",id:"s2"}}]}}]}}});
    }
    expect(template).toEqual(before);
    for(const id of ["external","child-a"]){
      selector.refs[0]={coll:"walls",id,parent:{coll:"scenes",id:"s1"}};
      expect(planPrefabPlacement(world,template,"s2",{at:{x:500,y:500}},ids())).toMatchObject({ok:false,error:expect.stringContaining("dangling pinned entity")});
    }
  });

  test("explicit local background targets rebind to the placement scene; external targets fail closed", () => {
    const world = emptyWorld(); world.scenes.push({ ...scene(), _id: "s2" });
    const template = def(); const graph = template.graphs[0]?.doc;
    if (!graph) throw new Error("missing fixture graph");
    graph.definition.steps = [{ id: "bg", kind: "sceneBackground", image: null, targetSceneId: "s1" }];
    const placed = planPrefabPlacement(world, template, "s2", { at: { x: 500, y: 500 } }, ids());
    if (!placed.ok) throw new Error(placed.error);
    expect(placed.plan.ops.at(-1)).toMatchObject({ kind: "create", coll: "automations", data: {
      definition: { sceneId: "s2", steps: [{ targetSceneId: "s2" }] },
    } });
    expect(graph.definition.steps[0]).toMatchObject({ targetSceneId: "s1" });
    graph.definition.steps = [{ id: "bg", kind: "sceneBackground", image: null, targetSceneId: "external" }];
    expect(planPrefabPlacement(world, template, "s2", { at: { x: 500, y: 500 } }, ids()))
      .toMatchObject({ ok: false, error: expect.stringMatching(/external Scene Background target/) });
  });

  test("allocates scene-unique {#} and per-part {id}, binds refs, retains nested private children, never mutates source", () => {
    const world = emptyWorld();
    const sc = scene();
    sc.walls.push({ ...wall(), _id: "other", taggerTags: ["door-1"] });
    world.scenes.push(sc);
    const template = def();
    expect(validatePrefab(template).ok).toBe(true);
    const first = planPrefabPlacement(world, template, "s1", { at: { x: 500, y: 500 } }, ids());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.plan.ops).toHaveLength(4);
    const firstTile = first.plan.ops[0];
    const firstDoor = first.plan.ops[1];
    const firstToken = first.plan.ops[2];
    const firstGraph = first.plan.ops[3];
    if (firstTile?.kind !== "create" || firstDoor?.kind !== "create" ||
        firstToken?.kind !== "create" || firstGraph?.kind !== "create") throw new Error("wrong operations");
    expect(firstTile.data).toMatchObject({ _id: "fresh_2", x: 500, y: 500, taggerTags: ["trap-2"] });
    expect(firstDoor.data).toMatchObject({ _id: "fresh_3", c: [600, 500, 700, 500], taggerTags: ["door-2"],
      flags: { prefab: { instanceId: "fresh_1", rootId: "fresh_2", parentId: "fresh_2", locked: true } } });
    expect(firstToken.data).toMatchObject({ _id: "fresh_4", hidden: true, taggerTags: ["guard-fresh_4"],
      flags: { prefab: { parentId: "fresh_3" } } });
    expect((firstGraph.data as AutomationDocument).definition).toMatchObject({ sceneId: "s1", tileId: "fresh_2" });
    expect((firstGraph.data as AutomationDocument).definition.steps[0]).toMatchObject({
      selector: { query: "door-2", includeRefs: [{ coll: "walls", id: "fresh_3",
        parent: { coll: "scenes", id: "s1" } }] } });
    expect((firstGraph.data as AutomationDocument).state).toBeUndefined();
    expect(template.parts[1]?.doc._id).toBe("wall-a");
    const store = new DocumentStore({ meta: { worldId: "w", name: "w", system: "s", systemVersion: "1" } });
    expect(store.applyEnvelope({ seq: 1, ts: 1, by: "gm", txId: "seed", ops: [
      { kind: "create", coll: "scenes", data: sc },
    ] }).ok).toBe(true);
    expect(store.applyEnvelope({ seq: 2, ts: 2, by: "gm", txId: "first", ops: first.plan.ops }).ok).toBe(true);
    const second = planPrefabPlacement(store.world, template, "s1", { at: { x: 900, y: 700 } }, ids("again"));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.plan.tags).toContain("door-3");
    expect(((second.plan.ops[3] as Extract<(typeof second.plan.ops)[number], { kind: "create" }>).data as AutomationDocument)
      .definition.steps[0]).toMatchObject({ selector: { query: "door-3" } });
    expect(store.applyEnvelope({ seq: 3, ts: 3, by: "gm", txId: "second", ops: second.plan.ops }).ok).toBe(true);
    expect(store.get("scenes", "s1")?.walls).toHaveLength(3);
  });

  test("prefab rebinding includes collection selectors and nested Trigger Tile IDs/tag refs across copies", () => {
    const world = emptyWorld(); const source = scene(); world.scenes.push(source);
    const template = def();
    template.parts.push({ id: "tile-b", coll: "tiles", parentId: "tile-a", doc: { ...tile(), _id: "tile-b",
      x: 420, y: 100, taggerTags: ["bell-{#}"] } });
    const parent = template.graphs[0]?.doc;
    if (!parent) throw new Error("graph missing");
    parent.definition.steps = [
      { id: "gather", kind: "collection", mode: "add", selector: { kind: "tag", query: "door-{#}",
        collections: ["walls"], includeRefs: [{ coll: "walls", id: "wall-a",
          parent: { coll: "scenes", id: "s1" } }] } },
      { id: "by-id", kind: "triggerTile", target: { kind: "id", tileId: "tile-b" }, tokens: "triggering" },
      { id: "by-tag", kind: "triggerTile", target: { kind: "tag", query: "bell-{#}",
        includeRefs: [{ coll: "tiles", id: "tile-b", parent: { coll: "scenes", id: "s1" } }] },
        tokens: "current" },
      { id: "wake", kind: "setActive", target: { kind: "id", tileId: "tile-b" }, mode: "activate" },
      { id: "assign", kind: "set", scope: "tile", name: "charge", value: 2,
        target: { kind: "id", tileId: "tile-b" } },
      { id: "increment", kind: "set", scope: "tile", name: "charge", value: 1, operation: "add",
        target: { kind: "tag", query: "bell-{#}", includeRefs: [{ coll: "tiles", id: "tile-b",
          parent: { coll: "scenes", id: "s1" } }] } },
      { id: "check-id", kind: "checkVariable", name: "charge", compare: "eq", value: 3,
        target: { kind: "id", tileId: "tile-b" } },
      { id: "check-tag", kind: "checkVariable", name: "charge", compare: "gte", value: 1,
        target: { kind: "tag", query: "bell-{#}", includeRefs: [{ coll: "tiles", id: "tile-b",
          parent: { coll: "scenes", id: "s1" } }] } },
    ];
    template.graphs.push({ id: "graph-b", doc: { ...graph(), _id: "graph-b", definition: {
      ...graph().definition, tileId: "tile-b", methods: ["manual"], gates: {},
      steps: [{ id: "done", kind: "stop" }],
    } } });
    const first = planPrefabPlacement(world, template, "s1", { at: { x: 500, y: 500 } }, ids());
    if (!first.ok) throw new Error(first.error);
    const root = first.plan.ops.find((op) => op.kind === "create" && op.coll === "automations" &&
      (op.data as AutomationDocument).definition.tileId === first.plan.ids["tile-a"]);
    expect(root?.kind === "create" ? (root.data as AutomationDocument).definition.steps : []).toMatchObject([
      { selector: { query: "door-1", includeRefs: [{ id: first.plan.ids["wall-a"] }] } },
      { target: { kind: "id", tileId: first.plan.ids["tile-b"] } },
      { target: { kind: "tag", query: "bell-1", includeRefs: [{ id: first.plan.ids["tile-b"] }] } },
      { target: { kind: "id", tileId: first.plan.ids["tile-b"] } },
      { target: { kind: "id", tileId: first.plan.ids["tile-b"] } },
      { target: { kind: "tag", query: "bell-1", includeRefs: [{ id: first.plan.ids["tile-b"] }] } },
      { target: { kind: "id", tileId: first.plan.ids["tile-b"] } },
      { target: { kind: "tag", query: "bell-1", includeRefs: [{ id: first.plan.ids["tile-b"] }] } },
    ]);
    const store = new DocumentStore({ meta: { worldId: "w", name: "w", system: "s", systemVersion: "1" } });
    expect(store.applyEnvelope({ seq: 1, ts: 1, by: "gm", txId: "seed", ops: [
      { kind: "create", coll: "scenes", data: source },
    ] }).ok).toBe(true);
    expect(store.applyEnvelope({ seq: 2, ts: 2, by: "gm", txId: "first", ops: first.plan.ops }).ok).toBe(true);
    const second = planPrefabPlacement(store.world, template, "s1", { at: { x: 800, y: 800 } }, ids("second"));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const clone = second.plan.ops.find((op) => op.kind === "create" && op.coll === "automations" &&
      (op.data as AutomationDocument).definition.tileId === second.plan.ids["tile-a"]);
    expect(clone?.kind === "create" ? (clone.data as AutomationDocument).definition.steps[2] : null)
      .toMatchObject({ target: { query: "bell-2", includeRefs: [{ id: second.plan.ids["tile-b"] }] } });
    expect(clone?.kind === "create" ? (clone.data as AutomationDocument).definition.steps.slice(3) : null)
      .toMatchObject([{ target: { tileId: second.plan.ids["tile-b"] } },
        { target: { tileId: second.plan.ids["tile-b"] } },
        { target: { query: "bell-2", includeRefs: [{ id: second.plan.ids["tile-b"] }] } },
        { target: { tileId: second.plan.ids["tile-b"] } },
        { target: { query: "bell-2", includeRefs: [{ id: second.plan.ids["tile-b"] }] } }]);
    const external = structuredClone(template);
    if (external.graphs[0]?.doc.definition.steps[1]?.kind === "triggerTile")
      external.graphs[0].doc.definition.steps[1].target = { kind: "id", tileId: "not-in-prefab" };
    expect(planPrefabPlacement(world, external, "s1", { at: { x: 500, y: 500 } }, ids()))
      .toMatchObject({ ok: false, error: expect.stringMatching(/dangling Trigger Tile target/) });
    const variableOutside = structuredClone(template);
    if (variableOutside.graphs[0]?.doc.definition.steps[4]?.kind === "set")
      variableOutside.graphs[0].doc.definition.steps[4].target = { kind: "id", tileId: "not-in-prefab" };
    expect(planPrefabPlacement(world, variableOutside, "s1", { at: { x: 500, y: 500 } }, ids()))
      .toMatchObject({ ok: false, error: expect.stringMatching(/dangling Set Variable target/) });
    const checkOutside = structuredClone(template);
    if (checkOutside.graphs[0]?.doc.definition.steps[6]?.kind === "checkVariable")
      checkOutside.graphs[0].doc.definition.steps[6].target = { kind: "id", tileId: "not-in-prefab" };
    expect(planPrefabPlacement(world, checkOutside, "s1", { at: { x: 500, y: 500 } }, ids()))
      .toMatchObject({ ok: false, error: expect.stringMatching(/dangling Check Variable target/) });
  });

  test("invalid cycles, external refs, shared/static binding, missing art, bounds and rotation fail before any operation", () => {
    const world = emptyWorld(); world.scenes.push(scene());
    const p = def();
    expect(validatePrefab({ ...p, parts: p.parts.map((part) => ({ ...part, parentId: part.id })) }).ok).toBe(false);
    expect(validatePrefab({ ...p, parts: [...p.parts, { ...p.parts[0], id: "tile-a" }] }).ok).toBe(false);
    const pos = { at: { x: 500, y: 500 } };
    const place = (template: PrefabDefinition) => planPrefabPlacement(world, template, "s1", pos, ids());
    const refs = def();
    const g = refs.graphs[0]?.doc;
    if (!g) throw new Error("no graph");
    g.definition.steps[0] = { id: "find", kind: "select", selector: { kind: "tag", query: "door-{#}",
      includeRefs: [{ coll: "walls", id: "not-copied", parent: { coll: "scenes", id: "s1" } }] } };
    expect(place(refs)).toMatchObject({ ok: false, error: expect.stringMatching(/dangling external/) });
    const staticTag = def();
    (staticTag.parts[1]?.doc as WallDocument).taggerTags = ["ordinary-door"];
    staticTag.graphs[0]?.doc.definition.steps.splice(0, 1, { id: "find", kind: "select", selector: {
      kind: "tag", query: "ordinary-door", collections: ["walls"] } });
    expect(place(staticTag)).toMatchObject({ ok: false, error: expect.stringMatching(/ambiguous or unbound/) });
    const missing = def();
    (missing.parts[0]?.doc as TileDocument).img = "a".repeat(64);
    expect(place(missing)).toMatchObject({ ok: false, error: expect.stringMatching(/missing media/) });
    expect(planPrefabPlacement(world, def(), "s1", { at: { x: 1990, y: 1490 } }, ids()))
      .toMatchObject({ ok: false, error: expect.stringMatching(/outside scene/) });
    const drawing = def();
    drawing.parts.push({ id: "drawing", coll: "drawings", parentId: "tile-a", doc: {
      _id: "drawing", type: "drawing", name: "Box", ownership: { default: 0 }, flags: {}, system: {},
      kind: "rect", points: [], box: [100, 100, 50, 50], stroke: "#ffffff", fill: "#ffffff", strokeWidth: 1, text: null,
    } });
    expect(planPrefabPlacement(world, drawing, "s1", { ...pos, rotation: 90 }, ids()))
      .toMatchObject({ ok: false, error: expect.stringMatching(/rotated rectangular drawings/) });
  });

  test("grid-portable rotation/scale transform an attached token and wall coherently", () => {
    const world = emptyWorld();
    const sc = scene(); sc.grid.size = 200; world.scenes.push(sc);
    const placed = planPrefabPlacement(world, def(), "s1", { at: { x: 800, y: 800 }, rotation: 90 }, ids());
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect((placed.plan.ops[1] as Extract<(typeof placed.plan.ops)[number], { kind: "create" }>).data)
      .toMatchObject({ c: [800, 1000, 800, 1200] });
    expect((placed.plan.ops[2] as Extract<(typeof placed.plan.ops)[number], { kind: "create" }>).data)
      .toMatchObject({ x: 580, y: 940, width: 80, height: 80, rotation: 90 });
  });

  test("moving/resizing/rotating a root carries nested walls/tokens in one envelope, without mutating originals", () => {
    const world = emptyWorld(); world.scenes.push(scene());
    const placed = planPrefabPlacement(world, def(), "s1", { at: { x: 500, y: 500 } }, ids());
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const store = new DocumentStore({ meta: { worldId: "w", name: "w", system: "s", systemVersion: "1" } });
    expect(store.applyEnvelope({ seq: 1, ts: 1, by: "gm", txId: "fixture", ops: [
      { kind: "create", coll: "scenes", data: world.scenes[0] as SceneDocument }, ...placed.plan.ops,
    ] }).ok).toBe(true);
    const root = placed.plan.rootId;
    const proposed = [{ kind: "update" as const, ref: { coll: "tiles" as const, id: root,
      parent: { coll: "scenes" as const, id: "s1" } },
      diff: { x: 600, y: 500, width: 300, height: 300, rotation: 90 } }];
    const expanded = attachedMovementOps(store.world, proposed);
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.ops).toHaveLength(3);
    expect(expanded.ops.find((op) => op.kind === "update" && op.ref.coll === "walls"))
      .toMatchObject({ ref: { id: placed.plan.ids["wall-a"] }, diff: { c: [900, 650, 900, 800] } });
    expect(expanded.ops.find((op) => op.kind === "update" && op.ref.coll === "tokens"))
      .toMatchObject({ ref: { id: placed.plan.ids["child-a"] },
        diff: { x: 735, y: 605, width: 60, height: 60, rotation: 90 } });
    expect(store.applyEnvelope({ seq: 2, ts: 2, by: "gm", txId: "move", ops: expanded.ops }).ok).toBe(true);
    expect((store.get("scenes", "s1") as SceneDocument).walls[0]?.c).toEqual([900, 650, 900, 800]);
    expect(proposed).toHaveLength(1);
    const original = proposed[0];
    if (!original) throw new Error("missing root movement");
    expect(attachedMovementOps(store.world, [{ ...original, diff: { x: 1900 } }]))
      .toMatchObject({ ok: false, error: expect.stringMatching(/outside scene/) });
  });

  test("deleting the root cascades nested placeables and only its bound graph atomically", () => {
    const world = emptyWorld(); world.scenes.push(scene());
    const first = planPrefabPlacement(world, def(), "s1", { at: { x: 500, y: 500 } }, ids());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const store = new DocumentStore({ meta: { worldId: "w", name: "w", system: "s", systemVersion: "1" } });
    expect(store.applyEnvelope({ seq: 1, ts: 1, by: "gm", txId: "fixture", ops: [
      { kind: "create", coll: "scenes", data: world.scenes[0] as SceneDocument }, ...first.plan.ops,
    ] }).ok).toBe(true);
    const other = planPrefabPlacement(store.world, def(), "s1", { at: { x: 900, y: 600 } }, ids("other"));
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(store.applyEnvelope({ seq: 2, ts: 2, by: "gm", txId: "other", ops: other.plan.ops }).ok).toBe(true);
    const proposed = [{ kind: "delete" as const, ref: { coll: "tiles" as const, id: first.plan.rootId,
      parent: { coll: "scenes" as const, id: "s1" } } }];
    const cascade = attachedDeletionOps(store.world, proposed);
    expect(cascade.ok).toBe(true);
    if (!cascade.ok) return;
    expect(cascade.ops).toHaveLength(4); // root, wall, nested hidden token, bound graph
    expect(store.applyEnvelope({ seq: 3, ts: 3, by: "gm", txId: "delete", ops: cascade.ops }).ok).toBe(true);
    const sc = store.get("scenes", "s1") as SceneDocument;
    expect(sc.tiles.map((t) => t._id)).toEqual([other.plan.rootId]);
    expect(sc.walls).toHaveLength(1);
    expect(sc.tokens).toHaveLength(1);
    expect(store.getAll("automations")).toHaveLength(1);
  });
});
