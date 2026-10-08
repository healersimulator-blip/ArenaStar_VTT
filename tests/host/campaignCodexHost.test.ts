/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, test } from "vitest";
import { gmSessionUser, HostSync, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus } from "../../src/core/events";
import {
  DocumentStore,
  OpLog,
  UndoStack,
  type StoreMeta,
} from "../../src/core";
import type { OpEnvelope } from "../../src/core/ops";
import { planCodexBundleImport, type CodexContentBundle } from "../../src/core/campaignCodexBundle";
import type {
  ActorDocument,
  BaseDocument,
  CodexSheet,
  JournalDocument,
  JournalPageDocument,
  ItemDocument,
  Json,
  UserDocument,
} from "../../src/core/documents";

const meta: StoreMeta = {
  worldId: "codex-world",
  name: "Codex World",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};
const gmId = "codex-gm";
const playerId = "codex-player";

function page(id: string, audience: "inherit" | "gmOnly"): JournalPageDocument {
  return {
    _id: id,
    type: "page",
    name: id,
    ownership: { default: 3 },
    flags: {},
    system: {},
    text: `Page ${id}`,
    src: null,
    codex: { tabKey: "info", audience: { kind: audience } },
  };
}

function codexOf(journal: JournalDocument): CodexSheet {
  if (!journal.codex) throw new Error("Expected a Codex journal");
  return journal.codex;
}

function journalDoc(): JournalDocument {
  return {
    _id: "host-codex",
    type: "journal",
    name: "Host Codex",
    ownership: { default: 3 },
    flags: {},
    system: {},
    pages: [page("page-public", "inherit"), page("page-private", "gmOnly")],
    codex: {
      version: 1,
      kind: "entry",
      tabs: [
        { key: "info", label: "Info", order: 0, audience: { kind: "inherit" } },
      ],
      links: [],
      widgets: [],
      quests: [
        {
          id: "quest-public",
          title: "Visible",
          description: "",
          state: "active",
          pinned: true,
          order: 0,
          audience: { kind: "inherit" },
          objectives: [
            {
              id: "obj-visible",
              title: "First",
              completed: false,
              order: 0,
              audience: { kind: "inherit" },
              children: [],
            },
            {
              id: "obj-hidden",
              title: "Secret",
              completed: false,
              order: 1,
              audience: { kind: "gmOnly" },
              children: [],
            },
          ],
        },
        {
          id: "quest-private",
          title: "Not for players",
          description: "",
          state: "active",
          pinned: false,
          order: 1,
          audience: { kind: "gmOnly" },
          objectives: [],
        },
      ],
    },
  };
}

function userDoc(
  id: string,
  name: string,
  role: UserDocument["role"],
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
    color: "#fff",
  };
}

async function harness(additionalPlayerIds: string[] = []) {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const bus = createEventBus<HostEvents>();
  const host = new HostSync({
    store,
    log,
    undo,
    bus,
    systemUserId: gmId,
    roomId: "codex-room",
    verifyHelloSig: async (hello) => hello.sig === "valid",
  });
  const seeds: OpEnvelope[] = [
    {
      seq: 1,
      ts: 0,
      by: gmId,
      txId: "codex-seed",
      ops: [
        userDoc(gmId, "GM", "GM"),
        userDoc(playerId, "Player", "PLAYER"),
        ...additionalPlayerIds.map((id, index) =>
          userDoc(id, `Player ${index + 2}`, "PLAYER"),
        ),
      ].map((data) => ({ kind: "create" as const, coll: "users" as const, data: data as BaseDocument })),
    },
  ];
  for (const envelope of seeds) {
    const applied = store.applyEnvelope(envelope);
    if (!applied.ok) throw new Error(applied.error);
    log.append(envelope, applied.value.inverses);
    undo.push(envelope, applied.value.inverses);
  }
  const gmPair = createTransportPair();
  host.addSession("codex-gm-peer", gmPair.a, gmSessionUser(gmId));
  const gmBus = createEventBus<ClientEvents>();
  const gm = new ClientSync({ transport: gmPair.b, bus: gmBus, meta });
  await flushMicrotasks();
  const playerPair = createTransportPair();
  host.addSession("codex-player-peer", playerPair.a, {
    id: playerId,
    role: "PLAYER",
    name: "Player",
  });
  const playerBus = createEventBus<ClientEvents>();
  const player = new ClientSync({
    transport: playerPair.b,
    bus: playerBus,
    meta,
  });
  await flushMicrotasks();
  return { host, store, gm, gmBus, player, playerBus };
}

async function addPlayerClient(host: HostSync, id: string, name: string) {
  const pair = createTransportPair();
  host.addSession(`codex-${id}-peer`, pair.a, { id, role: "PLAYER", name });
  const bus = createEventBus<ClientEvents>();
  const client = new ClientSync({ transport: pair.b, bus, meta });
  await flushMicrotasks();
  return { client, bus };
}

describe("Campaign Codex host authorization and live projection", () => {
  test("applies a selected-bundle import as one remapped host transaction", async () => {
    const h = await harness();
    const sourceRoot = journalDoc();
    sourceRoot._id = "bundle-source-root";
    sourceRoot.name = "Bundle Root";
    sourceRoot.pages[0]!._id = "bundle-root-page";
    const sourceChild = journalDoc();
    sourceChild._id = "bundle-source-child";
    sourceChild.name = "Bundle Child";
    sourceChild.pages[0]!._id = "bundle-child-page";
    codexOf(sourceRoot).links.push({ id: "bundle-child-link", relation: "relatedTo",
      target: { coll: "journals", id: sourceChild._id } });
    const bundle: CodexContentBundle = {
      format: "arenastar-codex-bundle", version: 1,
      roots: [{ coll: "journals", id: sourceRoot._id }],
      documents: { journals: [sourceRoot, sourceChild], actors: [], items: [], scenes: [], rollTables: [] },
      assets: {},
      report: { included: { journals: 2, actors: 0, items: 0, scenes: 0, rollTables: 0 }, omittedMedia: 0,
        hasUnavailableDependencies: false, hasPortablePermissionResets: false },
    };
    let generated = 0;
    const plan = planCodexBundleImport(bundle, h.store.world, {}, () => `bundle-import-${++generated}`);
    expect(plan.ready).toBe(true);
    expect(plan.ops).toHaveLength(2);
    const rootOp = plan.ops.find((op) => op.kind === "create" && op.data.name === "Bundle Root");
    const childOp = plan.ops.find((op) => op.kind === "create" && op.data.name === "Bundle Child");
    expect(rootOp?.kind).toBe("create");
    expect(childOp?.kind).toBe("create");
    if (rootOp?.kind !== "create" || childOp?.kind !== "create") throw new Error("Expected both imported journals");
    const importedRootId = rootOp.data._id;
    const importedChildId = childOp.data._id;
    expect((rootOp.data as JournalDocument).codex?.links[0]?.target.id).toBe(importedChildId);

    const seqBefore = h.store.seq;
    h.gm.submit(plan.ops);
    await flushMicrotasks();

    expect(h.store.seq).toBe(seqBefore + 1);
    const savedRoot = h.store.get("journals", importedRootId) as JournalDocument;
    expect(savedRoot.codex?.links[0]?.target.id).toBe(importedChildId);
    expect(h.store.get("journals", importedChildId)?.name).toBe("Bundle Child");
    const deliveredRoot = h.player.store.get("journals", importedRootId) as JournalDocument;
    expect(deliveredRoot.codex?.links[0]?.target.id).toBe(importedChildId);
    expect(h.player.store.get("journals", importedChildId)?.name).toBe("Bundle Child");
  });

  test("validates and commits a Codex sheet with newly created dependency targets in one atomic batch", async () => {
    const h = await harness();
    const actor: ActorDocument = {
      _id: "same-batch-actor", type: "actor", name: "New contact", ownership: { default: 1 },
      flags: {}, system: {}, items: [], effects: [],
    };
    const base = journalDoc();
    const journal: JournalDocument = {
      ...base,
      _id: "same-batch-codex",
      codex: { ...codexOf(base), links: [{ id: "new-contact", relation: "representsActor",
        target: { coll: "actors", id: actor._id } }] },
    };
    h.gm.submit([
      { kind: "create", coll: "actors", data: actor },
      { kind: "create", coll: "journals", data: journal },
    ]);
    await flushMicrotasks();
    expect(h.store.get("actors", actor._id)).toBeDefined();
    expect(h.store.get("journals", journal._id)?.codex?.links[0]?.target.id).toBe(actor._id);
    expect((h.player.store.get("journals", journal._id) as JournalDocument).codex?.links).toHaveLength(1);
  });

  test("filters GM-only gallery asset ids from live Codex delivery and the player manifest", async () => {
    const h = await harness();
    const visibleAsset = "a".repeat(64);
    const privateAsset = "b".repeat(64);
    h.store.world.assetManifest[visibleAsset] = { name: "shared.webp", mime: "image/webp", size: 8, chunks: 1,
      visibility: "referenced", exportRights: "granted" };
    h.store.world.assetManifest[privateAsset] = { name: "gm.webp", mime: "image/webp", size: 8, chunks: 1,
      visibility: "gm", exportRights: "restricted" };
    const base = journalDoc();
    const journal: JournalDocument = {
      ...base,
      _id: "gallery-live",
      codex: { ...codexOf(base), widgets: [{ id: "gallery", type: "image-gallery", version: 1,
        tab: "info", order: 0, enabled: true, audience: { kind: "inherit" },
        config: { images: [{ assetId: visibleAsset }, { assetId: privateAsset }] } }] },
    };
    h.gm.submit([{ kind: "create", coll: "journals", data: journal }]);
    await flushMicrotasks();
    const delivered = h.player.store.get("journals", journal._id) as JournalDocument;
    expect(delivered.codex?.widgets[0]?.config).toEqual({ images: [{ assetId: visibleAsset }] });
    expect(h.player.store.world.assetManifest[visibleAsset]).toBeDefined();
    expect(h.player.store.world.assetManifest[privateAsset]).toBeUndefined();
  });

  test("protects create/update/delete and replicates page audience grant/revoke plus nested privacy", async () => {
    const h = await harness();
    const rejected: ClientEvents["rejected"][] = [];
    const gmRejected: ClientEvents["rejected"][] = [];
    h.playerBus.on("rejected", (message) => rejected.push(message));
    h.gmBus.on("rejected", (message) => gmRejected.push(message));
    const journal = journalDoc();
    h.gm.submit([{ kind: "create", coll: "journals", data: journal }]);
    await flushMicrotasks();
    expect(h.store.get("journals", journal._id)).toEqual(journal);
    const projected = h.player.store.get(
      "journals",
      journal._id,
    ) as JournalDocument;
    expect(projected.pages.map((item) => item._id)).toEqual(["page-public"]);
    expect(projected.codex?.quests?.map((quest) => quest.id)).toEqual([
      "quest-public",
    ]);
    expect(
      projected.codex?.quests?.[0]?.objectives.map((objective) => objective.id),
    ).toEqual(["obj-visible"]);
    expect(projected.codex?.tabs?.map((tab) => tab.key)).toEqual(["info"]);

    const actor: ActorDocument = {
      _id: "linked-actor",
      type: "actor",
      name: "Visible actor",
      ownership: { default: 3 },
      flags: {},
      system: {},
      items: [],
      effects: [],
    };
    h.gm.submit([{ kind: "create", coll: "actors", data: actor }]);
    await flushMicrotasks();
    const withLink = {
      ...codexOf(journal),
      links: [
        {
          id: "actor-link",
          relation: "representsActor" as const,
          target: { coll: "actors" as const, id: actor._id },
        },
      ],
    };
    h.gm.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: journal._id },
        diff: { codex: withLink as unknown as Json },
      },
    ]);
    await flushMicrotasks();
    const liveProjected = h.player.store.get(
      "journals",
      journal._id,
    ) as JournalDocument;
    expect(liveProjected.codex?.links.map((link) => link.id)).toEqual([
      "actor-link",
    ]);
    expect(JSON.stringify(liveProjected)).not.toContain("Not for players");
    expect(JSON.stringify(liveProjected)).not.toContain("Secret");
    h.gm.submit([{ kind: "delete", ref: { coll: "actors", id: actor._id } }]);
    await flushMicrotasks();
    expect(gmRejected.at(-1)?.reason).toBe("invalid_schema");
    expect(h.store.get("actors", actor._id)).toBeDefined();
    h.gm.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: journal._id },
        diff: { codex: { ...withLink, links: [] } as unknown as Json },
      },
      { kind: "delete", ref: { coll: "actors", id: actor._id } },
    ]);
    await flushMicrotasks();
    expect(h.store.get("actors", actor._id)).toBeUndefined();
    expect(
      (h.player.store.get("journals", journal._id) as JournalDocument).codex
        ?.links,
    ).toEqual([]);

    const forged = { ...journal, _id: "player-codex" };
    h.player.submit([{ kind: "create", coll: "journals", data: forged }]);
    await flushMicrotasks();
    expect(h.store.get("journals", forged._id)).toBeUndefined();
    expect(rejected.at(-1)?.reason).toBe("forbidden");

    h.player.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: journal._id },
        diff: {
          codex: { ...codexOf(journal), subtitle: "forged" } as unknown as Json,
        },
      },
    ]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    h.player.submit([
      {
        kind: "update",
        ref: {
          coll: "pages",
          id: "page-public",
          parent: { coll: "journals", id: journal._id },
        },
        diff: { text: "forged page text" },
      },
    ]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    h.player.submit([
      { kind: "delete", ref: { coll: "journals", id: journal._id } },
    ]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect(h.store.get("journals", journal._id)).toBeDefined();

    // A GM grant for an embedded page becomes a sanitized create; revoke removes it from the replica.
    const privateRef = {
      coll: "pages",
      id: "page-private",
      parent: { coll: "journals", id: journal._id },
    } as const;
    h.gm.submit([
      {
        kind: "update",
        ref: privateRef,
        diff: { codex: { tabKey: "info", audience: { kind: "inherit" } } },
      },
    ]);
    await flushMicrotasks();
    expect(
      (
        h.player.store.get("journals", journal._id) as JournalDocument
      ).pages.map((item) => item._id),
    ).toEqual(["page-public", "page-private"]);
    h.gm.submit([
      {
        kind: "update",
        ref: privateRef,
        diff: { codex: { tabKey: "info", audience: { kind: "gmOnly" } } },
      },
    ]);
    await flushMicrotasks();
    expect(
      (
        h.player.store.get("journals", journal._id) as JournalDocument
      ).pages.map((item) => item._id),
    ).toEqual(["page-public"]);
    expect(h.store.get("journals", journal._id)).toMatchObject({
      pages: [{ _id: "page-public" }, { _id: "page-private" }],
    });
    h.gm.submit([{
      kind: "update",
      ref: privateRef,
      diff: { codex: { tabKey: "info", audience: { kind: "selectedUsers", userIds: [playerId] } } as unknown as Json },
    }]);
    await flushMicrotasks();
    expect((h.player.store.get("journals", journal._id) as JournalDocument).pages.map((item) => item._id)).toContain("page-private");
    h.gm.submit([{
      kind: "update",
      ref: privateRef,
      diff: { codex: { tabKey: "info", audience: { kind: "selectedUsers", userIds: ["not-a-world-user"] } } as unknown as Json },
    }]);
    await flushMicrotasks();
    expect(gmRejected.at(-1)?.reason).toBe("invalid_schema");
    expect((h.store.get("journals", journal._id) as JournalDocument).pages.find((item) => item._id === "page-private")?.codex?.audience).toEqual({ kind: "selectedUsers", userIds: [playerId] });

    // A newly attached malformed relation is rejected by authoritative reference validation.
    h.gm.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: journal._id },
        diff: {
          codex: {
            ...codexOf(journal),
            links: [
              {
                id: "bad-link",
                relation: "representsActor",
                target: { coll: "scenes", id: "missing" },
              },
            ],
          } as unknown as Json,
        },
      },
    ]);
    await flushMicrotasks();
    expect(h.store.get("journals", journal._id)?.codex?.links).toEqual([]);
  });

  test("commits PF1e shop purchases atomically, deduplicates retries, and supports GM Revert", async () => {
    const h = await harness();
    const item: ItemDocument = {
      _id: "codex-potion",
      type: "item",
      name: "Healing potion",
      ownership: { default: 3 },
      flags: {},
      system: { value: 1.5, quantity: 1 },
      effects: [],
    };
    const actor: ActorDocument = {
      _id: "buyer",
      type: "actor",
      name: "Player hero",
      ownership: { default: 0, [playerId]: 3 },
      flags: {},
      system: { pf1e: { currency: { pp: 0, gp: 10, sp: 0, cp: 0 } } },
      items: [],
      effects: [],
    };
    const underfundedActor: ActorDocument = {
      ...actor,
      _id: "underfunded-buyer",
      name: "Broke hero",
      system: { pf1e: { currency: { pp: 0, gp: 0, sp: 0, cp: 0 } } },
    };
    const unauthorizedActor: ActorDocument = {
      ...actor,
      _id: "foreign-buyer",
      name: "Someone else's hero",
      ownership: { default: 0 },
    };
    const fullStack: ItemDocument = {
      ...item,
      _id: "full-stack-potion",
      flags: { pf1e: { codexImportedFrom: item._id } },
      system: { quantity: 1_000_000_000 },
    };
    const fullStackActor: ActorDocument = {
      ...actor,
      _id: "full-stack-buyer",
      name: "Full inventory",
      items: [fullStack],
    };
    h.gm.submit([{ kind: "create", coll: "items", data: item }]);
    h.gm.submit([
      { kind: "create", coll: "actors", data: actor },
      { kind: "create", coll: "actors", data: underfundedActor },
      { kind: "create", coll: "actors", data: unauthorizedActor },
      { kind: "create", coll: "actors", data: fullStackActor },
    ]);
    await flushMicrotasks();
    const base = journalDoc();
    const journal: JournalDocument = {
      ...base,
      codex: {
        ...codexOf(base),
        shop: {
          mode: "shop",
          currencyLabel: "gp",
          markup: 2,
          audience: { kind: "inherit" },
          stock: [{ id: "potion-stock", item: { coll: "items", id: item._id }, quantity: 3, unitPrice: "1.50", order: 0 }],
        },
      },
    };
    h.gm.submit([{ kind: "create", coll: "journals", data: journal }]);
    await flushMicrotasks();
    const results: ClientEvents["codexPurchaseResult"][] = [];
    h.playerBus.on("codexPurchaseResult", (result) => results.push(result));
    const requestId = "codex-purchase-retry";
    h.player.requestCodexPurchase(journal._id, "potion-stock", 2, actor._id, requestId);
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({
      action: "purchase",
      ok: true,
      receiptId: `codexpurchase_${requestId}`,
      totalCopper: 600,
    });
    expect(results.at(-1)).not.toHaveProperty("replayed");
    expect(h.store.get("actors", actor._id)?.system.pf1e).toMatchObject({ currency: { pp: 0, gp: 4, sp: 0, cp: 0 } });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(1);
    expect(h.store.get("actors", actor._id)?.items[0]?.system.quantity).toBe(2);
    expect(h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity).toBe(1);

    h.player.requestCodexPurchase(journal._id, "potion-stock", 1, underfundedActor._id, "underfunded-purchase");
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "purchase", ok: false, detail: "There are not enough funds for this purchase." });
    expect(h.store.get("actors", underfundedActor._id)?.system.pf1e).toMatchObject({ currency: { pp: 0, gp: 0, sp: 0, cp: 0 } });
    expect(h.store.get("actors", underfundedActor._id)?.items).toHaveLength(0);
    expect(h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity).toBe(1);

    h.player.requestCodexPurchase(journal._id, "potion-stock", 1, fullStackActor._id, "full-stack-purchase");
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "purchase", ok: false, detail: "The matching inventory stack has an unsupported quantity." });
    expect(h.store.get("actors", fullStackActor._id)?.system.pf1e).toMatchObject({ currency: { pp: 0, gp: 10, sp: 0, cp: 0 } });
    expect(h.store.get("actors", fullStackActor._id)?.items[0]?.system.quantity).toBe(1_000_000_000);
    expect(h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity).toBe(1);

    h.player.requestCodexPurchase(journal._id, "potion-stock", 1, unauthorizedActor._id, "foreign-purchase");
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "purchase", ok: false });
    h.player.requestCodexPurchase(journal._id, "potion-stock", 1, "missing-purchase-actor", "missing-purchase-actor");
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "purchase", ok: false });
    h.player.requestCodexPurchase(journal._id, "potion-stock", 2, actor._id, "depleted-purchase");
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "purchase", ok: false, detail: "There is not enough stock for that quantity." });
    expect(h.store.get("actors", actor._id)?.system.pf1e).toMatchObject({ currency: { pp: 0, gp: 4, sp: 0, cp: 0 } });
    expect(h.store.get("actors", actor._id)?.items[0]?.system.quantity).toBe(2);
    expect(h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity).toBe(1);

    h.player.requestCodexPurchase(journal._id, "potion-stock", 2, actor._id, requestId);
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({
      action: "purchase",
      ok: true,
      receiptId: `codexpurchase_${requestId}`,
      replayed: true,
      totalCopper: 600,
    });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(1);
    expect(h.store.get("actors", actor._id)?.items[0]?.system.quantity).toBe(2);

    const receipt = h.store.getAll("actionReceipts").find((candidate) =>
      candidate.system.requestId === requestId,
    );
    if (!receipt) throw new Error("Expected durable Codex purchase receipt");
    h.gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(h.store.get("actors", actor._id)?.system.pf1e).toMatchObject({ currency: { pp: 0, gp: 10, sp: 0, cp: 0 } });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(0);
    expect(h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity).toBe(3);
    expect(h.store.get("actionReceipts", receipt._id)?.status).toBe("reverted");

    h.player.requestCodexPurchase(journal._id, "potion-stock", 2, actor._id, requestId);
    await flushMicrotasks();
    expect(results.at(-1)?.ok).toBe(false);
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(0);

    h.gm.submit([{
      kind: "update",
      ref: { coll: "journals", id: journal._id },
      diff: { "codex.shop.audience": { kind: "gmOnly" } as unknown as Json },
    }]);
    await flushMicrotasks();
    h.player.requestCodexPurchase(journal._id, "potion-stock", 1, actor._id, "revoked-shop-purchase");
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "purchase", ok: false, detail: "This shop is unavailable." });
    expect(h.store.get("actors", actor._id)?.system.pf1e).toMatchObject({ currency: { pp: 0, gp: 10, sp: 0, cp: 0 } });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(0);
    expect(h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity).toBe(3);

    // Even a stale request sent after the GM removes the row and its source Item cannot write.
    h.gm.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: journal._id },
        diff: { "codex.shop.audience": { kind: "inherit" } as unknown as Json, "codex.shop.stock": [] as unknown as Json },
      },
      { kind: "delete", ref: { coll: "items", id: item._id } },
    ]);
    await flushMicrotasks();
    expect(h.store.get("items", item._id)).toBeUndefined();
    h.player.requestCodexPurchase(journal._id, "potion-stock", 1, actor._id, "deleted-source-purchase");
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "purchase", ok: false });
    expect(h.store.get("actors", actor._id)?.system.pf1e).toMatchObject({ currency: { pp: 0, gp: 10, sp: 0, cp: 0 } });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(0);
    expect(h.store.get("journals", journal._id)?.codex?.shop?.stock).toEqual([]);
    expect(h.store.get("actionReceipts", "codexpurchase_deleted-source-purchase")).toBeUndefined();
  });

  test("serializes competing player purchases so only one buyer receives the last stock unit", async () => {
    const secondPlayerId = "codex-player-two";
    const h = await harness([secondPlayerId]);
    const second = await addPlayerClient(h.host, secondPlayerId, "Second Player");
    const item: ItemDocument = {
      _id: "race-potion",
      type: "item",
      name: "Last potion",
      ownership: { default: 1 },
      flags: {},
      system: { quantity: 1, value: 2 },
      effects: [],
    };
    const firstActor: ActorDocument = {
      _id: "race-buyer-one",
      type: "actor",
      name: "First buyer",
      ownership: { default: 0, [playerId]: 3 },
      flags: {},
      system: { pf1e: { currency: { pp: 0, gp: 10, sp: 0, cp: 0 } } },
      items: [],
      effects: [],
    };
    const secondActor: ActorDocument = {
      ...firstActor,
      _id: "race-buyer-two",
      name: "Second buyer",
      ownership: { default: 0, [secondPlayerId]: 3 },
    };
    const base = journalDoc();
    const journal: JournalDocument = {
      ...base,
      _id: "race-shop",
      codex: {
        ...codexOf(base),
        shop: {
          mode: "shop",
          markup: 2,
          audience: { kind: "inherit" },
          stock: [{ id: "last-potion", item: { coll: "items", id: item._id }, quantity: 1, unitPrice: "2", order: 0 }],
        },
      },
    };
    h.gm.submit([
      { kind: "create", coll: "items", data: item },
      { kind: "create", coll: "actors", data: firstActor },
      { kind: "create", coll: "actors", data: secondActor },
      { kind: "create", coll: "journals", data: journal },
    ]);
    await flushMicrotasks();

    const firstResults: ClientEvents["codexPurchaseResult"][] = [];
    const secondResults: ClientEvents["codexPurchaseResult"][] = [];
    h.playerBus.on("codexPurchaseResult", (result) => firstResults.push(result));
    second.bus.on("codexPurchaseResult", (result) => secondResults.push(result));
    h.player.requestCodexPurchase(journal._id, "last-potion", 1, firstActor._id, "race-buy-one");
    second.client.requestCodexPurchase(journal._id, "last-potion", 1, secondActor._id, "race-buy-two");
    await flushMicrotasks();

    expect(firstResults.at(-1)).toMatchObject({ action: "purchase", requestId: "race-buy-one" });
    expect(secondResults.at(-1)).toMatchObject({ action: "purchase", requestId: "race-buy-two" });
    const outcomes = [firstResults.at(-1), secondResults.at(-1)];
    expect(outcomes.filter((result) => result?.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => result?.ok === false)).toHaveLength(1);
    expect(outcomes.find((result) => result?.ok)).toMatchObject({ ok: true, totalCopper: 400 });
    expect(outcomes.find((result) => result?.ok === false)).toMatchObject({
      ok: false,
      detail: "There is not enough stock for that quantity.",
    });

    const committedShop = h.store.get("journals", journal._id) as JournalDocument | undefined;
    expect(committedShop?.codex?.shop?.stock[0]?.quantity).toBe(0);
    const committedActors = [firstActor, secondActor].map((actor) => {
      const current = h.store.get("actors", actor._id) as ActorDocument | undefined;
      const currency = (current?.system as { pf1e?: { currency?: { gp?: number } } } | undefined)?.pf1e?.currency;
      return { gp: currency?.gp, items: current?.items.map((owned) => owned.system.quantity) ?? [] };
    });
    expect(committedActors.filter((actor) => actor.gp === 6 && actor.items[0] === 1)).toHaveLength(1);
    expect(committedActors.filter((actor) => actor.gp === 10 && actor.items.length === 0)).toHaveLength(1);
    expect(h.store.getAll("actionReceipts").filter((receipt) =>
      receipt.system.action === "codex.purchase" && receipt.system.sheetId === journal._id,
    )).toHaveLength(1);
  });

  test("commits loot claims atomically, deduplicates retries, and supports GM Revert", async () => {
    const h = await harness();
    const item: ItemDocument = {
      _id: "codex-loot-herb",
      type: "item",
      name: "Healing herb",
      ownership: { default: 3 },
      flags: { pf1e: { source: "field-cache" } },
      system: { quantity: 1 },
      effects: [],
    };
    const actor: ActorDocument = {
      _id: "loot-buyer",
      type: "actor",
      name: "Player ranger",
      ownership: { default: 0, [playerId]: 3 },
      flags: {},
      system: { pf1e: { currency: { pp: 0, gp: 7, sp: 0, cp: 0 } } },
      items: [],
      effects: [],
    };
    const unauthorizedActor: ActorDocument = {
      ...actor,
      _id: "loot-foreign-actor",
      name: "Someone else's ranger",
      ownership: { default: 0 },
    };
    const base = journalDoc();
    const journal: JournalDocument = {
      ...base,
      _id: "codex-loot-container",
      name: "Abandoned cache",
      codex: {
        ...codexOf(base),
        shop: {
          mode: "loot",
          audience: { kind: "selectedUsers", userIds: [gmId] },
          stock: [
            {
              id: "herb-stock",
              item: { coll: "items", id: item._id },
              quantity: 3,
              order: 0,
            },
          ],
        },
      },
    };
    h.gm.submit([
      { kind: "create", coll: "items", data: item },
      { kind: "create", coll: "actors", data: actor },
      { kind: "create", coll: "actors", data: unauthorizedActor },
      { kind: "create", coll: "journals", data: journal },
    ]);
    await flushMicrotasks();

    const results: ClientEvents["codexPurchaseResult"][] = [];
    h.playerBus.on("codexPurchaseResult", (result) => results.push(result));
    h.player.requestCodexClaim(
      journal._id,
      "herb-stock",
      1,
      actor._id,
      "hidden-shop-claim",
    );
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({
      action: "claim",
      ok: false,
      detail: "This loot container is unavailable.",
    });
    expect(
      h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity,
    ).toBe(3);
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(0);

    h.gm.submit([
      {
        kind: "update",
        ref: { coll: "journals", id: journal._id },
        diff: { "codex.shop.audience": { kind: "inherit" } as unknown as Json },
      },
    ]);
    await flushMicrotasks();
    h.player.requestCodexClaim(
      journal._id,
      "herb-stock",
      1,
      "missing-actor",
      "missing-actor-claim",
    );
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "claim", ok: false });
    expect(
      h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity,
    ).toBe(3);

    h.player.requestCodexClaim(
      journal._id,
      "herb-stock",
      1,
      unauthorizedActor._id,
      "foreign-claim",
    );
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "claim", ok: false });
    expect(h.store.get("actors", unauthorizedActor._id)?.items).toHaveLength(0);
    expect(
      h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity,
    ).toBe(3);

    h.player.requestCodexClaim(
      journal._id,
      "herb-stock",
      4,
      actor._id,
      "overstock-claim",
    );
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({
      action: "claim",
      ok: false,
      detail: "There is not enough stock for that quantity.",
    });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(0);
    expect(
      h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity,
    ).toBe(3);

    const requestId = "codex-loot-claim-retry";
    h.player.requestCodexClaim(
      journal._id,
      "herb-stock",
      2,
      actor._id,
      requestId,
    );
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({
      action: "claim",
      ok: true,
      detail: "Claimed 2 × Healing herb.",
    });
    expect(results.at(-1)).toHaveProperty(
      "receiptId",
      `codexclaim_${requestId}`,
    );
    expect(h.store.get("actors", actor._id)?.system.pf1e).toMatchObject({
      currency: { pp: 0, gp: 7, sp: 0, cp: 0 },
    });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(1);
    expect(h.store.get("actors", actor._id)?.items[0]).toMatchObject({
      name: "Healing herb",
      flags: { pf1e: { source: "field-cache", codexImportedFrom: item._id } },
      system: { quantity: 2 },
    });
    expect(
      h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity,
    ).toBe(1);

    h.player.requestCodexClaim(
      journal._id,
      "herb-stock",
      2,
      actor._id,
      "depleted-claim",
    );
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({
      action: "claim",
      ok: false,
      detail: "There is not enough stock for that quantity.",
    });
    expect(h.store.get("actors", actor._id)?.items[0]?.system.quantity).toBe(2);
    expect(
      h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity,
    ).toBe(1);

    h.player.requestCodexClaim(
      journal._id,
      "herb-stock",
      2,
      actor._id,
      requestId,
    );
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({
      action: "claim",
      ok: true,
      receiptId: `codexclaim_${requestId}`,
      replayed: true,
    });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(1);
    expect(h.store.get("actors", actor._id)?.items[0]?.system.quantity).toBe(2);

    const receipt = h.store
      .getAll("actionReceipts")
      .find((candidate) => candidate.system.requestId === requestId);
    if (!receipt) throw new Error("Expected durable Codex loot-claim receipt");
    h.gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(0);
    expect(h.store.get("actors", actor._id)?.system.pf1e).toMatchObject({
      currency: { pp: 0, gp: 7, sp: 0, cp: 0 },
    });
    expect(
      h.store.get("journals", journal._id)?.codex?.shop?.stock[0]?.quantity,
    ).toBe(3);
    expect(h.store.get("actionReceipts", receipt._id)?.status).toBe("reverted");

    h.player.requestCodexClaim(
      journal._id,
      "herb-stock",
      2,
      actor._id,
      requestId,
    );
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ action: "claim", ok: false });
    expect(h.store.get("actors", actor._id)?.items).toHaveLength(0);
  });
});
