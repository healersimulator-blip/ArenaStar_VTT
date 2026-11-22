import type { Baseline, ModelMarker } from "../../core/strategicRoom/protocol";
import {
  parseHexColor,
  type DrawableUnit,
} from "../../canvas/layers/ModelLayer/units";
import { allocModel, createModelPool } from "../../sim/pool";

/** Dense local ranges are renderer-only, rebuilt from authorized stable IDs. */
export function detailLayer(
  view: Baseline,
  models: ReadonlyMap<string, ModelMarker>,
) {
  const byUnit = new Map<string, ModelMarker[]>();
  for (const model of models.values()) {
    let list = byUnit.get(model.unitId);
    if (!list) byUnit.set(model.unitId, (list = []));
    list.push(model);
  }
  const markers = new Map(view.markers.map((u) => [u.id, u]));
  const ownBadges = new Map(
    view.own.flatMap((u) => (u.badgeUrl ? [[u.id, u.badgeUrl] as const] : [])),
  );
  const colors = new Map(view.factions.map((f) => [f.id, f.color]));
  const pool = createModelPool(models.size);
  const units: DrawableUnit[] = [];
  for (const [id, list] of byUnit) {
    const u = markers.get(id);
    if (!u) continue;
    const start = pool.count;
    for (const model of list)
      allocModel(pool, {
        id: pool.count + 1,
        unitIdx: units.length,
        x: model.x,
        y: model.y,
        rot: model.rotation,
      });
    const badgeUrl = view.unitBadges?.[id] ?? ownBadges.get(id);
    units.push({
      id,
      armyId: u.factionId,
      armyName: u.factionId,
      factionId: u.factionId,
      name: u.name,
      type: "infantry",
      color: parseHexColor(colors.get(u.factionId) ?? ""),
      ...(badgeUrl ? { tokenImg: badgeUrl } : {}),
      modelRange: [start, pool.count],
    });
  }
  return { pool, units };
}
