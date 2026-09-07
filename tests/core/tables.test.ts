import { describe, expect, test } from "vitest";
import { drawFromTable, validateTable } from "../../src/core/rollTable";
import type { RollTableDocument } from "../../src/core/documents";
import {
  buildFolderTree,
  flattenTree,
  folderPath,
  foldersFor,
  wouldCycle,
} from "../../src/core/folders";
import type { FolderDocument } from "../../src/core/documents";

function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] as number;
}

function table(ranges: Array<[number, number]>, formula = "1d20"): RollTableDocument {
  return {
    _id: "t1",
    type: "rollTable",
    name: "events",
    ownership: { default: 1 },
    flags: {},
    system: {},
    formula,
    results: ranges.map((range, i) => ({ range, text: `r${i}`, documentRef: null })),
  };
}

describe("roll tables (§10)", () => {
  test("validateTable rejects empty, inverted and overlapping ranges", () => {
    expect(validateTable(table([]))).toBe("table has no results");
    expect(validateTable(table([[5, 2]]))).toContain("inverted");
    expect(
      validateTable(
        table([
          [1, 5],
          [5, 9],
        ]),
      ),
    ).toContain("overlaps");
    expect(
      validateTable(
        table([
          [1, 5],
          [6, 20],
        ]),
      ),
    ).toBeNull();
  });

  test("a draw lands in the matching range", () => {
    const t = table([
      [1, 10],
      [11, 20],
    ]);
    const d = drawFromTable(t, seq(0.55)); // 1d20 → 12
    expect(d.missed).toBe(false);
    expect(d.roll.total).toBe(12);
    expect(d.result?.text).toBe("r1");
  });

  test("gaps re-roll until a range matches", () => {
    const t = table([
      [1, 1],
      [3, 20],
    ]); // 2 is a gap
    const d = drawFromTable(t, seq(0.05, 0.05, 0.15)); // 2 (gap), 2 (gap), 4 → hit
    expect(d.missed).toBe(false);
    expect(d.result?.text).toBe("r1");
  });

  test("broken formula yields a missed draw, not a throw", () => {
    const d = drawFromTable(table([[1, 20]], "1d"), seq(0.5));
    expect(d.missed).toBe(true);
    expect(d.result).toBeNull();
  });

  test("documentRef passes through for linked results", () => {
    const t: RollTableDocument = {
      ...table([[1, 20]]),
      results: [{ range: [1, 20], text: "a journal", documentRef: { coll: "journals", id: "j1" } }],
    };
    const d = drawFromTable(t, seq(0.5));
    expect(d.result?.documentRef?.id).toBe("j1");
  });
});

function folder(
  id: string,
  parent: string | null,
  targetType: FolderDocument["targetType"] = "actors",
): FolderDocument {
  return {
    _id: id,
    type: "folder",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    parent,
    targetType,
  };
}

describe("folders (§4/§10)", () => {
  test("buildFolderTree nests and depths", () => {
    const roots = buildFolderTree([
      folder("a", null),
      folder("b", "a"),
      folder("c", "b"),
      folder("d", null),
    ]);
    expect(roots.map((r) => r.folder._id)).toEqual(["a", "d"]);
    expect(roots[0]?.children[0]?.folder._id).toBe("b");
    expect(roots[0]?.children[0]?.children[0]?.folder._id).toBe("c");
    expect(roots[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  test("missing or self parent becomes a root (no crash)", () => {
    const roots = buildFolderTree([folder("x", "ghost"), folder("y", "y")]);
    expect(roots.map((r) => r.folder._id).sort()).toEqual(["x", "y"]);
  });

  test("flattenTree is depth-first", () => {
    const flat = flattenTree(
      buildFolderTree([folder("a", null), folder("b", "a"), folder("c", null), folder("d", "b")]),
    );
    expect(flat.map((n) => n.folder._id)).toEqual(["a", "b", "d", "c"]);
  });

  test("wouldCycle blocks moving under descendants", () => {
    const fs = [folder("a", null), folder("b", "a"), folder("c", "b")];
    expect(wouldCycle(fs, "a", "c")).toBe(true); // a under its own descendant
    expect(wouldCycle(fs, "a", "b")).toBe(true);
    expect(wouldCycle(fs, "a", "a")).toBe(true); // self
    expect(wouldCycle(fs, "c", "a")).toBe(false); // leaf under root is fine
    expect(wouldCycle(fs, "c", null)).toBe(false);
  });

  test("wouldCycle survives pre-existing cycles in data", () => {
    const fs = [folder("a", "b"), folder("b", "a")];
    expect(wouldCycle(fs, "a", "b")).toBe(true);
    expect(wouldCycle(fs, "a", null)).toBe(false);
  });

  test("folderPath joins names root→leaf; foldersFor filters by targetType", () => {
    const fs = [folder("a", null), folder("b", "a"), folder("j", null, "journals")];
    expect(folderPath(fs, "b")).toBe("a / b");
    expect(foldersFor(fs, "actors").map((f) => f._id)).toEqual(["a", "b"]);
  });
});
