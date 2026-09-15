import { describe, expect, test } from "vitest";
import {
  calculatePerceptionDc,
  evaluateDetection,
  sizeStealthModifier,
  aggregateUnitStealth,
  evaluateUnitAmbush,
  type StealthSubjectFacts,
  type ObserverPerceptionFacts,
  type MassStealthUnit,
} from "../../src/packages/pf1e/stealthPerception";

describe("C06 — PF1e Stealth vs Perception DC calculation", () => {
  test("distance modifier adds +1 DC per 10 feet", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 15,
      distanceFt: 35,
    };
    const breakdown = calculatePerceptionDc(subject);
    expect(breakdown.baseStealthRoll).toBe(15);
    expect(breakdown.distanceMod).toBe(3); // floor(35 / 10) = 3
    expect(breakdown.totalPerceptionDc).toBe(18);
  });

  test("movement penalty applies -5 when moving faster than half speed", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 20,
      distanceFt: 0,
      fastMovement: true,
    };
    const breakdown = calculatePerceptionDc(subject);
    expect(breakdown.movementPenalty).toBe(-5);
    expect(breakdown.effectiveStealth).toBe(15);
    expect(breakdown.totalPerceptionDc).toBe(15);
  });

  test("sniping penalty applies -20 to hide after attack", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 25,
      distanceFt: 30,
      sniping: true,
    };
    const breakdown = calculatePerceptionDc(subject);
    expect(breakdown.snipingPenalty).toBe(-20);
    expect(breakdown.effectiveStealth).toBe(5);
    expect(breakdown.distanceMod).toBe(3);
    expect(breakdown.totalPerceptionDc).toBe(8);
  });

  test("invisibility adds +20 moving or +40 stationary", () => {
    const stationary: StealthSubjectFacts = {
      stealthRoll: 10,
      distanceFt: 0,
      invisible: true,
      moving: false,
    };
    expect(calculatePerceptionDc(stationary).invisibilityBonus).toBe(40);
    expect(calculatePerceptionDc(stationary).totalPerceptionDc).toBe(50);

    const moving: StealthSubjectFacts = {
      stealthRoll: 10,
      distanceFt: 0,
      invisible: true,
      moving: true,
    };
    expect(calculatePerceptionDc(moving).invisibilityBonus).toBe(20);
    expect(calculatePerceptionDc(moving).totalPerceptionDc).toBe(30);
  });

  test("improved cover grants +10 Stealth bonus; soft cover grants none", () => {
    const improved: StealthSubjectFacts = {
      stealthRoll: 12,
      distanceFt: 20,
      cover: "improved",
    };
    expect(calculatePerceptionDc(improved).coverBonus).toBe(10);
    expect(calculatePerceptionDc(improved).totalPerceptionDc).toBe(24); // 12 + 10 + 2

    const soft: StealthSubjectFacts = {
      stealthRoll: 12,
      distanceFt: 20,
      cover: "soft",
    };
    expect(calculatePerceptionDc(soft).coverBonus).toBe(0);
    expect(calculatePerceptionDc(soft).totalPerceptionDc).toBe(14); // 12 + 0 + 2
  });

  test("environmental and perceiver condition modifiers", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 10,
      distanceFt: 10,
    };
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 15,
      environment: "unfavorable", // +2
      throughDoor: true,          // +5
      asleep: true,               // +10
    };
    const breakdown = calculatePerceptionDc(subject, observer);
    expect(breakdown.environmentMod).toBe(2);
    expect(breakdown.perceiverConditionMod).toBe(15);
    // 10 base + 1 dist + 2 env + 15 conditions = 28
    expect(breakdown.totalPerceptionDc).toBe(28);
  });

  test("size stealth modifiers ladder", () => {
    expect(sizeStealthModifier("Fine")).toBe(16);
    expect(sizeStealthModifier("Diminutive")).toBe(12);
    expect(sizeStealthModifier("Tiny")).toBe(8);
    expect(sizeStealthModifier("Small")).toBe(4);
    expect(sizeStealthModifier("Medium")).toBe(0);
    expect(sizeStealthModifier("Large")).toBe(-4);
    expect(sizeStealthModifier("Huge")).toBe(-8);
    expect(sizeStealthModifier("Gargantuan")).toBe(-12);
    expect(sizeStealthModifier("Colossal")).toBe(-16);
  });
});

describe("C07 — Sensory Modes & Awareness Behavior", () => {
  test("Tremorsense pinpoints grounded targets and bypasses stealth & invisibility", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 45,
      distanceFt: 40,
      invisible: true,
      grounded: true,
    };
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 10,
      senses: [{ kind: "tremorsense", rangeFt: 60 }],
    };
    const res = evaluateDetection(subject, observer);
    expect(res.detected).toBe(true);
    expect(res.awareness).toBe("located");
    expect(res.bypassedBySense).toBe("tremorsense");
    expect(res.isTargetable).toBe(true);
  });

  test("Tremorsense does NOT detect flying/airborne (ungrounded) targets", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 25,
      distanceFt: 20,
      grounded: false, // flying
    };
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 10,
      senses: [{ kind: "tremorsense", rangeFt: 60 }],
    };
    const res = evaluateDetection(subject, observer);
    expect(res.bypassedBySense).toBe(null);
    expect(res.detected).toBe(false);
    expect(res.awareness).toBe("none");
  });

  test("Blindsight & True Seeing ignore visual concealment (blur, invisibility)", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 30,
      distanceFt: 30,
      invisible: true,
      concealment: 0.5,
    };
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 10,
      senses: [{ kind: "blindsight", rangeFt: 30 }],
    };
    const res = evaluateDetection(subject, observer);
    expect(res.detected).toBe(true);
    expect(res.awareness).toBe("seen");
    expect(res.targetingMissChance).toBe(0); // Ignores all visual concealment!
  });

  test("Blindsense locates square but target retains 50% concealment", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 30,
      distanceFt: 25,
      invisible: true,
    };
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 12,
      senses: [{ kind: "blindsense", rangeFt: 30 }],
    };
    const res = evaluateDetection(subject, observer);
    expect(res.detected).toBe(true);
    expect(res.awareness).toBe("located");
    expect(res.targetingMissChance).toBe(0.5); // Retains total concealment
  });

  test("Scent detects presence within 30 ft, but cannot pinpoint beyond 5 ft", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 35,
      distanceFt: 20,
    };
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 10,
      senses: [{ kind: "scent", rangeFt: 30 }],
    };
    const res = evaluateDetection(subject, observer);
    expect(res.detected).toBe(true);
    expect(res.awareness).toBe("presence"); // Presence only!
    expect(res.isTargetable).toBe(false);   // Cannot target specific square
  });

  test("Scent pinpoints target when adjacent (<= 5 ft)", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 35,
      distanceFt: 5,
    };
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 10,
      senses: [{ kind: "scent", rangeFt: 30 }],
    };
    const res = evaluateDetection(subject, observer);
    expect(res.detected).toBe(true);
    expect(res.awareness).toBe("located"); // Pinpointed!
    expect(res.isTargetable).toBe(true);
  });

  test("Scent range doubles upwind (60 ft) and halves downwind (15 ft)", () => {
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 10,
      senses: [{ kind: "scent", rangeFt: 30 }],
    };

    // Upwind at 50 ft -> detects presence
    const upwind: StealthSubjectFacts = {
      stealthRoll: 35,
      distanceFt: 50,
      windRelation: "upwind",
    };
    expect(evaluateDetection(upwind, observer).awareness).toBe("presence");

    // Downwind at 20 ft -> beyond 15 ft range -> undetected
    const downwind: StealthSubjectFacts = {
      stealthRoll: 35,
      distanceFt: 20,
      windRelation: "downwind",
    };
    expect(evaluateDetection(downwind, observer).awareness).toBe("none");
  });

  test("Hearing an invisible creature pinpoints location with 50% miss chance", () => {
    const subject: StealthSubjectFacts = {
      stealthRoll: 10,
      distanceFt: 10,
      invisible: true,
      moving: true, // +20 invisibility -> DC 31
    };
    const observer: ObserverPerceptionFacts = {
      perceptionTotal: 32, // Beats DC 31
      senses: [{ kind: "normal", rangeFt: null }],
    };
    const res = evaluateDetection(subject, observer);
    expect(res.detected).toBe(true);
    expect(res.awareness).toBe("located");
    expect(res.targetingMissChance).toBe(0.5);
    expect(res.isTargetable).toBe(true);
  });
});

describe("C08 — Mass Stealth Aggregation & Ambush Mechanics", () => {
  test("unit stealth aggregation: lowest vs average policy", () => {
    const unitLowest: MassStealthUnit = {
      unitId: "u-scouts",
      policy: "lowest",
      stealthRolls: [18, 14, 22, 11, 16],
      distanceFt: 40,
    };
    expect(aggregateUnitStealth(unitLowest)).toBe(11);

    const unitAvg: MassStealthUnit = {
      ...unitLowest,
      policy: "average",
    };
    // (18 + 14 + 22 + 11 + 16) / 5 = 81 / 5 = 16.2 -> round to 16
    expect(aggregateUnitStealth(unitAvg)).toBe(16);
  });

  test("ambush evaluation catches defenders flat-footed on failure", () => {
    const ambusher: MassStealthUnit = {
      unitId: "u-ninjas",
      policy: "lowest",
      stealthRolls: [15, 16, 17],
      distanceFt: 30, // +3 DC
    };
    // DC = 15 + 3 = 18
    const verdictFail = evaluateUnitAmbush(ambusher, 14);
    expect(verdictFail.ambushSuccess).toBe(true);
    expect(verdictFail.perceptionDc).toBe(18);

    const verdictPass = evaluateUnitAmbush(ambusher, 19);
    expect(verdictPass.ambushSuccess).toBe(false);
  });
});
