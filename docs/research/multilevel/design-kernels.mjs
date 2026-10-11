/**
 * Original, isolated design examples for MULTILEVEL_WALLS_DESIGN.md.
 * Not imported by the app; not a port of Foundry/Better Levels/Monk code.
 * These cover narrow contracts, NOT a complete geometry or authorization engine.
 */
export function levelAtZ(levels, z) {
  if (!Number.isFinite(z)) throw new Error("Elevation must be finite");
  const matches = levels.filter(
    (level) =>
      (level.bottom === null || z >= level.bottom) &&
      (level.top === null || z < level.top),
  );
  if (matches.length > 1) throw new Error("Overlapping level bands");
  return matches[0]?.id ?? null;
}

export function pixelTolerance(cssPixels, cameraScale) {
  if (
    !Number.isFinite(cssPixels) ||
    cssPixels < 0 ||
    !Number.isFinite(cameraScale) ||
    cameraScale <= 0
  )
    throw new Error("Invalid tolerance or camera scale");
  return cssPixels / cameraScale;
}

/** Endpoints are already validated/canonicalized by the authoring schema. */
export function nearestEndpoint(
  endpoints,
  point,
  cssPixels,
  cameraScale,
  topologyKey,
) {
  const tolerance = pixelTolerance(cssPixels, cameraScale);
  const candidates = endpoints
    .filter(
      (endpoint) => !endpoint.locked && endpoint.topologyKey === topologyKey,
    )
    .map((endpoint) => ({
      endpoint,
      distance2: (endpoint.x - point.x) ** 2 + (endpoint.y - point.y) ** 2,
    }))
    .filter((candidate) => candidate.distance2 <= tolerance ** 2);
  candidates.sort(
    (a, b) =>
      a.distance2 - b.distance2 ||
      (a.endpoint.wallId < b.endpoint.wallId
        ? -1
        : a.endpoint.wallId > b.endpoint.wallId
          ? 1
          : 0) ||
      a.endpoint.end - b.endpoint.end,
  );
  return candidates[0]?.endpoint ?? null;
}

/** t is obtained from our existing wall-pick projection, not raw cursor XY.
 * Host must still validate permissions, revision, reference integrity and new ID uniqueness.
 * Portal splitting is deliberately rejected, including legacy conditional-axis doors.
 */
export function planPlainWallSplit(sceneId, wall, t, newId) {
  if (!Number.isFinite(t) || t <= 0 || t >= 1)
    throw new Error("Split must be inside the segment");
  if (
    wall.portal ||
    ["move", "sight", "light", "sound"].some((axis) => wall[axis] === 1)
  )
    throw new Error("Portal requires an explicit grouped split plan");
  if (!newId || newId === wall._id) throw new Error("A fresh ID is required");
  const [ax, ay, bx, by] = wall.c;
  if (![ax, ay, bx, by].every(Number.isFinite) || (ax === bx && ay === by))
    throw new Error("Invalid wall geometry");
  const x = ax + t * (bx - ax),
    y = ay + t * (by - ay);
  const parent = { coll: "scenes", id: sceneId };
  // Documents contain JSON data. Copying here is isolated preview data, never a store mutation.
  const second = JSON.parse(JSON.stringify(wall));
  second._id = newId;
  second.c = [x, y, bx, by];
  second.parent = parent;
  return [
    {
      kind: "update",
      ref: { coll: "walls", id: wall._id, parent },
      diff: { c: [ax, ay, x, y] },
    },
    { kind: "create", coll: "walls", parent, data: second },
  ];
}

/** Unit-consistent ray/plane math only. Boundary/coplanar classification is explicit;
 * a caller must not turn the "coplanar" result into unconditional visibility.
 */
export function crossHorizontalPlane(a, b, z, epsilon = 1e-9) {
  if (
    ![a.x, a.y, a.z, b.x, b.y, b.z, z, epsilon].every(Number.isFinite) ||
    epsilon < 0
  )
    throw new Error("Invalid ray");
  const dz = b.z - a.z;
  if (Math.abs(dz) <= epsilon)
    return Math.abs(a.z - z) <= epsilon
      ? { kind: "coplanar" }
      : { kind: "none" };
  const t = (z - a.z) / dz;
  if (t < -epsilon || t > 1 + epsilon) return { kind: "none" };
  const bounded = Math.max(0, Math.min(1, t));
  return {
    kind: "point",
    t: bounded,
    x: a.x + bounded * (b.x - a.x),
    y: a.y + bounded * (b.y - a.y),
  };
}

/** Policy example for an ALREADY geometrically covered token, not a visibility solver.
 * "privileged" means owned-token/GM diagnostic display; it does not grant attack LOS.
 */
export function coveredTokenPresentation({
  authorized,
  visibleByLos,
  privileged,
  preference,
}) {
  if (!["hidden", "ghost", "hitbox", "normal"].includes(preference))
    throw new Error("Invalid preference");
  if (!authorized || (!visibleByLos && !privileged))
    return { mode: "hidden", targetCandidate: false, hitTest: false };
  if (visibleByLos)
    return {
      mode: preference === "hidden" ? "ghost" : preference,
      targetCandidate: true,
      hitTest: true,
    };
  return {
    mode: preference,
    targetCandidate: false,
    hitTest: preference !== "hidden",
  };
}

export function fogKey(worldId, sceneId, levelId, userId) {
  if (
    ![worldId, sceneId, levelId, userId].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    throw new Error("Fog identity is incomplete");
  return JSON.stringify([worldId, sceneId, levelId, userId]);
}
