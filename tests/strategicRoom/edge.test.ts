import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { PostgresRoom } from "../../services/strategic-room/src/postgres";
import {
  deploy,
  generatedScenario,
} from "../../services/strategic-room/src/scenario";
import { serve } from "../../services/strategic-room/src/server";
import {
  authPayload,
  STRATEGIC_PROTOCOL,
  STRATEGIC_VIEW_TYPE,
  type ServerMessage,
} from "../../src/core/strategicRoom/protocol";
import { signText, type Identity } from "../../src/net/identity";
import { readView } from "../../src/core/strategicRoom/viewWire";

/**
 * The real edge over real sockets. These assertions are the ones a browser cannot prove on its
 * own: the roster is redacted per role, a roster/control change reaches an already-joined socket
 * as a new head generation, and a kick closes that socket with the documented code.
 */

const url = process.env.STRATEGIC_TEST_DATABASE_URL;
const pin = "edge-test-v1";
const rooms: string[] = [];
const dbs: PostgresRoom[] = [];
const services: Array<{ close: () => Promise<void> }> = [];
const sockets: WebSocket[] = [];

async function availablePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function identity(): Promise<Identity> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    algorithm: "Ed25519",
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyHex: [...raw].map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

type Client = {
  slot: string;
  socket: WebSocket;
  bearer: string;
  heads: ServerMessage[];
  closed: Promise<{ code: number; reason: string }>;
};

async function listen() {
  const room = `edge-${randomUUID()}`;
  const scenario = generatedScenario(4, 5);
  const db = new PostgresRoom(url ?? "", room, pin);
  dbs.push(db);
  await db.migrate();
  const keys = {
    gm: await identity(),
    "commander-1": await identity(),
    "commander-2": await identity(),
  };
  await db.create(scenario, deploy(scenario), {
    gm: keys.gm.publicKeyHex,
    "commander-1": keys["commander-1"].publicKeyHex,
    "commander-2": keys["commander-2"].publicKeyHex,
  });
  rooms.push(room);
  // `serve` opens the single room authority itself; a second one would lose the lease.
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const service = await serve(db, new Set([origin]), port);
  services.push(service);
  return { room, db, keys, origin };
}

async function join(
  origin: string,
  key: Identity,
  slot: string,
): Promise<Client> {
  const socket = new WebSocket(
    `${origin.replace(/^http/, "ws")}/api/strategic/socket`,
    STRATEGIC_PROTOCOL,
    { origin },
  );
  sockets.push(socket);
  const heads: ServerMessage[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.on("close", (code, reason) =>
      resolve({ code, reason: String(reason) }),
    ),
  );
  const client: Client = { slot, socket, bearer: "", heads, closed };
  const welcome = new Promise<string>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as ServerMessage;
      if (message.kind === "challenge")
        void signText(
          key,
          authPayload(message.room, origin, message.nonce),
        ).then((signature) =>
          socket.send(
            JSON.stringify({
              kind: "auth",
              publicKey: key.publicKeyHex,
              signature,
            }),
          ),
        );
      else if (message.kind === "welcome") {
        client.bearer = message.bearer;
        resolve(message.bearer);
      } else if (message.kind === "head") heads.push(message);
      else if (message.kind === "error") reject(new Error(message.code));
    });
  });
  client.bearer = await welcome;
  await vi.waitFor(() => expect(heads.length).toBeGreaterThan(0));
  return client;
}

/** Send a command and resolve on its private receipt. */
async function submit(client: Client, command: object) {
  const requestId = randomUUID();
  const receipt = new Promise<ServerMessage>((resolve) => {
    client.socket.on("message", function once(payload) {
      const message = JSON.parse(payload.toString()) as ServerMessage;
      if (message.kind !== "receipt" || message.requestId !== requestId) return;
      client.socket.off("message", once);
      resolve(message);
    });
  });
  client.socket.send(JSON.stringify({ ...command, requestId }));
  return receipt;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(dbs.splice(0).map((db) => db.dispose()));
  if (url && rooms.length) {
    const cleaner = new PostgresRoom(url, "cleanup", pin);
    try {
      await cleaner.pool.query(
        "DELETE FROM strategic_rooms WHERE id=ANY($1::text[])",
        [rooms.splice(0)],
      );
    } finally {
      await cleaner.dispose();
    }
  }
});

const view = async (origin: string, bearer: string) => {
  const response = await fetch(`${origin}/api/strategic/view`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: STRATEGIC_VIEW_TYPE },
  });
  if (!response.ok) return { response, body: undefined };
  const body = await readView(response, undefined);
  return { response, body };
};

describe.skipIf(!url)("hosted room edge", () => {
  test("only the GM view carries the roster, and a control change reaches a live socket", async () => {
    const { origin, keys, db } = await listen();
    const gm = await join(origin, keys.gm, "gm");
    const player = await join(origin, keys["commander-1"], "commander-1");

    const gmView = await view(origin, gm.bearer);
    expect(gmView.response.status).toBe(200);
    const gmBody = gmView.body;
    if (!gmBody) throw new Error("GM view missing");
    expect(gmBody.role).toBe("GM");
    expect(gmBody.members?.map((m) => m.id)).toEqual([
      "commander-1",
      "commander-2",
      "commander-3",
      "commander-4",
    ]);
    // Every seat lists its whole deployment, whether or not it currently holds a grant.
    expect(
      gmBody.members?.find((m) => m.id === "commander-3")?.deployed,
    ).toEqual(["unit-3-1", "unit-3-2", "unit-3-3", "unit-3-4", "unit-3-5"]);
    expect(gmBody.members?.[0]?.deployed.length).toBe(5);

    const playerView = await view(origin, player.bearer);
    expect(playerView.response.status).toBe(200);
    expect(playerView.body?.members).toBeUndefined();

    // An unauthenticated caller never reaches the roster either.
    expect((await fetch(`${origin}/api/strategic/view`)).status).toBe(401);

    const before = player.heads.length;
    expect(
      await submit(gm, {
        kind: "member.update",
        memberId: "commander-1",
        units: ["unit-1-1"],
      }),
    ).toMatchObject({ status: "accepted" });

    // A control change must reach the affected commander as a new head generation, on the same
    // battlefield version — otherwise their `own` list would stay stale until the next turn.
    await vi.waitFor(() => expect(player.heads.length).toBeGreaterThan(before));
    const latest = player.heads.at(-1);
    if (latest?.kind !== "head") throw new Error("Expected a head message");
    expect(latest.head.members).toBeGreaterThan(0);
    const refreshed = (await view(origin, player.bearer)).body;
    if (!refreshed) throw new Error("Player view missing");
    expect(refreshed.own.map((u) => u.id)).toEqual(["unit-1-1"]);
    expect(refreshed.members).toBeUndefined();
    expect(
      (await db.roster()).find((m) => m.id === "commander-1")?.units,
    ).toEqual(["unit-1-1"]);
  });

  test("a claimed seat cannot be handed to another browser by an invite", async () => {
    const { origin, keys } = await listen();
    const gm = await join(origin, keys.gm, "gm");
    await join(origin, keys["commander-1"], "commander-1");
    // commander-1 is bound; re-issuing would be a takeover, so the GM's command is refused
    // even though the roster never renders an invite control for a claimed seat.
    expect(
      await submit(gm, {
        kind: "member.invite",
        memberId: "commander-1",
        invite: "z".repeat(32),
      }),
    ).toMatchObject({ status: "rejected", code: "forbidden" });
  });

  test("kick closes the holder's socket and the same key resumes the seat", async () => {
    const { origin, keys } = await listen();
    const gm = await join(origin, keys.gm, "gm");
    const player = await join(origin, keys["commander-1"], "commander-1");

    const kicked = player.closed;
    const requestId = randomUUID();
    const receipt = new Promise<ServerMessage>((resolve) => {
      gm.socket.on("message", function once(payload) {
        const message = JSON.parse(payload.toString()) as ServerMessage;
        if (message.kind !== "receipt" || message.requestId !== requestId)
          return;
        gm.socket.off("message", once);
        resolve(message);
      });
    });
    gm.socket.send(
      JSON.stringify({
        kind: "member.kick",
        requestId,
        memberId: "commander-1",
      }),
    );
    expect(await receipt).toMatchObject({ status: "accepted" });
    expect(await kicked).toEqual({ code: 4001, reason: "kicked" });
    // The bearer died with the socket.
    expect((await view(origin, player.bearer)).response.status).toBe(401);
    // Kick is not a ban: the bound key still claims the same seat.
    const again = await join(origin, keys["commander-1"], "commander-1");
    expect((await view(origin, again.bearer)).response.status).toBe(200);
  });

  test("scene media is same-origin and refuses unknown or malformed hashes", async () => {
    const { origin, keys } = await listen();
    await join(origin, keys.gm, "gm");
    const hash = "a".repeat(64);
    expect(
      (await fetch(`${origin}/api/strategic/scene/${hash}.webp`)).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${origin}/api/strategic/scene/${"0".repeat(64)}.webp`, {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${origin}/api/strategic/scene/not-a-hash.webp`)).status,
    ).toBe(404);
  });
});
