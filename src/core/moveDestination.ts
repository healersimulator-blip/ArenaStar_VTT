import type { TileDocument, TokenDocument } from "./documents";

/** Private, action-local snapshot: moving the destination cannot move later anchors. */
export interface MoveDestinationSnapshot {
  x: number; y: number;
  tile?: { width: number; height: number; radians: number };
}
export function snapshotMoveDestination(doc: TileDocument | TokenDocument): MoveDestinationSnapshot | null {
  if (![doc.x,doc.y].every(Number.isFinite)) return null;
  if (doc.type === "token") return {x:doc.x,y:doc.y};
  const rotation=doc.rotation??0;
  if (![doc.width,doc.height,rotation].every(Number.isFinite) || doc.width<=0 || doc.height<=0) return null;
  const x=doc.x+doc.width/2,y=doc.y+doc.height/2;
  if (![x,y].every(Number.isFinite)) return null;
  return {x,y,tile:{width:doc.width,height:doc.height,radians:(rotation%360)*Math.PI/180}};
}
/** Uniform area sampling in the tile's local rectangle, transformed into scene space.
 * Offsets, snap and collision happen afterwards; no retries or footprint-containment promise.
 * Token destinations stay at their native center and consume no placement randomness. */
export function moveDestinationPoint(snapshot: MoveDestinationSnapshot, position: "center" | "random" | "entry", random:()=>number, entry?: MoveEntryPosition): {x:number;y:number} {
  const tile=snapshot.tile;
  if (!tile || position === "center") return {x:snapshot.x,y:snapshot.y};
  if (position === "entry" && (!entry || ![entry.u,entry.v].every((n)=>Number.isFinite(n)&&n>=0&&n<=1)))
    throw new Error("Move relative to entry requires a host-observed enter event for this tile and token");
  const x=((position === "entry" ? entry?.u ?? 0 : random())-0.5)*tile.width;
  const y=((position === "entry" ? entry?.v ?? 0 : random())-0.5)*tile.height;
  const cos=Math.cos(tile.radians),sin=Math.sin(tile.radians);
  return {x:snapshot.x+x*cos-y*sin,y:snapshot.y+x*sin+y*cos};
}

/** Deliberately not an expression evaluator or a document-reference resolver.
 * Accept exactly two literal JSON numeric fields, once each, in either order.
 * Checking the bounded grammar before conversion also refuses duplicate keys. */
export function moveTableLocation(text: unknown): {x:number;y:number} | null {
  if (typeof text !== "string" || text.length > 256) return null;
  const number = "(-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)";
  const match = new RegExp(`^[ \t\r\n]*\\{[ \t\r\n]*"([xy])"[ \t\r\n]*:[ \t\r\n]*${number}[ \t\r\n]*,[ \t\r\n]*"([xy])"[ \t\r\n]*:[ \t\r\n]*${number}[ \t\r\n]*\\}[ \t\r\n]*$`).exec(text);
  if (!match || match[1] === match[3]) return null;
  const first=Number(match[2]),second=Number(match[4]);
  if (![first,second].every((n)=>Number.isFinite(n)&&n>=0&&n<=1e9)) return null;
  return match[1] === "x" ? {x:first,y:second} : {x:second,y:first};
}


export interface MoveEntryPosition { u: number; v: number }
/** Normalize an enter contact in the source tile's local frame. For a swept-footprint event,
 * the token center may lie beyond the authored tile edge; project it to the nearest edge point. */
export function snapshotMoveEntry(tile: TileDocument, point: {x:number;y:number}, footprintContact=false): MoveEntryPosition | null {
  const snapshot=snapshotMoveDestination(tile),shape=snapshot?.tile;
  if (!snapshot || !shape || ![point.x,point.y].every(Number.isFinite)) return null;
  const dx=point.x-snapshot.x,dy=point.y-snapshot.y,c=Math.cos(shape.radians),s=Math.sin(shape.radians);
  const u=(dx*c+dy*s)/shape.width+0.5,v=(-dx*s+dy*c)/shape.height+0.5;
  if (![u,v].every(Number.isFinite) || (!footprintContact && (u < -1e-7 || u > 1+1e-7 || v < -1e-7 || v > 1+1e-7))) return null;
  return {u:Math.max(0,Math.min(1,u)),v:Math.max(0,Math.min(1,v))};
}
