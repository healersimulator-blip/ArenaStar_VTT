import { describe, expect, test } from "vitest";
import {
  deriveSeed32,
  evaluateCommitRoll,
  randomSeedHex,
  sha256Hex,
  verifyCommitRoll,
} from "../../src/dice/commitReveal";

const FORMULA = "2d6+3";

const totalOf = async (c: string, h: string): Promise<number> => {
  const res = await evaluateCommitRoll(FORMULA, c, h);
  if (!res.ok) throw new Error(res.error);
  return res.value.total;
};

describe("commitReveal (§11)", () => {
  test("randomSeedHex: 32 hex chars, entropy between calls", () => {
    const a = randomSeedHex();
    const b = randomSeedHex();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toEqual(b);
  });

  test("sha256Hex: known-answer test (empty string + abc)", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("deriveSeed32: 32-bit value from the first 4 bytes, order-sensitive", async () => {
    const c = "00000000000000000000000000000000";
    const h = "ffffffffffffffffffffffffffffffff";
    // SHA-256(`${c}:${h}`) first 4 bytes as big-endian uint32
    const digest = await sha256Hex(`${c}:${h}`);
    const expectHead = Number.parseInt(digest.slice(0, 8), 16) >>> 0;
    expect(await deriveSeed32(c, h)).toBe(expectHead);
    expect(await deriveSeed32(h, c)).not.toBe(expectHead); // concat order matters
  });

  test("evaluateCommitRoll: deterministic and seed-sensitive", async () => {
    const totalA = await totalOf("aa", "bb");
    expect(totalA).toBeGreaterThanOrEqual(5); // 2d6 min 2 + 3
    expect(totalA).toBeLessThanOrEqual(15); // 2d6 max 12 + 3
    expect(await totalOf("aa", "bb")).toBe(totalA);
    expect(await totalOf("ab", "bb")).not.toBe(totalA);
    expect(await totalOf("aa", "ba")).not.toBe(totalA);
  });

  test("verifyCommitRoll: accepts an honest full record", async () => {
    const seedClient = "11111111111111111111111111111111";
    const seedHost = "22222222222222222222222222222222";
    const commit = await sha256Hex(seedClient);
    const res = await verifyCommitRoll({
      formula: FORMULA,
      total: await totalOf(seedClient, seedHost),
      seedClient,
      seedHost,
      commit,
    });
    expect(res.ok).toBe(true);
  });

  test("verifyCommitRoll: rejects commit mismatch (wrong client seed)", async () => {
    const seedClient = "11111111111111111111111111111111";
    const commit = await sha256Hex(seedClient);
    const res = await verifyCommitRoll({
      formula: FORMULA,
      total: await totalOf(seedClient, "22"),
      seedClient: "33333333333333333333333333333333", // never committed
      seedHost: "22",
      commit,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("commitment mismatch");
  });

  test("verifyCommitRoll: rejects total mismatch (rigged record)", async () => {
    const seedClient = "11111111111111111111111111111111";
    const seedHost = "22222222222222222222222222222222";
    const commit = await sha256Hex(seedClient);
    const honest = await totalOf(seedClient, seedHost);
    const res = await verifyCommitRoll({
      formula: FORMULA,
      total: honest === 15 ? 5 : 15, // definitely different
      seedClient,
      seedHost,
      commit,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("total mismatch");
  });

  test("verifyCommitRoll: rejects records without commit or seeds", async () => {
    const seedClient = "11111111111111111111111111111111";
    const seedHost = "22222222222222222222222222222222";
    const total = await totalOf(seedClient, seedHost);
    expect(
      (
        await verifyCommitRoll({
          formula: FORMULA,
          total,
          seedClient,
          seedHost,
          commit: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await verifyCommitRoll({
          formula: FORMULA,
          total,
          seedClient: null,
          seedHost,
          commit: await sha256Hex(seedClient),
        })
      ).ok,
    ).toBe(false);
  });
});
