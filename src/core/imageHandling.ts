/** Shared preferences, world defaults and duplicate policies for the image ingest UI. */
import type { AssetManifest, AssetManifestEntry, Json, SceneGrid } from "./documents";

export type ImageAction =
  | "newScene"
  | "replaceBackground"
  | "replaceForeground"
  | "tileNatural"
  | "tileFit"
  | "tileGrid"
  | "journalPage"
  | "tokenArt"
  | "showPlayers"
  | "preview";
export type ImageSourceMode = "store" | "link";
export type DuplicateFileBehavior = "stop" | "reuse" | "overwrite" | "ask";

export interface ImageDialogSize {
  width: number;
  height: number;
}

export interface ImageHandlingPreferences {
  dropEnabled: boolean;
  pasteEnabled: boolean;
  defaultAction: ImageAction;
  rememberLastAction: boolean;
  lastUsedAction: ImageAction | null;
  defaultShareToPlayers: boolean;
  activateNewScene: boolean;
  defaultNavigation: boolean;
  defaultUploadFolder: string;
  uploadFolderHistory: string[];
  dialogWindowSizes: ImageDialogSize;
  targetJournal: string;
  autoCreateJournal: boolean;
  autoCreateJournalName: string;
  webpConvert: boolean;
  webpQuality: number;
  urlMode: ImageSourceMode;
  playerRestrictedMode: boolean;
}

export const DEFAULT_IMAGE_HANDLING_PREFERENCES: Readonly<ImageHandlingPreferences> = {
  dropEnabled: true,
  pasteEnabled: true,
  defaultAction: "newScene",
  rememberLastAction: true,
  lastUsedAction: null,
  defaultShareToPlayers: false,
  activateNewScene: false,
  defaultNavigation: false,
  defaultUploadFolder: "Images",
  uploadFolderHistory: ["Images"],
  dialogWindowSizes: { width: 760, height: 680 },
  targetJournal: "",
  autoCreateJournal: true,
  autoCreateJournalName: "mini-uploader",
  webpConvert: false,
  webpQuality: 0.8,
  urlMode: "store",
  playerRestrictedMode: true,
};

export const IMAGE_ACTIONS: readonly ImageAction[] = [
  "newScene",
  "replaceBackground",
  "replaceForeground",
  "tileNatural",
  "tileFit",
  "tileGrid",
  "journalPage",
  "tokenArt",
  "showPlayers",
  "preview",
];

export function isImageAction(value: unknown): value is ImageAction {
  return IMAGE_ACTIONS.includes(value as ImageAction);
}

/** Clamp old/corrupt client settings to safe, forward-compatible defaults. */
export function imageHandlingPreferencesOf(value: unknown): ImageHandlingPreferences {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Partial<ImageHandlingPreferences>
    : {};
  const size = typeof raw.dialogWindowSizes === "object" && raw.dialogWindowSizes !== null
    ? raw.dialogWindowSizes as Partial<ImageDialogSize>
    : {};
  const folders = Array.isArray(raw.uploadFolderHistory)
    ? raw.uploadFolderHistory.filter((v): v is string => typeof v === "string").slice(0, 10)
    : [...DEFAULT_IMAGE_HANDLING_PREFERENCES.uploadFolderHistory];
  const quality = Number(raw.webpQuality);
  const defaultFolder = typeof raw.defaultUploadFolder === "string" ? raw.defaultUploadFolder.slice(0, 240) : "Images";
  const autoName = typeof raw.autoCreateJournalName === "string" ? raw.autoCreateJournalName.slice(0, 160) : "mini-uploader";
  return {
    ...DEFAULT_IMAGE_HANDLING_PREFERENCES,
    dropEnabled: raw.dropEnabled !== false,
    pasteEnabled: raw.pasteEnabled !== false,
    defaultAction: isImageAction(raw.defaultAction) ? raw.defaultAction : "newScene",
    rememberLastAction: raw.rememberLastAction !== false,
    lastUsedAction: isImageAction(raw.lastUsedAction) ? raw.lastUsedAction : null,
    defaultShareToPlayers: raw.defaultShareToPlayers === true,
    activateNewScene: raw.activateNewScene === true,
    defaultNavigation: raw.defaultNavigation === true,
    defaultUploadFolder: defaultFolder,
    uploadFolderHistory: folders,
    dialogWindowSizes: {
      width: Number.isFinite(size.width) ? Math.round(Math.min(1600, Math.max(420, size.width as number))) : 760,
      height: Number.isFinite(size.height) ? Math.round(Math.min(1400, Math.max(420, size.height as number))) : 680,
    },
    targetJournal: typeof raw.targetJournal === "string" ? raw.targetJournal.slice(0, 256) : "",
    autoCreateJournal: raw.autoCreateJournal !== false,
    autoCreateJournalName: autoName || "mini-uploader",
    webpConvert: raw.webpConvert === true,
    webpQuality: Number.isFinite(quality) ? Math.min(1, Math.max(0.1, quality)) : 0.8,
    urlMode: raw.urlMode === "link" ? "link" : "store",
    playerRestrictedMode: raw.playerRestrictedMode !== false,
  };
}

export type ImagePreferencesStorage = Pick<Storage, "getItem" | "setItem">;

export function imageHandlingPreferencesKey(worldId: string, userId: string): string {
  return `vtt:image-handling:${encodeURIComponent(worldId)}:${encodeURIComponent(userId)}`;
}

export function loadImageHandlingPreferences(
  worldId: string,
  userId: string,
  storage: ImagePreferencesStorage | null = safeLocalStorage(),
): ImageHandlingPreferences {
  if (!storage) return imageHandlingPreferencesOf(null);
  try {
    const serialized = storage.getItem(imageHandlingPreferencesKey(worldId, userId));
    return imageHandlingPreferencesOf(serialized ? JSON.parse(serialized) as unknown : null);
  } catch {
    return imageHandlingPreferencesOf(null);
  }
}

export function saveImageHandlingPreferences(
  worldId: string,
  userId: string,
  value: unknown,
  storage: ImagePreferencesStorage | null = safeLocalStorage(),
): ImageHandlingPreferences {
  const normalized = imageHandlingPreferencesOf(value);
  if (storage) {
    try { storage.setItem(imageHandlingPreferencesKey(worldId, userId), JSON.stringify(normalized)); }
    catch { /* private browsing / storage quota: preferences still work for this session */ }
  }
  return normalized;
}

function safeLocalStorage(): ImagePreferencesStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export interface SceneExpressDefaults {
  enabled: boolean;
  destinationLogicalFolder: string;
  duplicateFileBehavior: DuplicateFileBehavior;
  duplicateSceneBehavior: DuplicateFileBehavior;
  gridType: SceneGrid["type"];
  gridSize: number;
  navigation: boolean;
  ownership: "gm" | "all";
  tokenVision: boolean;
  fogExploration: boolean;
  activateImmediately: boolean;
}

export const DEFAULT_SCENE_EXPRESS_DEFAULTS: Readonly<SceneExpressDefaults> = {
  enabled: true,
  destinationLogicalFolder: "Scenes",
  duplicateFileBehavior: "stop",
  duplicateSceneBehavior: "stop",
  gridType: "square",
  gridSize: 100,
  navigation: false,
  ownership: "gm",
  tokenVision: false,
  fogExploration: false,
  activateImmediately: false,
};

export function sceneExpressDefaultsOf(value: unknown): SceneExpressDefaults {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Partial<SceneExpressDefaults>
    : {};
  const gridSize = Number(raw.gridSize);
  const duplicateFileBehavior: DuplicateFileBehavior = ["stop", "reuse", "overwrite", "ask"].includes(String(raw.duplicateFileBehavior))
    ? raw.duplicateFileBehavior as DuplicateFileBehavior
    : "stop";
  const sceneBehavior = raw.duplicateSceneBehavior ?? raw.duplicateFileBehavior;
  const duplicateSceneBehavior: DuplicateFileBehavior = ["stop", "reuse", "overwrite", "ask"].includes(String(sceneBehavior))
    ? sceneBehavior as DuplicateFileBehavior
    : "stop";
  return {
    enabled: raw.enabled !== false,
    destinationLogicalFolder: typeof raw.destinationLogicalFolder === "string"
      ? raw.destinationLogicalFolder.slice(0, 240)
      : DEFAULT_SCENE_EXPRESS_DEFAULTS.destinationLogicalFolder,
    duplicateFileBehavior,
    duplicateSceneBehavior,
    gridType: raw.gridType === "hex" || raw.gridType === "gridless" ? raw.gridType : "square",
    gridSize: Number.isFinite(gridSize) ? Math.round(Math.max(50, Math.min(1000, gridSize))) : 100,
    navigation: raw.navigation === true,
    ownership: raw.ownership === "all" ? "all" : "gm",
    tokenVision: raw.tokenVision === true,
    fogExploration: raw.fogExploration === true,
    activateImmediately: raw.activateImmediately === true,
  };
}

export function makeImageSceneGrid(defaults: SceneExpressDefaults): SceneGrid {
  return {
    type: defaults.gridType,
    size: defaults.gridType === "gridless" ? 100 : defaults.gridSize,
    distance: 5,
    units: "ft",
    diagonals: "555",
    hexLayout: "evenQ",
  };
}

export interface LogicalFileAlias {
  folder: string;
  name: string;
}

/** Return an alias array with an exact logical (folder,name) pair added once. */
export function addLogicalFileAlias(
  current: readonly LogicalFileAlias[] | undefined,
  alias: LogicalFileAlias,
): LogicalFileAlias[] {
  const files = [...(current ?? [])];
  if (!files.some((entry) => entry.folder === alias.folder && entry.name === alias.name)) files.push(alias);
  return files;
}

export function hasLogicalFileCollision(
  manifest: Record<string, AssetManifestEntry>,
  alias: LogicalFileAlias,
  contentHash: string,
): boolean {
  return Object.entries(manifest).some(([hash, entry]) => hash !== contentHash &&
    entry.logicalFiles?.some((file) => file.folder === alias.folder && file.name.toLocaleLowerCase() === alias.name.toLocaleLowerCase()));
}

export function uniqueSceneName(name: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((value) => value.toLocaleLowerCase()));
  if (!taken.has(name.toLocaleLowerCase())) return name;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error("Could not allocate a unique scene name");
}

/** Allocate a new logical alias in the selected folder without changing content identity. */
export function uniqueLogicalFileName(
  name: string,
  folder: string,
  manifest: Record<string, AssetManifestEntry>,
): string {
  const clean = name.trim().slice(0, 160) || "Image";
  const taken = new Set(Object.values(manifest).flatMap((entry) => entry.logicalFiles ?? [])
    .filter((file) => file.folder === folder)
    .map((file) => file.name.toLocaleLowerCase()));
  if (!taken.has(clean.toLocaleLowerCase())) return clean;
  for (let i = 2; i < 10_000; i++) {
    const suffix = ` (${i})`;
    const candidate = `${clean.slice(0, 160 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error("Could not allocate a unique logical file name");
}

/**
 * The GM world quota is unset/unlimited by default. A positive number is the maximum cumulative
 * bytes imported by one non-GM user; it is intentionally not capped by product policy.
 */
export function playerUploadQuotaMBOf(settings: Record<string, Json>): number | null {
  const value = settings.playerUploadQuotaMB;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Asset ids that are derived variants (thumbnail, mid-res copy or map tile) of another asset.
 * Pickers offer originals only; validation still accepts any owned hash.
 */
export function derivedAssetIds(manifest: AssetManifest): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(manifest)) {
    if (entry.thumb) ids.add(entry.thumb.assetId);
    if (entry.mid) ids.add(entry.mid.assetId);
    for (const id of entry.tiles?.ids ?? []) ids.add(id);
  }
  return ids;
}
