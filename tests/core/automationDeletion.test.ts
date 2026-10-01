import { expect, test } from "vitest";
import { planAutomation, validateAutomation, type AutomationStep } from "../../src/core/automation";
import type { AutomationDocument, DocRef, SceneDocument, TileDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";
import { environmentPlaceables } from "../fixtures/automationPlaceables";
const select: AutomationStep = {id:"select",kind:"select",selector:{kind:"tag",query:"cleanup",collections:["lights","sounds","templates"]}};
function fixture(steps: AutomationStep[]) {
  const tile: TileDocument = {_id:"tile",type:"tile",name:"Controller",ownership:{default:0},flags:{},system:{},x:100,y:100,width:100,height:100,img:"",above:false,occlusion:{mode:"roof",alpha:0.5}};
  const scene: SceneDocument = {_id:"s",type:"scene",name:"Scene",ownership:{default:2},flags:{},system:{},width:1000,height:1000,
    active:true,img:null,darkness:0,grid:{type:"square",size:100,distance:5,units:"ft",diagonals:"555",hexLayout:"oddQ"},
    tokens:[],tiles:[tile],walls:[],drawings:[],notes:[],...environmentPlaceables()};
  const graph: AutomationDocument = {_id:"graph",type:"automation",name:"Cleanup",ownership:{default:0},flags:{},system:{},
    definition:{version:1,sceneId:"s",tileId:"tile",methods:["manual"],steps}};
  const world=emptyWorld();world.scenes.push(scene);world.automations.push(graph);
  return {world,scene,graph,run:()=>planAutomation(world,graph,{scene,tile,method:"manual",caller:{id:"gm",role:"GM"},at:1000,rng:()=>0},"gm")};
}
test.each(["lights","sounds","templates"] as const)("Delete Entities removes %s and clears current selection without mutating inputs", (coll)=>{
  const f=fixture([{id:"select",kind:"select",selector:{kind:"tag",query:"cleanup",collections:[coll]}},
    {id:"delete",kind:"delete"},{id:"empty",kind:"filter",test:{kind:"count",min:0,max:0}}]);
  const before=structuredClone(f.world),result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  expect(result.plan.ops.filter((op)=>op.kind==="delete")).toEqual([{kind:"delete",ref:{coll,id:f.scene[coll][0]?._id,parent:{coll:"scenes",id:"s"}}}]);
  expect(f.world).toEqual(before);
});
test("mixed collection deletion is local, nested re-selection sees no deleted entities",()=>{
  const f=fixture([select,{id:"delete",kind:"delete"},{id:"child",kind:"triggerTile",target:{kind:"id",tileId:"child"},tokens:"triggering"}]);
  const tile=f.scene.tiles[0];if(!tile)throw new Error("missing tile");f.scene.tiles.push({...tile,_id:"child"});
  f.world.automations.push({...f.graph,_id:"child-graph",definition:{...f.graph.definition,tileId:"child",steps:[select,{id:"empty",kind:"filter",test:{kind:"count",min:0,max:0}}]}});
  const remote={...structuredClone(f.scene),_id:"other",active:false};f.world.scenes.push(remote);
  const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  expect(result.plan.ops.filter((op)=>op.kind==="delete")).toHaveLength(3);
  expect(result.plan.trace).toContain("selected 0 tag target(s)");expect(remote.lights).toHaveLength(1);
  expect(f.scene.lights).toHaveLength(1);expect(f.world.assetManifest).toEqual({});
});
test.each([false,true])("pending tags on removed entities are superseded, flushed edits keep their order (flush %s)",(flush)=>{
  const f=fixture([select,{id:"tag",kind:"tags",edit:"add",tags:["changed"]},...(flush?[{id:"flush",kind:"batchFlush"} as const]:[]),{id:"delete",kind:"delete"}]);
  const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  const ops=result.plan.ops.filter((op)=>op.kind==="delete"||op.kind==="update"&&op.ref.coll!=="automations");
  expect(ops.map((op)=>op.kind)).toEqual(flush?["update","update","update","delete","delete","delete"]:["delete","delete","delete"]);
  expect(f.scene.lights[0]?.taggerTags).toEqual(["cleanup"]);
});
test("discarding a deleted target's pending tags does not discard a surviving target's edits",()=>{
  const f=fixture([select,{id:"tag",kind:"tags",edit:"add",tags:["changed"]},
    {id:"one",kind:"select",selector:{kind:"tag",query:"cleanup",collections:["lights"]}},{id:"delete",kind:"delete"}]);
  const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  expect(result.plan.ops.filter((op)=>op.kind==="update"&&op.ref.coll!=="automations").map((op)=>op.kind==="update"?op.ref.coll:null).sort()).toEqual(["sounds","templates"]);
});
test.each(["scene","later failure"])("unsupported mixed targets or %s rejects the entire deletion plan",(reason)=>{
  const f=fixture([select,{id:"delete",kind:"delete"}]);
  if(reason==="scene") {
    f.scene.taggerTags=["cleanup"];
    f.graph.definition.steps[0]={id:"select",kind:"select",selector:{kind:"tag",query:"cleanup",collections:["scenes","lights","sounds","templates"]}};
  } else f.graph.definition.steps.push({id:"fail",kind:"sceneLighting",mode:"add",darkness:1},{id:"overflow",kind:"sceneLighting",mode:"add",darkness:1});
  const before=structuredClone(f.world);expect(f.run().ok).toBe(false);expect(f.world).toEqual(before);
});
test("deletion supersedes unflushed visibility and door edits as well as tags",()=>{
  const f=fixture([]),tile=f.scene.tiles[0];if(!tile)throw new Error("missing controller");
  f.scene.tiles.push({...tile,_id:"victim",taggerTags:["victim"]});
  f.scene.walls.push({_id:"door",type:"wall",name:"Door",ownership:{default:0},flags:{},system:{},taggerTags:["victim"],
    c:[0,0,100,0],door:0,oneWay:false,move:1,sight:1,light:1,sound:1});
  f.graph.definition.steps=[
    {id:"tile",kind:"select",selector:{kind:"tag",query:"victim",collections:["tiles"]}},
    {id:"hide",kind:"visibility",mode:"hide"},
    {id:"wall",kind:"select",selector:{kind:"tag",query:"victim",collections:["walls"]}},
    {id:"open",kind:"door",mode:"open"},
    {id:"both",kind:"select",selector:{kind:"tag",query:"victim",collections:["tiles","walls"]}},
    {id:"delete",kind:"delete"},
  ];
  const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  expect(result.plan.ops.filter((op)=>op.kind==="delete")).toHaveLength(2);
  expect(result.plan.ops.filter((op)=>op.kind==="update"&&op.ref.coll!=="automations")).toEqual([]);
  expect(f.scene.walls[0]?.door).toBe(0);expect(f.scene.tiles[1]?.hidden).toBeUndefined();
});

const pin=(coll:DocRef["coll"],id:string):DocRef=>({coll,id,parent:{coll:"scenes",id:"s"}});
test("pinned selectors resolve untagged entities in authored order against staged documents",()=>{
  const f=fixture([{id:"pin",kind:"select",selector:{kind:"ids",refs:[pin("templates","environment-template"),pin("lights","environment-light")]}},
    {id:"delete",kind:"delete"}]);
  for(const coll of ["templates","lights"] as const)for(const doc of f.scene[coll])doc.taggerTags=[];
  const before=structuredClone(f.world),result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  expect(result.plan.ops.filter((op)=>op.kind==="delete").map((op)=>op.kind==="delete"?op.ref.coll:null)).toEqual(["templates","lights"]);
  expect(f.world).toEqual(before);
});
test.each(["add","remove","replace"] as const)("pinned collection %s uses exact references and fails if one is missing",(mode)=>{
  const f=fixture([select,{id:"edit",kind:"collection",mode,selector:{kind:"ids",refs:[pin("lights","environment-light")]}},
    {id:"delete",kind:"delete"}]);
  const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  expect(result.plan.ops.filter((op)=>op.kind==="delete")).toHaveLength(mode==="add"?3:mode==="remove"?2:1);
  f.scene.lights=[];expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("Pinned entity is unavailable")});
});
test("a pin deleted earlier in the plan rejects the whole graph, including earlier writes",()=>{
  const f=fixture([{id:"pin",kind:"select",selector:{kind:"ids",refs:[pin("sounds","environment-sound")]}},
    {id:"delete",kind:"delete"},{id:"light",kind:"sceneLighting",mode:"set",darkness:0.5},
    {id:"again",kind:"select",selector:{kind:"ids",refs:[pin("sounds","environment-sound")]}}]);
  const before=structuredClone(f.world);expect(f.run()).toMatchObject({ok:false,error:expect.stringContaining("Pinned entity is unavailable")});expect(f.world).toEqual(before);
});
test.each([
  [], [pin("lights","environment-light"),pin("lights","environment-light")], [pin("actors","a")],
  [{coll:"scenes",id:"s"}], [pin("cells","cell")], [{coll:"lights",id:"x"}],
  [{...pin("lights","x"),parent:{coll:"scenes",id:"other"}}], [{...pin("lights","x"),extra:true}],
  [null], Array.from({length:101},(_,i)=>pin("lights",`l${i}`)),
].map((refs)=>({refs})))("rejects malformed pinned references $refs",({refs})=>{
  const f=fixture([]);expect(validateAutomation({...f.graph.definition,steps:[{id:"pin",kind:"select",selector:{kind:"ids",refs}}]}).ok).toBe(false);
});
test("pinned references are collection-qualified, not just document IDs",()=>{
  const f=fixture([{id:"pin",kind:"select",selector:{kind:"ids",refs:[pin("sounds","shared"),pin("lights","shared")]}},{id:"delete",kind:"delete"}]);
  for(const coll of ["sounds","lights"] as const){const doc=f.scene[coll][0];if(doc)doc._id="shared";}
  const result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  expect(result.plan.ops.filter((op)=>op.kind==="delete")).toHaveLength(2);
});

test("all eight pinnable placeable collections resolve together without tags",()=>{
  const f=fixture([]);
  const common={name:"Untagged",ownership:{default:0 as const},flags:{},system:{}};
  f.scene.tokens.push({...common,_id:"token",type:"token",x:0,y:0,rotation:0,width:1,height:1,img:"",hidden:false,
    disposition:"neutral",vision:false,light:{radius:0,color:"#ffffff",alpha:1}});
  f.scene.walls.push({...common,_id:"wall",type:"wall",c:[0,0,100,0],door:0,oneWay:false,move:0,sight:0,light:0,sound:0});
  f.scene.drawings.push({...common,_id:"drawing",type:"drawing",kind:"rect",points:[],box:[0,0,50,50],stroke:"#ffffff",fill:"#000000",strokeWidth:1,text:null});
  f.scene.notes.push({...common,_id:"note",type:"note",x:0,y:0,text:"",icon:""});
  const refs=[pin("tokens","token"),pin("tiles","tile"),pin("walls","wall"),pin("drawings","drawing"),pin("notes","note"),
    pin("lights","environment-light"),pin("sounds","environment-sound"),pin("templates","environment-template")];
  for(const coll of ["lights","sounds","templates"] as const)for(const doc of f.scene[coll])doc.taggerTags=[];
  f.graph.definition.steps=[{id:"pin",kind:"select",selector:{kind:"ids",refs}},{id:"delete",kind:"delete"}];
  const before=structuredClone(f.world),result=f.run();if(!result.ok||!("plan" in result))throw new Error(JSON.stringify(result));
  expect(result.plan.ops.filter((op)=>op.kind==="delete").map((op)=>op.ref)).toEqual(refs);
  expect(f.world).toEqual(before);
});
