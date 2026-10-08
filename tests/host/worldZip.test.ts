import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  assertWorldZipEntriesWithinLimits,
  extractZipEntriesBounded,
  WORLD_ZIP_LIMITS,
} from "../../src/host/worldZip";

const limits = (patch: Partial<typeof WORLD_ZIP_LIMITS>) => ({
  ...WORLD_ZIP_LIMITS,
  ...patch,
});
const extractionOptions = (patch: Partial<typeof WORLD_ZIP_LIMITS>) => ({
  limits: limits(patch),
});
const overwriteDeclaredUncompressedSize = (
  source: Uint8Array,
  size: number,
): Uint8Array => {
  const archive = source.slice();
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  for (let offset = 0; offset + 30 < archive.byteLength; offset++) {
    if (
      archive[offset] === 0x50 &&
      archive[offset + 1] === 0x4b &&
      archive[offset + 2] === 0x03 &&
      archive[offset + 3] === 0x04
    )
      view.setUint32(offset + 22, size, true);
    else if (
      archive[offset] === 0x50 &&
      archive[offset + 1] === 0x4b &&
      archive[offset + 2] === 0x01 &&
      archive[offset + 3] === 0x02
    )
      view.setUint32(offset + 24, size, true);
  }
  return archive;
};

describe("bounded World ZIP extraction", () => {
  test("reads normal ZIP entries and enforces the shared export size policy", async () => {
    const input = zipSync({ "documents.json": strToU8("{}") });
    const extracted = await extractZipEntriesBounded(input);
    expect(new TextDecoder().decode(extracted.get("documents.json"))).toBe(
      "{}",
    );

    expect(() =>
      assertWorldZipEntriesWithinLimits(
        [{ path: "documents.json", bytes: strToU8("x".repeat(32)) }],
        limits({ maxEntryBytes: 16 }),
      ),
    ).toThrow(/per-entry size limit/);
  });

  test("rejects compressed archives above the input limit before scanning", async () => {
    const input = zipSync({ "world.json": strToU8("{}") });
    await expect(
      extractZipEntriesBounded(
        input,
        extractionOptions({ maxArchiveBytes: input.byteLength - 1 }),
      ),
    ).rejects.toThrow(/compressed-size limit/);
  });

  test("rejects oversized declared entries and aggregate expansion", async () => {
    const single = zipSync({ "asset.bin": new Uint8Array(20) });
    await expect(
      extractZipEntriesBounded(
        single,
        extractionOptions({ maxEntryBytes: 19 }),
      ),
    ).rejects.toThrow(/per-entry size limit/);

    const multiple = zipSync({
      "one.bin": new Uint8Array(6),
      "two.bin": new Uint8Array(6),
    });
    await expect(
      extractZipEntriesBounded(
        multiple,
        extractionOptions({ maxEntryBytes: 8, maxUncompressedBytes: 11 }),
      ),
    ).rejects.toThrow(/aggregate uncompressed-size limit/);
  });

  test("enforces actual output size when ZIP headers under-report it", async () => {
    const wellFormed = zipSync({
      "payload.bin": new Uint8Array(32).fill(5),
    });
    const understated = overwriteDeclaredUncompressedSize(wellFormed, 4);
    await expect(
      extractZipEntriesBounded(
        understated,
        extractionOptions({ maxEntryBytes: 32, maxUncompressedBytes: 32 }),
      ),
    ).rejects.toThrow(/mismatched uncompressed size/);
  });

  test("rejects too many entries and unsafe archive paths", async () => {
    const twoFiles = zipSync({
      "one.bin": strToU8("1"),
      "two.bin": strToU8("2"),
    });
    await expect(
      extractZipEntriesBounded(twoFiles, extractionOptions({ maxEntries: 1 })),
    ).rejects.toThrow(/more than 1 entries/);

    const traversal = zipSync({ "../escape.json": strToU8("{}") });
    await expect(extractZipEntriesBounded(traversal)).rejects.toThrow(
      /unsafe entry path/,
    );
  });

  test("rejects non-ZIP input instead of treating it as an empty archive", async () => {
    await expect(
      extractZipEntriesBounded(strToU8("not a zip")),
    ).rejects.toThrow(/not a readable zip/);
  });
});
