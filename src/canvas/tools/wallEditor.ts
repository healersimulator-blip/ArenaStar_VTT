import { wallTopologyKey } from "../../core/levelMembership";
import type { WallDocument } from "../../core/documents";
import {
  joinedWallEndpoints, nearestWallEndpoint, nearestWallSegment, planWallCorner, planWallSplit,
  wallEditGuard, type WallEditGuard, type WallEditPlan, type WallEndpoint, type WallPoint,
} from "../../core/wallEditing";

export type WallEditMode = "draw" | "corner" | "split";
export interface WallEditorContext { sceneId: string; walls: readonly WallDocument[]; scale: number }
export interface WallEditorPort {
  context(): WallEditorContext | null;
  commit(plan: WallEditPlan): void;
  error(message: string): void;
}
interface Drag {
  sceneId: string; walls: WallDocument[]; guard: WallEditGuard; mode: "corner" | "split";
  start: WallPoint; endpoints: WallEndpoint[]; wallId: string; newId: string;
}
/** Detached preview only. The host checks the captured wall revision before committing. */
export class WallEditorController {
  private drag: Drag | null = null;
  constructor(private readonly port: WallEditorPort,
    private readonly preview: (walls: WallDocument[] | null) => void,
    private readonly nextId: () => string) {}
  cancel(): void { this.drag = null; this.preview(null); }
  /** D-465: an endpoint/split drag is in flight (Escape cancels it instead of leaving the tool). */
  get busy(): boolean { return this.drag !== null; }
  down(point: WallPoint, mode: WallEditMode, joined: boolean): void {
    this.cancel();
    if (mode === "draw") return;
    const context = this.port.context();
    if (!context) return;
    const walls = structuredClone([...context.walls]);
    const guard = wallEditGuard(context.sceneId, walls);
    const base = { sceneId: context.sceneId, walls, guard, mode, start: { ...point }, endpoints: [] as WallEndpoint[], wallId: "", newId: this.nextId() };
    if (mode === "corner") {
      const selected = nearestWallEndpoint(walls, point, context.scale);
      if (!selected) { this.port.error("Click within 8 screen pixels of an unlocked wall endpoint."); return; }
      const result = joinedWallEndpoints(walls, selected, joined);
      if (!result.ok) { this.port.error(result.error); return; }
      this.drag = { ...base, endpoints: result.value, wallId: selected.wallId };
      this.preview(walls.filter((wall) => result.value.some((e) => e.wallId === wall._id)));
    } else {
      const selected = nearestWallSegment(walls, point, context.scale);
      if (!selected) { this.port.error("Click on a plain wall segment to split it."); return; }
      const plan = planWallSplit(context.sceneId, walls, selected.wall._id, point, base.newId, context.scale);
      if (!plan.ok) { this.port.error(plan.error); return; }
      this.drag = { ...base, wallId: selected.wall._id };
      this.preview(plan.value.preview);
    }
  }
  private target(raw: WallPoint, gridSnapped: WallPoint, scale: number, snapEndpoints: boolean): WallPoint {
    const drag = this.drag;
    if (!drag || !snapEndpoints) return gridSnapped;
    const source = drag.walls.find((wall) => wall._id === drag.wallId);
    const targets = source ? drag.walls.filter((wall) => wallTopologyKey(wall) === wallTopologyKey(source)) : [];
    return nearestWallEndpoint(targets, raw, scale, drag.endpoints)?.point ?? gridSnapped;
  }
  move(raw: WallPoint, gridSnapped: WallPoint, snapEndpoints: boolean): void {
    const drag = this.drag, context = this.port.context();
    if (!drag || drag.mode !== "corner") return;
    if (!context || context.sceneId !== drag.sceneId) { this.cancel(); return; }
    const plan = planWallCorner(drag.sceneId, drag.walls, drag.endpoints,
      this.target(raw, gridSnapped, context.scale, snapEndpoints), drag.guard);
    this.preview(plan.ok ? plan.value.preview : null);
  }
  up(raw: WallPoint, gridSnapped: WallPoint, snapEndpoints: boolean): void {
    const drag = this.drag, context = this.port.context();
    if (!drag) return;
    if (!context || context.sceneId !== drag.sceneId) { this.cancel(); this.port.error("Scene changed; wall gesture cancelled."); return; }
    // A click selects a corner; it must not snap/move it accidentally on release.
    const travelled = Math.hypot(raw.x - drag.start.x, raw.y - drag.start.y) * context.scale;
    if ((drag.mode === "corner" && travelled < 2) || (drag.mode === "split" && travelled > 4)) { this.cancel(); return; }
    const plan = drag.mode === "corner"
      ? planWallCorner(drag.sceneId, drag.walls, drag.endpoints, this.target(raw, gridSnapped, context.scale, snapEndpoints), drag.guard)
      : planWallSplit(drag.sceneId, drag.walls, drag.wallId, drag.start, drag.newId, context.scale);
    this.cancel();
    if (!plan.ok) { this.port.error(plan.error); return; }
    if (plan.value.ops.length) this.port.commit(plan.value);
  }
}
