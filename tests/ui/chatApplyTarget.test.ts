/**
 * §2.2 item 3 (G-20/D-261) — which actor a roll card's apply verbs target.
 *
 * The button is drawn from the *canvas selection*, so the derivation is the one thing that decides
 * whether a card shows a verb, shows "no permission", or shows nothing at all. The permission
 * answer is advisory (the host re-checks it in `roll.apply`), but a card that offers a verb the
 * host will refuse is a bug at the table: every case below is a case a player can reach.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument, SceneDocument } from "../../src/core/documents";
import { appliedLabelFor, rollApplyTarget } from "../../src/ui/chat/applyTarget";

const GM = { id: "u-gm", role: "GM" as const };
const PLAYER = { id: "u-hero", role: "PLAYER" as const };

function sceneWithTokens(tokens: Array<{ _id: string; actorId?: string | null }>): SceneDocument {
  return {
    _id: "s1",
    tokens: tokens.map((t) => ({ _id: t._id, actorId: t.actorId ?? null })),
  } as unknown as SceneDocument;
}

function actor(id: string, ownership: Record<string, number>): ActorDocument {
  return { _id: id, name: `actor ${id}`, ownership } as unknown as ActorDocument;
}

const readerWith = (scene: SceneDocument, actors: ActorDocument[]) => ({
  getAll: (coll: "scenes" | "actors") => (coll === "scenes" ? [scene] : actors),
});

describe("rollApplyTarget", () => {
  const scene = sceneWithTokens([
    { _id: "t-hero", actorId: "a-hero" },
    { _id: "t-rock" },
    { _id: "t-scout", actorId: "a-scout" },
  ]);
  const hero = actor("a-hero", { default: 0, "u-hero": 3 });
  const scout = actor("a-scout", { default: 0, "u-gm": 3 });

  test("a single selected token names its actor, and the owner may apply", () => {
    const target = rollApplyTarget(readerWith(scene, [hero, scout]), PLAYER, ["t-hero"]);
    expect(target).toEqual({ actorId: "a-hero", name: "actor a-hero", canUpdate: true });
  });

  test("a token the viewer does not own is a named refusal, not a hidden button", () => {
    const target = rollApplyTarget(readerWith(scene, [hero, scout]), PLAYER, ["t-scout"]);
    expect(target).toMatchObject({ actorId: "a-scout", canUpdate: false });
    // the host agrees: a player does not own the GM's scout
    expect(rollApplyTarget(readerWith(scene, [hero, scout]), GM, ["t-scout"])?.canUpdate).toBe(
      true,
    );
  });

  test("multiple selected tokens have no single target — a card must not guess", () => {
    expect(rollApplyTarget(readerWith(scene, [hero, scout]), PLAYER, ["t-hero", "t-scout"])).toBe(
      null,
    );
    expect(rollApplyTarget(readerWith(scene, [hero, scout]), PLAYER, [])).toBe(null);
  });

  test("a token with no actor, or an actor this replica lacks, targets nothing", () => {
    expect(rollApplyTarget(readerWith(scene, [hero, scout]), PLAYER, ["t-rock"])).toBe(null);
    expect(rollApplyTarget(readerWith(scene, [hero, scout]), PLAYER, ["t-missing"])).toBe(null);
    // a player replica never receives the GM's actor documents
    expect(rollApplyTarget(readerWith(scene, [hero]), PLAYER, ["t-scout"])).toBe(null);
  });

  test("a signed-out replica offers a verb it cannot prove it is allowed", () => {
    expect(rollApplyTarget(readerWith(scene, [hero, scout]), null, ["t-hero"])?.canUpdate).toBe(
      false,
    );
  });
});

describe("appliedLabelFor", () => {
  test("names each verb the card already applied to that actor", () => {
    expect(appliedLabelFor({ "a-hero": { damage: 8 } }, "a-hero")).toBe("⚔ 8");
    expect(appliedLabelFor({ "a-hero": { damage: 8, healing: 3 } }, "a-hero")).toBe("⚔ 8 · ✚ 3");
    expect(appliedLabelFor({ "a-hero": { healing: 3 } }, "a-hero")).toBe("✚ 3");
  });

  test("another actor's apply leaves this card's verbs enabled", () => {
    expect(appliedLabelFor({ "a-orc": { damage: 8 } }, "a-hero")).toBe(null);
    expect(appliedLabelFor({}, "a-hero")).toBe(null);
  });
});
