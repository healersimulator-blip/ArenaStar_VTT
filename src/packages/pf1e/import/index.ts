/**
 * §3.1 (G-39) — the character-import front door: sniff the format, read it, hand the caller a
 * document it can create.
 *
 * The readers behind this module each produce the same `ImportedCharacter`, and everything after
 * that point is shared: the actor document, its embedded items, its authored attack lines and the
 * report the importing GM reads. Four today — Foundry actor JSON, Hero Lab XML and Roll20 sheet
 * exports for §3.1, and (G-08, §3.2) a monster stat block pasted as text, which carries no file
 * name and no schema and is therefore the one path where the sniffer reads labels rather than
 * structure. Two consequences worth stating, because they are the point of the shape:
 *
 * - **One place decides the actor's ownership.** An imported character belongs to the GM until the
 *   GM says otherwise (the same default a hand-made actor gets, `ownership: {default: 0, gm: 3}`),
 *   and the caller passes the GM's user id. A character imported by a player — which the UI does
 *   not offer today — would still land authored the same way; the difference is a permissions
 *   question, not an import question.
 * - **The report is data, not prose.** `characterImportReport` returns the counts and the lines, so
 *   the UI renders them and the e2e reads them back, and neither has to re-derive what happened.
 */
import type { Op } from "../../../core/ops";
import type { Result } from "../../../core/result";
import { err, okVal } from "../../../core/result";
import { parsePF1eActorSystem } from "../actor";
import type { ActorDocument, ItemDocument } from "../../../core/documents";
import { importFoundryCharacter, looksLikeFoundryActor } from "./foundry";
import { importHeroLabCharacter, looksLikeHeroLabXml } from "./herolab";
import { importRoll20Character, looksLikeRoll20Export } from "./roll20";
import { importStatblock, looksLikeStatblock } from "./statblock";
import type {
  CharacterImportFormat,
  ImportedCharacter,
  ImportedItem,
} from "./types";

export { importFoundryCharacter, looksLikeFoundryActor } from "./foundry";
export {
  importHeroLabCharacter,
  looksLikeHeroLabXml,
  parseXml,
} from "./herolab";
export { importRoll20Character, looksLikeRoll20Export } from "./roll20";
export { importStatblock, looksLikeStatblock } from "./statblock";
export { parseDamage, sizeRollToDice } from "./dice";
export type {
  CharacterImportFormat,
  ImportedCharacter,
  ImportedItem,
} from "./types";

/** An id for the actor a character becomes, in this app's own id shape. */
export const characterImportActorId = (uuid: string): string =>
  `a-${uuid.slice(0, 8)}`;

/**
 * Which exporter wrote this text. Structure decides — a `.json` extension means nothing (all three
 * can be JSON) and Hero Lab's XML is the only one that is not — with the file name used only to
 * explain a failure ("a `.por` is a zip"). `null` means "not something we can read", which the
 * caller turns into a named error rather than a guess.
 */
export function detectCharacterFormat(
  text: string,
  fileName?: string,
): CharacterImportFormat | null {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return null;
  if (trimmed.startsWith("<"))
    return looksLikeHeroLabXml(trimmed) ? "herolab" : null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    void fileName;
    return null;
  }
  if (looksLikeRoll20Export(raw)) return "roll20";
  if (looksLikeFoundryActor(raw)) return "foundry";
  // A Roll20 export without an `attribs` array still names its character and its sheet fields.
  if (typeof raw === "object" && raw !== null && "attribs" in raw)
    return "roll20";
  return null;
}

/**
 * Everything `detectCharacterFormat` knows **plus** the one source that is not a document at all:
 * a monster stat block pasted as prose (G-08). It is kept separate because the file-import path
 * wants the document formats only, while the paste path wants exactly this.
 */
export function detectPastedFormat(text: string): CharacterImportFormat | null {
  const detected = detectCharacterFormat(text);
  if (detected !== null) return detected;
  return looksLikeStatblock(text) ? "statblock" : null;
}

/**
 * Read one export into the app's own shape. `fileName` is only used in the error message: whoever
 * hands us a broken file deserves to be told what kind of file it was supposed to be.
 */
export function importCharacter(
  text: string,
  options: { fileName?: string } = {},
): Result<ImportedCharacter> {
  const fileName = options.fileName ?? "";
  const lower = fileName.toLowerCase();
  if (looksLikeHeroLabXml(text)) return played(importHeroLabCharacter(text));
  const format = detectCharacterFormat(text, fileName);
  if (format === "roll20" || format === "foundry" || format === "herolab") {
    if (format === "herolab") return played(importHeroLabCharacter(text));
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return err(
        `that file is not valid JSON (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
    return played(
      format === "roll20"
        ? importRoll20Character(raw)
        : importFoundryCharacter(raw),
    );
  }
  if (lower.endsWith(".por")) {
    return err(
      "a .por file is a zip archive: open it in Hero Lab and use File ▸ Save Custom Output ▸ Generate XML File, or export the character as JSON from Foundry/Roll20",
    );
  }
  if (lower.endsWith(".xml")) {
    return err(
      "that XML has no <character> element — export the character with Hero Lab's XML output",
    );
  }
  // G-08: not a document at all — a stat block pasted as text.
  if (looksLikeStatblock(text)) return played(importStatblock(text));
  if (looksLikeStatblock(text.replace(/^[^\n]*\n/, "")))
    return err(
      "that text looks like a stat block without its first line — a stat block starts with the creature's name and its CR (`Goblin Warrior CR 1/3`); paste it from the top",
    );
  return err(
    "unrecognised file: expected a Foundry PF1e actor JSON, a Hero Lab XML export, a Roll20 character sheet JSON, or a pasted Pathfinder 1e monster stat block",
  );
}

/**
 * Refuse a read this app cannot play.
 *
 * A reader can be tolerant — that is what makes it survive three exporters whose fields have moved
 * between versions — but tolerance has a floor: the actor block it produces must be one
 * `parsePF1eActorSystem` accepts. Without this gate an unsupported value (a size the rules do not
 * know, an ability score the sheet cannot read) would still create an actor, and the *derivation*
 * would quietly fall back to its defaults: a character that opens as a blank 10-in-everything
 * sheet. That is worse than a refusal, because the numbers look plausible. So the failure is named
 * here, at the moment the file is read, and nothing is created.
 */
export function characterImportCheck(
  character: ImportedCharacter,
): Result<ImportedCharacter> {
  const parsed = parsePF1eActorSystem(character.system);
  if (!parsed.ok) {
    return err(
      `this app cannot play the character this export describes: ${parsed.error}. Nothing was imported — the fields it states need checking in the app that wrote the file`,
    );
  }
  return okVal(character);
}

function played(result: Result<ImportedCharacter>): Result<ImportedCharacter> {
  return result.ok ? characterImportCheck(result.value) : result;
}

/** The actor document an imported character becomes, with its items embedded. */
export function characterImportActorDoc(
  character: ImportedCharacter,
  options: { id: string; gmId?: string },
): ActorDocument {
  const items: ItemDocument[] = character.items.map(
    (item: ImportedItem, index) => ({
      _id: `${options.id}-i${index + 1}`,
      type: "item",
      name: item.name,
      ownership: {
        default: 0,
        ...(options.gmId !== undefined ? { [options.gmId]: 3 } : {}),
      },
      flags: {},
      system: item.system as unknown as ItemDocument["system"],
      effects: [],
    }),
  );
  return {
    _id: options.id,
    type: "actor",
    name: character.name,
    ownership: {
      default: 0,
      ...(options.gmId !== undefined ? { [options.gmId]: 3 } : {}),
    },
    flags: { core: { importedFrom: character.format } },
    system: { pf1e: character.system } as unknown as ActorDocument["system"],
    items,
    effects: [],
  };
}

/** The one create op an import submits — the whole character, items included, in one document. */
export function characterImportOps(
  character: ImportedCharacter,
  options: { id: string; gmId?: string },
): Op[] {
  return [
    {
      kind: "create",
      coll: "actors",
      data: characterImportActorDoc(character, options),
    },
  ];
}

export interface CharacterImportReport {
  format: CharacterImportFormat;
  name: string;
  /** Every fact that came across, in the source's own terms. */
  read: string[];
  /** Everything the source stated that this app does not place. */
  warnings: string[];
  counts: { items: number; weapons: number; attackLines: number };
}

/** What the UI shows and the e2e reads: the same data the ops were built from. */
export function characterImportReport(
  character: ImportedCharacter,
): CharacterImportReport {
  const weapons = character.items.filter(
    (item) =>
      typeof item.system.weapon === "object" && item.system.weapon !== null,
  ).length;
  const attacks = Array.isArray(character.system.attacks)
    ? character.system.attacks.length
    : 0;
  return {
    format: character.format,
    name: character.name,
    read: [...character.read],
    warnings: [...character.warnings],
    counts: { items: character.items.length, weapons, attackLines: attacks },
  };
}

/** The format's display name, for the report's first line. */
export function formatLabel(format: CharacterImportFormat): string {
  return format === "foundry"
    ? "Foundry PF1e actor"
    : format === "herolab"
      ? "Hero Lab XML"
      : format === "statblock"
        ? "stat block"
        : "Roll20 sheet";
}

/** A `Result`-shaped parse for callers that only want the report (the UI's happy path). */
export function importCharacterReport(
  text: string,
  options: { fileName?: string } = {},
): Result<CharacterImportReport & { character: ImportedCharacter }> {
  const parsed = importCharacter(text, options);
  if (!parsed.ok) return parsed;
  return okVal({
    ...characterImportReport(parsed.value),
    character: parsed.value,
  });
}
