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
import { RESOURCE_TEMPLATES, readResource, resourceList } from "./resources";
import { callTool, toolManifest } from "./tools";
import { promptGet, promptList } from "./prompts";
import type { AgentWorldView, AgentWriter } from "./types";

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
  /**
   * The write port (§6.2). **Absent means read-only**, and every write tool says so in those
   * words rather than pretending the verb is broken.
   */
  writer?: AgentWriter | undefined;
  /** The user id the writes will be attributed to — what `whoami` reports as the agent's own. */
  agentId?: string | null | undefined;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
}

/**
 * §6.4 — one line per call, for the GM's eyes. The plan asks for the txId; this records the **seq**
 * as well, because the seq is what the OpLog and the undo stack are keyed by, and the GM's question
 * after an agent does something odd is "which line of the log was that", not "which socket write".
 */
export interface AgentAuditEntry {
  at: number;
  method: string;
  /** The tool, when the call was `tools/call`. */
  tool: string | null;
  /** One line of arguments — enough to recognise the call, never enough to be a data leak. */
  args: string;
  ms: number;
  outcome: "answered" | "refused" | "invalid" | "error";
  /** The first line of the answer, trimmed: what the model was told. */
  detail: string;
  seq: number | null;
}

export interface AgentBridge {
  dispose(): void;
  /** The last `AUDIT_RING_SIZE` calls, oldest first. In-memory: a ring, not another document. */
  audit(): readonly AgentAuditEntry[];
}

/** §6.4: the Agents window shows the last 200. */
export const AUDIT_RING_SIZE = 200;

const oneLine = (value: unknown, max = 160): string => {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

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
  const { transport, view, grant, writer, agentId } = options;
  const ring: AgentAuditEntry[] = [];
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
    const startedAt = Date.now();
    // The audit is written on the way out, whatever the way out is — including the ones that throw,
    // which is why the handle() wrapper records it rather than each case.
    let audit: Omit<AgentAuditEntry, "ms"> | null = null;
    const finish = (): void => {
      if (audit === null) return;
      const entry: AgentAuditEntry = { ...audit, ms: Date.now() - startedAt };
      ring.push(entry);
      if (ring.length > AUDIT_RING_SIZE) ring.shift();
      audit = null;
    };

    switch (method) {
      case "initialize":
        transport.send(
          JSON.stringify(
            envelope(id, {
              result: {
                protocolVersion,
                // All three primitives this bridge actually serves. Advertising only `tools`
                // while answering `resources/*` and `prompts/*` would leave a client that trusts
                // the handshake never asking for two thirds of the surface. `subscribe` is not
                // advertised: resources are re-read on demand, and a promise to push updates is
                // not one this bridge keeps.
                capabilities: {
                  tools: { listChanged: false },
                  resources: { listChanged: false, subscribe: false },
                  prompts: { listChanged: false },
                },
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
      case "tools/call": {
        const name = params["name"];
        const toolArgs = params["arguments"];
        audit = {
          at: startedAt,
          method: "tools/call",
          tool: typeof name === "string" ? name : null,
          args: oneLine(toolArgs),
          outcome: "answered",
          detail: "",
          seq: null,
        };
        const called = await callTool(
          { name, args: toolArgs },
          {
            view,
            grant,
            ...(writer ? { writer } : {}),
            agentId: agentId ?? null,
          },
        );
        if (called.kind === "invalid") {
          audit.outcome = "invalid";
          audit.detail = called.error;
          finish();
          sendError(id, JSON_RPC_ERROR.invalidParams, called.error);
          return;
        }
        const structured = called.result.structuredContent as
          Record<string, unknown> | undefined;
        audit.outcome = called.result.isError === true ? "refused" : "answered";
        audit.detail = oneLine(called.result.content[0]?.text ?? "", 200);
        audit.seq =
          typeof structured?.["seq"] === "number" ? structured["seq"] : null;
        finish();
        transport.send(JSON.stringify(envelope(id, { result: called.result })));
        return;
      }
      case "resources/read": {
        const uri = params["uri"];
        if (typeof uri !== "string" || uri === "") {
          sendError(
            id,
            JSON_RPC_ERROR.invalidParams,
            "resources/read needs a uri",
          );
          return;
        }
        // §5.7: a resource is the same answer as the tool behind it, wearing a URI — so the grant
        // that refuses the tool refuses the resource, and there is one place to get it wrong.
        audit = {
          at: startedAt,
          method: "resources/read",
          tool: null,
          args: uri,
          outcome: "answered",
          detail: "",
          seq: null,
        };
        const read = await readResource(view, grant, uri);
        if (!read.ok) {
          audit.outcome = "refused";
          audit.detail = read.message;
          finish();
          sendError(
            id,
            read.code === "not_implemented"
              ? JSON_RPC_ERROR.methodNotFound
              : JSON_RPC_ERROR.invalidParams,
            read.message,
          );
          return;
        }
        transport.send(
          JSON.stringify(
            envelope(id, { result: { contents: [read.resource] } }),
          ),
        );
        return;
      }
      case "resources/list":
        transport.send(
          JSON.stringify(
            envelope(id, { result: { resources: resourceList(view) } }),
          ),
        );
        return;
      case "resources/templates/list":
        // The open-ended resources (a sheet per actor, a map per scene) are advertised as templates
        // rather than enumerated: 5,000 actor URIs is a resource list no client can read.
        transport.send(
          JSON.stringify(
            envelope(id, {
              result: { resourceTemplates: [...RESOURCE_TEMPLATES] },
            }),
          ),
        );
        return;
      case "prompts/list":
        // §5.7: the recipes. Each one names the tools it reaches for, so a client can offer
        // "Run this encounter as the GM" as one action instead of hoping its model invents the
        // sequence. They are pure templates — they read no world, so they can leak none.
        transport.send(
          JSON.stringify(envelope(id, { result: { prompts: promptList() } })),
        );
        return;
      case "prompts/get": {
        const params = (req.params ?? {}) as Record<string, unknown>;
        const name = typeof params["name"] === "string" ? params["name"] : "";
        const raw = params["arguments"];
        const filled: Record<string, string> = {};
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            // MCP sends prompt arguments as strings; anything else is not a fill-in the template
            // can render, and dropping it is better than stringifying an object into a sentence.
            if (typeof value === "string") filled[key] = value;
          }
        }
        const prompt = promptGet(name, filled);
        if (!prompt) {
          sendError(
            id,
            JSON_RPC_ERROR.invalidParams,
            `no prompt "${name}" — prompts/list names the ${promptList().length} this world offers`,
          );
          return;
        }
        transport.send(JSON.stringify(envelope(id, { result: prompt })));
        return;
      }
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
        void error;
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
    audit(): readonly AgentAuditEntry[] {
      return [...ring];
    },
  };
}
