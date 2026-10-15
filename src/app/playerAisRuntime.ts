/**
 * D-468: the player-side AIS runtime. The same sandboxed iframe, the same kernel RPC handlers
 * and the same module code as on the GM device — composed over the player's live replica
 * (`ClientSync`) instead of the host. What differs is authority and consent:
 *
 *   - delivery: the host sends the GM-approved shared module set as `ais.profile`; a module
 *     that leaves a later profile (or changes hash) stops at once, a new one waits for consent;
 *   - consent: the player allows each module per device, world and exact hash (IndexedDB), so
 *     the GM's approval is necessary but never sufficient to run code on a player's machine;
 *     the record also binds a digest this device computes over the delivered code and the
 *     capability list it was shown — the host names the package, the player verifies the bytes;
 *   - authority: every op a module produces travels as the player's own intent, so the host's
 *     `validateOps` and Foundry-default ownership decide — a torch module lights the tokens the
 *     player owns and is refused for everything else (reason `forbidden`, surfaced as a notice).
 *
 * Host-device services (FX, scene tags, themes) are not offered here; the shared profile
 * already strips those capabilities (see aisPlayerProfile.ts).
 */
import type { IDBPDatabase } from "idb";
import type { ClientEvents, ClientSync } from "../client/sync";
import type { EventBus } from "../core";
import {
  aisTokenLightChanges,
  type AisCapability,
  type AisEventName,
  type AisEventPayloads,
  type AisSettingDeclaration,
  type AisSettingValue,
  AIS_MAX_RUNTIME_SETTINGS,
  AIS_MAX_SETTINGS,
  cloneAisSettingDeclaration,
} from "../core/automationInterconnect";
import {
  aisDeviceSettingsScope,
  aisSettingsDocId,
  aisSettingsDocTouched,
  aisWorldSettingValues,
  coerceAisSettingValue,
} from "../core/aisSettings";
import type { ActorDocument, Json, SceneDocument, SettingsDocument, TokenDocument } from "../core/documents";
import type { AisProfileMsg, AisSharedModule } from "../core/messages";
import type { Op } from "../core/ops";
import { aisDocumentChanges } from "../core/aisDocuments";
import {
  AisModuleIframe,
  type AisModuleDiagnostics,
  type AisModuleIframeOptions,
  type AisModuleInvocationOptions,
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
import { packageContentHash } from "../packages/packageHash";
import { createAisPanelHost, type AisPanelEntry, type AisPanelHost } from "../packages/aisPanel";
import { getAllSettings, getSetting, putSetting } from "../storage/idb";
import type { TokenModuleAction } from "../ui/combat/tokenContextMenu";

export type PlayerAisStatuses = Readonly<Record<string, AisModuleRuntimeStatus>>;

/** One module awaiting this player's decision (rendered by the shell's consent dialog). */
export interface PlayerAisPendingConsent {
  packageId: string;
  name: string;
  version: string;
  hash: string;
  capabilities: AisCapability[];
  /** True when this device allowed an earlier hash of the same module (an update, not a stranger). */
  updated: boolean;
  /**
   * "mismatch": the host offers the *same* package hash this device already allowed, but the code
   * it delivered now digests differently. Nothing starts; the dialog says so. A host that behaves
   * never produces this.
   */
  integrity: "ok" | "mismatch";
}

export interface PlayerAisConsentRecord {
  hash: string;
  /** `deliveredDigest` of the code this device allowed (absent only in pre-digest records, which never start). */
  digest?: string;
  /** The capabilities shown at consent time; a later profile may offer a subset without asking again. */
  capabilities?: AisCapability[];
  decision: "allow" | "deny";
  at: number;
}

/**
 * The digest this device computes over what it actually received for a module: entry source,
 * resources and the runtime composition. The host's `hash` names the package (and matches what the
 * GM reviewed); this binds the player's consent to the bytes that will run, so a host cannot
 * substitute code under an already-allowed identity without the player being asked again.
 */
export function deliveredDigest(module: AisSharedModule): string {
  const files: Record<string, string> = { "$source": module.source };
  for (const [path, text] of Object.entries(module.resources ?? {})) files[`$resource/${path}`] = text;
  files.$runtime = JSON.stringify({ runtimeHash: module.runtimeHash ?? null, runtimeContext: module.runtimeContext ?? null });
  return packageContentHash(files);
}

function consentCovers(record: PlayerAisConsentRecord | null, module: AisSharedModule): boolean {
  return record?.decision === "allow" && record.hash === module.hash && record.digest === deliveredDigest(module)
    && module.capabilities.every((capability) => (record.capabilities ?? []).includes(capability));
}

/** The subset of AisModuleIframe the runtime drives (a test seam: no iframe under vitest). */
export interface PlayerAisFrame {
  readonly status: AisModuleRuntimeStatus;
  emit<K extends AisEventName>(event: K, payload: AisEventPayloads[K]): void;
  /** D-469: declared command, run as the player (see AisModuleIframe.invokeCommand). */
  invokeCommand(commandId: string, input: Json, options: AisModuleInvocationOptions): Promise<Json>;
  /** D-470: visibility of the module's own document inside its panel. */
  setVisible?(visible: boolean): void;
  /** D-479: health counters and trace (absent in the test seam). */
  diagnostics?(): AisModuleDiagnostics;
  dispose(reason: string): void;
}

/** D-476: what the player shell's device-settings form renders for one shared module. */
export interface PlayerAisSettingsView {
  declarations: AisSettingDeclaration[];
  values: Record<string, AisSettingValue>;
}

export interface PlayerAisRuntimeOptions {
  client: ClientSync;
  /** The client's event bus (PlayerApp.bus): snapshot/ops/turn events and `aisProfile`. */
  bus: EventBus<ClientEvents>;
  db: IDBPDatabase;
  worldId: string;
  /** The scene the player is viewing (the shell owns that choice). */
  activeScene: () => SceneDocument | null;
  select: (packageId: string, request: AisModuleSelectRequest) => Promise<string | null>;
  cancelChoice: (packageId: string) => void;
  notify: (message: string, level: "info" | "warn" | "error") => void;
  onStatus: (statuses: PlayerAisStatuses) => void;
  onPending: (pending: PlayerAisPendingConsent[]) => void;
  /** Test seam; production creates the sandboxed iframe. */
  createFrame?: (options: AisModuleIframeOptions) => PlayerAisFrame;
  /** D-470: persistent layer element for sandboxed module panels; absent = panels unavailable. */
  panelLayer?: HTMLElement;
  /** Test seam for the panel host. */
  panelHost?: AisPanelHost;
  now?: () => number;
}

export const PLAYER_AIS_CONSENT_SCOPE_PREFIX = "ais-player-consent:";

export function playerAisConsentScope(worldId: string): string {
  return `${PLAYER_AIS_CONSENT_SCOPE_PREFIX}${worldId}`;
}

/** Plain-language capability descriptions for the consent prompt (what the module MAY ask the host for). */
export function describeAisCapability(capability: AisCapability): string {
  switch (capability) {
    case "scene.read.visible": return "read the scene you can see";
    case "action.observe": return "react to token actions you trigger";
    case "module.storage.read": return "read its own settings on this device";
    case "module.storage.write": return "save its own settings on this device";
    case "chat.post": return "post chat messages as you";
    case "ui.notify": return "show you notifications";
    case "ui.interaction": return "ask you to choose from a list";
    case "event.emit": return "signal other shared modules";
    case "actor.inventory.read": return "read the inventory of your characters";
    case "actor.inventory.consume": return "use up items your characters carry";
    case "scene.token.light.manage": return "change the light carried by your tokens";
    case "scene.tags.read": return "read scene tags";
    case "scene.tags.write": return "edit scene tags";
    case "fx.play": return "play visual effects";
    case "runtime.execute": return "run inside a shared adapter runtime";
    case "package.resources.read": return "read its own bundled files";
    case "ui.theme": return "restyle the interface";
    case "ui.panel": return "show its own panel in a window on your screen";
    case "module.settings.write": return "change its own declared settings on this device";
    case "compendium.read": return "read compendium packs (GM device only; nothing on yours)";
    case "modules.invoke": return "ask other shared modules on this device to run their commands";
    case "documents.read": return "read the actors, items, journals and tables you can see, and watch them change";
    case "documents.write": return "create, edit and delete documents as you (only what you may edit yourself)";
    default: return capability;
  }
}

function jsonByteLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : new TextEncoder().encode(text).byteLength;
  } catch {
    return null;
  }
}

export class PlayerAisRuntime {
  private readonly options: PlayerAisRuntimeOptions;
  private readonly frames = new Map<string, PlayerAisFrame>();
  private commandSeq = 0;
  private readonly panels: AisPanelHost | null;
  private readonly running = new Map<string, AisSharedModule>();
  private readonly statuses: Record<string, AisModuleRuntimeStatus> = {};
  private readonly pending = new Map<string, PlayerAisPendingConsent>();
  private readonly off: Array<() => void> = [];
  private readonly mutate = createAisMutationQueue();
  private profile: AisProfileMsg | null = null;
  private applying: Promise<void> = Promise.resolve();
  private disposed = false;
  /** D-476: last world-scope values per running module (one `module.settings.changed` per key). */
  private readonly worldSettingValues = new Map<string, Record<string, AisSettingValue>>();
  /** D-482: declarations added at runtime through `settings.register` (per boot, not persisted). */
  private readonly runtimeDeclarations = new Map<string, AisSettingDeclaration[]>();
  /** D-478: in-flight module→module calls on this device. */
  private busDepth = 0;
  private busSeq = 0;

  constructor(options: PlayerAisRuntimeOptions) {
    this.options = options;
    this.panels = options.panelHost ?? (options.panelLayer ? createAisPanelHost(options.panelLayer) : null);
    const { client, bus } = options;
    this.off.push(
      bus.on("aisProfile", (message) => this.applyProfile(message)),
      bus.on("snapshot", (message) => this.emit("world.snapshot", { seq: message.seq })),
      bus.on("ops", (message) => {
        this.emit("world.ops.committed", { seq: message.envelope.seq, operationCount: message.envelope.ops.length });
        this.emitWorldSettingChanges(message.envelope.ops);
        // D-485: the player's envelopes are already projected by the host; notify per touched root.
        const documentChanges = aisDocumentChanges(message.envelope.seq, message.envelope.by, message.envelope.ops, jsonByteLength);
        if (documentChanges) this.emit("documents.changed", documentChanges);
        const scene = options.activeScene();
        if (!scene) return;
        for (const change of aisTokenLightChanges(message.envelope.ops)) {
          if (change.sceneId !== scene._id) continue;
          const token = scene.tokens.find((candidate) => candidate._id === change.tokenId && !candidate.hidden);
          if (token) this.emit("scene.token.light.changed", {
            sceneId: scene._id, tokenId: token._id, light: projectAisTokenLight(token),
          });
        }
      }),
      bus.on("turnPhase", (message) => this.emit("turn.phase.changed", {
        turnId: message.turnId, phase: message.phase,
        ...(message.mode === "stepwise" || message.mode === "realtime" || message.mode === "simultaneous"
          ? { mode: message.mode } : {}),
        ...(message.paused === undefined ? {} : { paused: message.paused }),
      })),
      bus.on("turnReport", (message) => this.emit("turn.report.committed", {
        turnId: message.turnId, turn: message.report.turn, rulesVersion: message.report.rulesVersion,
      })),
    );
    // The profile may have arrived with the welcome, before this runtime existed.
    if (client.aisProfile) this.applyProfile(client.aisProfile);
  }

  /** The latest shared set (null until the host sent one). */
  get currentProfile(): AisProfileMsg | null { return this.profile; }

  /** Modules awaiting this player's decision, in profile order. */
  get pendingConsent(): PlayerAisPendingConsent[] { return [...this.pending.values()]; }

  /** Resolves when the most recent profile has been fully applied (tests and shells awaiting state). */
  settled(): Promise<void> { return this.applying; }

  private applyProfile(message: AisProfileMsg): void {
    if (this.disposed || message.worldId !== this.options.worldId) return;
    this.profile = message;
    this.applying = this.applying.then(() => this.reconcile(message)).catch((error) => {
      this.options.notify(`AIS modules could not be reconciled: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  }

  private async reconcile(message: AisProfileMsg): Promise<void> {
    if (this.disposed) return;
    const offered = new Map(message.modules.map((module) => [module.packageId, module]));
    // 1. Anything no longer offered under the same hash stops now (and leaves the prompt).
    for (const [packageId, module] of [...this.running]) {
      const next = offered.get(packageId);
      if (next && next.hash === module.hash) continue;
      this.stop(packageId, next ? "The GM shared a different version of this module" : "No longer shared by the GM");
    }
    for (const packageId of [...this.pending.keys()]) {
      const next = offered.get(packageId);
      if (!next || next.hash !== this.pending.get(packageId)?.hash) this.pending.delete(packageId);
    }
    // 2. New or changed modules: consented code starts, declined ones stay quiet, the rest ask.
    for (const module of message.modules) {
      if (this.running.has(module.packageId) || this.pending.has(module.packageId)) continue;
      const record = await this.consentRecord(module.packageId);
      if (this.disposed) return;
      if (consentCovers(record, module)) { this.start(module); continue; }
      if (record?.hash === module.hash && record.decision === "deny") {
        this.statuses[module.packageId] = { state: "stopped", error: "Declined on this device" };
        continue;
      }
      const sameHashDifferentCode = record?.decision === "allow" && record.hash === module.hash
        && record.digest !== undefined && record.digest !== deliveredDigest(module);
      if (sameHashDifferentCode) {
        this.statuses[module.packageId] = { state: "failed", error: "Delivered code does not match the code allowed under this hash" };
        this.options.notify(`Module ${module.name}: the host delivered code that differs from what you allowed under the same hash. It was not started.`, "warn");
      }
      this.pending.set(module.packageId, {
        packageId: module.packageId, name: module.name, version: module.version, hash: module.hash,
        capabilities: [...module.capabilities], updated: record?.decision === "allow",
        integrity: sameHashDifferentCode ? "mismatch" : "ok",
      });
    }
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    this.options.onStatus({ ...this.statuses });
    this.options.onPending(this.pendingConsent);
  }

  /**
   * Consent records are re-checked on every module RPC; this runtime is the only writer of its
   * scope, so after the first read they are served from memory (an IndexedDB read per request
   * measured ~200 ms in the e2e sandbox). `writeConsent`/`forget` refresh the entry they write.
   */
  private readonly consentCache = new Map<string, PlayerAisConsentRecord | null>();

  private async consentRecord(packageId: string): Promise<PlayerAisConsentRecord | null> {
    const cached = this.consentCache.get(packageId);
    if (cached !== undefined) return cached;
    const row = await getSetting(this.options.db, playerAisConsentScope(this.options.worldId), packageId);
    const value = row?.value as Partial<PlayerAisConsentRecord> | undefined;
    const record: PlayerAisConsentRecord | null =
      !value || typeof value.hash !== "string" || (value.decision !== "allow" && value.decision !== "deny") ? null : {
        hash: value.hash,
        decision: value.decision,
        at: typeof value.at === "number" ? value.at : 0,
        ...(typeof value.digest === "string" ? { digest: value.digest } : {}),
        ...(Array.isArray(value.capabilities) ? { capabilities: value.capabilities.filter((c): c is AisCapability => typeof c === "string") } : {}),
      };
    // A write that raced this read wins: it already placed the newer entry.
    if (!this.consentCache.has(packageId)) this.consentCache.set(packageId, record);
    return this.consentCache.get(packageId) ?? record;
  }

  private async writeConsent(packageId: string, record: PlayerAisConsentRecord): Promise<void> {
    await putSetting(this.options.db, { scope: playerAisConsentScope(this.options.worldId), key: packageId, value: { ...record } });
    this.consentCache.set(packageId, { ...record, ...(record.capabilities ? { capabilities: [...record.capabilities] } : {}) });
  }

  /** The player's "Allow" for a pending module: persisted for this exact hash and code, then started. */
  async allow(packageId: string): Promise<void> {
    const entry = this.pending.get(packageId);
    const module = this.profile?.modules.find((candidate) => candidate.packageId === packageId);
    if (!entry || !module || module.hash !== entry.hash) return;
    await this.writeConsent(packageId, {
      hash: module.hash, digest: deliveredDigest(module), capabilities: [...module.capabilities],
      decision: "allow", at: (this.options.now ?? Date.now)(),
    });
    if (this.disposed) return;
    this.pending.delete(packageId);
    this.start(module);
    this.publish();
  }

  /** "Not now": remembered for this hash so the prompt does not return every session. */
  async deny(packageId: string): Promise<void> {
    const entry = this.pending.get(packageId);
    if (!entry) return;
    await this.writeConsent(packageId, { hash: entry.hash, decision: "deny", at: (this.options.now ?? Date.now)() });
    if (this.disposed) return;
    this.pending.delete(packageId);
    this.statuses[packageId] = { state: "stopped", error: "Declined on this device" };
    this.publish();
  }

  /** Forget a decision (Settings): a later profile asks again. */
  async forget(packageId: string): Promise<void> {
    await putSetting(this.options.db, { scope: playerAisConsentScope(this.options.worldId), key: packageId, value: null });
    this.consentCache.set(packageId, null);
    this.stop(packageId, "Consent withdrawn on this device");
    if (this.profile) this.applyProfile(this.profile);
  }

  /** Current consent + offer check: the equivalent of the GM's hash-bound grant verification. */
  private async assertModuleActive(module: AisSharedModule, capability?: AisCapability): Promise<void> {
    if (this.disposed) throw new Error("AIS player runtime was stopped");
    const offered = this.profile?.modules.find((candidate) => candidate.packageId === module.packageId);
    if (!offered || offered.hash !== module.hash) throw new Error(`AIS module ${module.packageId} is no longer shared by the GM`);
    const record = await this.consentRecord(module.packageId);
    if (!consentCovers(record, offered))
      throw new Error(`AIS module ${module.packageId} is not allowed on this device`);
    if (capability && !offered.capabilities.includes(capability))
      throw new Error(`AIS capability ${capability} is not shared for ${module.packageId}`);
    if (this.disposed) throw new Error("AIS player runtime was stopped");
  }

  private start(module: AisSharedModule): void {
    // D-482: the settings context exposes a live getter (declarations grow at runtime).
    const declarationsOf = (packageId: string): readonly AisSettingDeclaration[] => this.declarationsOf(packageId);
    const { options } = this;
    const { client } = options;
    const assertCapability = (capability?: AisCapability): Promise<void> => this.assertModuleActive(module, capability);
    // D-470: the hidden host-chromed window exists before the iframe so the frame is born inside it.
    const panels = this.panels;
    const panelBody = module.panel && panels
      ? panels.mount(module.packageId, { title: module.panel.title, moduleName: module.name,
        width: module.panel.width, height: module.panel.height,
        onClose: () => { this.frames.get(module.packageId)?.emit("ui.panel.closed", { reason: "user" }); this.publish(); } })
      : undefined;
    const frameOptions: AisModuleIframeOptions = {
      packageId: module.packageId,
      source: module.source,
      ...(module.runtimeContext !== undefined ? { runtimeContext: module.runtimeContext, stopOnCommandTimeout: true } : {}),
      commands: module.commands,
      grantedCapabilities: module.capabilities,
      playerCommands: true,
      ...(panelBody ? { hostElement: panelBody } : {}),
      assertModuleActive: () => assertCapability(),
      isCapabilityCurrentlyGranted: async (capability) => {
        try { await assertCapability(capability); return true; } catch { return false; }
      },
      onSubscribe: (event) => {
        if (event === "world.snapshot") this.frames.get(module.packageId)?.emit(event, { seq: client.store.seq });
      },
      onStatus: (status) => {
        const registered = this.runtimeDeclarations.get(module.packageId)?.length ?? 0; // D-482
        this.statuses[module.packageId] = registered ? { ...status, settings: registered } : status;
        if (status.state === "failed" || status.state === "stopped") {
          options.cancelChoice(module.packageId);
          panels?.close(module.packageId);
        }
        if (status.state === "failed") options.notify(`Module ${module.name}: ${status.error}`, "error");
        this.publish();
      },
      handlers: createAisModuleHandlers({
        worldId: options.worldId,
        packageId: module.packageId,
        emittedEvents: module.emittedEvents,
        db: options.db,
        user: () => ({ id: client.user?.id ?? "player", name: client.user?.name ?? "Player" }),
        activeScene: () => options.activeScene(),
        actorById: (id) => client.store.get("actors", id) as ActorDocument | undefined,
        select: (request) => options.select(module.packageId, request),
        // Resolves only on the host's commit; a `forbidden` rejection becomes the RPC's error.
        submit: (ops) => client.submitAndWait(ops),
        mutate: this.mutate,
        ...(module.resources ? { resources: module.resources } : {}),
        sequence: () => client.store.seq,
        notify: options.notify,
        ...(panelBody && panels ? { panel: {
          open: () => { panels.open(module.packageId); this.publish(); },
          close: () => { panels.close(module.packageId); this.publish(); },
        } } : {}),
        emitModuleEvent: (eventId, payload) => this.emitModuleEvent(module.packageId, eventId, payload),
        newId: (prefix) => `${prefix}${globalThis.crypto.randomUUID()}`,
        assertCapability,
        // D-476: world scope is read from the replica; only device scope is writable here.
        // D-482: always present — a module may declare settings at runtime (`settings.register`).
        settings: {
          get declarations() { return declarationsOf(module.packageId); },
          packageName: module.name,
          worldDoc: () => this.worldSettingsDoc(module.packageId),
          canWriteWorld: () => false,
          onDeviceChange: (key, value) =>
            this.frames.get(module.packageId)?.emit("module.settings.changed", { scope: "device", key, value }),
          register: (declaration) => this.registerRuntimeSetting(module.packageId, declaration),
        },
        // D-477: no `compendia` — packs live on the GM device; the handler says so.
        // D-478: sibling modules running on this device, invoked with the player's authority.
        modules: {
          requires: module.requires ?? [],
          list: () => this.moduleDirectory(),
          invoke: (target, commandId, input, lifetime) => this.invokeFromModule(module.packageId, target, commandId, input, lifetime),
        },
        // D-485: the player's projected world; writes run as the player through `submit`.
        documents: {
          getAll: (collection) => client.store.getAll(collection),
          get: (collection, id) => client.store.get(collection, id),
        },
      }),
    };
    const frame = (options.createFrame ?? ((frameOptionsIn) => new AisModuleIframe(frameOptionsIn)))(frameOptions);
    if (panelBody && panels) panels.attach(module.packageId, { setVisible: (visible) => frame.setVisible?.(visible) });
    this.frames.set(module.packageId, frame);
    this.running.set(module.packageId, module);
    this.statuses[module.packageId] = frame.status;
    if (module.settings?.length)
      this.worldSettingValues.set(module.packageId, aisWorldSettingValues(this.worldSettingsDoc(module.packageId), module.settings));
  }

  private worldSettingsDoc(packageId: string): SettingsDocument | undefined {
    return this.options.client.store.get("settings", aisSettingsDocId(packageId)) as SettingsDocument | undefined;
  }

  /** D-482: the profile's declarations followed by the ones this module registered at runtime. */
  declarationsOf(packageId: string): readonly AisSettingDeclaration[] {
    const module = this.running.get(packageId) ?? this.profile?.modules.find((candidate) => candidate.packageId === packageId);
    return [...(module?.settings ?? []), ...(this.runtimeDeclarations.get(packageId) ?? [])];
  }

  private registerRuntimeSetting(packageId: string, declaration: AisSettingDeclaration): string | null {
    const manifestCount = this.running.get(packageId)?.settings?.length ?? 0;
    const rows = this.runtimeDeclarations.get(packageId) ?? [];
    if (manifestCount + rows.length >= AIS_MAX_SETTINGS + AIS_MAX_RUNTIME_SETTINGS)
      return `A module may declare at most ${AIS_MAX_SETTINGS + AIS_MAX_RUNTIME_SETTINGS} settings`;
    rows.push(cloneAisSettingDeclaration(declaration));
    this.runtimeDeclarations.set(packageId, rows);
    this.worldSettingValues.set(packageId, aisWorldSettingValues(this.worldSettingsDoc(packageId), this.declarationsOf(packageId)));
    const status = this.statuses[packageId];
    if (status) this.statuses[packageId] = { ...status, settings: rows.length };
    this.publish();
    return null;
  }

  /** D-476: a replicated commit touched a module's world-settings document → one event per changed key. */
  private emitWorldSettingChanges(ops: readonly Op[]): void {
    for (const [packageId] of this.running) {
      const declarations = this.declarationsOf(packageId);
      if (!declarations.length || !aisSettingsDocTouched(ops, packageId)) continue;
      const previous = this.worldSettingValues.get(packageId) ?? {};
      const next = aisWorldSettingValues(this.worldSettingsDoc(packageId), declarations);
      this.worldSettingValues.set(packageId, next);
      const frame = this.frames.get(packageId);
      for (const [key, value] of Object.entries(next))
        if (previous[key] !== value) frame?.emit("module.settings.changed", { scope: "world", key, value });
    }
  }

  /** D-476: declarations + effective values (world from the replica, device from this device). */
  async moduleSettings(packageId: string): Promise<PlayerAisSettingsView | null> {
    const module = this.profile?.modules.find((candidate) => candidate.packageId === packageId);
    const declarations = this.declarationsOf(packageId);
    if (!module || !declarations.length) return null;
    const values = aisWorldSettingValues(this.worldSettingsDoc(packageId), declarations);
    const rows = await getAllSettings(this.options.db, aisDeviceSettingsScope(this.options.worldId, packageId));
    for (const declaration of declarations) {
      if (declaration.scope !== "device") continue;
      const row = rows.find((candidate) => candidate.key === declaration.key);
      const coerced = row ? coerceAisSettingValue(declaration, row.value) : null;
      values[declaration.key] = coerced?.ok ? coerced.value : declaration.default;
    }
    return { declarations: declarations.map((declaration) => cloneAisSettingDeclaration(declaration)), values };
  }

  /** D-476: the player's form writes a device-scope value (world scope is the GM's). */
  async setDeviceSetting(packageId: string, key: string, value: unknown): Promise<AisSettingValue> {
    const declaration = this.declarationsOf(packageId).find((candidate) => candidate.key === key);
    if (!declaration) throw new Error(`${packageId} declares no setting ${key}`);
    if (declaration.scope !== "device") throw new Error("World-scope settings are changed by the GM");
    const coerced = coerceAisSettingValue(declaration, value);
    if (!coerced.ok) throw new Error(coerced.error);
    await putSetting(this.options.db, { scope: aisDeviceSettingsScope(this.options.worldId, packageId), key, value: coerced.value });
    this.frames.get(packageId)?.emit("module.settings.changed", { scope: "device", key, value: coerced.value });
    return coerced.value;
  }

  /** D-478: the public contract of every shared module on this device. */
  private moduleDirectory(): AisModuleDirectoryEntry[] {
    return (this.profile?.modules ?? []).map((module) => ({
      packageId: module.packageId, name: module.name, version: module.version,
      running: this.running.has(module.packageId) && this.frames.get(module.packageId)?.status.state === "ready",
      commands: module.commands, provides: module.provides ?? [], emits: module.emittedEvents,
    }));
  }

  /** D-478: route to a sibling's declared command with this player's authority. */
  private async invokeFromModule(
    callerPackageId: string,
    targetId: string,
    commandId: string,
    input: Json,
    lifetime: AisModuleRequestContext | undefined,
  ): Promise<Json> {
    const frame = this.running.has(targetId) ? this.frames.get(targetId) : undefined;
    if (!frame) throw new Error(`AIS module ${targetId} is not running on this device`);
    if (this.busDepth >= 8) throw new Error("AIS module bus depth exceeded");
    const scene = this.options.activeScene();
    this.busDepth++;
    try {
      return await frame.invokeCommand(commandId, input, {
        sceneId: scene?._id ?? "",
        callerId: this.options.client.user?.id ?? "player",
        requestId: `ais-module:${callerPackageId}:${++this.busSeq}`,
        runAs: "player",
        isActive: () => !this.disposed && this.frames.get(targetId) === frame && lifetime?.isActive() !== false,
      });
    } finally { this.busDepth--; }
  }

  /** D-479: health counters and trace of one running module (null when not running or in the test seam). */
  diagnostics(packageId: string): AisModuleDiagnostics | null {
    const frame = this.running.has(packageId) ? this.frames.get(packageId) : undefined;
    return frame?.diagnostics?.() ?? null;
  }

  /** D-479: stop and start a consented module again (after a circuit trip); consent is re-read. */
  async restart(packageId: string): Promise<boolean> {
    const module = this.profile?.modules.find((candidate) => candidate.packageId === packageId);
    if (!module || this.disposed) return false;
    this.stop(packageId, "Restarted on this device");
    const record = await this.consentRecord(packageId);
    if (this.disposed || !consentCovers(record, module)) return false;
    this.start(module);
    this.publish();
    return true;
  }

  private stop(packageId: string, reason: string): void {
    const frame = this.frames.get(packageId);
    this.frames.delete(packageId);
    this.running.delete(packageId);
    frame?.dispose(reason);
    // D-470: the frame removed itself; its host-chromed window goes with it.
    this.panels?.remove(packageId);
    this.statuses[packageId] = { state: "stopped", error: reason };
    this.options.cancelChoice(packageId);
  }

  private emit<K extends AisEventName>(event: K, payload: AisEventPayloads[K]): void {
    if (this.disposed) return;
    for (const frame of this.frames.values()) frame.emit(event, payload);
  }

  private emitModuleEvent(packageId: string, eventId: string, payload: Json): void {
    if (this.disposed) return;
    for (const [id, frame] of this.frames) {
      if (id !== packageId) frame.emit("module.event", { packageId, eventId, payload });
    }
  }

  /** The selected token-light provider, when it is shared and running here. */
  private lightProvider(): { packageId: string; module: AisSharedModule | undefined; frame: PlayerAisFrame | undefined } | null {
    const selected = this.profile?.providers["scene.token.light.action"];
    const packageId = selected?.split("/", 1)[0];
    if (!packageId) return null;
    return { packageId, module: this.running.get(packageId), frame: this.frames.get(packageId) };
  }

  /** Mirrors AisRuntime.tokenLightState with player wording; undefined = no provider is shared. */
  tokenLightState(token: TokenDocument) {
    const provider = this.lightProvider();
    if (!provider) return undefined;
    const ais = token.flags.ais as Record<string, unknown> | undefined;
    const state = ais ? ais[provider.packageId] as Record<string, unknown> | undefined : undefined;
    const pending = this.pending.get(provider.packageId);
    const reason = pending ? "Allow the token-light module when prompted (it is waiting for your decision)."
      : !provider.frame ? this.statuses[provider.packageId]?.error ?? "The token-light module is not running on this device."
        : provider.frame.status.state !== "ready" ? provider.frame.status.error ?? "The token-light module is starting."
          : !provider.module?.capabilities.includes("action.observe")
            ? "The GM has not shared action.observe for the token-light module." : null;
    return { enabled: reason === null, reason, active: state?.active === true,
      sourceName: typeof state?.sourceName === "string" ? state.sourceName : null };
  }

  /**
   * D-469: run one declared command of a shared module as this player. The command executes inside
   * the player's own frame; every write it makes travels through ClientSync and is validated by the
   * host under this player's ownership, exactly like a hand-made edit.
   */
  async invokeCommand(packageId: string, commandId: string, input: Json): Promise<Json> {
    const frame = this.running.has(packageId) ? this.frames.get(packageId) : undefined;
    if (!frame) throw new Error("The module is not running on this device.");
    const scene = this.options.activeScene();
    if (!scene) throw new Error("No scene is open.");
    const requestId = `player-cmd-${++this.commandSeq}`;
    return frame.invokeCommand(commandId, input, {
      sceneId: scene._id,
      callerId: this.options.client.user?.id ?? "player",
      requestId,
      runAs: "player",
      isActive: () => !this.disposed && this.frames.get(packageId) === frame,
    });
  }

  /** D-470: panels of running shared modules that declared one (for the Shared-modules card). */
  panelEntries(): AisPanelEntry[] { return this.panels?.entries() ?? []; }

  /** D-470: open a module's panel from the shell; false (with a notice) when it is not running. */
  openPanel(packageId: string): boolean {
    const frame = this.running.has(packageId) ? this.frames.get(packageId) : undefined;
    if (!frame || frame.status.state !== "ready" || !this.panels) {
      this.options.notify(frame?.status.error ?? "The module is not running on this device.", "warn");
      return false;
    }
    const opened = this.panels.open(packageId);
    if (opened) this.publish();
    return opened;
  }

  closePanel(packageId: string): boolean {
    const closed = this.panels?.close(packageId) ?? false;
    if (closed) this.publish();
    return closed;
  }

  /** D-469: manifest token actions of the shared modules, with this device's run state. */
  tokenActions(): TokenModuleAction[] {
    const out: TokenModuleAction[] = [];
    for (const module of this.profile?.modules ?? []) {
      if (!module.tokenActions?.length) continue;
      const frame = this.running.has(module.packageId) ? this.frames.get(module.packageId) : undefined;
      const reason = this.pending.has(module.packageId) ? "Allow this module when prompted (it is waiting for your decision)."
        : !frame ? this.statuses[module.packageId]?.error ?? "The module is not running on this device."
          : frame.status.state !== "ready" ? frame.status.error ?? "The module is starting." : null;
      for (const action of module.tokenActions)
        out.push({ packageId: module.packageId, id: action.id, label: action.label, enabled: reason === null, reason });
    }
    return out;
  }

  runTokenAction(tokenId: string, packageId: string, actionId: string): void {
    const scene = this.options.activeScene();
    const token = scene?.tokens.find((row) => row._id === tokenId);
    const action = this.tokenActions().find((row) => row.packageId === packageId && row.id === actionId);
    if (!scene || !token || !action?.enabled) {
      this.options.notify(action?.reason ?? "That module action is not available at this table.", "warn");
      return;
    }
    this.frames.get(packageId)?.emit("ui.token.action", { sceneId: scene._id, tokenId, action: actionId });
  }

  tokenLightAction(tokenId: string, action: string): void {
    const scene = this.options.activeScene();
    const token = scene?.tokens.find((row) => row._id === tokenId && !row.hidden);
    const provider = this.lightProvider();
    const state = token ? this.tokenLightState(token) : undefined;
    if (!scene || !provider || !state?.enabled) {
      this.options.notify(state?.reason ?? "Token lighting is not available at this table.", "warn");
      return;
    }
    provider.frame?.emit("ui.token.action", { sceneId: scene._id, tokenId, action });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    for (const frame of this.frames.values()) frame.dispose("Left the table");
    this.frames.clear();
    this.running.clear();
    this.panels?.dispose();
    this.pending.clear();
  }
}
