import type { TokenModuleAction } from "../ui/combat/tokenContextMenu";
import { createAisPanelHost, type AisPanelEntry, type AisPanelHost } from "../packages/aisPanel";
import { UI_THEME_CAPABILITIES, UI_THEME_COMMAND } from "../core/uiTheme";
/** Browser composition for AIS v1. Kept out of Svelte so the authority callbacks are type-checked. */
import type { HostApp, HostAutomationModuleBoot } from "./hostBoot";
import type { AisProfileMsg } from "../core/messages";
import { buildAisPlayerProfile } from "./aisPlayerProfile";
import type { Json, SceneDocument, SettingsDocument, TokenDocument, ActorDocument } from "../core/documents";
import type { Op } from "../core/ops";
import {
  aisTokenLightChanges,
  type AisCapability,
  type AisEventName,
  type AisEventPayloads,
  type AisSettingDeclaration,
  type AisSettingValue,
} from "../core/automationInterconnect";
import {
  aisDeviceSettingsScope,
  aisSettingsDocId,
  aisSettingsDocTouched,
  aisWorldSettingOps,
  aisWorldSettingValues,
  coerceAisSettingValue,
} from "../core/aisSettings";
import { getAllSettings, getWorld, putSetting, type WorldsRecord } from "../storage/idb";
import {
  AisModuleIframe,
  type AisModuleDiagnostics,
  type AisModuleRequestContext,
  type AisModuleRuntimeStatus,
} from "../packages/aisModuleIframe";
import {
  createAisModuleHandlers,
  createAisMutationQueue,
  projectAisTokenLight,
  type AisModuleDirectoryEntry,
  type AisModuleSelectRequest,
} from "../packages/aisModuleHandlers";

/** D-476: what a shell form needs to render one module's settings. */
export interface AisModuleSettingsView {
  declarations: AisSettingDeclaration[];
  values: Record<string, AisSettingValue>;
}

export type AisRuntimeStatuses = Readonly<Record<string, AisModuleRuntimeStatus>>;

/**
 * D-476/D-479: what a shell's packages view needs from a runtime to render a module's settings
 * form and health block. Both runtimes (GM and player) satisfy it; the player's `restart` is async.
 */
export interface AisModuleShellApi {
  settings(packageId: string): Promise<AisModuleSettingsView | null>;
  setSetting(packageId: string, key: string, value: AisSettingValue): Promise<AisSettingValue>;
  diagnostics(packageId: string): AisModuleDiagnostics | null;
  restart(packageId: string): boolean | Promise<boolean>;
}

export interface AisRuntimeOptions {
  app: HostApp;
  activeSceneId: () => string | null;
  select: (packageId: string, request: AisModuleSelectRequest) => Promise<string | null>;
  cancelChoice: (packageId: string) => void;
  notify: (message: string, level: "info" | "warn" | "error") => void;
  onStatus: (statuses: AisRuntimeStatuses) => void;
  /** D-470: persistent layer element for sandboxed module panels; absent = panels unavailable. */
  panelLayer?: HTMLElement;
  /** Test seam for the panel host. */
  panelHost?: AisPanelHost;
}

/** Frozen boot identity + current local consent, never a portable world's assertion of trust. */
export function assertAisModuleConsent(
  world: WorldsRecord | undefined,
  module: HostAutomationModuleBoot,
  capability?: AisCapability,
): void {
  const check = (identity: Pick<HostAutomationModuleBoot, "packageId" | "version" | "hash" | "capabilities">): void => {
    const lock = world?.automationProfile?.modules.find((entry) =>
      entry.id === identity.packageId && entry.version === identity.version && entry.hash === identity.hash,
    );
    const grant = world?.automationGrants?.[identity.packageId];
    if (!lock || grant?.hash !== identity.hash || !Array.isArray(grant.capabilities))
      throw new Error(`AIS code approval is not currently active for ${identity.packageId}`);
    if (capability && (!identity.capabilities.includes(capability) || !grant.capabilities.includes(capability)))
      throw new Error(`AIS capability ${capability} is not currently approved for ${identity.packageId}`);
  };
  check(module);
  if (module.runtimeHash && world?.automationGrants?.[module.packageId]?.runtimeHash !== module.runtimeHash)
    throw new Error(`AIS runtime composition is not currently approved for ${module.packageId}`);
  for (const dependency of module.runtimeDependencies ?? []) check(dependency);
  if (module.runtimeHash) for (const identity of [module, ...(module.runtimeDependencies ?? [])]) {
    if (!identity.capabilities.includes("runtime.execute") ||
        !world?.automationGrants?.[identity.packageId]?.capabilities.includes("runtime.execute"))
      throw new Error(`AIS runtime.execute is not currently approved for ${identity.packageId}`);
  }
}

export class AisRuntime {
  private readonly hosts = new Map<string, AisModuleIframe>();
  private readonly statuses: Record<string, AisModuleRuntimeStatus> = {};
  private readonly off: Array<() => void> = [];
  private readonly options: AisRuntimeOptions;
  private providers: HostApp["automationBoot"]["resolution"]["providers"];
  private disposed = false;
  private readonly definitions = new Map<string, HostAutomationModuleBoot>();
  private readonly mutate = createAisMutationQueue();
  /** D-470: host-chromed windows around module iframes (one per module that declares a panel). */
  private readonly panels: AisPanelHost | null;
  /** D-468: the last published player-facing module set (empty until consent is verified). */
  private playerProfileBody: Omit<AisProfileMsg, "kind" | "seq" | "worldId"> = { providers: {}, modules: [] };
  /** D-476: last world-scope values seen per module, so a commit raises one change per key. */
  private readonly worldSettingValues = new Map<string, Record<string, AisSettingValue>>();
  /** D-478: in-flight module→module invocations (a chain deeper than this is a bug, not a feature). */
  private busDepth = 0;
  private busSeq = 0;

  constructor(options: AisRuntimeOptions) {
    this.options = options;
    const { app } = options;
    this.panels = options.panelHost ?? (options.panelLayer ? createAisPanelHost(options.panelLayer) : null);
    this.providers = app.automationBoot.resolution.providers;
    for (const module of app.automationBoot.modules) this.start(module);
    // D-468: players receive the shared module set once the GM-device consent has been read.
    app.host.setAisProfileProvider(() => this.playerProfileBody);
    void getWorld(app.db, app.worldId).then(
      (world) => this.publishPlayerProfile(world),
      () => this.publishPlayerProfile(null),
    );
    app.host.setAisMacroModuleInvoker(async (invocation) => {
      if (!invocation.isActive()) throw new Error("Script action was cancelled");
      const module = this.definitions.get(invocation.moduleId);
      if (module?.runtimeHash && invocation.callerId !== app.gm.client.user?.id)
        throw new Error("Adapter-backed feasibility commands are restricted to the local GM; player delegation is not implemented");
      if (module?.runtimeHash && invocation.sceneId !== this.options.activeSceneId())
        throw new Error("Adapter-backed commands require the currently viewed scene");
      const frame = this.hosts.get(invocation.moduleId);
      if (!frame) throw new Error(`AIS module ${invocation.moduleId} is not enabled and locally approved on this host`);
      return frame.invokeCommand(invocation.commandId, invocation.input, {
        sceneId: invocation.sceneId, callerId: invocation.callerId, requestId: invocation.requestId,
        runAs: invocation.runAs, isActive: invocation.isActive,
      });
    });
    this.off.push(
      app.packages.onAutomationChanged(() => this.reconcile()),
      app.gm.bus.on("snapshot", (message) => this.emit("world.snapshot", { seq: message.seq })),
      app.gm.bus.on("ops", (message) => {
        this.emit("world.ops.committed", { seq: message.envelope.seq, operationCount: message.envelope.ops.length });
        this.emitWorldSettingChanges(message.envelope.ops);
        const scene = this.scene();
        if (!scene) return;
        for (const change of aisTokenLightChanges(message.envelope.ops)) {
          if (change.sceneId !== scene._id) continue;
          const token = scene.tokens.find((candidate) => candidate._id === change.tokenId && !candidate.hidden);
          if (token) this.emit("scene.token.light.changed", {
            sceneId: scene._id, tokenId: token._id, light: projectAisTokenLight(token),
          });
        }
      }),
      app.gm.bus.on("turnPhase", (message) => this.emit("turn.phase.changed", {
        turnId: message.turnId, phase: message.phase,
        ...(message.mode === "stepwise" || message.mode === "realtime" || message.mode === "simultaneous"
          ? { mode: message.mode } : {}),
        ...(message.paused === undefined ? {} : { paused: message.paused }),
      })),
      app.gm.bus.on("turnReport", (message) => this.emit("turn.report.committed", {
        turnId: message.turnId, turn: message.report.turn, rulesVersion: message.report.rulesVersion,
      })),
    );
  }

  private start(module: HostAutomationModuleBoot, explicitAppearance = false): void {
    if (this.disposed) throw new Error("AIS runtime was stopped");
    const options = this.options;
    const { app } = options;
    this.definitions.set(module.packageId, module);
      if (module.runtimeProvider || module.blockedReason || (module.appearance && !explicitAppearance)) {
        this.statuses[module.packageId] = { state: module.blockedReason ? "blocked" : "available",
          ...(module.blockedReason ? { error: module.blockedReason } : {}) };
        options.onStatus({ ...this.statuses });
        return;
      }
      const fxRuns = new Map<string, { runId: string; atHostTime: number; endsAtHostTime: number }>();
      const pruneFx = (): void => {
        for (const [id, run] of fxRuns) if (run.endsAtHostTime <= Date.now()) fxRuns.delete(id);
      };
      const assertCapability = async (capability?: AisCapability): Promise<void> => {
        if (this.disposed) throw new Error("AIS world runtime was stopped");
        assertAisModuleConsent(await getWorld(app.db, app.worldId), module, capability);
        if (this.disposed) throw new Error("AIS world runtime was stopped");
      };
      // D-470: a declared panel gets its hidden host-chromed window first, so the iframe is created
      // inside it and never re-parented (re-parenting reloads an iframe = module navigation).
      const panelBody = module.panel && this.panels
        ? this.panels.mount(module.packageId, { title: module.panel.title, moduleName: module.name,
          width: module.panel.width, height: module.panel.height, onClose: () => {} })
        : undefined;
      const panels = this.panels;
      const frame = new AisModuleIframe({
        packageId: module.packageId,
        source: module.source,
        ...(module.runtimeContext ? { runtimeContext: module.runtimeContext, stopOnCommandTimeout: true } : {}),
        commands: module.commands,
        grantedCapabilities: module.capabilities.filter((capability) =>
          (module.runtimeDependencies ?? []).every((dependency) => dependency.capabilities.includes(capability))),
        ...(panelBody ? { hostElement: panelBody } : {}),
        assertModuleActive: () => assertCapability(),
        isCapabilityCurrentlyGranted: async (capability) => {
          try { await assertCapability(capability); return true; } catch { return false; }
        },
        onSubscribe: (event) => {
          // The GM welcome predates module boot. A subscriber still receives one current
          // snapshot; startup must not depend on a later reconnect or unrelated edit.
          if (event === "world.snapshot")
            this.hosts.get(module.packageId)?.emit(event, { seq: app.store.seq });
        },
        onStatus: (status) => {
          this.statuses[module.packageId] = status;
          if (status.state === "failed" || status.state === "stopped") {
            options.cancelChoice(module.packageId);
            for (const id of fxRuns.keys()) app.host.stopAisFx(id);
            fxRuns.clear();
            panels?.close(module.packageId);
          }
          if (status.state === "failed") options.notify(`AIS module ${module.packageId}: ${status.error}`, "error");
          options.onStatus({ ...this.statuses });
        },
        handlers: createAisModuleHandlers({
          worldId: app.worldId,
          packageId: module.packageId,
          emittedEvents: module.emittedEvents,
          db: app.db,
          user: () => ({ id: app.gm.client.user?.id ?? "gm", name: app.gm.client.user?.name ?? "GM" }),
          // Do not read optimistic replica state or acknowledge a write before the host does.
          activeScene: () => this.scene(),
          actorById: (id) => app.store.get("actors", id) as ActorDocument | undefined,
          select: (request) => options.select(module.packageId, request),
          submit: (ops) => app.gm.client.submitAndWait(ops),
          mutate: this.mutate,
          ...(module.resources ? { resources: module.resources } : {}),
          sequence: () => app.store.seq,
          updateSceneTags: (input) => app.host.applyAisSceneTags(input),
          fx: {
            play: (input) => {
              pruneFx();
              if (fxRuns.size >= 16) throw new Error("AIS module may own at most 16 active FX runs");
              const scene = this.scene();
              if (!scene) throw new Error("No active AIS scene");
              const run = app.host.playAisFx(scene._id, input);
              fxRuns.set(run.runId, run);
              return run;
            },
            list: () => { pruneFx(); return [...fxRuns.values()]; },
            stop: (id) => {
              pruneFx();
              if (!fxRuns.has(id)) return { stopped: false };
              fxRuns.delete(id);
              return { stopped: app.host.stopAisFx(id) };
            },
          },
          notify: options.notify,
          ...(panelBody && panels ? { panel: {
            open: () => { panels.open(module.packageId); },
            close: () => { panels.close(module.packageId); },
          } } : {}),
          emitModuleEvent: (eventId, payload) => this.emitModuleEvent(module.packageId, eventId, payload),
          newId: (prefix) => `${prefix}${globalThis.crypto.randomUUID()}`,
          assertCapability,
          // D-476: the GM device writes world scope with GM authority; device scope stays local.
          ...(module.settings?.length ? { settings: {
            declarations: module.settings,
            packageName: module.name,
            worldDoc: () => this.worldSettingsDoc(module.packageId),
            canWriteWorld: () => true,
            onDeviceChange: (key, value) =>
              this.hosts.get(module.packageId)?.emit("module.settings.changed", { scope: "device", key, value }),
          } } : {}),
          // D-477: the GM device holds every imported pack (memoized per package record in HostPackages).
          compendia: () => app.packages.compendia(),
          // D-478: directory + kernel-routed invocation with GM authority.
          modules: {
            requires: module.requires ?? [],
            list: () => this.moduleDirectory(),
            invoke: (target, commandId, input, lifetime) => this.invokeFromModule(module.packageId, target, commandId, input, lifetime),
          },
        }),
      });
      if (panelBody) panels?.attach(module.packageId, frame);
      this.hosts.set(module.packageId, frame);
      if (module.settings?.length)
        this.worldSettingValues.set(module.packageId, aisWorldSettingValues(this.worldSettingsDoc(module.packageId), module.settings));
  }

  private worldSettingsDoc(packageId: string): SettingsDocument | undefined {
    return this.options.app.store.get("settings", aisSettingsDocId(packageId)) as SettingsDocument | undefined;
  }

  /** D-476: a committed batch touched a module's world-settings document → one event per changed key. */
  private emitWorldSettingChanges(ops: readonly Op[]): void {
    for (const module of this.definitions.values()) {
      if (!module.settings?.length || !aisSettingsDocTouched(ops, module.packageId)) continue;
      const previous = this.worldSettingValues.get(module.packageId) ?? {};
      const next = aisWorldSettingValues(this.worldSettingsDoc(module.packageId), module.settings);
      this.worldSettingValues.set(module.packageId, next);
      const frame = this.hosts.get(module.packageId);
      for (const [key, value] of Object.entries(next))
        if (previous[key] !== value) frame?.emit("module.settings.changed", { scope: "world", key, value });
    }
  }

  /** D-476: declarations + effective values of one module (world from the store, device from IndexedDB). */
  async moduleSettings(packageId: string): Promise<AisModuleSettingsView | null> {
    const module = this.definitions.get(packageId) ?? this.options.app.automationBoot.modules.find((entry) => entry.packageId === packageId);
    if (!module?.settings?.length) return null;
    const values = aisWorldSettingValues(this.worldSettingsDoc(packageId), module.settings);
    const rows = await getAllSettings(this.options.app.db, aisDeviceSettingsScope(this.options.app.worldId, packageId));
    for (const declaration of module.settings) {
      if (declaration.scope !== "device") continue;
      const row = rows.find((candidate) => candidate.key === declaration.key);
      const coerced = row ? coerceAisSettingValue(declaration, row.value) : null;
      values[declaration.key] = coerced?.ok ? coerced.value : declaration.default;
    }
    return { declarations: module.settings.map((declaration) => structuredClone(declaration)), values };
  }

  /** D-476: the GM's form writes a value — world scope through a normal commit, device scope locally. */
  async setModuleSetting(packageId: string, key: string, value: unknown): Promise<AisSettingValue> {
    const module = this.definitions.get(packageId) ?? this.options.app.automationBoot.modules.find((entry) => entry.packageId === packageId);
    const declaration = module?.settings?.find((candidate) => candidate.key === key);
    if (!module || !declaration) throw new Error(`${packageId} declares no setting ${key}`);
    const coerced = coerceAisSettingValue(declaration, value);
    if (!coerced.ok) throw new Error(coerced.error);
    if (declaration.scope === "world") {
      const ops = aisWorldSettingOps(this.worldSettingsDoc(packageId), packageId, module.name, key, coerced.value);
      if (ops.length > 0) await this.options.app.gm.client.submitAndWait(ops);
    } else {
      await putSetting(this.options.app.db, { scope: aisDeviceSettingsScope(this.options.app.worldId, packageId), key, value: coerced.value });
      this.hosts.get(packageId)?.emit("module.settings.changed", { scope: "device", key, value: coerced.value });
    }
    return coerced.value;
  }

  /** D-478: the public contract of every booted module on this device (running or not). */
  private moduleDirectory(): AisModuleDirectoryEntry[] {
    return this.options.app.automationBoot.modules
      .filter((module) => !module.runtimeProvider && !module.appearance)
      .map((module) => ({
        packageId: module.packageId, name: module.name, version: module.version,
        running: this.hosts.get(module.packageId)?.status.state === "ready",
        commands: module.commands, provides: module.provides ?? [], emits: module.emittedEvents,
      }));
  }

  /** D-478: route a module's request to a sibling's declared command, with this device's (GM) authority. */
  private async invokeFromModule(
    callerPackageId: string,
    targetId: string,
    commandId: string,
    input: Json,
    lifetime: AisModuleRequestContext | undefined,
  ): Promise<Json> {
    const frame = this.hosts.get(targetId);
    if (!frame) throw new Error(`AIS module ${targetId} is not running on this device`);
    if (this.busDepth >= 8) throw new Error("AIS module bus depth exceeded");
    this.busDepth++;
    try {
      return await frame.invokeCommand(commandId, input, {
        sceneId: this.options.activeSceneId() ?? "",
        callerId: this.options.app.gm.client.user?.id ?? "gm",
        requestId: `ais-module:${callerPackageId}:${++this.busSeq}`,
        runAs: "gm",
        isActive: () => !this.disposed && lifetime?.isActive() !== false,
      });
    } finally { this.busDepth--; }
  }

  /** The GM shell's view of settings + health, bound so Svelte props can hold it. */
  shellApi(): AisModuleShellApi {
    return {
      settings: (packageId) => this.moduleSettings(packageId),
      setSetting: (packageId, key, value) => this.setModuleSetting(packageId, key, value),
      diagnostics: (packageId) => this.diagnostics(packageId),
      restart: (packageId) => this.restart(packageId),
    };
  }

  /** D-479: health counters and the bounded trace of one module (null when it never started here). */
  diagnostics(packageId: string): AisModuleDiagnostics | null {
    return this.hosts.get(packageId)?.diagnostics() ?? null;
  }

  /**
   * D-479: stop and start one module again from its frozen boot definition (after a circuit trip
   * or a module-side failure). New code or grants still require a reload: the definition is the
   * one the GM approved at boot.
   */
  restart(packageId: string): boolean {
    if (this.disposed) return false;
    const module = this.definitions.get(packageId);
    if (!module || module.appearance || module.runtimeProvider) return false;
    this.hosts.get(packageId)?.dispose("Restarted from Settings → Packages");
    this.hosts.delete(packageId);
    this.start(module);
    return true;
  }

  /** D-470: panels of modules that declared one, with their open state (for shell buttons). */
  panelEntries(): AisPanelEntry[] { return this.panels?.entries() ?? []; }

  /** D-470: open a module's panel from the shell; false when the module is not running. */
  openPanel(packageId: string): boolean {
    const frame = this.hosts.get(packageId);
    if (!frame || frame.status.state !== "ready" || !this.panels) {
      this.options.notify(frame?.status.error ?? "The module is not running; enable and approve it in Settings → Packages.", "warn");
      return false;
    }
    return this.panels.open(packageId);
  }

  closePanel(packageId: string): boolean { return this.panels?.close(packageId) ?? false; }

  /** The ONLY live-start path: explicit local-GM activation of appearance-only packages. */
  async composeTheme(packageId: string, input: Json, isActive: () => boolean): Promise<{ value: Json; module: HostAutomationModuleBoot }> {
    const plan = await this.options.app.packages.runtimePlan();
    const module = plan.modules.find((entry) => entry.packageId === packageId);
    if (!module?.appearance || module.blockedReason || !module.runtimeHash ||
        !module.capabilities.includes("ui.theme") ||
        module.capabilities.some((capability) => !(UI_THEME_CAPABILITIES as readonly string[]).includes(capability)) ||
        !module.commands.some((command) => command.id === UI_THEME_COMMAND && command.contract === 1))
      throw new Error(module?.blockedReason ?? "Only reviewed, appearance-only modules support live theme activation");
    if (plan.profile.providers["ui.theme"] !== `${packageId}/ui.theme`)
      throw new Error("This module is not the selected appearance provider");
    const world = await getWorld(this.options.app.db, this.options.app.worldId);
    assertAisModuleConsent(world, module, "ui.theme");
    if (!isActive() || this.disposed) throw new Error("Appearance request cancelled");
    let frame = this.hosts.get(packageId);
    const previous = this.definitions.get(packageId);
    if (!frame || !["ready", "starting"].includes(frame.status.state) || previous?.runtimeHash !== module.runtimeHash) {
      frame?.dispose("Appearance runtime restarted");
      this.start(module, true);
      frame = this.hosts.get(packageId);
    }
    if (!frame) throw new Error("Appearance runtime did not start");
    await frame.whenReady();
    const value = await frame.invokeCommand(UI_THEME_COMMAND, input, {
      sceneId: this.options.activeSceneId() ?? "", callerId: this.options.app.gm.client.user?.id ?? "gm",
      requestId: `appearance-${crypto.randomUUID()}`, runAs: "gm", isActive,
    });
    return { value, module };
  }

  async assertThemeActive(module: HostAutomationModuleBoot, requireSelected = true): Promise<void> {
    if (this.disposed || this.hosts.get(module.packageId)?.status.state !== "ready") throw new Error("Theme runtime is not active");
    const world = await getWorld(this.options.app.db, this.options.app.worldId);
    assertAisModuleConsent(world, module, "ui.theme");
    if (requireSelected && world?.automationProfile?.providers["ui.theme"] !== `${module.packageId}/ui.theme`)
      throw new Error("Appearance provider changed before its proposal could be applied");
  }

  stopThemes(): void {
    for (const [id, definition] of this.definitions) if (definition.appearance)
      this.hosts.get(id)?.dispose("Appearance restored to native defaults");
  }

  private scene(): SceneDocument | null {
    const id = this.options.activeSceneId();
    return id ? this.options.app.store.get("scenes", id) as SceneDocument | undefined ?? null : null;
  }

  private emit<K extends AisEventName>(event: K, payload: AisEventPayloads[K]): void {
    if (this.disposed) return;
    for (const frame of this.hosts.values()) frame.emit(event, payload);
  }

  private emitModuleEvent(packageId: string, eventId: string, payload: Json): void {
    if (this.disposed) return;
    for (const [id, frame] of this.hosts) {
      if (id !== packageId) frame.emit("module.event", { packageId, eventId, payload });
    }
  }

  /**
   * D-468: recompute and re-send the player-facing module set. `null` world = the authority
   * read failed, which shares nothing (the same posture `reconcile` takes for local frames).
   */
  private publishPlayerProfile(world: WorldsRecord | undefined | null): void {
    if (this.disposed) return;
    const { app } = this.options;
    this.playerProfileBody = world === null
      ? { providers: {}, modules: [] }
      : buildAisPlayerProfile({
        modules: app.automationBoot.modules,
        providers: this.providers,
        assertConsent: (module) => assertAisModuleConsent(world, module),
        isShared: (packageId) => world?.automationSharing?.[packageId] !== false,
      });
    app.host.publishAisProfile();
  }

  /** The current player-facing module set (what `ais.profile` carries). */
  get playerProfile(): Omit<AisProfileMsg, "kind" | "seq" | "worldId"> { return this.playerProfileBody; }

  /** Removal/replacement/revocation stops immediately; additions still require explicit reload. */
  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    try {
      const { app } = this.options;
      const [world, state] = await Promise.all([getWorld(app.db, app.worldId), app.packages.automation()]);
      this.providers = state.resolution.providers;
      for (const module of this.definitions.values()) {
        const frame = this.hosts.get(module.packageId);
        try {
          assertAisModuleConsent(world, module);
          for (const identity of [module, ...(module.runtimeDependencies ?? [])]) {
            const caps = world?.automationGrants?.[identity.packageId]?.capabilities ?? [];
            if (caps.length !== identity.capabilities.length || caps.some((capability) => !identity.capabilities.includes(capability)))
              throw new Error(`Capabilities for ${identity.packageId} changed; reload to apply the new grants`);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Module approval changed; reload required";
          frame?.dispose(reason);
          this.panels?.remove(module.packageId);
          if (!frame) this.statuses[module.packageId] = { state: "stopped", error: reason };
        }
      }
      this.options.onStatus({ ...this.statuses });
      this.publishPlayerProfile(world);
    } catch {
      // A failed authority read is never permission to keep executing the cached profile.
      for (const frame of this.hosts.values()) frame.dispose("Could not verify current module approval; reload required");
      this.panels?.dispose();
      this.publishPlayerProfile(null);
    }
  }

  tokenLightState(token: TokenDocument) {
    const provider = this.providers.find((row) => row.slotId === "scene.token.light.action");
    if (!provider) return undefined;
    const id = provider.selected?.split("/", 1)[0];
    const frame = id ? this.hosts.get(id) : undefined;
    const ais = token.flags.ais as Record<string, unknown> | undefined;
    const state = id && ais ? ais[id] as Record<string, unknown> | undefined : undefined;
    const reason = !id ? "Select one token-light provider in Settings → Packages."
      : !frame ? "Enable the module and approve its code and capabilities in Settings → Packages, then reload."
        : frame.status.state !== "ready" ? frame.status.error ?? "The token-light module is starting."
          : !this.options.app.automationBoot.modules.find((module) => module.packageId === id)?.capabilities.includes("action.observe")
            ? "Approve action.observe for the token-light provider in Settings → Packages, then reload." : null;
    return { enabled: reason === null, reason, active: state?.active === true,
      sourceName: typeof state?.sourceName === "string" ? state.sourceName : null };
  }

  /** D-469: manifest token actions of every running module (the generic token-menu slot). */
  tokenActions(): TokenModuleAction[] {
    const out: TokenModuleAction[] = [];
    for (const module of this.options.app.automationBoot.modules) {
      if (!module.tokenActions?.length) continue;
      const frame = this.hosts.get(module.packageId);
      const reason = !frame ? "Enable the module and approve its code in Settings → Packages, then reload."
        : frame.status.state !== "ready" ? frame.status.error ?? "The module is starting." : null;
      for (const action of module.tokenActions)
        out.push({ packageId: module.packageId, id: action.id, label: action.label, enabled: reason === null, reason });
    }
    return out;
  }

  runTokenAction(tokenId: string, packageId: string, actionId: string): void {
    const scene = this.scene();
    const token = scene?.tokens.find((row) => row._id === tokenId && !row.hidden);
    const action = this.tokenActions().find((row) => row.packageId === packageId && row.id === actionId);
    if (!scene || !token || !action?.enabled) {
      this.options.notify(action?.reason ?? "That module action is not available.", "warn");
      return;
    }
    this.hosts.get(packageId)?.emit("ui.token.action", { sceneId: scene._id, tokenId, action: actionId });
  }

  tokenLightAction(tokenId: string, action: string): void {
    const scene = this.scene();
    const token = scene?.tokens.find((row) => row._id === tokenId && !row.hidden);
    const id = this.providers.find((row) => row.slotId === "scene.token.light.action")?.selected?.split("/", 1)[0];
    const state = token ? this.tokenLightState(token) : undefined;
    if (!scene || !id || !state?.enabled) {
      this.options.notify(state?.reason ?? "Token lighting is not ready. Review the module in Settings → Packages.", "warn");
      return;
    }
    this.hosts.get(id)?.emit("ui.token.action", { sceneId: scene._id, tokenId, action });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    this.options.app.host.setAisMacroModuleInvoker(null);
    this.options.app.host.setAisProfileProvider(null);
    for (const frame of this.hosts.values()) frame.dispose("World closed");
    this.hosts.clear();
    this.panels?.dispose();
  }
}
