import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  MARKER_COUNT_BYTES,
  MARKER_POINT_BYTES,
  MAX_VIEW_BYTES,
  MAX_VIEW_META_BYTES,
  STRATEGIC_VIEW_TYPE,
  STRATEGIC_PATCH_TYPE,
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
  packMarkerChanges,
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

  test("applies one publication of exact changes, retains runs and drops concealed rows", async () => {
    const before = Array.from({ length: 8 }, (_, i): UnitMarker => ({
      id: `id-${i}`,
      name: `N${i}`,
      factionId: "red",
      at: { x: i, y: -i },
    }));
    const after = before
      .map((m, i) =>
        i === 2
          ? { ...m, at: { ...m.at, y: -8192.125 } }
          : i === 3
            ? { ...m, at: { ...m.at, x: 4096 + 2 / 3 } }
            : i === 4
              ? { ...m, at: { x: 10, y: 20 } }
              : m,
      )
      .filter((_, i) => i !== 5);
    const base = { ...meta, markers: before };
    const next = {
      ...meta,
      head: { ...meta.head, version: meta.head.version + 1 },
      orders: { revision: 0, edits: [] },
    };
    const changes = packMarkerChanges(before, after, 1000);
    if (!changes) throw new Error("Expected patch");
    const readPatch = (b = changes, previous: typeof base | undefined = base) =>
      decodeView(frame(next, b), STRATEGIC_PATCH_TYPE, previous);
    const applied = await readPatch();
    expect(applied).toEqual({ ...next, markers: after });
    expect(applied.markers[0]).toBe(before[0]);
    expect(base.markers[3]?.at.x).toBe(3);
    for (const wrong of [
      { ...base, epoch: "stale" },
      { ...base, role: "GM" as const },
      { ...base, factionId: "red" },
      { ...base, head: next.head },
      { ...base, markers: [] },
    ]) {
      await expect(readPatch(changes, wrong)).rejects.toBeInstanceOf(
        MissingViewMarkers,
      );
    }
    await expect(
      decodeView(frame(next, changes), STRATEGIC_PATCH_TYPE),
    ).rejects.toBeInstanceOf(MissingViewMarkers);
    expect((await readPatch(packMarkerChanges(before, [], 4))).markers).toEqual(
      [],
    );
    const first = before[0];
    if (!first) throw new Error("Missing first marker");
    for (const incompatible of [
      [{ ...first, id: "new" }],
      [{ ...first, name: "renamed" }],
      [{ ...first, factionId: "blue" }],
      before.slice().reverse(),
    ])
      expect(packMarkerChanges(before, incompatible, 1000)).toBeUndefined();
    expect(
      packMarkerChanges(before, after, changes.length - 1),
    ).toBeUndefined();
    for (const corrupt of [
      changes.subarray(0, -1),
      Buffer.concat([changes, Buffer.from([0, 0, 0, 1])]),
      Buffer.from([0, 8, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0, 8, 0, 1, 0, 7, 0, 2]),
    ])
      await expect(readPatch(corrupt)).rejects.toThrow();
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

  test("carries a 500-seat GM roster in the metadata head", async () => {
    // The GM view is the only one with `members`; a big room must not be rejected as oversized
    // metadata just because 500 seats × their deployment are listed.
    const seats = Array.from({ length: 500 }, (_, i) => ({
      id: `commander-${i + 1}`,
      name: `Commander ${i + 1} with a fairly long display name`,
      role: "PLAYER" as const,
      factionId: i % 2 ? "red" : "blue",
      units: Array.from({ length: 5 }, (_, u) => `unit-${(i % 2) + 1}-${i * 5 + u + 1}`),
      deployed: Array.from({ length: 5 }, (_, u) => `unit-${(i % 2) + 1}-${i * 5 + u + 1}`),
      claimed: true,
      invite: null,
      online: i < 7,
    }));
    const head = { ...meta, members: seats };
    expect(Buffer.byteLength(JSON.stringify(head))).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(head))).toBeLessThan(MAX_VIEW_META_BYTES);
    const packed = packMarkers(markers, meta.factions);
    const decoded = await read(Uint8Array.from(frame(head, packed)));
    expect(decoded.members).toHaveLength(500);
    expect(decoded.markers).toHaveLength(markers.length);
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
