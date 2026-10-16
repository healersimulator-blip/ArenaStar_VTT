#!/usr/bin/env node
/**
 * How tightly is the native PF1e implementation welded into the host?
 *
 * Walks the static import graph of `src/` (ts + svelte; `import type` edges ignored) and
 * reports, for the PF1e-named files (`*pf1e*` / `*PF1e*`):
 *   - host → PF1e import edges, importing host files, distinct imported symbols;
 *   - PF1e → host edges (what the PF1e code needs from the host);
 *   - reachability from the player shell (`app/joinBoot.ts` + `app/JoinApp.svelte`) versus the
 *     GM shell (`app/hostBoot.ts` + `app/App.svelte`) — i.e. which PF1e bytes the player tab
 *     needs, which decides whether moving them out of `index.html` needs a player-side
 *     package delivery path;
 *   - bundle bytes per file when `dist/analyze/attribution.json` exists (see
 *     `bundleAttribution.mjs`).
 *
 *   node tools/analysis/pf1eCoupling.mjs
 *   node tools/analysis/pf1eCoupling.mjs --symbols   # host → PF1e by PF1e module, with symbols
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = resolve(root, "src");
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|svelte)$/.test(e) && !/\.d\.ts$/.test(e)) files.push(p);
  }
})(SRC);

const rel = (f) => relative(SRC, f);
const isPf1e = (f) => /pf1e/i.test(rel(f));
const resolveImport = (from, spec) => {
  if (!spec.startsWith(".")) return null;
  const p = resolve(dirname(from), spec);
  for (const c of [p, `${p}.ts`, `${p}.svelte`, join(p, "index.ts"), p.replace(/\.js$/, ".ts")]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* not this candidate */
    }
  }
  return null;
};

// Static `import … from`, re-exports (`export … from`), side-effect imports and dynamic
// `import()` all count as edges; `import type` / `export type` edges are recorded but do
// not contribute to reachability (they vanish at compile time).
const IMPORT_RE =
  /\b(import|export)\s+(type\s+)?(?:(\{[^}]*\})|(\*(?:\s+as\s+\w+)?)|(\w+))?\s*(?:,\s*\{([^}]*)\})?\s*from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const edges = []; // { from, to, syms, typeOnly }
const graph = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const out = new Set();
  for (const m of src.matchAll(IMPORT_RE)) {
    const to = resolveImport(f, m[7] ?? m[8] ?? m[9]);
    if (!to) continue;
    const typeOnly = Boolean(m[2]);
    const syms = [m[3], m[6], m[4], m[5]]
      .filter(Boolean)
      .join(",")
      .replace(/[{}]/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])
      .filter(Boolean);
    edges.push({ from: f, to, syms, typeOnly });
    if (!typeOnly) out.add(to);
  }
  graph.set(f, out);
}

const uniq = (xs) => [...new Set(xs)];
const hostToPf1e = edges.filter((e) => !isPf1e(e.from) && isPf1e(e.to));
const pf1eToHost = edges.filter((e) => isPf1e(e.from) && !isPf1e(e.to));

console.log(`src files: ${files.length}  PF1e-named: ${files.filter(isPf1e).length}  import edges: ${edges.length}`);
console.log("\n== host → PF1e (coupling points a package boundary must cut) ==");
console.log(
  `edges ${hostToPf1e.length} (type-only ${hostToPf1e.filter((e) => e.typeOnly).length})  importing host files ${uniq(hostToPf1e.map((e) => e.from)).length}  imported PF1e files ${uniq(hostToPf1e.map((e) => e.to)).length}  distinct symbols ${uniq(hostToPf1e.flatMap((e) => e.syms)).length}`,
);
const byHost = new Map();
for (const e of hostToPf1e) {
  const k = rel(e.from);
  const v = byHost.get(k) ?? { edges: 0, syms: new Set() };
  v.edges++;
  e.syms.forEach((s) => v.syms.add(s));
  byHost.set(k, v);
}
for (const [k, v] of [...byHost].sort((a, b) => b[1].syms.size - a[1].syms.size).slice(0, 15)) {
  console.log(String(v.syms.size).padStart(4), "symbols", String(v.edges).padStart(3), "edges ", k);
}
// --symbols: the contract surface a tactical package boundary would have to carry — every
// PF1e module the host imports, with the symbols, grouped by PF1e file and ranked by how
// many host files need it (the shared ones are the dispatch interface; the one-offs are glue).
if (process.argv.includes("--symbols")) {
  console.log("\n== host → PF1e by PF1e module (--symbols) ==");
  const byTarget = new Map();
  for (const e of hostToPf1e) {
    const k = rel(e.to);
    const v = byTarget.get(k) ?? { hosts: new Set(), syms: new Map() };
    v.hosts.add(rel(e.from));
    for (const s of e.syms) {
      const row = v.syms.get(s) ?? { hosts: new Set(), typeOnly: true };
      row.hosts.add(rel(e.from));
      if (!e.typeOnly) row.typeOnly = false;
      v.syms.set(s, row);
    }
    byTarget.set(k, v);
  }
  for (const [k, v] of [...byTarget].sort((a, b) => b[1].hosts.size - a[1].hosts.size || b[1].syms.size - a[1].syms.size)) {
    console.log(`\n${k}  (${v.hosts.size} host files, ${v.syms.size} symbols)`);
    for (const [s, row] of [...v.syms].sort((a, b) => b[1].hosts.size - a[1].hosts.size)) {
      console.log(`   ${String(row.hosts.size).padStart(2)}× ${row.typeOnly ? "type " : "     "}${s}`);
    }
  }
}

console.log("\n== PF1e → host (what PF1e needs from the host) ==");
console.log(
  `edges ${pf1eToHost.length}  host files ${uniq(pf1eToHost.map((e) => e.to)).length}  distinct symbols ${uniq(pf1eToHost.flatMap((e) => e.syms)).length}`,
);

// --- reachability from the two shells -----------------------------------------------------
const reach = (starts) => {
  const seen = new Set();
  const stack = starts.map((s) => resolve(SRC, s));
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const t of graph.get(f) ?? []) stack.push(t);
  }
  return seen;
};
const player = reach(["app/joinBoot.ts", "app/JoinApp.svelte"]);
const host = reach(["app/hostBoot.ts", "app/App.svelte"]);

const attributionPath = resolve(root, "dist/analyze/attribution.json");
const size = new Map();
if (existsSync(attributionPath)) {
  for (const [f, n] of Object.entries(JSON.parse(readFileSync(attributionPath, "utf8")).files)) size.set(f, n);
} else {
  console.log("\n(no dist/analyze/attribution.json — byte columns are 0; run bundleAttribution.mjs first)");
}
const bytesOf = (f) => size.get(`src/${rel(f)}`) ?? 0;
const pf = files.filter(isPf1e);
const sum = (xs) => xs.reduce((a, f) => a + bytesOf(f), 0);
console.log("\n== reachability of PF1e-named files ==");
console.log(`all:          ${pf.length} files  ${sum(pf)} bytes`);
console.log(`player shell: ${pf.filter((f) => player.has(f)).length} files  ${sum(pf.filter((f) => player.has(f)))} bytes`);
console.log(`GM shell only:${String(pf.filter((f) => host.has(f) && !player.has(f)).length).padStart(3)} files  ${sum(pf.filter((f) => host.has(f) && !player.has(f)))} bytes`);
console.log(`neither:      ${pf.filter((f) => !host.has(f) && !player.has(f)).length} files  ${sum(pf.filter((f) => !host.has(f) && !player.has(f)))} bytes`);
console.log("\nGM-shell-only PF1e files:");
for (const f of pf.filter((f) => host.has(f) && !player.has(f))) console.log(String(bytesOf(f)).padStart(7), rel(f));
