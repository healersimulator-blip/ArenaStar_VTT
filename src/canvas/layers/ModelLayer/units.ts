/**
 * §9A canvas unit views — DrawableUnit derived from army + faction documents
 * (pure; the client store supplies the docs, the ModelLayer consumes views).
 */
import type { ArmyDocument, FactionDocument } from "../../../core/strategic";

export interface DrawableUnit {
  id: string;
  armyId: string;
  armyName: string;
  factionId: string;
  name: string;
  /** System-defined unit type (§7 atlas entry input). */
  type: string;
  /** Parsed faction color (fallback grey). */
  color: number;
  modelRange: readonly [number, number] | null;
}

/** "#rrggbb" | "#rgb" | number-string → packed 0xrrggbb. */
export function parseHexColor(hex: string, fallback = 0x9aa0a8): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const g = m?.[1];
  if (!g) return fallback;
  const s =
    g.length === 3
      ? g
          .split("")
          .map((c) => c + c)
          .join("")
      : g;
  return parseInt(s, 16);
}

/** DrawableUnit list from store docs; units without a scene range are kept with null. */
export function drawableUnits(
  armies: readonly ArmyDocument[],
  factions: readonly FactionDocument[],
): DrawableUnit[] {
  const colors = new Map<string, number>();
  for (const f of factions) colors.set(f._id, parseHexColor(f.color));
  const out: DrawableUnit[] = [];
  for (const army of armies) {
    for (const unit of army.units) {
      out.push({
        id: unit._id,
        armyId: army._id,
        armyName: army.name,
        factionId: army.factionId,
        name: unit.name,
        type: unit.type,
        color: colors.get(army.factionId) ?? 0x9aa0a8,
        modelRange: unit.modelRange ?? null,
      });
    }
  }
  return out;
}
