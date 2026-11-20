/** Loopback protocol diagnostic. Needs built VTT/service and a disposable PostgreSQL database.
 * Creates an isolated slot and an ended battle (retained in the test database). No 500-browser claim. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
const [players = "100", units = "10", turns = "2", work = "mixed"] =
  process.argv.slice(2);
const db = process.env.STRATEGIC_TEST_DATABASE_URL;
if (!db || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(db).hostname))
  throw Error(
    "Set STRATEGIC_TEST_DATABASE_URL to a disposable local PostgreSQL database",
  );
if (
  ![1, 5, 10].includes(Number(units)) ||
  !Number.isInteger(+players) ||
  +players < 2 ||
  +players > 500 ||
  +players % 2 ||
  !Number.isInteger(+turns) ||
  +turns < 1 ||
  +turns > 10
)
  throw Error(
    "Usage: node performance/strategic/localCampaign.mjs <even seats 2–500> <1|5|10 units/seat> <1–10 turns> [workload]",
  );
const probe = createServer().listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = `http://127.0.0.1:${port}`,
  key = randomUUID();
const service = spawn(
  process.execPath,
  ["services/strategic-room/dist/server/main.mjs", "campaign"],
  {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      PORT: String(port),
      STRATEGIC_BIND_ADDRESS: "127.0.0.1",
      STRATEGIC_ROOM: `local-${randomUUID()}`,
      STRATEGIC_LAUNCH_KEY: key,
      STRATEGIC_ORIGINS: origin,
      DATABASE_URL: db,
    },
  },
);
const exited = once(service, "exit");
try {
  let ready = false;
  for (let i = 0; i < 80 && service.exitCode === null; i++) {
    try {
      const r = await fetch(origin, { signal: AbortSignal.timeout(1000) });
      ready = r.ok;
      await r.body?.cancel();
      if (ready) break;
    } catch {
      // The listener may not exist until migration/initialization completes.
    }
    await delay(100);
  }
  if (!ready)
    throw Error(
      "Local campaign service did not start. Build both entries and check database.",
    );
  // Run the built generator directly so its timeout cannot orphan a grandchild.
  const { build } = await import("vite");
  const dir = "test-results/strategic500/harness";
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      ssr: "performance/strategic/hostedLoad.ts",
      target: "node22",
      outDir: dir,
      emptyOutDir: false,
      rollupOptions: {
        output: { entryFileNames: "campaignLoad.mjs", codeSplitting: false },
      },
    },
  });
  const load = spawn(
    process.execPath,
    [
      `${dir}/campaignLoad.mjs`,
      origin,
      "--local-campaign",
      turns,
      work,
      players,
    ],
    {
      stdio: "inherit",
      timeout: 600000,
      env: {
        ...process.env,
        STRATEGIC_TEST_LAUNCH_KEY: key,
        STRATEGIC_LOAD_UNITS: units,
        STRATEGIC_LOAD_SPREAD_MS: "1800",
        STRATEGIC_LOAD_DECODE_SAMPLE:
          process.env.STRATEGIC_LOAD_DECODE_SAMPLE ?? "10",
        STRATEGIC_LOAD_RECONNECT: String(Math.min(10, +players - 1)),
      },
    },
  );
  const [code] = await once(load, "exit");
  if (code !== 0) throw Error(`Local campaign generator failed (${code})`);
} finally {
  service.kill("SIGTERM");
  await exited;
}
