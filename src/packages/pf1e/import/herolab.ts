/**
 * §3.1 (G-39) — **Hero Lab XML** → an actor this app plays.
 *
 * This is the path a Roll20 table takes (Roll20's own PF importer is a Hero Lab XML reader), and
 * the format has one property that decides this module's whole design: Hero Lab's export has no
 * DTD and its nesting has moved between versions — the community importers say so plainly, and
 * MapTool's own reader reaches it by XPath rather than by a schema. Reaching it by *path*
 * (`document/public/character/attributes/attribute`) is therefore the fragile choice, and the
 * robust one is to read **by label**: parse the document into a tree (no namespace games, no DTD),
 * then find facts by what they are *called* — an element whose `name` says `Strength`, a
 * `armorclass` element, a `skill`, a `weapon` — and take each value from wherever that label keeps
 * it (its own attribute, a named child element, or its text).
 *
 * Two things the format is documented to carry, and what this reader does with them:
 *
 * - **It does not publish the character's items or attacks.** Roll20's own importer lists AC,
 *   items and attacks as *not* imported, and says why. A Hero Lab import therefore brings a
 *   character's *stats* across and leaves the gear to the Items tab; the report says so rather
 *   than pretending an empty inventory is an empty character.
 * - **It publishes totals where this app derives.** A saving throw is a total and the armor class
 *   is a published triple (`ac`/`touch`/`flatfooted`, which is how MapTool reads it). Both are
 *   authored as published facts (`savesAsTotal`, `acMode: "published"`) — the two fields the
 *   derived reader already honours for a stat block — and the report says the sheet will not
 *   recompute them.
 *
 * `attrvalue` is the verified spelling for an attribute's own numbers (MapTool's importer reads
 * `attribute[@name='Strength']/attrvalue/@modified`); the element-text form is accepted too,
 * because that same public source shows both shapes in the wild.
 */
import type { Result } from "../../../core/result";
import { err } from "../../../core/result";
import { abilityMod, normalizeSize } from "../rulesTables";
import { normalizeSkillId } from "../skills";
import { parseDamage } from "./dice";
import {
  abilitiesBlock,
  abilityKey,
  attackLinesFromItems,
  imported,
  int,
  plainText,
  saveKey,
  str,
  type ImportedCharacter,
  type ImportedItem,
} from "./types";

/** A parsed element: what this reader needs from XML, and nothing else. */
export interface XmlNode {
  name: string;
  /** Attribute names lower-cased — Hero Lab spells them inconsistently across versions. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content, entities decoded. */
  text: string;
}

/**
 * A small, tolerant XML reader: elements, attributes, text, comments, processing instructions and
 * CDATA. It is not a validating parser and does not pretend to be one — it exists so this module
 * has no dependency and so a document Hero Lab itself wrote is read the way Hero Lab meant it.
 * An unterminated tag closes at the end of input; unknown constructs are skipped rather than
 * thrown, because the report can say what was missing but cannot say why a file failed to parse.
 */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = {
    name: "#document",
    attrs: {},
    children: [],
    text: "",
  };
  const stack: XmlNode[] = [root];
  let i = 0;
  const decode = (text: string): string =>
    text.replace(
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
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      const tail = stack[stack.length - 1];
      if (tail !== undefined) tail.text += decode(xml.slice(i));
      break;
    }
    const parent = stack[stack.length - 1];
    if (lt > i && parent !== undefined) parent.text += decode(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      const cdataParent = stack[stack.length - 1];
      if (cdataParent !== undefined)
        cdataParent.text += xml.slice(lt + 9, end < 0 ? xml.length : end);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt);
      i = end < 0 ? xml.length : end + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt < 0) break;
    const inner = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      // close the nearest open element of that name (a tolerant reader: a stray close tag is
      // ignored rather than treated as the end of the document)
      for (let index = stack.length - 1; index > 0; index--) {
        const node: XmlNode | undefined = stack[index];
        if (node !== undefined && node.name === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/[\s]/);
    const name = (space < 0 ? body : body.slice(0, space)).toLowerCase();
    const attrs: Record<string, string> = {};
    if (space >= 0) {
      const attrRe = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(body.slice(space))) !== null) {
        const key = m[1];
        if (key !== undefined)
          attrs[key.toLowerCase()] = decode(m[2] ?? m[3] ?? "");
      }
    }
    const node: XmlNode = { name, attrs, children: [], text: "" };
    const parentNode = stack[stack.length - 1];
    if (parentNode !== undefined) parentNode.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** Every element in the tree with this name, in document order (a depth-first walk). */
export function findAll(root: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (node: XmlNode): void => {
    for (const child of node.children) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * One fact's number, from wherever its label put it: a named attribute (`modified` first — the
 * value the character actually plays with — then `value`, `text`, `base`, `current`, `total`,
 * `score`), a child element with one of those names, or the element's own text.
 */
export function valueOfNode(node: XmlNode): number | undefined {
  const keys = [
    "modified",
    "value",
    "text",
    "base",
    "current",
    "total",
    "score",
  ];
  for (const key of keys) {
    const raw = node.attrs[key];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  // A child element may carry the number as its own attribute (`<attrvalue modified="18"/>`) or as
  // a child of the same name (`<attribute><modified>18</modified></attribute>`) — both shapes are
  // in the wild, so both are read.
  for (const child of node.children) {
    for (const key of keys) {
      const raw = child.attrs[key];
      if (raw === undefined || raw.trim() === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  }
  for (const key of keys) {
    const child = node.children.find((c) => c.name === key);
    if (child === undefined) continue;
    const nested = valueOfNode(child);
    if (nested !== undefined) return nested;
  }
  // …and finally the element's own text (`<hitpoints>38</hitpoints>`), which is where a portfolio
  // often keeps a number that has no attribute of its own.
  const text = node.text.trim();
  if (text !== "") {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** The leading whole number of a text like `"5d8"` — a count stated as dice, not a die size. */
function leadingInt(text: string): number | undefined {
  const match = /^\s*(\d+)/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** The label an element carries: its `name`, its `id`, or its own tag name. */
export function labelOf(node: XmlNode): string {
  return (
    str(node.attrs.name) ??
    str(node.attrs.id) ??
    node.name
  ).toLowerCase();
}

/** `+3` / `−1` — how a bonus reads on a character sheet. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

export function looksLikeHeroLabXml(text: string): boolean {
  const head = typeof text === "string" ? text.slice(0, 4000) : "";
  if (!/<\s*(document|character|public)[\s>]/i.test(head)) return false;
  return /<character[\s>]/i.test(text) || /<document[\s>]/i.test(head);
}

export function importHeroLabCharacter(
  text: string,
): Result<ImportedCharacter> {
  const xml = typeof text === "string" ? text : "";
  if (!looksLikeHeroLabXml(xml)) {
    return err(
      "herolab: this does not look like a Hero Lab XML export — export with File ▸ Save Custom Output ▸ Generate XML File (a .por file is a zip; unpack it or use that export)",
    );
  }
  const root = parseXml(xml);
  const characters = findAll(root, "character");
  const first = characters[0];
  if (first === undefined)
    return err("herolab: the export contains no <character> element");
  const warnings: string[] = [];
  const read: string[] = [];
  const name =
    str(first.attrs.name) ??
    str(findAll(first, "charactername")[0]?.attrs.value) ??
    str(findAll(first, "name")[0]?.attrs.value) ??
    (findAll(first, "name")[0]?.text.trim() || undefined) ??
    "";
  if (characters.length > 1) {
    warnings.push(
      `the portfolio holds ${characters.length} characters — only the first was imported; export the others one at a time`,
    );
  }

  const pf1e: Record<string, unknown> = {};

  // ── abilities ──
  const abilityScores: Record<string, unknown> = {};
  for (const node of findAll(first, "attribute")) {
    const key = abilityKey(node.attrs.name);
    if (key === undefined || abilityScores[key] !== undefined) continue;
    const value = valueOfNode(node);
    if (value !== undefined) abilityScores[key] = { value };
  }
  const abilities = abilitiesBlock(abilityScores);
  /** The Strength modifier the printed weapon lines are decomposed against (see the weapons pass). */
  const strMod =
    abilities?.str === undefined ? undefined : abilityMod(abilities.str);
  if (abilities !== undefined) {
    pf1e.abilities = abilities;
    read.push(
      `abilities: ${Object.entries(abilities)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  } else {
    warnings.push(
      'no ability scores were found (expected <attribute name="Strength">…)',
    );
  }

  // ── hit points ──
  const hpNode =
    findAll(first, "hitpoints")[0] ??
    findAll(first, "hitpointsmax")[0] ??
    findAll(first, "hp")[0] ??
    findAll(first, "health")[0];
  const maxHp = findAll(first, "hitpointsmax")[0] ?? findAll(first, "hpmax")[0];
  if (hpNode !== undefined) {
    const current = valueOfNode(hpNode);
    const max =
      maxHp === undefined ? int(hpNode.attrs.max) : valueOfNode(maxHp);
    if (max !== undefined && max > 0) {
      pf1e.hpMax = max;
      pf1e.hp =
        current !== undefined && current > 0 ? Math.min(current, max) : max;
      read.push(`hit points: ${String(pf1e.hp)}/${max}`);
    } else if (current !== undefined) {
      pf1e.hp = current;
      pf1e.hpMax = current;
      read.push(`hit points: ${current}/${current}`);
    }
  } else {
    warnings.push(
      "hit points were not found in the export — author them on the sheet",
    );
  }

  // ── armor class, published as a triple ──
  const acNode = findAll(first, "armorclass")[0] ?? findAll(first, "ac")[0];
  if (acNode !== undefined) {
    const normal =
      int(acNode.attrs.ac) ?? int(acNode.attrs.value) ?? valueOfNode(acNode);
    const touch = int(acNode.attrs.touch);
    const flat = int(acNode.attrs.flatfooted) ?? int(acNode.attrs.flat_footed);
    if (normal !== undefined && normal > 0) {
      pf1e.acTotals = {
        normal,
        ...(touch !== undefined ? { touch } : {}),
        ...(flat !== undefined ? { flatFooted: flat } : {}),
      };
      pf1e.acMode = "published";
      read.push(
        `AC (published): ${normal}${touch !== undefined ? ` / touch ${touch}` : ""}${flat !== undefined ? ` / flat-footed ${flat}` : ""}`,
      );
      warnings.push(
        "AC came across as a published total: it will not follow a change of armor or Dexterity — author the components on the sheet if the sheet should recompute it",
      );
    }
  } else {
    warnings.push("the export states no armor class — author it on the sheet");
  }

  // ── saving throws, totals by nature ──
  const saves: Record<string, number> = {};
  const savesParent =
    findAll(first, "saves")[0] ?? findAll(first, "savingthrows")[0];
  if (savesParent !== undefined) {
    // By label, like everything else here: a portfolio may spell the three attributes `fort` or
    // `fortitude`, `ref` or `reflex` — `saveKey` is the one place that knows the aliases.
    for (const [label, raw] of Object.entries(savesParent.attrs)) {
      const key = saveKey(label);
      if (key === undefined) continue;
      const value = int(raw);
      if (value !== undefined) saves[key] = value;
    }
  }
  for (const node of findAll(first, "save")) {
    const key = saveKey(node.attrs.name) ?? saveKey(node.attrs.id);
    if (key === undefined || saves[key] !== undefined) continue;
    const value = valueOfNode(node);
    if (value !== undefined) saves[key] = value;
  }
  if (Object.keys(saves).length > 0) {
    pf1e.saves = saves;
    pf1e.savesAsTotal = true;
    read.push(
      `saves (published): ${Object.entries(saves)
        .map(([k, v]) => `${k} +${v}`)
        .join(", ")}`,
    );
    warnings.push(
      "saving throws came across as totals: they will not follow a change of ability score (author the components on the sheet if you want them recomputed)",
    );
  } else {
    warnings.push("saving throws were not found in the export");
  }

  // ── base attack bonus and hit dice ──
  const babNode = findAll(first, "baseattack")[0] ?? findAll(first, "bab")[0];
  if (babNode !== undefined) {
    const bab = valueOfNode(babNode);
    if (bab !== undefined) {
      pf1e.baseAttack = bab;
      read.push(`base attack bonus: ${bab}`);
    }
  }
  const hdNode =
    findAll(first, "hitdice")[0] ?? findAll(first, "totalhitdice")[0];
  if (hdNode !== undefined) {
    // `5` and `5d8` are both hit dice as a portfolio states them: the count is the leading
    // integer, and the die size is not a fact this app's actor shape keeps.
    const hd = valueOfNode(hdNode) ?? leadingInt(hdNode.text);
    if (hd !== undefined && hd > 0) {
      pf1e.hitDice = hd;
      read.push(`hit dice: ${hd}`);
    }
  }

  // ── size ──
  const sizeNode = findAll(first, "size")[0];
  if (sizeNode !== undefined) {
    const size =
      str(sizeNode.attrs.name) ??
      str(sizeNode.attrs.value) ??
      str(sizeNode.text);
    if (size !== undefined) {
      const normalized = normalizeSize(size);
      if (normalized === null) {
        warnings.push(
          `size ${JSON.stringify(size)} is not a PF1e size category — left unauthored (Medium is assumed until the sheet says otherwise)`,
        );
      } else {
        pf1e.size = normalized;
        read.push(`size: ${normalized}`);
      }
    }
  }

  // ── skills ──
  const skillRows = findAll(first, "skill");
  const skillsAuthored: Record<
    string,
    { ranks: number; classSkill?: boolean }
  > = {};
  const skippedSkills: string[] = [];
  for (const row of skillRows) {
    const label = str(row.attrs.name) ?? str(row.attrs.id);
    if (label === undefined) continue;
    const id =
      normalizeSkillId(label) ??
      normalizeSkillId(label.replace(/[^A-Za-z]/g, ""));
    if (id === undefined) {
      skippedSkills.push(label);
      continue;
    }
    const ranks = int(row.attrs.ranks ?? row.attrs.rank) ?? 0;
    const classSkill = /^(yes|true|y)$/i.test(
      row.attrs.classskill ?? row.attrs.class ?? "",
    );
    if (ranks === 0 && !classSkill) continue;
    skillsAuthored[id] = {
      ranks: Math.max(0, ranks),
      ...(classSkill ? { classSkill: true } : {}),
    };
  }
  if (Object.keys(skillsAuthored).length > 0) {
    pf1e.skills = skillsAuthored;
    read.push(`skill ranks: ${Object.keys(skillsAuthored).length} skill(s)`);
    warnings.push(
      "skill totals were not imported: this app derives them from ability, ranks, class skill and armor check penalty, so only ranks and class-skill marks were read",
    );
  }
  if (skippedSkills.length > 0) {
    warnings.push(
      `skill(s) this app has no row for were skipped: ${skippedSkills.slice(0, 8).join(", ")}${skippedSkills.length > 8 ? ` (+${skippedSkills.length - 8} more)` : ""}`,
    );
  }

  // ── weapons: the dice come across, the printed attack total does not ──
  const items: ImportedItem[] = [];
  const weaponNodes = [
    ...findAll(first, "weapon"),
    ...findAll(first, "melee"),
    ...findAll(first, "ranged"),
  ];
  let ignoredAttackTotals = 0;
  for (const row of weaponNodes) {
    const label = str(row.attrs.name);
    if (label === undefined) continue;
    const damageNode = row.children.find((c) => c.name === "damage");
    const damageText =
      str(row.attrs.damage) ??
      str(damageNode?.attrs.value) ??
      str(damageNode?.attrs.text) ??
      (damageNode === undefined ? undefined : str(damageNode.text));
    const attackTotal = int(row.attrs.attack ?? row.attrs.att);
    if (attackTotal !== undefined) ignoredAttackTotals++;
    const parsed = damageText === undefined ? null : parseDamage(damageText);
    // A Hero Lab damage line is a *total* ("1d8+4"): it already contains the wielder's Strength.
    // The dice come across, the ability contribution is left to the derivation (which reads the
    // abilities above), and only what is left of the printed total — an enhancement bonus, a
    // weapon-specialisation bonus — is authored as the weapon's own flat, carrying
    // `abilityDamageIncluded` so Strength is not added a second time. Either way the printed
    // total is what the line rolls to. With no Strength in the export there is nothing to
    // subtract, so the flat is left out and named rather than guessed.
    const printedRemainder =
      parsed === null || parsed.bonus === 0
        ? undefined
        : strMod === undefined
          ? null
          : parsed.bonus - strMod;
    if (printedRemainder === null) {
      warnings.push(
        `${label}: the printed damage bonus ${parsed === null ? "" : String(parsed.bonus)} was not imported because the export states no Strength for this character — add it on the Items tab if the weapon is magical`,
      );
    }
    items.push({
      name: label,
      system: {
        category: "weapon",
        quantity: 1,
        ...(row.attrs.equipped === "yes" ? { equipped: true } : {}),
        weapon: {
          class:
            row.name === "ranged" || row.attrs.ranged === "yes"
              ? "projectile"
              : "melee",
          ...(parsed !== null && parsed.dice !== ""
            ? { damageDice: parsed.dice }
            : {}),
          ...(printedRemainder !== undefined &&
          printedRemainder !== null &&
          printedRemainder !== 0
            ? { damageBonus: printedRemainder, abilityDamageIncluded: true }
            : {}),
        },
      },
    });
    if (printedRemainder !== undefined && printedRemainder !== null) {
      read.push(
        `${label}: damage ${damageText ?? ""} — the wielder's Strength (${signed(strMod ?? 0)}) is derived from the character's own scores${printedRemainder !== 0 ? `, ${signed(printedRemainder)} kept on the weapon` : ""}`,
      );
    }
  }
  if (ignoredAttackTotals > 0) {
    warnings.push(
      "the weapon attack bonuses Hero Lab printed were not imported: this app derives them from base attack bonus and abilities, so importing the printed totals would count twice",
    );
  }
  if (items.length > 0)
    read.push(`weapons: ${items.map((i) => i.name).join(", ")}`);
  const { attacks } = attackLinesFromItems(items, str(pf1e.size), warnings);
  if (attacks.length > 0) {
    pf1e.attacks = attacks;
    read.push(
      `attack lines authored from weapons: ${attacks.map((a) => a.name).join(", ")}`,
    );
  }
  if (weaponNodes.length === 0) {
    warnings.push(
      "this export lists no weapons: a Hero Lab character's gear has to be authored on the Items tab",
    );
  }

  // ── what else the format carries that this app has no home for, in its own words ──
  const noHome = (
    [
      "language",
      "resist",
      "immune",
      "weakness",
      "sense",
      "dr",
      "special",
    ] as const
  )
    .map((tag) => [tag, findAll(first, tag).length] as const)
    .filter(([, count]) => count > 0);
  if (noHome.length > 0) {
    warnings.push(
      `${noHome.map(([tag, count]) => `${count} ${tag}${count === 1 ? "" : "s"}`).join(", ")} have no home on this app's sheet yet — author them as traits or effects if a rule needs them`,
    );
  }
  const personalCount = [
    "alignment",
    "deity",
    "gender",
    "age",
    "height",
    "weight",
    "hair",
    "eyes",
    "skin",
  ].reduce((total, tag) => total + findAll(first, tag).length, 0);
  if (personalCount > 0) {
    warnings.push(
      `${personalCount} personal-detail field(s) (alignment, deity, …) have no home on this app's sheet yet`,
    );
  }
  const description =
    findAll(first, "description")[0] ?? findAll(first, "personality")[0];
  if (description !== undefined && plainText(description.text).length > 0) {
    warnings.push(
      "the character's description text was not imported: this app has no biography field yet",
    );
  }

  if (read.length === 0) {
    return err(
      "herolab: no recognisable character data was found in this export",
    );
  }
  return imported("herolab", {
    name: name === "" ? "Imported character" : name,
    system: pf1e,
    items,
    read,
    warnings,
  });
}
