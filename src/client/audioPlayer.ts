/**
 * §7 client audio player — turns scheduled `audio.cmd` broadcasts into
 * WebAudio playback on the synchronized clock. Bytes resolve from the sound's
 * `audio` reference: data:/http(s) URLs fetch directly (§7 external URLs),
 * anything else is an asset hash handled by the injected fetcher.
 *
 * Testability: the AudioContext, timers and clock are injectable; the player
 * records per-sound state so e2e can assert scheduling without speakers.
 */
import type { AudioCmdMsg } from "../core/messages";
import type { ClientSync } from "./sync";
import type { ClientEvents } from "./sync";
import type { EventBus } from "../core/events";
import { scheduleDelayMs } from "../core/audio";

export type SoundState = "loading" | "playing" | "suspended" | "stopped" | "error";

export interface AudioPlayerOptions {
  client: ClientSync;
  bus: EventBus<ClientEvents>;
  /** Asset-hash sounds → bytes (GM passes HostApp.gm.fetcher.request). */
  fetchAsset?: (hash: string) => Promise<Uint8Array>;
  /** Clock (defaults to Date.now). */
  now?: () => number;
  /** Timer (defaults to setTimeout; tests use immediate/controllable ones). */
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (id: number) => void;
}

interface ActiveSound {
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  buffer: AudioBuffer | null;
  startedAt: number; // ctx.currentTime of last start
  startOffset: number; // seconds into the buffer
  state: SoundState;
}

export class AudioPlayer {
  private readonly client: ClientSync;
  private ctx: AudioContext | null = null; // lazy: built on first playback (autoplay policy)
  private readonly active = new Map<string, ActiveSound>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly timers = new Map<string, number>();
  private readonly fetchAsset: (hash: string) => Promise<Uint8Array>;
  private readonly off: () => void;
  /** Last scheduled delay per sound (e2e/diagnostics). */
  readonly lastDelays = new Map<string, number>();

  constructor(options: AudioPlayerOptions) {
    this.client = options.client;
    // Asset-hash sounds need an injected fetcher (GM: HostApp.gm.fetcher).
    this.fetchAsset =
      options.fetchAsset ?? ((hash) => Promise.reject(new Error(`no asset fetcher for ${hash}`)));
    this.off = options.bus.on("audio", (msg) => void this.onCommand(msg));
  }

  /** Current per-sound states (UI/e2e). */
  states(): Array<{ soundId: string; state: SoundState }> {
    return [...this.active.entries()].map(([soundId, a]) => ({ soundId, state: a.state }));
  }

  state(soundId: string): SoundState | null {
    return this.active.get(soundId)?.state ?? null;
  }

  private readonly timerFns = {
    set: (fn: () => void, ms: number): number => setTimeout(fn, ms) as unknown as number,
    clear: (id: number): void => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
  };

  private setTimeoutFn(fn: () => void, ms: number): number {
    return this.timerFns.set(fn, ms);
  }

  private cancelTimer(id: number): void {
    this.timerFns.clear(id);
  }

  dispose(): void {
    this.off();
    for (const id of this.timers.values()) this.cancelTimer(id);
    this.timers.clear();
    for (const sound of this.active.values()) sound.source?.stop();
    this.active.clear();
    void this.ctx?.close();
  }

  private async onCommand(msg: AudioCmdMsg): Promise<void> {
    if (msg.action === "stop") return this.stop(msg.soundId);
    if (msg.action === "pause") return this.pause(msg.soundId);
    // play / resume
    const offset =
      msg.action === "resume"
        ? (this.active.get(msg.soundId)?.startOffset ?? msg.offset)
        : msg.offset;
    const estimate = this.client.clockOffset();
    const offsetMs = estimate?.offsetMs ?? 0; // unsynced best effort: assume 0
    let delay = 0;
    if (typeof msg.atHostTime === "number") {
      delay = Math.max(0, scheduleDelayMs(Date.now(), offsetMs, msg.atHostTime));
      this.lastDelays.set(msg.soundId, delay);
    }
    const audioRef = this.audioRefOf(msg.playlistId, msg.soundId);
    const timer = this.setTimeoutFn(() => void this.start(msg.soundId, audioRef, offset), delay);
    const prev = this.timers.get(msg.soundId);
    if (prev !== undefined) this.cancelTimer(prev);
    this.timers.set(msg.soundId, timer);
  }

  /** Resolve a sound's `audio` reference (URL or asset hash) from the store. */
  private audioRefOf(playlistId: string, soundId: string): string {
    const playlists = this.client.store.getAll("playlists") as ReadonlyArray<{
      _id: string;
      sounds: ReadonlyArray<{ _id: string; audio: string }>;
    }>;
    const playlist = playlists.find((p) => p._id === playlistId);
    return playlist?.sounds.find((s) => s._id === soundId)?.audio ?? "";
  }

  /** Build the AudioContext lazily — constructing one at boot with no gesture
   *  freezes rAF-driven actionability in headless browsers (and autoplay
   *  policy suspends it anyway until a gesture). */
  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }

  private async start(soundId: string, audioRef: string, offsetSeconds: number): Promise<void> {
    let sound = this.active.get(soundId);
    if (!sound) {
      sound = {
        source: null,
        gain: null,
        buffer: null,
        startedAt: 0,
        startOffset: offsetSeconds,
        state: "loading",
      };
      this.active.set(soundId, sound);
    }
    sound.startOffset = offsetSeconds;
    try {
      const buffer = await this.load(audioRef);
      sound.buffer = buffer;
      const ctx = this.ensureCtx();
      if (!ctx) {
        sound.state = "suspended"; // no WebAudio (tests/ssr) — scheduled but silent
        return;
      }
      if (ctx.state === "suspended") {
        // Autoplay policy: fire-and-forget resume; state reflects the attempt.
        void ctx.resume().catch(() => undefined);
      }
      sound.source?.stop();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      source.connect(gain).connect(ctx.destination);
      source.start(0, Math.max(0, offsetSeconds));
      sound.source = source;
      sound.gain = gain;
      sound.startedAt = ctx.currentTime;
      sound.state = ctx.state === "running" ? "playing" : "suspended";
      source.onended = () => {
        if (this.active.get(soundId)?.source === source) {
          sound.state = "stopped";
        }
      };
    } catch {
      sound.state = "error";
    }
  }

  private async load(audioRef: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(audioRef);
    if (cached) return cached;
    const ctx = this.ensureCtx();
    if (!ctx) throw new Error("no audio context");
    let bytes: Uint8Array;
    if (audioRef.startsWith("data:") || /^https?:/.test(audioRef)) {
      bytes = new Uint8Array(await (await fetch(audioRef)).arrayBuffer());
    } else {
      bytes = await this.fetchAsset(audioRef);
    }
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const buffer = await ctx.decodeAudioData(copy);
    this.buffers.set(audioRef, buffer);
    return buffer;
  }

  private stop(soundId: string): void {
    const timer = this.timers.get(soundId);
    if (timer !== undefined) {
      this.cancelTimer(timer);
      this.timers.delete(soundId);
    }
    const sound = this.active.get(soundId);
    if (!sound) return;
    sound.source?.stop();
    sound.source = null;
    sound.state = "stopped";
  }

  private pause(soundId: string): void {
    const sound = this.active.get(soundId);
    if (!sound || !sound.source || !this.ctx) return;
    sound.startOffset = Math.max(0, sound.startOffset + (this.ctx.currentTime - sound.startedAt));
    sound.source.stop();
    sound.source = null;
    sound.state = "stopped"; // paused == stopped with a resume offset
  }
}
