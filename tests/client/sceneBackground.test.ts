import { describe, expect, test, vi } from "vitest";
import { SceneBackgroundPlayer } from "../../src/client/sceneBackground";
import type { AssetManifest } from "../../src/core/documents";

const manifest: AssetManifest = {
  a: { name: "a.png", mime: "image/png", size: 4, chunks: 1, thumb: { assetId: "thumb", width: 1, height: 1 } },
  b: { name: "b.jpg", mime: "image/jpeg", size: 4, chunks: 1 },
  thumb: { name: "thumb.webp", mime: "image/webp", size: 4, chunks: 1 },
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const pending: Array<{ hash: string; resolve: (bytes: Uint8Array) => void }> = [];
  const fetch = vi.fn((hash: string) => new Promise<Uint8Array>((resolve) => pending.push({ hash, resolve })));
  const view = { clearBackgroundImage: vi.fn(), setBackgroundImage: vi.fn<(bytes: Uint8Array, mime?: string) => Promise<void>>(async () => {}) };
  const player = new SceneBackgroundPlayer();
  const sync = (hash: string | null) => player.sync(hash, manifest, fetch, view);
  return { pending, fetch, view, player, sync };
}

describe("latest-scene-wins background fetch", () => {
  test("uses canonical thumbnail assetId and never downgrades full art to a late thumbnail", async () => {
    const f = fixture(); f.sync("a");
    expect(f.fetch.mock.calls.map(([hash]) => hash)).toEqual(["thumb", "a"]);
    f.pending[1]?.resolve(new Uint8Array([2])); await flush();
    f.pending[0]?.resolve(new Uint8Array([1])); await flush();
    expect(f.view.setBackgroundImage.mock.calls).toEqual([[new Uint8Array([2]), "image/png"]]);
  });
  test("early thumbnail is upgraded to full media and repeated sync does not fetch twice", async () => {
    const f = fixture(); f.sync("a"); f.sync("a");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.pending[0]?.resolve(new Uint8Array([1])); await flush();
    f.pending[1]?.resolve(new Uint8Array([2])); await flush();
    expect(f.view.setBackgroundImage.mock.calls.map((args) => args[1])).toEqual(["image/webp", "image/png"]);
  });
  test("switch, clear and destroy invalidate pending requests", async () => {
    const f = fixture(); f.sync("a"); f.sync("b");
    f.pending[0]?.resolve(new Uint8Array([1])); f.pending[1]?.resolve(new Uint8Array([2])); await flush();
    expect(f.view.setBackgroundImage).not.toHaveBeenCalled();
    f.sync(null);
    f.pending[2]?.resolve(new Uint8Array([3])); await flush();
    expect(f.view.setBackgroundImage).not.toHaveBeenCalled();
    expect(f.view.clearBackgroundImage).toHaveBeenCalledTimes(3);
    f.sync("b"); f.player.destroy();
    f.pending[3]?.resolve(new Uint8Array([4])); await flush();
    expect(f.view.setBackgroundImage).not.toHaveBeenCalled();
  });
  test("recreating the canvas with the same map still paints the new canvas", async () => {
    const f = fixture(); f.sync("b");
    const next = { clearBackgroundImage: vi.fn(), setBackgroundImage: vi.fn(async () => {}) };
    f.player.sync("b", manifest, f.fetch, next);
    f.pending[0]?.resolve(new Uint8Array([1])); f.pending[1]?.resolve(new Uint8Array([2])); await flush();
    expect(f.view.setBackgroundImage).not.toHaveBeenCalled();
    expect(next.setBackgroundImage).toHaveBeenCalledTimes(1);
  });
});
