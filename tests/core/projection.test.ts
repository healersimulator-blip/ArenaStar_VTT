import { describe, expect, test } from "vitest";
import { projectEnvelope, projectWorld, stripSecretText } from "../../src/core/projection";
import { getEffectiveOwnership } from "../../src/core/permissions";
import type {
  JournalDocument,
  MessageDocument,
  SceneDocument,
  TokenDocument,
  WorldCollections,
} from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type { ProjectionResolver } from "../../src/core/projection";
import { emptyWorld } from "../net/fixtures";

const gm: PermissionUser = { id: "gm-key", role: "GM" };
const player: PermissionUser = { id: "pl-key", role: "PLAYER" };
const other: PermissionUser = { id: "ot-key", role: "PLAYER" };

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "s1",
    type: "scene",
    name: "Field",
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
    walls: [
      {
        _id: "w1",
        type: "wall",
        name: "Wall",
        ownership: { default: 0 },
        flags: {},
        system: {},
        c: [0, 0, 100, 100],
        door: 0,
        oneWay: false,
        move: 0,
        sight: 0,
        sound: 0,
        light: 0,
      },
    ],
    lights: [
      {
        _id: "l1",
        type: "light",
        name: "Torch",
        ownership: { default: 0 },
        flags: {},
        system: {},
        x: 5,
        y: 5,
        dim: 20,
        bright: 10,
        color: "#ffaa00",
        alpha: 0.6,
      },
    ],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    ...over,
  };
}

function token(id: string, over: Partial<TokenDocument> = {}): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: `Token ${id}`,
    ownership: { default: 0 },
    flags: {},
    system: {},
    x: 0,
    y: 0,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
    ...over,
  };
}

function message(id: string, over: Partial<MessageDocument> = {}): MessageDocument {
  return {
    _id: id,
    type: "message",
    name: `Message ${id}`,
    ownership: { default: 2 },
    flags: {},
    system: {},
    author: "pl-key",
    content: "hello",
    whisper: [],
    roll: null,
    flavor: "",
    ...over,
  };
}

function journal(): JournalDocument {
  return {
    _id: "j1",
    type: "journal",
    name: "Quest",
    ownership: { default: 2 },
    flags: {},
    system: {},
    pages: [
      {
        _id: "p1",
        type: "page",
        name: "Page 1",
        ownership: { default: 2 },
        flags: {},
        system: {},
        text: "Public lore. <secret>The duke is the traitor.</secret> More public.",
        src: null,
      },
    ],
  };
}

function world(): WorldCollections {
  const w = emptyWorld();
  const s = scene({
    tokens: [
      token("t-public"),
      token("t-hidden", { hidden: true }),
      token("t-hidden-owned", { hidden: true, ownership: { default: 0, "pl-key": 3 } }),
    ],
  });
  w.scenes.push(s);
  w.actors.push(
    {
      _id: "a-visible",
      type: "actor",
      name: "Visible",
      ownership: { default: 2 },
      flags: {},
      system: {},
      items: [],
      effects: [],
    },
    {
      _id: "a-gm",
      type: "actor",
      name: "Secret NPC",
      ownership: { default: 0 },
      flags: {},
      system: {},
      items: [],
      effects: [],
    },
  );
  w.journals.push(journal());
  w.messages.push(
    message("m-public"),
    // author ot-key whispering to the GM: pl-key sees nothing, ot-key (author) does
    message("m-whisper", { author: "ot-key", whisper: ["gm-key"] }),
    // gmroll rolled by ot-key: others see the card but not the result
    message("m-gmroll", {
      author: "ot-key",
      roll: { formula: "1d20", total: 15, terms: [], seedClient: null, seedHost: null },
      rollMode: "gmroll",
    }),
    // blindroll rolled by pl-key: only GM ever sees the result (author included)
    message("m-blindroll", {
      author: "pl-key",
      roll: { formula: "1d20", total: 15, terms: [], seedClient: null, seedHost: null },
      rollMode: "blindroll",
    }),
    // selfroll rolled by ot-key: only ot-key and GM receive it at all
    message("m-selfroll", {
      author: "ot-key",
      roll: { formula: "1d20", total: 9, terms: [], seedClient: null, seedHost: null },
      rollMode: "selfroll",
    }),
  );
  return w;
}

describe("projectWorld (§5)", () => {
  test("GM receives everything unfiltered", () => {
    const w = world();
    const projected = projectWorld(w, 5, gm);
    expect(projected.collections.scenes).toBe(w.scenes);
    expect(projected.collections.actors).toHaveLength(2);
    expect(projected.collections.messages).toHaveLength(5);
  });

  test("player: hidden tokens omitted unless owner; walls/lights always sent", () => {
    const projected = projectWorld(world(), 5, player);
    const sc = projected.collections.scenes?.[0];
    expect(sc?.tokens.map((t) => t._id)).toEqual(["t-public", "t-hidden-owned"]);
    expect(sc?.walls).toHaveLength(1);
    expect(sc?.lights).toHaveLength(1);
  });

  test("player: docs with effective ownership < LIMITED omitted", () => {
    const projected = projectWorld(world(), 5, player);
    expect(projected.collections.actors?.map((a) => a._id)).toEqual(["a-visible"]);
  });

  test("player: <secret> blocks stripped from journal pages; GM keeps them", () => {
    const projected = projectWorld(world(), 5, player);
    const page = projected.collections.journals?.[0]?.pages[0];
    expect(page?.text).not.toContain("traitor");
    expect(page?.text).toContain("Public lore.");

    const gmView = projectWorld(world(), 5, gm);
    expect(gmView.collections.journals?.[0]?.pages[0]?.text).toContain("traitor");
  });

  test("whispers: only author, targets and GM receive the message", () => {
    const projected = projectWorld(world(), 5, player);
    expect(projected.collections.messages?.map((m) => m._id)).not.toContain("m-whisper");
    const targetView = projectWorld(world(), 5, other);
    expect(targetView.collections.messages?.map((m) => m._id)).toContain("m-whisper");
  });

  test("gmroll redacted for others; blindroll redacted even for the roller; selfroll omitted for others", () => {
    const projected = projectWorld(world(), 5, player);
    const byId = new Map(projected.collections.messages?.map((m) => [m._id, m]));
    expect(byId.get("m-gmroll")?.roll).toBeNull();
    expect(byId.get("m-blindroll")?.roll).toBeNull();
    expect(byId.get("m-selfroll")).toBeUndefined();
    // the roller (ot-key) sees their own gmroll/selfroll results
    const rollerView = projectWorld(world(), 5, other);
    const rollerById = new Map(rollerView.collections.messages?.map((m) => [m._id, m]));
    expect(rollerById.get("m-selfroll")?.roll?.total).toBe(9);
    // blindroll stays GM-only even for the author of the roll message
    expect(rollerById.get("m-blindroll")?.roll).toBeNull();
  });

  test("seq is carried through", () => {
    expect(projectWorld(world(), 42, player).seq).toBe(42);
  });

  test("is pure: input world is never mutated", () => {
    const w = world();
    const before = JSON.stringify(w);
    projectWorld(w, 5, player);
    expect(JSON.stringify(w)).toBe(before);
  });
});

describe("projectEnvelope (§5)", () => {
  const resolver: ProjectionResolver = {
    resolve: (ref) => {
      const w = world();
      if (ref.coll === "scenes") return w.scenes.find((s) => s._id === ref.id);
      if (ref.coll === "actors") return w.actors.find((a) => a._id === ref.id);
      if (ref.coll === "tokens") return w.scenes[0]?.tokens.find((t) => t._id === ref.id);
      if (ref.coll === "messages") return w.messages.find((m) => m._id === ref.id);
      if (ref.coll === "pages") return w.journals[0]?.pages.find((p) => p._id === ref.id);
      return undefined;
    },
  };

  let tx = 0;
  function env(ops: Op[]): OpEnvelope {
    tx += 1;
    return { seq: 1, ts: 0, by: "gm-key", ops, txId: `tx-${tx}` };
  }

  const sceneRef = { coll: "scenes" as const, id: "s1" };
  const tokenRef = (id: string) => ({ coll: "tokens" as const, id, parent: sceneRef });

  test("GM receives the envelope verbatim", () => {
    const e = env([{ kind: "update", ref: tokenRef("t-hidden"), diff: { x: 1 } }]);
    expect(projectEnvelope(e, gm, resolver)).toBe(e);
  });

  test("updates to hidden tokens are dropped for non-owners", () => {
    const e = env([{ kind: "update", ref: tokenRef("t-hidden"), diff: { x: 1 } }]);
    expect(projectEnvelope(e, player, resolver)).toBeNull();
    const e2 = env([{ kind: "update", ref: tokenRef("t-hidden-owned"), diff: { x: 1 } }]);
    expect(projectEnvelope(e2, player, resolver)?.ops).toHaveLength(1);
  });

  test("updates to invisible top-level docs are dropped", () => {
    const e = env([{ kind: "update", ref: { coll: "actors", id: "a-gm" }, diff: { name: "X" } }]);
    expect(projectEnvelope(e, player, resolver)).toBeNull();
  });

  test("whisper message creates are omitted for outsiders", () => {
    const e = env([
      {
        kind: "create",
        coll: "messages",
        data: message("m-new", { author: "ot-key", whisper: ["gm-key"] }),
      },
    ]);
    expect(projectEnvelope(e, player, resolver)).toBeNull();
  });

  test("gmroll create is redacted (roll stripped) for non-privileged users", () => {
    const e = env([
      {
        kind: "create",
        coll: "messages",
        data: message("m-roll2", {
          author: "pl-key",
          roll: { formula: "1d20", total: 20, terms: [], seedClient: null, seedHost: null },
          rollMode: "gmroll",
        }),
      },
    ]);
    const projected = projectEnvelope(e, other, resolver);
    expect(projected).not.toBeNull();
    const op = projected?.ops[0];
    expect(op?.kind).toBe("create");
    if (op?.kind === "create") {
      expect((op.data as MessageDocument).roll).toBeNull();
    }
  });

  test("journal page text diffs get secrets stripped", () => {
    const e = env([
      {
        kind: "update",
        ref: { coll: "pages", id: "p1", parent: { coll: "journals", id: "j1" } },
        diff: { text: "Safe. <secret>plot twist</secret> Still safe." },
      },
    ]);
    const projected = projectEnvelope(e, player, resolver);
    const op = projected?.ops[0];
    expect(op?.kind).toBe("update");
    if (op?.kind === "update") {
      expect(op.diff["text"]).toBe("Safe.  Still safe.");
    }
  });

  test("partially visible envelopes keep seq/txId and drop only the invisible ops", () => {
    const e = env([
      { kind: "update", ref: tokenRef("t-public"), diff: { x: 5 } },
      { kind: "update", ref: tokenRef("t-hidden"), diff: { x: 5 } },
    ]);
    const projected = projectEnvelope(e, player, resolver);
    expect(projected?.seq).toBe(e.seq);
    expect(projected?.txId).toBe(e.txId);
    expect(projected?.ops).toHaveLength(1);
    expect(projected?.ops[0]).toEqual(e.ops[0]);
  });

  test("hidden token create is invisible to non-owners", () => {
    const e = env([
      {
        kind: "create",
        coll: "tokens",
        parent: sceneRef,
        data: token("t-ambush", { hidden: true }),
      },
    ]);
    expect(projectEnvelope(e, other, resolver)).toBeNull();
    expect(projectEnvelope(e, gm, resolver)).not.toBeNull();
  });
});

describe("helpers", () => {
  test("stripSecretText removes full blocks only", () => {
    expect(stripSecretText("a<secret>x</secret>b")).toBe("ab");
    expect(stripSecretText("<secret>multi\nline</secret>tail")).toBe("tail");
    expect(stripSecretText("no tags")).toBe("no tags");
  });

  test("getEffectiveOwnership GM override", () => {
    expect(getEffectiveOwnership(gm, { ...token("t"), ownership: { default: 0 } })).toBe(3);
  });
});
