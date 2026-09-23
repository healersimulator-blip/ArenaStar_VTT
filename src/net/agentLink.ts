/**
 * MCP connector §2 A — the transport between the GM's tab and the sidecar: a WebSocket **the tab
 * dials out on**, so the browser never listens on a port. That is the whole reason the sidecar is a
 * separate process and not an HTTP server inside the app: this app opens outbound connections and
 * nothing else, and a connector that needed an inbound port would be a connector that cannot work
 * from `file://` or behind a router.
 *
 * It lives in `src/net` beside the other transports (`memory`, `webrtc`, the signalling clients)
 * because it is a transport and nothing more — the bridge core decides what the messages *mean*.
 * It uses the platform `WebSocket`, which exists in every browser this app targets and in Node 22,
 * so the integration test drives the same code against a real socket instead of a mock.
 */
import type { BridgeTransport } from "../core/agents/bridge";

export interface AgentLinkStatus {
  state: "connecting" | "open" | "closed";
  reason?: string;
}

export interface AgentLinkOptions {
  url: string;
  /** Optional: the Agents window (Phase 2) shows the link's state from this. */
  onStatus?: (status: AgentLinkStatus) => void;
}

const decoder = new TextDecoder();

function asText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return decoder.decode(data as Uint8Array);
  return null;
}

/**
 * A transport over one WebSocket. `send` throws when the socket is not open rather than dropping the
 * message: a bridge that silently discards a response leaves the MCP client waiting on an id it will
 * never see answered, and a thrown error comes back as a JSON-RPC internal error the model can read.
 */
export function createAgentLink(options: AgentLinkOptions): BridgeTransport {
  const { url, onStatus } = options;
  let handler: ((text: string) => void) | null = null;
  let socket: WebSocket | null = null;
  let closed = false;

  const tell = (state: AgentLinkStatus["state"], reason?: string): void => {
    if (!onStatus) return;
    onStatus(reason === undefined ? { state } : { state, reason });
  };

  tell("connecting");
  socket = new WebSocket(url);

  socket.onopen = () => tell("open");
  socket.onclose = (event: CloseEvent) => {
    closed = true;
    tell("closed", event.reason || `closed (${event.code})`);
  };
  socket.onerror = () => tell("closed", "socket error");
  socket.onmessage = (event: MessageEvent) => {
    const text = asText(event.data as unknown);
    if (text !== null) {
      handler?.(text);
      return;
    }
    // A binary or Blob frame: read it, then deliver. Text frames are what this bridge speaks, so
    // this path exists so a runtime that hands back a Blob cannot silently swallow a response.
    const data = event.data as Blob;
    if (typeof data?.text === "function") {
      void data.text().then((value) => handler?.(value));
    }
  };

  return {
    send(text: string): void {
      if (closed || socket === null || socket.readyState !== WebSocket.OPEN) {
        throw new Error(
          "the agent link is not open — the sidecar is not connected",
        );
      }
      socket.send(text);
    },
    onMessage(next: (text: string) => void): void {
      handler = next;
    },
    close(): void {
      closed = true;
      socket?.close();
      socket = null;
    },
  };
}
