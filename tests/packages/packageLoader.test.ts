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
  test("accepts system, data, and independent AIS module manifests", () => {
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
    const module = validatePackageManifest({
      id: "condition-mod",
      name: "Condition Mod",
      version: "1.0.0",
      type: "module",
      interconnect: {
        api: "arena.ais/1",
        entry: "automation/entry.js",
        requires: [{ id: "pf1e-core", version: "2.0.0" }],
        provides: [{ id: "pf1e.damage.resolve", mode: "exclusive", contract: 1 }],
        commands: [{ id: "torch.toggle", contract: 1 }],
        emits: ["torch.changed"],
        capabilities: ["scene.read.visible", "action.observe", "event.emit"],
      },
    });
    expect(module.ok).toBe(true);
    if (module.ok) expect(module.value.interconnect).toMatchObject({
      entry: "automation/entry.js",
      commands: [{ id: "torch.toggle", contract: 1 }],
      emits: ["torch.changed"],
    });
  });

  test("rejects unknown AIS fields, invalid capabilities, and non-exact dependency versions", () => {
    const moduleManifest = {
      id: "strict-module",
      name: "Strict Module",
      version: "1.0.0",
      type: "module",
      interconnect: { api: "arena.ais/1", entry: "module.js", capabilities: ["action.observe"] },
    };
    expect(validatePackageManifest({ ...moduleManifest, interconnect: { ...moduleManifest.interconnect, typo: true } }).ok).toBe(false);
    expect(validatePackageManifest({
      ...moduleManifest,
      interconnect: { ...moduleManifest.interconnect, capabilities: ["world.write"] },
    }).ok).toBe(false);
    expect(validatePackageManifest({
      ...moduleManifest,
      interconnect: { ...moduleManifest.interconnect, requires: [{ id: "other-module", version: "^1.0.0" }] },
    }).ok).toBe(false);
  });

  test("validates declared macro commands and custom event capabilities", () => {
    const base = {
      id: "typed-module", name: "Typed Module", version: "1.0.0", type: "module",
      interconnect: { api: "arena.ais/1", entry: "module.js", capabilities: ["action.observe"] },
    };
    expect(validatePackageManifest({ ...base, interconnect: {
      ...base.interconnect, emits: ["torch.changed"],
    } })).toMatchObject({ ok: false, error: "package typed-module: interconnect.emits requires the event.emit capability" });
    expect(validatePackageManifest({ ...base, interconnect: {
      ...base.interconnect, commands: [{ id: "toggle", contract: 1 }, { id: "toggle", contract: 1 }],
    } }).ok).toBe(false);
    expect(validatePackageManifest({ ...base, interconnect: {
      ...base.interconnect, commands: [{ id: "../toggle", contract: 1 }],
    } }).ok).toBe(false);
  });

  test("D-469: sharing and tokenActions are validated and normalized", () => {
    const base = {
      id: "typed-module", name: "Typed Module", version: "1.0.0", type: "module",
      interconnect: { api: "arena.ais/1", entry: "module.js", capabilities: ["action.observe", "ui.interaction"] },
    };
    const ok = validatePackageManifest({ ...base, interconnect: {
      ...base.interconnect, sharing: "host-only", tokenActions: [{ id: "mount", label: "  Mount up  " }, { id: "dismount", label: "Dismount" }],
    } });
    expect(ok).toMatchObject({ ok: true, value: { interconnect: {
      sharing: "host-only", tokenActions: [{ id: "mount", label: "Mount up" }, { id: "dismount", label: "Dismount" }],
    } } });
    // Absent by default — a module that says nothing is shareable and adds no menu entries.
    const plain = validatePackageManifest(base);
    expect(plain.ok && plain.value.type === "module" ? plain.value.interconnect?.sharing : "set").toBeUndefined();
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, sharing: "everyone" } }))
      .toMatchObject({ ok: false, error: 'package typed-module: interconnect.sharing must be "players" or "host-only"' });
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, tokenActions: [{ id: "a", label: "A", icon: "x" }] } }).ok).toBe(false);
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, tokenActions: [{ id: "mount", label: "" }] } }).ok).toBe(false);
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, tokenActions: [{ id: "mount", label: "M" }, { id: "mount", label: "N" }] } }).ok).toBe(false);
    expect(validatePackageManifest({ ...base, interconnect: {
      ...base.interconnect, capabilities: ["action.observe"], tokenActions: [{ id: "mount", label: "Mount" }],
    } })).toMatchObject({ ok: false, error: "package typed-module: interconnect.tokenActions requires the ui.interaction capability" });
  });

  test("D-470: interconnect.panel is bounded, defaulted and tied to the ui.panel capability", () => {
    const base = {
      id: "typed-module", name: "Typed Module", version: "1.0.0", type: "module",
      interconnect: { api: "arena.ais/1", entry: "module.js", capabilities: ["ui.panel"] },
    };
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, panel: { title: " Loot " } } }))
      .toMatchObject({ ok: true, value: { interconnect: { panel: { title: "Loot", width: 360, height: 420 } } } });
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, panel: { title: "Loot", width: 480, height: 160 } } }))
      .toMatchObject({ ok: true, value: { interconnect: { panel: { title: "Loot", width: 480, height: 160 } } } });
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, panel: { title: "Loot", width: 100 } } }).ok).toBe(false);
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, panel: { title: "Loot", height: 720.5 } } }).ok).toBe(false);
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, panel: { title: "", width: 300 } } }).ok).toBe(false);
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, panel: { title: "Loot", icon: "x" } } }).ok).toBe(false);
    expect(validatePackageManifest({ ...base, interconnect: { ...base.interconnect, capabilities: ["ui.notify"], panel: { title: "Loot" } } }))
      .toMatchObject({ ok: false, error: "package typed-module: interconnect.panel requires the ui.panel capability" });
  });

  test("D-476: interconnect.settings is a bounded, typed schema with validated defaults", () => {
    const base = {
      id: "typed-module", name: "Typed Module", version: "1.0.0", type: "module",
      interconnect: { api: "arena.ais/1", entry: "module.js", capabilities: ["module.settings.write"] },
    };
    const withSettings = (settings: unknown) => validatePackageManifest({ ...base, interconnect: { ...base.interconnect, settings } });
    expect(withSettings([
      { key: "radius", scope: "world", type: "number", label: " Radius ", hint: "In feet", default: 20, min: 0, max: 60, step: 5 },
      { key: "sound", scope: "device", type: "boolean", label: "Sound", default: true },
      { key: "mode", scope: "world", type: "choice", label: "Mode", default: "soft", choices: [{ value: "soft", label: " Soft " }, { value: "hard", label: "Hard" }] },
      { key: "note", scope: "device", type: "string", label: "Note", default: "", maxLength: 40 },
    ])).toMatchObject({ ok: true, value: { interconnect: { settings: [
      { key: "radius", scope: "world", type: "number", label: "Radius", hint: "In feet", default: 20, min: 0, max: 60, step: 5 },
      { key: "sound", scope: "device", type: "boolean", label: "Sound", default: true },
      { key: "mode", scope: "world", type: "choice", label: "Mode", default: "soft", choices: [{ value: "soft", label: "Soft" }, { value: "hard", label: "Hard" }] },
      { key: "note", scope: "device", type: "string", label: "Note", default: "", maxLength: 40 },
    ] } } });
    // A manifest without settings keeps the field absent.
    const plain = validatePackageManifest(base);
    expect(plain.ok && !Object.hasOwn(plain.value.interconnect ?? {}, "settings")).toBe(true);
    const bad: Array<[unknown, string]> = [
      [[{ key: "Radius", scope: "world", type: "number", label: "R", default: 1 }], "key matching"],
      [[{ key: "r", scope: "global", type: "number", label: "R", default: 1 }], "scope must be"],
      [[{ key: "r", scope: "world", type: "colour", label: "R", default: 1 }], "type must be"],
      [[{ key: "r", scope: "world", type: "number", label: "", default: 1 }], "label of 1–48"],
      [[{ key: "r", scope: "world", type: "number", label: "R", default: "1" }], "default: setting r must be a finite number"],
      [[{ key: "r", scope: "world", type: "number", label: "R", default: 99, max: 10 }], "default: setting r must be between"],
      [[{ key: "r", scope: "world", type: "number", label: "R", default: 1, min: 5, max: 2 }], "min must not exceed max"],
      [[{ key: "r", scope: "world", type: "number", label: "R", default: 1, step: 0 }], "step must be positive"],
      [[{ key: "r", scope: "world", type: "boolean", label: "R", default: true, min: 1 }], "min only applies to number"],
      [[{ key: "r", scope: "world", type: "string", label: "R", default: "x", maxLength: 1000 }], "maxLength must be an integer 1–512"],
      [[{ key: "r", scope: "world", type: "choice", label: "R", default: "a" }], "choice settings need choices"],
      [[{ key: "r", scope: "world", type: "choice", label: "R", default: "a", choices: [{ value: "a", label: "A" }] }], "needs 2–32 choices"],
      [[{ key: "r", scope: "world", type: "choice", label: "R", default: "c", choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }], "declared choices"],
      [[{ key: "r", scope: "world", type: "choice", label: "R", default: "a", choices: [{ value: "a", label: "A" }, { value: "a", label: "B" }] }], "repeats choice a"],
      [[{ key: "r", scope: "world", type: "number", label: "R", default: 1, icon: "x" }], "unsupported field icon"],
      [[{ key: "r", scope: "world", type: "number", label: "R", default: 1 }, { key: "r", scope: "device", type: "boolean", label: "S", default: false }], "repeats key r"],
      [Array.from({ length: 33 }, (_, i) => ({ key: `k${i}`, scope: "device", type: "boolean", label: "K", default: false })), "at most 32 entries"],
      [{ key: "r" }, "must be an array"],
    ];
    for (const [settings, message] of bad) {
      const result = withSettings(settings);
      expect(result.ok, JSON.stringify(settings)).toBe(false);
      if (!result.ok) expect(result.error).toContain(message);
    }
  });

  test("rejects bad ids, names, versions, types", () => {
    expect(validatePackageManifest(systemManifest({ id: "Bad_ID" })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ id: "x" })).ok).toBe(false); // too short
    expect(validatePackageManifest(systemManifest({ name: "" })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ version: "one" })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ type: "other" as "system" })).ok).toBe(false);
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

  test("D-475: system packages may declare a ui entry (window components); data may not", () => {
    const withUi = validatePackageManifest(systemManifest({ ui: { entry: "ui.js" } }));
    expect(withUi.ok ? null : withUi.error).toBeNull();
    if (withUi.ok) expect(withUi.value.ui?.entry).toBe("ui.js");
    expect(validatePackageManifest(systemManifest({ ui: { entry: "../ui.js" } })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ ui: { entry: "" } })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ ui: "ui.js" })).ok).toBe(false);
    const dataUi = validatePackageManifest(systemManifest({ type: "data", rules: undefined, ui: { entry: "ui.js" } }));
    expect(dataUi.ok).toBe(false);
    if (dataUi.ok) return;
    expect(dataUi.error).toContain("ui block");
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

  test("AIS module ZIP requires and loads its independent interconnect entry", async () => {
    const manifest = {
      id: "condition-mod",
      name: "Condition Mod",
      version: "1.0.0",
      type: "module",
      interconnect: { api: "arena.ais/1", entry: "automation/entry.js", capabilities: ["action.observe"] },
    };
    const missing = await readZipPackage(zipOf({ "manifest.json": JSON.stringify(manifest) }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("AIS entry automation/entry.js is missing");
    const loaded = await readZipPackage(zipOf({
      "manifest.json": JSON.stringify(manifest),
      "automation/entry.js": "AIS.on('action.intent', () => {});",
    }));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.manifest.type).toBe("module");
  });

  test("package ZIP extraction rejects unsafe entry paths before importing", async () => {
    const result = await readZipPackage(zipSync({
      "manifest.json": strToU8(JSON.stringify(systemManifest())),
      "../outside.js": strToU8("malicious"),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unsafe entry path");
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

  test("D-475: a declared ui entry must ship in the zip and be non-empty", async () => {
    const missing = await readZipPackage(
      zipOf({ "manifest.json": JSON.stringify(systemManifest({ ui: { entry: "ui.js" } })), "rules.js": RULES_JS }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("ui entry ui.js is missing");
    const empty = await readZipPackage(
      zipOf({ "manifest.json": JSON.stringify(systemManifest({ ui: { entry: "ui.js" } })), "rules.js": RULES_JS, "ui.js": "   " }),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("ui entry is empty");
    const good = await readZipPackage(
      zipOf({
        "manifest.json": JSON.stringify(systemManifest({ ui: { entry: "ui.js" } })),
        "rules.js": RULES_JS,
        "ui.js": "export default { api: 'arena.ui/1', components: {} };",
      }),
    );
    expect(good.ok ? null : good.error).toBeNull();
    if (good.ok) expect(good.value.manifest.ui?.entry).toBe("ui.js");
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

describe("manifest.dependencies (D-248 — advisory companions)", () => {
  test("accepts a list of package ids, dedupes, and rejects self/invalid entries", () => {
    const ok = validatePackageManifest(
      systemManifest({ dependencies: ["pf1e-core", "pf1e-core", "other-pack"] }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.dependencies).toEqual(["pf1e-core", "other-pack"]);

    const absent = validatePackageManifest(systemManifest());
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.dependencies).toBeUndefined();

    expect(validatePackageManifest(systemManifest({ dependencies: "pf1e-core" })).ok).toBe(false);
    expect(validatePackageManifest(systemManifest({ dependencies: ["Not An Id"] })).ok).toBe(false);
    const self = validatePackageManifest(systemManifest({ dependencies: ["probe-rules"] }));
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toContain("depend on itself");
  });

  test("data packages may declare dependencies too", () => {
    const data = validatePackageManifest(
      systemManifest({ id: "tables-pkg", type: "data", rules: undefined, dependencies: ["base-pack"] }),
    );
    expect(data.ok).toBe(true);
    if (data.ok) expect(data.value.dependencies).toEqual(["base-pack"]);
  });
});
