/**
 * MCP connector §6 — the bridge's protocol half: JSON-RPC 2.0 with the MCP method set, speaking to
 * the sidecar over whatever `BridgeTransport` it is handed.
 *
 * It lives in `core` on purpose. The transport is the only thing that differs between the two places
 * this runs — the GM's tab (a WebSocket the tab dials *out* on, §2 A) and the integration test (a
 * real loopback socket against a host booted in Node) — and keeping the protocol here means the
 * method table, the error codes and the refusal semantics are unit-testable without a browser, and
 * identical in both.
 *
 * Two decisions worth naming:
 *
 * - **Notifications are answered with silence.** A JSON-RPC notification has no id; replying to one
 *   is the classic way to make an MCP client log a response it cannot correlate.
 * - **Malformed is not refused.** A bad tool *name* is `-32602` (the call is broken); a tool the
 *   grant does not cover is a normal result with `isError: true`, because "you may not delete" is
 *   information and "error -32602" is not.
 *
 * The sidecar (`tools/mcp/server.mjs`) answers `initialize` itself and proxies everything else here,
 * so this is the one place a tool is ever answered: **one registry, one gate.**
 */
import type { Json } from "../documents";
import type { AgentGrant } from "./capabilities";
import { callTool, toolManifest, type AgentWorldView } from "./tools";

export interface BridgeTransport {
  /** One JSON-RPC message per call. Framing is the transport's business (a WS text frame, a line). */
  send(text: string): void;
  /** Replaces any previous handler — a reconnecting socket sets this up again. */
  onMessage(handler: (text: string) => void): void;
  close(): void;
}

/** JSON-RPC 2.0 error codes (§5 of the spec) plus the two MCP servers are expected to use. */
export const JSON_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** The MCP revision this bridge speaks. Bumped in one place, advertised to every client. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AgentBridgeOptions {
  transport: BridgeTransport;
  view: AgentWorldView;
  grant: AgentGrant;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
}

export interface AgentBridge {
  dispose(): void;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: Json;
}

const isNotification = (req: JsonRpcRequest): boolean =>
  !("id" in req) ||
  req.id === undefined ||
  req.id === null ||
  (typeof req.method === "string" && req.method.startsWith("notifications/"));

const envelope = (
  id: JsonRpcId,
  payload: { result?: unknown; error?: JsonRpcError },
) => {
  const base: {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result?: unknown;
    error?: JsonRpcError;
  } = {
    jsonrpc: "2.0",
    id: id ?? null,
  };
  return payload.error
    ? { ...base, error: payload.error }
    : { ...base, result: payload.result ?? null };
};

/**
 * Wire the bridge to a transport. Returns a handle whose `dispose()` unsubscribes and closes — a
 * revoked agent must stop answering, and a leaked handler is a socket that keeps answering after
 * the GM pulled the grant.
 */
export function createAgentBridge(options: AgentBridgeOptions): AgentBridge {
  const { transport, view, grant } = options;
  const serverInfo = options.serverInfo ?? {
    name: "arenastar-vtt",
    version: "0.1.0",
  };
  const protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;

  const sendError = (id: JsonRpcId, code: number, message: string): void => {
    transport.send(JSON.stringify(envelope(id, { error: { code, message } })));
  };

  async function dispatch(req: JsonRpcRequest): Promise<void> {
    const id = req.id ?? null;
    const method = typeof req.method === "string" ? req.method : "";
    const params = (req.params ?? {}) as Record<string, Json>;

    switch (method) {
      case "initialize":
        transport.send(
          JSON.stringify(
            envelope(id, {
              result: {
                protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo,
              },
            }),
          ),
        );
        return;
      case "ping":
        transport.send(JSON.stringify(envelope(id, { result: {} })));
        return;
      case "tools/list":
        transport.send(
          JSON.stringify(envelope(id, { result: { tools: toolManifest() } })),
        );
        return;
      case "tools/call":
      case "resources/read":
      case "prompts/get": {
        if (method === "tools/call") {
          const called = await callTool(
            { name: params["name"], args: params["arguments"] },
            { view, grant },
          );
          if (called.kind === "invalid") {
            sendError(id, JSON_RPC_ERROR.invalidParams, called.error);
            return;
          }
          transport.send(
            JSON.stringify(envelope(id, { result: called.result })),
          );
          return;
        }
        // Phase 1/6 fill these in (§5.7). Answering "not yet" beats answering nothing: the client
        // knows the primitive exists and that this world has nothing behind it.
        sendError(
          id,
          JSON_RPC_ERROR.methodNotFound,
          `${method} is not implemented yet — this connector exposes tools only (plan Phase 1 and 6)`,
        );
        return;
      }
      case "resources/list":
        transport.send(
          JSON.stringify(envelope(id, { result: { resources: [] } })),
        );
        return;
      case "resources/templates/list":
        transport.send(
          JSON.stringify(envelope(id, { result: { resourceTemplates: [] } })),
        );
        return;
      case "prompts/list":
        transport.send(
          JSON.stringify(envelope(id, { result: { prompts: [] } })),
        );
        return;
      default:
        if (isNotification(req)) return;
        sendError(id, JSON_RPC_ERROR.methodNotFound, `no method "${method}"`);
        return;
    }
  }

  const handle = (text: string): void => {
    // One message per call is the contract; a frame that carries several (a pasted batch, a
    // concatenated write) is split rather than answered with a parse error.
    const chunks = text.includes("\n")
      ? text.split("\n").filter((l) => l.trim() !== "")
      : [text];
    for (const chunk of chunks) {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(chunk) as JsonRpcRequest;
      } catch {
        sendError(null, JSON_RPC_ERROR.parseError, "invalid JSON");
        continue;
      }
      if (!req || typeof req !== "object" || Array.isArray(req)) {
        sendError(
          null,
          JSON_RPC_ERROR.invalidRequest,
          "request must be an object",
        );
        continue;
      }
      if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
        sendError(
          req.id ?? null,
          JSON_RPC_ERROR.invalidRequest,
          "expected jsonrpc 2.0 with a method",
        );
        continue;
      }
      if (isNotification(req)) {
        // Nothing to answer and nothing to do for the ones MCP defines; the id-less form is the
        // only thing that matters here, and swallowing it keeps the client's log clean.
        continue;
      }
      void dispatch(req).catch((error: unknown) => {
        sendError(
          req.id ?? null,
          JSON_RPC_ERROR.internalError,
          error instanceof Error ? error.message : String(error),
        );
      });
    }
  };

  transport.onMessage(handle);
  return {
    dispose(): void {
      transport.onMessage(() => undefined);
      transport.close();
    },
  };
}
