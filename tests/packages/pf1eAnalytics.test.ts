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

  test("a comma or quote in a unit id cannot corrupt the CSV (RFC-4180, Gap List §Analytics)", () => {
    const collector = new PF1eBattleAnalyticsCollector();
    collector.recordCombat('2nd Battalion, "Iron" Guard', {
      totalAttacks: 3,
      hits: 2,
      misses: 1,
      critThreats: 0,
      critsConfirmed: 0,
      misfiresCount: 0,
      rawDamageDealt: 9,
      drAbsorbed: 0,
      drBypassed: 0,
      netDamageDealt: 9,
      nonlethalDealt: 0,
      killsCount: 1,
      aooExecuted: 0,
      aooHits: 0,
      cmbSuccesses: 0,
    });
    const csv = exportAnalyticsToCsv(collector.generateReport());
    // The id is quoted with embedded quotes doubled; the numeric columns stay intact.
    expect(csv).toContain('"2nd Battalion, ""Iron"" Guard",3,2,1');
    const row = csv.split("\n").find((l) => l.startsWith('"2nd Battalion')) ?? "";
    // Header and row have the same column count — the comma broke nothing.
    expect(row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length).toBe(csv.split("\n")[0]?.split(",").length);
  });

  test("recordSpellKills books deathsCount on the unit that lost models, not the caster (D-165)", () => {
    const collector = new PF1eBattleAnalyticsCollector();
    collector.recordSpellKills("unit-2", 3);
    collector.recordSpellKills("unit-2", 0); // no-op, must not invent an entry side effect
    const report = collector.generateReport();
    expect(report.units["unit-2"]?.deathsCount).toBe(3);
    expect(report.totals.deathsCount).toBe(3);
    // The caster's killsCount ledger is untouched by the deaths-side recording.
    expect(report.units["unit-2"]?.killsCount).toBe(0);
  });

  test("recordSpell rolls defensive-cast AoO counters into the unit ledger (D-170)", () => {
    const collector = new PF1eBattleAnalyticsCollector();
    collector.recordSpell("caster-1", {
      modelsTargeted: 3,
      modelsBlockedByCover: 0,
      savesPassed: 1,
      savesFailed: 2,
      srBlocked: 0,
      damageDealt: 18,
      killsCount: 1,
      concentrationPassed: 0,
      concentrationFailed: 1,
      spellInterrupted: false,
      aooExecuted: 2,
      aooHits: 1,
    });
    const report = collector.generateReport();
    expect(report.units["caster-1"]?.aooExecuted).toBe(2);
    expect(report.units["caster-1"]?.aooHits).toBe(1);
    expect(report.totals.aooExecuted).toBe(2);
    expect(report.totals.aooHits).toBe(1);
  });
});
