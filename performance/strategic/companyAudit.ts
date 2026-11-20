/** Offline audit of this fixture's committed checkpoints. Read-only and outside the timed path. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { PostgresRoom } from "../../services/strategic-room/src/postgres";
import {
  checkpointPool,
  type Published,
} from "../../services/strategic-room/src/state";

export async function auditCompanies(
  db: string,
  roomId: string,
  seats: number,
  turns: number,
  march: boolean,
) {
  // pg is a dependency of the service workspace, not the standalone load generator.
  const { Pool } = createRequire(
    resolve("services/strategic-room/package.json"),
  )("pg");
  const dbPool: PostgresRoom["pool"] = new Pool({
    connectionString: db,
    max: 1,
  });
  let previous: ReturnType<typeof checkpointPool> | undefined;
  try {
    for (let version = 0; version <= turns; version++) {
      const { rows } = await dbPool.query<Published>(
        'SELECT version, checkpoint AS bytes,hp_max AS "maxHpMax",pool_hash AS hash,units FROM strategic_versions WHERE room_id=$1 AND version=$2',
        [roomId, version],
      );
      const state = rows[0];
      assert(state);
      const p = checkpointPool(state);
      assert.equal(p.count, seats * 100);
      assert.equal(state.units.length, seats);
      let moved = 0;
      const cells = new Set<string>();
      for (let u = 0; u < seats; u++) {
        const base = u * 100;
        assert.deepEqual(state.units[u]?.range, [base, base + 100]);
        const x = p.x[base],
          y = p.y[base];
        assert(x !== undefined && y !== undefined);
        if (previous) {
          const px = previous.x[base],
            py = previous.y[base];
          assert(px !== undefined && py !== undefined);
          const d = Math.hypot(x - px, y - py);
          assert(d <= 20.05, "march exceeded 20 ft + checkpoint quantization");
          if (d > 0) moved++;
        }
        for (let i = 0; i < 100; i++) {
          const n = base + i;
          assert.equal(p.id[n], previous?.id[n] ?? n + 1);
          assert.equal(p.unitIdx[n], u);
          const mx: number = x - 5 * Math.floor(i / 10),
            my: number = y + 5 * (i % 10);
          assert.equal(p.x[n], mx);
          assert.equal(p.y[n], my);
          cells.add(`${Math.floor(mx / 5)},${Math.floor(my / 5)}`);
        }
      }
      assert.equal(cells.size, p.count, "cross-company cell overlap");
      if (version > 0) {
        if (march) assert(moved > 0, "march did no work");
        else assert.equal(moved, 0);
      }
      console.log(
        JSON.stringify({
          stage: "checkpoint-audit",
          version,
          models: p.count,
          companies: seats,
          moved,
          modelsBeyondFirstPerCell: p.count - cells.size,
        }),
      );
      previous = p;
    }
  } finally {
    await dbPool.end();
  }
}
