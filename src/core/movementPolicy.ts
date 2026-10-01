import type { WallDocument } from "./documents";
import { axisBlocks } from "../canvas/vision/wallSight";

export interface MovePoint { x: number; y: number }
/** Conservative center-line collision: closed/locked movement doors block, open doors pass.
 * One-way walls are conservatively two-sided until directional movement is implemented. */
export function movementWallBlocked(from: MovePoint, to: MovePoint, walls: readonly WallDocument[]): boolean {
  if (from.x === to.x && from.y === to.y) return false;
  const cross = (a: MovePoint, b: MovePoint, c: MovePoint) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const inside = (a: number, b: number, c: number, d: number) => Math.max(Math.min(a,b),Math.min(c,d)) <= Math.min(Math.max(a,b),Math.max(c,d)) + 1e-7;
  return walls.some((wall) => {
    if (!axisBlocks(wall.move, wall.door)) return false;
    const [x1,y1,x2,y2] = wall.c;
    if (![x1,y1,x2,y2].every(Number.isFinite)) return true;
    const a = { x: x1, y: y1 }, b = { x: x2, y: y2 };
    if (!inside(from.x,to.x,a.x,b.x) || !inside(from.y,to.y,a.y,b.y)) return false;
    const opposite = (u: number, v: number) => Math.abs(u) <= 1e-7 || Math.abs(v) <= 1e-7 || (u < 0) !== (v < 0);
    return opposite(cross(from,to,a), cross(from,to,b)) && opposite(cross(a,b,from), cross(a,b,to));
  });
}

/** Sweep a fixed-orientation rectangular footprint along the segment. The convex hull
 * of its start/end corners is exact for pure translation, including rotated tiles. */
export function movementFootprintBlocked(from: MovePoint, to: MovePoint, width: number, height: number,
  rotation: number, walls: readonly WallDocument[]): boolean {
  if (from.x === to.x && from.y === to.y) return false;
  if (![width,height,rotation].every(Number.isFinite) || width <= 0 || height <= 0) return true;
  const angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const points: MovePoint[] = [];
  for (const center of [from,to]) for (const x of [-width/2,width/2]) for (const y of [-height/2,height/2])
    points.push({x:center.x+x*c-y*s,y:center.y+x*s+y*c});
  points.sort((a,b) => a.x-b.x || a.y-b.y);
  const cross = (a: MovePoint,b: MovePoint,c: MovePoint) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const half = (rows: MovePoint[]) => {
    const out: MovePoint[] = [];
    for (const p of rows) {
      while (out.length >= 2 && cross(out[out.length-2] as MovePoint,out[out.length-1] as MovePoint,p) <= 0) out.pop();
      out.push(p);
    }
    out.pop(); return out;
  };
  const hull = [...half(points),...half([...points].reverse())];
  const inside = (p: MovePoint) => hull.every((a,i) => cross(a,hull[(i+1)%hull.length] as MovePoint,p) >= -1e-7);
  return walls.some((wall) => {
    if (!axisBlocks(wall.move,wall.door)) return false;
    if (!wall.c.every(Number.isFinite)) return true;
    const [x,y,u,v] = wall.c;
    return inside({x,y}) || inside({x:u,y:v}) || hull.some((p,i) => movementWallBlocked(p,hull[(i+1)%hull.length] as MovePoint,[wall]));
  });
}

/** Grid sizes per second, evaluated on the final snapped straight-line distance. */
export function movementSpeedDuration(distance: number, gridSize: number, speed: number): number | null {
  if (![distance,gridSize,speed].every(Number.isFinite) || distance < 0 || gridSize <= 0 || speed <= 0) return null;
  const duration = distance / gridSize / speed * 1000;
  return Number.isFinite(duration) && duration <= 60000 ? duration : null;
}
