import { describe, expect, test, vi } from "vitest";
import { DocumentStore, type StoreMeta } from "../../src/core/store";
import type {
  ActorDocument,
  MessageDocument,
  SceneDocument,
  TokenDocument,
  UserDocument,
} from "../../src/core/documents";
import type { Op, OpEnvelope } from "../../src/core/ops";

const meta: StoreMeta = {
  worldId: "w1",
  name: "World",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};

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
    width: 2000,
    height: 2000,
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

function tokenDoc(id: string, x = 0): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: `Token ${id}`,
    ownership: { default: 0 },
    flags: {},
    system: {},
    x,
    y: 0,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  };
}

function actorDoc(id: string): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: `Actor ${id}`,
    ownership: { default: 1 },
    flags: {},
    system: { hp: 10 },
    items: [],
    effects: [],
  };
}

function messageDoc(id: string, author: string): MessageDocument {
  return {
    _id: id,
    type: "message",
    name: `Message ${id}`,
    ownership: { default: 2 },
    flags: {},
    system: {},
    author,
    content: "hi",
    whisper: [],
    roll: null,
    flavor: "",
  };
}

function userDoc(id: string, name: string): UserDocument {
  return {
    _id: id,
    type: "user",
    name,
    ownership: { default: 0 },
    flags: {},
    system: {},
    role: "PLAYER",
    character: null,
    color: "#ff0000",
  };
}

let txCounter = 0;
function env(seq: number, ops: Op[]): OpEnvelope {
  txCounter += 1;
  return { seq, ts: 0, by: "gm-key", ops, txId: `tx-${txCounter}` };
}

const sceneRef = { coll: "scenes" as const, id: "s1" };
const tokenRef = (id: string) => ({ coll: "tokens" as const, id, parent: sceneRef });

function setup(): DocumentStore {
  const store = new DocumentStore({ meta });
  expect(
    store.applyEnvelope(env(1, [{ kind: "create", coll: "scenes", data: sceneDoc("s1") }])).ok,
  ).toBe(true);
  return store;
}

describe("DocumentStore — create/update/delete (§4)", () => {
  test("creates top-level docs and indexes them", () => {
    const store = new DocumentStore({ meta });
    const res = store.applyEnvelope(
      env(1, [{ kind: "create", coll: "users", data: userDoc("u1", "Rex") }]),
    );
    expect(res.ok).toBe(true);
    expect(store.get("users", "u1")?.name).toBe("Rex");
    expect(store.getAll("users")).toHaveLength(1);
  });

  test("rejects duplicate top-level _id without consuming seq", () => {
    const store = new DocumentStore({ meta });
    expect(
      store.applyEnvelope(env(1, [{ kind: "create", coll: "scenes", data: sceneDoc("s1") }])).ok,
    ).toBe(true);
    const dup = store.applyEnvelope(
      env(2, [{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]),
    );
    expect(dup.ok).toBe(false);
    expect(store.seq).toBe(1);
    expect(store.getAll("scenes")).toHaveLength(1);
  });

  test("creates embedded docs via parent refs (tokens in scenes)", () => {
    const store = setup();
    const res = store.applyEnvelope(
      env(2, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1", 120) }]),
    );
    expect(res.ok).toBe(true);
    const scene = store.get("scenes", "s1");
    expect(scene?.tokens).toHaveLength(1);
    expect(scene?.tokens[0]?.x).toBe(120);
    expect(store.resolve(tokenRef("t1"))?._id).toBe("t1");
  });

  test("rejects embedding into the wrong parent type", () => {
    const store = new DocumentStore({ meta });
    store.applyEnvelope(env(1, [{ kind: "create", coll: "actors", data: actorDoc("a1") }]));
    const res = store.applyEnvelope(
      env(2, [
        {
          kind: "create",
          coll: "tokens",
          parent: { coll: "actors", id: "a1" },
          data: tokenDoc("t1"),
        },
      ]),
    );
    expect(res.ok).toBe(false);
  });

  test("updates with dotted diffs, immutably", () => {
    const store = setup();
    store.applyEnvelope(
      env(2, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") }]),
    );
    const sceneBefore = store.get("scenes", "s1");
    const tokenBefore = sceneBefore?.tokens[0];
    expect(
      store.applyEnvelope(
        env(3, [{ kind: "update", ref: tokenRef("t1"), diff: { x: 500, "system.hp": 3 } }]),
      ).ok,
    ).toBe(true);
    expect(store.get("scenes", "s1")?.tokens[0]?.x).toBe(500);
    expect(store.get("scenes", "s1")?.tokens[0]?.system.hp).toBe(3);
    // old references keep the old values (immutability)
    expect(tokenBefore?.x).toBe(0);
    expect(sceneBefore?.tokens[0]?.x).toBe(0);
  });

  test("deletes embedded docs", () => {
    const store = setup();
    store.applyEnvelope(
      env(2, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") }]),
    );
    expect(store.applyEnvelope(env(3, [{ kind: "delete", ref: tokenRef("t1") }])).ok).toBe(true);
    expect(store.get("scenes", "s1")?.tokens).toHaveLength(0);
    expect(store.resolve(tokenRef("t1"))).toBeUndefined();
  });

  test("update of a missing ref fails cleanly", () => {
    const store = setup();
    const res = store.applyEnvelope(
      env(2, [{ kind: "update", ref: tokenRef("ghost"), diff: { x: 1 } }]),
    );
    expect(res.ok).toBe(false);
    expect(store.seq).toBe(1);
  });

  test("deeply embedded refs resolve (effect in item in actor)", () => {
    const store = new DocumentStore({ meta });
    const actor = actorDoc("a1");
    actor.items = [
      {
        _id: "i1",
        type: "item",
        name: "Sword",
        ownership: { default: 0 },
        flags: {},
        system: {},
        effects: [
          {
            _id: "e1",
            type: "effect",
            name: "Buff",
            ownership: { default: 0 },
            flags: {},
            system: {},
            changes: [],
            disabled: false,
          },
        ],
      },
    ];
    store.applyEnvelope(env(1, [{ kind: "create", coll: "actors", data: actor }]));
    const effectRef = {
      coll: "effects" as const,
      id: "e1",
      parent: { coll: "items" as const, id: "i1", parent: { coll: "actors" as const, id: "a1" } },
    };
    expect(store.resolve(effectRef)?.name).toBe("Buff");
    const res = store.applyEnvelope(
      env(2, [{ kind: "update", ref: effectRef, diff: { disabled: true } }]),
    );
    expect(res.ok).toBe(true);
    expect(store.get("actors", "a1")?.items[0]?.effects[0]?.disabled).toBe(true);
  });
});

describe("DocumentStore — transactions & seq (§4, §5)", () => {
  test("envelopes are all-or-nothing (D-016)", () => {
    const store = new DocumentStore({ meta });
    const res = store.applyEnvelope(
      env(1, [
        { kind: "create", coll: "users", data: userDoc("u1", "Rex") },
        { kind: "update", ref: { coll: "users", id: "ghost" }, diff: { name: "X" } },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(store.get("users", "u1")).toBeUndefined(); // rolled back
    expect(store.seq).toBe(0);
    // store still functional
    expect(
      store.applyEnvelope(env(1, [{ kind: "create", coll: "users", data: userDoc("u2", "Ivy") }]))
        .ok,
    ).toBe(true);
    expect(store.get("users", "u2")?.name).toBe("Ivy");
  });

  test("create-then-update within one envelope works", () => {
    const store = new DocumentStore({ meta });
    const res = store.applyEnvelope(
      env(1, [
        { kind: "create", coll: "users", data: userDoc("u1", "Rex") },
        { kind: "update", ref: { coll: "users", id: "u1" }, diff: { name: "Rex II" } },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(store.get("users", "u1")?.name).toBe("Rex II");
  });

  test("seq must be strictly monotonic (+1)", () => {
    const store = setup(); // seq 1
    expect(
      store.applyEnvelope(env(3, [{ kind: "update", ref: sceneRef, diff: { name: "X" } }])).ok,
    ).toBe(false);
    expect(
      store.applyEnvelope(env(1, [{ kind: "update", ref: sceneRef, diff: { name: "X" } }])).ok,
    ).toBe(false);
    expect(
      store.applyEnvelope(env(2, [{ kind: "update", ref: sceneRef, diff: { name: "X" } }])).ok,
    ).toBe(true);
  });

  test("message cap trims oldest deterministically (D-018)", () => {
    const store = new DocumentStore({ meta, messagesCap: 3 });
    for (let i = 1; i <= 5; i++) {
      expect(
        store.applyEnvelope(
          env(i, [{ kind: "create", coll: "messages", data: messageDoc(`m${i}`, "gm") }]),
        ).ok,
      ).toBe(true);
    }
    const msgs = store.getAll("messages");
    expect(msgs.map((m) => m._id)).toEqual(["m3", "m4", "m5"]);
    expect(store.get("messages", "m1")).toBeUndefined();
    expect(store.get("messages", "m5")?._id).toBe("m5");
  });
});

describe("DocumentStore — reactivity (§10)", () => {
  test("watch fires for embedded child changes with the root mapped", () => {
    const store = setup();
    const sceneSpy = vi.fn();
    const tokenSpy = vi.fn();
    store.watch(sceneRef, sceneSpy);
    store.watch(tokenRef("t1"), tokenSpy);
    store.applyEnvelope(
      env(2, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") }]),
    );
    expect(sceneSpy).toHaveBeenCalledTimes(1);
    expect(tokenSpy).toHaveBeenCalledTimes(1);
    store.applyEnvelope(env(3, [{ kind: "update", ref: tokenRef("t1"), diff: { x: 9 } }]));
    expect(sceneSpy).toHaveBeenCalledTimes(2);
    expect(tokenSpy).toHaveBeenCalledTimes(2);
    expect(tokenSpy.mock.calls[1]?.[0].root).toEqual({ coll: "scenes", id: "s1" });
  });

  test("watch does not fire for unrelated documents", () => {
    const store = setup();
    const spy = vi.fn();
    store.watch({ coll: "scenes", id: "s-other" }, spy);
    store.applyEnvelope(env(2, [{ kind: "update", ref: sceneRef, diff: { name: "renamed" } }]));
    expect(spy).not.toHaveBeenCalled();
  });

  test("watch with path is segment-aware", () => {
    const store = new DocumentStore({ meta });
    store.applyEnvelope(env(1, [{ kind: "create", coll: "actors", data: actorDoc("a1") }]));
    const hpSpy = vi.fn();
    const anySystemSpy = vi.fn();
    store.watch({ coll: "actors", id: "a1" }, hpSpy, "system.hp");
    store.watch({ coll: "actors", id: "a1" }, anySystemSpy, "system");
    store.applyEnvelope(
      env(2, [{ kind: "update", ref: { coll: "actors", id: "a1" }, diff: { "system.hpMax": 20 } }]),
    );
    expect(hpSpy).not.toHaveBeenCalled(); // hp ≠ hpMax
    expect(anySystemSpy).toHaveBeenCalledTimes(1);
    store.applyEnvelope(
      env(3, [{ kind: "update", ref: { coll: "actors", id: "a1" }, diff: { "system.hp": 7 } }]),
    );
    expect(hpSpy).toHaveBeenCalledTimes(1);
    expect(anySystemSpy).toHaveBeenCalledTimes(2);
    store.applyEnvelope(
      env(4, [{ kind: "update", ref: { coll: "actors", id: "a1" }, diff: { name: "Zug" } }]),
    );
    expect(hpSpy).toHaveBeenCalledTimes(1);
    expect(anySystemSpy).toHaveBeenCalledTimes(2);
  });

  test("path on an embedded watch addresses the child doc's fields", () => {
    const store = setup();
    store.applyEnvelope(
      env(2, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") }]),
    );
    const xSpy = vi.fn();
    store.watch(tokenRef("t1"), xSpy, "x");
    store.applyEnvelope(env(3, [{ kind: "update", ref: tokenRef("t1"), diff: { y: 5 } }]));
    expect(xSpy).not.toHaveBeenCalled();
    store.applyEnvelope(env(4, [{ kind: "update", ref: tokenRef("t1"), diff: { x: 5 } }]));
    expect(xSpy).toHaveBeenCalledTimes(1);
  });

  test("onChange fires once per envelope with the envelope", () => {
    const store = setup();
    const spy = vi.fn();
    store.onChange(spy);
    store.applyEnvelope(
      env(2, [
        { kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") },
        { kind: "update", ref: tokenRef("t1"), diff: { x: 1 } },
      ]),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].seq).toBe(2);
    expect(spy.mock.calls[0]?.[1]).toHaveLength(1); // one root touched
  });
});

describe("DocumentStore — serialize/load (§5 snapshot base)", () => {
  test("round-trips losslessly and continues applying", () => {
    const store = setup();
    store.applyEnvelope(
      env(2, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") }]),
    );
    store.applyEnvelope(env(3, [{ kind: "update", ref: tokenRef("t1"), diff: { x: 77 } }]));
    const snap = store.serialize();

    const revived = DocumentStore.load(snap);
    expect(revived.seq).toBe(3);
    expect(revived.get("scenes", "s1")?.tokens[0]?.x).toBe(77);
    expect(
      revived.applyEnvelope(env(4, [{ kind: "update", ref: tokenRef("t1"), diff: { x: 88 } }])).ok,
    ).toBe(true);
    expect(revived.get("scenes", "s1")?.tokens[0]?.x).toBe(88);
  });

  test("load tolerates partial collections (client replica)", () => {
    const store = DocumentStore.load({
      meta,
      seq: 5,
      collections: { users: [userDoc("u1", "Rex")] },
    });
    expect(store.get("users", "u1")?.name).toBe("Rex");
    expect(store.getAll("scenes")).toHaveLength(0);
    expect(store.seq).toBe(5);
  });
});
