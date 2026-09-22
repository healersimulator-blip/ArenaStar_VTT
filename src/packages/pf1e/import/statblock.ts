/**
 * §3.2 (G-08) — **statblock import**: a pasted monster block becomes a bestiary actor.
 *
 * The fourth reader behind `import/index.ts`, and the only one whose source is not a file: a GM
 * copying a statblock out of a PDF, a wiki page or another table's handout. There is no exporter
 * behind it and no schema to sniff, so the text is read **by label** the way `herolab.ts` reads XML
 * — a SRD block is a set of labelled clauses (`AC 16, touch 13…`, `hp 6 (1d8+2)`, `Melee short
 * sword +2 (1d4/19-20)`) whose order and section headings (DEFENSE / OFFENSE / STATISTICS /
 * ECOLOGY) vary between printings and between suites. Labels are what survives that.
 *
 * The three house rules of `types.ts` decide every mapping here, and the stat block is the case
 * they were written for:
 *
 * 1. **Never invent.** A missing line authors nothing. A block without `Str` imports with no
 *    ability scores, and the sheet says so, rather than a plausible 10 in everything.
 * 2. **Never double the arithmetic.** A stat block publishes *totals*: AC, saves, hp, Base Atk,
 *    CMB/CMD. Those are authored as the totals they are (`acTotals` + `acMode: "published"`,
 *    `saves` + `savesAsTotal`) so the derivation does not add a Dexterity modifier a second time.
 *    Two printed numbers are deliberately **not** imported, because this app derives them from the
 *    very components the same block states: the attack bonus on each attack line (Base Atk + ability
 *    + size + feats) and the skill totals (ranks + ability + class skill + armor check). Both are
 *    reported in the source's own words instead — the same treatment D-264 gave Hero Lab's printed
 *    attack bonus and Roll20's stored attack modifier. A printed damage total (`1d6+2`) *is* the
 *    line's damage, so it is decomposed into dice + flat bonus and flagged `abilityDamageIncluded`.
 * 3. **Report every field left behind.** A stat block carries prose the sheet's numbers do not:
 *    senses, languages, special attacks, special qualities and treasure land in
 *    `system.pf1e.creature` — the monster-details fields the Details tab already edits, prefix
 *    preserved when several lines share the block — and everything with no home at all (XP, the
 *    environment/organization lines, gear, spell-like ability lists, racial skill modifiers) is
 *    named in the report, in the source's words.
 *
 * Senses are descriptive here on purpose: writing them into `creature.senses` is a fact about the
 * creature's stat block, and it does not claim the token's vision — the converter → actor field →
 * token-editor inheritance chain is the open G-24 tail D-260 recorded, not something an import
 * should invent.
 */
import type { Result } from "../../../core/result";
import { err } from "../../../core/result";
import type { PF1eAttackEntry } from "../actor";
import { normalizeSize } from "../rulesTables";
import { DICE_FORMULA } from "./dice";
import { imported, int, str, type ImportedCharacter } from "./types";

/** Natural weapons, by the names a stat block prints them under. */
const NATURAL_WEAPONS = [
  "bite",
  "claw",
  "claws",
  "gore",
  "hoof",
  "hooves",
  "kick",
  "pincer",
  "slam",
  "sting",
  "tail slap",
  "talon",
  "talons",
  "tentacle",
  "tentacles",
  "wing",
  "wings",
  "ram",
  "tusk",
  "spike",
  "spikes",
] as const;

const SIZES =
  "Fine|Diminutive|Tiny|Small|Medium|Large|Huge|Gargantuan|Colossal";
const ALIGNMENTS = ["LG", "NG", "CG", "LN", "N", "CN", "LE", "NE", "CE", "any"];

/** `Initiative +6` / `Init +6` / `Init –1` (the printed en dash is not a minus sign). */
const signed = (text: string): number | undefined => {
  const m = /[−–-]?\d+/.exec(text.replace(/[+]/g, ""));
  if (m === null) return undefined;
  const value = int(m[0].replace(/[−–—]/g, "-"));
  if (value === undefined) return undefined;
  // `+3` and `3` mean the same thing in a stat block; a leading `-` is the sign.
  return value;
};

/** All the numbers in a clause, signed as printed: `Fort +3, Ref +4, Will -1`. */
const signedNumbers = (text: string): number[] =>
  [...text.matchAll(/([+−–-]?)\s*(\d+)/g)].map((m) => {
    const n = Number.parseInt(m[2] ?? "0", 10);
    return m[1] === "-" || m[1] === "−" || m[1] === "–" ? -n : n;
  });

/** Split on a separator at parenthesis depth 0 — `2 claws +5 (1d4+2), bite +5 (1d6+2)`. */
function splitTop(text: string, separators: readonly string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    const separator = depth === 0 ? separators.find((s) => text.startsWith(s, i)) : undefined;
    if (separator !== undefined) {
      out.push(current);
      current = "";
      i += separator.length - 1;
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

/** Markdown/emphasis a paste may carry, and the bolded section headers some wikis print. */
const cleanLine = (line: string): string =>
  line
    .replace(/^[#>\s]*/, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/\s+$/, "")
    .replace(/\u00a0/g, " ");

interface Clause {
  label: string;
  value: string;
}

const SECTION_HEADINGS = [
  "defense",
  "offense",
  "statistics",
  "stat",
  "ecology",
  "source",
  "sources",
  "description",
  "combat",
];

/**
 * Labels a stat block prints, longest first so `Spell-Like Abilities` is not read as `Spells` and
 * `Base Atk` is not read as `Atk`.
 */
const LABELS = [
  "Spell-Like Abilities",
  "Special Attacks",
  "Defensive Abilities",
  "Racial Modifiers",
  "Combat Gear",
  "Other Gear",
  "Base Atk",
  "Languages",
  "Weaknesses",
  "Environment",
  "Organization",
  "Senses",
  "Speed",
  "Melee",
  "Ranged",
  "Space",
  "Reach",
  "Feats",
  "Skills",
  "Treasure",
  "Immune",
  "Resist",
  "Spells",
  "Gear",
  "Init",
  "Initiative",
  "Fort",
  "Ref",
  "Will",
  "Fortitude",
  "Reflex",
  "AC",
  "hp",
  "HP",
  "DR",
  "SR",
  "CMB",
  "CMD",
  "SQ",
  "XP",
  "CR",
  "Str",
  "Dex",
  "Con",
  "Int",
  "Wis",
  "Cha",
] as const;

/** The label a clause opens with, if any. Case-insensitive, tolerant of `AC:` and `ac 16`. */
function labelOf(clause: string): string | null {
  for (const label of LABELS) {
    if (label === "hp" || label === "HP") {
      if (/^hp\b[:\s]/i.test(clause)) return "hp";
      continue;
    }
    const pattern = new RegExp(`^${label.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
    if (pattern.test(clause)) return label;
  }
  return null;
}

/**
 * Flatten a pasted block into labelled clauses. A line may hold several (`Init +6; Senses
 * darkvision 60 ft.`) and a clause may wrap onto the next line (PDF pastes wrap at ~90 columns),
 * so an unlabelled line continues the clause above it unless it is empty.
 */
function clausesOf(lines: readonly string[]): { clauses: Clause[]; preamble: string[] } {
  const clauses: Clause[] = [];
  const preamble: string[] = [];
  /** A clause whose value is often a list of further lines (its continuation has no label). */
  const multiline = (label: string): boolean =>
    /^(spell-like abilities|spells|special attacks|defensive abilities|sq|source|sources)$/i.test(
      label,
    );
  /**
   * Does the previous clause invite a line that carries no label of its own? Two ways: the block
   * wrapped mid-sentence (the value ends on a comma, dash or open parenthesis — a PDF paste does
   * this constantly), or the clause is one that *is* a list (`Spell-Like Abilities (CL 6th; …)`
   * followed by `Constant—…`). Anything else on its own line is part of the header block — the
   * creature's class line, `XP 135`'s neighbours, the type line — which is why `Goblin warrior 1`
   * is not swallowed by the XP clause.
   */
  const invitesContinuation = (last: Clause | undefined): boolean =>
    last !== undefined && (multiline(last.label) || /[(:,;\u2014-]\s*$/.test(last.value));
  for (const raw of lines) {
    const line = cleanLine(raw);
    if (line === "") continue;
    if (SECTION_HEADINGS.includes(line.toLowerCase().replace(/[:\s]+$/, ""))) continue;
    const parts = splitTop(line, [";", "|"]).flatMap((part) =>
      // `Fort +3, Ref +4, Will -1` is a comma-separated save line; ordinary clauses keep their
      // commas (`AC 16, touch 13, flat-footed 14` is one clause with commas).
      /^(Fort|Ref|Will|Fortitude|Reflex)\b/i.test(part) && part.includes(",")
        ? splitTop(part, [","])
        : [part],
    );
    parts.forEach((part, index) => {
      const label = labelOf(part);
      const last = clauses[clauses.length - 1];
      if (label === null) {
        // Several clauses on one line — `Init +6; Senses darkvision 60 ft.; Perception -1` — mean
        // an unlabelled piece belongs to the clause just before it, on that line or the last one
        // the block wrapped.
        const continues = index > 0 ? last !== undefined : invitesContinuation(last);
        if (continues && last !== undefined) last.value = `${last.value} ${part}`.trim();
        else preamble.push(part);
        return;
      }
      clauses.push({ label, value: part.slice(label.length).replace(/^[:\s]+/, "").trim() });
    });
  }
  return { clauses, preamble };
}

/** The first clause with one of these labels, in the labels' own priority order. */
const clauseOf = (clauses: readonly Clause[], ...labels: string[]): Clause | undefined => {
  for (const label of labels) {
    for (const clause of clauses) {
      if (clause.label.toLowerCase() === label.toLowerCase()) {
        return { label: clause.label, value: clause.value };
      }
    }
  }
  return undefined;
};

const clausesOfLabel = (clauses: readonly Clause[], ...labels: string[]): Clause[] =>
  clauses.filter((clause) =>
    labels.some((label) => clause.label.toLowerCase() === label.toLowerCase()),
  );

/** `hp 6 (1d8+2)`: the total, and the Hit Dice the parenthetical states. */
function hitDiceOf(value: string): number | undefined {
  const dice = /(\d+)\s*d\s*(\d+)/i.exec(value);
  if (dice === null) return undefined;
  const count = int(dice[1]);
  return count === undefined ? undefined : Math.max(1, count);
}

const modOf = (score: number | undefined): number | undefined =>
  score === undefined ? undefined : Math.floor((score - 10) / 2);

/**
 * One printed attack: `2 claws +5 (1d4+2)`, `short sword +2 (1d4/19-20)`, `bite +7 (1d8+4/×3)`,
 * `touch +4 (1d6 negative energy plus 1d6 cold)`. Returns one entry per printed attack (a `2
 * claws` line is two attacks, because that is what it is), plus the text this app does not model.
 */
function attacksOf(
  clause: Clause,
  options: { ranged: boolean; reachSquares?: number },
): { attacks: PF1eAttackEntry[]; notes: string[] } {
  const ranged = options.ranged;
  const attacks: PF1eAttackEntry[] = [];
  const notes: string[] = [];
  for (const part of splitTop(clause.value, [",", " and ", " or "])) {
    // The attack bonus is the last signed number before the damage parenthetical — and a
    // full-attack line prints a whole sequence of them (`+12/+7`), which is one line here: this
    // app derives the iterative attacks from Base Atk, so the sequence is read and refused as one
    // printed figure.
    const paren = part.indexOf("(");
    const head = paren === -1 ? part : part.slice(0, paren);
    const damageText = paren === -1 ? "" : part.slice(paren);
    const bonusMatch = /([+−–-]?\s*\d+(?:\s*\/\s*[+−–-]?\s*\d+)*)\s*$/.exec(head.trim());
    const name = head
      .slice(0, bonusMatch === null ? head.length : (bonusMatch.index ?? head.length))
      .trim()
      .replace(/\s+/g, " ");
    if (name === "") {
      notes.push(`an attack line with no name was not imported (${part})`);
      continue;
    }
    const printedBonus = bonusMatch === null ? "" : bonusMatch[0].replace(/\s+/g, "");
    const bonus =
      printedBonus === "" ? undefined : signedNumbers(printedBonus.replace(/\//g, " "))[0];
    // `2 claws +5 …` — the leading count is part of the attack, not the name.
    const countMatch = /^(\d+)\s+(?=\S)/.exec(name);
    const count = countMatch === null ? 1 : Math.max(1, int(countMatch[1]) ?? 1);
    const bareName = countMatch === null ? name : name.slice(countMatch[0].length).trim();
    const natural = NATURAL_WEAPONS.some((weapon) => bareName.toLowerCase().startsWith(weapon));
    const diceMatch = /([+−–-]?\s*\d+)\s*d\s*(\d+)/i.exec(damageText);
    const dice: string | undefined =
      diceMatch === null
        ? undefined
        : (() => {
            const size = diceMatch[2] ?? "";
            const count2 = diceMatch[1]?.replace(/[+−–\s]/g, "") || "1";
            const formula = `${count2}d${size}`;
            return DICE_FORMULA.test(formula) ? formula : undefined;
          })();
    if (diceMatch === null && damageText !== "") {
      notes.push(
        `the damage on "${bareName}" was not a dice expression and was not imported (${damageText.trim()})`,
      );
    }
    // A printed damage total: dice plus the flat part, which a stat block already includes the
    // Strength in — flagged so the derivation does not add it again (`abilityDamageIncluded`).
    const flat = /d\s*\d+\s*([+−–-]\s*\d+)/i.exec(damageText);
    const damageBonus = flat === null ? undefined : signed(flat[1] ?? "0");
    // `/19-20` threatens on 19; `/×3` triples on a 20. Both may be spelled with x or ×.
    const threat = /\/\s*(?:(1?\d)\s*[–-]\s*20|(\d+)\s*[–-]\s*20)/.exec(damageText);
    const multiplier = /\/\s*[×x*]\s*(\d+)/i.exec(damageText);
    const touchMatch = /(^|\s)touch(\s|$)/i.test(bareName);
    const named = bareName.replace(/\btouch\b/gi, "").replace(/\s+/g, " ").trim();
    const entry: PF1eAttackEntry = { name: named === "" ? bareName : named };
    if (ranged) entry.ranged = true;
    if (natural) entry.natural = true;
    if (touchMatch) entry.touchAttack = true;
    if (dice !== undefined) entry.damageDice = dice;
    if (damageBonus !== undefined) {
      entry.damageBonus = damageBonus;
      entry.abilityDamageIncluded = true;
    }
    if (threat !== null) {
      const low = int(threat[1] ?? threat[2] ?? "20");
      if (low !== undefined && low >= 2 && low <= 20) entry.critThreatMin = low;
    }
    if (multiplier !== null) {
      const mult = int(multiplier[1]);
      if (mult !== undefined && mult >= 2) entry.critMultiplier = mult;
    }
    if (options.reachSquares !== undefined && options.reachSquares > 1)
      entry.reachSquares = options.reachSquares;
    for (let i = 0; i < count; i += 1) attacks.push({ ...entry });
    if (bonus !== undefined) {
      notes.push(
        `the printed attack bonus on "${bareName}" (${printedBonus.replace(/\//g, "/")}) was not imported: this app derives attack bonuses from Base Atk, ability, size and feats`,
      );
    }
    const unmodelled = /d\s*\d+[^)]*?\b(plus|and)\b[^(]*?(?=plus|\)|$)/i.exec(damageText);
    if (unmodelled !== null && /(plus|and)\s+[a-z]/i.test(damageText)) {
      const extra = damageText
        .replace(/^\(|\)$/g, "")
        .replace(/^\s*[+−–-]?\s*\d+\s*d\s*\d+(\s*[+−–-]\s*\d+)?/i, "")
        .replace(/^\s*(plus|and)\s+/i, "")
        .replace(/\/\s*[×x*]?\s*[\d–-]+\s*$/i, "")
        .trim();
      if (extra !== "") {
        notes.push(
          `the extra damage or effect text on "${bareName}" was not imported (${extra}) — author it as an effect or a trait on the sheet`,
        );
      }
    }
  }
  return { attacks, notes };
}

const labelFor = (label: string, value: string): string => `${label}: ${value}`;

/**
 * Does this text look like a stat block? Two independent markers are required, because a
 * *refusal* is better than a wrong import: a paragraph of prose that happens to contain "AC 15"
 * must not become an actor, and a stat block pasted without its headings still must.
 */
export function looksLikeStatblock(text: string): boolean {
  if (typeof text !== "string") return false;
  const lines = text.split(/\r?\n/).map(cleanLine);
  const body = lines.join("\n");
  const markers = [
    /\bCR\s+[\d/]+\s*$/im, // the header line
    /^(defense|offense|statistics|ecology)\s*$/im,
    /^\s*(AC|Armor Class)\s*[: ]\s*\d+/im,
    /^\s*hp\s*[: ]?\s*\d+/im,
    /^(Init|Initiative)\s*[+−–-]?\s*\d+/im,
    /^(Fort|Ref|Will|Fortitude|Reflex)\s*[+−–-]?\s*\d+/im,
    /^(Melee|Ranged)\s+\S/im,
    /^(Str|Strength)\s*[: ]\s*\d+/im,
    /^(Base Atk|CMB|CMD)\s*[: ]?\s*[+−–-]?\s*\d+/im,
  ];
  const hits = markers.filter((m) => m.test(body)).length;
  if (hits < 2) return false;
  // JSON and XML are somebody else's readers, and both can contain the words above.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("<"))
    return false;
  return true;
}

/** Read a stat block into the app's actor shape. */
export function importStatblock(text: string): Result<ImportedCharacter> {
  if (typeof text !== "string" || text.trim() === "")
    return err("statblock: there is no text to read");
  const lines = text.split(/\r?\n/);
  const { clauses, preamble } = clausesOf(lines);
  if (clauses.length === 0)
    return err(
      "statblock: no labelled lines were found — paste the block as printed (Init, AC, hp, Fort/Ref/Will, abilities, Melee…)",
    );

  const read: string[] = [];
  const warnings: string[] = [];
  const pf1e: Record<string, unknown> = {};
  const creature: Record<string, string> = {};
  /**
   * Did the block state a *number* this app can play? Prose alone (a name, a CR, a type line, a
   * language) makes an actor that no rule can touch, so it is refused rather than created: the
   * paste is either incomplete or is not a stat block.
   */
  let playable = false;

  // ── the header: `Goblin Warrior CR 1/3`, or the name on its own line with CR above/below ──
  const headerCr = clauseOf(clauses, "CR");
  const cr = headerCr?.value.match(/\d+(?:\s*\/\s*\d+)?/)?.[0];
  const sizeWord = new RegExp(`\\b(${SIZES})\\b`, "i");
  /**
   * The name is the first header line that is not itself part of the creature's *description*: a
   * type line (`NE Small humanoid (goblinoid)`) or a class line (`Goblin warrior 1`) means the
   * paste started below the name, and a block with no name is refused rather than named after its
   * first attribute — "paste it from the top" is a fixable mistake, a creature called
   * "NE Small humanoid" is not.
   */
  const nameCandidate = preamble.find(
    (line) => !sizeWord.test(line) && !/^[A-Z][a-z]+ [a-z]+ \d+$/.test(line),
  );
  const crMatch = nameCandidate === undefined ? null : /\bCR\s+([\d/]+)\s*$/.exec(nameCandidate);
  const name =
    nameCandidate === undefined
      ? ""
      : (crMatch === null ? nameCandidate : nameCandidate.slice(0, crMatch.index)).trim();
  if (name === "")
    return err(
      "statblock: the block states no creature name — a stat block starts with the creature's name and its CR (`Goblin Warrior CR 1/3`); paste it from the top",
    );
  if (cr !== undefined) creature.cr = cr.replace(/\s+/g, "");
  else if (crMatch !== null) creature.cr = crMatch[1] ?? "";
  // ── the type line: `NE Small humanoid (goblinoid)` ──
  const typeLine = preamble.find((line) => sizeWord.test(line) === true && line.length < 120);
  if (typeLine !== undefined) {
    const sizeMatch = sizeWord.exec(typeLine);
    const size = sizeMatch === null ? null : normalizeSize(sizeMatch[1]);
    if (size !== null) {
      pf1e.size = size;
      read.push(`size: ${size}`);
    } else {
      warnings.push(`the creature's size was not one this app knows (${typeLine})`);
    }
    const alignment = ALIGNMENTS.find((a) =>
      new RegExp(`(^|\\s)${a}(\\s|$)`, "i").test(typeLine),
    );
    if (alignment !== undefined) creature.alignment = alignment;
    const type = typeLine
      .slice(sizeMatch === null ? 0 : (sizeMatch.index ?? 0) + sizeMatch[0].length)
      .trim();
    if (type !== "") {
      creature.type = type;
      read.push(`type: ${type}`);
    }
  }
  // The rest of the header block is a fact about the creature with no field on this app's sheet —
  // a class line (`Goblin warrior 1`), a source line, a note. Say so with the line quoted, rather
  // than dropping it silently: the whole point of the report is that nothing vanishes quietly.
  const placed = [nameCandidate, typeLine].filter((line): line is string => line !== undefined);
  const unplaced = [...preamble];
  for (const line of placed) {
    const at = unplaced.indexOf(line);
    if (at !== -1) unplaced.splice(at, 1);
  }
  for (const line of unplaced) {
    warnings.push(
      `the header line "${line}" was not placed: a stat block's name, its CR and its type line (size, type, alignment) are read, and the rest of the header block has no field on this app's sheet`,
    );
  }

  // ── initiative ──
  const initClause = clauseOf(clauses, "Init", "Initiative");
  const initTotal = initClause === undefined ? undefined : signed(initClause.value);
  const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"] as const;
  const abilitiesRaw = clauseOf(clauses, "Str");
  let dexScore: number | undefined;
  if (abilitiesRaw !== undefined) {
    // Modern printings put all six on one labelled line in the SRD's order — `Str 11, Dex 15, Con
    // 12, Int 10, Wis 9, Cha 6` — while older ones label each separately (`Str 11; Dex 15; …`).
    // Read the labelled clauses first (they are unambiguous), then fill any gap from the order the
    // Str line states.
    const abilities: Record<string, number> = {};
    const abilitiesClauses = clauses.filter((c) =>
      ABILITY_KEYS.includes(c.label.toLowerCase() as (typeof ABILITY_KEYS)[number]),
    );
    for (const key of ABILITY_KEYS) {
      const clause = abilitiesClauses.find((c) => c.label.toLowerCase() === key);
      const score = clause === undefined ? undefined : signedNumbers(clause.value)[0];
      if (score !== undefined) abilities[key] = score;
    }
    if (abilities.str === undefined || Object.keys(abilities).length < ABILITY_KEYS.length) {
      // `Str 14, Dex 12, Con -, Int 11,` / `Wis 13, Cha 15` — a wrapped ability line gives the
      // second half a label of its own (`Wis`), and its value carries the abilities after it.
      const inline = abilitiesClauses.flatMap((clause) => [
        ...clause.value.matchAll(/\b(Str|Dex|Con|Int|Wis|Cha)\b\s*([+−–-]?\s*\d+)/gi),
      ]);
      for (const match of inline) {
        const key = (match[1] ?? "").toLowerCase() as (typeof ABILITY_KEYS)[number];
        if (!ABILITY_KEYS.includes(key)) continue;
        const score = int((match[2] ?? "").replace(/[+−–\s]/g, (char) => (char === "+" ? "" : char === " " ? "" : "-")));
        if (score !== undefined) abilities[key] = score;
      }
      // The Str clause's own number is Strength when nothing else claimed it.
      const own = signedNumbers(abilitiesRaw.value)[0];
      if (own !== undefined && abilities.str === undefined) abilities.str = own;
      if (inline.length === 0) {
        const inOrder = signedNumbers(abilitiesRaw.value);
        ABILITY_KEYS.forEach((key, index) => {
          const score = inOrder[index];
          if (score !== undefined && abilities[key] === undefined) abilities[key] = score;
        });
      }
    }
    const noScore = [
      ...abilitiesRaw.value.matchAll(/\b(Str|Dex|Con|Int|Wis|Cha)\b\s*[−–—-](?![\d.])/g),
    ].map((match) => match[1] ?? "");
    if (noScore.length > 0)
      warnings.push(
        `the ability line prints no score for ${noScore.join(", ")} (a dash — undead and constructs are written this way): those scores are left unauthored, and this app has no "no ability score" mode, so anything it derives from them uses an unauthored ability's default`,
      );
    if (Object.keys(abilities).length > 0) {
      pf1e.abilities = abilities;
      playable = true;
      dexScore = abilities.dex;
      read.push(
        `abilities: ${Object.entries(abilities)
          .map(([key, value]) => `${key} ${value}`)
          .join(", ")}`,
      );
    }
  } else {
    warnings.push(
      "no ability line was found (Str … Cha) — ability scores are left unauthored rather than guessed",
    );
  }
  if (initTotal !== undefined) {
    const dexMod = modOf(dexScore);
    if (dexMod === undefined) {
      warnings.push(
        `initiative ${initTotal} was not imported: without a Dexterity score this app cannot tell how much of it is the ability and how much is a feat or trait`,
      );
    } else {
      const misc = initTotal - dexMod;
      if (misc !== 0) pf1e.initiative = misc;
      read.push(
        `initiative ${initTotal >= 0 ? "+" : ""}${initTotal} (Dex ${dexMod >= 0 ? "+" : ""}${dexMod}${misc === 0 ? "" : `, misc ${misc >= 0 ? "+" : ""}${misc}`})`,
      );
    }
  }

  // ── senses and perception ──
  const senses = clauseOf(clauses, "Senses");
  if (senses !== undefined) {
    const value = senses.value.replace(/;\s*$/,"").trim();
    const perception = /\bPerception\s*([+−–-]?\s*\d+)/i.exec(value);
    const withoutPerception = perception === null ? value : value.replace(perception[0], "").replace(/;\s*$/, "").trim();
    if (withoutPerception !== "") {
      creature.senses = withoutPerception;
      read.push(labelFor("senses", withoutPerception));
    }
    if (perception !== null)
      warnings.push(
        `Perception ${perception[1]?.replace(/\s+/g, "")} was not imported: this app derives Perception from Wisdom, ranks and class skill marks — author the ranks on the Skills tab`,
      );
  }

  // ── defense ──
  const ac = clauseOf(clauses, "AC");
  if (ac !== undefined) {
    const normal = signedNumbers(ac.value)[0];
    const touch = /\btouch\s*([+−–-]?\s*\d+)/i.exec(ac.value);
    const flatFooted = /\bflat[-\s]?footed\s*([+−–-]?\s*\d+)/i.exec(ac.value);
    if (normal !== undefined) {
      const totals: { normal: number; touch?: number; flatFooted?: number } = { normal };
      const touchValue = touch === null ? undefined : signed(touch[1] ?? "");
      const flatValue = flatFooted === null ? undefined : signed(flatFooted[1] ?? "");
      if (touchValue !== undefined) totals.touch = touchValue;
      if (flatValue !== undefined) totals.flatFooted = flatValue;
      pf1e.acTotals = totals;
      pf1e.acMode = "published";
      playable = true;
      const breakdown = /\(([^)]*)\)/.exec(ac.value);
      read.push(
        `armor class: ${normal}${totals.touch !== undefined ? `, touch ${totals.touch}` : ""}${totals.flatFooted !== undefined ? `, flat-footed ${totals.flatFooted}` : ""} (published totals)`,
      );
      if (breakdown !== null && breakdown[1]?.trim() !== "")
        read.push(`the block's own AC breakdown: ${breakdown[1]?.trim()}`);
    }
  }
  const hp = clauseOf(clauses, "hp", "HP");
  if (hp !== undefined) {
    const total = signedNumbers(hp.value)[0];
    if (total !== undefined) {
      pf1e.hp = Math.max(0, total);
      pf1e.hpMax = Math.max(0, total);
      playable = true;
      const hitDice = hitDiceOf(hp.value);
      if (hitDice !== undefined) pf1e.hitDice = hitDice;
      read.push(
        `hit points: ${total}${hitDice === undefined ? "" : ` (${hitDice} Hit Dice)`}`,
      );
    }
  }
  const saves: Record<string, number> = {};
  for (const [labels, key] of [
    [["Fort", "Fortitude"], "fort"],
    [["Ref", "Reflex"], "ref"],
    [["Will"], "will"],
  ] as const) {
    const clause = clauseOf(clauses, ...labels);
    const value = clause === undefined ? undefined : signedNumbers(clause.value)[0];
    if (value !== undefined) saves[key] = value;
  }
  if (Object.keys(saves).length > 0) {
    pf1e.saves = saves;
    pf1e.savesAsTotal = true;
    playable = true;
    read.push(
      `saves: ${Object.entries(saves)
        .map(([key, value]) => `${key} ${value >= 0 ? "+" : ""}${value}`)
        .join(", ")} (published totals)`,
    );
  }
  const qualities: string[] = [];
  for (const [labels, display] of [
    [["Defensive Abilities"], "Defensive Abilities"],
    [["Immune"], "Immune"],
    [["Resist"], "Resist"],
    [["Weaknesses"], "Weaknesses"],
  ] as const) {
    const clause = clauseOf(clauses, ...labels);
    if (clause !== undefined && clause.value.trim() !== "")
      qualities.push(labelFor(display, clause.value.trim()));
  }
  const dr = clauseOf(clauses, "DR");
  if (dr !== undefined) {
    const value = /(\d+)/.exec(dr.value);
    if (value !== null) {
      const amount = int(value[1]);
      if (amount !== undefined) pf1e.dr = amount;
      const bypass = dr.value
        .slice((value.index ?? 0) + (value[0]?.length ?? 0))
        .replace(/^[\s/]+/, "")
        // `good or silver`, `cold iron and good`, `magic, adamantine` — each is its own bypass.
        .split(/\s+or\s+|\s+and\s+|\s*,\s*/i)
        .map((part) => part.replace(/\s*\/\s*$/, "").trim())
        .filter((part) => part !== "" && !/^[\d/]+$/.test(part));
      if (bypass.length > 0) pf1e.drBypass = bypass;
      read.push(
        `damage reduction: ${value[0]}${bypass.length > 0 ? `/${bypass.join(", ")}` : ""}`,
      );
    }
  }
  const sr = clauseOf(clauses, "SR");
  if (sr !== undefined) {
    const value = signedNumbers(sr.value)[0];
    if (value !== undefined) {
      pf1e.spellResistance = value;
      playable = true;
      read.push(`spell resistance: ${value}`);
    }
  }

  // ── offense: speeds, reach, attacks ──
  const speed = clauseOf(clauses, "Speed");
  if (speed !== undefined) {
    const units: Record<string, string> = {
      "": "speedFt",
      land: "speedFt",
      fly: "flySpeedFt",
      swim: "swimSpeedFt",
      climb: "climbSpeedFt",
      burrow: "burrowSpeedFt",
    };
    const found: string[] = [];
    for (const part of splitTop(speed.value, [","])) {
      const match = /(?:^|\s)(fly|swim|climb|burrow)?\s*(\d+)\s*(?:ft|feet|')/i.exec(part);
      if (match === null) continue;
      const kind = (match[1] ?? "").toLowerCase();
      const field = units[kind];
      const value = int(match[2]);
      if (field === undefined || value === undefined || value <= 0) continue;
      pf1e[field] = value;
      playable = true;
      found.push(kind === "" ? `${value} ft.` : `${kind} ${value} ft.`);
      const manoeuvrability = /\(([^)]*)\)/.exec(part)?.[1]?.trim();
      if (manoeuvrability !== undefined && manoeuvrability !== "")
        warnings.push(
          `${kind === "" ? "the speed" : `${kind} speed`} states manoeuvrability "${manoeuvrability}" — this app does not model flight manoeuvrability`,
        );
    }
    if (found.length > 0) read.push(`speed: ${found.join(", ")}`);
    else warnings.push(`the Speed line stated no distance this app could read (${speed.value})`);
  }
  const reach = clauseOf(clauses, "Reach");
  const reachFt = reach === undefined ? undefined : int(/(\d+)/.exec(reach.value)?.[1]);
  const reachSquares =
    reachFt === undefined || reachFt <= 0 ? undefined : Math.max(1, Math.round(reachFt / 5));
  if (reachSquares !== undefined && reachSquares > 1)
    read.push(`reach: ${reachFt} ft. (${reachSquares} squares)`);
  const space = clauseOf(clauses, "Space");
  if (space !== undefined && space.value.trim() !== "") {
    // Space and reach are printed together and both follow from the size category above; the
    // printed reach is the one that becomes a line, the printed space only confirms the size.
    read.push(
      `space: ${space.value.trim()} (the token's footprint comes from the size category)`,
    );
  }
  const attacks: PF1eAttackEntry[] = [];
  for (const [labels, ranged] of [
    [["Melee"], false],
    [["Ranged"], true],
  ] as const) {
    const clause = clauseOf(clauses, ...labels);
    if (clause === undefined) continue;
    const parsed = attacksOf(clause, {
      ranged,
      ...(reachSquares === undefined ? {} : { reachSquares }),
    });
    attacks.push(...parsed.attacks);
    for (const note of parsed.notes) warnings.push(note);
  }
  if (attacks.length > 0) {
    pf1e.attacks = attacks;
    playable = true;
    read.push(
      `attack lines: ${attacks.map((a) => a.name).filter((n, i, all) => all.indexOf(n) === i).join(", ")}`,
    );
  } else {
    warnings.push(
      "no Melee or Ranged line was found — the Attacks tab starts empty and can be filled from the sheet",
    );
  }
  const specialAttacks: string[] = [];
  const special = clauseOf(clauses, "Special Attacks");
  if (special !== undefined && special.value.trim() !== "")
    specialAttacks.push(special.value.trim());
  const spellLike = clauseOf(clauses, "Spell-Like Abilities");
  if (spellLike !== undefined && spellLike.value.trim() !== "") {
    specialAttacks.push(labelFor("Spell-Like Abilities", spellLike.value.trim()));
    warnings.push(
      "spell-like abilities are recorded as text on the monster details; this app's Casting tab holds slots and prepared spells, so their rules are not automated",
    );
  }
  const spells = clauseOf(clauses, "Spells");
  if (spells !== undefined && spells.value.trim() !== "") {
    specialAttacks.push(labelFor("Spells", spells.value.trim()));
    warnings.push(
      "the block's spell list is recorded as text on the monster details: author prepared spells on the Casting tab for them to be castable",
    );
  }
  if (specialAttacks.length > 0) {
    creature.specialAttacks = specialAttacks.join("\n");
    read.push(
      `special attacks kept on the sheet: ${specialAttacks.length} line${specialAttacks.length === 1 ? "" : "s"}`,
    );
  }

  // ── statistics ──
  const baseAtk = clauseOf(clauses, "Base Atk");
  if (baseAtk !== undefined) {
    const value = signedNumbers(baseAtk.value)[0];
    if (value !== undefined) {
      pf1e.baseAttack = value;
      playable = true;
      read.push(`base attack bonus: ${value >= 0 ? "+" : ""}${value}`);
    }
  }
  const cmb = clauseOf(clauses, "CMB");
  if (cmb !== undefined) {
    const value = signedNumbers(cmb.value)[0];
    if (value !== undefined) {
      pf1e.cmb = value;
      read.push(`CMB: ${value >= 0 ? "+" : ""}${value}`);
    }
    // `CMB +9 (+13 grapple)` is a conditional modifier, not a different CMB.
    const conditional = /\(([^)]*)\)/.exec(cmb.value)?.[1]?.trim();
    if (conditional !== undefined && conditional !== "")
      warnings.push(
        `the CMB line's conditional modifier was not imported (${conditional}): this app derives CMB from Base Atk, Strength and size, and has no field for a maneuver-specific bonus`,
      );
  }
  const cmd = clauseOf(clauses, "CMD");
  if (cmd !== undefined) {
    const value = signedNumbers(cmd.value)[0];
    if (value !== undefined) {
      pf1e.cmd = value;
      read.push(`CMD: ${value}`);
    }
    const conditional = /\(([^)]*)\)/.exec(cmd.value)?.[1]?.trim();
    if (conditional !== undefined && conditional !== "")
      warnings.push(
        `the CMD line's conditional modifier was not imported (${conditional}): this app derives CMD from Base Atk, Strength, Dexterity and size, and has no field for a maneuver-specific bonus`,
      );
  }
  const feats = clauseOf(clauses, "Feats");
  if (feats !== undefined) {
    const names = splitTop(feats.value, [","]).filter((name) => name !== "");
    if (names.length > 0) {
      pf1e.feats = names;
      read.push(`feats: ${names.join(", ")}`);
    }
  }
  const skills = clausesOfLabel(clauses, "Skills");
  const racial = clausesOfLabel(clauses, "Racial Modifiers");
  const skillText = [...skills, ...racial]
    .map((clause) => clause.value)
    .join(", ")
    .trim();
  if (skillText !== "")
    warnings.push(
      `skill totals were not imported (${skillText}): this app derives skill modifiers from ranks, ability, class-skill bonus and armor check penalty — author the ranks on the Skills tab`,
    );
  const languages = clauseOf(clauses, "Languages");
  if (languages !== undefined && languages.value.trim() !== "") {
    creature.languages = languages.value.trim();
    read.push(labelFor("languages", languages.value.trim()));
  }
  const sq = clauseOf(clauses, "SQ");
  if (sq !== undefined && sq.value.trim() !== "") qualities.push(labelFor("SQ", sq.value.trim()));
  // Two of the qualities a stat block prints in that line *are* modelled fields, so they are read
  // out of the prose rather than left to be retyped: `fast healing 2` and `regeneration 5 (cold
  // iron)`. The text stays in `SQ` either way — the sheet shows both, and the numbers are the
  // ones the block printed.
  const qualitiesText = [
    ...qualities,
    clauseOf(clauses, "Defensive Abilities")?.value ?? "",
  ].join("; ");
  const fastHealing = /\bfast healing\s*(\d+)/i.exec(qualitiesText);
  if (fastHealing !== null) {
    const value = int(fastHealing[1]);
    if (value !== undefined) {
      pf1e.fastHealing = value;
      playable = true;
      read.push(`fast healing: ${value}`);
    }
  }
  const regeneration = /\bregeneration\s*(\d+)/i.exec(qualitiesText);
  if (regeneration !== null) {
    const value = int(regeneration[1]);
    if (value !== undefined) {
      pf1e.regeneration = value;
      playable = true;
      const suppressText = /\(([^)]*)\)/.exec(qualitiesText.slice(regeneration.index))?.[1]?.trim();
      if (suppressText !== undefined && suppressText !== "" && suppressText.toLowerCase() !== "see text") {
        const list = suppressText
          .split(/\s+or\s+|\s+and\s+|\s*,\s*/i)
          .map((part) => part.trim())
          .filter((part) => part !== "");
        if (list.length > 0) pf1e.regenSuppress = list;
      }
      read.push(
        `regeneration: ${value}${Array.isArray(pf1e.regenSuppress) ? ` (suppressed by ${(pf1e.regenSuppress as string[]).join(" or ")})` : ""}`,
      );
    }
  }
  if (qualities.length > 0) {
    creature.sq = qualities.join("\n");
    read.push(`special qualities kept on the sheet: ${qualities.length}`);
  }

  // ── ecology and everything else ──
  const treasure = clauseOf(clauses, "Treasure");
  if (treasure !== undefined && treasure.value.trim() !== "") {
    creature.treasure = treasure.value.trim();
    read.push(labelFor("treasure", treasure.value.trim()));
  }
  const environment = clauseOf(clauses, "Environment");
  if (environment !== undefined && environment.value.trim() !== "")
    warnings.push(
      `environment was not placed (${environment.value.trim()}): this app has no encounter-builder field for it yet`,
    );
  const organization = clauseOf(clauses, "Organization");
  if (organization !== undefined && organization.value.trim() !== "")
    warnings.push(
      `organization was not placed (${organization.value.trim()}): this app has no encounter-builder field for it yet`,
    );
  const gear = clausesOfLabel(clauses, "Gear", "Combat Gear", "Other Gear");
  if (gear.length > 0)
    warnings.push(
      `gear was not imported (${gear.map((clause) => clause.value).join("; ")}): author the items on the Items tab so their numbers come from this app's own item rules`,
    );
  const xp = clauseOf(clauses, "XP");
  if (xp !== undefined && xp.value.trim() !== "")
    warnings.push(`XP was not placed (${xp.value.trim()}): this app tracks no experience points`);
  const used = new Set([
    "cr",
    "init",
    "initiative",
    "senses",
    "ac",
    "hp",
    "fort",
    "fortitude",
    "ref",
    "reflex",
    "will",
    "defensive abilities",
    "immune",
    "resist",
    "weaknesses",
    "dr",
    "sr",
    "speed",
    "reach",
    "melee",
    "ranged",
    "space",
    "special attacks",
    "spell-like abilities",
    "spells",
    "str",
    "dex",
    "con",
    "int",
    "wis",
    "cha",
    "base atk",
    "cmb",
    "cmd",
    "feats",
    "skills",
    "racial modifiers",
    "languages",
    "sq",
    "treasure",
    "environment",
    "organization",
    "gear",
    "combat gear",
    "other gear",
    "xp",
  ]);
  const leftover = clauses.filter((clause) => !used.has(clause.label.toLowerCase()));
  if (leftover.length > 0) {
    const named = leftover
      .map((clause) => `${clause.label}${clause.value === "" ? "" : ` ${clause.value}`}`)
      .join(" · ");
    warnings.push(`this app does not place these lines: ${named}`);
  }
  if (Object.keys(creature).length > 0) pf1e.creature = creature;

  if (read.length === 0) {
    return err(
      "statblock: the block's lines were recognised but none of them state something this app can place — check that it is a creature stat block",
    );
  }
  if (!playable) {
    return err(
      `statblock: the block describes ${name} but states no number this app can play — no hit points, AC, saves, ability scores, speed or attacks were found, so nothing was created. Paste the whole stat block, the DEFENSE and OFFENSE lines included`,
    );
  }
  return imported("statblock", { name, system: pf1e, items: [], read, warnings });
}

/** A `name` for the report when a caller only has the text. */
export const statblockNameOf = (text: string): string | undefined =>
  str(text.split(/\r?\n/)[0]?.replace(/\bCR\s+[\d/]+\s*$/, "").trim());
