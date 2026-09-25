/**
 * D-311 (SQ-12 / A09, WZ-05) — firing the cue an item is bound to.
 *
 * The **use** half of an item binding. The rules live in `core/fxBinding` (the authored shape
 * and which branch a committed outcome plays); this module joins them to a live client: which
 * of the timelines this reader can see names that item, which scene and tokens the run should
 * name, and the one call that actually asks for the cue.
 *
 * Two boundaries the call sites below rely on:
 *
 * - **After the commit.** Every caller fires this *after* its own flow has committed (charges,
 *   slots, hit points) — that is what makes "the branch uses the committed result" true rather
 *   than aspirational, and it is why a refused or failed use plays the failure cue (the use
 *   *did* commit) while a rejected one plays nothing (there is no result to recognise).
 * - **The client is never trusted.** This only *names* a timeline the reader can already see;
 *   the host re-checks the caller's rights on the ordinary `fx.request` path, so a binding the
 *   reader could not run by hand is refused here exactly as it would be there.
 */
import type { ClientSync } from "../../client/sync";
import type { ActorDocument, ItemDocument, MacroDocument, SceneDocument, TokenDocument } from "../../core/documents";
import { fxBindingBranch, fxBindingMatches } from "../../core/fxBinding";

/**
 * What the committed use was, as the binding's recognition reads it. `unknown` is an answer:
 * a cast whose effect has not landed yet (a multi-round casting) has no committed result, so
 * no branch can honestly be chosen.
 */
export type FxItemOutcome = "success" | "failure" | "unknown";

/** The facts a committed item use carries that recognition needs (a structural subset). */
export interface FxItemOutcomeFacts {
  /** The spell was ruined after committing (the slot is spent, nothing resolves). */
  lost?: boolean;
  /** A melee touch missed: the charge is spent and held. */
  held?: boolean;
  /** The effect is deferred (a longer casting time); nothing has landed yet. */
  pending?: unknown;
  /** Spell resistance or the saving throw: `resisted`/`passed` mean the spell did *not* land. */
  result?: { resisted?: boolean; passed?: boolean };
  /** A touch attack that delivered the spell, when one was declared. */
  touch?: { hit?: boolean };
}

/**
 * Recognise the committed outcome — the automatic rule an author can override. A lost spell, a
 * held charge, a missed touch attack, spell resistance and a made saving throw are all
 * **failures** for this purpose: each of them means the effect did not land on the target.
 */
export function fxCastOutcome(facts: FxItemOutcomeFacts): FxItemOutcome {
  if (facts.pending !== undefined && facts.pending !== null) return "unknown";
  if (facts.lost === true || facts.held === true) return "failure";
  if (facts.touch?.hit === false) return "failure";
  if (facts.result?.resisted === true || facts.result?.passed === true) return "failure";
  return "success";
}

/** The timelines this reader can see that name that item (the projection already gated them). */
export function boundCuesFor(client: ClientSync, actorId: string, itemId: string): MacroDocument[] {
  return (client.store.getAll("macros") as readonly MacroDocument[])
    .filter((macro) => macro.kind === "sequence" && fxBindingMatches(macro, actorId, itemId))
    .sort((a, b) => a._id.localeCompare(b._id));
}

/** The first bound timeline, for the item window's read-only line. */
export function boundCueFor(client: ClientSync, actorId: string, itemId: string): MacroDocument | null {
  return boundCuesFor(client, actorId, itemId)[0] ?? null;
}

/** A token of that actor on that scene, if the table has one. */
function tokenFor(scene: SceneDocument | null, actorId: string): TokenDocument | undefined {
  return scene?.tokens.find((token) => token.actorId === actorId);
}

/**
 * The scene a bound cue should run in: the table's active scene, or — with none marked — the
 * first one the caster actually stands in. A caster whose token is nowhere is not a reason to
 * play nothing: plenty of cues name no token at all, so the run proceeds in the scene the
 * table is looking at and the host's own anchor rules decide the rest.
 */
function cueScene(client: ClientSync, actorId: string): SceneDocument | null {
  const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
  return scenes.find((scene) => scene.active) ??
    scenes.find((scene) => tokenFor(scene, actorId) !== undefined) ??
    null;
}

export type FxItemCueResult =
  | { fired: false; reason: "unbound" | "disabled" | "no-branch" | "no-scene" }
  | { fired: true; macroId: string; macroName: string; branch: FxItemOutcome; note: string };

/**
 * Ask for the cue a committed item use is bound to. Returns what happened rather than throwing:
 * every reason is a sentence the caller can show, and `unbound` is the common, silent case (an
 * item with no binding is not a problem to report).
 */
export function fireBoundItemCue(input: {
  client: ClientSync;
  actor: ActorDocument;
  item: Pick<ItemDocument, "_id" | "name">;
  outcome: FxItemOutcome;
  /** The use's own target, when the flow has one: the cue's `target` anchor. */
  targetActor?: ActorDocument | null;
}): FxItemCueResult {
  const { client, actor, item } = input;
  const macro = boundCueFor(client, actor._id, item._id);
  if (macro === null) return { fired: false, reason: "unbound" };
  const branch = fxBindingBranch(macro, input.outcome === "failure" ? "failure" : "success");
  if (branch === null)
    return { fired: false, reason: macro.fxItem?.enabled === false ? "disabled" : "no-branch" };
  const scene = cueScene(client, actor._id);
  if (scene === null) return { fired: false, reason: "no-scene" };
  const source = tokenFor(scene, actor._id);
  const target = input.targetActor ? tokenFor(scene, input.targetActor._id) : undefined;
  client.requestSequence(branch, scene._id, source?._id, target?._id);
  // The note names the timeline actually asked for — on a failure that is the failure cue, not
  // the item's own, and the two are different documents with different names.
  const branchName = (client.store.get("macros", branch) as MacroDocument | undefined)?.name ?? branch;
  return { fired: true, macroId: branch, macroName: branchName, branch: input.outcome,
    note: branch === macro._id
      ? `bound cue "${branchName}" requested`
      : `bound failure cue "${branchName}" requested` };
}
