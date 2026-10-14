/**
 * D-464 — workspace layouts (Modern / Foundry-like / Roll20-like) are a local presentation choice.
 *
 * The contract these tests pin: the preference record tolerates garbage, defaults to the modern
 * layout, keeps every document tab reachable in every layout (the same ids the e2e suite clicks),
 * and the store writes only to device storage — never to a world.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  WORKSPACE_PROFILES,
  WORKSPACE_PROFILE_INFO,
  WORKSPACE_UI_KEY,
  workspaceTabLabel,
  workspaceTabOrder,
  workspaceToolInset,
  workspaceUiPrefs,
} from "../../src/core/workspaceUi";

const SIDEBAR_TABS = ["chat", "actors", "scenes", "images", "journals", "combat", "tables", "playlists",
  "compendia", "placeables", "macros", "settings"] as const;

describe("workspaceUiPrefs", () => {
  test("defaults to the modern layout, light Roll20 scheme and an open content dock in every layout", () => {
    for (const raw of [null, undefined, 0, "modern", [], {}, { profile: "foundry-v9" }, { panels: "yes" }]) {
      expect(workspaceUiPrefs(raw)).toEqual({ version: 1, profile: "modern", roll20Scheme: "light",
        panels: { modern: true, foundry: true, roll20: true } });
    }
  });

  test("keeps valid stored choices and repairs only the broken fields", () => {
    expect(workspaceUiPrefs({ profile: "roll20", roll20Scheme: "dark", panels: { modern: false, roll20: false } }))
      .toEqual({ version: 1, profile: "roll20", roll20Scheme: "dark", panels: { modern: false, foundry: true, roll20: false } });
    expect(workspaceUiPrefs({ profile: "foundry", roll20Scheme: "sepia", panels: { foundry: "open" } }).roll20Scheme).toBe("light");
    expect(workspaceUiPrefs({ profile: "foundry", panels: { foundry: "open" } }).panels.foundry).toBe(true);
  });

  test("every profile has picker copy and a window inset that clears its tool column", () => {
    expect(WORKSPACE_PROFILES).toEqual(["modern", "foundry", "roll20"]);
    for (const profile of WORKSPACE_PROFILES) {
      expect(WORKSPACE_PROFILE_INFO[profile].name.length).toBeGreaterThan(0);
      expect(WORKSPACE_PROFILE_INFO[profile].detail.length).toBeGreaterThan(0);
      expect(workspaceToolInset(profile)).toBeGreaterThanOrEqual(54);
    }
    expect(workspaceToolInset("foundry")).toBeGreaterThan(workspaceToolInset("modern"));
  });
});

describe("workspaceTabOrder", () => {
  test("every layout orders the same twelve sidebar tabs — none is dropped or invented", () => {
    for (const profile of WORKSPACE_PROFILES) {
      const order = workspaceTabOrder(profile);
      expect([...order].sort()).toEqual([...SIDEBAR_TABS].sort());
      expect(new Set(order).size).toBe(order.length);
    }
  });

  test("chat leads every layout and the compatibility layouts follow their reference order", () => {
    for (const profile of WORKSPACE_PROFILES) expect(workspaceTabOrder(profile)[0]).toBe("chat");
    expect(workspaceTabOrder("foundry").slice(0, 3)).toEqual(["chat", "combat", "scenes"]);
    // Roll20's seven-tab strip: chat, art library, journal, jukebox, collections, compendium, settings.
    expect(workspaceTabOrder("roll20").slice(0, 7)).toEqual(["chat", "images", "journals", "playlists", "macros", "compendia", "settings"]);
  });

  test("labels follow the layout's vocabulary without changing the tab ids", () => {
    // "Actors" is the product's own word (onboarding copy, sheet lists, 38 specs); the Roll20 strip
    // may rename pages and collections, nobody renames actors.
    expect(workspaceTabLabel("modern", "actors")).toBe("Actors");
    expect(workspaceTabLabel("foundry", "actors")).toBe("Actors");
    expect(workspaceTabLabel("modern", "playlists")).toBe("Jukebox");
    expect(workspaceTabLabel("roll20", "scenes")).toBe("My pages");
    expect(workspaceTabLabel("roll20", "macros")).toBe("Collections");
    expect(workspaceTabLabel("modern", "not-a-tab")).toBe("not-a-tab");
  });
});

describe("workspace store", () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    storage.clear();
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    });
  });

  test("persists profile, scheme and per-profile drawer state under the versioned device key", async () => {
    const { workspaceUi, setWorkspaceProfile, setWorkspaceScheme, setWorkspacePanel, toggleWorkspacePanel } =
      await import("../../src/ui/workspace/state");
    const { get } = await import("svelte/store");
    expect(get(workspaceUi).profile).toBe("modern");
    setWorkspaceProfile("foundry");
    setWorkspacePanel(false);
    setWorkspaceScheme("dark");
    toggleWorkspacePanel();
    toggleWorkspacePanel();
    expect(get(workspaceUi)).toEqual({ version: 1, profile: "foundry", roll20Scheme: "dark",
      panels: { modern: true, foundry: false, roll20: true } });
    expect(JSON.parse(storage.get(WORKSPACE_UI_KEY) ?? "null")).toEqual(get(workspaceUi));
    expect([...storage.keys()]).toEqual([WORKSPACE_UI_KEY]); // nothing else on the device, nothing in a world
  });

  test("boots from a stored record, tolerates corrupt storage, and reset returns to the defaults", async () => {
    storage.set(WORKSPACE_UI_KEY, JSON.stringify({ profile: "roll20", roll20Scheme: "dark", panels: { roll20: false } }));
    let mod = await import("../../src/ui/workspace/state");
    const { get } = await import("svelte/store");
    expect(get(mod.workspaceUi)).toMatchObject({ profile: "roll20", roll20Scheme: "dark", panels: { roll20: false } });
    mod.resetWorkspaceUi();
    expect(get(mod.workspaceUi)).toEqual(workspaceUiPrefs(null));

    storage.set(WORKSPACE_UI_KEY, "{not json");
    vi.resetModules();
    mod = await import("../../src/ui/workspace/state");
    expect(get(mod.workspaceUi)).toEqual(workspaceUiPrefs(null));
  });

  test("works without device storage at all", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const mod = await import("../../src/ui/workspace/state");
    const { get } = await import("svelte/store");
    expect(() => mod.setWorkspaceProfile("roll20")).not.toThrow();
    expect(get(mod.workspaceUi).profile).toBe("roll20");
  });
});
