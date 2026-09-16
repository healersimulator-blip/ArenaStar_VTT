import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

export const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

type AnySurface = Record<string, () => unknown>;

export const surfaceCall = <T>(page: Page, surface: "app" | "player" | "gm", method: string): Promise<T> =>
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
/** GM-host surface (strategic fog, §12 readbacks, reaction prompt) — installed by the host app. */
export const gmCall = <T>(page: Page, method: string): Promise<T> =>
  surfaceCall<T>(page, "gm", method);

export async function waitForSurface(page: Page, surface: "app" | "player" | "gm"): Promise<void> {
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
  surface: "app" | "player" | "gm",
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

/**
 * Import the shipped data-only `pf1e-core` package into the running app (V10 browser gate).
 *
 * The pack list is read from `systems/pf1e-core/manifest.json` rather than hardcoded: D-234
 * (M15/M16/M18) grew that manifest from two packs to five, and a hardcoded
 * `["manifest.json", "packs/bestiary.json", "packs/spells.json"]` then produced a zip whose
 * manifest declared three files it did not ship — `buildPackageFromFiles` refuses that with
 * `package pf1e-core: pack file packs/classes.json is missing`, which surfaced as five opaque
 * `{ok:false}` browser failures. Deriving the list makes the helper immune to the next pack.
 */
export async function importShippedCore(page: Page): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { zipSync } = await import("fflate");
  const manifestText = readFileSync(
    new URL("../systems/pf1e-core/manifest.json", import.meta.url),
    "utf8",
  );
  const declared = (JSON.parse(manifestText) as { packs?: Array<{ file?: unknown }> })
    .packs?.map((pack) => pack.file)
    .filter((file): file is string => typeof file === "string");
  if (!declared || declared.length === 0) {
    throw new Error("pf1e-core manifest declares no packs — nothing to ship");
  }
  const files = Object.fromEntries(
    ["manifest.json", ...declared].map((path) => [
      path,
      readFileSync(new URL(`../systems/pf1e-core/${path}`, import.meta.url)),
    ]),
  );
  const imported = await surfaceCallArg<{ ok: boolean; error?: string }>(
    page,
    "app",
    "importPackageZip",
    Array.from(zipSync(files)),
  );
  if (!imported.ok) {
    throw new Error(`pf1e-core import failed: ${imported.error ?? "unknown"}`);
  }
}

