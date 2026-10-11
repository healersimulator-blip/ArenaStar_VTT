import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { entry, hostCall, waitForSurface } from "./lib";

test.setTimeout(90_000);

test("Drive prototype: opt-in sign-in, real ZIP upload, verification failure/retry and checked download", async ({
  page,
}) => {
  // Simulated provider, not a live Google account. HTTPS also exercises the production CSP.
  const html = await readFile(new URL("../dist/index.html", import.meta.url));
  let googleLoads = 0;
  let folder = false;
  let idCount = 0;
  let corruptChecksum = true;
  let corruptDownload = false;
  let uploaded: Buffer = Buffer.alloc(0);
  let metadata: Record<string, unknown> | null = null;
  const file = () => ({
    ...metadata,
    size: String(uploaded.length),
    createdTime: "2026-10-10T18:00:00Z",
    sha256Checksum: corruptChecksum
      ? "0".repeat(64)
      : createHash("sha256").update(uploaded).digest("hex"),
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    if (url.origin === "https://cloud-backup.example") {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    if (
      url.origin === "https://accounts.google.com" &&
      url.pathname === "/gsi/client"
    ) {
      googleLoads++;
      await route.fulfill({
        contentType: "application/javascript",
        body: `window.google={accounts:{oauth2:{initTokenClient(config){return {requestAccessToken(){config.callback({access_token:'cloud-e2e-session-token',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'});}};}}}};`,
      });
      return;
    }
    if (url.origin !== "https://www.googleapis.com") {
      await route.abort();
      return;
    }
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
      return;
    }
    expect(request.headers().authorization).toBe(
      "Bearer cloud-e2e-session-token",
    );
    if (url.pathname.endsWith("generateIds")) {
      await reply({ ids: [`cloud-backup-${++idCount}`] });
      return;
    }
    if (url.pathname.startsWith("/upload/")) {
      if (!url.searchParams.has("upload_id")) {
        metadata = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Location",
            Location:
              "https://www.googleapis.com/upload/drive/v3/files?upload_id=test-session",
          },
        });
        return;
      }
      if (request.headers()["content-range"]?.startsWith("bytes */")) {
        await route.fulfill({
          status: 308,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
        return;
      }
      uploaded = Buffer.concat([
        uploaded,
        request.postDataBuffer() ?? Buffer.alloc(0),
      ]);
      await reply(file());
      return;
    }
    if (url.pathname === "/drive/v3/files") {
      if (request.method() === "POST") {
        folder = true;
        await reply({ id: "cloud-folder" });
        return;
      }
      if (url.searchParams.get("q")?.includes("mimeType")) {
        await reply({ files: folder ? [{ id: "cloud-folder" }] : [] });
        return;
      }
      await reply({ files: metadata ? [file()] : [] });
      return;
    }
    if (!metadata) {
      await reply({}, 404);
      return;
    }
    if (request.method() === "PATCH") {
      metadata = {
        ...metadata,
        ...(request.postDataJSON() as Record<string, unknown>),
      };
      await reply(file());
      return;
    }
    if (url.searchParams.get("alt") === "media") {
      await route.fulfill({
        status: 200,
        contentType: "application/zip",
        body: corruptDownload ? Buffer.from("corrupted") : uploaded,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
      return;
    }
    await reply(file());
  });
  await page.goto("https://cloud-backup.example/?e2e=1");
  await waitForSurface(page, "app");
  await page.click("#add-token");
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  await page.click("#gm-settings");
  const settings = page.locator('[data-window="settings"]');
  await settings.getByText("Backups & portability", { exact: true }).click();
  await settings.locator("[data-cloud-backup] > summary").click();
  await settings.getByLabel("Backup connection").selectOption("temporary");
  expect(googleLoads).toBe(0); // No Google contact from ordinary play or simply opening settings.
  await settings
    .getByLabel("Google OAuth client ID")
    .fill("123456-e2e.apps.googleusercontent.com");
  await settings.getByRole("button", { name: "Enable Google sign-in" }).click();
  await expect(
    settings.getByRole("button", { name: "Connect Google Drive" }),
  ).toBeEnabled();
  await settings.getByRole("button", { name: "Connect Google Drive" }).click();
  await expect(
    settings.getByRole("button", { name: "Back up now" }),
  ).toBeVisible();
  expect(googleLoads).toBe(1);
  await settings.getByRole("button", { name: "Back up now" }).click();
  await expect(settings.getByRole("alert")).toContainText("checksum");
  await expect(settings.getByText(/Last verified backup:/)).toHaveCount(0);
  expect(uploaded.length).toBeGreaterThan(0);
  const contents = unzipSync(uploaded);
  expect(contents["world.json"]).toBeDefined();
  expect(strFromU8(contents["documents.json"] ?? new Uint8Array())).toContain(
    "Token 1",
  );
  expect(
    Object.values(contents).some((bytes) =>
      strFromU8(bytes).includes("cloud-e2e-session-token"),
    ),
  ).toBe(false);
  corruptChecksum = false;
  await settings.getByRole("button", { name: "Retry backup" }).click();
  await expect(
    settings.getByText(/Backup uploaded and checksum verified/),
  ).toBeVisible();
  expect(idCount).toBe(1);
  const downloading = page.waitForEvent("download");
  await settings.locator("[data-cloud-backup] li button").click();
  expect(await (await downloading).failure()).toBeNull();
  corruptDownload = true;
  await settings.locator("[data-cloud-backup] li button").click();
  await expect(settings.getByRole("alert")).toContainText("checksum");
  const storage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage }),
  );
  expect(storage).toContain("123456-e2e.apps.googleusercontent.com");
  expect(storage).not.toContain("cloud-e2e-session-token");
  await settings
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Connect Google Drive" }),
  ).toBeVisible();
  await expect(settings.locator("[data-cloud-backup] li")).toHaveCount(0);
  await expect(page.locator("[data-save-warning]")).toHaveCount(0);
});

test("file:// keeps local backup available and does not load Google", async ({
  page,
}) => {
  let contactedGoogle = false;
  page.on("request", (request) => {
    if (request.url().includes("accounts.google.com")) contactedGoogle = true;
  });
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.click("#gm-settings");
  const settings = page.locator('[data-window="settings"]');
  await settings.getByText("Backups & portability", { exact: true }).click();
  await settings.locator("[data-cloud-backup] > summary").click();
  await settings.getByLabel("Backup connection").selectOption("temporary");
  await expect(
    settings.getByText(/Google sign-in needs a registered HTTPS/),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Download world backup" }),
  ).toBeEnabled();
  expect(contactedGoogle).toBe(false);
});

test("remembered GitHub backup: pairing cookie, GM size preference, real ZIP, reload reconnection and checked download", async ({
  page,
}) => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url));
  let uploaded: Buffer = Buffer.alloc(0);
  let backup: Record<string, unknown> | null = null;
  let uploads = 0;
  await page.route("https://remembered-backup.example/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (value: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(value),
        headers,
      });
    if (url.pathname === "/api/cloud/status") {
      await reply({
        available: true,
        paired:
          request.headers().cookie?.includes("arenastar_cloud=e2e-pairing") ??
          false,
        googleConfigured: false,
        googleConnected: false,
        githubConfigured: true,
      });
      return;
    }
    if (url.pathname === "/api/cloud/pair") {
      expect(request.postDataJSON()).toEqual({ key: "test-only-pairing-key" });
      await reply(
        { paired: true },
        {
          "Set-Cookie":
            "arenastar_cloud=e2e-pairing; Path=/api/cloud; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000",
        },
      );
      return;
    }
    if (url.pathname.startsWith("/api/cloud/github/")) {
      expect(request.headers().cookie).toContain("arenastar_cloud=e2e-pairing");
      expect(url.searchParams.get("repo")).toBe("gm/world-backups");
      if (url.pathname.endsWith("/check")) {
        await reply({ connected: true });
        return;
      }
      if (url.pathname.endsWith("/list")) {
        await reply(backup ? [backup] : []);
        return;
      }
      if (url.pathname.endsWith("/upload")) {
        uploads++;
        uploaded = request.postDataBuffer() ?? Buffer.alloc(0);
        const manifest = JSON.parse(
          Buffer.from(
            request.headers()["x-backup-manifest"] ?? "",
            "base64",
          ).toString(),
        );
        expect(manifest.size).toBe(uploaded.length);
        expect(manifest.sha256).toBe(
          createHash("sha256").update(uploaded).digest("hex"),
        );
        backup = {
          id: "7:9",
          name: manifest.name,
          size: manifest.size,
          sha256: manifest.sha256,
          createdTime: new Date().toISOString(),
          verified: true,
        };
        await reply(backup);
        return;
      }
      if (url.pathname.endsWith("/download")) {
        await route.fulfill({ contentType: "application/zip", body: uploaded });
        return;
      }
    }
    await route.fulfill({ contentType: "text/html", body: html });
  });
  await page.goto("https://remembered-backup.example/?e2e=1");
  await waitForSurface(page, "app");
  await page.click("#add-token");
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  async function openPanel() {
    await page.click("#gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await settings.getByText("Backups & portability", { exact: true }).click();
    await settings.locator("[data-cloud-backup] > summary").click();
    return settings;
  }
  let settings = await openPanel();
  await settings.getByLabel("Backup destination").selectOption("github");
  await settings
    .getByLabel("GitHub backup repository")
    .fill("gm/world-backups");
  await settings.getByLabel("GitHub backup repository").press("Tab");
  await settings.getByLabel("Maximum backup ZIP size (MiB)").fill("1024");
  await settings.getByLabel("Maximum backup ZIP size (MiB)").press("Tab");
  await settings
    .getByLabel("Companion pairing key")
    .fill("test-only-pairing-key");
  await settings.getByRole("button", { name: "Remember this browser" }).click();
  await expect(
    settings.getByRole("button", { name: "Back up now" }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Back up now" }).click();
  await expect(settings.getByText(/Last verified backup:/)).toBeVisible();
  expect(uploads).toBe(1);
  const zip = unzipSync(uploaded);
  expect(zip["world.json"]).toBeTruthy();
  for (const bytes of Object.values(zip))
    expect(strFromU8(bytes)).not.toMatch(/test-only-pairing-key|e2e-pairing/);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(
    /test-only-pairing-key|e2e-pairing/,
  );
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "arenastar_cloud",
  );
  await page.reload();
  await waitForSurface(page, "app");
  settings = await openPanel();
  await expect(
    settings.getByRole("button", { name: "Back up now" }),
  ).toBeVisible();
  await expect(
    settings.getByLabel("Maximum backup ZIP size (MiB)"),
  ).toHaveValue("1024");
  await expect(settings.getByLabel("Companion pairing key")).toHaveCount(0);
  const downloaded = page.waitForEvent("download");
  await settings.getByRole("button", { name: /^Download .*\.zip$/ }).click();
  const result = await downloaded;
  expect(result.suggestedFilename()).toMatch(/\.zip$/);
  expect(uploads).toBe(1); // Reopening does not upload, sign in, or ask for approval.
});
