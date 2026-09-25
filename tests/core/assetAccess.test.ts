import { describe, expect, test } from "vitest";
import { canFetchAsset, projectAssetManifest } from "../../src/core/assetAccess";
import type { AssetManifest, SceneDocument, TokenDocument } from "../../src/core/documents";
import { emptyWorld } from "../net/fixtures";

const entry = (name: string, visibility?: "world" | "referenced" | "gm") => ({
  name, mime: "image/png", size: 4, chunks: 1,
  ...(visibility ? { visibility } : {}),
});
const gm = { id: "gm", role: "GM" as const };
const player = { id: "p", role: "PLAYER" as const };
function token(id: string, img: string, hidden = false): TokenDocument {
  return { _id: id, type: "token", name: id, system: {}, flags: {}, ownership: { default: 0 },
    img, hidden, x: 0, y: 0, width: 50, height: 50, rotation: 0,
    disposition: "neutral", vision: false, light: { radius: 0, alpha: 0, color: "#fff" } };
}
function scene(): SceneDocument {
  return { _id: "scene", type: "scene", name: "scene", system: {}, flags: {},
    ownership: { default: 2 }, active: true, img: null, width: 300, height: 300, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [token("visible", "shared"), token("secret", "private", true), token("old", "legacy-secret", true)],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [] };
}

describe("asset entitlement / per-viewer manifest", () => {
  test("unreferenced new assets stay GM-only; visible refs grant parent and variants", () => {
    const world = emptyWorld();
    world.scenes.push(scene());
    const manifest: AssetManifest = {
      shared: { ...entry("shared", "referenced"), thumb: { assetId: "shared-thumb", width: 32, height: 32 } },
      "shared-thumb": entry("thumbnail", "referenced"),
      private: { ...entry("private", "referenced"), mid: { assetId: "private-mid", width: 60, height: 60 } },
      "private-mid": entry("mid", "referenced"),
      "legacy-secret": entry("legacy private"),
      "not-yet-used": entry("future art", "referenced"),
      "legacy-unused": entry("old loose asset"),
      published: entry("published", "world"),
      gm: entry("gm only", "gm"),
    };
    expect(Object.keys(projectAssetManifest(world, manifest, gm))).toHaveLength(9);
    expect(Object.keys(projectAssetManifest(world, manifest, player)).sort()).toEqual([
      "legacy-unused", "published", "shared", "shared-thumb",
    ]);
    for (const secret of ["private", "private-mid", "legacy-secret", "not-yet-used", "gm", "guessed"]) {
      expect(canFetchAsset(world, manifest, player, secret)).toBe(false);
    }
    const secretToken = world.scenes[0]?.tokens[1];
    if (!secretToken) throw new Error("fixture lost the hidden token");
    secretToken.hidden = false;
    expect(canFetchAsset(world, manifest, player, "private-mid")).toBe(true);
    expect(canFetchAsset(world, manifest, player, "gm")).toBe(false);
  });

  test("arbitrary text, tags and flags containing a hidden hash are not media entitlements", () => {
    const world = emptyWorld();
    const s = scene();
    const first = s.tokens[0];
    if (!first) throw new Error("fixture lost the first token");
    first.system = { randomNote: "private" };
    first.flags = { core: { notAnAsset: "private" }, tagger: { tags: ["private"] } };
    first.taggerTags = ["private"];
    world.scenes.push(s);
    const manifest: AssetManifest = {
      private: entry("private", "referenced"),
      "legacy-secret": entry("legacy"),
    };
    expect(projectAssetManifest(world, manifest, player)).toEqual({});
    // A declared media field in system is a valid extension point; a random string is not.
    first.system = { portrait: { img: "private" } };
    expect(canFetchAsset(world, manifest, player, "private")).toBe(true);
  });

  test("a GM-only persistent timeline never grants its media just because a private instance exists", () => {
    const world = emptyWorld();
    world.scenes.push(scene());
    world.macros.push({ _id: "secret-timeline", type: "macro", name: "GM cue", flags: {}, system: {},
      ownership: { default: 3 }, kind: "sequence", command: "", sequence: {
        version: 1, audience: "gm", persistent: true, sections: [
          { id: "a", kind: "image", at: { kind: "point", x: 20, y: 20 }, assetId: "secret-media",
            startMs: 0, durationMs: 500 },
        ],
      } });
    world.fxInstances.push({ _id: "private-run", type: "fxInstance", name: "GM cue",
      flags: {}, system: {}, ownership: { default: 3 }, sceneId: "scene", macroId: "secret-timeline",
      ownerId: "gm", audience: "gm", atHostTime: 1000, sections: [
        { id: "a", kind: "image", x: 20, y: 20, mime: "image/png", assetId: "secret-media",
          startMs: 0, durationMs: 500 },
      ] });
    const manifest: AssetManifest = { "secret-media": entry("private effects", "referenced") };
    expect(projectAssetManifest(world, manifest, player)).toEqual({});
    expect(canFetchAsset(world, manifest, player, "secret-media")).toBe(false);
    expect(projectAssetManifest(world, manifest, gm)["secret-media"]?.name).toBe("private effects");
    const authored = world.macros[0];
    if (!authored?.sequence) throw new Error("Missing authored timeline");
    authored.sequence.audience = "scene";
    expect(canFetchAsset(world, manifest, player, "secret-media")).toBe(true);
  });

  test("media a preset references is referenced — and a preset never reaches a player (D-310)", () => {
    const world = emptyWorld();
    world.scenes.push(scene());
    world.macros.push({ _id: "p-fire", type: "macro", name: "Fireball look", command: "",
      flags: {}, system: {}, ownership: { default: 0 }, kind: "fxPreset",
      preset: { version: 1, sections: [
        { id: "a", kind: "image", at: { kind: "point", x: 20, y: 20 }, assetId: "preset-media",
          startMs: 0, durationMs: 500 },
      ] } });
    const manifest: AssetManifest = { "preset-media": entry("preset art", "referenced") };
    // The preset is an authoring aid: the bytes are *referenced* by the world, so they are
    // not "loose legacy art" — and because the preset itself is never projected to a
    // player, that reference does not become theirs either. The GM sees both.
    expect(projectAssetManifest(world, manifest, player)).toEqual({});
    expect(canFetchAsset(world, manifest, player, "preset-media")).toBe(false);
    expect(projectAssetManifest(world, manifest, gm)["preset-media"]?.name).toBe("preset art");
    expect(canFetchAsset(world, manifest, gm, "preset-media")).toBe(true);
    // Deleting the preset releases the reference: the same asset, now unreferenced but
    // *new* (no visibility), stays GM-only exactly as before.
    world.macros.length = 0;
    expect(canFetchAsset(world, manifest, player, "preset-media")).toBe(false);
  });

  test("no scene ownership also hides a referenced asset even with public token", () => {
    const world = emptyWorld();
    const s = scene();
    s.ownership = { default: 0 };
    world.scenes.push(s);
    expect(projectAssetManifest(world, { shared: entry("shared", "referenced") }, player)).toEqual({});
  });
});
