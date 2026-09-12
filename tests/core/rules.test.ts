/**
 * P01 — the shared scene scale.
 *
 * `sceneCellFeet` lives next to `RulesGridContext` because both sides of the sim
 * boundary derive their own cell conversions from it: the host deploys formations
 * at this spacing and writes it into `ctx.grid.distance`, and a system package
 * (PF1e's spatial hash and its square-based flanking pass) reads the same number.
 * These tests pin the derivation itself, including the cases a scene document can
 * actually produce — the grid distance is authored data, so "missing", `0`,
 * negative, `NaN` and a string all have to resolve to the standard square rather
 * than to a second convention.
 */
import { describe, expect, test } from "vitest";
import { sceneCellFeet } from "../../src/core/rules";

describe("sceneCellFeet (P01)", () => {
  test("a usable authored distance is the scale, unchanged", () => {
    expect(sceneCellFeet(5)).toBe(5);
    expect(sceneCellFeet(10)).toBe(10);
    expect(sceneCellFeet(1.5)).toBe(1.5); // a hex-ish or custom scene, still authored data
    expect(sceneCellFeet(0.5)).toBe(0.5);
  });

  test("everything a scene document can be missing degrades to the standard 5-ft square", () => {
    expect(sceneCellFeet(undefined)).toBe(5); // no scene, or a scene with no grid
    expect(sceneCellFeet(null)).toBe(5);
    expect(sceneCellFeet(0)).toBe(5);
    expect(sceneCellFeet(-5)).toBe(5);
    expect(sceneCellFeet(Number.NaN)).toBe(5);
    expect(sceneCellFeet(Number.POSITIVE_INFINITY)).toBe(5);
    // Authored data is unvalidated JSON, so a string is a shape the caller can see.
    expect(sceneCellFeet("5")).toBe(5);
    expect(sceneCellFeet({ distance: 5 })).toBe(5);
  });

  test("the fallback is the rule's own square, not the deployer's legacy 4 ft", () => {
    // Gap List §2.15 named the deployer's generic 4-ft spacing as the drift: a scene
    // with no usable distance must not silently deploy off the rules' own square.
    expect(sceneCellFeet(undefined)).not.toBe(4);
    expect(sceneCellFeet(undefined)).toBe(5);
  });
});
