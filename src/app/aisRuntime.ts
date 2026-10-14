import { UI_THEME_CAPABILITIES, UI_THEME_COMMAND } from "../core/uiTheme";
/** Browser composition for AIS v1. Kept out of Svelte so the authority callbacks are type-checked. */
import type { HostApp, HostAutomationModuleBoot } from "./hostBoot";
import type { AisProfileMsg } from "../core/messages";
import { buildAisPlayerProfile } from "./aisPlayerProfile";
import type { Json, SceneDocument, TokenDocument, ActorDocument } from "../core/documents";
import {
  aisTokenLightChanges,
  type AisCapability,
  type AisEventName,
  type AisEventPayloads,
} from "../core/automationInterconnect";
import { getWorld, type WorldsRecord } from "../storage/idb";
import { AisModuleIframe, type AisModuleRuntimeStatus } from "../packages/aisModuleIframe";
import {
  createAisModuleHandlers,
  createAisMutationQueue,
  projectAisTokenLight,
  type AisModuleSelectRequest,
} from "../packages/aisModuleHandlers";

export type AisRuntimeStatuses = Readonly<Record<string, AisModuleRuntimeStatus>>;

export interface AisRuntimeOptions {
  app: HostApp;
  activeSceneId: () => string | null;
  select: (packageId: string, request: AisModuleSelectRequest) => Promise<string | null>;
  cancelChoice: (packageId: string) => void;
  notify: (message: string, level: "info" | "warn" | "error") => void;
  onStatus: (statuses: AisRuntimeStatuses) => void;
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
  /** D-468: the last published player-facing module set (empty until consent is verified). */
  private playerProfileBody: Omit<AisProfileMsg, "kind" | "seq" | "worldId"> = { providers: {}, modules: [] };

  constructor(options: AisRuntimeOptions) {
    this.options = options;
    const { app } = options;
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
      const frame = new AisModuleIframe({
        packageId: module.packageId,
        source: module.source,
        ...(module.runtimeContext ? { runtimeContext: module.runtimeContext, stopOnCommandTimeout: true } : {}),
        commands: module.commands,
        grantedCapabilities: module.capabilities.filter((capability) =>
          (module.runtimeDependencies ?? []).every((dependency) => dependency.capabilities.includes(capability))),
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
          emitModuleEvent: (eventId, payload) => this.emitModuleEvent(module.packageId, eventId, payload),
          newId: (prefix) => `${prefix}${globalThis.crypto.randomUUID()}`,
          assertCapability,
        }),
      });
      this.hosts.set(module.packageId, frame);
  }

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
          if (!frame) this.statuses[module.packageId] = { state: "stopped", error: reason };
        }
      }
      this.options.onStatus({ ...this.statuses });
      this.publishPlayerProfile(world);
    } catch {
      // A failed authority read is never permission to keep executing the cached profile.
      for (const frame of this.hosts.values()) frame.dispose("Could not verify current module approval; reload required");
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
  }
}
