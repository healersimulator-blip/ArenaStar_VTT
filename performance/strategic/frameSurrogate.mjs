/* global requestAnimationFrame */
/**
 * CPU-throttled Chromium frame surrogate. It applies a synthetic 50k marker table in
 * requestAnimationFrame chunks. This is a bounded browser substitute for a reference-laptop
 * frame test, NOT a measurement of the production VTT on the reference laptop.
 *
 * The global comment applies to code executed inside `page.evaluate`, not this Node process.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

function adoptRegistryChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return;
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const root =
    configured && configured !== "0"
      ? configured
      : join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium_headless_shell-")) continue;
    const binary = join(
      root,
      entry,
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    );
    const lib = join(root, entry, "al2023", "lib");
    const fonts = join(root, entry, "fonts");
    if (!existsSync(binary) || !existsSync(lib)) continue;
    process.env.STRATEGIC_CHROMIUM_EXECUTABLE ??= binary;
    if (!(process.env.LD_LIBRARY_PATH ?? "").split(":").includes(lib))
      process.env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(":");
    if (existsSync(join(fonts, "fonts.conf")))
      process.env.FONTCONFIG_PATH ??= fonts;
    return;
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export async function runFrameSurrogate({
  rate = 4,
  markers = 50_000,
  targetFrameMs = 33,
} = {}) {
  adoptRegistryChromium();
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    process.env.STRATEGIC_CHROMIUM_EXECUTABLE ||
    chromium.executablePath();
  if (!existsSync(executablePath))
    throw new Error(
      "Chromium not installed; run `corepack pnpm e2e:browser` first.",
    );
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    chromiumSandbox: false,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await page.setContent(
      "<!doctype html><meta charset=utf-8><title>Arena Star frame surrogate</title>",
    );
    const intervals = await page.evaluate(
      async ({ count }) => {
        const xs = new Float64Array(count);
        const ys = new Float64Array(count);
        const labels = new Uint16Array(count);
        const intervals = [];
        let index = 0;
        let previous = 0;
        const chunk = 5_000;
        await new Promise((resolve) => {
          const tick = (now) => {
            if (previous) intervals.push(now - previous);
            previous = now;
            for (let n = 0; n < chunk && index < count; n++, index++) {
              const angle = index * 0.017;
              xs[index] = Math.sin(angle) * 4096;
              ys[index] = Math.cos(angle * 1.3) * 4096;
              labels[index] = index & 0xffff;
            }
            if (index < count) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        return intervals;
      },
      { count: markers },
    );
    const p95 = percentile(intervals, 0.95);
    return {
      surrogate: true,
      browser: browser.version(),
      cpuThrottleRate: rate,
      markers,
      frames: intervals.length + 1,
      p50FrameMs: percentile(intervals, 0.5),
      p95FrameMs: p95,
      p99FrameMs: percentile(intervals, 0.99),
      targetFrameMs,
      meetsTarget: p95 !== null && p95 <= targetFrameMs,
      caveat:
        "Synthetic marker apply under Chromium CPU throttling; not production rendering or reference hardware.",
    };
  } finally {
    await browser.close();
  }
}
