/**
 * D-309 (SQ-09) — the two things an `<audio>` element cannot do: panning and muffling.
 *
 * A positional sound needs a stereo position and, when a wall is in the way, a low-pass.
 * Both live in Web Audio, and both must be *optional*: a shell with no `AudioContext`
 * (a unit test, an old browser, a hardened WebView) must still play the sound at its
 * distance gain rather than pretending it panned. So this module is a small adapter with
 * one honest failure mode — `attachSpatialAudio` returns `null`, the caller reports the
 * reduction, and the element keeps playing straight to the speakers.
 *
 * The element's own `volume` stays in charge of the *level*: this graph only routes the
 * signal (source → low-pass → stereo panner → output). Everything the mix panel and the
 * fade already do therefore composes with it instead of being replaced by it.
 *
 * One `MediaElementSourceNode` per element, and creating a second one for the same
 * element throws — the player creates an element per cue and hands it here exactly once,
 * which is what makes that safe.
 */
import { MUFFLE_CUTOFF_HZ, MUFFLE_OPEN_HZ } from "../core/fxSound";

/** The knobs a playing cue needs; a device without them never receives this object. */
export interface SpatialAudioNodes {
  /** −1 hard left … +1 hard right. */
  setPan(pan: number): void;
  /** Dull the sound as if heard through a wall, or open it back up. */
  setMuffled(muffled: boolean): void;
  /** Detach this element from the graph (the element itself is the caller's to stop). */
  dispose(): void;
}

/** The page's single context: browsers cap how many a document may open. */
let context: AudioContext | null = null;
let contextFailed = false;

function audioContext(): AudioContext | null {
  if (context) return context;
  if (contextFailed) return null;
  const ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  try {
    context = ctor ? new ctor() : null;
    if (context && typeof context.createStereoPanner !== "function") {
      // A graph without a panner is no spatial graph at all: fail as a whole rather than
      // half-apply the request (a `pan` the author asked for must not silently do nothing).
      void context.close?.();
      context = null;
    }
  } catch {
    context = null;
  }
  if (!context) contextFailed = true;
  return context;
}

/** A suspended context is fine for arithmetic and resumes on the first gesture. */
function wake(ctx: AudioContext): void {
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  } catch {
    // A context that refuses to resume still has usable nodes; play() needs a gesture anyway.
  }
}

/**
 * Route `element` through a low-pass and a stereo panner, or return `null` when this
 * device cannot do it (no `AudioContext`, no panner, or a constructor that throws).
 */
export function attachSpatialAudio(element: HTMLAudioElement): SpatialAudioNodes | null {
  const ctx = audioContext();
  if (!ctx) return null;
  try {
    wake(ctx);
    const source = ctx.createMediaElementSource(element);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = MUFFLE_OPEN_HZ;
    lowpass.Q.value = 0.7;
    const panner = ctx.createStereoPanner();
    source.connect(lowpass);
    lowpass.connect(panner);
    panner.connect(ctx.destination);
    let disposed = false;
    return {
      setPan(pan: number): void {
        if (disposed || !Number.isFinite(pan)) return;
        panner.pan.value = Math.min(1, Math.max(-1, pan));
      },
      setMuffled(muffled: boolean): void {
        if (disposed) return;
        lowpass.frequency.value = muffled ? MUFFLE_CUTOFF_HZ : MUFFLE_OPEN_HZ;
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        try {
          source.disconnect();
          lowpass.disconnect();
          panner.disconnect();
        } catch {
          // Nodes already detached by a closed context: nothing to do.
        }
      },
    };
  } catch {
    // `createMediaElementSource` throws for an element that already has one, and a
    // closed context throws for everything: neither is a reason to lose the sound.
    return null;
  }
}

/** Test hook: forget the module's context (a page reload does this for real). */
export function resetFxAudioGraph(): void {
  context = null;
  contextFailed = false;
}
