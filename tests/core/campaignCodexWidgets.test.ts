import { describe, expect, test } from "vitest";
import {
  CODEX_BUILTIN_WIDGETS,
  CODEX_BUILTIN_WIDGET_TYPES,
  codexWidgetConfigError,
  projectCodexWidgetConfig,
} from "../../src/core/campaignCodexWidgets";
import type { CodexLink, CodexQuest, CodexWidgetInstance } from "../../src/core/documents";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function widget(type: string, config: unknown, version = 1): CodexWidgetInstance {
  return {
    id: "widget-1",
    type,
    version,
    tab: "info",
    order: 0,
    enabled: true,
    config: config as CodexWidgetInstance["config"],
  };
}

describe("Campaign Codex first-party widget contracts", () => {
  test("publishes six versioned safe widget definitions with read-only capabilities", () => {
    expect(CODEX_BUILTIN_WIDGET_TYPES).toHaveLength(6);
    for (const type of CODEX_BUILTIN_WIDGET_TYPES) {
      const definition = CODEX_BUILTIN_WIDGETS[type];
      expect(definition.version).toBe(1);
      expect(definition.configSchema.version).toBe(1);
      expect(definition.configSchema.validate(definition.defaultConfig())).toBeNull();
      expect(definition.capabilities.every((capability) => capability.startsWith("read."))).toBe(true);
    }
  });

  test("bounds gallery hashes, timeline rows, and selected relationship references", () => {
    expect(codexWidgetConfigError("image-gallery", 1, {
      images: [{ assetId: hashA, caption: "Map", alt: "An island" }],
    })).toBeNull();
    expect(codexWidgetConfigError("image-gallery", 1, {
      images: [{ assetId: "https://example.test/map.png" }],
    })).toContain("malformed");
    expect(codexWidgetConfigError("image-gallery", 1, {
      images: [{ assetId: hashA }, { assetId: hashA }],
    })).toContain("duplicated");
    expect(codexWidgetConfigError("timeline", 1, {
      events: [{ id: "e1", date: "Dawn", title: "The first bell", order: 0 }],
    })).toBeNull();
    expect(codexWidgetConfigError("linked-entities", 1, { linkIds: ["missing", "missing"] })).toContain("invalid");
    expect(codexWidgetConfigError("roll-table", 1, { tableId: "bad id" })).toContain("invalid");
    // Future versions remain opaque and inert rather than being parsed with today's schema.
    expect(codexWidgetConfigError("timeline", 2, { arbitrary: [1, 2, 3] })).toBeNull();
    expect(codexWidgetConfigError("vendor.custom", 1, { command: "not run" })).toBeNull();
  });

  test("projects configured link, quest, image and table IDs against the already-filtered view", () => {
    const links: CodexLink[] = [
      { id: "public-link", relation: "relatedTo", target: { coll: "journals", id: "public" } },
    ];
    const quests: CodexQuest[] = [
      { id: "public-quest", title: "Public", description: "", state: "active", pinned: false, order: 0, objectives: [] },
    ];
    const linked = projectCodexWidgetConfig(
      widget("linked-entities", { linkIds: ["public-link", "hidden-link"] }),
      links, quests, () => false, () => false,
    );
    expect(linked).toEqual({ linkIds: ["public-link"] });

    const questList = projectCodexWidgetConfig(
      widget("quest-list", { questIds: ["public-quest", "private-quest"] }),
      links, quests, () => false, () => false,
    );
    expect(questList).toEqual({ questIds: ["public-quest"] });

    const gallery = projectCodexWidgetConfig(
      widget("image-gallery", { images: [
        { assetId: hashA, caption: "public image" },
        { assetId: hashB, caption: "private image" },
      ] }),
      links, quests, (assetId) => assetId === hashA, () => false,
    );
    expect(gallery).toEqual({ images: [{ assetId: hashA, caption: "public image" }] });

    const map = projectCodexWidgetConfig(
      widget("scene-map", { linkId: "private-scene-link", zoom: 1 }),
      links, quests, () => false, () => false,
    );
    expect(map).toEqual({ zoom: 1 });

    const table = projectCodexWidgetConfig(
      widget("roll-table", { tableId: "private-table", showRanges: true }),
      links, quests, () => false, () => false,
    );
    expect(table).toEqual({ showRanges: true });

    expect(projectCodexWidgetConfig(
      widget("vendor.custom", { privateId: "never sent" }, 1),
      links, quests, () => false, () => false,
    )).toEqual({});
  });
});
