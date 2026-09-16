#!/usr/bin/env node
/**
 * V09 — PF1e rules-coverage dashboard.
 *
 * Every row this prints is *derived*, nothing is asserted by hand:
 *
 *   • the checklist   — `PF1e_Unified_TODO.md`, parsed for `- [x]`/`- [ ]` items, their id,
 *                       title, the section they live under, and the source refs they cite;
 *   • tested-by       — every file under `tests/` and `e2e/` that names the item id, so the
 *                       "tested" column is the test tree's own back-references rather than a
 *                       hand-kept table. This is a text scan, so it is deliberately coarse: a
 *                       file that merely *discusses* an id counts as evidence for it. That is
 *                       the right trade for a dashboard (it can only over-report coverage, and
 *                       the ids are added by the slice that lands the work), but it is not a
 *                       proof that a given assertion exercises a given item;
 *   • rule citations  — explicit `@srd <heading>` annotations in those files, the verified
 *                       rule text a test claims to encode;
 *   • deviated        — `DEVIATIONS.md`, parsed for its live deviation rows and the
 *                       per-decision additions sections;
 *   • deferred        — §12's L-items, which are scope decisions rather than missing work.
 *
 * `--check` turns the dashboard into a gate: any item the checklist marks `[x]` but no test
 * file names is a failure, which is what stops the coverage claim from drifting away from the
 * test tree the way the previous hardcoded version did.
 *
 * Usage:  node scripts/coverage.mjs [--check] [--json]
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const argv = process.argv.slice(2);
const args = new Set(argv);
const CHECK = args.has("--check");
const JSON_OUT = args.has("--json");
/**
 * `--todo <path>` points the dashboard at a different checklist. It exists so the `--check`
 * gate's *failure* mode is testable (`tests/scripts/coverage.test.ts`) without mutating the
 * real checklist; the default is the repository's own `PF1e_Unified_TODO.md`.
 */
const todoFlag = argv.indexOf("--todo");
const TODO_ARG = todoFlag >= 0 ? argv[todoFlag + 1] : undefined;

const TODO_PATH = TODO_ARG ? path.resolve(TODO_ARG) : path.join(ROOT, "PF1e_Unified_TODO.md");
const DEVIATIONS_PATH = path.join(ROOT, "DEVIATIONS.md");
const TODO_REL = TODO_ARG ? path.relative(ROOT, TODO_PATH) : "PF1e_Unified_TODO.md";

// ── 1. the checklist ──────────────────────────────────────────────────────────

/** Item ids look like `A01`, `C03a`, `V11`, `L07` — a letter prefix plus digits (+ optional suffix). */
const ITEM_ID = /^([A-Z]\d{2}[a-z]?)$/;

function walk(dir, filter) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** GitHub-style anchor for a heading, so the printed links actually land in the file. */
const anchor = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

function parseChecklist(text) {
  const sections = [];
  let section = { title: "(preamble)", items: [] };
  sections.push(section);
  const itemLine = /^- \[( |x)\] \*\*([A-Z]\d{2}[a-z]?) —/;
  for (const line of text.split("\n")) {
    const heading = /^#{2,4} (.+)$/.exec(line);
    if (heading) {
      section = { title: heading[1].trim(), items: [] };
      sections.push(section);
      continue;
    }
    const item = itemLine.exec(line);
    if (!item) continue;
    const done = item[1] === "x";
    const id = item[2];
    // Title = the text between the em-dash and the first `**`-close or source paren.
    const body = line.slice(item[0].length);
    const title = body.split(/(?:\*\*|\(G |\(I |\(M |\(B )/)[0].trim();
    // Closure note, when the checklist carries one (`— **done 2026-09-15 (D-238)**`).
    const closed = /\*\*(?:done|landed|closed|complete)[^*]*\*\*/i.exec(line);
    // Source refs like `(G §1.2; I P6)` / `(M Task 10; G §7.5)`.
    const refs = [...line.matchAll(/\(([GBIM](?: §[^)]*| Task [^)]*| P\d[^)]*| §\d[^)]*))\)/g)]
      .map((m) => m[1])
      .join("; ");
    section.items.push({
      id,
      done,
      title: title || "(untitled)",
      section: section.title,
      sectionAnchor: anchor(section.title),
      closed: closed ? closed[0].replace(/\*/g, "").trim() : null,
      refs,
    });
  }
  return sections.filter((s) => s.items.length > 0);
}

// ── 2. the test tree's own back-references ────────────────────────────────────

function scanTests() {
  const files = [
    ...walk(path.join(ROOT, "tests"), (p) => p.endsWith(".test.ts")),
    ...walk(path.join(ROOT, "e2e"), (p) => p.endsWith(".spec.ts")),
  ].sort();

  const byItem = new Map(); // id -> Set<relpath>
  const srd = []; // { file, heading }
  // A citation counts only inside a comment line (`//`, `/*` or a docblock `*` continuation),
  // so a test *name* that merely mentions "@srd" cannot mint a fake rule heading.
  const commentLine = /^\s*(?:\/\/|\/\*|\*)/;
  const srdRe = /@srd\s+([^*\n]+)/;
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b([A-Z]\d{2}[a-z]?)\b/g)) {
      const id = match[1];
      if (!ITEM_ID.test(id)) continue;
      if (!byItem.has(id)) byItem.set(id, new Set());
      byItem.get(id).add(rel);
    }
    for (const line of text.split("\n")) {
      if (!commentLine.test(line)) continue;
      const citation = srdRe.exec(line);
      if (citation) srd.push({ file: rel, heading: citation[1].trim() });
    }
  }
  return { files, byItem, srd };
}

// ── 3. deviations ─────────────────────────────────────────────────────────────

function parseDeviations(text) {
  const live = [];
  // The index table: | D-1 | description | spec section | conflict | change | approval |
  for (const line of text.split("\n")) {
    const row = /^\|\s*(D-\d+)\s*\|([^|]*)\|/.exec(line);
    if (!row) continue;
    const state = /\*\*CLOSED/.test(line) ? "closed" : "live";
    live.push({ id: row[1], summary: row[2].trim().replace(/\*\*/g, ""), state });
  }
  const additions = [...text.matchAll(/^## (D-\d+) additions \(([^)]*)\)$/gm)].map((m) => ({
    decision: m[1],
    when: m[2],
  }));
  return { rows: live, additions };
}

// ── 4. group items into the rule areas the checklist itself defines ────────────

/** Item-id prefix → the area name, taken from the checklist's own section wording. */
const AREA_OF_PREFIX = {
  R: "Reconciliation (disputed rules verified before encoding)",
  D: "Landed baseline (P0 foundation)",
  N: "Multiplayer correctness (protocol + replication)",
  S: "P1 — Actor & monster sheets",
  T: "P2 — Initiative, encounters, action economy",
  A: "P3 — Attack, damage & equipment mechanics",
  E: "P4 — Effects, conditions & durations",
  C: "P5 — Spellcasting, targeting & awareness",
  P: "P6 — Positioning, maneuvers, interrupts, mounted/firearms",
  H: "P7 — Injury, recovery & death",
  M: "P8 — Strategic fidelity, hero bridge, analytics & content",
  V: "Verification & release gates",
  L: "Deferred / expanded-system backlog",
  F: "New features (F01–F03)",
};

// ── 5. report ─────────────────────────────────────────────────────────────────

const todoText = fs.readFileSync(TODO_PATH, "utf8");
const sections = parseChecklist(todoText);
const { files: testFiles, byItem, srd } = scanTests();
const deviations = parseDeviations(
  fs.existsSync(DEVIATIONS_PATH) ? fs.readFileSync(DEVIATIONS_PATH, "utf8") : "",
);

const items = sections.flatMap((s) => s.items);
const areas = new Map();
for (const item of items) {
  const prefix = item.id[0];
  const area = AREA_OF_PREFIX[prefix] ?? `Area ${prefix}`;
  if (!areas.has(area)) areas.set(area, []);
  areas.get(area).push(item);
}

const evidenceFor = (item) => {
  const set = byItem.get(item.id);
  return set ? [...set].sort() : [];
};

const rows = [...areas.entries()].map(([area, areaItems]) => ({
  area,
  items: areaItems.map((item) => {
    const evidence = evidenceFor(item);
    return {
      id: item.id,
      status: item.done ? "implemented" : "open",
      checklist: item.done ? "[x]" : "[ ]",
      title: item.title,
      section: item.section,
      link: `${TODO_REL}#${item.sectionAnchor}`,
      sources: item.refs,
      closure: item.closed,
      testedBy: evidence,
      testedByCount: evidence.length,
      srdCitations: srd.filter((c) => evidence.includes(c.file)).length,
      deferred: area === AREA_OF_PREFIX.L,
    };
  }),
}));

const implemented = items.filter((i) => i.done).length;
const open = items.length - implemented;
const untestedButDone = rows
  .flatMap((r) => r.items)
  .filter((i) => i.status === "implemented" && i.testedByCount === 0);
const liveDeviations = deviations.rows.filter((r) => r.state === "live");

/**
 * Items that are documentation deliverables by the checklist's own definition, so "no test file
 * names them" is the correct state rather than a coverage hole. §0's preamble states these
 * "override older proposals, not additional implementation tasks", and R01/R03's closures
 * record "No code changed". Listed by id so an exemption is visible and has to be argued for.
 */
const DOCUMENTATION_ONLY = new Set(["R01", "R03"]);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        generatedFrom: {
          checklist: TODO_REL,
          deviations: path.relative(ROOT, DEVIATIONS_PATH),
          testFilesScanned: testFiles.length,
        },
        totals: {
          items: items.length,
          implemented,
          open,
          deferred: rows
            .find((r) => r.area === AREA_OF_PREFIX.L)
            ?.items.filter((i) => i.deferred).length,
          srdCitations: srd.length,
          liveDeviations: liveDeviations.length,
          implementedWithoutTestEvidence: untestedButDone.map((i) => i.id),
        },
        areas: rows,
        srdCitations: srd,
        deviations,
      },
      null,
      2,
    ),
  );
} else {
  console.log("=== PF1e Rules Coverage Dashboard (V09) ===");
  console.log(
    `derived from: ${TODO_REL} checklist · DEVIATIONS.md · ${testFiles.length} test/spec files\n`,
  );
  console.log(
    `checklist items : ${items.length}   implemented ${implemented}   open ${open}   ` +
      `deferred ${rows.find((r) => r.area === AREA_OF_PREFIX.L)?.items.length ?? 0}`,
  );
  console.log(`@srd citations  : ${srd.length} across ${new Set(srd.map((c) => c.file)).size} files`);
  console.log(
    `live deviations : ${liveDeviations.length}` +
      (deviations.additions.length
        ? `  (+${deviations.additions.length} per-decision addition sections: ${deviations.additions
            .map((a) => a.decision)
            .join(", ")})`
        : ""),
  );
  console.log("");

  for (const area of rows) {
    const done = area.items.filter((i) => i.status === "implemented").length;
    console.log(`## ${area.area}  —  ${done}/${area.items.length} implemented`);
    for (const item of area.items) {
      const mark = item.status === "implemented" ? "✓" : item.deferred ? "·" : "✗";
      const tests =
        item.testedByCount > 0
          ? `${item.testedByCount} test file${item.testedByCount === 1 ? "" : "s"}`
          : "NO TEST EVIDENCE";
      const cite = item.srdCitations > 0 ? ` · ${item.srdCitations} @srd` : "";
      const dev = liveDeviations.some((d) => d.summary.includes(item.id)) ? " · DEVIATED" : "";
      console.log(
        `  ${mark} ${item.id}  ${item.title.slice(0, 72).padEnd(72)}  ${tests}${cite}${dev}`,
      );
      console.log(`      → ${item.link}${item.sources ? `   sources: ${item.sources}` : ""}`);
      if (item.testedByCount > 0) {
        console.log(`      tested by: ${item.testedBy.slice(0, 4).join(", ")}` +
          (item.testedBy.length > 4 ? ` … (+${item.testedBy.length - 4})` : ""));
      }
    }
    console.log("");
  }

  console.log("## Rule citations found in the test tree (@srd)");
  if (srd.length === 0) console.log("  (none)");
  for (const citation of srd) console.log(`  · [${citation.file}] ${citation.heading}`);
  console.log("");

  console.log("## Deviations");
  for (const row of deviations.rows) {
    console.log(`  ${row.state === "live" ? "⚠" : "✓"} ${row.id} (${row.state}) — ${row.summary.slice(0, 90)}`);
  }
  console.log("");

  if (untestedButDone.length > 0) {
    console.log("## Implemented items with no test file naming them");
    for (const item of untestedButDone) {
      const why = DOCUMENTATION_ONLY.has(item.id)
        ? "  (documentation-only deliverable — exempt from --check)"
        : "";
      console.log(`  ✗ ${item.id} — ${item.title.slice(0, 70)}  → ${item.link}${why}`);
    }
    console.log("");
  }
}

if (CHECK) {
  const problems = [];
  const gaps = untestedButDone.filter((i) => !DOCUMENTATION_ONLY.has(i.id));
  if (gaps.length > 0) {
    problems.push(
      `${gaps.length} checklist item(s) marked [x] with no test file naming them: ` +
        gaps.map((i) => i.id).join(", "),
    );
  }
  if (srd.length === 0) problems.push("no @srd rule citations found in the test tree");
  if (problems.length > 0) {
    console.error("coverage --check FAILED:");
    for (const problem of problems) console.error(`  · ${problem}`);
    process.exit(1);
  }
  console.log(
    `coverage --check OK: ${implemented} implemented items all carry test evidence; ` +
      `${srd.length} @srd citations indexed.`,
  );
}
