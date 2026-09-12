/**
 * Battle Analytics & Detailed Combat Reporter (Combat_Resolver_5 Parity & High-Fidelity PF1e Metrics).
 */
import type { PF1eCombatMetrics } from "./combatEngine";
import type { PF1eSpellMetrics } from "./spells";

export interface UnitAnalyticsSummary {
  unitId: string;
  totalAttacks: number;
  hits: number;
  misses: number;
  hitPercentage: number;
  critThreats: number;
  critsConfirmed: number;
  misfiresCount: number;
  rawDamageDealt: number;
  drAbsorbed: number;
  drBypassed: number;
  srBlocked: number;
  netDamageDealt: number;
  damageHealed: number;
  killsCount: number;
  deathsCount: number;
  savesPassed: number;
  savesFailed: number;
  aooExecuted: number;
  aooHits: number;
  cmbSuccesses: number;
  concentrationPassed: number;
  concentrationFailed: number;
}

export interface PF1eBattleReport {
  totals: UnitAnalyticsSummary;
  units: Record<string, UnitAnalyticsSummary>;
}

export class PF1eBattleAnalyticsCollector {
  private unitsMap = new Map<string, UnitAnalyticsSummary>();

  private ensureUnit(unitId: string): UnitAnalyticsSummary {
    let entry = this.unitsMap.get(unitId);
    if (!entry) {
      entry = {
        unitId,
        totalAttacks: 0,
        hits: 0,
        misses: 0,
        hitPercentage: 0,
        critThreats: 0,
        critsConfirmed: 0,
        misfiresCount: 0,
        rawDamageDealt: 0,
        drAbsorbed: 0,
        drBypassed: 0,
        srBlocked: 0,
        netDamageDealt: 0,
        damageHealed: 0,
        killsCount: 0,
        deathsCount: 0,
        savesPassed: 0,
        savesFailed: 0,
        aooExecuted: 0,
        aooHits: 0,
        cmbSuccesses: 0,
        concentrationPassed: 0,
        concentrationFailed: 0,
      };
      this.unitsMap.set(unitId, entry);
    }
    return entry;
  }

  recordCombat(unitId: string, metrics: PF1eCombatMetrics): void {
    const entry = this.ensureUnit(unitId);
    entry.totalAttacks += metrics.totalAttacks;
    entry.hits += metrics.hits;
    entry.misses += metrics.misses;
    entry.critThreats += metrics.critThreats;
    entry.critsConfirmed += metrics.critsConfirmed;
    entry.misfiresCount += metrics.misfiresCount;
    entry.rawDamageDealt += metrics.rawDamageDealt;
    entry.drAbsorbed += metrics.drAbsorbed;
    entry.drBypassed += metrics.drBypassed;
    entry.netDamageDealt += metrics.netDamageDealt;
    entry.killsCount += metrics.killsCount;
    entry.aooExecuted += metrics.aooExecuted;
    entry.aooHits += metrics.aooHits;
    entry.cmbSuccesses += metrics.cmbSuccesses;
    entry.hitPercentage = entry.totalAttacks > 0 ? Math.round((entry.hits / entry.totalAttacks) * 100) : 0;
  }

  recordSpell(unitId: string, metrics: PF1eSpellMetrics): void {
    const entry = this.ensureUnit(unitId);
    entry.savesPassed += metrics.savesPassed;
    entry.savesFailed += metrics.savesFailed;
    entry.srBlocked += metrics.srBlocked;
    entry.netDamageDealt += metrics.damageDealt;
    entry.killsCount += metrics.killsCount;
    entry.concentrationPassed += metrics.concentrationPassed;
    entry.concentrationFailed += metrics.concentrationFailed;
    entry.aooExecuted += metrics.aooExecuted;
    entry.aooHits += metrics.aooHits;
  }

  /**
   * Attribute spell kills to the unit that LOST the models (D-165, M11): `recordSpell`
   * books `killsCount` on the caster, but `deathsCount` — the advertised field for the
   * dying side — had no event source at all until now.
   */
  recordSpellKills(unitId: string, deaths: number): void {
    if (deaths <= 0) return;
    const entry = this.ensureUnit(unitId);
    entry.deathsCount += deaths;
  }

  recordHealing(unitId: string, healed: number): void {
    const entry = this.ensureUnit(unitId);
    entry.damageHealed += healed;
  }

  generateReport(): PF1eBattleReport {
    const totals: UnitAnalyticsSummary = {
      unitId: "TOTALS",
      totalAttacks: 0,
      hits: 0,
      misses: 0,
      hitPercentage: 0,
      critThreats: 0,
      critsConfirmed: 0,
      misfiresCount: 0,
      rawDamageDealt: 0,
      drAbsorbed: 0,
      drBypassed: 0,
      srBlocked: 0,
      netDamageDealt: 0,
      damageHealed: 0,
      killsCount: 0,
      deathsCount: 0,
      savesPassed: 0,
      savesFailed: 0,
      aooExecuted: 0,
      aooHits: 0,
      cmbSuccesses: 0,
      concentrationPassed: 0,
      concentrationFailed: 0,
    };

    const units: Record<string, UnitAnalyticsSummary> = {};

    for (const [id, u] of this.unitsMap.entries()) {
      units[id] = { ...u };
      totals.totalAttacks += u.totalAttacks;
      totals.hits += u.hits;
      totals.misses += u.misses;
      totals.critThreats += u.critThreats;
      totals.critsConfirmed += u.critsConfirmed;
      totals.misfiresCount += u.misfiresCount;
      totals.rawDamageDealt += u.rawDamageDealt;
      totals.drAbsorbed += u.drAbsorbed;
      totals.drBypassed += u.drBypassed;
      totals.srBlocked += u.srBlocked;
      totals.netDamageDealt += u.netDamageDealt;
      totals.damageHealed += u.damageHealed;
      totals.killsCount += u.killsCount;
      totals.deathsCount += u.deathsCount;
      totals.savesPassed += u.savesPassed;
      totals.savesFailed += u.savesFailed;
      totals.aooExecuted += u.aooExecuted;
      totals.aooHits += u.aooHits;
      totals.cmbSuccesses += u.cmbSuccesses;
      totals.concentrationPassed += u.concentrationPassed;
      totals.concentrationFailed += u.concentrationFailed;
    }

    totals.hitPercentage = totals.totalAttacks > 0 ? Math.round((totals.hits / totals.totalAttacks) * 100) : 0;

    return { totals, units };
  }
}

/**
 * RFC-4180 field encoding: a field containing a comma, double quote, or line break is
 * wrapped in double quotes and every embedded quote is doubled. Unit ids are authored
 * names in practice, so an unquoted comma in one corrupts every column after it — the
 * Gap List called this out despite the work plan's "RFC-4180" claim.
 */
function csvField(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(fields: Array<string | number>): string {
  return fields.map(csvField).join(",");
}

export function exportAnalyticsToCsv(report: PF1eBattleReport): string {
  const lines: string[] = [
    csvRow([
      "Unit ID",
      "Attacks",
      "Hits",
      "Misses",
      "Hit %",
      "Misfires",
      "Damage",
      "Kills",
      "Heals",
      "DR Absorbed",
      "DR Bypassed",
      "SR Blocked",
      "Saves Passed",
      "Saves Failed",
    ]),
  ];

  for (const u of Object.values(report.units)) {
    lines.push(
      csvRow([
        u.unitId,
        u.totalAttacks,
        u.hits,
        u.misses,
        u.hitPercentage,
        u.misfiresCount,
        u.netDamageDealt,
        u.killsCount,
        u.damageHealed,
        u.drAbsorbed,
        u.drBypassed,
        u.srBlocked,
        u.savesPassed,
        u.savesFailed,
      ]),
    );
  }

  const t = report.totals;
  lines.push(
    csvRow([
      "TOTALS",
      t.totalAttacks,
      t.hits,
      t.misses,
      t.hitPercentage,
      t.misfiresCount,
      t.netDamageDealt,
      t.killsCount,
      t.damageHealed,
      t.drAbsorbed,
      t.drBypassed,
      t.srBlocked,
      t.savesPassed,
      t.savesFailed,
    ]),
  );

  return lines.join("\n");
}
