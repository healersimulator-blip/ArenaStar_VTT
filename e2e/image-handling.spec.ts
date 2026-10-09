import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:https";
import { entry, hostCall, solidPng, waitForSurface } from "./lib";

const imageBytes = [...solidPng(16, 8, [90, 140, 190])];

type ImageFileSpec = { name: string; type: string; bytes: number[] };
type DropSpec = { files?: ImageFileSpec[]; uriList?: string; html?: string; text?: string };

async function dispatchDrop(page: Page, selector: string, payload: DropSpec): Promise<void> {
  await page.locator(selector).evaluate((target, value) => {
    const transfer = new DataTransfer();
    for (const file of value.files ?? []) {
      transfer.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: file.type }));
    }
    if (value.uriList) transfer.setData("text/uri-list", value.uriList);
    if (value.html) transfer.setData("text/html", value.html);
    if (value.text) transfer.setData("text/plain", value.text);
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, payload);
}

async function imageState(page: Page): Promise<{ scenes: Array<{ name: string; width: number; height: number; img: string | null; thumbnail: string | null; logicalFolder?: string }>; assetIds: string[] }> {
  return page.evaluate(() => {
    const surface = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: {
      getAll: (collection: "scenes") => Array<{ name: string; width: number; height: number; img: string | null; thumbnail: string | null; logicalFolder?: string }>;
      world?: { assetManifest?: Record<string, { logicalFiles?: Array<{ folder: string; name: string }> }> };
    } } } } } }).__vttE2E;
    const store = surface?.app?.gm?.client?.store;
    const manifest = store?.world?.assetManifest ?? {};
    return {
      scenes: (store?.getAll("scenes") ?? []).map(({ name, width, height, img, thumbnail }) => {
        const logicalFile = img ? manifest[img]?.logicalFiles?.find((file) => file.name === name) : undefined;
        return {
          name, width, height, img, thumbnail,
          ...(logicalFile ? { logicalFolder: logicalFile.folder } : {}),
        };
      }),
      assetIds: Object.keys(manifest).sort(),
    };
  });
}

async function hostUser(page: Page): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
}

/**
 * Real HTTPS fixtures (design §9 URL modes). Playwright's `route.fulfill` skips CORS checks, so a
 * mocked route cannot prove the CORS behaviour. The CSP allows `https:` images and connections, so
 * a self-signed localhost certificate (generated into a temp dir, never committed) is enough.
 */
const fixtures: { base: string; server: Server | null } = { base: "", server: null };

async function startHttpsFixtures(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "arena-image-fixtures-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    const path = new URL(req.url ?? "/", "https://localhost").pathname;
    if (path === "/cors/map.png") {
      res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
      res.end(Buffer.from(imageBytes));
      return;
    }
    if (path === "/nocors/map.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(imageBytes));
      return;
    }
    if (path === "/proxy/map.png") {
      // A pass-through proxy: fetch the no-CORS fixture and add the header on the way back.
      const upstream = https.get({ host: "127.0.0.1", port: (server.address() as AddressInfo).port,
        path: "/nocors/map.png", servername: "localhost", rejectUnauthorized: false }, (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, "access-control-allow-origin": "*" });
        up.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixtures.server = server;
  fixtures.base = `https://localhost:${(server.address() as AddressInfo).port}`;
}

test.describe("image ingest UI (design §5, §8)", () => {
  test.use({ ignoreHTTPSErrors: true });
  test.beforeAll(startHttpsFixtures);
  test.afterAll(() => new Promise<void>((resolve) => { fixtures.server?.close(() => resolve()); }));

  test("a synthetic Scenes-tab drop imports a batch as correctly sized scenes with thumbnails", async ({ page }) => {
    await hostUser(page);
    await page.locator('[data-tab="scenes"]').click();
    const before = await imageState(page);

    await dispatchDrop(page, '[aria-label="Drop one or more images here to create scenes"]', {
      files: [
        { name: "alpha_map+1.png", type: "image/png", bytes: imageBytes },
        { name: "beta.png", type: "image/png", bytes: imageBytes },
        { name: "gamma.png", type: "image/png", bytes: imageBytes },
      ],
    });

    const dialog = page.locator("[data-image-import-dialog]");
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Document name")).toHaveValue("alpha map 1");
    await expect(dialog.getByText("16 × 8 px", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Apply to all 3" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => hostCall<number>(page, "sceneCount"), { timeout: 30_000 })
      .toBe(before.scenes.length + 3);

    const after = await imageState(page);
    const imported = after.scenes.filter((scene) => ["alpha map 1", "beta", "gamma"].includes(scene.name));
    expect(imported).toHaveLength(3);
    for (const scene of imported) {
      expect(scene).toMatchObject({ width: 16, height: 8, logicalFolder: "Scenes" });
      expect(scene.img).toMatch(/^[a-f0-9]{64}$/);
      expect(scene.thumbnail).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(after.assetIds.length).toBeGreaterThan(before.assetIds.length);
    await expect(page.locator(".scene-card").filter({ hasText: "alpha map 1" }).locator("img"))
      .toBeVisible({ timeout: 20_000 });
  });

  test("undo removes the scene reference, and the imported bytes stay in the library (§6.8)", async ({ page }) => {
    await hostUser(page);
    await page.locator('[data-tab="scenes"]').click();
    const before = await imageState(page);

    await dispatchDrop(page, '[aria-label="Drop one or more images here to create scenes"]', {
      files: [{ name: "undo_probe.png", type: "image/png", bytes: imageBytes }],
    });
    const dialog = page.locator("[data-image-import-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => hostCall<number>(page, "sceneCount"), { timeout: 30_000 })
      .toBe(before.scenes.length + 1);

    const created = await imageState(page);
    const scene = created.scenes.find((entry) => entry.name === "undo probe");
    expect(scene?.img).toMatch(/^[a-f0-9]{64}$/);
    const blob = scene?.img ?? "";
    expect(created.assetIds).toContain(blob);

    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect.poll(() => hostCall<number>(page, "sceneCount"), { timeout: 30_000 })
      .toBe(before.scenes.length);

    // Revert removes the document reference; the content-addressed bytes are not deleted.
    const after = await imageState(page);
    expect(after.scenes.some((entry) => entry.name === "undo probe")).toBe(false);
    expect(after.assetIds).toContain(blob);
  });

  test("synthetic image paste offers a preview and preview-only creates neither documents nor assets", async ({ page }) => {
    await hostUser(page);
    const before = await imageState(page);
    await page.evaluate((bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(bytes)], "clipboard-map.png", { type: "image/png" }));
      document.body.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }));
    }, imageBytes);

    const dialog = page.locator("[data-image-import-dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".preview-frame img")).toBeVisible();
    await page.getByLabel("Destination action").selectOption("preview");
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(dialog).toHaveCount(0);

    const after = await imageState(page);
    expect(after.scenes).toHaveLength(before.scenes.length);
    expect(after.assetIds).toEqual(before.assetIds);
  });

  test("HTTPS URL drops honor CORS, show a generic fallback, and explain Pinterest pin pages", async ({ page }) => {
    await hostUser(page);
    const cors = `${fixtures.base}/cors/map.png`;
    const noCors = `${fixtures.base}/nocors/map.png`;
    const proxied = `${fixtures.base}/proxy/map.png`;
    const dialog = page.locator("[data-image-import-dialog]");

    // A server that sends CORS headers loads like any other image.
    await dispatchDrop(page, "body", { text: cors });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".preview-frame img")).toBeVisible();
    await page.getByLabel("Destination action").selectOption("preview");
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(dialog).toHaveCount(0);

    // A proxy in front of the no-CORS server adds the header, so it behaves like the first.
    await dispatchDrop(page, "body", { text: proxied });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".preview-frame img")).toBeVisible();
    await page.getByLabel("Destination action").selectOption("preview");
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(dialog).toHaveCount(0);

    // Without CORS the browser refuses the read: the generic message and save-and-drop instruction show.
    await dispatchDrop(page, "body", { text: noCors });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("Save the image to your computer and drop the file here.");
    await page.getByRole("button", { name: "Close image preview" }).click();
    await expect(dialog).toHaveCount(0);

    await dispatchDrop(page, "body", { text: "https://www.pinterest.com/pin/123456789/" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("This is a Pinterest page, not an image. Copy the image address instead.");
  });
});
