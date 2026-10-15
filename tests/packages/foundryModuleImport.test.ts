/**
 * D-482: a Foundry VTT module distribution (module.json, esmodules, binary assets) imports
 * unmodified and becomes an AIS guest bound to the `ais-foundry-v13` `foundry-module` profile.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  aisPackageIdForFoundry,
  aisVersionForFoundry,
  normalizeFoundryPath,
  parseFoundryModuleManifest,
  synthesizeFoundryModulePackage,
} from "../../src/core/foundryModuleManifest";
import { foundryModuleUrl, rewriteFoundryModuleSource } from "../../src/packages/foundryEsmGraph";
import { aisFoundryDistribution, aisRuntimeResources } from "../../src/packages/aisRuntimePackage";
import { readZipPackage } from "../../src/packages/packageLoader";
import { classifyZip } from "../../src/host/zipKind";

const UPSTREAM = join(process.cwd(), "modules/foundry-tagger/upstream");

function upstreamFiles(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(UPSTREAM, full).replaceAll("\\", "/")] = readFileSync(full);
    }
  };
  walk(UPSTREAM);
  return out;
}

/** The upstream Tagger release layout plus a binary icon and a LevelDB pack file, nested one folder deep. */
function taggerZip(root = "tagger/"): Uint8Array {
  const files = upstreamFiles();
  const entries: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(files)) entries[`${root}${path}`] = bytes;
  entries[`${root}icons/tag.png`] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
  entries[`${root}packs/macros/000005.ldb`] = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x81]);
  return zipSync(entries);
}

describe("D-482: Foundry module.json import", () => {
  test("module.json parses with Foundry path spellings normalised and remote entries dropped", () => {
    const parsed = parseFoundryModuleManifest({
      id: "my_mod", title: "My Mod", version: "v2.1", esmodules: ["/scripts/a.js", "modules/my_mod/scripts/b.js", "https://cdn.example/x.js"],
      scripts: ["./lib/c.js"], styles: ["style.css"], languages: [{ lang: "en", name: "English", path: "lang/en.json" }],
      packs: [{ name: "macros", label: "Macros", path: "packs/macros", type: "Macro" }],
      relationships: { systems: [{ id: "pf1" }], requires: [{ id: "lib-wrapper" }] }, socket: true,
      compatibility: { minimum: 12, verified: "13.345" },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      id: "my_mod", title: "My Mod", version: "v2.1", esmodules: ["scripts/a.js", "scripts/b.js"], scripts: ["lib/c.js"],
      styles: ["style.css"], languages: [{ lang: "en", path: "lang/en.json" }], packs: [{ name: "macros", type: "Macro" }],
      systems: ["pf1"], requires: ["lib-wrapper"], socket: true, compatibility: { minimum: "12", verified: "13.345", maximum: null },
      dropped: ["esmodule https://cdn.example/x.js"],
    });
    expect(aisPackageIdForFoundry("my_mod")).toBe("my-mod");
    expect(aisPackageIdForFoundry("X")).toBe("fm-x");
    expect(aisVersionForFoundry("v2.1")).toBe("2.1.0");
    expect(aisVersionForFoundry("This is auto replaced")).toBe("0.0.0");
    expect(aisVersionForFoundry("1.5.4")).toBe("1.5.4");
    expect(normalizeFoundryPath("../escape.js", "m")).toBeNull();
    expect(normalizeFoundryPath("/modules/m//scripts/./x.js", "m")).toBe("scripts/x.js");
    expect(parseFoundryModuleManifest({ title: "no id" }).ok).toBe(false);
  });

  test("synthesis refuses a distribution whose entry file is missing or binary", () => {
    const base = { "module.json": JSON.stringify({ id: "m", esmodules: ["scripts/a.js"] }) };
    expect(synthesizeFoundryModulePackage(base)).toMatchObject({ ok: false, error: expect.stringContaining("missing from the archive") });
    expect(synthesizeFoundryModulePackage(base, ["scripts/a.js"])).toMatchObject({ ok: false, error: expect.stringContaining("not UTF-8 text") });
    expect(synthesizeFoundryModulePackage({ "module.json": JSON.stringify({ id: "m" }) }))
      .toMatchObject({ ok: false, error: expect.stringContaining("no esmodules or scripts") });
  });

  test("specifier rewriting maps only what the archive serves and leaves the rest verbatim", () => {
    const has = (path: string): boolean => ["scripts/module.js", "scripts/hotkeys.js", "lib/util.mjs", "scripts/constants.js"].includes(path);
    const source = [
      `import { hotkeyState, registerHotkeysPost as post } from "./hotkeys.js";`,
      `import CONSTANTS from './constants.js';`,
      `import * as util from "../lib/util.mjs";`,
      `export { x } from "/scripts/constants.js";`,
      `import "./side-effect.js";`,
      `const lazy = () => import("./hotkeys.js");`,
      `import lw from "lib-wrapper";`,
      `import sys from "/systems/pf1/pf1.mjs";`,
      `const s = "import x from './not-code.js'";`,
    ].join("\n");
    const result = rewriteFoundryModuleSource(source, "scripts/module.js", "tagger", "tagger", has);
    expect(result.text).toContain(`from "${foundryModuleUrl("tagger", "scripts/hotkeys.js")}"`);
    expect(result.text).toContain(`from '${foundryModuleUrl("tagger", "scripts/constants.js")}'`);
    expect(result.text).toContain(`from "${foundryModuleUrl("tagger", "lib/util.mjs")}"`);
    expect(result.text).toContain(`export { x } from "${foundryModuleUrl("tagger", "scripts/constants.js")}"`);
    expect(result.text).toContain(`import("${foundryModuleUrl("tagger", "scripts/hotkeys.js")}")`);
    expect(result.text).toContain(`import lw from "lib-wrapper";`);
    expect(result.text).toContain(`import sys from "/systems/pf1/pf1.mjs";`);
    expect(result.text).toContain(`import "./side-effect.js";`);
    expect([...result.unresolved].sort()).toEqual(["./not-code.js", "./side-effect.js", "/systems/pf1/pf1.mjs"]);
  });

  test("the upstream Tagger zip (nested root, icons, LevelDB pack) imports as an AIS guest of the Foundry adapter", async () => {
    const bytes = taggerZip();
    const kind = await classifyZip(bytes);
    expect(kind).toMatchObject({ kind: "package", manifest: { id: "tagger", name: "Tagger", type: "module" } });

    const loaded = await readZipPackage(bytes);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const { manifest, files, foundry } = loaded.value;
    expect(manifest).toMatchObject({
      id: "tagger", name: "Tagger", version: "0.0.0", type: "module",
      interconnect: {
        entry: "ais-foundry/entry.js",
        requires: [{ id: "ais-foundry-v13", version: "0.5.0" }],
        runtime: { provider: "ais-foundry-v13", profile: "foundry-module", scripts: ["ais-foundry/loader.js"], configuration: "module.json" },
        commands: [{ id: "foundry.info", contract: 1 }, { id: "foundry.api", contract: 1 }, { id: "foundry.ui", contract: 1 }],
        // D-483: Foundry windows render inside the module's own sandboxed panel.
        panel: { title: "Tagger", width: 760, height: 560 },
        sharing: "host-only",
      },
    });
    expect(manifest.interconnect?.capabilities).toContain("ui.panel");
    expect(manifest.description).toContain("imported unmodified");
    expect(manifest.interconnect?.runtime?.resources).toEqual(["LICENSE", "module.json", "scripts/constants.js", "scripts/hotkeys.js", "scripts/module.js"]);
    expect(foundry).toMatchObject({ id: "tagger", title: "Tagger", version: "This is auto replaced", esmodules: ["scripts/module.js"], styles: ["style.css"], library: true, binaryFiles: 2 });
    // The module's own files are byte-identical to upstream; only the kernel-side resource view is rewritten.
    const upstream = upstreamFiles();
    for (const path of ["scripts/module.js", "scripts/hotkeys.js", "scripts/constants.js", "module.json"])
      expect(files[path]).toBe(new TextDecoder().decode(upstream[path] as Uint8Array));
    expect(files["manifest.json"]).toContain('"profile": "foundry-module"');

    const pkg = { id: manifest.id, version: manifest.version, manifest, files };
    const resources = aisRuntimeResources(pkg);
    expect(resources["scripts/module.js"]).toContain(`from "ais-foundry://tagger/scripts/hotkeys.js"`);
    expect(resources["scripts/module.js"]).toContain(`from "ais-foundry://tagger/scripts/constants.js"`);
    expect(resources["scripts/hotkeys.js"]).toContain(`from "ais-foundry://tagger/scripts/constants.js"`);
    expect(resources["scripts/constants.js"]).toBe(files["scripts/constants.js"]);
    const distribution = aisFoundryDistribution(pkg);
    expect(distribution).toMatchObject({
      foundryId: "tagger", packageId: "tagger", title: "Tagger", esmodules: ["scripts/module.js"], scripts: [], styles: [],
      languages: [], packs: [], systems: [], requires: [], socket: false, unresolved: [],
    });
    expect(distribution?.files).toEqual(["LICENSE", "module.json", "scripts/constants.js", "scripts/hotkeys.js", "scripts/module.js"]);
  });

  test("a root-level module.json works too, and a plain ArenaStar package still refuses binaries", async () => {
    const rooted = await readZipPackage(taggerZip(""));
    expect(rooted.ok).toBe(true);
    const ours = await readZipPackage(zipSync({
      "manifest.json": strToU8(JSON.stringify({ id: "plain", name: "Plain", version: "1.0.0", type: "data" })),
      "bin.dat": new Uint8Array([0xff, 0xfe, 0x00, 0x80]),
    }));
    expect(ours).toMatchObject({ ok: false, error: expect.stringContaining("binary files are not supported") });
  });
});
