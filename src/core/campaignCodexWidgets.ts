/**
 * Safe, declarative configuration contracts for Campaign Codex's first-party widgets.
 *
 * This module is deliberately framework-free: host validation, archive tooling, and UI all
 * share the same bounded schemas. Widget config is data, never code. Unknown widget types and
 * future versions are preserved inertly; they are not interpreted by this module.
 */
import type { CodexLink, CodexQuest, CodexWidgetInstance, DocRef, Json } from "./documents";

export const CODEX_WIDGET_VERSION = 1;
export const CODEX_BUILTIN_WIDGET_TYPES = [
  "linked-entities",
  "quest-list",
  "image-gallery",
  "timeline",
  "scene-map",
  "roll-table",
] as const;
export type CodexBuiltinWidgetType = (typeof CODEX_BUILTIN_WIDGET_TYPES)[number];

export type CodexWidgetCapability =
  | "read.links"
  | "read.quests"
  | "read.assets"
  | "read.scenes"
  | "read.rollTables"
  | "read.timeline";

export type CodexWidgetConfigField =
  | { key: string; label: string; type: "text"; maxLength: number; multiline?: boolean }
  | { key: string; label: string; type: "number"; min: number; max: number; step?: number }
  | { key: string; label: string; type: "boolean" }
  | { key: string; label: string; type: "link-picker"; relation?: "linksScene" }
  | { key: string; label: string; type: "quest-picker" }
  | { key: string; label: string; type: "asset-picker"; maxItems: number }
  | { key: string; label: string; type: "roll-table-picker" }
  | { key: string; label: string; type: "event-list"; maxItems: number };

export interface CodexWidgetConfigSchema {
  version: number;
  fields: readonly CodexWidgetConfigField[];
  validate(config: unknown): string | null;
  /** Trusted local migration hook for older persisted versions; its output is validated before render. */
  migrate?(fromVersion: number, config: Json): Json | null;
}

export interface CodexBuiltinWidgetDefinition {
  type: CodexBuiltinWidgetType;
  version: number;
  label: string;
  capabilities: readonly CodexWidgetCapability[];
  configSchema: CodexWidgetConfigSchema;
  defaultConfig: () => Json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stableId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hashId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const shortText = (value: unknown, max: number, nonempty = false): value is string =>
  typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0);

function uniqueIds(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max &&
    value.every(stableId) && new Set(value).size === value.length;
}

function schema(
  fields: readonly CodexWidgetConfigField[],
  validate: (config: Record<string, unknown>) => string | null,
  extraKeys: readonly string[] = [],
): CodexWidgetConfigSchema {
  const allowedKeys = new Set([...fields.map((field) => field.key), ...extraKeys]);
  return {
    version: CODEX_WIDGET_VERSION,
    fields,
    validate(config) {
      if (!isRecord(config)) return "Widget configuration must be a plain object";
      try {
        if (JSON.stringify(config).length > 16_384) return "Widget configuration is too large";
      } catch {
        return "Widget configuration must be JSON data";
      }
      if (Object.keys(config).some((key) => !allowedKeys.has(key)))
        return "Widget configuration contains unsupported fields";
      return validate(config);
    },
  };
}

const linkedEntitiesSchema = schema(
  [
    { key: "linkIds", label: "Relationships", type: "link-picker" },
    { key: "maxItems", label: "Maximum records", type: "number", min: 1, max: 50, step: 1 },
  ],
  (config) =>
    (config.linkIds !== undefined && !uniqueIds(config.linkIds, 200)) ||
    (config.maxItems !== undefined && (!Number.isSafeInteger(config.maxItems) || Number(config.maxItems) < 1 || Number(config.maxItems) > 50))
      ? "Linked entities widget config is invalid"
      : config.relation !== undefined && !("contains locatedAt associatedWith operatedBy representsActor linksScene linksItem relatedTo".split(" ").includes(String(config.relation)))
        ? "Linked entities relation filter is invalid"
        : null,
  ["relation"],
);

const questListSchema = schema(
  [
    { key: "questIds", label: "Quests", type: "quest-picker" },
    { key: "showCompleted", label: "Show completed quests", type: "boolean" },
  ],
  (config) =>
    (config.questIds !== undefined && !uniqueIds(config.questIds, 128)) ||
    (config.showCompleted !== undefined && typeof config.showCompleted !== "boolean")
      ? "Quest list widget config is invalid"
      : null,
);

const imageGallerySchema = schema(
  [{ key: "images", label: "Gallery images", type: "asset-picker", maxItems: 40 }],
  (config) => {
    if (!Array.isArray(config.images) || config.images.length > 40) return "Image gallery config must contain at most 40 images";
    const seen = new Set<string>();
    for (const image of config.images) {
      if (!isRecord(image) || !hashId(image.assetId) || seen.has(image.assetId)) return "Image gallery asset is malformed or duplicated";
      seen.add(image.assetId);
      if (image.caption !== undefined && !shortText(image.caption, 240)) return "Image gallery caption is too long";
      if (image.alt !== undefined && !shortText(image.alt, 240)) return "Image gallery alt text is too long";
    }
    return null;
  },
);

const timelineSchema = schema(
  [{ key: "events", label: "Timeline events", type: "event-list", maxItems: 100 }],
  (config) => {
    if (!Array.isArray(config.events) || config.events.length > 100) return "Timeline config must contain at most 100 events";
    const ids = new Set<string>();
    for (const event of config.events) {
      if (!isRecord(event) || !stableId(event.id) || ids.has(event.id) ||
          !shortText(event.date, 80, true) || !shortText(event.title, 200, true) ||
          !Number.isSafeInteger(event.order) || Math.abs(Number(event.order)) > 100_000 ||
          event.description !== undefined && !shortText(event.description, 2_000))
        return "Timeline event is malformed or duplicated";
      ids.add(event.id);
    }
    return null;
  },
);

const sceneMapSchema = schema(
  [
    { key: "linkId", label: "Linked scene", type: "link-picker", relation: "linksScene" },
    { key: "zoom", label: "Preview zoom", type: "number", min: 0.5, max: 2, step: 0.1 },
  ],
  (config) =>
    (config.linkId !== undefined && config.linkId !== "" && !stableId(config.linkId)) ||
    (config.zoom !== undefined && (typeof config.zoom !== "number" || !Number.isFinite(config.zoom) || config.zoom < 0.5 || config.zoom > 2))
      ? "Scene map widget config is invalid"
      : null,
);

const rollTableSchema = schema(
  [
    { key: "tableId", label: "Roll table", type: "roll-table-picker" },
    { key: "showRanges", label: "Show result ranges", type: "boolean" },
  ],
  (config) =>
    (config.tableId !== undefined && config.tableId !== "" && !stableId(config.tableId)) ||
    (config.showRanges !== undefined && typeof config.showRanges !== "boolean")
      ? "Roll table widget config is invalid"
      : null,
);

export const CODEX_BUILTIN_WIDGETS: Readonly<Record<CodexBuiltinWidgetType, CodexBuiltinWidgetDefinition>> = {
  "linked-entities": {
    type: "linked-entities", version: CODEX_WIDGET_VERSION, label: "Linked entities",
    capabilities: ["read.links"], configSchema: linkedEntitiesSchema, defaultConfig: () => ({}),
  },
  "quest-list": {
    type: "quest-list", version: CODEX_WIDGET_VERSION, label: "Quest list",
    capabilities: ["read.quests"], configSchema: questListSchema, defaultConfig: () => ({}),
  },
  "image-gallery": {
    type: "image-gallery", version: CODEX_WIDGET_VERSION, label: "Image gallery",
    capabilities: ["read.assets"], configSchema: imageGallerySchema, defaultConfig: () => ({ images: [] }),
  },
  timeline: {
    type: "timeline", version: CODEX_WIDGET_VERSION, label: "Timeline",
    capabilities: ["read.timeline"], configSchema: timelineSchema, defaultConfig: () => ({ events: [] }),
  },
  "scene-map": {
    type: "scene-map", version: CODEX_WIDGET_VERSION, label: "Scene map",
    capabilities: ["read.links", "read.scenes", "read.assets"], configSchema: sceneMapSchema, defaultConfig: () => ({}),
  },
  "roll-table": {
    type: "roll-table", version: CODEX_WIDGET_VERSION, label: "Roll table",
    capabilities: ["read.rollTables"], configSchema: rollTableSchema, defaultConfig: () => ({}),
  },
};

export function codexWidgetConfigError(type: string, version: number, config: unknown): string | null {
  if (version !== CODEX_WIDGET_VERSION || !Object.hasOwn(CODEX_BUILTIN_WIDGETS, type)) return null;
  return CODEX_BUILTIN_WIDGETS[type as CodexBuiltinWidgetType].configSchema.validate(config);
}

export function defaultCodexWidgetConfig(type: string): Json {
  return Object.hasOwn(CODEX_BUILTIN_WIDGETS, type)
    ? CODEX_BUILTIN_WIDGETS[type as CodexBuiltinWidgetType].defaultConfig()
    : {};
}

/** Stable table references carried inside first-party widget config. */
export function codexWidgetDocumentRefs(widget: CodexWidgetInstance): DocRef[] {
  if (widget.type !== "roll-table" || widget.version !== CODEX_WIDGET_VERSION || !isRecord(widget.config)) return [];
  return stableId(widget.config.tableId)
    ? [{ coll: "rollTables", id: widget.config.tableId } as DocRef]
    : [];
}

export function codexWidgetAssetIds(widget: CodexWidgetInstance): string[] {
  if (widget.type !== "image-gallery" || widget.version !== CODEX_WIDGET_VERSION || !isRecord(widget.config) || !Array.isArray(widget.config.images)) return [];
  return widget.config.images.flatMap((image) => isRecord(image) && hashId(image.assetId) ? [image.assetId] : []);
}

/**
 * Projects only safe, schema-aware references into a widget. The caller supplies already
 * permission-filtered links/quests and an asset predicate evaluated against the live manifest.
 * Unknown versions/types return an empty object and are rendered as inert placeholders.
 */
export function projectCodexWidgetConfig(
  widget: CodexWidgetInstance,
  visibleLinks: readonly CodexLink[],
  visibleQuests: readonly CodexQuest[],
  canReadAsset: (assetId: string) => boolean,
  canReadRollTable: (tableId: string) => boolean,
): Json {
  if (widget.version !== CODEX_WIDGET_VERSION || !isRecord(widget.config) ||
      codexWidgetConfigError(widget.type, widget.version, widget.config)) return {};
  const config = widget.config;
  const linkIds = new Set(visibleLinks.map((link) => link.id));
  const questIds = new Set(visibleQuests.map((quest) => quest.id));
  switch (widget.type) {
    case "linked-entities": {
      const selected = Array.isArray(config.linkIds) ? config.linkIds.filter((id): id is string => typeof id === "string" && linkIds.has(id)) : undefined;
      return { ...config, ...(selected === undefined ? {} : { linkIds: selected }) } as Json;
    }
    case "quest-list": {
      const selected = Array.isArray(config.questIds) ? config.questIds.filter((id): id is string => typeof id === "string" && questIds.has(id)) : undefined;
      return { ...config, ...(selected === undefined ? {} : { questIds: selected }) } as Json;
    }
    case "image-gallery": {
      const images = (config.images as Array<Record<string, unknown>>).filter((image) => canReadAsset(String(image.assetId)));
      return { ...config, images } as Json;
    }
    case "timeline":
      return { ...config } as Json;
    case "scene-map": {
      const linkId = config.linkId;
      if (typeof linkId === "string" && linkId !== "" && !visibleLinks.some((link) => link.id === linkId && link.relation === "linksScene")) {
        const safe = { ...config };
        delete safe.linkId;
        return safe as Json;
      }
      return { ...config } as Json;
    }
    case "roll-table": {
      if (typeof config.tableId === "string" && config.tableId !== "" && !canReadRollTable(config.tableId)) {
        const safe = { ...config };
        delete safe.tableId;
        return safe as Json;
      }
      return { ...config } as Json;
    }
    default:
      return {};
  }
}

/** Relationship or quest ids selected explicitly by a widget config. */
export function codexWidgetVisibleReferences(widget: CodexWidgetInstance): { linkIds: string[]; questIds: string[] } {
  if (!isRecord(widget.config)) return { linkIds: [], questIds: [] };
  return {
    linkIds: Array.isArray(widget.config.linkIds) ? widget.config.linkIds.filter(stableId) :
      widget.type === "scene-map" && stableId(widget.config.linkId) ? [widget.config.linkId] : [],
    questIds: Array.isArray(widget.config.questIds) ? widget.config.questIds.filter(stableId) : [],
  };
}
