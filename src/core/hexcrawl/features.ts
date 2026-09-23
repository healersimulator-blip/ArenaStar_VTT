/**
 * **Hidden features and the rule that reveals them (D-275, plan §3.5, requirement 8).**
 *
 * A cell can hide things — a shrine, a lair, a cache, a corpse in the reeds — each carrying a
 * rule for what uncovers it: *the GM decides* (`manual`), *a Perception check* (`perception`,
 * passive by default, an actual roll when the feature asks for one), *time spent* (`time`), or
 * *a dice check* (`dice`). `autoReveal` says whether the client that evaluates the rule flips
 * the state itself or leaves it to the GM's checkbox — requirement 8's "automatic or checkbox",
 * and the two halves live in the same document on purpose: a rule the engine may not apply on
 * its own is still shown to the GM in plain words, so there is something to rule on.
 *
 * Three decisions worth stating:
 *
 * - **This module is pure, and the caller brings the facts.** Perception is read off the PF1e
 *   derivation (`packages/pf1e` — a rules package; `core` does not depend on a ruleset), time
 *   comes from the travel ledger and the explore action, and dice come from the injected `RngFn`.
 *   That is the split `encounter.ts` already uses for its draws, and it is why the whole rule
 *   matrix is testable in Node.
 * - **A reveal is one `update` on the cell carrying the whole `features` array**, beside one
 *   `update` carrying the accumulated time — both submitted in the same envelope. The array is
 *   what `revealFeatureOps` patches (Phase 2), the counter is `flags.core.exploredSeconds`, and
 *   writing them together is what stops a feature from claiming "2 h spent here" while the clock
 *   says nothing was spent.
 * - **Reveals are monotone, and the GM's checkbox wins ties.** `autoReveal: false` makes the rule
 *   decoration: it says *Perception DC 15* next to the feature and waits for the GM. Nothing here
 *   ever hides a feature again — that is the GM's own checkbox, and only theirs.
 *
 * The **projection** half of requirement 8 is deliberately not here: an unrevealed feature (and its
 * image, and the hash behind it) is stripped from the cell document on its way to a player
 * (`core/projection.ts` → `projectCellForViewer`), which is the single security-relevant line of
 * the whole hexcrawl feature. This module is the other side of it: the client that holds the
 * feature deciding to reveal it.
 */
import type {
  CellDocument,
  CellFeature,
  FlagStore,
  MessageDocument,
  SceneDocument,
} from "../documents";
import type { FlatDiff, Op } from "../ops";
import { evaluateFormula, type RngFn } from "../../dice/engine";
import { createCellOps } from "./scene";
import { hexFeature } from "./strings";

/** Where the accumulated "time spent here" lives on a cell (`flags.core`). */
export const EXPLORED_FLAG = "exploredSeconds";

/**
 * The facts a rule is evaluated against. The caller reads them off its own replica: the clock
 * from the settings document, Perception from the PF1e derivation, dice from the injected rng.
 */
export interface FeatureFacts {
  /** World clock reading at the moment of the evaluation. */
  clockSeconds: number;
  /**
   * The party's **passive** Perception — `10 + the best Perception modifier` the caller could
   * derive. A Perception feature compares its DC against this, which is plan §9.5's "read the
   * party's passive value by default": a hidden roll per step would spam the table, and a hidden
   * feature that only *might* be there is not worth a click.
   */
  passivePerception: number;
  /** The party's Perception *modifier*, used by a feature that asks for an active check. */
  perceptionModifier: number;
  /** Dice for a `dice` rule and for an active Perception check. */
  rng: RngFn;
}

export interface FeatureVerdict {
  /** True when the rule says the feature is found. */
  reveal: boolean;
  /** One line in the GM's words — logged, and shown next to the row. */
  note: string;
}

/** Seconds the party has spent in this cell so far (`flags.core.exploredSeconds`). */
export function exploredSecondsOf(cell: CellDocument | null | undefined): number {
  const raw = flagCore(cell?.flags ?? undefined)?.[EXPLORED_FLAG];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

/**
 * Add elapsed time to a cell's counter — the write side of the `time` rule.
 *
 * Returns `[]` for a non-positive amount (a zero-second advance is not a write). For a cell nobody
 * authored it **authors the hex first and writes the time in the same envelope**: the counter is a
 * fact about where the party has *stood*, not about what the GM has painted, and a march that
 * sleeps in an unauthored hex must still find those hours there when the GM opens it later (plan
 * §3.5's `time` rule reads this counter). The create carries the flag with it — D-270/D-271's
 * two-envelope lesson again: an op that patches a document it is creating in the same breath is
 * one op, not two. An unauthored hex is still invisible to a player: `projectCellForViewer` drops
 * every cell the profile has not opened, whatever it carries.
 */
export function addExploredTimeOps(
  scene: SceneDocument,
  cellKey: string,
  seconds: number,
  atClock?: number,
): Op[] {
  const delta = Math.trunc(seconds);
  if (!Number.isFinite(delta) || delta <= 0) return [];
  const cell = (scene.cells ?? []).find((c) => c.key === cellKey);
  const flags = cell?.flags ?? {};
  const core = { ...(flagCore(flags) ?? {}) };
  core[EXPLORED_FLAG] = exploredSecondsOf(cell) + delta;
  if (typeof atClock === "number" && Number.isFinite(atClock)) {
    core["exploredAtClock"] = Math.trunc(atClock);
  }
  const next = { ...flags, core } as FlagStore;
  if (!cell) {
    return createCellOps(scene, globalThis.crypto.randomUUID(), {
      key: cellKey,
      flags: next,
    });
  }
  return [
    {
      kind: "update",
      ref: {
        coll: "cells",
        id: cell._id,
        parent: { coll: "scenes", id: scene._id },
      },
      diff: { flags: next } as FlatDiff,
    },
  ];
}

/** A march charges every cell it touched: one call, one op per cell, one envelope. */
export function addExploredTimeOpsMany(
  scene: SceneDocument,
  spent: Readonly<Record<string, number>>,
  atClock?: number,
): Op[] {
  const ops: Op[] = [];
  for (const [key, seconds] of Object.entries(spent)) {
    ops.push(...addExploredTimeOps(scene, key, seconds, atClock));
  }
  return ops;
}

/** Hours/minutes/seconds in the GM's units — "2 h", "1 h 30 m", "45 m", "30 s". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} m` : `${hours} h`;
  if (minutes > 0) return rest > 0 ? `${minutes} m ${rest} s` : `${minutes} m`;
  return `${rest} s`;
}

/** How a feature's rule reads in the hex window (a GM who cannot read it cannot rule on it). */
export function featureRuleLabel(feature: CellFeature): string {
  const reveal = feature.reveal;
  const auto = feature.autoReveal ? "" : hexFeature.decides;
  switch (reveal.kind) {
    case "manual":
      return hexFeature.manual;
    case "perception":
      return reveal.active === true
        ? `${hexFeature.perceptionCheck(reveal.dc)}${auto}`
        : `${hexFeature.perceptionPassive(reveal.dc)}${auto}`;
    case "time":
      return `${hexFeature.time(formatDuration(reveal.seconds))}${auto}`;
    case "dice":
      return `${hexFeature.dice(reveal.formula, reveal.target)}${auto}`;
    default:
      return hexFeature.manual;
  }
}

/**
 * Evaluate one feature's rule against the facts.
 *
 * `spentSeconds` is the cell's accumulated time *after* the advance that is being evaluated (a
 * `time` feature measures the party's stay, and this module never reads the store to find it).
 * A feature that is already revealed is left alone; a `manual` feature never reveals itself; and a
 * rule this module cannot evaluate (an unreadable formula) reports why instead of throwing in the
 * middle of a march.
 */
export function evaluateFeature(
  feature: CellFeature,
  facts: FeatureFacts,
  spentSeconds = 0,
): FeatureVerdict {
  if (feature.state?.revealed === true) return { reveal: false, note: "" };
  const reveal = feature.reveal;
  switch (reveal.kind) {
    case "manual":
      return { reveal: false, note: "" };
    case "time": {
      const spent = Math.max(0, Math.trunc(spentSeconds));
      const need = Math.max(0, Math.trunc(reveal.seconds));
      return {
        reveal: spent >= need,
        note: hexFeature.noteTime(feature.name, formatDuration(spent), formatDuration(need)),
      };
    }
    case "perception": {
      const target = Math.trunc(reveal.dc);
      if (reveal.active === true) {
        const roll = evaluateFormula(
          `1d20+${Math.trunc(facts.perceptionModifier)}`,
          undefined,
          facts.rng,
        );
        const total = roll.ok ? roll.value.total : 0;
        return {
          reveal: roll.ok && total >= target,
          note: roll.ok
            ? hexFeature.notePerceptionRoll(feature.name, total, target)
            : hexFeature.notePerceptionBroken(feature.name),
        };
      }
      const passive = Math.max(0, Math.trunc(facts.passivePerception));
      return {
        reveal: passive >= target,
        note: hexFeature.notePerception(feature.name, passive, target),
      };
    }
    case "dice": {
      const roll = evaluateFormula(reveal.formula, undefined, facts.rng);
      if (!roll.ok) {
        return {
          reveal: false,
          note: hexFeature.noteBadFormula(feature.name, reveal.formula),
        };
      }
      const total = roll.value.total;
      return {
        reveal: total >= Math.trunc(reveal.target),
        note: hexFeature.noteDice(feature.name, reveal.formula, total, reveal.target),
      };
    }
    default:
      return { reveal: false, note: "" };
  }
}

export interface FeatureRevealResult {
  /** The writes: one `features` array update, and one for the time that earned it. */
  ops: Op[];
  /** The features this evaluation revealed, in document order. */
  revealed: CellFeature[];
  /** One line per evaluation worth reporting (a roll, a check, a formula that would not read). */
  notes: string[];
}

/**
 * What the party's presence in a cell has earned: evaluate every rule, reveal the automatic ones,
 * and write the time that was spent there — **one envelope**, so the counter and the reveal it
 * produced can never disagree.
 *
 * `spentSeconds` is the time this advance added to the cell (the caller has it from
 * `travelAdvance.spentSeconds` or from the explore action); it is added to the stored counter when
 * the rule is judged, and written whether or not anything was revealed — the time was spent either
 * way, and a GM who comes back to the hex later should find the hours the party already stood there.
 * Features with `autoReveal` off are reported but never flipped: the GM's checkbox is their switch.
 */
export function revealDueFeatures(input: {
  scene: SceneDocument;
  cellKey: string;
  facts: FeatureFacts;
  /** The time this event added to the cell (0 when time already passed is being re-read). */
  spentSeconds?: number;
}): FeatureRevealResult {
  const cell = (input.scene.cells ?? []).find((c) => c.key === input.cellKey);
  const added = Math.max(0, Math.trunc(input.spentSeconds ?? 0));
  // An unauthored hex holds no features to judge — but the hours were still spent, and the walk
  // writes them here rather than dropping them (see `addExploredTimeOps`).
  if (!cell) {
    return {
      ops: addExploredTimeOps(input.scene, input.cellKey, added, input.facts.clockSeconds),
      revealed: [],
      notes: [],
    };
  }
  const spent = exploredSecondsOf(cell) + added;
  const features = cell.features ?? [];
  const revealed: CellFeature[] = [];
  const notes: string[] = [];
  for (const feature of features) {
    if (feature.state?.revealed === true) continue;
    const verdict = evaluateFeature(feature, input.facts, spent);
    if (!verdict.reveal) {
      // A rule that did not fire is worth a line when it is one the engine is *supposed* to apply
      // (a GM wants to see the check that failed); a manual feature has nothing to report.
      if (verdict.note !== "" && feature.autoReveal === true) notes.push(verdict.note);
      continue;
    }
    if (feature.autoReveal !== true) {
      notes.push(hexFeature.noteFound(feature.name));
      continue;
    }
    revealed.push(feature);
    notes.push(verdict.note);
  }
  const ops: Op[] = [];
  if (revealed.length > 0) {
    const ids = new Set(revealed.map((f) => f.id));
    const atClock = Math.max(0, Math.trunc(input.facts.clockSeconds));
    ops.push(
      updateCellFieldOps(
        input.scene,
        cell,
        "features",
        features.map((f) => (ids.has(f.id) ? { ...f, state: { revealed: true, atClock } } : f)),
      ),
    );
  }
  if (added > 0) {
    ops.push(...addExploredTimeOps(input.scene, input.cellKey, added, input.facts.clockSeconds));
  }
  return { ops, revealed, notes };
}

/** One `update` on a cell, carrying `features` (the only array this module writes). */
function updateCellFieldOps(
  scene: SceneDocument,
  cell: CellDocument,
  field: "features",
  value: CellFeature[],
): Op {
  return {
    kind: "update",
    ref: {
      coll: "cells",
      id: cell._id,
      parent: { coll: "scenes", id: scene._id },
    },
    diff: { [field]: value } as unknown as FlatDiff,
  };
}

/**
 * The card a reveal leaves in the chat — the table hears about the shrine when the party finds it,
 * not only the GM (requirement 8's "the reveal is in the log as the table would hear it").
 *
 * Plain text and **public**: a revealed feature is a document the players are allowed to hold
 * (`projectCellForViewer` keeps it), so whispering its name would be a secret about a thing that
 * is no longer one. A GM-authored feature whose `autoReveal` is off never reaches here — that one
 * is the GM's checkbox, and the GM's alone.
 */
export function featureFoundMessage(input: {
  authorId: string;
  cellKey: string;
  features: readonly CellFeature[];
}): MessageDocument {
  const names = input.features.map((feature) => feature.name);
  return {
    _id: globalThis.crypto.randomUUID(),
    type: "message",
    name: `Found ${input.cellKey}`.slice(0, 40),
    ownership: { default: 1 },
    flags: {},
    system: {},
    author: input.authorId,
    content: names.map((name) => hexFeature.found(input.cellKey, name)).join("\n"),
    whisper: [],
    roll: null,
    flavor: "hexcrawl",
  };
}

/** The `flags.core` bag on a cell (the ledger's own helper, kept local to avoid a cycle). */
function flagCore(flags: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const core = flags?.["core"];
  return typeof core === "object" && core !== null && !Array.isArray(core)
    ? (core as Record<string, unknown>)
    : null;
}
