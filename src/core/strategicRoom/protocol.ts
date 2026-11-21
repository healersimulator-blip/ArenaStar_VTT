import type { ActionCard } from "../action";

/** Opt-in hosted wire. No legacy world/OpLog or raw ModelPool frames cross it. */
export const STRATEGIC_VERSION = 1;
export const STRATEGIC_CODEC = 2;
export const STRATEGIC_PROTOCOL = "arenastar.strategic.v1.pos2";
export const STRATEGIC_API = "/api/strategic";
export const MAX_FRAME = 128 * 1024;
export const MAX_EDITS = 25;
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
export const MAX_VIEW_META_BYTES = 1024 * 1024;
export const MAX_VIEW_BYTES = 4 * 1024 * 1024;

/** Durable shared PF1e compendium document identities; never strategic-only spell definitions. */
export const PF1E_ENTANGLE_DOCUMENT_ID = "pf1e-core-spells-entangle";
export const STRATEGIC_SPELL_IDS = [
  "entangle",
  "burning-entanglement",
  "black-tentacles",
  "fireball",
  "burning-hands",
  "lightning-bolt",
  "cone-of-cold",
] as const;
export type StrategicSpellId = (typeof STRATEGIC_SPELL_IDS)[number];

export const STRATEGIC_SPELL_CATALOG: Readonly<
  Record<
    StrategicSpellId,
    {
      id: StrategicSpellId;
      name: string;
      itemId: string;
      level: number;
      shape: "circle" | "cone" | "line";
      radius: number;
      range: "self" | "medium" | "long";
      kind: "hazard" | "blast";
    }
  >
> = Object.freeze({
  entangle: {
    id: "entangle",
    name: "Entangle",
    itemId: PF1E_ENTANGLE_DOCUMENT_ID,
    level: 1,
    shape: "circle",
    radius: 40,
    range: "long",
    kind: "hazard",
  },
  "burning-entanglement": {
    id: "burning-entanglement",
    name: "Burning Entanglement",
    itemId: "pf1e-core-spells-burning-entanglement",
    level: 3,
    shape: "circle",
    radius: 40,
    range: "long",
    kind: "hazard",
  },
  "black-tentacles": {
    id: "black-tentacles",
    name: "Black Tentacles",
    itemId: "pf1e-core-spells-black-tentacles",
    level: 4,
    shape: "circle",
    radius: 20,
    range: "medium",
    kind: "hazard",
  },
  fireball: {
    id: "fireball",
    name: "Fireball",
    itemId: "pf1e-core-spells-fireball",
    level: 3,
    shape: "circle",
    radius: 20,
    range: "long",
    kind: "blast",
  },
  "burning-hands": {
    id: "burning-hands",
    name: "Burning Hands",
    itemId: "pf1e-core-spells-burning-hands",
    level: 1,
    shape: "cone",
    radius: 15,
    range: "self",
    kind: "blast",
  },
  "lightning-bolt": {
    id: "lightning-bolt",
    name: "Lightning Bolt",
    itemId: "pf1e-core-spells-lightning-bolt",
    level: 3,
    shape: "line",
    radius: 120,
    range: "self",
    kind: "blast",
  },
  "cone-of-cold": {
    id: "cone-of-cold",
    name: "Cone of Cold",
    itemId: "pf1e-core-spells-cone-of-cold",
    level: 5,
    shape: "cone",
    radius: 60,
    range: "self",
    kind: "blast",
  },
});

export type Point = { x: number; y: number };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type ReadyTrigger = "enemyEntersReach" | "enemyCasts" | "allyAttacked";
export type ReadyResponse = "melee" | "shot" | "countermarch";
export type StrategicItemEffect = "heal" | "bless" | "haste" | "shield";

export type RoomOrder =
  | { kind: "hold"; stance: "hold" | "defend" }
  | { kind: "reform" }
  | { kind: "move"; path: Point[]; pace: "march" | "charge"; reform?: boolean }
  | {
      kind: "attack";
      targetUnitId: string;
      mode: "melee" | "shot";
      envelop?: boolean;
    }
  | {
      kind: "cast";
      spellId: StrategicSpellId;
      itemId: string;
      origin: Point;
      dir?: Point;
    }
  | {
      kind: "useItem";
      itemId: string;
      targetUnitId?: string;
    }
  | {
      kind: "ready";
      trigger: ReadyTrigger;
      response: ReadyResponse;
      targetUnitId?: string;
    };

export type HostedTemplate = {
  id: string;
  shape: "circle" | "cone" | "line" | "rect";
  x: number;
  y: number;
  distance: number;
  direction?: number;
  width?: number;
  color: string;
  label?: string;
};

export type HostedLight = {
  id: string;
  x: number;
  y: number;
  dim: number;
  bright: number;
  color: string;
  alpha: number;
  hidden?: boolean;
};

export type HostedRegion = {
  id: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  elevationFt: number;
  kind: "raised" | "stairs";
};

export type HostedChatEntry = {
  id: string;
  senderId: string;
  senderName: string;
  factionId: string | null;
  scope: "public" | "faction" | "gm";
  text: string;
  roll?: {
    formula: string;
    total: number;
    breakdown: string;
    provenance: "host";
  };
  createdAt: number;
};

export type HostedJournal = {
  id: string;
  name: string;
  markdown: string;
  visibility: "public" | "gm";
};

export type HostedRollTable = {
  id: string;
  name: string;
  formula: string;
  results: Array<{ range: [number, number]; text: string }>;
  visibility: "public" | "gm";
};

export type HostedPlaylist = {
  id: string;
  name: string;
  tracks: Array<{ id: string; name: string; loop: boolean }>;
};

export type HostedMacro = {
  id: string;
  name: string;
  executable: boolean;
  disabledReason?: string;
  action?:
    | { kind: "chat"; text: string; rollFormula?: string }
    | { kind: "order"; orderKind: "hold" | "defend" | "reform" };
};

export type HostedFxCue = {
  id: string;
  turnId: number;
  preset: "fireball" | "burning-hands" | "lightning-bolt" | "cone-of-cold" | "entangle" | "burning-entanglement" | "black-tentacles" | "heal" | "buff";
  at: Point;
  dir?: Point;
  radius: number;
  soundCue?: string;
};

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
    }
  | {
      kind: "roster.assign";
      requestId: string;
      assignments: Array<{
        memberId: string;
        factionId?: string;
        units?: string[];
      }>;
    }
  | {
      kind: "scene.door";
      requestId: string;
      wallId: string;
      door: 0 | 1 | 2;
    }
  | {
      kind: "scene.light";
      requestId: string;
      darkness?: number;
      lightId?: string;
      hidden?: boolean;
    }
  | {
      kind: "scene.template";
      requestId: string;
      op: "put" | "delete";
      template?: HostedTemplate;
      templateId?: string;
    }
  | {
      kind: "scene.playlist";
      requestId: string;
      trackId: string | null;
    }
  | {
      kind: "chat.send";
      requestId: string;
      text: string;
      scope?: "public" | "faction" | "gm";
      rollFormula?: string;
    }
  | {
      kind: "table.roll";
      requestId: string;
      tableId: string;
    }
  | {
      kind: "macro.exec";
      requestId: string;
      macroId: string;
      unitId?: string;
      point?: Point;
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
  /** Roster/control/live-scene generation. Same version + a new value means: refetch your authorized view. */
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
  factionId?: string;
  at: Point | null;
  alive: number;
  weapon: "melee" | "shot";
  facing?: number;
  badgeUrl?: string;
  elevation?: number;
  conditions?: string[];
  statsSummary?: {
    ac: number;
    bab: number;
    hp: number;
    vision: "normal" | "lowLight" | "darkvision";
  };
  spells?: Array<{
    id: StrategicSpellId;
    name?: string;
    itemId: string;
    shape?: "circle" | "cone" | "line";
    radius?: number;
    slots: number;
  }>;
  items?: Array<{
    id: string;
    name: string;
    effect: StrategicItemEffect;
    charges: number;
  }>;
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
  /** Per-unit current faction allegiance so GM roster UI reflects `unit.faction` flips. */
  unitFactions?: Record<string, string>;
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
  /** Stitched multi-image background tiles in world feet, rendered edge-to-edge under the grid. */
  backgroundTiles?: Array<{
    hash: string;
    url: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
  }>;
  /** Projected battlefield walls (`restriction`: bit0 move, bit1 sight). */
  walls?: Array<{
    id?: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    restriction: number;
    door?: 0 | 1 | 2;
  }>;
  /** Current door states keyed by projected wall ID (`0` closed, `1` open, `2` locked). */
  doors?: Record<string, 0 | 1 | 2>;
  /** Scene darkness level (`0` bright daylight .. `1` darkness). */
  darkness?: number;
  /** Ambient light sources visible to the participant. */
  lights?: HostedLight[];
  /** Elevated floors/stairs regions in world feet. */
  regions?: HostedRegion[];
  /** Persistent measured templates in world feet. */
  templates?: HostedTemplate[];
  /** Authored difficult-terrain 5-ft grid cells (`col`, `row`). */
  difficultCells?: Array<{ col: number; row: number }>;
  /** Active persistent areas rendered from authoritative hosted state. */
  areas?: Array<{
    id: string;
    spell: "entangle" | "burningEntanglement" | "blackTentacles";
    at: Point;
    radius: number;
    expiresAfterTurn?: number;
  }>;
  /** Bounded authoritative action history for shared cards and authored FX consumers. */
  actions?: ActionCard[];
  /** Permission-filtered room chat and provenanced dice rolls. */
  chat?: HostedChatEntry[];
  /** Entitlement-filtered campaign content (journals, roll tables, playlists, macros, FX cues). */
  content?: {
    journals?: HostedJournal[];
    rollTables?: HostedRollTable[];
    playlists?: HostedPlaylist[];
    activeTrackId?: string | null;
    macros?: HostedMacro[];
    fxCues?: HostedFxCue[];
  };
  /** GM-only additional service-hosted art, prefetched into the browser cache on view. */
  media?: StoreMedia[];
  /** Authorized visible unit facing angles (radians) for formation orientation. */
  unitFacings?: Record<string, number>;
  /** Authorized visible unit token art URLs (`unitId -> url`). */
  unitBadges?: Record<string, string>;
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

export type ReconciledUnitSummary = {
  id: string;
  name: string;
  factionId: string;
  source?: {
    kind: "armyUnit" | "token";
    armyId?: string;
    unitId?: string;
    tokenId?: string;
    actorId?: string;
  };
  initialStrength: number;
  alive: number;
  lost: number;
  at: Point | null;
  facing?: number;
  spellsSpent?: Record<string, number>;
  itemsSpent?: Record<string, number>;
  conditions?: string[];
};

export type BattleReconciliationPayload = {
  id: string;
  version: number;
  previewOnly?: boolean;
  surviving?: number;
  lost?: number;
  projection?: {
    worldId: string;
    sceneId: string;
    sourceSeq: number;
    digest: string;
    dependencies?: Array<{
      coll: string;
      id: string;
      parentId?: string;
      digest: string;
      visibility: "public" | "faction" | "gm" | "owner";
    }>;
  };
  units?: ReconciledUnitSummary[];
  doorStates?: Record<string, 0 | 1 | 2>;
  darkness?: number;
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

function isSpellId(v: unknown): v is StrategicSpellId {
  return (STRATEGIC_SPELL_IDS as readonly string[]).includes(String(v));
}

function parseTemplate(v: unknown): HostedTemplate | null {
  if (
    !record(v) ||
    !only(v, "id", "shape", "x", "y", "distance", "direction", "width", "color", "label") ||
    !isId(v.id) ||
    !["circle", "cone", "line", "rect"].includes(String(v.shape)) ||
    !finite(v.x) ||
    !finite(v.y) ||
    !finite(v.distance) ||
    v.distance <= 0 ||
    v.distance > 1000 ||
    (v.direction !== undefined && (!finite(v.direction) || Math.abs(v.direction) > 3600)) ||
    (v.width !== undefined && (!finite(v.width) || v.width <= 0 || v.width > 200)) ||
    typeof v.color !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(v.color) ||
    (v.label !== undefined && !memberName(v.label))
  )
    return null;
  return {
    id: v.id,
    shape: v.shape as HostedTemplate["shape"],
    x: v.x,
    y: v.y,
    distance: v.distance,
    ...(v.direction !== undefined ? { direction: v.direction } : {}),
    ...(v.width !== undefined ? { width: v.width } : {}),
    color: v.color,
    ...(typeof v.label === "string" ? { label: v.label.trim() } : {}),
  };
}

function parseOrder(v: unknown): RoomOrder | null {
  if (!record(v)) return null;
  if (
    v.kind === "hold" &&
    (v.stance === "hold" || v.stance === "defend") &&
    only(v, "kind", "stance")
  )
    return { kind: "hold", stance: v.stance };
  if (v.kind === "reform" && only(v, "kind")) return { kind: "reform" };
  if (
    v.kind === "attack" &&
    only(v, "kind", "targetUnitId", "mode", "envelop") &&
    isId(v.targetUnitId) &&
    (v.mode === "melee" || v.mode === "shot") &&
    (v.envelop === undefined ||
      (typeof v.envelop === "boolean" && (!v.envelop || v.mode === "melee")))
  ) {
    return {
      kind: "attack",
      targetUnitId: v.targetUnitId,
      mode: v.mode,
      ...(v.envelop === true ? { envelop: true } : {}),
    };
  }
  if (
    v.kind === "cast" &&
    only(v, "kind", "spellId", "itemId", "origin", "dir") &&
    isSpellId(v.spellId) &&
    isId(v.itemId) &&
    point(v.origin) &&
    (v.dir === undefined || point(v.dir))
  ) {
    return {
      kind: "cast",
      spellId: v.spellId,
      itemId: v.itemId,
      origin: { x: v.origin.x, y: v.origin.y },
      ...(v.dir ? { dir: { x: v.dir.x, y: v.dir.y } } : {}),
    };
  }
  if (
    v.kind === "useItem" &&
    only(v, "kind", "itemId", "targetUnitId") &&
    isId(v.itemId) &&
    (v.targetUnitId === undefined || isId(v.targetUnitId))
  ) {
    return {
      kind: "useItem",
      itemId: v.itemId,
      ...(typeof v.targetUnitId === "string" ? { targetUnitId: v.targetUnitId } : {}),
    };
  }
  if (
    v.kind === "ready" &&
    only(v, "kind", "trigger", "response", "targetUnitId") &&
    ["enemyEntersReach", "enemyCasts", "allyAttacked"].includes(String(v.trigger)) &&
    ["melee", "shot", "countermarch"].includes(String(v.response)) &&
    (v.targetUnitId === undefined || isId(v.targetUnitId))
  ) {
    return {
      kind: "ready",
      trigger: v.trigger as ReadyTrigger,
      response: v.response as ReadyResponse,
      ...(typeof v.targetUnitId === "string" ? { targetUnitId: v.targetUnitId } : {}),
    };
  }
  if (
    v.kind === "move" &&
    only(v, "kind", "pace", "path", "reform") &&
    (v.pace === "march" || v.pace === "charge") &&
    Array.isArray(v.path) &&
    v.path.length > 0 &&
    v.path.length <= MAX_WAYPOINTS &&
    v.path.every(point) &&
    (v.pace !== "charge" || v.path.length === 1) &&
    (v.reform === undefined ||
      (typeof v.reform === "boolean" && (!v.reform || v.pace === "march")))
  ) {
    return {
      kind: "move",
      path: v.path.map(({ x, y }) => ({ x, y })),
      pace: v.pace,
      ...(v.reform === true ? { reform: true } : {}),
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
    isId(v.unitId) &&
    isId(v.factionId)
  )
    return { kind: v.kind, requestId, unitId: v.unitId, factionId: v.factionId };
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
        v.units.length <= MAX_EDITS &&
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
  if (
    v.kind === "roster.assign" &&
    only(v, "kind", "requestId", "assignments") &&
    Array.isArray(v.assignments) &&
    v.assignments.length >= 1 &&
    v.assignments.length <= 500
  ) {
    const seenMembers = new Set<string>();
    const seenUnits = new Set<string>();
    const assignments: Extract<Command, { kind: "roster.assign" }>["assignments"] = [];
    for (const item of v.assignments as unknown[]) {
      if (
        !record(item) ||
        !only(item, "memberId", "factionId", "units") ||
        !isId(item.memberId) ||
        seenMembers.has(item.memberId) ||
        (item.factionId !== undefined && !isId(item.factionId)) ||
        (item.factionId === undefined && item.units === undefined)
      )
        return null;
      seenMembers.add(item.memberId);
      let units: string[] | undefined;
      if (item.units !== undefined) {
        if (
          !Array.isArray(item.units) ||
          item.units.length > MAX_EDITS ||
          !item.units.every((id) => isId(id))
        )
          return null;
        units = [];
        for (const id of item.units as string[]) {
          if (seenUnits.has(id)) return null;
          seenUnits.add(id);
          units.push(id);
        }
      }
      assignments.push({
        memberId: item.memberId,
        ...(typeof item.factionId === "string" ? { factionId: item.factionId } : {}),
        ...(units !== undefined ? { units } : {}),
      });
    }
    return { kind: "roster.assign", requestId, assignments };
  }
  if (
    v.kind === "scene.door" &&
    only(v, "kind", "requestId", "wallId", "door") &&
    isId(v.wallId) &&
    (v.door === 0 || v.door === 1 || v.door === 2)
  ) {
    return { kind: "scene.door", requestId, wallId: v.wallId, door: v.door };
  }
  if (
    v.kind === "scene.light" &&
    only(v, "kind", "requestId", "darkness", "lightId", "hidden") &&
    (v.darkness !== undefined || (isId(v.lightId) && typeof v.hidden === "boolean")) &&
    (v.darkness === undefined || (finite(v.darkness) && v.darkness >= 0 && v.darkness <= 1)) &&
    (v.lightId === undefined || isId(v.lightId)) &&
    (v.hidden === undefined || typeof v.hidden === "boolean")
  ) {
    return {
      kind: "scene.light",
      requestId,
      ...(v.darkness !== undefined ? { darkness: Math.round(v.darkness * 1000) / 1000 } : {}),
      ...(typeof v.lightId === "string" ? { lightId: v.lightId } : {}),
      ...(typeof v.hidden === "boolean" ? { hidden: v.hidden } : {}),
    };
  }
  if (
    v.kind === "scene.template" &&
    only(v, "kind", "requestId", "op", "template", "templateId") &&
    (v.op === "put" || v.op === "delete")
  ) {
    if (v.op === "put") {
      const parsed = parseTemplate(v.template);
      if (!parsed || v.templateId !== undefined) return null;
      return { kind: "scene.template", requestId, op: "put", template: parsed };
    }
    if (!isId(v.templateId) || v.template !== undefined) return null;
    return { kind: "scene.template", requestId, op: "delete", templateId: v.templateId };
  }
  if (
    v.kind === "scene.playlist" &&
    only(v, "kind", "requestId", "trackId") &&
    (v.trackId === null || isId(v.trackId))
  ) {
    return { kind: "scene.playlist", requestId, trackId: v.trackId };
  }
  if (
    v.kind === "chat.send" &&
    only(v, "kind", "requestId", "text", "scope", "rollFormula") &&
    typeof v.text === "string" &&
    v.text.length <= 500 &&
    (v.text.trim().length > 0 || (typeof v.rollFormula === "string" && v.rollFormula.trim().length > 0)) &&
    (v.scope === undefined || ["public", "faction", "gm"].includes(String(v.scope))) &&
    (v.rollFormula === undefined ||
      (typeof v.rollFormula === "string" && /^[0-9dD+\-\s]{1,32}$/.test(v.rollFormula.trim())))
  ) {
    return {
      kind: "chat.send",
      requestId,
      text: v.text.trim().slice(0, 500),
      ...(v.scope !== undefined ? { scope: v.scope as "public" | "faction" | "gm" } : {}),
      ...(typeof v.rollFormula === "string" && v.rollFormula.trim()
        ? { rollFormula: v.rollFormula.trim() }
        : {}),
    };
  }
  if (
    v.kind === "table.roll" &&
    only(v, "kind", "requestId", "tableId") &&
    isId(v.tableId)
  ) {
    return { kind: "table.roll", requestId, tableId: v.tableId };
  }
  if (
    v.kind === "macro.exec" &&
    only(v, "kind", "requestId", "macroId", "unitId", "point") &&
    isId(v.macroId) &&
    (v.unitId === undefined || isId(v.unitId)) &&
    (v.point === undefined || point(v.point))
  ) {
    return {
      kind: "macro.exec",
      requestId,
      macroId: v.macroId,
      ...(typeof v.unitId === "string" ? { unitId: v.unitId } : {}),
      ...(v.point ? { point: { x: v.point.x, y: v.point.y } } : {}),
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

/** Scope one GM management proof to an operation, deployment origin and battle. The
 * launch credential grants provisioning entitlement; the signature proves seat identity. */
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

export function campaignProof(
  action: "launch" | "finish" | "preview",
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
