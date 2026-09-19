/**
 * §9 explored fog — the client loop (D-250/D-251) against a fake surface: restore merges the
 * stored map, reveals follow token moves and door state, saves debounce and flush on scene
 * change, the GM's translucent style restyles without recomputing, the token gate fails
 * closed and follows tokens that walk into an unmoved eye's sight, and the loop never
 * touches a surface after the scene left or the loop was destroyed.
 */
import { describe, expect, test } from "vitest";
import { FogExploration, type FogSurface, type FogTransport } from "../../src/client/fogExploration";
import type { SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";
import { pointInPolygon } from "../../src/canvas/vision/polygon";
import { InlineVisionWorker } from "../../src/workers/visionWorkerClient";

// ─── fixtures ────────────────────────────────────────────────────────────────

const token = (id: string, x: number, y: number, over: Partial<TokenDocument> = {}): TokenDocument => ({
  _id: id,
  type: "token",
  name: id,
  ownership: { default: 3 },
  flags: {},
  system: {},
  x,
  y,
  rotation: 0,
  width: 100,
  height: 100,
  img: "",
  hidden: false,
  disposition: "neutral",
  vision: true,
  light: { radius: 0, color: "#fff", alpha: 0.5 },
  ...over,
});

const wall = (id: string, c: WallDocument["c"], over: Partial<WallDocument> = {}): WallDocument => ({
  _id: id,
  type: "wall",
  name: id,
  ownership: { default: 0 },
  flags: {},
  system: {},
  c,
  door: 0,
  oneWay: false,
  move: 0,
  sight: 0,
  sound: 0,
  light: 0,
  ...over,
});

const scene = (id: string, over: Partial<SceneDocument> = {}): SceneDocument => ({
  _id: id,
  type: "scene",
  name: id,
  ownership: { default: 2 },
  flags: { core: { fog: true } },
  system: {},
  active: true,
  img: null,
  width: 1000,
  height: 800,
  darkness: 0,
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  tokens: [],
  walls: [],
  lights: [],
  sounds: [],
  tiles: [],
  drawings: [],
  templates: [],
  notes: [],
  ...over,
});

class FakeSurface implements FogSurface {
  resets = 0;
  reveals: Float32Array[] = [];
  visible: Float32Array[][] = [];
  merged: Uint8Array[] = [];
  shown: boolean | null = null;
  style: string | null = null;
  readbacks = 0;
  destroyed = false;
  constructor(readonly label: string) {}
  reset(): void {
    this.assertAlive("reset");
    this.resets++;
  }
  reveal(poly: Float32Array): void {
    this.assertAlive("reveal");
    this.reveals.push(poly);
  }
  setVisible(polys: readonly Float32Array[]): void {
    this.assertAlive("setVisible");
    this.visible.push([...polys]);
  }
  mergePng(png: Uint8Array): Promise<void> {
    this.assertAlive("mergePng");
    this.merged.push(png);
    return Promise.resolve();
  }
  readbackPng(): Promise<Uint8Array> {
    this.assertAlive("readbackPng");
    this.readbacks++;
    return Promise.resolve(new Uint8Array([0x89, this.reveals.length]));
  }
  setShown(shown: boolean): void {
    this.assertAlive("setShown");
    this.shown = shown;
  }
  setStyle(style: "opaque" | "translucent"): void {
    this.assertAlive("setStyle");
    this.style = style;
  }
  private assertAlive(what: string): void {
    if (this.destroyed) throw new Error(`${what} on destroyed surface ${this.label}`);
  }
}

class FakeTransport implements FogTransport {
  stored = new Map<string, Uint8Array>();
  puts: Array<{ sceneId: string; png: Uint8Array }> = [];
  gets: string[] = [];
  /** When set, requestFog never resolves (a silent host). */
  silent = false;
  requestFog(sceneId: string): Promise<Uint8Array | null> {
    this.gets.push(sceneId);
    if (this.silent) return new Promise(() => undefined);
    return Promise.resolve(this.stored.get(sceneId) ?? null);
  }
  sendFogPng(sceneId: string, png: Uint8Array): void {
    this.puts.push({ sceneId, png });
    this.stored.set(sceneId, png);
  }
}

/** Manual timers: the loop's debounce and restore timeout fire only when the test says. */
class Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  };
  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  armed(ms: number): boolean {
    return [...this.pending.values()].some((t) => t.ms === ms);
  }
  fire(ms?: number): void {
    for (const [id, t] of [...this.pending]) {
      if (ms !== undefined && t.ms !== ms) continue;
      this.pending.delete(id);
      t.fn();
    }
  }
}

function harness(opts: { user?: { id: string; role: "GM" | "PLAYER" } | null } = {}) {
  const surfaces = new Map<string, FakeSurface>();
  let current: FakeSurface | null = null;
  let hidden = 0;
  const transport = new FakeTransport();
  const timers = new Timers();
  const errors: string[] = [];
  const visibility: Array<string[] | null> = [];
  const user = opts.user === undefined ? { id: "gm", role: "GM" as const } : opts.user;
  const fog = new FogExploration({
    surfaceFor: (sc) => {
      // like the stage: a new layer per scene size, the old one destroyed
      const key = `${sc.width}x${sc.height}`;
      let s = surfaces.get(key);
      if (!s) {
        for (const old of surfaces.values()) old.destroyed = true;
        surfaces.clear();
        s = new FakeSurface(key);
        surfaces.set(key, s);
      }
      current = s;
      return s;
    },
    hideSurface: () => {
      hidden++;
    },
    computer: new InlineVisionWorker(),
    transport,
    user: () => user,
    actors: () => [],
    onVisibility: (ids) => visibility.push(ids === null ? null : [...ids].sort()),
    saveDelayMs: 1500,
    restoreTimeoutMs: 15_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
    onError: (where, error) => errors.push(`${where}: ${String(error)}`),
  });
  return {
    fog,
    transport,
    timers,
    errors,
    visibility,
    surface: () => {
      if (!current) throw new Error("no surface yet");
      return current;
    },
    hidden: () => hidden,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("FogExploration loop", () => {
  test("entering a fogged scene: reset, restore from the host, then reveal the viewers' polygons", async () => {
    const h = harness();
    h.transport.stored.set("s1", new Uint8Array([1, 2, 3]));
    const s1 = scene("s1", { tokens: [token("t", 200, 200)], walls: [wall("w", [0, 300, 1000, 300])] });
    await h.fog.sync(s1, { style: "opaque" });

    const surface = h.surface();
    expect(surface.resets).toBe(1);
    expect(h.transport.gets).toEqual(["s1"]);
    expect(surface.merged.map((m) => [...m])).toEqual([[1, 2, 3]]);
    expect(surface.shown).toBe(true);
    expect(surface.style).toBe("opaque");
    expect(surface.reveals).toHaveLength(1);
    const poly = surface.reveals[0] as Float32Array;
    expect(pointInPolygon(poly, 200, 100)).toBe(true); // same side of the wall
    expect(pointInPolygon(poly, 200, 500)).toBe(false); // behind it
    expect(surface.visible.at(-1)).toHaveLength(1);
    expect(h.fog.stats()).toMatchObject({ sceneId: "s1", enabled: true, restored: true, restoredBytes: 3, reveals: 1, dirty: true, saves: 0 });
    expect(h.errors).toEqual([]);
  });

  test("nothing stored → restored with 0 bytes, no merge", async () => {
    const h = harness();
    await h.fog.sync(scene("s1", { tokens: [token("t", 200, 200)] }), { style: "opaque" });
    expect(h.surface().merged).toEqual([]);
    expect(h.fog.stats()).toMatchObject({ restored: true, restoredBytes: 0 });
  });

  test("a save lands after the quiet time, not before; unchanged replicas do not re-reveal", async () => {
    const h = harness();
    const s1 = scene("s1", { tokens: [token("t", 200, 200)] });
    await h.fog.sync(s1, { style: "opaque" });
    await h.fog.sync(s1, { style: "opaque" }); // same key → no second polygon pass
    expect(h.surface().reveals).toHaveLength(1);
    expect(h.transport.puts).toEqual([]);
    expect([...h.timers.pending.values()].map((t) => t.ms)).toEqual([1500]);

    h.timers.fire(1500);
    await h.fog.settle();
    expect(h.transport.puts.map((p) => p.sceneId)).toEqual(["s1"]);
    expect(h.fog.stats()).toMatchObject({ saves: 1, dirty: false, lastSaveBytes: 2 });

    // a move re-reveals and re-arms ONE timer
    await h.fog.sync({ ...s1, tokens: [token("t", 500, 200)] }, { style: "opaque" });
    await h.fog.sync({ ...s1, tokens: [token("t", 600, 200)] }, { style: "opaque" });
    expect(h.surface().reveals).toHaveLength(3);
    expect([...h.timers.pending.values()].filter((t) => t.ms === 1500)).toHaveLength(1);
  });

  test("an opening door re-reveals even though nobody moved", async () => {
    const h = harness();
    const door = wall("d", [0, 300, 1000, 300], { sight: 1, door: 0 });
    const s1 = scene("s1", { tokens: [token("t", 200, 200)], walls: [door] });
    await h.fog.sync(s1, { style: "opaque" });
    const closed = h.surface().reveals[0] as Float32Array;
    expect(pointInPolygon(closed, 200, 500)).toBe(false);
    await h.fog.sync({ ...s1, walls: [{ ...door, door: 1 }] }, { style: "opaque" });
    const open = h.surface().reveals[1] as Float32Array;
    expect(pointInPolygon(open, 200, 500)).toBe(true);
  });

  test("leaving a scene flushes its dirty map BEFORE the next scene's surface replaces it", async () => {
    const h = harness();
    await h.fog.sync(scene("s1", { tokens: [token("t", 200, 200)] }), { style: "opaque" });
    const first = h.surface();
    // a different size → the stage would destroy the first layer when asked for the second
    await h.fog.sync(scene("s2", { width: 600, height: 600, tokens: [token("t", 100, 100)] }), { style: "opaque" });
    expect(h.transport.puts.map((p) => p.sceneId)).toEqual(["s1"]);
    expect(first.readbacks).toBe(1);
    expect(h.surface()).not.toBe(first);
    expect(h.surface().resets).toBe(1);
    expect(h.transport.gets).toEqual(["s1", "s2"]);
    expect(h.errors).toEqual([]);
  });

  test("fog off for the scene (or no scene): flush, forget, hide — and the GM's style only restyles", async () => {
    const h = harness();
    const s1 = scene("s1", { tokens: [token("t", 200, 200)] });
    await h.fog.sync(s1, { style: "translucent" });
    expect(h.surface().shown).toBe(true);
    expect(h.surface().style).toBe("translucent");
    expect(h.surface().reveals).toHaveLength(1);
    await h.fog.sync(s1, { style: "opaque" });
    expect(h.surface().style).toBe("opaque");
    expect(h.surface().reveals).toHaveLength(1); // a restyle recomputes nothing

    const plain = { ...s1, flags: {} };
    await h.fog.sync(plain, { style: "opaque" });
    expect(h.transport.puts.map((p) => p.sceneId)).toEqual(["s1"]);
    expect(h.hidden()).toBe(1);
    expect(h.fog.stats()).toMatchObject({ sceneId: null, enabled: false });
    await h.fog.sync(null, { style: "opaque" });
    expect(h.hidden()).toBe(2);
    expect(h.transport.puts).toHaveLength(1); // nothing new to save
  });

  test("a player reveals only with tokens they control; no viewer → nothing revealed, nothing saved", async () => {
    const h = harness({ user: { id: "rex", role: "PLAYER" } });
    const s1 = scene("s1", {
      tokens: [token("mine", 200, 200, { ownership: { default: 0, rex: 3 } }), token("npc", 800, 600, { ownership: { default: 0 } })],
    });
    await h.fog.sync(s1, { style: "opaque" });
    expect(h.surface().reveals).toHaveLength(1);
    const h2 = harness({ user: { id: "ivy", role: "PLAYER" } });
    await h2.fog.sync(s1, { style: "opaque" });
    expect(h2.surface().reveals).toHaveLength(0);
    expect(h2.surface().visible.at(-1)).toEqual([]);
    expect(h2.fog.stats().dirty).toBe(false);
    expect(h2.timers.pending.size).toBe(0);
    // D-251: ivy controls nothing and sees nothing; the gate closed before any polygon
    expect(h2.visibility).toEqual([[]]);
  });

  test("D-251 token gate: fails closed on entry, opens for tokens in sight, follows a token that walks in or out", async () => {
    const h = harness({ user: { id: "rex", role: "PLAYER" } });
    const wallAcross = wall("w", [0, 300, 1000, 300]); // the hero's side is y < 300
    const hero = token("hero", 200, 200, { ownership: { default: 0, rex: 3 } });
    const orcNear = token("orc", 600, 150, { ownership: { default: 0 } }); // same side, in sight
    const orcFar = token("orc", 600, 600, { ownership: { default: 0 } }); // behind the wall
    const s1 = scene("s1", { tokens: [hero, orcFar], walls: [wallAcross] });

    // entering: own token only, published BEFORE the restore/polygons (fail closed)
    h.transport.silent = true;
    const first = h.fog.sync(s1, { style: "opaque" });
    for (let i = 0; i < 50 && h.visibility.length === 0; i++) await Promise.resolve();
    expect(h.visibility).toEqual([["hero"]]);
    expect(h.fog.stats().restored).toBe(false);
    h.timers.fire(15_000);
    await first;
    // polygons in: the far orc is behind the wall → still just the hero (no re-publish)
    expect(h.visibility).toEqual([["hero"]]);
    expect(h.fog.stats().visibleTokenIds).toEqual(["hero"]);

    // the orc walks around the wall into sight — the hero never moved (same reveal key)
    const revealsBefore = h.surface().reveals.length;
    await h.fog.sync({ ...s1, tokens: [hero, orcNear] }, { style: "opaque" });
    expect(h.surface().reveals).toHaveLength(revealsBefore);
    expect(h.visibility.at(-1)).toEqual(["hero", "orc"]);

    // …and back out of sight
    await h.fog.sync({ ...s1, tokens: [hero, orcFar] }, { style: "opaque" });
    expect(h.visibility.at(-1)).toEqual(["hero"]);

    // a second controlled token is always shown, wherever it stands
    const mule = token("mule", 900, 700, { ownership: { default: 0, rex: 3 }, vision: false });
    await h.fog.sync({ ...s1, tokens: [hero, orcFar, mule] }, { style: "opaque" });
    expect(h.visibility.at(-1)).toEqual(["hero", "mule"]);

    // fog off → null (everything), once
    await h.fog.sync({ ...s1, flags: {} }, { style: "opaque" });
    expect(h.visibility.at(-1)).toBeNull();
    expect(h.fog.stats().visibleTokenIds).toBeNull();
  });

  test("D-251: the GM is never gated — every token is listed regardless of sight", async () => {
    const h = harness();
    const s1 = scene("s1", {
      tokens: [token("a", 200, 200), token("b", 900, 700, { ownership: { default: 0 }, vision: false })],
      walls: [wall("w", [0, 300, 1000, 300])],
    });
    await h.fog.sync(s1, { style: "translucent" });
    expect(h.visibility.at(-1)).toEqual(["a", "b"]);
  });

  test("a silent host: restore times out as 'nothing stored', reveals go on, refreshStored merges later", async () => {
    const h = harness();
    h.transport.silent = true;
    const s1 = scene("s1", { tokens: [token("t", 200, 200)] });
    const sync = h.fog.sync(s1, { style: "opaque" });
    // the restore timeout is armed a few microtasks in (queue → leaveScene → surface → fetch)
    for (let i = 0; i < 50 && !h.timers.armed(15_000); i++) await Promise.resolve();
    expect(h.timers.armed(15_000)).toBe(true);
    expect(h.fog.stats().restored).toBe(false);
    h.timers.fire(15_000);
    await sync;
    expect(h.fog.stats()).toMatchObject({ restored: true, restoredBytes: 0, reveals: 1 });

    h.transport.silent = false;
    h.transport.stored.set("s1", new Uint8Array([7, 7]));
    await h.fog.refreshStored();
    expect(h.surface().merged.map((m) => [...m])).toEqual([[7, 7]]);
    expect(h.fog.stats().restoredBytes).toBe(2);
    expect(h.errors).toEqual([]);
  });

  test("flush then destroy: the queued flush lands, later syncs are ignored, nothing touches the surface", async () => {
    const h = harness();
    const s1 = scene("s1", { tokens: [token("t", 200, 200)] });
    await h.fog.sync(s1, { style: "opaque" });
    const flushed = h.fog.flush();
    h.fog.destroy();
    await flushed;
    expect(h.transport.puts.map((p) => p.sceneId)).toEqual(["s1"]);
    expect(h.timers.pending.size).toBe(0);
    const surface = h.surface();
    surface.destroyed = true; // the stage is gone
    await h.fog.sync({ ...s1, tokens: [token("t", 600, 600)] }, { style: "opaque" });
    await h.fog.flush();
    expect(h.errors).toEqual([]);
    expect(h.transport.puts).toHaveLength(1);
  });

  test("a surface/transport failure is reported, not thrown, and the loop keeps serving", async () => {
    const h = harness();
    const s1 = scene("s1", { tokens: [token("t", 200, 200)] });
    await h.fog.sync(s1, { style: "opaque" });
    const surface = h.surface();
    surface.readbackPng = () => Promise.reject(new Error("gpu lost"));
    await h.fog.flush();
    expect(h.errors).toEqual(["flush: Error: gpu lost"]);
    surface.readbackPng = () => Promise.resolve(new Uint8Array([1]));
    await h.fog.sync({ ...s1, tokens: [token("t", 300, 300)] }, { style: "opaque" });
    await h.fog.flush();
    expect(h.transport.puts).toHaveLength(1);
  });
});
