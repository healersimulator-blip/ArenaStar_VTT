/**
 * §9A order visualisation — ephemeral overlays derived from Unit.orders
 * (no extra Documents): planned paths, charge arrows, target lines for the
 * OWNING faction; the GM sees all. Pure geometry; the renderer is
 * src/canvas/layers/OrderOverlay.ts.
 */
import type { Order, OrderQueue, Vec2 } from "../../core/strategic";

export interface OverlayUnit {
  id: string;
  factionId: string;
  /** Faction color (parsed) for strokes. */
  color: number;
  /** Unit anchor (centroid of drawable models); null = off-scene. */
  anchor: Vec2 | null;
  orders: OrderQueue | null;
}

export interface MovePathOverlay {
  unitId: string;
  color: number;
  /** [anchor, ...waypoints] in world coords. */
  points: Vec2[];
  pace: string;
}

export interface TargetLineOverlay {
  unitId: string;
  targetUnitId: string;
  color: number;
  from: Vec2;
  to: Vec2;
}

export interface OrderOverlayGeometry {
  /** Planned move paths (pace !== "charge"). */
  paths: MovePathOverlay[];
  /** Charge arrows (pace === "charge"). */
  charges: MovePathOverlay[];
  /** Attack target lines (dashed). */
  targets: TargetLineOverlay[];
}

/**
 * Visibility predicate for order overlays: GM (null factions) sees all;
 * otherwise a viewer sees a unit's orders only for their own factions
 * (§9A "for the owning faction; GM sees all").
 */
export function orderVisibility(
  viewerFactionIds: Set<string> | null,
): (unit: OverlayUnit) => boolean {
  if (viewerFactionIds === null) return () => true;
  return (unit) => viewerFactionIds.has(unit.factionId);
}

function firstOrder(queue: OrderQueue | null): Order | null {
  if (!queue) return null;
  return queue.active ?? queue.pending[0] ?? null;
}

/** Build overlay geometry from unit order queues + the visibility filter. */
export function orderOverlayGeometry(
  units: readonly OverlayUnit[],
  isVisible: (unit: OverlayUnit) => boolean,
): OrderOverlayGeometry {
  const byId = new Map(units.map((u) => [u.id, u] as const));
  const geometry: OrderOverlayGeometry = { paths: [], charges: [], targets: [] };
  for (const unit of units) {
    if (!unit.anchor) continue;
    if (!isVisible(unit)) continue;
    const order = firstOrder(unit.orders);
    if (!order) continue;
    if (order.kind === "move") {
      if (order.path.length === 0) continue;
      const overlay: MovePathOverlay = {
        unitId: unit.id,
        color: unit.color,
        points: [unit.anchor, ...order.path],
        pace: order.pace,
      };
      if (order.pace === "charge") geometry.charges.push(overlay);
      else geometry.paths.push(overlay);
    } else if (order.kind === "attack") {
      const target = byId.get(order.targetUnitId);
      // target anchors of enemy units are hidden from players: callers pass
      // only drawable anchors, so a missing anchor just drops the line
      if (!target || !target.anchor) continue;
      geometry.targets.push({
        unitId: unit.id,
        targetUnitId: target.id,
        color: unit.color,
        from: unit.anchor,
        to: target.anchor,
      });
    } else if (order.kind === "retreat") {
      geometry.paths.push({
        unitId: unit.id,
        color: 0x9aa0a8,
        points: [unit.anchor, order.toward],
        pace: "retreat",
      });
    }
    // hold / formation / supply / custom carry no line geometry
  }
  return geometry;
}
