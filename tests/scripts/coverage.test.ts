// Checklist: V09 — the rules-coverage dashboard generator this file pins.
/**
 * V09 — the coverage dashboard must be *derived*, not asserted.
 *
 * The previous `scripts/coverage.mjs` printed nine hardcoded `console.log("  ✓ …")` chapter rows
 * and found four `@srd` tags, so it reported full coverage no matter what the checklist or the
 * test tree said. This test runs the real script as a child process (the same way
 * `tests/packages/pf1ePackage.test.ts` runs `buildSystemPackages.mjs`) and pins the properties
 * that make the output a dashboard rather than a poster:
 *
 *  • every checklist row comes from parsing `PF1e_Unified_TODO.md` — statuses must agree with
 *    the file's own `[x]`/`[ ]` boxes, read independently here;
 *  • the "tested by" column names files that exist on disk;
 *  • the anchors in the printed links resolve to real headings in the checklist;
 *  • `--check` is a gate with teeth: it exits non-zero when a `[x]` item has no test evidence.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const script = join(repoRoot, "scripts/coverage.mjs");
const todoText = readFileSync(join(repoRoot, "PF1e_Unified_TODO.md"), "utf8");

interface Item {
  id: string;
  status: "implemented" | "open";
  checklist: string;
  title: string;
  section: string;
  link: string;
  testedBy: string[];
  deferred: boolean;
}
interface Dashboard {
  totals: {
    items: number;
    implemented: number;
    open: number;
    srdCitations: number;
    implementedWithoutTestEvidence: string[];
  };
  areas: Array<{ area: string; items: Item[] }>;
  srdCitations: Array<{ file: string; heading: string }>;
  deviations: { rows: Array<{ id: string; state: string }> };
}

function runDashboard(args: string[]): Dashboard {
  const out = execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    stdio: "pipe",
  });
  return JSON.parse(out) as Dashboard;
}

/** Independently re-read the checklist's own boxes, so the dashboard cannot grade itself. */
function checklistBoxes(): Map<string, boolean> {
  const boxes = new Map<string, boolean>();
  for (const line of todoText.split("\n")) {
    const m = /^- \[( |x)\] \*\*([A-Z]\d{2}[a-z]?) —/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) boxes.set(m[2], m[1] === "x");
  }
  return boxes;
}

describe("V09 — the coverage dashboard is derived from the checklist and the test tree", () => {
  const dashboard = runDashboard(["--json"]);
  const allItems = dashboard.areas.flatMap((area) => area.items);

  test("every checklist box is reported, with the status the file itself carries", () => {
    const boxes = checklistBoxes();
    expect(boxes.size).toBeGreaterThan(80);
    expect(allItems.length).toBe(boxes.size);
    expect(dashboard.totals.items).toBe(boxes.size);

    for (const item of allItems) {
      const expected = boxes.get(item.id);
      expect(expected, `unknown checklist id ${item.id}`).toBeDefined();
      expect(item.status, `${item.id} status`).toBe(expected ? "implemented" : "open");
      expect(item.checklist).toBe(expected ? "[x]" : "[ ]");
    }
    const implemented = allItems.filter((i) => i.status === "implemented").length;
    expect(dashboard.totals.implemented).toBe(implemented);
    expect(dashboard.totals.open).toBe(allItems.length - implemented);
    // The current shape of the checklist, derived rather than enumerated: every
    // rule phase (R/D/N/S/T/A/E/M/C/P/B/G) is closed, so the only boxes left open
    // carry a V (verification) or L (deferred backlog) prefix. Listing the ids
    // here would make this test a second copy of the checklist that has to be
    // hand-edited every time one closes — the exact drift V09 exists to prevent.
    const open = allItems.filter((i) => i.status === "open").map((i) => i.id);
    expect(open.length).toBeGreaterThan(0);
    expect(
      open.filter((id) => !/^[VL]\d{2}[a-z]?$/.test(id)),
      "a non-V/L checklist item is open — a rule phase has regressed",
    ).toEqual([]);
    // …and the open set agrees with the checklist file's own unchecked boxes.
    const unchecked = [...boxes.entries()].filter(([, done]) => !done).map(([id]) => id);
    expect(open.slice().sort()).toEqual(unchecked.sort());
  });

  test("the deferred backlog is labelled as deferred, not as missing work", () => {
    const deferred = allItems.filter((i) => i.deferred).map((i) => i.id);
    expect(deferred).toEqual(["L01", "L02", "L03", "L04", "L05", "L06", "L07"]);
  });

  test("every 'tested by' entry is a real file in the repository", () => {
    const withEvidence = allItems.filter((i) => i.testedBy.length > 0);
    expect(withEvidence.length).toBeGreaterThan(50);
    for (const item of withEvidence) {
      for (const file of item.testedBy) {
        expect(existsSync(join(repoRoot, file)), `${item.id} cites missing ${file}`).toBe(true);
      }
    }
  });

  test("every printed link resolves to a heading that exists in the checklist", () => {
    const headings = new Set(
      todoText
        .split("\n")
        .map((line) => /^#{2,4} (.+)$/.exec(line)?.[1])
        .filter((h): h is string => typeof h === "string")
        .map((h) =>
          h
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, "")
            .trim()
            .replace(/\s+/g, "-"),
        ),
    );
    for (const item of allItems) {
      const anchor = item.link.split("#")[1] ?? "";
      expect(headings.has(anchor), `${item.id} link ${item.link}`).toBe(true);
    }
  });

  test("@srd citations are read out of the test tree, with real files and headings", () => {
    expect(dashboard.totals.srdCitations).toBe(dashboard.srdCitations.length);
    expect(dashboard.srdCitations.length).toBeGreaterThan(0);
    for (const citation of dashboard.srdCitations) {
      expect(existsSync(join(repoRoot, citation.file))).toBe(true);
      expect(citation.heading.length).toBeGreaterThan(8);
      // The citation must actually appear in the file it is attributed to.
      const text = readFileSync(join(repoRoot, citation.file), "utf8");
      expect(text).toContain("@srd");
    }
  });

  test("deviations are parsed from DEVIATIONS.md, not listed by hand", () => {
    const deviationsText = readFileSync(join(repoRoot, "DEVIATIONS.md"), "utf8");
    expect(dashboard.deviations.rows.length).toBeGreaterThan(0);
    for (const row of dashboard.deviations.rows) {
      expect(deviationsText).toContain(row.id);
      expect(["live", "closed"]).toContain(row.state);
    }
  });

  test("--check passes on the current tree: every [x] item carries test evidence", () => {
    const out = execFileSync(process.execPath, [script, "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      stdio: "pipe",
    });
    expect(out).toContain("coverage --check OK");
    // Any closed item still lacking a test file must be one the script exempts by name — the
    // documentation-only reconciliation deliverables (§0 calls them controlling decisions, not
    // implementation tasks). The exemption list is read back out of the script rather than
    // restated here, so this file's own text cannot become a fake "evidence" source for the
    // very ids it names (the id scan is a text scan; see the script header).
    const exempt = new Set(
      [...readFileSync(script, "utf8").matchAll(/DOCUMENTATION_ONLY = new Set\(\[([^\]]*)\]\)/g)]
        .flatMap((m) => [...(m[1] ?? "").matchAll(/"([A-Z]\d{2}[a-z]?)"/g)].map((x) => x[1] ?? "")),
    );
    expect(exempt.size).toBeGreaterThan(0);
    for (const gap of dashboard.totals.implementedWithoutTestEvidence) {
      expect(exempt.has(gap), `${gap} is closed with no test file and is not exempt`).toBe(true);
      expect(gap.startsWith("R"), `${gap} must be a reconciliation deliverable`).toBe(true);
    }
  });

  test("--check fails when a closed item has no test evidence (the gate has teeth)", () => {
    // Drive the same parser over a synthetic checklist whose only item is closed but named by
    // no test file. `--todo` exists precisely so this failure mode is testable without
    // mutating the real checklist.
    const dir = mkdtempSync(join(tmpdir(), "vtt-coverage-"));
    const synthetic = join(dir, "TODO.md");
    // The ids are generated, never literals: an id written into this file would be found by the
    // scanner in this file and name itself as its own test evidence.
    const stamp = Date.now() % 100;
    const closedId = `Q${String(stamp).padStart(2, "0")}`;
    const openId = `Z${String(stamp).padStart(2, "0")}`;
    writeFileSync(
      synthetic,
      [
        "# Synthetic checklist",
        "",
        "## 1. Nothing",
        "",
        `- [x] **${closedId} — A closed item no test file names.** (I P1)`,
        `- [ ] **${openId} — An open item.** (I P2)`,
        "",
      ].join("\n"),
    );
    try {
      let failure = "";
      try {
        execFileSync(process.execPath, [script, "--check", "--todo", synthetic], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 60_000,
          stdio: "pipe",
        });
      } catch (error) {
        const e = error as { status?: number; stderr?: string };
        failure = e.stderr ?? "";
        expect(e.status, "--check must exit non-zero").toBe(1);
      }
      expect(failure).toContain("coverage --check FAILED");
      expect(failure).toContain(closedId);

      // …and the same synthetic checklist passes --json reporting without the gate.
      const reported = JSON.parse(
        execFileSync(process.execPath, [script, "--json", "--todo", synthetic], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 60_000,
          stdio: "pipe",
        }),
      ) as Dashboard;
      expect(reported.totals.items).toBe(2);
      expect(reported.totals.implemented).toBe(1);
      expect(reported.totals.implementedWithoutTestEvidence).toEqual([closedId]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
