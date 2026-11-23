/**
 * Procedural Strategic Battle Spatial Audio Synthesizer.
 *
 * Plays planned `PlannedAudioFxVoice` cues produced by `planStrategicViewportFx(...)`
 * through a single shared Web Audio `DynamicsCompressorNode` limiter bus so mass battles
 * with hundreds of simultaneous spells and 20,000+ melee/ranged events NEVER clip speakers,
 * exceed `DEFAULT_MAX_SOUND_VOICES` polyphony, or leak audio outside the viewer's viewport.
 *
 * Gracefully degrades to a silent no-op in headless/non-WebAudio environments.
 */
import type { PlannedAudioFxVoice } from "../core/strategicRoom/strategicFx";

export class StrategicFxSynth {
  private ctx: AudioContext | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private failed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private ensureBus(): { ctx: AudioContext; out: AudioNode; noise: AudioBuffer } | null {
    if (this.failed) return null;
    if (!this.ctx) {
      const ctor = (
        globalThis as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        }
      ).AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!ctor) {
        this.failed = true;
        return null;
      }
      try {
        this.ctx = new ctor();
      } catch {
        this.failed = true;
        return null;
      }
    }
    const ctx = this.ctx;
    try {
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    } catch {
      /* gesture-gated */
    }
    if (!this.compressor) {
      try {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 18;
        comp.ratio.value = 8;
        comp.attack.value = 0.003;
        comp.release.value = 0.18;
        comp.connect(ctx.destination);
        this.compressor = comp;
      } catch {
        this.failed = true;
        return null;
      }
    }
    if (!this.noiseBuffer) {
      const len = Math.max(1024, Math.floor(ctx.sampleRate * 0.65));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      let seed = 0x9e3779b9;
      for (let i = 0; i < len; i++) {
        seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x85ebca6b) >>> 0;
        ch[i] = (seed / 0xffffffff) * 2 - 1;
      }
      this.noiseBuffer = buf;
    }
    return { ctx, out: this.compressor, noise: this.noiseBuffer };
  }

  /** Schedule a bounded batch of viewport-culled, spatially deduplicated voices. */
  playVoices(voices: readonly PlannedAudioFxVoice[]): number {
    if (voices.length === 0) return 0;
    const bus = this.ensureBus();
    if (!bus) return 0;
    let scheduled = 0;
    for (const v of voices) {
      if (v.gain <= 0.01) continue;
      scheduled++;
      if (v.delayMs <= 0) {
        this.triggerVoice(bus.ctx, bus.out, bus.noise, v);
      } else {
        const handle = setTimeout(() => {
          this.timers.delete(handle);
          if (this.ctx && this.compressor && this.noiseBuffer) {
            this.triggerVoice(this.ctx, this.compressor, this.noiseBuffer, v);
          }
        }, v.delayMs);
        this.timers.add(handle);
      }
    }
    return scheduled;
  }

  private triggerVoice(
    ctx: AudioContext,
    dest: AudioNode,
    noise: AudioBuffer,
    voice: PlannedAudioFxVoice,
  ): void {
    try {
      const now = ctx.currentTime;
      const gainNode = ctx.createGain();
      let target: AudioNode = dest;
      if (typeof ctx.createStereoPanner === "function") {
        const pan = ctx.createStereoPanner();
        pan.pan.value = Math.max(-1, Math.min(1, voice.pan));
        pan.connect(dest);
        target = pan;
      }
      gainNode.connect(target);

      const g = Math.max(0.001, Math.min(0.95, voice.gain));
      switch (voice.soundCue) {
        case "blast": {
          // Deep fiery boom + crackle burst
          const osc = ctx.createOscillator();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(135, now);
          osc.frequency.exponentialRampToValueAtTime(34, now + 0.48);
          osc.connect(gainNode);

          const src = ctx.createBufferSource();
          src.buffer = noise;
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.setValueAtTime(920, now);
          lp.frequency.exponentialRampToValueAtTime(180, now + 0.45);
          src.connect(lp);
          lp.connect(gainNode);

          gainNode.gain.setValueAtTime(0.001, now);
          gainNode.gain.linearRampToValueAtTime(g, now + 0.018);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
          osc.start(now);
          src.start(now);
          osc.stop(now + 0.54);
          src.stop(now + 0.54);
          break;
        }
        case "thunder": {
          // Sharp electric snap + rumble
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.setValueAtTime(1800, now);
          bp.frequency.exponentialRampToValueAtTime(240, now + 0.36);
          bp.Q.value = 1.4;
          src.connect(bp);
          bp.connect(gainNode);

          gainNode.gain.setValueAtTime(g, now);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
          src.start(now);
          src.stop(now + 0.4);
          break;
        }
        case "frost": {
          // Crystalline icy sweep
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const hp = ctx.createBiquadFilter();
          hp.type = "highpass";
          hp.frequency.setValueAtTime(2200, now);
          src.connect(hp);
          hp.connect(gainNode);

          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.setValueAtTime(980, now);
          osc.frequency.exponentialRampToValueAtTime(520, now + 0.35);
          osc.connect(gainNode);

          gainNode.gain.setValueAtTime(0.001, now);
          gainNode.gain.linearRampToValueAtTime(g * 0.75, now + 0.03);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
          src.start(now);
          osc.start(now);
          src.stop(now + 0.42);
          osc.stop(now + 0.42);
          break;
        }
        case "vines": {
          // Earthy rustling swell
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.setValueAtTime(420, now);
          bp.frequency.linearRampToValueAtTime(760, now + 0.25);
          bp.Q.value = 2.2;
          src.connect(bp);
          bp.connect(gainNode);

          gainNode.gain.setValueAtTime(0.001, now);
          gainNode.gain.linearRampToValueAtTime(g * 0.85, now + 0.08);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.46);
          src.start(now);
          src.stop(now + 0.48);
          break;
        }
        case "chime": {
          // Harmonic healing fifth
          const o1 = ctx.createOscillator();
          const o2 = ctx.createOscillator();
          o1.type = "sine";
          o2.type = "sine";
          o1.frequency.setValueAtTime(587.33, now);
          o2.frequency.setValueAtTime(880, now + 0.04);
          o1.connect(gainNode);
          o2.connect(gainNode);

          gainNode.gain.setValueAtTime(0.001, now);
          gainNode.gain.linearRampToValueAtTime(g * 0.7, now + 0.025);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
          o1.start(now);
          o2.start(now + 0.04);
          o1.stop(now + 0.46);
          o2.stop(now + 0.46);
          break;
        }
        case "horn": {
          // Brass warhorn / charge call
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(196, now);
          osc.frequency.setValueAtTime(261.63, now + 0.11);
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.setValueAtTime(950, now);
          osc.connect(lp);
          lp.connect(gainNode);

          gainNode.gain.setValueAtTime(0.001, now);
          gainNode.gain.linearRampToValueAtTime(g * 0.72, now + 0.04);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.44);
          osc.start(now);
          osc.stop(now + 0.46);
          break;
        }
        case "volley": {
          // Arrow/bolt volley whoosh
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.frequency.setValueAtTime(1400, now);
          bp.frequency.exponentialRampToValueAtTime(520, now + 0.24);
          bp.Q.value = 2.8;
          src.connect(bp);
          bp.connect(gainNode);

          gainNode.gain.setValueAtTime(0.001, now);
          gainNode.gain.linearRampToValueAtTime(g * 0.8, now + 0.03);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
          src.start(now);
          src.stop(now + 0.28);
          break;
        }
        default: {
          // "clash" — metallic steel ring + shield thud
          const osc = ctx.createOscillator();
          osc.type = "square";
          osc.frequency.setValueAtTime(1320, now);
          osc.frequency.exponentialRampToValueAtTime(480, now + 0.12);
          const hp = ctx.createBiquadFilter();
          hp.type = "bandpass";
          hp.frequency.setValueAtTime(1650, now);
          hp.Q.value = 3.5;
          osc.connect(hp);
          hp.connect(gainNode);

          const src = ctx.createBufferSource();
          src.buffer = noise;
          const lp = ctx.createBiquadFilter();
          lp.type = "bandpass";
          lp.frequency.setValueAtTime(900, now);
          src.connect(lp);
          lp.connect(gainNode);

          gainNode.gain.setValueAtTime(g * 0.75, now);
          gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
          osc.start(now);
          src.start(now);
          osc.stop(now + 0.2);
          src.stop(now + 0.2);
          break;
        }
      }
    } catch {
      /* ignore transient WebAudio node errors */
    }
  }

  destroy(): void {
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    if (this.ctx) {
      void this.ctx.close?.().catch(() => undefined);
      this.ctx = null;
      this.compressor = null;
      this.noiseBuffer = null;
    }
  }
}
