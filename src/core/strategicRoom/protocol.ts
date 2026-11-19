/** Opt-in hosted wire. No legacy world/OpLog or raw ModelPool frames cross it. */
export const STRATEGIC_VERSION = 1;
export const STRATEGIC_CODEC = 2;
export const STRATEGIC_PROTOCOL = "arenastar.strategic.v1.pos2";
export const STRATEGIC_API = "/api/strategic";
export const MAX_FRAME = 16 * 1024;
export const MAX_EDITS = 10;
export const MAX_WAYPOINTS = 12;
export const REGION_SIZE = 120;
export const MAX_REGION_MODELS = 1200;
export const PAGE_ROWS = 40;
export const STRATEGIC_VIEW_TYPE =
  "application/vnd.arenastar.strategic-view.v1";
export const VIEW_PREFIX_BYTES = 8;
export const MARKER_COUNT_BYTES = 4;
export const MARKER_POINT_BYTES = 16;
export const MAX_VIEW_META_BYTES = 64 * 1024;
export const MAX_VIEW_BYTES = 4 * 1024 * 1024;

export type Point = { x: number; y: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type RoomOrder =
  | { kind: "hold"; stance: "hold" }
  | { kind: "move"; path: Point[]; pace: "march" }
  | { kind: "attack"; targetUnitId: string; mode: "melee" | "shot" };
export type UnitEdit = { unitId: string; order: RoomOrder | null };
export type OrdersSubmit = {
  kind: "orders.submit";
  requestId: string;
  turnId: number;
  expectedRevision: number;
  unitEdits: UnitEdit[];
};
export type Command =
  | OrdersSubmit
  | { kind: "turn.close" | "turn.retry"; requestId: string; turnId: number }
  | {
      kind: "turn.next";
      requestId: string;
      turnId: number;
      durationMs: number | null;
    }
  | { kind: "member.revoke"; requestId: string; memberId: string };
export type RejectCode =
  | "forbidden"
  | "turn_closed"
  | "wrong_phase"
  | "stale_revision"
  | "request_reused"
  | "invalid_order"
  | "unavailable"
  | "busy";
export type Receipt =
  | {
      kind: "receipt";
      requestId: string;
      status: "accepted";
      turnId: number;
      revision?: number;
    }
  | {
      kind: "receipt";
      requestId: string;
      status: "rejected";
      code: RejectCode;
      detail: string;
    };

export type AuthProof = {
  kind: "auth";
  publicKey: string;
  signature: string;
  invite?: string;
};
export type Head = {
  turnId: number;
  version: number;
  phase: "orders" | "resolution" | "report" | "paused";
  deadlineMs: number | null;
};
export type ServerMessage =
  | { kind: "challenge"; room: string; nonce: string }
  | { kind: "welcome"; epoch: string; bearer: string; role: "GM" | "PLAYER" }
  | { kind: "head"; epoch: string; seq: number; head: Head }
  | Receipt
  | { kind: "error"; code: "not_admitted" | "invalid_message" | "unavailable" };

/** Enemy positions only derive from visible models; full strength is private. */
export type UnitMarker = {
  id: string;
  name: string;
  factionId: string;
  at: Point;
};
export type OwnUnit = {
  id: string;
  name: string;
  at: Point | null;
  alive: number;
  weapon: "melee" | "shot";
};
export type OwnOrders = { revision: number; edits: UnitEdit[] };
export type Baseline = {
  epoch: string;
  head: Head;
  name: string;
  bounds: Bounds;
  role: "GM" | "PLAYER";
  factionId: string | null;
  factions: Array<{ id: string; name: string; color: string }>;
  markers: UnitMarker[];
  own: OwnUnit[];
  orders: OwnOrders;
};
export type BaselineMeta = Omit<Baseline, "markers">;
/** Parallel id/name/faction columns, indexed in the same order as the point table. */
export type MarkerLabels = [string[], string[], number[]];
export type ModelMarker = Point & {
  id: string;
  unitId: string;
  rotation: number;
};
export type RegionPatch = {
  epoch: string;
  version: number;
  cursor: number;
  fromCursor: number | null;
  enter: ModelMarker[];
  update: ModelMarker[];
  leave: string[];
  /** Dense views beyond the detail budget still render unit summaries. */
  truncated: boolean;
};
export type ReportRow = {
  unitId: string;
  name: string;
  before: number;
  alive: number;
  lost: number;
  order: RoomOrder["kind"] | null;
};
export type ReportPage = {
  epoch: string;
  version: number;
  page: number;
  hasMore: boolean;
  rows: ReportRow[];
};

export function authPayload(
  room: string,
  origin: string,
  nonce: string,
): string {
  return JSON.stringify([STRATEGIC_PROTOCOL, room, origin, nonce]);
}

export function reject(
  requestId: string,
  code: RejectCode,
  detail: string,
): Receipt {
  return { kind: "receipt", requestId, status: "rejected", code, detail };
}

export const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
export const isRequestId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);
export const isPublicKey = (v: unknown): v is string =>
  typeof v === "string" && /^(?:[0-9a-f]{64}|04[0-9a-f]{128})$/.test(v);
export const integer = (
  v: unknown,
  min: number,
  max = 2_147_483_646,
): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && min <= v && v <= max;
export const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
export const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export const only = (v: Record<string, unknown>, ...keys: string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));
export const point = (v: unknown): v is Point =>
  record(v) && only(v, "x", "y") && finite(v.x) && finite(v.y);

function parseOrder(v: unknown): RoomOrder | null {
  if (!record(v)) return null;
  if (v.kind === "hold" && v.stance === "hold" && only(v, "kind", "stance"))
    return { kind: "hold", stance: "hold" };
  if (
    v.kind === "attack" &&
    only(v, "kind", "targetUnitId", "mode") &&
    isId(v.targetUnitId) &&
    (v.mode === "melee" || v.mode === "shot")
  ) {
    return { kind: "attack", targetUnitId: v.targetUnitId, mode: v.mode };
  }
  if (
    v.kind === "move" &&
    only(v, "kind", "pace", "path") &&
    v.pace === "march" &&
    Array.isArray(v.path) &&
    v.path.length > 0 &&
    v.path.length <= MAX_WAYPOINTS &&
    v.path.every(point)
  ) {
    return {
      kind: "move",
      path: v.path.map(({ x, y }) => ({ x, y })),
      pace: "march",
    };
  }
  return null;
}

/** Strict allowlist; rebuild in a fixed key order for durable request identity. */
export function parseCommand(v: unknown): Command | null {
  if (!record(v) || !isRequestId(v.requestId)) return null;
  const requestId = v.requestId;
  if (
    v.kind === "member.revoke" &&
    only(v, "kind", "requestId", "memberId") &&
    isId(v.memberId)
  ) {
    return { kind: v.kind, requestId, memberId: v.memberId };
  }
  if (!integer(v.turnId, 1)) return null;
  const turnId = v.turnId;
  if (
    (v.kind === "turn.close" || v.kind === "turn.retry") &&
    only(v, "kind", "requestId", "turnId")
  ) {
    return { kind: v.kind, requestId, turnId };
  }
  if (
    v.kind === "turn.next" &&
    only(v, "kind", "requestId", "turnId", "durationMs") &&
    (v.durationMs === null || integer(v.durationMs, 1000, 24 * 3600 * 1000))
  ) {
    return { kind: v.kind, requestId, turnId, durationMs: v.durationMs };
  }
  if (
    v.kind !== "orders.submit" ||
    !only(v, "kind", "requestId", "turnId", "expectedRevision", "unitEdits") ||
    !integer(v.expectedRevision, 0) ||
    !Array.isArray(v.unitEdits) ||
    v.unitEdits.length === 0 ||
    v.unitEdits.length > MAX_EDITS
  )
    return null;
  const unitEdits: UnitEdit[] = [];
  const ids = new Set<string>();
  for (const edit of v.unitEdits as unknown[]) {
    if (
      !record(edit) ||
      !only(edit, "unitId", "order") ||
      !isId(edit.unitId) ||
      ids.has(edit.unitId)
    )
      return null;
    const order = edit.order === null ? null : parseOrder(edit.order);
    if (edit.order !== null && order === null) return null;
    ids.add(edit.unitId);
    unitEdits.push({ unitId: edit.unitId, order });
  }
  return {
    kind: v.kind,
    requestId,
    turnId,
    expectedRevision: v.expectedRevision,
    unitEdits,
  };
}

export function parseAuth(v: unknown): AuthProof | null {
  if (
    !record(v) ||
    v.kind !== "auth" ||
    !only(v, "kind", "publicKey", "signature", "invite") ||
    !isPublicKey(v.publicKey) ||
    typeof v.signature !== "string" ||
    !/^[0-9a-f]{128}$/.test(v.signature) ||
    (v.invite !== undefined &&
      (typeof v.invite !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(v.invite)))
  )
    return null;
  return {
    kind: "auth",
    publicKey: v.publicKey,
    signature: v.signature,
    ...(v.invite === undefined ? {} : { invite: v.invite }),
  };
}
