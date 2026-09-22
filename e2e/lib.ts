import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { deflateSync as zlibDeflate } from "node:zlib";

export const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

type AnySurface = Record<string, () => unknown>;
/** `playerCanvas` (D-251) is the player shell's stage readback — fog's token gate. */
export type SurfaceName = "app" | "player" | "gm" | "playerCanvas";

export const surfaceCall = <T>(page: Page, surface: SurfaceName, method: string): Promise<T> =>
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

export async function waitForSurface(page: Page, surface: SurfaceName): Promise<void> {
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

/** Call a surface method with any number of arguments (a readback that takes two, say). */
export const surfaceCallArgs = <T>(
  page: Page,
  surface: SurfaceName,
  method: string,
  args: unknown[],
): Promise<T> =>
  page.evaluate(
    ({ surface, method, args }) => {
      const e2e = (
        globalThis as {
          __vttE2E?: Record<string, Record<string, (...a: unknown[]) => T> | undefined>;
        }
      ).__vttE2E;
      const fn = e2e?.[surface]?.[method];
      if (typeof fn !== "function") throw new Error(`${surface} surface missing: ${method}`);
      return fn(...args) as T;
    },
    { surface, method, args },
  );

/** Call a one-arg surface method (e.g. cacheHas(hash)). */
export const surfaceCallArg = <T>(
  page: Page,
  surface: SurfaceName,
  method: string,
  arg: unknown,
): Promise<T> => surfaceCallArgs<T>(page, surface, method, [arg]);

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

/**
 * A real PNG of a given size, built here instead of checked in as a binary.
 *
 * Map-shaped specs need an image whose *dimensions* mean something (the hexcrawl wizard derives
 * its cell count from them), and a 1×1 fixture like `TINY_PNG` would make every map one cell.
 * A solid-colour truecolor PNG is a few kilobytes at any size, and `zlib` does the compression,
 * so the spec carries no base64 blob. The CRC table is the PNG spec's own — `zlib.crc32` exists
 * only on newer Node builds, and a spec must not depend on which one CI runs.
 */
export function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number] = [64, 92, 68],
): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibDeflate(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
