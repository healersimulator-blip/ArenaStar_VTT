/**
 * Summon presets are GM-authored MacroDocuments. Players request a saved preset
 * ID and a point; the host resolves the actor, allocates two fresh documents
 * and owns expiry/dismissal. Source actors/compendia are never edited/imported.
 * This is the authority/lifecycle substrate, not the full PF1e casting UI.
 */
import type { ActorDocument, AssetManifest, FlagStore, Json, SceneDocument, TokenDocument,
  WorldCollections } from "./documents";
import { sightBlockedBetween } from "./crosshair";
import type { Op } from "./ops";
import type { PermissionUser } from "./ownership";

export type SummonSource = { kind: "world"; actorId: string }
  | { kind: "compendium"; packageId: string; packFile: string; entryId: string };
export interface SummonPublic { version: 1; sceneId: string; playerCallable: true;
  maxDistance: number; size?: number; requireLoS?: boolean; durationMs?: number }
export interface SummonDefinition {
  version: 1;
  sceneId: string;
  source: SummonSource;
  playerCallable: boolean;
  /** Scene units (e.g. feet); applies from an owned summoner token for players. */
  maxDistance: number;
  /** Zero/absent means no expiry; otherwise real host milliseconds, ≤24h. */
  durationMs?: number;
  /** Summoned token footprint in grid cells; does not modify source actor size. */
  size?: number;
  disposition?: "friendly" | "neutral" | "hostile";
  /** Require an unobstructed sight segment from the summoner to the point. */
  requireLoS?: boolean;
}
export interface SummonMarker {
  version: 1;
  instanceId: string;
  presetId: string;
  sceneId: string;
  actorId: string;
  tokenId: string;
  ownerId: string;
  createdAt: number;
  expiresAt?: number;
}
export type SummonResult = { ok: true; actor: ActorDocument; token: TokenDocument; marker: SummonMarker; ops: Op[] }
  | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FILE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every((k) => allowed.includes(k));
const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** Refuse unknown fields and unsafe package paths, including during world import. */
export function validateSummon(value: unknown): { ok: true; definition: SummonDefinition } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!object(value) || !keys(value, ["version", "sceneId", "source", "playerCallable", "maxDistance",
    "durationMs", "size", "disposition", "requireLoS"]) || value.version !== 1 ||
    typeof value.sceneId !== "string" || !ID.test(value.sceneId) || !object(value.source) ||
    typeof value.playerCallable !== "boolean" || !finite(value.maxDistance, 0, 10_000) ||
    (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs) || !finite(value.durationMs, 1000, 86_400_000))) ||
    (value.size !== undefined && !finite(value.size, 0.25, 8)) ||
    (value.disposition !== undefined && !["friendly", "neutral", "hostile"].includes(String(value.disposition))) ||
    (value.requireLoS !== undefined && typeof value.requireLoS !== "boolean"))
    return bad("summon needs a scene, bounded range, source and publication policy");
  const source = value.source;
  if (source.kind === "world") {
    if (!keys(source, ["kind", "actorId"]) || typeof source.actorId !== "string" || !ID.test(source.actorId))
      return bad("invalid world actor reference");
  } else if (source.kind === "compendium") {
    if (!keys(source, ["kind", "packageId", "packFile", "entryId"]) ||
      typeof source.packageId !== "string" || !ID.test(source.packageId) ||
      typeof source.entryId !== "string" || !ID.test(source.entryId) ||
      typeof source.packFile !== "string" || !FILE.test(source.packFile) || source.packFile.length > 128)
      return bad("invalid compendium actor reference");
  } else return bad("unknown summon source");
  return { ok: true, definition: value as unknown as SummonDefinition };
}

/** Flag is host-only and stripped from both snapshot and envelope projections. */
export function summonMarker(doc: { flags?: FlagStore }): SummonMarker | null {
  const marker: unknown = doc.flags?.summon;
  if (!object(marker) || !keys(marker, ["version", "instanceId", "presetId", "sceneId", "actorId",
    "tokenId", "ownerId", "createdAt", "expiresAt"]) || marker.version !== 1 ||
    [marker.instanceId, marker.presetId, marker.sceneId, marker.actorId, marker.tokenId, marker.ownerId]
      .some((v) => typeof v !== "string" || !ID.test(v)) ||
    !finite(marker.createdAt, 0, 9e15) ||
    (marker.expiresAt !== undefined && !finite(marker.expiresAt, marker.createdAt + 1000, 9e15))) return null;
  return marker as unknown as SummonMarker;
}

/** Host and crosshair share bounds/range/LOS math. GM placement without a
 * caster skips range and LOS; player invocation always has an owned summoner.
 * LOS uses the scene's existing sight-blocked wall semantics (incl. doors).
 * This does not bypass fog or grant visibility to otherwise hidden tokens. */
export function summonPlacementError(scene: SceneDocument, definition: Pick<SummonDefinition,
  "sceneId" | "size" | "maxDistance" | "requireLoS">, at: { x: number; y: number },
  summoner?: TokenDocument, enforceCaster = true): string | null {
  const cell = scene.grid.size * (definition.size ?? 1);
  if (definition.sceneId !== scene._id || !scene.active ||
      !finite(scene.grid.size, 1, 10_000) || !finite(scene.grid.distance, Number.EPSILON, 10_000) ||
      !finite(cell, 1, 80_000) || !finite(at.x, cell / 2, scene.width - cell / 2) ||
      !finite(at.y, cell / 2, scene.height - cell / 2)) return "summon footprint outside active scene";
  if (!enforceCaster) return null;
  if (!summoner || !scene.tokens.some((t) => t._id === summoner._id))
    return "summoning needs an owned token in this scene";
  const distance = Math.hypot(at.x - summoner.x, at.y - summoner.y) * scene.grid.distance / scene.grid.size;
  if (distance > definition.maxDistance) return "summon placement exceeds the approved range";
  // SQ-10: the same shared segment rule the crosshair preview draws with, so a
  // placement that looked legal on the map is exactly the one the host accepts.
  if (definition.requireLoS && sightBlockedBetween(scene.walls, summoner, at))
    return "summon placement is behind a sight-blocking wall";
  return null;
}

/** Resolve and snapshot a source actor into independent per-instance actor/token
 * documents. No player-provided actor fields, token overrides or raw source IDs.
 * IDs are host-generated and all calculations are repeated immediately before
 * committing, after any async compendium lookup. */
export function planSummon(input: {
  definition: SummonDefinition; presetId: string; scene: SceneDocument; source: ActorDocument;
  caller: PermissionUser; summoner?: TokenDocument; at: { x: number; y: number };
  now: number; instanceId: string; actorId: string; tokenId: string; manifest: AssetManifest;
}): SummonResult {
  const { definition, presetId, scene, source, caller, summoner, at, now, instanceId, actorId, tokenId, manifest } = input;
  const fail = (error: string): SummonResult => ({ ok: false, error });
  if (![presetId, instanceId, actorId, tokenId].every((id) => ID.test(id))) return fail("invalid summon IDs");
  if (definition.sceneId !== scene._id || !scene.active || source.type !== "actor" ||
    !source.name?.trim() || source.name.length > 128 || !Array.isArray(source.items) || !Array.isArray(source.effects) ||
    !object(source.system) || !object(source.flags) ||
    !finite(scene.grid.size, 1, 10_000) || !finite(scene.grid.distance, Number.EPSILON, 10_000) ||
    !finite(now, 0, 9e15)) return fail("summon source or scene unavailable");
  try { if (JSON.stringify(source).length > 200_000) return fail("summon source exceeds 200 KiB"); }
  catch { return fail("summon source must be serializable"); }
  const placement = summonPlacementError(scene, definition, at, summoner,
    caller.role !== "GM" && caller.role !== "ASSISTANT");
  if (placement) return fail(placement);
  const cell = scene.grid.size * (definition.size ?? 1);
  const expiresAt = definition.durationMs === undefined ? undefined : now + definition.durationMs;
  if (expiresAt !== undefined && !finite(expiresAt, now + 1000, 9e15)) return fail("invalid summon expiry");
  const marker: SummonMarker = { version: 1, instanceId, presetId, sceneId: scene._id,
    actorId, tokenId, ownerId: caller.id, createdAt: now, ...(expiresAt ? { expiresAt } : {}) };
  // A source image is optional and must be an available, player-shareable owned hash.
  // Never load a URL or infer redistribution permission from a filename/hash.
  const rawImg = (source as ActorDocument & { img?: unknown }).img;
  const image = typeof rawImg === "string" && HASH.test(rawImg) &&
    manifest[rawImg] && manifest[rawImg].visibility !== "gm" ? rawImg : "";
  const flags: FlagStore = { summon: marker as unknown as Record<string, Json> };
  const actor: ActorDocument = { ...structuredClone(source), _id: actorId, name: source.name,
    ownership: { default: 0, [caller.id]: 3 }, flags,
    items: structuredClone(source.items), effects: structuredClone(source.effects), img: image } as ActorDocument;
  const token: TokenDocument = { _id: tokenId, type: "token", name: source.name,
    ownership: { default: 1, [caller.id]: 3 }, flags: structuredClone(flags), system: {},
    x: at.x, y: at.y, width: cell, height: cell, rotation: 0, img: image,
    actorId, hidden: false, disposition: definition.disposition ?? "friendly", vision: true,
    light: { radius: 0, alpha: 0, color: "#ffffff" } };
  return { ok: true, actor, token, marker, ops: [
    { kind: "create", coll: "actors", data: actor },
    { kind: "create", coll: "tokens", parent: { coll: "scenes", id: scene._id }, data: token },
  ] };
}

/** Deleting a summon token, its instance actor, or its scene removes the linked
 * counterpart in the SAME undoable envelope. An unrelated source actor is never
 * touched. Ordinary scene tokens/actors are unaffected. */
export function summonDeletionOps(world: Readonly<WorldCollections>, ops: Op[]): Op[] {
  const scenes = new Set(ops.flatMap((op) => op.kind === "delete" && op.ref.coll === "scenes" && !op.ref.parent
    ? [op.ref.id] : []));
  const actors = new Set(ops.flatMap((op) => op.kind === "delete" && op.ref.coll === "actors" && !op.ref.parent
    ? [op.ref.id] : []));
  const tokens = new Set(ops.flatMap((op) => op.kind === "delete" && op.ref.coll === "tokens" && op.ref.parent?.coll === "scenes"
    ? [`${op.ref.parent.id}\u0000${op.ref.id}`] : []));
  if (!scenes.size && !actors.size && !tokens.size) return ops;
  const more: Op[] = [];
  for (const scene of world.scenes) for (const token of scene.tokens) {
    const marker = summonMarker(token);
    if (!marker || marker.sceneId !== scene._id || marker.tokenId !== token._id ||
        !(scenes.has(scene._id) || actors.has(marker.actorId) || tokens.has(`${scene._id}\u0000${token._id}`))) continue;
    if (!actors.has(marker.actorId) && world.actors.some((actor) => actor._id === marker.actorId)) {
      actors.add(marker.actorId);
      more.push({ kind: "delete", ref: { coll: "actors", id: marker.actorId } });
    }
    if (!scenes.has(scene._id) && !tokens.has(`${scene._id}\u0000${token._id}`)) {
      tokens.add(`${scene._id}\u0000${token._id}`);
      more.push({ kind: "delete", ref: { coll: "tokens", id: token._id,
        parent: { coll: "scenes", id: scene._id } } });
    }
  }
  return more.length ? [...ops, ...more] : ops;
}
