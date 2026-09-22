// MCP connector §2 A + §8 Phase 0 — the whole path, end to end:
//
//   MCP client (this test) ──stdio──▶ vtt-mcp sidecar ──ws://127.0.0.1──▶ bridge ──▶ host replica
//
// A host booted in Node on the in-memory wire (`tests/host/sync.test.ts` is the precedent), the real
// sidecar as a child process, the real WebSocket transport, and the real bridge: the only thing
// mocked here is the browser, which is the point of putting the protocol in `core`.
//
// It is an integration test on purpose. Unit tests can prove `tools/list` returns two names; only
// this one can prove a *client* that speaks JSON-RPC over a pipe gets an answer that came out of a
// document store, and that a tool the grant does not cover is refused rather than silently served.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { createEventBus } from "../../src/core/events";
import {
  DocumentStore,
  OpLog,
  UndoStack,
  type StoreMeta,
} from "../../src/core";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import type { SceneDocument, UserDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { agentWorldView } from "../../src/app/agentBridge";
import {
  createAgentBridge,
  type AgentBridge,
} from "../../src/core/agents/bridge";
import { grantFor, narrow } from "../../src/core/agents/capabilities";
import { createAgentLink } from "../../src/net/agentLink";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const SIDECAR = join(REPO, "tools", "mcp", "server.mjs");

const meta: StoreMeta = {
  worldId: "w1",
  name: "World One",
  system: "pf1e-core",
  systemVersion: "1.0.0",
};
const GM_ID = "gm-key";

function userDoc(
  id: string,
  name: string,
  role: "GM" | "PLAYER" = "PLAYER",
): UserDocument {
  return {
    _id: id,
    type: "user",
    name,
    role,
    ownership: { default: 0 },
    flags: {},
    system: {},
    character: null,
    color: "#88c0d0",
  };
}

function sceneDoc(id: string): SceneDocument {
  return {
    _id: id,
    type: "scene",
    name: `Scene ${id}`,
    ownership: { default: 2 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 1000,
    darkness: 0,
    grid: {
      type: "square",
      size: 100,
      distance: 5,
      units: "ft",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  };
}

/** A minimal MCP client over the sidecar's stdio: newline-delimited JSON-RPC, correlated by id. */
class McpClient {
  private buffer = "";
  private readonly waiters = new Map<
    number,
    (msg: Record<string, unknown>) => void
  >();
  private nextId = 1;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let cut = this.buffer.indexOf("\n");
      while (cut >= 0) {
        const line = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut + 1);
        cut = this.buffer.indexOf("\n");
        if (line === "") continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = typeof msg["id"] === "number" ? msg["id"] : null;
        if (id !== null) {
          const waiter = this.waiters.get(id);
          if (waiter) {
            this.waiters.delete(id);
            waiter(msg);
          }
        }
      }
    });
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params) message["params"] = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timed out waiting for the answer to ${method}`));
      }, timeoutMs);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
}

interface Started {
  child: ChildProcessWithoutNullStreams;
  client: McpClient;
  url: string;
  token: string;
  port: number;
}

/** Start the sidecar on an OS-assigned port and read the URL and token off its stderr banner. */
function startSidecar(): Promise<Started> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [SIDECAR, "--port", "0", "--host", "127.0.0.1"],
      {
        cwd: REPO,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.unref();
    let stderr = "";
    const timer = setTimeout(() => {
      rejectPromise(
        new Error(`the sidecar never announced a port.\n${stderr}`),
      );
    }, 20_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      const url = /listening on ws:\/\/([\d.]+):(\d+)/.exec(stderr);
      const token = /pairing token (\S+)/.exec(stderr);
      if (!url || !token) return;
      clearTimeout(timer);
      resolvePromise({
        child,
        client: new McpClient(child),
        url: `ws://${url[1]}:${url[2]}`,
        token: token[1] ?? "",
        port: Number(url[2]),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

describe("vtt-mcp ↔ agent bridge (MCP plan §8 Phase 0)", () => {
  let started: Started;
  let bridge: AgentBridge | null = null;
  let gm: ClientSync;

  beforeAll(async () => {
    // ── a host in Node, with a world that has something in it ──
    const store = new DocumentStore({ meta });
    const log = new OpLog();
    const undo = new UndoStack();
    const bus = createEventBus<HostEvents>();
    const host = new HostSync({
      store,
      log,
      undo,
      bus,
      systemUserId: GM_ID,
      roomId: "room-mcp",
      verifyHelloSig: async (hello) => hello.sig === "valid",
    });
    const seed = (seq: number, ops: Op[]): void => {
      const applied = store.applyEnvelope({
        seq,
        ts: 0,
        by: GM_ID,
        ops,
        txId: `seed-${seq}`,
      });
      if (!applied.ok) throw new Error(applied.error);
      const appended = log.append(
        { seq, ts: 0, by: GM_ID, ops, txId: `seed-${seq}` },
        applied.value.inverses,
      );
      if (!appended.ok) throw new Error(appended.error);
    };
    seed(1, [
      { kind: "create", coll: "users", data: userDoc(GM_ID, "GM", "GM") },
      { kind: "create", coll: "scenes", data: sceneDoc("s1") },
      {
        kind: "create",
        coll: "scenes",
        data: { ...sceneDoc("s2"), active: false },
      },
    ]);

    const pair = createTransportPair();
    host.addSession("gm", pair.a, gmSessionUser(GM_ID));
    gm = new ClientSync({
      transport: pair.b,
      bus: createEventBus<ClientEvents>(),
      meta,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    started = await startSidecar();
  }, 60_000);

  afterAll(async () => {
    bridge?.dispose();
    bridge = null;
    if (started) {
      started.child.stdin.end();
      started.child.kill("SIGTERM");
    }
    await new Promise((done) => setTimeout(done, 50));
  });

  /** Dial the sidecar from the "tab" side and hand the socket to the bridge. */
  async function connect(grant = grantFor("gm")): Promise<void> {
    const opened = new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("the tab never paired")),
        15_000,
      );
      const transport = createAgentLink({
        url: `${started.url}/bridge?token=${encodeURIComponent(started.token)}`,
        onStatus: (status) => {
          if (status.state === "open") {
            clearTimeout(timer);
            resolvePromise();
          } else if (status.state === "closed") {
            clearTimeout(timer);
            rejectPromise(
              new Error(`the link closed: ${status.reason ?? "no reason"}`),
            );
          }
        },
      });
      bridge = createAgentBridge({
        transport,
        view: agentWorldView(gm),
        grant,
      });
    });
    await opened;
    // The sidecar logs the pairing on its side; give it a tick to install its message handler.
    await new Promise((done) => setTimeout(done, 50));
  }

  test("initialize, and it answers before any tab has paired", async () => {
    const reply = await started.client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    expect(reply["error"]).toBeUndefined();
    const result = reply["result"] as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo.name).toBe("arenastar-vtt-bridge");
  });

  test("a tool call with no tab connected says what is missing instead of hanging", async () => {
    const reply = await started.client.request("tools/list");
    const error = reply["error"] as
      { code: number; message: string } | undefined;
    expect(error?.code).toBe(-32603);
    expect(error?.message).toContain("no VTT tab is connected");
  });

  test("tools/list returns the catalogue once the tab pairs", async () => {
    await connect();
    const reply = await started.client.request("tools/list");
    expect(reply["error"]).toBeUndefined();
    const tools = (
      reply["result"] as {
        tools: Array<{ name: string; inputSchema: unknown }>;
      }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "whoami",
      "world.info",
      "world.snapshot",
      "scene.list",
      "scene.read",
      "scene.describe",
      "map.render",
      "document.list",
      "document.read",
      "token.list",
      "chat.read",
      "sheet.read",
      "bestiary.search",
    ]);
    for (const tool of tools)
      expect(tool.inputSchema).toMatchObject({ type: "object" });
  }, 30_000);

  test("tools/call world.info reads the world out of the host's replica", async () => {
    const reply = await started.client.request("tools/call", {
      name: "world.info",
      arguments: {},
    });
    expect(reply["error"]).toBeUndefined();
    const result = reply["result"] as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('World "World One"');
    // The counts come from the store the host seeded — not from a fixture inside the bridge.
    expect(result.structuredContent).toMatchObject({
      id: "w1",
      name: "World One",
      system: "pf1e-core",
      version: "1.0.0",
    });
    const collections = result.structuredContent["collections"] as Record<
      string,
      number
    >;
    expect(collections["scenes"]).toBe(2);
    expect(collections["users"]).toBe(1);
    expect(collections["depots"]).toBeUndefined(); // empty collections are noise, not information
  }, 30_000);

  test("the read surface answers from the host's replica, not from a fixture", async () => {
    const scenes = await started.client.request("tools/call", {
      name: "scene.list",
    });
    const sceneText =
      (
        scenes["result"] as {
          content: Array<{ text: string }>;
          isError?: boolean;
        }
      ).content[0]?.text ?? "";
    // Both seeded scenes, with the active one marked: an agent that cannot tell which scene the
    // table is on will describe the wrong room.
    expect(sceneText).toContain("* Scene s1");
    expect(sceneText).toContain("  Scene s2");

    const map = await started.client.request("tools/call", {
      name: "map.render",
      arguments: {},
    });
    const mapText =
      (map["result"] as { content: Array<{ text: string }> }).content[0]
        ?.text ?? "";
    // 1000 px at 100 px per cell, 5 ft per cell — the numbers came out of the host's scene doc.
    expect(mapText).toContain("map 10×10 cells (square, 1 cell = 5 ft)");
  }, 30_000);

  test("a tool name that is not in the catalogue is a protocol error, not a refusal", async () => {
    const reply = await started.client.request("tools/call", {
      name: "scene.delete",
    });
    const error = reply["error"] as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("no tool named");
  }, 30_000);

  test("a tool the grant does not cover comes back as a tool error in plain words", async () => {
    // Same socket, narrower grant: the GM unticks world.read and the very next call is refused.
    bridge?.dispose();
    bridge = null;
    await new Promise((done) => setTimeout(done, 50));
    await connect(narrow(grantFor("observer"), ["chat.read"]));

    const refused = await started.client.request("tools/call", {
      name: "world.info",
    });
    const result = refused["result"] as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "this agent may not read the world — ask the GM to change its grant",
    );

    // …and the identity probe still answers, so a refused agent can find out why.
    const who = await started.client.request("tools/call", { name: "whoami" });
    const body =
      (who["result"] as { content: Array<{ text: string }> }).content[0]
        ?.text ?? "";
    // The session is the GM's (Phase 0 hosts the bridge in the GM's tab) but the grant is the
    // ceiling, and whoami has to say which is which.
    expect(body).toContain('Grant: preset "observer", role PLAYER');
    expect(body).toContain("narrower than the session");
    expect(body).toContain("Capabilities (1): chat.read.");
  }, 30_000);

  test("resources are the tool's answer wearing a URI (§5.7)", async () => {
    // Back to the full grant: the previous test deliberately narrowed it.
    bridge?.dispose();
    bridge = null;
    await new Promise((done) => setTimeout(done, 50));
    await connect(grantFor("gm"));

    const list = await started.client.request("resources/list");
    const uris = (
      list["result"] as { resources: Array<{ uri: string }> }
    ).resources.map((r) => r.uri);
    expect(uris).toContain("vtt://world/w1/overview");
    expect(uris).toContain("vtt://world/w1/tokens");
    expect(uris).toContain("vtt://world/w1/scene/s1/map.txt");

    const templates = await started.client.request("resources/templates/list");
    expect(
      (
        templates["result"] as {
          resourceTemplates: Array<{ uriTemplate: string }>;
        }
      ).resourceTemplates.map((t) => t.uriTemplate),
    ).toContain("vtt://world/{worldId}/scene/{sceneId}/map.txt");

    const read = await started.client.request("resources/read", {
      uri: "vtt://world/w1/scene/s1/map.txt",
    });
    const contents = (read["result"] as { contents: Array<{ text: string }> })
      .contents;
    expect(contents[0]?.text).toContain("map 10×10 cells");

    // A guessed URI is answered with the grammar, and Phase 5's work says so rather than 404-ing.
    const guessed = await started.client.request("resources/read", {
      uri: "vtt://world/w1/hexmap",
    });
    const error = guessed["error"] as { code: number; message: string };
    expect(error.code).toBe(-32601);
    expect(error.message).toContain("Phase 5");
  }, 30_000);

  test("prompts/list is honest: there are none yet (§5.7, Phase 6)", async () => {
    const prompts = await started.client.request("prompts/list");
    expect(prompts["result"]).toEqual({ prompts: [] });
  }, 30_000);

  test("an unknown method is -32601, and a notification gets no answer at all", async () => {
    const reply = await started.client.request("does/not/exist");
    expect((reply["error"] as { code: number }).code).toBe(-32601);
    // A notification has no id, so nothing can be correlated: the proof is that the next request
    // still gets its own answer rather than the notification's.
    started.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const after = await started.client.request("ping");
    expect(after["id"]).toBeDefined();
    expect(after["result"]).toEqual({});
  }, 30_000);
});
