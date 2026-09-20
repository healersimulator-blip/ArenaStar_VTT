#!/usr/bin/env node
/**
 * Content source fetch (plan §1.1, gap G-44) — `pnpm content:fetch`.
 *
 * The converter (`pnpm content:convert`) reads *checkouts* of the upstream PF1 sources, and the
 * repo only ever carried the clone commands as prose in a help string. That made the whole
 * content pipeline unreachable from a fresh clone: 25,376 converted entries existed, and nobody
 * could produce them without knowing the two repos and their commits by heart.
 *
 * This script is the missing half. It reads `tools/content/sources.json` (pinned commit + sparse
 * path set + the license fact from `tools/adopt/INVENTORY.md`) and materialises each source under
 * `tools/content/vendor/<id>` using a blobless sparse clone, then *verifies* the result — right
 * commit, required directories present, non-empty. It is idempotent: an up-to-date checkout is
 * skipped, a wrong or partial one is repaired. Every git invocation runs with prompts disabled,
 * so it can never hang a CI job waiting for credentials.
 *
 * Offline / no-network: the printed remedy is the published artifact
 * (`pf1e-content` + the tester world zip on the releases page), not a broken pipeline — see
 * `README.md` "Content: two ways in".
 *
 * Usage: node tools/content/fetch.mjs [--dest <dir>] [--only <id,id>] [--check] [--force]
 *   --dest    where the checkouts go (default tools/content/vendor, env VTT_CONTENT_VENDOR)
 *   --only    fetch just these source ids
 *   --check   verify what is already there; change nothing, and exit 1 if anything is missing
 *   --force   re-clone even when a checkout is already up to date
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SOURCES_FILE = join(repoRoot, "tools", "content", "sources.json");
export const DEFAULT_DEST = join(repoRoot, "tools", "content", "vendor");
/** Where the converter looks by default — kept in step with tools/convert/index.mjs. */
export const CONVERTER_VENDOR = join(repoRoot, "tools", "content", "vendor");

/** Parsed manifest, validated. Throws with the offending field named. */
export function readSources(file = SOURCES_FILE) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const sources = raw?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(`${relative(repoRoot, file)}: no "sources" array`);
  }
  const seen = new Set();
  for (const s of sources) {
    for (const field of ["id", "url", "commit", "license", "usage"]) {
      if (typeof s?.[field] !== "string" || s[field] === "") {
        throw new Error(`${relative(repoRoot, file)}: source ${s?.id ?? "?"} is missing "${field}"`);
      }
    }
    if (!/^[0-9a-f]{40}$/.test(s.commit)) {
      throw new Error(`${s.id}: commit must be a full 40-char hex sha, got "${s.commit}"`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id)) {
      throw new Error(`${s.id}: ids are lowercase path-safe slugs`);
    }
    if (seen.has(s.id)) throw new Error(`${s.id}: duplicate source id`);
    seen.add(s.id);
    if (!Array.isArray(s.sparse) || s.sparse.length === 0) {
      throw new Error(`${s.id}: "sparse" must list at least one path`);
    }
    if (!Array.isArray(s.required) || s.required.length === 0) {
      throw new Error(`${s.id}: "required" must list at least one path to verify`);
    }
    for (const p of [...s.sparse, ...s.required]) {
      if (p.startsWith("/") || p.includes("..")) {
        throw new Error(`${s.id}: path "${p}" must be relative and free of ".."`);
      }
    }
    // A required path that is not inside the sparse set would never be checked out.
    for (const p of s.required) {
      const covered = s.sparse.some((sp) => p === sp || p.startsWith(`${sp}/`));
      if (!covered) throw new Error(`${s.id}: required path "${p}" is outside the sparse set`);
    }
  }
  return sources;
}

/**
 * The git argv for each step of materialising one source, as pure data (unit-tested, and the
 * single place the recipe lives — the D-253 prose version is deleted from the converter's error).
 */
export function fetchCommands(source, dir, { fresh }) {
  const git = (args) => ["git", "-C", dir, ...args];
  if (fresh) {
    return [
      [
        "git",
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--quiet",
        source.url,
        dir,
      ],
      git(["sparse-checkout", "init", "--cone"]),
      git(["sparse-checkout", "set", ...source.sparse]),
      git(["checkout", "--quiet", source.commit]),
    ];
  }
  return [
    git(["sparse-checkout", "init", "--cone"]),
    git(["sparse-checkout", "set", ...source.sparse]),
    git(["fetch", "--quiet", "--depth", "1", "origin", source.commit]),
    git(["checkout", "--force", "--quiet", source.commit]),
  ];
}

/** Environment for every git call: never prompt, never paginate. */
export const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "never",
  GIT_PAGER: "cat",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(args, { cwd } = {}) {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Seconds spent in one source; the report prints them so a slow mirror is visible. */
function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function countFiles(dir) {
  let n = 0;
  const walk = (current, depth) => {
    if (depth > 6) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name), depth + 1);
      else n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

/**
 * Is this checkout the pinned commit, with every required path present and non-empty?
 * Returns the facts either way — `--check` prints them and the fetch uses them to decide.
 */
export function verifyCheckout(source, dir) {
  if (!existsSync(join(dir, ".git"))) {
    return { ok: false, commit: null, missing: [...source.required], reason: "not a checkout" };
  }
  let commit;
  try {
    commit = git(["git", "-C", dir, "rev-parse", "HEAD"]);
  } catch {
    return { ok: false, commit: null, missing: [...source.required], reason: "unreadable git dir" };
  }
  const missing = source.required.filter((p) => {
    const abs = join(dir, p);
    if (!existsSync(abs)) return true;
    return statSync(abs).isDirectory() && readdirSync(abs).length === 0;
  });
  if (commit !== source.commit) {
    return { ok: false, commit, missing, reason: `at ${commit.slice(0, 7)}, want ${source.commit.slice(0, 7)}` };
  }
  if (missing.length > 0) {
    return { ok: false, commit, missing, reason: `missing ${missing.join(", ")}` };
  }
  return { ok: true, commit, missing: [], reason: "up to date" };
}

/**
 * Materialise every source into `dest`. Returns one report row per source so the CLI (and a
 * test) can assert what happened without parsing stdout.
 */
export function fetchSources({
  dest = process.env.VTT_CONTENT_VENDOR ?? DEFAULT_DEST,
  only = null,
  force = false,
  check = false,
  log = () => {},
} = {}) {
  const sources = readSources().filter((s) => only === null || only.has(s.id));
  if (sources.length === 0) throw new Error("no sources selected");
  const rows = [];
  for (const source of sources) {
    const dir = join(dest, source.id);
    const before = verifyCheckout(source, dir);
    if (check) {
      rows.push({ id: source.id, action: before.ok ? "ok" : "missing", ...before });
      continue;
    }
    if (before.ok && !force) {
      rows.push({ id: source.id, action: "up-to-date", ...before, files: countFiles(dir) });
      continue;
    }
    const fresh = !existsSync(join(dir, ".git"));
    if (before.ok === false && !fresh) {
      // A partial or wrong checkout is repaired in place; a corrupt one is re-cloned.
      log(`${source.id}: repairing (${before.reason})`);
    }
    const started = nowMs();
    const commands = fetchCommands(source, dir, { fresh });
    for (const argv of commands) {
      if (argv[0] === "git" && argv[1] === "clone" && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      try {
        git(argv, { cwd: repoRoot });
      } catch (err) {
        const message = String(err?.stderr ?? err?.message ?? err).trim().split("\n").slice(-2).join(" ");
        throw new Error(
          `${source.id}: \`${argv.slice(0, 4).join(" ")}…\` failed — ${message}\n` +
            `  Offline or proxied? The built artifacts are published instead of the checkouts:\n` +
            `  download pf1e-content / the tester world zip from the releases page and open the zip in the app (README, "Content: two ways in").`,
          { cause: err },
        );
      }
    }
    const after = verifyCheckout(source, dir);
    if (!after.ok) {
      throw new Error(`${source.id}: checkout did not verify after fetch — ${after.reason}`);
    }
    rows.push({
      id: source.id,
      action: fresh ? "cloned" : "updated",
      ...after,
      files: countFiles(dir),
      ms: nowMs() - started,
    });
  }
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  const argOf = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const dest = resolve(repoRoot, argOf("--dest") ?? process.env.VTT_CONTENT_VENDOR ?? DEFAULT_DEST);
  const onlyArg = argOf("--only");
  const only = onlyArg !== null ? new Set(onlyArg.split(",")) : null;
  const check = argv.includes("--check");
  const force = argv.includes("--force");

  let rows;
  try {
    rows = fetchSources({
      dest,
      only,
      check,
      force,
      log: (line) => console.log(`  ${line}`),
    });
  } catch (err) {
    console.error(`content:fetch — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`content sources → ${relative(repoRoot, dest)}`);
  for (const row of rows) {
    const where = row.action === "ok" || row.action === "up-to-date" ? "already there" : "fetched";
    console.log(
      `  ${row.id}: ${row.action} (${row.commit?.slice(0, 7) ?? "—"})` +
        (row.files !== undefined ? ` · ${row.files} file(s)` : "") +
        (row.ms !== undefined ? ` · ${(row.ms / 1000).toFixed(1)} s` : "") +
        (row.action === "ok" || row.action === "up-to-date" ? ` · ${where}` : ""),
    );
  }
  const bad = rows.filter((r) => r.action === "missing");
  if (bad.length > 0) {
    console.error(
      `\ncontent:fetch --check: ${bad.length} source(s) missing — run \`pnpm content:fetch\` (network) or use the published artifacts (README).`,
    );
    process.exit(1);
  }
  console.log(
    check
      ? "\nAll sources present. Next: pnpm build && pnpm build:systems && pnpm content:convert && pnpm build:worlds"
      : "\nNext: pnpm build && pnpm build:systems && pnpm content:convert && pnpm build:worlds",
  );
  if (dest !== DEFAULT_DEST) {
    console.log(
      `note: fetched to ${relative(repoRoot, dest)} — the converter reads ${relative(repoRoot, CONVERTER_VENDOR)} by default, so pass \`--vendor ${relative(repoRoot, dest)}\`.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
