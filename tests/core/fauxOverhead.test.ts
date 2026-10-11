/* eslint-disable @typescript-eslint/no-non-null-assertion -- explicit fixtures and required renderer readbacks; absence fails the test */
import { expect, test } from "vitest";
import type { RegionDocument, SceneDocument } from "../../src/core/documents";
import {
  compileOverhead,
  fauxOverheadError,
  overheadAffects,
  overheadCoversPoint,
} from "../../src/core/fauxOverhead";
import { regionGeometryError } from "../../src/core/regionGeometry";
import {
  regionTransactionError,
  sceneRegionsError,
} from "../../src/core/regionValidation";
import { pickToken } from "../../src/canvas/interactions";

export const coverRegion = (): RegionDocument => ({
  _id: "roof",
  type: "region",
  name: "Roof",
  ownership: { default: 1 },
  flags: {},
  system: {},
  x: 100,
  y: 200,
  width: 200,
  height: 100,
  shape: {
    kind: "polygon",
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  },
  fauxOverhead: {
    kind: "fauxOverhead",
    coverZ: 10,
    affectedElevation: { bottom: 0, top: 10 },
  },
});
test("native covers gate by feet elevation, not selection order or legacy trigger ranges", () => {
  const region = coverRegion();
  region.triggerElevation = { min: 50, max: 60 };
  const covers = compileOverhead([region]);
  expect(overheadAffects(covers[0]!, {})).toBe(true);
  expect(overheadAffects(covers[0]!, { elevation: -1 })).toBe(false);
  expect(overheadAffects(covers[0]!, { elevation: 10 })).toBe(false);
  expect(overheadCoversPoint(covers, {}, { x: 150, y: 220 })).toBe(true);
  expect(
    overheadCoversPoint(covers, { elevation: 10 }, { x: 150, y: 220 }),
  ).toBe(false);
  expect(overheadCoversPoint(covers, {}, { x: 0, y: 220 })).toBe(false);
  expect(regionGeometryError(region)).toBeNull();
});
test("rotated non-square regions use the same centered local frame as authored regions", () => {
  const region = coverRegion();
  region.rotation = 90;
  const covers = compileOverhead([region]);
  expect(overheadCoversPoint(covers, {}, { x: 200, y: 160 })).toBe(true);
  expect(overheadCoversPoint(covers, {}, { x: 110, y: 250 })).toBe(false);
});
test("concave footprint is independent of the legacy convex automation trigger", () => {
  const region = coverRegion();
  region.fauxOverhead!.footprint = {
    version: 2,
    components: [
      {
        outer: region.shape.points.map(([x, y]) => ({ x, y })),
        holes: [
          [
            { x: 0.2, y: 0.2 },
            { x: 0.8, y: 0.2 },
            { x: 0.8, y: 0.8 },
            { x: 0.2, y: 0.8 },
          ],
        ],
      },
    ],
  };
  const before = structuredClone(region);
  const covers = compileOverhead([region]);
  expect(overheadCoversPoint(covers, {}, { x: 200, y: 250 })).toBe(false);
  expect(overheadCoversPoint(covers, {}, { x: 110, y: 210 })).toBe(true);
  expect(region).toEqual(before);
});
test("invalid and private mask definitions are rejected at the document boundary", () => {
  expect(fauxOverheadError(null)).not.toBeNull();
  expect(
    fauxOverheadError({ ...coverRegion().fauxOverhead, coverZ: NaN }),
  ).not.toBeNull();
  expect(regionGeometryError({ ...coverRegion(), hidden: true })).toContain(
    "public",
  );
  expect(
    regionGeometryError({
      ...coverRegion(),
      ownership: { default: 1, player: 0 },
    }),
  ).toContain("public");
  expect(sceneRegionsError({ regions: {} })).toContain("array");
  expect(
    sceneRegionsError({ regions: Array.from({ length: 129 }, coverRegion) }),
  ).toContain("budget");
});
test("staged validation closes dotted-path, whole-scene and multi-op permission bypasses", () => {
  const region = coverRegion();
  const scene = {
    _id: "scene",
    type: "scene",
    regions: [region],
  } as SceneDocument;
  const ref = {
    coll: "regions" as const,
    id: "roof",
    parent: { coll: "scenes" as const, id: "scene" },
  };
  const resolve = () => scene;
  expect(
    regionTransactionError(
      [
        {
          kind: "update",
          ref,
          diff: { "fauxOverhead.affectedElevation.top": -1 },
        },
      ],
      resolve,
    ),
  ).toContain("bottom < top");
  expect(
    regionTransactionError(
      [
        {
          kind: "update",
          ref: ref.parent,
          diff: { "regions.0.fauxOverhead.coverZ": null },
        },
      ],
      resolve,
    ),
  ).toContain("height");
  const plain = { ...region };
  delete plain.fauxOverhead;
  scene.regions = [plain];
  expect(
    regionTransactionError(
      [
        {
          kind: "update",
          ref,
          diff: { fauxOverhead: region.fauxOverhead as never },
        },
        { kind: "update", ref, diff: { "ownership.default": 0 } },
      ],
      resolve,
    ),
  ).toContain("public");
  expect(scene.regions[0]!.fauxOverhead).toBeUndefined();
  expect(
    regionTransactionError(
      [
        {
          kind: "update",
          ref,
          diff: { fauxOverhead: region.fauxOverhead as never },
        },
      ],
      resolve,
    ),
  ).toBeNull();
});
test("pointer picking skips covered foreground tokens and can select uncovered tokens behind", () => {
  const token = {
    _id: "front",
    x: 100,
    y: 100,
    width: 100,
    height: 100,
  } as never;
  const views = [
    { token: { ...(token as object), _id: "back" } as never, sceneId: "scene" },
    { token, sceneId: "scene" },
  ];
  expect(
    pickToken(views, { x: 100, y: 100 }, undefined, (id) => id !== "front")
      ?.token._id,
  ).toBe("back");
  expect(
    pickToken(views, { x: 100, y: 100 }, undefined, () => false),
  ).toBeUndefined();
});
