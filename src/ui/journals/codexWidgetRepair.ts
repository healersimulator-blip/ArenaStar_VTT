import type { CodexWidgetInstance, Json } from "../../core/documents";
import { CODEX_BUILTIN_WIDGET_TYPES } from "../../core/campaignCodexWidgets";

export type CodexWidgetDependencyKind =
  "roll-table" | "gallery-image" | "relationship" | "scene-link" | "quest";

export interface CodexWidgetDependencyIssue {
  key: string;
  widgetId: string;
  widgetType: string;
  kind: CodexWidgetDependencyKind;
  target: string;
  /** Index into an array-valued config field. Null identifies a single-value field or malformed list. */
  index: number | null;
  malformed: boolean;
}

export interface CodexWidgetDependencyOptions {
  widgets: readonly CodexWidgetInstance[];
  relationshipIds: ReadonlySet<string>;
  sceneLinkIds: ReadonlySet<string>;
  questIds: ReadonlySet<string>;
  rollTableIds: ReadonlySet<string>;
  assetIds: ReadonlySet<string>;
}

export type CodexWidgetRepairResult =
  { ok: true; widget: CodexWidgetInstance } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStableId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isAssetHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

/** Find missing or unusable dependencies only in widget schemas this client understands. */
export function findCodexWidgetDependencyIssues(
  options: CodexWidgetDependencyOptions,
): CodexWidgetDependencyIssue[] {
  const issues: CodexWidgetDependencyIssue[] = [];
  const add = (
    widget: CodexWidgetInstance,
    kind: CodexWidgetDependencyKind,
    target: string,
    index: number | null,
    malformed: boolean,
  ): void => {
    issues.push({
      key: `${widget.id}:${kind}:${index ?? "single"}:${target}`,
      widgetId: widget.id,
      widgetType: widget.type,
      kind,
      target,
      index,
      malformed,
    });
  };

  for (const widget of options.widgets) {
    if (
      !CODEX_BUILTIN_WIDGET_TYPES.includes(
        widget.type as (typeof CODEX_BUILTIN_WIDGET_TYPES)[number],
      ) ||
      widget.version !== 1 ||
      !isRecord(widget.config)
    )
      continue;
    const config = widget.config;

    if (
      widget.type === "roll-table" &&
      Object.hasOwn(config, "tableId") &&
      config.tableId !== ""
    ) {
      const tableId = config.tableId;
      if (!isStableId(tableId) || !options.rollTableIds.has(tableId))
        add(widget, "roll-table", String(tableId), null, !isStableId(tableId));
    }

    if (widget.type === "image-gallery" && Object.hasOwn(config, "images")) {
      if (!Array.isArray(config.images)) {
        add(widget, "gallery-image", "malformed images list", null, true);
      } else {
        config.images.forEach((image, index) => {
          if (
            !isRecord(image) ||
            !isAssetHash(image.assetId) ||
            !options.assetIds.has(image.assetId)
          ) {
            const assetId = isRecord(image) ? image.assetId : undefined;
            add(
              widget,
              "gallery-image",
              String(assetId ?? "malformed image"),
              index,
              !isRecord(image) || !isAssetHash(image.assetId),
            );
          }
        });
      }
    }

    if (widget.type === "linked-entities" && Object.hasOwn(config, "linkIds")) {
      if (!Array.isArray(config.linkIds)) {
        add(widget, "relationship", "malformed relationship list", null, true);
      } else {
        config.linkIds.forEach((linkId, index) => {
          if (!isStableId(linkId) || !options.relationshipIds.has(linkId))
            add(
              widget,
              "relationship",
              String(linkId),
              index,
              !isStableId(linkId),
            );
        });
      }
    }

    if (
      widget.type === "scene-map" &&
      Object.hasOwn(config, "linkId") &&
      config.linkId !== ""
    ) {
      const linkId = config.linkId;
      if (!isStableId(linkId) || !options.sceneLinkIds.has(linkId))
        add(widget, "scene-link", String(linkId), null, !isStableId(linkId));
    }

    if (widget.type === "quest-list" && Object.hasOwn(config, "questIds")) {
      if (!Array.isArray(config.questIds)) {
        add(widget, "quest", "malformed quest list", null, true);
      } else {
        config.questIds.forEach((questId, index) => {
          if (!isStableId(questId) || !options.questIds.has(questId))
            add(widget, "quest", String(questId), index, !isStableId(questId));
        });
      }
    }
  }
  return issues;
}

/** Apply only the GM-selected replacement or removal; the function never guesses a target. */
export function repairCodexWidgetDependency(
  widget: CodexWidgetInstance,
  issue: CodexWidgetDependencyIssue,
  replacementId: string | null,
): CodexWidgetRepairResult {
  if (
    widget.id !== issue.widgetId ||
    widget.type !== issue.widgetType ||
    widget.version !== 1
  )
    return {
      ok: false,
      error: "The widget changed before this repair was submitted.",
    };
  if (replacementId !== null) {
    const valid =
      issue.kind === "gallery-image"
        ? isAssetHash(replacementId)
        : isStableId(replacementId);
    if (!valid)
      return {
        ok: false,
        error:
          "Choose a valid replacement target or remove the stale reference.",
      };
  }
  if (!isRecord(widget.config))
    return {
      ok: false,
      error: "The widget configuration is not a repairable object.",
    };

  const config = { ...widget.config };
  switch (issue.kind) {
    case "roll-table":
      if (widget.type !== "roll-table") break;
      if (replacementId === null) delete config.tableId;
      else config.tableId = replacementId;
      return { ok: true, widget: { ...widget, config: config as Json } };

    case "gallery-image": {
      if (widget.type !== "image-gallery") break;
      const images = Array.isArray(config.images) ? [...config.images] : [];
      if (issue.index === null) {
        if (replacementId === null) delete config.images;
        else config.images = [{ assetId: replacementId }];
      } else if (replacementId === null) {
        if (issue.index < 0 || issue.index >= images.length)
          return {
            ok: false,
            error:
              "The gallery entry changed before this repair was submitted.",
          };
        images.splice(issue.index, 1);
        config.images = images;
      } else {
        const previous = images[issue.index];
        images[issue.index] = isRecord(previous)
          ? { ...previous, assetId: replacementId }
          : { assetId: replacementId };
        config.images = images;
      }
      return { ok: true, widget: { ...widget, config: config as Json } };
    }

    case "relationship":
    case "quest": {
      const expectedType =
        issue.kind === "relationship" ? "linked-entities" : "quest-list";
      const field = issue.kind === "relationship" ? "linkIds" : "questIds";
      if (widget.type !== expectedType) break;
      const ids = Array.isArray(config[field]) ? [...config[field]] : [];
      if (issue.index !== null) {
        if (issue.index < 0 || issue.index >= ids.length)
          return {
            ok: false,
            error:
              "The widget reference changed before this repair was submitted.",
          };
        ids.splice(issue.index, 1);
      }
      if (replacementId !== null && !ids.includes(replacementId))
        ids.push(replacementId);
      if (ids.length === 0 && replacementId === null) {
        if (issue.kind === "relationship") delete config.linkIds;
        else delete config.questIds;
      } else config[field] = ids;
      return { ok: true, widget: { ...widget, config: config as Json } };
    }

    case "scene-link":
      if (widget.type !== "scene-map") break;
      if (replacementId === null) delete config.linkId;
      else config.linkId = replacementId;
      return { ok: true, widget: { ...widget, config: config as Json } };
  }
  return { ok: false, error: "The repair does not match this widget type." };
}
