/**
 * Durable FX instance records are private host state. Only validated, resolved
 * cues leave the host, and only after the caller/viewer/asset checks in HostSync.
 * This file has no transport/UI dependencies so archive loads and deletion
 * expansion can reuse the same bounded model.
 */
import type { AssetManifest, FxInstanceDocument, SceneDocument, WorldCollections } from "./documents";
import type { Op } from "./ops";
import { validateFxSequence, type FxSection } from "./fx";
import { tagMatcher } from "./tags";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Scene scope is NOT client-selectable in scripts: the reviewed macro policy
 * supplies it. This filter matches only host-validated, recipient-entitled FX.
 * `macroId` is the saved sequence that originated the instance. */
export interface FxInstanceFilter {
  name?: string; // case-insensitive * and ? wildcards, or an exact name
  macroId?: string;
  sourceTokenId?: string;
  targetTokenId?: string;
}
export function validateFxInstanceFilter(value: unknown, requireSelector = false):
  { ok: true; filter: FxInstanceFilter } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "FX filter must be a named record" };
  const filter = value as Record<string, unknown>;
  const keys = Object.keys(filter);
  if (keys.some((key) => !["name", "macroId", "sourceTokenId", "targetTokenId"].includes(key)) ||
      (requireSelector && !keys.some((key) => filter[key] !== undefined)) ||
      (filter.name !== undefined && (typeof filter.name !== "string" || !filter.name.trim() ||
        filter.name.length > 128 || [...filter.name].some((char) => char.charCodeAt(0) < 32))) ||
      [filter.macroId, filter.sourceTokenId, filter.targetTokenId].some((id) => id !== undefined &&
        (typeof id !== "string" || !ID.test(id))))
    return { ok: false, error: "FX filter needs a bounded name/macro/token selector" };
  return { ok: true, filter: value as FxInstanceFilter };
}

/** Pure filter for host-side queries. No authorization is implied: a caller
 * must first intersect with their entitled projection/ownership. */
export function fxInstanceMatches(doc: FxInstanceDocument, filter: FxInstanceFilter): boolean {
  if (filter.macroId !== undefined && doc.macroId !== filter.macroId ||
      filter.sourceTokenId !== undefined && doc.sourceTokenId !== filter.sourceTokenId ||
      filter.targetTokenId !== undefined && doc.targetTokenId !== filter.targetTokenId) return false;
  return filter.name === undefined || tagMatcher(filter.name, { pattern: "wildcard", caseSensitive: false })([doc.name]);
}

/** Fail closed on malformed historical/imported records before any cue is sent. */
export function validateFxInstance(
  doc: FxInstanceDocument, scene: SceneDocument | undefined, manifest: AssetManifest,
): boolean {
  if (!scene || doc.type !== "fxInstance" || !ID.test(doc._id) || !ID.test(doc.macroId) ||
      !ID.test(doc.ownerId) || doc.sceneId !== scene._id || !doc.name || doc.name.length > 128 ||
      !["scene", "gm", "caller"].includes(doc.audience) ||
      !Number.isFinite(doc.atHostTime) || doc.atHostTime < 0 ||
      !Array.isArray(doc.sections) || doc.sections.length < 1 || doc.sections.length > 16 ||
      (doc.sourceTokenId !== undefined && (!ID.test(doc.sourceTokenId) || !scene.tokens.some((t) => t._id === doc.sourceTokenId))) ||
      (doc.targetTokenId !== undefined && (!ID.test(doc.targetTokenId) || !scene.tokens.some((t) => t._id === doc.targetTokenId)))) return false;
  const sections: FxSection[] = [];
  for (const section of doc.sections) {
    if (!section || typeof section !== "object") return false;
    if (section.kind === "wait") { sections.push(section); continue; }
    if (section.kind === "sound") {
      const { mime, ...saved } = section;
      if (manifest[section.assetId]?.mime !== mime) return false;
      sections.push(saved);
      continue;
    }
    const { x, y, toX, toY, followTokenId, followToTokenId } = section;
    const boundToken = (id: string | undefined) => id === doc.sourceTokenId || id === doc.targetTokenId;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > scene.width || y > scene.height ||
        (toX === undefined) !== (toY === undefined) ||
        (toX !== undefined && (!Number.isFinite(toX) || !Number.isFinite(toY) ||
          toX < 0 || toY === undefined || toY < 0 || toX > scene.width || toY > scene.height)) ||
        (followTokenId !== undefined && !boundToken(followTokenId)) ||
        (followToTokenId !== undefined && (!boundToken(followToTokenId) || toX === undefined)) ||
        (section.follow === true && !followTokenId && !followToTokenId) ||
        (section.follow !== true && (followTokenId !== undefined || followToTokenId !== undefined))) return false;
    // Reconstruct authored anchors for schema validation; only previously
    // bound source/target tokens may ever be followed by a stored cue.
    const anchor = (id: string | undefined, px: number, py: number) =>
      id ? { kind: id === doc.sourceTokenId ? "source" as const : "target" as const }
        : { kind: "point" as const, x: px, y: py };
    const at = anchor(followTokenId, x, y);
    const to = toX !== undefined && toY !== undefined ? { to: anchor(followToTokenId, toX, toY) } : {};
    if (section.kind === "image") {
      const { x: _x, y: _y, toX: _toX, toY: _toY,
        followTokenId: _follow, followToTokenId: _followTo, mime, ...authored } = section;
      void _x; void _y; void _toX; void _toY; void _follow; void _followTo;
      if (manifest[section.assetId]?.mime !== mime) return false;
      sections.push({ ...authored, at, ...to });
    } else if (section.kind === "text") {
      const { x: _x, y: _y, toX: _toX, toY: _toY,
        followTokenId: _follow, followToTokenId: _followTo, ...authored } = section;
      void _x; void _y; void _toX; void _toY; void _follow; void _followTo;
      sections.push({ ...authored, at, ...to });
    } else return false;
  }
  return validateFxSequence({ version: 1, persistent: true, sections }).ok;
}

/** Deleting a source/target, saved macro or scene ends its FX in the SAME
 * transaction/undo group. Redo must not expand the already-complete envelope. */
export function boundFxDeletionOps(world: Readonly<WorldCollections>, ops: Op[]): Op[] {
  const sceneIds = new Set<string>();
  const macroIds = new Set<string>();
  const tokens = new Set<string>();
  const instances = new Set<string>();
  for (const op of ops) {
    if (op.kind !== "delete") continue;
    if (op.ref.coll === "scenes" && !op.ref.parent) sceneIds.add(op.ref.id);
    if (op.ref.coll === "macros" && !op.ref.parent) macroIds.add(op.ref.id);
    if (op.ref.coll === "fxInstances" && !op.ref.parent) instances.add(op.ref.id);
    if (op.ref.coll === "tokens" && op.ref.parent?.coll === "scenes")
      tokens.add(`${op.ref.parent.id}\u0000${op.ref.id}`);
  }
  if (!sceneIds.size && !macroIds.size && !tokens.size) return ops;
  const more: Op[] = [];
  for (const doc of world.fxInstances ?? []) {
    if (instances.has(doc._id) || !(
      sceneIds.has(doc.sceneId) || macroIds.has(doc.macroId) ||
      doc.sourceTokenId && tokens.has(`${doc.sceneId}\u0000${doc.sourceTokenId}`) ||
      doc.targetTokenId && tokens.has(`${doc.sceneId}\u0000${doc.targetTokenId}`)
    )) continue;
    more.push({ kind: "delete", ref: { coll: "fxInstances", id: doc._id } });
  }
  return more.length ? [...ops, ...more] : ops;
}
