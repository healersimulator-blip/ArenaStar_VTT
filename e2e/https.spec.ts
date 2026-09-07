import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("bootstrap over https:// (§15, §19 M1)", () => {
  test("the single-file app boots from an https origin", async ({ browser }) => {
    // self-signed cert for 127.0.0.1
    const dir = mkdtempSync(join(tmpdir(), "vtt-tls-"));
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/key.pem -out ${dir}/cert.pem ` +
        `-days 1 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"`,
      { stdio: "ignore" },
    );
    const body = readFileSync(dist);
    const server = https.createServer(
      { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    try {
      await page.goto(`https://127.0.0.1:${port}/`);
      await expect(page.locator("h1")).toHaveText("VTT");
      await expect(page.locator("#role-host")).toBeVisible(); // role picker booted
      await expect(page.locator("li")).toHaveCount(7); // §0 capability report
    } finally {
      await ctx.close();
      server.close();
    }
  });
});
