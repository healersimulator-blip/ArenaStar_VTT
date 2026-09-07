import { describe, expect, test } from "vitest";
import { detectCapabilities } from "../../src/app/capabilities";

describe("detectCapabilities", () => {
  test("reports every capability as an explicit boolean", () => {
    const caps = detectCapabilities();
    const values = Object.values(caps);
    expect(values).toHaveLength(7);
    for (const value of values) expect(typeof value).toBe("boolean");
  });

  test("is safe in non-browser environments (no throw, feature-detected)", () => {
    expect(() => detectCapabilities()).not.toThrow();
  });

  test("node test environment provides WebCrypto", () => {
    expect(detectCapabilities().webcrypto).toBe(true);
  });
});
