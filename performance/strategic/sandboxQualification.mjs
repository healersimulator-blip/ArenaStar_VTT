#!/usr/bin/env node
/**
 * Bounded sandbox qualification ladder for the missing PR #55 claims.
 *
 * It runs the existing 500 virtual protocol-client harness over a local self-signed
 * TLS/WSS proxy with optional request delay/loss, repeats for a short soak, then runs a
 * CPU-throttled Chromium frame surrogate. The generated JSON is explicitly labelled as
 * surrogate evidence: a real WAN, 500 human browsers, 50-turn soak and reference laptop
 * still require external infrastructure.
 */
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { availableParallelism, cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startWanTlsProxy } from "./wanTlsProxy.mjs";
import { runFrameSurrogate } from "./frameSurrogate.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [
  seats = "500",
  units = "1",
  turns = "1",
  loops = "2",
  workload = "march",
  wanDelayMs = "40",
  wanLossPct = "0",
  cpuRate = "4",
  evidenceOverride,
] = process.argv.slice(2);
if (process.argv.includes("--help")) {
  console.log(
    "Usage: node performance/strategic/sandboxQualification.mjs [seats=500] [units=1] [turns=1] [loops=2] [workload=mixed] [wanDelayMs=40] [wanLossPct=0] [cpuRate=4] [evidence=path]\nEnv: STRATEGIC_TEST_DATABASE_URL is required.",
  );
  process.exit(0);
}
const database = process.env.STRATEGIC_TEST_DATABASE_URL;
if (!database)
  throw new Error(
    "Set STRATEGIC_TEST_DATABASE_URL to a disposable local PostgreSQL database.",
  );
for (const required of [
  "dist/index.html",
  "services/strategic-room/dist/server/main.mjs",
  "services/strategic-room/dist/web/scene/scene.webp",
]) {
  if (!existsSync(join(root, required)))
    throw new Error(
      `Missing ${required}. Run corepack pnpm build && corepack pnpm build:strategic first.`,
    );
}

async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string")
    throw new Error("No local port.");
  return address.port;
}

async function runLoop({ index, origin, servicePort }) {
  const env = {
    ...process.env,
    STRATEGIC_TEST_DATABASE_URL: database,
    STRATEGIC_TEST_ORIGIN: origin,
    STRATEGIC_TEST_SERVICE_PORT: String(servicePort),
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    PLAYWRIGHT_CHROMIUM_NO_SANDBOX: "1",
    STRATEGIC_BIND_ADDRESS: "127.0.0.1",
  };
  const child = spawn(
    process.execPath,
    ["performance/strategic/localCampaign.mjs", seats, units, turns, workload],
    { cwd: root, env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const reports = [];
  let buffer = "";
  const consume = (text) => {
    buffer += text;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("{")) {
        process.stdout.write(`${line}\n`);
        continue;
      }
      try {
        const report = JSON.parse(line);
        if (
          report.stage !== "connected" &&
          report.stage !== "turn" &&
          report.stage !== "summary"
        )
          continue;
        // Per-turn reports include 500-element latency samples. Preserve summary metrics
        // and patch counts, but do not echo or persist the raw per-peer arrays.
        const { ackSamples, applySamples, ...rest } = report;
        const compact =
          report.stage === "turn"
            ? {
                ...rest,
                omittedSamples: {
                  ack: ackSamples?.length ?? 0,
                  apply: applySamples?.length ?? 0,
                },
              }
            : report;
        reports.push(compact);
        process.stdout.write(`${JSON.stringify(compact)}\n`);
      } catch {
        // Vite and the service also write plain diagnostics.
      }
    }
  };
  child.stdout.on("data", (chunk) => consume(String(chunk)));
  const [code] = await once(child, "exit");
  if (buffer.trim().startsWith("{")) consume(`${buffer.trim()}\n`);
  if (code !== 0)
    throw new Error(`Sandbox qualification loop ${index + 1} exited ${code}.`);
  return { loop: index + 1, reports };
}

function git(command) {
  try {
    return execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const servicePort = await freePort();
const proxyPort = await freePort();
const delay = Math.max(0, Number(wanDelayMs) || 0);
const loss = Math.min(5, Math.max(0, Number(wanLossPct) || 0));
const jitter = Math.min(20, Math.floor(delay / 4));
const proxy = await startWanTlsProxy({
  targetPort: servicePort,
  port: proxyPort,
  latencyMs: delay,
  jitterMs: jitter,
  lossPct: loss,
});
const evidencePath = evidenceOverride?.startsWith("/")
  ? evidenceOverride
  : join(
      root,
      evidenceOverride ??
        "performance/strategic/evidence/2026-11-20-sandbox-qualification.json",
    );
let loadRuns = [];
let frame = null;
let error = null;
try {
  for (let loop = 0; loop < Math.max(1, Number(loops) || 1); loop++)
    loadRuns.push(
      await runLoop({
        index: loop,
        origin: proxy.origin,
        servicePort,
      }),
    );
  frame = await runFrameSurrogate({ rate: Math.max(1, Number(cpuRate) || 4) });
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
} finally {
  await proxy.close();
  await mkdir(join(evidencePath, ".."), { recursive: true });
  const reports = loadRuns.flatMap((run) => run.reports);
  const summaries = reports.filter((report) => report.stage === "summary");
  const connected = reports.filter((report) => report.stage === "connected");
  const turnsRun = reports.filter((report) => report.stage === "turn");
  const worst = (key) =>
    summaries.length
      ? Math.max(...summaries.map((report) => Number(report[key]) || 0))
      : null;
  const closeP95 = worst("worstCloseP95");
  const applyP95 = worst("worstNoticeApplyP95");
  const evidence = {
    kind: "arenastar-strategic-sandbox-qualification-v1",
    generatedAt: new Date().toISOString(),
    fullQualification: false,
    disclaimer:
      "Surrogate evidence only. Loopback TLS/WSS, synthetic delay/loss, Node protocol clients and CPU-throttled Chromium cannot qualify real WAN paths, 500 browser renderers, long-duration soak or reference-laptop frame rate.",
    machine: {
      node: process.version,
      platform: process.platform,
      kernel: release(),
      cpu: cpus()[0]?.model ?? null,
      cores: availableParallelism(),
      memoryMiB: Math.round(totalmem() / 2 ** 20),
      commit: git(["rev-parse", "HEAD"]),
      dirty: (git(["status", "--porcelain"]) ?? "").length > 0,
      databaseHost: new URL(database).hostname,
    },
    configuration: {
      seats: Number(seats),
      unitsPerSeat: Number(units),
      turnsPerLoop: Number(turns),
      loops: Math.max(1, Number(loops) || 1),
      workload,
      proxyOrigin: proxy.origin,
      servicePort,
      tls: "self-signed localhost certificate",
      viewMode: process.env.STRATEGIC_LOAD_VIEW ?? "compact",
      fullViews: process.env.STRATEGIC_LOAD_FULL_VIEWS === "1",
      decodeSample: Number(process.env.STRATEGIC_LOAD_DECODE_SAMPLE ?? 10),
      reconnectPeers: Math.min(10, Number(seats) - 1),
      requestDelayMs: delay,
      requestJitterMs: jitter,
      connectionLossPct: loss,
      cpuThrottleRate: Math.max(1, Number(cpuRate) || 4),
    },
    loadRuns,
    changesetPatchesApplied: turnsRun.reduce(
      (total, report) => total + (Number(report.markerChangesApplied) || 0),
      0,
    ),
    budgetEvaluation: {
      closeToDurablePublishP95Ms: {
        observed: closeP95,
        budgetMs: 5000,
        source: "worstCloseP95",
        withinSurrogateBudget: closeP95 !== null && closeP95 <= 5000,
      },
      applyAfterPublishP95Ms: {
        observed: applyP95,
        budgetMs: 2000,
        source: "worstNoticeApplyP95",
        withinSurrogateBudget: applyP95 !== null && applyP95 <= 2000,
      },
      frameIntervalP95Ms: {
        observed: frame?.p95FrameMs ?? null,
        budgetMs: 33,
        source: "frameSurrogate.p95FrameMs",
        withinSurrogateBudget:
          frame?.p95FrameMs !== null && frame?.p95FrameMs !== undefined
            ? frame.p95FrameMs <= 33
            : null,
      },
      caveat:
        "Budget values are surrogate observations only and do not close production qualification.",
    },
    qualificationSurrogates: {
      virtual500Clients: {
        executed:
          Number(seats) === 500 &&
          connected.some((report) => Number(report.peers) >= 501),
        limitation:
          "Headless Node WS/HTTP protocol clients, not 500 human browsers or renderers.",
      },
      tlsAndWanLikeConditions: {
        executed: loadRuns.length > 0,
        limitation:
          "Local TLS termination plus request delay/loss; no real WAN RTT, congestion or packet scheduling.",
      },
      boundedSoak: {
        executed: loadRuns.length > 0,
        limitation:
          "Fresh short battles repeated serially; not a 50-turn or multi-hour production soak.",
      },
      referenceLaptopFrame: {
        executed: frame !== null,
        limitation:
          "Synthetic 50k marker apply under Chromium CPU throttling; not production rendering on reference hardware.",
      },
    },
    stillRequiresExternalRunner: [
      "500 representative browser clients including GM rendering",
      "real regional WAN paths with 80 ms RTT, jitter, loss and bandwidth caps",
      "50+ turn cold/warm soak with 600-connection headroom and multi-host recovery",
      "published reference laptop with <=33 ms p95 frame interval assertion",
    ],
    error,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Wrote ${evidencePath}`);
}
if (error) throw new Error(error);
