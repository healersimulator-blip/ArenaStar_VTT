/**
 * D-271 (plan §5.2) — the canvas context menu **on empty ground** in a hexcrawl scene, as a pure
 * model. The canvas layer (`canvas/interactions/index.ts`) decides *when* a menu opens (a
 * right-click that hit no token); this module decides *what* it shows and *which ops* each entry
 * produces, from the live scene and the viewer's permissions. `App.svelte` only renders the
 * entries — the same split `ui/combat/tokenContextMenu.ts` uses for tokens, and for the same
 * reason: the interesting part (what a GM may do to a hex, and what a player is allowed to see of
 * one) is testable without a browser.
 *
 * Two rules shape the entries:
 *
 * - **Mutating entries are gated by ownership**, not by a `viewer` flag: `can(user, "update",
 *   scene, "scenes")` is exactly "this seat is the GM", so a player's menu is the reduced one by
 *   construction and a future delegated-ownership model needs no change here.
 * - **A closed cell is not a cell a player has**, so a player right-clicking unexplored ground
 *   gets *no entries at all* — the app then shows no menu. Offering "open hex" there would be a
 *   lie twice over: the player has no document for it, and its text is not on their replica.
 *
 * Entries for encounters, exploration, features and travel are present but **disabled with the
 * reason they were waiting** (the token menu's own honesty rule — a disabled entry says why,
 * tooltip and all). Phases 3–5 filled the encounter half in; D-275 fills the last three:
 * *Reveal feature…* opens the window that owns the feature editor, *Move party here* is the party
 * token's position op, and *Add to path* appends to the route the GM is drawing. As before, the
 * ops belong to the shell: this module decides *what* the click means and names the verb, and
 * `App.svelte` submits what that verb needs (a cell centre, a path append, a window).
 */
import type { CellDocument, SceneDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import type { Op } from "../../core/ops";
import { can } from "../../core/permissions";
import { cellByKey, cellCenterOf } from "../../core/hexcrawl/cells";
import {
  createCellOps,
  revealCellsOps,
  updateCellOps,
} from "../../core/hexcrawl/scene";
import type { TerrainCatalog } from "../../core/hexcrawl/terrain";
import { partyPositionOps } from "../../core/hexcrawl/travel";
import { hexcrawlProfileOf } from "../../core/hexcrawl/types";
import { isCellOpen, partyCellKey } from "../../core/hexcrawl/visibility";

export type HexMenuEntryId =
  | "open"
  | "reveal"
  | "hide"
  | "attach"
  | "roll"
  | "explore"
  | "feature"
  | "move-party"
  | "add-path"
  | "terrain"
  | "party";

export interface HexMenuEntry {
  /** `terrain:<id>` for a terrain row, otherwise the entry id. */
  id: string;
  label: string;
  disabled: boolean;
  /** Disabled entries explain themselves — never a silent dead row. */
  reason: string | null;
  /** A row that reports state instead of acting (rendered as text, not a button). */
  statik?: boolean;
  /** Terrain rows: the id to write when clicked. */
  terrainId?: string;
  /** Terrain rows: this is the cell's current terrain. */
  checked?: boolean;
}

export interface HexMenuModel {
  title: string;
  subtitle: string | null;
  entries: HexMenuEntry[];
}

/** The `terrain:<id>` id form — one place, so the app never re-parses a label. */
export function terrainEntryId(terrainId: string): string {
  return `terrain:${terrainId}`;
}

export function terrainIdOfEntry(entryId: string): string | null {
  return entryId.startsWith("terrain:")
    ? entryId.slice("terrain:".length)
    : null;
}

/**
 * What right-clicking `key` offers `user`. `key` is the cell under the pointer, from
 * `cellAtPoint` — so on a gridless map it is an authored zone's id and `null` outside every zone
 * (the app then has no menu to show, because there is no cell to act on).
 */
export function hexContextMenuModel(input: {
  scene: SceneDocument;
  key: string;
  user: PermissionUser | null;
  catalog: TerrainCatalog;
}): HexMenuModel {
  const { scene, key, user, catalog } = input;
  const cell = cellByKey(scene, key);
  const open = isCellOpen(scene, key);
  const isGM = user !== null && can(user, "update", scene, "scenes");
  const title = cell?.name && cell.name !== "" ? cell.name : key;
  const subtitle = `${open ? "open" : "closed"}${
    cell?.terrain ? ` · ${terrainNameOf(catalog, cell.terrain)}` : ""
  }`;

  if (!isGM) {
    // A player's menu: the text the GM published, and where the party stands. Nothing else is
    // theirs to do — and on ground they have not been shown, nothing at all.
    if (!open) return { title: "Unexplored", subtitle: null, entries: [] };
    const entries: HexMenuEntry[] = [
      {
        id: "open",
        label: "Open hex description",
        disabled: false,
        reason: null,
      },
    ];
    if (partyCellKey(scene) === key) {
      entries.push({
        id: "party",
        label: "the party is here",
        disabled: true,
        reason: null,
        statik: true,
      });
    }
    return { title, subtitle, entries };
  }

  const entries: HexMenuEntry[] = [
    {
      id: "open",
      label: "Open hex description",
      disabled: false,
      reason: null,
    },
    open
      ? {
          id: "hide",
          label: "Close hex (hide from players)",
          disabled: false,
          reason: null,
        }
      : {
          id: "reveal",
          label: "Open hex (reveal to players)",
          disabled: false,
          reason: null,
        },
  ];

  // Terrain is the one §5.2 submenu Phase 2 can honour in full: the catalog is world data and a
  // cell's terrain is one field. A gridless map can only tint a cell that has geometry, so the
  // rows are disabled where no zone has been authored.
  const terrainLess = scene.grid?.type === "gridless" && !cell?.poly;
  const current = cell?.terrain ?? null;
  for (const terrain of catalog.terrains) {
    entries.push({
      id: terrainEntryId(terrain.id),
      label: terrain.name,
      disabled: terrainLess,
      reason: terrainLess
        ? "no zone authored here — a gridless cell needs its own shape"
        : null,
      terrainId: terrain.id,
      checked: current === terrain.id,
    });
  }

  entries.push(
    {
      id: "attach",
      label: "Attach encounter table…",
      // Enabled: the tables window does the attaching (D-272). A GM who has authored no table
      // yet still wants the door — the window's *New table…* is the first step of that path.
      disabled: false,
      reason: null,
    },
    // D-273: rolling by hand is the hex window's job (plan §6 rule 6 — `manual` mode's rows are
    // the trigger), so the entry opens the hex instead of duplicating the roll here. One place
    // decides what "roll this hex's table" means, and it is the window.
    {
      id: "roll",
      label: "Roll from a table…",
      disabled: false,
      reason: null,
    },
    // D-273: *explore* spends real time on the clock and then asks the `exploring` trigger; the
    // ops belong to the shell (the clock envelope), so this entry only says "yes, explore".
    {
      id: "explore",
      label: "Explore this hex",
      disabled: false,
      reason: null,
    },
    // D-275 — the last three entries, live: the feature editor is the hex window, the party's
    // position is one op, and the route is the path mode's own draft.
    {
      id: "feature",
      label: cell && (cell.features ?? []).length > 0
        ? "Features of this hex…"
        : "Reveal feature…",
      disabled: false,
      reason: null,
    },
    {
      id: "move-party",
      label: "Move party here",
      // A scene with no party token cannot be marched: the profile names the token, and the
      // shell refuses the click with a reason rather than moving nothing.
      disabled: partyTokenIdOf(scene) === null,
      reason:
        partyTokenIdOf(scene) === null
          ? "this scene has no party token yet"
          : null,
    },
    {
      id: "add-path",
      label: "Add to path",
      disabled: false,
      reason: null,
    },
  );
  return { title, subtitle, entries };
}

/** The party token the profile names, when it still exists (null = this scene cannot be marched). */
function partyTokenIdOf(scene: SceneDocument): string | null {
  const id = hexcrawlProfileOf(scene)?.partyTokenId ?? null;
  if (!id) return null;
  return (scene.tokens ?? []).some((t) => t._id === id) ? id : null;
}

function terrainNameOf(catalog: TerrainCatalog, id: string): string {
  return catalog.terrains.find((t) => t.id === id)?.name ?? id;
}

/**
 * What the travel entries mean to the shell (D-275):
 * - `addPath` — append `key` to the route being drawn (path mode's own model decides the rest);
 * - `moveParty` — put the party token on this cell's centre, now;
 * - `feature` — open the hex window, which is where features are authored and revealed.
 */
export interface HexMenuResult {
  /** Ops to submit, in order (empty for entries that only open a window). */
  ops: Op[];
  /** `open` — show the hex window for `key`. */
  openWindow: boolean;
  /** `attach` — open the encounter-tables window for this hex (D-272). */
  openTables: boolean;
  /** `explore` — spend the exploration time and ask the `exploring` trigger (D-273). */
  explore: boolean;
  /** `add-path` — append this hex to the travel route being drawn (D-275). */
  addPath: boolean;
  /** `move-party` — put the party token on this cell's centre (D-275). */
  moveParty: boolean;
  /** `feature` — open the hex window, where the feature editor lives (D-275). */
  feature: boolean;
  error: string | null;
  /** One line for the log/toast, so the GM sees what the click did. */
  note: string | null;
  /** The terrain id to paint optimistically, when this was a terrain click. */
  terrainId: string | null;
}

const NOTHING: HexMenuResult = {
  ops: [],
  openWindow: false,
  openTables: false,
  explore: false,
  addPath: false,
  moveParty: false,
  feature: false,
  error: null,
  note: null,
  terrainId: null,
};

/**
 * The ops one entry produces. `nextId` is the caller's id source (a cell create needs a
 * world-unique doc id) — kept out of the model so the tests can pin the id.
 */
export function applyHexMenuEntry(input: {
  scene: SceneDocument;
  key: string;
  entryId: string;
  user: PermissionUser | null;
  nextId: () => string;
}): HexMenuResult {
  const { scene, key, entryId, user, nextId } = input;
  const isGM = user !== null && can(user, "update", scene, "scenes");

  if (entryId === "open") {
    return { ...NOTHING, openWindow: true };
  }
  if (!isGM) return { ...NOTHING, error: "not your hex to change" };

  if (entryId === "attach") {
    return { ...NOTHING, openTables: true };
  }

  if (entryId === "roll") {
    // The window's rows roll; the window is where the hex's tables are listed (and where a
    // `manual` scene is meant to be played from).
    return {
      ...NOTHING,
      openWindow: true,
      note: `${key} — roll from the tables in this window`,
    };
  }
  if (entryId === "explore") {
    return { ...NOTHING, explore: true, note: `${key} — exploring it now` };
  }
  if (entryId === "feature") {
    // The features of a hex are authored and revealed in the hex window (its own section), so this
    // entry is a shortcut to the place that already owns the writes — no second editor.
    return {
      ...NOTHING,
      openWindow: true,
      feature: true,
      note: `${key} — hidden features are in this window`,
    };
  }
  if (entryId === "add-path") {
    return { ...NOTHING, addPath: true, note: `${key} — added to the route` };
  }
  if (entryId === "move-party") {
    const tokenId = partyTokenIdOf(scene);
    if (tokenId === null) {
      return { ...NOTHING, error: "this scene has no party token yet" };
    }
    const centre = cellCenterOf(scene, key);
    if (!centre) {
      return { ...NOTHING, error: `${key} has no place on the map yet` };
    }
    // Deliberately *not* through the travel engine: this is the GM lifting the party token and
    // putting it down somewhere else, and the encounter engine sees it exactly like a drag.
    return {
      ...NOTHING,
      moveParty: true,
      ops: partyPositionOps(scene, tokenId, centre),
      note: `the party moves to ${key}`,
    };
  }

  if (entryId === "reveal") {
    return {
      ...NOTHING,
      ops: revealCellsOps(scene, [key]),
      note: `${key} is open to the table`,
    };
  }
  if (entryId === "hide") {
    return {
      ...NOTHING,
      ops: revealCellsOps(scene, [], [key]),
      note: `${key} is closed again`,
    };
  }

  const terrainId = terrainIdOfEntry(entryId);
  if (terrainId !== null) {
    const cell: CellDocument | null = cellByKey(scene, key);
    if (cell) {
      // An update is a no-op when the value is already there — do not spend a sequence number.
      if (cell.terrain === terrainId) return NOTHING;
      return {
        ...NOTHING,
        ops: updateCellOps(scene, key, { terrain: terrainId }),
        note: `${key} is ${terrainId}`,
        terrainId,
      };
    }
    if (scene.grid?.type === "gridless") {
      return {
        ...NOTHING,
        error: "a gridless cell needs an authored zone first",
      };
    }
    return {
      ...NOTHING,
      ops: createCellOps(scene, nextId(), { key, terrain: terrainId }),
      note: `${key} is ${terrainId}`,
      terrainId,
    };
  }

  return { ...NOTHING, error: `unknown hex menu entry: ${entryId}` };
}
