/** AIS appearance contract. Foreign code returns data, never parent selectors/CSS/DOM. */
import type { Json } from "./documents";
import { isSafePackagePath } from "./packageManifest";

export const UI_THEME_SLOT = "ui.theme";
export const UI_THEME_COMMAND = "theme";
export const UI_THEME_PREFS_ID = "ais-ui-appearance";
export const UI_THEME_CAPABILITIES = ["runtime.execute", "package.resources.read", "ui.theme"] as const;
export const THEME_COLOR_KEYS = ["background", "panel", "raised", "border", "text", "muted", "accent"] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export interface UiThemeSpec {
  version: 1;
  colors: Record<ThemeColorKey, string>;
  font: "sans" | "serif";
  radius: number;
  density: "compact" | "comfortable";
  images?: { panel?: string; header?: string; button?: string };
  evidence: { mode: string; detail: string; hooks?: string[]; tokenCount?: number };
}
export interface UiThemePreferences {
  selected: string | null;
  variant: string;
  density: "compact" | "comfortable";
  sidebarWidth: number;
}
export const DEFAULT_UI_PREFERENCES: UiThemePreferences = {
  selected: null, variant: "default", density: "comfortable", sidebarWidth: 340,
};
export interface UiThemeCatalog {
  id: string;
  providerId: string;
  name: string;
  description: string;
  mode: string;
  sourceUrl: string;
  sourceVersion: string;
  sourceCommit: string;
  variants: Array<{ id: string; name: string }>;
  swatches: string[];
  exclusions: string[];
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function text(value: unknown, max = 160): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }

export function parseUiTheme(value: unknown): UiThemeSpec {
  const row = record(value), colors = record(row?.colors), evidence = record(row?.evidence);
  if (!row || Object.keys(row).some((key) => !["version", "colors", "font", "radius", "density", "images", "evidence"].includes(key)) ||
      row.version !== 1 || !colors || Object.keys(colors).length !== THEME_COLOR_KEYS.length ||
      THEME_COLOR_KEYS.some((key) => typeof colors[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(colors[key] as string)) ||
      !["sans", "serif"].includes(String(row.font)) || !["compact", "comfortable"].includes(String(row.density)) ||
      typeof row.radius !== "number" || !Number.isFinite(row.radius) || row.radius < 0 || row.radius > 16 ||
      !evidence || Object.keys(evidence).some((key) => !["mode", "detail", "hooks", "tokenCount"].includes(key)) ||
      !text(evidence.mode, 80) || !text(evidence.detail, 300) ||
      (evidence.hooks !== undefined && (!Array.isArray(evidence.hooks) || evidence.hooks.length > 24 || evidence.hooks.some((hook) => !text(hook, 80)))) ||
      (evidence.tokenCount !== undefined && (!Number.isSafeInteger(evidence.tokenCount) || Number(evidence.tokenCount) < 0 || Number(evidence.tokenCount) > 4096)))
    throw new Error("Invalid AIS appearance proposal: only bounded colors, typography and declared image resources are supported");
  if (row.images !== undefined) {
    const images = record(row.images);
    if (!images || Object.keys(images).some((key) => !["panel", "header", "button"].includes(key)) ||
        Object.values(images).some((path) => typeof path !== "string" || !isSafePackagePath(path)))
      throw new Error("Invalid appearance image resource");
  }
  // Recovery and approvals live outside the themed shell. Also keep basic text readable.
  for (const key of ["background", "panel", "raised"] as const) {
    if (contrast(colors.text as string, colors[key] as string) < 4)
      throw new Error("The theme's text contrast is too low; the previous appearance was kept");
  }
  return structuredClone(row) as unknown as UiThemeSpec;
}
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const n = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function parseUiPreferences(value: unknown): UiThemePreferences {
  const row = record(value);
  if (!row) return { ...DEFAULT_UI_PREFERENCES };
  return {
    selected: typeof row?.selected === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(row.selected) ? row.selected : null,
    variant: typeof row?.variant === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(row.variant) ? row.variant : "default",
    density: row?.density === "compact" ? "compact" : "comfortable",
    sidebarWidth: typeof row?.sidebarWidth === "number" && Number.isFinite(row.sidebarWidth)
      ? Math.min(420, Math.max(260, Math.round(row.sidebarWidth))) : 300,
  };
}
export function uiThemeCatalog(id: string, providerId: string, configuration: Json): UiThemeCatalog | null {
  const row = record(record(configuration)?.uiTheme);
  if (!row || !text(row.name, 80) || !text(row.description, 240) || !text(row.mode, 80) ||
      !text(row.sourceUrl, 240) || !/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(row.sourceUrl) ||
      !text(row.sourceVersion, 40) || typeof row.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(row.sourceCommit) ||
      !Array.isArray(row.variants) || row.variants.length < 1 || row.variants.length > 16 ||
      !Array.isArray(row.swatches) || row.swatches.length !== 3 || row.swatches.some((color) => typeof color !== "string" || !/^#[a-f0-9]{6}$/i.test(color)) ||
      !Array.isArray(row.exclusions) || row.exclusions.length > 12 || row.exclusions.some((item) => !text(item, 180))) return null;
  for (const item of row.variants) {
    const variant = record(item);
    if (!variant || !text(variant.name, 60) || typeof variant.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(variant.id)) return null;
  }
  return { id, providerId, ...structuredClone(row) } as unknown as UiThemeCatalog;
}

/** Only host-generated property names. URLs come from validated, owned raster resources. */
export function uiThemeVariables(theme: UiThemeSpec | null, prefs: UiThemePreferences, images: Partial<Record<"panel" | "header" | "button", string>> = {}): string {
  if (theme) theme = parseUiTheme(theme);
  prefs = parseUiPreferences(prefs);
  const variables: Record<string, string> = {
    "--vtt-control-height": prefs.density === "compact" ? "32px" : "42px",
    "--vtt-ui-font-size": prefs.density === "compact" ? "14px" : "16px",
    "--vtt-shell-header": prefs.density === "compact" ? "50px" : "70px",
    "--vtt-dock-heading": prefs.density === "compact" ? "42px" : "60px",
    "--vtt-sidebar-width": `${prefs.sidebarWidth}px`,
  };
  if (theme) {
    const keys: Record<ThemeColorKey, string> = { background: "bg", panel: "panel", raised: "panel-raised", border: "border",
      text: "text", muted: "muted", accent: "accent" };
    for (const key of THEME_COLOR_KEYS) variables[`--vtt-${keys[key]}`] = theme.colors[key];
    variables["--vtt-focus"] = theme.colors.text;
    variables["--vtt-radius"] = `${theme.radius}px`;
    variables["--vtt-ui-font"] = theme.font === "serif" ? "Georgia, 'Times New Roman', serif" : "Inter, system-ui, sans-serif";
    for (const [key, url] of Object.entries(images)) {
      if (!/^blob:[^\s"'()\\;]+$/.test(url)) throw new Error("Invalid generated theme image URL");
      variables[`--vtt-theme-${key}-image`] = `url("${url}")`;
    }
  }
  return Object.entries(variables).map(([key, value]) => `${key}:${value}`).join(";");
}
