/**
 * D-408 (S3) — persisted PF1e spell areas: the durable half of an area cast.
 *
 * A cast card carries the area its rows resolved in (`ActionArea`), but a card is history: it
 * cannot answer "is this token inside the entangle *now*", "what squares are difficult terrain?"
 * or "has the duration run out?". Those answers live here, as one validated record per live
 * area under `scene.flags.pf1e.spellAreas`, written by the host only (derived post-commit from
 * the cast card it names) and expired by the host's world-clock sweep.
 *
 * Authority boundary (ACTION_SYSTEM.md §1):
 *
 * - The record's every fact is host-derived: the effect from the versioned catalogue, the DC
 *   from a host-verified row check, the origin/radius from the card's area after the host
 *   re-resolves it against the live scene, the duration from the catalogue × the caster's
 *   derived caster level. A client can propose a cast; it can never author an area.
 * - The id is deterministic (`spellarea-<cardId>`), so re-derivation is idempotent and a card
 *   owns at most one area.
 * - Only radius spreads ship today (Entangle is the only catalogue row with an area). A row
 *   without `area`/`duration` persists nothing — the cast still resolves its rows; there is
 *   simply no durable area to stand in afterward.
 * - Reads are defensive (`spellAreasFromFlags` never throws, never invents): a malformed entry
 *   reads as absent, exactly like the SR-ledger flags blob.
 */
import type { Json } from "../../core/documents";
import { err, okVal, type Result } from "../../core/result";
import { pf1eAreaGridFromScene, resolveAreaCells, type PF1eAreaGrid, type PF1eCell } from "./targeting";
import type { Segment } from "../../canvas/vision/polygon";

/** A scene holds at most this many live spell areas; the host names the refusal past it. */
export const MAX_PF1E_SPELL_AREAS_PER_SCENE = 32;

/** Persisted under `scene.flags.pf1e.spellAreas[areaId]`. */
export interface PF1eSpellArea {
  /** Deterministic: `spellarea-<cast card message id>`. */
  id: string;
  /** Catalogue id (`entangle`); the catalogue row pins duration/area/range. */
  effectId: string;
  /** The cast card message this area was derived from. */
  actionId: string;
  sceneId: string;
  casterActorId: string;
  /** Spell save DC, taken from a host-verified row check at derivation. */
  dc: number;
  /** Derived caster level at derivation (pins the duration and range that were checked). */
  casterLevel: number;
  /** Spell level the rows verified at. */
  spellLevel: number;
  /** Area origin in world units (a grid intersection for spreads). */
  origin: { x: number; y: number };
  radiusFt: number;
  /** World-clock milliseconds the area came into effect / winks out. */
  startsAt: number;
  endsAt: number;
  difficultTerrain: boolean;
}

const AREA_KEYS = ["id", "effectId", "actionId", "sceneId", "casterActorId", "dc", "casterLevel",
  "spellLevel", "origin", "radiusFt", "startsAt", "endsAt", "difficultTerrain"] as const;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Validate one persisted area; closed shape, refused by name. */
export function validatePF1eSpellArea(raw: unknown): Result<PF1eSpellArea> {
  if (!isRecord(raw)) return err("a spell area must be an object");
  const stray = Object.keys(raw).filter((key) => !(AREA_KEYS as readonly string[]).includes(key));
  if (stray.length > 0) return err(`a spell area carries no ${stray.join("/")} field`);
  for (const key of ["id", "effectId", "actionId", "sceneId", "casterActorId"] as const) {
    if (typeof raw[key] !== "string" || !ID_RE.test(raw[key] as string))
      return err(`a spell area needs ${key} of 1–128 letters, digits, "_" or "-"`);
  }
  if (!isWhole(raw.dc, 1, 99)) return err("a spell area dc must be a whole number from 1 to 99");
  if (!isWhole(raw.casterLevel, 1, 100)) return err("a spell area casterLevel must be 1–100");
  if (!isWhole(raw.spellLevel, 0, 9)) return err("a spell area spellLevel must be 0–9");
  if (!isRecord(raw.origin) || Object.keys(raw.origin).some((key) => key !== "x" && key !== "y") ||
      typeof raw.origin.x !== "number" || !Number.isFinite(raw.origin.x) ||
      typeof raw.origin.y !== "number" || !Number.isFinite(raw.origin.y))
    return err("a spell area origin must be a finite { x, y } point");
  if (!isWhole(raw.radiusFt, 5, 500)) return err("a spell area radiusFt must be 5–500");
  if (typeof raw.startsAt !== "number" || !Number.isFinite(raw.startsAt) || raw.startsAt < 0 ||
      typeof raw.endsAt !== "number" || !Number.isFinite(raw.endsAt) || raw.endsAt <= raw.startsAt)
    return err("a spell area needs 0 ≤ startsAt < endsAt in world-clock milliseconds");
  if (typeof raw.difficultTerrain !== "boolean")
    return err("a spell area difficultTerrain must be a boolean");
  return okVal({
    id: raw.id as string,
    effectId: raw.effectId as string,
    actionId: raw.actionId as string,
    sceneId: raw.sceneId as string,
    casterActorId: raw.casterActorId as string,
    dc: raw.dc as number,
    casterLevel: raw.casterLevel as number,
    spellLevel: raw.spellLevel as number,
    origin: { x: raw.origin.x as number, y: raw.origin.y as number },
    radiusFt: raw.radiusFt as number,
    startsAt: raw.startsAt as number,
    endsAt: raw.endsAt as number,
    difficultTerrain: raw.difficultTerrain,
  });
}

/**
 * Defensive flags reader: anything that is not a record of valid areas reads as empty. A
 * malformed entry is skipped, never thrown — the host derivation is the only writer, so a bad
 * entry is a historical artifact, not a live fact.
 */
export function spellAreasFromFlags(flags: unknown): Record<string, PF1eSpellArea> {
  if (!isRecord(flags)) return {};
  const pf1e = flags.pf1e;
  if (!isRecord(pf1e) || !isRecord(pf1e.spellAreas)) return {};
  const out: Record<string, PF1eSpellArea> = {};
  for (const [key, raw] of Object.entries(pf1e.spellAreas)) {
    const checked = validatePF1eSpellArea(raw);
    if (!checked.ok || checked.value.id !== key) continue;
    out[key] = checked.value;
  }
  return out;
}

/** Live areas at `nowMs` (world clock): started and not yet ended. */
export function livePF1eSpellAreas(
  areas: Record<string, PF1eSpellArea>,
  nowMs: number,
): PF1eSpellArea[] {
  return Object.values(areas).filter((area) => area.startsAt <= nowMs && nowMs < area.endsAt);
}

/** Ids whose duration has run out at `nowMs` — the sweep deletes exactly these. */
export function expiredPF1eSpellAreaIds(
  areas: Record<string, PF1eSpellArea>,
  nowMs: number,
): string[] {
  return Object.values(areas).filter((area) => nowMs >= area.endsAt).map((area) => area.id);
}

/**
 * Difficult-terrain cells contributed by live spell areas: each live difficult area re-resolves
 * its spread against the scene grid (walls arrive as caller-supplied segments, the same seam the
 * area preview uses). Pure and total: an unreadable grid yields no cells, never an exception.
 * The movement planner unions these with the scene's authored `difficultCells`.
 */
export function difficultCellsFromSpellAreas(
  areas: Record<string, PF1eSpellArea>,
  input: {
    grid: { size: number; distance: number; units: string };
    nowMs: number;
    segments?: readonly Segment[];
  },
): PF1eCell[] {
  const { grid, issues } = pf1eAreaGridFromScene(input.grid);
  if (issues.length > 0) return [];
  const live = livePF1eSpellAreas(areas, input.nowMs).filter((area) => area.difficultTerrain);
  if (live.length === 0) return [];
  const cells: PF1eCell[] = [];
  const seen = new Set<string>();
  const areaGrid: PF1eAreaGrid = grid;
  for (const area of live) {
    const col = area.origin.x / areaGrid.cellSize;
    const row = area.origin.y / areaGrid.cellSize;
    if (!Number.isInteger(col) || !Number.isInteger(row)) continue;
    const resolved = resolveAreaCells(
      { kind: "spread", origin: { col, row }, radiusFt: area.radiusFt },
      areaGrid,
      { ...(input.segments ? { segments: [...input.segments] } : {}) },
    );
    if (resolved.issues.length > 0) continue;
    for (const cell of resolved.cells) {
      const key = `${String(cell.col)},${String(cell.row)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push(cell);
    }
  }
  return cells;
}

/**
 * Whole-record write for one added area (FlatDiff cannot create missing intermediates, so the
 * host writes the record, creating `flags.pf1e` when the scene has none). Returns the diff to
 * commit, or a named refusal when the scene is full.
 */
export function spellAreaAddDiff(
  flags: unknown,
  area: PF1eSpellArea,
): Result<Record<string, Json>> {
  const current = spellAreasFromFlags(flags);
  if (!Object.hasOwn(current, area.id) &&
      Object.keys(current).length >= MAX_PF1E_SPELL_AREAS_PER_SCENE)
    return err(`that scene already holds ${String(MAX_PF1E_SPELL_AREAS_PER_SCENE)} live spell areas`);
  const next = { ...current, [area.id]: area };
  if (!isRecord(flags) || !isRecord((flags as Record<string, unknown>).pf1e)) {
    return okVal({ "flags.pf1e": { spellAreas: next } as unknown as Json });
  }
  return okVal({ "flags.pf1e.spellAreas": next as unknown as Json });
}

/** Whole-record write removing expired ids; null when nothing would change. */
export function spellAreaRemoveDiff(
  flags: unknown,
  ids: readonly string[],
): Record<string, Json> | null {
  const current = spellAreasFromFlags(flags);
  const remove = new Set(ids.filter((id) => Object.hasOwn(current, id)));
  if (remove.size === 0) return null;
  const next = Object.fromEntries(Object.entries(current).filter(([id]) => !remove.has(id)));
  return { "flags.pf1e.spellAreas": next as unknown as Json };
}
