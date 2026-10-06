import { describe, expect, test } from "vitest";
import {
  ACTION_CONDITION_MAX,
  ACTION_FX_CONTEXT_JSON_MAX,
  ACTION_TARGET_MAX,
  actionFxContext,
  deriveActionState,
  expireActionPendingTarget,
  normalizeNewActionCard,
  resolveActionPendingTarget,
  validateActionCard,
  type ActionCard,
  type ActionTarget,
} from "../../src/core/action";

const target = (key: string, outcome: "pending" | "saved" | "failedSave" = "pending"): ActionTarget => ({
  key,
  name: key,
  actorId: `actor-${key}`,
  tokenId: `token-${key}`,
  state: outcome === "pending" ? "pending" : "resolved",
  outcome,
  provenance: "host",
  check: outcome === "pending"
    ? { kind: "save", status: "pending", formula: "1d20+5", dc: 17, total: null,
        saveType: "ref", pendingRollId: `roll-${key}` }
    : { kind: "save", status: "resolved", formula: "1d20+5", dc: 17,
        total: outcome === "saved" ? 22 : 11, saveType: "ref", passed: outcome === "saved" },
});

function action(targets: ActionTarget[] = [target("one"), target("two")]): ActionCard {
  return {
    v: 2,
    id: "action-1",
    revision: 0,
    kind: "cast",
    label: "Entangle",
    state: deriveActionState(targets),
    source: { name: "Druid", actorId: "actor-druid", tokenId: "token-druid", itemId: "item-entangle" },
    sceneId: "scene-forest",
    area: { sceneId: "scene-forest", ref: { kind: "region", id: "region-vines" },
      shape: "spread", origin: { x: 500, y: 600 }, radius: 40, units: "ft" },
    targets,
    notes: [],
    createdAt: 100,
    updatedAt: 100,
  };
}

describe("action card contract", () => {
  test("a bounded multi-target pending cast validates", () => {
    const checked = validateActionCard(action());
    expect(checked).toEqual(expect.objectContaining({ ok: true }));
  });

  test("host normalization records the area scene when the caller omitted root scene context", () => {
    const candidate = action();
    delete candidate.sceneId;
    expect(normalizeNewActionCard(candidate, "bound-id", 222)).toMatchObject({
      id: "bound-id", revision: 0, sceneId: "scene-forest", createdAt: 222, updatedAt: 222,
    });
  });

  test("host transitions independently preserve pending state, then resolve", () => {
    const first = resolveActionPendingTarget(action(), {
      id: "roll-one", actionId: "action-1", targetKey: "one", kind: "save", dc: 17,
    }, 23, 110);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.action).toMatchObject({ revision: 1, state: "pending", targets: [
      { key: "one", state: "resolved", outcome: "saved", check: { total: 23, passed: true } },
      { key: "two", state: "pending", outcome: "pending" },
    ] });

    const second = resolveActionPendingTarget(first.action, {
      id: "roll-two", actionId: "action-1", targetKey: "two", kind: "save", dc: 17,
    }, 9, 120);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toMatchObject({ revision: 2, state: "resolved", targets: [
      { key: "one", outcome: "saved" }, { key: "two", outcome: "failedSave" },
    ] });
  });

  test("host dice do not upgrade a pending check whose mechanics were only reported", () => {
    const unverified = target("one");
    unverified.provenance = "reported";
    const result = resolveActionPendingTarget(action([unverified]), {
      id: "roll-one", actionId: "action-1", targetKey: "one", kind: "save", dc: 17,
    }, 20, 110);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.targets[0]).toMatchObject({ state: "resolved", outcome: "saved",
      provenance: "reported" });
    expect(actionFxContext(result.action)).toMatchObject({ verified: false, targets: [{ verified: false }] });

    const expired = expireActionPendingTarget(action([unverified]), {
      id: "roll-one", actionId: "action-1", targetKey: "one",
    }, 110);
    expect(expired.targets[0]).toMatchObject({ state: "expired", outcome: "expired",
      provenance: "reported" });
    expect(actionFxContext(expired).targets[0]).toEqual({
      key: "one", name: "one", actorId: "actor-one", tokenId: "token-one", verified: false,
    });
  });

  test("roll identity cannot resolve another target", () => {
    const result = resolveActionPendingTarget(action(), {
      id: "roll-two", actionId: "action-1", targetKey: "one", kind: "save", dc: 17,
    }, 20, 110);
    expect(result).toEqual({ ok: false, error: "pending roll does not match the action target" });
  });

  test("expiry is explicit and a mixed card becomes partial", () => {
    const withResolved = action([target("one", "saved"), target("two")]);
    const expired = expireActionPendingTarget(withResolved,
      { id: "roll-two", actionId: "action-1", targetKey: "two" }, 130);
    expect(expired).toMatchObject({ revision: 1, state: "partial", targets: [
      { outcome: "saved" }, { state: "expired", outcome: "expired", check: { status: "expired" } },
    ] });
  });

  test("FX context carries when, where and per-target saves without executable state", () => {
    const resolved = action([target("one", "saved"), target("two", "failedSave")]);
    resolved.state = "resolved";
    resolved.revision = 3;
    resolved.updatedAt = 456;
    const context = actionFxContext(resolved);
    expect(context).toMatchObject({
      actionId: "action-1",
      revision: 3,
      kind: "cast",
      label: "Entangle",
      state: "resolved",
      at: 456,
      sceneId: "scene-forest",
      source: { actorId: "actor-druid", tokenId: "token-druid", itemId: "item-entangle" },
      area: { ref: { kind: "region", id: "region-vines" }, origin: { x: 500, y: 600 }, radius: 40 },
      targets: [
        { actorId: "actor-one", tokenId: "token-one", outcome: "saved", check: { saveType: "ref", passed: true } },
        { actorId: "actor-two", tokenId: "token-two", outcome: "failedSave", check: { saveType: "ref", passed: false } },
      ],
    });
    expect(JSON.stringify(context)).not.toContain("pendingRollId");
  });

  test("FX projection strips client-reported outcome mechanics", () => {
    const reported = target("one", "failedSave");
    reported.provenance = "reported";
    reported.damage = { dealt: 999 };
    reported.conditions = { applied: ["invented"] };
    reported.evidence = { adapter: "pf1e.spellTarget.v1", payload: { damageRollId: "secret-roll" } };
    const context = actionFxContext(action([reported]));
    expect(context.verified).toBe(false);
    expect(context).not.toHaveProperty("state");
    expect(context.targets).toEqual([{
      key: "one", name: "one", actorId: "actor-one", tokenId: "token-one",
      verified: false,
    }]);
  });

  test("FX projection has a schema-enforced cardinality and JSON budget", () => {
    const conditionNames = Array.from({ length: ACTION_CONDITION_MAX }, (_, index) =>
      `condition-${index}`.padEnd(80, "x"));
    const targets: ActionTarget[] = Array.from({ length: ACTION_TARGET_MAX }, (_, index) => ({
      key: `target-${index}`,
      name: `Target ${index}`.padEnd(160, "x"),
      actorId: `actor-${index}`,
      tokenId: `token-${index}`,
      state: "resolved",
      outcome: "affected",
      provenance: "host",
      damage: { dealt: Number.MAX_SAFE_INTEGER, prevented: Number.MAX_SAFE_INTEGER },
      healing: { applied: Number.MAX_SAFE_INTEGER },
      conditions: { applied: [...conditionNames], removed: [...conditionNames] },
      notes: ["not projected to FX".padEnd(500, "n")],
    }));
    const maximal = action(targets);
    maximal.label = "L".repeat(160);
    expect(validateActionCard(maximal).ok).toBe(true);

    const context = actionFxContext(maximal);
    const serialized = JSON.stringify(context);
    expect(context.targets).toHaveLength(ACTION_TARGET_MAX);
    expect(serialized.length).toBeLessThanOrEqual(ACTION_FX_CONTEXT_JSON_MAX);
    expect(serialized).not.toContain("not projected to FX");
    expect(serialized).not.toContain("formula");

    const firstTarget = targets[0];
    if (!firstTarget) throw new Error("maximal fixture needs a target");
    expect(validateActionCard(action([...targets, { ...firstTarget, key: "overflow" }]))).toMatchObject({
      ok: false, error: `action card needs at most ${ACTION_TARGET_MAX} targets`,
    });
    const conditionOverflow = structuredClone(firstTarget);
    conditionOverflow.key = "condition-overflow";
    conditionOverflow.conditions = { applied: [...conditionNames, "one-too-many"] };
    expect(validateActionCard(action([conditionOverflow]))).toMatchObject({
      ok: false, error: expect.stringContaining(`at most ${ACTION_CONDITION_MAX}`),
    });

    const evidenceOverflow = target("evidence", "saved");
    evidenceOverflow.evidence = { adapter: "pf1e.spellTarget.v1", payload: Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`field${index}`, "x".repeat(500)]),
    ) };
    expect(validateActionCard(action([evidenceOverflow]))).toEqual({
      ok: false, error: "action target evidence is too large",
    });
  });

  test("schema rejects state disagreement, premature mechanics and duplicate target keys", () => {
    expect(validateActionCard({ ...action(), state: "resolved" })).toEqual({
      ok: false, error: "action state resolved disagrees with its targets",
    });
    expect(validateActionCard({ ...action(), state: "failed" })).toEqual({
      ok: false, error: "terminal action state failed cannot contain pending targets",
    });
    const premature = target("premature");
    premature.damage = { dealt: 1 };
    expect(validateActionCard(action([premature]))).toEqual({
      ok: false, error: "a pending action target cannot carry committed mechanics",
    });
    const staleLink = target("stale", "saved");
    if (!staleLink.check) throw new Error("resolved fixture needs a check");
    staleLink.check.pendingRollId = "stale-roll";
    expect(validateActionCard(action([staleLink]))).toEqual({
      ok: false, error: "only a pending action check may carry a pending-roll id",
    });
    expect(validateActionCard(action([target("one"), target("one")]))).toEqual({
      ok: false, error: "action target key one is duplicated",
    });
    const distant = action();
    if (!distant.area) throw new Error("area fixture missing");
    distant.area.origin.x = 1_000_001;
    expect(validateActionCard(distant)).toEqual({ ok: false, error: "action area is malformed" });
  });
});

describe("action card riders (v2)", () => {
  const delivered = (): ActionCard => {
    const landed = target("one", "saved");
    landed.riders = [{
      kind: "poison",
      label: "Giant octopus poison",
      state: "pending",
      facts: ["Fort DC 19", "1/round for 6 rounds", "1d3 Str"],
      save: { saveType: "fort", dc: 19, total: null, pendingRollId: "poison-save" },
      evidence: { adapter: "pf1e.poison.v1", payload: { definitionId: "giant-octopus-poison", version: 1 } },
    }];
    const card = action([landed]);
    card.state = deriveActionState(card.targets);
    return card;
  };

  test("a delivered rider keeps the card pending while its save is unrolled", () => {
    const card = delivered();
    expect(card.state).toBe("pending");
    expect(validateActionCard(card)).toEqual(expect.objectContaining({ ok: true }));
  });

  test("rolling the rider save resolves the rider and leaves the landed target resolved", () => {
    const result = resolveActionPendingTarget(delivered(), {
      id: "poison-save", actionId: "action-1", targetKey: "one", kind: "save", dc: 19,
    }, 12, 200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.action.state).toBe("resolved");
    expect(result.action.targets[0]).toMatchObject({ state: "resolved", outcome: "saved",
      check: { status: "resolved", total: 22, passed: true }, riders: [{
        state: "applied", save: { total: 12, passed: false },
      }] });
    expect(result.action.targets[0]?.riders?.[0]?.save).not.toHaveProperty("pendingRollId");
    expect(validateActionCard(result.action).ok).toBe(true);
  });

  test("a resisted save records the pass and a closed window expires without inventing one", () => {
    const passed = resolveActionPendingTarget(delivered(), {
      id: "poison-save", actionId: "action-1", targetKey: "one", kind: "save", dc: 19,
    }, 25, 200);
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expect(passed.action.targets[0]?.riders?.[0]).toMatchObject({ state: "resisted",
      save: { total: 25, passed: true } });

    const expired = expireActionPendingTarget(delivered(), {
      id: "poison-save", actionId: "action-1", targetKey: "one",
    }, 300);
    expect(expired.state).toBe("resolved");
    expect(expired.targets[0]?.riders?.[0]).toMatchObject({ state: "expired", save: { total: null } });
    expect(validateActionCard(expired).ok).toBe(true);
  });

  test("version-1 cards cannot carry riders and rider invariants are enforced", () => {
    const legacy = delivered();
    legacy.v = 1;
    expect(validateActionCard(legacy)).toEqual({ ok: false, error: "action riders require an action card version 2" });

    const badPass = delivered();
    const rider = badPass.targets[0]?.riders?.[0];
    if (!rider?.save) throw new Error("rider fixture missing");
    rider.state = "resisted";
    rider.save.total = 20;
    rider.save.passed = false;
    delete rider.save.pendingRollId;
    expect(validateActionCard(badPass)).toEqual({
      ok: false, error: "a resisted rider save must be recorded as passed",
    });
  });

  test("FX projection carries rider state only for host-verified targets", () => {
    const card = delivered();
    expect(actionFxContext(card).targets[0]).toMatchObject({
      verified: true, riders: [{ kind: "poison", state: "pending",
        save: { saveType: "fort", dc: 19, total: null } }],
    });
    expect(JSON.stringify(actionFxContext(card))).not.toContain("pendingRollId");
    expect(JSON.stringify(actionFxContext(card))).not.toContain("pf1e.poison.v1");

    const reported = delivered();
    if (reported.targets[0]) reported.targets[0].provenance = "reported";
    expect(actionFxContext(reported).targets[0]).toEqual({
      key: "one", name: "one", actorId: "actor-one", tokenId: "token-one", verified: false,
    });
  });
});
