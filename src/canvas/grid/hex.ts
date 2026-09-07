/**
 * §9 hex grid math — pure geometry for the 4 §0 layouts (HexLayout):
 *   evenQ / oddQ → flat-top hexes in staggered columns
 *   evenR / oddR → pointy-top hexes in staggered rows
 * `size` is the circumradius (center → corner) — recorded in D-076.
 *
 * Coordinate pipeline: pixel → fractional axial → cube-rounded axial →
 * offset (q, r). Distance is cube distance between axial coords.
 */
import type { HexLayout } from "../../core/documents";

export interface Axial {
  q: number;
  r: number;
}

export interface Pixel {
  x: number;
  y: number;
}

export interface HexGridSpec {
  type: "hex";
  /** Circumradius in world units. */
  size: number;
  layout: HexLayout;
}

const SQRT3 = Math.sqrt(3);

// ─── offset ⇄ axial (Red Blob formulas, negative-safe via (v & 1)) ───────────

export function offsetToAxial(layout: HexLayout, q: number, r: number): Axial {
  switch (layout) {
    case "oddR":
      return { q: q - (r - (r & 1)) / 2, r };
    case "evenR":
      return { q: q - (r + (r & 1)) / 2, r };
    case "oddQ":
      return { q, r: r - (q - (q & 1)) / 2 };
    case "evenQ":
      return { q, r: r - (q + (q & 1)) / 2 };
  }
}

export function axialToOffset(layout: HexLayout, a: Axial): { q: number; r: number } {
  switch (layout) {
    case "oddR":
      return { q: a.q + (a.r - (a.r & 1)) / 2, r: a.r };
    case "evenR":
      return { q: a.q + (a.r + (a.r & 1)) / 2, r: a.r };
    case "oddQ":
      return { q: a.q, r: a.r + (a.q - (a.q & 1)) / 2 };
    case "evenQ":
      return { q: a.q, r: a.r + (a.q + (a.q & 1)) / 2 };
  }
}

// ─── axial ⇄ pixel ───────────────────────────────────────────────────────────

/** Center pixel of an axial hex. */
export function axialToPixel(size: number, flat: boolean, a: Axial): Pixel {
  if (flat) return { x: size * 1.5 * a.q, y: size * SQRT3 * (a.r + a.q / 2) };
  return { x: size * SQRT3 * (a.q + a.r / 2), y: size * 1.5 * a.r };
}

/** Fractional axial hex containing a pixel. */
export function pixelToAxial(size: number, flat: boolean, p: Pixel): Axial {
  if (flat) {
    const q = (p.x * 2) / 3 / size;
    const r = (-p.x / 3 + (SQRT3 / 3) * p.y) / size;
    return { q, r };
  }
  const q = ((SQRT3 / 3) * p.x - p.y / 3) / size;
  const r = (p.y * 2) / 3 / size;
  return { q, r };
}

/** Cube-round a fractional axial to the containing hex center. */
export function roundAxial(a: Axial): Axial {
  const x = a.q;
  const z = a.r;
  const y = -x - z;
  const rx = Math.round(x);
  const ry = Math.round(y);
  const rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  // reset the axis with the largest rounding error (Red Blob cube round);
  // +0 normalizes -0
  if (dx > dy && dx > dz) return { q: -ry - rz + 0, r: rz + 0 }; // reset x
  if (dy > dz) return { q: rx + 0, r: rz + 0 }; // reset y (axial q/r unchanged)
  return { q: rx + 0, r: -rx - ry + 0 }; // reset z
}

export function layoutIsFlat(layout: HexLayout): boolean {
  return layout === "evenQ" || layout === "oddQ";
}

/** Offset hex containing a pixel. */
export function hexFromPixel(grid: HexGridSpec, x: number, y: number): { q: number; r: number } {
  const axial = roundAxial(pixelToAxial(grid.size, layoutIsFlat(grid.layout), { x, y }));
  return axialToOffset(grid.layout, axial);
}

/** Center pixel of an offset hex. */
export function hexCenter(grid: HexGridSpec, q: number, r: number): Pixel {
  return axialToPixel(grid.size, layoutIsFlat(grid.layout), offsetToAxial(grid.layout, q, r));
}

/** Hex-count distance between two offset hexes (cube distance). */
export function hexDistance(
  grid: HexGridSpec,
  a: { q: number; r: number },
  b: { q: number; r: number },
): number {
  const aa = offsetToAxial(grid.layout, a.q, a.r);
  const ab = offsetToAxial(grid.layout, b.q, b.r);
  const dq = aa.q - ab.q;
  const dr = aa.r - ab.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

/** Six neighbors of an offset hex. */
export function hexNeighbors(
  grid: HexGridSpec,
  q: number,
  r: number,
): Array<{ q: number; r: number }> {
  const axial = offsetToAxial(grid.layout, q, r);
  const dirs: Axial[] = [
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ];
  return dirs.map((d) => axialToOffset(grid.layout, { q: axial.q + d.q, r: axial.r + d.r }));
}

/** Hex corner pixels (drawing); flat layouts start at 0°, pointy at 30°. */
export function hexCorners(grid: HexGridSpec, center: Pixel): Pixel[] {
  const flat = layoutIsFlat(grid.layout);
  const out: Pixel[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - (flat ? 0 : 30));
    out.push({
      x: center.x + grid.size * Math.cos(angle),
      y: center.y + grid.size * Math.sin(angle),
    });
  }
  return out;
}

/**
 * Offset hexes whose centers fall inside a world rect (expanded by the hex
 * diameter) — the grid layer draws exactly these.
 */
export function hexesInView(
  grid: HexGridSpec,
  view: { x: number; y: number; width: number; height: number },
): Array<{ q: number; r: number }> {
  const margin = grid.size * 2;
  const flat = layoutIsFlat(grid.layout);
  const x0 = view.x - margin;
  const x1 = view.x + view.width + margin;
  const y0 = view.y - margin;
  const y1 = view.y + view.height + margin;
  // coarse offset-coordinate ranges (over-inclusive; filtered by center)
  const qSpan = flat ? grid.size * 1.5 : grid.size * SQRT3;
  const rSpan = flat ? grid.size * SQRT3 : grid.size * 1.5;
  const qMin = Math.floor(x0 / qSpan) - 2;
  const qMax = Math.ceil(x1 / qSpan) + 2;
  const rMin = Math.floor(y0 / rSpan) - 2;
  const rMax = Math.ceil(y1 / rSpan) + 2;
  const out: Array<{ q: number; r: number }> = [];
  for (let q = qMin; q <= qMax; q++) {
    for (let r = rMin; r <= rMax; r++) {
      const c = hexCenter(grid, q, r);
      if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1) out.push({ q, r });
    }
  }
  return out;
}
