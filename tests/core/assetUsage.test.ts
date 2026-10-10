import { describe, expect, it } from "vitest";
import type { AssetManifest, AssetManifestEntry } from "../../src/core/documents";
import { assetLibrary, assetUsageRoots, closeOverDerived, referencedAssetIds, unusedAssetIds } from "../../src/core/assetUsage";

const h = (c: string) => c.repeat(64);
const entry = (name: string, extra: Partial<AssetManifestEntry> = {}): AssetManifestEntry => ({
  name, mime: "image/png", size: 100, chunks: 1, ...extra,
});

describe("§6.8 asset usage", () => {
  const main = h("a");
  const thumb = h("b");
  const orphan = h("c");
  const manifest: AssetManifest = {
    [main]: entry("map", { thumb: { assetId: thumb, width: 256, height: 128 } }),
    [thumb]: entry("map-thumb"),
    [orphan]: entry("replaced-background"),
  };

  it("finds an asset hash anywhere in a nested document, but only for manifest keys", () => {
    const scene = { scenes: { s1: { img: main, tiles: [{ img: "not-a-hash" }], notes: { deep: [{ x: h("9") }] } } } };
    expect([...referencedAssetIds([scene], manifest)]).toEqual([main]);
  });

  it("keeps a derived thumbnail of a live asset, even though no document names it", () => {
    const used = closeOverDerived(referencedAssetIds([{ img: main }], manifest), manifest);
    expect(used.has(thumb)).toBe(true);
    expect(used.has(orphan)).toBe(false);
  });

  it("counts only live documents: an image a replaced background left behind is unused", () => {
    expect(unusedAssetIds(manifest, [{ img: main }])).toEqual([orphan]);
    expect(unusedAssetIds(manifest, [{ img: orphan }])).toEqual([main, thumb].sort());
  });

  it("a derived variant is unused together with its unused parent", () => {
    const parentOnly = { img: orphan };
    const unused = unusedAssetIds(manifest, [parentOnly]);
    expect(unused.sort()).toEqual([main, thumb].sort());
  });

  it("returns a stable, named library with usage and derived flags", () => {
    const lib = assetLibrary(manifest, [{ img: main }]);
    expect(lib.map((item) => item.name)).toEqual(["map", "map-thumb", "replaced-background"]);
    expect(lib.find((item) => item.hash === main)).toMatchObject({ inUse: true, derived: false });
    expect(lib.find((item) => item.hash === thumb)).toMatchObject({ inUse: true, derived: true });
    expect(lib.find((item) => item.hash === orphan)).toMatchObject({ inUse: false, derived: false });
  });

  it("does not count an upload audit message's recorded hash as a use", () => {
    const collections = {
      assetManifest: manifest,
      messages: {
        audit: { _id: "audit", system: { auditKind: "image-upload", auditStatus: "stored", assetId: orphan, preparedHash: thumb } },
        chat: { _id: "chat", system: { note: "no image here" } },
      },
      scenes: { s1: { img: main } },
    };
    const roots = assetUsageRoots(collections);
    expect([...referencedAssetIds(roots, manifest)]).toEqual([main]);
  });

  it("tolerates cyclic documents without looping", () => {
    const doc: Record<string, unknown> = { img: main };
    doc.self = doc;
    expect([...referencedAssetIds([doc], manifest)]).toEqual([main]);
  });

  it("ignores typed-array payloads rather than walking their bytes", () => {
    const doc = { bytes: new Uint8Array(16), img: orphan };
    expect([...referencedAssetIds([doc], manifest)]).toEqual([orphan]);
  });
});
