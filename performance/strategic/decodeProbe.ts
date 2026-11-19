/** Where the per-browser decode cost goes, and what a real browser-facing number looks like. */
import { gunzipSync } from "node:zlib";
import { generatedScenario } from "../../services/strategic-room/src/scenario";
import {
  packMarkers,
  viewPrefix,
} from "../../services/strategic-room/src/viewEncoding";
import { decodeView } from "../../src/core/strategicRoom/viewWire";
import {
  MARKER_COUNT_BYTES,
  MARKER_POINT_BYTES,
  STRATEGIC_VIEW_TYPE,
  type BaselineMeta,
  type UnitMarker,
} from "../../src/core/strategicRoom/protocol";

const scenario = generatedScenario(500, 10, "mixed");
const markers: UnitMarker[] = scenario.commanders.flatMap((c) =>
  c.units.map((u) => ({
    id: u.id,
    name: u.name,
    factionId: c.factionId,
    at: u.anchor,
  })),
);
const packed = packMarkers(markers, scenario.factions);
const meta: BaselineMeta = {
  epoch: "e",
  head: { turnId: 1, version: 1, phase: "report", deadlineMs: null },
  name: scenario.name,
  bounds: scenario.bounds,
  role: "PLAYER",
  factionId: "blue",
  factions: scenario.factions,
  own: [],
  orders: { revision: 0, edits: [] },
};
const prefix = viewPrefix(meta, packed.byteLength);
if (!prefix) throw new Error("Fixture view prefix exceeds the wire limit.");
const body = new Uint8Array(prefix.byteLength + packed.byteLength);
body.set(prefix);
body.set(packed, prefix.byteLength);

const median = (v: number[]) =>
  [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
const time = async (label: string, runs: number, fn: () => unknown) => {
  for (let i = 0; i < 3; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  console.log(
    JSON.stringify({
      label,
      runs,
      p50Ms: +median(samples).toFixed(2),
      totalMs: +samples.reduce((a, b) => a + b, 0).toFixed(0),
    }),
  );
};

const inflated = gunzipSync(packed);
const labelsOffset = MARKER_COUNT_BYTES + markers.length * MARKER_POINT_BYTES;
console.log(
  JSON.stringify({
    wireBytes: body.byteLength,
    gzipMarkerBytes: packed.byteLength,
    inflatedBytes: inflated.byteLength,
    labelJsonBytes: inflated.byteLength - labelsOffset,
    markerCount: markers.length,
  }),
);

await time("full decode (stream + inflate + parse + 5000 objects)", 100, () =>
  decodeView(body.slice() as Uint8Array<ArrayBuffer>, STRATEGIC_VIEW_TYPE),
);
await time("inflate only (stream)", 100, async () => {
  const stream = new Blob([new Uint8Array(packed)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.byteLength !== inflated.byteLength) throw new Error("bad");
});
await time("JSON.parse label table only", 100, () => {
  const labels = JSON.parse(
    Buffer.from(inflated.subarray(labelsOffset)).toString("utf8"),
  ) as unknown[];
  if (labels.length !== 3) throw new Error("bad");
});
await time("build 5000 marker objects", 100, () => {
  const view = new DataView(
    inflated.buffer,
    inflated.byteOffset,
    inflated.byteLength,
  );
  const out: unknown[] = new Array(markers.length);
  for (let i = 0; i < markers.length; i++) {
    const pos = MARKER_COUNT_BYTES + i * MARKER_POINT_BYTES;
    out[i] = {
      id: "x",
      name: "y",
      factionId: "blue",
      at: { x: view.getFloat64(pos), y: view.getFloat64(pos + 8) },
    };
  }
  if (out.length !== markers.length) throw new Error("bad");
});
