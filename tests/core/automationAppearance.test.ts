import { describe, expect, test } from "vitest";
import { automationImageError, planAutomation, validateAutomation, type AutomationStep } from "../../src/core/automation";
import type { AssetManifest, AutomationDocument, SceneDocument, TileDocument } from "../../src/core/documents";
import { hexCenter } from "../../src/canvas/grid";
import { emptyWorld } from "../net/fixtures";

const hash = "a".repeat(64);
const asset = { name: "floor.png", mime: "image/png", size: 10, chunks: 1, visibility: "referenced" as const };
const second = "b".repeat(64), third = "c".repeat(64);
const manifest: AssetManifest = { [hash]: asset, [second]: asset, [third]: asset };
function fixture(steps: AutomationStep[]) {
  const tile: TileDocument = { _id: "tile", type: "tile", name: "Tile", ownership: { default: 0 }, flags: {}, system: {},
    x: 10, y: 10, width: 100, height: 100, img: "", above: false, occlusion: { mode: "roof", alpha: 0.5 } };
  const scene: SceneDocument = { _id: "s1", type: "scene", name: "Scene", ownership: { default: 2 }, flags: {}, system: {},
    width: 1000, height: 1000, active: true, img: null, darkness: 0.25,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [], tiles: [tile], walls: [], lights: [], sounds: [], drawings: [], templates: [], notes: [] };
  const graph: AutomationDocument = { _id: "graph", type: "automation", name: "Appearance", flags: {}, system: {},
    ownership: { default: 0 }, definition: { version: 1, sceneId: scene._id, tileId: tile._id, methods: ["manual"], steps } };
  const world = emptyWorld(); world.scenes.push(scene); world.automations.push(graph);
  const event = { scene, tile, method: "manual" as const, caller: { id: "gm", role: "GM" as const },
    at: 1000, rng: () => 0, imageAssetError: (id: string) => automationImageError(id, manifest) };
  return { world, graph, scene, tile, event, run: () => planAutomation(world, graph, event, "gm") };
}

describe("scene and tile appearance actions", () => {
  test.each([0,250,60000])("Scene Lighting %s ms stages endpoint-only hints and immediate checks", (durationMs) => {
    const f=fixture([{id:"light",kind:"sceneLighting",mode:"set",darkness:0.75,durationMs},
      {id:"check",kind:"checkValue",source:"darkness",compare:"eq",value:0.75}]);
    const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    expect(result.plan.ops.find((op)=>op.kind==="update"&&op.ref.coll==="scenes"))
      .toMatchObject({diff:{darkness:0.75,"flags.arenaDarkness":{darkness:0.75,durationMs}}});
    expect(result.plan.trace).toContain("Check Value darkness: 0.75 eq 0.75 -> pass");
    expect(f.scene.darkness).toBe(0.25);expect(f.scene.flags).toEqual({});
  });
  test.each([-1,60001,NaN,Infinity,"1000",null])("rejects invalid Scene Lighting duration %s", (durationMs) => {
    const f=fixture([]);
    expect(validateAutomation({...f.graph.definition,steps:[{id:"light",kind:"sceneLighting",mode:"set",darkness:1,durationMs}]}).ok).toBe(false);
  });
  test.each([0,500,60000])("Rotation %s ms publishes only endpoint/duration with immediate staged mechanics",(durationMs)=>{
    const f=fixture([{id:"select",kind:"select",selector:{kind:"tile"}},
      {id:"rotate",kind:"rotate",mode:"add",formula:"-1d1 * 90",targets:"current",durationMs},
      {id:"check",kind:"checkData",path:"rotation",compare:"eq",value:270}]);
    const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    expect(result.plan.ops.find((op)=>op.kind==="update"&&op.ref.coll==="tiles"))
      .toMatchObject({diff:{rotation:270,"flags.arenaRotation":{rotation:270,durationMs}}});
    expect(f.tile.rotation).toBeUndefined();expect(f.tile.flags).toEqual({});
  });
  test.each([-1,60001,NaN,Infinity,"1000",null])("rejects invalid Rotation duration %s",(durationMs)=>{
    const f=fixture([]);expect(validateAutomation({...f.graph.definition,steps:[{id:"rotate",kind:"rotate",angle:90,targets:"current",durationMs}]}).ok).toBe(false);
  });
  test("untimed turns clear stale hints; no-op turns preserve hints; later failure rolls back",()=>{
    const f=fixture([{id:"select",kind:"select",selector:{kind:"tile"}},
      {id:"turn",kind:"rotate",angle:90,targets:"current",durationMs:1000},
      {id:"noop",kind:"rotate",angle:450,targets:"current",durationMs:0}]);
    const run=()=>{const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));return result.plan.ops.filter((op)=>op.kind==="update"&&op.ref.coll==="tiles");};
    expect(run()).toHaveLength(1);
    f.graph.definition.steps.push({id:"cut",kind:"rotate",angle:180,targets:"current"});
    expect(run().at(-1)).toMatchObject({diff:{rotation:180,"flags.arenaRotation":{}}});
    f.graph.definition.steps.push({id:"fail",kind:"sceneLighting",mode:"add",darkness:1});
    expect(f.run().ok).toBe(false);expect(f.tile.flags).toEqual({});expect(f.tile.rotation).toBeUndefined();
  });

  test("nested lighting coalesces to the last actual change; legacy clears stale hints; failure rolls back", () => {
    const f=fixture([{id:"light",kind:"sceneLighting",mode:"set",darkness:0.75,durationMs:1000},
      {id:"call",kind:"triggerTile",target:{kind:"id",tileId:"child"},tokens:"triggering"}]);
    f.scene.tiles.push({...f.tile,_id:"child"});
    const child={...f.graph,_id:"child-graph",definition:{...f.graph.definition,tileId:"child",steps:[
      {id:"light",kind:"sceneLighting",mode:"set",darkness:0.5,durationMs:2000},
      {id:"noop",kind:"sceneLighting",mode:"set",darkness:0.5,durationMs:0},
    ] as AutomationStep[]}};
    f.world.automations.push(child);
    const run=()=>{const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));return result.plan;};
    expect(run().ops.filter((op)=>op.kind==="update"&&op.ref.coll==="scenes"))
      .toMatchObject([{diff:{darkness:0.5,"flags.arenaDarkness":{darkness:0.5,durationMs:2000}}}]);
    child.definition.steps.push({id:"cut",kind:"sceneLighting",mode:"set",darkness:0.9});
    expect(run().ops.find((op)=>op.kind==="update"&&op.ref.coll==="scenes"))
      .toMatchObject({diff:{darkness:0.9,"flags.arenaDarkness":{}}});
    child.definition.steps.push({id:"fail",kind:"sceneLighting",mode:"add",darkness:1});
    expect(f.run().ok).toBe(false);expect(f.scene.darkness).toBe(0.25);expect(f.scene.flags).toEqual({});
  });

  test("Game Time formulas share the nested budget even for zero-minute results", () => {
    const f=fixture([
      ...Array.from({length:16},(_,i):AutomationStep=>({id:`clock-${i}`,kind:"gameTime",formula:"64d1 * 0"})),
      {id:"call",kind:"triggerTile",target:{kind:"id",tileId:"child"},tokens:"triggering"},
    ]);
    f.scene.tiles.push({...f.tile,_id:"child"});
    f.world.automations.push({...f.graph,_id:"child-graph",definition:{...f.graph.definition,tileId:"child",steps:[
      {id:"clock",kind:"gameTime",formula:"1d1"},
    ]}});
    let draws=0;f.event.rng=()=>{draws++;return 0;};
    expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("1024 random draws")});
    expect(draws).toBe(1024);expect(f.world.settings).toEqual([]);expect(f.graph.state).toBeUndefined();
  });

  test.each(["1/0","1/2","525601","-1d1 * 100"])("Game Time invalid resolved change %s rolls back earlier actions", (formula) => {
    const f=fixture([{id:"light",kind:"sceneLighting",mode:"set",darkness:0.7},
      {id:"clock",kind:"gameTime",minutes:10},{id:"bad",kind:"gameTime",formula}]);
    expect(f.run().ok).toBe(false);
    expect(f.world.settings).toEqual([]);expect(f.scene.darkness).toBe(0.25);expect(f.graph.state).toBeUndefined();
  });

  test("Game Time signed formulas coalesce and later checks read the staged result", () => {
    const f=fixture([{id:"clock",kind:"gameTime",formula:"1d1 * 90"},
      {id:"rewind",kind:"gameTime",formula:"-1d1 * 30"},
      {id:"check",kind:"checkValue",source:"time",compare:"eq",value:60}]);
    let draws=0;f.event.rng=()=>{draws++;return 0;};
    const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op)=>op.kind==="create"&&op.coll==="settings"))
      .toMatchObject([{data:{system:{clockSeconds:3600}}}]);
    expect(result.plan.trace).toContain("Check Value time: 60 eq 60 -> pass");
    expect(draws).toBe(2);expect(f.world.settings).toEqual([]);
  });

  test("Move tag destinations default to both entity types but allow narrowing to a token center",()=>{
    const f=fixture([{id:"self",kind:"select",selector:{kind:"tile"}},
      {id:"move",kind:"move",destinationTag:{kind:"tag",query:"destination"},x:25,y:-25,targets:"current"}]);
    f.scene.tokens.push({_id:"anchor",type:"token",name:"Anchor",ownership:{default:0},flags:{},system:{},taggerTags:["destination"],
      x:450,y:350,width:40,height:40,rotation:0,hidden:true,img:"",vision:false,disposition:"neutral",light:{radius:0,color:"#ffffff",alpha:0}});
    const run=()=>{const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));return result.plan;};
    expect(run().ops.find((op)=>op.kind==="update"&&op.ref.id==="tile")).toMatchObject({diff:{x:425,y:275}});
    f.scene.tiles.push({...f.tile,_id:"anchor",taggerTags:["destination"]});
    expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("matched 2")});
    const move=f.graph.definition.steps[1];if(move?.kind!=="move"||!move.destinationTag)throw new Error("missing move");
    move.destinationTag.collections=["tokens"];
    expect(run().ops.find((op)=>op.kind==="update"&&op.ref.id==="tile")).toMatchObject({diff:{x:425,y:275}});
  });

  test("Move tag destinations snapshot a unique staged anchor for all movers", () => {
    const f=fixture([{id:"sel",kind:"select",selector:{kind:"tag",query:"moving",collections:["tiles"]}},
      {id:"move",kind:"move",destinationTag:{kind:"tag",query:"destination"},xFormula:"-1d1 * 25",y:0,targets:"current"}]);
    f.tile.taggerTags=["moving"];
    f.scene.tiles.unshift({...f.tile,_id:"anchor",x:300,y:400,width:200,height:100,hidden:true,taggerTags:["moving","destination"]});
    f.world.scenes.push({...structuredClone(f.scene),_id:"remote"});
    const before=structuredClone(f.world), result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    const changes=result.plan.ops.filter((op)=>op.kind==="update"&&op.ref.coll==="tiles");
    expect(changes).toHaveLength(2);
    for(const op of changes)if(op.kind==="update") expect(op.diff).toEqual({x:op.ref.id==="anchor"?275:325,y:400});
    expect(f.world).toEqual(before);
  });

  test("Move tag destinations read unflushed tag edits and staged movement; deletion rolls everything back",()=>{
    const f=fixture([
      {id:"anchor",kind:"select",selector:{kind:"ids",refs:[{coll:"tiles",id:"anchor",parent:{coll:"scenes",id:"s"}}]}},
      {id:"tag",kind:"tags",edit:"replace",tags:["destination"]},
      {id:"advance",kind:"move",x:600,y:650,targets:"current"},
      {id:"self",kind:"select",selector:{kind:"tile"}},
      {id:"follow",kind:"move",destinationTag:{kind:"tag",query:"destination"},x:0,y:0,targets:"current",snapToGrid:true,speed:2},
    ]);
    // Match fixture scene identity explicitly rather than relying on a hardcoded parent.
    const first=f.graph.definition.steps[0];if(first?.kind==="select"&&first.selector.kind==="ids")first.selector.refs[0]={coll:"tiles",id:"anchor",parent:{coll:"scenes",id:f.scene._id}};
    f.scene.tiles.push({...f.tile,_id:"anchor",x:300,y:400});
    const before=structuredClone(f.world),result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    expect(result.plan.ops.find((op)=>op.kind==="update"&&op.ref.coll==="tiles"&&op.ref.id==="tile"))
      .toMatchObject({diff:{x:600,y:600,"flags.arenaMove":{x:600,y:600,durationMs:expect.any(Number)}}});
    expect(result.plan.ops.some((op)=>op.kind==="update"&&op.ref.id==="anchor"&&Array.isArray(op.diff.taggerTags))).toBe(true);
    expect(f.world).toEqual(before);
    f.graph.definition.steps.splice(3,0,{id:"delete",kind:"delete"});
    expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("matched 0")});
    expect(f.scene.tiles).toHaveLength(2);expect(f.tile.x).toBe(10);expect(f.scene.tiles[1]?.taggerTags).toBeUndefined();
  });

  test.each([0,2])("Move tag destination cardinality %s rejects earlier staged writes",(count)=>{
    const f=fixture([{id:"light",kind:"sceneLighting",mode:"set",darkness:0.75},
      {id:"self",kind:"select",selector:{kind:"tile"}},
      {id:"move",kind:"move",destinationTag:{kind:"tag",query:"destination"},x:0,y:0,targets:"current"}]);
    for(let i=0;i<count;i++)f.scene.tiles.push({...f.tile,_id:`anchor-${i}`,taggerTags:["destination"]});
    const before=structuredClone(f.world);expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining(`matched ${count}`)});expect(f.world).toEqual(before);
  });

  test.each([
    {query:["Destination-A","blue"],mode:"all" as const},
    {query:["absent","Destination-A"],mode:"any" as const},
    {query:["blue","Destination-A"],mode:"exactSet" as const},
    {query:"destination-*",pattern:"wildcard" as const,caseSensitive:false},
    {query:"^Destination-[A-Z]$",pattern:"regex" as const},
    {query:"nation",contains:true},
  ])("Move supports Tagger matching options %j",(options)=>{
    const f=fixture([{id:"self",kind:"select",selector:{kind:"tile"}},
      {id:"move",kind:"move",destinationTag:{kind:"tag",...options,collections:["tiles"]},x:10,y:-10,targets:"current"}]);
    f.scene.tiles.push({...f.tile,_id:"anchor",x:400,y:300,taggerTags:["Destination-A","blue"]});
    const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    expect(result.plan.ops.find((op)=>op.kind==="update"&&op.ref.id==="tile")).toMatchObject({diff:{x:410,y:290}});
  });

  test("Move tag destination ref filters narrow matches without substituting missing tags",()=>{
    const f=fixture([]),ref=(id:string)=>({coll:"tiles" as const,id,parent:{coll:"scenes" as const,id:f.scene._id}});
    f.scene.tiles.push({...f.tile,_id:"one",x:400,y:300,taggerTags:["destination"]},{...f.tile,_id:"two",taggerTags:["destination"]});
    for(const filters of [{includeRefs:[ref("one")]},{excludeRefs:[ref("two")]}]) {
      f.graph.definition.steps=[{id:"self",kind:"select",selector:{kind:"tile"}},
        {id:"move",kind:"move",destinationTag:{kind:"tag",query:"destination",...filters},x:0,y:0,targets:"current"}];
      const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
      expect(result.plan.ops.find((op)=>op.kind==="update"&&op.ref.id==="tile")).toMatchObject({diff:{x:400,y:300}});
    }
    const move=f.graph.definition.steps[1];if(move?.kind!=="move"||!move.destinationTag)throw new Error("missing move");
    move.destinationTag.query="absent";expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("matched 0")});
  });

  test.each([
    {destinationTag:null},{destinationTag:{kind:"tile"}},{destinationTag:{kind:"tag",query:""}},
    {destinationTag:{kind:"tag",query:"a",collections:[]}}, {destinationTag:{kind:"tag",query:"a",collections:["walls"]}},
    {destinationTag:{kind:"tag",query:"a",collections:["tokens","tokens"]}},
    {destinationTag:{kind:"tag",query:"a",includeRefs:[{coll:"actors",id:"a"}]}},
    {destinationTag:{kind:"tag",query:"a",excludeRefs:[{coll:"tiles",id:"a",parent:{coll:"scenes",id:"remote"}}]}},
    {destinationTag:{kind:"tag",query:"a",sceneId:"remote"}},
    {destinationTag:{kind:"tag",query:"a"},destination:{coll:"tiles",id:"anchor"}},
    {destinationTag:{kind:"tag",query:"a"},mode:"set"},{destinationTag:{kind:"tag",query:"a"},xMode:"add"},
    {destinationTag:{kind:"tag",query:"[",pattern:"regex"}},
  ])("rejects malformed or conflicting Move tag destinations %j",(extra)=>{
    const f=fixture([]);expect(validateAutomation({...f.graph.definition,steps:[{id:"move",kind:"move",x:0,y:0,targets:"current",...extra}]}).ok).toBe(false);
  });

  test("entity destinations use staged centers, dice offsets and one anchor snapshot for all movers", () => {
    const f=fixture([{id:"sel",kind:"select",selector:{kind:"tag",query:"moving",collections:["tiles"]}},
      {id:"move",kind:"move",destination:{coll:"tiles",id:"anchor"},xFormula:"-1d1 * 25",y:0,targets:"current"}]);
    f.tile.taggerTags=["moving"];
    f.scene.tiles.unshift({...f.tile,_id:"anchor",x:300,y:400,width:200,height:100});
    const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    const changes=result.plan.ops.filter((op)=>op.kind==="update"&&op.ref.coll==="tiles");
    expect(changes).toHaveLength(2);
    for(const op of changes)if(op.kind==="update") expect(op.diff).toEqual({x:op.ref.id==="anchor"?275:325,y:400});
    expect(f.scene.tiles[0]?.x).toBe(300);expect(f.tile.x).toBe(10);
  });

  test("a destination reads earlier staged movement and fails atomically after deletion", () => {
    const f=fixture([
      {id:"anchor",kind:"select",selector:{kind:"tag",query:"anchor",collections:["tiles"]}},
      {id:"advance",kind:"move",x:600,y:650,targets:"current"},
      {id:"self",kind:"select",selector:{kind:"tile"}},
      {id:"follow",kind:"move",destination:{coll:"tiles",id:"anchor"},x:0,y:0,targets:"current",snapToGrid:true},
    ]);
    f.scene.tiles.push({...f.tile,_id:"anchor",x:300,y:400,taggerTags:["anchor"]});
    const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    expect(result.plan.ops.find((op)=>op.kind==="update"&&op.ref.coll==="tiles"&&op.ref.id==="tile"))
      .toMatchObject({diff:{x:600,y:600}}); // center 600,650 snaps to 650,650
    f.graph.definition.steps.splice(2,0,{id:"delete",kind:"delete"});
    expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("destination entity")});
    expect(f.scene.tiles).toHaveLength(2);expect(f.tile.x).toBe(10);
  });

  test.each([
    {destination:{coll:"walls",id:"anchor"}}, {destination:{coll:"tiles",id:""}},
    {destination:{coll:"tiles",id:"anchor",sceneId:"s2"}}, {destination:{coll:"tiles",id:"anchor"},mode:"set"},
    {destination:{coll:"tokens",id:"anchor"},xMode:"add"}, {destination:null},
  ])("rejects malformed/ambiguous entity destination %j", (extra) => {
    const f=fixture([]);
    expect(validateAutomation({...f.graph.definition,steps:[{id:"m",kind:"move",x:0,y:0,targets:"current",...extra}]}).ok).toBe(false);
  });

  test("Move rolls each axis per tile and applies independent set/add modes before snapping", () => {
    const f=fixture([{id:"sel",kind:"select",selector:{kind:"tag",query:"moving",collections:["tiles"]}},
      {id:"move",kind:"move",mode:"add",xMode:"set",yMode:"add",xFormula:"1d2 * 100",yFormula:"1d1 * 10",targets:"current"}]);
    f.tile.taggerTags=["moving"]; f.scene.tiles.push({...f.tile,_id:"other"});
    const draws=[0,0,0.999,0];f.event.rng=()=>draws.shift()??0;
    const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op)=>op.kind==="update"&&op.ref.coll==="tiles").map((op)=>op.kind==="update"?op.diff:null))
      .toEqual([{x:50,y:20},{x:150,y:20}]);
    expect(draws).toHaveLength(0);expect(f.tile.x).toBe(10);expect(f.tile.y).toBe(10);
  });

  test.each(["1/0","1000000001","65d1"])("bad coordinate formula %s rolls back earlier writes", (xFormula) => {
    const f=fixture([{id:"light",kind:"sceneLighting",mode:"set",darkness:1},
      {id:"sel",kind:"select",selector:{kind:"tile"}},
      {id:"move",kind:"move",xFormula,y:100,targets:"current",speed:2,wallCollision:"footprint",snapToGrid:true}]);
    expect(f.run().ok).toBe(false);expect(f.tile.x).toBe(10);expect(f.tile.flags).toEqual({});expect(f.scene.darkness).toBe(0.25);
  });

  test("nested coordinate formulas share draw budget even on no-op moves", () => {
    const f=fixture([{id:"sel",kind:"select",selector:{kind:"tile"}},
      ...Array.from({length:16},(_,i):AutomationStep=>({id:`m${i}`,kind:"move",mode:"add",xFormula:"64d1 - 64",y:0,targets:"current"})),
      {id:"call",kind:"triggerTile",target:{kind:"id",tileId:"child"},tokens:"triggering"}]);
    f.scene.tiles.push({...f.tile,_id:"child"});
    f.world.automations.push({...f.graph,_id:"child-graph",definition:{...f.graph.definition,tileId:"child",steps:[
      {id:"sel",kind:"select",selector:{kind:"tile"}},
      {id:"move",kind:"move",mode:"add",x:0,yFormula:"1d1",targets:"current"},
    ]}});
    let draws=0;f.event.rng=()=>{draws++;return 0;};
    expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("1024 random draws")});
    expect(draws).toBe(1024);expect(f.tile.x).toBe(10);expect(f.graph.state).toBeUndefined();
  });

  test.each([undefined, 0, 750])("Move speed uses snapped distance unless duration %s overrides it", (durationMs) => {
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: 276, y: 324, targets: "current", snapToGrid: true, speed: 2,
        ...(durationMs === undefined ? {} : { durationMs }) }]);
    const result = f.run(); if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    const op = result.plan.ops.find((op) => op.kind === "update" && op.ref.coll === "tiles");
    expect(op).toMatchObject({ diff: { "flags.arenaMove": { x:200, y:300, durationMs: durationMs ?? Math.hypot(190,290)/200*1000 } } });
  });

  test("too-slow movement rejects earlier changes instead of clamping", () => {
    const f = fixture([{ id: "light", kind: "sceneLighting", mode: "set", darkness: 1 },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: 500, y: 500, targets: "current", speed: 0.01 }]);
    expect(f.run()).toMatchObject({ ok: false, error: expect.stringContaining("60000") });
    expect(f.scene.darkness).toBe(0.25); expect(f.tile.flags).toEqual({});
  });

  test.each([{speed:0},{speed:10001},{speed:Infinity},{triggerTiles:"false"},{triggerTiles:0}])("invalid move bundle setting %j rejects publication", (extra) => {
    const f = fixture([]);
    expect(validateAutomation({ ...f.graph.definition, steps: [{ id: "m", kind: "move", x:100,y:100,targets:"current",...extra }] }).ok).toBe(false);
  });

  test("footprint collision rejects a parallel obstacle after snapping, center policy remains compatible", () => {
    const step: AutomationStep = {id:"move",kind:"move",x:350,y:50,targets:"current",snapToGrid:true,wallCollision:"footprint",speed:2};
    const f = fixture([{id:"sel",kind:"select",selector:{kind:"tile"}},step]);
    f.tile.y=0;
    f.scene.walls.push({_id:"w",type:"wall",name:"w",ownership:{default:0},flags:{},system:{},c:[150,90,200,90],move:0,door:0,oneWay:false,sight:2,light:2,sound:2});
    expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("footprint")});
    step.wallCollision="block"; expect(f.run().ok).toBe(true); expect(f.tile.x).toBe(10);
  });

  test.each([false, true])("wall collision checks the final snapped segment (snap %s)", (snapToGrid) => {
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: 276, y: 324, targets: "current", wallCollision: "block", snapToGrid }]);
    f.scene.walls.push({ _id: "w", type: "wall", name: "w", ownership: { default: 0 }, flags: {}, system: {}, c: [230,340,260,340], move: 0, door: 0, oneWay: false, sight: 2, light: 2, sound: 2 });
    expect(f.run().ok).toBe(!snapToGrid); expect(f.tile.x).toBe(10);
  });

  test.each(["ignore", "block"] as const)("snapped animated Move collision %s is atomic and endpoint-only", (wallCollision) => {
    const f = fixture([{ id: "light", kind: "sceneLighting", mode: "set", darkness: 0.8 },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: 276, y: 324, targets: "current", snapToGrid: true, wallCollision, durationMs: 1200 }]);
    f.scene.walls.push({ _id: "w", type: "wall", name: "w", ownership: { default: 0 }, flags: {}, system: {}, c: [150,0,150,1000], move: 1, door: 0, oneWay: false, sight: 2, light: 2, sound: 2 });
    const result = f.run();
    if (wallCollision === "block") expect(result).toMatchObject({ ok: false, error: expect.stringContaining("movement wall") });
    else {
      if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
      expect(result.plan.ops.find((op) => op.kind === "update" && op.ref.coll === "tiles"))
        .toMatchObject({ diff: { x: 200, y: 300, "flags.arenaMove": { x: 200, y: 300, durationMs: 1200 } } });
    }
    expect(f.scene.darkness).toBe(0.25); expect(f.tile.flags).toEqual({}); expect(f.tile.x).toBe(10);
    if (f.scene.walls[0]) f.scene.walls[0].door = 1;
    expect(f.run().ok).toBe(true);
  });

  test("collision reads a staged door opening before the snapped move", () => {
    const f = fixture([
      { id: "wall", kind: "select", selector: { kind: "tag", query: "gate", collections: ["walls"] } },
      { id: "open", kind: "door", mode: "open" },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: 276, y: 324, targets: "current", snapToGrid: true, wallCollision: "block", durationMs: 0 },
    ]);
    f.scene.walls.push({ _id: "w", type: "wall", name: "w", taggerTags: ["gate"], ownership: { default: 0 }, flags: {}, system: {}, c: [150,0,150,1000], move: 1, door: 2, oneWay: false, sight: 2, light: 2, sound: 2 });
    // Open explicitly refuses a locked door; unlock first instead of bypassing that policy.
    f.graph.definition.steps.splice(1, 0, { id: "unlock", kind: "door", mode: "unlock" });
    expect(f.run().ok).toBe(true); expect(f.scene.walls[0]?.door).toBe(2);
  });

  test.each([{ durationMs: -1 }, { durationMs: 60001 }, { durationMs: NaN }, { wallCollision: "slide" }])("invalid movement controls %j rejected", (extra) => {
    const f = fixture([]);
    expect(validateAutomation({ ...f.graph.definition, steps: [{ id: "m", kind: "move", x: 100, y: 100, targets: "current", ...extra }] }).ok).toBe(false);
  });

  test.each(["oddQ", "evenQ", "oddR", "evenR"] as const)("Move snaps a tile center to a %s hex", (layout) => {
    const center = hexCenter({ type: "hex", size: 100, layout }, 3, 4);
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: center.x + 2, y: center.y - 2, targets: "current", snapToGrid: true }]);
    f.scene.grid.type = "hex"; f.scene.grid.hexLayout = layout;
    const result = f.run(); if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    const op = result.plan.ops.find((op) => op.kind === "update" && op.ref.coll === "tiles");
    expect(op).toMatchObject({ diff: { x: center.x - 50, y: center.y - 50 } });
    expect(f.tile.x).toBe(10);
  });

  test.each(["set", "add"] as const)("Move %s snaps after computing the tile destination", (mode) => {
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", mode, x: mode === "set" ? 276 : 216, y: mode === "set" ? 324 : 264, targets: "current", snapToGrid: true }]);
    const result = f.run(); if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.find((op) => op.kind === "update" && op.ref.coll === "tiles"))
      .toMatchObject({ diff: { x: 200, y: 300 } });
  });

  test("gridless Move ignores snapping and preserves authored fractions", () => {
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: 276.5, y: 324.5, targets: "current", snapToGrid: true }]);
    f.scene.grid.type = "gridless";
    const result = f.run(); if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.find((op) => op.kind === "update" && op.ref.coll === "tiles"))
      .toMatchObject({ diff: { x: 226.5, y: 274.5 } });
  });

  test.each([0, -1, NaN, Infinity])("invalid grid size %s rejects snapping atomically", (size) => {
    const f = fixture([{ id: "light", kind: "sceneLighting", mode: "set", darkness: 1 },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: 300, y: 300, targets: "current", snapToGrid: true }]);
    f.scene.grid.size = size;
    expect(f.run()).toMatchObject({ ok: false, error: expect.stringContaining("invalid grid") });
    expect(f.scene.darkness).toBe(0.25); expect(f.tile.x).toBe(10);
  });

  test("snapping does not clamp an out-of-scene result", () => {
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", x: 980, y: 300, targets: "current", snapToGrid: true }]);
    f.scene.width = 975;
    const result = f.run(); if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    // 980 snaps to the in-bounds center 950, then bounds are checked.
    expect(result.plan.ops.find((op) => op.kind === "update" && op.ref.coll === "tiles"))
      .toMatchObject({ diff: { x: 900, y: 300 } });
    f.scene.width = 940;
    expect(f.run()).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
  });

  test.each(["true", 1, null])("reject non-boolean snap setting %j", (snapToGrid) => {
    const f = fixture([]);
    expect(validateAutomation({ ...f.graph.definition, steps: [{ id: "m", kind: "move", x: 0, y: 0, targets: "current", snapToGrid }] }).ok).toBe(false);
  });

  test.each([
    [undefined, 300, 200, 250, 150], ["set", 50, 50, 0, 0],
    ["add", -10, -10, 0, 0], ["add", 20.5, 30.5, 30.5, 40.5], ["add", 0, 0, 10, 10],
  ] as const)("tile Move %s (%s,%s) resolves its center/offset correctly", (mode, x, y, expectedX, expectedY) => {
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", ...(mode ? { mode } : {}), x, y, targets: "current" }]);
    const result = f.run(); if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    const updates = result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles");
    expect(updates).toEqual(expectedX === 10 && expectedY === 10 ? [] : [{ kind: "update", ref: { coll: "tiles", id: "tile", parent: { coll: "scenes", id: "s1" } }, diff: { x: expectedX, y: expectedY } }]);
    expect(f.tile.x).toBe(10); expect(f.tile.y).toBe(10);
  });

  test.each([
    { mode: "add", x: -11, y: 0 }, { mode: "add", x: 1000, y: 0 },
    { mode: "set", x: 49, y: 100 }, { mode: "set", x: 1001, y: 100 },
  ] as const)("invalid Move destination %j rolls back earlier appearance writes", (point) => {
    const f = fixture([{ id: "light", kind: "sceneLighting", mode: "set", darkness: 1 },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", ...point, targets: "current" }]);
    expect(f.run()).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
    expect(f.tile.x).toBe(10); expect(f.scene.darkness).toBe(0.25); expect(f.graph.state).toBeUndefined();
  });

  test.each([
    { mode: "bad", x: 0, y: 0 }, { mode: "set", x: -1, y: 0 },
    { mode: "add", x: -1e9 - 1, y: 0 }, { mode: "add", x: 0, y: NaN },
  ])("invalid Move schema %j fails publication validation", (point) => {
    const f = fixture([]);
    expect(validateAutomation({ ...f.graph.definition, steps: [{ id: "move", kind: "move", ...point, targets: "current" }] }).ok).toBe(false);
  });

  test("nested tile moves read each other's staged positions", () => {
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "first", kind: "move", mode: "add", x: 10, y: 20, targets: "current" },
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
      { id: "last", kind: "move", mode: "add", x: -5, y: -10, targets: "current" }]);
    f.tile.taggerTags = ["root"]; f.scene.tiles.push({ ...f.tile, _id: "child", taggerTags: [] });
    f.world.automations.push({ ...f.graph, _id: "child-graph", definition: { ...f.graph.definition, tileId: "child", steps: [
      { id: "sel", kind: "select", selector: { kind: "tag", query: "root", collections: ["tiles"] } },
      { id: "move", kind: "move", mode: "add", x: 100, y: 100, targets: "current" },
    ] } });
    const result = f.run(); if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")
      .map((op) => op.kind === "update" ? op.diff : null)).toEqual([{ x: 20, y: 30 }, { x: 120, y: 130 }, { x: 115, y: 120 }]);
    expect(f.tile.x).toBe(10); expect(f.tile.y).toBe(10);
  });

  test("rotation formulas roll independently per tile and compose with staged math angles", () => {
    const f = fixture([
      { id: "sel", kind: "select", selector: { kind: "tag", query: "turn", collections: ["tiles"] } },
      { id: "dice", kind: "rotate", formula: "1d4 * 90", targets: "current" },
      { id: "math", kind: "rotate", mode: "add", formula: "-45 / 2", targets: "current" },
    ]);
    f.tile.taggerTags = ["turn"]; f.scene.tiles.push({ ...f.tile, _id: "other" });
    let draws = 0; f.event.rng = () => draws++ === 0 ? 0 : 0.5;
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")
      .map((op) => op.kind === "update" ? op.diff.rotation : null)).toEqual([90, 270, 67.5, 247.5]);
    expect(draws).toBe(2); expect(f.scene.tiles.every((tile) => tile.rotation === undefined)).toBe(true);
  });

  test.each(["1 / 0", "1000001", "65d1", "sqrt(-1)"])("bad rotation formula rolls back prior writes: %s", (formula) => {
    const f = fixture([
      { id: "light", kind: "sceneLighting", mode: "set", darkness: 1 },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "set", kind: "rotate", angle: 20, targets: "current" },
      { id: "bad", kind: "rotate", formula, targets: "current" },
    ]);
    expect(f.run().ok).toBe(false); expect(f.tile.rotation).toBeUndefined();
    expect(f.scene.darkness).toBe(0.25); expect(f.graph.state).toBeUndefined();
  });

  test("nested rotation formulas share the random budget even for zero-angle no-ops", () => {
    const f = fixture([
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      ...Array.from({ length: 16 }, (_, i): AutomationStep => ({ id: `r-${i}`, kind: "rotate", formula: "64d1 - 64", targets: "current" })),
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
    ]);
    f.scene.tiles.push({ ...f.tile, _id: "child" });
    f.world.automations.push({ ...f.graph, _id: "child-graph", definition: { ...f.graph.definition, tileId: "child", steps: [
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "extra", kind: "rotate", formula: "1d1", targets: "current" },
    ] } });
    let draws = 0; f.event.rng = () => { draws++; return 0; };
    expect(f.run()).toMatchObject({ ok: false, error: expect.stringContaining("1024 random draws") });
    expect(draws).toBe(1024); expect(f.graph.state).toBeUndefined(); expect(f.tile.rotation).toBeUndefined();
  });

  test.each([
    [undefined, 20, 450, 90], ["set", 20, -90, 270], ["add", 350, 25, 15],
    ["add", 10, -25, 345], ["add", 0, 0.5, 0.5], ["add", undefined, 90, 90],
    ["add", 45, 360, 45],
  ] as const)("tile rotation %s from %s by %s gives %s", (mode, initial, angle, expected) => {
    const f = fixture([{ id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "turn", kind: "rotate", ...(mode ? { mode } : {}), angle, targets: "current" }]);
    if (initial !== undefined) f.tile.rotation = initial;
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    const updates = result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles");
    expect(updates).toEqual(initial === expected ? [] : [{ kind: "update", ref: { coll: "tiles", id: "tile", parent: { coll: "scenes", id: "s1" } }, diff: { rotation: expected } }]);
    expect(f.tile.rotation).toBe(initial);
  });

  test.each(["subtract", null, 5])("rejects unknown rotation mode %s", (mode) => {
    const f = fixture([]);
    expect(validateAutomation({ ...f.graph.definition, steps: [{ id: "r", kind: "rotate", targets: "current", angle: 10, mode }] }).ok).toBe(false);
  });

  test("relative tile rotations compose through parent/child plans and roll back on later failure", () => {
    const f = fixture([
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "first", kind: "rotate", mode: "add", angle: 30, targets: "current" },
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
      { id: "last", kind: "rotate", mode: "add", angle: -10, targets: "current" },
    ]);
    f.tile.taggerTags = ["root"]; f.tile.rotation = 350;
    f.scene.tiles.push({ ...f.tile, _id: "child", taggerTags: [] });
    f.world.automations.push({ ...f.graph, _id: "child-graph", definition: { ...f.graph.definition, tileId: "child", steps: [
      { id: "sel", kind: "select", selector: { kind: "tag", query: "root", collections: ["tiles"] } },
      { id: "turn", kind: "rotate", mode: "add", angle: 50, targets: "current" },
    ] } });
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")
      .map((op) => op.kind === "update" ? op.diff.rotation : null)).toEqual([20, 70, 60]);
    f.graph.definition.steps.push({ id: "fail", kind: "sceneLighting", mode: "add", darkness: 1 });
    expect(f.run().ok).toBe(false); expect(f.tile.rotation).toBe(350); expect(f.graph.state).toBeUndefined();
  });

  test.each([
    { id: "light", kind: "sceneLighting", mode: "set", darkness: 1.01 },
    { id: "light", kind: "sceneLighting", mode: "set", darkness: -0.1 },
    { id: "light", kind: "sceneLighting", mode: "add", darkness: Number.NaN },
    { id: "light", kind: "sceneLighting", mode: "toggle", darkness: 1 },
    { id: "light", kind: "sceneLighting", mode: "set", darkness: 0.5, sceneId: "secret" },
    { id: "image", kind: "sceneBackground", image: "https://example.com/map.png" },
    { id: "image", kind: "sceneBackground", image: "" },
    { id: "image", kind: "sceneBackground", image: hash, targetSceneId: "" },
    { id: "image", kind: "sceneBackground", image: hash, targetSceneId: 5 },
    { id: "image", kind: "tileImage", image: hash, targetSceneId: "s2" },
    { id: "image", kind: "tileImage", image: null },
    { id: "image", kind: "tileImage", image: hash, script: "arbitrary()" },
  ])("rejects malformed or out-of-scope data: %j", (step) => {
    const { graph } = fixture([]);
    expect(validateAutomation({ ...graph.definition, steps: [step] }).ok).toBe(false);
  });

  test.each([
    { images: [], selection: "next" }, { images: [hash, hash], selection: "first" },
    { images: [hash], selection: "other" }, { images: [hash], selection: "bad" },
    { images: [hash], selection: "index", index: 0 }, { images: [hash], selection: "index", index: 2 },
    { images: [hash], selection: "index", index: 1.5 }, { images: [hash], selection: "next", index: 1 },
    { images: [hash], selection: "first", image: hash }, { images: ["https://example.com/a.png"], selection: "first" },
    { images: Array.from({ length: 33 }, (_, n) => n.toString(16).padStart(64, "0")), selection: "first" },
  ])("rejects invalid image-list contract %j", (fields) => {
    const f = fixture([]);
    expect(validateAutomation({ ...f.graph.definition, steps: [{ id: "list", kind: "tileImage", ...fields }] }).ok).toBe(false);
  });

  test.each([
    ["first", third, hash], ["last", hash, third], ["next", hash, second], ["next", third, hash],
    ["next", "", hash], ["previous", hash, third], ["previous", third, second], ["previous", "", third],
    ["index", hash, second], ["random", hash, hash], ["other", hash, second], ["other", "", hash],
  ] as const)("%s selects relative to each tile's current image (%s)", (selection, current, expected) => {
    const f = fixture([
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "list", kind: "tileImage", images: [hash, second, third], selection,
        ...(selection === "index" ? { index: 2 } : {}) },
    ]);
    f.tile.img = current;
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    const updates = result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles");
    expect(updates).toEqual(current === expected ? [] : [
      { kind: "update", ref: { coll: "tiles", id: "tile", parent: { coll: "scenes", id: "s1" } }, diff: { img: expected } },
    ]);
    expect(f.tile.img).toBe(current); // pure dry-run
  });

  test("list cycling reads earlier staged images and rejects revoked unchosen alternatives atomically", () => {
    const f = fixture([
      { id: "select", kind: "select", selector: { kind: "tile" } },
      { id: "one", kind: "tileImage", images: [hash, second], selection: "next" },
      { id: "two", kind: "tileImage", images: [hash, second], selection: "next" },
      { id: "three", kind: "tileImage", images: [hash, second], selection: "next" },
    ]);
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")
      .map((op) => op.kind === "update" ? op.diff.img : null)).toEqual([hash, second, hash]);
    f.event.imageAssetError = (id) => id === second ? "revoked" : null;
    expect(f.run()).toMatchObject({ ok: false, error: expect.stringContaining("revoked") });
    expect(f.tile.img).toBe(""); expect(f.graph.state).toBeUndefined();
  });

  test("nested Trigger Tile image-list actions see and extend the parent's staged art", () => {
    const f = fixture([
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "first", kind: "tileImage", images: [hash, second], selection: "next" },
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
      { id: "sel-again", kind: "select", selector: { kind: "tile" } },
      { id: "last", kind: "tileImage", images: [hash, second], selection: "next" },
    ]);
    f.tile.taggerTags = ["cycle-root"];
    f.scene.tiles.push({ ...f.tile, _id: "child", taggerTags: [] });
    f.world.automations.push({ ...f.graph, _id: "child-graph", definition: { ...f.graph.definition, tileId: "child", steps: [
      { id: "sel", kind: "select", selector: { kind: "tag", query: "cycle-root", collections: ["tiles"] } },
      { id: "image", kind: "tileImage", images: [hash, second], selection: "next" },
    ] } });
    f.event.rng = () => { throw new Error("ordered selections must not roll"); };
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")
      .map((op) => op.kind === "update" ? op.diff.img : null)).toEqual([hash, second, hash]);
    expect(f.tile.img).toBe(""); expect(f.graph.state).toBeUndefined();
  });

  test("dice/math and number subsets see earlier staged art", () => {
    const f = fixture([
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "formula", kind: "tileImage", images: [hash, second, third], selection: "formula", formula: "1d1 + 1" },
      { id: "next", kind: "tileImage", images: [hash, second, third], selection: "next" },
      { id: "subset", kind: "tileImage", images: [hash, second, third], selection: "numbers", numbers: "[1, 2]" },
    ]);
    let draws = 0; f.event.rng = () => { draws++; return 0.75; };
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")
      .map((op) => op.kind === "update" ? op.diff.img : null)).toEqual([second, third, second]);
    expect(draws).toBe(2); expect(f.tile.img).toBe("");
  });

  test("each selected tile gets its own formula roll from the host", () => {
    const f = fixture([
      { id: "sel", kind: "select", selector: { kind: "tag", query: "art", collections: ["tiles"] } },
      { id: "roll", kind: "tileImage", images: [hash, second, third], selection: "formula", formula: "1d3" },
    ]);
    f.scene.tiles = [{ ...f.tile, taggerTags: ["art"] }, { ...f.tile, _id: "another", taggerTags: ["art"] }];
    let draws = 0; f.event.rng = () => draws++ === 0 ? 0 : 0.999;
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")
      .map((op) => op.kind === "update" ? op.diff.img : null)).toEqual([hash, third]);
    expect(draws).toBe(2); expect(f.scene.tiles.every((tile) => tile.img === "")).toBe(true);
  });

  test.each(["1 / 0", "1.5", "4", "65d1-64"])("runtime formula failure rolls back earlier writes: %s", (formula) => {
    const f = fixture([
      { id: "light", kind: "sceneLighting", mode: "set", darkness: 1 },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "set", kind: "tileImage", image: hash },
      { id: "formula", kind: "tileImage", images: [hash, second, third], selection: "formula", formula },
    ]);
    expect(f.run()).toMatchObject({ ok: false });
    expect(f.scene.darkness).toBe(0.25); expect(f.tile.img).toBe(""); expect(f.graph.state).toBeUndefined();
  });

  test("nested image formulas share a plan-wide random draw budget, even when the art is unchanged", () => {
    const formulaSteps = (count: number): AutomationStep[] => Array.from({ length: count }, (_, i) => ({
      id: `roll-${i}`, kind: "tileImage", images: [hash], selection: "formula", formula: "1d1",
    }));
    const select: AutomationStep = { id: "sel", kind: "select", selector: { kind: "tag", query: "all", collections: ["tiles"] } };
    const f = fixture([select, ...formulaSteps(16),
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
    ]);
    f.scene.tiles = Array.from({ length: 32 }, (_, i) => ({ ...f.tile,
      _id: i === 0 ? "tile" : i === 1 ? "child" : `tile-${i}`, img: hash, taggerTags: ["all"],
    }));
    f.world.automations.push({ ...f.graph, _id: "child-graph", definition: { ...f.graph.definition, tileId: "child",
      steps: [select, ...formulaSteps(17)],
    } });
    let draws = 0; f.event.rng = () => { draws++; return 0; };
    expect(f.run()).toMatchObject({ ok: false, error: expect.stringContaining("1024 random draws") });
    expect(draws).toBe(1024); expect(f.graph.state).toBeUndefined();
    expect(f.scene.tiles.every((tile) => tile.img === hash)).toBe(true);
  });

  test("host random choice is per tile, never repeats for other, and rejects invalid RNG", () => {
    const f = fixture([
      { id: "select", kind: "select", selector: { kind: "tag", query: "cycle", collections: ["tiles"] } },
      { id: "list", kind: "tileImage", images: [hash, second, third], selection: "other" },
    ]);
    f.tile.taggerTags = ["cycle"]; f.tile.img = hash;
    f.scene.tiles.push({ ...f.tile, _id: "tile2", img: third });
    f.event.rng = () => 0.999;
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")
      .map((op) => op.kind === "update" ? op.diff.img : null)).toEqual([third, second]);
    for (const roll of [-1, 1, Number.NaN, Infinity]) {
      f.event.rng = () => roll;
      expect(f.run()).toMatchObject({ ok: false, error: expect.stringContaining("RNG") });
    }
    expect(f.tile.img).toBe(hash);
  });

  test("validates owned image formats and sharing separately from export rights", () => {
    expect(automationImageError(hash, manifest)).toBeNull();
    for (const bad of ["https://example.com/a.png", "", "../../secret", "toString"])
      expect(automationImageError(bad, manifest)).toMatch(/owned asset hash/);
    expect(automationImageError(hash, {})).toMatch(/missing/);
    for (const mime of ["audio/wav", "video/webm", "text/html", "image/svg+xml"])
      expect(automationImageError(hash, { [hash]: { ...asset, mime } })).toMatch(/unsupported/);
    expect(automationImageError(hash, { [hash]: { ...asset, visibility: "gm" } })).toMatch(/GM-only/);
    expect(automationImageError(hash, { [hash]: { ...asset, exportRights: "restricted" } })).toBeNull();
  });

  test("lighting and background coalesce across parent/child actions with staged darkness checks", () => {
    const f = fixture([
      { id: "darken", kind: "sceneLighting", mode: "set", darkness: 0.5 },
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
      { id: "check", kind: "checkValue", source: "darkness", compare: "eq", value: 0.75 },
      { id: "chat", kind: "chat", audience: "gm", content: "Night" },
    ]);
    f.scene.tiles.push({ ...f.tile, _id: "child", hidden: true });
    f.world.automations.push({ ...f.graph, _id: "child-graph", definition: { ...f.graph.definition, tileId: "child", steps: [
      { id: "check", kind: "checkValue", source: "darkness", compare: "eq", value: 0.5 },
      { id: "darken", kind: "sceneLighting", mode: "add", darkness: 0.25 },
      { id: "art", kind: "sceneBackground", image: hash },
    ] } });
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "scenes")).toEqual([
      { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { darkness: 0.75, img: hash } },
    ]);
    expect(result.plan.ops.filter((op) => op.kind === "create")).toMatchObject([{ data: { content: "Night" } }]);
    expect(f.scene.darkness).toBe(0.25); expect(f.scene.img).toBeNull();
    expect(f.graph.state).toBeUndefined();
  });

  test("explicit backgrounds coalesce per scene across nested calls without mutating remote inputs", () => {
    const f = fixture([
      { id: "remote", kind: "sceneBackground", image: hash, targetSceneId: "s2" },
      { id: "light", kind: "sceneLighting", mode: "set", darkness: 1 },
      { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
    ]);
    const remote = { ...structuredClone(f.scene), _id: "s2", active: false };
    f.world.scenes.push(remote);
    f.scene.tiles.push({ ...f.tile, _id: "child" });
    f.world.automations.push({ ...f.graph, _id: "child-graph", definition: { ...f.graph.definition, tileId: "child", steps: [
      { id: "remote", kind: "sceneBackground", image: null, targetSceneId: "s2" },
      { id: "local", kind: "sceneBackground", image: hash, targetSceneId: "s1" },
    ] } });
    const before = structuredClone(f.world);
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "scenes")).toEqual([
      { kind: "update", ref: { coll: "scenes", id: "s2" }, diff: { img: null } },
      { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { darkness: 1, img: hash } },
    ]);
    expect(f.world).toEqual(before);
    f.world.scenes.pop();
    expect(f.run()).toMatchObject({ ok: false, error: expect.stringMatching(/target scene is unavailable/) });
    expect(f.scene.img).toBeNull(); expect(f.graph.state).toBeUndefined();
  });

  test("overflow or missing media after earlier steps returns no plan and mutates no input", () => {
    for (const final of [
      { id: "overflow", kind: "sceneLighting", mode: "add", darkness: 0.5 } as const,
      { id: "missing", kind: "sceneBackground", image: "d".repeat(64) } as const,
    ]) {
      const f = fixture([
        { id: "light", kind: "sceneLighting", mode: "set", darkness: 0.75 },
        { id: "chat", kind: "chat", audience: "scene", content: "Never committed" }, final,
      ]);
      expect(f.run()).toMatchObject({ ok: false });
      expect(f.scene.darkness).toBe(0.25); expect(f.world.messages).toEqual([]); expect(f.graph.state).toBeUndefined();
    }
  });

  test("unchanged lighting/background and empty tile art emit no appearance writes", () => {
    const f = fixture([
      { id: "light", kind: "sceneLighting", mode: "add", darkness: 0 },
      { id: "bg", kind: "sceneBackground", image: null },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "art", kind: "tileImage", image: "" },
    ]);
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error("no-op graph failed");
    expect(result.plan.ops).toHaveLength(1); // the successful graph fire still records history
    expect(result.plan.ops[0]).toMatchObject({ ref: { coll: "automations" } });
  });

  test("tile art changes only selected tiles and preserves pending tags and visibility", () => {
    const f = fixture([
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "tag", kind: "tags", edit: "add", tags: ["changed"] },
      { id: "art", kind: "tileImage", image: hash },
      { id: "hide", kind: "visibility", mode: "hide" },
      { id: "flush", kind: "batchFlush" },
    ]);
    f.scene.tiles.push({ ...f.tile, _id: "untouched" });
    const result = f.run();
    if (!result.ok || !("plan" in result)) throw new Error("tile art failed");
    expect(result.plan.ops.filter((op) => op.kind === "update" && op.ref.coll === "tiles")).toEqual([
      { kind: "update", ref: { coll: "tiles", id: "tile", parent: { coll: "scenes", id: "s1" } }, diff: { img: hash } },
      { kind: "update", ref: { coll: "tiles", id: "tile", parent: { coll: "scenes", id: "s1" } }, diff: { taggerTags: ["changed"], hidden: true } },
    ]);
    expect(f.tile.img).toBe(""); expect(f.tile.hidden).toBeUndefined();
  });

  test("tile art requires 1–32 tiles, never an empty or mixed entity collection", () => {
    const empty = fixture([{ id: "art", kind: "tileImage", image: hash }]);
    expect(empty.run()).toMatchObject({ ok: false, error: expect.stringMatching(/1–32 current tiles/) });
    const many = fixture([
      { id: "sel", kind: "select", selector: { kind: "tag", query: "group", collections: ["tiles"] } },
      { id: "art", kind: "tileImage", image: hash },
    ]);
    many.scene.tiles = Array.from({ length: 33 }, (_, i) => ({ ...many.tile, _id: i === 0 ? "tile" : `tile-${i}`, taggerTags: ["group"] }));
    expect(many.run()).toMatchObject({ ok: false, error: expect.stringMatching(/1–32 current tiles/) });
    expect(many.scene.tiles.every((t) => t.img === "")).toBe(true);
  });

  test("nonempty image writes fail closed without a host media adapter, clearing needs none", () => {
    const f = fixture([{ id: "bg", kind: "sceneBackground", image: hash }]);
    const event = { ...f.event };
    Reflect.deleteProperty(event, "imageAssetError");
    expect(planAutomation(f.world, f.graph, event, "gm")).toMatchObject({ ok: false, error: expect.stringMatching(/validation unavailable/) });
    f.scene.img = hash; f.graph.definition.steps = [{ id: "clear", kind: "sceneBackground", image: null }];
    const result = planAutomation(f.world, f.graph, event, "gm");
    expect(result.ok && "plan" in result ? result.plan.ops : []).toContainEqual({ kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { img: null } });
  });
});
