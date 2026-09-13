/**
 * P09/D-202 — firearms misfire, explosion and clearing, transcribed from the
 * verified texts (Gap List §2.9/§2.9b, UC p.135, the AoN firearms pages, and
 * the gunslinger deeds — every number below was re-verified before encoding):
 *
 *   §2.9b — "Misfire (UC p.135): natural result ≤ misfire value ⇒ auto-miss +
 *   weapon gains **broken**; while broken the misfire value rises **+4**
 *   (+2 with Gun Training); a **second** misfire of a broken early firearm
 *   **explodes** (burst from a chosen corner, damage as a hit, DC 12 Reflex
 *   half, nonmagical weapon destroyed / magical wrecked); advanced firearms
 *   never explode; nonproficient loader +4 to misfire values of shots they
 *   load; no misfire on a confirmation roll; clearing a misfire is a
 *   full-round action (DC 10 + ? — verify) with Gunsmithing/Quick Clear
 *   variants" — and the verification answered the "DC 10 + ?": **there is no
 *   generic clear**. The named clears are the gunslinger's **Quick Clear**
 *   deed (a *standard action* removing the broken condition a misfire
 *   inflicted, requiring at least 1 grit; **spending 1 grit makes it a move
 *   action**) and the **Gunsmithing** feat (**1 hour** to repair a broken
 *   firearm). The DC-10 full-round action is not a rule and is not encoded.
 *
 *   The natural-20 gate ("checked before the hit roll so a natural 20 with a
 *   misfire value ≥ 20 would still misfire" was the strategic defect) is
 *   encoded here: **a natural 20 never misfires**, and the check reads the
 *   natural die face, never the total and never a confirmation roll.
 *
 * Already owned elsewhere and not re-encoded: the touch-AC windows (early ≤
 * 1st increment, advanced ≤ 5th) and max increments (5/10) are `tactical.ts`'s
 * (A04); the broken weapon's −2 attack/damage and nat-20-only ×2 crit are
 * `weapons.ts`'s `brokenWeaponAdjustments` (AoN 413); the load-action cost is
 * the weapon's authored ammo descriptor; loading provokes (§2.9) — the
 * trigger is the action seam's, `actionTrigger`'s own table convention.
 *
 * Deliberately caller-owned: the explosion's burst geometry (the verified
 * text places it "from a chosen corner" — a placement fact), the Reflex save
 * rolls, grit accounting, and the weapon-state writes (this module reports
 * what happens; the caller persists it).
 */

/** UC p.135: early firearms are the default technological tier. */
export type PF1eFirearmGeneration = "early" | "advanced";

/** The weapon facts the misfire rules read. */
export interface PF1eMisfireFacts {
  /** The firearm's generation: only early firearms explode. */
  generation: PF1eFirearmGeneration;
  /** The authored misfire minimum (1–20; 0 ⇒ never misfires). */
  misfireMinimum: number;
  /** The weapon already carries the broken condition. */
  broken: boolean;
  /** A magical weapon is wrecked by an explosion, not destroyed. */
  magical?: boolean;
  /** Gun Training: the broken escalation is +2 instead of +4 (§2.9b). */
  gunTraining?: boolean;
  /**
   * A nonproficient loader adds +4 to the misfire values of the shots they
   * load (§2.9b) — a per-shot caller fact.
   */
  nonproficientLoader?: boolean;
  /**
   * The gunslinger's 11th-level deed: spending 1 grit on a misfire with a
   * broken gun keeps it from exploding (the broken condition stays).
   */
  expertLoading?: boolean;
}

/** The effective misfire value: minimum, plus the broken and loader escalations. */
export function effectiveMisfireValue(facts: PF1eMisfireFacts): number {
  let value = Math.max(0, facts.misfireMinimum);
  if (facts.broken) value += facts.gunTraining === true ? 2 : 4;
  if (facts.nonproficientLoader === true) value += 4;
  return value;
}

export type PF1eMisfireVerdict =
  | { misfire: false }
  | {
      misfire: true;
      /** A misfire is an automatic miss, whatever the total would have been. */
      autoMiss: true;
      /** The weapon gains the broken condition (first misfire of a sound gun). */
      breaksWeapon: boolean;
      /**
       * A second misfire of a broken **early** firearm explodes — unless the
       * Expert Loading deed averts it (the gun keeps its broken condition).
       */
      explodes: boolean;
      /** The explosion's save: DC 12 Reflex for half (UC p.135). */
      save: { dc: 12; half: true } | null;
      /** A nonmagical weapon is destroyed; a magical one is wrecked (broken past repair in the field). */
      weaponDestroyed: boolean;
      notes: readonly string[];
    };

/**
 * The misfire check. `die` is the natural d20 face of the **attack** roll —
 * a confirmation roll is never checked (§2.9b), and a natural 20 never
 * misfires (the gate the strategic engine lacked).
 */
export function pf1eMisfireVerdict(input: {
  facts: PF1eMisfireFacts;
  die: number;
}): PF1eMisfireVerdict {
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 20) {
    return {
      misfire: true,
      autoMiss: true,
      breaksWeapon: false,
      explodes: false,
      save: null,
      weaponDestroyed: false,
      notes: ["the misfire die must be a natural d20 face (1–20)"],
    };
  }
  const value = effectiveMisfireValue(input.facts);
  if (input.die === 20 || input.die > value) return { misfire: false };

  const notes: string[] = [
    `misfire — natural ${String(input.die)} ≤ misfire value ${String(value)} (§2.9b): the shot automatically misses`,
  ];
  const firstMisfire = !input.facts.broken;
  if (firstMisfire) {
    notes.push(
      "the firearm gains the broken condition — its misfire value rises " +
        (input.facts.gunTraining === true ? "+2 (Gun Training)" : "+4") +
        " while broken (§2.9b)",
    );
    return {
      misfire: true,
      autoMiss: true,
      breaksWeapon: true,
      explodes: false,
      save: null,
      weaponDestroyed: false,
      notes,
    };
  }

  // A second misfire with an already-broken gun.
  if (input.facts.generation === "early") {
    if (input.facts.expertLoading === true) {
      notes.push(
        "Expert Loading (1 grit): the explosion is averted — the firearm keeps its broken condition (gunslinger deed)",
      );
      return {
        misfire: true,
        autoMiss: true,
        breaksWeapon: false,
        explodes: false,
        save: null,
        weaponDestroyed: false,
        notes,
      };
    }
    notes.push(
      "the broken early firearm explodes — a burst from a chosen corner deals its damage, DC 12 Reflex half (UC p.135)",
    );
    notes.push(
      input.facts.magical === true
        ? "the magical firearm is wrecked by the explosion (not merely broken)"
        : "the firearm is destroyed by the explosion",
    );
    return {
      misfire: true,
      autoMiss: true,
      breaksWeapon: false,
      explodes: true,
      save: { dc: 12, half: true },
      weaponDestroyed: true,
      notes,
    };
  }
  // Advanced firearms never explode: the misfire is just the auto-miss, and
  // the gun is already broken.
  notes.push(
    "advanced firearms never explode — the firearm stays broken (UC p.135)",
  );
  return {
    misfire: true,
    autoMiss: true,
    breaksWeapon: false,
    explodes: false,
    save: null,
    weaponDestroyed: false,
    notes,
  };
}

/** The named ways a misfire's broken condition is cleared (re-verified). */
export const MISFIRE_CLEARS = [
  {
    id: "quick-clear",
    name: "Quick Clear (gunslinger deed)",
    cost: "a standard action, requiring at least 1 grit; spending 1 grit makes it a move action",
    effect:
      "removes the broken condition from one wielded firearm, as long as that condition was gained by a firearm misfire",
  },
  {
    id: "gunsmithing",
    name: "Gunsmithing (feat)",
    cost: "1 hour",
    effect: "repairs a broken firearm",
  },
] as const;

/**
 * The ammo gate (§2.9's fix contract): a weapon with no ammunition is
 * impossible to attack with — not merely inaccurate.
 */
export function firearmShotAmmo(input: {
  /** Loaded shots available right now. */
  shotsAvailable: number;
}): { canShoot: boolean; remaining: number; refusal: string | null } {
  if (input.shotsAvailable <= 0) {
    return {
      canShoot: false,
      remaining: 0,
      refusal:
        "the firearm has no shot loaded — a weapon without ammunition is impossible to attack with (§2.9)",
    };
  }
  return {
    canShoot: true,
    remaining: input.shotsAvailable - 1,
    refusal: null,
  };
}
