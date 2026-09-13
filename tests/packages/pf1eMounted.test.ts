/**
 * P08/D-201 — mounted combat (`mounted.ts`), derived from Gap List A.11's
 * transcribed text: the higher-ground bonus vs smaller on-foot foes, the
 * full-attack bar when the mount moves, the ranged penalties, the lance
 * charge multiplier, the casting DCs, the Ride checks, and the
 * unconscious-rider saddle chance.
 */
import { describe, expect, test } from "vitest";
import {
  LANCE_CHARGE_MULTIPLIER,
  guideWithKnees,
  mountedCastingConcentrationDC,
  mountedHigherGround,
  mountedMeleeFullAttack,
  mountedRangedPenalty,
  mountLinkageOf,
  stayInSaddle,
  unconsciousRiderStays,
  untrainedMountControl,
} from "../../src/packages/pf1e/mounted";

describe("P08 — the rider↔mount linkage", () => {
  test("normalize the authored block; absent, null or empty ⇒ no mount", () => {
    expect(mountLinkageOf(undefined)).toBeNull();
    expect(mountLinkageOf(null)).toBeNull();
    expect(mountLinkageOf("horse")).toBeNull();
    expect(mountLinkageOf({})).toEqual({
      actorId: null,
      combatTrained: false,
      saddle: "none",
    });
    expect(
      mountLinkageOf({
        actorId: "mount-1",
        combatTrained: true,
        saddle: "military",
      }),
    ).toEqual({ actorId: "mount-1", combatTrained: true, saddle: "military" });
    expect(mountLinkageOf({ actorId: "  ", saddle: "military" })).toEqual({
      actorId: null,
      combatTrained: false,
      saddle: "military",
    });
  });
});

describe("P08 — the mounted higher-ground bonus (A.11, CRB p.202)", () => {
  test("+1 vs a foe smaller than the mount that is on foot", () => {
    expect(
      mountedHigherGround({
        mountSize: "Large",
        targetSize: "Medium",
        targetMounted: false,
      }),
    ).toBe(true);
    // Equal size, or the target rides too: no bonus.
    expect(
      mountedHigherGround({
        mountSize: "Medium",
        targetSize: "Medium",
        targetMounted: false,
      }),
    ).toBe(false);
    expect(
      mountedHigherGround({
        mountSize: "Large",
        targetSize: "Medium",
        targetMounted: true,
      }),
    ).toBe(false);
    // An unrecognized size is not guessed into a bonus.
    expect(
      mountedHigherGround({
        mountSize: null,
        targetSize: "Medium",
        targetMounted: false,
      }),
    ).toBe(false);
  });
});

describe("P08 — the full-attack bar and the ranged penalties", () => {
  test("more than 5 ft of mount movement leaves one melee attack, exactly 5 keeps the full attack", () => {
    expect(mountedMeleeFullAttack({ mountMovedFt: 30 })).toEqual({
      fullAttack: false,
      reason:
        "the mount moved more than 5 ft — only one melee attack at the end of the move, no full attack (A.11)",
    });
    expect(mountedMeleeFullAttack({ mountMovedFt: 5 })).toEqual({
      fullAttack: true,
      reason: null,
    });
    expect(mountedMeleeFullAttack({ mountMovedFt: 0 })).toEqual({
      fullAttack: true,
      reason: null,
    });
  });

  test("−4 while the mount doubles its speed, −8 while it runs, nothing at half movement", () => {
    expect(mountedRangedPenalty("double")).toEqual({
      label: "mounted, mount double-moving",
      value: -4,
    });
    expect(mountedRangedPenalty("run")).toEqual({
      label: "mounted, mount running",
      value: -8,
    });
    expect(mountedRangedPenalty("single")).toBeNull();
    expect(mountedRangedPenalty("stationary")).toBeNull();
  });

  test("a lance on a charge deals ×2", () => {
    expect(LANCE_CHARGE_MULTIPLIER).toBe(2);
  });
});

describe("P08 — casting from the saddle (A.11)", () => {
  test("moving both before and after ⇒ 10 + SL; running ⇒ 15 + SL; else no mounted DC", () => {
    expect(
      mountedCastingConcentrationDC({
        spellLevel: 3,
        movedBeforeAndAfter: true,
        mountRunning: false,
      }),
    ).toBe(13);
    expect(
      mountedCastingConcentrationDC({
        spellLevel: 3,
        movedBeforeAndAfter: false,
        mountRunning: true,
      }),
    ).toBe(18);
    // Running wins over the both-halves case.
    expect(
      mountedCastingConcentrationDC({
        spellLevel: 3,
        movedBeforeAndAfter: true,
        mountRunning: true,
      }),
    ).toBe(18);
    expect(
      mountedCastingConcentrationDC({
        spellLevel: 3,
        movedBeforeAndAfter: false,
        mountRunning: false,
      }),
    ).toBeNull();
  });
});

describe("P08 — the Ride checks (A.11)", () => {
  test("untrained mount: DC 20, and failure costs the whole round", () => {
    const ok = untrainedMountControl({ die: 15, rideMod: 5 });
    expect(ok.controlled).toBe(true);
    expect(ok.reason).toContain("move action");
    const fail = untrainedMountControl({ die: 10, rideMod: 5 });
    expect(fail.controlled).toBe(false);
    expect(fail.reason).toContain("full-round action");
  });

  test("guide with the knees: DC 5 as a free action", () => {
    expect(guideWithKnees({ die: 3, rideMod: 2 }).handsFree).toBe(true);
    expect(guideWithKnees({ die: 2, rideMod: 2 }).handsFree).toBe(false);
  });

  test("the mount falls: DC 15 or the rider falls for 1d6", () => {
    expect(stayInSaddle({ die: 12, rideMod: 3 }).stays).toBe(true);
    expect(stayInSaddle({ die: 11, rideMod: 3 }).stays).toBe(false);
  });
});

describe("P08 — the unconscious rider (A.11)", () => {
  test("50% to stay mounted, 75% in a military saddle, else fall for 1d6", () => {
    expect(unconsciousRiderStays({ saddle: "none", roll: 50 })).toEqual({
      stays: true,
      reason: "the unconscious rider stays in the saddle (roll 50 ≤ 50%, A.11)",
    });
    expect(unconsciousRiderStays({ saddle: "none", roll: 51 }).stays).toBe(
      false,
    );
    expect(unconsciousRiderStays({ saddle: "military", roll: 75 }).stays).toBe(
      true,
    );
    expect(unconsciousRiderStays({ saddle: "military", roll: 76 }).stays).toBe(
      false,
    );
    expect(unconsciousRiderStays({ saddle: "none", roll: 0 }).stays).toBe(
      false,
    );
    expect(unconsciousRiderStays({ saddle: "none", roll: 101 }).stays).toBe(
      false,
    );
  });
});
