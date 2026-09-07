import { describe, expect, test } from "vitest";
import { can, getEffectiveOwnership } from "../../src/core/permissions";
import { OWNERSHIP_LEVELS, type BaseDocument } from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";

const gm: PermissionUser = { id: "gm-key", role: "GM" };
const assistant: PermissionUser = { id: "as-key", role: "ASSISTANT" };
const trusted: PermissionUser = { id: "tr-key", role: "TRUSTED" };
const player: PermissionUser = { id: "pl-key", role: "PLAYER" };
const otherPlayer: PermissionUser = { id: "ot-key", role: "PLAYER" };

function doc(ownership: Partial<BaseDocument["ownership"]> = {}): BaseDocument {
  return {
    _id: "d1",
    type: "actor",
    name: "Doc",
    ownership: { default: OWNERSHIP_LEVELS.NONE, ...ownership },
    flags: {},
    system: {},
  };
}

const sceneParent: BaseDocument = {
  ...doc(),
  _id: "scene1",
  type: "scene",
  name: "Scene",
  ownership: { default: OWNERSHIP_LEVELS.NONE },
};

describe("getEffectiveOwnership (§4)", () => {
  test("GM and ASSISTANT are always OWNER (D-013)", () => {
    expect(getEffectiveOwnership(gm, doc())).toBe(OWNERSHIP_LEVELS.OWNER);
    expect(getEffectiveOwnership(assistant, doc())).toBe(OWNERSHIP_LEVELS.OWNER);
  });

  test("per-user override beats default; max is taken", () => {
    const d = doc({ default: OWNERSHIP_LEVELS.NONE, "pl-key": OWNERSHIP_LEVELS.OBSERVER });
    expect(getEffectiveOwnership(player, d)).toBe(OWNERSHIP_LEVELS.OBSERVER);
    expect(getEffectiveOwnership(otherPlayer, d)).toBe(OWNERSHIP_LEVELS.NONE);
  });

  test("embedded docs cascade through their parent (D-014)", () => {
    const army: BaseDocument = {
      ...doc(),
      _id: "army1",
      type: "army",
      ownership: { default: OWNERSHIP_LEVELS.NONE, "pl-key": OWNERSHIP_LEVELS.OWNER },
    };
    const unit: BaseDocument = {
      ...doc(),
      _id: "unit1",
      type: "unit",
      ownership: { default: OWNERSHIP_LEVELS.NONE },
    };
    expect(getEffectiveOwnership(player, unit, army)).toBe(OWNERSHIP_LEVELS.OWNER);
    expect(getEffectiveOwnership(otherPlayer, unit, army)).toBe(OWNERSHIP_LEVELS.NONE);
  });
});

describe("can() — Foundry default rules (§4)", () => {
  test("GM/ASSISTANT may do everything", () => {
    for (const user of [gm, assistant]) {
      expect(can(user, "create", doc(), "actors")).toBe(true);
      expect(can(user, "read", doc(), "actors")).toBe(true);
      expect(can(user, "update", doc(), "actors")).toBe(true);
      expect(can(user, "delete", doc(), "actors")).toBe(true);
      expect(can(user, "order", doc(), "units")).toBe(true);
    }
  });

  test("OWNER level may update/delete; OBSERVER may only read; LIMITED reads partially", () => {
    const owned = doc({ default: OWNERSHIP_LEVELS.OWNER });
    expect(can(player, "update", owned, "actors")).toBe(true);
    expect(can(player, "delete", owned, "actors")).toBe(true);

    const observed = doc({ default: OWNERSHIP_LEVELS.OBSERVER });
    expect(can(player, "read", observed, "actors")).toBe(true);
    expect(can(player, "update", observed, "actors")).toBe(false);

    const limited = doc({ default: OWNERSHIP_LEVELS.LIMITED });
    expect(can(player, "read", limited, "actors")).toBe(true); // partial content is projection's job

    const none = doc({ default: OWNERSHIP_LEVELS.NONE });
    expect(can(player, "read", none, "actors")).toBe(false);
  });

  test("TRUSTED may create tokens/drawings/templates, nothing else", () => {
    expect(can(trusted, "create", doc(), "tokens")).toBe(true);
    expect(can(trusted, "create", doc(), "drawings")).toBe(true);
    expect(can(trusted, "create", doc(), "templates")).toBe(true);
    expect(can(trusted, "create", doc(), "actors")).toBe(false);
    expect(can(player, "create", doc(), "tokens")).toBe(false);
  });

  test("players may create chat messages (host stamps author)", () => {
    expect(can(player, "create", doc(), "messages")).toBe(true);
    expect(can(trusted, "create", doc(), "messages")).toBe(true);
  });

  test("order: OWNER on unit or cascaded army (§4A)", () => {
    const thirdPlayer: PermissionUser = { id: "th-key", role: "PLAYER" };
    const army: BaseDocument = {
      ...doc(),
      type: "army",
      ownership: { default: OWNERSHIP_LEVELS.NONE, "pl-key": OWNERSHIP_LEVELS.OWNER },
    };
    const unit: BaseDocument = {
      ...doc(),
      type: "unit",
      ownership: { default: OWNERSHIP_LEVELS.NONE },
    };
    // army owner may order any unit of the army (cascade)
    expect(can(player, "order", unit, "units", { parent: army })).toBe(true);
    // unrelated player may not
    expect(can(otherPlayer, "order", unit, "units", { parent: army })).toBe(false);
    expect(can(thirdPlayer, "order", unit, "units", { parent: army })).toBe(false);

    // direct unit ownership also grants order, even to a non-army-owner …
    const selfOwnedUnit: BaseDocument = {
      ...doc(),
      type: "unit",
      ownership: { default: OWNERSHIP_LEVELS.NONE, "ot-key": OWNERSHIP_LEVELS.OWNER },
    };
    expect(can(otherPlayer, "order", selfOwnedUnit, "units", { parent: army })).toBe(true);
    // … but a third player with no stake anywhere still may not
    expect(can(thirdPlayer, "order", selfOwnedUnit, "units", { parent: army })).toBe(false);

    // order applies to units only
    expect(can(player, "order", doc({ "pl-key": OWNERSHIP_LEVELS.OWNER }), "actors")).toBe(false);
  });

  test("embedded reads cascade scene ownership", () => {
    const secretScene: BaseDocument = {
      ...sceneParent,
      ownership: { default: OWNERSHIP_LEVELS.NONE, "pl-key": OWNERSHIP_LEVELS.OBSERVER },
    };
    const token: BaseDocument = {
      ...doc(),
      type: "token",
      ownership: { default: OWNERSHIP_LEVELS.NONE },
    };
    expect(can(player, "read", token, "tokens", { parent: secretScene })).toBe(true);
    expect(can(otherPlayer, "read", token, "tokens", { parent: secretScene })).toBe(false);
  });
});
