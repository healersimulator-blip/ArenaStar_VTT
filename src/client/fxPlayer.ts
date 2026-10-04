/**
 * One-shot FX timeline player. Receives ONLY host-approved cues from ClientSync;
 * never mutates documents. Media loads lazily through the entitled asset fetcher.
 * The stage's FX strata are below fog (not the ping/ruler overlay).
 */
import { Texture } from "pixi.js";
import type { Stage } from "../canvas/stage";
import type { FxMediaAckState, FxStartMsg } from "../core/messages";
import type { ResolvedFxSection } from "../core/fx";
import { cameraAt, cameraEnd, type ResolvedCameraSection } from "../canvas/fxCamera";
import {
  fxMediaCues, fxPreloadPlan, lateMediaDecision, summarizeDelivery,
  type FxDeliveryEntry, type FxDeliveryReport,
} from "../core/fxDelivery";
import { domCanPlay, fxAssetFitness, fxViewPrefs, subscribeFxViewPrefs, type FxViewPrefs } from "../core/fxPrefs";
import { soundChannelOf, soundFadeGain, soundGain, soundNeedsGraph, soundSpatial,
  type SoundSpatial } from "../core/fxSound";
import { registerFxSound, setFxSoundGain, setFxSoundSpatial } from "./fxSounds";
import { attachSpatialAudio, type SpatialAudioNodes } from "./fxAudioGraph";
import type { Camera } from "../canvas/camera";
import type { ClientEvents, ClientSync } from "./sync";
import type { EventBus } from "../core/events";

/**
 * Below this, "late" is just the cost of a decode and not worth telling the table
 * about. Above it, a viewer is looking at a cue that did not arrive on time.
 */
const LATE_TOLERANCE_MS = 120;
/** Avoid Blob-URL decoder task deferral for small sprites without blocking on large base64 work. */
const STATIC_IMAGE_DATA_URL_MAX_BYTES = 512 * 1024;
const staticImageDataUrl = (bytes: Uint8Array, mime: string): string | undefined => {
  if (bytes.byteLength > STATIC_IMAGE_DATA_URL_MAX_BYTES || typeof window === "undefined" ||
      typeof btoa !== "function") return undefined;
  let binary = "";
  for (let at = 0; at < bytes.byteLength; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, Math.min(bytes.byteLength, at + 0x8000)));
  return `data:${mime};base64,${btoa(binary)}`;
};
const decoderUnsupported = (error: unknown): boolean =>
  /unsupported|format|decode|not supported/i.test(String(error));

interface FxMediaClipWindow {
  /** Seconds in the decoded source; start is inclusive and end exclusive. */
  start: number;
  end: number;
  span: number;
}
/** Resolve authored source-time marks only after the browser knows the real duration. */
function fxMediaClipWindow(
  section: { clipStartMs?: number; clipEndMs?: number },
  sourceDuration: number,
): FxMediaClipWindow | null {
  if (section.clipStartMs === undefined && section.clipEndMs === undefined) return null;
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0)
    throw new Error("FX media clip needs a finite source duration");
  const start = (section.clipStartMs ?? 0) / 1_000;
  const end = Math.min(sourceDuration, (section.clipEndMs ?? sourceDuration * 1_000) / 1_000);
  if (!(end > start)) throw new Error("FX media clip starts outside this source's duration");
  return { start, end, span: end - start };
}
const fxLoopedClipTime = (clip: FxMediaClipWindow, mediaElapsed: number): number =>
  clip.start + mediaElapsed % clip.span;

interface FxPrefetchRecord {
  /** The D-308 receipt stays byte-scoped; decoder usability is tracked separately. */
  done: boolean;
  failed: boolean;
  work: Promise<void>;
  startedAt: number;
  /** Byte availability; final image readiness may be later. */
  readyAtHost?: number;
  /** Static images are decoded during their lead window, not for the first time at cue time. */
  decodeWork?: Promise<void>;
  decodeFailed: boolean;
  decodeError?: unknown;
  decodeReadyAtHost?: number;
  image?: HTMLImageElement;
  objectUrl?: string;
}

export interface FxPlayerOptions {
  client: ClientSync;
  bus: EventBus<ClientEvents>;
  stage: Stage;
  fetchAsset: (hash: string) => Promise<Uint8Array>;
  /**
   * This serverless viewer is also the host that owns the source bytes. Its client fetcher
   * still uses the normal loopback path, but that internal hop is not audience delivery.
   */
  isAssetLocal?: (hash: string) => boolean;
  sceneId: () => string | null;
  onError?: (error: string) => void;
  /** SQ-13: what this viewer's delivery looked like (late, skipped, cut, failed). */
  onDelivery?: (report: FxDeliveryReport) => void;
  /** Where a run's name comes from for the report line (the world's own macro). */
  macroName?: (macroId: string) => string | null;
  /** The world's own name for an imported asset, for the local "playing now" list. */
  assetName?: (hash: string) => string | null;
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
  /**
   * D-308: what this viewer has already told the host about each run's media, so a run
   * never repeats itself. The *latest* state is the truth (a fetch that failed at cue
   * start and succeeded when the section actually needed the bytes has the media), so a
   * change is sent and a repeat is not.
   */
  private readonly mediaAcks = new Map<string, Map<string, FxMediaAckState>>();
  /** This browser's own decoder opinion, cached; `null` in a shell without a DOM. */
  private readonly canPlay = domCanPlay();
  private scene: string | null;
  private generation = 0;
  private disposed = false;
  /** The one camera cue currently claiming this viewer's view, if any. */
  private view: { runId: string; sceneId: string; section: ResolvedCameraSection; base: Camera;
    startedAtHost: number; generation: number; epoch: number } | null = null;
  /** Runs whose camera track this viewer took back by dragging/zooming the map. */
  private readonly cameraTakenBack = new Set<string>();
  /** SQ-13/A10: this device's own preferences; never sent anywhere. */
  private prefs: FxViewPrefs = fxViewPrefs();
  private readonly offPrefs: () => void;
  /**
   * Assets this run asked for ahead of time. `readyAtHost` records when the bytes actually
   * became available on the host clock: a throttled browser timer may wake after the cue even
   * though its media was already in hand, and that scheduler delay must not be misreported as
   * late media.
   */
  private readonly prefetched = new Map<string, FxPrefetchRecord>();
  /** Per-run delivery entries plus how many media cues are still unresolved. */
  private readonly delivery = new Map<string, { macroId: string; entries: FxDeliveryEntry[];
    pending: number; reported: boolean }>();

  constructor(private readonly options: FxPlayerOptions) {
    this.scene = options.sceneId();
    this.off = options.bus.on("fx", (cue) => this.start(cue));
    this.offEnd = options.bus.on("fxEnd", (end) => this.stopRun(end.runId));
    this.offFrame = options.stage.onFrame(() => this.tickCamera());
    // A viewer may flip these mid-session; the next cue already obeys the new value.
    this.offPrefs = subscribeFxViewPrefs((prefs) => { this.prefs = prefs; });
    this.offWelcome = options.bus.on("welcome", () => {
      // A newly connected host may have ended instances while we were offline.
      this.clearLocal();
      this.scene = this.options.sceneId();
      if (this.scene) this.options.client.requestFxSync(this.scene);
    });
    if (this.scene) options.client.requestFxSync(this.scene);
  }

  /** Release decoder resources only when the whole scene/cache is leaving. */
  private releasePrefetch(record: FxPrefetchRecord): void {
    if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
    delete record.objectUrl;
    delete record.image;
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
    this.delivery.clear();
    for (const record of this.prefetched.values()) this.releasePrefetch(record);
    this.prefetched.clear();
    this.mediaAcks.clear();
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
    this.flushDelivery(runId); // a stopped run still reports what it never managed to show
    this.delivery.delete(runId);
    this.mediaAcks.delete(runId);
    // Prefetch records are shared by overlapping runs for the same asset. Stopping one run
    // must not discard another run's readiness timestamp; scene/reconnect teardown owns the
    // full clear, while a failed record is replaced on the next prefetch below.
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

  /**
   * Can this device hear that sound at all? The master switch and the per-channel
   * fader both answer no, and either way the bytes are not fetched (D-297).
   */
  private audible(section: ResolvedFxSection | undefined): boolean {
    if (!section || section.kind !== "sound") return true;
    return soundGain({ ...(section.volume !== undefined ? { volume: section.volume } : {}),
      channel: soundChannelOf(section), mix: this.prefs.soundMix }) > 0;
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
    // SQ-13: fetch what this timeline will need *before* the table expects it. The
    // cue arrives FX_LEAD_MS early, so a section later in the timeline has real lead
    // time — that is the whole difference between a cue that fires on time and one
    // that pops in late on the one viewer with a slow connection.
    // A run is "settled" when everything that could produce a delivery entry has
    // resolved: its media cues, plus its camera cues when this viewer asked for
    // reduced motion (only then can a camera cue be degraded).
    // D-308 (SQ-13): the answers this viewer can give *now* — a format this browser
    // refuses (known before a byte is fetched, so the fetch is not made at all), media
    // already in hand, and a fetch that failed for an earlier run. The rest of the
    // report arrives as the bytes do.
    const undecodable = new Set<string>();
    for (const item of fxMediaCues(cue.sections)) {
      if (this.mediaAcks.get(cue.runId)?.has(item.assetId)) continue;
      const held = this.prefetched.get(item.assetId);
      if (this.undecodable(item.mime)) {
        undecodable.add(item.assetId);
        this.ackMedia(cue.runId, item.assetId, "unsupported");
      } else if (held?.done === true) {
        this.ackMedia(cue.runId, item.assetId, "ready"); // bytes already in hand
      } else if (held?.failed === true) {
        this.ackMedia(cue.runId, item.assetId, "failed", { reason: "fetch" });
      }
    }
    const cameras = this.prefs.reduceMotion
      ? cue.sections.filter((section) => section.kind === "camera").length : 0;
    this.delivery.set(cue.runId, { macroId: cue.macroId, entries: [],
      pending: fxMediaCues(cue.sections).length + cameras, reported: false });
    for (const plan of fxPreloadPlan(cue.sections, { leadMs: cue.atHostTime - this.hostNow(),
      aheadMs: this.prefs.preloadAheadMs,
      // A viewer who muted FX sounds — or turned this channel down to zero — doesn't
      // want the bytes either: bandwidth is a courtesy, not a thing to spend on a cue
      // that will be skipped (D-295/D-297).
      include: (media) => !undecodable.has(media.assetId) &&
        (media.kind !== "sound" || this.audible(cue.sections[media.index])) })) {
      const start = () => { void this.prefetch(plan.assetId, plan.mime, cue.runId); };
      if (plan.waitMs <= 0) { start(); continue; }
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.disposed || generation !== this.generation || this.options.sceneId() !== cue.sceneId ||
            this.runEpoch.get(cue.runId) !== epoch) return;
        start();
      }, plan.waitMs);
      this.timers.set(timer, cue.runId);
    }
    cue.sections.forEach((section, index) => {
      if (section.kind === "wait") return;
      // A camera cue is a claim on THIS viewer's view. The host resolved and
      // bounds-checked the destination; the client only animates its own camera.
      if (section.kind === "camera") {
        const delay = cue.atHostTime + section.startMs - this.hostNow();
        if (delay < 0) { this.settleCue(cue.runId); return; } // a view claim never starts late
        const cameraTimer = setTimeout(() => {
          this.timers.delete(cameraTimer);
          if (this.disposed || generation !== this.generation || this.options.sceneId() !== cue.sceneId ||
              this.runEpoch.get(cue.runId) !== epoch || this.cameraTakenBack.has(cue.runId)) return;
          // A viewer who asked for less motion still needs to end up looking at the
          // right place: cut to it instead of panning, and skip a shake outright.
          if (this.prefs.reduceMotion) {
            this.noteDelivery(cue.runId, { index, kind: "camera",
              state: section.mode === "shake" ? "skipped" : "cut", reason: "reduced-motion" });
            // A pan or a path still has to end up looking at the right place; only a
            // shake is skipped outright.
            if (section.mode !== "shake") {
              this.options.stage.setCamera(cameraEnd(section, this.options.stage.camera,
                this.options.stage.viewport));
            }
            this.settleCue(cue.runId);
            return;
          }
          this.settleCue(cue.runId);
          this.beginCamera(cue, section, generation, epoch);
        }, delay);
        this.timers.set(cameraTimer, cue.runId);
        return;
      }
      const delay = cue.atHostTime + section.startMs - this.hostNow();
      if (!cue.persistent && delay + section.durationMs <= 0) {
        this.settleCue(cue.runId); // a stale replay is not a delivery failure
        return;
      }
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.disposed || generation !== this.generation || this.options.sceneId() !== cue.sceneId ||
            this.runEpoch.get(cue.runId) !== epoch) return;
        void this.play(cue, section, generation, epoch, index);
      }, Math.max(0, delay));
      this.timers.set(timer, cue.runId);
    });
    this.flushDelivery(cue.runId);
  }

  /** Fetch an asset early and remember only whether it landed (the bytes are the fetcher's). */
  /**
   * Does *this* browser refuse this format outright? `canPlayType` answers "" only for a
   * format it cannot play at all, which is worth acting on before spending a download on
   * it — a shell with no DOM claims no opinion and fetches as usual.
   */
  private undecodable(mime: string): boolean {
    return fxAssetFitness({ mime }, mime, this.canPlay) === "unsupported-codec";
  }

  /**
   * D-309: where this viewer hears from. Their own token is the honest answer — the
   * character they are playing stands somewhere on the map — and a viewer with nothing of
   * their own uses **the centre of their own view**: they are looking at the scene from
   * there, which is the only position a client can honestly name about itself.
   */
  private listener(): { x: number; y: number } | null {
    const sceneId = this.options.sceneId();
    const userId = this.options.client.user?.id;
    // A shell with no store (a preview, a test double, a client that has not loaded the
    // world yet) simply has no token to name — the view centre below still answers.
    const world = (this.options.client as { store?: { world: { scenes?: readonly unknown[] } } }).store;
    if (sceneId && world) {
      const scene = (world.world.scenes as Array<{ _id: string; tokens: Array<{ x: number; y: number;
        ownership?: Record<string, number> }> }> | undefined)?.find((entry) => entry._id === sceneId);
      const token = userId
        ? scene?.tokens.find((entry) => (entry.ownership?.[userId] ?? 0) >= 3) : undefined;
      if (token) return { x: token.x, y: token.y };
    }
    const camera = this.options.stage.camera;
    const viewport = this.options.stage.viewport;
    if (!camera || !viewport || !Number.isFinite(camera.scale) || camera.scale <= 0) return null;
    return { x: camera.x + viewport.width / (2 * camera.scale),
      y: camera.y + viewport.height / (2 * camera.scale) };
  }

  private async prefetch(assetId: string, mime: string, runId: string): Promise<void> {
    const generation = this.generation;
    const epoch = this.runEpoch.get(runId);
    let record = this.prefetched.get(assetId);
    // A fetch/decode failure is not a permanent property of the asset. The real fetcher
    // drops rejected memo entries so a later run can retry; mirror that lifecycle here.
    if (!record || record.failed || record.decodeFailed) {
      if (record) this.releasePrefetch(record);
      const fresh: FxPrefetchRecord = {
        done: false, failed: false, decodeFailed: false,
        work: Promise.resolve(), startedAt: Date.now(),
      };
      this.prefetched.set(assetId, fresh);
      fresh.work = (async () => {
        let bytes: Uint8Array;
        try {
          bytes = await this.options.fetchAsset(assetId);
          // Keep the receipt's established meaning: `ready` says the bytes arrived. Image
          // decode begins in the same continuation but has its own shared promise below.
          fresh.readyAtHost = this.hostNow();
          fresh.done = true;
        } catch {
          fresh.failed = true;
          return;
        }
        if (mime.startsWith("image/") && typeof Image !== "undefined") {
          fresh.decodeWork = (async () => {
            try {
              const blob = new Blob([new Uint8Array(bytes)], { type: mime });
              // A Blob URL dispatches image decode through a later browser task; under load
              // that can waste the whole lead window. Small sprites can safely take this
              // bounded synchronous conversion and begin decoding in the current task.
              const dataUrl = staticImageDataUrl(bytes, mime);
              const image = new Image();
              image.decoding = "sync";
              if (dataUrl) {
                image.src = dataUrl;
                try {
                  await image.decode();
                } catch {
                  // A browser/CSP that refuses data images still gets the portable path;
                  // only refusal of both sources becomes an unsupported decoder report.
                  fresh.objectUrl = URL.createObjectURL(blob);
                  image.src = fresh.objectUrl;
                  await image.decode();
                }
              } else {
                fresh.objectUrl = URL.createObjectURL(blob);
                image.src = fresh.objectUrl;
                await image.decode();
              }
              fresh.image = image;
              fresh.decodeReadyAtHost = this.hostNow();
            } catch (cause) {
              fresh.decodeFailed = true; // cue-time decode gets one honest retry/report
              fresh.decodeError = cause;
            }
          })();
        }
      })();
      record = fresh;
    }
    // The bytes are shared, but the answer belongs to EVERY waiting run. Capture the
    // run's answer before waiting: a cue-time decoder/startup result that settles first is
    // newer and must not be overwritten by this older byte-only continuation.
    const ackBeforeWork = this.mediaAcks.get(runId)?.get(assetId);
    await record.work;
    if (this.disposed || generation !== this.generation || this.runEpoch.get(runId) !== epoch) return;
    if (this.mediaAcks.get(runId)?.get(assetId) === ackBeforeWork) {
      if (record.done)
        this.ackMedia(runId, assetId, "ready", { ms: Math.max(0, Date.now() - record.startedAt) });
      else this.ackMedia(runId, assetId, "failed", { reason: "fetch" });
    }
    // D-308 keeps `ready` byte-scoped, but a decoder refusal is still a later, truer
    // answer. Every run sharing this record observes the same predecode settlement.
    if (!record.done || !record.decodeWork) return;
    await record.decodeWork;
    if (this.disposed || generation !== this.generation || this.runEpoch.get(runId) !== epoch ||
        this.prefetched.get(assetId) !== record || !record.decodeFailed) return;
    const unsupported = decoderUnsupported(record.decodeError);
    this.ackMedia(runId, assetId, unsupported ? "unsupported" : "failed",
      unsupported ? {} : { reason: "decode" });
  }

  /**
   * D-308 (SQ-13): tell the host what this viewer did with one asset of a run the host
   * sent. A local draft preview is not the table's business — it never left this client —
   * so a preview run says nothing. The *latest* state is what the host keeps (a fetch that
   * failed at cue start and succeeded when the section needed the bytes has the media), so
   * an unchanged answer is not repeated.
   */
  private ackMedia(runId: string, assetId: string, state: FxMediaAckState,
    extra: { reason?: "fetch" | "decode"; ms?: number } = {}): void {
    if (this.disposed || this.previewRuns.has(runId)) return;
    const sent = this.mediaAcks.get(runId) ?? new Map<string, FxMediaAckState>();
    if (sent.get(assetId) === state) return;
    sent.set(assetId, state);
    this.mediaAcks.set(runId, sent);
    this.options.client.reportFxMedia({ runId, assetId, state, ...extra });
  }

  /** Record a delivery outcome; the report waits for the run's last media cue. */
  private noteDelivery(runId: string, entry: FxDeliveryEntry): void {
    const run = this.delivery.get(runId);
    if (!run || run.reported) return;
    run.entries.push(entry);
  }

  /** One cue is settled — when the last one is, the viewer hears how it went. */
  private settleCue(runId: string): void {
    const run = this.delivery.get(runId);
    if (run && !run.reported) run.pending = Math.max(0, run.pending - 1);
    this.flushDelivery(runId);
  }

  /**
   * Emit the run's report **once**, when nothing is still outstanding. A timeline
   * whose media all arrived early says nothing at all: the right amount of news for
   * an effect that worked is none.
   */
  private flushDelivery(runId: string): void {
    const run = this.delivery.get(runId);
    if (!run || run.reported || run.pending > 0) return;
    run.reported = true;
    const summary = summarizeDelivery(run.entries,
      this.options.macroName?.(run.macroId) ?? "FX timeline");
    this.delivery.delete(runId);
    if (summary && this.options.onDelivery) {
      this.options.onDelivery({ runId, sceneId: this.scene ?? "", entries: run.entries,
        level: summary.level, message: summary.message });
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
    // Finished. A shake hands the view back exactly as it found it; a pan leaves the
    // view on its destination and a path on its last waypoint — the whole point of both.
    this.view = null;
    this.options.stage.setCamera(cameraEnd(claimed.section, claimed.base, viewport));
  }

  /** Release a camera claim; `restore` puts the view back where the section found it. */
  private releaseCamera(restore: boolean): void {
    const claimed = this.view;
    if (!claimed) return;
    this.view = null;
    if (restore) this.options.stage.setCamera(claimed.base);
  }

  private async play(cue: FxStartMsg, section: Exclude<ResolvedFxSection, { kind: "wait" }>,
    generation: number, epoch: number, index = -1): Promise<void> {
    const elapsed = () => Math.max(0, this.hostNow() - cue.atHostTime - section.startMs);
    const active = () => !this.disposed && generation === this.generation &&
      this.runEpoch.get(cue.runId) === epoch && this.options.sceneId() === cue.sceneId;
    const skipExpired = (mediaLateMs: number): boolean => {
      if (cue.persistent || elapsed() < section.durationMs) return false;
      if (section.kind === "image" || section.kind === "sound") {
        // Expiry and media readiness are separate facts. If the bytes arrived on time but
        // the browser serviced this timer after the whole section, the run is stale but the
        // media was not late; preserve the earlier ready acknowledgement.
        if (mediaLateMs > LATE_TOLERANCE_MS) {
          const lateMs = Math.round(mediaLateMs);
          this.noteDelivery(cue.runId, { index, kind: section.kind, state: "skipped",
            reason: "not-ready", assetId: section.assetId, lateMs });
          this.ackMedia(cue.runId, section.assetId, "late", { ms: lateMs });
        }
        this.settleCue(cue.runId);
      }
      return true;
    };
    if (section.kind === "camera") return; // animated per frame by tickCamera
    if (section.kind === "text") {
      if (active()) this.options.stage.getFxLayer().spawn(cue.runId, section, elapsed(), undefined, undefined,
        cue.persistent === true);
      return;
    }
    if (section.kind === "sound" && !this.audible(section)) {
      // Local choice, local effect: the rest of the timeline still plays, and no
      // bytes are fetched for a sound this viewer asked not to hear.
      this.noteDelivery(cue.runId, { index, kind: "sound", state: "skipped", reason: "muted",
        assetId: section.assetId });
      this.settleCue(cue.runId);
      return;
    }
    if (this.undecodable(section.mime)) {
      // No point downloading a format this browser already refused: the viewer is told
      // why, the host was told at cue start, and the rest of the timeline plays on.
      this.noteDelivery(cue.runId, { index, kind: section.kind, state: "failed",
        assetId: section.assetId, reason: "unsupported-codec" });
      this.settleCue(cue.runId);
      return;
    }
    // Readiness is a *pre-cue* fact: did the preload (or the cache) already land?
    // Asking after a fetch would always answer "yes" and hide the slow client SQ-13
    // is about.
    const preload = this.prefetched.get(section.assetId);
    const landed = preload?.done === true;
    const decodedAtDispatch = preload?.image !== undefined;
    const scheduledFor = cue.atHostTime + section.startMs;
    const fetchStarted = this.hostNow();
    try {
      const bytes = await this.options.fetchAsset(section.assetId);
      // Measure the thing the delivery report names: when the bytes became available.
      // A timer or promise continuation may wake much later without making cached media late.
      const readyAtHost = preload?.readyAtHost ?? this.hostNow();
      // Attribute only delay that media adds after the browser gets an opportunity to run
      // this cue. A throttled event loop can service the preload continuation and an overdue
      // section timer in the same turn; when the preload won that race (`landed`), it did not
      // hold playback back. The host's own source bytes are local too: reading them through
      // its client loopback is an implementation hop, not a failed audience delivery. If a
      // remote viewer still lacks bytes when its timer runs, the subsequent wait remains
      // genuine media lateness.
      const locallyOwned = this.options.isAssetLocal?.(section.assetId) === true;
      const mediaLateMs = landed || locallyOwned ? 0
        : Math.max(0, readyAtHost - Math.max(scheduledFor, fetchStarted));
      /** Apply this viewer's strict-sync choice to media that was not usable in time. */
      const skipLate = (lateMs: number): boolean => {
        if (lateMs <= LATE_TOLERANCE_MS) return false;
        const decision = lateMediaDecision(this.prefs.lateMedia, lateMs);
        if (decision.start) return false;
        this.noteDelivery(cue.runId, { index, kind: section.kind, state: "skipped",
          reason: decision.reason, assetId: section.assetId, lateMs });
        this.ackMedia(cue.runId, section.assetId, "late", { ms: Math.round(lateMs) });
        this.settleCue(cue.runId);
        return true;
      };
      /** Record success only once the browser can actually use the decoded media. */
      const reportUsable = (lateMs: number): void => {
        const late = lateMs > LATE_TOLERANCE_MS;
        this.noteDelivery(cue.runId, { index, kind: section.kind, assetId: section.assetId,
          state: late ? "late" : "ready",
          ...(late ? { reason: "not-ready" as const, lateMs }
            : landed ? { reason: "preload" as const } : {}) });
        if (late) this.ackMedia(cue.runId, section.assetId, "late", { ms: Math.round(lateMs) });
        else this.ackMedia(cue.runId, section.assetId, "ready",
          { ms: Math.max(0, Math.round(readyAtHost - fetchStarted)) });
      };
      // Cancellation belongs to this invocation, not only to the run's reusable ID.
      // Check before *any* late/failure reporting can touch a replacement run. Bytes that
      // are already late can honor strict sync without spending another decode.
      if (!active() || skipExpired(mediaLateMs) || skipLate(mediaLateMs)) return;
      const decoderStartedAt = this.hostNow();
      // `mediaLateMs` is the fetch contribution. Add only decoder/startup time that extends
      // past cue dispatch; a delayed section timer itself remains excluded. Static-image
      // predecode starts in the lead window, so only any unfinished tail is awaited here.
      const usableLateMs = (): number => mediaLateMs +
        Math.max(0, this.hostNow() - decoderStartedAt);
      const staticImage = section.kind === "image" && section.mime.startsWith("image/");
      let staticImageLateMs: number | undefined;
      /**
       * A decoded source that existed when the cue callback got its turn added no media
       * wait, even if the browser/OS later pauses synchronous Pixi setup. If playback had
       * to await predecode, add only the decoder tail after both bytes and callback were
       * available; fetch and decode are sequential, so this composes without double count.
       */
      const predecodeLateMs = (): number => decodedAtDispatch ? mediaLateMs : mediaLateMs +
        Math.max(0, (preload?.decodeReadyAtHost ?? this.hostNow()) -
          Math.max(scheduledFor, fetchStarted, preload?.readyAtHost ?? fetchStarted));
      if (staticImage && preload?.decodeWork && !preload.image && !preload.decodeFailed) {
        await preload.decodeWork;
        if (!active()) return;
        // A failed predecode gets the established cue-time retry below. Do not relabel a
        // known decoder refusal as mere lateness before that retry can recover or report it.
        if (!preload.decodeFailed) {
          staticImageLateMs = predecodeLateMs();
          if (skipExpired(staticImageLateMs) || skipLate(staticImageLateMs)) return;
        }
      }
      const warmedImage = staticImage ? preload?.image : undefined;
      if (warmedImage && staticImageLateMs === undefined) staticImageLateMs = predecodeLateMs();
      // A retained decoded source needs no second blob URL. Audio, video and lazy/static
      // fallback paths own a cue-local URL that is revoked with their playback resource.
      const ownsUrl = !warmedImage;
      const url = ownsUrl
        ? URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: section.mime })) : "";
      const revokeUrl = () => { if (ownsUrl) URL.revokeObjectURL(url); };
      if (section.kind === "sound") {
        const channel = soundChannelOf(section);
        const audio = new Audio(url);
        // D-309: pan and muffle are the two things an element cannot do; a device that
        // cannot do them plays everything else and *says* so (once, in this viewer's own
        // report) rather than pretending the author's placement took effect.
        const wants = soundNeedsGraph(section);
        const spatialNodes: SpatialAudioNodes | null = wants ? attachSpatialAudio(audio) : null;
        const spatialReduced = wants && !spatialNodes;
        // Starting the element is asynchronous too. Do not settle before play() can
        // reject; otherwise the local report has already forgotten this section.
        let settled = false;
        const settle = () => {
          if (settled || !active()) return;
          settled = true;
          this.settleCue(cue.runId);
        };
        // The gain is recomputed on a timer rather than set once, because a fade is a
        // curve and a viewer may move a channel fader while the cue is playing. Both
        // facts are local: the timeline never learns that this device changed its mix.
        // Distance is measured afresh on every tick, so a viewer who walks their token or
        // pans their camera hears the sound approach (and a wall that opens between them
        // stops muffling it — the host resolved that at emit, so it is fixed for this cue).
        const applyGain = (): number => {
          const fade = soundFadeGain({ elapsedMs: elapsed(), durationMs: section.durationMs,
            ...(section.fadeInMs !== undefined ? { fadeInMs: section.fadeInMs } : {}),
            ...(section.fadeOutMs !== undefined ? { fadeOutMs: section.fadeOutMs } : {}),
            loop: cue.persistent === true });
          const spatial: SoundSpatial = soundSpatial(section, this.listener());
          const gain = soundGain({ ...(section.volume !== undefined ? { volume: section.volume } : {}),
            channel, mix: this.prefs.soundMix, fade }) * spatial.gain;
          audio.volume = gain;
          setFxSoundGain(soundId, gain);
          // The device list says what this device is *actually* playing: a shell that could
          // not build the graph plays centred and open, so claiming the author's pan or a
          // wall's muffle there would be showing a control that did nothing (its own report
          // is where the reduction is stated honestly).
          const heard = spatialNodes ? { pan: spatial.pan, muffled: spatial.muffled }
            : { pan: 0, muffled: false };
          spatialNodes?.setPan(heard.pan);
          spatialNodes?.setMuffled(heard.muffled);
          setFxSoundSpatial(soundId, heard);
          return gain;
        };
        // The epoch is part of the key: a run that restarts (or reuses its ID after a
        // stop) is a different element, and its row must not be mistaken for this one's.
        const soundId = `${cue.runId}:${index}:${epoch}`;
        // Keep startup silent until `play()` proves the decoder can begin and the late-media
        // policy has had its say. A strict-sync viewer must not hear a blip from a cue that
        // is discarded because startup itself was late.
        const playbackRate = section.playbackRate ?? 1;
        const hasClip = section.clipStartMs !== undefined || section.clipEndMs !== undefined;
        audio.volume = 0;
        audio.playbackRate = playbackRate;
        // Native looping always returns to source time zero. A clipped persistent sound
        // instead wraps explicitly to the authored start below.
        audio.loop = cue.persistent === true && !hasClip;
        let clip: FxMediaClipWindow | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let clipEndTimer: ReturnType<typeof setTimeout> | null = null;
        let clipWatch: ReturnType<typeof setInterval> | null = null;
        let ramp: ReturnType<typeof setInterval> | null = null;
        let unregister: (() => void) | null = null;
        let stopped = false;
        const stop = (settleStopped = true) => {
          if (stopped) return;
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          if (clipEndTimer !== null) clearTimeout(clipEndTimer);
          if (clipWatch !== null) clearInterval(clipWatch);
          if (ramp !== null) clearInterval(ramp);
          audio.onended = null;
          audio.ontimeupdate = null;
          audio.pause();
          audio.src = "";
          revokeUrl();
          spatialNodes?.dispose();
          unregister?.();
          const stops = this.stopAudio.get(cue.runId);
          stops?.delete(stop);
          if (stops?.size === 0) this.stopAudio.delete(cue.runId);
          if (settleStopped) settle(); // local stop/expiry must not strand a pending play
        };
        const stops = this.stopAudio.get(cue.runId) ?? new Set<() => void>();
        stops.add(stop);
        this.stopAudio.set(cue.runId, stops);
        if (!cue.persistent) timer = setTimeout(() => {
          if (stopped) return;
          if (!settled && active() && !skipExpired(usableLateMs())) settle();
          stop(false);
        }, Math.max(0, section.durationMs - elapsed()));
        // Register the silent, pending element too: "Stop here" must be able to interrupt
        // a decoder/autoplay promise rather than waiting for it to become audible first.
        unregister = registerFxSound({ id: soundId, runId: cue.runId, index, channel,
          name: this.options.assetName?.(section.assetId) ?? null,
          gain: 0, persistent: cue.persistent === true, startedAt: Date.now(), stop });
        try {
          const knownDuration = Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration : null;
          const mediaElapsed = (elapsed() / 1000) * playbackRate;
          if (hasClip && knownDuration !== null) {
            clip = fxMediaClipWindow(section, knownDuration);
            if (clip) {
              const sourceTime = cue.persistent
                ? fxLoopedClipTime(clip, mediaElapsed) : clip.start + mediaElapsed;
              // An already-exhausted one-shot still starts silently so browser startup is
              // honestly accounted, but never seeks past EOF or leaks a beginning blip.
              audio.currentTime = sourceTime < clip.end ? sourceTime : clip.start;
            }
          } else if (!hasClip) {
            const duration = knownDuration ?? section.durationMs / 1_000;
            audio.currentTime = cue.persistent ? mediaElapsed % duration : mediaElapsed;
          }
          await audio.play();
          // Some browsers do not expose duration until `play()` has started. Startup stays
          // silent, then the source is sought before gain is applied.
          if (hasClip && !clip) clip = fxMediaClipWindow(section, audio.duration);
        } catch (err) {
          const report = active() && !stopped;
          stop(false); // genuine failure is settled by the outer failure-report path
          if (report) throw err;
          return; // interruption after host/device stop is not a playback failure
        }
        if (!active() || stopped) { stop(); return; }
        const lateMs = usableLateMs();
        if (skipExpired(lateMs) || skipLate(lateMs)) { stop(false); return; }
        if (clip) {
          const sourceTime = clip.start + (elapsed() / 1_000) * playbackRate;
          if (!cue.persistent && sourceTime >= clip.end) {
            // The clipped one-shot elapsed while startup was pending. It is expected to be
            // silent now, but startup/lateness was still measured and reported honestly.
            reportUsable(lateMs);
            stop(false);
            settle();
            return;
          }
          const window = clip;
          audio.currentTime = cue.persistent
            ? fxLoopedClipTime(window, (elapsed() / 1_000) * playbackRate) : sourceTime;
          if (cue.persistent) {
            const rewind = () => {
              if (stopped || !active()) { stop(); return; }
              const current = audio.currentTime;
              if (current >= window.end || current < window.start - 0.02) {
                const overflow = current >= window.end ? current - window.end : 0;
                audio.currentTime = window.start + overflow % window.span;
              }
            };
            audio.ontimeupdate = rewind;
            audio.onended = () => {
              if (stopped || !active()) { stop(); return; }
              audio.currentTime = window.start;
              void audio.play().catch(() => stop());
            };
            clipWatch = setInterval(rewind, 40);
          } else {
            const stopAtEnd = () => {
              if (stopped || !active()) { stop(); return; }
              if (audio.currentTime >= window.end - 0.01) { stop(); return; }
              const remainingMs = ((window.end - audio.currentTime) / playbackRate) * 1_000;
              clipEndTimer = setTimeout(stopAtEnd, Math.max(10, remainingMs));
            };
            audio.ontimeupdate = () => {
              if (audio.currentTime >= window.end - 0.01) stop();
            };
            audio.onended = () => stop();
            stopAtEnd();
          }
        } else audio.onended = () => stop();
        reportUsable(lateMs);
        if (spatialReduced) {
          this.noteDelivery(cue.runId, { index, kind: "sound", state: "reduced",
            reason: "spatial-unavailable", assetId: section.assetId });
        }
        // The decoder has started and policy kept the cue: only now make it audible. The
        // already-registered pending row is updated to the gain this device applies.
        applyGain();
        // A fade needs a fast ramp; a *positioned* sound needs a tick for as long as it
        // plays, because the listener can walk (or pan the view) while it sounds. A plain
        // global sound with no fade is set once and left alone — nothing about it changes.
        const fading = (section.fadeInMs ?? 0) > 0 || (section.fadeOutMs ?? 0) > 0;
        if (fading || section.radiusPx !== undefined) {
          const everyMs = fading ? 40 : 100;
          ramp = setInterval(() => { if (stopped || !active()) stop(); else applyGain(); }, everyMs);
        }
        settle();
        return;
      }
      // Decode is still pending: settling here would discard a later local failure report.
      let texture: Texture;
      let video: HTMLVideoElement | null = null;
      let clearVideoClip: (() => void) | null = null;
      try {
        if (section.mime.startsWith("video/")) {
          video = document.createElement("video");
          video.muted = true; // sound is an explicit sound section, not an autoplay side effect
          video.playsInline = true;
          video.playbackRate = section.playbackRate ?? 1;
          video.src = url;
          await new Promise<void>((resolve, reject) => {
            if (!video) return reject(new Error("video released"));
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error("video format unsupported"));
          });
          video.onloadeddata = null;
          video.onerror = null;
          const loadedLateMs = usableLateMs();
          if (!active() || skipExpired(loadedLateMs) || skipLate(loadedLateMs)) {
            video.pause();
            revokeUrl();
            return;
          }
          const clip = fxMediaClipWindow(section, video.duration);
          // An unclipped video keeps the browser's native whole-source loop. A clip loops
          // explicitly to its own start for both one-shot and persistent timeline sections.
          video.loop = clip === null;
          const seconds = (elapsed() / 1_000) * (section.playbackRate ?? 1);
          video.currentTime = clip ? fxLoopedClipTime(clip, seconds)
            : cue.persistent && Number.isFinite(video.duration) && video.duration > 0
              ? seconds % video.duration : seconds;
          await video.play();
          if (clip) {
            const rewind = () => {
              if (!video || !active()) return;
              const current = video.currentTime;
              if (current >= clip.end || current < clip.start - 0.02) {
                const overflow = current >= clip.end ? current - clip.end : 0;
                video.currentTime = clip.start + overflow % clip.span;
              }
            };
            const watch = setInterval(rewind, 40);
            video.ontimeupdate = rewind;
            video.onended = () => {
              if (!video || !active()) return;
              video.currentTime = clip.start;
              void video.play().catch(() => undefined);
            };
            clearVideoClip = () => {
              clearInterval(watch);
              if (!video) return;
              video.ontimeupdate = null;
              video.onended = null;
            };
          }
          texture = Texture.from(video);
        } else {
          let image: HTMLImageElement;
          if (warmedImage) image = warmedImage;
          else {
            const freshImage = new Image();
            freshImage.decoding = "sync";
            freshImage.src = url;
            await freshImage.decode();
            image = freshImage;
            // Capture actual decoder settlement before synchronous texture construction.
            // A browser/OS scheduler pause in `Texture.from` is not media startup delay.
            staticImageLateMs = usableLateMs();
          }
          // Each layer owns its own texture lifetime even when runs share the decoded source.
          // Skipping Pixi's source cache prevents one run's destroy from invalidating an
          // overlapping run (or the retained predecode record).
          texture = Texture.from(image, true);
        }
        const lateMs = staticImageLateMs ?? usableLateMs();
        if (!active() || skipExpired(lateMs) || skipLate(lateMs)) {
          clearVideoClip?.();
          video?.pause();
          texture.destroy(true);
          revokeUrl();
          return;
        }
        reportUsable(lateMs);
        const media = video;
        const releaseClip = clearVideoClip;
        this.options.stage.getFxLayer().spawn(cue.runId, section, elapsed(), texture, () => {
          releaseClip?.();
          media?.pause();
          texture.destroy(true);
          revokeUrl();
        }, cue.persistent === true);
        this.settleCue(cue.runId);
      } catch (err) {
        clearVideoClip?.();
        video?.pause();
        revokeUrl();
        throw err;
      }
    } catch (err) {
      if (!active()) return; // a dead fetch/decode must not report into a reused run ID
      const detail = String(err);
      const unsupported = decoderUnsupported(err);
      this.noteDelivery(cue.runId, { index, kind: section.kind, state: "failed", assetId: section.assetId,
        reason: unsupported ? "unsupported-codec" : "error", detail });
      // D-308: the bytes arrived and this browser could not use them — the one case the
      // GM can still act on, so it is reported as its own state rather than as silence.
      this.ackMedia(cue.runId, section.assetId, unsupported ? "unsupported" : "failed",
        unsupported ? {} : { reason: "decode" });
      this.settleCue(cue.runId); // one failure is not a reason to keep the run "pending"
      this.options.onError?.(`FX ${section.kind} failed: ${detail}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.offEnd();
    this.offWelcome();
    this.offFrame();
    this.offPrefs();
    this.clearLocal();
  }
}
