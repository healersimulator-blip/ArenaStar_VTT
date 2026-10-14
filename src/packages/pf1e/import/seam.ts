/**
 * D-474 (T1) — the character importers as the system package presents them.
 *
 * Everything in `./index` stays the readers' own API (the unit tests drive it directly); this
 * file is the one object the `RulesModule.characterImport` seam hands to a shell: the paste
 * example, the accepted file types, and `read`, which is `importCharacter` → playability check →
 * report → create ops in one call. The shells (Actors tab, agent bridge) import nothing from
 * `packages/pf1e/import` any more — they get this through the live module, which in a PF1e world
 * is the package's own `rules.js` (D-471 on the host, D-472/D-473 on players).
 */
import type { RulesCharacterImport } from "../../../core/rules";
import { okVal } from "../../../core/result";
import {
  characterImportOps,
  characterImportReport,
  formatLabel,
  importCharacter,
} from "./index";

/** What the paste box shows before anything is typed: the head of a real SRD block. */
export const PF1E_PASTE_EXAMPLE = [
  "Goblin Warrior CR 1/3",
  "NE Small humanoid (goblinoid)",
  "Init +6; Senses darkvision 60 ft.; Perception -1",
  "",
  "DEFENSE",
  "",
  "AC 16, touch 13, flat-footed 14 (+2 armor, +2 Dex, +1 shield, +1 size)",
  "hp 6 (1d10+1)",
  "Fort +3, Ref +4, Will -1",
  "",
  "OFFENSE",
  "",
  "Speed 30 ft.",
  "Melee short sword +2 (1d4/19-20)",
  "Ranged short bow +4 (1d4/\u00d73)",
  "",
  "STATISTICS",
  "",
  "Str 11, Dex 15, Con 12, Int 10, Wis 9, Cha 6",
  "Base Atk +1; CMB +1; CMD 12",
  "Feats Improved Initiative",
  "Languages Goblin",
].join("\n");

export const pf1eCharacterImport: RulesCharacterImport = {
  pasteExample: PF1E_PASTE_EXAMPLE,
  fileAccept: ".json,.xml,.txt",
  fileFormats: "Foundry PF1e actor JSON, Hero Lab XML, or a Roll20 sheet export",
  pasteFormats: "Paste a Pathfinder 1e monster stat block as text",
  read({ text, fileName, id, ownerId }) {
    const parsed = importCharacter(text, fileName === undefined ? {} : { fileName });
    if (!parsed.ok) return parsed;
    const report = characterImportReport(parsed.value);
    return okVal({
      name: report.name,
      format: formatLabel(report.format),
      read: report.read,
      warnings: report.warnings,
      ops: characterImportOps(parsed.value, { id, ...(ownerId === undefined ? {} : { gmId: ownerId }) }),
    });
  },
};
