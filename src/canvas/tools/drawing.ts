import type { DrawingDocument } from "../../core/documents";
import type { DocId, UserId } from "../../core/ids";

export interface Point { x: number; y: number }

/** Reduce pointer samples while preserving the endpoints and visible shape. */
export function simplifyPoints(points: readonly Point[], tolerance = 2): Point[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const tol2 = tolerance * tolerance;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return points.map((p) => ({ ...p }));
  const out: Point[] = [first];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const prev = out.at(-1);
    if (!p || !prev) continue;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    if (dx * dx + dy * dy >= tol2) out.push({ ...p });
  }
  out.push({ ...last });
  return out;
}

/** The rail's draw sub-toolbar (§10): freehand plus the Roll20 shape set. */
export type DrawShape = "freehand" | "rect" | "ellipse" | "line" | "poly";

/** Stroke/fill/width the rail's swatches carry into every shape. */
export interface DrawingStyle {
  stroke: string;
  fill: string;
  strokeWidth: number;
}

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
  stroke: "#ffffff",
  fill: "transparent",
  strokeWidth: 3,
};

/** Normalized axis-aligned box from two drag corners (negative drags included). */
export function boxFromCorners(
  from: Point,
  to: Point,
): [number, number, number, number] {
  return [
    Math.min(from.x, to.x),
    Math.min(from.y, to.y),
    Math.abs(to.x - from.x),
    Math.abs(to.y - from.y),
  ];
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

function shapeDocument(
  id: DocId,
  kind: DrawingDocument["kind"],
  name: string,
  userId: UserId,
  style: Partial<DrawingStyle>,
): DrawingDocument {
  return {
    _id: id,
    type: "drawing",
    name,
    ownership: { default: 0, [userId]: 3 },
    flags: { core: { createdBy: userId } },
    system: {},
    kind,
    points: [],
    box: null,
    stroke: style.stroke ?? DEFAULT_DRAWING_STYLE.stroke,
    fill: style.fill ?? DEFAULT_DRAWING_STYLE.fill,
    strokeWidth: style.strokeWidth ?? DEFAULT_DRAWING_STYLE.strokeWidth,
    text: null,
  };
}

/** Rectangle from a drag (Roll20's default shape). */
export function drawingForRect(
  id: DocId,
  from: Point,
  to: Point,
  userId: UserId,
  style: Partial<DrawingStyle> = {},
): DrawingDocument {
  const doc = shapeDocument(id, "rect", "Rectangle", userId, style);
  doc.box = boxFromCorners(from, to);
  return doc;
}

/** Ellipse from a drag (Roll20: `Alt` while the rectangle tool is active). */
export function drawingForEllipse(
  id: DocId,
  from: Point,
  to: Point,
  userId: UserId,
  style: Partial<DrawingStyle> = {},
): DrawingDocument {
  const doc = shapeDocument(id, "ellipse", "Ellipse", userId, style);
  doc.box = boxFromCorners(from, to);
  return doc;
}

/** Open segment from a drag (Roll20's "one segment + finish" line). */
export function drawingForLine(
  id: DocId,
  from: Point,
  to: Point,
  userId: UserId,
  style: Partial<DrawingStyle> = {},
): DrawingDocument {
  const doc = shapeDocument(id, "line", "Line", userId, style);
  doc.points = [from.x, from.y, to.x, to.y];
  return doc;
}

/** Closed polygon from clicked vertices (Roll20's Polygon/Line tool). */
export function drawingForPoly(
  id: DocId,
  points: readonly Point[],
  userId: UserId,
  style: Partial<DrawingStyle> = {},
): DrawingDocument {
  const doc = shapeDocument(id, "poly", "Polygon", userId, style);
  doc.points = points.flatMap((p) => [p.x, p.y]);
  return doc;
}

/** The shape factory the draw gesture commits through, by sub-tool. */
export function drawingForShape(
  shape: DrawShape,
  id: DocId,
  gesture: { from: Point; to: Point; points?: readonly Point[] },
  userId: UserId,
  style: Partial<DrawingStyle> = {},
): DrawingDocument {
  switch (shape) {
    case "rect":
      return drawingForRect(id, gesture.from, gesture.to, userId, style);
    case "ellipse":
      return drawingForEllipse(id, gesture.from, gesture.to, userId, style);
    case "line":
      return drawingForLine(id, gesture.from, gesture.to, userId, style);
    case "poly":
      return drawingForPoly(id, gesture.points ?? [gesture.from, gesture.to], userId, style);
    case "freehand":
      return drawingForFreehand(id, gesture.points ?? [gesture.from, gesture.to], userId, style);
  }
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
