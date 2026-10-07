/**
 * Trusted local renderer registry for declarative Campaign Codex widgets.
 *
 * Registering code is a package-author action, not a world-data capability: imported journal data
 * can only select an already-registered (type, version) and supply JSON validated by its schema.
 * Renderers receive a projected read-only view model, never ClientSync or a host store handle.
 */
import type { Component } from "svelte";
import type { CodexWidgetInstance, Json } from "../../core/documents";
import type {
  CodexWidgetCapability,
  CodexWidgetConfigSchema,
} from "../../core/campaignCodexWidgets";

export interface CodexWidgetLinkView {
  id: string;
  relation: string;
  label: string;
  targetName: string;
  targetCollection: string;
  targetId?: string;
  targetIsCodexSheet: boolean;
}

export interface CodexWidgetImageView {
  assetId: string;
  caption: string;
  alt: string;
}

export interface CodexWidgetTimelineEventView {
  id: string;
  date: string;
  title: string;
  description: string;
  order: number;
}

export interface CodexWidgetSceneView {
  name: string;
  imageAssetId: string | null;
}

export interface CodexWidgetRollTableView {
  name: string;
  formula: string;
  results: Array<{ range: [number, number]; text: string }>;
}

/** Only viewer-authorized data, with each relationship target already resolved. */
export interface CodexWidgetViewModel {
  links: CodexWidgetLinkView[];
  quests: Array<{
    id: string;
    title: string;
    description: string;
    state: string;
    pinned: boolean;
    objectives: Array<{ id: string; title: string; completed: boolean }>;
  }>;
  images: CodexWidgetImageView[];
  timeline: CodexWidgetTimelineEventView[];
  scene: CodexWidgetSceneView | null;
  rollTable: CodexWidgetRollTableView | null;
}

export interface CodexWidgetRendererProps {
  widget: CodexWidgetInstance;
  view: CodexWidgetViewModel;
  resolveAsset?: ((assetId: string) => string | null) | null;
  onOpenSheet?: ((sheetId: string) => void) | null;
}

export type CodexWidgetRenderer = Component<CodexWidgetRendererProps>;

export interface CodexWidgetRegistration {
  type: string;
  version: number;
  renderer: CodexWidgetRenderer;
  configSchema: CodexWidgetConfigSchema;
  capabilities: readonly CodexWidgetCapability[];
}

const ALLOWED_CAPABILITIES = new Set<CodexWidgetCapability>([
  "read.links",
  "read.quests",
  "read.assets",
  "read.scenes",
  "read.rollTables",
  "read.timeline",
]);
const registrations = new Map<string, CodexWidgetRegistration>();
const registryKey = (type: string, version: number): string => `${type}@${version}`;

/** Register one trusted renderer. All capabilities are read-only and are descriptive contracts. */
export function registerWidget(
  type: string,
  version: number,
  renderer: CodexWidgetRenderer,
  configSchema: CodexWidgetConfigSchema,
  capabilities: readonly CodexWidgetCapability[],
): () => void {
  if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(type))
    throw new Error("Codex widget type must be a stable lowercase package/type id");
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("Codex widget version must be a positive integer");
  if (!renderer || typeof configSchema?.validate !== "function" ||
      !Number.isSafeInteger(configSchema.version) || configSchema.version < 1 || configSchema.version !== version ||
      configSchema.migrate !== undefined && typeof configSchema.migrate !== "function")
    throw new Error("Codex widget renderer and same-version config schema are required");
  if (capabilities.length > 16 || new Set(capabilities).size !== capabilities.length ||
      capabilities.some((capability) => !ALLOWED_CAPABILITIES.has(capability)))
    throw new Error("Codex widgets may request only known, read-only data capabilities");
  const key = registryKey(type, version);
  if (registrations.has(key)) throw new Error(`Codex widget '${key}' is already registered`);
  const registration = { type, version, renderer, configSchema, capabilities: [...capabilities] };
  registrations.set(key, registration);
  return () => {
    if (registrations.get(key) === registration) registrations.delete(key);
  };
}

export function getCodexWidget(type: string, version: number): CodexWidgetRegistration | undefined {
  return registrations.get(registryKey(type, version));
}

/** Newest locally trusted version; older saved instances may be migrated through its declared hook. */
export function getCurrentCodexWidget(type: string): CodexWidgetRegistration | undefined {
  return [...registrations.values()].filter((entry) => entry.type === type)
    .sort((a, b) => b.version - a.version)[0];
}

export type PreparedCodexWidget =
  | { ok: true; widget: CodexWidgetInstance; migrated: boolean }
  | { ok: false; error: string };

/** Validates a saved widget before rendering and runs only the trusted local schema's pure migration. */
export function prepareCodexWidget(
  widget: CodexWidgetInstance,
  registration: CodexWidgetRegistration,
): PreparedCodexWidget {
  if (widget.version > registration.version)
    return { ok: false, error: "This widget data is newer than the installed renderer." };
  let config = widget.config;
  const migrated = widget.version !== registration.version;
  if (migrated) {
    if (!registration.configSchema.migrate)
      return { ok: false, error: "No trusted migration is registered for this widget version." };
    try {
      const result = registration.configSchema.migrate(widget.version, config);
      if (result === null) return { ok: false, error: "The trusted widget migration could not convert this config." };
      config = result;
    } catch {
      return { ok: false, error: "The trusted widget migration failed; its saved data was not changed." };
    }
  }
  const error = registration.configSchema.validate(config);
  if (error) return { ok: false, error: `Widget config is invalid: ${error}` };
  return { ok: true, widget: migrated ? { ...widget, version: registration.version, config } : widget, migrated };
}

/** Capability boundary: each trusted renderer receives only the data scopes it explicitly declared. */
export function codexWidgetViewForCapabilities(
  view: CodexWidgetViewModel,
  capabilities: readonly CodexWidgetCapability[],
): CodexWidgetViewModel {
  const allowed = new Set(capabilities);
  const canAssets = allowed.has("read.assets");
  const canScenes = allowed.has("read.scenes");
  return {
    links: allowed.has("read.links") ? view.links : [],
    quests: allowed.has("read.quests") ? view.quests : [],
    images: canAssets ? view.images : [],
    timeline: allowed.has("read.timeline") ? view.timeline : [],
    scene: canScenes ? {
      name: view.scene?.name ?? "",
      imageAssetId: canAssets ? view.scene?.imageAssetId ?? null : null,
    } : null,
    rollTable: allowed.has("read.rollTables") ? view.rollTable : null,
  };
}

export function listCodexWidgets(): readonly CodexWidgetRegistration[] {
  return [...registrations.values()].sort((a, b) => a.type.localeCompare(b.type) || a.version - b.version);
}

/** A renderer is never handed arbitrary JSON from an unsupported or invalid definition. */
export function validatedWidgetConfig(registration: CodexWidgetRegistration, config: Json): Json | null {
  return registration.configSchema.validate(config) === null ? config : null;
}
