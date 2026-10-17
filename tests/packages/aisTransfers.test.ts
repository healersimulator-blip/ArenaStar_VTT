import "fake-indexeddb/auto";
import { describe, expect, test, vi } from "vitest";
import {
  createAisModuleHandlers,
  type AisModuleHandlerContext,
} from "../../src/packages/aisModuleHandlers";
import { createAisAssetSource } from "../../src/packages/aisAssetSource";
import type { AssetManifest } from "../../src/core/documents";
import { openVttDb } from "../../src/storage/idb";

async function context(
  extra: Partial<AisModuleHandlerContext> = {},
): Promise<AisModuleHandlerContext> {
  return {
    worldId: "transfers",
    packageId: "probe",
    emittedEvents: [],
    db: await openVttDb(),
    user: () => ({ id: "gm", name: "GM" }),
    activeScene: () => null,
    actorById: () => undefined,
    select: async () => null,
    notify: () => undefined,
    emitModuleEvent: () => undefined,
    busEmit: () => undefined,
    newId: () => "new",
    submit: () => "tx",
    assertCapability: async () => undefined,
    ...extra,
  };
}

describe("bounded AIS transfers", () => {
  test.each(["a", "Ж", "😀", "\u0000", '"\\'])(
    "resource JSON chunks roundtrip expanded characters %j",
    async (character) => {
      const text = character.repeat(50000);
      const ctx = await context({ resources: { "lang.json": text } });
      const handler = createAisModuleHandlers(ctx)["package.resource.read"];
      let offset = 0;
      const chunks: string[] = [];
      for (;;) {
        const row = (await handler({ path: "lang.json", offset })) as {
          text: string;
          next: number | null;
        };
        expect(
          new TextEncoder().encode(JSON.stringify(row)).length,
        ).toBeLessThan(64 * 1024);
        chunks.push(row.text);
        if (row.next === null) break;
        expect(row.next).toBeGreaterThan(offset);
        offset = row.next;
      }
      expect(chunks.join("")).toBe(text);
      ctx.db.close();
    },
  );
  test("settings preserve metadata, page by byte budget, and offer compact values explicitly", async () => {
    const declarations = Array.from({ length: 10 }, (_, i) => ({
      key: `setting${i}`,
      label: "Large",
      scope: "world" as const,
      type: "string" as const,
      default: "ж".repeat(8000),
      maxLength: 16384,
      hidden: true,
    }));
    const ctx = await context({
      settings: {
        declarations,
        packageName: "Probe",
        worldDoc: () => undefined,
        canWriteWorld: () => true,
      },
    });
    const handler = createAisModuleHandlers(ctx)["settings.list"];
    let offset = 0;
    const keys: string[] = [];
    for (;;) {
      const page = (await handler({ offset })) as {
        settings: Array<{ key: string; hidden: boolean; default: string }>;
        next?: number;
      };
      expect(
        new TextEncoder().encode(JSON.stringify(page)).length,
      ).toBeLessThan(64 * 1024);
      expect(
        page.settings.every((row) => row.hidden && row.default.length === 8000),
      ).toBe(true);
      keys.push(...page.settings.map((row) => row.key));
      if (page.next === undefined) break;
      expect(page.next).toBeGreaterThan(offset);
      offset = page.next;
    }
    expect(keys).toEqual(declarations.map((row) => row.key));
    const compact = (await handler({ compact: true })) as {
      settings: unknown[];
    };
    expect(compact.settings[0]).toEqual({
      key: "setting0",
      value: declarations[0]?.default,
    });
    await expect(handler({ offset: -1 })).rejects.toThrow(/offset/);
    ctx.db.close();
  });
  test("shared asset source uses normal storage/transfer, caches immutable bytes, and rechecks entitlement", async () => {
    const hash = "a".repeat(64);
    let manifest: AssetManifest = {
      [hash]: { name: "Icon", mime: "image/png", size: 4, chunks: 1 },
    };
    const read = vi.fn(async () => new Uint8Array([0, 127, 128, 255]));
    const source = createAisAssetSource(() => manifest, read);
    const first = await source.assetBytes?.(hash);
    expect(first).toEqual({ base64: "AH+A/w==", mime: "image/png" });
    expect(await source.assetBytes?.(hash)).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);
    manifest = {};
    expect(await source.assetBytes?.(hash)).toBeNull();
    expect(await source.assets?.()).toEqual({});
  });
});

test("world compendium browse pages are complete beyond the search cap and remain pack-scoped", async () => {
  const pack = {
    name: "Spells",
    type: "items" as const,
    entries: Array.from({ length: 240 }, (_, i) => ({
      id: `spell-${i}`,
      name: `Spell ${i}`,
      data: { type: "spell", name: `Spell ${i}` },
    })),
  };
  const ctx = await context({
    compendia: async () => [
      { packageId: "pf1", packFile: "packs/spells.json", pack },
    ],
  });
  const handler = createAisModuleHandlers(ctx)["compendium.search"];
  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const row = (await handler({
      query: "",
      browse: true,
      packId: "pf1/packs/spells.json",
      offset,
      limit: 100,
    })) as {
      hits: Array<{ entryId: string }>;
      next: number | null;
    };
    ids.push(...row.hits.map((hit) => hit.entryId));
    if (row.next === null) break;
    offset = row.next;
  }
  expect(ids).toEqual(pack.entries.map((entry) => entry.id));
  await expect(handler({ query: "", browse: true })).rejects.toThrow(
    /one packId/,
  );
  ctx.db.close();
});
