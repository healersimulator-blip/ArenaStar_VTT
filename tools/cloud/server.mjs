// Optional single-GM backup companion. No third-party runtime dependencies.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const PREFIX = "arenastar-backup-";
const COOKIE = "arenastar_cloud";
const secret = () => randomBytes(32).toString("base64url");
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const cookieOf = (req) =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
function repository(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9_.-]{1,100}$/.test(value) ||
    value.split("/").includes("..")
  )
    throw fail("Use a repository in owner/name form.");
  return value;
}
function metadata(value) {
  if (
    !value ||
    value.format !== "arenastar-vtt-backup-v2" ||
    !UUID.test(value.snapshot ?? "") ||
    !HASH.test(value.sha256 ?? "") ||
    !HASH.test(value.worldKey ?? "") ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > 2 * 1024 ** 3 ||
    typeof value.name !== "string" ||
    !/^[\p{L}\p{N} _.-]{1,160}\.zip$/u.test(value.name)
  )
    throw fail("Invalid backup manifest or GitHub asset exceeds 2 GiB.");
  return value;
}
function releaseMeta(release) {
  try {
    const m = metadata(JSON.parse(release.body));
    return release.tag_name === PREFIX + m.snapshot ? m : null;
  } catch {
    return null;
  }
}
async function jsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 16_384) throw fail("Request too large.", 413);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw fail("Invalid JSON.");
  }
}
async function responseJson(response) {
  // Provider responses are bounded independently of ZIP streaming.
  const reader = response.body?.getReader();
  let size = 0;
  const parts = [];
  if (!reader) throw fail("Empty provider response.", 502);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 ** 2) throw fail("Provider response too large.", 502);
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw fail("Invalid provider response.", 502);
  }
}

export async function createCloudServer(options = {}) {
  const env = options.env ?? process.env;
  const origin = new URL(env.CLOUD_PUBLIC_ORIGIN ?? "http://localhost:8787");
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)
      ))
  )
    throw Error(
      "CLOUD_PUBLIC_ORIGIN must be an HTTPS origin (HTTP allowed only on loopback).",
    );
  const directory = resolve(
    options.directory ??
      env.CLOUD_STATE_DIR ??
      join(homedir(), ".arenastar-cloud"),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const vaultPath = join(directory, "credentials.json");
  let vault;
  try {
    vault = JSON.parse(await readFile(vaultPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw Error(
        "Cannot read cloud credential store. Refusing to replace it.",
        { cause: error },
      );
    vault = { pairingKey: secret(), sessions: [] };
  }
  if (!vault.pairingKey || !Array.isArray(vault.sessions))
    throw Error("Invalid cloud credential store.");
  let saving = Promise.resolve();
  const save = () => {
    const data = JSON.stringify(vault);
    const next = saving
      .catch(() => {})
      .then(async () => {
        await writeFile(vaultPath + ".tmp", data, { mode: 0o600 });
        await chmod(vaultPath + ".tmp", 0o600);
        await rename(vaultPath + ".tmp", vaultPath);
      });
    saving = next;
    return next;
  };
  await save();
  await chmod(vaultPath, 0o600);
  const request = options.fetch ?? globalThis.fetch;
  const ghToken =
    options.githubToken ??
    (async () => {
      if (env.CLOUD_GITHUB_TOKEN) return env.CLOUD_GITHUB_TOKEN;
      try {
        return (
          await exec("gh", ["auth", "token", "--hostname", "github.com"], {
            timeout: 10_000,
          })
        ).stdout.trim();
      } catch {
        throw fail(
          "On the companion, run gh auth login for github.com, or configure CLOUD_GITHUB_TOKEN.",
          503,
        );
      }
    });
  let access = null;
  let googleGeneration = 0;
  const oauth = new Map();
  const uploading = new Set();
  let attempts = []; // Global small pairing limiter; not trustable proxy IP headers.
  const callback = origin.origin + "/api/cloud/google/callback";
  const googleConfigured = Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
  );
  async function exchange(fields) {
    const result = await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        ...fields,
      }),
    });
    const data = await responseJson(result);
    if (!result.ok || typeof data.access_token !== "string")
      throw fail(
        "Google authorization expired or was rejected. Connect Google Drive again.",
        401,
      );
    if (data.scope && !data.scope.split(" ").includes(SCOPE))
      throw fail("Google did not grant Drive file access.", 403);
    access = {
      token: data.access_token,
      expires:
        Date.now() + Math.max(0, Number(data.expires_in ?? 3600) - 60) * 1000,
    };
    return data;
  }
  async function googleToken() {
    if (!googleConfigured || !vault.refreshToken)
      throw fail("Connect Google Drive first.", 401);
    if (!access || access.expires <= Date.now()) {
      const generation = googleGeneration;
      const data = await exchange({
        grant_type: "refresh_token",
        refresh_token: vault.refreshToken,
      });
      if (generation !== googleGeneration) {
        access = null;
        throw fail("Google was disconnected.", 401);
      }
      if (data.refresh_token) {
        vault.refreshToken = data.refresh_token;
        await save();
      }
    }
    return access.token;
  }
  async function github(path, init = {}) {
    const response = await request("https://api.github.com" + path, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(60_000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ArenaStar-cloud-backup",
        Authorization: `Bearer ${await ghToken()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw fail(
        `GitHub request failed (${response.status}). Check the repository, saved login and Contents permission.`,
        response.status === 401 ? 401 : 502,
      );
    }
    return responseJson(response);
  }
  async function checkRepo(repo) {
    const info = await github("/repos/" + repository(repo));
    if (!info.private)
      throw fail(
        "Choose a private repository: backups include GM notes and private chat.",
        403,
      );
    if (!info.permissions?.push)
      throw fail(
        "The saved GitHub login needs Contents write access to this repository.",
        403,
      );
    return info;
  }
  function backup(release, asset, m) {
    return {
      id: `${release.id}:${asset.id}`,
      name: m.name,
      size: m.size,
      createdTime: asset.created_at,
      sha256: m.sha256,
      verified: m.verified === true && !release.draft,
    };
  }
  async function assetResponse(repo, assetId, signal) {
    let url = `https://api.github.com/repos/${repo}/releases/assets/${assetId}`;
    for (let i = 0; i < 4; i++) {
      const host = new URL(url).hostname;
      const response = await request(url, {
        signal,
        redirect: "manual",
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "ArenaStar-cloud-backup",
          ...(host === "api.github.com"
            ? { Authorization: `Bearer ${await ghToken()}` }
            : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get("location") ?? "", url);
        await response.body?.cancel();
        if (
          next.protocol !== "https:" ||
          next.username ||
          next.password ||
          ![
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
            "github.com",
          ].includes(next.hostname)
        )
          throw fail("Unsafe GitHub download redirect.", 502);
        url = next.href;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw fail("GitHub download failed.", 502);
      }
      return response;
    }
    throw fail("Too many download redirects.", 502);
  }
  function checker(m) {
    let count = 0;
    const hash = createHash("sha256");
    return new Transform({
      transform(chunk, _, next) {
        count += chunk.length;
        if (count > m.size) return next(fail("Backup size mismatch.", 413));
        hash.update(chunk);
        next(null, chunk);
      },
      flush(next) {
        next(
          count === m.size && hash.digest("hex") === m.sha256
            ? null
            : fail("Backup checksum mismatch.", 422),
        );
      },
    });
  }
  async function verifyAsset(repo, asset, m, signal) {
    if (asset.state !== "uploaded" || asset.size !== m.size)
      throw fail(
        "Incomplete GitHub asset. Start a new snapshot; the unfinished draft was retained.",
        409,
      );
    if (asset.digest === "sha256:" + m.sha256) return;
    const response = await assetResponse(repo, asset.id, signal);
    await pipeline(
      Readable.fromWeb(response.body),
      checker(m),
      async (source) => {
        for await (const chunk of source) {
          void chunk;
          /* checked read-back */
        }
      },
    );
  }
  const server = createServer(async (req, res) => {
    const send = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(30 * 60_000),
    ]);
    req.on("aborted", () => abort.abort());
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.headers.host !== origin.host)
        throw fail("Unexpected Host. Configure the public origin.", 403);
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (!path.startsWith("/api/cloud/")) {
        if (req.method !== "GET" || !["/", "/index.html"].includes(path))
          throw fail("Not found.", 404);
        const html = await readFile(
          options.indexPath ?? resolve("dist/index.html"),
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (
        req.method !== "GET" &&
        (req.headers.origin !== origin.origin ||
          req.headers["x-arenastar-cloud"] !== "1")
      )
        throw fail("Cross-origin request rejected.", 403);
      const session = vault.sessions.find(
        (s) =>
          s.expires > Date.now() &&
          same(
            s.hash,
            createHash("sha256")
              .update(cookieOf(req) ?? "")
              .digest("hex"),
          ),
      );
      if (path === "/api/cloud/pair" && req.method === "POST") {
        attempts = attempts.filter((t) => t > Date.now() - 60_000);
        if (attempts.length >= 10)
          throw fail("Too many pairing attempts. Wait a minute.", 429);
        attempts.push(Date.now());
        const body = await jsonBody(req);
        if (!same(body.key, vault.pairingKey))
          throw fail("Incorrect companion pairing key.", 403);
        const value = secret();
        vault.sessions = vault.sessions
          .filter((s) => s.expires > Date.now())
          .slice(-19);
        vault.sessions.push({
          hash: createHash("sha256").update(value).digest("hex"),
          expires: Date.now() + 90 * 86400_000,
        });
        await save();
        res.setHeader(
          "Set-Cookie",
          `${COOKIE}=${value}; Path=/api/cloud; HttpOnly; SameSite=Lax; Max-Age=7776000${origin.protocol === "https:" ? "; Secure" : ""}`,
        );
        send({ paired: true });
        return;
      }
      if (path === "/api/cloud/status" && req.method === "GET") {
        let githubConfigured = false;
        if (session) {
          try {
            githubConfigured = Boolean(await ghToken());
          } catch {
            /* reported without credential details */
          }
        }
        send({
          available: true,
          paired: Boolean(session),
          googleConfigured,
          googleConnected: Boolean(session && vault.refreshToken),
          googleAttempt: session ? (vault.googleAttempt ?? null) : null,
          githubConfigured,
        });
        return;
      }
      if (!session)
        throw fail("Pair this browser with the backup companion first.", 401);
      if (path === "/api/cloud/unpair" && req.method === "POST") {
        vault.sessions = vault.sessions.filter((s) => s !== session);
        await save();
        res.setHeader(
          "Set-Cookie",
          `${COOKIE}=; Path=/api/cloud; HttpOnly; SameSite=Lax; Max-Age=0`,
        );
        send({ ok: true });
        return;
      }
      if (path === "/api/cloud/google/start" && req.method === "POST") {
        if (!googleConfigured)
          throw fail("Configure Google OAuth on the companion first.", 503);
        const state = secret(),
          verifier = secret();
        for (const [key, entry] of oauth)
          if (entry.expires < Date.now()) oauth.delete(key);
        if (oauth.size > 50) throw fail("Too many pending sign-ins.", 429);
        oauth.set(state, {
          verifier,
          session: session.hash,
          expires: Date.now() + 10 * 60_000,
          generation: googleGeneration,
        });
        const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        target.search = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: callback,
          response_type: "code",
          scope: SCOPE,
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "false",
          state,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
        }).toString();
        send({ url: target.href, attempt: state });
        return;
      }
      if (path === "/api/cloud/google/cancel" && req.method === "POST") {
        const { attempt } = await jsonBody(req);
        if (oauth.get(attempt)?.session === session.hash) oauth.delete(attempt);
        send({ ok: true });
        return;
      }
      if (path === "/api/cloud/google/callback" && req.method === "GET") {
        const state = url.searchParams.get("state");
        const entry = oauth.get(state);
        if (
          !entry ||
          entry.expires < Date.now() ||
          entry.session !== session.hash ||
          entry.generation !== googleGeneration ||
          !url.searchParams.get("code")
        )
          throw fail(
            "Google sign-in was cancelled or expired. Try connecting again.",
          );
        const data = await exchange({
          grant_type: "authorization_code",
          code: url.searchParams.get("code"),
          redirect_uri: callback,
          code_verifier: entry.verifier,
        });
        if (
          entry.generation !== googleGeneration ||
          oauth.get(state) !== entry
        ) {
          access = null;
          throw fail("Sign-in was cancelled.");
        }
        if (!data.refresh_token)
          throw fail(
            "Google did not return offline access. Remove the old app grant in your Google account and reconnect.",
          );
        oauth.delete(state);
        vault.googleAttempt = state;
        vault.refreshToken = data.refresh_token;
        await save();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'",
        });
        res.end(
          "<!doctype html><title>ArenaStar connected</title><p>Google Drive is connected and will be remembered. You may close this tab and return to ArenaStar.</p>",
        );
        return;
      }
      if (path === "/api/cloud/google/token" && req.method === "POST") {
        await jsonBody(req);
        send({ token: await googleToken() });
        return;
      }
      if (path === "/api/cloud/google/forget" && req.method === "POST") {
        await jsonBody(req);
        googleGeneration++;
        oauth.clear();
        const token = vault.refreshToken;
        delete vault.refreshToken;
        access = null;
        await save();
        let revoked = !token;
        if (token) {
          try {
            const response = await request(
              "https://oauth2.googleapis.com/revoke",
              {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(15_000),
                body: new URLSearchParams({ token }),
              },
            );
            revoked = response.ok;
            await response.body?.cancel();
          } catch {
            /* local removal succeeds even offline */
          }
        }
        send({ forgotten: true, revoked });
        return;
      }
      if (path.startsWith("/api/cloud/github/")) {
        const repo = repository(url.searchParams.get("repo"));
        await checkRepo(repo);
        const base = "/repos/" + repo + "/releases";
        if (path === "/api/cloud/github/check" && req.method === "POST") {
          await jsonBody(req);
          send({ connected: true });
          return;
        }
        if (path === "/api/cloud/github/list" && req.method === "GET") {
          const releases = await github(base + "?per_page=100");
          const result = [];
          for (const release of releases) {
            const m = releaseMeta(release);
            if (!m || release.draft || !m.verified) continue;
            const asset = release.assets?.find(
              (a) =>
                a.name === m.name &&
                a.size === m.size &&
                a.state === "uploaded",
            );
            if (asset) result.push(backup(release, asset, m));
          }
          send(result.slice(0, 20));
          return;
        }
        if (path === "/api/cloud/github/download" && req.method === "GET") {
          const id = url.searchParams.get("id");
          if (!/^\d+:\d+$/.test(id ?? "")) throw fail("Invalid backup ID.");
          const [releaseId, assetId] = id.split(":");
          const release = await github(base + "/" + releaseId);
          const m = releaseMeta(release);
          const asset = release.assets?.find((a) => String(a.id) === assetId);
          if (
            !m ||
            !m.verified ||
            release.draft ||
            !asset ||
            asset.name !== m.name ||
            asset.size !== m.size
          )
            throw fail("Not a verified ArenaStar backup.", 404);
          const response = await assetResponse(repo, asset.id, signal);
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Length": m.size,
          });
          await pipeline(Readable.fromWeb(response.body), checker(m), res);
          return;
        }
        if (path === "/api/cloud/github/upload" && req.method === "POST") {
          let m;
          try {
            m = metadata(
              JSON.parse(
                Buffer.from(
                  req.headers["x-backup-manifest"] ?? "",
                  "base64",
                ).toString("utf8"),
              ),
            );
          } catch {
            throw fail("Invalid backup manifest.");
          }
          if (Number(req.headers["content-length"]) !== m.size)
            throw fail("ZIP size does not match manifest.");
          const key = repo + ":" + m.snapshot;
          if (uploading.has(key))
            throw fail("This snapshot is already uploading.", 409);
          uploading.add(key);
          try {
            const tag = PREFIX + m.snapshot;
            // Listing includes unpublished drafts, unlike the release-by-tag endpoint.
            const releases = await github(base + "?per_page=100");
            let release = releases.find((r) => r.tag_name === tag);
            if (release) {
              const old = releaseMeta(release);
              if (
                !old ||
                old.sha256 !== m.sha256 ||
                old.size !== m.size ||
                old.name !== m.name ||
                old.worldKey !== m.worldKey
              )
                throw fail(
                  "Existing snapshot manifest differs; nothing was overwritten.",
                  409,
                );
            } else
              release = await github(base, {
                method: "POST",
                body: JSON.stringify({
                  tag_name: tag,
                  name: m.name,
                  draft: true,
                  body: JSON.stringify({ ...m, verified: false }),
                }),
              });
            let asset = release.assets?.find((a) => a.name === m.name);
            if (!asset) {
              if (!release.draft)
                throw fail(
                  "Published snapshot is missing its asset; nothing was changed.",
                  409,
                );
              const upload = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(m.name)}`;
              const stream = checker(m);
              const checked = pipeline(req, stream);
              checked.catch(() => {});
              const response = await request(upload, {
                method: "POST",
                signal,
                redirect: "error",
                duplex: "half",
                headers: {
                  Authorization: `Bearer ${await ghToken()}`,
                  "Content-Type": "application/zip",
                  "Content-Length": String(m.size),
                  "User-Agent": "ArenaStar-cloud-backup",
                },
                body: stream,
              });
              if (!response.ok) {
                stream.destroy();
                await response.body?.cancel();
                throw fail(
                  `GitHub upload failed (${response.status}); the draft remains for retry.`,
                  502,
                );
              }
              asset = await responseJson(response);
              await checked;
            } else req.resume(); // Idempotent retry: verify existing bytes, never overwrite.
            await verifyAsset(repo, asset, m, signal);
            if (release.draft)
              release = await github(base + "/" + release.id, {
                method: "PATCH",
                body: JSON.stringify({
                  draft: false,
                  make_latest: "false",
                  body: JSON.stringify({ ...m, verified: true }),
                }),
              });
            send(backup(release, asset, { ...m, verified: true }));
            return;
          } finally {
            uploading.delete(key);
          }
        }
      }
      throw fail("Not found.", 404);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else
        send(
          {
            error: error.status
              ? error.message
              : "Cloud service failed. Local saves are unaffected; check companion setup and retry.",
          },
          error.status ?? 502,
        );
    }
  });
  server.requestTimeout = 0; // Individual cloud operations have a 30-minute abort deadline.
  return { server, directory, origin: origin.origin };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { server, directory, origin } = await createCloudServer();
  server.listen(
    Number(process.env.PORT ?? 8787),
    process.env.CLOUD_BIND ?? "127.0.0.1",
    () =>
      console.log(
        `ArenaStar backup companion: ${origin}\nPairing key is in ${join(directory, "credentials.json")}. Keep this file private; never commit or share it.`,
      ),
  );
}
