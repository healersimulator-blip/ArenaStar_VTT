import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  MARKER_COUNT_BYTES,
  MARKER_POINT_BYTES,
  MAX_VIEW_BYTES,
  MAX_VIEW_META_BYTES,
  STRATEGIC_VIEW_TYPE,
  type BaselineMeta,
  type MarkerLabels,
  type UnitMarker,
} from "../../src/core/strategicRoom/protocol";
import {
  decodeView,
  MissingViewMarkers,
  readView,
} from "../../src/core/strategicRoom/viewWire";
import { BattleView } from "../../services/strategic-room/src/battle";
import {
  deploy,
  generatedScenario,
} from "../../services/strategic-room/src/scenario";
import type { Member } from "../../services/strategic-room/src/state";
import {
  packMarkers,
  viewPrefix,
} from "../../services/strategic-room/src/viewEncoding";

const meta: BaselineMeta = {
  epoch: "current-epoch",
  head: { turnId: 1, version: 4, phase: "report", deadlineMs: null },
  name: "Северная переправа",
  bounds: { minX: 4000, minY: -9000, maxX: 8000, maxY: -6000 },
  role: "PLAYER",
  factionId: "blue",
  factions: [
    { id: "blue", name: "Blue", color: "#72bbff" },
    { id: "red", name: "Red", color: "#ff887e" },
  ],
  own: [{ id: "own", name: "Гвардия", at: null, alive: 0, weapon: "melee" }],
  orders: { revision: 3, edits: [{ unitId: "own", order: null }] },
};
const markers: UnitMarker[] = [
  {
    id: "enemy",
    name: "赤",
    factionId: "red",
    at: { x: 4096 + 2 / 3, y: -8192.125 },
  },
  {
    id: "ally",
    name: 'Гвардия "Север"',
    factionId: "blue",
    at: { x: 4166.5, y: -7933.03125 },
  },
];
const blue: Member = {
  id: "commander-1",
  epoch: 1,
  role: "PLAYER",
  factionId: "blue",
};
const gm: Member = { id: "gm", epoch: 1, role: "GM", factionId: null };

function frame(meta: BaselineMeta, packed: Uint8Array = Buffer.alloc(0)) {
  const prefix = viewPrefix(meta, packed.byteLength);
  if (!prefix) throw new Error("Test frame out of bounds.");
  return Buffer.concat([prefix, packed]);
}

function read(
  body: Uint8Array<ArrayBuffer>,
  contentType = STRATEGIC_VIEW_TYPE,
) {
  return readView(
    new Response(body, { headers: { "content-type": contentType } }),
  );
}

describe("hosted compact views", () => {
  test("round-trips private metadata and exact visible positions without compressing private fields", async () => {
    const packed = packMarkers(markers, meta.factions);
    const plain = gunzipSync(packed);
    expect(plain.readUInt32BE(0)).toBe(2);
    const labelsOffset = MARKER_COUNT_BYTES + 2 * MARKER_POINT_BYTES;
    const labels = JSON.parse(
      plain.toString("utf8", labelsOffset),
    ) as MarkerLabels;
    expect(labels).toEqual([
      ["enemy", "ally"],
      markers.map((m) => m.name),
      [1, 0],
    ]);
    expect(plain.readDoubleBE(MARKER_COUNT_BYTES)).toBe(4096 + 2 / 3);
    expect(plain.readDoubleBE(MARKER_COUNT_BYTES + 8)).toBe(-8192.125);
    const expected = { ...meta, markers };
    expect(await read(frame(meta, packed))).toEqual(expected);
    expect(
      await read(
        new TextEncoder().encode(JSON.stringify(expected)),
        "application/json; charset=utf-8",
      ),
    ).toEqual(expected);
  });

  test("reuses markers across turn changes only with the exact epoch, version and cohort", async () => {
    const base = { ...meta, markers };
    const next: BaselineMeta = {
      ...meta,
      head: { ...meta.head, turnId: 2, phase: "orders" },
      orders: { revision: 0, edits: [] },
    };
    const response = frame(next);
    const opened = await decodeView(response, STRATEGIC_VIEW_TYPE, base);
    expect(opened.markers).toBe(markers);
    expect(opened.head).toEqual(next.head);
    expect(opened.orders).toEqual(next.orders);
    for (const wrong of [
      undefined,
      { ...base, epoch: "stale-epoch" },
      { ...base, head: { ...base.head, version: base.head.version - 1 } },
      { ...base, role: "GM" as const },
      { ...base, factionId: "red" },
    ])
      await expect(
        decodeView(response, STRATEGIC_VIEW_TYPE, wrong),
      ).rejects.toBeInstanceOf(MissingViewMarkers);
    // An authorized empty cohort is still a full snapshot, not a cache reference.
    expect(
      (await read(frame(next, packMarkers([], meta.factions)))).markers,
    ).toEqual([]);
  });

  test("rejects corrupt frames, invalid columns and oversized compressed or inflated bodies", async () => {
    const packed = packMarkers(markers, meta.factions);
    const valid = frame(meta, packed);
    const trailing = Buffer.concat([valid, Buffer.of(0)]);
    const plain = gunzipSync(packed);
    const points = plain.subarray(
      0,
      MARKER_COUNT_BYTES + 2 * MARKER_POINT_BYTES,
    );
    const badColumns = Buffer.concat([
      points,
      Buffer.from(JSON.stringify([["a"], ["b"], [0]])),
    ]);
    const badFaction = Buffer.concat([
      points,
      Buffer.from(
        JSON.stringify([
          ["a", "b"],
          ["A", "B"],
          [0, 2],
        ]),
      ),
    ]);
    const cases = [
      valid.subarray(0, valid.length - 1),
      trailing,
      frame(meta, packed.subarray(0, packed.length - 1)),
      frame(meta, gzipSync(badColumns)),
      frame(meta, gzipSync(badFaction)),
      frame(meta, gzipSync(Buffer.alloc(MAX_VIEW_BYTES + 1, 0x20))),
      new Uint8Array(MAX_VIEW_BYTES + 1),
    ];
    for (const invalid of cases) await expect(read(invalid)).rejects.toThrow();
    expect(
      viewPrefix({ ...meta, name: "a".repeat(MAX_VIEW_META_BYTES) }, 0),
    ).toBeNull();
  });

  test("shares encoded fog projections only within the authorized cohort", async () => {
    const scenario = generatedScenario(4, 5);
    const hidden = scenario.commanders[1]?.units[0];
    if (!hidden) throw new Error("Missing hidden fixture");
    hidden.anchor.y = scenario.bounds.maxY - 25;
    hidden.name = "Hidden scout";
    const view = new BattleView(scenario, deploy(scenario), new Uint8Array(32));
    expect(view.packedMarkers(blue)).toBe(
      view.packedMarkers({ ...blue, id: "commander-3" }),
    );
    const projected = await read(frame(meta, view.packedMarkers(blue)));
    expect(projected.markers).toEqual(view.markers(blue));
    expect(projected.markers.some((m) => m.id === hidden.id)).toBe(false);
    expect(view.markers(gm).some((m) => m.id === hidden.id)).toBe(true);
    expect(view.packedMarkers(blue)).not.toEqual(view.packedMarkers(gm));
  });

  test.each([5, 10])(
    "fits the default marker budget on the generated 50k dense field (%i units/commander)",
    async (units) => {
      const scenario = generatedScenario(500, units, "dense");
      const view = new BattleView(
        scenario,
        deploy(scenario),
        new Uint8Array(32),
      );
      const body = frame(
        { ...meta, own: view.own(blue), factions: scenario.factions },
        view.packedMarkers(blue),
      );
      expect(body.byteLength).toBeLessThan(128 * 1024);
      expect((await read(body)).markers).toEqual(view.markers(blue));
    },
  );
});
