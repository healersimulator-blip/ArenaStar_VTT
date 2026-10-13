import {
  AIS_EVENTS,
  type AisCapability,
  type AisEventName,
  type AisEventPayloads,
  type AisModuleCommandDeclaration,
} from "../core/automationInterconnect";
import type { Json } from "../core/documents";
import { AIS_MODULE_RUNTIME_SOURCE } from "./aisModuleRuntimeSource";

export const AIS_RPC_TAG = 1 as const;
export const AIS_MAX_RPC_BYTES = 64 * 1024;
const MAX_REQUESTS_PER_SECOND = 120;
const MAX_COMMANDS_PER_SECOND = 30;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_COMMAND_MS = 8_000;
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
    runAs: "gm";
    deadlineAt: number;
  };
}

/** Host-only authorization/liveness context attached to RPCs made by a macro command. */
export interface AisModuleCallContext {
  commandId: string;
  sceneId: string;
  callerId: string;
  requestId: string;
  runAs: "gm";
  deadlineAt: number;
  isActive(): boolean;
  assertActive(): void;
}

export interface AisModuleInvocationOptions {
  sceneId: string;
  callerId: string;
  requestId: string;
  /** AIS commands execute only under an explicitly GM-reviewed script-macro elevation. */
  runAs: "gm";
  isActive: () => boolean;
}

export type AisModuleHandler = (
  args: Record<string, unknown>,
  context?: AisModuleCallContext,
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
  if (frame.args !== null && frame.args !== undefined && jsonByteLength(frame.args) === null) return null;
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
): {
  onFrame(
    data: unknown,
    post: (frame: AisModuleResponse) => void,
    commandContext?: (commandId: string) => AisModuleCallContext | null,
  ): void;
} {
  const requestTimes: number[] = [];
  let activeRequests = 0;
  return {
    onFrame(data, post, resolveCommandContext) {
      const size = jsonByteLength(data);
      const request = parseRequest(data);
      if (!request || size === null || size > AIS_MAX_RPC_BYTES) return;

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

      let callContext: AisModuleCallContext | undefined;
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
        onSubscribe(args.event);
      }
      activeRequests++;
      void (async () => {
        let response: AisModuleResponse;
        try {
          callContext?.assertActive();
          const result = await handlers[request.method](args, callContext);
          callContext?.assertActive();
          const resultSize = jsonByteLength(result);
          if (resultSize === null || resultSize > AIS_MAX_RPC_BYTES)
            throw new Error("AIS RPC result exceeds the size limit");
          response = { vttAisRpc: AIS_RPC_TAG, kind: "response", id: request.id, ok: true, result };
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
        post(response);
      })();
    },
  };
}

export interface AisModuleIframeOptions {
  packageId: string;
  source: string;
  grantedCapabilities: readonly AisCapability[];
  handlers: AisModuleHandlers;
  commands?: readonly AisModuleCommandDeclaration[];
  /** Rechecked before forwarding events, so revocation takes effect without waiting for reload. */
  isCapabilityCurrentlyGranted?: (capability: AisCapability) => Promise<boolean> | boolean;
  /** Rechecked before a script macro dispatches a declared command. */
  isModuleCurrentlyActive?: () => Promise<boolean> | boolean;
  hostElement?: HTMLElement;
}

interface ActiveModuleCommand {
  context: AisModuleCallContext;
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Run a module in an opaque-origin, script-only iframe. Network and external resources are
 * blocked by a restrictive CSP; every bridge request is source-checked and capability-gated.
 */
export class AisModuleIframe {
  readonly packageId: string;
  private readonly frame: HTMLIFrameElement;
  private readonly dispatcher: ReturnType<typeof createAisModuleDispatcher>;
  private readonly subscriptions = new Set<AisEventName>();
  private readonly commandIds: ReadonlySet<string>;
  private readonly isCapabilityCurrentlyGranted: ((capability: AisCapability) => Promise<boolean> | boolean) | undefined;
  private readonly isModuleCurrentlyActive: (() => Promise<boolean> | boolean) | undefined;
  private readonly activeCommands = new Map<string, ActiveModuleCommand>();
  private readonly commandTimes: number[] = [];
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private readyState = false;
  private nextCommandId = 1;
  private disposed = false;

  constructor(options: AisModuleIframeOptions) {
    this.packageId = options.packageId;
    this.commandIds = new Set((options.commands ?? []).map((command) => command.id));
    this.isCapabilityCurrentlyGranted = options.isCapabilityCurrentlyGranted;
    this.isModuleCurrentlyActive = options.isModuleCurrentlyActive;
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.dispatcher = createAisModuleDispatcher(
      options.handlers,
      new Set(options.grantedCapabilities),
      (event) => this.subscriptions.add(event),
    );
    const doc = globalThis.document;
    const frame = doc.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", `AIS module:${options.packageId}`);
    frame.style.display = "none";
    const csp = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; navigate-to 'none'";
    const srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><body><script>${escapeScript(AIS_MODULE_RUNTIME_SOURCE)}</script><script>${escapeScript(options.source)}</script><script>globalThis.AIS.__ready()</script></body>`;
    frame.srcdoc = srcdoc;
    (options.hostElement ?? doc.body).appendChild(frame);
    this.frame = frame;
    globalThis.addEventListener("message", this.onMessage);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.disposed || event.source !== this.frame.contentWindow || event.origin !== "null") return;
    const data = asRecord(event.data);
    if (!data || data.vttAisRpc !== AIS_RPC_TAG) return;
    if (data.kind === "ready") {
      if (!this.readyState) {
        this.readyState = true;
        this.resolveReady();
      }
      return;
    }
    if (data.kind === "command-result") {
      this.finishCommand(data);
      return;
    }
    const commandId = typeof data.commandId === "string" ? data.commandId : undefined;
    this.dispatcher.onFrame(event.data, (response) => this.post(response), commandId
      ? (id) => this.activeCommands.get(id)?.context ?? null
      : undefined);
  };

  private finishCommand(data: Record<string, unknown>): void {
    if (typeof data.id !== "string" || !COMMAND_ID_RE.test(data.id)) return;
    const active = this.activeCommands.get(data.id);
    if (!active) return;
    try {
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
    const size = jsonByteLength(frame);
    if (this.disposed || size === null || size > AIS_MAX_RPC_BYTES || !this.hasOpaqueOrigin()) return;
    this.frame.contentWindow?.postMessage(frame, "*");
  }

  private hasOpaqueOrigin(): boolean {
    try {
      return this.frame.contentWindow?.location.origin === "null";
    } catch {
      // A module can navigate its frame even without top-navigation permission. Never send
      // host events or capability replies to a document that is no longer the opaque srcdoc.
      return false;
    }
  }

  async invokeCommand(
    commandId: string,
    input: Json,
    options: AisModuleInvocationOptions,
  ): Promise<Json> {
    if (this.disposed) throw new Error(`AIS module ${this.packageId} is not running`);
    if (!this.commandIds.has(commandId)) throw new Error(`AIS module ${this.packageId} does not declare command ${commandId}`);
    if (!COMMAND_NAME_RE.test(commandId)) throw new Error("Invalid AIS command ID");
    if (options.runAs !== "gm") throw new Error("AIS module commands require explicitly reviewed GM authority");
    if (!boundedJson(input) || (jsonByteLength(input) ?? Infinity) > MAX_COMMAND_BYTES)
      throw new Error("AIS command input exceeds 16 KiB or is not bounded JSON");
    if (this.activeCommands.size > 0) throw new Error(`AIS module ${this.packageId} already has a command running`);

    const now = Date.now();
    while (this.commandTimes.length > 0 && now - (this.commandTimes[0] ?? now) >= 1000) this.commandTimes.shift();
    if (this.commandTimes.length >= MAX_COMMANDS_PER_SECOND) throw new Error("AIS command rate limit exceeded");
    this.commandTimes.push(now);

    await Promise.race([
      this.ready,
      new Promise<never>((_, reject) => globalThis.setTimeout(() => reject(new Error(`AIS module ${this.packageId} did not become ready`)), 2000)),
    ]);
    if (this.disposed || !(await options.isActive())) throw new Error("AIS macro invocation is no longer active");
    if (this.isModuleCurrentlyActive && !(await this.isModuleCurrentlyActive()))
      throw new Error(`AIS module ${this.packageId} is no longer enabled and locally approved`);

    const id = `cmd-${this.nextCommandId++}`;
    const deadlineAt = Date.now() + MAX_COMMAND_MS;
    const isActive = (): boolean => !this.disposed && this.activeCommands.has(id) &&
      Date.now() < deadlineAt && options.isActive();
    const context: AisModuleCallContext = {
      commandId: id,
      sceneId: options.sceneId,
      callerId: options.callerId,
      requestId: options.requestId,
      runAs: options.runAs,
      deadlineAt,
      isActive,
      assertActive: () => {
        if (!isActive()) throw new Error("AIS macro command was cancelled, expired or exceeded its budget");
      },
    };

    return new Promise<Json>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.activeCommands.delete(id);
        reject(new Error("AIS module command timed out"));
      }, MAX_COMMAND_MS);
      this.activeCommands.set(id, { context, resolve, reject, timer });
      this.post({
        vttAisRpc: AIS_RPC_TAG,
        kind: "command",
        id,
        commandId,
        input,
        context: {
          sceneId: options.sceneId,
          callerId: options.callerId,
          requestId: options.requestId,
          runAs: options.runAs,
          deadlineAt,
        },
      });
    });
  }

  emit<K extends AisEventName>(event: K, payload: AisEventPayloads[K]): void {
    if (!this.subscriptions.has(event)) return;
    const post = (): void => {
      if (!this.disposed && this.subscriptions.has(event))
        this.post({ vttAisRpc: AIS_RPC_TAG, kind: "event", event, payload });
    };
    if (!this.isCapabilityCurrentlyGranted) {
      post();
      return;
    }
    void Promise.resolve(this.isCapabilityCurrentlyGranted("action.observe")).then((allowed) => {
      if (allowed) post();
    }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    globalThis.removeEventListener("message", this.onMessage);
    this.subscriptions.clear();
    for (const command of this.activeCommands.values()) {
      globalThis.clearTimeout(command.timer);
      command.reject(new Error(`AIS module ${this.packageId} was stopped`));
    }
    this.activeCommands.clear();
    this.frame.remove();
  }
}

function escapeScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}
