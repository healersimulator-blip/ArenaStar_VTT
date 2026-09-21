/**
 * Item-window navigation (plan §1.3 item 2) — the same rules as `pf1eSheetWindow.ts`:
 * everything is read from the client's projected store, the actor's own readability decides
 * whether the window opens at all, and one stable window id per (actor, item) pair.
 */
import type { ClientSync, ClientEvents } from "../../client/sync";
import type { ActorDocument, ItemDocument } from "../../core/documents";
import type { EventBus } from "../../core/events";
import type { WindowManager } from "../../core/windows";
import { readablePF1eActor } from "./pf1eSheetWindow";

type SheetClient = Pick<ClientSync, "store" | "user">;

/** The item document, when the reader may see the actor it is embedded in. */
export function readableItem(
  client: SheetClient,
  actorId: string,
  itemId: string,
): { actor: ActorDocument; item: ItemDocument } | null {
  const actor = readablePF1eActor(client, actorId);
  if (actor === null) return null;
  const item = actor.items.find((i) => i._id === itemId);
  return item ? { actor, item } : null;
}

/** One stable window per item; a re-open focuses the existing one through `manager.open`. */
export function openPF1eItemWindow(
  manager: WindowManager,
  client: SheetClient,
  actorId: string,
  itemId: string,
): boolean {
  if (readableItem(client, actorId, itemId) === null) return false;
  manager.open({
    id: `pf1e-item:${actorId}:${itemId}`,
    // The live name lives in the window body; chrome stays valid after a rename.
    title: "Item",
    kind: "item",
    data: { actorId, itemId },
    x: 96 + (manager.list().length % 5) * 24,
    y: 72 + (manager.list().length % 5) * 24,
    width: 420,
    height: 520,
  });
  return true;
}

/** Refresh on every store/permission event; unsubscribe when the window closes. */
export function observePF1eItem(
  client: SheetClient,
  bus: EventBus<ClientEvents>,
  actorId: string,
  itemId: string,
  changed: (value: { actor: ActorDocument; item: ItemDocument } | null) => void,
): () => void {
  const refresh = () => changed(readableItem(client, actorId, itemId));
  const offs = [
    bus.on("snapshot", refresh),
    bus.on("ops", refresh),
    bus.on("rejected", refresh),
    bus.on("welcome", refresh),
  ];
  refresh();
  return () => offs.forEach((off) => off());
}
