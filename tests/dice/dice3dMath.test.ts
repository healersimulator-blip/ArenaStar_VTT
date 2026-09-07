import { describe, expect, test } from "vitest";
import {
  diceFromTerms,
  fillerLabels,
  MAX_3D_DICE,
  orientationForTopFace,
  planDieFaces,
  type CubeFace,
} from "../../src/dice/dice3dMath";

describe("orientationForTopFace (§11)", () => {
  test("identity for the top face; unit quaternions otherwise", () => {
    expect(orientationForTopFace(2)).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    for (const face of [0, 1, 3, 4, 5] as CubeFace[]) {
      const q = orientationForTopFace(face);
      const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
      expect(Math.abs(len - 1)).toBeLessThan(1e-9);
    }
  });

  test("rotations actually bring their face to +y (basis-vector check)", () => {
    const apply = (
      q: { x: number; y: number; z: number; w: number },
      v: [number, number, number],
    ): [number, number, number] => {
      // v' = q * v * q̄  (v as pure quaternion)
      const [x, y, z] = v;
      const { x: qx, y: qy, z: qz, w: qw } = q;
      // t = q ⊗ v (v as pure quaternion)
      const tw = -(qx * x + qy * y + qz * z);
      const tx = qw * x + qy * z - qz * y;
      const ty = qw * y + qz * x - qx * z;
      const tz = qw * z + qx * y - qy * x;
      // v' = t ⊗ q̄  with q̄ = (qw, −u)
      return [
        qw * tx - tw * qx - (ty * qz - tz * qy),
        qw * ty - tw * qy - (tz * qx - tx * qz),
        qw * tz - tw * qz - (tx * qy - ty * qx),
      ];
    };
    const faceNormals: Record<CubeFace, [number, number, number]> = {
      0: [1, 0, 0],
      1: [-1, 0, 0],
      2: [0, 1, 0],
      3: [0, -1, 0],
      4: [0, 0, 1],
      5: [0, 0, -1],
    };
    for (const face of [0, 1, 2, 3, 4, 5] as CubeFace[]) {
      const rotated = apply(orientationForTopFace(face), faceNormals[face]);
      expect(rotated[0]).toBeCloseTo(0, 9);
      expect(rotated[1]).toBeCloseTo(1, 9);
      expect(rotated[2]).toBeCloseTo(0, 9);
    }
  });
});

describe("planDieFaces + fillerLabels (§11)", () => {
  test("the chosen slot carries the rolled value and ends on top", () => {
    const plan = planDieFaces(20, 17, 4);
    expect(plan.labels[4]).toBe(17);
    expect(plan.labels.filter((l) => l >= 1 && l <= 20)).toHaveLength(6);
    expect(plan.value).toBe(17);
    const d6 = planDieFaces(6, 3, 1);
    expect(new Set(d6.labels).size).toBeGreaterThanOrEqual(5);
  });

  test("fillers stay in range and avoid the top value", () => {
    const f = fillerLabels(6, 4);
    expect(f).toHaveLength(5);
    for (const v of f) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });
});

describe("diceFromTerms (§11)", () => {
  test("kept values of dice terms become dice; math terms ignored", () => {
    const dice = diceFromTerms([
      { kind: "dice", expr: "2d6kh1", rolls: [2, 5], kept: [5], total: 5 },
      { kind: "dice", expr: "1d20", rolls: [14], kept: [14], total: 14 },
      { kind: "fn", name: "max", args: [5, 14] },
      { kind: "number" },
    ]);
    expect(dice).toEqual([
      { sides: 6, value: 5 },
      { sides: 20, value: 14 },
    ]);
  });

  test("caps the scene at 8 dice; garbage rejected", () => {
    const many = diceFromTerms([
      { kind: "dice", expr: "20d4", kept: Array.from({ length: 20 }, (_, i) => i + 1), total: 40 },
    ]);
    expect(many).toHaveLength(MAX_3D_DICE);
    expect(diceFromTerms([{ kind: "dice", expr: "weird", kept: [3] }])).toEqual([]);
    expect(diceFromTerms([{ kind: "dice", expr: "1d1", kept: [1] }])).toEqual([]);
    expect(diceFromTerms([null, 5, "x"])).toEqual([]);
  });
});
