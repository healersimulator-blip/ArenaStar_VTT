import { describe, expect, it } from "vitest";
import type { CodexWidgetInstance, Json } from "../../src/core/documents";
import {
  findCodexWidgetDependencyIssues,
  repairCodexWidgetDependency,
} from "../../src/ui/journals/codexWidgetRepair";

const asset = "a".repeat(64);

const widget = (
  id: string,
  type: string,
  config: Record<string, unknown>,
  version = 1,
): CodexWidgetInstance => ({
  id,
  type,
  version,
  tab: "info",
  order: 0,
  enabled: true,
  config: config as Json,
});

const issuesFor = (widgets: readonly CodexWidgetInstance[]) =>
  findCodexWidgetDependencyIssues({
    widgets,
    relationshipIds: new Set(["live-link"]),
    sceneLinkIds: new Set(["live-scene-link"]),
    questIds: new Set(["live-quest"]),
    rollTableIds: new Set(["live-table"]),
    assetIds: new Set([asset]),
  });

describe("explicit post-restore widget dependency repair", () => {
  it("finds missing supported document, asset, relationship, scene-link, and quest refs", () => {
    const widgets = [
      widget("table", "roll-table", { tableId: "missing-table" }),
      widget("gallery", "image-gallery", {
        images: [{ assetId: "b".repeat(64), caption: "Keep me" }],
      }),
      widget("links", "linked-entities", {
        linkIds: ["live-link", "missing-link"],
      }),
      widget("map", "scene-map", { linkId: "missing-scene-link" }),
      widget("quests", "quest-list", { questIds: ["missing-quest"] }),
      widget("future", "third-party-widget", { sceneId: "uninspected" }, 7),
    ];
    const issues = issuesFor(widgets);
    expect(
      issues.map(({ widgetId, kind, target }) => ({ widgetId, kind, target })),
    ).toEqual([
      { widgetId: "table", kind: "roll-table", target: "missing-table" },
      { widgetId: "gallery", kind: "gallery-image", target: "b".repeat(64) },
      { widgetId: "links", kind: "relationship", target: "missing-link" },
      { widgetId: "map", kind: "scene-link", target: "missing-scene-link" },
      { widgetId: "quests", kind: "quest", target: "missing-quest" },
    ]);
  });

  it("uses only the chosen replacement and leaves unrelated widget config intact", () => {
    const source = widget("links", "linked-entities", {
      linkIds: ["live-link", "missing-link"],
      relation: "relatedTo",
      maxItems: 10,
    });
    const issue = issuesFor([source]).find(
      (candidate) => candidate.target === "missing-link",
    );
    if (!issue)
      throw new Error("Expected the missing link reference to be reported");
    const repaired = repairCodexWidgetDependency(source, issue, "chosen-link");
    expect(repaired).toMatchObject({
      ok: true,
      widget: {
        config: {
          linkIds: ["live-link", "chosen-link"],
          relation: "relatedTo",
          maxItems: 10,
        },
      },
    });
    expect(source.config).toEqual({
      linkIds: ["live-link", "missing-link"],
      relation: "relatedTo",
      maxItems: 10,
    });
  });

  it("removes one stale gallery image without discarding its neighboring image", () => {
    const source = widget("gallery", "image-gallery", {
      images: [
        { assetId: asset, caption: "Healthy" },
        { assetId: "b".repeat(64), caption: "Stale" },
      ],
    });
    const issue = issuesFor([source])[0];
    if (!issue)
      throw new Error("Expected the stale gallery image to be reported");
    expect(issue.kind).toBe("gallery-image");
    const result = repairCodexWidgetDependency(source, issue, null);
    expect(result).toMatchObject({
      ok: true,
      widget: { config: { images: [{ assetId: asset, caption: "Healthy" }] } },
    });
    expect(source.config).toEqual({
      images: [
        { assetId: asset, caption: "Healthy" },
        { assetId: "b".repeat(64), caption: "Stale" },
      ],
    });
  });

  it("rejects a replacement with the wrong ID shape or a mismatched widget", () => {
    const source = widget("quests", "quest-list", { questIds: ["missing"] });
    const issue = issuesFor([source])[0];
    if (!issue)
      throw new Error("Expected the stale quest reference to be reported");
    expect(
      repairCodexWidgetDependency(source, issue, "not a stable id"),
    ).toMatchObject({ ok: false });
    expect(
      repairCodexWidgetDependency(
        widget("other", "quest-list", { questIds: ["missing"] }),
        issue,
        "live-quest",
      ),
    ).toMatchObject({ ok: false });
  });
});
