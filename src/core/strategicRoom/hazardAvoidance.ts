import type { Point } from "./protocol";

/** Frozen, replay-safe persistent spell area. Turns are inclusive; omitted bounds mean authored
 * pre-existing terrain that remains active for the battle. */
export type SpellHazard = {
  id: string;
  spell: "entangle" | "burningEntanglement" | "blackTentacles";
  at: Point;
  radius: number;
  startsTurn?: number;
  expiresAfterTurn?: number;
  dc?: number;
  casterLevel?: number;
  casterFactionId?: string;
};

export const spellHazardActive = (hazard: SpellHazard, turn: number): boolean =>
  turn >= (hazard.startsTurn ?? 0) && turn <= (hazard.expiresAfterTurn ?? Number.MAX_SAFE_INTEGER);

export const pointInSpellHazard = (hazard: SpellHazard, point: Point, margin = 0): boolean =>
  Math.hypot(point.x - hazard.at.x, point.y - hazard.at.y) <= hazard.radius + margin;

export function segmentHitsSpellHazard(hazard: SpellHazard, from: Point, to: Point, margin = 0): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1,
    ((hazard.at.x - from.x) * dx + (hazard.at.y - from.y) * dy) / length2,
  ));
  return Math.hypot(from.x + t * dx - hazard.at.x, from.y + t * dy - hazard.at.y) <= hazard.radius + margin;
}

/** Combat Resolver 5 C5/C13 semantics: flee the zone first, clamp unsafe goals, then use stable
 * same-side outer waypoints. Starting inside one area is an exception only for that area. */
export function routeAroundSpellHazards(
  from: Point,
  requested: Point,
  hazards: readonly SpellHazard[],
  clearance = 5,
): Point[] {
  let goal = { ...requested };
  for (let pass = 0; pass < hazards.length; pass++) {
    const hazard = hazards.find((candidate) => pointInSpellHazard(candidate, goal));
    if (!hazard) break;
    let dx = goal.x - hazard.at.x;
    const dy = goal.y - hazard.at.y;
    if (dx === 0 && dy === 0) dx = 1;
    const length = Math.hypot(dx, dy);
    goal = { x: hazard.at.x + dx / length * (hazard.radius + clearance),
      y: hazard.at.y + dy / length * (hazard.radius + clearance) };
  }
  const points: Point[] = [];
  let cursor = from;
  // A formation in harm spends its movement heading directly to the nearest safe rim, regardless
  // of an order that would drag it through the zone. This also gives overlapping areas separate
  // leave exceptions, matching entersLiveHarm in the reference.
  for (const hazard of hazards) {
    if (!pointInSpellHazard(hazard, cursor, clearance)) continue;
    let dx = cursor.x - hazard.at.x;
    const dy = cursor.y - hazard.at.y;
    if (dx === 0 && dy === 0) dx = 1;
    const length = Math.hypot(dx, dy);
    cursor = { x: hazard.at.x + dx / length * (hazard.radius + clearance),
      y: hazard.at.y + dy / length * (hazard.radius + clearance) };
    points.push(cursor);
  }
  const routed = new Set<string>();
  for (let pass = 0; pass < Math.min(8, hazards.length); pass++) {
    const hazard = hazards.find((candidate) => !routed.has(candidate.id) &&
      !pointInSpellHazard(candidate, cursor) && segmentHitsSpellHazard(candidate, cursor, goal, clearance));
    if (!hazard) break;
    routed.add(hazard.id);
    const dx = goal.x - cursor.x, dy = goal.y - cursor.y, length = Math.hypot(dx, dy) || 1;
    const ux = dx / length, uy = dy / length, px = -uy, py = ux;
    const radius = hazard.radius + clearance;
    const entry = { x: hazard.at.x - ux * radius + px * radius,
      y: hazard.at.y - uy * radius + py * radius };
    const exit = { x: hazard.at.x + ux * radius + px * radius,
      y: hazard.at.y + uy * radius + py * radius };
    points.push(entry, exit);
    cursor = exit;
  }
  points.push(goal);
  return points;
}
