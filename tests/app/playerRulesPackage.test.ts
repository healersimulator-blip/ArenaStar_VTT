// D-472: the active rules package travels to players — artifact publish, chunked fetch, consent.
/**
 * P3's second step: after D-471 the GM shell runs the active system package in-page from the
 * world file; this proves the *player* half without a browser:
 *
 *   1. delivery — the host publishes the package's `rules.js` as a content-addressed artifact,
 *      every welcome names it (`sim.artifact`), and an approved player fetches it on the §7
 *      assets channel in ordinary chunks (no new framing on any transport);
 *   2. consent — nothing is fetched, let alone run, before this device allowed the exact hash;
 *      "Not now" is remembered; a changed artifact asks again as an update; `forget` goes back;
 *   3. integrity — bytes that do not digest to the announced hash never reach the importer,
 *      whatever the host says; an unknown hash is the usual miss sentinel.
 */
import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { AssetCache, AssetFetcher, type AssetCacheBackend } from "../../src/client/assets";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { HelloMsg, WelcomeSimInfo } from "../../src/core/messages";
import type { OpEnvelope } from "../../src/core/ops";
import type { UserDocument } from "../../src/core/documents";
import { sha256Hex } from "../../src/host/assets";
import type { RulesModule } from "../../src/core/rules";
import { err, type Result } from "../../src/core/result";
import { openVttDb, getSetting } from "../../src/storage/idb";
import {
  PlayerRulesPackage,
  playerRulesConsentScope,
  type PlayerRulesOffer,
  type PlayerRulesStatus,
} from "../../src/app/playerRulesPackage";

const RULES_JS =
  "export default { schema: { version: '3.1.0', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move', 'heal'] }, validateOrder(){ return {ok:true}; }, resolveTurn(){}, detection(){ return 5; } };\n" +
  "// padding so the artifact spans several transfer chunks\n".repeat(8);
const RULES_JS_V2 = RULES_JS.replace("3.1.0", "3.2.0");
const GM_ID = "gm-key";
const SCHEMA = { ammo: "u8" as const };

let worldCounter = 0;
let meta: StoreMeta = { worldId: "w-rules-0", name: "Rules", system: "probe-rules", systemVersion: "3.1.0" };

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function userDoc(id: string, name: string, role: UserDocument["role"] = "PLAYER"): UserDocument {
  return { _id: id, type: "user", name, ownership: { default: 0 }, flags: {}, system: {}, role, character: null, color: "#fff" };
}

class MemoryBackend implements AssetCacheBackend {
  readonly entries = new Map<string, { bytes: Uint8Array; mime: string }>();
  async get(hash: string) { return this.entries.get(hash); }
  async put(hash: string, bytes: Uint8Array, mime: string) { this.entries.set(hash, { bytes, mime }); }
  async has(hash: string) { return this.entries.has(hash); }
}

interface Player {
  client: ClientSync;
  bus: EventBus<ClientEvents>;
  fetcher: AssetFetcher;
  backend: MemoryBackend;
  chunks: number;
  fetchCalls: string[];
  statuses: PlayerRulesStatus[];
  rules: PlayerRulesPackage;
  db: Awaited<ReturnType<typeof openVttDb>>;
}

interface Harness {
  host: HostSync;
  hostBus: EventBus<HostEvents>;
  worldId: string;
  announce: (source: string, over?: Partial<WelcomeSimInfo>) => Promise<string>;
  addPlayer: (pubkey: string, options?: { importModule?: (source: string) => Promise<Result<RulesModule>>; trusted?: (hash: string) => boolean }) => Promise<Player>;
  /** D-475: publish a `ui.js` beside the rules and announce both. */
  announceWithUi: (rules: string, ui: string) => Promise<{ hash: string; uiHash: string }>;
}

async function setup(): Promise<Harness> {
  meta = { ...meta, worldId: `w-rules-${++worldCounter}` };
  const hostStore = new DocumentStore({ meta });
  const hostLog = new OpLog();
  const undo = new UndoStack();
  const hostBus = createEventBus<HostEvents>();
  const host = new HostSync({
    store: hostStore, log: hostLog, undo, bus: hostBus, systemUserId: GM_ID, roomId: "room-rules",
    verifyHelloSig: async (hello) => hello.sig === "valid", rng: () => 0.25,
    // Small chunks and no pacing: the 700-byte artifact must still arrive as several asset.chunk
    // messages, exactly the path a 330 KB real package takes at 32 KB.
    assetTransfer: { chunkSize: 64, bytesPerSecond: 1e12, sleep: () => Promise.resolve() },
  });
  const seed: OpEnvelope = {
    seq: 1, ts: 0, by: GM_ID, txId: "seed",
    ops: [
      { kind: "create", coll: "users", data: userDoc(GM_ID, "GM", "GM") },
      { kind: "create", coll: "users", data: userDoc("rex-key", "Rex") },
    ],
  };
  const applied = hostStore.applyEnvelope(seed);
  if (!applied.ok) throw new Error(applied.error);
  const appended = hostLog.append(seed, applied.value.inverses);
  if (!appended.ok) throw new Error(appended.error);
  undo.push(seed, applied.value.inverses);

  const gmPair = createTransportPair();
  host.addSession("gm", gmPair.a, gmSessionUser(GM_ID));
  new ClientSync({ transport: gmPair.b, bus: createEventBus<ClientEvents>(), meta });
  await flushMicrotasks();
  hostBus.on("join:request", ({ approve }) => approve());

  const announce = async (source: string, over: Partial<WelcomeSimInfo> = {}): Promise<string> => {
    const bytes = encode(source);
    const hash = await sha256Hex(bytes);
    host.publishArtifact(hash, bytes);
    host.setSimInfo({
      sceneId: "scene-1", schema: SCHEMA, packageId: "probe-rules", version: "3.1.0",
      artifact: { hash, size: bytes.byteLength, name: "Probe Rules" },
      ...over,
    });
    await flushMicrotasks();
    return hash;
  };

  const announceWithUi = async (rules: string, ui: string): Promise<{ hash: string; uiHash: string }> => {
    const uiBytes = encode(ui);
    const uiHash = await sha256Hex(uiBytes);
    host.publishArtifact(uiHash, uiBytes);
    const hash = await announce(rules, { ui: { hash: uiHash, size: uiBytes.byteLength, name: "Probe Rules" } });
    return { hash, uiHash };
  };

  return {
    host, hostBus, worldId: meta.worldId, announce, announceWithUi,
    addPlayer: async (pubkey, options = {}) => {
      const pair = createTransportPair();
      host.addSession(`peer-${pubkey}`, pair.a);
      const bus = createEventBus<ClientEvents>();
      const client = new ClientSync({ transport: pair.b, bus, meta });
      const backend = new MemoryBackend();
      const fetcher = new AssetFetcher({
        cache: AssetCache.withBackend(backend),
        request: (id, priority, offset) => client.requestAsset(id, priority, offset),
      });
      const player: Partial<Player> = { client, bus, fetcher, backend, chunks: 0, fetchCalls: [], statuses: [] };
      bus.on("asset", (chunk) => { player.chunks = (player.chunks ?? 0) + 1; fetcher.onChunk(chunk); });
      const hello: HelloMsg = { kind: "hello", pubkey, displayName: pubkey, ts: 1, sig: "valid" };
      client.connect(hello);
      await flushMicrotasks();
      const db = await openVttDb();
      const rules = new PlayerRulesPackage({
        client, bus, db, worldId: meta.worldId,
        fetch: (hash) => { player.fetchCalls?.push(hash); return fetcher.request(hash, "ui", "text/javascript"); },
        onStatus: (status) => { player.statuses?.push(status); },
        ...(options.importModule ? { importModule: options.importModule } : {}),
        ...(options.trusted ? { trusted: options.trusted } : {}),
        now: () => 1_700_000_000_000,
      });
      player.rules = rules;
      player.db = db;
      return player as Player;
    },
  };
}

const lastState = (player: Player): PlayerRulesStatus["state"] => player.statuses[player.statuses.length - 1]?.state ?? "none";

describe("D-472 — delivery: the active rules package reaches an approved player as chunked bytes", () => {
  test("every welcome names the artifact; after consent the player fetches it in several chunks, verifies the digest and loads the module", async () => {
    const h = await setup();
    const hash = await h.announce(RULES_JS);
    const player = await h.addPlayer("rex-key");
    await until(() => lastState(player) === "pending", "the consent prompt");

    // The welcome carried the artifact alongside the schema the sim replica already adopts.
    expect(player.client.simInfo?.artifact).toEqual({ hash, size: encode(RULES_JS).byteLength, name: "Probe Rules" });
    const offer = must(player.statuses.find((status) => status.state === "pending"));
    if (offer.state !== "pending") throw new Error("unreachable");
    expect(offer.offer).toEqual({ packageId: "probe-rules", name: "Probe Rules", version: "3.1.0", hash, uiHash: null, size: encode(RULES_JS).byteLength, updated: false, firstParty: false });
    // Nothing moved on the wire before the decision.
    expect(player.fetchCalls).toEqual([]);
    expect(player.rules.module).toBeNull();

    await player.rules.allow();
    await until(() => lastState(player) === "ready", "the module to load");
    expect(player.statuses.map((status) => status.state)).toEqual(["pending", "loading", "ready"]);
    const module = must(player.rules.module);
    expect(module.schema.version).toBe("3.1.0");
    expect(module.schema.subPhases).toContain("heal");
    expect(module.validateOrder).toBeTypeOf("function");
    // Chunked: 700-odd bytes at 64 B per chunk is a dozen asset.chunk messages, not one op.
    expect(player.chunks).toBeGreaterThanOrEqual(Math.ceil(encode(RULES_JS).byteLength / 64));
    expect(player.fetchCalls).toEqual([hash]);
    // The decision is remembered for this exact artifact, scoped to the world.
    const row = await getSetting(player.db, playerRulesConsentScope(h.worldId), "probe-rules");
    expect(row?.value).toEqual({ hash, uiHash: null, decision: "allow", at: 1_700_000_000_000 });
    // The content-addressed cache filled, so a rejoin costs no wire traffic (§7 acceptance).
    expect(player.backend.entries.has(hash)).toBe(true);
    player.rules.dispose();
  });

  test("a remembered allow loads on the next session without a prompt and without a second transfer", async () => {
    const h = await setup();
    const hash = await h.announce(RULES_JS);
    const first = await h.addPlayer("rex-key");
    await until(() => lastState(first) === "pending", "prompt");
    await first.rules.allow();
    await until(() => lastState(first) === "ready", "load");
    first.rules.dispose();

    // Same device (same IndexedDB consent row), fresh client: straight to loading, then ready.
    const second = await h.addPlayer("rex-key");
    await until(() => lastState(second) === "ready", "auto-load");
    expect(second.statuses.map((status) => status.state)).toEqual(["loading", "ready"]);
    expect(second.fetchCalls).toEqual([hash]); // the fetcher's own cache would short-circuit with a shared cache
    expect(must(second.rules.module).schema.version).toBe("3.1.0");
    second.rules.dispose();
  });

  test("a hash nobody published is the usual miss sentinel, and a session without a user cannot fetch", async () => {
    const h = await setup();
    await h.announce(RULES_JS);
    const player = await h.addPlayer("rex-key");
    await until(() => lastState(player) === "pending", "prompt");
    const unknown = "f".repeat(64);
    await expect(player.fetcher.request(unknown, "ui", "text/javascript")).rejects.toThrow(/not found/);
    // A transport that never completed hello: asset.get is ignored (no user), nothing arrives.
    const pair = createTransportPair();
    h.host.addSession("peer-stranger", pair.a);
    const bus = createEventBus<ClientEvents>();
    let strangerChunks = 0;
    bus.on("asset", () => { strangerChunks += 1; });
    const stranger = new ClientSync({ transport: pair.b, bus, meta });
    stranger.requestAsset(h.host.publishedArtifacts()[0] ?? unknown, "ui", 0);
    await flushMicrotasks();
    await settle(20);
    expect(strangerChunks).toBe(0);
    player.rules.dispose();
  });
});

describe("D-472 — consent: this device decides, per world, package and exact artifact", () => {
  test("Not now is remembered for the hash; a changed artifact asks again as an update and drops the old module", async () => {
    const h = await setup();
    const hashV1 = await h.announce(RULES_JS);
    const player = await h.addPlayer("rex-key");
    await until(() => lastState(player) === "pending", "prompt");
    await player.rules.deny();
    expect(lastState(player)).toBe("declined");
    expect(player.fetchCalls).toEqual([]);
    expect((await getSetting(player.db, playerRulesConsentScope(h.worldId), "probe-rules"))?.value).toEqual({ hash: hashV1, uiHash: null, decision: "deny", at: 1_700_000_000_000 });
    player.rules.dispose();

    // Next session, same artifact: no prompt, still declined, still no traffic.
    const again = await h.addPlayer("rex-key");
    await until(() => lastState(again) === "declined", "remembered decline");
    expect(again.statuses.map((status) => status.state)).toEqual(["declined"]);
    expect(again.fetchCalls).toEqual([]);
    // The card's way back: allow from "declined" loads it.
    await again.rules.allow();
    await until(() => lastState(again) === "ready", "load after decline");
    expect(must(again.rules.module).schema.version).toBe("3.1.0");

    // The GM activates a new build of the package: the host re-announces (artifact hash changed,
    // everything else equal) and the player is asked again — as an update, with the old module gone.
    const hashV2 = await h.announce(RULES_JS_V2);
    expect(hashV2).not.toBe(hashV1);
    await until(() => lastState(again) === "pending", "re-prompt");
    const pending = again.statuses[again.statuses.length - 1];
    if (pending?.state !== "pending") throw new Error("unreachable");
    expect(pending.offer).toMatchObject({ hash: hashV2, updated: true, version: "3.1.0" });
    expect(again.rules.module).toBeNull();
    await again.rules.allow();
    await until(() => lastState(again) === "ready", "load v2");
    expect(must(again.rules.module).schema.version).toBe("3.2.0");
    again.rules.dispose();
  });

  test("D-473: a first-party artifact (hash in this build's own list) loads without a prompt and leaves no consent row", async () => {
    const h = await setup();
    const hash = await h.announce(RULES_JS);
    const player = await h.addPlayer("rex-key", { trusted: (candidate) => candidate === hash });
    await until(() => lastState(player) === "ready", "silent load");
    expect(player.statuses.map((status) => status.state)).toEqual(["loading", "ready"]);
    const ready = player.statuses[player.statuses.length - 1];
    if (ready?.state !== "ready") throw new Error("unreachable");
    expect(ready.offer.firstParty).toBe(true);
    expect(must(player.rules.module).schema.version).toBe("3.1.0");
    expect(await getSetting(player.db, playerRulesConsentScope(h.worldId), "probe-rules")).toBeUndefined();
    // Nothing to forget: the decision was the build's, not this device's.
    await player.rules.forget();
    expect(lastState(player)).toBe("ready");
    // A later, non-first-party build of the same package asks like any stranger.
    await h.announce(RULES_JS_V2);
    await until(() => lastState(player) === "pending", "prompt for the untrusted update");
    const pending = player.statuses[player.statuses.length - 1];
    if (pending?.state !== "pending") throw new Error("unreachable");
    expect(pending.offer).toMatchObject({ firstParty: false, updated: false });
    player.rules.dispose();
  });

  test("forget withdraws the decision: the module is dropped and the prompt returns", async () => {
    const h = await setup();
    await h.announce(RULES_JS);
    const player = await h.addPlayer("rex-key");
    await until(() => lastState(player) === "pending", "prompt");
    await player.rules.allow();
    await until(() => lastState(player) === "ready", "load");
    await player.rules.forget();
    expect(lastState(player)).toBe("pending");
    expect(player.rules.module).toBeNull();
    expect((await getSetting(player.db, playerRulesConsentScope(h.worldId), "probe-rules"))?.value).toBeNull();
    player.rules.dispose();
  });

  test("a world on the built-in rules (no artifact) offers nothing, and a re-announce without one clears the state", async () => {
    const h = await setup();
    h.host.setSimInfo({ sceneId: "scene-1", schema: SCHEMA, packageId: null, version: "1.0.0" });
    const player = await h.addPlayer("rex-key");
    await settle(20);
    expect(player.statuses).toEqual([]);
    expect(player.rules.currentStatus).toEqual({ state: "none" });
    await h.announce(RULES_JS);
    await until(() => lastState(player) === "pending", "prompt");
    h.host.setSimInfo({ sceneId: "scene-1", schema: SCHEMA, packageId: null, version: "1.0.0" });
    await flushMicrotasks();
    await until(() => lastState(player) === "none", "cleared");
    player.rules.dispose();
  });
});

describe("D-472 — integrity: what runs is what was announced and allowed", () => {
  test("bytes that do not digest to the announced hash fail closed before the importer sees them", async () => {
    const h = await setup();
    // A lying host: publishes v2 bytes under v1's hash and announces v1.
    const bytesV1 = encode(RULES_JS);
    const hashV1 = await sha256Hex(bytesV1);
    h.host.publishArtifact(hashV1, encode(RULES_JS_V2));
    h.host.setSimInfo({
      sceneId: "scene-1", schema: SCHEMA, packageId: "probe-rules", version: "3.1.0",
      artifact: { hash: hashV1, size: bytesV1.byteLength, name: "Probe Rules" },
    });
    await flushMicrotasks();
    const imports: string[] = [];
    const player = await h.addPlayer("rex-key", {
      importModule: async (source: string) => { imports.push(source); return err("must not be reached"); },
    });
    await until(() => lastState(player) === "pending", "prompt");
    await player.rules.allow();
    await until(() => lastState(player) === "failed", "integrity failure");
    const failed = player.statuses[player.statuses.length - 1];
    if (failed?.state !== "failed") throw new Error("unreachable");
    expect(failed.error).toMatch(/integrity/);
    expect(imports).toEqual([]);
    expect(player.rules.module).toBeNull();
    player.rules.dispose();
  });

  test("a module that fails the RulesModule shape gate is reported, not run", async () => {
    const h = await setup();
    await h.announce("export default { schema: { version: '9' } };");
    const player = await h.addPlayer("rex-key");
    await until(() => lastState(player) === "pending", "prompt");
    await player.rules.allow();
    await until(() => lastState(player) === "failed", "shape failure");
    expect(player.rules.module).toBeNull();
    player.rules.dispose();
  });
});

const UI_JS = "export default { api: 'arena.ui/1', components: { battleAnalysis: function BattleAnalysis() {} } };";
const UI_JS_V2 = UI_JS.replace("BattleAnalysis()", "BattleAnalysisV2()");
const offerOf = (player: Player): PlayerRulesOffer => {
  const status = player.statuses[player.statuses.length - 1];
  if (!status || status.state === "none") throw new Error("no offer yet");
  return status.offer;
};

describe("D-475 — the package's window components travel as a second artifact under the same consent", () => {
  test("one prompt covers rules + ui; both are fetched and verified after allow; the components reach the shell", async () => {
    const h = await setup();
    const { hash, uiHash } = await h.announceWithUi(RULES_JS, UI_JS);
    const player = await h.addPlayer("rex-key");
    await until(() => lastState(player) === "pending", "prompt");
    // The offer sizes the whole download and names the UI hash the decision will cover.
    expect(offerOf(player)).toMatchObject({ hash, uiHash, size: encode(RULES_JS).byteLength + encode(UI_JS).byteLength, firstParty: false });
    expect(player.fetchCalls).toEqual([]);
    await player.rules.allow();
    await until(() => lastState(player) === "ready", "load");
    expect(player.fetchCalls).toEqual([hash, uiHash]);
    expect(must(player.rules.module).schema.version).toBe("3.1.0");
    expect(must(player.rules.ui).components.battleAnalysis).toBeTypeOf("function");
    expect((await getSetting(player.db, playerRulesConsentScope(h.worldId), "probe-rules"))?.value).toEqual({ hash, uiHash, decision: "allow", at: 1_700_000_000_000 });
    player.rules.dispose();

    // Reconnect with the same pair: remembered, no prompt, no second transfer of either file.
    const again = await h.addPlayer("rex-key");
    await until(() => lastState(again) === "ready", "remembered");
    expect(again.statuses.map((status) => status.state)).toEqual(["loading", "ready"]);
    expect(again.fetchCalls).toEqual([hash, uiHash]); // a fresh cache fetches, but nobody was asked
    expect(must(again.rules.ui).components.battleAnalysis).toBeTypeOf("function");

    // A new UI build beside the same rules is an update: it asks again, the components it has
    // not been allowed are withheld, and the rules — the exact hash this device did allow — keep running.
    const next = await h.announceWithUi(RULES_JS, UI_JS_V2);
    expect(next.hash).toBe(hash);
    expect(next.uiHash).not.toBe(uiHash);
    await until(() => lastState(again) === "pending", "re-prompt for the ui change");
    expect(offerOf(again)).toMatchObject({ hash, uiHash: next.uiHash, updated: true });
    expect(must(again.rules.module).schema.version).toBe("3.1.0");
    expect(again.rules.ui).toBeNull();
    await again.rules.allow();
    await until(() => lastState(again) === "ready", "load the new pair");
    expect(again.fetchCalls).toEqual([hash, uiHash, hash, next.uiHash]); // rules re-read from this player's cache
    expect(must(again.rules.ui).components.battleAnalysis?.name).toBe("BattleAnalysisV2");
    again.rules.dispose();
  });

  test("a ui.js that fails its gate leaves the rules running and names the error; a first-party pair needs both hashes trusted", async () => {
    const h = await setup();
    const { hash, uiHash } = await h.announceWithUi(RULES_JS, "export default { api: 'arena.ui/1', components: { battleAnalysis: 42 } };");
    const player = await h.addPlayer("rex-key");
    await until(() => lastState(player) === "pending", "prompt");
    await player.rules.allow();
    await until(() => lastState(player) === "ready", "rules ready despite the ui");
    const ready = player.statuses[player.statuses.length - 1];
    if (ready?.state !== "ready") throw new Error("unreachable");
    expect(ready.uiError).toContain("battleAnalysis");
    expect(must(player.rules.module).schema.version).toBe("3.1.0");
    expect(player.rules.ui).toBeNull();
    player.rules.dispose();

    // D-473 trust is per artifact: a build that lists the rules hash but not the ui hash (a
    // tampered or foreign ui.js beside a genuine rules.js) is a stranger, so it prompts.
    const half = await h.addPlayer("rex-key", { trusted: (candidate) => candidate === hash });
    await until(() => lastState(half) === "ready", "the remembered allow still covers this exact pair");
    expect(offerOf(half).firstParty).toBe(false);
    half.rules.dispose();
    const fresh = await h.announceWithUi(RULES_JS_V2, UI_JS);
    const halfFresh = await h.addPlayer("rex-key", { trusted: (candidate) => candidate === fresh.hash });
    await until(() => lastState(halfFresh) === "pending", "prompt when only the rules hash is first-party");
    expect(offerOf(halfFresh)).toMatchObject({ firstParty: false, hash: fresh.hash, uiHash: fresh.uiHash, updated: true });
    halfFresh.rules.dispose();
    const both = await h.addPlayer("rex-key", { trusted: (candidate) => candidate === fresh.hash || candidate === fresh.uiHash });
    await until(() => lastState(both) === "ready", "silent load of a fully first-party pair");
    expect(both.statuses.map((status) => status.state)).toEqual(["loading", "ready"]);
    expect(offerOf(both).firstParty).toBe(true);
    expect(must(both.rules.ui).components.battleAnalysis).toBeTypeOf("function");
    // The build's trust writes nothing: the only row is the first player's explicit allow of the old pair.
    expect((await getSetting(both.db, playerRulesConsentScope(h.worldId), "probe-rules"))?.value).toMatchObject({ hash, uiHash, decision: "allow" });
    both.rules.dispose();
  });
});
