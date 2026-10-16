/**
 * D-473 — the packages a build ships inside itself.
 *
 * `vite.config.ts` inlines `systems/.first-party/index.json` (+ zips, base64) as
 * `__FIRST_PARTY_PACKAGES__`; this module reads that list. Two consumers depend on its shape:
 * a fresh world created on the first-party ruleset (wizard default, `?e2e=1&rules=pf1e`,
 * `bootHostApp({ firstPartyRules: true })`), and the player shell's "is this artifact one of
 * ours?" check that skips the D-472 consent prompt. The tests use the list seam with probe
 * packages so they do not depend on `build:systems` having run; one test inspects the real
 * embedded set when it is present.
 */
import "fake-indexeddb/auto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  firstPartyPackageBytes,
  firstPartyPackages,
  firstPartySystemPackage,
  isFirstPartyArtifact,
  loadFirstPartyRecipePackages,
  type FirstPartyPackage,
} from "../../src/app/firstPartyPackages";
import { bootHostApp } from "../../src/app/hostBoot";
import { sha256Hex } from "../../src/host/assets";
import { getWorld, openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "./fakes";

const RULES_JS =
  "export default { schema: { version: '3.1.0', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] }, validateOrder(){ return {ok:true}; }, resolveTurn(){}, detection(){ return 5; } };";

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const RULESET_ZIP = zipOf({
  "manifest.json": JSON.stringify({
    id: "probe-rules",
    name: "Probe Rules",
    version: "3.1.0",
    type: "system",
    dependencies: ["probe-content", "probe-optional"],
    rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
  }),
  "rules.js": RULES_JS,
});
const CONTENT_ZIP = zipOf({
  "manifest.json": JSON.stringify({ id: "probe-content", name: "Probe Content", version: "1.0.0", type: "data" }),
});

async function probeList(): Promise<FirstPartyPackage[]> {
  return [
    {
      id: "probe-content",
      name: "Probe Content",
      version: "1.0.0",
      type: "data",
      dependencies: [],
      rulesSha256: null,
      zipBase64: base64(CONTENT_ZIP),
    },
    {
      id: "probe-rules",
      name: "Probe Rules",
      version: "3.1.0",
      type: "system",
      dependencies: ["probe-content", "probe-optional"],
      rulesSha256: await sha256Hex(strToU8(RULES_JS)),
      zipBase64: base64(RULESET_ZIP),
    },
  ];
}

describe("first-party list accessors", () => {
  test("the system package is the one with a rules hash; data packages never match an artifact", async () => {
    const list = await probeList();
    expect(firstPartyPackages(list).map((entry) => entry.id)).toEqual(["probe-content", "probe-rules"]);
    expect(firstPartySystemPackage(list)?.id).toBe("probe-rules");
    expect(firstPartySystemPackage([])).toBeNull();
    const hash = list[1]?.rulesSha256 ?? "";
    expect(isFirstPartyArtifact(hash, list)).toBe(true);
    expect(isFirstPartyArtifact(hash.toUpperCase(), list)).toBe(false);
    expect(isFirstPartyArtifact("0".repeat(64), list)).toBe(false);
    expect(isFirstPartyArtifact("", list)).toBe(false);
    // D-475: the package's ui.js hash is trusted the same way; a list without one trusts no UI.
    const uiHash = "ab".repeat(32);
    expect(isFirstPartyArtifact(uiHash, list)).toBe(false);
    const withUi = list.map((entry) => (entry.type === "system" ? { ...entry, uiSha256: uiHash } : entry));
    expect(isFirstPartyArtifact(uiHash, withUi)).toBe(true);
    expect(isFirstPartyArtifact(hash, withUi)).toBe(true);
  });

  test("the embedded base64 round-trips to the zip bytes the loader reads", async () => {
    const list = await probeList();
    const entry = list[1];
    if (!entry) throw new Error("unreachable");
    expect(Array.from(firstPartyPackageBytes(entry))).toEqual(Array.from(RULESET_ZIP));
  });

  test("the recipe set is the ruleset plus its declared companions that this build also carries", async () => {
    const set = await loadFirstPartyRecipePackages(await probeList());
    expect(set?.ruleset.manifest.id).toBe("probe-rules");
    expect(set?.ruleset.files["rules.js"]).toBe(RULES_JS);
    // `probe-optional` is declared but not shipped — left to the GM, not an error (D-110).
    expect(set?.content.map((pkg) => pkg.manifest.id)).toEqual(["probe-content"]);
    expect(await loadFirstPartyRecipePackages([])).toBeNull();
  });

  test("a broken embedded zip is a build defect, not a quiet fallback", async () => {
    const list = await probeList();
    const broken = list.map((entry) => (entry.type === "system" ? { ...entry, zipBase64: base64(strToU8("not a zip")) } : entry));
    await expect(loadFirstPartyRecipePackages(broken)).rejects.toThrow(/probe-rules/);
  });
});

describe("bootHostApp({ firstPartyRules: true }) — a fresh World One on the shipped ruleset", () => {
  test("the first world is created from the first-party recipe: rows, pin and the published artifact agree", async () => {
    const list = await probeList();
    const db = await openVttDb();
    const app = await bootHostApp({
      db,
      root: new MemDirHandle(),
      codec: new FakeCodec(),
      simRunner: new InlineSimRunner(),
      firstPartyRules: true,
      firstPartyPackages: list,
    });
    try {
      expect(app.rulesBoot).toMatchObject({ source: "package", packageId: "probe-rules", version: "3.1.0", error: null });
      expect(app.rulesBoot.inPage).toBe("package");
      expect(await getWorld(db, app.worldId)).toMatchObject({
        name: "World One",
        activeRulesPackage: "probe-rules",
        system: "probe-rules",
        version: "3.1.0",
      });
      const summaries = await app.packages.list();
      expect(summaries.map((p) => [p.id, p.type, p.active])).toEqual([
        ["probe-content", "data", false],
        ["probe-rules", "system", true],
      ]);
      // D-472 announces the artifact under the hash the build signed: that equality is what a
      // player shell checks before loading without a prompt.
      expect(app.host.publishedArtifacts()).toEqual([list[1]?.rulesSha256]);
    } finally {
      await app.close();
    }
  });
});

describe("the real embedded set (present after `pnpm build:systems`)", () => {
  test.skipIf(firstPartyPackages().length === 0)(
    "carries pf1e-mass-battles with pf1e-core as its companion, hash matching the rules.js it embeds",
    async () => {
      const system = firstPartySystemPackage();
      expect(system?.id).toBe("pf1e-mass-battles");
      const set = await loadFirstPartyRecipePackages();
      expect(set?.ruleset.manifest.id).toBe("pf1e-mass-battles");
      expect(set?.content.map((pkg) => pkg.manifest.id)).toEqual(["pf1e-core"]);
      const rulesJs = set?.ruleset.files["rules.js"] ?? "";
      expect(await sha256Hex(new TextEncoder().encode(rulesJs))).toBe(system?.rulesSha256);
      // D-475: the window components ship as the second hash-pinned artifact of the same package.
      expect(set?.ruleset.manifest.ui?.entry).toBe("ui.js");
      const uiJs = set?.ruleset.files["ui.js"] ?? "";
      expect(uiJs.length).toBeGreaterThan(1000);
      expect(await sha256Hex(new TextEncoder().encode(uiJs))).toBe(system?.uiSha256);
    },
  );
});
