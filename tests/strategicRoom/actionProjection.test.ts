import { expect, test } from "vitest";
import type { ActionCard } from "../../src/core/action";
import { frozenEntangleAction, projectEntangleAction, projectFrozenEntangleCast } from "../../src/core/strategicRoom/pf1eActionProjection";
import { boundedActionHistory, MAX_PUBLISHED_ACTION_BYTES, MAX_PUBLISHED_ACTIONS } from "../../services/strategic-room/src/resolve";

const action = (): ActionCard => ({
  v: 2,
  id: "entangle-action-1",
  revision: 0,
  kind: "cast",
  label: "Entangle",
  state: "resolved",
  source: { name: "Druid", actorId: "druid", tokenId: "druid-token" },
  sceneId: "field",
  area: { sceneId: "field", shape: "spread", origin: { x: 600, y: 400 }, radius: 40, units: "ft" },
  targets: [{ key: "orc", name: "Orc", actorId: "orc", tokenId: "orc-token",
    state: "resolved", outcome: "failedSave", provenance: "host",
    check: { kind: "save", status: "resolved", formula: "1d20+2", dc: 15, total: 7,
      saveType: "ref", passed: false } }],
  notes: [],
  createdAt: 1,
  updatedAt: 1,
});

test("the regular PF1e Entangle action projects to a duration-bearing strategic area", () => {
  expect(projectEntangleAction({ action: action(), grid: { size: 100, distance: 5, units: "ft" },
    startsTurn: 3, casterLevel: 4, casterFactionId: "blue" })).toEqual({
    id: "entangle-action-1", spell: "entangle", at: { x: 30, y: 20 }, radius: 40,
    startsTurn: 3, expiresAfterTurn: 42, dc: 15, casterLevel: 4, casterFactionId: "blue",
  });
});

test("hosted frozen casts produce regular action evidence before model-level projection", () => {
  const input = { actionId: "entangle-4-druids", sceneId: "field", actorId: "druid",
    itemId: "pf1e-core-spells-entangle", unitId: "druids", originFeet: { x: 30, y: 20 },
    saveDc: 16, startsTurn: 4, casterLevel: 5, casterFactionId: "blue" };
  expect(frozenEntangleAction(input)).toMatchObject({ kind: "cast", label: "Entangle", state: "resolved",
    source: { actorId: "druid", itemId: "pf1e-core-spells-entangle" },
    area: { sceneId: "field", shape: "spread", origin: { x: 30, y: 20 }, radius: 40, units: "ft" },
    targets: [{ provenance: "host", check: { kind: "save", saveType: "ref", dc: 16 } }] });
  expect(projectFrozenEntangleCast(input)).toEqual({ id: "entangle-4-druids", spell: "entangle",
    at: { x: 30, y: 20 }, radius: 40, startsTurn: 4, expiresAfterTurn: 53, dc: 16,
    casterLevel: 5, casterFactionId: "blue" });
});

test("published action history is bounded by count and wire bytes", () => {
  const cards = Array.from({ length: 100 }, (_, index) => ({ ...action(), id: `entangle-${index}`,
    notes: Array(32).fill("x".repeat(500)) }));
  const retained = boundedActionHistory(cards);
  expect(retained.length).toBeLessThanOrEqual(MAX_PUBLISHED_ACTIONS);
  expect(Buffer.byteLength(JSON.stringify(retained), "utf8")).toBeLessThanOrEqual(
    MAX_PUBLISHED_ACTION_BYTES + retained.length,
  );
  expect(retained.at(-1)?.id).toBe("entangle-99");
});

test("the adapter rejects client-reported, malformed, or strategically re-authored casts", () => {
  const base = action();
  expect(() => projectEntangleAction({ action: { ...base, label: "Strategic Entangle" },
    grid: { size: 100, distance: 5, units: "ft" }, startsTurn: 1, casterLevel: 1,
    casterFactionId: "blue" })).toThrow(/regular PF1e Entangle/);
  const reported = action();
  if (reported.targets[0]) reported.targets[0].provenance = "reported";
  expect(() => projectEntangleAction({ action: reported,
    grid: { size: 100, distance: 5, units: "ft" }, startsTurn: 1, casterLevel: 1,
    casterFactionId: "blue" })).toThrow(/host-verified Reflex DC/);
});
