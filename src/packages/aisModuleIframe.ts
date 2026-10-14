import {
  AIS_EVENTS,
  type AisCapability,
  type AisEventName,
  type AisEventPayloads,
  type AisModuleCommandDeclaration,
} from "../core/automationInterconnect";
import type { Json } from "../core/documents";
import { aisModuleRuntimeSource } from "./aisModuleRuntimeSource";

export const AIS_RPC_TAG = 1 as const;
export const AIS_MAX_RPC_BYTES = 64 * 1024;
const MAX_REQUESTS_PER_SECOND = 120;
const MAX_COMMANDS_PER_SECOND = 30;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_COMMAND_MS = 8_000;
const MAX_STARTUP_MS = 5_000;
const COMMAND_ID_RE = /^cmd-[0-9]{1,16}$/;
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9._:-]{1,127}$/;

export const AIS_MODULE_METHODS = [
  "events.subscribe",
  "events.emit",
  "scene.read.visible",
  "actor.inventory.read",
  "scene.token.light.apply",
  "module.storage.get",
  "module.storage.set",
  "chat.post",
  "ui.notify",
  "ui.select",
  "ui.panel.open",
  "ui.panel.close",
  "scene.tags.snapshot",
  "scene.tags.update",
  "fx.play",
  "fx.list",
  "fx.stop",
  "package.resource.read",
] as const;
export type AisModuleMethod = (typeof AIS_MODULE_METHODS)[number];

const REQUIRED_CAPABILITY: Record<AisModuleMethod, AisCapability> = {
  "events.subscribe": "action.observe",
  "events.emit": "event.emit",
  "scene.read.visible": "scene.read.visible",
  "actor.inventory.read": "actor.inventory.read",
  "scene.token.light.apply": "scene.token.light.manage",
  "module.storage.get": "module.storage.read",
  "module.storage.set": "module.storage.write",
  "chat.post": "chat.post",
  "ui.notify": "ui.notify",
  "ui.select": "ui.interaction",
  "ui.panel.open": "ui.panel",
  "ui.panel.close": "ui.panel",
  "scene.tags.snapshot": "scene.tags.read",
  "scene.tags.update": "scene.tags.write",
  "fx.play": "fx.play",
  "fx.list": "fx.play",
  "fx.stop": "fx.play",
  "package.resource.read": "package.resources.read",
};

export interface AisModuleRequest {
  vttAisRpc: typeof AIS_RPC_TAG;
  kind: "request";
  id: number;
  method: AisModuleMethod;
  args: unknown;
  /** Present only for an explicitly invoked, macro-facing command. */
  commandId?: string;
}

export interface AisModuleResponse {
  vttAisRpc: typeof AIS_RPC_TAG;
  kind: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AisModuleEventFrame {
  vttAisRpc: typeof AIS_RPC_TAG;
  kind: "event";
  event: AisEventName;
  payload: unknown;
}

export interface AisModuleCommandFrame {
  vttAisRpc: typeof AIS_RPC_TAG;
  kind: "command";
  id: string;
  commandId: string;
  input: Json;
  context: {
    sceneId: string;
    callerId: string;
    requestId: string;
    runAs: "gm" | "player";
    deadlineAt: number;
  };
}

/** Every RPC is bound to a live module instance, including non-command event callbacks. */
export interface AisModuleRequestContext {
  commandId?: string;
  isActive(): boolean;
  assertActive(): void;
}

/** Host-only authorization/liveness context attached to RPCs made by a macro command. */
export interface AisModuleCallContext extends AisModuleRequestContext {
  commandId: string;
  sceneId: string;
  callerId: string;
  requestId: string;
  runAs: "gm" | "player";
  deadlineAt: number;
  isActive(): boolean;
  assertActive(): void;
}

export interface AisModuleInvocationOptions {
  sceneId: string;
  callerId: string;
  requestId: string;
  /**
   * At the host, AIS commands execute only under an explicitly GM-reviewed script-macro elevation
   * (`"gm"`). D-469: a frame created with `playerCommands: true` — the player-side runtime — accepts
   * `"player"`: the command runs with that player's own authority (host-side ownership validation).
   */
  runAs: "gm" | "player";
  isActive: () => boolean;
}

export type AisModuleHandler = (
  args: Record<string, unknown>,
  context?: AisModuleRequestContext,
) => unknown | Promise<unknown>;
export type AisModuleHandlers = Record<AisModuleMethod, AisModuleHandler>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonByteLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : new TextEncoder().encode(text).byteLength;
  } catch {
    return null;
  }
}

function boundedJson(value: unknown, depth = 0, seen = new Set<object>()): value is Json {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  let valid: boolean;
  if (Array.isArray(value)) valid = value.length <= 1024 && value.every((item) => boundedJson(item, depth + 1, seen));
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row);
    valid = keys.length <= 1024 && keys.every((key) =>
      key !== "__proto__" && key !== "constructor" && boundedJson(row[key], depth + 1, seen),
    );
  }
  seen.delete(value);
  return valid;
}

function isAisEventName(value: unknown): value is AisEventName {
  return (AIS_EVENTS as readonly unknown[]).includes(value);
}

function parseRequest(value: unknown): AisModuleRequest | null {
  const frame = asRecord(value);
  if (!frame || frame.vttAisRpc !== AIS_RPC_TAG || frame.kind !== "request") return null;
  if (!Number.isSafeInteger(frame.id) || Number(frame.id) < 0) return null;
  if (typeof frame.method !== "string" || !(AIS_MODULE_METHODS as readonly string[]).includes(frame.method)) return null;
  if (Object.keys(frame).some((key) => !["vttAisRpc", "kind", "id", "method", "args", "commandId"].includes(key))) return null;
  if (!asRecord(frame.args) || Array.isArray(frame.args) || !boundedJson(frame.args)) return null;
  if (frame.commandId !== undefined && (typeof frame.commandId !== "string" || !COMMAND_ID_RE.test(frame.commandId))) return null;
  return {
    vttAisRpc: AIS_RPC_TAG,
    kind: "request",
    id: Number(frame.id),
    method: frame.method as AisModuleMethod,
    args: frame.args ?? {},
    ...(frame.commandId === undefined ? {} : { commandId: frame.commandId as string }),
  };
}

/** Capability check and bounded RPC dispatcher shared by every AIS package iframe. */
export function createAisModuleDispatcher(
  handlers: AisModuleHandlers,
  grantedCapabilities: ReadonlySet<AisCapability>,
  onSubscribe: (event: AisEventName) => void,
  lifetime?: AisModuleRequestContext,
): {
  onFrame(
    data: unknown,
    post: (frame: AisModuleResponse) => void,
    commandContext?: (commandId: string) => AisModuleCallContext | null,
  ): void;
} {
  const requestTimes: number[] = [];
  let activeRequests = 0;
  let lastRequestId = -1;
  return {
    onFrame(data, post, resolveCommandContext) {
      const size = jsonByteLength(data);
      const request = parseRequest(data);
      if (!request || size === null || size > AIS_MAX_RPC_BYTES || lifetime?.isActive() === false) return;
      // Ordered port + monotonically increasing SDK IDs: replay can never repeat a write.
      if (request.id <= lastRequestId) return;
      lastRequestId = request.id;

      const now = Date.now();
      while (requestTimes.length > 0 && now - (requestTimes[0] ?? now) >= 1000) requestTimes.shift();
      const respondError = (error: string): void => post({
        vttAisRpc: AIS_RPC_TAG,
        kind: "response",
        id: request.id,
        ok: false,
        error,
      });
      if (requestTimes.length >= MAX_REQUESTS_PER_SECOND) {
        respondError("AIS RPC rate limit exceeded");
        return;
      }
      requestTimes.push(now);
      if (activeRequests >= 32) {
        respondError("AIS RPC concurrency limit exceeded");
        return;
      }

      let callContext: AisModuleRequestContext | undefined = lifetime;
      if (request.commandId !== undefined) {
        callContext = resolveCommandContext?.(request.commandId) ?? undefined;
        if (!callContext || !callContext.isActive()) {
          respondError("AIS macro command is no longer active");
          return;
        }
      }
      const required = REQUIRED_CAPABILITY[request.method];
      if (!grantedCapabilities.has(required)) {
        respondError(`Capability not granted: ${required}`);
        return;
      }

      const args = asRecord(request.args) ?? {};
      if (request.method === "events.subscribe") {
        if (!isAisEventName(args.event)) {
          respondError("Unknown AIS event");
          return;
        }
      }
      activeRequests++;
      void (async () => {
        let response: AisModuleResponse;
        try {
          callContext?.assertActive();
          const result = await handlers[request.method](args, callContext);
          callContext?.assertActive();
          response = { vttAisRpc: AIS_RPC_TAG, kind: "response", id: request.id, ok: true, result };
          if (!boundedJson(result) || (jsonByteLength(response) ?? Infinity) > AIS_MAX_RPC_BYTES)
            throw new Error("AIS RPC result exceeds the size limit or is not bounded JSON");
          // A dynamic grant check may refuse an otherwise well-formed subscription.
          // Register only after that check has succeeded, never on a rejected request.
          if (request.method === "events.subscribe") onSubscribe(args.event as AisEventName);
        } catch (error) {
          response = {
            vttAisRpc: AIS_RPC_TAG,
            kind: "response",
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          };
        } finally {
          activeRequests--;
        }
        if (lifetime?.isActive() !== false) post(response);
      })();
    },
  };
}

export interface AisModuleRuntimeStatus {
  state: "starting" | "ready" | "failed" | "stopped" | "available" | "blocked";
  error?: string;
}

export interface AisModuleIframeOptions {
  packageId: string;
  source: string;
  runtimeContext?: Json;
  /** Guest globals cannot survive an expired invocation and be reused by another call. */
  stopOnCommandTimeout?: boolean;
  grantedCapabilities: readonly AisCapability[];
  handlers: AisModuleHandlers;
  commands?: readonly AisModuleCommandDeclaration[];
  /** Rechecked before forwarding events, so revocation takes effect without waiting for reload. */
  isCapabilityCurrentlyGranted?: (capability: AisCapability) => Promise<boolean> | boolean;
  /** An assertion, not a truthy-return callback: returning void means the check succeeded. */
  assertModuleActive?: () => Promise<void> | void;
  onStatus?: (status: AisModuleRuntimeStatus) => void;
  onSubscribe?: (event: AisEventName) => void;
  hostElement?: HTMLElement;
  /** D-469: this frame belongs to a player's runtime; commands run as `"player"`, never `"gm"`. */
  playerCommands?: boolean;
}

interface ActiveModuleCommand {
  context: AisModuleCallContext;
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Script-only opaque iframe. A one-use authenticated handshake transfers a MessagePort
 * FROM the original document; subsequent navigation cannot inherit that capability.
 * No same-origin access, cross-origin Location reads, or wildcard RPC replies are needed.
 */
export class AisModuleIframe {
  readonly packageId: string;
  private readonly frame: HTMLIFrameElement;
  private readonly dispatcher: ReturnType<typeof createAisModuleDispatcher>;
  private readonly subscriptions = new Set<AisEventName>();
  private readonly commandIds: ReadonlySet<string>;
  private readonly options: AisModuleIframeOptions;
  private readonly activeCommands = new Map<string, ActiveModuleCommand>();
  private readonly commandTimes: number[] = [];
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private readonly bootId = globalThis.crypto.randomUUID();
  private port: MessagePort | null = null;
  private loaded = false;
  private entryReady = false;
  private documentVerified = false;
  private commandPending = false;
  private nextCommandId = 1;
  private disposed = false;
  private statusValue: AisModuleRuntimeStatus = { state: "starting" };

  constructor(options: AisModuleIframeOptions) {
    this.packageId = options.packageId;
    this.options = options;
    this.commandIds = new Set((options.commands ?? []).map((command) => command.id));
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // A failed module may never be called. Keep its rejection observable to whenReady/invoke
    // without creating an unhandled promise rejection in the GM's app.
    void this.ready.catch(() => {});
    const lifetime: AisModuleRequestContext = {
      isActive: () => !this.disposed,
      assertActive: () => { if (this.disposed) throw new Error(`AIS module ${this.packageId} was stopped`); },
    };
    this.dispatcher = createAisModuleDispatcher(options.handlers, new Set(options.grantedCapabilities), (event) => {
      if (!this.subscriptions.has(event)) {
        this.subscriptions.add(event);
        options.onSubscribe?.(event);
      }
    }, lifetime);
    const doc = globalThis.document;
    const frame = doc.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", `AIS module:${options.packageId}`);
    frame.style.display = "none";
    const csp = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'";
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><body><script>${escapeScript(aisModuleRuntimeSource(this.bootId, options.runtimeContext))}</script><script>${escapeScript(options.source)}</script><script>globalThis.AIS.__ready()</script></body>`;
    this.frame = frame;
    this.startupTimer = globalThis.setTimeout(() => this.stop("Module did not become ready", true), MAX_STARTUP_MS);
    globalThis.addEventListener("message", this.onConnect);
    frame.addEventListener("load", this.onLoad);
    (options.hostElement ?? doc.body).appendChild(frame);
    options.onStatus?.(this.statusValue);
  }

  get status(): AisModuleRuntimeStatus { return this.statusValue; }
  whenReady(): Promise<void> { return this.ready; }

  /**
   * D-470: show or hide the module's own document. The element never moves in the DOM (re-parenting
   * an iframe reloads it, which this class treats as a navigation and stops the module); the shell
   * creates it inside the panel body via `hostElement` and toggles visibility here.
   */
  setVisible(visible: boolean): void {
    if (this.disposed && visible) return;
    this.frame.style.display = visible ? "block" : "none";
    if (visible) this.frame.removeAttribute("aria-hidden");
    else this.frame.setAttribute("aria-hidden", "true");
  }

  private readonly onLoad = (): void => {
    if (this.loaded) this.stop("Module iframe navigated; reload the world to restart it", true);
    this.loaded = true;
    this.verifyLoadedDocument();
  };

  private verifyLoadedDocument(): void {
    // A module can navigate BEFORE the iframe's very first load event. Do not mark an
    // abandoned srcdoc ready: only its live document-bound port can answer this probe.
    if (!this.disposed && this.loaded && this.port)
      this.port.postMessage({ vttAisRpc: AIS_RPC_TAG, kind: "ping", bootId: this.bootId });
  }

  private readonly onConnect = (event: MessageEvent): void => {
    if (this.disposed || this.port || event.source !== this.frame.contentWindow || event.origin !== "null") return;
    const data = asRecord(event.data);
    if (!data || data.vttAisRpc !== AIS_RPC_TAG || data.kind !== "connect" ||
        data.bootId !== this.bootId || event.ports.length !== 1) return;
    const port = event.ports[0];
    if (!port) return;
    this.port = port;
    globalThis.removeEventListener("message", this.onConnect);
    port.onmessage = (message) => this.onFrame(message.data);
    port.onmessageerror = () => this.stop("Module bridge could not decode a message", true);
    port.start();
    this.verifyLoadedDocument();
  };

  private onFrame(value: unknown): void {
    if (this.disposed || (jsonByteLength(value) ?? Infinity) > AIS_MAX_RPC_BYTES) return;
    const data = asRecord(value);
    if (!data || data.vttAisRpc !== AIS_RPC_TAG) return;
    if (data.kind === "error") {
      this.stop(typeof data.error === "string" ? data.error.slice(0, 500) : "Module execution failed", true);
    } else if (data.kind === "ready" || data.kind === "pong") {
      if (this.statusValue.state !== "starting") return;
      if (data.kind === "ready") this.entryReady = true;
      else if (this.loaded && data.bootId === this.bootId) this.documentVerified = true;
      if (!this.entryReady || !this.documentVerified) return;
      globalThis.clearTimeout(this.startupTimer);
      this.statusValue = { state: "ready" };
      this.resolveReady();
      this.options.onStatus?.(this.statusValue);
    } else if (data.kind === "command-result") {
      void this.finishCommand(data);
    } else {
      this.dispatcher.onFrame(data, (response) => this.post(response), (id) => this.activeCommands.get(id)?.context ?? null);
    }
  }

  private async finishCommand(data: Record<string, unknown>): Promise<void> {
    if (typeof data.id !== "string" || !COMMAND_ID_RE.test(data.id)) return;
    const active = this.activeCommands.get(data.id);
    if (!active) return;
    try {
      active.context.assertActive();
      await this.options.assertModuleActive?.();
      active.context.assertActive();
      if (data.ok === true && boundedJson(data.result) && (jsonByteLength(data.result) ?? Infinity) <= MAX_COMMAND_BYTES)
        active.resolve(data.result);
      else if (data.ok === true)
        active.reject(new Error("AIS command result exceeds 16 KiB or is not bounded JSON"));
      else active.reject(new Error(typeof data.error === "string" ? data.error.slice(0, 500) : "AIS command failed"));
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeCommands.delete(data.id);
      globalThis.clearTimeout(active.timer);
    }
  }

  private post(frame: AisModuleResponse | AisModuleEventFrame | AisModuleCommandFrame): void {
    if (this.disposed || !this.port || (jsonByteLength(frame) ?? Infinity) > AIS_MAX_RPC_BYTES) return;
    this.port.postMessage(frame);
  }

  async invokeCommand(commandId: string, input: Json, options: AisModuleInvocationOptions): Promise<Json> {
    if (this.disposed) throw new Error(`AIS module ${this.packageId} is not running`);
    if (!this.commandIds.has(commandId)) throw new Error(`AIS module ${this.packageId} does not declare command ${commandId}`);
    if (!COMMAND_NAME_RE.test(commandId)) throw new Error("Invalid AIS command ID");
    if (this.options.playerCommands ? options.runAs !== "player" : options.runAs !== "gm")
      throw new Error(this.options.playerCommands
        ? "AIS module commands at a player run only with that player's own authority"
        : "AIS module commands require explicitly reviewed GM authority");
    if (!boundedJson(input) || (jsonByteLength(input) ?? Infinity) > MAX_COMMAND_BYTES)
      throw new Error("AIS command input exceeds 16 KiB or is not bounded JSON");
    if (this.commandPending) throw new Error(`AIS module ${this.packageId} already has a command running`);
    const now = Date.now();
    while (this.commandTimes.length > 0 && now - (this.commandTimes[0] ?? now) >= 1000) this.commandTimes.shift();
    if (this.commandTimes.length >= MAX_COMMANDS_PER_SECOND) throw new Error("AIS command rate limit exceeded");
    this.commandTimes.push(now);
    // Reserve BEFORE readiness/consent await: two simultaneous calls cannot both pass the gate.
    this.commandPending = true;
    try {
      await this.ready;
      await this.options.assertModuleActive?.();
      if (this.disposed || !options.isActive()) throw new Error("AIS macro invocation is no longer active");
      const id = `cmd-${this.nextCommandId++}`;
      const deadlineAt = Date.now() + MAX_COMMAND_MS;
      const isActive = (): boolean => !this.disposed && this.activeCommands.has(id) &&
        Date.now() < deadlineAt && options.isActive();
      const context: AisModuleCallContext = {
        commandId: id, sceneId: options.sceneId, callerId: options.callerId,
        requestId: options.requestId, runAs: options.runAs, deadlineAt, isActive,
        assertActive: () => { if (!isActive()) throw new Error("AIS macro command was cancelled, expired or exceeded its budget"); },
      };
      return await new Promise<Json>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => {
          this.activeCommands.delete(id);
          reject(new Error("AIS module command timed out"));
          if (this.options.stopOnCommandTimeout) this.stop("Guest command timed out; reload to restart", true);
        }, MAX_COMMAND_MS);
        this.activeCommands.set(id, { context, resolve, reject, timer });
        this.post({ vttAisRpc: AIS_RPC_TAG, kind: "command", id, commandId, input,
          context: { sceneId: options.sceneId, callerId: options.callerId,
            requestId: options.requestId, runAs: options.runAs, deadlineAt } });
      });
    } finally { this.commandPending = false; }
  }

  emit<K extends AisEventName>(event: K, payload: AisEventPayloads[K]): void {
    if (this.disposed || !this.subscriptions.has(event)) return;
    void (async () => {
      await this.options.assertModuleActive?.();
      if (this.options.isCapabilityCurrentlyGranted && !(await this.options.isCapabilityCurrentlyGranted("action.observe"))) return;
      if (!this.disposed && this.subscriptions.has(event))
        this.post({ vttAisRpc: AIS_RPC_TAG, kind: "event", event, payload });
    })().catch(() => {});
  }

  private stop(reason: string, failed = false): void {
    if (this.disposed) return;
    this.disposed = true;
    this.statusValue = { state: failed ? "failed" : "stopped", error: reason };
    globalThis.clearTimeout(this.startupTimer);
    this.rejectReady(new Error(`AIS module ${this.packageId}: ${reason}`));
    globalThis.removeEventListener("message", this.onConnect);
    this.frame.removeEventListener("load", this.onLoad);
    this.port?.close();
    this.port = null;
    this.subscriptions.clear();
    for (const command of this.activeCommands.values()) {
      globalThis.clearTimeout(command.timer);
      command.reject(new Error(`AIS module ${this.packageId}: ${reason}`));
    }
    this.activeCommands.clear();
    this.frame.remove();
    this.options.onStatus?.(this.statusValue);
  }

  dispose(reason = "Module stopped"): void { this.stop(reason); }
}

function escapeScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}
