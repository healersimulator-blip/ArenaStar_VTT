import { build } from "vite";
import { spawnSync } from "node:child_process";
import { cpus, availableParallelism, release, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [, , mode = "smoke", ...args] = process.argv;
const hosted = mode === "hosted";
/** Decode throughput of one published baseline, isolated from any room or network. */
const decode = mode === "decode";
const entry = hosted ? "hostedLoad" : decode ? "decodeProbe" : "legacyProbe";
const directory = "test-results/strategic500/harness";
await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    ssr: `performance/strategic/${entry}.ts`,
    target: "node22",
    minify: false,
    outDir: directory,
    emptyOutDir: false,
    rollupOptions: {
      output: { entryFileNames: `${entry}.mjs`, codeSplitting: false },
    },
  },
});
const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
const dirty =
  spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim().length > 0;
console.log(
  JSON.stringify({
    stage: "machine",
    node: process.version,
    system: process.platform,
    kernel: release(),
    cpu: cpus()[0]?.model,
    cores: availableParallelism(),
    memoryMiB: Math.round(totalmem() / 2 ** 20),
    commit,
    dirty,
    fixtureVersion: 1,
    mode,
  }),
);
function run(argv) {
  const result = spawnSync(
    process.execPath,
    [`${directory}/${entry}.mjs`, ...argv],
    {
      cwd: root,
      stdio: "inherit",
      timeout: hosted ? 4 * 60 * 60_000 : 180_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (mode === "smoke" || mode === "matrix") {
  const samples = Number(args[0] ?? 1);
  if (!Number.isInteger(samples) || samples < 1 || samples > 100)
    throw new Error("Provide 1–100 independent samples per fixture.");
  for (const units of [5, 10])
    for (const scenario of [
      "idle",
      "contact",
      "mixed",
      "march",
      "dense",
      "doctrine",
    ]) {
      for (let sample = 0; sample < samples; sample++)
        run(["sim", mode === "smoke" ? "4" : "500", String(units), scenario]);
    }
} else if (hosted) run(args);
else if (decode) run(args);
else if (["sim", "turn", "fanout"].includes(mode)) run([mode, ...args]);
else
  throw new Error(
    "Use smoke [samples], matrix [samples], sim/turn <players> <5|10> <workload>, fanout <players> <5|10> [cap], hosted <origin> <invites-file> <turns> <workload> [commanders], or decode.",
  );
