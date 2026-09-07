/** §9 drawing bounds (pure) — freehand/poly → point bbox; rect/text → box. */
export function drawingBounds(d: {
  kind: "freehand" | "poly" | "rect" | "text";
  points: number[];
  box: [number, number, number, number] | null;
}): { x: number; y: number; width: number; height: number } | null {
  if (d.kind === "rect" || d.kind === "text") {
    const b = d.box;
    return b ? { x: b[0], y: b[1], width: b[2], height: b[3] } : null;
  }
  const pts = d.points;
  if (pts.length < 4) return null; // a drawable needs ≥ 2 points
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i] ?? 0;
    const y = pts[i + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
