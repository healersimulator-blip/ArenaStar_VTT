/**
 * One-shot FX timeline player. Receives ONLY host-approved cues from ClientSync;
 * never mutates documents. Media loads lazily through the entitled asset fetcher.
 * The stage's FX strata are below fog (not the ping/ruler overlay).
 */
import { Texture } from "pixi.js";
import type { Stage } from "../canvas/stage";
import type { FxStartMsg } from "../core/messages";
import type { ResolvedFxSection } from "../core/fx";
import { cameraAt, cameraPanEnd, type ResolvedCameraSection } from "../canvas/fxCamera";
import type { Camera } from "../canvas/camera";
import type { ClientEvents, ClientSync } from "./sync";
import type { EventBus } from "../core/events";

export interface FxPlayerOptions {
  client: ClientSync;
  bus: EventBus<ClientEvents>;
  stage: Stage;
  fetchAsset: (hash: string) => Promise<Uint8Array>;
  sceneId: () => string | null;
  onError?: (error: string) => void;
}

export class FxPlayer {
  private readonly off: () => void;
  private readonly offEnd: () => void;
  private readonly offWelcome: () => void;
  private readonly offFrame: () => void;
  private readonly timers = new Map<ReturnType<typeof setTimeout>, string>();
  private readonly stopAudio = new Map<string, Set<() => void>>();
  private readonly seenRuns = new Set<string>();
  /** GM-authored drafts rendered locally for their author; never committed or relayed. */
  private readonly previewRuns = new Set<string>();
  /** A stopped/undone run may reuse its ID: old async decodes must not respawn. */
  private readonly runEpoch = new Map<string, number>();
  private scene: string | null;
  private generation = 0;
  private disposed = false;
  /** The one camera cue currently claiming this viewer's view, if any. */
  private view: { runId: string; sceneId: string; section: ResolvedCameraSection; base: Camera;
    startedAtHost: number; generation: number; epoch: number } | null = null;
  /** Runs whose camera track this viewer took back by dragging/zooming the map. */
  private readonly cameraTakenBack = new Set<string>();

  constructor(private readonly options: FxPlayerOptions) {
    this.scene = options.sceneId();
    this.off = options.bus.on("fx", (cue) => this.start(cue));
    this.offEnd = options.bus.on("fxEnd", (end) => this.stopRun(end.runId));
    this.offFrame = options.stage.onFrame(() => this.tickCamera());
    this.offWelcome = options.bus.on("welcome", () => {
      // A newly connected host may have ended instances while we were offline.
      this.clearLocal();
      this.scene = this.options.sceneId();
      if (this.scene) this.options.client.requestFxSync(this.scene);
    });
    if (this.scene) options.client.requestFxSync(this.scene);
  }

  private clearLocal(): void {
    this.generation++;
    for (const timer of this.timers.keys()) clearTimeout(timer);
    this.timers.clear();
    for (const stops of [...this.stopAudio.values()]) for (const stop of [...stops]) stop();
    this.options.stage.getFxLayer().clear();
    // A view claim dies with the scene/run it belonged to: leaving a camera
    // parked where a stopped timeline put it would be state nothing owns.
    this.releaseCamera(true);
    this.seenRuns.clear();
    this.previewRuns.clear();
    this.cameraTakenBack.clear();
    this.runEpoch.clear();
  }

  /** Switch/reconnect: no old-scene image, sound or deferred timer survives. */
  syncScene(): void {
    const next = this.options.sceneId();
    if (next === this.scene) return;
    this.clearLocal();
    this.scene = next;
    if (next) this.options.client.requestFxSync(next);
  }

  /**
   * GM-local preview of an **unsaved draft**: the same renderer and the same
   * host-clock offsets, but no host commit, no durable instance and no
   * recipient — a preview cannot create world state, outlive its author's
   * session, or grant a player a read. One preview at a time.
   */
  preview(cue: FxStartMsg): void {
    if (this.disposed || cue.sceneId !== this.scene) return;
    this.clearPreview();
    this.previewRuns.add(cue.runId);
    this.start(cue);
  }

  /**
   * The viewer grabbed the map (drag or wheel) while a timeline held their view.
   * The handover is deliberately **quiet**: the claim is dropped and the rest of
   * that run's camera track is ignored, but no camera is written — the gesture
   * that triggered this is already moving the view, and restoring the pre-pan
   * position here would silently undo it. (An explicit *stop* is the other case:
   * that restores where the viewer was — see `releaseCamera`.)
   */
  cancelCamera(): void {
    const claimed = this.view;
    if (!claimed) return;
    this.view = null;
    this.cameraTakenBack.add(claimed.runId);
    if (this.cameraTakenBack.size > 256) {
      const first = this.cameraTakenBack.values().next().value;
      if (first) this.cameraTakenBack.delete(first);
    }
  }

  /** End every local preview (window close, Stop button, or scene switch above). */
  clearPreview(): void {
    for (const runId of [...this.previewRuns]) {
      this.previewRuns.delete(runId);
      this.stopRun(runId);
    }
  }

  private stopRun(runId: string): void {
    if (this.view?.runId === runId) this.releaseCamera(true);
    this.runEpoch.set(runId, (this.runEpoch.get(runId) ?? 0) + 1);
    this.seenRuns.delete(runId);
    for (const [timer, id] of this.timers) {
      if (id !== runId) continue;
      clearTimeout(timer);
      this.timers.delete(timer);
    }
    for (const stop of [...this.stopAudio.get(runId) ?? []]) stop();
    this.stopAudio.delete(runId);
    this.options.stage.getFxLayer().clear(runId);
  }

  private hostNow(): number {
    return Date.now() + (this.options.client.clockOffset()?.offsetMs ?? 0);
  }

  private start(cue: FxStartMsg): void {
    this.syncScene();
    if (this.disposed || cue.sceneId !== this.scene || this.seenRuns.has(cue.runId)) return;
    this.seenRuns.add(cue.runId);
    if (this.seenRuns.size > 256) {
      const first = this.seenRuns.values().next().value;
      if (first) this.seenRuns.delete(first);
    }
    const generation = this.generation;
    const epoch = (this.runEpoch.get(cue.runId) ?? 0) + 1;
    this.runEpoch.set(cue.runId, epoch);
    for (const section of cue.sections) {
      if (section.kind === "wait") continue;
      // A camera cue is a claim on THIS viewer's view. The host resolved and
      // bounds-checked the destination; the client only animates its own camera.
      if (section.kind === "camera") {
        const delay = cue.atHostTime + section.startMs - this.hostNow();
        if (delay < 0) continue; // a view claim never starts late; it is not a visual to catch up on
        const cameraTimer = setTimeout(() => {
          this.timers.delete(cameraTimer);
          if (this.disposed || generation !== this.generation || this.options.sceneId() !== cue.sceneId ||
              this.runEpoch.get(cue.runId) !== epoch || this.cameraTakenBack.has(cue.runId)) return;
          this.beginCamera(cue, section, generation, epoch);
        }, delay);
        this.timers.set(cameraTimer, cue.runId);
        continue;
      }
      const delay = cue.atHostTime + section.startMs - this.hostNow();
      if (!cue.persistent && delay + section.durationMs <= 0) continue; // don't replay a stale one-shot
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.disposed || generation !== this.generation || this.options.sceneId() !== cue.sceneId ||
            this.runEpoch.get(cue.runId) !== epoch) return;
        void this.play(cue, section, generation, epoch);
      }, Math.max(0, delay));
      this.timers.set(timer, cue.runId);
    }
  }

  /** Start a camera cue: capture the base view, then animate from it on every frame. */
  private beginCamera(cue: FxStartMsg, section: ResolvedCameraSection, generation: number, epoch: number): void {
    if (this.cameraTakenBack.has(cue.runId)) return;
    this.releaseCamera(true); // one claim at a time; a new section starts from the live view
    this.view = { runId: cue.runId, sceneId: cue.sceneId, section, base: this.options.stage.camera,
      startedAtHost: cue.atHostTime + section.startMs, generation, epoch };
    this.tickCamera();
  }

  private tickCamera(): void {
    const claimed = this.view;
    if (!claimed) return;
    if (this.cameraTakenBack.has(claimed.runId)) {
      // The viewer's own drag/wheel already owns the view: drop the claim **without**
      // writing a camera. Restoring the pre-cue position here would undo exactly the
      // gesture that took control, on the very next frame.
      this.view = null;
      return;
    }
    if (this.disposed || claimed.generation !== this.generation ||
        this.runEpoch.get(claimed.runId) !== claimed.epoch ||
        this.options.sceneId() !== claimed.sceneId) {
      this.releaseCamera(true);
      return;
    }
    const elapsed = this.hostNow() - claimed.startedAtHost;
    const viewport = this.options.stage.viewport;
    const want = cameraAt(claimed.section, claimed.base, viewport, elapsed);
    if (want) {
      this.options.stage.setCamera(want);
      return;
    }
    // Finished. A shake hands the view back exactly as it found it; a pan leaves
    // it on the destination, which is the whole point of a pan.
    this.view = null;
    this.options.stage.setCamera(claimed.section.mode === "shake"
      ? claimed.base
      : cameraPanEnd(claimed.section, claimed.base, viewport));
  }

  /** Release a camera claim; `restore` puts the view back where the section found it. */
  private releaseCamera(restore: boolean): void {
    const claimed = this.view;
    if (!claimed) return;
    this.view = null;
    if (restore) this.options.stage.setCamera(claimed.base);
  }

  private async play(cue: FxStartMsg, section: Exclude<ResolvedFxSection, { kind: "wait" }>,
    generation: number, epoch: number): Promise<void> {
    const elapsed = () => Math.max(0, this.hostNow() - cue.atHostTime - section.startMs);
    const active = () => !this.disposed && generation === this.generation &&
      this.runEpoch.get(cue.runId) === epoch && this.options.sceneId() === cue.sceneId;
    if (section.kind === "camera") return; // animated per frame by tickCamera
    if (section.kind === "text") {
      if (active()) this.options.stage.getFxLayer().spawn(cue.runId, section, elapsed(), undefined, undefined,
        cue.persistent === true);
      return;
    }
    try {
      const bytes = await this.options.fetchAsset(section.assetId);
      if (!active() || !cue.persistent && elapsed() >= section.durationMs) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: section.mime }));
      if (section.kind === "sound") {
        const audio = new Audio(url);
        audio.volume = section.volume ?? 1;
        audio.loop = cue.persistent === true;
        const duration = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration : section.durationMs / 1000;
        audio.currentTime = cue.persistent ? (elapsed() / 1000) % duration : elapsed() / 1000;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          audio.pause();
          audio.src = "";
          URL.revokeObjectURL(url);
          const stops = this.stopAudio.get(cue.runId);
          stops?.delete(stop);
          if (stops?.size === 0) this.stopAudio.delete(cue.runId);
        };
        const stops = this.stopAudio.get(cue.runId) ?? new Set<() => void>();
        stops.add(stop);
        this.stopAudio.set(cue.runId, stops);
        audio.onended = stop;
        if (!cue.persistent) timer = setTimeout(stop, Math.max(0, section.durationMs - elapsed()));
        void audio.play().catch((err: unknown) => {
          this.options.onError?.(`FX audio unavailable: ${String(err)}`);
          stop();
        });
        return;
      }
      let texture: Texture;
      let video: HTMLVideoElement | null = null;
      try {
        if (section.mime.startsWith("video/")) {
          video = document.createElement("video");
          video.muted = true; // sound is an explicit sound section, not an autoplay side effect
          video.playsInline = true;
          video.loop = true;
          video.src = url;
          await new Promise<void>((resolve, reject) => {
            if (!video) return reject(new Error("video released"));
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error("video format unsupported"));
          });
          // Restored instances may have started hours ago. Seek into the
          // decoded clip's actual loop, not past EOF (which can stall WebM).
          const seconds = elapsed() / 1000;
          video.currentTime = cue.persistent && Number.isFinite(video.duration) && video.duration > 0
            ? seconds % video.duration : seconds;
          await video.play();
          texture = Texture.from(video);
        } else {
          const image = new Image();
          image.src = url;
          await image.decode();
          texture = Texture.from(image);
        }
        if (!active() || !cue.persistent && elapsed() >= section.durationMs) {
          video?.pause();
          texture.destroy(true);
          URL.revokeObjectURL(url);
          return;
        }
        const media = video;
        this.options.stage.getFxLayer().spawn(cue.runId, section, elapsed(), texture, () => {
          media?.pause();
          texture.destroy(true);
          URL.revokeObjectURL(url);
        }, cue.persistent === true);
      } catch (err) {
        video?.pause();
        URL.revokeObjectURL(url);
        throw err;
      }
    } catch (err) {
      this.options.onError?.(`FX ${section.kind} failed: ${String(err)}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.offEnd();
    this.offWelcome();
    this.offFrame();
    this.clearLocal();
  }
}
