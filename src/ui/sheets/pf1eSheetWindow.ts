/** PF1e sheet navigation reads only the client's projected store, never host-private data. */
import type { ClientSync, ClientEvents } from "../../client/sync";
import type { ActorDocument } from "../../core/documents";
import type { EventBus } from "../../core/events";
import { can } from "../../core/permissions";
import type { WindowBounds, WindowManager } from "../../core/windows";
import { isPF1eActor } from "./pf1eSheetModel";

type SheetClient = Pick<ClientSync, "store" | "user">;

export function readablePF1eActor(
  client: SheetClient,
  actorId: string,
): ActorDocument | null {
  const actor = client.store.get("actors", actorId);
  return actor &&
    isPF1eActor(actor) &&
    client.user &&
    can(client.user, "read", actor, "actors")
    ? actor
    : null;
}

/** One stable window per actor; reopening restores/focuses instead of duplicating. */
export function openPF1eSheetWindow(
  manager: WindowManager,
  client: SheetClient,
  actorId: string,
  bounds?: WindowBounds,
  /** E02: open directly on a sheet tab, e.g. "effects" from the token menu. */
  tab?: string,
): boolean {
  if (!readablePF1eActor(client, actorId)) return false;
  if (bounds) manager.setBounds(bounds);
  manager.open({
    id: `pf1e-sheet:${actorId}`,
    // Names live in the reactive body, not stale window chrome after a revocation.
    title: "PF1e actor sheet",
    kind: "pf1e-sheet",
    data: { actorId, ...(tab !== undefined ? { tab } : {}) },
    x: 32 + (manager.list().length % 5) * 24,
    y: 32 + (manager.list().length % 5) * 24,
    width: 480,
    height: 560,
  });
  return true;
}

/** Refresh even on rejection/permission changes; unsubscribe when the window closes. */
export function observePF1eSheetActor(
  client: SheetClient,
  bus: EventBus<ClientEvents>,
  actorId: string,
  changed: (actor: ActorDocument | null) => void,
): () => void {
  const refresh = () => changed(readablePF1eActor(client, actorId));
  const offs = [
    bus.on("snapshot", refresh),
    bus.on("ops", refresh),
    bus.on("rejected", refresh),
    bus.on("welcome", refresh),
  ];
  refresh();
  return () => offs.forEach((off) => off());
}
