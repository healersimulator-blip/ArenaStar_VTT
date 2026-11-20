import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  integer,
  isId,
  isPublicKey,
  record,
} from "../../../src/core/strategicRoom/protocol";
import { PostgresRoom } from "./postgres";
import { deploy, generatedScenario, parseScenario } from "./scenario";
import { extractScenario } from "./worldExtract";
import { serveCampaign } from "./campaign";
import { serve } from "./server";

async function jsonFile(path: string | undefined): Promise<unknown> {
  if (!path) throw new Error("Provide the path to a JSON file.");
  const info = await stat(path);
  if (!info.isFile() || info.size > 8 * 1024 * 1024)
    throw new Error("Input must be a JSON file under 8 MiB.");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function publicOrigins(port: number): Set<string> {
  return new Set(
    (
      process.env.STRATEGIC_ORIGINS ??
      `http://127.0.0.1:${port},http://localhost:${port}`
    )
      .split(",")
      .map((v) => {
        const origin = new URL(v.trim());
        if (
          origin.origin !== v.trim() ||
          (origin.protocol !== "https:" &&
            !(
              origin.protocol === "http:" &&
              ["localhost", "127.0.0.1"].includes(origin.hostname)
            ))
        ) {
          throw new Error(
            "STRATEGIC_ORIGINS requires explicit HTTPS origins (HTTP only on loopback).",
          );
        }
        return origin.origin;
      }),
  );
}

async function main() {
  const [, , command, arg1, arg2, arg3, arg4] = process.argv;
  if (command === "extract") {
    if (!arg3)
      throw new Error(
        "Use extract documents.json layout.json new-scenario.json.",
      );
    const scenario = extractScenario(
      await jsonFile(arg1),
      await jsonFile(arg2),
    );
    deploy(scenario); // Fail here, not after a GM has started handing out invites.
    await writeFile(arg3, JSON.stringify(scenario, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    return;
  }
  const url = process.env.DATABASE_URL;
  const room = process.env.STRATEGIC_ROOM;
  if (!url || !isId(room))
    throw new Error("Set DATABASE_URL and STRATEGIC_ROOM (a room ID).");
  const pin = createHash("sha256")
    .update(await readFile(new URL("./worker.mjs", import.meta.url)))
    .digest("hex");
  const db = new PostgresRoom(url, room, pin);
  let running = false;
  try {
    if (command === "migrate") await db.migrate();
    else if (command === "demo" || command === "import") {
      const scenario =
        command === "demo"
          ? generatedScenario(
              Number(arg1 ?? 2),
              Number(arg2 ?? 5),
              arg3 ?? "mixed",
            )
          : parseScenario(await jsonFile(arg1));
      const keysPath = command === "demo" ? arg4 : arg2;
      const keys = keysPath ? await jsonFile(keysPath) : {};
      const slots = new Set(["gm", ...scenario.commanders.map((c) => c.id)]);
      if (
        !record(keys) ||
        Object.entries(keys).some(
          ([slot, key]) => !slots.has(slot) || !isPublicKey(key),
        ) ||
        new Set(Object.values(keys)).size !== Object.keys(keys).length
      )
        throw new Error(
          "Use unique identity public keys indexed by commander slot (or gm).",
        );
      const invites = await db.create(
        scenario,
        deploy(scenario),
        keys as Record<string, string>,
      );
      console.log(JSON.stringify({ room, expiresInMinutes: 30, invites }));
    } else if (command === "export") {
      if (!arg1) throw new Error("Provide a new file path for the GM export.");
      const { state, report, scenario, pin } = await db.exportLatest();
      await writeFile(
        arg1,
        JSON.stringify({
          format: "arenastar-strategic-checkpoint-v1",
          scenario,
          pin,
          codecVersion: 2,
          state: {
            ...state,
            bytes: Buffer.from(state.bytes).toString("base64"),
          },
          report: report ? Buffer.from(report).toString("base64") : null,
        }),
        { flag: "wx", mode: 0o600 },
      );
      await chmod(arg1, 0o600);
    } else if (command === "serve" || command === "campaign") {
      const port = Number(process.env.PORT ?? 8788);
      if (!integer(port, 1, 65535)) throw new Error("Invalid PORT.");
      const service = command === "campaign" ? await serveCampaign(url, room, pin, publicOrigins(port), port, process.env.STRATEGIC_LAUNCH_KEY ?? "") : await serve(db, publicOrigins(port), port);
      if (command === "campaign") await db.dispose();
      running = true;
      process.once("SIGTERM", () => {
        void service.close();
      });
      process.once("SIGINT", () => {
        void service.close();
      });
      console.log(`Strategic room ${room} listening on port ${port}.`);
    } else
      throw new Error(
        "Use migrate | demo [players units workload keys.json] | extract documents.json layout.json new-scenario.json | import scenario.json [keys.json] | export checkpoint.json | serve.",
      );
  } finally {
    if (!running) await db.dispose();
  }
}

main().catch((error: unknown) => {
  // Do not emit SQL/property diagnostics containing member or order payloads.
  const message =
    error instanceof Error && !("severity" in error)
      ? error.message
      : "Strategic database operation failed.";
  console.error(message);
  process.exitCode = 1;
});
