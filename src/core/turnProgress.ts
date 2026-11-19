import type { Head } from "./strategicRoom/protocol";

/** Display phases only. A phase reports actual work, not an estimated percentage. */
export type TurnProgressStage =
  "closing" | "resolving" | "applying" | "retrying";

export function hostedTurnProgress(
  head: Head | null,
  applied: Head | null,
  waitingForClose: boolean,
): TurnProgressStage | null {
  if (head?.phase === "resolution") return "resolving";
  if (head && applied && head.version > applied.version) return "applying";
  if (!waitingForClose) return null;
  return head?.phase === "paused"
    ? "retrying"
    : !head || head.phase === "orders"
      ? "closing"
      : null;
}
