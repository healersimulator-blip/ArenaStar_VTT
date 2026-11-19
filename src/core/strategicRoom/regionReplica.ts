import type { ModelMarker, RegionPatch } from "./protocol";

/** An epoch or cursor mismatch is not a partial update; require a fresh baseline. */
export class RegionReplica {
  epoch = "";
  version = -1;
  cursor: number | null = null;
  models: ReadonlyMap<string, ModelMarker> = new Map();

  clear(epoch: string) {
    this.epoch = epoch;
    this.version = -1;
    this.cursor = null;
    this.models = new Map();
  }

  apply(patch: RegionPatch, expectedVersion: number): boolean {
    if (
      patch.epoch !== this.epoch ||
      patch.version !== expectedVersion ||
      patch.version < this.version ||
      (this.cursor !== null && patch.cursor <= this.cursor) ||
      (patch.fromCursor !== null && patch.fromCursor !== this.cursor)
    )
      return false;
    const models = new Map(patch.fromCursor === null ? [] : this.models);
    for (const id of patch.leave) models.delete(id);
    for (const model of patch.enter) models.set(model.id, model);
    for (const model of patch.update) {
      if (!models.has(model.id)) return false;
      models.set(model.id, model);
    }
    this.models = models;
    this.cursor = patch.cursor;
    this.version = patch.version;
    return true;
  }
}
