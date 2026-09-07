/**
 * Deploy-time / turn-start seeding of the PF1e pool columns (PF1e_Combat_Fidelity_GapList
 * §1.3, §1.4).
 *
 * The generic deployer (`src/sim/deploy.ts`) is system-agnostic: it lays models out and
 * writes `hp/hpMax = 1` plus nothing else. Every PF1e column therefore has to be filled
 * from the unit's own data before the first attack resolves — otherwise `ac` is 0
 * (every attack hits), `profileIdx` is 0 (no profile → every attack loop `continue`s and
 * the battle resolves *zero* attacks), and HP is 1 (a model dies to a scratch).
 *
 * Seeding runs at the start of every `resolveTurn`, and is idempotent by construction:
 * derived columns are rewritten from the same deterministic source each turn, while the
 * accumulators (`hp`/`hpMax`, `lethalDmg`, `nonlethal`) are only initialised once. That
 * ordering is also what makes profile ids stable: they are interned by content from a
 * sorted unit list, so a SimWorker restart, a checkpoint resume, and the host-side preview
 * all compute the same ids for the same army.
 */
import type { UnitView } from "../../core/rules";
import type { ModelPool } from "../../core/strategic";
import { PF1eProfileRegistry, type PF1eUnitProfile, type RawPF1eProfile } from "./schema";

/** Deterministic ordering for profile interning (unit id ascending). */
export function sortUnitsForInterning(units: readonly UnitView[]): UnitView[] {
  return [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const num = (stats: Record<string, number>, key: string, fallback: number): number => {
  const v = stats[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

/**
 * `UnitView.stats` → raw profile. Numbers not present in `stats` fall back to the same
 * defaults the module used before, so an army deployed without PF1e stats still resolves
 * (against a sane AC instead of 0).
 */
export function rawProfileFromUnit(unit: UnitView): RawPF1eProfile {
  const s = unit.stats;
  const raw: RawPF1eProfile = {
    name: unit.name,
    bab: num(s, "bab", 6),
    strMod: num(s, "strMod", 3),
    dexMod: num(s, "dexMod", 0),
    conMod: num(s, "conMod", 2),
    sizeMod: num(s, "sizeMod", 0),
    fort: num(s, "fort", 4),
    ref: num(s, "ref", 4),
    will: num(s, "will", 2),
    hp: num(s, "hp", 10),
    sr: num(s, "sr", 0),
    dr: { val: num(s, "drVal", 0), typeFlags: num(s, "drType", 0) },
  };
  // Typed AC values win; otherwise compilePF1eProfile derives all three from the breakdown.
  if (s["ac"] !== undefined) raw.ac = s["ac"];
  if (s["touchAc"] !== undefined) raw.touchAc = s["touchAc"];
  if (s["flatFootedAc"] !== undefined) raw.flatFootedAc = s["flatFootedAc"];
  for (const key of ["armorBonus", "shieldBonus", "naturalArmor", "dodgeBonus", "miscAc"] as const) {
    if (typeof s[key] === "number" && Number.isFinite(s[key])) raw[key] = s[key] as number;
  }
  if (s["cmd"] !== undefined) raw.cmd = s["cmd"];
  if (s["cmb"] !== undefined) raw.cmb = s["cmb"];
  if (s["casterLevel"] !== undefined) raw.casterLevel = s["casterLevel"];
  return raw;
}

export interface PF1eUnitProfiles {
  /** unit id → compiled profile (its `id` is the value stored in `pool.sys.profileIdx`). */
  byUnitId: Map<string, PF1eUnitProfile>;
  /** profile id → compiled profile. */
  registry: PF1eProfileRegistry;
}

/** Intern every unit's profile deterministically. */
export function buildUnitProfiles(
  units: readonly UnitView[],
  registry = new PF1eProfileRegistry(),
): PF1eUnitProfiles {
  const sorted = sortUnitsForInterning(units);
  const raws = sorted.map(rawProfileFromUnit);
  const compiled = registry.internAll(raws);
  const byUnitId = new Map<string, PF1eUnitProfile>();
  for (let i = 0; i < sorted.length; i++) {
    const unit = sorted[i];
    const profile = compiled[i];
    if (unit && profile) byUnitId.set(unit.id, profile);
  }
  return { byUnitId, registry };
}

/** Clamp into the column's storage width (u8 columns wrap on negative input). */
const u8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const i8 = (v: number): number => Math.max(-128, Math.min(127, Math.round(v)));
const u16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));

export interface SeedResult {
  /** Models whose derived columns were (re)written this turn. */
  seeded: number;
  /** Models whose hit points were initialised for the first time. */
  hpInitialized: number;
}

/**
 * Write the derived PF1e columns for every model of every unit.
 *
 * `hpMax <= 1` is the "never seeded" marker: `deploySnapshot` allocates `hp: 1, hpMax: 1`,
 * and PF1e hit points are always ≥ 1 real hit die, so a model with `hpMax === 1` is still
 * the deploy-time placeholder. This keeps seeding idempotent — it can never resurrect a
 * model that has already fought.
 */
export function seedPF1ePool(
  pool: ModelPool,
  units: readonly UnitView[],
  profiles: PF1eUnitProfiles,
): SeedResult {
  const out: SeedResult = { seeded: 0, hpInitialized: 0 };
  const col = (name: string): Float64Array | Float32Array | Int32Array | Uint8Array | undefined =>
    pool.sys[name] as unknown as Float32Array | undefined;

  const ac = col("ac");
  const touchAc = col("touchAc");
  const flatFootedAc = col("flatFootedAc");
  const fort = col("fort");
  const ref = col("ref");
  const will = col("will");
  const sr = col("sr");
  const drType = col("drType");
  const drVal = col("drVal");
  const profileIdx = col("profileIdx");
  const nonlethal = col("nonlethal");
  const lethalDmg = col("lethalDmg");
  const aooUsed = col("aooUsed");

  for (const unit of units) {
    const profile = profiles.byUnitId.get(unit.id);
    if (!profile) continue;
    const [start, end] = unit.modelRange ?? [0, 0];
    for (let i = start; i < end && i < pool.count; i++) {
      if (profileIdx) profileIdx[i] = u16(profile.id);
      if (ac) ac[i] = u8(profile.ac);
      if (touchAc) touchAc[i] = u8(profile.touchAc);
      if (flatFootedAc) flatFootedAc[i] = u8(profile.flatFootedAc);
      if (fort) fort[i] = i8(profile.fort);
      if (ref) ref[i] = i8(profile.ref);
      if (will) will[i] = i8(profile.will);
      if (sr) sr[i] = u8(profile.sr);
      if (drType) drType[i] = u8(profile.drTypeFlags);
      if (drVal) drVal[i] = u8(profile.drVal);
      out.seeded++;

      if (nonlethal && nonlethal[i] === undefined) nonlethal[i] = 0;
      if (lethalDmg && lethalDmg[i] === undefined) lethalDmg[i] = 0;
      // SRD: your attacks of opportunity refresh at the start of your turn.
      if (aooUsed) aooUsed[i] = 0;

      const maxHp = pool.hpMax[i] ?? 0;
      if (maxHp <= 1) {
        pool.hpMax[i] = profile.hp;
        if ((pool.hp[i] ?? 0) <= 1) pool.hp[i] = profile.hp;
        out.hpInitialized++;
      }
    }
  }

  return out;
}
