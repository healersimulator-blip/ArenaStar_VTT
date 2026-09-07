/**
 * §12 sandboxed-iframe module API — the RPC contract between a package's
 * module script (classic script inside a sandboxed iframe, opaque origin)
 * and the host app. The iframe may ONLY talk to us via these messages:
 * no DOM access to the parent, no same-origin, no storage of its own.
 *
 * Frames (both directions) are tagged `vttModuleRpc: 1` and JSON-safe.
 * Host → iframe "event" frames forward whitelisted app events (Hooks).
 */
import type { Json } from "./documents";
import type { Result } from "./result";
import { err, okVal } from "./result";

export const MODULE_RPC_TAG = 1;

/** Methods a module may call (the §12 surface). */
export const MODULE_METHODS = [
  "game.info",
  "settings.get",
  "settings.set",
  "tokens.list",
  "tokens.move",
  "chat.create",
  "notify",
  "hooks.subscribe",
] as const;

export type ModuleMethod = (typeof MODULE_METHODS)[number];

/** App events forwarded into module Hooks (D-087 world scope). */
export const MODULE_HOOKS = ["ready", "snapshot", "turnPhase", "turnReport"] as const;

export type ModuleHookName = (typeof MODULE_HOOKS)[number];

export interface ModuleRpcRequest {
  vttModuleRpc: typeof MODULE_RPC_TAG;
  kind: "request";
  id: number;
  method: string;
  args: Json | undefined;
}

export interface ModuleRpcResponse {
  vttModuleRpc: typeof MODULE_RPC_TAG;
  kind: "response";
  id: number;
  ok: boolean;
  result?: Json;
  error?: string;
}

export interface ModuleRpcEvent {
  vttModuleRpc: typeof MODULE_RPC_TAG;
  kind: "event";
  event: ModuleHookName;
  payload: Json;
}

export type ModuleFrameToHost = ModuleRpcRequest;
export type ModuleFrameToModule = ModuleRpcResponse | ModuleRpcEvent;

/** Max serialized request size (guards runaway modules). */
export const MODULE_MAX_REQUEST_BYTES = 64 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function parseModuleFrame(data: unknown): Result<ModuleRpcRequest> {
  if (!isRecord(data) || data.vttModuleRpc !== MODULE_RPC_TAG || data.kind !== "request") {
    return err("module rpc: not a module request frame");
  }
  if (typeof data.id !== "number" || !Number.isInteger(data.id) || data.id < 0) {
    return err("module rpc: bad request id");
  }
  if (typeof data.method !== "string") return err("module rpc: bad method");
  if (!(MODULE_METHODS as readonly string[]).includes(data.method)) {
    return err(`module rpc: unknown method ${data.method}`);
  }
  if (data.args !== undefined && !isJson(data.args)) {
    return err("module rpc: args must be JSON-safe");
  }
  return okVal({
    vttModuleRpc: MODULE_RPC_TAG,
    kind: "request",
    id: data.id,
    method: data.method,
    args: (data.args ?? null) as Json | undefined,
  });
}

function isJson(v: unknown): boolean {
  const text = JSON.stringify(v);
  if (text === undefined) return false;
  return text.length <= MODULE_MAX_REQUEST_BYTES;
}

export type ModuleHandlers = Record<
  ModuleMethod,
  (args: Record<string, unknown>) => Promise<Json> | Json
>;

/** Pure request dispatcher — unit-testable without any iframe. */
export function createModuleDispatcher(handlers: ModuleHandlers): {
  onFrame(data: unknown, post: (frame: ModuleFrameToModule) => void): void;
} {
  return {
    onFrame(data, post) {
      const frame = parseModuleFrame(data);
      if (!frame.ok) {
        // Malformed frames have no id to answer — drop them (host logs).
        return;
      }
      const req = frame.value;
      void (async () => {
        let response: ModuleRpcResponse;
        try {
          const args = (req.args ?? {}) as Record<string, unknown>;
          const result = await handlers[req.method as ModuleMethod](args);
          response = {
            vttModuleRpc: MODULE_RPC_TAG,
            kind: "response",
            id: req.id,
            ok: true,
            result,
          };
        } catch (e) {
          response = {
            vttModuleRpc: MODULE_RPC_TAG,
            kind: "response",
            id: req.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
        post(response);
      })();
    },
  };
}
