import "fake-indexeddb/auto";
import { beforeAll, afterAll, describe, test, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { parseUiTheme, parseUiPreferences, uiThemeVariables, type UiThemeSpec } from "../../src/core/uiTheme";
import { AisAppearance } from "../../src/app/aisAppearance";
import { AisRuntime, assertAisModuleConsent } from "../../src/app/aisRuntime";
import { parseEmbeddedDemo, openEmbeddedDemo } from "../../src/app/embeddedDemo";
import { bootHostApp, type HostApp, type HostAutomationModuleBoot } from "../../src/app/hostBoot";
import { importWorldZip } from "../../src/host/worldFile";
import { openVttDb, getWorld, listPackages, listWorlds } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "./fakes";
import { createAisModuleHandlers } from "../../src/packages/aisModuleHandlers";

const stage = mkdtempSync(join(tmpdir(), "ui-adapter-tests-"));
let bytes: Uint8Array;
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/buildUiDemo.mjs", "--out", stage], { stdio: "pipe", timeout: 60_000 });
  bytes = new Uint8Array(readFileSync(join(stage, "worlds/ais-ui-laboratory-0.1.0.zip")));
}, 65_000);
afterAll(() => rmSync(stage, { recursive: true, force: true }));
const theme = (): UiThemeSpec => ({ version: 1, colors: { background: "#101820", panel: "#19232f", raised: "#23303b", border: "#596978",
  text: "#f5f6fa", muted: "#bbc7d0", accent: "#75d9bc" }, font: "sans", radius: 8, density: "compact", evidence: { mode: "fixture", detail: "verified fixture" } });
async function fresh(): Promise<HostApp> {
  const db = await openVttDb(), root = new MemDirHandle();
  const world = await importWorldZip({ db, root, file: bytes, mode: "copy" });
  return bootHostApp({ db, root, worldId: world.worldId, codec: new FakeCodec(), simRunner: new InlineSimRunner() });
}

describe("closed AIS appearance contract", () => {
  test("native CSS accepts only fixed host properties and bounded visual values", () => {
    const value = parseUiTheme(theme());
    const style = uiThemeVariables(value, parseUiPreferences({ density: "compact", sidebarWidth: 9000 }), { panel: "blob:null/owned" });
    expect(style).toContain("--vtt-sidebar-width:420px");
    expect(style).toContain("--vtt-control-height:32px");
    expect(style).toContain('--vtt-theme-panel-image:url("blob:null/owned")');
    expect(() => uiThemeVariables(value, parseUiPreferences(null), { panel: 'https://tracker.invalid/a' })).toThrow();
    expect(parseUiPreferences({ density: "hidden", sidebarWidth: -10, selected: "../bad" })).toMatchObject({ selected: null, density: "comfortable", sidebarWidth: 260 });
  });
  test.each([
    { css: "body{display:none}" }, { selector: "#gm-settings" }, { radius: -1 }, { radius: 900 }, { font: "url(https://evil.test)" },
    { images: { panel: "../another-package/private" } }, { images: { overlay: "safe.webp.b64" } },
    { colors: { ...theme().colors, accent: "url(https://evil.test)" } },
    { colors: { ...theme().colors, text: "#111111" } },
  ])("rejects unsafe or unreadable proposals %j", (patch) => {
    expect(() => parseUiTheme({ ...theme(), ...patch })).toThrow();
  });
});

describe("world-packaged UI assets and inert preload", () => {
  test("all three upstream representations and the adapter are portable; CSS resource imports/URLs are removed", async () => {
    const app = await fresh();
    try {
      const packages = await listPackages(app.db, app.worldId);
      expect(packages).toHaveLength(4);
      expect(app.automationBoot.modules).toHaveLength(0);
      for (const pkg of packages) {
        for (const [path, text] of Object.entries(pkg.files)) {
          if (path.startsWith("prepared/") && path.endsWith(".css")) {
            expect(text).not.toMatch(/@import\s/i);
            expect(text).not.toMatch(/url\s*\(/i);
          }
        }
      }
      const rpg = packages.find((pkg) => pkg.id === "foundry-ui-rpg-styled-ui");
      expect(rpg?.files["upstream/scripts/rpg-ui.js"]).toContain("game.settings.register('rpg-styled-ui', 'compactModeToggle'");
      expect(rpg?.files["upstream/ui/frames/header.webp.b64"]).toBeTruthy();
      const original = readFileSync("modules/foundry-ui-rpg-styled-ui/upstream/ui/frames/header.webp");
      expect(Buffer.from(rpg?.files["upstream/ui/frames/header.webp.b64"] ?? "", "base64")).toEqual(original);
    } finally { await app.close(); }
  });
  test("preloaded demo creates one copy, preserves unrelated worlds, and never imports approvals", async () => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const demo = parseEmbeddedDemo(JSON.stringify({ id: "ui-unit-demo", sha256: digest, archive: Buffer.from(bytes).toString("base64") }));
    const db = await openVttDb();
    try {
      const count = (await listWorlds(db)).length;
      const first = await openEmbeddedDemo(demo);
      expect(first.fresh).toBe(true);
      expect((await getWorld(db, first.worldId))?.automationGrants).toBeUndefined();
      expect(await openEmbeddedDemo(demo)).toEqual({ worldId: first.worldId, fresh: false });
      expect((await listWorlds(db)).length).toBe(count + 1);
      await expect(openEmbeddedDemo({ ...demo, id: "bad-ui-unit", sha256: "0".repeat(64) })).rejects.toThrow("integrity");
      expect(() => parseEmbeddedDemo('{"id":"../bad"}')).toThrow();
    } finally { db.close(); }
  });
  test("package resource reads are chunked, capability checked, and cannot probe other files", async () => {
    const db = await openVttDb();
    let allowed = true;
    const api = createAisModuleHandlers({ db, worldId: "resource-unit", packageId: "theme", emittedEvents: [],
      user: () => ({ id: "gm", name: "GM" }), activeScene: () => null, actorById: () => undefined,
      select: async () => null, submit: () => "unused", notify: vi.fn(), emitModuleEvent: vi.fn(), busEmit: vi.fn(), newId: () => "unused",
      resources: { "style.css": "x".repeat(12_000) }, assertCapability: async () => { if (!allowed) throw new Error("revoked"); } });
    try {
      expect(await api["package.resource.read"]({ path: "style.css", offset: 0 })).toMatchObject({ next: 8192 });
      expect(await api["package.resource.read"]({ path: "style.css", offset: 8192 })).toEqual({ text: "x".repeat(3808), next: null });
      await expect(api["package.resource.read"]({ path: "../private", offset: 0 })).rejects.toThrow("Undeclared");
      await expect(api["package.resource.read"]({ path: "constructor", offset: 0 })).rejects.toThrow("Undeclared");
      await expect(api["package.resource.read"]({ path: "style.css", offset: 99999 })).rejects.toThrow("offset");
      allowed = false;
      await expect(api["package.resource.read"]({ path: "style.css", offset: 0 })).rejects.toThrow("revoked");
    } finally { db.close(); }
  });
});

function testRuntime(app: HostApp) {
  const composeTheme = vi.fn(async (id: string) => {
    const module = (await app.packages.runtimePlan()).modules.find((entry) => entry.packageId === id);
    if (!module) throw new Error("not approved");
    assertAisModuleConsent(await getWorld(app.db, app.worldId), module, "ui.theme");
    return { value: theme(), module };
  });
  const runtime = { composeTheme, stopThemes: vi.fn(),
    assertThemeActive: async (module: HostAutomationModuleBoot) => assertAisModuleConsent(await getWorld(app.db, app.worldId), module, "ui.theme") };
  return { runtime: runtime as unknown as AisRuntime, composeTheme };
}

describe("GM appearance controller", () => {
  test("review is inert, explicit confirmation applies a single provider, and revoke/reset recover native UI", async () => {
    const app = await fresh(), mock = testRuntime(app), controller = new AisAppearance(app, mock.runtime);
    try {
      await controller.restore();
      expect(controller.snapshot.themes).toHaveLength(3);
      const id = "foundry-ui-your-flavor";
      expect(await controller.needsReview(id)).toBe(true);
      const reviews = await controller.reviews(id);
      expect(reviews.map((item) => item.id)).toEqual(["ais-foundry-ui", id]);
      expect((await app.packages.list()).every((item) => !item.approved)).toBe(true);
      await controller.approveAndApply(reviews, { selected: id, variant: "dark-fantasy", density: "compact", sidebarWidth: 300 });
      expect(controller.snapshot.active).toBe(id);
      expect((await app.packages.automation()).profile.providers["ui.theme"]).toBe(`${id}/ui.theme`);
      expect(app.store.get("settings", "ais-ui-appearance")?.system.selected).toBe(id);
      await app.packages.revokeAutomationApproval("ais-foundry-ui");
      expect(controller.snapshot.active).toBeNull();
      expect(controller.snapshot.spec).toBeNull();
      await controller.reset();
      expect(app.store.get("settings", "ais-ui-appearance")?.system.selected).toBeNull();
    } finally { controller.dispose(); await app.close(); }
  });
  test("reset cancels a pending theme result and its settings cannot resurrect after cancellation", async () => {
    const app = await fresh(), mock = testRuntime(app), controller = new AisAppearance(app, mock.runtime);
    try {
      await controller.refreshCatalog();
      const prefs = { selected: "foundry-ui-your-flavor", variant: "dark-fantasy", density: "compact" as const, sidebarWidth: 300 };
      await controller.approveAndApply(await controller.reviews(prefs.selected), prefs);
      let release!: () => void, entered!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const previous = mock.composeTheme.getMockImplementation();
      if (!previous) throw new Error("missing fixture implementation");
      mock.composeTheme.mockImplementationOnce(async (id) => { entered(); await gate; return previous(id); });
      const pending = controller.apply({ ...prefs, variant: "ocean-depths" });
      await reached;
      const reset = controller.reset();
      expect(controller.snapshot.active).toBeNull();
      release(); await pending; await reset;
      expect(controller.snapshot.active).toBeNull();
      expect(app.store.get("settings", "ais-ui-appearance")?.system.selected).toBeNull();
    } finally { controller.dispose(); await app.close(); }
  });
  test("archive manifest still carries no local grants or selected provider by default", () => {
    const files = unzipSync(bytes), data = files["world.json"];
    if (!data) throw new Error("Missing manifest");
    const manifest = JSON.parse(strFromU8(data));
    expect(manifest.format).toBe(5);
    expect(manifest.automation).toMatchObject({ modules: [], providers: {} });
    expect(manifest.automationGrants).toBeUndefined();
  });
});
