/**
 * PF1e content converter — pure mappers (no I/O), one per target entry kind.
 *
 * Source shapes (verified against the pinned commits, see tools/adopt/INVENTORY.md):
 *  - pf1 system packs (YAML): spells (system.actions + learnedAt), classes (savingThrows,
 *    bab, hd, links), items (system.weapon/armor/uses), actors (system.abilities/speed/
 *    attributes, traits.size/dr/sr, details).
 *  - pf1e-content packs (JSON): same family, per entry { _id, name, type, system }.
 *
 * Target shapes (the app's own contracts, the in-repo packs are the quality bar):
 *  - items  → data { type: "item", name, system: {…display + carried raw…}, effects: [] }
 *  - actors → data { type: "actor", name, system: { pf1e: <PF1eActorSystem block>, … },
 *               items: [], effects: [] }  — the SAME `system.pf1e` block the tactical
 *               derivation (actor.ts:deriveFromDocuments) and the strategic profile read.
 *
 * Drop policy (plan §2, P-1/P-6): map the fields the app consumes, carry the rest of the
 * Foundry `system` under `system.foundry` (a per-kind whitelist — no loss, no bloat),
 * and count every category that is dropped outright (`_id`, `img` — Foundry's icon
 * library is not shipped — `flags`, source `items`/`effects`, …). The caller turns the
 * counters into the per-pack drop report (REPORT.md).
 */

// ─── lookup tables ──────────────────────────────────────────────────────────────

export const SCHOOL = {
  abj: "Abjuration",
  conj: "Conjuration",
  div: "Divination",
  evo: "Evocation",
  enr: "Enchantment",
  ill: "Illusion",
  nec: "Necromancy",
  tru: "Transmutation",
};

export const SIZE = {
  f: "Fine",
  d: "Diminutive",
  t: "Tiny",
  sm: "Small",
  med: "Medium",
  lg: "Large",
  xl: "Huge",
  g: "Gargantuan",
  co: "Colossal",
};

export const BAB = { high: "good", med: "medium", low: "low" };

/** The in-repo class `levels` tables' save convention (D-234): per-level totals. */
export const SAVE_PROGRESSION = {
  high: (n) => Math.floor(n / 2) + 2,
  medium: (n) => Math.floor(n / 2) + 1,
  low: (n) => Math.floor(n / 2),
};

/** PF1e class BAB progression, per level. */
export const BAB_PROGRESSION = {
  good: (n) => n,
  medium: (n) => Math.ceil(n / 2),
  low: (n) => Math.floor((n - 1) / 3),
};

const RANGE = {
  0: "range 0",
  personal: "personal",
  touch: "touch",
  close: "close (25 ft. + 5 ft./2 levels)",
  medium: "medium (100 ft. + 10 ft./level)",
  long: "long (400 ft. + 40 ft./level)",
  "extra-long": "extra-long (800 ft. + 80 ft./level)",
  unlimited: "unlimited",
  sight: "sight",
  special: "special",
};

const CASTING = {
  standard: "1 standard action",
  swift: "swift action",
  move: "1 move action",
  free: "free action",
  none: "—",
};

const SKILLS = {
  acr: "Acrobatics",
  arc: "Arcana",
  art: "Artistry",
  clm: "Climb",
  crf: "Craft",
  dip: "Diplomacy",
  flg: "Fly",
  han: "Handle Animal",
  int: "Intimidate",
  kna: "Knowledge",
  lor: "Lore",
  med: "Medicine",
  per: "Perception",
  rid: "Ride",
  sne: "Stealth",
  sur: "Survival",
  swm: "Swim",
  umd: "Use Magic Device",
};

const ARMOR_PROF = {
  lgt: "light",
  med: "medium",
  hvy: "heavy",
  shl: "shields",
  nsh: "no shields",
};

// ─── report ─────────────────────────────────────────────────────────────────────

/** Per-pack drop report: what the converter did, category by category. */
export function newReport() {
  return { total: 0, converted: 0, dropped: [], fields: {} };
}

/** Count a dropped field category (the REPORT.md row). */
export function dropField(report, category) {
  report.fields[category] = (report.fields[category] ?? 0) + 1;
}

// ─── small helpers ──────────────────────────────────────────────────────────────

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);

const num = (v) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

/** A Foundry `system.actions` block (an id-keyed object) as an array, "Use" first. */
export function actionsOf(system) {
  const actions = system?.actions;
  if (!isRecord(actions)) return [];
  const list = Object.values(actions).filter(isRecord);
  const use = list.findIndex((a) => a.name === "Use");
  if (use > 0) {
    const [u] = list.splice(use, 1);
    list.unshift(u);
  }
  return list;
}

/** Decode HTML entities in ONE pass, so `&amp;quot;` becomes the literal text `&quot;`, never a quote. */
function decodeEntities(s) {
  return s.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&#[xX][0-9a-f]+;|&#\d+;/g, (m) => {
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
  });
}

/**
 * HTML → plain text (the converter's notes are display strings, not documents).
 */
export function stripHtml(html) {
  if (typeof html !== "string") return undefined;
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * HTML → markdown for journal pages (JournalPageDocument.text is markdown — the app
 * renders it as such, and `<secret>` blocks in the markdown are projection-stripped).
 * The rules corpus is simple rulebook HTML (headings, paragraphs, lists, bold/italic),
 * so this small converter is enough; unknown tags drop their markup, keep their text.
 */
export function htmlToMarkdown(html) {
  if (typeof html !== "string" || html.trim() === "") return undefined;
  return decodeEntities(
    html
      // Foundry compendium/UUID links → the label text (the target documents are not carried)
      .replace(/@(?:Compendium|UUID)\[[^\]]*\]\{([^}]*)\}/g, "$1")
      // Foundry source tags → plain citation text ("CRB p. 183")
      .replace(/@Source\[([^;\]]+);pages=([^\]]+)\]/g, "$1 p. $2")
      .replace(/@Source\[([^\]]+)\]/g, "$1")
      .replace(/<h1[^>]*>/gi, "\n# ")
      .replace(/<h2[^>]*>/gi, "\n## ")
      .replace(/<h3[^>]*>/gi, "\n### ")
      .replace(/<h4[^>]*>/gi, "\n#### ")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
      .replace(/<strong[^>]*>/gi, "**").replace(/<\/strong>/gi, "**")
      .replace(/<b[^>]*>/gi, "**").replace(/<\/b>/gi, "**")
      .replace(/<em[^>]*>/gi, "*").replace(/<\/em>/gi, "*")
      .replace(/<i[^>]*>/gi, "*").replace(/<\/i>/gi, "*")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The compendium id: a lowercase slug of the name, unique within the pack. */
export function slugify(name, used = new Set()) {
  let id = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (id === "") id = "entry";
  let candidate = id;
  let n = 2;
  while (used.has(candidate)) candidate = `${id}-${n++}`;
  used.add(candidate);
  return candidate;
}

/** Entry names must fit the 80-char compendium guard; truncate + count. */
export function fitName(name, report) {
  const n = String(name ?? "").trim();
  if (n.length > 80) {
    dropField(report, "name truncated to 80 chars");
    return n.slice(0, 80);
  }
  return n;
}

/** description {summary, value(HTML)} → { notes, description } display pair. */
function descriptionFields(system) {
  const desc = system?.description;
  const out = {};
  const summary = stripHtml(desc?.summary ?? (typeof desc === "string" ? desc : undefined));
  const value = str(desc?.value);
  if (summary) out.notes = summary.slice(0, 300);
  if (value) out.description = value;
  return out;
}

/** The Foundry `system` kept raw under `system.foundry` (per-kind whitelist). */
function foundryCarry(system, keys, report) {
  if (!isRecord(system)) return undefined;
  const out = {};
  for (const k of keys) {
    const v = system[k];
    if (v === undefined || v === null) continue;
    out[k] = v;
    dropField(report, `system.${k} (carried raw)`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ─── mappers ────────────────────────────────────────────────────────────────────

/**
 * Spell (pf1 system YAML, pf-magic JSON). The in-repo spells.json shape is the target:
 * level table, school, descriptors, components, casting time, range/area/duration,
 * saving throw — plus the carried raw (actions, learnedAt, sources) for later phases.
 */
export function mapSpell(src, report, used) {
  const system = isRecord(src.system) ? src.system : {};
  const name = fitName(src.name, report);
  if (!name) return null;
  const action = actionsOf(system)[0] ?? {};
  const schoolRaw = system.school;
  const school =
    SCHOOL[schoolRaw] ?? (typeof schoolRaw === "string" && schoolRaw.length > 3 ? schoolRaw : undefined);
  const descriptors = Array.isArray(system.descriptors)
    ? system.descriptors.filter((d) => typeof d === "string")
    : [];
  const components = {
    ...(system.components?.verbal ? { verbal: true } : {}),
    ...(system.components?.somatic ? { somatic: true } : {}),
    ...(system.components?.focus ? { focus: true } : {}),
  };
  const materialCost = str(system.materials?.value ?? (typeof system.materials === "string" ? system.materials : undefined));
  if (materialCost) components.material = materialCost;
  else if (system.components?.material) components.material = true;
  const activation = action.activation;
  const castingTime =
    CASTING[activation?.type] ?? (typeof activation?.type === "string" ? activation.type : undefined);
  const range = RANGE[action.range?.units] ?? str(action.range?.units);
  const durationUnits = action.duration?.units;
  const durationValue = num(action.duration?.value);
  let duration;
  if (durationUnits === "inst") duration = "instantaneous";
  else if (durationUnits === "perm") duration = "permanent";
  else if (durationUnits === "conc") duration = "concentration";
  else if ((durationUnits === "hr" || durationUnits === "min") && durationValue !== undefined)
    duration = `${durationValue} ${durationUnits === "hr" ? "hour" : "minute"}${durationValue === 1 ? "" : "s"}`;
  else if (typeof durationUnits === "string") duration = durationUnits;
  const save = action.save;
  const savingThrow =
    str(save?.description) ??
    (save?.type && save.type !== "none"
      ? `${save.type === "ref" ? "Reflex" : save.type === "fort" ? "Fortitude" : "Will"}${save?.half ? " half" : ""}`
      : undefined);
  const learned = system.learnedAt?.class;
  const level =
    isRecord(learned) && Object.keys(learned).length > 0
      ? learned
      : typeof system.level === "number"
        ? { sorcererWizard: system.level }
        : undefined;

  const sys = {
    ...(level ? { level } : {}),
    ...(typeof system.level === "number" ? { levelNumber: system.level } : {}),
    ...(school ? { school } : {}),
    ...(descriptors.length > 0 ? { descriptors } : {}),
    ...(Object.keys(components).length > 0 ? { components } : {}),
    ...(castingTime ? { castingTime } : {}),
    ...(range ? { range } : {}),
    ...(str(action.target) ? { target: str(action.target) } : {}),
    ...(str(action.area) ? { area: str(action.area) } : {}),
    ...(duration ? { duration } : {}),
    ...(savingThrow ? { savingThrow } : {}),
    ...(system.spellResistance === true ? { spellResistance: true } : {}),
    ...descriptionFields(system),
  };
  const foundry = foundryCarry(system, [
    "learnedAt",
    "tradition",
    "materials",
    "sources",
    "uses",
  ], report);
  // carry the actions as an ordered array ("Use" first), not the id-keyed object
  const actionList = actionsOf(system);
  if (actionList.length > 0) {
    dropField(report, "system.actions (carried raw)");
    if (foundry) foundry.actions = actionList;
    else sys.foundry = { actions: actionList };
  }
  if (foundry) sys.foundry = foundry;

  return {
    id: slugify(name, used),
    name,
    keywords: ["spell", ...(school ? [school.toLowerCase()] : []), ...descriptors],
    data: { type: "item", name, system: sys, effects: [] },
  };
}

/** Feat (pf1 system YAML, pf-feats JSON). The in-repo feats.json shape is the target. */
export function mapFeat(src, report, used) {
  const system = isRecord(src.system) ? src.system : {};
  const name = fitName(src.name, report);
  if (!name) return null;
  const tags = Array.isArray(system.tags)
    ? system.tags.flat().filter((t) => typeof t === "string")
    : [];
  // `featType` is "feat" for plain feats (the mythic/advanced ones carry a variant type);
  // otherwise the first real tag — PFS/class/mythic markers are not categories.
  const TAG_STOP = new Set(["feat", "class", "pfs", "mythic", "advanced"]);
  const category =
    (typeof system.featType === "string" && !TAG_STOP.has(system.featType.toLowerCase())
      ? system.featType
      : undefined) ??
    tags.find((t) => t && !TAG_STOP.has(t.toLowerCase()))?.toLowerCase() ??
    "general";
  const sys = {
    category,
    ...descriptionFields(system),
  };
  const foundry = foundryCarry(system, [
    "uses",
    "changes",
    "actions",
    "tags",
    "duration",
    "abilityType",
    "classSkills",
    "associations",
  ], report);
  if (foundry) sys.foundry = foundry;

  return {
    id: slugify(name, used),
    name,
    keywords: ["feat", category, ...tags.filter((t) => t !== "feat")],
    data: { type: "item", name, system: sys, effects: [] },
  };
}

/** Class (pf1 system YAML). The in-repo classes.json shape is the target (levels table). */
export function mapClass(src, report, used) {
  const system = isRecord(src.system) ? src.system : {};
  const name = fitName(src.name, report);
  if (!name) return null;
  const bab = BAB[system.bab] ?? (typeof system.bab === "string" ? system.bab : "good");
  const savesRaw = {};
  const goodSaves = [];
  for (const k of ["fort", "ref", "will"]) {
    const v = system.savingThrows?.[k]?.value;
    if (v === "high" || v === "medium" || v === "low") {
      savesRaw[k] = v;
      if (v === "high") goodSaves.push(k);
    }
  }
  const levels = [];
  const babAt = BAB_PROGRESSION[bab] ?? BAB_PROGRESSION.good;
  for (let n = 1; n <= 20; n++) {
    levels.push({
      level: n,
      bab: babAt(n),
      fort: SAVE_PROGRESSION[savesRaw.fort ?? "low"](n),
      ref: SAVE_PROGRESSION[savesRaw.ref ?? "low"](n),
      will: SAVE_PROGRESSION[savesRaw.will ?? "low"](n),
    });
  }
  const classSkills = Array.isArray(system.classSkills)
    ? system.classSkills
        .map((s) => (typeof s === "string" ? SKILLS[s] ?? s : undefined))
        .filter((s) => s !== undefined)
    : [];
  const armorProf = Array.isArray(system.armorProf)
    ? system.armorProf.map((p) => ARMOR_PROF[p] ?? p)
    : [];
  const sys = {
    ...(typeof system.hd === "number" ? { hd: `d${system.hd}` } : {}),
    babProgression: bab,
    ...(goodSaves.length > 0 ? { goodSaves } : {}),
    ...(Object.keys(savesRaw).length > 0 ? { savingThrows: savesRaw } : {}),
    ...(typeof system.skillsPerLevel === "number"
      ? { skillRanksPerLevel: system.skillsPerLevel }
      : {}),
    ...(classSkills.length > 0 ? { classSkills } : {}),
    ...(armorProf.length > 0 ? { armorProf } : {}),
    levels,
    ...(str(system.alignment) ? { alignment: str(system.alignment) } : {}),
    ...descriptionFields(system),
  };
  const foundry = foundryCarry(system, ["links", "sources"], report);
  if (foundry) sys.foundry = foundry;

  return {
    id: slugify(name, used),
    name,
    keywords: ["class", ...(goodSaves.length > 0 ? goodSaves : [])],
    data: { type: "actor", name, system: sys, items: [], effects: [] },
  };
}

/**
 * Item of any other kind (weapon, armor, item, wondrous, consumable, artifact, buff,
 * trait, racialTrait, classAbility, specialQuality, rule, technology, …). Display-first:
 * category + notes + description, the mechanics the app will consume later (weapon/armor
 * blocks, uses, changes) carried both mapped (armor → PF1eArmorEntry shape) and raw.
 */
export function mapItem(src, report, used) {
  const system = isRecord(src.system) ? src.system : {};
  const name = fitName(src.name, report);
  if (!name) return null;
  const kind = typeof src.type === "string" ? src.type : "item";
  const sys = {
    category: kind,
    ...descriptionFields(system),
  };
  if (isRecord(system.armor)) {
    // pf1-system shape: { bonus, maximumDexBonus, checkPenalty, arcaneSpellFailure };
    // pf1e-content shape: { value, dex, acp, enh }.
    const a = system.armor;
    const bonus = num(a.bonus) ?? num(a.value);
    const maxDex = num(a.maximumDexBonus) ?? (a.dex === null ? 0 : num(a.dex));
    const acp = num(a.checkPenalty) ?? num(a.acp);
    const spellFail = num(a.arcaneSpellFailure) ?? num(a.spellFailure);
    sys.armor = {
      ...(bonus !== undefined ? { armorBonus: bonus } : {}),
      ...(maxDex !== undefined ? { maxDexBonus: maxDex } : {}),
      ...(acp !== undefined ? { checkPenalty: acp } : {}),
      ...(spellFail !== undefined ? { spellFailure: spellFail } : {}),
    };
  }
  if (isRecord(system.weapon)) sys.weapon = system.weapon;
  if (isRecord(system.uses)) sys.uses = system.uses;
  const cost = num(system.value) ?? num(system.price) ?? num(system.price?.value);
  if (cost !== undefined) sys.value = cost;
  const weight = num(system.weight) ?? num(system.weight?.value);
  if (weight !== undefined) sys.weight = weight;
  const itemHp = num(system.hp) ?? num(system.hp?.value) ?? num(system.hp?.max);
  if (itemHp !== undefined) sys.hp = itemHp;
  const hardness = num(system.hardness);
  if (hardness !== undefined) sys.hardness = hardness;
  if (Array.isArray(system.traits))
    sys.traits = system.traits.filter((t) => typeof t === "string");
  const foundry = foundryCarry(system, [
    "special",
    "recharge",
    "identification",
    "changes",
    "traits",
    "bulk",
    "equippable",
    "quantity",
    "aura",
    "cl",
  ], report);
  if (foundry) sys.foundry = foundry;

  return {
    id: slugify(name, used),
    name,
    keywords: [kind, ...(Array.isArray(system.traits) ? system.traits.filter((t) => typeof t === "string") : [])],
    data: { type: "item", name, system: sys, effects: [] },
  };
}

/**
 * Creature / NPC / companion / familiar / deity (pf1 system YAML actors, pf1e-content
 * character/npc actors). Writes the `system.pf1e` block the tactical derivation reads
 * (component-shaped where the source has components, published totals where it does not)
 * — the same block the strategic profile consumes (D-112: one authored location).
 */
export function mapActor(src, report, used) {
  const system = isRecord(src.system) ? src.system : {};
  const name = fitName(src.name, report);
  if (!name) return null;
  const traits = isRecord(system.traits) ? system.traits : {};
  const pf1e = {};

  const size = SIZE[traits.size] ?? (typeof traits.size === "string" && traits.size.length > 3 ? traits.size : undefined);
  if (size) pf1e.size = size;
  else dropField(report, "size (unmapped — defaults to Medium)");

  const abilities = {};
  for (const k of ["str", "dex", "con", "int", "wis", "cha"]) {
    const v = num(system.abilities?.[k]?.value);
    if (v !== undefined) abilities[k] = v;
  }
  if (Object.keys(abilities).length > 0) pf1e.abilities = abilities;

  const hp = num(system.attributes?.hp?.value);
  if (hp !== undefined) {
    pf1e.hp = hp;
    pf1e.hpMax = hp;
  }

  const speed = system.attributes?.speed;
  if (isRecord(speed)) {
    for (const [key, field] of [
      ["land", "speedFt"],
      ["fly", "flySpeedFt"],
      ["swim", "swimSpeedFt"],
      ["burrow", "burrowSpeedFt"],
      ["climb", "climbSpeedFt"],
    ]) {
      const v = num(speed[key]?.base) ?? num(speed[key]);
      if (v !== undefined && v > 0) pf1e[field] = v;
    }
  }

  const savesRaw = system.attributes?.savingThrows ?? system.saves;
  if (isRecord(savesRaw)) {
    const saves = {};
    for (const k of ["fort", "ref", "will"]) {
      const v = num(savesRaw[k]?.total) ?? num(savesRaw[k]?.value) ?? num(savesRaw[k]?.save);
      if (v !== undefined) saves[k] = v;
    }
    if (Object.keys(saves).length > 0) {
      pf1e.saves = saves;
      pf1e.savesAsTotal = true;
    }
  }

  // AC: classic monsters publish the component breakdown; companions/familiars publish
  // authored partials (0 when derived from equipment — in which case the sheet composes
  // 10 + Dex + size, a documented default rather than a guess).
  const ac = system.armorClass;
  if (isRecord(ac)) {
    const parts = (ac.base ?? 0) + (ac.armor ?? 0) + (ac.shield ?? 0) + (ac.natural ?? 0) + (ac.dex ?? 0) + (ac.bonus ?? 0);
    pf1e.acTotals = {
      normal: num(ac.acBase) ?? num(ac.total) ?? parts,
      touch: num(ac.touch),
      flatFooted: num(ac.flatFooted),
    };
    pf1e.acMode = "published";
  } else if (isRecord(system.attributes?.ac)) {
    const a = system.attributes.ac;
    if ((num(a.normal?.value) ?? 0) > 0 || (num(a.touch?.value) ?? 0) > 0 || (num(a.flatFooted?.value) ?? 0) > 0) {
      pf1e.acTotals = {
        normal: num(a.normal?.value) ?? 0,
        touch: num(a.touch?.value),
        flatFooted: num(a.flatFooted?.value),
      };
      pf1e.acMode = "published";
    } else {
      dropField(report, "ac (authored 0 — derived from equipment, not carried)");
    }
  } else {
    dropField(report, "ac (absent — composed by the sheet from defaults)");
  }

  const attackBonus = num(system.attackBonus);
  if (attackBonus !== undefined) pf1e.attackBonus = attackBonus;

  const drRaw = traits.dr ?? system.dr;
  if (typeof drRaw === "string" && drRaw.trim() !== "") {
    const m = drRaw.match(/(\d+)/);
    if (m) pf1e.dr = Number.parseInt(m[1], 10);
    const bypass = drRaw.split(/[\s/]+/).filter((w) => w && !/^\d+$/.test(w) && w !== "—" && w !== "-");
    if (bypass.length > 0) pf1e.drBypass = bypass;
  } else if (num(drRaw) !== undefined) {
    pf1e.dr = num(drRaw);
  }

  const sr = num(traits.sr) ?? num(system.sr) ?? (typeof traits.sr === "string" ? num(traits.sr.match(/(\d+)/)?.[1]) : undefined);
  if (sr !== undefined) pf1e.spellResistance = sr;

  const special = system.special;
  if (isRecord(special)) {
    const fh = num(special.fastHealing) ?? num(special.fast_healing);
    if (fh !== undefined && fh > 0) pf1e.fastHealing = fh;
    const reg = num(special.regeneration) ?? num(special.regen);
    if (reg !== undefined && reg > 0) pf1e.regeneration = reg;
  }
  const details = system.details;
  if (isRecord(details)) {
    // CR/XP/alignment ride the carried raw `foundry.details` — the block keeps rule fields only.
    const notes = stripHtml(details.biography?.value ?? details.notes?.value);
    if (notes) pf1e.notes = notes.slice(0, 1200);
  }

  const creatureTypes = Array.isArray(traits.creatureTypes)
    ? traits.creatureTypes
    : Array.isArray(system.creatureTypes)
      ? system.creatureTypes
      : [];
  const keywords = [
    typeof src.type === "string" ? src.type : "creature",
    ...creatureTypes.filter((t) => typeof t === "string"),
    ...Array.isArray(traits.creatureSubtypes) ? traits.creatureSubtypes.filter((t) => typeof t === "string") : [],
    ...(size ? [size.toLowerCase()] : []),
  ];

  const sys = { pf1e };
  const foundry = foundryCarry(system, [
    "details",
    "traits",
    "combat",
    "spells",
    "classes",
    "initiative",
    "perception",
    "skills",
  ], report);
  if (foundry) sys.foundry = foundry;

  return {
    id: slugify(name, used),
    name,
    keywords,
    data: { type: "actor", name, system: sys, items: [], effects: [] },
  };
}

/**
 * Roll table (pf1 system YAML: `_key: '!tables!…'`, formula + results[] — the
 * ultimate-equipment and roll-tables packs). Target: RollTableDocument. Foundry result
 * ranges are [min, max] arrays or "a-b" strings (sometimes comma-lists — the first
 * range is kept, the rest noted in the text).
 */
export function mapRollTable(src, report, used) {
  const name = fitName(src.name, report);
  if (!name) return null;
  const formula = str(src.formula) ?? "1d100";
  const rawResults = Array.isArray(src.results) ? src.results : [];
  const results = [];
  for (const r of rawResults) {
    if (!isRecord(r)) continue;
    let range;
    const raw = r.range;
    if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => Number.isFinite(Number(n)))) {
      range = [Number(raw[0]), Number(raw[1])];
    } else if (typeof raw === "string") {
      const first = raw.split(",")[0];
      const m = first.trim().match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        range = [Number(m[1]), Number(m[2])];
        if (raw.includes(",")) dropField(report, "roll-table range (multi-range — first kept)");
      }
    }
    if (!range) dropField(report, "roll-table result (unparseable range)");
    // Foundry roll-table results carry their text in `description` (older ones: `text`/`name`)
    const text =
      htmlToMarkdown(str(r.description) ?? str(r.text) ?? "") ?? str(r.name) ?? "";
    if (range && text) results.push({ range, text, documentRef: null });
  }
  if (results.length === 0) return null;

  return {
    id: slugify(name, used),
    name,
    keywords: ["roll-table"],
    data: { type: "rollTable", name, formula, results },
  };
}

/**
 * Journal / rules document (pf1e-content pf-rules: top-level `content` HTML; pf1 system
 * `rules`: `pages[]` with per-page `content`). Target: JournalDocument with markdown pages.
 */
export function mapJournal(src, report, used) {
  const name = fitName(src.name, report);
  if (!name) return null;
  // pf1-system journals nest the HTML under page.text.content; v11 JSON puts it in page.content
  const srcPages = Array.isArray(src.pages) && src.pages.length > 0 ? src.pages : [{ content: src.content }];
  const pages = [];
  for (const p of srcPages) {
    if (!isRecord(p)) continue;
    const content = str(p.text?.content) ?? str(p.content);
    if (!content) continue;
    const text = htmlToMarkdown(content);
    if (!text) continue;
    pages.push({ name: str(p.name) ?? name, text, src: null });
  }
  if (pages.length === 0) return null;
  dropField(report, "content (HTML → markdown, @Compendium links → label)");

  return {
    id: slugify(name, used),
    name,
    keywords: ["rules", "journal"],
    data: { type: "journal", name, pages },
  };
}

/**
 * Dispatch on the Foundry entry type (with shape fallbacks — the pf1-system roll tables
 * carry no `type`, and the pf-rules journals carry no `type` either).
 */
export function mapEntry(src, report, used) {
  const type = typeof src?.type === "string" ? src.type : "";
  const key = typeof src?._key === "string" ? src._key : "";
  switch (type) {
    case "spell":
      return mapSpell(src, report, used);
    case "feat":
      return mapFeat(src, report, used);
    case "class":
      return mapClass(src, report, used);
    case "npc":
    case "monster":
    case "character":
    case "companion":
    case "familiar":
    case "deity":
      return mapActor(src, report, used);
    case "rollTable":
    case "journal":
    case "JournalEntry":
      return type === "rollTable" ? mapRollTable(src, report, used) : mapJournal(src, report, used);
    default:
      break;
  }
  // shape fallbacks (type-less Foundry v11 documents)
  if (key.startsWith("!tables!") || Array.isArray(src.results)) return mapRollTable(src, report, used);
  if (typeof src.content === "string" || (Array.isArray(src.pages) && src.pages.length > 0))
    return mapJournal(src, report, used);
  return mapItem(src, report, used);
}
