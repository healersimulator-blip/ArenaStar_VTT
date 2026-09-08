/** CRB p.178 Initiative: equal totals compare total modifiers, then roll remaining ties.
 * https://www.aonprd.com/Rules.aspx?ID=95
 * Tie dice only establish relative order; they never change the initiative result.
 */
export interface InitiativeEntry {
  id: string;
  total: number;
  modifier: number;
}
export type InitiativeOrderResult = {
  order: string[];
  tieRolls: Record<string, number[]>;
  error: string | null;
};
export function resolveInitiativeOrder(
  entries: readonly InitiativeEntry[],
  d20: () => number,
): InitiativeOrderResult {
  const fail = (error: string): InitiativeOrderResult => ({ order: [], tieRolls: {}, error });
  if (
    new Set(entries.map((e) => e.id)).size !== entries.length ||
    entries.some((e) => !Number.isSafeInteger(e.total) || !Number.isSafeInteger(e.modifier))
  )
    return fail("Invalid initiative entries.");
  const rolls = new Map(entries.map((e) => [e.id, [] as number[]]));
  let error: string | null = null;
  function breakTie(group: InitiativeEntry[], depth: number): InitiativeEntry[] {
    if (group.length < 2 || error) return group;
    // A broken RNG must not hang the tracker or fabricate a winner. Discard the proposal.
    if (depth >= 20) {
      error =
        "Initiative tie remained unresolved after 20 roll-offs. Try rolling again; no results were applied.";
      return [];
    }
    const values = new Map<string, number>();
    for (const member of group) {
      const die = d20();
      if (!Number.isInteger(die) || die < 1 || die > 20) {
        error = "Invalid initiative tie die; no results were applied.";
        return [];
      }
      values.set(member.id, die);
      rolls.get(member.id)?.push(die);
    }
    group.sort((a, b) => (values.get(b.id) ?? 0) - (values.get(a.id) ?? 0));
    const result: InitiativeEntry[] = [];
    for (let i = 0; i < group.length;) {
      let end = i + 1;
      while (
        end < group.length &&
        values.get(group[end]?.id ?? "") === values.get(group[i]?.id ?? "")
      )
        end++;
      result.push(...breakTie(group.slice(i, end), depth + 1));
      i = end;
    }
    return result;
  }
  const sorted = [...entries].sort((a, b) => b.total - a.total || b.modifier - a.modifier);
  const ordered: InitiativeEntry[] = [];
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (
      end < sorted.length &&
      sorted[end]?.total === sorted[i]?.total &&
      sorted[end]?.modifier === sorted[i]?.modifier
    )
      end++;
    ordered.push(...breakTie(sorted.slice(i, end), 0));
    i = end;
  }
  return error
    ? fail(error)
    : { order: ordered.map((e) => e.id), tieRolls: Object.fromEntries(rolls), error: null };
}
