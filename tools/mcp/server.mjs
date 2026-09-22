#!/usr/bin/env node
/**
 * MCP connector §2 A — `vtt-mcp`, the sidecar an MCP-speaking client launches over stdio.
 *
 * The shape, because it is easy to get backwards:
 *
 * ```
 *   LLM client ──stdio (JSON-RPC)──▶ this process ──ws://127.0.0.1:<port>──▶ the GM's tab
 * ```
 *
 * The tab **dials out**; nothing listens for inbound connections except this sidecar, on loopback,
 * and only for the one tab that presents the pairing token. The browser never opens a port, which is
 * what lets this work from `file://`, behind a router, and in a browser sandbox.
 *
 * Everything the *tools* know lives in the app (`src/core/agents`), not here: this process answers
 * `initialize` and `ping` so a client can handshake before a tab exists, and proxies everything else
 * to the bridge and back by request id. **One registry, one gate** — a sidecar that kept its own
 * copy of the tool table would be a second place to forget to enforce a grant.
 *
 * stdout is the protocol channel and nothing else: every log line goes to stderr, because one
 * `console.log` here is a corrupt JSON-RPC stream (and a support ticket nobody can diagnose).
 *
 * Usage: node tools/mcp/server.mjs [--port 8787] [--host 127.0.0.1] [--token <t>] [--timeout 30000]
 *   --port     TCP port to listen on (default 8787, env VTT_MCP_PORT; 0 = pick a free port)
 *   --host     bind address (default 127.0.0.1; the e2e harness passes 0.0.0.0 because the
 *              sandbox serves its preview from outside the container — the *product* default is
 *              loopback, and the tool says so when it is overridden)
 *   --token    pairing token (default: generated, printed to stderr)
 *   --timeout  ms to wait for the tab before answering -32603 (default 30000)
 *
 * Note: `ws` is a devDependency, because this is a tool run from a clone (`pnpm mcp`), not part of
 * the app bundle — `pnpm size` never sees it.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { WebSocketServer } from "ws";

const DEFAULTS = { port: 8787, host: "127.0.0.1", timeout: 30_000 };

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "arenastar-vtt-bridge", version: "0.1.0" };

const JSON_RPC = { methodNotFound: -32601, internalError: -32603 };

/** The methods this process answers without a tab. `initialize` must be one of them: an MCP client
 *  handshakes the moment it spawns us, which is usually before the GM has clicked anything. */
const LOCAL_METHODS = new Set(["initialize", "ping"]);

function parseArgs(argv) {
  const out = { ...DEFAULTS, token: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--help" || key === "-h") {
      out.help = true;
    } else if (key === "--port" && next !== undefined) {
      out.port = Number(next);
      i += 1;
    } else if (key === "--host" && next !== undefined) {
      out.host = next;
      i += 1;
    } else if (key === "--token" && next !== undefined) {
      out.token = next;
      i += 1;
    } else if (key === "--timeout" && next !== undefined) {
      out.timeout = Number(next);
      i += 1;
    } else {
      out.unknown = key;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (process.env.VTT_MCP_PORT) args.port = Number(process.env.VTT_MCP_PORT);

const log = (line) => process.stderr.write(`${line}\n`);

if (args.help) {
  log(
    "vtt-mcp — the ArenaStar VTT MCP sidecar. See the header of tools/mcp/server.mjs.",
  );
  process.exit(0);
}
if (args.unknown) {
  log(`vtt-mcp: unknown argument "${args.unknown}" (try --help)`);
  process.exit(2);
}
// 0 is allowed and means "let the OS pick a free port" — the integration test asks for that, and
// the banner then reports the port that was actually bound.
if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
  log(`vtt-mcp: --port must be a TCP port number (got "${args.port}")`);
  process.exit(2);
}

const token = args.token ?? randomBytes(24).toString("base64url");

/** One tab at a time: a world has one GM, and a second socket claiming to be it is a mistake (or a
 *  second browser the GM forgot about) — refuse it rather than silently stealing the session. */
let tab = null;
const pending = new Map();

const http = createServer((_req, res) => {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("vtt-mcp: this port speaks WebSocket only (/?token=…)");
});

const wss = new WebSocketServer({ noServer: true });

http.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "127.0.0.1"}`,
  );
  if (url.searchParams.get("token") !== token) {
    log("vtt-mcp: refused a connection with the wrong pairing token");
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  if (tab !== null) {
    log("vtt-mcp: refused a second tab — one GM tab per sidecar");
    socket.write(
      "HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  tab = ws;
  log("vtt-mcp: the VTT tab paired. Tools are live.");
  ws.on("message", (data) => {
    // Answers to our forwarded requests carry the id we are waiting on; anything else is a
    // notification (or a server→client request, which MCP allows) and goes straight to the client.
    const text = data.toString();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log("vtt-mcp: dropped a non-JSON frame from the tab");
      return;
    }
    const key = msg && "id" in msg ? String(msg.id) : null;
    const waiting = key === null ? null : pending.get(key);
    if (waiting) {
      pending.delete(key);
      clearTimeout(waiting.timer);
      write(msg);
      return;
    }
    write(msg);
  });
  const drop = (why) => {
    if (tab !== ws) return;
    tab = null;
    log(
      `vtt-mcp: the VTT tab went away (${why}). Tools are offline until it pairs again.`,
    );
    for (const [key, waiting] of pending) {
      clearTimeout(waiting.timer);
      pending.delete(key);
      write({
        jsonrpc: "2.0",
        id: waiting.id,
        error: {
          code: JSON_RPC.internalError,
          message: `the VTT tab disconnected: ${why}`,
        },
      });
    }
  };
  ws.on("close", () => drop("closed"));
  ws.on("error", (error) =>
    drop(error instanceof Error ? error.message : "socket error"),
  );
});

const write = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

function answerLocally(msg) {
  if (msg.method === "ping")
    return { jsonrpc: "2.0", id: msg.id ?? null, result: {} };
  return {
    jsonrpc: "2.0",
    id: msg.id ?? null,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      // All three primitives the bridge behind us serves (D-287): a client that trusts the
      // handshake would never ask for resources or prompts if we advertised tools alone.
      // `subscribe` stays false — resources are re-read on demand, and a promise to push
      // notifications is not one this sidecar keeps.
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
    },
  };
}

function refuse(id, code, message) {
  write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function handle(line) {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    refuse(null, -32700, "invalid JSON");
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    refuse(msg?.id ?? null, -32600, "request must be an object");
    return;
  }
  const isNotification =
    !("id" in msg) || msg.id === undefined || msg.id === null;
  if (isNotification) return; // nothing to answer, and nothing of ours to do with it

  if (typeof msg.method === "string" && LOCAL_METHODS.has(msg.method)) {
    write(answerLocally(msg));
    return;
  }
  if (tab === null) {
    refuse(
      msg.id,
      JSON_RPC.internalError,
      "no VTT tab is connected — open Settings ▸ Agents in the running app and click Connect (the sidecar printed the pairing token when it started)",
    );
    return;
  }
  const key = String(msg.id);
  const timer = setTimeout(() => {
    pending.delete(key);
    refuse(
      msg.id,
      JSON_RPC.internalError,
      `the VTT tab did not answer within ${args.timeout} ms`,
    );
  }, args.timeout);
  pending.set(key, { id: msg.id, timer });
  tab.send(trimmed);
}

http.listen(args.port, args.host, () => {
  // `--port 0` asks the OS for a free port; the tests use it, so the banner has to report the port
  // that was actually bound rather than the one that was asked for.
  const address = http.address();
  const bound =
    address && typeof address === "object" ? address.port : args.port;
  log(`vtt-mcp: listening on ws://${args.host}:${bound}`);
  log(`vtt-mcp: pairing token ${token}`);
  log(
    args.host === "127.0.0.1"
      ? "vtt-mcp: bound to loopback — only this machine can pair."
      : `vtt-mcp: WARNING bound to ${args.host}, not loopback — anything that can reach this port can pair.`,
  );
  if (args.token === null)
    log("vtt-mcp: (token generated for this run; pass --token to pin it)");
  log("vtt-mcp: waiting for the VTT tab…");
});

http.on("error", (error) => {
  log(
    `vtt-mcp: cannot listen — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

const stdin = createInterface({ input: process.stdin });
stdin.on("line", handle);

const shutdown = () => {
  for (const [, waiting] of pending) clearTimeout(waiting.timer);
  pending.clear();
  tab?.close();
  http.close(() => process.exit(0));
  // A client that closes stdin without waiting: do not hang on open sockets.
  setTimeout(() => process.exit(0), 250).unref();
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
