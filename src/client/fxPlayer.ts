/**
 * One-shot FX timeline player. Receives ONLY host-approved cues from ClientSync;
 * never mutates documents. Media loads lazily through the entitled asset fetcher.
 * The stage's FX strata are below fog (not the ping/ruler overlay).
 */
import { Texture } from "pixi.js";
import type { Stage } from "../canvas/stage";
import type { FxStartMsg } from "../core/messages";
import type { ResolvedFxSection } from "../core/fx";
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

  constructor(private readonly options: FxPlayerOptions) {
    this.scene = options.sceneId();
    this.off = options.bus.on("fx", (cue) => this.start(cue));
    this.offEnd = options.bus.on("fxEnd", (end) => this.stopRun(end.runId));
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
    this.seenRuns.clear();
    this.previewRuns.clear();
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

  /** End every local preview (window close, Stop button, or scene switch above). */
  clearPreview(): void {
    for (const runId of [...this.previewRuns]) {
      this.previewRuns.delete(runId);
      this.stopRun(runId);
    }
  }

  private stopRun(runId: string): void {
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

  private async play(cue: FxStartMsg, section: Exclude<ResolvedFxSection, { kind: "wait" }>,
    generation: number, epoch: number): Promise<void> {
    const elapsed = () => Math.max(0, this.hostNow() - cue.atHostTime - section.startMs);
    const active = () => !this.disposed && generation === this.generation &&
      this.runEpoch.get(cue.runId) === epoch && this.options.sceneId() === cue.sceneId;
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
    this.clearLocal();
  }
}
