import { createHmac } from "node:crypto";
import type { ActionCard } from "../../../src/core/action";
import {
  DetectionGrid,
  firstMoveBlock,
  hasLineOfEffect,
  type DetectionSource,
} from "../../../src/core/detection";
import { can } from "../../../src/core/permissions";
import { ModelStatus, type Order } from "../../../src/core/strategic";
import { simPositionFits } from "../../../src/core/sim";
import {
  pointInSpellHazard,
  spellHazardActive,
  type SpellHazard,
} from "../../../src/core/strategicRoom/hazardAvoidance";
import {
  MAX_REGION_MODELS,
  REGION_SIZE,
  STRATEGIC_CODEC,
  STRATEGIC_SPELL_CATALOG,
  type Baseline,
  type HostedChatEntry,
  type HostedLight,
  type HostedTemplate,
  type ModelMarker,
  type OwnUnit,
  type Point,
  type RoomOrder,
  type StrategicModelStats,
  type StrategicSpellId,
  type UnitEdit,
  type UnitMarker,
  type UnitModelStatsSummary,
} from "../../../src/core/strategicRoom/protocol";
import { planUnitModelMoves } from "../../../src/packages/pf1e/formationMovement";
import { applyUnitConditionsToStride } from "../../../src/packages/pf1e/stride";
import { createMassBattlePf1e } from "../../../src/packages/massBattlePf1e";
import { deriveRoomKey } from "./invite";
import {
  CELL_FEET,
  effectiveWallsFor,
  inBounds,
  initialUnitResources,
  rulesInput,
  unitElevationAt,
  type Scenario,
  type ScenarioUnit,
} from "./scenario";
import {
  checkpointPool,
  type Control,
  type LiveRoomState,
  type Member,
  type Published,
} from "./state";
import { packMarkerChanges, packMarkers } from "./viewEncoding";

const rules = createMassBattlePf1e();
const MOVE_BLOCK_EPSILON = 0.001;
type BattleInput = ReturnType<typeof rulesInput>;
type UnitSlot = {
  index: number;
  view: BattleInput["units"][number];
  army: BattleInput["armies"][number];
  doc: BattleInput["armies"][number]["units"][number];
  own: OwnUnit;
  authored?: ScenarioUnit;
  badge?: string;
};
type Cohort = {
  markers: UnitMarker[];
  packedMarkers: Buffer;
  changes: Buffer | undefined;
  visible: Set<string>;
  regions: Map<string, ModelMarker[]>;
};

function toRulesOrderForValidation(order: RoomOrder): Order {
  switch (order.kind) {
    case "hold":
      return { kind: "hold", stance: order.stance };
    case "reform":
      return { kind: "custom", type: "reform", data: null };
    case "move":
      return {
        kind: "move",
        path: order.path,
        pace: order.pace,
        ...(order.reform ? { reform: true } : {}),
      };
    case "attack":
      return {
        kind: "attack",
        targetUnitId: order.targetUnitId,
        mode: order.mode,
        ...(order.envelop ? { envelop: true } : {}),
      };
    case "cast":
    case "useItem":
    case "ready":
      return { kind: "hold", stance: "hold" };
  }
}

function pointToSegmentDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Whole-room work is once per publication, never on the order path. */
export class BattleView {
  private readonly input: BattleInput;
  private readonly pool;
  private readonly grid: DetectionGrid;
  private readonly units = new Map<string, UnitSlot>();
  private readonly owners = new Map<string, OwnUnit[]>();
  /** Effective unit allowlist per commander, frozen with the publication it belongs to. */
  private readonly control = new Map<string, Set<string>>();
  /** A missing control entry means the seat's own deployment (unrestricted). */
  private readonly defaultControl = new Map<string, Set<string>>();
  private readonly cohorts = new Map<string | null, Cohort>();
  /** Precomputed difficult-terrain + active-hazard cell set for move validation (once per publication). */
  private readonly moveDifficultCells: ReadonlySet<string>;
  /** Precomputed active hazards for the upcoming turn (once per publication). */
  private readonly nextTurnHazards: readonly SpellHazard[];
  /** Cached HMAC marker IDs keyed by immutable `pool.id[i]` so consecutive publications reuse digests. */
  private readonly markerIdByPoolId: Map<number, string>;
  live: LiveRoomState;

  constructor(
    readonly scenario: Scenario,
    readonly state: Published,
    projectionKey: Uint8Array,
    previous?: BattleView,
    live: LiveRoomState = {},
  ) {
    this.live = live;
    this.markerIdByPoolId = previous
      ? new Map(previous.markerIdByPoolId)
      : new Map();
    this.pool = checkpointPool(state);
    const liveUnitPositions = new Map<string, Point | null>();
    const allAuthoredUnits = scenario.commanders.flatMap((c) => c.units);
    allAuthoredUnits.forEach((u, idx) => {
      const r = state.units[idx]?.range;
      if (!r) {
        liveUnitPositions.set(u.id, null);
        return;
      }
      let sx = 0,
        sy = 0,
        n = 0;
      for (let i = r[0]; i < r[1] && i < this.pool.count; i++) {
        if (((this.pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
        sx += this.pool.x[i] ?? 0;
        sy += this.pool.y[i] ?? 0;
        n++;
      }
      liveUnitPositions.set(u.id, n > 0 ? { x: sx / n, y: sy / n } : null);
    });
    this.input = rulesInput(scenario, state.units, {
      live,
      ...(state.extras ? { extras: state.extras } : {}),
      turnId: state.version,
      unitPositions: liveUnitPositions,
    });
    const markerKey = deriveRoomKey(projectionKey, "marker");
    const defaultFacingByFaction = new Map<string, number>();
    if (scenario.factions.length > 1) {
      const sumX = new Map<string, { x: number; n: number }>();
      let allX = 0,
        allN = 0;
      for (const a of this.input.armies) {
        const u = a.units[0];
        const pt = u?.profile.anchor as { x?: number; y?: number } | undefined;
        if (pt && typeof pt.x === "number") {
          const cur = sumX.get(a.factionId) ?? { x: 0, n: 0 };
          cur.x += pt.x;
          cur.n += 1;
          sumX.set(a.factionId, cur);
          allX += pt.x;
          allN += 1;
        }
      }
      if (allN > 0) {
        const midX = allX / allN;
        for (const [fid, cur] of sumX) {
          if (cur.n > 0 && cur.x / cur.n > midX + 5) {
            defaultFacingByFaction.set(fid, Math.round(Math.PI * 1000) / 1000);
          }
        }
      }
    }

    const authoredById = new Map<string, ScenarioUnit>();
    for (const commander of scenario.commanders) {
      for (const u of commander.units) authoredById.set(u.id, u);
    }
    const baseResources = initialUnitResources(scenario);
    const runtimeResources = state.extras?.unitResources ?? {};

    const darkness = this.darkness();
    const activeLights = this.activeLights();
    const factionAnchors = new Map<string, Array<{ pt: Point; lowLight: boolean }>>();

    const sources: DetectionSource[] = [];
    let index = 0;
    for (const army of this.input.armies) {
      const ownUnits: OwnUnit[] = [];
      for (const doc of army.units) {
        const view = this.input.units[index];
        if (!view) throw new Error("Invalid unit slot.");
        const [start, end] = doc.modelRange ?? [0, 0];
        let sx = 0,
          sy = 0,
          sinSum = 0,
          cosSum = 0,
          alive = 0,
          minXIdx = -1,
          maxXIdx = -1,
          minYIdx = -1,
          maxYIdx = -1;
        for (let i = start; i < end; i++) {
          if (this.pool.unitIdx[i] !== index)
            throw new Error("Checkpoint unit range mismatch.");
          if (((this.pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
          const mx = this.pool.x[i] ?? 0;
          const my = this.pool.y[i] ?? 0;
          const mrot = this.pool.rot[i] ?? 0;
          sx += mx;
          sy += my;
          sinSum += Math.sin(mrot);
          cosSum += Math.cos(mrot);
          if (minXIdx < 0 || mx < (this.pool.x[minXIdx] ?? 0)) minXIdx = i;
          if (maxXIdx < 0 || mx > (this.pool.x[maxXIdx] ?? 0)) maxXIdx = i;
          if (minYIdx < 0 || my < (this.pool.y[minYIdx] ?? 0)) minYIdx = i;
          if (maxYIdx < 0 || my > (this.pool.y[maxYIdx] ?? 0)) maxYIdx = i;
          alive++;
        }
        const at = alive > 0 ? { x: sx / alive, y: sy / alive } : null;
        const rawFacing =
          alive > 0 ? Math.round(Math.atan2(sinSum, cosSum) * 1000) / 1000 : undefined;
        const facing =
          rawFacing === 0 && defaultFacingByFaction.has(army.factionId)
            ? defaultFacingByFaction.get(army.factionId)
            : rawFacing;
        const authored = authoredById.get(doc._id);
        const visionMode = authored?.vision?.mode ?? "normal";

        if (at) {
          const baseRadius = rules.detection(this.input.ctx, view) * CELL_FEET;
          let radius = baseRadius;
          if (darkness > 0) {
            if (visionMode === "darkvision") {
              radius = Math.max(baseRadius, authored?.vision?.rangeFt ?? 60);
            } else if (visionMode === "lowLight") {
              radius = Math.max(CELL_FEET * 2, baseRadius * (1 - 0.25 * darkness));
            } else {
              radius = Math.max(CELL_FEET, baseRadius * (1 - 0.5 * darkness));
            }
          }
          sources.push({ anchor: at, factionId: army.factionId, radius });
          const fList = factionAnchors.get(army.factionId) ?? [];
          fList.push({ pt: at, lowLight: visionMode === "lowLight" });
          factionAnchors.set(army.factionId, fList);

          const edgeSeen = new Set<number>();
          for (const idx of [minXIdx, maxXIdx, minYIdx, maxYIdx]) {
            if (idx < 0 || edgeSeen.has(idx)) continue;
            edgeSeen.add(idx);
            const ex = this.pool.x[idx] ?? 0;
            const ey = this.pool.y[idx] ?? 0;
            if ((ex - at.x) ** 2 + (ey - at.y) ** 2 > (CELL_FEET * 2) ** 2) {
              sources.push({
                anchor: { x: ex, y: ey },
                factionId: army.factionId,
                radius,
              });
            }
          }
        }

        const unitRes = runtimeResources[doc._id] ?? baseResources[doc._id];
        const ownSpells: OwnUnit["spells"] = [];
        if (authored?.spells?.length) {
          for (const sp of authored.spells) {
            const cat = STRATEGIC_SPELL_CATALOG[sp.id];
            const slots =
              unitRes?.spells?.[sp.id] ??
              (sp.id === "entangle" ? doc.stats.entangleSlots : undefined) ??
              sp.slots;
            ownSpells.push({
              id: sp.id,
              name: cat.name,
              itemId: sp.itemId,
              shape: cat.shape,
              radius: cat.radius,
              slots: Math.max(0, slots),
            });
          }
        } else if (authored?.spellcasting) {
          const slots =
            unitRes?.spells?.entangle ??
            doc.stats.entangleSlots ??
            authored.spellcasting.entangleSlots;
          ownSpells.push({
            id: "entangle",
            name: "Entangle",
            itemId: authored.spellcasting.itemId,
            shape: "circle",
            radius: 40,
            slots: Math.max(0, slots),
          });
        }

        const ownItems: OwnUnit["items"] = (authored?.items ?? []).map((it) => ({
          id: it.id,
          name: it.name,
          effect: it.effect,
          charges: Math.max(0, unitRes?.items?.[it.id] ?? it.charges),
        }));

        const conditions = unitRes?.conditions ?? authored?.conditions;
        const elev = unitElevationAt(scenario, at ?? authored?.anchor);

        let modelStatsSummary: UnitModelStatsSummary | undefined;
        if (scenario.trackModelStats) {
          const map = state.extras?.modelStats ?? {};
          const unitRecords: StrategicModelStats[] = [];
          for (let i = start; i < end; i++) {
            if (((this.pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
            const rec = map[String(this.pool.id[i])];
            unitRecords.push(rec ? { ...rec } : { kills: 0, damageDealt: 0 });
          }
          modelStatsSummary = summarizeUnitModelStats(unitRecords);
        }

        const own: OwnUnit = {
          id: doc._id,
          name: doc.name,
          factionId: army.factionId,
          at,
          leadAt:
            alive > 0
              ? ((): Point => {
                  for (let i = start; i < end; i++) {
                    if (((this.pool.status[i] ?? 0) & ModelStatus.dead) === 0) {
                      return {
                        x: this.pool.x[i] ?? 0,
                        y: this.pool.y[i] ?? 0,
                      };
                    }
                  }
                  return at ?? { x: 0, y: 0 };
                })()
              : null,
          alive,
          weapon: doc.stats.weaponIsRanged ? "shot" : "melee",
          ...(facing !== undefined ? { facing } : {}),
          ...(elev > 0 ? { elevation: elev } : {}),
          ...(conditions?.length ? { conditions: [...conditions] } : {}),
          statsSummary: {
            ac: Math.round(doc.stats.ac ?? 16),
            bab: Math.round(doc.stats.bab ?? 6),
            hp: Math.round(doc.stats.hp ?? 10),
            vision: visionMode,
          },
          ...(modelStatsSummary ? { modelStatsSummary } : {}),
          ...(ownSpells.length ? { spells: ownSpells } : {}),
          ...(ownItems.length ? { items: ownItems } : {}),
        };
        ownUnits.push(own);
        this.units.set(doc._id, {
          index,
          view,
          army,
          doc,
          own,
          ...(authored ? { authored } : {}),
          ...(authored?.badge ? { badge: authored.badge } : {}),
        });
        index++;
      }
      const commander = army.commander[0] ?? "";
      this.owners.set(commander, [
        ...(this.owners.get(commander) ?? []),
        ...ownUnits,
      ]);
    }
    for (const army of this.input.armies) {
      const commander = army.commander[0] ?? "";
      const deployment = new Set([
        ...(this.defaultControl.get(commander) ?? []),
        ...army.units.map((unit) => unit._id),
      ]);
      this.defaultControl.set(commander, deployment);
      const granted = state.control?.[commander];
      if (granted !== undefined && granted !== null)
        this.control.set(commander, new Set(granted));
    }

    let detectionBounds = scenario.bounds;
    let detectionCellFeet = CELL_FEET;
    if (sources.length > 0) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const src of sources) {
        const pad = src.radius + CELL_FEET * 2;
        if (src.anchor.x - pad < minX) minX = src.anchor.x - pad;
        if (src.anchor.y - pad < minY) minY = src.anchor.y - pad;
        if (src.anchor.x + pad > maxX) maxX = src.anchor.x + pad;
        if (src.anchor.y + pad > maxY) maxY = src.anchor.y + pad;
      }
      detectionBounds = {
        minX: Math.max(scenario.bounds.minX, Math.floor(minX / CELL_FEET) * CELL_FEET),
        minY: Math.max(scenario.bounds.minY, Math.floor(minY / CELL_FEET) * CELL_FEET),
        maxX: Math.min(scenario.bounds.maxX, Math.ceil(maxX / CELL_FEET) * CELL_FEET),
        maxY: Math.min(scenario.bounds.maxY, Math.ceil(maxY / CELL_FEET) * CELL_FEET),
      };
      const spanX = Math.max(CELL_FEET, detectionBounds.maxX - detectionBounds.minX);
      const spanY = Math.max(CELL_FEET, detectionBounds.maxY - detectionBounds.minY);
      const cells = (spanX / CELL_FEET) * (spanY / CELL_FEET);
      if (cells > 4_000_000 && this.input.ctx.walls.x1.length === 0) {
        detectionCellFeet =
          Math.ceil(Math.max(spanX, spanY) / 2000 / CELL_FEET) * CELL_FEET;
      }
    }
    this.grid = new DetectionGrid(detectionCellFeet);
    this.grid.reseed(sources, detectionBounds, this.input.ctx.walls);

    const lightBounds = activeLights
      .map((light) => {
        const baseR = Math.max(light.bright, light.dim);
        return { light, baseR, maxR: baseR * 2, maxR2: baseR * baseR * 4 };
      })
      .filter((entry) => entry.baseR > 0);
    let lightsMinX = Infinity,
      lightsMinY = Infinity,
      lightsMaxX = -Infinity,
      lightsMaxY = -Infinity;
    for (const lb of lightBounds) {
      if (lb.light.x - lb.maxR < lightsMinX) lightsMinX = lb.light.x - lb.maxR;
      if (lb.light.y - lb.maxR < lightsMinY) lightsMinY = lb.light.y - lb.maxR;
      if (lb.light.x + lb.maxR > lightsMaxX) lightsMaxX = lb.light.x + lb.maxR;
      if (lb.light.y + lb.maxR > lightsMaxY) lightsMaxY = lb.light.y + lb.maxR;
    }

    const isIlluminatedFor = (mx: number, my: number, factionId: string): boolean => {
      if (
        lightBounds.length === 0 ||
        mx < lightsMinX ||
        mx > lightsMaxX ||
        my < lightsMinY ||
        my > lightsMaxY
      )
        return false;
      const viewers = factionAnchors.get(factionId);
      if (!viewers?.length) return false;
      for (const { light, baseR, maxR2 } of lightBounds) {
        const dxL = mx - light.x;
        const dyL = my - light.y;
        const dLight2 = dxL * dxL + dyL * dyL;
        if (dLight2 > maxR2) continue;
        if (!hasLineOfEffect(light.x, light.y, mx, my, this.input.ctx.walls)) continue;
        const dLight = Math.sqrt(dLight2);
        for (const viewer of viewers) {
          const effRadius = viewer.lowLight ? baseR * 2 : baseR;
          if (dLight > effRadius) continue;
          const dxV = mx - viewer.pt.x;
          const dyV = my - viewer.pt.y;
          if (dxV * dxV + dyV * dyV > 14_400) continue;
          if (hasLineOfEffect(viewer.pt.x, viewer.pt.y, mx, my, this.input.ctx.walls)) {
            return true;
          }
        }
      }
      return false;
    };

    for (const factionId of [null, ...scenario.factions.map((f) => f.id)]) {
      const bitmap =
        factionId === null
          ? null
          : this.grid.visibleModels(this.pool, factionId);
      const markers: UnitMarker[] = [];
      const regions = new Map<string, ModelMarker[]>();
      const visible = new Set<string>();
      for (const { doc, army } of this.units.values()) {
        const [start, end] = doc.modelRange ?? [0, 0];
        let sx = 0,
          sy = 0,
          count = 0;
        for (let i = start; i < end; i++) {
          if (((this.pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
          const x = this.pool.x[i] ?? 0,
            y = this.pool.y[i] ?? 0;
          if (
            factionId !== null &&
            army.factionId !== factionId &&
            !bitmap?.[i] &&
            !isIlluminatedFor(x, y, factionId)
          )
            continue;
          if (!inBounds(scenario.bounds, x, y))
            throw new Error("Resolved models outside room bounds.");
          sx += x;
          sy += y;
          count++;
          const key = this.regionKey(x, y);
          let models = regions.get(key);
          if (!models) regions.set(key, (models = []));
          if (models.length > MAX_REGION_MODELS) continue;
          const poolModelId = this.pool.id[i] ?? i;
          let id = this.markerIdByPoolId.get(poolModelId);
          if (!id) {
            id = createHmac("sha256", markerKey)
              .update(String(poolModelId))
              .digest("base64url")
              .slice(0, 22);
            this.markerIdByPoolId.set(poolModelId, id);
          }
          const rawRot = this.pool.rot[i] ?? 0;
          const modelStat =
            scenario.trackModelStats && (factionId === null || army.factionId === factionId)
              ? state.extras?.modelStats?.[String(this.pool.id[i])]
              : undefined;
          models.push({
            id,
            unitId: doc._id,
            x,
            y,
            rotation:
              rawRot === 0 && defaultFacingByFaction.has(army.factionId)
                ? (defaultFacingByFaction.get(army.factionId) ?? 0)
                : rawRot,
            ...(modelStat ? { stats: modelStat } : {}),
          });
        }
        if (count > 0) {
          visible.add(doc._id);
          markers.push({
            id: doc._id,
            name: doc.name,
            factionId: army.factionId,
            at: { x: sx / count, y: sy / count },
          });
        }
      }
      const packedMarkers = packMarkers(markers, scenario.factions);
      const old =
        previous?.state.version === state.version - 1
          ? previous.cohorts.get(factionId)
          : undefined;
      this.cohorts.set(factionId, {
        markers,
        packedMarkers,
        changes:
          old &&
          packMarkerChanges(old.markers, markers, packedMarkers.byteLength - 1),
        visible,
        regions,
      });
    }

    const nextTurn = state.version + 1;
    const activeHazards = [
      ...(scenario.hazards ?? []),
      ...(state.hazards ?? []),
    ].filter((h) => spellHazardActive(h, nextTurn));
    this.nextTurnHazards = activeHazards;
    const difficult = new Set<string>();
    for (const cell of this.input.ctx.terrain?.difficultCells ?? []) {
      difficult.add(`${cell.col},${cell.row}`);
    }
    for (const hazard of activeHazards) {
      if (hazard.radius < CELL_FEET * 0.5) continue;
      const minC = Math.floor((hazard.at.x - hazard.radius) / CELL_FEET);
      const maxC = Math.floor((hazard.at.x + hazard.radius) / CELL_FEET);
      const minR = Math.floor((hazard.at.y - hazard.radius) / CELL_FEET);
      const maxR = Math.floor((hazard.at.y + hazard.radius) / CELL_FEET);
      for (let c = minC; c <= maxC; c++) {
        for (let r = minR; r <= maxR; r++) {
          if (
            pointInSpellHazard(hazard, {
              x: (c + 0.5) * CELL_FEET,
              y: (r + 0.5) * CELL_FEET,
            })
          ) {
            difficult.add(`${c},${r}`);
          }
        }
      }
    }
    this.moveDifficultCells = difficult;
  }

  private regionKey(x: number, y: number): string {
    return `${Math.floor((x - this.scenario.bounds.minX) / REGION_SIZE)},${Math.floor((y - this.scenario.bounds.minY) / REGION_SIZE)}`;
  }

  private memberFactions(member: Member): string[] {
    if (member.role === "GM") return [];
    const ownUnits = this.own(member);
    const seen = new Set<string>();
    for (const u of ownUnits) {
      if (u.factionId) seen.add(u.factionId);
    }
    if (seen.size === 0 && member.factionId) seen.add(member.factionId);
    return this.scenario.factions
      .map((f) => f.id)
      .filter((id) => seen.has(id));
  }

  private cohort(member: Member): Cohort {
    if (member.role === "GM") {
      const gmView = this.cohorts.get(null);
      if (!gmView) throw new Error("Missing authorized view.");
      return gmView;
    }
    const fids = this.memberFactions(member);
    if (fids.length <= 1) {
      const view = this.cohorts.get(fids[0] ?? member.factionId);
      if (!view) throw new Error("Missing authorized view.");
      return view;
    }
    const visible = new Set<string>();
    const markerById = new Map<string, UnitMarker>();
    const regions = new Map<string, ModelMarker[]>();
    const regionSeen = new Map<string, Set<string>>();
    for (const fid of fids) {
      const sub = this.cohorts.get(fid);
      if (!sub) continue;
      for (const id of sub.visible) visible.add(id);
      for (const m of sub.markers) {
        if (!markerById.has(m.id)) markerById.set(m.id, m);
      }
      for (const [key, list] of sub.regions) {
        let out = regions.get(key);
        let seen = regionSeen.get(key);
        if (!out) regions.set(key, (out = []));
        if (!seen) regionSeen.set(key, (seen = new Set()));
        for (const model of list) {
          if (seen.has(model.id) || out.length > MAX_REGION_MODELS) continue;
          seen.add(model.id);
          out.push(model);
        }
      }
    }
    const markers = [...this.units.keys()]
      .map((id) => markerById.get(id))
      .filter((m): m is UnitMarker => m !== undefined);
    return {
      markers,
      packedMarkers: packMarkers(markers, this.scenario.factions),
      changes: undefined,
      visible,
      regions,
    };
  }

  private areaDetectedBy(
    origin: Point,
    radius: number,
    factionIds: readonly string[],
  ): boolean {
    if (factionIds.length === 0) return false;
    const minC = Math.max(
      Math.floor(this.scenario.bounds.minX / CELL_FEET),
      Math.floor((origin.x - radius) / CELL_FEET),
    );
    const maxC = Math.min(
      Math.floor(this.scenario.bounds.maxX / CELL_FEET),
      Math.floor((origin.x + radius) / CELL_FEET),
    );
    const minR = Math.max(
      Math.floor(this.scenario.bounds.minY / CELL_FEET),
      Math.floor((origin.y - radius) / CELL_FEET),
    );
    const maxR = Math.min(
      Math.floor(this.scenario.bounds.maxY / CELL_FEET),
      Math.floor((origin.y + radius) / CELL_FEET),
    );
    const r2 = radius * radius;
    for (let r = minR; r <= maxR; r++) {
      const sy = (r + 0.5) * CELL_FEET;
      for (let c = minC; c <= maxC; c++) {
        const sx = (c + 0.5) * CELL_FEET;
        if ((sx - origin.x) ** 2 + (sy - origin.y) ** 2 > r2) continue;
        if (this.grid.detectedAt(sx, sy, factionIds)) return true;
      }
    }
    return false;
  }

  unitFactions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, slot] of this.units) out[id] = slot.army.factionId;
    return out;
  }

  effectiveWalls(): NonNullable<Baseline["walls"]> | undefined {
    const list = effectiveWallsFor(this.scenario, this.live).list;
    if (!list.length) return undefined;
    return list.map((w) => ({
      ...(w.id ? { id: w.id } : {}),
      x1: w.x1,
      y1: w.y1,
      x2: w.x2,
      y2: w.y2,
      restriction: w.restriction,
      ...(w.door !== undefined ? { door: w.door } : {}),
    }));
  }

  doors(): Record<string, 0 | 1 | 2> | undefined {
    const out: Record<string, 0 | 1 | 2> = {};
    for (const w of this.scenario.walls ?? []) {
      if (w.id && w.door !== undefined) {
        out[w.id] =
          this.live.doors && Object.hasOwn(this.live.doors, w.id)
            ? (this.live.doors[w.id] ?? w.door)
            : w.door;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }

  canToggleDoor(member: Member, wallId: string, nextDoor: 0 | 1 | 2): string | null {
    const wall = (this.scenario.walls ?? []).find((w) => w.id === wallId);
    if (!wall || wall.door === undefined) return "No such door on this battlefield.";
    if (member.role === "GM") return null;
    if (nextDoor === 2) return "Only the GM may lock doors.";
    const curDoor =
      this.live.doors && Object.hasOwn(this.live.doors, wallId)
        ? (this.live.doors[wallId] ?? wall.door)
        : wall.door;
    if (curDoor === 2) return "Door is locked.";
    const myUnits = this.own(member);
    const near = myUnits.some(
      (u) =>
        u.alive > 0 &&
        u.at !== null &&
        pointToSegmentDist(u.at.x, u.at.y, wall.x1, wall.y1, wall.x2, wall.y2) <= 25,
    );
    if (!near) return "Move a controlled unit within 25 ft of the door to operate it.";
    return null;
  }

  darkness(): number {
    return this.live.darkness !== undefined
      ? this.live.darkness
      : (this.scenario.lighting?.darkness ?? 0);
  }

  private resolveLights(): HostedLight[] {
    return (this.scenario.lighting?.lights ?? []).map((l): HostedLight => {
      const hidden =
        this.live.lightHidden && Object.hasOwn(this.live.lightHidden, l.id)
          ? this.live.lightHidden[l.id]
          : l.hidden;
      const copy: HostedLight = {
        id: l.id,
        x: l.x,
        y: l.y,
        dim: l.dim,
        bright: l.bright,
        color: l.color,
        alpha: l.alpha,
      };
      if (hidden !== undefined) copy.hidden = hidden;
      return copy;
    });
  }

  private activeLights(): HostedLight[] {
    return this.resolveLights().filter((l) => !l.hidden);
  }

  lights(member: Member): HostedLight[] | undefined {
    const raw = this.resolveLights();
    const list = member.role === "GM" ? raw : raw.filter((l) => !l.hidden);
    return list.length ? list : undefined;
  }

  templates(): HostedTemplate[] | undefined {
    const list = this.live.templates ?? this.scenario.templates;
    return list?.length ? list : undefined;
  }

  chat(member: Member): HostedChatEntry[] | undefined {
    const all = this.live.chat;
    if (!all?.length) return undefined;
    if (member.role === "GM") return all;
    const fids = this.memberFactions(member);
    const filtered = all.filter(
      (c) =>
        c.scope === "public" ||
        (c.scope === "faction" && c.factionId !== null && fids.includes(c.factionId)),
    );
    return filtered.length ? filtered : undefined;
  }

  content(member: Member): Baseline["content"] | undefined {
    const src = this.scenario.content;
    const fxCuesAll = this.state.extras?.fxCues ?? [];
    const fids = this.memberFactions(member);
    const fxCues =
      member.role === "GM"
        ? fxCuesAll
        : fxCuesAll
            .filter((cue) => this.areaDetectedBy(cue.at, Math.max(10, cue.radius), fids))
            .map((cue) => {
              if (!cue.from) return cue;
              // Strip launch `from` if the origin is hidden in fog of war!
              if (this.areaDetectedBy(cue.from, 10, fids)) return cue;
              const copy: typeof cue = { ...cue };
              delete copy.from;
              return copy;
            });

    const journals =
      member.role === "GM"
        ? src?.journals
        : src?.journals?.filter((j) => j.visibility === "public");
    const rollTables =
      member.role === "GM"
        ? src?.rollTables
        : src?.rollTables?.filter((t) => t.visibility === "public");
    const playlists = src?.playlists;
    const macros = src?.macros;
    const activeTrackId = this.live.activeTrackId ?? null;
    const fxCoalescence = this.scenario.fxCoalescence;

    if (
      !journals?.length &&
      !rollTables?.length &&
      !playlists?.length &&
      !macros?.length &&
      !fxCues.length &&
      activeTrackId === null &&
      !fxCoalescence
    ) {
      return undefined;
    }
    return {
      ...(journals?.length ? { journals } : {}),
      ...(rollTables?.length ? { rollTables } : {}),
      ...(playlists?.length ? { playlists } : {}),
      ...(playlists?.length || activeTrackId !== null ? { activeTrackId } : {}),
      ...(macros?.length ? { macros } : {}),
      ...(fxCues.length ? { fxCues } : {}),
      ...(fxCoalescence ? { fxCoalescence } : {}),
    };
  }

  areas(member: Member, turnId: number): NonNullable<Baseline["areas"]> {
    const active = [
      ...(this.scenario.hazards ?? []),
      ...(this.state.hazards ?? []),
    ].filter((hazard) => spellHazardActive(hazard, turnId));
    const fids = this.memberFactions(member);
    return active
      .filter(
        (hazard) =>
          member.role === "GM" ||
          (hazard.casterFactionId !== undefined &&
            fids.includes(hazard.casterFactionId)) ||
          this.areaDetectedBy(hazard.at, hazard.radius, fids),
      )
      .map((hazard) => ({
        id: hazard.id,
        spell: hazard.spell,
        at: { ...hazard.at },
        radius: hazard.radius,
        ...(hazard.expiresAfterTurn !== undefined
          ? { expiresAfterTurn: hazard.expiresAfterTurn }
          : {}),
      }));
  }

  actions(member: Member): ActionCard[] | undefined {
    const all = this.state.actions;
    if (!all?.length) return undefined;
    if (member.role === "GM") return all;
    const fids = this.memberFactions(member);
    const view = this.cohort(member);
    const filtered = all.filter((action) => {
      const sourceUnit = this.units.get(action.source.name);
      if (
        sourceUnit &&
        (fids.includes(sourceUnit.army.factionId) ||
          view.visible.has(sourceUnit.doc._id))
      ) {
        return true;
      }
      if (action.area) {
        return this.areaDetectedBy(
          action.area.origin,
          action.area.radius ?? 0,
          fids,
        );
      }
      return false;
    });
    return filtered.length ? filtered : undefined;
  }

  markers(member: Member): UnitMarker[] {
    return this.cohort(member).markers;
  }
  markerChanges(member: Member) {
    return this.cohort(member).changes;
  }
  packedMarkers(member: Member): Buffer {
    return this.cohort(member).packedMarkers;
  }

  applyControl(control: Control) {
    for (const [memberId, units] of Object.entries(control)) {
      if (units === null) this.control.delete(memberId);
      else this.control.set(memberId, new Set(units));
    }
  }

  private allows(memberId: string, unitId: string): boolean {
    return (
      this.control.get(memberId) ??
      this.defaultControl.get(memberId) ??
      new Set<string>()
    ).has(unitId);
  }

  own(member: Member, badgeUrls?: Readonly<Record<string, string>>): OwnUnit[] {
    if (member.role === "GM") return this.owners.get(member.id) ?? [];
    const explicit = this.control.get(member.id);
    const granted = explicit ?? this.defaultControl.get(member.id);
    if (!granted) return [];
    const list = explicit
      ? [...this.units.values()]
          .filter(({ own }) => granted.has(own.id))
          .map(({ own }) => own)
      : (this.owners.get(member.id) ?? []).filter((unit) => granted.has(unit.id));
    if (!badgeUrls) return list;
    return list.map((unit) => {
      const hash = this.units.get(unit.id)?.badge;
      const badgeUrl = hash ? badgeUrls[hash] : undefined;
      return badgeUrl ? { ...unit, badgeUrl } : unit;
    });
  }

  unitFacings(member: Member): Record<string, number> | undefined {
    const visible = this.cohort(member).visible;
    if (visible.size > 500) return undefined;
    const out: Record<string, number> = {};
    let count = 0;
    for (const id of visible) {
      const facing = this.units.get(id)?.own.facing;
      if (facing !== undefined && Math.abs(facing) >= 0.002) {
        out[id] = facing;
        count++;
      }
    }
    return count > 0 ? out : undefined;
  }

  unitBadges(
    member: Member,
    badgeUrls: Readonly<Record<string, string>>,
  ): Record<string, string> | undefined {
    const visible = this.cohort(member).visible;
    const out: Record<string, string> = {};
    let count = 0;
    for (const id of visible) {
      const hash = this.units.get(id)?.badge;
      const url = hash ? badgeUrls[hash] : undefined;
      if (url) {
        out[id] = url;
        count++;
      }
    }
    return count > 0 ? out : undefined;
  }

  region(member: Member, key: string): ModelMarker[] {
    return this.cohort(member).regions.get(key) ?? [];
  }

  private hasFormationLineOfEffect(
    attackerRange: readonly [number, number],
    defenderRange: readonly [number, number],
  ): boolean {
    const walls = this.input.ctx.walls;
    if (walls.x1.length === 0) return true;
    for (let a = attackerRange[0]; a < attackerRange[1]; a++) {
      if (((this.pool.status[a] ?? 0) & ModelStatus.dead) !== 0) continue;
      const ax = this.pool.x[a] ?? 0;
      const ay = this.pool.y[a] ?? 0;
      for (let d = defenderRange[0]; d < defenderRange[1]; d++) {
        if (((this.pool.status[d] ?? 0) & ModelStatus.dead) !== 0) continue;
        if (
          hasLineOfEffect(
            ax,
            ay,
            this.pool.x[d] ?? 0,
            this.pool.y[d] ?? 0,
            walls,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private findUnitSpell(unitSlot: UnitSlot, spellId: StrategicSpellId) {
    const sp = unitSlot.authored?.spells?.find((s) => s.id === spellId);
    if (sp) return sp;
    if (spellId === "entangle" && unitSlot.authored?.spellcasting) {
      return {
        id: "entangle" as const,
        itemId: unitSlot.authored.spellcasting.itemId,
        casterLevel: unitSlot.authored.spellcasting.casterLevel,
        castingAbilityMod: unitSlot.authored.spellcasting.castingAbilityMod,
        slots: unitSlot.authored.spellcasting.entangleSlots,
      };
    }
    return null;
  }

  validate(member: Member, edit: UnitEdit): string | null {
    const { unitId, order } = edit;
    const unit = this.units.get(unitId);
    const explicitlyGranted = this.control.get(member.id)?.has(unitId) === true;
    if (
      !unit ||
      (!explicitlyGranted && unit.army.commander[0] !== member.id) ||
      !this.allows(member.id, unitId) ||
      !can(
        explicitlyGranted ? { ...member, factionId: unit.army.factionId } : member,
        "order",
        unit.doc,
        "units",
        {
          parent: explicitlyGranted
            ? {
                ...unit.army,
                commander: [member.id],
                ownership: { ...unit.army.ownership, [member.id]: 3 },
              }
            : unit.army,
        },
      )
    ) {
      return "Unit is not assigned to this commander.";
    }
    if (!order) return null;
    const range = unit.view.modelRange;
    if (!range || unit.own.alive === 0) return "Unit has no living models.";
    let firstLiving = -1;
    for (let i = range[0]; i < range[1]; i++) {
      if (((this.pool.status[i] ?? 0) & ModelStatus.dead) === 0) {
        firstLiving = i;
        break;
      }
    }
    if (firstLiving < 0) return "Unit has no living models.";

    if (order.kind === "cast") {
      const spellEntry = this.findUnitSpell(unit, order.spellId);
      if (!spellEntry || spellEntry.itemId !== order.itemId)
        return "This unit does not have that projected PF1e spell item.";
      const ownSpell = unit.own.spells?.find((s) => s.id === order.spellId);
      if ((ownSpell?.slots ?? 0) < 1)
        return `${STRATEGIC_SPELL_CATALOG[order.spellId].name} has no remaining projected spell slot.`;
      if (!inBounds(this.scenario.bounds, order.origin.x, order.origin.y))
        return "Spell origin is outside the battlefield.";
      const cat = STRATEGIC_SPELL_CATALOG[order.spellId];
      const from = {
        x: this.pool.x[firstLiving] ?? 0,
        y: this.pool.y[firstLiving] ?? 0,
      };
      if (cat.shape === "cone" || cat.shape === "line") {
        if (!order.dir || Math.hypot(order.dir.x, order.dir.y) < 0.01) {
          return `${cat.name} requires a non-zero aim direction.`;
        }
        const centroid = unit.own.at ?? from;
        if (
          Math.hypot(order.origin.x - from.x, order.origin.y - from.y) > 35 &&
          Math.hypot(order.origin.x - centroid.x, order.origin.y - centroid.y) > 35
        ) {
          return `${cat.name} originates at the casting unit (self-range ${cat.shape}, CRB p.214).`;
        }
      } else {
        const maxRange =
          cat.range === "long"
            ? 400 + 40 * spellEntry.casterLevel
            : 100 + 10 * spellEntry.casterLevel;
        if (Math.hypot(order.origin.x - from.x, order.origin.y - from.y) > maxRange) {
          return `${cat.name} origin is beyond the regular PF1e ${cat.range} range.`;
        }
        if (
          !hasLineOfEffect(
            from.x,
            from.y,
            order.origin.x,
            order.origin.y,
            this.input.ctx.walls,
          )
        ) {
          return "No line of effect to spell origin.";
        }
      }
      return null;
    }

    if (order.kind === "useItem") {
      const ownItem = unit.own.items?.find((it) => it.id === order.itemId);
      if (!ownItem) return "This unit does not carry that projected PF1e item.";
      if (ownItem.charges < 1) return `${ownItem.name} has no remaining charges.`;
      const targetId = order.targetUnitId ?? unitId;
      const targetSlot = this.units.get(targetId);
      if (!targetSlot || targetSlot.army.factionId !== unit.army.factionId) {
        return "Item target must be an allied unit.";
      }
      if (targetId !== unitId && unit.own.at && targetSlot.own.at) {
        if (Math.hypot(targetSlot.own.at.x - unit.own.at.x, targetSlot.own.at.y - unit.own.at.y) > 60) {
          return "Allied unit must be within 60 ft to receive item support.";
        }
      }
      return null;
    }

    if (order.kind === "ready") {
      if (order.response === "shot" && unit.own.weapon !== "shot") {
        return "Only ranged formations can ready a volley.";
      }
      if (order.targetUnitId !== undefined) {
        const target = this.units.get(order.targetUnitId);
        if (
          !target ||
          target.army.factionId === unit.army.factionId ||
          !this.cohort(member).visible.has(order.targetUnitId)
        ) {
          return "Readied target is not an available visible enemy.";
        }
      }
      return null;
    }

    const verdict = rules.validateOrder(
      this.input.ctx,
      unit.view,
      toRulesOrderForValidation(order),
    );
    if (!verdict.ok) return verdict.error;

    if (order.kind === "reform") {
      const from = {
        x: this.pool.x[firstLiving] ?? 0,
        y: this.pool.y[firstLiving] ?? 0,
      };
      const infantry = rules.schema.unitTypes.infantry as { move: number };
      const cond = applyUnitConditionsToStride(
        { from, path: [from], pace: "march", movePoints: infantry.move, cellFeet: CELL_FEET },
        this.pool,
        unit.view,
      );
      if (cond.refusal) return cond.refusal;
      return null;
    }

    if (order.kind === "attack") {
      const target = this.units.get(order.targetUnitId);
      const unitCohort = this.cohorts.get(unit.army.factionId);
      if (
        !target ||
        target.army.factionId === unit.army.factionId ||
        !this.cohort(member).visible.has(order.targetUnitId) ||
        !unitCohort?.visible.has(order.targetUnitId)
      )
        return "Target is not an available enemy.";
      if (order.mode !== unit.own.weapon)
        return "This unit does not use that attack mode.";
      const targetRange = target.view.modelRange;
      if (
        targetRange &&
        !this.hasFormationLineOfEffect(range, targetRange)
      ) {
        return "No line of effect to target.";
      }
    }

    if (order.kind === "move") {
      const bounds = this.scenario.bounds;
      if (order.path.some(({ x, y }) => !inBounds(bounds, x, y)))
        return "Destination is outside the battlefield.";
      const typeKey = (unit.view.type as keyof typeof rules.schema.unitTypes) || "infantry";
      const unitTypeBlock = (rules.schema.unitTypes[typeKey] ?? rules.schema.unitTypes.infantry) as { move: number };
      const planned = planUnitModelMoves({
        pool: this.pool,
        unit: unit.view,
        path: order.path,
        pace: order.pace,
        movePoints: unitTypeBlock.move,
        cellFeet: CELL_FEET,
        reform: order.reform === true,
        difficult: this.moveDifficultCells,
        difficultIncludesHazards: true,
        hazards: this.nextTurnHazards,
        bounds,
        strictBounds: true,
        quantize: true,
        ...(this.input.ctx.walls.x1.length > 0
          ? {
              blockAt: (fx: number, fy: number, tx: number, ty: number) =>
                firstMoveBlock(fx, fy, tx, ty, this.input.ctx.walls),
            }
          : {}),
        blockEpsilon: MOVE_BLOCK_EPSILON,
      });
      if (!planned.ok) return planned.refusal;
      for (const o of planned.plan.outcomes) {
        const fx = Math.fround(o.to.x);
        const fy = Math.fround(o.to.y);
        if (
          !simPositionFits(fx, STRATEGIC_CODEC) ||
          !simPositionFits(fy, STRATEGIC_CODEC) ||
          !inBounds(bounds, Math.round(fx * 16) / 16, Math.round(fy * 16) / 16)
        ) {
          return "Formation would extend outside the battlefield.";
        }
      }
    }
    return null;
  }
}

export function summarizeUnitModelStats(
  records: readonly StrategicModelStats[],
): UnitModelStatsSummary | undefined {
  if (records.length === 0) return undefined;
  let kills = 0,
    damageDealt = 0,
    damageTaken = 0,
    damageReduced = 0,
    healed = 0,
    hits = 0,
    misses = 0,
    crits = 0,
    veteranCount = 0;
  let topVeteran: { slot: number; kills: number; damageDealt: number } | undefined;
  records.forEach((r, slot) => {
    kills += r.kills;
    damageDealt += r.damageDealt;
    damageTaken += r.damageTaken ?? 0;
    damageReduced += r.damageReduced ?? 0;
    healed += r.healed ?? 0;
    hits += r.hits ?? 0;
    misses += r.misses ?? 0;
    crits += r.crits ?? 0;
    if (r.kills > 0 || r.damageDealt > 0) {
      veteranCount++;
      if (
        !topVeteran ||
        r.kills > topVeteran.kills ||
        (r.kills === topVeteran.kills && r.damageDealt > topVeteran.damageDealt)
      ) {
        topVeteran = { slot: slot + 1, kills: r.kills, damageDealt: r.damageDealt };
      }
    }
  });
  return {
    kills,
    damageDealt,
    damageTaken,
    damageReduced,
    healed,
    hits,
    misses,
    crits,
    veteranCount,
    ...(topVeteran ? { topVeteran } : {}),
  };
}

export function diffRegion(
  previous: ReadonlyMap<string, ModelMarker> | null,
  next: Map<string, ModelMarker>,
) {
  const enter: ModelMarker[] = [],
    update: ModelMarker[] = [],
    leave: string[] = [];
  for (const [id, model] of next) {
    const before = previous?.get(id);
    if (!before) enter.push(model);
    else if (
      before.x !== model.x ||
      before.y !== model.y ||
      before.rotation !== model.rotation ||
      before.unitId !== model.unitId ||
      before.stats?.kills !== model.stats?.kills ||
      before.stats?.damageDealt !== model.stats?.damageDealt ||
      before.stats?.damageTaken !== model.stats?.damageTaken
    )
      update.push(model);
  }
  if (previous)
    for (const id of previous.keys()) if (!next.has(id)) leave.push(id);
  return { enter, update, leave };
}
