import { describe, expect, test } from "vitest";
import type { SceneDocument, TokenDocument } from "../../src/core/documents";
import { applyDiff } from "../../src/core/diff";
import {
  activateEncounter,
  encounterList,
  newEncounter,
  selectedEncounter,
} from "../../src/ui/combat/encounters";
const gm = { id: "gm", role: "GM" as const };
const scene = (id: string): SceneDocument =>
  ({
    _id: id,
    type: "scene",
    name: id,
    ownership: { default: 2 },
    flags: { core: { keep: "yes" } },
    system: {},
    active: true,
    tokens: [],
  }) as unknown as SceneDocument;
const create = (s: SceneDocument, id: string) => newEncounter(s, id, id, () => "member");
describe("scene-scoped encounter selection", () => {
  test("each scene lists its own encounters; legacy unbound encounters belong only to the original scene", () => {
    const a = scene("a"),
      b = scene("b");
    const legacy = { ...create(a, "legacy"), flags: {} };
    const docs = [legacy, create(a, "first"), create(b, "other")];
    expect(encounterList(docs, a, "a").map((c) => c._id)).toEqual(["legacy", "first"]);
    expect(encounterList(docs, b, "a").map((c) => c._id)).toEqual(["other"]);
    expect(selectedEncounter(docs, a, "a")).toBe(legacy);
  });
  test("activation applies as a narrow Op, preserving scene metadata and all encounter progress", () => {
    const a = scene("a");
    const first = { ...create(a, "first"), round: 3, turn: 2 };
    const second = create(a, "second");
    const original = structuredClone([a, first, second]);
    const result = activateEncounter(a, second, gm, "a");
    expect(result.error).toBeNull();
    const op = result.ops[0];
    if (op?.kind !== "update") throw new Error("expected update");
    const applied = applyDiff(a, op.diff);
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.value.flags.core).toEqual({ keep: "yes", activeCombatId: "second" });
    expect(selectedEncounter([first, second], applied.value, "a")).toBe(second);
    expect([a, first, second]).toEqual(original);
    expect(selectedEncounter([first], applied.value, "a")).toBeNull();
  });
  test("cross-scene selection and non-GM scene writes are rejected", () => {
    const a = scene("a"),
      b = scene("b");
    expect(activateEncounter(a, create(b, "wrong"), gm, "a").ops).toEqual([]);
    for (const user of [null, { id: "p", role: "PLAYER" as const }])
      expect(activateEncounter(a, create(a, "ok"), user, "a").ops).toEqual([]);
  });
  test("new encounters copy only current-scene tokens and preserve actor links without rolling", () => {
    const a = scene("a");
    a.tokens = [
      { _id: "t1", name: "Hero", actorId: "hero" },
      { _id: "t2", name: "Generic" },
    ] as TokenDocument[];
    let id = 0;
    const c = newEncounter(a, "combat", "Test", () => `c${id++}`);
    expect(c.flags.core?.sceneId).toBe("a");
    expect(c.round).toBe(0);
    expect(c.combatants.map((x) => [x._id, x.tokenId, x.actorId, x.initiative])).toEqual([
      ["c0", "t1", "hero", null],
      ["c1", "t2", null, null],
    ]);
    expect(a.tokens).toHaveLength(2);
  });
});
