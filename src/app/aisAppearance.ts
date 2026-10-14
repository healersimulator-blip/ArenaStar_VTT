/** GM-owned appearance orchestration. Guest code computes data in AIS; only this host applies it. */
import type { HostApp, HostAutomationModuleBoot } from "./hostBoot";
import { AisRuntime } from "./aisRuntime";
import { aisRuntimeConfiguration } from "../packages/aisRuntimePackage";
import { listPackages } from "../storage/idb";
import type { Json, SettingsDocument } from "../core/documents";
import {
  UI_THEME_PREFS_ID, UI_THEME_SLOT, parseUiPreferences, parseUiTheme,
  uiThemeCatalog, type UiThemeCatalog, type UiThemePreferences, type UiThemeSpec,
} from "../core/uiTheme";

export interface ThemeReview {
  id: string; name: string; source: string; hash: string; runtimeHash?: string;
  capabilities: import("../core/automationInterconnect").AisCapability[];
}
export interface AppearanceState {
  themes: UiThemeCatalog[];
  preferences: UiThemePreferences;
  active: string | null;
  spec: UiThemeSpec | null;
  images: Partial<Record<"panel" | "header" | "button", string>>;
  busy: boolean;
  error: string | null;
}

async function rasterUrl(text: string): Promise<string> {
  if (!text || text.length > 512 * 1024 || !/^[a-z0-9+/]+={0,2}$/i.test(text)) throw new Error("Invalid encoded theme raster");
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP")
    throw new Error("Only declared WebP theme rasters are accepted");
  const blob = new Blob([bytes], { type: "image/webp" });
  const image = await createImageBitmap(blob);
  try {
    if (image.width > 4096 || image.height > 4096 || image.width * image.height > 4_194_304)
      throw new Error("Theme raster exceeds the pixel budget");
  } finally { image.close(); }
  return URL.createObjectURL(blob);
}

export class AisAppearance {
  private state: AppearanceState;
  private readonly listeners = new Set<(state: AppearanceState) => void>();
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private activeModule: HostAutomationModuleBoot | null = null;
  private readonly off: () => void;
  constructor(private readonly app: HostApp, private readonly runtime: AisRuntime,
    private readonly makeImageUrl = rasterUrl) {
    const stored = app.store.get("settings", UI_THEME_PREFS_ID)?.system;
    this.state = { themes: [], preferences: parseUiPreferences(stored), active: null,
      spec: null, images: {}, busy: false, error: null };
    this.off = app.packages.onAutomationChanged(async () => {
      await this.refreshCatalog();
      if (!this.activeModule) return;
      try { await this.runtime.assertThemeActive(this.activeModule, !this.state.busy); }
      catch { this.clearRendered(); this.publish({ error: "Theme execution was stopped. Native appearance is available." }); }
    });
  }
  get snapshot(): AppearanceState { return this.state; }
  subscribe(listener: (state: AppearanceState) => void): () => void {
    this.listeners.add(listener); listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  private publish(patch: Partial<AppearanceState> = {}): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
  private clearRendered(): void {
    for (const url of Object.values(this.state.images)) URL.revokeObjectURL(url);
    this.activeModule = null;
    this.publish({ active: null, spec: null, images: {} });
  }
  async refreshCatalog(): Promise<void> {
    const packages = await listPackages(this.app.db, this.app.worldId);
    if (this.disposed) return;
    const themes: UiThemeCatalog[] = [];
    for (const pkg of packages) {
      const spec = pkg.manifest.interconnect;
      if (!spec?.runtime || !spec.provides?.some((slot) => slot.id === UI_THEME_SLOT && slot.mode === "exclusive" && slot.contract === 1)) continue;
      try {
        const theme = uiThemeCatalog(pkg.id, spec.runtime.provider, aisRuntimeConfiguration(pkg));
        if (theme) themes.push(theme);
      } catch { /* The package manager separately displays an invalid package/configuration. */ }
    }
    this.publish({ themes: themes.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  async restore(): Promise<void> {
    await this.refreshCatalog();
    const prefs = this.state.preferences;
    if (!prefs.selected) return;
    // Restore never grants consent. Importing a world cannot execute its theme without review.
    const state = await this.app.packages.automation();
    const entry = state.modules.find((module) => module.id === prefs.selected);
    if (!entry?.enabled || !entry.approved) {
      this.publish({ error: "This world requests a theme. Review it in Interface before activating it on this device." }); return;
    }
    await this.apply(prefs);
  }
  async reviews(id: string): Promise<ThemeReview[]> {
    const theme = this.state.themes.find((entry) => entry.id === id);
    if (!theme) throw new Error("Unknown appearance package");
    const catalog = await this.app.packages.list();
    const reviews: ThemeReview[] = [];
    for (const packageId of [theme.providerId, theme.id]) {
      const pkg = catalog.find((entry) => entry.id === packageId);
      if (!pkg) throw new Error(`Required package ${packageId} is not installed`);
      if (pkg.requestedCapabilities.some((capability) => !["runtime.execute", "package.resources.read", "ui.theme"].includes(capability)))
        throw new Error("The quick appearance selector only approves appearance-only packages; review other modules in Packages");
      const preview = await this.app.packages.previewAutomationModule(packageId);
      if (!preview.ok) throw new Error(preview.error);
      if (preview.truncated) throw new Error("Source exceeds the quick review limit; inspect this package in Settings → Packages");
      reviews.push({ id: packageId, name: pkg.name, source: preview.source, hash: preview.hash,
        ...(preview.runtimeHash ? { runtimeHash: preview.runtimeHash } : {}), capabilities: pkg.requestedCapabilities });
    }
    return reviews;
  }
  async needsReview(id: string): Promise<boolean> {
    const theme = this.state.themes.find((entry) => entry.id === id);
    if (!theme) return true;
    const packages = await this.app.packages.list();
    return [theme.providerId, id].some((packageId) => {
      const pkg = packages.find((entry) => entry.id === packageId);
      return !pkg?.approved || pkg.requestedCapabilities.some((capability) => !pkg.grantedCapabilities.includes(capability));
    });
  }
  /** Explicit user confirmation approves exact snapshots of BOTH code packages, no silent grant. */
  async approveAndApply(reviews: ThemeReview[], preferences: UiThemePreferences): Promise<void> {
    const theme = this.state.themes.find((entry) => entry.id === preferences.selected);
    if (!theme || reviews.length !== 2 || reviews[0]?.id !== theme.providerId || reviews[1]?.id !== theme.id)
      throw new Error("Appearance review does not match the selected packages");
    for (const review of reviews) {
      const granted = await this.app.packages.grantAutomationCapabilities(review.id, review.capabilities, review.hash, review.runtimeHash);
      if (!granted.ok) throw new Error(granted.error);
    }
    await this.apply(preferences);
  }
  private async save(preferences: UiThemePreferences): Promise<void> {
    const existing = this.app.store.get("settings", UI_THEME_PREFS_ID);
    const system = structuredClone(preferences) as unknown as Record<string, Json>;
    if (existing) await this.app.gm.client.submitAndWait([{ kind: "update", ref: { coll: "settings", id: UI_THEME_PREFS_ID }, diff: { system } }]);
    else {
      const data: SettingsDocument = { _id: UI_THEME_PREFS_ID, type: "settings", name: "Interface appearance",
        ownership: { default: 1 }, flags: {}, system };
      await this.app.gm.client.submitAndWait([{ kind: "create", coll: "settings", data }]);
    }
  }
  async apply(preferences: UiThemePreferences): Promise<void> {
    const prefs = parseUiPreferences(preferences);
    if (!prefs.selected) return this.reset(prefs);
    const theme = this.state.themes.find((entry) => entry.id === prefs.selected);
    if (!theme || !theme.variants.some((variant) => variant.id === prefs.variant)) throw new Error("Unknown appearance variant");
    const generation = ++this.generation;
    const active = () => !this.disposed && generation === this.generation;
    this.publish({ busy: true, error: null });
    const work = this.tail.catch(() => {}).then(async () => {
      const images: AppearanceState["images"] = {};
      try {
        if (!active()) return;
        const enabled = await this.app.packages.enableAutomationModule(theme.providerId);
        if (!enabled.ok) throw new Error(enabled.error);
        const selected = await this.app.packages.selectAutomationProvider(UI_THEME_SLOT, `${theme.id}/${UI_THEME_SLOT}`);
        if (!selected.ok) throw new Error(selected.error);
        const composed = await this.runtime.composeTheme(theme.id, { variant: prefs.variant, density: prefs.density }, active);
        const spec = parseUiTheme(composed.value);
        if (spec.density !== prefs.density) throw new Error("Theme cannot override the GM's selected density");
        for (const slot of ["panel", "header", "button"] as const) {
          const path = spec.images?.[slot];
          if (!path) continue;
          if (!path.endsWith(".webp.b64") || !composed.module.resources || !Object.hasOwn(composed.module.resources, path))
            throw new Error("Theme tried to use an undeclared image resource");
          images[slot] = await this.makeImageUrl(composed.module.resources[path] ?? "");
        }
        if (!active()) return;
        await this.runtime.assertThemeActive(composed.module);
        if (!active()) return;
        await this.save(prefs);
        if (!active()) return;
        await this.runtime.assertThemeActive(composed.module);
        this.clearRendered();
        this.activeModule = composed.module;
        this.publish({ active: theme.id, spec, images: { ...images }, preferences: prefs, error: null });
        for (const key of Object.keys(images)) Reflect.deleteProperty(images, key);
      } catch (error) {
        if (active()) this.publish({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        for (const url of Object.values(images)) URL.revokeObjectURL(url);
        if (active()) this.publish({ busy: false });
      }
    });
    this.tail = work;
    return work;
  }
  async reset(preferences: UiThemePreferences = { ...this.state.preferences, selected: null }): Promise<void> {
    const generation = ++this.generation;
    this.runtime.stopThemes();
    this.clearRendered();
    const prefs = { ...parseUiPreferences(preferences), selected: null };
    this.publish({ busy: false, preferences: prefs, error: null });
    const saved = this.tail.catch(() => {}).then(async () => {
      if (!this.disposed && generation === this.generation) await this.save(prefs);
    });
    this.tail = saved;
    await saved;
  }
  async layout(density: UiThemePreferences["density"], sidebarWidth: number): Promise<void> {
    const prefs = { ...this.state.preferences, density, sidebarWidth };
    if (prefs.selected && this.state.active) await this.apply(prefs);
    else { const valid = parseUiPreferences(prefs); await this.save(valid); this.publish({ preferences: valid }); }
  }
  dispose(): void {
    this.disposed = true; ++this.generation; this.off();
    this.clearRendered(); this.listeners.clear();
  }
}
