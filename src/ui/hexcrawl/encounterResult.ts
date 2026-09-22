/**
 * **Encounter results** (Phase 3, plan §5.5) — where a roll's outcome lives between the wizard and
 * the results window.
 *
 * `WindowSpec.data` is `Record<string, string>` (core/windows.ts), so a drawn roll cannot travel
 * inside the window spec the way a document id can. It travels here instead, in a module-level
 * registry keyed by window id — the same "one stable window per thing, the payload is looked up
 * by id" shape `pf1eItemWindow.ts` uses for item windows, minus the store read, because a *test
 * roll* of a table that has not been saved has nothing in the store to read.
 *
 * Resolution of an entry's refs is deliberately here and not in the components: the bestiary
 * picker, the results window and (Phase 5) the token placement all need "what is this ref, and
 * what image does it have", and they must not answer it three different ways.
 */
import type { ClientSync } from "../../client/sync";
import type {
  ActorDocument,
  EncounterRef,
  TokenDocument,
} from "../../core/documents";
import type { EncounterRoll } from "../../core/hexcrawl/encounter";
import type { WindowManager } from "../../core/windows";
import { loadWorldCompendia } from "../sheets/compendiumLoader";

export interface EncounterResult {
  roll: EncounterRoll;
  /** A wizard *test roll*: nothing was created, no message posted, no ledger written (§5.4). */
  preview: boolean;
  /** Where it happened, for the result card's title (`null` for a test roll). */
  sceneId: string | null;
  cellKey: string | null;
}

const results = new Map<string, EncounterResult>();

/** Open the results window for a roll; `id` is stable per (table, cell, roll) so a second draw
 * of the same table opens a *new* window rather than overwriting the first one's outcome. */
export function openEncounterResult(
  manager: WindowManager,
  id: string,
  result: EncounterResult,
): void {
  results.set(id, result);
  manager.open({
    id,
    title: result.preview
      ? `Test roll — ${result.roll.tableName}`
      : "Encounter",
    kind: "encounterResult",
    x: 120 + (manager.list().length % 5) * 24,
    y: 96 + (manager.list().length % 5) * 24,
    width: 420,
    height: 380,
    data: { resultId: id },
  });
}

export function encounterResultOf(id: string): EncounterResult | null {
  return results.get(id) ?? null;
}

/** Called by the window on destroy (and by any flow that supersedes a result). */
export function forgetEncounterResult(id: string): void {
  results.delete(id);
}

/** One-line id for a roll, so the same table drawn twice gets two windows. */
export function encounterResultId(
  tableId: string,
  cellKey: string | null,
  roll: number,
): string {
  return `encounter-result:${tableId}:${cellKey ?? "-"}:${roll}`;
}

export interface ResolvedRef {
  ref: EncounterRef;
  name: string;
  img: string;
  /** A secondary line: the pack, the creature's type, or "in this world". */
  note: string;
  /** Set when the ref resolves to something placeable (a world actor). */
  actor: ActorDocument | null;
  /** The actor's token prototype on the scene, when it has one (its image and size). */
  token: TokenDocument | null;
}

/**
 * What a ref *is*, in the world as it stands right now.
 *
 * A compendium ref names a pack by **name** (`packId`), matching the compendium drag payload's
 * `packName` (App.svelte's `onCompendiumDrop`): the picker hands its caller the pack it read the
 * entry from, not a package id, and a name is what a world file can carry across a re-import.
 * The entry is looked up inside that pack first, then in any pack of the same package, so a pack
 * that was renamed still resolves when the entry is unambiguous.
 */
export async function resolveEncounterRefs(
  client: Pick<ClientSync, "store">,
  refs: readonly EncounterRef[],
  worldId?: string,
): Promise<ResolvedRef[]> {
  if (refs.length === 0) return [];
  const rows = await loadWorldCompendia(worldId).catch(() => []);
  const out: ResolvedRef[] = [];
  for (const ref of refs) {
    if (ref.kind === "compendium") {
      const candidates = rows.filter((r) => r.pack.name === ref.packId);
      const pools = candidates.length > 0 ? candidates : rows;
      let found: { name: string; img: string; note: string } | null = null;
      for (const row of pools) {
        const entry = row.pack.entries.find((e) => e.id === ref.entryId);
        if (!entry) continue;
        found = {
          name: entry.name,
          img: entry.img ?? "",
          note: row.pack.name,
        };
        break;
      }
      out.push({
        ref,
        name: found?.name ?? ref.entryId,
        img: found?.img ?? "",
        note: found ? found.note : `${ref.packId} (not found in this world)`,
        actor: null,
        token: null,
      });
      continue;
    }
    const actor = client.store.get("actors", ref.actorId) ?? null;
    out.push({
      ref,
      name: actor?.name ?? ref.actorId,
      img: actor ? actorImageOf(actor, client) : "",
      note: actor ? "in this world" : "actor missing",
      actor,
      token: actor ? actorTokenOf(actor, client) : null,
    });
  }
  return out;
}

/** An actor's image: its own `system.img`/`flags.core.img` if it carries one, else the image of
 * the first token that uses it. Compendium imports set `img` on the *entry*, not the actor, so the
 * token is usually the only place the art survives a drop. */
export function actorImageOf(
  actor: ActorDocument,
  client: Pick<ClientSync, "store">,
): string {
  const fromSystem = actor.system?.["img"];
  if (typeof fromSystem === "string" && fromSystem !== "") return fromSystem;
  const fromFlags = (actor.flags as Record<string, unknown>)?.["core"];
  if (typeof fromFlags === "object" && fromFlags !== null) {
    const img = (fromFlags as Record<string, unknown>)["img"];
    if (typeof img === "string" && img !== "") return img;
  }
  return actorTokenOf(actor, client)?.img ?? "";
}

/** The first token on any scene that this actor owns — the prototype Phase 5 places from. */
export function actorTokenOf(
  actor: ActorDocument,
  client: Pick<ClientSync, "store">,
): TokenDocument | null {
  for (const scene of client.store.getAll("scenes")) {
    const token = (scene.tokens ?? []).find((t) => t.actorId === actor._id);
    if (token) return token;
  }
  return null;
}
