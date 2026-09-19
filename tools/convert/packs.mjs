/**
 * Pack configuration — which vendored source directory becomes which content pack.
 *
 * Sources (pinned, git-ignored — see tools/adopt/INVENTORY.md for the license facts):
 *  - `pf1-system`    — the pf1 system mirror, `packs/<name>` per-entry YAML.
 *  - `pf1e-content`  — baileymh/pf1e-content, `src/packs/<name>` per-entry JSON.
 *
 * Stages per GAP_CLOSURE_ImplementationPlan §2.6: 1a = the pf1-system core packs,
 * 1b = the pf1e-content expanded packs. 1c (bestiary) and 1d (3PP) stay out until
 * their sources are decided (the Bestiary is GitLab-only today).
 */
export const CONTENT_PACKAGE = {
  id: "pf1e-content",
  name: "Pathfinder 1e Content (Foundry transfer)",
  version: "1.0.0",
  type: "data",
};

export const PACKS = [
  // ── stage 1a — pf1 system core (YAML) ────────────────────────────────────────
  { src: "pf1-system", dir: "packs/spells", out: "spells-core", name: "PF1e Spells (Core)", type: "items", stage: "1a" },
  { src: "pf1-system", dir: "packs/feats", out: "feats-core", name: "PF1e Feats (Core)", type: "items", stage: "1a" },
  { src: "pf1-system", dir: "packs/classes", out: "classes-core", name: "PF1e Classes (Core)", type: "actors", stage: "1a" },
  { src: "pf1-system", dir: "packs/races", out: "races", name: "PF1e Races", type: "items", stage: "1a" },
  { src: "pf1-system", dir: "packs/weapons-and-ammo", out: "weapons-ammo", name: "PF1e Weapons & Ammo", type: "items", stage: "1a" },
  { src: "pf1-system", dir: "packs/armors-and-shields", out: "armor-shields", name: "PF1e Armor & Shields", type: "items", stage: "1a" },
  { src: "pf1-system", dir: "packs/items", out: "items-core", name: "PF1e Items (Core)", type: "items", stage: "1a" },
  { src: "pf1-system", dir: "packs/ultimate-equipment", out: "ultimate-equipment", name: "PF1e Ultimate Equipment", type: "rollTables", stage: "1a" },
  { src: "pf1-system", dir: "packs/roll-tables", out: "roll-tables", name: "PF1e Roll Tables (Core)", type: "rollTables", stage: "1a" },
  { src: "pf1-system", dir: "packs/rules", out: "rules-core", name: "PF1e Rules (Core)", type: "journals", stage: "1a" },
  { src: "pf1-system", dir: "packs/technology", out: "technology-core", name: "PF1e Technology (Core)", type: "items", stage: "1a" },
  { src: "pf1-system", dir: "packs/buffs", out: "buffs-core", name: "PF1e Buffs (Core)", type: "items", stage: "1a" },
  { src: "pf1-system", dir: "packs/basic-monsters", out: "basic-npcs", name: "PF1e Basic NPCs", type: "actors", stage: "1a" },
  // ── stage 1b — pf1e-content expanded (JSON) ─────────────────────────────────
  { src: "pf1e-content", dir: "src/packs/pf-feats", out: "feats", name: "PF1e Feats (Expanded)", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-wondrous", out: "wondrous", name: "PF1e Wondrous Items", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-items", out: "items", name: "PF1e Items (Expanded)", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-magic", out: "magic-items", name: "PF1e Magic Items", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-class-abilities", out: "class-abilities", name: "PF1e Class Abilities", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-traits", out: "traits", name: "PF1e Traits", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-racial-traits", out: "racial-traits", name: "PF1e Racial Traits", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-goods-services", out: "goods-services", name: "PF1e Goods & Services", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-special-qualities", out: "special-qualities", name: "PF1e Special Qualities", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-technology", out: "technology", name: "PF1e Technology (Expanded)", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-artifacts", out: "artifacts", name: "PF1e Artifacts", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-buffs", out: "buffs", name: "PF1e Buffs (Expanded)", type: "items", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-rules", out: "rules", name: "PF1e Rules (Reference)", type: "journals", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-companions", out: "companions", name: "PF1e Companions", type: "actors", stage: "1b" },
  { src: "pf1e-content", dir: "src/packs/pf-familiars", out: "familiars", name: "PF1e Familiars", type: "actors", stage: "1b" },
];
