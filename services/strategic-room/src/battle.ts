import { createHmac } from "node:crypto";
import {
  DetectionGrid,
  type DetectionSource,
} from "../../../src/core/detection";
import { can } from "../../../src/core/permissions";
import { ModelStatus } from "../../../src/core/strategic";
import { simPositionFits } from "../../../src/core/sim";
import {
  MAX_REGION_MODELS,
  REGION_SIZE,
  STRATEGIC_CODEC,
  type ModelMarker,
  type OwnUnit,
  type UnitEdit,
  type UnitMarker,
} from "../../../src/core/strategicRoom/protocol";
import { planPF1eStride } from "../../../src/packages/pf1e/stride";
import { createMassBattlePf1e } from "../../../src/packages/massBattlePf1e";
import { CELL_FEET, inBounds, rulesInput, type Scenario } from "./scenario";
import {
  checkpointPool,
  type Control,
  type Member,
  type Published,
} from "./state";
import { packMarkerChanges, packMarkers } from "./viewEncoding";

const rules = createMassBattlePf1e();
type BattleInput = ReturnType<typeof rulesInput>;
type UnitSlot = {
  index: number;
  view: BattleInput["units"][number];
  army: BattleInput["armies"][number];
  doc: BattleInput["armies"][number]["units"][number];
  own: OwnUnit;
};
type Cohort = {
  markers: UnitMarker[];
  packedMarkers: Buffer;
  changes: Buffer | undefined;
  visible: Set<string>;
  regions: Map<string, ModelMarker[]>;
};

/** Whole-room work is once per publication, never on the order path. */
export class BattleView {
  private readonly input: BattleInput;
  private readonly pool;
  private readonly units = new Map<string, UnitSlot>();
  private readonly owners = new Map<string, OwnUnit[]>();
  /** Effective unit allowlist per commander, frozen with the publication it belongs to. */
  private readonly control = new Map<string, Set<string>>();
  private readonly cohorts = new Map<string | null, Cohort>();

  constructor(
    readonly scenario: Scenario,
    readonly state: Published,
    projectionKey: Uint8Array,
    previous?: BattleView,
  ) {
    this.input = rulesInput(scenario, state.units);
    this.pool = checkpointPool(state);
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
          alive = 0;
        for (let i = start; i < end; i++) {
          if (this.pool.unitIdx[i] !== index)
            throw new Error("Checkpoint unit range mismatch.");
          if (((this.pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
          sx += this.pool.x[i] ?? 0;
          sy += this.pool.y[i] ?? 0;
          alive++;
        }
        const at = alive > 0 ? { x: sx / alive, y: sy / alive } : null;
        if (at)
          sources.push({
            anchor: at,
            factionId: army.factionId,
            radius: rules.detection(this.input.ctx, view) * CELL_FEET,
          });
        const own: OwnUnit = {
          id: doc._id,
          name: doc.name,
          at,
          alive,
          weapon: doc.stats.weaponIsRanged ? "shot" : "melee",
        };
        ownUnits.push(own);
        this.units.set(doc._id, { index, view, army, doc, own });
        index++;
      }
      this.owners.set(army._id, ownUnits);
    }
    for (const army of this.input.armies) {
      const granted = state.control?.[army.commander[0] ?? ""];
      this.control.set(
        army.commander[0] ?? "",
        new Set(granted ?? army.units.map((unit) => unit._id)),
      );
    }
    const grid = new DetectionGrid(CELL_FEET);
    grid.reseed(sources, scenario.bounds);
    // Raw pool indices and sequential model ids never appear on the wire.
    const ids = new Map<number, string>();
    for (const factionId of [null, ...scenario.factions.map((f) => f.id)]) {
      const bitmap =
        factionId === null ? null : grid.visibleModels(this.pool, factionId);
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
          if (
            factionId !== null &&
            army.factionId !== factionId &&
            !bitmap?.[i]
          )
            continue;
          const x = this.pool.x[i] ?? 0,
            y = this.pool.y[i] ?? 0;
          if (!inBounds(scenario.bounds, x, y))
            throw new Error("Resolved models outside room bounds.");
          sx += x;
          sy += y;
          count++;
          const key = this.regionKey(x, y);
          let models = regions.get(key);
          if (!models) regions.set(key, (models = []));
          if (models.length > MAX_REGION_MODELS) continue; // One overflow entry is enough to signal truncation.
          let id = ids.get(i);
          if (!id) {
            id = createHmac("sha256", projectionKey)
              .update(String(this.pool.id[i]))
              .digest("base64url")
              .slice(0, 22);
            ids.set(i, id);
          }
          models.push({
            id,
            unitId: doc._id,
            x,
            y,
            rotation: this.pool.rot[i] ?? 0,
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
  }

  private regionKey(x: number, y: number): string {
    return `${Math.floor((x - this.scenario.bounds.minX) / REGION_SIZE)},${Math.floor((y - this.scenario.bounds.minY) / REGION_SIZE)}`;
  }

  private cohort(member: Member) {
    const view = this.cohorts.get(
      member.role === "GM" ? null : member.factionId,
    );
    if (!view) throw new Error("Missing authorized view.");
    return view;
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

  /** Apply already-durable grants to a freshly built view (never during a publication). */
  applyControl(control: Control) {
    for (const [memberId, units] of Object.entries(control))
      this.control.set(memberId, new Set(units));
  }

  /** Only units this commander may currently order; a revoked grant disappears with the view. */
  own(member: Member): OwnUnit[] {
    if (member.role === "GM") return this.owners.get(member.id) ?? [];
    const granted = this.control.get(member.id);
    if (!granted) return [];
    return (this.owners.get(member.id) ?? []).filter((unit) =>
      granted.has(unit.id),
    );
  }
  region(member: Member, key: string): ModelMarker[] {
    return this.cohort(member).regions.get(key) ?? [];
  }

  validate(member: Member, edit: UnitEdit): string | null {
    const { unitId, order } = edit;
    const unit = this.units.get(unitId);
    if (
      !unit ||
      unit.army.commander[0] !== member.id ||
      !(this.control.get(member.id)?.has(unitId) ?? false) ||
      !can(member, "order", unit.doc, "units", { parent: unit.army })
    ) {
      return "Unit is not assigned to this commander.";
    }
    if (!order) return null;
    const range = unit.view.modelRange;
    if (!range || unit.own.alive === 0) return "Unit has no living models.";
    const verdict = rules.validateOrder(this.input.ctx, unit.view, order);
    if (!verdict.ok) return verdict.error;
    if (order.kind === "attack") {
      const target = this.units.get(order.targetUnitId);
      // Do not distinguish a hidden, invalid or friendly target in the reply.
      if (
        !target ||
        target.army.factionId === unit.army.factionId ||
        !this.cohort(member).visible.has(order.targetUnitId)
      )
        return "Target is not an available enemy.";
      if (order.mode !== unit.own.weapon)
        return "This unit does not use that attack mode.";
    }
    if (order.kind === "move") {
      const bounds = this.scenario.bounds;
      if (order.path.some(({ x, y }) => !inBounds(bounds, x, y)))
        return "Destination is outside the battlefield.";
      const [start, end] = range;
      const from = { x: this.pool.x[start] ?? 0, y: this.pool.y[start] ?? 0 };
      const infantry = rules.schema.unitTypes.infantry as { move: number };
      const stride = planPF1eStride({
        from,
        path: order.path,
        pace: order.pace,
        movePoints: infantry.move,
        cellFeet: CELL_FEET,
      });
      if (stride.refusal) return stride.refusal;
      const dx = stride.to.x - from.x,
        dy = stride.to.y - from.y;
      for (let i = start; i < end; i++) {
        const x = Math.fround((this.pool.x[i] ?? 0) + dx),
          y = Math.fround((this.pool.y[i] ?? 0) + dy);
        if (
          !simPositionFits(x, STRATEGIC_CODEC) ||
          !simPositionFits(y, STRATEGIC_CODEC) ||
          !inBounds(bounds, Math.round(x * 16) / 16, Math.round(y * 16) / 16)
        )
          return "Formation would extend outside the battlefield.";
      }
    }
    return null;
  }
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
      before.unitId !== model.unitId
    )
      update.push(model);
  }
  if (previous)
    for (const id of previous.keys()) if (!next.has(id)) leave.push(id);
  return { enter, update, leave };
}
