/**
 * D-309 (SQ-09) — the optional half of a positional sound. Panning and muffling need
 * Web Audio; playing a cue does not. This pins the *shape of the refusal*: one honest
 * `null` for every reason a device cannot do it, a single shared context when it can,
 * and an idempotent detach.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { attachSpatialAudio, resetFxAudioGraph, type SpatialAudioNodes } from "../../src/client/fxAudioGraph";
import { MUFFLE_CUTOFF_HZ, MUFFLE_OPEN_HZ } from "../../src/core/fxSound";

interface FakeNodes {
  panValues: number[];
  frequencyValues: number[];
  created: number;
  closed: number;
  disconnected: number;
}

function fakeAudioContext(options: { panner?: boolean; throwOnSource?: boolean; connectThrows?: boolean } = {}) {
  const seen: FakeNodes = { panValues: [], frequencyValues: [], created: 0, closed: 0, disconnected: 0 };
  class FakeAudioContext {
    state = "running";
    destination = {};
    constructor() { seen.created++; }
    createMediaElementSource() {
      if (options.throwOnSource) throw new Error("already attached");
      return { connect: () => undefined, disconnect: () => { seen.disconnected++; } };
    }
    createBiquadFilter() {
      const frequency = {
        set value(next: number) { seen.frequencyValues.push(next); },
        get value() { return seen.frequencyValues.at(-1) ?? 0; },
      };
      return { type: "", Q: { value: 0 }, frequency,
        connect: () => { if (options.connectThrows) throw new Error("bad graph"); },
        disconnect: () => { seen.disconnected++; } };
    }
    createStereoPanner() {
      const pan = {
        set value(next: number) { seen.panValues.push(next); },
        get value() { return seen.panValues.at(-1) ?? 0; },
      };
      return { pan, connect: () => undefined, disconnect: () => { seen.disconnected++; } };
    }
    close() { seen.closed++; return Promise.resolve(); }
  }
  const ctor = options.panner === false
    ? class extends FakeAudioContext { override createStereoPanner(): never { throw new Error("no panner"); } }
    : FakeAudioContext;
  // `createStereoPanner` missing entirely is a different refusal path from one that throws.
  if (options.panner === false) delete (ctor.prototype as { createStereoPanner?: unknown }).createStereoPanner;
  return { ctor, seen };
}

const element = {} as HTMLAudioElement;

beforeEach(() => {
  vi.unstubAllGlobals();
  resetFxAudioGraph();
});

describe("the spatial graph a device may or may not have (D-309)", () => {
  test("a device with no AudioContext is refused honestly, and the refusal is remembered", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(attachSpatialAudio(element)).toBeNull();
    // Even if a context appears later, this document already learned it has none: a
    // half-wired graph arriving mid-cue would be worse than the honest reduction.
    const { ctor } = fakeAudioContext();
    vi.stubGlobal("AudioContext", ctor);
    expect(attachSpatialAudio(element)).toBeNull();
    resetFxAudioGraph();
    expect(attachSpatialAudio(element)).not.toBeNull();
  });

  test("a context without a stereo panner is no spatial graph at all, and it is released", () => {
    const pannerless = class {
      state = "running";
      destination = {};
      closed = 0;
      createMediaElementSource() { return { connect: () => undefined, disconnect: () => undefined }; }
      close() { this.closed++; return Promise.resolve(); }
    };
    const instances: Array<{ closed: number }> = [];
    class Tracked extends pannerless {
      constructor() { super(); instances.push(this); }
    }
    vi.stubGlobal("AudioContext", Tracked);
    expect(attachSpatialAudio(element)).toBeNull();
    // A pan the author asked for must not silently do nothing: the whole graph goes.
    expect(instances[0]?.closed).toBe(1);
  });

  test("a constructor that throws does not take the sound down with it", () => {
    vi.stubGlobal("AudioContext", function BrokenContext() { throw new Error("no audio device"); });
    expect(attachSpatialAudio(element)).toBeNull();
  });

  test("an element that already has a source is refused, not duplicated", () => {
    const { ctor } = fakeAudioContext({ throwOnSource: true });
    vi.stubGlobal("AudioContext", ctor);
    expect(attachSpatialAudio(element)).toBeNull();
  });

  test("pan is bounded and finite, muffle is a two-state low-pass, dispose is idempotent", () => {
    const { ctor, seen } = fakeAudioContext();
    vi.stubGlobal("AudioContext", ctor);
    const nodes = attachSpatialAudio(element) as SpatialAudioNodes;
    expect(nodes).not.toBeNull();
    // Opened by default: a sound with no wall between it and this listener is untouched.
    expect(seen.frequencyValues).toEqual([MUFFLE_OPEN_HZ]);
    nodes.setPan(0.25);
    nodes.setPan(9);
    nodes.setPan(-9);
    nodes.setPan(Number.NaN);
    expect(seen.panValues).toEqual([0.25, 1, -1]); // NaN never reaches a node
    // The player re-applies both on every tick (a listener can move), so the graph is
    // written to as often as it is asked — assigning an unchanged AudioParam is free.
    nodes.setMuffled(true);
    nodes.setMuffled(true);
    nodes.setMuffled(false);
    expect(seen.frequencyValues).toEqual([MUFFLE_OPEN_HZ, MUFFLE_CUTOFF_HZ, MUFFLE_CUTOFF_HZ, MUFFLE_OPEN_HZ]);
    nodes.dispose();
    const afterDispose = seen.panValues.length;
    nodes.setPan(0.5);
    nodes.setMuffled(true);
    expect(seen.panValues).toHaveLength(afterDispose); // a disposed cue is inert
    nodes.dispose(); // and disposing twice is not an error
    expect(seen.disconnected).toBe(3);
  });

  test("every cue in the page shares one context, and a detach never closes it", () => {
    const { ctor, seen } = fakeAudioContext();
    vi.stubGlobal("AudioContext", ctor);
    const first = attachSpatialAudio(element) as SpatialAudioNodes;
    const second = attachSpatialAudio({} as HTMLAudioElement) as SpatialAudioNodes;
    expect(seen.created).toBe(1); // browsers cap contexts per document
    first.dispose();
    second.dispose();
    expect(seen.closed).toBe(0); // the next cue still has a graph to use
    expect(attachSpatialAudio({} as HTMLAudioElement)).not.toBeNull();
    expect(seen.created).toBe(1);
  });
});
