import type { ActionCard } from "../action";

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
/** Opt-in one-publication marker changes. The server can always return a full v1 view. */
export const STRATEGIC_PATCH_TYPE =
  "application/vnd.arenastar.strategic-marker-changes.v1";
export const MARKER_X_BIT = 0x4000;
export const MARKER_Y_BIT = 0x8000;
export const VIEW_PREFIX_BYTES = 8;
export const MARKER_COUNT_BYTES = 4;
export const MARKER_POINT_BYTES = 16;
/** A GM view carries the whole seat roster (500 seats with their units), so the head
 * allowance has to fit a large room while markers stay bounded separately. */
export const MAX_VIEW_META_BYTES = 512 * 1024;
export const MAX_VIEW_BYTES = 4 * 1024 * 1024;

/** Durable shared PF1e compendium document identity; never a strategic-only spell definition. */
export const PF1E_ENTANGLE_DOCUMENT_ID = "pf1e-core-spells-entangle";

export type Point = { x: number; y: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type RoomOrder =
  | { kind: "hold"; stance: "hold" }
  | { kind: "move"; path: Point[]; pace: "march" }
  | { kind: "attack"; targetUnitId: string; mode: "melee" | "shot" }
  | { kind: "cast"; spellId: "entangle"; itemId: string; origin: Point };
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
  | { kind: "member.revoke"; requestId: string; memberId: string }
  | { kind: "member.kick"; requestId: string; memberId: string }
  | { kind: "unit.faction"; requestId: string; unitId: string; factionId: string }
  | {
      kind: "member.invite";
      requestId: string;
      memberId: string;
      /** One-time code; the server stores its digest and an encrypted GM-only resend copy. */
      invite: string;
    }
  | {
      kind: "member.update";
      requestId: string;
      memberId: string;
      name?: string;
      /** Explicit unit allowlist. `undefined` leaves control unchanged. */
      units?: string[];
    };
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
      /** GM-private accepted invite codes; never present on a player's command receipt. */
      invites?: Record<string, string>;
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
  /** Roster/control generation. Same version + a new value means: refetch your authorized view. */
  members?: number;
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
  spells?: Array<{ id: "entangle"; itemId: string; slots: number }>;
};
export type OwnOrders = { revision: number; edits: UnitEdit[] };
/** Service-hosted static media with immutable, content-addressed URLs. */
export type StoreMedia = {
  hash: string;
  name: string;
  mime: string;
  size: number;
  url: string;
};
/** GM-only roster row. Never sent to a player-view response. */
export type MemberRow = {
  id: string;
  name: string;
  role: "GM" | "PLAYER";
  factionId: string | null;
  /** Units this commander may order now; an empty list means visibly no control. */
  units: string[];
  /** The seat's whole deployment, so a withdrawn unit can be granted again. */
  deployed: string[];
  /** A bound browser key is present: this seat cannot be claimed with an invite. */
  claimed: boolean;
  /** GM-only recoverable invite code; null when no active invite can be resent. */
  invite: string | null;
  /** Whether the holder's session is connected right now (heartbeat-based). */
  online: boolean;
};
export type Baseline = {
  epoch: string;
  head: Head;
  name: string;
  bounds: Bounds;
  role: "GM" | "PLAYER";
  factionId: string | null;
  factions: Array<{ id: string; name: string; color: string }>;
  /** Present only for the GM; players never receive the roster. */
  members?: MemberRow[];
  /** Service-hosted authored battlefield background, visible to every admitted participant. */
  background?: StoreMedia;
  /** Active persistent areas rendered from authoritative hosted state. */
  areas?: Array<{ id: string; spell: "entangle" | "burningEntanglement" | "blackTentacles";
    at: Point; radius: number; expiresAfterTurn?: number }>;
  /** Bounded authoritative action history for shared cards and authored FX consumers. */
  actions?: ActionCard[];
  /** GM-only additional service-hosted art, prefetched into the browser cache on view. */
  media?: StoreMedia[];
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
  marchBlocked?: true;
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
/** A GM-assigned display label; carried in messages, never used as an ID or grant. */
export const memberName = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 64;
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
    v.kind === "cast" && only(v, "kind", "spellId", "itemId", "origin") &&
    v.spellId === "entangle" && isId(v.itemId) && point(v.origin)
  ) return { kind: "cast", spellId: "entangle", itemId: v.itemId,
    origin: { x: v.origin.x, y: v.origin.y } };
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
    v.kind === "unit.faction" &&
    only(v, "kind", "requestId", "unitId", "factionId") &&
    isId(v.unitId) && isId(v.factionId)
  ) return { kind: v.kind, requestId, unitId: v.unitId, factionId: v.factionId };
  if (
    v.kind === "member.revoke" &&
    only(v, "kind", "requestId", "memberId") &&
    isId(v.memberId)
  ) {
    return { kind: v.kind, requestId, memberId: v.memberId };
  }
  if (
    v.kind === "member.kick" &&
    only(v, "kind", "requestId", "memberId") &&
    isId(v.memberId)
  ) {
    return { kind: v.kind, requestId, memberId: v.memberId };
  }
  if (
    v.kind === "member.invite" &&
    only(v, "kind", "requestId", "memberId", "invite") &&
    isId(v.memberId) &&
    typeof v.invite === "string" &&
    v.invite.length >= 16 &&
    v.invite.length <= 128
  ) {
    return { kind: v.kind, requestId, memberId: v.memberId, invite: v.invite };
  }
  if (
    v.kind === "member.update" &&
    only(v, "kind", "requestId", "memberId", "name", "units") &&
    isId(v.memberId) &&
    (v.name === undefined || memberName(v.name)) &&
    (v.units === undefined ||
      (Array.isArray(v.units) &&
        v.units.length <= 10 &&
        v.units.every((id) => isId(id)) &&
        new Set(v.units).size === v.units.length))
  ) {
    return {
      kind: v.kind,
      requestId,
      memberId: v.memberId,
      ...(typeof v.name === "string"
        ? { name: v.name.trim().slice(0, 64) }
        : {}),
      ...(Array.isArray(v.units) ? { units: v.units as string[] } : {}),
    };
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
      (typeof v.invite !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(v.invite)))
  )
    return null;
  return {
    kind: "auth",
    publicKey: v.publicKey,
    signature: v.signature,
    ...(v.invite === undefined ? {} : { invite: v.invite }),
  };
}

/** Scope one GM management proof to an operation, deployment origin and battle. The
 * launch credential grants provisioning entitlement; the signature proves seat identity. */
export function campaignProof(
  action: "launch" | "finish",
  origin: string,
  id: string,
  at: number,
  scenario: unknown,
) {
  return JSON.stringify([
    "arenastar-campaign-v1",
    action,
    origin,
    id,
    at,
    scenario ?? null,
  ]);
}
