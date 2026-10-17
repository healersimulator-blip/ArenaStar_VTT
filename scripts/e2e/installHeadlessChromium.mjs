#!/usr/bin/env node
/**
 * Install a headless Chromium for Playwright from the npm registry alone.
 *
 * Sandboxes that can reach `registry.npmjs.org` but not `cdn.playwright.dev` cannot run
 * `playwright install`. `@sparticuz/chromium` publishes the same Chromium branch Playwright pins
 * (a brotli-compressed `chrome-headless-shell` plus its Amazon Linux 2023 shared libraries,
 * SwiftShader and a fonts set). This script lays that build out exactly where Playwright looks
 * for its own download (`~/.cache/ms-playwright/chromium_headless_shell-<revision>/`), so
 * `playwright test --project=chromium` runs with no executable-path override. Only two environment
 * variables are needed at run time, and `playwright.config.ts` sets them itself when it finds this
 * layout:
 *
 *   LD_LIBRARY_PATH=<dir>/al2023/lib   — the bundled libnss/libdrm/… the shell links against
 *   FONTCONFIG_PATH=<dir>/fonts        — a fonts.conf pointing at the bundled Open Sans (the
 *                                        shipped one points at /var/task → zero-width text)
 *
 * Usage: node scripts/e2e/installHeadlessChromium.mjs [--force] [--version <sparticuz version>]
 *
 * The Playwright revision and expected Chromium major come from playwright-core's browsers.json,
 * the sparticuz version from the registry (highest release of that major) unless pinned.
 * Re-running is a no-op once the markers exist (use --force to reinstall). Nothing here touches
 * CI, which keeps using Playwright's own pinned download. See DECISIONS.md D-222 / D-480.
 *
 * Verified host (2026-10-15): Debian 12 bookworm, glibc 2.36, kernel 6.1, 2 CPUs. The headless
 * shell links only glibc plus NSS; `libnss3.so`, `libnssutil3.so` and `libnspr4.so` are the only
 * libraries the host lacks, and `al2023/lib` supplies them (with libexpat/libplc4/libplds4). The
 * Chromium sandbox starts normally there — PLAYWRIGHT_CHROMIUM_NO_SANDBOX is not needed.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createBrotliDecompress } from "node:zlib";

const REGISTRY = "https://registry.npmjs.org/@sparticuz/chromium";
const FALLBACK_VERSION = "153.0.0"; // the release verified on 2026-10-15 (Chromium 153.0.8010.0)

const args = process.argv.slice(2);
const force = args.includes("--force");
const pinned = args.includes("--version") ? args[args.indexOf("--version") + 1] : null;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** playwright-core/browsers.json: the revision decides the directory name Playwright expects. */
function playwrightChromium() {
  const require = createRequire(join(repoRoot, "package.json"));
  let file = null;
  try { file = require.resolve("playwright-core/browsers.json"); } catch { /* pnpm isolated layout */ }
  if (!file) {
    const direct = join(repoRoot, "node_modules", "playwright-core", "browsers.json");
    if (existsSync(direct)) file = direct;
  }
  if (!file) {
    const pnpm = join(repoRoot, "node_modules", ".pnpm");
    if (existsSync(pnpm)) {
      for (const entry of readdirSync(pnpm)) {
        if (!entry.startsWith("playwright-core@")) continue;
        const candidate = join(pnpm, entry, "node_modules", "playwright-core", "browsers.json");
        if (existsSync(candidate)) { file = candidate; break; }
      }
    }
  }
  if (!file) throw new Error("playwright-core/browsers.json not found — run `corepack pnpm install` first");
  const json = JSON.parse(readFileSync(file, "utf8"));
  const shell = json.browsers.find((browser) => browser.name === "chromium-headless-shell") ??
    json.browsers.find((browser) => browser.name === "chromium");
  if (!shell) throw new Error("no chromium entry in browsers.json");
  return { revision: String(shell.revision), version: String(shell.browserVersion ?? "") };
}

async function pickVersion(major) {
  if (pinned) return pinned;
  try {
    const response = await fetch(REGISTRY, { headers: { accept: "application/vnd.npm.install-v1+json" } });
    if (!response.ok) throw new Error(`registry ${response.status}`);
    const packument = await response.json();
    const versions = Object.keys(packument.versions ?? {})
      .filter((version) => /^\d+\.\d+\.\d+$/.test(version) && version.split(".")[0] === String(major))
      .sort((a, b) => {
        const [a1, a2, a3] = a.split(".").map(Number); const [b1, b2, b3] = b.split(".").map(Number);
        return a1 - b1 || a2 - b2 || a3 - b3;
      });
    return versions.at(-1) ?? FALLBACK_VERSION;
  } catch (error) {
    console.warn(`could not read the registry (${error instanceof Error ? error.message : String(error)}); using ${FALLBACK_VERSION}`);
    return FALLBACK_VERSION;
  }
}

async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed: ${url} → ${response.status}`);
  await pipeline(response.body, createWriteStream(target));
  return statSync(target).size;
}

async function unbrotli(source, target) {
  await pipeline(createReadStream(source), createBrotliDecompress(), createWriteStream(target));
}

function untar(archive, into) {
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xf", archive, "-C", into], { stdio: "inherit" });
}

async function main() {
  const { revision, version: expected } = playwrightChromium();
  const major = Number(expected.split(".")[0]) || 153;
  const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0"
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : join(homedir(), ".cache", "ms-playwright");
  const dir = join(browsersRoot, `chromium_headless_shell-${revision}`);
  const shellDir = join(dir, "chrome-headless-shell-linux64");
  const binary = join(shellDir, "chrome-headless-shell");
  if (!force && existsSync(join(dir, "INSTALLATION_COMPLETE")) && existsSync(binary)) {
    console.log(`already installed: ${binary}`);
    printEnv(dir);
    return;
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`@sparticuz/chromium ships linux-x64 only (this is ${process.platform}-${process.arch})`);
  }
  const version = await pickVersion(major);
  const url = `${REGISTRY}/-/chromium-${version}.tgz`;
  console.log(`Playwright expects Chromium ${expected || `major ${major}`} (revision ${revision}); fetching @sparticuz/chromium@${version}`);
  const work = await mkdtemp(join(tmpdir(), "headless-chromium-"));
  try {
    const tgz = join(work, "chromium.tgz");
    const bytes = await download(url, tgz);
    console.log(`downloaded ${bytes.toLocaleString("en-US")} bytes`);
    untar(tgz, work);
    const bin = join(work, "package", "bin");
    for (const required of ["chromium.br", "al2023.tar.br", "swiftshader.tar.br", "fonts.tar.br"]) {
      if (!existsSync(join(bin, required))) throw new Error(`${required} missing from the package`);
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(shellDir, { recursive: true });
    await unbrotli(join(bin, "chromium.br"), binary);
    chmodSync(binary, 0o755);
    for (const [archive, into] of [["swiftshader.tar.br", shellDir], ["al2023.tar.br", join(dir, "al2023")], ["fonts.tar.br", join(dir, "fonts", "fonts")]]) {
      const tar = join(work, archive.replace(/\.br$/, ""));
      await unbrotli(join(bin, archive), tar);
      untar(tar, into);
    }
    // The shipped fonts.conf points at /var/task (Lambda); Chromium then measures every glyph as
    // zero-width and layout-dependent specs fail. Point it at the extracted fonts and the system set.
    mkdirSync(join(dir, "fonts-cache"), { recursive: true });
    const fontDirs = [join(dir, "fonts", "fonts"), "/usr/share/fonts", "/usr/local/share/fonts"].filter((candidate) => existsSync(candidate));
    writeFileSync(join(dir, "fonts", "fonts.conf"), `<?xml version="1.0" ?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
${fontDirs.map((fontDir) => `  <dir>${fontDir}</dir>`).join("\n")}
  <cachedir>${join(dir, "fonts-cache")}/</cachedir>
  <alias><family>sans-serif</family><prefer><family>Open Sans</family><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>DejaVu Serif</family><family>Open Sans</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family><family>Open Sans</family></prefer></alias>
  <alias><family>system-ui</family><prefer><family>Open Sans</family></prefer></alias>
  <config></config>
</fontconfig>
`);
    // Playwright's own markers: without them `playwright test` reports the browser as missing.
    writeFileSync(join(dir, "INSTALLATION_COMPLETE"), "");
    writeFileSync(join(dir, "DEPENDENCIES_VALIDATED"), "");
    await writeFile(join(dir, "SOURCE.txt"), `@sparticuz/chromium@${version} (${url})\ninstalled ${new Date().toISOString()} by scripts/e2e/installHeadlessChromium.mjs\n`);
    const banner = execFileSync(binary, ["--version"], {
      env: { ...process.env, LD_LIBRARY_PATH: join(dir, "al2023", "lib"), FONTCONFIG_PATH: join(dir, "fonts") },
      encoding: "utf8",
    }).trim();
    console.log(`installed ${banner} → ${binary}`);
    printEnv(dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function printEnv(dir) {
  console.log("\nplaywright.config.ts applies these automatically when the layout is present; for other tools:");
  console.log(`  export LD_LIBRARY_PATH=${join(dir, "al2023", "lib")}`);
  console.log(`  export FONTCONFIG_PATH=${join(dir, "fonts")}`);
  console.log("then: corepack pnpm build && corepack pnpm test:e2e:ais   (or any test:e2e:* batch)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
