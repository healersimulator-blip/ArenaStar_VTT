import { describe, expect, test, vi } from "vitest";
import { ClientSync, type ClientEvents, type ClientImageUploadOptions } from "../../src/client/sync";
import type { AssetId, UserId } from "../../src/core/ids";
import type { AssetManifestEntry, UserDocument } from "../../src/core/documents";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { Op, OpEnvelope } from "../../src/core/ops";
import { createEventBus } from "../../src/core/events";
import type { AssetServer } from "../../src/host/assets";
import { gmSessionUser, HostSync, type HostEvents } from "../../src/host/sync";
import type { ImageImportOptions, ImportPipeline } from "../../src/host/import";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { frameMessage } from "../../src/net/frame";
import { worldSettingsDoc, type CoreWorldSettings } from "../../src/core/worldSettings";
import { MAX_IMAGE_BYTES } from "../../src/core/imageSizing";
import { pngHeaderForTest } from "../helpers/imageBytes";

const GM_ID = "image-gm";
const TRUSTED_ID = "image-trusted";
const PLAYER_ID = "image-player";
const meta: StoreMeta = {
  worldId: "image-upload-world",
  name: "Image upload test world",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};

function userDoc(id: UserId, name: string, role: UserDocument["role"]): UserDocument {
  return {
    _id: id,
    type: "user",
    name,
    ownership: { default: 0 },
    flags: {},
    system: {},
    role,
    character: null,
    color: "#fff",
  };
}

interface TestClient {
  client: ClientSync;
  bus: ReturnType<typeof createEventBus<ClientEvents>>;
  pair: ReturnType<typeof createTransportPair>;
}

interface Harness {
  store: DocumentStore;
  log: OpLog;
  gm: TestClient;
  trusted: TestClient;
  player: TestClient;
  viewer: TestClient;
  importer: ReturnType<typeof vi.fn>;
}

async function createHarness(settings: CoreWorldSettings = {}): Promise<Harness> {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const hostBus = createEventBus<HostEvents>();
  const blobs = new Map<string, Uint8Array>();
  const entries = new Map<string, AssetManifestEntry>();
  let nextHash = 1;
  const publishManifest = (): void => {
    store.replaceAssetManifest(Object.fromEntries(entries));
  };

  const assets = {
    read: async (hash: string, offset: number, length: number) => {
      const bytes = blobs.get(hash);
      return bytes ? { bytes: bytes.slice(offset, offset + length), total: bytes.length } : undefined;
    },
    has: async (hash: string) => blobs.has(hash),
    meta: async (hash: string) => entries.get(hash),
    describe: async (hash: string, patch: Partial<AssetManifestEntry>) => {
      const current = entries.get(hash);
      if (!current) throw new Error(`unknown asset ${hash}`);
      const updated = { ...current, ...patch };
      entries.set(hash, updated);
      publishManifest();
      return updated;
    },
  } as unknown as AssetServer;

  const importer = vi.fn(async (
    bytes: Uint8Array,
    name: string,
    mime: string,
    options: ImageImportOptions = {},
  ) => {
    const hash = (nextHash++).toString(16).padStart(64, "0") as AssetId;
    await options.beforeStore?.({ assetHash: hash, preparedHash: hash, reused: false });
    const entry: AssetManifestEntry = {
      name,
      mime,
      size: bytes.length,
      chunks: 1,
      visibility: options.visibility ?? "referenced",
      width: 2,
      height: 2,
      ...(options.source ? { source: structuredClone(options.source) } : {}),
    };
    entries.set(hash, entry);
    blobs.set(hash, new Uint8Array(bytes));
    publishManifest();
    return { hash, entry };
  });
  const pipeline = { importImage: importer } satisfies Pick<ImportPipeline, "importImage">;

  const seedOps: Op[] = [
    { kind: "create", coll: "users", data: userDoc(GM_ID, "GM", "GM") },
    { kind: "create", coll: "users", data: userDoc(TRUSTED_ID, "Rin", "TRUSTED") },
    { kind: "create", coll: "users", data: userDoc(PLAYER_ID, "Sam", "PLAYER") },
    { kind: "create", coll: "settings", data: worldSettingsDoc(settings) },
  ];
  const seed: OpEnvelope = { seq: 1, ts: 0, by: GM_ID, ops: seedOps, txId: "image-upload-seed" };
  const applied = store.applyEnvelope(seed);
  if (!applied.ok) throw new Error(applied.error);
  const appended = log.append(seed, applied.value.inverses);
  if (!appended.ok) throw new Error("failed to seed image upload OpLog");
  undo.push(seed, applied.value.inverses);

  const host = new HostSync({
    store,
    log,
    undo,
    bus: hostBus,
    systemUserId: GM_ID,
    roomId: "image-upload-room",
    assets,
    pipeline,
  });

  const addClient = (id: UserId, name: string, role: UserDocument["role"]): TestClient => {
    const pair = createTransportPair();
    host.addSession(`peer-${id}`, pair.a, { id, name, role });
    const bus = createEventBus<ClientEvents>();
    const client = new ClientSync({ transport: pair.b, bus, meta });
    return { client, bus, pair };
  };

  const gmPair = createTransportPair();
  host.addSession("image-gm-loopback", gmPair.a, gmSessionUser(GM_ID));
  const gmBus = createEventBus<ClientEvents>();
  const gm = { client: new ClientSync({ transport: gmPair.b, bus: gmBus, meta }), bus: gmBus, pair: gmPair };

  const harness = {
    store,
    log,
    gm,
    trusted: addClient(TRUSTED_ID, "Rin", "TRUSTED"),
    player: addClient(PLAYER_ID, "Sam", "PLAYER"),
    viewer: addClient("image-viewer", "Mo", "PLAYER"),
    importer,
  };
  await flushMicrotasks();
  return harness;
}

function uploadOptions(name: string): ClientImageUploadOptions {
  return {
    name,
    displayName: name,
    folder: "",
    sourceKind: "file",
    collisionBehavior: "stop",
    convertToWebp: false,
    webpQuality: 0.8,
  };
}

function startMessage(uploadId: string, size: number) {
  return {
    kind: "asset.upload.start" as const,
    uploadId,
    name: "map.png",
    displayName: "map.png",
    size,
    folder: "",
    sourceKind: "file" as const,
    collisionBehavior: "stop" as const,
    convertToWebp: false,
    webpQuality: 0.8,
  };
}

describe("host-authorized image uploads and sharing", () => {
  test("rejects an untrusted player and restricted mode before invoking the import pipeline", async () => {
    const bytes = pngHeaderForTest(2, 2, [1, 2, 3]);
    const h = await createHarness();
    const results: ClientEvents["assetUpload"][] = [];
    h.player.bus.on("assetUpload", (result) => results.push(result));
    h.player.pair.b.send("assets", frameMessage(startMessage("untrusted-upload", bytes.length)));
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ status: "error" });
    expect(results.at(-1)?.error).toMatch(/TRUSTED upload grant/i);
    expect(h.importer).not.toHaveBeenCalled();

    const restricted = await createHarness({ restrictedPlayerImageMode: true });
    await expect(restricted.trusted.client.uploadImageAsset(bytes, uploadOptions("map.png")))
      .rejects.toThrow(/TRUSTED upload grant/i);
    expect(restricted.importer).not.toHaveBeenCalled();
  });

  test("rejects over-limit declarations and bad magic bytes before import", async () => {
    const h = await createHarness();
    const results: ClientEvents["assetUpload"][] = [];
    h.trusted.bus.on("assetUpload", (result) => results.push(result));

    h.trusted.pair.b.send("assets", frameMessage(startMessage("oversized-upload", MAX_IMAGE_BYTES + 1)));
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ status: "error" });
    expect(results.at(-1)?.error).toMatch(/64 MB/i);
    expect(h.importer).not.toHaveBeenCalled();

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const uploadId = "bad-magic-upload";
    h.trusted.pair.b.send("assets", frameMessage(startMessage(uploadId, bytes.length)));
    await flushMicrotasks();
    h.trusted.pair.b.send("assets", frameMessage({ kind: "asset.upload.chunk", uploadId, offset: 0, bytes }));
    await flushMicrotasks();
    h.trusted.pair.b.send("assets", frameMessage({ kind: "asset.upload.finish", uploadId }));
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ status: "error" });
    expect(results.at(-1)?.error).toMatch(/unsupported or malformed image/i);
    expect(h.importer).not.toHaveBeenCalled();
  });

  test("keeps an audit commit failure before any asset bytes are written", async () => {
    const h = await createHarness();
    vi.spyOn(h.log, "append").mockReturnValue({ ok: false, error: "audit log unavailable" });
    const bytes = pngHeaderForTest(2, 2, [3, 1, 4]);

    await expect(h.trusted.client.uploadImageAsset(bytes, uploadOptions("no-audit.png")))
      .rejects.toThrow(/audit could not be committed; no bytes were stored/i);
    expect(h.importer).toHaveBeenCalledOnce();
    expect(h.store.world.assetManifest).toEqual({});
  });

  test("re-checks a player's current role before accepting chunks", async () => {
    const h = await createHarness();
    const bytes = pngHeaderForTest(2, 2, [7, 8, 9]);
    const uploadId = "revocation-upload";
    const results: ClientEvents["assetUpload"][] = [];
    h.trusted.bus.on("assetUpload", (result) => results.push(result));

    h.trusted.pair.b.send("assets", frameMessage(startMessage(uploadId, bytes.length)));
    await flushMicrotasks();
    expect(results.at(-1)?.status).toBe("ready");

    h.gm.client.submit([{
      kind: "update",
      ref: { coll: "users", id: TRUSTED_ID },
      diff: { role: "PLAYER" },
    }]);
    await flushMicrotasks();
    h.trusted.pair.b.send("assets", frameMessage({
      kind: "asset.upload.chunk",
      uploadId,
      offset: 0,
      bytes,
    }));
    await flushMicrotasks();

    expect(results.at(-1)).toMatchObject({ status: "error" });
    expect(results.at(-1)?.error).toMatch(/revoked/i);
    expect(h.importer).not.toHaveBeenCalled();
  });

  test("rechecks the configured quota at finish, before importing bytes", async () => {
    const h = await createHarness({ playerUploadQuotaMB: 0.01 });
    const bytes = pngHeaderForTest(2, 2, [11, 12, 13]);
    const uploadId = "quota-upload-test";
    const results: ClientEvents["assetUpload"][] = [];
    h.trusted.bus.on("assetUpload", (result) => results.push(result));

    h.trusted.pair.b.send("assets", frameMessage(startMessage(uploadId, bytes.length)));
    await flushMicrotasks();
    expect(results.at(-1)?.status).toBe("ready");
    h.trusted.pair.b.send("assets", frameMessage({ kind: "asset.upload.chunk", uploadId, offset: 0, bytes }));
    await flushMicrotasks();

    h.gm.client.submit([{
      kind: "update",
      ref: { coll: "settings", id: "world-settings" },
      diff: { "system.playerUploadQuotaMB": 0 },
    }]);
    await flushMicrotasks();
    h.trusted.pair.b.send("assets", frameMessage({ kind: "asset.upload.finish", uploadId }));
    await flushMicrotasks();

    expect(results.at(-1)).toMatchObject({ status: "error" });
    expect(results.at(-1)?.error).toMatch(/quota reached/i);
    expect(h.importer).not.toHaveBeenCalled();
  });

  test("uploads are attributed in a GM-visible OpLog record; sharing updates one stable slot and broadcasts", async () => {
    const h = await createHarness();
    const shared: Array<ClientEvents["ephemeral"]> = [];
    h.viewer.bus.on("ephemeral", (event) => shared.push(event));
    const seqBefore = h.store.seq;

    const firstBytes = pngHeaderForTest(2, 2, [21, 22]);
    const first = await h.trusted.client.uploadImageAsset(firstBytes, uploadOptions("first.png"));
    expect(first.width).toBe(2);
    expect(h.store.world.assetManifest[first.hash]?.visibility).toBe("gm");

    const auditEnvelope = h.log.since(seqBefore).find((envelope) => envelope.ops.some((op) =>
      op.kind === "create" && op.coll === "messages" && op.data.system.auditKind === "image-upload"));
    expect(auditEnvelope?.by).toBe(TRUSTED_ID);
    const audit = h.store.getAll("messages").find((message) => message.system.auditKind === "image-upload");
    expect(audit).toMatchObject({
      author: TRUSTED_ID,
      system: { auditKind: "image-upload", auditStatus: "stored", assetId: first.hash, uploadedBytes: firstBytes.length },
    });
    expect(audit?.content).toContain("Rin uploaded image");
    expect(audit?.whisper).toContain(GM_ID);
    expect(h.gm.client.store.get("messages", audit?._id ?? "")).toBeDefined();

    await h.trusted.client.shareImageToPlayers(first.hash);
    await flushMicrotasks();
    expect(h.store.world.assetManifest[first.hash]?.visibility).toBe("world");
    expect(h.store.get("settings", "world-settings")?.system.imageShareSlots)
      .toEqual({ [TRUSTED_ID]: first.hash });
    expect(shared.at(-1)).toMatchObject({
      from: TRUSTED_ID,
      t: "image",
      data: { assetId: first.hash, name: "first.png" },
    });

    const secondBytes = pngHeaderForTest(2, 2, [31, 32]);
    const second = await h.trusted.client.uploadImageAsset(secondBytes, uploadOptions("second.png"));
    await h.trusted.client.shareImageToPlayers(second.hash);
    await flushMicrotasks();
    expect(h.store.get("settings", "world-settings")?.system.imageShareSlots)
      .toEqual({ [TRUSTED_ID]: second.hash });
    expect(shared.at(-1)?.data.assetId).toBe(second.hash);
    expect(shared).toHaveLength(2);
  });
});
