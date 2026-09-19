/**
 * D-248 — a zip's kind is a property of the file. World files, ruleset packages and content
 * packs all end in `.zip`; the importers ask `classifyZip` before deciding what to do so a
 * package dropped on the world importer (or the reverse) is named, not failed cryptically.
 */
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { classifyZip, describePackage, packageKindLabel } from "../../src/host/zipKind";

const zipOf = (files: Record<string, string | Uint8Array>): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]),
    ),
  );

const worldHeader = { format: 2, worldId: "w-1", name: "Siege of Absalom", seq: 12 };
const rulesetManifest = {
  id: "pf1e-mass-battles",
  name: "PF1e Mass Battles",
  version: "1.0.0",
  type: "system",
  rules: { entry: "rules.js", modelColumns: { ac: "u8" } },
};
const contentManifest = {
  id: "pf1e-core",
  name: "PF1e Core",
  version: "1.0.0",
  type: "data",
  packs: [{ name: "Spells", type: "items", file: "packs/spells.json" }],
};

describe("classifyZip", () => {
  test("world.json at the root → world (name/id/format read off the header)", async () => {
    const kind = await classifyZip(
      zipOf({
        "world.json": JSON.stringify(worldHeader),
        "documents.json": "{}",
        "assets.json": "[]",
        // a world may EMBED packages (format 2) — those manifests do not make it a package
        "packages/pf1e-core/manifest.json": JSON.stringify(contentManifest),
      }),
    );
    // D-249: the sniff also reads the ruleset pin, the package index and the starter flag —
    // here none of them are present (no packages.json), which reads as "built-in, nothing embedded".
    expect(kind).toEqual({
      kind: "world",
      format: 2,
      worldId: "w-1",
      name: "Siege of Absalom",
      system: null,
      activeRules: null,
      packages: [],
      starter: false,
    });
  });

  test("manifest.json at the root → package, validated", async () => {
    const kind = await classifyZip(
      zipOf({ "manifest.json": JSON.stringify(rulesetManifest), "rules.js": "export default 1" }),
    );
    expect(kind.kind).toBe("package");
    if (kind.kind !== "package") return;
    expect(kind.manifest.id).toBe("pf1e-mass-battles");
    expect(kind.manifest.type).toBe("system");
    expect(describePackage(kind.manifest)).toBe("PF1e Mass Battles v1.0.0 (strategic ruleset)");
  });

  test("manifest.json inside one top-level folder → package (packageLoader's nested root)", async () => {
    const kind = await classifyZip(
      zipOf({
        "pf1e-core-1.0.0/manifest.json": JSON.stringify(contentManifest),
        "pf1e-core-1.0.0/packs/spells.json": "{}",
      }),
    );
    expect(kind.kind).toBe("package");
    if (kind.kind !== "package") return;
    expect(kind.manifest.type).toBe("data");
    expect(describePackage(kind.manifest)).toBe("PF1e Core v1.0.0 (content pack)");
  });

  test("two nested roots is not a package", async () => {
    const kind = await classifyZip(
      zipOf({
        "a/manifest.json": JSON.stringify(contentManifest),
        "b/manifest.json": JSON.stringify(rulesetManifest),
      }),
    );
    expect(kind.kind).toBe("unknown");
  });

  test("an invalid manifest reports the validator's reason", async () => {
    const kind = await classifyZip(
      zipOf({ "manifest.json": JSON.stringify({ ...rulesetManifest, id: "Bad Id" }) }),
    );
    expect(kind).toMatchObject({ kind: "unknown" });
    if (kind.kind === "unknown") expect(kind.reason).toContain("manifest.id");
  });

  test("neither marker, or not a zip at all → unknown with a reason", async () => {
    const neither = await classifyZip(zipOf({ "readme.txt": "hello" }));
    expect(neither).toMatchObject({ kind: "unknown" });
    if (neither.kind === "unknown") expect(neither.reason).toContain("neither a world file");
    const garbage = await classifyZip(new Uint8Array([1, 2, 3, 4, 5]));
    expect(garbage).toMatchObject({ kind: "unknown" });
    if (garbage.kind === "unknown") expect(garbage.reason).toContain("not a readable zip");
  });

  test("a world header without a worldId is not mistaken for a world", async () => {
    const kind = await classifyZip(zipOf({ "world.json": JSON.stringify({ format: 1 }) }));
    expect(kind).toMatchObject({ kind: "unknown" });
  });

  test("labels never leak the manifest's internal type words", () => {
    expect(packageKindLabel("system")).toBe("strategic ruleset");
    expect(packageKindLabel("data")).toBe("content pack");
  });
});
