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

export interface FxPlayerOptions {
  client: ClientSync;
  bus: EventBus<ClientEvents>;
  stage: Stage;
  fetchAsset: (hash: string) => Promise<Uint8Array>;
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
  /** Assets this run asked for ahead of time; `done` is the readiness signal at cue time. */
  private readonly prefetched = new Map<string, { done: boolean; failed: boolean }>();
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
    this.prefetched.clear(); // a stopped run's warm promises are its own
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
        this.ackMedia(cue.runId, item.assetId, "ready"); // already in hand: no fetch to time
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
      const start = () => { void this.prefetch(plan.assetId, cue.runId); };
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

  private async prefetch(assetId: string, runId: string): Promise<void> {
    if (this.prefetched.has(assetId)) return;
    const record = { done: false, failed: false };
    this.prefetched.set(assetId, record);
    const startedAt = Date.now();
    try {
      await this.options.fetchAsset(assetId);
      record.done = true;
      // SQ-13's "progress" half: the requester learns not only *that* everyone has the
      // bytes but how long the slowest fetch took.
      this.ackMedia(runId, assetId, "ready", { ms: Math.max(0, Date.now() - startedAt) });
    } catch {
      record.failed = true; // the section still reports its own failure when it plays
      this.ackMedia(runId, assetId, "failed", { reason: "fetch" });
    }
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
    const landed = this.prefetched.get(section.assetId)?.done === true;
    const scheduledFor = cue.atHostTime + section.startMs;
    const fetchStarted = this.hostNow();
    try {
      const bytes = await this.options.fetchAsset(section.assetId);
      const lateMs = this.hostNow() - scheduledFor;
      if (lateMs > LATE_TOLERANCE_MS) {
        const decision = lateMediaDecision(this.prefs.lateMedia, lateMs);
        if (!decision.start) {
          this.noteDelivery(cue.runId, { index, kind: section.kind, state: "skipped",
            reason: decision.reason, assetId: section.assetId, lateMs });
          // D-308: the bytes are here, they just missed the cue — the requester needs
          // exactly that sentence, not silence, because it is the timeline's own timing
          // that was wrong rather than this viewer's connection.
          this.ackMedia(cue.runId, section.assetId, "late", { ms: Math.round(lateMs) });
          this.settleCue(cue.runId);
          return;
        }
      }
      if (!active() || !cue.persistent && elapsed() >= section.durationMs) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: section.mime }));
      const arrivedMs = this.hostNow() - scheduledFor;
      const late = arrivedMs > LATE_TOLERANCE_MS;
      this.noteDelivery(cue.runId, { index, kind: section.kind, assetId: section.assetId,
        state: late ? "late" : "ready",
        ...(late ? { reason: "not-ready" as const, lateMs: arrivedMs }
          : landed ? { reason: "preload" as const } : {}) });
      // D-308: this viewer's word — late by how much, or (when nothing was preloaded and
      // nothing has been said yet) simply that the bytes were in hand when they were
      // needed, with the fetch it took to get them.
      if (late) this.ackMedia(cue.runId, section.assetId, "late", { ms: Math.round(arrivedMs) });
      else if (this.mediaAcks.get(cue.runId)?.get(section.assetId) === undefined)
        this.ackMedia(cue.runId, section.assetId, "ready",
          { ms: Math.max(0, Math.round(this.hostNow() - fetchStarted)) });
      if (section.kind === "sound") {
        const channel = soundChannelOf(section);
        const audio = new Audio(url);
        audio.loop = cue.persistent === true;
        const startedAt = Date.now();
        // D-309: pan and muffle are the two things an element cannot do; a device that
        // cannot do them plays everything else and *says* so (once, in this viewer's own
        // report) rather than pretending the author's placement took effect.
        const wants = soundNeedsGraph(section);
        const spatialNodes: SpatialAudioNodes | null = wants ? attachSpatialAudio(audio) : null;
        if (wants && !spatialNodes) {
          this.noteDelivery(cue.runId, { index, kind: "sound", state: "reduced",
            reason: "spatial-unavailable", assetId: section.assetId });
        }
        // A run settles only once this viewer knows everything it will report — which
        // includes whether its device could honour the author's placement at all. A note
        // written after the report has gone out would never be sent.
        this.settleCue(cue.runId);
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
        applyGain();
        const duration = Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration : section.durationMs / 1000;
        audio.currentTime = cue.persistent ? (elapsed() / 1000) % duration : elapsed() / 1000;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let ramp: ReturnType<typeof setInterval> | null = null;
        let unregister: (() => void) | null = null;
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          if (ramp !== null) clearInterval(ramp);
          audio.pause();
          audio.src = "";
          URL.revokeObjectURL(url);
          spatialNodes?.dispose();
          unregister?.();
          const stops = this.stopAudio.get(cue.runId);
          stops?.delete(stop);
          if (stops?.size === 0) this.stopAudio.delete(cue.runId);
        };
        const stops = this.stopAudio.get(cue.runId) ?? new Set<() => void>();
        stops.add(stop);
        this.stopAudio.set(cue.runId, stops);
        audio.onended = stop;
        // A fade needs a fast ramp; a *positioned* sound needs a tick for as long as it
        // plays, because the listener can walk (or pan the view) while it sounds. A plain
        // global sound with no fade is set once and left alone — nothing about it changes.
        const fading = (section.fadeInMs ?? 0) > 0 || (section.fadeOutMs ?? 0) > 0;
        if (fading || section.radiusPx !== undefined) {
          const everyMs = fading ? 40 : 100;
          ramp = setInterval(() => { if (stopped || !active()) stop(); else applyGain(); }, everyMs);
        }
        if (!cue.persistent) timer = setTimeout(stop, Math.max(0, section.durationMs - elapsed()));
        // The device-local list: this element exists here and now, whoever else may
        // also be hearing the timeline. Stopping from that list silences this device.
        unregister = registerFxSound({ id: soundId, runId: cue.runId, index, channel,
          name: this.options.assetName?.(section.assetId) ?? null,
          gain: audio.volume, persistent: cue.persistent === true, startedAt, stop });
        void audio.play().catch((err: unknown) => {
          this.options.onError?.(`FX audio unavailable: ${String(err)}`);
          stop();
        });
        return;
      }
      this.settleCue(cue.runId);
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
      const detail = String(err);
      const unsupported = /unsupported|format|decode|not supported/i.test(detail);
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
