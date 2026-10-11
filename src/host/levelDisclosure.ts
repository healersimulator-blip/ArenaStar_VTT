/** Host-only level exposure planning. This is NOT wired into legacy replica projection yet.
 * A caller must supply one immutable authoritative geometry/document revision. Never accept
 * bodies, lighting, floor permissions or geometry from a player's request.
 */
import type { ActorDocument, SceneDocument, TokenDocument } from "../core/documents";
import type { PermissionUser } from "../core/ownership";
import { can } from "../core/permissions";
import { maskHiddenTokenIds } from "../core/fogExploration";
import { sceneLevelsError } from "../core/levels";
import { SpatialKernel, type SpatialBarrier, type SpatialSurface } from "../core/spatial/kernel";
import { SpatialPerception, bodySamples, perceptionBodyError, type PerceptionBody, type SpatialLight } from "../core/spatial/perception";

export interface LevelDisclosureInput {
  scene: SceneDocument;
  actors: readonly ActorDocument[];
  bodies: ReadonlyMap<string, PerceptionBody>;
  barriers: readonly SpatialBarrier[];
  surfaces: readonly SpatialSurface[];
  lights: readonly SpatialLight[];
  worldSeq: number;
  geometryRevision: number;
}
export interface LevelDisclosureRequest {
  /** A display preference, never a grant. */
  levelId: string;
  /** A caller may reduce owned viewers, not add unauthorized ones. */
  observerIds?: readonly string[];
}
export interface LevelExposurePlan {
  sceneId: string;
  userId: string;
  worldSeq: number;
  geometryRevision: number;
  viewedLevelId: string;
  levels: Array<{ id: string; name: string }>;
  tokenIds: string[];
  /** Point/body tests do not prove any terrain area visible. No cross-floor room-art grant. */
  terrainRegions: never[];
}
export type LevelExposureResult = { ok: true; plan: LevelExposurePlan } | { ok: false; error: "unavailable" | "budget" };

export class HostLevelDisclosure {
  private readonly scene: SceneDocument;
  private readonly actors: readonly ActorDocument[];
  private readonly bodies: ReadonlyMap<string, PerceptionBody>;
  private readonly perception: SpatialPerception;
  private readonly worldSeq: number;
  private readonly geometryRevision: number;
  constructor(input: LevelDisclosureInput) {
    if (!Number.isSafeInteger(input.worldSeq) || input.worldSeq < 0 || !Number.isSafeInteger(input.geometryRevision) || input.geometryRevision < 0 ||
        !input.scene.levels?.length || sceneLevelsError(input.scene) || input.scene.tokens.length > 500 || input.bodies.size > 500) throw new Error("Invalid authoritative perception snapshot");
    this.scene = structuredClone(input.scene); this.actors = structuredClone(input.actors); this.bodies = structuredClone(input.bodies);
    this.worldSeq = input.worldSeq; this.geometryRevision = input.geometryRevision;
    for (const [id, body] of this.bodies) {
      const token = this.scene.tokens.find((t) => t._id === id);
      if (!token || perceptionBodyError(body) || body.feet.x !== token.x || body.feet.y !== token.y || body.feet.z !== (token.elevation ?? 0) ||
          body.width !== token.width || body.depth !== token.height || body.rotation !== token.rotation) throw new Error("Body is not aligned with authoritative token geometry");
    }
    this.perception = new SpatialPerception(new SpatialKernel(input.barriers, input.surfaces), input.lights, this.scene.grid.size / this.scene.grid.distance);
  }
  private owned(user: PermissionUser, token: TokenDocument): boolean {
    if (can(user, "update", token, "tokens", { parent: this.scene })) return true;
    const actor = this.actors.find((a) => a._id === token.actorId);
    return !!actor && can(user, "update", actor, "actors");
  }
  plan(user: PermissionUser, request: LevelDisclosureRequest): LevelExposureResult {
    const scene = this.scene;
    const gm = user.role === "GM" || user.role === "ASSISTANT";
    // Identical refusal for nonexistent, hidden and unauthorized floors: do not leak names/counts.
    if (!request || typeof request.levelId !== "string" || !can(user, "read", scene, "scenes")) return { ok: false, error: "unavailable" };
    const owned = scene.tokens.filter((t) => this.owned(user, t));
    const allowedLevels = (scene.levels ?? []).filter((l) => gm || owned.some((t) => t.levelId === l._id));
    if (!allowedLevels.some((l) => l._id === request.levelId)) return { ok: false, error: "unavailable" };
    if (request.observerIds !== undefined && (!Array.isArray(request.observerIds) || request.observerIds.length > 8 || new Set(request.observerIds).size !== request.observerIds.length ||
        !Array.from(request.observerIds).every((id) => typeof id === "string" && owned.some((t) => t._id === id && t.vision)))) return { ok: false, error: "unavailable" };
    const observers = owned.filter((t) => t.vision && t.levelId !== undefined && (request.observerIds === undefined || request.observerIds.includes(t._id)));
    if (observers.length > 8) return { ok: false, error: "budget" };
    // Missing body data is fail-closed for the whole request, not a silently guessed eye height.
    if (observers.some((t) => !this.bodies.has(t._id))) return { ok: false, error: "unavailable" };
    const visible = new Set(owned.map((t) => t._id));
    const masked = maskHiddenTokenIds(scene, user, { actors: this.actors });
    this.perception.begin();
    try {
      for (const target of scene.tokens) {
        if (visible.has(target._id) || target.hidden || masked.has(target._id) || !target.levelId || !can(user, "read", target, "tokens", { parent: scene })) continue;
        const body = this.bodies.get(target._id), level = scene.levels?.find((l) => l._id === target.levelId);
        if (!body || !level) continue;
        const samples = bodySamples(body);
        for (const observer of observers) {
          const fromLevel = scene.levels?.find((l) => l._id === observer.levelId), eye = this.bodies.get(observer._id);
          if (!eye || !fromLevel || (target.levelId !== observer.levelId && !fromLevel.visibleLevelIds.includes(target.levelId))) continue;
          if (this.perception.sees(eye, samples, level.darkness ?? scene.darkness)) { visible.add(target._id); break; }
        }
      }
    } catch { return { ok: false, error: "budget" }; }
    return { ok: true, plan: { sceneId: scene._id, userId: user.id, worldSeq: this.worldSeq, geometryRevision: this.geometryRevision,
      viewedLevelId: request.levelId, levels: allowedLevels.map((l) => ({ id: l._id, name: l.name })).sort((a, b) => a.id.localeCompare(b.id)),
      tokenIds: [...visible].sort(), terrainRegions: [] } };
  }
}

export interface LevelExposureDelta {
  sceneId: string;
  userId: string;
  baseViewRevision: number;
  viewRevision: number;
  worldSeq: number;
  geometryRevision: number;
  addedTokenIds: string[];
  removedTokenIds: string[];
  levels: LevelExposurePlan["levels"];
  viewedLevelId: string;
}
/** Private per-session state. A conceal is a view removal, never a canonical world delete. */
export class LevelExposureTracker {
  private plan: LevelExposurePlan | null = null;
  private revision = 0;
  update(next: LevelExposurePlan): LevelExposureDelta {
    if (this.plan && (next.userId !== this.plan.userId || next.sceneId !== this.plan.sceneId || next.worldSeq < this.plan.worldSeq || next.geometryRevision < this.plan.geometryRevision)) throw new Error("Stale or mismatched exposure snapshot");
    const previous = new Set(this.plan?.tokenIds ?? []), current = new Set(next.tokenIds);
    const delta: LevelExposureDelta = { sceneId: next.sceneId, userId: next.userId, baseViewRevision: this.revision, viewRevision: ++this.revision,
      worldSeq: next.worldSeq, geometryRevision: next.geometryRevision, addedTokenIds: [...current].filter((id) => !previous.has(id)),
      removedTokenIds: [...previous].filter((id) => !current.has(id)), levels: structuredClone(next.levels), viewedLevelId: next.viewedLevelId };
    this.plan = structuredClone(next); return delta;
  }
}
