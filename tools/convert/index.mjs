#!/usr/bin/env node
/**
 * PF1e content converter CLI (plan §2 — the content pipeline).
 *
 * Reads the VENDOR CHECKOUTS (git-ignored, pinned commits — tools/adopt/INVENTORY.md):
 *   tools/content/vendor/pf1-system/packs/<name>/*.yaml
 *   tools/content/vendor/pf1e-content/src/packs/<name>/*.json
 * and writes the converted content package to `dist/content/pf1e/` (a dist artifact —
 * the world zips are release artifacts, never repo files, plan §2.5.6):
 *   manifest.json  packs/<out>.json  OGL.txt  CREDITS.md  REPORT.md
 *
 * The converted package rides the tester starter world (scripts/buildStarterWorlds.mjs)
 * as `packages/pf1e-content/…` — a data-only package beside pf1e-core and the
 * pf1e-mass-battles strategic ruleset.
 *
 * Usage: node tools/convert/index.mjs [--vendor <dir>] [--out <dir>] [--only <out…>]
 *        [--allow-missing]   exit 0 with a note when the checkout is absent (used by
 *                            `pnpm test:e2e`, which must not fail on a machine that has
 *                            not fetched the 262 MB of sources — it skips, and says so)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { mapEntry, newReport } from "./mappers.mjs";
import { CONTENT_PACKAGE, PACKS } from "./packs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const isFile = (p) => statSync(p, { throwIfNoEntry: false })?.isFile() === true;

/** Every .yaml under dir (recursive, sorted); the pf1-system pack folders nest by school. */
function walkYaml(dir) {
  const out = [];
  const walk = (current, depth) => {
    if (depth > 4) return; // pack folders are at most one level deep; don't walk the world
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".yaml")) out.push(abs);
    }
  };
  walk(dir, 0);
  return out;
}

/** A parsed YAML/JSON source document: an entry has both a Foundry type and a name. */
/**
 * Entry-vs-scaffolding detection. pf1-system YAML documents carry a `_key` whose prefix is
 * the Foundry document kind (`!items!`, `!actors!`, `!tables!`, `!folders!`, `!macros!`,
 * `!journal!`): folders are pack scaffolding, macros are module-API JS (P-6, never ported
 * raw). pf1e-content JSON carries `type`; the pf-rules pack's real documents are type-less
 * journals (top-level `content`), and its folder scaffolding is `#[CF_tempEntity]` stubs.
 */
function isEntry(parsed) {
  if (typeof parsed !== "object" || parsed === null || typeof parsed.name !== "string") return false;
  const key = typeof parsed._key === "string" ? parsed._key : "";
  if (key.startsWith("!folders!")) return false;
  if (key.startsWith("!macros!")) return "macro";
  if (key !== "") return true; // any other Foundry kind (items/actors/tables/journal/…)
  if (typeof parsed.name === "string" && parsed.name.startsWith("#[")) return false; // CF folder stub
  if (typeof parsed.type === "string") return true;
  return typeof parsed.content === "string" || Array.isArray(parsed.results);
}

/** Convert one vendored directory to one pack { file, name, type, entries, report }. */
function convertPack(spec, vendorRoot) {
  const dir = join(vendorRoot, spec.src, spec.dir);
  if (!existsSync(dir)) {
    return { spec, error: `source directory missing: ${relative(repoRoot, dir)} (vendor the pinned commit first — see tools/adopt/INVENTORY.md)` };
  }
  const files = spec.src === "pf1-system" ? walkYaml(dir) : readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)).sort();
  const report = newReport();
  const used = new Set();
  const entries = [];
  for (const file of files) {
    let parsed;
    try {
      const text = readFileSync(file, "utf8");
      parsed = spec.src === "pf1-system" ? parseYaml(text) : JSON.parse(text);
    } catch (e) {
      report.dropped.push(`${relative(dir, file)}: unparseable (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const entryCheck = isEntry(parsed);
    if (entryCheck === "macro") {
      report.dropped.push(`${relative(dir, file)}: macro (module-API JS — dropped, P-6 mapping)`);
      continue;
    }
    if (!entryCheck) {
      const key = typeof parsed._key === "string" ? parsed._key : "";
      const reason = key.startsWith("!folders!")
        ? "folder descriptor, not an entry"
        : String(parsed.name ?? "").startsWith("#[")
          ? "compendium-folder stub, not an entry"
          : "no recognizable entry shape";
      report.dropped.push(`${relative(dir, file)}: ${reason}`);
      continue;
    }
    report.total += 1;
    const entry = mapEntry(parsed, report, used);
    if (entry === null) {
      report.dropped.push(`${relative(dir, file)}: no mappable content (nameless or empty)`);
      continue;
    }
    report.converted += 1;
    entries.push(entry);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    spec,
    file: `packs/${spec.out}.json`,
    pack: { name: spec.name, type: spec.type, entries },
    report,
  };
}

function renderReport(results) {
  const lines = [];
  lines.push("# PF1e content — conversion report");
  lines.push("");
  lines.push(`Generated by \`tools/convert/index.mjs\` from the vendored checkouts (pinned commits — \`tools/adopt/INVENTORY.md\`). Regenerate: \`pnpm content:convert\`.`);
  lines.push("");
  lines.push("| Pack | Stage | Source | In | Out | Dropped categories |");
  lines.push("|---|---|---|---|---|---|");
  let inTotal = 0;
  let outTotal = 0;
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.spec.out} | ${r.spec.stage} | — | — | — | ${r.error} |`);
      continue;
    }
    inTotal += r.report.total;
    outTotal += r.report.converted;
    const cats = Object.entries(r.report.fields)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} (${n})`)
      .join(", ");
    lines.push(
      `| [${r.pack.name}](${r.file}) | ${r.spec.stage} | \`${r.spec.src}/${r.spec.dir}\` | ${r.report.total.toLocaleString("en-US")} | ${r.report.converted.toLocaleString("en-US")} | ${cats === "" ? "—" : cats} |`,
    );
  }
  lines.push("");
  lines.push(`**Total: ${inTotal.toLocaleString("en-US")} source entries → ${outTotal.toLocaleString("en-US")} pack entries.**`);
  lines.push("");
  lines.push("Dropped outright: `_id`/`_key`/`_stats` (Foundry metadata), `img` (paths into Foundry's icon library, not shipped), `folder`, source `items[]`/`effects[]` (per-entry links into other compendia), `flags`, `scriptCalls` (Foundry module API — P-6 mapping, never ported raw). Everything else of the Foundry `system` is carried under `system.foundry` (per-kind whitelist) or mapped into the app's own `system` shape.");
  for (const r of results) {
    if (r.error || r.report.dropped.length === 0) continue;
    lines.push("");
    lines.push(`### ${r.pack.name} — entry-level drops (${r.report.dropped.length})`);
    // aggregate by reason (the text after "file: reason"), with a few examples per reason
    const byReason = new Map();
    for (const line of r.report.dropped) {
      const i = line.lastIndexOf(": ");
      const reason = i === -1 ? line : line.slice(i + 2);
      const file = i === -1 ? "" : line.slice(0, i);
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push(file);
    }
    for (const [reason, files] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`- ${reason} — ${files.length}`);
      for (const f of files.slice(0, 3)) lines.push(`  - ${f}`);
      if (files.length > 3) lines.push(`  - … and ${files.length - 3} more`);
    }
  }
  return lines.join("\n") + "\n";
}

function renderCredits(results, vendorRoot) {
  const commits = {
    "pf1-system": "mirror of the FoundryPF1e pf1 system, commit 681929d1f5471178a99fc3285f94caa85d78e427",
    "pf1e-content": "baileymh/pf1e-content, commit baf5232c5dc16af99d49ae1bf57ead6473b46bbb",
  };
  const lines = [
    "# Credits",
    "",
    "This content package was converted from the following sources (license facts and the case-by-case legal review: `tools/adopt/INVENTORY.md`; OGL notice: `OGL.txt`).",
    "",
  ];
  const sources = new Map();
  for (const r of results) {
    if (r.error) continue;
    const list = sources.get(r.spec.src) ?? [];
    list.push(r.pack.name);
    sources.set(r.spec.src, list);
  }
  for (const [src, names] of [...sources.entries()].sort()) {
    lines.push(`## ${src}`);
    lines.push(commits[src] ?? src);
    for (const n of names) lines.push(`- ${n}`);
    lines.push("");
  }
  const ogls = [join(vendorRoot, "pf1e-content", "OGL.txt"), join(vendorRoot, "pf1-system", "OGL.txt")];
  const oglsFound = ogls.filter(isFile);
  lines.push("OGL 1.0a applies to the Paizo product content converted here; the full notice ships as `OGL.txt`.");
  void oglsFound;
  return lines.join("\n") + "\n";
}

function main() {
  const argv = process.argv.slice(2);
  const argOf = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  // VTT_CONTENT_VENDOR lets the whole chain point at one checkout (fetch --dest, this, worlds),
  // which is how a sandbox or CI keeps the 262 MB of sources outside the repo.
  const vendorRoot = resolve(
    repoRoot,
    argOf("--vendor") ?? process.env.VTT_CONTENT_VENDOR ?? join("tools", "content", "vendor"),
  );
  const outDir = resolve(repoRoot, argOf("--out") ?? join("dist", "content", "pf1e"));
  const only = argOf("--only");
  const onlySet = only !== null ? new Set(only.split(",")) : null;

  if (!existsSync(vendorRoot)) {
    // The recipe lives in tools/content/sources.json and materialises with one command (G-44);
    // this message used to be the only copy of the two clone lines, which is why a fresh clone
    // could not reach the content pipeline at all.
    console.error(`vendor checkout missing: ${relative(repoRoot, vendorRoot)}`);
    console.error("Fetch the pinned sources first:");
    console.error(
      vendorRoot === resolve(repoRoot, join("tools", "content", "vendor"))
        ? "  pnpm content:fetch"
        : `  pnpm content:fetch --dest ${relative(repoRoot, vendorRoot)}`,
    );
    console.error(
      "  (or, offline: download the published pf1e-content / tester-world artifacts — README, \"Content: two ways in\")",
    );
    // `--allow-missing` exists for exactly one caller: `pnpm test:e2e`, which runs the whole
    // build chain on whatever machine it is run on. Without it, a developer who has not fetched
    // the sources gets a hard failure; with an implicit skip, the content specs go quiet and the
    // gap is invisible again (D-258). So: one explicit flag, and the skip is printed.
    if (argv.includes("--allow-missing")) {
      console.error("");
      console.error(
        "--allow-missing: skipping the conversion; dist/content is left as it is (content specs will self-skip).",
      );
      process.exit(0);
    }
    process.exit(1);
  }

  const specs = PACKS.filter((s) => onlySet === null || onlySet.has(s.out));
  const results = specs.map((spec) => convertPack(spec, vendorRoot));

  // Write the package (deterministic bytes: sorted files, 2-space JSON).
  mkdirSync(join(outDir, "packs"), { recursive: true });
  const manifest = {
    id: CONTENT_PACKAGE.id,
    name: CONTENT_PACKAGE.name,
    version: CONTENT_PACKAGE.version,
    type: CONTENT_PACKAGE.type,
    packs: [],
  };
  for (const r of results) {
    if (r.error) {
      console.warn(`${r.spec.out}: SKIPPED — ${r.error}`);
      continue;
    }
    writeFileSync(join(outDir, r.file), JSON.stringify(r.pack, null, 2));
    manifest.packs.push({ name: r.pack.name, type: r.pack.type, file: r.file });
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  // OGL notice: the content's own license text (whichever checkout carries it).
  for (const candidate of [join(vendorRoot, "pf1e-content", "OGL.txt"), join(vendorRoot, "pf1-system", "OGL.txt")]) {
    if (isFile(candidate)) {
      cpSync(candidate, join(outDir, "OGL.txt"));
      break;
    }
  }
  writeFileSync(join(outDir, "CREDITS.md"), renderCredits(results, vendorRoot));
  writeFileSync(join(outDir, "REPORT.md"), renderReport(results));

  let total = 0;
  for (const r of results) {
    if (r.error) continue;
    total += r.report.converted;
    console.log(
      `${r.spec.out.padEnd(18)} ${r.report.converted.toLocaleString("en-US").padStart(9)} entries  ${r.pack.name}`,
    );
  }
  console.log(`\n${manifest.packs.length} packs, ${total.toLocaleString("en-US")} entries → ${relative(repoRoot, outDir)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]).endsWith("index.mjs") && process.argv[1].includes("convert")) {
  main();
}
