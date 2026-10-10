import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applySidebarMap, entry, solidPng, waitForSurface } from "./lib";

/**
 * Phase 4 origin check (design §8): the built app boots and completes a sidebar image import from
 * both `file://` and `https:`. The whole suite already runs from `file://` (lib.ts `entry`); this spec
 * adds the https origin, which the CSP (`img-src https:`, `connect-src https:`) also depends on.
 */

const distIndex = fileURLToPath(new URL("../dist/index.html", import.meta.url));
const mapPng = Buffer.from(solidPng(16, 8, [90, 140, 190]));

async function serveDistOverHttps(): Promise<{ server: Server; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), "arena-origin-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  const html = readFileSync(distIndex);
  const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    const path = new URL(req.url ?? "/", "https://localhost").pathname;
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `https://localhost:${(server.address() as AddressInfo).port}` };
}

async function importMapAndReadScene(page: Page): Promise<string> {
  await waitForSurface(page, "app");
  await page.setInputFiles("#map-input", { name: "origin-map.png", mimeType: "image/png", buffer: mapPng });
  await applySidebarMap(page);
  await expect.poll(() => page.evaluate(() => {
    const store = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { getAll: (c: "scenes") => Array<{ img: string | null }> } } } } } })
      .__vttE2E?.app?.gm?.client?.store;
    return store?.getAll("scenes")[0]?.img ?? null;
  })).toMatch(/^[0-9a-f]{64}$/);
  return page.evaluate(() => {
    const store = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { getAll: (c: "scenes") => Array<{ img: string | null }> } } } } } })
      .__vttE2E?.app?.gm?.client?.store;
    return store?.getAll("scenes")[0]?.img ?? "";
  });
}

test.describe("app origins (Phase 4, §8)", () => {
  test.use({ ignoreHTTPSErrors: true });

  test("file:// boots and imports a map", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    const hash = await importMapAndReadScene(page);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("https boots and imports a map", async ({ page }) => {
    const { server, base } = await serveDistOverHttps();
    try {
      await page.goto(base + "/index.html?e2e=1");
      const hash = await importMapAndReadScene(page);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
