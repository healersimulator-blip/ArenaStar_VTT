/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, test } from "vitest";
import { CODEX_BUILTIN_WIDGETS } from "../../src/core/campaignCodexWidgets";
import type { CodexWidgetInstance, Json } from "../../src/core/documents";
import {
  codexWidgetViewForCapabilities,
  getCodexWidget,
  getCurrentCodexWidget,
  listCodexWidgets,
  prepareCodexWidget,
  registerWidget,
  type CodexWidgetRenderer,
  type CodexWidgetViewModel,
} from "../../src/ui/journals/codexWidgetRegistry";

describe("trusted Campaign Codex widget renderer registry", () => {
  test("registers an exact version and unregisters without affecting siblings", () => {
    const renderer = {} as CodexWidgetRenderer;
    const schema = CODEX_BUILTIN_WIDGETS.timeline.configSchema;
    const dispose = registerWidget("test.timeline", 1, renderer, schema, ["read.quests"]);
    expect(getCodexWidget("test.timeline", 1)?.renderer).toBe(renderer);
    expect(getCodexWidget("test.timeline", 2)).toBeUndefined();
    expect(listCodexWidgets().some((entry) => entry.type === "test.timeline")).toBe(true);
    dispose();
    expect(getCodexWidget("test.timeline", 1)).toBeUndefined();
  });

  test("runs only an explicit trusted migration and validates its output before render", () => {
    const renderer = {} as CodexWidgetRenderer;
    const base = CODEX_BUILTIN_WIDGETS.timeline.configSchema;
    const schema = {
      ...base,
      version: 2,
      migrate: (_fromVersion: number, config: Json): Json => {
        const rawEvents = config && typeof config === "object" && !Array.isArray(config) && Array.isArray(config.events)
          ? config.events : [];
        return { events: rawEvents.flatMap((event, order) => typeof event === "string"
          ? [{ id: `legacy-${order}`, date: "Unknown", title: event, order }] : []) };
      },
    };
    const dispose = registerWidget("test.timeline", 2, renderer, schema, ["read.timeline"]);
    try {
      const registration = getCurrentCodexWidget("test.timeline");
      expect(registration).toBeDefined();
      const legacy: CodexWidgetInstance = { id: "legacy", type: "test.timeline", version: 1,
        tab: "info", order: 0, enabled: true, config: { events: ["storm"] } };
      const prepared = prepareCodexWidget(legacy, registration!);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error(prepared.error);
      expect(prepared.migrated).toBe(true);
      expect(prepared.widget.version).toBe(2);
      expect(prepared.widget.config).toEqual({ events: [{ id: "legacy-0", date: "Unknown", title: "storm", order: 0 }] });
      expect(legacy.version).toBe(1); // Preview does not mutate archived data.
    } finally {
      dispose();
    }
  });

  test("filters the renderer model to declared read-only capability scopes", () => {
    const view: CodexWidgetViewModel = {
      links: [{ id: "l", relation: "relatedTo", label: "Link", targetName: "Contact", targetCollection: "actors",
        targetId: "actor-id", targetIsCodexSheet: false }],
      quests: [{ id: "q", title: "Quest", description: "", state: "active", pinned: false, objectives: [] }],
      images: [{ assetId: "a".repeat(64), caption: "Map", alt: "" }],
      timeline: [{ id: "t", date: "Today", title: "Event", description: "", order: 0 }],
      scene: { name: "Harbor", imageAssetId: "b".repeat(64) },
      rollTable: { name: "Table", formula: "1d6", results: [{ range: [1, 6], text: "Nothing" }] },
    };
    const filtered = codexWidgetViewForCapabilities(view, ["read.scenes", "read.assets"]);
    expect(filtered.links).toEqual([]);
    expect(filtered.quests).toEqual([]);
    expect(filtered.images).toEqual(view.images);
    expect(filtered.timeline).toEqual([]);
    expect(filtered.scene).toEqual(view.scene);
    expect(filtered.rollTable).toBeNull();
    expect(codexWidgetViewForCapabilities(view, ["read.scenes"]).scene?.imageAssetId).toBeNull();
  });

  test("rejects untrusted write capabilities, invalid IDs and duplicate versions", () => {
    const renderer = {} as CodexWidgetRenderer;
    const schema = CODEX_BUILTIN_WIDGETS.timeline.configSchema;
    expect(() => registerWidget("Bad Uppercase", 1, renderer, schema, [])).toThrow(/stable lowercase/);
    expect(() => registerWidget("test.write", 1, renderer, schema, ["world.write"] as never)).toThrow(/read-only/);
    const dispose = registerWidget("test.duplicate", 1, renderer, schema, []);
    try {
      expect(() => registerWidget("test.duplicate", 1, renderer, schema, [])).toThrow(/already registered/);
    } finally {
      dispose();
    }
  });
});
