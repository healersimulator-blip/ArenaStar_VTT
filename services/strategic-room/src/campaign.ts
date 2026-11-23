/** Same-origin VTT entry + one live strategic authority per deployment. No peer messages are proxied. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { verifyText } from "../../../src/net/identity";
import { ModelStatus } from "../../../src/core/strategic";
import {
  record,
  isPublicKey,
  campaignProof,
  type BattleReconciliationPayload,
  type ReconciledUnitSummary,
  type StrategicModelStats,
} from "../../../src/core/strategicRoom/protocol";
import { parseScenario, deploy, initialUnitResources, type Scenario, type UnitState } from "./scenario";
import { summarizeUnitModelStats } from "./battle";
import { digest, openInvite, sealInvite } from "./invite";
import { PostgresRoom } from "./postgres";
import { checkpointPool, type LiveRoomState, type Published, type VersionExtras } from "./state";
import { serve } from "./server";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (s: string) => createHash("sha256").update(s).digest();
const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
};

export function buildReconciliationPayload(
  id: string,
  scenario: Scenario,
  state: Published,
  live: LiveRoomState,
  surviving: number,
  lost: number,
  previewOnly?: boolean,
): BattleReconciliationPayload {
  const pool = checkpointPool(state);
  const baseRes = initialUnitResources(scenario);
  const curRes = state.extras?.unitResources ?? {};
  const units: ReconciledUnitSummary[] = [];
  const allUnits = scenario.commanders.flatMap((c) =>
    c.units.map((u) => ({ u, factionId: u.factionId ?? c.factionId })),
  );

  allUnits.forEach(({ u, factionId }, idx) => {
    const unitState = state.units[idx];
    const [start, end] = unitState?.range ?? [0, 0];
    let sx = 0,
      sy = 0,
      sinSum = 0,
      cosSum = 0,
      alive = 0;
    const statsMap = scenario.trackModelStats ? (state.extras?.modelStats ?? {}) : null;
    const survivingModelStats: StrategicModelStats[] = [];
    for (let i = start; i < end && i < pool.count; i++) {
      if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
      sx += pool.x[i] ?? 0;
      sy += pool.y[i] ?? 0;
      const rot = pool.rot[i] ?? 0;
      sinSum += Math.sin(rot);
      cosSum += Math.cos(rot);
      alive++;
      if (statsMap) {
        const rec = statsMap[String(pool.id[i])];
        survivingModelStats.push(rec ? { ...rec } : { kills: 0, damageDealt: 0 });
      }
    }
    const at =
      alive > 0
        ? {
            x: Math.round((sx / alive) * 10) / 10,
            y: Math.round((sy / alive) * 10) / 10,
          }
        : null;
    const facing =
      alive > 0 ? Math.round(Math.atan2(sinSum, cosSum) * 1000) / 1000 : undefined;

    const spellsSpent: Record<string, number> = {};
    if (u.spells?.length) {
      for (const sp of u.spells) {
        const rem =
          curRes[u.id]?.spells?.[sp.id] ??
          (sp.id === "entangle" ? unitState?.stats.entangleSlots : undefined) ??
          baseRes[u.id]?.spells?.[sp.id] ??
          sp.slots;
        const spent = Math.max(0, sp.slots - rem);
        if (spent > 0) spellsSpent[sp.id] = (spellsSpent[sp.id] ?? 0) + spent;
      }
    } else if (u.spellcasting) {
      const rem =
        curRes[u.id]?.spells?.entangle ??
        unitState?.stats.entangleSlots ??
        u.spellcasting.entangleSlots;
      const spent = Math.max(0, u.spellcasting.entangleSlots - rem);
      if (spent > 0) {
        spellsSpent.entangle = (spellsSpent.entangle ?? 0) + spent;
      }
    }

    const itemsSpent: Record<string, number> = {};
    for (const it of u.items ?? []) {
      const rem = curRes[u.id]?.items?.[it.id] ?? baseRes[u.id]?.items?.[it.id] ?? it.charges;
      const spent = Math.max(0, it.charges - rem);
      if (spent > 0) itemsSpent[it.id] = (itemsSpent[it.id] ?? 0) + spent;
    }

    const launchConditions = baseRes[u.id]?.conditions ?? [];
    const conditions = curRes[u.id]?.conditions ?? u.conditions ?? [];
    const conditionsAdded = conditions.filter((c) => !launchConditions.includes(c));
    const modelStatsSummary = statsMap
      ? summarizeUnitModelStats(survivingModelStats)
      : undefined;
    units.push({
      id: u.id,
      name: u.name,
      factionId,
      ...(u.source ? { source: u.source } : {}),
      initialStrength: u.strength,
      alive,
      lost: Math.max(0, u.strength - alive),
      at,
      ...(facing !== undefined ? { facing } : {}),
      ...(Object.keys(spellsSpent).length ? { spellsSpent } : {}),
      ...(Object.keys(itemsSpent).length ? { itemsSpent } : {}),
      ...(conditions.length ? { conditions: [...conditions] } : {}),
      ...(conditionsAdded.length ? { conditionsAdded } : {}),
      ...(statsMap && survivingModelStats.length
        ? { modelStats: survivingModelStats }
        : {}),
      ...(modelStatsSummary ? { modelStatsSummary } : {}),
    });
  });

  const doorStates: Record<string, 0 | 1 | 2> = {};
  for (const w of scenario.walls ?? []) {
    if (w.id && w.door !== undefined) {
      doorStates[w.id] =
        live.doors && Object.hasOwn(live.doors, w.id)
          ? (live.doors[w.id] ?? w.door)
          : w.door;
    }
  }
  const darkness =
    live.darkness !== undefined ? live.darkness : scenario.lighting?.darkness;

  return {
    id,
    version: state.version,
    ...(previewOnly ? { previewOnly: true } : {}),
    surviving,
    lost,
    units,
    ...(Object.keys(doorStates).length ? { doorStates } : {}),
    ...(darkness !== undefined ? { darkness } : {}),
    ...(scenario.projection
      ? {
          projection: {
            worldId: scenario.projection.worldId,
            sceneId: scenario.projection.sceneId,
            sourceSeq: scenario.projection.sourceSeq,
            digest: scenario.projection.digest,
            ...(scenario.projection.dependencies
              ? { dependencies: scenario.projection.dependencies }
              : {}),
          },
        }
      : {}),
  };
}
export async function serveCampaign(
  url: string,
  slot: string,
  pin: string,
  origins: Set<string>,
  port: number,
  token: string,
) {
  if (token.length < 32)
    throw new Error(
      "Set STRATEGIC_LAUNCH_KEY to a random secret of at least 32 characters.",
    );
  // The API test path may run before `pnpm build`; the deployed campaign still uses the
  // real single-file app shell. Keep the fallback inert so no test can drive GM UI from it.
  const shell = Buffer.from(
    (
      await readFile(
        new URL("../../../../dist/index.html", import.meta.url),
        "utf8",
      ).catch(
        () => '<!doctype html><meta charset="utf-8"><title>Arena Star</title>',
      )
    ).replace("<head>", '<head><meta name="arenastar-campaign" content="v1">'),
  );
  const registry = new PostgresRoom(url, slot, pin);
  let live: { id: string; edge: Awaited<ReturnType<typeof serve>> } | null =
    null;
  let busy = false;
  let createdInvites: Record<string, string> = {};
  async function attach(id: string) {
    if (live?.id === id) return;
    if (live) throw new Error("Slot occupied");
    const db = new PostgresRoom(url, id, pin);
    try {
      live = { id, edge: await serve(db, origins, null) };
    } catch (e) {
      await db.dispose();
      throw e;
    }
  }
  await registry.migrate();
  const saved = await registry.pool.query<{ room_id: string }>(
    "SELECT room_id FROM strategic_campaign_bindings WHERE slot=$1 AND NOT ended",
    [slot],
  );
  if (saved.rows[0]) await attach(saved.rows[0].room_id);
  function route(req: IncomingMessage) {
    if (!live) return null;
    const prefix = `/battle/${live.id}`;
    if (!req.url?.startsWith(prefix + "/")) return null;
    req.url = req.url.slice(prefix.length);
    return live.edge.server;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url?.split("?")[0] === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end(shell);
      return;
    }
    const edge = route(req);
    if (edge) {
      edge.emit("request", req, res);
      return;
    }
    if (
      req.method !== "POST" ||
      !["/api/campaign/launch", "/api/campaign/finish"].includes(req.url ?? "")
    )
      return json(res, 404, { error: "Not found" });
    if (
      !origins.has(req.headers.origin ?? "") ||
      !timingSafeEqual(
        hash(req.headers.authorization ?? ""),
        hash(`Bearer ${token}`),
      )
    )
      return json(res, 403, { error: "Origin or launch key not authorized." });
    if (busy)
      return json(res, 409, {
        error: "Another campaign command is in progress. Retry.",
      });
    busy = true;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 24 * 1024 * 1024)
          return json(res, 413, { error: "Deployment too large" });
        chunks.push(chunk);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return json(res, 400, { error: "Invalid JSON" });
      }
      if (
        !record(body) ||
        typeof body.id !== "string" ||
        !uuid.test(body.id) ||
        !isPublicKey(body.publicKey)
      )
        return json(res, 400, { error: "Invalid battle identity" });
      const { id, publicKey } = body;
      createdInvites = {};
      const previewOnly =
        req.url === "/api/campaign/finish" && body.previewOnly === true;
      const action =
        req.url === "/api/campaign/finish"
          ? previewOnly
            ? "preview"
            : "finish"
          : "launch";
      const validSig =
        typeof body.at === "number" &&
        Number.isSafeInteger(body.at) &&
        Math.abs(Date.now() - body.at) <= 60000 &&
        typeof body.signature === "string" &&
        body.signature.length <= 256 &&
        ((await verifyText(
          publicKey,
          body.signature,
          campaignProof(
            action,
            req.headers.origin ?? "",
            id,
            body.at,
            body.scenario,
          ),
        )) ||
          (previewOnly &&
            (await verifyText(
              publicKey,
              body.signature,
              campaignProof(
                "finish",
                req.headers.origin ?? "",
                id,
                body.at,
                body.scenario,
              ),
            ))));
      if (!validSig)
        return json(res, 403, {
          error: "Invalid or expired GM identity proof.",
        });
      const existing = (
        await registry.pool.query<{
          ended: boolean;
          public_key: string;
        }>(
          `SELECT c.ended,m.public_key FROM strategic_campaign_bindings c JOIN strategic_members m ON m.room_id=c.room_id AND m.id='gm' WHERE c.room_id=$1 AND c.slot=$2`,
          [id, slot],
        )
      ).rows[0];
      if (existing && existing.public_key !== publicKey)
        return json(res, 403, { error: "Wrong GM identity" });
      if (req.url === "/api/campaign/finish") {
        if (!existing)
          return json(res, 404, {
            id,
            unprovisioned: true,
            error: "No such battle",
          });
        if (!previewOnly && !existing.ended) {
          if (live?.id !== id) await attach(id);
          const closing = live;
          live = null;
          await closing?.edge.close();
          await registry.pool.query(
            "UPDATE strategic_campaign_bindings SET ended=true WHERE room_id=$1",
            [id],
          );
        }
        const row = (
          await registry.pool.query<{
            version: number;
            scenario: Scenario;
            liveState: LiveRoomState | null;
          }>(
            `SELECT version, scenario, live_state AS "liveState" FROM strategic_rooms WHERE id=$1`,
            [id],
          )
        ).rows[0];
        if (!row) throw new Error("Missing committed battle");
        const verRow = (
          await registry.pool.query<{
            version: number;
            bytes: Buffer;
            maxHpMax: number;
            hash: string;
            units: UnitState[];
            extras: VersionExtras | null;
          }>(
            `SELECT version, checkpoint AS bytes, hp_max AS "maxHpMax", pool_hash AS hash, units, extras
             FROM strategic_versions WHERE room_id=$1 AND version=$2`,
            [id, row.version],
          )
        ).rows[0];
        const totals = (
          await registry.pool.query<{ surviving: number; lost: number }>(
            `SELECT coalesce(sum((row->>'alive')::int),0)::int AS surviving, coalesce(sum((row->>'lost')::int),0)::int AS lost FROM strategic_report_rows WHERE room_id=$1 AND version=$2`,
            [id, row.version],
          )
        ).rows[0];
        if (!totals) throw new Error("Missing battle totals");
        let reconciliation: BattleReconciliationPayload | undefined;
        if (verRow) {
          const initialTotal = row.scenario.commanders
            .flatMap((c) => c.units)
            .reduce((acc, u) => acc + u.strength, 0);
          const published: Published = {
            version: verRow.version,
            bytes: verRow.bytes,
            maxHpMax: verRow.maxHpMax,
            hash: verRow.hash,
            units: verRow.units,
            ...(verRow.extras ? { extras: verRow.extras } : {}),
          };
          const built = buildReconciliationPayload(
            id,
            row.scenario,
            published,
            row.liveState ?? {},
            row.version > 0 ? totals.surviving : initialTotal,
            row.version > 0 ? totals.lost : 0,
            previewOnly,
          );
          reconciliation = built;
        }
        return json(res, 200, {
          id,
          version: row.version,
          previewOnly,
          ...(row.version > 0 ? totals : {}),
          ...(reconciliation ? { reconciliation } : {}),
        });
      }
      if (existing?.ended || (live && live.id !== id))
        return json(res, 409, {
          error: "Battle ended or deployment slot already occupied.",
        });
      const invite = (member: string) =>
        createHmac("sha256", token)
          .update(JSON.stringify([id, member]))
          .digest("base64url");

      if (!existing) {
        let scenario, state;
        try {
          scenario = parseScenario(body.scenario);
          if (scenario.background) {
            const bytes = Buffer.from(scenario.background.data, "base64url");
            if (
              bytes.byteLength !== scenario.background.size ||
              createHash("sha256").update(bytes).digest("hex") !== scenario.background.hash
            ) throw new Error("Battlefield background hash or size mismatch.");
          }
          if (scenario.backgroundAssets) {
            for (const panel of Object.values(scenario.backgroundAssets)) {
              const bytes = Buffer.from(panel.data, "base64url");
              if (
                bytes.byteLength !== panel.size ||
                createHash("sha256").update(bytes).digest("hex") !== panel.hash
              ) throw new Error("Stitched map panel hash or size mismatch.");
            }
          }
          if (scenario.badges) {
            for (const badge of Object.values(scenario.badges)) {
              const bytes = Buffer.from(badge.data, "base64url");
              if (
                bytes.byteLength !== badge.size ||
                createHash("sha256").update(bytes).digest("hex") !== badge.hash
              ) throw new Error("Unit badge hash or size mismatch.");
            }
          }
          state = deploy(scenario);
        } catch (e) {
          return json(res, 422, {
            error: e instanceof Error ? e.message : "Invalid deployment",
          });
        }
        const db = new PostgresRoom(url, id, pin);
        try {
          createdInvites = await db.create(
            scenario,
            state,
            { gm: publicKey },
            { slot, invite },
          );
        } finally {
          await db.dispose();
        }
      }
      await attach(id);
      const rows = (
        await registry.pool.query<{
          id: string;
          inviteHash: string;
          inviteCipher: string | null;
          projectionKey: Buffer;
        }>(
          `SELECT m.id,m.invite_hash AS "inviteHash",m.invite_cipher AS "inviteCipher",
            r.projection_key AS "projectionKey"
          FROM strategic_members m JOIN strategic_rooms r ON r.id=m.room_id
          WHERE m.room_id=$1 AND m.active AND m.invite_hash IS NOT NULL
            AND m.invite_expires>now() ORDER BY m.id`,
          [id],
        )
      ).rows;
      const invites: Record<string, string> = {};
      for (const row of rows) {
        const code = row.inviteCipher
          ? openInvite(row.projectionKey, id, row.id, row.inviteCipher)
          : null;
        if (code && digest(code) === row.inviteHash) {
          invites[row.id] = code;
          continue;
        }
        // Pre-migration rooms used launch-key HMAC invites with no resend copy. Verify
        // before returning one, then seal it so later retries and the GM roster agree.
        if (!row.inviteCipher) {
          const legacy = invite(row.id);
          if (digest(legacy) === row.inviteHash) {
            invites[row.id] = legacy;
            await registry.pool.query(
              "UPDATE strategic_members SET invite_cipher=$3 WHERE room_id=$1 AND id=$2",
              [id, row.id, sealInvite(row.projectionKey, id, row.id, legacy)],
            );
          }
        }
      }
      return json(res, 200, {
        id,
        invites: existing ? invites : { ...invites, ...createdInvites },
      });
    } finally {
      busy = false;
    }
  }
  const server = createServer(
    { requestTimeout: 15000 },
    (req, res) =>
      void handle(req, res).catch(() =>
        json(res, 503, {
          error: "Service unavailable. Retry with the same battle.",
        }),
      ),
  );
  // The edge is dispatched in-process (no second listener); enforce the socket cap
  // on the actual listener as well as the edge's per-session and bulk limits.
  server.maxConnections = 1200;
  server.on("upgrade", (req, socket, head) => {
    const edge = route(req);
    if (edge) edge.emit("upgrade", req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      port,
      process.env.STRATEGIC_BIND_ADDRESS ?? "0.0.0.0",
      resolve,
    );
  });
  return {
    async close() {
      server.close();
      server.closeAllConnections();
      await live?.edge.close();
      await registry.dispose();
    },
  };
}
