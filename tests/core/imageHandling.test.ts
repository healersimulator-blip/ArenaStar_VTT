import { describe, expect, test } from "vitest";
import {
  DEFAULT_IMAGE_HANDLING_PREFERENCES,
  DEFAULT_SCENE_EXPRESS_DEFAULTS,
  derivedAssetIds,
  imageHandlingPreferencesKey,
  imageHandlingPreferencesOf,
  loadImageHandlingPreferences,
  saveImageHandlingPreferences,
  sceneExpressDefaultsOf,
  uniqueLogicalFileName,
} from "../../src/core/imageHandling";
import { playerUploadQuotaMBOf } from "../../src/core/imageHandling";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

describe("image workflow preferences and world defaults", () => {
  test("defaults preserve files, use Store URLs and set the requested destinations", () => {
    expect(DEFAULT_IMAGE_HANDLING_PREFERENCES).toMatchObject({
      dropEnabled: true,
      pasteEnabled: true,
      defaultAction: "newScene",
      rememberLastAction: true,
      defaultShareToPlayers: false,
      webpConvert: false,
      webpQuality: 0.8,
      urlMode: "store",
      autoCreateJournal: true,
      autoCreateJournalName: "mini-uploader",
    });
    expect(DEFAULT_SCENE_EXPRESS_DEFAULTS).toMatchObject({
      enabled: true,
      destinationLogicalFolder: "Scenes",
      duplicateFileBehavior: "stop",
      duplicateSceneBehavior: "stop",
      gridType: "square",
      gridSize: 100,
      ownership: "gm",
      activateImmediately: false,
    });
  });

  test("preferences are isolated by world and user and persist normalized values", () => {
    const local = storage();
    expect(imageHandlingPreferencesKey("world one", "user/a")).toBe("vtt:image-handling:world%20one:user%2Fa");
    const saved = saveImageHandlingPreferences("world one", "user/a", {
      ...DEFAULT_IMAGE_HANDLING_PREFERENCES,
      defaultAction: "journalPage",
      lastUsedAction: "tileFit",
      rememberLastAction: true,
      uploadFolderHistory: ["Maps", "Scenes"],
      dialogWindowSizes: { width: 400, height: 2000 },
      webpConvert: true,
      webpQuality: 5,
      urlMode: "link",
    }, local);
    expect(saved.dialogWindowSizes).toEqual({ width: 420, height: 1400 });
    expect(saved.webpQuality).toBe(1);
    expect(loadImageHandlingPreferences("world one", "user/a", local)).toEqual(saved);
    expect(loadImageHandlingPreferences("world one", "other-user", local).defaultAction).toBe("newScene");
    expect(loadImageHandlingPreferences("another-world", "user/a", local).defaultAction).toBe("newScene");
  });

  test("corrupt client preferences and world defaults fall back to bounded safe values", () => {
    const prefs = imageHandlingPreferencesOf({
      defaultAction: "run-script",
      lastUsedAction: "run-script",
      uploadFolderHistory: Array.from({ length: 20 }, (_, index) => `Folder ${index}`),
      autoCreateJournalName: "",
      dialogWindowSizes: { width: Number.NaN, height: 0 },
      webpQuality: Number.NaN,
      urlMode: "ftp",
    });
    expect(prefs.defaultAction).toBe("newScene");
    expect(prefs.lastUsedAction).toBeNull();
    expect(prefs.uploadFolderHistory).toHaveLength(10);
    expect(prefs.autoCreateJournalName).toBe("mini-uploader");
    expect(prefs.dialogWindowSizes).toEqual({ width: 760, height: 420 });
    expect(prefs.webpQuality).toBe(0.8);
    expect(prefs.urlMode).toBe("store");

    expect(sceneExpressDefaultsOf({ gridType: "gridless", gridSize: 4, duplicateFileBehavior: "danger" }))
      .toMatchObject({ gridType: "gridless", gridSize: 50, duplicateFileBehavior: "stop", ownership: "gm" });
    expect(sceneExpressDefaultsOf({ gridType: "hex", gridSize: 5000, duplicateFileBehavior: "ask" }))
      .toMatchObject({ gridType: "hex", gridSize: 1000, duplicateFileBehavior: "ask", duplicateSceneBehavior: "ask" });
    expect(sceneExpressDefaultsOf({ duplicateFileBehavior: "overwrite", duplicateSceneBehavior: "reuse" }))
      .toMatchObject({ duplicateFileBehavior: "overwrite", duplicateSceneBehavior: "reuse" });
    // Settings saved before the two collision policies were split keep their prior behavior.
    expect(sceneExpressDefaultsOf({ duplicateFileBehavior: "overwrite" }).duplicateSceneBehavior).toBe("overwrite");
  });

  test("new logical names are allocated independently per folder", () => {
    const manifest = {
      a: { name: "a.png", mime: "image/png", size: 4, chunks: 1, logicalFiles: [{ folder: "Maps", name: "Dungeon" }] },
      b: { name: "b.png", mime: "image/png", size: 4, chunks: 1, logicalFiles: [{ folder: "Maps", name: "Dungeon (2)" }] },
    };
    expect(uniqueLogicalFileName("Dungeon", "Maps", manifest)).toBe("Dungeon (3)");
    expect(uniqueLogicalFileName("Dungeon", "Actors", manifest)).toBe("Dungeon");
  });

  test("quota is unlimited when unset, but accepts any configured nonnegative value", () => {
    expect(playerUploadQuotaMBOf({})).toBeNull();
    expect(playerUploadQuotaMBOf({ playerUploadQuotaMB: null })).toBeNull();
    expect(playerUploadQuotaMBOf({ playerUploadQuotaMB: 0 })).toBe(0);
    expect(playerUploadQuotaMBOf({ playerUploadQuotaMB: 0.25 })).toBe(0.25);
    expect(playerUploadQuotaMBOf({ playerUploadQuotaMB: -1 })).toBeNull();
  });
});

describe("derived image variants are not separate picker choices", () => {
  test("thumbnails, mid-res copies and tiles are listed as derived; originals are not", () => {
    const original = "a".repeat(64);
    const thumb = "b".repeat(64);
    const mid = "c".repeat(64);
    const tile = "d".repeat(64);
    const plain = "e".repeat(64);
    const entry = (name: string) => ({ name, mime: "image/png", size: 1, visibility: "referenced" as const, createdAt: 0 });
    const manifest = {
      [original]: { ...entry("map.png"), thumb: { assetId: thumb, width: 1, height: 1 }, mid: { assetId: mid, width: 1, height: 1 },
        tiles: { size: 1024, cols: 1, rows: 1, ids: [tile] } },
      [thumb]: entry("map.png#thumb"),
      [mid]: entry("map.png#mid"),
      [tile]: entry("map.png#tile0"),
      [plain]: entry("standalone.png"),
    } as unknown as Parameters<typeof derivedAssetIds>[0];
    expect([...derivedAssetIds(manifest)].sort()).toEqual([thumb, mid, tile].sort());
    expect(derivedAssetIds(manifest).has(original)).toBe(false);
    expect(derivedAssetIds(manifest).has(plain)).toBe(false);
  });
});
