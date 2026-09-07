import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("RulesModule in worker (§12)", () => {
  test("package blob-URL import, validation, execution and sandbox probes", async ({ page }) => {
    const webkit = test.info().project.name === "webkit";
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { rulesPackageSmoke: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.rulesPackageSmoke()) as {
        ok: boolean;
        supported: boolean;
        unsupportedReason: string;
        version: string;
        urlScheme: string;
        subPhases: string[];
        orderTypes: string[];
        rulesVersion: string;
        eventTypes: string[];
        sandbox: string[];
        builtinRulesVersion: string;
        syntaxError: string;
        badShapeError: string;
        cpuAbuseError: string;
        error?: string;
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // bad packages never load on any engine
    expect(result.syntaxError).toContain("failed");
    expect(result.badShapeError.length).toBeGreaterThan(0);
    expect(result.cpuAbuseError.length).toBeGreaterThan(0);
    // built-in rules keep running after the package flow on every engine
    expect(result.builtinRulesVersion).toBe("1.0.0");

    if (webkit) {
      // WebKit classic workers cannot import module scripts and CSP-blocks
      // eval: packages degrade cleanly and the sim stays on built-in rules
      expect(result.supported).toBe(false);
      expect(result.unsupportedReason).toContain("rules package");
      return;
    }

    expect(result.supported).toBe(true);
    // the malformed package is rejected by shape validation (not just CSP)
    expect(result.badShapeError).toContain("resolveTurn");
    // schema echo from the real sandboxed sim worker
    expect(result.version).toBe("1.0.0-smoke");
    expect(["blob", "eval"]).toContain(result.urlScheme);
    expect(result.subPhases).toEqual(["probe"]);
    expect(result.orderTypes).toEqual(["probe"]);
    // the custom module actually executed and stamped the report
    expect(result.rulesVersion).toBe("1.0.0-smoke");
    expect(result.eventTypes).toEqual(["probe"]);
    // hardenSandbox held: no network/storage reachability from the package
    expect(result.sandbox).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
    // hostile top-level code hits the host-side CPU limit (termination)
    expect(result.cpuAbuseError).toContain("CPU limit");
  });
});
