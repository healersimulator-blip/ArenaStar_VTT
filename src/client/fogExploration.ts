/**
 * §9 explored fog — the client loop (D-250). Both shells (GM `App`, player `JoinApp`) feed
 * it the scene on every replica change; it decides whose tokens reveal (core/fogExploration),
 * asks the vision computer for their polygons, erases them from the fog surface, and keeps
 * the explored map persistent:
 *
 *   scene enters  → surface.reset() → fog.get → mergePng(stored)      (restore)
 *   tokens / walls change → polygons → reveal + setVisible → dirty      (explore)
 *   dirty for `saveDelayMs` (or scene leaves / flush) → readbackPng → fog.put   (save)
 *
 * The host persists fog.put per [worldId, sceneId, userId] and answers fog.get from that
 * store, so a reload, a reconnect, or a world file opened elsewhere all come back with the
 * same explored map. Every step is serialised on one promise chain, so a scene switch can
 * never read back a surface the next scene already replaced, and a stale polygon result
 * never lands on a newer scene. No pixi here: the surface is an interface, and the unit
 * tests drive the loop with a fake one.
 *
 * D-251 — what the viewer is shown: `onVisibility` receives the set of token ids the user
 * may see (their own tokens plus whatever stands in current sight), recomputed on EVERY
 * replica change against the last polygons (a token walking into an unmoved eye's sight
 * must appear), `null` when fog is off for the scene. It fails closed: the moment a fogged
 * scene is entered only the user's own tokens are listed, before any polygon exists. The
 * GM shell does not wire it (the GM sees everything under a translucent cover).
 */
import { sightSegments } from "../canvas/vision/wallSight";
import type { ActorDocument, SceneDocument } from "../core/documents";
import {
  flatSegments,
  fogRevealKey,
  fogSightRadius,
  fogViewers,
  fogVisibleTokenIds,
  sceneFogSettings,
} from "../core/fogExploration";
import type { PermissionUser } from "../core/ownership";
import type { VisionComputer } from "../workers/visionWorkerClient";

/**
 * How the cover is drawn: `opaque` is the player's fog (black over the unseen, a veil over
 * the remembered); `translucent` is the GM's — the same shapes at a fraction of the alpha,
 * so the GM sees where fog lies and everything under it (D-251).
 */
export type FogStyle = "opaque" | "translucent";

/** What the loop needs from a fog layer (FogLayer implements it). */
export interface FogSurface {
  reset(): void;
  reveal(poly: Float32Array): void;
  setVisible(polys: readonly Float32Array[]): void;
  mergePng(png: Uint8Array): Promise<void>;
  readbackPng(): Promise<Uint8Array>;
  setShown(shown: boolean): void;
  setStyle(style: FogStyle): void;
}

/** What the loop needs from ClientSync. */
export interface FogTransport {
  requestFog(sceneId: string): Promise<Uint8Array | null>;
  sendFogPng(sceneId: string, png: Uint8Array): void;
}

export interface FogExplorationOptions {
  /** The surface for a scene (the stage recreates its layer when the scene size changes). */
  surfaceFor: (scene: SceneDocument) => FogSurface;
  /** Fog is off for the current scene: hide whatever layer is mounted. */
  hideSurface: () => void;
  /** Owned by the loop: terminated on destroy. */
  computer: VisionComputer;
  transport: FogTransport;
  user: () => PermissionUser | null;
  actors: () => readonly ActorDocument[];
  /**
   * D-251: the token ids the user may currently see (`null` = fog off, everything). Called
   * only when the set changes. Player shells wire it to the stage; the GM shell leaves it.
   */
  onVisibility?: (visible: ReadonlySet<string> | null) => void;
  /** Quiet time after the last reveal before the map is uploaded (default 1500 ms). */
  saveDelayMs?: number;
  /**
   * How long a restore waits for the host (default 15 s). A restore that times out is
   * treated as "nothing stored" — the local map keeps accumulating and `refreshStored()`
   * (the shells call it on every welcome) merges the stored one in once the host answers.
   */
  restoreTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (where: string, error: unknown) => void;
}

export interface FogExplorationStats {
  sceneId: string | null;
  enabled: boolean;
  /** Restore finished for the current scene (stored map merged, or none stored). */
  restored: boolean;
  restoredBytes: number;
  reveals: number;
  saves: number;
  lastSaveBytes: number;
  dirty: boolean;
  /** D-251: token ids currently shown (null = fog off / not gating). */
  visibleTokenIds: string[] | null;
}

export class FogExploration {
  private chain: Promise<void> = Promise.resolve();
  private surface: FogSurface | null = null;
  private sceneId: string | null = null;
  private key: string | null = null;
  private dirty = false;
  private saveTimer: unknown = null;
  private restored = false;
  private restoredBytes = 0;
  private reveals = 0;
  private saves = 0;
  private lastSaveBytes = 0;
  private enabled = false;
  private destroyed = false;
  /** Polygons of the last reveal pass (current sight), for the visibility gate. */
  private polys: readonly Float32Array[] = [];
  private visibleKey: string | null = null;
  private visibleIds: Set<string> | null = null;
  private readonly saveDelayMs: number;
  private readonly restoreTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: FogExplorationOptions) {
    this.saveDelayMs = options.saveDelayMs ?? 1500;
    this.restoreTimeoutMs = options.restoreTimeoutMs ?? 15_000;
    this.setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Feed the current scene (null = none) and how this shell draws the cover. */
  sync(scene: SceneDocument | null, view: { style: FogStyle }): Promise<void> {
    return this.enqueue("sync", () => this.syncInner(scene, view.style));
  }

  /** Upload now if anything changed since the last save (scene switch, close, pagehide). */
  flush(): Promise<void> {
    return this.enqueue("flush", () => this.save());
  }

  /** Wait for everything queued so far (tests / e2e readbacks). */
  settle(): Promise<void> {
    return this.enqueue("settle", () => Promise.resolve());
  }

  /**
   * Merge the stored map in again (after a reconnect: a fresh host session may hold a map
   * this client never received, and the union makes a repeat harmless).
   */
  refreshStored(): Promise<void> {
    return this.enqueue("refresh", async () => {
      const surface = this.surface;
      const sceneId = this.sceneId;
      if (!surface || sceneId === null || this.destroyed) return;
      const stored = await this.fetchStored(sceneId);
      if (this.surface !== surface || this.sceneId !== sceneId || this.destroyed) return;
      if (stored && stored.length > 0) {
        await surface.mergePng(stored);
        this.restoredBytes = stored.length;
        this.restored = true;
      }
    });
  }

  stats(): FogExplorationStats {
    return {
      sceneId: this.sceneId,
      enabled: this.enabled,
      restored: this.restored,
      restoredBytes: this.restoredBytes,
      reveals: this.reveals,
      saves: this.saves,
      lastSaveBytes: this.lastSaveBytes,
      dirty: this.dirty,
      visibleTokenIds: this.visibleIds ? [...this.visibleIds].sort() : null,
    };
  }

  /**
   * Stops the loop: no further reveals or restores; a `flush()` queued before this call
   * still lands (the shells call `flush()` then `destroy()` in their teardown). Terminating
   * the computer rejects any in-flight polygon request, so the chain never hangs on it.
   */
  destroy(): void {
    this.destroyed = true;
    this.cancelTimer();
    this.options.computer.terminate();
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private enqueue(where: string, step: () => Promise<void>): Promise<void> {
    const next = this.chain.then(step);
    this.chain = next.catch((error) => {
      this.options.onError?.(where, error);
    });
    return this.chain;
  }

  private async syncInner(scene: SceneDocument | null, style: FogStyle): Promise<void> {
    if (this.destroyed) return;
    const settings = scene ? sceneFogSettings(scene) : { enabled: false, rangeSquares: null };
    if (!scene || !settings.enabled) {
      await this.leaveScene();
      this.enabled = false;
      this.options.hideSurface();
      this.publishVisibility(null);
      return;
    }
    this.enabled = true;
    const user = this.options.user();
    const actors = this.options.actors();
    if (scene._id !== this.sceneId) {
      await this.leaveScene();
      const surface = this.options.surfaceFor(scene);
      surface.reset();
      surface.setStyle(style);
      surface.setShown(true);
      this.surface = surface;
      this.sceneId = scene._id;
      this.key = null;
      this.polys = [];
      this.restored = false;
      this.restoredBytes = 0;
      // fail closed: until the first polygons exist only the user's own tokens are shown
      this.publishVisibility(fogVisibleTokenIds(scene, user, [], { actors }));
      const stored = await this.fetchStored(scene._id);
      if (this.destroyed || this.sceneId !== scene._id) return;
      if (stored && stored.length > 0) {
        await surface.mergePng(stored);
        this.restoredBytes = stored.length;
      }
      this.restored = true;
    }
    const surface = this.surface;
    if (!surface) return;
    surface.setStyle(style);
    surface.setShown(true);

    const viewers = fogViewers(scene, user, { actors });
    const radius = fogSightRadius(scene, settings);
    const key = fogRevealKey(scene, viewers, radius);
    if (key !== this.key) {
      this.key = key;
      const segments = flatSegments(sightSegments(scene.walls));
      const polys = await Promise.all(
        viewers.map((v) => this.options.computer.compute(v.x, v.y, segments, radius)),
      );
      if (this.destroyed || this.sceneId !== scene._id || this.surface !== surface) return;
      for (const poly of polys) surface.reveal(poly);
      surface.setVisible(polys);
      this.polys = polys;
      this.reveals++;
      if (polys.length > 0) {
        this.dirty = true;
        this.scheduleSave();
      }
    }
    // every replica change: a token may have walked into (or out of) an unmoved eye's sight
    this.publishVisibility(fogVisibleTokenIds(scene, user, this.polys, { actors }));
  }

  /** Hand the shell the visible set, only when it changed (null = fog off, everything). */
  private publishVisibility(ids: Set<string> | null): void {
    const key = ids === null ? null : [...ids].sort().join("\n");
    if (key === this.visibleKey) return;
    this.visibleKey = key;
    this.visibleIds = ids;
    this.options.onVisibility?.(ids);
  }

  /** The stored map for a scene, or null on a miss, an error, or a host that stays silent. */
  private async fetchStored(sceneId: string): Promise<Uint8Array | null> {
    let handle: unknown = null;
    const timeout = new Promise<null>((resolve) => {
      handle = this.setTimer(() => resolve(null), this.restoreTimeoutMs);
    });
    try {
      return await Promise.race([this.options.transport.requestFog(sceneId), timeout]);
    } catch (error) {
      this.options.onError?.("restore", error);
      return null;
    } finally {
      if (handle !== null) this.clearTimer(handle);
    }
  }

  /** Save the current scene's map (if dirty) and forget the scene. */
  private async leaveScene(): Promise<void> {
    if (this.sceneId === null) return;
    await this.save();
    this.sceneId = null;
    this.surface = null;
    this.key = null;
    this.polys = [];
    this.restored = false;
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = this.setTimer(() => {
      this.saveTimer = null;
      void this.enqueue("save", () => this.save());
    }, this.saveDelayMs);
  }

  private cancelTimer(): void {
    if (this.saveTimer !== null) {
      this.clearTimer(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private async save(): Promise<void> {
    this.cancelTimer();
    const surface = this.surface;
    const sceneId = this.sceneId;
    if (!this.dirty || !surface || sceneId === null) return;
    this.dirty = false;
    const png = await surface.readbackPng();
    this.options.transport.sendFogPng(sceneId, png);
    this.saves++;
    this.lastSaveBytes = png.length;
  }
}
