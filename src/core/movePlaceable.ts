import type { DrawingDocument, Json, LightDocument, SoundDocument, TemplateDocument, TileDocument, TokenDocument } from "./documents";
import { drawingBounds } from "../canvas/layers/drawingGeometry";

export const MOVABLE_COLLECTIONS = ["tokens", "tiles", "drawings", "lights", "sounds", "templates"] as const;
export type MovePlaceable = TokenDocument | TileDocument | DrawingDocument | LightDocument | SoundDocument | TemplateDocument;
export interface MoveGeometry {
  x: number; y: number; dx: number; dy: number;
  width: number; height: number; rotation: number;
  /** Light/sound/template emitters have a point anchor, not a solid radius/area. */
  point: boolean;
}
/** Native tokens/emitters are anchored at x/y; tile/drawing destinations use their centers. */
export function moveGeometry(doc: MovePlaceable): MoveGeometry | null {
  if (doc.type === "drawing") {
    if (!Array.isArray(doc.points) || doc.points.length > 2048 || doc.points.length % 2 || !doc.points.every(Number.isFinite) ||
        (doc.box !== null && (!Array.isArray(doc.box) || doc.box.length !== 4 || !doc.box.every(Number.isFinite)))) return null;
    if (!["rect","ellipse","text","line","poly","freehand"].includes(doc.kind) ||
        (["line","poly","freehand"].includes(doc.kind) && doc.points.length < (doc.kind === "poly" ? 6 : 4))) return null;
    const bounds = drawingBounds(doc);
    if (!bounds || !Object.values(bounds).every(Number.isFinite) || bounds.width < 0 || bounds.height < 0) return null;
    return {...bounds, dx:bounds.width/2, dy:bounds.height/2, rotation:0, point:false};
  }
  if (!Number.isFinite(doc.x) || !Number.isFinite(doc.y)) return null;
  if (doc.type === "tile" || doc.type === "token") {
    const rotation = doc.type === "tile" ? doc.rotation ?? 0 : 0;
    if (![doc.width,doc.height,rotation].every(Number.isFinite) || doc.width <= 0 || doc.height <= 0) return null;
    return {x:doc.x,y:doc.y,dx:doc.type === "tile" ? doc.width/2 : 0,dy:doc.type === "tile" ? doc.height/2 : 0,
      width:doc.width,height:doc.height,rotation,point:false};
  }
  return {x:doc.x,y:doc.y,dx:0,dy:0,width:0,height:0,rotation:0,point:true};
}
/** Translate all stored drawing geometry, preserving dimensions, style and relative vertices.
 * Called only on the private staged scene after bounds/collision checks. */
export function applyMovePosition(doc: MovePlaceable, geometry: MoveGeometry, x: number, y: number): Record<string, Json> {
  if (doc.type !== "drawing") { doc.x=x; doc.y=y; return {x,y}; }
  const ox=x-geometry.x, oy=y-geometry.y;
  doc.points=doc.points.map((n,i)=>n+(i%2===0?ox:oy));
  if (doc.box) doc.box=[doc.box[0]+ox,doc.box[1]+oy,doc.box[2],doc.box[3]];
  return {points:doc.points,box:doc.box};
}
