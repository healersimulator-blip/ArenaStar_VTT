/**
 * P4/E02 — the custom effect editor model, the in-place edit ops, and the token
 * menu's "Apply effect…" application flow. The persistence/authorization
 * mechanics themselves are E01's (pf1eEffectOps.test.ts) — here the editor's
 * form assembly, round-trip honesty and edit paths are under test.
 */
import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CombatDocument,
  CombatantDocument,
  Json,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import {
  buildEffectDoc,
  combinedTacticalEffects,
  pf1eApplyCombatantEffect,
  pf1eEditActorEffect,
  pf1eEditCombatantEffect,
} from "../../src/packages/pf1e/effectOps";
import {
  buildEffectRequest,
  emptyEffectForm,
  formFromEffect,
  parseTokenList,
  PF1E_MOD_KEYS,
  SRD_CONDITION_NAMES,
  type EffectForm,
} from "../../src/ui/sheets/pf1eEffectEditorModel";
import {
  applyTokenMenuEntry,
  tokenContextMenuModel,
} from "../../src/ui/combat/tokenContextMenu";

/** Guard instead of `!` — the lint forbids non-null assertions. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`missing fixture value: ${what}`);
  return value;
}

const gm: PermissionUser = { id: "gm", role: "GM" };
const player: PermissionUser = { id: "wedge", role: "PLAYER" };
const stranger: PermissionUser = { id: "mallory", role: "PLAYER" };

function actor(): ActorDocument {
  return {
    _id: "wedge",
    type: "actor",
    name: "Wedge",
    ownership: { default: 2, wedge: 3 },
    flags: {},
    system: { pf1e: { abilities: { str: 12 } } },
    items: [],
    effects: [],
  };
}

function token(id: string, actorId?: string): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    x: 0,
    y: 0,
    rotation: 0,
    width: 1,
    height: 1,
    img: "",
    ...(actorId !== undefined ? { actorId } : {}),
    hidden: false,
    disposition: "friendly",
    vision: false,
    light: { radius: 0, color: "", alpha: 0 },
  };
}

function scene(...tokens: TokenDocument[]): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Scene",
    ownership: { default: 1 },
    flags: {},
    system: {},
    active: true,
    tokens,
    walls: [],
    lights: [],
    sounds: [],
    notes: [],
  } as unknown as SceneDocument;
}

function combat(...cs: CombatantDocument[]): CombatDocument {
  return {
    _id: "enc",
    type: "combat",
    name: "fight",
    ownership: { default: 1 },
    flags: {},
    system: {},
    round: 0,
    turn: 0,
    combatants: cs,
  };
}

function combatant(
  id: string,
  tokenId: string | null = null,
): CombatantDocument {
  return {
    _id: id,
    type: "combatant",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    tokenId,
    actorId: tokenId === "hero" ? "wedge" : null,
    initiative: 15,
    hidden: false,
    defeated: false,
  };
}

describe("pf1eEffectEditorModel — form assembly (E02)", () => {
  test("a full form builds a payload that survives the P0 validator and core doc shaping", () => {
    const form: EffectForm = {
      ...emptyEffectForm(),
      name: "Rage",
      icon: "😡",
      condition: "",
      mods: [
        { key: "attack", type: "morale", value: "+2", source: "" },
        { key: "damage", type: "morale", value: "-2", source: "rage penalty" },
        { key: "ac", type: "dodge", value: "-2", source: "" },
      ],
      boosts: [
        { dice: "2", sides: "6", bonus: "", energy: "", precision: false },
      ],
      denies: "cast-spell, Concentrate",
      grants: "uncanny-dodge",
      stackGroup: "rage",
      concentration: false,
      flatFooted: false,
      deniedDexToAc: false,
      cannotAoO: false,
      immuneMindAffecting: false,
      immuneConditions: "",
      immuneEnergy: "",
      immuneDr: "",
      ttlUnit: "round",
      ttlValue: "6",
      ttlPerLevel: true,
      ttlEndsOn: "round-start",
      sourceKind: "spell",
      sourceId: "rage",
      sourceLevel: "8",
      sourceDc: "",
    };
    const { request, error } = buildEffectRequest(form);
    expect(error).toBeNull();
    expect(request).not.toBeNull();
    const doc = buildEffectDoc(must(request, "built request"));
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    // duration seeded: 6 rounds/level at CL 8 = 48 ticks; denies normalized.
    expect((doc.value.flags.core as Record<string, Json>).duration).toBe(48);
    expect((doc.value.flags.pf1e as Record<string, Json>).denies).toEqual([
      "cast-spell",
      "concentrate",
    ]);
    expect((doc.value.flags.pf1e as Record<string, Json>).stackGroup).toBe(
      "rage",
    );
  });

  test("empty numbers are absent, garbage is a named error — never a silent zero", () => {
    const blank = buildEffectRequest({
      ...emptyEffectForm(),
      name: "Plain",
      mods: [{ key: "", type: "untyped", value: "", source: "" }],
    });
    expect(blank.error).toBeNull();
    expect(must(blank.request, "blank request").payload).toEqual({});

    const garbage = buildEffectRequest({
      ...emptyEffectForm(),
      name: "Broken",
      mods: [{ key: "attack", type: "morale", value: "two", source: "" }],
    });
    expect(garbage.request).toBeNull();
    expect(garbage.error).toMatch(
      /Modifier row 1 value must be a whole number/,
    );

    const boostMissing = buildEffectRequest({
      ...emptyEffectForm(),
      name: "Broken boost",
      boosts: [
        { dice: "", sides: "6", bonus: "", energy: "", precision: false },
      ],
    });
    expect(boostMissing.error).toMatch(
      /Boost row 1 needs dice or a flat bonus/,
    );

    const tinyDie = buildEffectRequest({
      ...emptyEffectForm(),
      name: "Broken die",
      boosts: [
        { dice: "1", sides: "1", bonus: "", energy: "", precision: false },
      ],
    });
    expect(tinyDie.error).toMatch(/die size of at least 2/);
  });

  test("parseTokenList is whitespace/comma tolerant and lowercased", () => {
    expect(parseTokenList("Charge,  full-attack\ncast-spell")).toEqual([
      "charge",
      "full-attack",
      "cast-spell",
    ]);
    expect(parseTokenList("")).toEqual([]);
  });

  test("form round-trip: effect → form → request → doc → read → same payload facts", () => {
    const built = buildEffectDoc({
      id: "e1",
      name: "Shield of faith",
      payload: {
        mods: [{ key: "ac", type: "deflection", value: 2 }],
        condition: "Sickened",
        ttl: {
          unit: "minute",
          value: 1,
          perLevel: true,
          endsOn: "round-start",
        },
        source: { kind: "spell", level: 3, dc: 17 },
        denies: ["aoo"],
        immune: { mindAffecting: true, energy: ["fire"], dr: 5 },
        flags: { cannotAoO: true },
      },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const read = combinedTacticalEffects(
      { ...actor(), effects: [built.value] },
      null,
      null,
    ).effects[0];
    if (read === undefined) throw new Error("fixture: read effect missing");
    const form = formFromEffect(read);
    expect(form.name).toBe("Shield of faith");
    expect(form.condition).toBe("Sickened");
    expect(form.mods).toEqual([
      { key: "ac", type: "deflection", value: "2", source: "" },
    ]);
    expect(form.ttlUnit).toBe("minute");
    expect(form.ttlPerLevel).toBe(true);
    expect(form.ttlEndsOn).toBe("round-start");
    expect(form.sourceKind).toBe("spell");
    expect(form.sourceLevel).toBe("3");
    expect(form.sourceDc).toBe("17");
    expect(form.denies).toBe("aoo");
    expect(form.immuneMindAffecting).toBe(true);
    expect(form.immuneEnergy).toBe("fire");
    expect(form.immuneDr).toBe("5");
    expect(form.cannotAoO).toBe(true);

    const rebuilt = buildEffectRequest(form);
    expect(rebuilt.error).toBeNull();
    const rebuiltDoc = buildEffectDoc({
      id: "e1",
      ...must(rebuilt.request, "rebuilt request"),
    });
    expect(rebuiltDoc.ok).toBe(true);
    if (!rebuiltDoc.ok) return;
    const reread = combinedTacticalEffects(
      { ...actor(), effects: [rebuiltDoc.value] },
      null,
      null,
    ).effects[0];
    if (reread === undefined) throw new Error("fixture: reread effect missing");
    expect(reread.payload).toEqual(read.payload);
  });

  test("the closed mod-key contract and the SRD condition picker are presentation data", () => {
    expect(PF1E_MOD_KEYS.length).toBeGreaterThan(20);
    expect(SRD_CONDITION_NAMES).toContain("Prone");
    expect(SRD_CONDITION_NAMES).toContain("Flat-footed");
    // The picker only labels — it does not smuggle mechanics into the payload.
    const labeled = buildEffectRequest({
      ...emptyEffectForm(),
      name: "Labeled",
      condition: "Prone",
    });
    expect(must(labeled.request, "labeled request").payload).toEqual({
      condition: "Prone",
    });
  });
});

describe("pf1eEditActorEffect / pf1eEditCombatantEffect — in-place edits (E02)", () => {
  test("an edit keeps the id and suppression state, swaps the payload and re-seeds duration", () => {
    const applied = pf1eApplyCombatantEffect(
      combat(combatant("c1", "hero")),
      gm,
      "c1",
      {
        id: "bs",
        name: "Bull's Strength",
        payload: {
          mods: [{ key: "ability.str", type: "enhancement", value: 4 }],
          ttl: { unit: "round", value: 3 },
        },
      },
    );
    expect(applied.error).toBeNull();
    // Suppress it, then edit: the suppression survives the edit.
    const baseCombat = applied.combat;
    const member = baseCombat !== null ? baseCombat.combatants[0] : undefined;
    if (baseCombat === null || member === undefined)
      throw new Error("fixture: combatant missing");
    const memberEffects = ((member.flags.core as Record<string, Json>)
      .effects ?? {}) as Record<string, Json>;
    const withFlags: CombatantDocument = {
      ...member,
      flags: {
        core: {
          effects: {
            ...memberEffects,
            bs: {
              ...(memberEffects.bs as Record<string, Json>),
              disabled: true,
            },
          },
        },
      },
    };
    const suppressed: CombatDocument = {
      ...baseCombat,
      combatants: [withFlags],
    };
    const edited = pf1eEditCombatantEffect(suppressed, gm, "c1", "bs", {
      id: "bs",
      name: "Bull's Strength (greater)",
      payload: {
        mods: [{ key: "ability.str", type: "enhancement", value: 6 }],
        ttl: { unit: "minute", value: 1 },
      },
    });
    expect(edited.error).toBeNull();
    const editedCombat = edited.combat;
    const after =
      editedCombat !== null ? editedCombat.combatants[0] : undefined;
    if (editedCombat === null || after === undefined)
      throw new Error("fixture: edited combatant missing");
    const doc = (
      (after.flags.core as Record<string, Json>).effects as Record<string, Json>
    ).bs as {
      name: string;
      disabled: boolean;
      flags: { core: { duration: number }; pf1e: Record<string, Json> };
    };
    expect(doc.name).toBe("Bull's Strength (greater)");
    expect(doc.disabled).toBe(true);
    expect(doc.flags.core.duration).toBe(10); // 1 minute re-seeded
    expect(doc.flags.pf1e.mods).toEqual([
      { key: "ability.str", type: "enhancement", value: 6 },
    ]);
  });

  test("actor edits are permission-checked and refuse unknown ids; the derivation follows", () => {
    const withEffect: ActorDocument = {
      ...actor(),
      effects: [
        {
          _id: "e1",
          type: "effect" as const,
          name: "Old",
          ownership: { default: 0 },
          flags: {
            pf1e: { mods: [{ key: "attack", type: "morale", value: 1 }] },
          },
          system: {},
          changes: [],
          disabled: false,
        },
      ],
    };
    const edited = pf1eEditActorEffect(withEffect, gm, "e1", {
      name: "New",
      payload: { mods: [{ key: "attack", type: "morale", value: 3 }] },
    });
    expect(edited.error).toBeNull();
    const editedOp = edited.ops[0];
    if (editedOp === undefined) throw new Error("fixture: edit op missing");
    const updated: ActorDocument = {
      ...withEffect,
      effects: (
        editedOp.diff as unknown as { effects: ActorDocument["effects"] }
      ).effects,
    };
    const read = combinedTacticalEffects(updated, null, null).effects;
    expect(
      deriveFromDocuments({ actor: updated, effects: read }).attacks[0]
        ?.attackBonuses[0],
    ).toBeDefined();

    expect(
      pf1eEditActorEffect(withEffect, stranger, "e1", {
        name: "N",
        payload: {},
      }).error,
    ).toMatch(/do not own/);
    expect(
      pf1eEditActorEffect(withEffect, gm, "ghost", { name: "N", payload: {} })
        .error,
    ).toMatch(/not on this actor/);
    expect(
      pf1eEditActorEffect(withEffect, gm, "e1", { name: " ", payload: {} })
        .error,
    ).toMatch(/name is required/);
  });
});

describe("token menu — Apply effect… (E02 token application)", () => {
  test("the entry appears for PF1e-linked tokens, gated by actor ownership", () => {
    const linked = token("hero", "wedge");
    const plain = token("lurker");
    const a = actor();
    const model = tokenContextMenuModel({
      combat: null,
      scene: scene(linked, plain),
      token: linked,
      user: gm,
      actors: [a],
    });
    const entry = must(
      model.entries.find((e) => e.id === "apply-effect"),
      "apply-effect entry",
    );
    expect(entry.disabled).toBe(false);

    const forStranger = tokenContextMenuModel({
      combat: null,
      scene: scene(linked, plain),
      token: linked,
      user: stranger,
      actors: [a],
    });
    const strangerEntry = must(
      forStranger.entries.find((e) => e.id === "apply-effect"),
      "stranger entry",
    );
    expect(strangerEntry.disabled).toBe(true);
    expect(strangerEntry.reason).toMatch(/cannot update this actor/);

    const plainModel = tokenContextMenuModel({
      combat: null,
      scene: scene(linked, plain),
      token: plain,
      user: gm,
      actors: [a],
    });
    const plainEntry = must(
      plainModel.entries.find((e) => e.id === "apply-effect"),
      "plain entry",
    );
    expect(plainEntry.disabled).toBe(true);
    expect(plainEntry.reason).toMatch(/no PF1e actor/);
  });

  test("applyTokenMenuEntry returns the actor whose Effects tab should open", () => {
    const linked = token("hero", "wedge");
    const ok = applyTokenMenuEntry({
      combat: null,
      scene: scene(linked),
      token: linked,
      user: player,
      actors: [actor()],
      entryId: "apply-effect",
      nextId: () => "n1",
    });
    expect(ok.error).toBeNull();
    expect(ok.ops).toHaveLength(0);
    expect(ok.openEffectEditorActorId).toBe("wedge");

    const denied = applyTokenMenuEntry({
      combat: null,
      scene: scene(linked),
      token: linked,
      user: stranger,
      actors: [actor()],
      entryId: "apply-effect",
      nextId: () => "n1",
    });
    expect(denied.error).toMatch(/cannot update this actor/);
    expect(denied.openEffectEditorActorId).toBeNull();
  });
});
