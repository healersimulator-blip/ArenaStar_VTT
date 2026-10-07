import { describe, expect, test } from "vitest";
import type { ClientSync } from "../../src/client/sync";
import type { ActorDocument, Json, MacroDocument, MessageDocument, SceneDocument, TokenDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { deriveFromActorDocument } from "../../src/packages/pf1e/actor";
import { quickbarCandidates, candidateToEntry } from "../../src/ui/quickbar/model";
import { runQuickbarEntry } from "../../src/ui/quickbar/run";

const gm = { id: "gm", role: "GM" as const };

function actor(id: string, patch: Record<string, Json> = {}): ActorDocument {
  return {
    _id: id, type: "actor", name: id, ownership: { default: 3 }, flags: {},
    system: { pf1e: {
      abilities: { int: 16, con: 12, str: 10, dex: 10, wis: 10, cha: 10 },
      hp: 20, hpMax: 20, saves: { fort: 0, ref: 0, will: 0 },
      ...patch,
    } }, items: [], effects: [],
  };
}

function token(id: string, actorId: string, x: number): TokenDocument {
  return {
    _id: id, type: "token", name: id, ownership: { default: 3 }, flags: {}, system: {},
    x, y: 100, rotation: 0, width: 100, height: 100, img: "", actorId,
    hidden: false, disposition: "neutral", vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  };
}

const scene: SceneDocument = {
  _id: "s1", type: "scene", name: "Test", ownership: { default: 3 }, flags: {}, system: {},
  active: true, img: null, width: 1000, height: 800, darkness: 0,
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
  tokens: [token("t-caster", "a-caster", 100), token("t-target", "a-target", 300)],
  walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
};

const boundCue: MacroDocument = {
  _id: "fx-mage-armor", type: "macro", name: "Mage Armor shimmer", command: "",
  kind: "sequence", ownership: { default: 3 }, flags: {}, system: {},
  fxSpell: { spellId: "mage-armor", spellName: "Mage Armor", onFailureId: "fx-mage-armor-fizzle" },
  sequence: { version: 1, audience: "scene", sections: [{
    id: "spark", kind: "text", text: "Arcane sparks", startMs: 0, durationMs: 400,
    at: { kind: "point", x: 100, y: 100 },
  }] },
};

const boundFailureCue: MacroDocument = {
  ...boundCue,
  _id: "fx-mage-armor-fizzle",
  name: "Mage Armor fizzle",
  fxSpell: { spellId: "sleep" },
};

class FakeQuickbarClient {
  readonly user = gm;
  readonly messages: MessageDocument[] = [];
  readonly submissions: Op[][] = [];
  readonly sequenceRequests: Array<[string, string, string, string]> = [];
  private rollIndex = 0;
  readonly macros: MacroDocument[] = [boundCue, boundFailureCue];
  readonly store = {
    getAll: (coll: string): readonly unknown[] => coll === "messages" ? this.messages
      : coll === "macros" ? this.macros : coll === "scenes" ? [scene] : [],
    get: (coll: string, id: string): unknown => coll === "scenes" && id === scene._id
      ? scene : coll === "macros" ? this.macros.find((macro) => macro._id === id) : undefined,
  };

  roll(formula: string): string {
    const rollId = `quickbar-roll-${this.rollIndex++}`;
    this.messages.push({
      _id: `message-${rollId}`, type: "message", name: formula, ownership: { default: 1 },
      flags: { core: { rollId } }, system: {}, author: "gm", content: formula, whisper: [],
      roll: { formula, total: 4, terms: [{ kind: "dice", expr: formula, rolls: [3], kept: [3], total: 4 }],
        seedClient: null, seedHost: null, commit: null }, flavor: "",
    });
    return rollId;
  }

  submit(ops: Op[]): string {
    this.submissions.push(ops);
    return `tx-${this.submissions.length}`;
  }

  requestSequence(macroId: string, sceneId: string, sourceTokenId: string, targetTokenId: string): string {
    this.sequenceRequests.push([macroId, sceneId, sourceTokenId, targetTokenId]);
    return "sequence-request";
  }
}

describe("quickbar casts for non-catalogue compendium spells", () => {
  const caster = actor("a-caster", { spells: {
    keyAbility: "int", mode: "prepared", casterLevel: 5,
    slotsPerDay: { 1: 3 }, slotsUsed: { 1: 0 },
    prepared: [{ name: "Mage Armor", level: 1, slotLevel: 1, components: "" }],
  } });
  const target = actor("a-target", { hp: 20, hpMax: 20, saves: { fort: 0, ref: 0, will: 0 } });
  const derived = deriveFromActorDocument(caster, {});
  const candidate = quickbarCandidates(caster, derived).find((row) => row.label === "Mage Armor (level 1)");
  if (!candidate) throw new Error("Mage Armor candidate missing");

  test("uses the reviewed profile and fires the exact normalized spell binding after commit", async () => {
    const client = new FakeQuickbarClient();
    const entry = candidateToEntry(1, candidate, {
      saveType: "ref", severity: "none", damageFormula: "",
    });
    const result = await runQuickbarEntry({
      client: client as unknown as ClientSync,
      actor: caster,
      entry,
      target,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.note).toContain("Mage Armor");
    expect(result.note).toContain('bound spell cue "Mage Armor shimmer" requested');
    expect(client.sequenceRequests).toEqual([[
      "fx-mage-armor", "s1", "t-caster", "t-target",
    ]]);
    expect(client.submissions.flat().some((op) => op.kind === "update" &&
      op.ref.coll === "actors" && op.ref.id === caster._id)).toBe(true);
    expect(client.submissions.flat().some((op) => op.kind === "create" && op.coll === "messages"))
      .toBe(true); // the cast committed its action card before requesting FX
    expect(client.messages).toEqual([]); // no save/damage dice were invented
  });

  test("a committed lost cast requests its configured failure cue", async () => {
    const failedCaster = actor("a-caster", {
      armor: { spellFailure: 100 },
      spells: {
        keyAbility: "int", mode: "prepared", casterLevel: 5,
        slotsPerDay: { 1: 3 }, slotsUsed: { 1: 0 },
        prepared: [{ name: "Mage Armor", level: 1, slotLevel: 1, components: "V, S" }],
      },
    });
    const failedView = deriveFromActorDocument(failedCaster, {});
    const failedCandidate = quickbarCandidates(failedCaster, failedView)
      .find((row) => row.label === "Mage Armor (level 1)");
    if (!failedCandidate) throw new Error("Mage Armor candidate missing");
    const client = new FakeQuickbarClient();
    const entry = candidateToEntry(1, failedCandidate, {
      saveType: "ref", severity: "none", damageFormula: "",
    });
    const result = await runQuickbarEntry({ client: client as unknown as ClientSync,
      actor: failedCaster, entry, target });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toContain("was lost before it resolved");
    expect(result.error).toContain('bound spell failure cue "Mage Armor fizzle" requested');
    expect(client.sequenceRequests).toEqual([[
      "fx-mage-armor-fizzle", "s1", "t-caster", "t-target",
    ]]);
  });

  test("does not invent mechanics or request FX when the manual profile is absent", async () => {
    const client = new FakeQuickbarClient();
    const entry = candidateToEntry(1, candidate);
    const result = await runQuickbarEntry({
      client: client as unknown as ClientSync,
      actor: caster,
      entry,
      target,
    });
    expect(result).toEqual({ ok: false,
      error: "Mage Armor needs a reviewed save, severity and damage profile in its quickbar binding" });
    expect(client.sequenceRequests).toEqual([]);
    expect(client.messages).toEqual([]);
  });
});
