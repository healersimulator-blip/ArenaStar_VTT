/**
 * §12 migrations — bring world documents forward when the system's
 * dataSchema version is newer than the persisted world version. Migration
 * steps form explicit `from → to` semver chains; DECLARATIVE transforms
 * (set/default/move/remove with `*` wildcard path segments) run without any
 * code execution — packages declare them in manifest.json, the built-in
 * system may register code steps in the registry. Pure + node-tested.
 */
import type { BaseDocument } from "./documents";
import type { Result } from "./result";
import { err, okVal } from "./result";

// ─── semver ───────────────────────────────────────────────────────────────────

export interface ParsedVersion {
  core: [number, number, number];
  pre: string | null;
}

export function parseVersion(v: string): Result<ParsedVersion> {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.+-]+))?$/.exec(v.trim());
  if (!m) return err(`version: "${v}" is not semver`);
  return okVal({
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] !== undefined ? m[4] : null,
  });
}

/** Semver order (x.y.z numeric; equal cores: prerelease < release). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa.ok || !pb.ok) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa.value.core[i] ?? 0) - (pb.value.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.value.pre === null && pb.value.pre === null) return 0;
  if (pa.value.pre === null) return 1;
  if (pb.value.pre === null) return -1;
  return pa.value.pre < pb.value.pre ? -1 : pa.value.pre > pb.value.pre ? 1 : 0;
}

// ─── declarative transforms ───────────────────────────────────────────────────

export const MIGRATION_OPS = ["set", "default", "move", "remove"] as const;
export type MigrationOp = (typeof MIGRATION_OPS)[number];

export interface DeclaredTransform {
  op: MigrationOp;
  /** Target path, `*` segments fan out over arrays/objects (e.g. `units.*.stats.drill`). */
  path: string;
  /** For move: the source path. */
  from?: string;
  value?: unknown;
}

export interface MigrationStep {
  from: string;
  to: string;
  /** Transform lists keyed by document type (e.g. "armies", "actors"). */
  transforms: Record<string, DeclaredTransform[]>;
}

/** Path segments must be plain keys or `*` (no prototype tricks). */
const SEG_RE = /^[A-Za-z0-9_$-]+$/;

export function parsePath(path: string): Result<string[]> {
  const segs = path.split(".");
  if (segs.length === 0 || segs.length > 8) return err(`path: "${path}" has bad depth`);
  const DANGEROUS = new Set(["__proto__", "prototype", "constructor"]);
  for (const seg of segs) {
    if (seg !== "*" && (!SEG_RE.test(seg) || DANGEROUS.has(seg))) {
      return err(`path: "${path}" has bad segment "${seg}"`);
    }
  }
  return okVal(segs);
}

/** Validate a parsed manifest migrations array (shape only; versions checked here). */
export function validateMigrationSteps(raw: unknown): Result<MigrationStep[]> {
  if (!Array.isArray(raw)) return err("migrations: must be an array");
  const steps: MigrationStep[] = [];
  for (const rawStep of raw) {
    if (typeof rawStep !== "object" || rawStep === null) {
      return err("migrations: step must be an object");
    }
    const step = rawStep as Record<string, unknown>;
    const fromV = parseVersion(String(step.from ?? ""));
    if (!fromV.ok) return err(`migrations: step.from ${fromV.error}`);
    const toV = parseVersion(String(step.to ?? ""));
    if (!toV.ok) return err(`migrations: step.to ${toV.error}`);
    if (compareVersions(String(step.from), String(step.to)) >= 0) {
      return err(`migrations: step ${step.from} → ${step.to} must increase`);
    }
    if (typeof step.transforms !== "object" || step.transforms === null) {
      return err(`migrations ${step.from}: transforms must be an object`);
    }
    const transforms: Record<string, DeclaredTransform[]> = {};
    for (const [type, list] of Object.entries(step.transforms as Record<string, unknown>)) {
      if (!Array.isArray(list))
        return err(`migrations ${step.from}: transforms.${type} must be an array`);
      const ops: DeclaredTransform[] = [];
      for (const rawOp of list) {
        if (typeof rawOp !== "object" || rawOp === null) {
          return err(`migrations ${step.from}: transform must be an object`);
        }
        const t = rawOp as Record<string, unknown>;
        if (!(MIGRATION_OPS as readonly string[]).includes(String(t.op))) {
          return err(`migrations ${step.from}: unknown op ${String(t.op)}`);
        }
        if (typeof t.path !== "string")
          return err(`migrations ${step.from}: transform.path required`);
        const pathOk = parsePath(t.path);
        if (!pathOk.ok) return err(`migrations ${step.from}: ${pathOk.error}`);
        const op: DeclaredTransform = { op: t.op as MigrationOp, path: t.path };
        if (t.op === "move") {
          if (typeof t.from !== "string") {
            return err(`migrations ${step.from}: move needs a from path`);
          }
          const fromOk = parsePath(t.from);
          if (!fromOk.ok) return err(`migrations ${step.from}: ${fromOk.error}`);
          op.from = t.from;
        } else if (t.op === "set" || t.op === "default") {
          if (!("value" in t)) {
            return err(`migrations ${step.from}: ${String(t.op)} needs a value`);
          }
          if (JSON.stringify(t.value) === undefined) {
            return err(`migrations ${step.from}: value must be JSON-safe`);
          }
          op.value = t.value;
        }
        ops.push(op);
      }
      transforms[type] = ops;
    }
    steps.push({ from: String(step.from), to: String(step.to), transforms });
  }
  return okVal(steps);
}

// ─── path get/set/remove with `*` fan-out ─────────────────────────────────────

const clone = <T>(v: T): T =>
  Array.isArray(v)
    ? (v.map((x) => clone(x)) as unknown as T)
    : typeof v === "object" && v !== null
      ? ({ ...v } as T)
      : v;

function getPath(target: unknown, segs: string[]): unknown {
  if (segs.length === 0) return target;
  const [head, ...rest] = segs;
  if (head === undefined) return undefined;
  if (target === null || typeof target !== "object") return undefined;
  if (Array.isArray(target)) {
    if (head === "*") {
      return target.map((item) => getPath(item, rest));
    }
    const idx = Number(head);
    return Number.isInteger(idx) ? getPath(target[idx], rest) : undefined;
  }
  const record = target as Record<string, unknown>;
  if (head === "*") {
    return Object.values(record).map((item) => getPath(item, rest));
  }
  return getPath(record[head], rest);
}

/** Returns a new structure when changed, else the SAME reference. */
function setPath(
  target: unknown,
  segs: string[],
  value: unknown,
  mode: "set" | "default",
): unknown {
  if (segs.length === 0) return value;
  const [head, ...rest] = segs;
  if (head === undefined) return target;
  if (target === null || typeof target !== "object") {
    if (head === "*") return target; // nothing to fan out over
    target = {};
  }
  if (Array.isArray(target)) {
    if (head === "*") {
      let changed = false;
      const next = target.map((item) => {
        const r = setPath(item, rest, value, mode);
        if (r !== item) changed = true;
        return r;
      });
      return changed ? next : target;
    }
    const idx = Number(head);
    if (!Number.isInteger(idx)) return target;
    const r = setPath(target[idx], rest, value, mode);
    return r === target[idx] ? target : target.map((v, i) => (i === idx ? r : v));
  }
  const record = target as Record<string, unknown>;
  if (head === "*") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      const r = setPath(v, rest, value, mode);
      if (r !== v) changed = true;
      next[k] = r;
    }
    return changed ? next : record;
  }
  // `default` only yields on the LEAF key; intermediate containers must recurse
  if (mode === "default" && rest.length === 0 && record[head] !== undefined) return target;
  const r = setPath(record[head], rest, value, mode);
  if (r === record[head]) return target;
  return { ...record, [head]: r };
}

function removePath(target: unknown, segs: string[]): unknown {
  if (segs.length === 0) return target;
  const [head, ...rest] = segs;
  if (head === undefined || target === null || typeof target !== "object") return target;
  if (Array.isArray(target)) {
    if (head === "*") {
      let changed = false;
      const next = target.map((item) => {
        const r = removePath(item, rest);
        if (r !== item) changed = true;
        return r;
      });
      return changed ? next : target;
    }
    const idx = Number(head);
    if (!Number.isInteger(idx)) return target;
    if (rest.length === 0) return target.filter((_, i) => i !== idx);
    const r = removePath(target[idx], rest);
    return r === target[idx] ? target : target.map((v, i) => (i === idx ? r : v));
  }
  const record = target as Record<string, unknown>;
  if (head === "*") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      const r = removePath(v, rest);
      if (r !== v) changed = true;
      next[k] = r;
    }
    return changed ? next : record;
  }
  if (rest.length === 0) {
    if (!(head in record)) return target;
    const next = { ...record };
    Reflect.deleteProperty(next, head);
    return next;
  }
  const r = removePath(record[head], rest);
  if (r === record[head]) return target;
  return { ...record, [head]: r };
}

// ─── applying migrations ──────────────────────────────────────────────────────

/** Apply one step's transforms for a doc type; same ref when untouched. */
export function applyStep(doc: BaseDocument, step: MigrationStep): BaseDocument {
  const ops = step.transforms[doc.type];
  if (!ops || ops.length === 0) return doc;
  let current: unknown = doc;
  const segsOf = (p: string): string[] => {
    const parsed = parsePath(p);
    return parsed.ok ? parsed.value : [];
  };
  for (const op of ops) {
    if (op.op === "remove") {
      current = removePath(current, segsOf(op.path));
    } else if (op.op === "move") {
      const fromSegs = segsOf(op.from ?? "");
      const value = getPath(current, fromSegs);
      if (value === undefined) continue;
      current = removePath(current, fromSegs);
      current = setPath(current, segsOf(op.path), value, "set");
    } else {
      current = setPath(current, segsOf(op.path), clone(op.value), op.op);
    }
  }
  return current === doc ? doc : (current as BaseDocument);
}

/** Chain steps from → to (explicit links; missing link or cycle is an Err). */
export function planMigrationChain(
  steps: readonly MigrationStep[],
  from: string,
  to: string,
): Result<MigrationStep[]> {
  const chain: MigrationStep[] = [];
  const seen = new Set<string>();
  let current = from;
  while (compareVersions(current, to) < 0) {
    if (seen.has(current)) return err(`migrations: cycle detected at ${current}`);
    seen.add(current);
    const next = steps.find((s) => s.from === current);
    if (!next) {
      return err(`migrations: no step from ${current} (target ${to}) — missing link`);
    }
    chain.push(next);
    current = next.to;
  }
  if (compareVersions(current, to) > 0) {
    return err(`migrations: chain overshot ${to} (reached ${current})`);
  }
  return okVal(chain);
}

/** Migrate a document batch through a chain; returns changed docs only stats. */
export function migrateDocuments(
  docs: readonly BaseDocument[],
  chain: readonly MigrationStep[],
): { docs: BaseDocument[]; changed: number } {
  let changed = 0;
  const out = docs.map((doc) => {
    let current = doc;
    for (const step of chain) current = applyStep(current, step);
    if (current !== doc) changed++;
    return current;
  });
  return { docs: out, changed };
}

// ─── code-migration registry (built-in system) ───────────────────────────────

export type CodeMigration = (doc: BaseDocument) => BaseDocument;

export interface CodeStep {
  from: string;
  to: string;
  migrate: CodeMigration;
}

const codeRegistry = new Map<string, CodeStep[]>();

export function registerCodeMigrations(systemId: string, steps: CodeStep[]): void {
  codeRegistry.set(systemId, [...(codeRegistry.get(systemId) ?? []), ...steps]);
}

export function codeSteps(systemId: string): readonly CodeStep[] {
  return codeRegistry.get(systemId) ?? [];
}
