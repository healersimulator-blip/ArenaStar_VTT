/**
 * D-294: a camera section claims the viewer's OWN view. The pure geometry lives in
 * `tests/canvas/fxCamera.test.ts`; this file pins the *handover*, which is where a
 * camera cue can quietly become a bug — the frame tick and the viewer's own gesture
 * write the same field, so the loser must yield in the same frame.
 */
import { describe, expect, test, vi, afterEach } from "vitest";
import { FxPlayer } from "../../src/client/fxPlayer";
import { createEventBus } from "../../src/core/events";
import type { ClientEvents, ClientSync } from "../../src/client/sync";
import type { Stage } from "../../src/canvas/stage";
import type { Camera } from "../../src/canvas/camera";
import type { FxStartMsg } from "../../src/core/messages";
import type { ResolvedFxSection } from "../../src/core/fx";

const SCENE = "sc-1";

function harness() {
  const bus = createEventBus<ClientEvents>();
  const frames: Array<() => void> = [];
  let scene = SCENE;
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  const writes: Camera[] = [];
  const stage = {
    get camera() {
      return camera;
    },
    viewport: { width: 800, height: 600 },
    setCamera: (next: Camera) => {
      camera = { ...next };
      writes.push({ ...next });
    },
    getFxLayer: () => ({ clear: vi.fn(), count: 0 }),
    onFrame: (cb: () => void) => {
      frames.push(cb);
      return () => frames.splice(frames.indexOf(cb), 1);
    },
  } as unknown as Stage;
  const player = new FxPlayer({
    client: { clockOffset: () => ({ offsetMs: 0 }), requestFxSync: vi.fn() } as unknown as ClientSync,
    bus,
    stage,
    fetchAsset: async () => new Uint8Array(),
    sceneId: () => scene,
  });
  return {
    bus,
    player,
    writes,
    camera: () => camera,
    leaveScene: () => { scene = "sc-2"; player.syncScene(); },
    tick: () => { for (const cb of [...frames]) cb(); },
    /** Cues are host-timestamped; a view claim never starts late, so give it a real future start. */
    cue: async (runId: string, sections: ResolvedFxSection[], wait = 80) => {
      bus.emit("fx", {
        kind: "fx.start", runId, macroId: "macro", sceneId: SCENE,
        atHostTime: Date.now() + 40, sections,
      } satisfies FxStartMsg);
      await new Promise((resolve) => setTimeout(resolve, wait));
    },
  };
}

/** A resolved pan, exactly as the host would broadcast it (destination already resolved). */
function pan(toX: number, toY: number, durationMs = 2_000, startMs = 0): ResolvedFxSection {
  return { id: `pan-${toX}-${toY}-${startMs}`, kind: "camera", mode: "pan", startMs, durationMs, toX, toY };
}

function shake(intensity = 0.5, durationMs = 1_000): ResolvedFxSection {
  return { id: `shake-${intensity}-${durationMs}`, kind: "camera", mode: "shake", startMs: 0, durationMs, intensity };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FX camera view claims (D-294)", () => {
  test("a viewer drag is not undone by the next frame, and the rest of that run yields", async () => {
    const h = harness();
    // Two camera sections in one timeline: take the view back during the first and
    // the second must not be attempted either.
    await h.cue("r1", [pan(1_200, 900, 4_000), pan(50, 50, 300, 150)]);
    h.tick();
    const claimed = h.camera();
    expect(claimed.x).toBeGreaterThan(0); // the claim is moving the viewport centre
    const movesBefore = h.writes.length;

    h.player.cancelCamera(); // the viewer grabbed the map here
    const afterCancel = h.camera();
    expect(afterCancel).toEqual(claimed); // a cancel writes no camera of its own

    // Every later frame must leave the viewer's view alone — including the frame the
    // device would have used to "restore" the pre-cue position.
    h.tick();
    h.tick();
    expect(h.camera()).toEqual(afterCancel);

    // …and the timeline's *next* camera section is skipped, not merely delayed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.tick();
    h.tick();
    expect(h.camera()).toEqual(afterCancel);
    expect(h.writes.length).toBe(movesBefore);
  });

  test("an explicit stop hands the view back where the cue found it", async () => {
    const h = harness();
    const base = { ...h.camera() };
    await h.cue("r2", [pan(1_200, 900, 4_000)]);
    h.tick();
    expect(h.camera()).not.toEqual(base);

    h.bus.emit("fxEnd", { kind: "fx.end", runId: "r2", sceneId: SCENE });
    expect(h.camera()).toEqual(base); // a stop is not a gesture: it restores, exactly
    const writes = h.writes.length;
    h.tick();
    expect(h.camera()).toEqual(base); // and nothing keeps animating afterwards
    expect(h.writes.length).toBe(writes);
  });

  test("a finished shake returns the exact pre-cue camera; a finished pan stays on its destination", async () => {
    const h = harness();
    const base = { ...h.camera() };
    await h.cue("r3", [shake(0.6, 120)]);
    h.tick(); // mid-shake: the view is displaced
    expect(h.camera()).not.toEqual(base);
    await new Promise((resolve) => setTimeout(resolve, 160));
    h.tick(); // the section is over
    expect(h.camera()).toEqual(base);

    await h.cue("r4", [pan(1_000, 400, 120)], 160);
    h.tick();
    const parked = h.camera();
    h.tick();
    expect(h.camera()).toEqual(parked); // the pan ends on the centring its sections asked for
    expect(parked.x + 800 / (2 * parked.scale)).toBeCloseTo(1_000, 5);
    expect(parked.y + 600 / (2 * parked.scale)).toBeCloseTo(400, 5);
  });

  test("a stale cue cannot claim the view after the viewer changed scene", async () => {
    const h = harness();
    await h.cue("old", [pan(900, 900, 4_000)]);
    h.tick();
    expect(h.camera().x).toBeGreaterThan(0);
    h.leaveScene(); // clearLocal drops the claim and restores the view of the old scene
    expect(h.camera()).toEqual({ x: 0, y: 0, scale: 1 });
    h.tick();
    expect(h.camera()).toEqual({ x: 0, y: 0, scale: 1 });
  });
});
