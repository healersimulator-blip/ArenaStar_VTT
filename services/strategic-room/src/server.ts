import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyText } from "../../../src/net/identity";
import {
  authPayload,
  integer,
  MAX_FRAME,
  MAX_REGION_MODELS,
  MAX_VIEW_BYTES,
  PAGE_ROWS,
  parseAuth,
  parseCommand,
  REGION_SIZE,
  reject,
  STRATEGIC_API,
  STRATEGIC_PROTOCOL,
  STRATEGIC_VIEW_TYPE,
  STRATEGIC_PATCH_TYPE,
  type BaselineMeta,
  type MemberRow,
  type ModelMarker,
  type RegionPatch,
  type ReportPage,
  type ServerMessage,
  type UnitMarker,
} from "../../../src/core/strategicRoom/protocol";
import { BulkReads } from "./bulkReads";
import { StrategicAuthority } from "./authority";
import { diffRegion } from "./battle";
import { PostgresRoom } from "./postgres";
import { MAX_COMMANDERS } from "./scenario";
import { publicHead, type Member } from "./state";
import { viewPrefix } from "./viewEncoding";

const SESSION_BYTES = 64 * 1024;
const ROOM_BYTES = 8 * 1024 * 1024;
const BULK_CONCURRENCY = 64;
const AUTH_CONCURRENCY = 64;
const MAX_SCENE_MEDIA = 24 * 1024 * 1024;
const MAX_SCENE_MEDIA_FILES = 64;
const SESSION_MS = 30 * 60_000;
const secret = () => randomBytes(32).toString("base64url");

type Session = {
  deliveredMarkersVersion?: number;
  socket: WebSocket;
  member: Member;
  bearer: string;
  epoch: string;
  seq: number;
  regionCursor: number;
  region: {
    tile: string;
    cursor: number;
    models: Map<string, ModelMarker>;
  } | null;
  regionBusy: boolean;
  pending: number;
  responses: Set<ServerResponse>;
  sent: number;
  allowance: number;
  refillAt: number;
  expires: number;
};

const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};
async function webAssets() {
  const base = new URL("../web/", import.meta.url);
  const files = new Map<string, { data: Buffer; type: string }>();
  files.set("/", {
    data: await readFile(new URL("index.html", base)),
    type: contentTypes.html ?? "text/html",
  });
  // A source checkout has no asset directory until the service web build runs; the API and
  // socket lanes must still start so a deployment failure is visible, not fatal.
  let built: string[];
  try {
    built = await readdir(new URL("assets/", base));
  } catch {
    built = [];
  }
  for (const file of built) {
    const type = contentTypes[file.split(".").at(-1) ?? ""];
    if (type && /^[a-zA-Z0-9_.-]+$/.test(file))
      files.set(`/assets/${file}`, {
        data: await readFile(new URL(`assets/${file}`, base)),
        type,
      });
  }
  return files;
}

function common(res: ServerResponse, socketOrigins: string) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${socketOrigins}; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://arena.ai https://*.arena.ai`,
  );
}
function reply(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed) return;
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_VIEW_BYTES) {
    reply(res, 503, { error: "view_too_large" });
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}
/** GM roster with live presence; players never reach this branch. */
async function roster(
  db: PostgresRoom,
  sessions: ReadonlyMap<string, Session>,
): Promise<MemberRow[]> {
  const rows = await db.roster();
  return rows
    .filter((row) => row.role === "PLAYER")
    .map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      factionId: row.factionId,
      units: row.units,
      deployed: row.deployed,
      claimed: row.claimed,
      invite: row.invite,
      online: sessions.has(row.id),
    }));
}

/** Optional preloaded battle art: `scene.webp` / `scene/<slot>.webp` beside the service web build. */
async function mediaAssets(): Promise<Buffer[]> {
  const dir = new URL("../web/scene/", import.meta.url);
  const out: Buffer[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!/^[a-zA-Z0-9_-]{1,32}\.webp$/.test(name)) continue;
    const data = await readFile(new URL(name, dir));
    if (data.byteLength > MAX_SCENE_MEDIA) continue;
    out.push(data);
    if (out.length >= MAX_SCENE_MEDIA_FILES) break;
  }
  return out;
}

const numeric = (value: string | null) =>
  value !== null && /^(0|[1-9][0-9]{0,9})$/.test(value) ? Number(value) : NaN;

/** Single-room HTTP/WSS edge. Bare HTTP is for loopback or a trusted same-origin TLS proxy. */
export async function serve(
  db: PostgresRoom,
  origins: ReadonlySet<string>,
  port: number | null,
) {
  const assets = await webAssets();
  const socketOrigins = [...origins]
    .map((origin) => origin.replace(/^http/, "ws"))
    .join(" ");
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME,
    handleProtocols: (protocols) =>
      protocols.has(STRATEGIC_PROTOCOL) ? STRATEGIC_PROTOCOL : false,
  });
  const sessions = new Map<string, Session>();
  /** Content-hashed image bytes, offered to any admitted session as a cache seed. */
  const media = (await mediaAssets()).map((data) => ({
    data,
    hash: createHash("sha256").update(data).digest("hex"),
  }));
  const mediaByHash = new Map(media.map((asset) => [asset.hash, asset]));
  const byBearer = new Map<string, Session>();
  const unauth = new Set<WebSocket>();
  const heartbeats = new WeakSet<WebSocket>();
  let totalBuffered = 0;
  let maxBuffered = 0;
  let dropped = 0;
  const bulk = new BulkReads<Session>(
    BULK_CONCURRENCY,
    MAX_COMMANDERS + 1,
    1500,
  );
  // Compatibility JSON also shares its serialized tail, but is not the browser default.
  const tails = new WeakMap<UnitMarker[], Buffer>();
  function replyView(
    req: IncomingMessage,
    res: ServerResponse,
    data: BaselineMeta,
    markers: UnitMarker[],
    packed: Buffer | undefined,
    changes: boolean,
  ) {
    res.setHeader("Vary", "Accept");
    res.setHeader("Cache-Control", "no-store, no-transform");
    if (
      req.headers.accept === STRATEGIC_VIEW_TYPE ||
      req.headers.accept === STRATEGIC_PATCH_TYPE
    ) {
      const prefix = viewPrefix(data, packed?.byteLength ?? 0);
      if (!prefix) {
        reply(res, 503, { error: "view_too_large" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": changes ? STRATEGIC_PATCH_TYPE : STRATEGIC_VIEW_TYPE,
        "Content-Length": prefix.byteLength + (packed?.byteLength ?? 0),
      });
      if (packed) {
        res.write(prefix);
        res.end(packed);
      } else res.end(prefix);
      return;
    }
    let tail = tails.get(markers);
    if (!tail) {
      tail = Buffer.from(`${JSON.stringify(markers)}}`);
      tails.set(markers, tail);
    }
    const prefix = Buffer.from(
      `${JSON.stringify(data).slice(0, -1)},"markers":`,
    );
    const length = prefix.byteLength + tail.byteLength;
    if (length > MAX_VIEW_BYTES) {
      reply(res, 503, { error: "view_too_large" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": length,
    });
    res.write(prefix);
    res.end(tail);
  }
  let stopping = false;
  const lifecycle = { close: undefined as (() => Promise<void>) | undefined };
  const live = (s: Session) =>
    !stopping &&
    authority.active &&
    sessions.get(s.member.id) === s &&
    s.expires > Date.now() &&
    s.socket.readyState === WebSocket.OPEN;
  /** Retire a session's authority and its HTTP permits. The socket close frame is the caller's
   * job: a kick must hand the browser a documented reason, while a shed session is terminated. */
  const retire = (s: Session) => {
    if (sessions.get(s.member.id) === s) sessions.delete(s.member.id);
    if (byBearer.get(s.bearer) === s) byBearer.delete(s.bearer);
    s.region = null;
    for (const response of s.responses) response.destroy();
  };
  const drop = (s: Session) => {
    retire(s);
    s.socket.terminate();
  };
  function send(socket: WebSocket, message: ServerMessage, s?: Session) {
    if (socket.readyState !== WebSocket.OPEN || (s && !live(s))) return;
    const text = JSON.stringify(message);
    const bytes = Buffer.byteLength(text);
    if (
      s &&
      (s.sent + bytes > SESSION_BYTES ||
        socket.bufferedAmount + bytes > SESSION_BYTES ||
        totalBuffered + bytes > ROOM_BYTES)
    ) {
      // Never continue an incremental stream after dropping data. Rejoin obtains a fresh epoch.
      dropped++;
      drop(s);
      return;
    }
    if (s) {
      s.sent += bytes;
      totalBuffered += bytes;
      maxBuffered = Math.max(maxBuffered, totalBuffered);
    }
    socket.send(text, (error) => {
      if (s) {
        s.sent -= bytes;
        totalBuffered -= bytes;
      }
      if (error) socket.terminate();
    });
  }
  const pushHead = (s: Session) =>
    send(
      s.socket,
      {
        kind: "head",
        seq: ++s.seq,
        epoch: s.epoch,
        head: publicHead(authority.room),
      },
      s,
    );
  const lost = () => {
    console.error("Strategic room authority lost; closing connections.");
    process.exitCode = 1;
    if (lifecycle.close) void lifecycle.close();
  };
  const authority = await StrategicAuthority.open(db, {
    change: () => {
      for (const s of sessions.values()) pushHead(s);
      if (process.env.STRATEGIC_METRICS === "1")
        console.log(
          JSON.stringify({
            stage: "notify",
            room: db.id,
            version: authority.room.version,
            phase: authority.room.phase,
            sessions: sessions.size,
            maxBuffered,
            dropped,
            bulk: bulk.active,
          }),
        );
    },
    kick: (id) => {
      // Live session only. The browser may resume this seat with its existing key, so this is a
      // deliberate close rather than a terminate: the client sees why it must rejoin.
      const s = sessions.get(id);
      if (!s) return;
      retire(s);
      s.socket.close(4001, "kicked");
    },
    revoke: (id) => {
      const s = sessions.get(id);
      if (s) drop(s);
    },
    lost,
  });

  wss.on("connection", (socket, req: IncomingMessage) => {
    socket.on("error", () => socket.terminate());
    unauth.add(socket);
    const origin = req.headers.origin ?? "";
    const nonce = secret();
    let s: Session | undefined;
    const timeout = setTimeout(() => socket.terminate(), 10_000);
    let proving = false;
    socket.once("close", () => {
      clearTimeout(timeout);
      unauth.delete(socket);
      if (s) drop(s);
    });
    socket.on("pong", () => heartbeats.add(socket));
    socket.on("message", (raw, binary) => {
      const receivedAt = Date.now();
      let value: unknown;
      try {
        if (binary) throw new Error("binary");
        value = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, "invalid message");
        return;
      }
      if (!s) {
        if (proving) {
          socket.terminate();
          return;
        }
        proving = true;
        void (async () => {
          const proof = parseAuth(value);
          const member =
            proof &&
            (await verifyText(
              proof.publicKey,
              proof.signature,
              authPayload(db.id, origin, nonce),
            )) &&
            socket.readyState === WebSocket.OPEN &&
            authority.active
              ? await db.admit(proof.publicKey, proof.invite)
              : null;
          if (socket.readyState !== WebSocket.OPEN) return;
          if (!member || !authority.active) {
            send(socket, { kind: "error", code: "not_admitted" });
            socket.close(1008, "not admitted");
            return;
          }
          // Recheck after async proof/claim, so an intervening revocation can't re-admit a slot.
          if (
            !(await db.privateState(member)) ||
            socket.readyState !== WebSocket.OPEN ||
            !authority.active
          ) {
            socket.terminate();
            return;
          }
          unauth.delete(socket);
          clearTimeout(timeout);
          const old = sessions.get(member.id);
          if (old) drop(old);
          s = {
            socket,
            member,
            epoch: secret(),
            bearer: secret(),
            expires: Date.now() + SESSION_MS,
            seq: 0,
            regionCursor: 0,
            region: null,
            regionBusy: false,
            pending: 0,
            responses: new Set(),
            sent: 0,
            allowance: 12,
            refillAt: Date.now(),
          };
          sessions.set(member.id, s);
          byBearer.set(s.bearer, s);
          heartbeats.add(socket);
          send(
            socket,
            {
              kind: "welcome",
              epoch: s.epoch,
              bearer: s.bearer,
              role: member.role,
            },
            s,
          );
          pushHead(s);
        })().catch(() => {
          send(socket, { kind: "error", code: "unavailable" });
          socket.close(1011);
        });
        return;
      }
      const session = s;
      if (!live(session)) {
        drop(session);
        return;
      }
      const cmd = parseCommand(value);
      if (!cmd) {
        send(socket, { kind: "error", code: "invalid_message" }, session);
        socket.close(1008);
        return;
      }
      session.allowance = Math.min(
        12,
        session.allowance + Math.max(0, receivedAt - session.refillAt) / 250,
      );
      session.refillAt = receivedAt;
      if (session.allowance < 1 || session.pending >= 8) {
        // Bound ingress as well as queued output. Retrying a durable ID is safe after reconnect.
        drop(session);
        return;
      }
      session.allowance--;
      session.pending++;
      void authority
        .submit(session.member, cmd, receivedAt)
        .then(
          (receipt) => send(socket, receipt, session),
          () =>
            send(
              socket,
              reject(
                cmd.requestId,
                "unavailable",
                "Retry the same request after reconnecting.",
              ),
              session,
            ),
        )
        .finally(() => {
          session.pending--;
        });
    });
    send(socket, { kind: "challenge", room: db.id, nonce });
  });

  async function http(req: IncomingMessage, res: ServerResponse) {
    common(res, socketOrigins);
    const url = new URL(req.url ?? "/", "http://strategic.invalid");
    if (req.method !== "GET") {
      reply(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (url.pathname === "/healthz") {
      reply(res, authority.active ? 200 : 503, { ok: authority.active });
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset) {
      res.writeHead(200, { "Content-Type": asset.type });
      res.end(asset.data);
      return;
    }
    const path = url.pathname.slice(STRATEGIC_API.length);
    const sceneMedia = (asset: string) => {
      const hash = asset.replace(/\.webp$/, "");
      if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
      const found = mediaByHash.get(hash);
      if (!found) return undefined;
      // Same origin the session was admitted from; a shared reader can cache it, not mutate it.
      if (req.headers.origin && !origins.has(req.headers.origin))
        return undefined;
      return found;
    };
    if (
      url.pathname.startsWith(`${STRATEGIC_API}/scene/`) &&
      req.method === "GET" &&
      req.headers.origin &&
      origins.has(req.headers.origin)
    ) {
      const asset = sceneMedia(
        decodeURIComponent(
          url.pathname.slice(`${STRATEGIC_API}/scene/`.length),
        ),
      );
      if (!asset) {
        reply(res, 404, { error: "not_found" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": asset.data.byteLength,
        ETag: `"${asset.hash}"`,
      });
      res.end(asset.data);
      return;
    }
    if (
      !url.pathname.startsWith(`${STRATEGIC_API}/`) ||
      !["/view", "/region", "/report"].includes(path)
    ) {
      reply(res, 404, { error: "not_found" });
      return;
    }
    const origin = req.headers.origin;
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.authorization ?? "",
    )?.[1];
    const session = bearer ? byBearer.get(bearer) : undefined;
    if ((origin && !origins.has(origin)) || !session || !live(session)) {
      reply(res, 401, { error: "not_admitted" });
      return;
    }
    if (
      session.responses.size >= 3 ||
      (path === "/region" && session.regionBusy)
    ) {
      reply(res, 429, { error: "view_busy" });
      return;
    }
    let release = bulk.enter();
    // Don't make the publication herd throw away authenticated connections and retry in waves.
    // Regions, reports, or duplicate requests do not get a waiting slot.
    if (
      !release &&
      path === "/view" &&
      req.headers.accept === STRATEGIC_PATCH_TYPE &&
      session.deliveredMarkersVersion === authority.room.version - 1 &&
      numeric(url.searchParams.get("markersVersion")) ===
        session.deliveredMarkersVersion
    ) {
      const pending = new AbortController();
      const cancel = () => pending.abort();
      session.responses.add(res);
      res.once("close", cancel);
      try {
        release = await bulk.wait(session, pending.signal);
      } finally {
        res.off("close", cancel);
        session.responses.delete(res);
      }
    }
    if (!release) {
      reply(res, 429, { error: "view_busy" });
      return;
    }
    if (!live(session) || res.destroyed) {
      release();
      reply(res, 401, { error: "not_admitted" });
      return;
    }
    session.responses.add(res);
    if (path === "/region") session.regionBusy = true;
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      session.responses.delete(res);
      if (path === "/region") session.regionBusy = false;
      release();
    };
    res.on("close", done);
    res.on("finish", done);
    res.setTimeout(10_000, () => res.destroy());
    const privateState = await db.privateState(session.member);
    if (!privateState || !live(session) || res.destroyed) {
      reply(res, 401, { error: "not_admitted" });
      return;
    }
    const current = authority.battle;
    const { room, orders } = privateState;
    // If a DB commit and the in-memory install straddle the read, ask for a clean baseline.
    if (
      current.state.version !== room.version ||
      authority.room.turnId !== room.turnId ||
      authority.room.phase !== room.phase
    ) {
      reply(res, 409, { error: "view_changed" });
      return;
    }
    if (path === "/view") {
      // A roster read can finish after the session was dropped by a kick, revoke or disconnect.
      const members =
        session.member.role === "GM" ? await roster(db, sessions) : undefined;
      if (!live(session) || res.destroyed) {
        reply(res, 401, { error: "not_admitted" });
        return;
      }
      const data: BaselineMeta = {
        epoch: session.epoch,
        head: publicHead(room),
        name: current.scenario.name,
        bounds: current.scenario.bounds,
        role: session.member.role,
        factionId: session.member.factionId,
        factions: current.scenario.factions,
        own: current.own(session.member),
        orders,
        ...(members
          ? {
              members,
              media: media.map(({ hash, data }) => ({
                hash,
                name: `scene-${hash.slice(0, 12)}.webp`,
                mime: "image/webp",
                size: data.byteLength,
                url: `scene/${hash}.webp`,
              })),
            }
          : {}),
      };
      // The version is only a bandwidth hint; select data by the admitted member.
      const known = numeric(url.searchParams.get("markersVersion"));
      const changes =
        req.headers.accept === STRATEGIC_PATCH_TYPE &&
        session.deliveredMarkersVersion === known &&
        known === room.version - 1
          ? current.markerChanges(session.member)
          : undefined;
      res.once("finish", () => {
        if (res.statusCode === 200 && known !== room.version)
          session.deliveredMarkersVersion = Math.max(
            session.deliveredMarkersVersion ?? -1,
            room.version,
          );
      });
      replyView(
        req,
        res,
        data,
        current.markers(session.member),
        known === room.version
          ? undefined
          : (changes ?? current.packedMarkers(session.member)),
        changes !== undefined,
      );
      return;
    }
    const version = numeric(url.searchParams.get("version"));
    if (
      !integer(version, path === "/region" ? 0 : 1) ||
      version > room.version
    ) {
      reply(res, 404, { error: "not_found" });
      return;
    }
    if (path === "/region") {
      if (version !== room.version) {
        reply(res, 409, { error: "view_changed" });
        return;
      }
      const x = numeric(url.searchParams.get("x")),
        y = numeric(url.searchParams.get("y"));
      const { minX, minY, maxX, maxY } = current.scenario.bounds;
      if (
        !integer(x, 0, Math.floor((maxX - minX) / REGION_SIZE)) ||
        !integer(y, 0, Math.floor((maxY - minY) / REGION_SIZE))
      ) {
        reply(res, 400, { error: "bad_region" });
        return;
      }
      const tile = `${x},${y}`;
      const cursor = numeric(url.searchParams.get("cursor"));
      const previous =
        session.region?.tile === tile && cursor === session.region.cursor
          ? session.region
          : null;
      const visible = current.region(session.member, tile);
      const models = new Map(
        visible.slice(0, MAX_REGION_MODELS).map((model) => [model.id, model]),
      );
      const next = { tile, cursor: ++session.regionCursor, models };
      const patch: RegionPatch = {
        epoch: session.epoch,
        version,
        cursor: next.cursor,
        fromCursor: previous?.cursor ?? null,
        truncated: visible.length > MAX_REGION_MODELS,
        ...diffRegion(previous?.models ?? null, models),
      };
      session.region = next;
      reply(res, 200, patch);
      return;
    }
    const page = numeric(url.searchParams.get("page") ?? "0");
    if (!integer(page, 0, 125)) {
      reply(res, 400, { error: "bad_page" });
      return;
    }
    const rows = await db.report(session.member, version, page);
    if (!live(session)) {
      reply(res, 401, { error: "not_admitted" });
      return;
    }
    const data: ReportPage = {
      epoch: session.epoch,
      version,
      page,
      hasMore: rows.length > PAGE_ROWS,
      rows: rows.slice(0, PAGE_ROWS),
    };
    reply(res, 200, data);
  }

  const server = createServer(
    { headersTimeout: 10_000, requestTimeout: 10_000, maxHeaderSize: 8192 },
    (req, res) => {
      void http(req, res).catch(() =>
        reply(res, 503, { error: "unavailable" }),
      );
    },
  );
  server.maxConnections =
    (MAX_COMMANDERS + 1) * 2 + AUTH_CONCURRENCY + BULK_CONCURRENCY;
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const allowed =
      !stopping &&
      authority.active &&
      req.url === `${STRATEGIC_API}/socket` &&
      origins.has(req.headers.origin ?? "") &&
      req.headers["sec-websocket-protocol"] === STRATEGIC_PROTOCOL &&
      unauth.size < AUTH_CONCURRENCY &&
      sessions.size <= MAX_COMMANDERS + 1;
    if (!allowed) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  const pulse = setInterval(() => {
    for (const s of sessions.values()) {
      if (!live(s) || !heartbeats.has(s.socket)) {
        drop(s);
        continue;
      }
      heartbeats.delete(s.socket);
      s.socket.ping();
    }
  }, 15_000);
  pulse.unref();

  async function close() {
    if (stopping) return;
    stopping = true;
    clearInterval(pulse);
    for (const s of sessions.values()) drop(s);
    for (const s of unauth) s.terminate();
    wss.close();
    server.close();
    server.closeAllConnections();
    await authority.close();
  }
  lifecycle.close = close;
  try {
    if (!authority.active)
      throw new Error("Room authority lost during startup.");
    if (port !== null)
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
          server.off("error", reject);
          resolve();
        });
      });
  } catch (error) {
    await close();
    throw error;
  }
  return { server, close };
}
