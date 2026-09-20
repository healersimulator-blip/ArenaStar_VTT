import type { DrawingDocument } from "../../core/documents";
import type { DocId, UserId } from "../../core/ids";

export interface Point { x: number; y: number }

/** Reduce pointer samples while preserving the endpoints and visible shape. */
export function simplifyPoints(points: readonly Point[], tolerance = 2): Point[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const tol2 = tolerance * tolerance;
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const prev = out[out.length - 1]!;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    if (dx * dx + dy * dy >= tol2) out.push({ ...p });
  }
  out.push({ ...points[points.length - 1]! });
  return out;
}

export function drawingForFreehand(
  id: DocId,
  points: readonly Point[],
  userId: UserId,
  style: Partial<Pick<DrawingDocument, "stroke" | "fill" | "strokeWidth">> = {},
): DrawingDocument {
  const sampled = simplifyPoints(points);
  return {
    _id: id,
    type: "drawing",
    name: "Drawing",
    ownership: { default: 0, [userId]: 3 },
    flags: { core: { createdBy: userId } },
    system: {},
    kind: "freehand",
    points: sampled.flatMap((p) => [p.x, p.y]),
    box: null,
    stroke: style.stroke ?? "#ffffff",
    fill: style.fill ?? "transparent",
    strokeWidth: style.strokeWidth ?? 3,
    text: null,
  };
}

export function drawingForText(
  id: DocId,
  at: Point,
  text: string,
  userId: UserId,
  options: { width?: number; height?: number; color?: string; background?: string } = {},
): DrawingDocument {
  return {
    _id: id,
    type: "drawing",
    name: text.slice(0, 80) || "Label",
    ownership: { default: 0, [userId]: 3 },
    flags: { core: { createdBy: userId } },
    system: {},
    kind: "text",
    points: [],
    box: [at.x, at.y, options.width ?? 180, options.height ?? 32],
    stroke: options.color ?? "#ffffff",
    fill: options.background ?? "#111827cc",
    strokeWidth: 0,
    text: text || "Label",
  };
}

export function canEditDrawing(
  drawing: Pick<DrawingDocument, "ownership" | "flags">,
  userId: string,
  isGM: boolean,
): boolean {
  if (isGM) return true;
  const createdBy = drawing.flags.core?.createdBy;
  return createdBy === userId || drawing.ownership[userId] === 3;
}
