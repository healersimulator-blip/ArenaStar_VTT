import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { serveCampaign } from "../../services/strategic-room/src/campaign";
import { digest } from "../../services/strategic-room/src/invite";
import { PostgresRoom } from "../../services/strategic-room/src/postgres";
import {
  deploy,
  generatedScenario,
} from "../../services/strategic-room/src/scenario";
import { campaignProof } from "../../src/core/strategicRoom/protocol";
import { generateIdentity, signText } from "../../src/net/identity";

const url = process.env.STRATEGIC_TEST_DATABASE_URL;
const pin = "campaign-invite-test-v1";
const rooms: string[] = [];
const dbs: PostgresRoom[] = [];
let service: Awaited<ReturnType<typeof serveCampaign>> | undefined;
const bindAddress = process.env.STRATEGIC_BIND_ADDRESS;

async function availablePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === "string")
    throw new Error("No local port.");
  return address.port;
}

afterEach(async () => {
  await service?.close();
  service = undefined;
  await Promise.all(dbs.splice(0).map((db) => db.dispose()));
  if (url && rooms.length) {
    const cleaner = new PostgresRoom(url, "cleanup", pin);
    try {
      const finished = rooms.splice(0);
      await cleaner.pool.query(
        "DELETE FROM strategic_campaign_bindings WHERE room_id=ANY($1::text[])",
        [finished],
      );
      await cleaner.pool.query(
        "DELETE FROM strategic_rooms WHERE id=ANY($1::text[])",
        [finished],
      );
    } finally {
      await cleaner.dispose();
    }
  }
  if (bindAddress === undefined) delete process.env.STRATEGIC_BIND_ADDRESS;
  else process.env.STRATEGIC_BIND_ADDRESS = bindAddress;
});

describe.skipIf(!url)("campaign invite recovery", () => {
  test("retry launch returns a reissued roster invite, not the original HMAC code", async () => {
    if (!url) throw new Error("Disposable PostgreSQL URL missing.");
    process.env.STRATEGIC_BIND_ADDRESS = "127.0.0.1";
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const id = randomUUID();
    const slot = `invite-${randomUUID()}`;
    const key = `${randomUUID()}${randomUUID()}`;
    const gm = await generateIdentity();
    const scenario = generatedScenario(4, 5);
    const invite = (member: string) =>
      createHmac("sha256", key)
        .update(JSON.stringify([id, member]))
        .digest("base64url");

    // Provision the binding and exercise the real GM `member.invite` command before the
    // campaign edge takes the lease. This mirrors a reissue from the GM roster UI.
    const db = new PostgresRoom(url, id, pin);
    dbs.push(db);
    rooms.push(id);
    await db.migrate();
    await db.create(
      scenario,
      deploy(scenario),
      { gm: gm.publicKeyHex },
      { slot, invite },
    );
    await db.acquire(() => undefined);
    const gmMember = await db.admit(gm.publicKeyHex);
    if (!gmMember) throw new Error("GM member missing.");
    const reissued = "r".repeat(32);
    const result = await db.command(
      gmMember,
      {
        kind: "member.invite",
        requestId: randomUUID(),
        memberId: "commander-1",
        invite: reissued,
      },
      Date.now(),
      scenario.seed,
      () => null,
      (memberId) =>
        scenario.commanders
          .find((c) => c.id === memberId)
          ?.units.map((u) => u.id) ?? [],
    );
    expect(result.receipt).toMatchObject({ status: "accepted" });
    expect(
      (await db.roster()).find((m) => m.id === "commander-1")?.invite,
    ).toBe(reissued);
    const stored = await db.pool.query<{ inviteHash: string }>(
      `SELECT invite_hash AS "inviteHash" FROM strategic_members
      WHERE room_id=$1 AND id='commander-1'`,
      [id],
    );
    expect(stored.rows[0]?.inviteHash).toBe(digest(reissued));
    await db.dispose();

    service = await serveCampaign(url, slot, pin, new Set([origin]), port, key);
    const at = Date.now();
    const res = await fetch(`${origin}/api/campaign/launch`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id,
        publicKey: gm.publicKeyHex,
        scenario,
        at,
        signature: await signText(
          gm,
          campaignProof("launch", origin, id, at, scenario),
        ),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites: Record<string, string> };
    expect(body.invites["commander-1"]).toBe(reissued);
    expect(body.invites["commander-1"]).not.toBe(invite("commander-1"));
    // An untouched initial invite is still recoverable from its sealed resend copy.
    expect(body.invites["commander-2"]).toBe(invite("commander-2"));
  });
});
