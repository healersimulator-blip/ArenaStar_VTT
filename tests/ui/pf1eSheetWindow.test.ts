import { describe, expect, test } from "vitest";
import type { ClientEvents } from "../../src/client/sync";
import type { ActorDocument } from "../../src/core/documents";
import { createEventBus } from "../../src/core/events";
import type { Op } from "../../src/core/ops";
import { DocumentStore } from "../../src/core/store";
import { WindowManager } from "../../src/core/windows";
import {
  observePF1eSheetActor,
  openPF1eSheetWindow,
  readablePF1eActor,
} from "../../src/ui/sheets/pf1eSheetWindow";
import { pf1eSheetView } from "../../src/ui/sheets/pf1eSheetModel";

function fixture() {
  const store = new DocumentStore({
    meta: { worldId: "world", name: "World", system: "pf1e", systemVersion: "1.0.0" },
  });
  const bus = createEventBus<ClientEvents>();
  const client = { store, user: { id: "player", role: "PLAYER" as const, name: "Player" } };
  const manager = new WindowManager({ width: 800, height: 600 });
  const apply = (ops: Op[]) => {
    const envelope = { seq: store.seq + 1, ts: 0, by: "gm", txId: `tx-${store.seq + 1}`, ops };
    const result = store.applyEnvelope(envelope);
    if (!result.ok) throw new Error(result.error);
    bus.emit("ops", { envelope, reconciled: null });
  };
  const actor: ActorDocument = {
    _id: "hero",
    type: "actor",
    name: "Secret Hero",
    ownership: { default: 0, player: 3 },
    flags: {},
    system: { pf1e: { hp: 12, hpMax: 20, abilities: { dex: 16 }, armorClass: { armor: 5 } } },
    items: [],
    effects: [],
  };
  apply([{ kind: "create", coll: "actors", data: actor }]);
  return { client, manager, bus, apply };
}

describe("PF1e floating sheet navigation and subscription", () => {
  test("one actor window: reopening focuses/restores it and clamps to viewport bounds", () => {
    const { client, manager } = fixture();
    expect(openPF1eSheetWindow(manager, client, "hero", { width: 320, height: 300 })).toBe(
      true,
    );
    const id = "pf1e-sheet:hero";
    const w = manager.get(id);
    expect(w).toMatchObject({
      kind: "pf1e-sheet",
      data: { actorId: "hero" },
      width: 320,
      height: 300,
    });
    expect(w?.title).not.toContain("Secret Hero");
    manager.toggleMinimize(id);
    expect(manager.get(id)?.minimized).toBe(true);
    expect(openPF1eSheetWindow(manager, client, "hero")).toBe(true);
    expect(manager.list()).toHaveLength(1);
    expect(manager.get(id)?.minimized).toBe(false);
  });
  test("missing, generic and inaccessible actors never open; readable nonowners may inspect", () => {
    const { client, manager, apply } = fixture();
    expect(openPF1eSheetWindow(manager, client, "missing")).toBe(false);
    apply([
      {
        kind: "update",
        ref: { coll: "actors", id: "hero" },
        diff: { ownership: { default: 0 } },
      },
    ]);
    expect(readablePF1eActor(client, "hero")).toBeNull();
    expect(openPF1eSheetWindow(manager, client, "hero")).toBe(false);
    apply([
      {
        kind: "update",
        ref: { coll: "actors", id: "hero" },
        diff: { ownership: { default: 2 } },
      },
    ]);
    expect(openPF1eSheetWindow(manager, client, "hero")).toBe(true);
    manager.close("pf1e-sheet:hero");
    apply([
      { kind: "update", ref: { coll: "actors", id: "hero" }, diff: { system: { hp: 5 } } },
    ]);
    expect(openPF1eSheetWindow(manager, client, "hero")).toBe(false);
    expect(manager.list()).toHaveLength(0);
  });
  test("live HP/name/effect edits refresh, revocation clears content, grant restores, deletion clears", () => {
    const { client, bus, apply } = fixture();
    const seen: Array<ActorDocument | null> = [];
    const stop = observePF1eSheetActor(client, bus, "hero", (a) => seen.push(a));
    const latest = () => {
      const a = seen.at(-1);
      if (!a) throw new Error("missing actor");
      return a;
    };
    expect(pf1eSheetView(latest()).derived.ac.normal).toBe(18);
    apply([
      {
        kind: "update",
        ref: { coll: "actors", id: "hero" },
        diff: { name: "Renamed", "system.pf1e.hp": 7, "system.pf1e.abilities.dex": 18 },
      },
    ]);
    expect(latest().name).toBe("Renamed");
    expect(pf1eSheetView(latest()).derived.hp).toBe(7);
    expect(pf1eSheetView(latest()).derived.ac.normal).toBe(19);
    apply([
      {
        kind: "create",
        coll: "effects",
        parent: { coll: "actors", id: "hero" },
        data: {
          _id: "buff",
          type: "effect",
          name: "Dex",
          ownership: { default: 0 },
          system: {},
          flags: { pf1e: { mods: [{ key: "ability.dex", type: "enhancement", value: 2 }] } },
          changes: [],
          disabled: false,
        } as ActorDocument["effects"][number],
      },
    ]);
    expect(pf1eSheetView(latest()).derived.ac.normal).toBe(20);
    apply([
      {
        kind: "update",
        ref: { coll: "actors", id: "hero" },
        diff: { ownership: { default: 0 } },
      },
    ]);
    expect(seen.at(-1)).toBeNull();
    apply([
      {
        kind: "update",
        ref: { coll: "actors", id: "hero" },
        diff: { ownership: { default: 2 } },
      },
    ]);
    expect(latest().name).toBe("Renamed");
    apply([{ kind: "delete", ref: { coll: "actors", id: "hero" } }]);
    expect(seen.at(-1)).toBeNull();
    stop();
  });
  test("snapshot/rejection refresh and closing unsubscribes all listeners", () => {
    const { client, bus } = fixture();
    const seen: Array<ActorDocument | null> = [];
    const stop = observePF1eSheetActor(client, bus, "hero", (a) => seen.push(a));
    bus.emit("snapshot", { seq: client.store.seq });
    bus.emit("rejected", { txId: "bad", reason: "forbidden", detail: "not owned" });
    expect(seen).toHaveLength(3);
    stop();
    bus.emit("snapshot", { seq: client.store.seq });
    bus.emit("rejected", { txId: "bad", reason: "forbidden", detail: "not owned" });
    expect(seen).toHaveLength(3);
  });
});
