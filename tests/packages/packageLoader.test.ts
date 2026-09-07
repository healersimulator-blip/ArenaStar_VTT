import { describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import { buildPackageFromFiles, readZipPackage } from "../../src/packages/packageLoader";
import { isSafePackagePath, validatePackageManifest } from "../../src/core/packageManifest";
import type { PackageManifest } from "../../src/core/packageManifest";

const systemManifest = (over: Record<string, unknown> = {}): PackageManifest =>
  ({
    id: "probe-rules",
    name: "Probe Rules",
    version: "1.2.3",
    type: "system",
    rules: { entry: "rules.js", modelColumns: { ammo: "u8", morale: "f32" } },
    ...over,
  }) as PackageManifest;

const RULES_JS =
  "export default { schema: { version: '1.2.3', modelColumns: { ammo: 'u8', morale: 'f32' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] }, validateOrder(){ return {ok:true}; }, resolveTurn(){}, detection(){ return 5; } };";

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

describe("validatePackageManifest (§12)", () => {
  test("accepts system and data manifests", () => {
    const sys = validatePackageManifest(systemManifest());
    expect(sys.ok).toBe(true);
    const data = validatePackageManifest(
      systemManifest({
        id: "tables-pkg",
        type: "data",
        rules: undefined,
        packs: [{ name: "lines", type: "tables", file: "packs/lines.json" }],
      }),
    );
    expect(data.ok).toBe(true);
  });

  test("rejects bad ids, names, versions, types", () => {
    expect(validatePackageManifest(systemManifest({ id: "Bad_ID" })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ id: "x" })).ok).toBe(false); // too short
    expect(validatePackageManifest(systemManifest({ name: "" })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ version: "one" })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ type: "module" as "system" })).ok).toBe(false);
    expect(validatePackageManifest(null).ok).toBe(false);
  });

  test("system needs a valid rules block; data must not declare one", () => {
    const noRules = validatePackageManifest(systemManifest({ rules: undefined }));
    expect(noRules.ok).toBe(false);
    if (noRules.ok) return;
    expect(noRules.error).toContain("rules block");
    const badEntry = validatePackageManifest(
      systemManifest({ rules: { entry: "../escape.js", modelColumns: {} } }),
    );
    expect(badEntry.ok).toBe(false);
    const badCol = validatePackageManifest(
      systemManifest({ rules: { entry: "rules.js", modelColumns: { ammo: "bytes" as "u8" } } }),
    );
    expect(badCol.ok).toBe(false);
    if (badCol.ok) return;
    expect(badCol.error).toContain("ammo");
    const dataWithRules = validatePackageManifest(systemManifest({ type: "data", packs: [] }));
    expect(dataWithRules.ok).toBe(false);
    if (dataWithRules.ok) return;
    expect(dataWithRules.error).toContain("data-only");
  });

  test("system packages may declare an iframe module entry; data may not", () => {
    const withModule = validatePackageManifest(systemManifest({ module: { entry: "module.js" } }));
    expect(withModule.ok).toBe(true);
    if (withModule.ok) expect(withModule.value.module?.entry).toBe("module.js");
    const badPath = validatePackageManifest(systemManifest({ module: { entry: "../x.js" } }));
    expect(badPath.ok).toBe(false);
    const dataModule = validatePackageManifest(
      systemManifest({ type: "data", rules: undefined, module: { entry: "m.js" } }),
    );
    expect(dataModule.ok).toBe(false);
    if (dataModule.ok) return;
    expect(dataModule.error).toContain("module block");
  });

  test("module.trusted is a validated boolean request flag", () => {
    const trusted = validatePackageManifest(
      systemManifest({ module: { entry: "m.js", trusted: true } }),
    );
    expect(trusted.ok).toBe(true);
    if (trusted.ok) expect(trusted.value.module?.trusted).toBe(true);
    const untrusted = validatePackageManifest(
      systemManifest({ module: { entry: "m.js", trusted: false } }),
    );
    expect(untrusted.ok).toBe(true);
    if (untrusted.ok) expect(untrusted.value.module?.trusted).toBe(false);
    const bad = validatePackageManifest(
      systemManifest({ module: { entry: "m.js", trusted: "yes" as unknown as boolean } }),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toContain("module.trusted");
  });

  test("path guard blocks traversal and absolute paths", () => {
    expect(isSafePackagePath("a/b/c.js")).toBe(true);
    expect(isSafePackagePath("../a.js")).toBe(false);
    expect(isSafePackagePath("a/../../b.js")).toBe(false);
    expect(isSafePackagePath("/abs.js")).toBe(false);
    expect(isSafePackagePath("a//b.js")).toBe(false);
    expect(isSafePackagePath("")).toBe(false);
  });
});

describe("readZipPackage / buildPackageFromFiles (§12)", () => {
  test("system zip: manifest + entry land in the record", async () => {
    const res = await readZipPackage(
      zipOf({ "manifest.json": JSON.stringify(systemManifest()), "rules.js": RULES_JS }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.manifest.id).toBe("probe-rules");
    expect(res.value.files["rules.js"]).toBe(RULES_JS);
  });

  test("nested single root directory is tolerated", async () => {
    const res = await readZipPackage(
      zipOf({
        "probe-pkg/manifest.json": JSON.stringify(systemManifest()),
        "probe-pkg/rules.js": RULES_JS,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.files["rules.js"]).toBe(RULES_JS);
  });

  test("data zip with packs: pack files must exist and be JSON", async () => {
    const manifest = systemManifest({
      id: "tables-pkg",
      type: "data",
      rules: undefined,
      packs: [{ name: "lines", type: "tables", file: "packs/lines.json" }],
    });
    const okRes = await readZipPackage(
      zipOf({ "manifest.json": JSON.stringify(manifest), "packs/lines.json": "[1,2,3]" }),
    );
    expect(okRes.ok).toBe(true);
    const missing = await readZipPackage(zipOf({ "manifest.json": JSON.stringify(manifest) }));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toContain("pack file");
    const badJson = await readZipPackage(
      zipOf({ "manifest.json": JSON.stringify(manifest), "packs/lines.json": "{nope" }),
    );
    expect(badJson.ok).toBe(false);
    if (badJson.ok) return;
    expect(badJson.error).toContain("not valid JSON");
  });

  test("missing manifest, missing entry, bad manifest JSON surface specific errors", async () => {
    const noManifest = await readZipPackage(zipOf({ "rules.js": RULES_JS }));
    expect(noManifest.ok).toBe(false);
    if (noManifest.ok) return;
    expect(noManifest.error).toContain("manifest.json not found");

    const noEntry = await readZipPackage(
      zipOf({ "manifest.json": JSON.stringify(systemManifest()) }),
    );
    expect(noEntry.ok).toBe(false);
    if (noEntry.ok) return;
    expect(noEntry.error).toContain("rules entry rules.js is missing");

    const badJson = await readZipPackage(zipOf({ "manifest.json": "{{{" }));
    expect(badJson.ok).toBe(false);
    if (badJson.ok) return;
    expect(badJson.error).toContain("not valid JSON");

    const notZip = await readZipPackage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(notZip.ok).toBe(false);
  });

  test("module entry file must exist in the package", async () => {
    const res = await readZipPackage(
      zipOf({
        "manifest.json": JSON.stringify(systemManifest({ module: { entry: "module.js" } })),
        "rules.js": RULES_JS,
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("module entry module.js is missing");
    const good = await readZipPackage(
      zipOf({
        "manifest.json": JSON.stringify(systemManifest({ module: { entry: "module.js" } })),
        "rules.js": RULES_JS,
        "module.js": "ui.notifications.notify('hi');",
      }),
    );
    expect(good.ok).toBe(true);
  });

  test("folder import path shares validation", () => {
    const res = buildPackageFromFiles({
      "manifest.json": JSON.stringify(systemManifest()),
      "rules.js": RULES_JS,
    });
    expect(res.ok).toBe(true);
    const res2 = buildPackageFromFiles({ "readme.md": "hi" });
    expect(res2.ok).toBe(false);
    if (res2.ok) return;
    expect(res2.error).toContain("manifest.json not found");
  });
});
