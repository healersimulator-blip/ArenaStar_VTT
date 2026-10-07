/** GM-owned publication scopes for saved FX definitions (visibility, not invocation or media rights). */
import { describe, expect, test } from "vitest";
import { OWNERSHIP_LEVELS, type MacroDocument, type Ownership, type UserDocument } from "../../src/core/documents";
import { fxShareDraftOf, fxShareError, fxShareOwnership, fxShareableUsers,
  FX_SHARE_USERS_MAX, type FxShareDraft } from "../../src/core/fxSharing";

const user = (id: string, role: UserDocument["role"] = "PLAYER"): UserDocument => ({
  _id: id, type: "user", name: id, ownership: { default: 0 }, flags: {}, system: {},
  role, character: null, color: "#ffffff",
});

const macro = (ownership: Ownership): MacroDocument => ({
  _id: "fx", type: "macro", name: "FX", command: "", kind: "sequence",
  ownership, flags: {}, system: {}, sequence: { version: 1, sections: [] },
});

const players = [user("ivy"), user("rex"), user("trusted", "TRUSTED"),
  user("assistant", "ASSISTANT"), user("gm", "GM")];

describe("FX timeline sharing", () => {
  test("the recipient picker contains named non-GM accounts in stable order", () => {
    expect(fxShareableUsers(players).map(({ _id }) => _id)).toEqual(["ivy", "rex", "trusted"]);
  });

  test("sharing scopes round-trip from ownership without confusing invocation flags", () => {
    expect(fxShareDraftOf(macro({ default: OWNERSHIP_LEVELS.NONE }), players))
      .toEqual({ scope: "gm", userIds: [] });
    expect(fxShareDraftOf(macro({ default: OWNERSHIP_LEVELS.LIMITED }), players))
      .toEqual({ scope: "all", userIds: [] });
    expect(fxShareDraftOf(macro({ default: OWNERSHIP_LEVELS.OBSERVER }), players))
      .toEqual({ scope: "all", userIds: [] });
    expect(fxShareDraftOf(macro({ default: OWNERSHIP_LEVELS.NONE,
      rex: OWNERSHIP_LEVELS.LIMITED, ivy: OWNERSHIP_LEVELS.OBSERVER,
      gm: OWNERSHIP_LEVELS.OWNER, assistant: OWNERSHIP_LEVELS.OWNER,
      departed: OWNERSHIP_LEVELS.OWNER }), players))
      .toEqual({ scope: "selected", userIds: ["ivy", "rex"] });
  });

  test("ownership maps keep GM-only, all-player and selected-player access distinct", () => {
    expect(fxShareOwnership({ scope: "gm", userIds: ["rex"] }))
      .toEqual({ default: OWNERSHIP_LEVELS.NONE });
    expect(fxShareOwnership({ scope: "all", userIds: [] }))
      .toEqual({ default: OWNERSHIP_LEVELS.OBSERVER });
    expect(fxShareOwnership({ scope: "selected", userIds: ["rex", "rex", "ivy"] }))
      .toEqual({ default: OWNERSHIP_LEVELS.NONE, rex: OWNERSHIP_LEVELS.OBSERVER,
        ivy: OWNERSHIP_LEVELS.OBSERVER });
  });

  test("selected sharing requires current non-GM recipients and enforces its size bound", () => {
    const selected: FxShareDraft = { scope: "selected", userIds: ["rex"] };
    expect(fxShareError(selected, players)).toBeNull();
    expect(fxShareError({ scope: "selected", userIds: [] }, players)).toContain("Choose at least one player");
    expect(fxShareError({ scope: "selected", userIds: ["gm"] }, players)).toContain("non-GM");
    expect(fxShareError({ scope: "selected", userIds: ["assistant"] }, players)).toContain("non-GM");
    expect(fxShareError({ scope: "selected", userIds: ["departed"] }, players)).toContain("non-GM");

    const many = Array.from({ length: FX_SHARE_USERS_MAX + 1 }, (_, index) =>
      user(`player-${String(index).padStart(2, "0")}`));
    const tooMany = { scope: "selected", userIds: many.map(({ _id }) => _id) } as FxShareDraft;
    expect(fxShareError(tooMany, many)).toContain(`at most ${String(FX_SHARE_USERS_MAX)}`);
  });

  test("GM/all scopes ignore stale recipient draft ids and reject an unknown scope", () => {
    expect(fxShareError({ scope: "gm", userIds: ["departed"] }, players)).toBeNull();
    expect(fxShareError({ scope: "all", userIds: ["departed"] }, players)).toBeNull();
    expect(fxShareError({ scope: "private" as FxShareDraft["scope"], userIds: [] }, players))
      .toContain("Choose GM-only");
  });
});
