import { describe, expect, test } from "vitest";
import type { ActorDocument, Json } from "../../src/core/documents";
import { EMPTY_ACTION_LEDGER, actionRefusal } from "../../src/packages/pf1e/actions";
import { deriveFromDocuments, parsePF1eActorSystem } from "../../src/packages/pf1e/actor";
import {
  pf1eApplyConditionApplication,
  pf1eRemoveConditionApplication,
  readPF1eConditionApplications,
  type PF1eConditionApplication,
} from "../../src/packages/pf1e/conditionApplications";
import { evaluateDetection } from "../../src/packages/pf1e/stealthPerception";

const application = (id: string, condition: string): PF1eConditionApplication => ({
  id,
  condition,
  source: { kind: "maneuver", id: `source-${id}`, relationshipId: "grapple-1" },
  removal: { kind: "manual" },
});

function actorWith(pf1e: Record<string, unknown>): ActorDocument {
  return {
    _id: "target",
    type: "actor",
    name: "Target",
    ownership: { default: 2 },
    flags: {},
    system: { pf1e: pf1e as unknown as Json },
    items: [],
    effects: [],
  };
}

describe("source-aware PF1e condition applications", () => {
  test("actor parsing validates keyed records without rejecting unknown legacy labels", () => {
    expect(parsePF1eActorSystem({
      conditionApplications: { "cond-one": application("cond-one", "Prone") },
      conditions: ["Old Pack Condition"],
    }).ok).toBe(true);
    expect(parsePF1eActorSystem({
      conditionApplications: { "cond-one": application("cond-two", "Prone") },
    }).ok).toBe(false);
    expect(parsePF1eActorSystem({
      conditionApplications: { "cond-one": { ...application("cond-one", "Bogus") } },
    }).ok).toBe(false);
  });

  test("two source instances derive one effective condition; removing one leaves the other", () => {
    const target = actorWith({
      abilities: { str: 14, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      conditionApplications: {
        "cond-one": application("cond-one", "Shaken"),
        "cond-two": { ...application("cond-two", "Shaken"), source: { kind: "spell", id: "fear-ward" } },
      },
    });
    const before = deriveFromDocuments({ actor: target });
    expect(before.conditions).toContain("Shaken");
    expect(before.effectBreakdown.attack).toContain("-2");
    expect(before.effectBreakdown.saves).toContain("-2");

    const removed = pf1eRemoveConditionApplication(target, "cond-one");
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value[0]).toMatchObject({
      kind: "update",
      diff: { "-=system.pf1e.conditionApplications.cond-one": null },
    });

    const afterActor = actorWith({
      ...(target.system.pf1e as Record<string, unknown>),
      conditionApplications: { "cond-two": application("cond-two", "Shaken") },
    });
    const after = deriveFromDocuments({ actor: afterActor });
    expect(after.conditions).toContain("Shaken");
    expect(after.effectBreakdown.attack).toContain("-2");
  });

  test("legacy labels are visible and supported mechanics resolve once beside new records", () => {
    const target = actorWith({
      conditions: ["Shaken", "Shaken", "Reticulated"],
      conditionApplications: { "cond-one": application("cond-one", "Shaken") },
    });
    const readout = readPF1eConditionApplications(target.system);
    expect(readout.names).toEqual(["Shaken", "Reticulated"]);
    expect(readout.issues.join(" ")).toContain("Reticulated");

    const derived = deriveFromDocuments({ actor: target });
    expect(derived.conditions).toContain("Reticulated");
    expect(derived.conditions.filter((name) => name === "Shaken")).toHaveLength(1);
    expect(derived.effectBreakdown.attack).toContain("-2");
    expect(derived.effectBreakdown.attack).not.toContain("-6");
    expect(derived.issues.join(" ")).toContain("Reticulated");
  });

  test("Pinned suppresses Grappled mechanics, keeps the source instance, and permits escape", () => {
    const target = actorWith({
      abilities: { str: 14, dex: 16, con: 12, int: 10, wis: 10, cha: 10 },
      conditionApplications: {
        "cond-grapple": application("cond-grapple", "Grappled"),
        "cond-pin": application("cond-pin", "Pinned"),
      },
    });
    const derived = deriveFromDocuments({ actor: target });
    expect(derived.conditions).toContain("Pinned");
    expect(derived.conditions).not.toContain("Grappled");
    expect(derived.abilityMods.dex).toBe(3);
    expect(derived.effectBreakdown.attack ?? "").not.toContain("grappled");
    expect(derived.denies.has("standard")).toBe(true);
    expect(actionRefusal(EMPTY_ACTION_LEDGER, {
      kind: "standard", action: "escape-grapple",
    }, derived.denies)).toBeNull();

    const unpinned = actorWith({
      ...(target.system.pf1e as Record<string, unknown>),
      conditionApplications: { "cond-grapple": application("cond-grapple", "Grappled") },
    });
    const grappled = deriveFromDocuments({ actor: unpinned });
    expect(grappled.abilityMods.dex).toBe(1); // Dex 16 → 12, modifier +1
    expect(grappled.effectBreakdown.attack).toContain("-2");
  });

  test("Prone permits crossbows but refuses other ranged weapons; Deafened affects initiative", () => {
    const prone = deriveFromDocuments({ actor: actorWith({
      conditionApplications: { "cond-prone": application("cond-prone", "Prone") },
    }) });
    expect(actionRefusal(EMPTY_ACTION_LEDGER, {
      kind: "standard", action: "attack-ranged", rangedWeaponKind: "crossbow",
    }, prone.denies)).toBeNull();
    expect(actionRefusal(EMPTY_ACTION_LEDGER, {
      kind: "standard", action: "attack-ranged", rangedWeaponKind: "other",
    }, prone.denies)).toContain("ranged attacks");

    const deafened = deriveFromDocuments({ actor: actorWith({
      initiative: 2,
      conditionApplications: { "cond-deaf": application("cond-deaf", "Deafened") },
    }) });
    expect(deafened.deafened).toBe(true);
    expect(deafened.initiative).toBe(-2); // Dex modifier 0 + authored 2 − 4
  });

  test("manual application writes a keyed instance and Pinned replaces target Grappled instances", () => {
    const target = actorWith({
      conditionApplications: { "old-grapple": application("old-grapple", "Grappled") },
    });
    const result = pf1eApplyConditionApplication({
      actor: target,
      condition: "Pinned",
      id: "new-pin",
      source: { kind: "manual", id: "user-1" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.kind).toBe("update");
    if (result.value[0]?.kind !== "update") return;
    expect(Object.keys(result.value[0].diff)).toContain("system.pf1e.conditionApplications.new-pin");
    expect(Object.keys(result.value[0].diff)).toContain("-=system.pf1e.conditionApplications.old-grapple");
  });

  test("opposed and sense-specific Perception checks consume condition facts", () => {
    const audibleOnly = evaluateDetection(
      { stealthRoll: 12, distanceFt: 10, requiresHearing: true },
      { perceptionTotal: 20, deafened: true },
    );
    expect(audibleOnly.detected).toBe(false);
    expect(audibleOnly.notes.join(" ")).toContain("automatically fails");

    const sightOnly = evaluateDetection(
      { stealthRoll: 12, distanceFt: 10, requiresVision: true },
      { perceptionTotal: 20, blinded: true },
    );
    expect(sightOnly.detected).toBe(false);
    expect(sightOnly.notes.join(" ")).toContain("automatically fails");

    const opposed = evaluateDetection(
      { stealthRoll: 12, distanceFt: 10 },
      { perceptionTotal: 20, blinded: true },
    );
    expect(opposed.perceptionTotal).toBe(16);
    expect(opposed.notes.join(" ")).toContain("−4");
  });
});
