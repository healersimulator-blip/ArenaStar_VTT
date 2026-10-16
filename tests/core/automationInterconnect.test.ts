import { describe, expect, test } from "vitest";
import {
  AIS_API_VERSION,
  AIS_EVENTS,
  aisEventSubscriptionCapability,
  aisTokenLightChanges,
  emptyAisProfile,
  resolveAisProfile,
  type AisActivationProfile,
  type AisPackageCandidate,
} from "../../src/core/automationInterconnect";
import { packageContentHash } from "../../src/packages/packageHash";

const hash = (char: string): string => char.repeat(64);
const candidate = (
  id: string,
  options: {
    version?: string;
    hash?: string;
    requires?: NonNullable<AisPackageCandidate["interconnect"]>["requires"];
    provides?: NonNullable<AisPackageCandidate["interconnect"]>["provides"];
    capabilities?: NonNullable<AisPackageCandidate["interconnect"]>["capabilities"];
    type?: AisPackageCandidate["type"];
  } = {},
): AisPackageCandidate => ({
  id,
  version: options.version ?? "1.0.0",
  hash: options.hash ?? hash("a"),
  type: options.type ?? "module",
  interconnect: {
    api: AIS_API_VERSION,
    entry: `${id}.js`,
    ...(options.requires ? { requires: options.requires } : {}),
    ...(options.provides ? { provides: options.provides } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  },
});
const lock = (pkg: AisPackageCandidate) => ({ id: pkg.id, version: pkg.version, hash: pkg.hash });
const profile = (...packages: AisPackageCandidate[]): AisActivationProfile => ({
  ...emptyAisProfile(),
  modules: packages.map(lock),
});

describe("AIS v1 package profile resolution", () => {
  test("D-483: event subscriptions are gated by the capability that owns the event", () => {
    expect(AIS_EVENTS).toContain("ui.panel.closed");
    expect(aisEventSubscriptionCapability("module.settings.changed")).toBeNull();
    expect(aisEventSubscriptionCapability("ui.panel.closed")).toBe("ui.panel");
    // D-485: document change notifications carry ids and diffs; the read grant that exposes them owns the event.
    expect(aisEventSubscriptionCapability("documents.changed")).toBe("documents.read");
    // D-487: the package's own cross-device channel; opting in is the bus grant itself.
    expect(aisEventSubscriptionCapability("bus.message")).toBe("bus.transmit");
    for (const event of AIS_EVENTS)
      if (event !== "module.settings.changed" && event !== "ui.panel.closed" && event !== "documents.changed" && event !== "bus.message")
        expect(aisEventSubscriptionCapability(event)).toBe("action.observe");
  });

  test("publishes a typed token-light source-change hook and identifies only committed light writes", () => {
    expect(AIS_EVENTS).toContain("scene.token.light.changed");
    const scene = { coll: "scenes" as const, id: "scene-1" };
    const ops = [
      { kind: "update", ref: { coll: "tokens", id: "token-1", parent: scene }, diff: { "light.animation.type": "pulse" } },
      { kind: "update", ref: { coll: "tokens", id: "token-1", parent: scene }, diff: { "flags.ais.torch.active": true } },
      { kind: "create", coll: "tokens", parent: scene, data: { _id: "token-2", light: { radius: 10 } } },
      { kind: "delete", ref: { coll: "tokens", id: "token-3", parent: scene } },
      { kind: "update", ref: { coll: "tokens", id: "orphan-token" }, diff: { light: { radius: 10 } } },
    ] as never[];
    expect(aisTokenLightChanges(ops)).toEqual([
      { sceneId: "scene-1", tokenId: "token-1" },
      { sceneId: "scene-1", tokenId: "token-2" },
      { sceneId: "scene-1", tokenId: "token-3" },
    ]);
  });

  test("locks exact package bytes and sorts dependency order deterministically", () => {
    const core = candidate("base-mod");
    const addon = candidate("addon-mod", { requires: [{ id: "base-mod", version: "1.0.0" }] });
    const result = resolveAisProfile([addon, core], profile(addon, core), "mass-battle-basic");
    expect(result.issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(result.order).toEqual(["base-mod", "addon-mod"]);
    expect(result.modules.map((item) => item.id)).toEqual(["base-mod", "addon-mod"]);

    const tampered = candidate("base-mod", { hash: hash("b") });
    const mismatch = resolveAisProfile([tampered, addon], profile(core, addon), "mass-battle-basic");
    expect(mismatch.issues.some((issue) => issue.kind === "hash-mismatch" && issue.blocking)).toBe(true);
    expect(mismatch.modules.map((item) => item.id)).toEqual([]);
  });

  test("blocks required missing dependencies and their transitive dependents", () => {
    const broken = candidate("broken-mod", { requires: [{ id: "missing-mod" }] });
    const dependent = candidate("dependent-mod", { requires: [{ id: "broken-mod" }] });
    const independent = candidate("independent-mod");
    const result = resolveAisProfile(
      [broken, dependent, independent],
      profile(broken, dependent, independent),
      "mass-battle-basic",
    );
    expect(result.modules.map((item) => item.id)).toEqual(["independent-mod"]);
    expect(result.issues.some((issue) => issue.kind === "missing-dependency" && issue.packageId === "broken-mod")).toBe(true);
    expect(result.issues.some((issue) => issue.packageId === "dependent-mod" && issue.blocking)).toBe(true);
  });

  test("optional missing dependencies warn without disabling the module", () => {
    const optional = candidate("optional-mod", { requires: [{ id: "not-here", optional: true }] });
    const result = resolveAisProfile([optional], profile(optional), "mass-battle-basic");
    expect(result.modules.map((item) => item.id)).toEqual(["optional-mod"]);
    expect(result.issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(result.issues.some((issue) => issue.packageId === "optional-mod" && !issue.blocking)).toBe(true);
  });

  test("resolves exclusive contributions only with an explicit provider selection", () => {
    const first = candidate("first-mod", { provides: [{ id: "pf1e.damage.resolve", mode: "exclusive", contract: 1 }] });
    const second = candidate("second-mod", { provides: [{ id: "pf1e.damage.resolve", mode: "exclusive", contract: 1 }] });
    const ambiguous = resolveAisProfile([first, second], profile(first, second), "mass-battle-basic");
    expect(ambiguous.issues.some((issue) => issue.kind === "provider-conflict" && issue.blocking)).toBe(true);

    const selected: AisActivationProfile = {
      ...profile(first, second),
      providers: { "pf1e.damage.resolve": "second-mod/pf1e.damage.resolve" },
    };
    const resolved = resolveAisProfile([first, second], selected, "mass-battle-basic");
    expect(resolved.issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(resolved.providers[0]).toMatchObject({
      slotId: "pf1e.damage.resolve",
      selected: "second-mod/pf1e.damage.resolve",
      order: ["second-mod/pf1e.damage.resolve"],
    });
  });

  test("a dependency cycle blocks the cycle and dependent packages, not unrelated modules", () => {
    const a = candidate("cycle-a", { requires: [{ id: "cycle-b" }] });
    const b = candidate("cycle-b", { requires: [{ id: "cycle-a" }] });
    const c = candidate("cycle-c", { requires: [{ id: "cycle-a" }] });
    const independent = candidate("free-mod");
    const result = resolveAisProfile([a, b, c, independent], profile(a, b, c, independent), "mass-battle-basic");
    expect(result.modules.map((item) => item.id)).toEqual(["free-mod"]);
    expect(result.issues.some((issue) => issue.kind === "dependency-cycle")).toBe(true);
    expect(result.issues.some((issue) => issue.packageId === "cycle-c" && issue.blocking)).toBe(true);
  });

  test("package hashes ignore file-map insertion order and bind paths and contents", () => {
    const first = packageContentHash({ "manifest.json": "{}", "entry.js": "run()" });
    const reordered = packageContentHash({ "entry.js": "run()", "manifest.json": "{}" });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(packageContentHash({ "manifest.json": "{}", "entry.js": "run(2)" })).not.toBe(first);
    expect(packageContentHash({ "manifest.json": "{}", "renamed.js": "run()" })).not.toBe(first);
  });
});
