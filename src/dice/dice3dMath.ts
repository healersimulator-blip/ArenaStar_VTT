/**
 * §11 3D dice — pure planning math (no three.js import; node-tested).
 * Dice settle onto the DETERMINED face: the host has already resolved the
 * roll; the animation is cosmetic and must land showing the actual values.
 */

/** Cube face order matches three.js BoxGeometry material slots:
 * 0:+x 1:-x 2:+y 3:-y 4:+z 5:-z. */
export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5;
export const TOP_FACE = 2 as CubeFace;

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Quaternion rotating cube face `face` to the top (+y). Derived from axis
 * rotations; identity for the already-top face.
 */
export function orientationForTopFace(face: CubeFace): Quaternion {
  switch (face) {
    case 2: // +y already top
      return { x: 0, y: 0, z: 0, w: 1 };
    case 3: // -y: π about X (or Z)
      return { x: 1, y: 0, z: 0, w: 0 };
    case 0: // +x → +y: +π/2 about Z
      return { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    case 1: // -x → +y: -π/2 about Z
      return { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 };
    case 4: // +z → +y: -π/2 about X
      return { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    case 5: // -z → +y: +π/2 about X
      return { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
  }
}

/** Deterministic label spread for the five non-top faces (1..sides). */
export function fillerLabels(sides: number, topValue: number): number[] {
  const out: number[] = [];
  const step = Math.max(1, Math.floor(sides / 6));
  const v = Math.max(1, topValue - 2 * step);
  for (let i = 0; i < 5; i++) {
    let label = v + i * step;
    if (label > sides) label = ((label - 1) % sides) + 1;
    if (label === topValue) label = (label % sides) + 1;
    out.push(label);
  }
  return out;
}

export interface DieFacePlan {
  sides: number;
  value: number;
  /** Material-slot labels; labels[TOP_SLOT after orientation] shows value. */
  labels: [number, number, number, number, number, number];
  /** Face slot that will be rotated to the top. */
  topSlot: CubeFace;
  orientation: Quaternion;
}

/** Plan one die: the given face slot carries the rolled value and ends up. */
export function planDieFaces(sides: number, value: number, topSlot: CubeFace = 0): DieFacePlan {
  const fillers = fillerLabels(sides, value);
  const labels: number[] = [0, 0, 0, 0, 0, 0];
  labels[topSlot] = value;
  let fi = 0;
  for (let i = 0; i < 6; i++) {
    if (i === topSlot) continue;
    labels[i] = fillers[fi] ?? value;
    fi++;
  }
  return {
    sides,
    value,
    labels: labels as DieFacePlan["labels"],
    topSlot,
    orientation: orientationForTopFace(topSlot),
  };
}

// ─── roll-record → dice list ──────────────────────────────────────────────────

export interface DieSpec {
  sides: number;
  value: number;
}

/** Scene cap — extra dice roll but do not animate. */
export const MAX_3D_DICE = 8;

/**
 * Extract display dice from a RollEvaluation's terms: every KEPT value of
 * every dice term becomes one die of that term's sides. Non-dice terms are
 * ignored (math has no faces).
 */
export function diceFromTerms(terms: readonly unknown[]): DieSpec[] {
  const out: DieSpec[] = [];
  for (const raw of terms) {
    if (typeof raw !== "object" || raw === null) continue;
    const term = raw as { kind?: unknown; expr?: unknown; kept?: unknown };
    if (term.kind !== "dice") continue;
    const sidesMatch = /d(\d+)/.exec(String(term.expr ?? ""));
    if (!sidesMatch) continue;
    const sides = Number(sidesMatch[1]);
    if (!Number.isInteger(sides) || sides < 2 || sides > 1000) continue;
    const kept = Array.isArray(term.kept) ? term.kept : [];
    for (const value of kept) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
        out.push({ sides, value });
      }
    }
  }
  return out.slice(0, MAX_3D_DICE);
}
