import { describe, expect, test } from "vitest";
import type { CodexQuest, JournalDocument } from "../../src/core/documents";
import { codexQuestBoardRows } from "../../src/ui/journals/codexQuestBoard";

function quest(
  id: string,
  title: string,
  options: {
    order?: number;
    pinned?: boolean;
    description?: string;
    objectives?: CodexQuest["objectives"];
  } = {},
): CodexQuest {
  return {
    id,
    title,
    description: options.description ?? "",
    state: "active",
    pinned: options.pinned ?? false,
    order: options.order ?? 0,
    objectives: options.objectives ?? [],
  };
}

function sheet(
  id: string,
  name: string,
  quests: CodexQuest[],
): JournalDocument {
  return {
    _id: id,
    type: "journal",
    name,
    ownership: { default: 3 },
    flags: {},
    system: {},
    pages: [],
    codex: { version: 1, kind: "group", links: [], widgets: [], quests },
  };
}

describe("Campaign Codex global quest board", () => {
  test("orders pinned quests first, then source sheets and sheet-local order without mutating input", () => {
    const amber = sheet("amber", "Amber Guild", [
      quest("amber-later", "Second", { order: 1 }),
      quest("amber-pinned", "Pinned amber", { order: 9, pinned: true }),
      quest("amber-first", "First", { order: 0 }),
    ]);
    const zephyr = sheet("zephyr", "Zephyr Circle", [
      quest("zephyr-pinned", "Pinned zephyr", { order: 0, pinned: true }),
    ]);

    const rows = codexQuestBoardRows([zephyr, amber]);

    expect(rows.map((row) => row.quest.id)).toEqual([
      "amber-pinned",
      "zephyr-pinned",
      "amber-first",
      "amber-later",
    ]);
    expect(amber.codex?.quests?.map((item) => item.id)).toEqual([
      "amber-later",
      "amber-pinned",
      "amber-first",
    ]);
  });

  test("searches authorized source and nested objective text and can hide unpinned rows", () => {
    const journal = sheet("harbor", "Harbor Watch", [
      quest("pinned", "Find the missing chart", {
        pinned: true,
        description: "Ask the dockmaster.",
        objectives: [
          {
            id: "objective",
            title: "Search the lighthouse",
            description: "Look beneath the brass lantern.",
            completed: false,
            order: 0,
            children: [
              {
                id: "child",
                title: "Find the keeper",
                completed: false,
                order: 0,
                children: [],
              },
            ],
          },
        ],
      }),
      quest("unpinned", "Repair the bell", { order: 1 }),
    ]);

    expect(
      codexQuestBoardRows([journal], { query: "BRASS LANTERN" }).map(
        (row) => row.quest.id,
      ),
    ).toEqual(["pinned"]);
    expect(
      codexQuestBoardRows([journal], { query: "keeper" }).map(
        (row) => row.quest.id,
      ),
    ).toEqual(["pinned"]);
    expect(
      codexQuestBoardRows([journal], { showUnpinned: false }).map(
        (row) => row.quest.id,
      ),
    ).toEqual(["pinned"]);
  });

  test("returns only records present in the supplied viewer projection", () => {
    const projected = sheet("published", "Published", [
      quest("visible", "Visible quest"),
    ]);

    expect(
      codexQuestBoardRows([projected]).map((row) => [
        row.sheet._id,
        row.quest.id,
      ]),
    ).toEqual([["published", "visible"]]);
  });
});
