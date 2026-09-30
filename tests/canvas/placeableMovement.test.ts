import { expect, test } from "vitest";
import { DrawingsLayer } from "../../src/canvas/layers/DrawingsLayer";
import { TemplatesLayer } from "../../src/canvas/layers/TemplatesLayer";
import { applyMovePosition, moveGeometry } from "../../src/core/movePlaceable";
import type { DrawingDocument, TemplateDocument } from "../../src/core/documents";
const camera={x:0,y:0,scale:1};
const common={name:"Shape",ownership:{default:1 as const},flags:{},system:{}};
test.each(["line","poly","freehand","rect","ellipse","text"] as const)("moving %s redraws geometry despite unchanged vertex count; Undo restores it",(kind)=>{
  const doc:DrawingDocument={...common,_id:"d",type:"drawing",kind,points:[100,100,200,100,200,180],box:[100,100,100,80],
    stroke:"#ffffff",fill:"none",strokeWidth:2,text:kind==="text"?"Caption":null};
  const layer=new DrawingsLayer();layer.sync([doc],camera);
  const visual=kind==="text"?layer.container.children[1]?.children[0]:layer.container.children[0];if(!visual)throw new Error("missing visual");
  const initial=kind==="text"?{x:visual.x,y:visual.y}:visual.getLocalBounds(),before={x:initial.x,y:initial.y};
  const moved=structuredClone(doc),geometry=moveGeometry(moved);if(!geometry)throw new Error("invalid geometry");
  applyMovePosition(moved,geometry,geometry.x+123.25,geometry.y-25.125);
  layer.sync([moved],camera);
  const after=kind==="text"?{x:visual.x,y:visual.y}:visual.getLocalBounds();
  expect(after.x-before.x).toBeCloseTo(123.25);expect(after.y-before.y).toBeCloseTo(-25.125);
  layer.sync([doc],camera);
  const restored=kind==="text"?{x:visual.x,y:visual.y}:visual.getLocalBounds();
  expect(restored.x).toBe(before.x);expect(restored.y).toBe(before.y);layer.destroy();
});
test.each(["circle","cone","ray","rect"] as const)("subpixel %s template movement redraws geometry and retains pooled labels",(kind)=>{
  const doc:TemplateDocument={...common,_id:"t",type:"template",kind,x:300,y:300,distance:50,direction:45,width:30};
  const layer=new TemplatesLayer();layer.sync([doc],camera);
  const g=layer.container.children[0],label=layer.container.children[1]?.children[0];if(!g||!label)throw new Error("missing graphics/label");
  const initial=g.getLocalBounds(),before={x:initial.x,y:initial.y},labelX=label.x;
  layer.sync([{...doc,x:300.125,y:300.25}],camera);
  const next=g.getLocalBounds();expect(next.x-before.x).toBeCloseTo(0.125);expect(next.y-before.y).toBeCloseTo(0.25);
  expect(label.x-labelX).toBeCloseTo(0.125);expect(label.visible).toBe(true);
  layer.sync([doc],camera);expect(g.getLocalBounds().x).toBe(before.x);expect(label.x).toBe(labelX);expect(label.visible).toBe(true);
  layer.destroy();
});
