import type {
  CodexObjective,
  CodexQuest,
  JournalDocument,
} from "../../core/documents";

/**
 * One quest as it appears in the Codex Hub's viewer-specific board.
 *
 * `sheet` must come from the active viewer's projected journal set. This presentation helper does
 * not implement authorization; callers must project/filter journals before passing them here.
 */
export interface CodexQuestBoardRow {
  key: string;
  sheet: JournalDocument;
  quest: CodexQuest;
}

function objectiveSearchText(objectives: readonly CodexObjective[]): string {
  return objectives
    .map(
      (objective) =>
        `${objective.title} ${objective.description ?? ""} ${objectiveSearchText(objective.children)}`,
    )
    .join(" ");
}

/**
 * Build the global quest-board rows from already-authorized sheets. Pinned quests sort first;
 * everything else is ordered by source sheet and then the sheet-local quest order. `query` is
 * applied only to visible quest/source/objective fields so it cannot become a hidden-content probe.
 */
export function codexQuestBoardRows(
  projectedSheets: readonly JournalDocument[],
  options: { query?: string; showUnpinned?: boolean } = {},
): CodexQuestBoardRow[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const showUnpinned = options.showUnpinned !== false;
  const rows: CodexQuestBoardRow[] = [];

  for (const sheet of projectedSheets) {
    if (sheet.codex?.version !== 1) continue;
    for (const quest of sheet.codex.quests ?? []) {
      if (!showUnpinned && !quest.pinned) continue;
      if (query) {
        const searchable = [
          sheet.name,
          sheet.codex.subtitle ?? "",
          quest.title,
          quest.description,
          objectiveSearchText(quest.objectives),
        ]
          .join(" ")
          .toLocaleLowerCase();
        if (!searchable.includes(query)) continue;
      }
      rows.push({
        key: JSON.stringify([sheet._id, quest.id]),
        sheet,
        quest,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      Number(b.quest.pinned) - Number(a.quest.pinned) ||
      a.sheet.name.localeCompare(b.sheet.name) ||
      a.quest.order - b.quest.order ||
      a.quest.title.localeCompare(b.quest.title) ||
      a.quest.id.localeCompare(b.quest.id),
  );
}
