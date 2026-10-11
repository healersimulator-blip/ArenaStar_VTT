import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createCloudServer } from "./server.mjs";
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
const hash = (data) => createHash("sha256").update(data).digest("hex");
async function harness(
  t,
  upstream = async () => {
    throw Error("Unexpected provider call");
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "arenastar-cloud-test-"));
  let server;
  const start = async () => {
    ({ server } = await createCloudServer({
      directory,
      env: {
        CLOUD_PUBLIC_ORIGIN: "http://localhost:8787",
        GOOGLE_CLIENT_ID: "test-client",
        GOOGLE_CLIENT_SECRET: "test-secret",
      },
      fetch: upstream,
      githubToken: async () => "test-gh-credential",
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  const call = (path, { method = "GET", body, cookie, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const bytes =
        body === undefined
          ? null
          : Buffer.isBuffer(body)
            ? body
            : Buffer.from(JSON.stringify(body));
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: "/api/cloud/" + path,
          method,
          headers: {
            Host: "localhost:8787",
            ...(cookie ? { Cookie: cookie } : {}),
            ...(method !== "GET"
              ? { Origin: "http://localhost:8787", "X-ArenaStar-Cloud": "1" }
              : {}),
            ...(bytes ? { "Content-Length": bytes.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const parts = [];
          res.on("data", (chunk) => parts.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const text = Buffer.concat(parts).toString();
            let data;
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
            resolve({
              status: res.statusCode,
              data,
              text,
              headers: res.headers,
              bytes: Buffer.concat(parts),
            });
          });
        },
      );
      req.on("error", reject);
      req.end(bytes);
    });
  const vault = async () =>
    JSON.parse(await readFile(join(directory, "credentials.json"), "utf8"));
  const pair = async () => {
    const response = await call("pair", {
      method: "POST",
      body: { key: (await vault()).pairingKey },
    });
    assert.equal(response.status, 200);
    return response.headers["set-cookie"][0].split(";")[0];
  };
  return {
    call,
    pair,
    vault,
    directory,
    restart: async () => {
      await stop();
      await start();
    },
  };
}
test("pairing is persistent, HttpOnly, origin/Host guarded, and credentials are not exposed in status", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("status")).data.paired, false);
  assert.equal(
    (await h.call("google/token", { method: "POST", body: {} })).status,
    401,
  );
  assert.equal(
    (await h.call("pair", { method: "POST", body: { key: "bad" } })).status,
    403,
  );
  const key = (await h.vault()).pairingKey;
  assert.equal(
    (
      await h.call("pair", {
        method: "POST",
        body: { key },
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await h.call("status", { headers: { Host: "attacker.example" } })).status,
    403,
  );
  const result = await h.call("pair", { method: "POST", body: { key } });
  assert.match(
    result.headers["set-cookie"][0],
    /HttpOnly; SameSite=Lax; Max-Age=7776000/,
  );
  const cookie = result.headers["set-cookie"][0].split(";")[0];
  await h.restart();
  const status = await h.call("status", { cookie });
  assert.equal(status.data.paired, true);
  assert.ok(!status.text.includes(key));
  assert.ok(!JSON.stringify(await h.vault()).includes(cookie.split("=")[1]));
  assert.equal(
    (await stat(join(h.directory, "credentials.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(h.directory)).mode & 0o777, 0o700);
  assert.equal(
    (await h.call("unpair", { method: "POST", body: {}, cookie })).status,
    200,
  );
  assert.equal((await h.call("status", { cookie })).data.paired, false);
});
test("Google PKCE + cookie-bound OAuth persists refresh grant over restart; only short token reaches client", async (t) => {
  const exchanges = [];
  const h = await harness(t, async (url, init) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    exchanges.push(init.body);
    if (init.body.get("grant_type") === "authorization_code")
      return json({
        access_token: "short-first",
        refresh_token: "offline-private",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/drive.file",
      });
    assert.equal(init.body.get("refresh_token"), "offline-private");
    return json({ access_token: "short-renewed", expires_in: 3600 });
  });
  const cookie = await h.pair();
  const start = await h.call("google/start", {
    method: "POST",
    body: {},
    cookie,
  });
  const url = new URL(start.data.url);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.equal(
    (await h.call("google/callback?state=wrong&code=test", { cookie })).status,
    400,
  );
  const otherCookie = await h.pair();
  const callback = `google/callback?state=${url.searchParams.get("state")}&code=test`;
  assert.equal((await h.call(callback, { cookie: otherCookie })).status, 400);
  assert.equal((await h.call(callback, { cookie })).status, 200);
  const verifier = exchanges[0].get("code_verifier");
  assert.equal(
    createHash("sha256").update(verifier).digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  assert.equal((await h.call(callback, { cookie })).status, 400); // one-use state
  await h.restart();
  assert.equal((await h.call("status", { cookie })).data.googleConnected, true);
  const result = await h.call("google/token", {
    method: "POST",
    body: {},
    cookie,
  });
  assert.deepEqual(result.data, { token: "short-renewed" });
  assert.ok(!result.text.includes("offline-private"));
  assert.equal(exchanges.length, 2);
});
test("cancelled OAuth cannot save an account; disconnect forgets locally even if revocation is offline", async (t) => {
  let exchangeCount = 0;
  const h = await harness(t, async (url) => {
    if (url.endsWith("/revoke")) throw Error("offline");
    exchangeCount++;
    return json({ access_token: "short", refresh_token: "offline-private" });
  });
  const cookie = await h.pair();
  let start = await h.call("google/start", {
    method: "POST",
    body: {},
    cookie,
  });
  await h.call("google/cancel", {
    method: "POST",
    body: { attempt: start.data.attempt },
    cookie,
  });
  assert.equal(
    (
      await h.call(`google/callback?state=${start.data.attempt}&code=test`, {
        cookie,
      })
    ).status,
    400,
  );
  assert.equal(exchangeCount, 0);
  start = await h.call("google/start", { method: "POST", body: {}, cookie });
  await h.call(`google/callback?state=${start.data.attempt}&code=test`, {
    cookie,
  });
  const result = await h.call("google/forget", {
    method: "POST",
    body: {},
    cookie,
  });
  assert.deepEqual(result.data, { forgotten: true, revoked: false });
  await h.restart();
  assert.equal(
    (await h.call("status", { cookie })).data.googleConnected,
    false,
  );
});
function githubMock() {
  let release;
  let stored;
  const calls = [];
  let privateRepo = true;
  let corrupt = false;
  let digest = true;
  let redirectHost = "release-assets.githubusercontent.com";
  return {
    calls,
    setPrivate: (value) => {
      privateRepo = value;
    },
    setCorrupt: (value) => {
      corrupt = value;
    },
    setDigest: (value) => {
      digest = value;
    },
    setRedirect: (value) => {
      redirectHost = value;
    },
    get release() {
      return release;
    },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (new URL(url).hostname === "release-assets.githubusercontent.com") {
        assert.equal(init.headers.Authorization, undefined);
        return new Response(corrupt ? Buffer.from("bad") : stored);
      }
      assert.equal(init.headers.Authorization, "Bearer test-gh-credential");
      if (path === "/repos/gm/backups")
        return json({ private: privateRepo, permissions: { push: true } });
      if (path.endsWith("/assets") && init.method === "POST") {
        const chunks = [];
        for await (const chunk of init.body) chunks.push(chunk);
        stored = Buffer.concat(chunks);
        const asset = {
          id: 9,
          name: new URL(url).searchParams.get("name"),
          size: stored.length,
          state: "uploaded",
          created_at: "2026-10-10T00:00:00Z",
          ...(digest ? { digest: "sha256:" + hash(stored) } : {}),
        };
        release.assets = [asset];
        return json(asset);
      }
      if (path.endsWith("/releases/assets/9"))
        return new Response(null, {
          status: 302,
          headers: { Location: `https://${redirectHost}/asset.zip` },
        });
      if (path.endsWith("/releases") && init.method === "POST") {
        release = { id: 7, ...JSON.parse(init.body), assets: [] };
        return json(release);
      }
      if (path.endsWith("/releases/7") && init.method === "PATCH") {
        release = { ...release, ...JSON.parse(init.body) };
        return json(release);
      }
      if (path.endsWith("/releases/7")) return json(release);
      if (path.endsWith("/releases")) return json(release ? [release] : []);
      throw Error("Unexpected GitHub request: " + url);
    },
  };
}
async function upload(h, cookie, bytes, snapshot = randomUUID()) {
  const manifest = {
    format: "arenastar-vtt-backup-v2",
    snapshot,
    name: "Мир-2026.zip",
    sha256: hash(bytes),
    size: bytes.length,
    worldKey: "a".repeat(64),
  };
  return h.call("github/upload?repo=gm/backups", {
    method: "POST",
    cookie,
    body: bytes,
    headers: {
      "X-Backup-Manifest": Buffer.from(JSON.stringify(manifest)).toString(
        "base64",
      ),
    },
  });
}
test("GitHub streams a new private release asset, verifies before publishing, retries idempotently and downloads without CDN credentials", async (t) => {
  const gh = githubMock();
  const h = await harness(t, gh.fetch);
  const cookie = await h.pair();
  const bytes = Buffer.from("PK mock-world ZIP bytes");
  const snapshot = randomUUID();
  const result = await upload(h, cookie, bytes, snapshot);
  assert.equal(result.status, 200);
  assert.equal(result.data.verified, true);
  assert.equal(gh.release.draft, false);
  assert.equal((await upload(h, cookie, bytes, snapshot)).status, 200);
  assert.equal(
    gh.calls.filter((c) => c.url.startsWith("https://uploads.github.com"))
      .length,
    1,
  );
  assert.equal(gh.calls.filter((c) => c.init.method === "DELETE").length, 0);
  const list = await h.call("github/list?repo=gm/backups", { cookie });
  assert.equal(list.data.length, 1);
  const file = await h.call("github/download?repo=gm/backups&id=7:9", {
    cookie,
  });
  assert.deepEqual(file.bytes, bytes);
  assert.equal(
    (await upload(h, cookie, Buffer.from("changed world"), snapshot)).status,
    409,
  );
  gh.setPrivate(false);
  assert.equal(
    (
      await h.call("github/check?repo=gm/backups", {
        method: "POST",
        body: {},
        cookie,
      })
    ).status,
    403,
  );
});
test("GitHub missing-digest readback failure never publishes, while retry can verify same asset", async (t) => {
  const gh = githubMock();
  gh.setDigest(false);
  gh.setCorrupt(true);
  const h = await harness(t, gh.fetch);
  const cookie = await h.pair();
  const bytes = Buffer.from("PK original ZIP bytes");
  const snapshot = randomUUID();
  const bad = await upload(h, cookie, bytes, snapshot);
  assert.equal(bad.status, 422);
  assert.equal(gh.release.draft, true);
  assert.deepEqual(
    (await h.call("github/list?repo=gm/backups", { cookie })).data,
    [],
  );
  gh.setCorrupt(false);
  assert.equal((await upload(h, cookie, bytes, snapshot)).status, 200);
  assert.equal(gh.release.draft, false);
});
test("GitHub refuses hostile download redirects and malformed repositories before sending a token", async (t) => {
  const gh = githubMock();
  gh.setDigest(false);
  gh.setRedirect("attacker.example");
  const h = await harness(t, gh.fetch);
  const cookie = await h.pair();
  assert.equal(
    (await h.call("github/list?repo=../../secrets", { cookie })).status,
    400,
  );
  assert.equal(gh.calls.length, 0);
  assert.equal((await upload(h, cookie, Buffer.from("PK zip"))).status, 502);
  assert.ok(!gh.calls.some((c) => c.url.includes("attacker.example")));
  assert.equal(gh.release.draft, true);
});
