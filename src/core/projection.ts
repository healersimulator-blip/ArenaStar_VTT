/**
 * §5 Projection — pure per-user filtering before anything is broadcast.
 * Invariant: no client ever receives data the projection says it may not see.
 *
 *   projectWorld(world, seq, user) → ProjectedWorld
 *   projectEnvelope(env, user, resolver?) → OpEnvelope | null
 *
 * Rules (§5):
 * - hidden tokens omitted unless owner/GM;
 * - docs with effective ownership < LIMITED omitted;
 * - `<secret>` blocks in journal pages, GM-only roll results and whispers
 *   stripped;
 * - walls and lights sent to everyone (within any scene the user receives,
 *   D-022);
 * - GM (and ASSISTANT, D-013) receive everything unfiltered.
 *
 * `resolver` (D-023) lets the host supply current documents for update/delete
 * visibility; it is a pure lookup — these functions never mutate inputs.
 */
import {
  OWNERSHIP_LEVELS,
  TOP_LEVEL_COLLECTIONS,
  type BaseDocument,
  type DocRef,
  type JournalDocument,
  type MessageDocument,
  type SceneDocument,
  type TokenDocument,
  type WorldCollections,
} from "./documents";
import type { Op, OpEnvelope } from "./ops";
import { getEffectiveOwnership } from "./permissions";
import type { PermissionUser } from "./ownership";
import type { Json } from "./documents";

export interface ProjectedWorld {
  seq: number;
  collections: Partial<WorldCollections>;
}

/** Pure lookup into current world state (host passes a store-backed one). */
export interface ProjectionResolver {
  resolve(ref: DocRef): BaseDocument | undefined;
}

export interface ProjectionFns {
  projectWorld(world: WorldCollections, seq: number, user: PermissionUser): ProjectedWorld;
  /** null ⇒ the recipient gets nothing from this envelope. */
  projectEnvelope(
    envelope: OpEnvelope,
    user: PermissionUser,
    resolver?: ProjectionResolver,
  ): OpEnvelope | null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const SECRET_BLOCK = /<secret>[\s\S]*?<\/secret>/gi;
const HAS_SECRET = /<secret[\s>]/i;

export function stripSecretText(text: string): string {
  return text.replace(SECRET_BLOCK, "");
}

function isGm(user: PermissionUser): boolean {
  return user.role === "GM" || user.role === "ASSISTANT";
}

type MessageAccess = "omit" | "redact" | "full";

/** §5: whispers + GM-only roll results (§10/§11 modes). */
function messageAccess(user: PermissionUser, msg: MessageDocument): MessageAccess {
  if (isGm(user)) return "full";
  const isAuthor = msg.author === user.id;
  const isTarget = msg.whisper.includes(user.id);
  if (msg.whisper.length > 0 && !(isAuthor || isTarget)) return "omit";
  if (msg.rollMode === "selfroll" && !isAuthor) return "omit";
  if (msg.roll) {
    if (msg.rollMode === "blindroll") return "redact"; // GM eyes only
    if (msg.rollMode === "gmroll" && !isAuthor) return "redact"; // GM + roller
  }
  return "full";
}

function redactMessage(msg: MessageDocument): MessageDocument {
  return { ...msg, roll: null };
}

function projectMessage(user: PermissionUser, msg: MessageDocument): MessageDocument | null {
  const access = messageAccess(user, msg);
  if (access === "omit") return null;
  if (access === "redact") return redactMessage(msg);
  return msg;
}

/** §5: hidden tokens omitted unless owner (≥ OWNER, cascade-aware) or GM. */
function tokenVisible(user: PermissionUser, token: TokenDocument, scene: SceneDocument): boolean {
  if (!token.hidden) return true;
  return getEffectiveOwnership(user, token, scene) >= OWNERSHIP_LEVELS.OWNER;
}

function projectScene(user: PermissionUser, scene: SceneDocument): SceneDocument {
  const tokens = scene.tokens.filter((t) => tokenVisible(user, t, scene));
  if (tokens.length === scene.tokens.length) return scene;
  return { ...scene, tokens };
}

function projectJournal(journal: JournalDocument): JournalDocument {
  let changed = false;
  const pages = journal.pages.map((page) => {
    if (typeof page.text === "string" && HAS_SECRET.test(page.text)) {
      changed = true;
      return { ...page, text: stripSecretText(page.text) };
    }
    return page;
  });
  return changed ? { ...journal, pages } : journal;
}

// ─── projectWorld ─────────────────────────────────────────────────────────────

export function projectWorld(
  world: WorldCollections,
  seq: number,
  user: PermissionUser,
): ProjectedWorld {
  if (isGm(user)) return { seq, collections: world };
  const out: Partial<WorldCollections> = {
    users: world.users, // D-021: player list / whisper targets for everyone
  };
  for (const coll of TOP_LEVEL_COLLECTIONS) {
    if (coll === "users") continue;
    const docs = world[coll] as readonly BaseDocument[];
    const kept: BaseDocument[] = [];
    for (const doc of docs) {
      if (getEffectiveOwnership(user, doc) < OWNERSHIP_LEVELS.LIMITED) continue;
      switch (coll) {
        case "scenes":
          kept.push(projectScene(user, doc as SceneDocument));
          break;
        case "journals":
          kept.push(projectJournal(doc as JournalDocument));
          break;
        case "messages": {
          const msg = projectMessage(user, doc as MessageDocument);
          if (msg) kept.push(msg);
          break;
        }
        default:
          kept.push(doc);
      }
    }
    (out[coll] as unknown) = kept;
  }
  // assetManifest deliberately not projected here — it travels in
  // SnapshotMsg.manifest (D-021).
  return { seq, collections: out };
}

// ─── projectEnvelope ──────────────────────────────────────────────────────────

function stripSecretsFromDiff(diff: Record<string, Json | null>): Record<string, Json | null> {
  const out: Record<string, Json | null> = {};
  let changed = false;
  for (const [key, value] of Object.entries(diff)) {
    const path = key.startsWith("-=") ? key.slice(2) : key;
    if (path.split(".").pop() === "text" && typeof value === "string" && HAS_SECRET.test(value)) {
      out[key] = stripSecretText(value);
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : diff;
}

function createVisible(
  user: PermissionUser,
  op: Extract<Op, { kind: "create" }>,
  resolver?: ProjectionResolver,
): Op | null {
  if (op.coll === "walls" || op.coll === "lights") return op; // §5/D-022
  const data = op.data as BaseDocument;
  const parent = op.parent !== undefined ? resolver?.resolve(op.parent) : undefined;
  if (op.coll === "messages") {
    const access = messageAccess(user, data as MessageDocument);
    if (access === "omit") return null;
    if (access === "redact") {
      return { ...op, data: redactMessage(data as MessageDocument) };
    }
    return op;
  }
  if (op.coll === "tokens" && (data as TokenDocument).hidden) {
    // Hidden token creation: owner (via token/parent ownership) or GM only.
    if (
      parent
        ? getEffectiveOwnership(user, data, parent) < OWNERSHIP_LEVELS.OWNER
        : getEffectiveOwnership(user, data) < OWNERSHIP_LEVELS.OWNER
    ) {
      return null;
    }
    return op;
  }
  if (getEffectiveOwnership(user, data, parent) >= OWNERSHIP_LEVELS.LIMITED) return op;
  // Embedded create in a parent we cannot resolve (envelope-only mode): the
  // recipient sees the parent (host projects to connected users only), keep.
  return op.parent !== undefined && parent === undefined ? op : null;
}

function updateVisible(
  user: PermissionUser,
  op: Extract<Op, { kind: "update" }>,
  resolver?: ProjectionResolver,
): Op | null {
  if (op.ref.coll === "walls" || op.ref.coll === "lights") return op;
  const doc = resolver?.resolve(op.ref);
  if (!doc) return op; // envelope-only mode (D-023): host always passes a resolver
  const parent = op.ref.parent !== undefined ? resolver?.resolve(op.ref.parent) : undefined;
  if (op.ref.coll === "messages") {
    const access = messageAccess(user, doc as MessageDocument);
    if (access === "omit") return null;
    if (access === "redact" && "roll" in op.diff) {
      return { ...op, diff: { ...op.diff, roll: null } };
    }
    return op;
  }
  if (op.ref.coll === "tokens" && (doc as TokenDocument).hidden) {
    if (getEffectiveOwnership(user, doc, parent) < OWNERSHIP_LEVELS.OWNER) return null;
  }
  if (getEffectiveOwnership(user, doc, parent) < OWNERSHIP_LEVELS.LIMITED) return null;
  if (op.ref.coll === "pages" || op.ref.coll === "journals") {
    const diff = stripSecretsFromDiff(op.diff);
    if (diff !== op.diff) return { ...op, diff };
  }
  return op;
}

function deleteVisible(
  user: PermissionUser,
  op: Extract<Op, { kind: "delete" }>,
  resolver?: ProjectionResolver,
): Op | null {
  if (op.ref.coll === "walls" || op.ref.coll === "lights") return op;
  const doc = resolver?.resolve(op.ref);
  if (!doc) return op;
  const parent = op.ref.parent !== undefined ? resolver?.resolve(op.ref.parent) : undefined;
  if (op.ref.coll === "messages" && messageAccess(user, doc as MessageDocument) === "omit")
    return null;
  if (op.ref.coll === "tokens" && (doc as TokenDocument).hidden) {
    if (getEffectiveOwnership(user, doc, parent) < OWNERSHIP_LEVELS.OWNER) return null;
  }
  if (getEffectiveOwnership(user, doc, parent) < OWNERSHIP_LEVELS.LIMITED) return null;
  return op;
}

export function projectEnvelope(
  envelope: OpEnvelope,
  user: PermissionUser,
  resolver?: ProjectionResolver,
): OpEnvelope | null {
  if (isGm(user)) return envelope;
  const ops: Op[] = [];
  let modified = false;
  for (const op of envelope.ops) {
    let projected: Op | null = null;
    switch (op.kind) {
      case "create":
        projected = createVisible(user, op, resolver);
        break;
      case "update":
        projected = updateVisible(user, op, resolver);
        break;
      case "delete":
        projected = deleteVisible(user, op, resolver);
        break;
    }
    if (projected !== null) {
      if (projected !== op) modified = true; // e.g. redacted roll, stripped secrets
      ops.push(projected);
    }
  }
  if (ops.length === 0) return null;
  // Return the original envelope object only when every op passed through as-is.
  return modified || ops.length !== envelope.ops.length ? { ...envelope, ops } : envelope;
}
