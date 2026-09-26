/**
 * D-310 (SQ-12) — FX presets: the *look*, saved once and reused.
 *
 * SQ-12 asks for an on-canvas effect player with two placement modes (D-306) **and**
 * preset save/load/edit/delete. A placement mode answers "where"; a preset answers
 * "what", and the split matters: a table that has settled on how its fireball looks
 * should not re-author the tint, the filter, the fades and the follow-up sound every
 * time somebody throws one.
 *
 * A preset is a **named bundle of authored sections** — the same `FxSection`s a
 * timeline holds, validated by the same sequence validator so every rule the table
 * already trusts (bounds, fades, masks, sound positions, camera limits, replay counts)
 * applies unchanged. What it deliberately does **not** carry is lifecycle: no
 * `persistent`, no `audience`, no source/target binding. A preset is the look, not the
 * run; loading one leaves the timeline's own lifecycle fields exactly as the author
 * set them, and nothing about a preset reaches the table until the author saves and
 * runs a timeline — which is where the host's authority lives and always did.
 *
 * Presets live in the world (a `MacroDocument` of `kind: "fxPreset"`), so they survive
 * a reload, travel with a world archive, and are undoable like every other document.
 * They are an **authoring artifact**: never projected to a player, never runnable, and
 * never accepted by a script step or an FX request.
 */
import type { MacroDocument } from "./documents";
import { validateFxSequence, type FxSection } from "./fx";

/** A preset is a handful of sections and a short name a GM types at a table. */
export const FX_PRESET_LIMITS = { sections: { min: 1, max: 8 }, name: 64 } as const;

/** The versioned payload of a preset document. */
export interface FxPresetDefinition {
  version: 1;
  sections: FxSection[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Validate a preset's payload: the shape of the bundle, then **every** section rule by
 * handing the bundle to the sequence validator — the preset is a fragment of a
 * timeline, so a section that would be refused in a timeline is refused here rather
 * than at the author's next save, when the error would have no obvious cause.
 *
 * A failure is attributed to the section that caused it (by index and id) when one
 * section can be blamed, because "unknown FX section field" twice over eight sections
 * is not an error message anybody can act on.
 */
export function validateFxPreset(
  value: unknown,
): { ok: true; preset: FxPresetDefinition } | { ok: false; error: string } {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.sections) ||
      value.sections.length < FX_PRESET_LIMITS.sections.min ||
      value.sections.length > FX_PRESET_LIMITS.sections.max ||
      Object.keys(value).some((key) => !["version", "sections"].includes(key))) {
    return { ok: false, error:
      `an FX preset needs version 1 and ${FX_PRESET_LIMITS.sections.min}–${FX_PRESET_LIMITS.sections.max} sections` };
  }
  const checked = validateFxSequence({ version: 1, sections: value.sections });
  if (checked.ok) return { ok: true, preset: { version: 1, sections: checked.sequence.sections } };
  for (const [index, section] of value.sections.entries()) {
    const alone = validateFxSequence({ version: 1, sections: [section] });
    if (!alone.ok) {
      const id = isObject(section) && typeof section.id === "string" ? ` (${section.id})` : "";
      return { ok: false, error: `preset section ${index + 1}${id}: ${alone.error}` };
    }
  }
  // Nothing is wrong with any single section, so the fault is between them: overlapping
  // IDs, too many camera cues, a total timeline past its bound.
  return { ok: false, error: `FX preset: ${checked.error}` };
}

/**
 * The sections a load puts into the draft. IDs are **minted fresh** rather than copied,
 * because the same preset may be loaded twice into one timeline (two fireballs, one
 * look) and a duplicated section id is a document the host refuses — a preset must not
 * be able to produce one. Copying is shallow per section: the loader never hands the
 * wizard a reference into a stored document it could then mutate in place.
 */
export function fxPresetSections(preset: FxPresetDefinition, mintId: () => string): FxSection[] {
  const seen = new Set<string>();
  return preset.sections.map((section) => {
    let id = mintId();
    while (seen.has(id)) id = mintId();
    seen.add(id);
    return { ...section, id };
  });
}

/**
 * The whole-document check for a preset macro, plus D-310's "a macro is one kind of
 * thing" rule: a preset that also carried `sequence`/`script`/`summon` would be a
 * payload no branch of the host's validator ever looks at, and a runnable macro
 * carrying `preset` would be a preset the FX request path would happily run. Both are
 * refused by name instead.
 */
export function fxPresetDocumentError(doc: MacroDocument): string | null {
  const stray = (["sequence", "script", "scriptState", "summon"] as const)
    .filter((key) => doc[key] !== undefined);
  if (stray.length > 0) return `an FX preset carries sections, not ${stray.join("/")}`;
  const name = typeof doc.name === "string" ? doc.name.trim() : "";
  if (name.length === 0 || name.length > FX_PRESET_LIMITS.name ||
      [...name].some((char) => char.charCodeAt(0) < 32))
    return `an FX preset needs a name of 1–${FX_PRESET_LIMITS.name} characters`;
  const checked = validateFxPreset(doc.preset);
  return checked.ok ? null : checked.error;
}

/** The mirror of the rule above, for the macros that *are* runnable. */
export function macroStrayPresetError(doc: MacroDocument): string | null {
  if (doc.kind === "fxPreset" || doc.preset === undefined) return null;
  return "an FX preset field belongs to a preset, not a runnable macro";
}
