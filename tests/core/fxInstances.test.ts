import { describe, expect, test } from "vitest";
import { boundFxDeletionOps, fxInstanceMatches, validateFxInstance, validateFxInstanceFilter } from "../../src/core/fxInstances";
import type { AssetManifest, FxInstanceDocument, SceneDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { emptyWorld } from "../net/fixtures";

const hash = "a".repeat(64);
const manifest: AssetManifest = { [hash]: { name: "owned.png", mime: "image/png", size: 5,
  chunks: 1, visibility: "referenced" } };
const scene: SceneDocument = { _id: "scene-a", type: "scene", name: "Scene", flags: {}, system: {},
  ownership: { default: 2 }, active: true, img: null, width: 1000, height: 1000, darkness: 0,
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  tokens: [{ _id: "source", type: "token", name: "Source", flags: {}, system: {},
    ownership: { default: 0 }, x: 50, y: 50, width: 50, height: 50, rotation: 0,
    hidden: false, disposition: "neutral", vision: true, img: "",
    light: { radius: 0, color: "#fff", alpha: 0 } }],
  walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
};
const instance: FxInstanceDocument = { _id: "run-1", type: "fxInstance", name: "Aura",
  flags: {}, system: {}, ownership: { default: 0 }, sceneId: scene._id,
  macroId: "macro-1", ownerId: "player", audience: "scene", atHostTime: 1000,
  sourceTokenId: "source", sections: [
    { kind: "image", id: "a", assetId: hash, mime: "image/png", x: 100, y: 100,
      startMs: 0, durationMs: 1000, toX: 200, toY: 200, repeats: 2 },
    { kind: "text", id: "b", text: "Glow", x: 180, y: 180,
      startMs: 200, durationMs: 800 },
  ],
};

describe("private durable FX records", () => {
  test("strict, bounded name/source filters match saved sequence origin without regex execution", () => {
    expect(validateFxInstanceFilter({ name: "a*", macroId: "macro-1" }).ok).toBe(true);
    expect(fxInstanceMatches(instance, { name: "aU?A", macroId: "macro-1", sourceTokenId: "source" })).toBe(true);
    expect(fxInstanceMatches(instance, { name: "Aura", targetTokenId: "source" })).toBe(false);
    expect(fxInstanceMatches(instance, { macroId: "private-macro" })).toBe(false);
    expect(validateFxInstanceFilter({}, true).ok).toBe(false); // no accidental stop-all
    expect(validateFxInstanceFilter({ name: undefined }, true).ok).toBe(false);
    expect(validateFxInstanceFilter({ name: "" }, true).ok).toBe(false);
    expect(validateFxInstanceFilter({ name: "a".repeat(129) }).ok).toBe(false);
    expect(validateFxInstanceFilter({ name: "a\nsecret" }).ok).toBe(false);
    expect(validateFxInstanceFilter({ macroId: "../escape" }).ok).toBe(false);
    expect(validateFxInstanceFilter({ sceneId: "another-scene" }).ok).toBe(false);
    expect(validateFxInstanceFilter({ ownerId: "gm" }).ok).toBe(false);
  });

  test("validates resolved coordinates, MIME, bounded duration and host-only shape", () => {
    const visual = instance.sections[0];
    if (!visual || visual.kind !== "image") throw new Error("Missing image fixture");
    expect(validateFxInstance(instance, scene, manifest)).toBe(true);
    expect(validateFxInstance({ ...instance, sourceTokenId: "deleted" }, scene, manifest)).toBe(false);
    expect(validateFxInstance({ ...instance, atHostTime: -1 }, scene, manifest)).toBe(false);
    expect(validateFxInstance({ ...instance, sections: [{ ...visual, x: 2000 }] }, scene, manifest)).toBe(false);
    expect(validateFxInstance({ ...instance, sections: [{ ...visual, mime: "text/html" }] }, scene, manifest)).toBe(false);
    const { toY: _missingY, ...missingY } = visual;
    void _missingY;
    expect(validateFxInstance({ ...instance, sections: [missingY] }, scene, manifest)).toBe(false);
    expect(validateFxInstance({ ...instance, sections: [{ ...visual, durationMs: 1 }] }, scene, manifest)).toBe(false);
    expect(validateFxInstance({ ...instance, sections: [{ ...visual, evil: "op" } as typeof instance.sections[number]] }, scene, manifest))
      .toBe(false);
    expect(validateFxInstance({ ...instance, sections: [{ ...visual, follow: true, followTokenId: "source" }] }, scene, manifest))
      .toBe(true);
    expect(validateFxInstance({ ...instance, sections: [{ ...visual, follow: true, followToTokenId: "source" }] }, scene, manifest))
      .toBe(true);
    expect(validateFxInstance({ ...instance, sections: [{ ...visual, follow: true, followTokenId: "secret" }] }, scene, manifest))
      .toBe(false);
    expect(validateFxInstance({ ...instance, sections: [{ ...visual, followTokenId: "source" }] }, scene, manifest))
      .toBe(false);
    const { toX: _missingDestination, ...noDestinationX } = visual;
    void _missingDestination;
    expect(validateFxInstance({ ...instance, sections: [{ ...noDestinationX, follow: true, followToTokenId: "source" }] }, scene, manifest))
      .toBe(false);
    expect(validateFxInstance(instance, undefined, manifest)).toBe(false);
    expect(instance.sections[0]).toHaveProperty("x", 100); // pure; host records aren't rewritten
  });

  test("a stored cue's resolved mask is checked as a polygon, not as authored scene units", () => {
    const visual = instance.sections[0];
    if (!visual || visual.kind !== "image") throw new Error("Missing image fixture");
    const ring = Array.from({ length: 12 }, (_, i) => ({ x: Math.cos(i) * 40, y: Math.sin(i) * 40 }));
    const masked = { ...visual, mask: { area: ring, invert: true } };
    expect(validateFxInstance({ ...instance, sections: [masked] }, scene, manifest)).toBe(true);
    // A polygon a renderer could not draw — too few points, a non-finite vertex, or a
    // shape larger than the bound — is refused on a *stored* cue too, not only on save.
    expect(validateFxInstance({ ...instance,
      sections: [{ ...visual, mask: { area: ring.slice(0, 2), invert: false } }] }, scene, manifest)).toBe(false);
    expect(validateFxInstance({ ...instance,
      sections: [{ ...visual, mask: { area: [...ring, { x: Number.NaN, y: 0 }], invert: false } }] }, scene, manifest)).toBe(false);
    expect(validateFxInstance({ ...instance,
      sections: [{ ...visual, mask: { area: Array.from({ length: 257 }, (_, i) => ({ x: i, y: 0 })), invert: false } }] }, scene, manifest))
      .toBe(false);
    expect(validateFxInstance({ ...instance,
      sections: [{ ...visual, mask: { area: ring, invert: "yes" as unknown as boolean } }] }, scene, manifest)).toBe(false);
    // A stored cue that omits `invert` reads as "not inverted" rather than as a refusal:
    // the flag is a boolean the renderer tests for `true`, not a required sentinel.
    expect(validateFxInstance({ ...instance,
      sections: [{ ...visual, mask: { area: ring, invert: undefined } as unknown as { area: { x: number; y: number }[]; invert: boolean } }] },
    scene, manifest)).toBe(true);
    // The authored form is not what a stored cue carries: trusting it would be a bypass.
    expect(validateFxInstance({ ...instance,
      sections: [{ ...visual, mask: { kind: "circle", length: 15 } } as unknown as typeof instance.sections[number]] },
    scene, manifest)).toBe(false);
  });

  test("source/target, scene or macro deletion cascades in one undoable transaction", () => {
    const world = emptyWorld();
    world.scenes.push(scene, { ...scene, _id: "scene-b", tokens: [] });
    const { sourceTokenId: _bound, ...unbound } = instance;
    void _bound;
    world.fxInstances.push(instance,
      { ...unbound, _id: "run-other", sceneId: "scene-b" });
    const tokenRef = { coll: "tokens" as const, id: "source",
      parent: { coll: "scenes" as const, id: "scene-a" } };
    const tokens: Op[] = [{ kind: "delete", ref: tokenRef }];
    expect(boundFxDeletionOps(world, tokens).map((op) => op.kind === "delete" ? op.ref.id : ""))
      .toEqual(["source", "run-1"]);
    expect(boundFxDeletionOps(world, [{ kind: "delete", ref: { coll: "macros", id: "macro-1" } }])
      .map((op) => op.kind === "delete" ? op.ref.id : ""))
      .toEqual(["macro-1", "run-1", "run-other"]);
    expect(boundFxDeletionOps(world, [{ kind: "delete", ref: { coll: "scenes", id: "scene-a" } }])
      .map((op) => op.kind === "delete" ? op.ref.id : ""))
      .toEqual(["scene-a", "run-1"]);
    expect(boundFxDeletionOps(world, [{ kind: "delete", ref: { coll: "fxInstances", id: "run-1" } }]))
      .toEqual([{ kind: "delete", ref: { coll: "fxInstances", id: "run-1" } }]);
  });
});
