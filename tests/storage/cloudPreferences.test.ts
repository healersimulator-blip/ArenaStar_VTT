import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  assertBackupSize,
  CLOUD_PREFS_KEY,
  loadCloudPreferences,
  saveCloudPreferences,
  validateBackupLimit,
} from "../../src/storage/cloud/preferences";
import { WORLD_ZIP_LIMITS, worldZipEntryLimit } from "../../src/host/worldZip";
import { sha256 } from "../../src/storage/cloud/googleDrive";
const MiB = 1048576;
afterEach(() => vi.unstubAllGlobals());
describe("GM backup size settings", () => {
  test("192 MiB worlds fit the default cloud/archive budgets; no fixed 64 MiB restriction", () => {
    expect(loadCloudPreferences().maxMiB).toBe(512);
    expect(() => assertBackupSize(192 * MiB, 512 * MiB)).not.toThrow();
    expect(WORLD_ZIP_LIMITS.maxArchiveBytes).toBe(1024 * MiB);
    expect(WORLD_ZIP_LIMITS.maxUncompressedBytes).toBe(2048 * MiB);
    expect(worldZipEntryLimit("assets/image.png")).toBe(512 * MiB);
    expect(worldZipEntryLimit("world.json")).toBe(MiB); // Preserve tight JSON/zip-bomb guards.
  });
  test("custom maximum persists locally and raises the restore budget too", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
    saveCloudPreferences({
      destination: "github",
      repository: "gm/backups",
      mode: "remembered",
      maxMiB: 2048,
    });
    expect(loadCloudPreferences().maxMiB).toBe(2048);
    expect(WORLD_ZIP_LIMITS.maxArchiveBytes).toBe(2048 * MiB);
    expect(WORLD_ZIP_LIMITS.maxUncompressedBytes).toBe(4096 * MiB);
    expect(values.get(CLOUD_PREFS_KEY)).not.toMatch(/token|secret|credential/);
    expect(() => assertBackupSize(193 * MiB, 192 * MiB)).toThrow("192 MiB");
  });
  test("zero removes the extra cloud cap, but not archive structural safety", () => {
    expect(() => assertBackupSize(1536 * MiB, 0)).not.toThrow();
    expect(() => assertBackupSize(-1, 0)).toThrow();
    expect(() => validateBackupLimit(NaN)).toThrow();
    expect(() => validateBackupLimit(-1)).toThrow();
    expect(() => validateBackupLimit(2049)).toThrow();
    expect(() => validateBackupLimit(2.5)).toThrow();
  });
  test("corrupt/blocked storage falls back safely", () => {
    vi.stubGlobal("localStorage", { getItem: () => '{"maxMiB":-10}' });
    expect(loadCloudPreferences().maxMiB).toBe(512);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw Error("denied");
      },
      setItem: () => {
        throw Error("denied");
      },
    });
    expect(() => saveCloudPreferences(loadCloudPreferences())).not.toThrow();
  });
  test("large hashes use bounded slices, not a second full-archive buffer; cancellation stops hashing", async () => {
    const bytes = new Uint8Array(9 * MiB).fill(57);
    const blob = new Blob([bytes]);
    vi.spyOn(blob, "arrayBuffer").mockRejectedValue(
      Error("must not buffer full archive"),
    );
    expect(await sha256(blob)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const abort = new AbortController();
    abort.abort();
    await expect(sha256(blob, abort.signal)).rejects.toThrow();
  });
});
