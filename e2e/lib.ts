import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

export const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

type AnySurface = Record<string, () => unknown>;

export const surfaceCall = <T>(page: Page, surface: "app" | "player", method: string): Promise<T> =>
  page.evaluate(
    ({ surface, method }) => {
      const e2e = (globalThis as { __vttE2E?: Record<string, AnySurface | null> }).__vttE2E;
      const fn = e2e?.[surface]?.[method];
      if (typeof fn !== "function") throw new Error(`${surface} surface missing: ${method}`);
      return fn() as T;
    },
    { surface, method },
  );

export const hostCall = <T>(page: Page, method: string): Promise<T> =>
  surfaceCall<T>(page, "app", method);
export const playerCall = <T>(page: Page, method: string): Promise<T> =>
  surfaceCall<T>(page, "player", method);

export async function waitForSurface(page: Page, surface: "app" | "player"): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ok = await page.evaluate(
      (surface) =>
        (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E?.[surface] != null,
      surface,
    );
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`surface never appeared: ${surface}`);
    await page.waitForTimeout(100);
  }
}

/** Call a one-arg surface method (e.g. cacheHas(hash)). */
export const surfaceCallArg = <T>(
  page: Page,
  surface: "app" | "player",
  method: string,
  arg: unknown,
): Promise<T> =>
  page.evaluate(
    ({ surface, method, arg }) => {
      const e2e = (
        globalThis as {
          __vttE2E?: Record<string, Record<string, (...a: unknown[]) => T> | undefined>;
        }
      ).__vttE2E;
      const fn = e2e?.[surface]?.[method];
      if (typeof fn !== "function") throw new Error(`${surface} surface missing: ${method}`);
      return fn(arg) as T;
    },
    { surface, method, arg },
  );

/** Manual-only invite fragment (strips &h= so the join never rides relays). */
export const manualFragment = (inviteLink: string): string => {
  const params = new URLSearchParams(inviteLink.slice(inviteLink.indexOf("#") + 1));
  return `room=${params.get("room")}&k=${params.get("k")}`;
};
