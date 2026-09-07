import { describe, expect, test } from "vitest";
import { PF1eBattleAnalyticsCollector, exportAnalyticsToCsv } from "../../src/packages/pf1e/analytics";

describe("PF1e Battle Analytics & Reporter (§12 / Task 6)", () => {
  test("collects metrics and formats RFC-4180 CSV export", () => {
    const collector = new PF1eBattleAnalyticsCollector();
    collector.recordCombat("unit-1", {
      totalAttacks: 20,
      hits: 15,
      misses: 5,
      critThreats: 3,
      critsConfirmed: 2,
      misfiresCount: 0,
      rawDamageDealt: 120,
      drAbsorbed: 15,
      drBypassed: 5,
      srBlocked: 0,
      netDamageDealt: 105,
      nonlethalDealt: 0,
      killsCount: 4,
      aooExecuted: 1,
      aooHits: 1,
      cmbSuccesses: 0,
    });

    const report = collector.generateReport();
    expect(report.totals.totalAttacks).toBe(20);
    expect(report.totals.hits).toBe(15);
    expect(report.totals.hitPercentage).toBe(75);

    const csv = exportAnalyticsToCsv(report);
    expect(csv).toContain("Unit ID,Attacks,Hits,Misses,Hit %");
    expect(csv).toContain("unit-1,20,15,5,75");
  });
});
