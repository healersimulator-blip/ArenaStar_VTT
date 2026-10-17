import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { readZipPackage } from "../../src/packages/packageLoader";

function archive(
  root: string,
  manifestName: string,
  packFiles: Record<string, Uint8Array>,
) {
  const manifest = {
    id: "probe",
    title: "Probe",
    version: "1.0.0",
    packs: [{ name: "items", type: "Item", path: "packs/items" }],
  };
  return zipSync({
    [root + manifestName]: strToU8(JSON.stringify(manifest)),
    ...Object.fromEntries(
      Object.entries(packFiles).map(([path, bytes]) => [root + path, bytes]),
    ),
  });
}
describe("Foundry pack storage admission", () => {
  test.each(["", "release/", "release/deep/"])(
    "rejects LevelDB consistently at archive root %s",
    async (root) => {
      const result = await readZipPackage(
        archive(root, "module.json", {
          "packs/items/000001.ldb": new Uint8Array([
            255,
            ...strToU8('{"_id":"old","name":"Deleted"}'),
          ]),
          "packs/items/CURRENT": strToU8("MANIFEST-000002\n"),
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/LevelDB.*snapshot/);
    },
  );
  test("recognizes even UTF-8-decodable WAL/manifest files, rather than scanning old values", async () => {
    const result = await readZipPackage(
      archive("release/", "public/system.json", {
        "packs/items/000001.log": strToU8('{"_id":"old","name":"Stale"}'),
      }),
    );
    expect(result.ok).toBe(false);
  });
  test.each(["", "release/"])(
    "preserves split JSON exports under %s",
    async (root) => {
      const result = await readZipPackage(
        archive(root, "module.json", {
          "packs/items/fireball.json": strToU8(
            '{"_id":"fireball","name":"Fireball"}',
          ),
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.value.files["packs/items/fireball.json"]).toContain(
          "Fireball",
        );
    },
  );
});
