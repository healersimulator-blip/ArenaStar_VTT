/**
 * §3.1 (G-39) — **character import**: reading somebody else's character sheet export into an
 * actor this app can play, without a second copy of the rules.
 *
 * A migrating table arrives with a character it has played for years, and the alternative to
 * importing it is retyping a 12th-level wizard. Three exporters matter, and they are three
 * *kinds* of document, not three dialects of one:
 *
 * - **Foundry PF1e actor JSON** — a structured character sheet (`system.abilities`,
 *   `system.attributes`, `system.skills`, `items[]`). The richest source by far: it states
 *   components (a BAB, an armor bonus, a weapon's actions) rather than totals, which is exactly
 *   the shape this app's derivation wants.
 * - **Hero Lab XML** — the path Roll20's own importer takes. A DTD-less XML whose nesting has
 *   changed across versions, so it is read **by label**, not by path (see `herolab.ts`).
 * - **Roll20 sheet export JSON** — a flat list of `attribs` named by the sheet's own fields.
 *   Read through an alias table that says exactly what it recognises (`roll20.ts`).
 *
 * Three rules hold across all three, and they are the reason this is one module with one output
 * shape rather than three importers:
 *
 * 1. **Never invent.** A field the source does not state is left absent, not defaulted. The
 *    derivation already knows how to treat an unauthored field (`derivePF1eActor` reports what it
 *    assumed), and a silent 10 in an ability score is a lie that survives for the whole campaign.
 * 2. **Never double the arithmetic.** Author *components* where the source has them (BAB, armor
 *    bonus, weapon damage dice); author a *total* only where the source only has one (a stat
 *    block's published AC, a Hero Lab save), flagged with the same `acMode`/`savesAsTotal` fields
 *    the derived reader already understands. Where a source stores a derived total that this app
 *    derives itself (Roll20's attack modifiers, Hero Lab's initiative), the total is *not*
 *    imported — it is named in the report instead, because importing it would double-count.
 * 3. **Report every field left behind.** `warnings` names what the source stated and this app does
 *    not place, in the source's own words. An import that silently drops a wizard's spellbook is
 *    worse than one that refuses: the player would never know to re-author it.
 *
 * The rules themselves are not re-implemented here: an imported weapon becomes an ordinary
 * embedded item, and the attack line is authored by the *same* `attackEntryFromWeapon` the sheet's
 * Items tab uses, so an imported longsword and a hand-authored one cannot disagree.
 */
import type { Result } from "../../../core/result";
import { err, okVal } from "../../../core/result";
import { attackEntryFromWeapon } from "../consumables";
import type { PF1eAttackEntry } from "../actor";
import { readInventoryItems } from "../inventory";
import { normalizeSkillId } from "../skills";
import { normalizeSize } from "../rulesTables";
import { DICE_FORMULA } from "./dice";

export type CharacterImportFormat = "foundry" | "herolab" | "roll20";

/** One embedded item, in the shape `resolveInventoryItem` reads (`system.*`, not `system.pf1e`). */
export interface ImportedItem {
  name: string;
  system: Record<string, unknown>;
}

export interface ImportedCharacter {
  format: CharacterImportFormat;
  /** The character's own name, as the source states it. */
  name: string;
  /** The authored `system.pf1e` block `parsePF1eActorSystem` validates. */
  system: Record<string, unknown>;
  items: ImportedItem[];
  /** What was read, one line per fact — the report's good news, and the e2e's readback. */
  read: string[];
  /** Everything the source stated that this importer does not place, named as the source named it. */
  warnings: string[];
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

export const int = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
};

export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** `{ value: 12 }` or `12` — both spellings appear in every one of the three sources. */
export const valueOf = (v: unknown): unknown =>
  isRecord(v) && "value" in v
    ? v.value
    : isRecord(v) && "total" in v
      ? v.total
      : v;

/**
 * HTML → display text, one pass. Item descriptions are the only rich text any of these exports
 * carries, and the sheet shows them as plain prose: tags out, block ends become spaces, the five
 * entities an SRD description actually uses decoded (and `&amp;quot;` decoded to `&quot;`, never
 * to a quote — the converter's own rule).
 */
export function plainText(html: unknown): string {
  const raw = typeof html === "string" ? html : "";
  if (raw === "") return "";
  const spaced = raw
    .replace(/<\s*(br|\/p|\/li|\/tr|\/h[1-6]|\/div|\/table)\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  const decoded = spaced.replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&#\d+;|&#[xX][0-9a-f]+;/g,
    (m) => {
      switch (m) {
        case "&nbsp;":
          return " ";
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&#39;":
          return "'";
        default:
          return m.startsWith("&#x") || m.startsWith("&#X")
            ? String.fromCodePoint(Number.parseInt(m.slice(3, -1), 16))
            : m.startsWith("&#")
              ? String.fromCodePoint(Number.parseInt(m.slice(2, -1), 10))
              : m;
      }
    },
  );
  return decoded.replace(/\s+/g, " ").trim();
}

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"] as const;
const ABILITY_LABELS: Record<string, (typeof ABILITY_KEYS)[number]> = {
  strength: "str",
  str: "str",
  dexterity: "dex",
  dex: "dex",
  constitution: "con",
  con: "con",
  intelligence: "int",
  int: "int",
  wisdom: "wis",
  wis: "wis",
  charisma: "cha",
  cha: "cha",
};

/** `Strength` → `str`, through the labels every one of the three sources uses. */
export function abilityKey(
  label: unknown,
): (typeof ABILITY_KEYS)[number] | undefined {
  const clean = str(label)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  return clean === undefined ? undefined : ABILITY_LABELS[clean];
}

const SAVE_LABELS: Record<string, "fort" | "ref" | "will"> = {
  fort: "fort",
  fortitude: "fort",
  reflex: "ref",
  ref: "ref",
  will: "will",
  willpower: "will",
};

export function saveKey(label: unknown): "fort" | "ref" | "will" | undefined {
  const clean = str(label)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  return clean === undefined ? undefined : SAVE_LABELS[clean];
}

/** Authored abilities, only the ones the source states. */
export function abilitiesBlock(
  raw: Record<string, unknown>,
): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const key of ABILITY_KEYS) {
    const score = int(valueOf(raw[key]));
    if (score !== undefined) out[key] = score;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `system.pf1e.skills`: ranks and class-skill marks, keyed by this app's skill ids. */
export function skillsBlock(
  raw: unknown,
  warnings: string[],
): Record<string, { ranks: number; classSkill?: boolean }> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, { ranks: number; classSkill?: boolean }> = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = normalizeSkillId(key);
    if (id === undefined) {
      // The three-letter keys are the source's own vocabulary, but a homebrew row is not a skill
      continue;
    }
    if (!isRecord(value)) continue;
    const ranks = int(value.rank ?? value.ranks ?? value.value) ?? 0;
    const classSkill = value.classSkill === true || value.cs === true;
    if (ranks === 0 && !classSkill) continue;
    out[id] = {
      ranks: Math.max(0, ranks),
      ...(classSkill ? { classSkill: true } : {}),
    };
  }
  if (Object.keys(out).length === 0) return undefined;
  warnings.push(
    "skill totals were not imported: this app derives them (ability, ranks, class-skill bonus, armor check penalty), so only ranks and class-skill marks are read",
  );
  return out;
}

/**
 * The attack lines for a character's own weapons, authored by the *sheet's* rule
 * (`attackEntryFromWeapon`) rather than a second arithmetic path: the items are handed to
 * `readInventoryItems` exactly as the Items tab would read them, and every weapon becomes a line.
 * A weapon the item reader does not recognise (`weapon` block missing) contributes nothing.
 */
export function attackLinesFromItems(
  items: readonly ImportedItem[],
  size: string | undefined,
  warnings: string[],
): { attacks: PF1eAttackEntry[]; issues: string[] } {
  const docs = items.map((item, index) => ({
    _id: `import-${index}`,
    type: "item",
    name: item.name,
    system: item.system,
  }));
  const read = readInventoryItems(docs);
  const attacks: PF1eAttackEntry[] = [];
  for (const item of read.items) {
    if (item.weapon === null) continue;
    attacks.push(
      attackEntryFromWeapon({ item, size: normalizeSize(size) ?? "Medium" }),
    );
  }
  for (const issue of [...read.issues, ...[]])
    if (issue !== "") warnings.push(issue);
  return { attacks, issues: read.issues };
}

/** A dice expression this app's roller accepts (`1d8`, `2d6`), from a source's own spelling. */
export function diceFrom(raw: unknown): string | undefined {
  const text = str(raw);
  if (text === undefined) return undefined;
  return DICE_FORMULA.test(text) ? text : undefined;
}

/** Wrap a reader's product with the format tag, so a caller can report where it came from. */
export function imported(
  format: CharacterImportFormat,
  value: Omit<ImportedCharacter, "format">,
): Result<ImportedCharacter> {
  if (value.name === "")
    return err(`${format}: the export states no character name`);
  return okVal({ format, ...value });
}
