import { randomBytes } from "node:crypto";
import { digest, openInvite, sealInvite } from "./invite";
import schema from "../schema.sql?raw";
import pg, { type PoolClient } from "pg";
import {
  PAGE_ROWS,
  reject,
  type Command,
  type OwnOrders,
  type Receipt,
  type ReportRow,
  type UnitEdit,
} from "../../../src/core/strategicRoom/protocol";
import { turnSeed } from "../../../src/host/turnEngine";
import { parseScenario, scenarioProjectionDigest, type Scenario, type UnitState } from "./scenario";
import type {
  Control,
  Frozen,
  FrozenOrder,
  Member,
  MemberRecord,
  Published,
  Result,
  RoomRecord,
} from "./state";

const columns = `turn_id AS "turnId", version, phase, deadline_ms AS "deadlineMs", generation, members_version AS "members"`;
const memberColumns = `id, coalesce(name,id) AS "name", role, faction_id AS "factionId", epoch`;
const publishedColumns =
  'version, checkpoint AS bytes, hp_max AS "maxHpMax", pool_hash AS hash, units, hazards, actions, control';
type RoomRow = Omit<RoomRecord, "deadlineMs" | "members"> & {
  deadlineMs: string | null;
  members: number;
};
const roomRecord = ({
  turnId,
  phase,
  version,
  deadlineMs,
  generation,
  members,
}: RoomRow): RoomRecord => ({
  turnId,
  phase,
  version,
  deadlineMs: deadlineMs === null ? null : Number(deadlineMs),
  generation,
  members,
});
const secret = () => randomBytes(32).toString("base64url");
const json = JSON.stringify;
export class StaleAuthority extends Error {}
export type CommittedCommand = {
  receipt: Receipt;
  room?: RoomRecord;
  revoked?: string;
  /** A durable allowlist edit, or `null` when the seat returns to its deployment. */
  control?: { memberId: string; units: string[] | null };
  /** Accepted one-time invite codes, returned only to the GM's private receipt. */
  invites?: Record<string, string>;
  /** A live session the edge must drop, without revoking the seat. */
  kicked?: string;
  /** Durable authored allegiance change; authority rebuilds every projected cohort. */
  scenario?: Scenario;
};

/** The lease serializes admission across processes; the generation also fences late commits after lease loss. */
export class PostgresRoom {
  readonly pool: pg.Pool;
  private lease: PoolClient | null = null;
  private ownedGeneration: number | null = null;
  private disposed: Promise<void> | undefined;
  /** Decrypted invite resend copies, keyed by seat; invalidated when the cipher changes. */
  private readonly inviteCache = new Map<
    string,
    { cipher: string; code: string }
  >();

  constructor(
    connectionString: string,
    readonly id: string,
    readonly pin: string,
  ) {
    this.pool = new pg.Pool({
      connectionString,
      max: 12,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      idle_in_transaction_session_timeout: 6000,
      application_name: "arenastar-strategic",
    });
    // Idle connections can fail independently; active queries still propagate their errors.
    this.pool.on("error", () =>
      console.error("Strategic database idle connection lost."),
    );
  }

  get generation(): number {
    if (this.ownedGeneration === null)
      throw new StaleAuthority("Room lease not held.");
    return this.ownedGeneration;
  }

  async migrate() {
    await this.pool.query(schema);
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL synchronous_commit = on");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw e;
    } finally {
      client.release(discard);
    }
  }

  async acquire(onLost: () => void) {
    const lease = await this.pool.connect();
    let released = false;
    const lost = () => {
      if (this.lease !== lease) return;
      this.ownedGeneration = null;
      this.lease = null;
      released = true;
      lease.release(true);
      onLost();
    };
    lease.on("error", lost);
    lease.on("end", lost);
    try {
      const lock = await lease.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('arenastar-strategic:' || $1, 0)) AS ok",
        [this.id],
      );
      if (!lock.rows[0]?.ok)
        throw new Error("Another authority owns this room.");
      this.lease = lease;
      const { rows } = await lease.query<
        RoomRow & { scenario: Scenario; key: Buffer }
      >(
        `UPDATE strategic_rooms SET generation=generation+1 WHERE id=$1 AND rules_pin=$2 RETURNING ${columns}, scenario, projection_key AS key`,
        [this.id, this.pin],
      );
      const row = rows[0];
      if (!row)
        throw new Error(
          "Room not found or resolver build differs from the pinned build.",
        );
      if (this.lease !== lease) throw new StaleAuthority("Room lease lost.");
      this.ownedGeneration = row.generation;
      return { room: roomRecord(row), scenario: row.scenario, key: row.key };
    } catch (error) {
      lease.off("error", lost);
      lease.off("end", lost);
      // A lost connection is already released by the lease listener.
      if (this.lease === lease) {
        this.lease = null;
        await this.releaseLock(lease);
      } else if (!released) lease.release(true);
      throw error;
    }
  }

  private async releaseLock(lease: PoolClient) {
    // Closing a TCP socket is not an acknowledgement that PostgreSQL has ended the
    // backend session. Unlock on the owning connection before allowing a clean restart.
    try {
      await lease.query(
        "SELECT pg_advisory_unlock(hashtextextended('arenastar-strategic:' || $1, 0))",
        [this.id],
      );
    } catch {
      // A lost session releases the lock at PostgreSQL. Never return it to the pool.
    } finally {
      lease.release(true);
    }
  }

  async dispose() {
    if (this.disposed) return this.disposed;
    const lease = this.lease;
    this.lease = null;
    this.ownedGeneration = null;
    return (this.disposed = (async () => {
      if (lease) await this.releaseLock(lease);
      await this.pool.end();
    })());
  }

  private async locked(
    client: PoolClient,
    generation: number,
  ): Promise<RoomRecord> {
    const { rows } = await client.query<RoomRow>(
      `SELECT ${columns} FROM strategic_rooms WHERE id=$1 FOR UPDATE`,
      [this.id],
    );
    const row = rows[0];
    if (
      !row ||
      row.generation !== generation ||
      this.ownedGeneration !== generation
    )
      throw new StaleAuthority("Room generation fenced.");
    return roomRecord(row);
  }

  private async projectionKey(client: PoolClient): Promise<Uint8Array> {
    const { rows } = await client.query<{ key: Buffer }>(
      "SELECT projection_key AS key FROM strategic_rooms WHERE id=$1",
      [this.id],
    );
    const key = rows[0]?.key;
    if (!key) throw new StaleAuthority("Room missing.");
    return key;
  }

  /** Explicit per-seat allowlists for a publication; unrestricted seats are omitted. */
  private async currentControl(client: PoolClient): Promise<Control> {
    const { rows } = await client.query<{ id: string; units: string[] }>(
      `SELECT id, control_units AS units FROM strategic_members
      WHERE room_id=$1 AND active AND role='PLAYER' AND control_units IS NOT NULL
      ORDER BY id COLLATE "C"`,
      [this.id],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.units]));
  }

  /**
   * Live authority control: include `null` for every unrestricted/inactive seat so an older
   * publication's stale grants can be cleared on restart. This is not a version snapshot.
   */
  async liveControl(): Promise<Control> {
    const { rows } = await this.pool.query<{
      id: string;
      units: string[] | null;
    }>(
      `SELECT id, control_units AS units FROM strategic_members
      WHERE room_id=$1 AND role='PLAYER' ORDER BY id COLLATE "C"`,
      [this.id],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.units ?? null]));
  }

  async create(
    scenario: Scenario,
    state: Published,
    publicKeys: Readonly<Record<string, string>> = {},
    campaign?: { slot: string; invite: (slot: string) => string },
  ) {
    return this.tx(async (client) => {
      const projectionKey = randomBytes(32);
      await client.query(
        "INSERT INTO strategic_rooms(id,rules_pin,scenario,projection_key) VALUES($1,$2,$3,$4)",
        [this.id, this.pin, scenario, projectionKey],
      );
      if (campaign)
        await client.query(
          "INSERT INTO strategic_campaign_bindings(room_id,slot) VALUES ($1,$2)",
          [this.id, campaign.slot],
        );
      await this.insertVersion(client, state, null, {});
      const members = [
        { id: "gm", name: "Game Master", factionId: null },
        ...scenario.commanders.map((c) => ({
          id: c.id,
          name: c.name ?? c.id,
          factionId: c.factionId,
        })),
      ];
      const invites: Record<string, string> = {};
      const values = members.map(({ id, name, factionId }) => {
        const key = Object.hasOwn(publicKeys, id) ? publicKeys[id] : undefined;
        const code = key ? null : (campaign?.invite(id) ?? secret());
        if (code) invites[id] = code;
        return {
          id,
          name,
          role: id === "gm" ? "GM" : "PLAYER",
          faction: factionId,
          key: key ?? null,
          invite: code ? digest(code) : null,
          inviteCipher: code
            ? sealInvite(projectionKey, this.id, id, code)
            : null,
        };
      });
      await client.query(
        `INSERT INTO strategic_members(room_id,id,name,role,faction_id,public_key,invite_hash,invite_cipher,invite_expires)
        SELECT $1,id,name,role,faction,key,invite,"inviteCipher",now() + interval '30 minutes'
        FROM jsonb_to_recordset($2::jsonb) AS m(id text,name text,role text,faction text,key text,invite text,"inviteCipher" text)`,
        [this.id, json(values)],
      );
      return invites;
    });
  }

  /** GM-only roster: identity binding, recoverable invites and current unit grants. */
  async roster(): Promise<MemberRecord[]> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      role: Member["role"];
      factionId: string | null;
      claimed: boolean;
      hasInvite: boolean;
      inviteHash: string | null;
      inviteCipher: string | null;
      projectionKey: Buffer;
      controlUnits: string[] | null;
      deployed: string[] | null;
    }>(
      `SELECT m.id, coalesce(m.name,m.id) AS name, m.role, m.faction_id AS "factionId",
        m.public_key IS NOT NULL AS claimed,
        (m.invite_hash IS NOT NULL AND m.invite_expires > now()) AS "hasInvite",
        m.invite_hash AS "inviteHash",
        m.invite_cipher AS "inviteCipher",
        m.control_units AS "controlUnits",
        r.projection_key AS "projectionKey",
        (SELECT array_agg(u->>'id' ORDER BY u->>'id' COLLATE "C")
          FROM jsonb_array_elements(r.scenario->'commanders') c,
            jsonb_array_elements(c->'units') u
          WHERE c->>'id'=m.id AND m.role='PLAYER') AS deployed
      FROM strategic_members m JOIN strategic_rooms r ON r.id=m.room_id
      WHERE m.room_id=$1 AND m.active
      ORDER BY m.id COLLATE "C"`,
      [this.id],
    );
    return rows.map((row) => {
      let code: string | null = null;
      if (row.hasInvite && row.inviteCipher) {
        // Avoid 500 AES-GCM opens on every GM view: reuse the decrypted code
        // while the stored cipher is unchanged (reissue/admit/revoke change it).
        const cached = this.inviteCache.get(row.id);
        if (cached && cached.cipher === row.inviteCipher) {
          code = cached.code;
        } else {
          code = openInvite(row.projectionKey, this.id, row.id, row.inviteCipher);
          if (code) this.inviteCache.set(row.id, { cipher: row.inviteCipher, code });
          else this.inviteCache.delete(row.id);
        }
      } else {
        this.inviteCache.delete(row.id);
      }
      return {
        id: row.id,
        name: row.name,
        role: row.role,
        factionId: row.factionId,
        // SQL NULL is unrestricted; an empty JSON array is an explicit no-unit allowlist.
        units: row.controlUnits ?? row.deployed ?? [],
        deployed: row.deployed ?? [],
        claimed: row.claimed,
        invite:
          code && row.inviteHash && digest(code) === row.inviteHash
            ? code
            : null,
      };
    });
  }

  /** One commander's canonical grants; `null` means unrestricted, `[]` means none. */
  async grants(memberId: string): Promise<string[] | null> {
    const { rows } = await this.pool.query<{ units: string[] | null }>(
      `SELECT control_units AS units FROM strategic_members
      WHERE room_id=$1 AND id=$2`,
      [this.id, memberId],
    );
    return rows[0]?.units ?? null;
  }

  async admit(publicKey: string, invite?: string): Promise<Member | null> {
    // Bound-key resume is read-only; first-use invite claiming is a durable compare-and-set.
    const current = await this.pool.query<Member>(
      `SELECT ${memberColumns} FROM strategic_members
      WHERE room_id=$1 AND public_key=$2 AND active`,
      [this.id, publicKey],
    );
    if (current.rows[0]) return current.rows[0];
    if (!invite) return null;
    const generation = this.generation;
    return this.tx(async (client) => {
      await this.locked(client, generation);
      const { rows } = await client.query<Member>(
        `UPDATE strategic_members SET public_key=$2, invite_hash=NULL, invite_cipher=NULL, invite_expires=NULL
        WHERE room_id=$1 AND public_key IS NULL AND active AND invite_hash=$3 AND invite_expires > now()
        AND NOT EXISTS (SELECT 1 FROM strategic_members WHERE room_id=$1 AND public_key=$2)
        RETURNING ${memberColumns}`,
        [this.id, publicKey, digest(invite)],
      );
      return rows[0] ?? null;
    });
  }

  async command(
    member: Member,
    cmd: Command,
    admittedAt: number,
    seed: number,
    validate: (edit: UnitEdit) => string | null,
    deployable: (memberId: string) => readonly string[],
  ): Promise<CommittedCommand> {
    const generation = this.generation;
    const requestDigest = digest(json(cmd));
    return this.tx(async (client) => {
      const room = await this.locked(client, generation);
      const alive = await client.query(
        "SELECT 1 FROM strategic_members WHERE room_id=$1 AND id=$2 AND epoch=$3 AND active",
        [this.id, member.id, member.epoch],
      );
      if (!alive.rowCount)
        return {
          receipt: reject(
            cmd.requestId,
            "forbidden",
            "Membership is not active.",
          ),
        };
      const key = [this.id, member.id, cmd.requestId];
      const existing = (
        await client.query<{ digest: string; receipt: Receipt }>(
          `SELECT digest,receipt FROM strategic_receipts
        WHERE room_id=$1 AND member_id=$2 AND request_id=$3`,
          key,
        )
      ).rows[0];
      if (existing)
        return {
          receipt:
            existing.digest === requestDigest
              ? existing.receipt
              : reject(
                  cmd.requestId,
                  "request_reused",
                  "Request ID already used for different data.",
                ),
        };
      const finish = async (reply: CommittedCommand) => {
        await client.query(
          `INSERT INTO strategic_receipts VALUES($1,$2,$3,$4,$5)`,
          [...key, requestDigest, reply.receipt],
        );
        return reply;
      };
      const deny = (code: Parameters<typeof reject>[1], message: string) =>
        finish({ receipt: reject(cmd.requestId, code, message) });
      const ok = (turnId: number, revision?: number): Receipt => ({
        kind: "receipt",
        requestId: cmd.requestId,
        status: "accepted",
        turnId,
        ...(revision === undefined ? {} : { revision }),
      });
      if (cmd.kind === "orders.submit") {
        if (
          room.phase !== "orders" ||
          cmd.turnId !== room.turnId ||
          (room.deadlineMs !== null && admittedAt >= room.deadlineMs)
        ) {
          return deny("turn_closed", "This turn no longer accepts orders.");
        }
        const revisionKey = [this.id, room.turnId, member.id];
        const previous =
          (
            await client.query<{ revision: number }>(
              "SELECT revision FROM strategic_revisions WHERE room_id=$1 AND turn_id=$2 AND member_id=$3",
              revisionKey,
            )
          ).rows[0]?.revision ?? 0;
        if (cmd.expectedRevision !== previous)
          return deny(
            "stale_revision",
            "Reload your accepted orders before submitting a new batch.",
          );
        for (const edit of cmd.unitEdits) {
          const reason = validate(edit);
          if (reason) return deny("invalid_order", reason);
        }
        const revision = previous + 1;
        await client.query(
          "DELETE FROM strategic_orders WHERE room_id=$1 AND turn_id=$2 AND member_id=$3 AND unit_id=ANY($4::text[])",
          [...revisionKey, cmd.unitEdits.map((e) => e.unitId)],
        );
        await client.query(
          `INSERT INTO strategic_orders(room_id,turn_id,member_id,unit_id,payload)
          SELECT $1,$2,$3,e."unitId",e."order" FROM jsonb_to_recordset($4::jsonb) AS e("unitId" text,"order" jsonb)`,
          [...revisionKey, json(cmd.unitEdits.filter((e) => e.order !== null))],
        );
        await client.query(
          `INSERT INTO strategic_revisions VALUES($1,$2,$3,$4)
          ON CONFLICT (room_id,turn_id,member_id) DO UPDATE SET revision=EXCLUDED.revision`,
          [...revisionKey, revision],
        );
        return finish({ receipt: ok(room.turnId, revision) });
      }
      if (member.role !== "GM")
        return deny("forbidden", "Only the GM may use this command.");
      if (cmd.kind === "unit.faction") {
        if (room.phase !== "orders")
          return deny("wrong_phase", "Unit allegiance can only change while orders are open.");
        const row = (await client.query<{ scenario: Scenario }>(
          "SELECT scenario FROM strategic_rooms WHERE id=$1 FOR UPDATE", [this.id],
        )).rows[0];
        if (!row) throw new StaleAuthority("Room missing.");
        if (!row.scenario.factions.some((faction) => faction.id === cmd.factionId))
          return deny("invalid_order", "Unknown battlefield faction.");
        let found = false;
        const candidate: Scenario = {
          ...row.scenario,
          commanders: row.scenario.commanders.map((commander) => ({
            ...commander,
            units: commander.units.map((unit) => {
              if (unit.id !== cmd.unitId) return unit;
              found = true;
              return { ...unit, factionId: cmd.factionId };
            }),
          })),
        };
        if (candidate.projection) {
          const payload = { ...candidate };
          delete payload.projection;
          candidate.projection = { ...candidate.projection,
            digest: scenarioProjectionDigest(payload) };
        }
        const next = parseScenario(candidate);
        if (!found) return deny("invalid_order", "Unknown battlefield unit.");
        await client.query("UPDATE strategic_rooms SET scenario=$2::jsonb WHERE id=$1", [this.id, json(next)]);
        // Existing orders were validated against the former friend/enemy graph. Clear them
        // rather than allowing an attack on a new ally to resolve silently.
        await client.query("DELETE FROM strategic_orders WHERE room_id=$1 AND turn_id=$2", [this.id, room.turnId]);
        await client.query("UPDATE strategic_revisions SET revision=revision+1 WHERE room_id=$1 AND turn_id=$2", [this.id, room.turnId]);
        return finish({ receipt: ok(room.turnId), scenario: next, room: await this.setMembers(client) });
      }
      if (cmd.kind === "member.update") {
        const target = (
          await client.query<{ role: string; factionId: string | null }>(
            `SELECT role,faction_id AS "factionId" FROM strategic_members
            WHERE room_id=$1 AND id=$2 AND active FOR UPDATE`,
            [this.id, cmd.memberId],
          )
        ).rows[0];
        if (!target || target.role !== "PLAYER")
          return deny("forbidden", "No active commander with that slot ID.");
        // The wire parser trims too; keep the durable row canonical for direct authority callers.
        const name = cmd.name?.trim();
        if (name !== undefined) {
          if (!name || name.length > 64)
            return deny(
              "invalid_order",
              "Commander names are 1–64 characters.",
            );
          await client.query(
            "UPDATE strategic_members SET name=$3 WHERE room_id=$1 AND id=$2",
            [this.id, cmd.memberId, name],
          );
        }
        if (cmd.units !== undefined) {
          const owned = new Set(deployable(cmd.memberId));
          if (cmd.units.some((unit) => !owned.has(unit)))
            return deny(
              "invalid_order",
              "That unit does not belong to this commander's deployment.",
            );
          await client.query(
            "UPDATE strategic_members SET control_units=$3::jsonb WHERE room_id=$1 AND id=$2",
            [this.id, cmd.memberId, json(cmd.units)],
          );
          await client.query(
            "DELETE FROM strategic_control WHERE room_id=$1 AND member_id=$2",
            [this.id, cmd.memberId],
          );
          if (cmd.units.length)
            await client.query(
              `INSERT INTO strategic_control(room_id,member_id,unit_id)
              SELECT $1,$2,unit FROM unnest($3::text[]) unit`,
              [this.id, cmd.memberId, cmd.units],
            );
          // An accepted order for a unit the commander just lost would otherwise resolve silently.
          if (room.phase === "orders") {
            await client.query(
              "DELETE FROM strategic_orders WHERE room_id=$1 AND turn_id=$2 AND member_id=$3 AND NOT (unit_id = ANY($4::text[]))",
              [this.id, room.turnId, cmd.memberId, cmd.units],
            );
            const revision =
              (
                await client.query<{ revision: number }>(
                  "SELECT revision FROM strategic_revisions WHERE room_id=$1 AND turn_id=$2 AND member_id=$3",
                  [this.id, room.turnId, cmd.memberId],
                )
              ).rows[0]?.revision ?? 0;
            await client.query(
              `INSERT INTO strategic_revisions VALUES($1,$2,$3,$4)
              ON CONFLICT (room_id,turn_id,member_id) DO UPDATE SET revision=EXCLUDED.revision`,
              [this.id, room.turnId, cmd.memberId, revision + 1],
            );
          }
        }
        return finish({
          receipt: ok(room.turnId),
          // Only an actual allowlist change needs the live view refreshed.
          ...(cmd.units === undefined
            ? {}
            : {
                control: { memberId: cmd.memberId, units: cmd.units },
              }),
          room: await this.setMembers(client),
        });
      }
      if (cmd.kind === "member.revoke") {
        const revoked = await client.query(
          `UPDATE strategic_members SET active=false,epoch=epoch+1,invite_hash=NULL,invite_cipher=NULL,
            invite_expires=NULL,control_units=NULL
          WHERE room_id=$1 AND id=$2 AND role='PLAYER' AND active`,
          [this.id, cmd.memberId],
        );
        if (!revoked.rowCount)
          return deny("forbidden", "No active commander with that slot ID.");
        await client.query(
          "DELETE FROM strategic_control WHERE room_id=$1 AND member_id=$2",
          [this.id, cmd.memberId],
        );
        if (room.phase === "orders")
          await client.query(
            "DELETE FROM strategic_orders WHERE room_id=$1 AND turn_id=$2 AND member_id=$3",
            [this.id, room.turnId, cmd.memberId],
          );
        return finish({
          receipt: ok(room.turnId),
          revoked: cmd.memberId,
          control: { memberId: cmd.memberId, units: null },
          room: await this.setMembers(client),
        });
      }
      if (cmd.kind === "member.kick") {
        const target = (
          await client.query<{ role: string }>(
            "SELECT role FROM strategic_members WHERE room_id=$1 AND id=$2 AND active",
            [this.id, cmd.memberId],
          )
        ).rows[0];
        if (!target || target.role !== "PLAYER")
          return deny("forbidden", "No active commander with that slot ID.");
        // The seat and its key stay intact; the live session is dropped by the edge.
        return finish({
          receipt: ok(room.turnId),
          kicked: cmd.memberId,
          room: await this.setMembers(client),
        });
      }
      if (cmd.kind === "member.invite") {
        const target = (
          await client.query<{ role: string; publicKey: string | null }>(
            `SELECT role, public_key AS "publicKey" FROM strategic_members
            WHERE room_id=$1 AND id=$2 AND active FOR UPDATE`,
            [this.id, cmd.memberId],
          )
        ).rows[0];
        if (!target || target.role !== "PLAYER")
          return deny("forbidden", "No active commander with that slot ID.");
        // A bound browser keeps its seat. Re-issuing there would be a takeover, not an invite.
        if (target.publicKey)
          return deny(
            "forbidden",
            "This commander is already claimed. Kick or revoke the seat before inviting a new browser.",
          );
        const projectionKey = await this.projectionKey(client);
        const cipher = sealInvite(
          projectionKey,
          this.id,
          cmd.memberId,
          cmd.invite,
        );
        await client.query(
          `UPDATE strategic_members SET invite_hash=$3, invite_cipher=$4,
            invite_expires=now() + interval '30 minutes' WHERE room_id=$1 AND id=$2`,
          [this.id, cmd.memberId, digest(cmd.invite), cipher],
        );
        return finish({
          receipt: ok(room.turnId),
          invites: { [cmd.memberId]: cmd.invite },
          room: await this.setMembers(client),
        });
      }
      if (cmd.turnId !== room.turnId)
        return deny("turn_closed", "That turn is no longer current.");
      if (cmd.kind === "turn.close" && room.phase === "orders") {
        return finish({
          receipt: ok(room.turnId),
          room: await this.freeze(client, room, seed),
        });
      }
      if (cmd.kind === "turn.retry" && room.phase === "paused") {
        return finish({
          receipt: ok(room.turnId),
          room: await this.setPhase(client, "resolution"),
        });
      }
      if (cmd.kind === "turn.next" && room.phase === "report") {
        const deadline =
          cmd.durationMs === null ? null : Date.now() + cmd.durationMs;
        const { rows } = await client.query<RoomRow>(
          `UPDATE strategic_rooms SET turn_id=turn_id+1,phase='orders',deadline_ms=$2 WHERE id=$1
          RETURNING ${columns}`,
          [this.id, deadline],
        );
        const next = rows[0];
        if (!next) throw new StaleAuthority("Room missing.");
        return finish({ receipt: ok(next.turnId), room: roomRecord(next) });
      }
      return deny("wrong_phase", "Command is not available in this phase.");
    });
  }

  /** A membership change is not a publication; it only tells clients to refetch their own view. */
  private async setMembers(client: PoolClient): Promise<RoomRecord> {
    const { rows } = await client.query<RoomRow>(
      `UPDATE strategic_rooms SET members_version=members_version+1 WHERE id=$1 RETURNING ${columns}`,
      [this.id],
    );
    const row = rows[0];
    if (!row) throw new StaleAuthority("Room missing.");
    return roomRecord(row);
  }

  private async freeze(
    client: PoolClient,
    room: RoomRecord,
    seed: number,
  ): Promise<RoomRecord> {
    // Start state and scenario are immutable references. Everything mutable the resolver reads is copied here.
    await client.query(
      `INSERT INTO strategic_frozen(room_id,turn_id,start_version,rules_pin,seed,orders,revisions)
      VALUES($1,$2,$3,$4,$5,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',unit_id,'memberId',member_id,'order',payload) ORDER BY unit_id COLLATE "C"),'[]')
          FROM strategic_orders WHERE room_id=$1 AND turn_id=$2),
        (SELECT coalesce(jsonb_object_agg(member_id,revision),'{}') FROM strategic_revisions WHERE room_id=$1 AND turn_id=$2))`,
      [
        this.id,
        room.turnId,
        room.version,
        this.pin,
        turnSeed(seed, room.turnId),
      ],
    );
    return this.setPhase(client, "resolution");
  }

  async closeDeadline(
    turnId: number,
    now: number,
    seed: number,
  ): Promise<RoomRecord | null> {
    const generation = this.generation;
    return this.tx(async (client) => {
      const room = await this.locked(client, generation);
      return room.turnId === turnId &&
        room.phase === "orders" &&
        room.deadlineMs !== null &&
        now >= room.deadlineMs
        ? this.freeze(client, room, seed)
        : null;
    });
  }

  private async setPhase(
    client: PoolClient,
    phase: RoomRecord["phase"],
  ): Promise<RoomRecord> {
    const { rows } = await client.query<RoomRow>(
      `UPDATE strategic_rooms SET phase=$2,deadline_ms=NULL WHERE id=$1 RETURNING ${columns}`,
      [this.id, phase],
    );
    const row = rows[0];
    if (!row) throw new StaleAuthority("Room missing.");
    return roomRecord(row);
  }

  async frozen(turnId: number, scenario: Scenario): Promise<Frozen> {
    const { rows } = await this.pool.query<{
      start: number;
      seed: string;
      orders: FrozenOrder[];
    }>(
      `SELECT start_version AS start,seed,orders FROM strategic_frozen
      WHERE room_id=$1 AND turn_id=$2 AND rules_pin=$3`,
      [this.id, turnId, this.pin],
    );
    const row = rows[0];
    if (!row) throw new Error("Frozen job missing or incompatible.");
    return {
      turnId,
      seed: Number(row.seed),
      orders: row.orders,
      start: await this.version(row.start),
      scenario,
    };
  }

  private async insertVersion(
    client: PoolClient,
    state: Published,
    report: Uint8Array | null,
    control: Control,
  ) {
    // A publication snapshot lists only restricted seats; `null` is a live-view reset marker.
    const snapshot: Control = Object.fromEntries(
      Object.entries(control).filter(
        (entry): entry is [string, string[]] => entry[1] !== null,
      ),
    );
    await client.query(
      `INSERT INTO strategic_versions
        (room_id,version,checkpoint,hp_max,pool_hash,units,raw_report,control,hazards,actions)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        this.id,
        state.version,
        Buffer.from(
          state.bytes.buffer,
          state.bytes.byteOffset,
          state.bytes.byteLength,
        ),
        state.maxHpMax,
        state.hash,
        json(state.units),
        report ? Buffer.from(report) : null,
        json(snapshot),
        json(state.hazards ?? []),
        json(state.actions ?? []),
      ],
    );
  }

  async publish(
    turnId: number,
    generation: number,
    result: Result,
    control?: Control,
  ): Promise<RoomRecord> {
    return this.tx(async (client) => {
      const room = await this.locked(client, generation);
      if (
        room.phase !== "resolution" ||
        room.turnId !== turnId ||
        room.version + 1 !== result.state.version
      )
        throw new StaleAuthority("Turn publication was superseded.");
      const snapshot = control ?? (await this.currentControl(client));
      await this.insertVersion(client, result.state, result.report, snapshot);
      await client.query(
        `INSERT INTO strategic_report_rows(room_id,version,member_id,unit_id,row)
        SELECT $1,$2,x->>'memberId',x->>'unitId',x - 'memberId' FROM jsonb_array_elements($3::jsonb) x`,
        [this.id, result.state.version, json(result.rows)],
      );
      const { rows } = await client.query<RoomRow>(
        `UPDATE strategic_rooms SET version=$2,phase='report' WHERE id=$1 RETURNING ${columns}`,
        [this.id, result.state.version],
      );
      const row = rows[0];
      if (!row) throw new StaleAuthority("Room missing.");
      return roomRecord(row);
    });
  }

  async pause(turnId: number, generation: number): Promise<RoomRecord | null> {
    return this.tx(async (client) => {
      const room = await this.locked(client, generation);
      return room.phase === "resolution" && room.turnId === turnId
        ? this.setPhase(client, "paused")
        : null;
    });
  }

  async version(version: number): Promise<Published> {
    const { rows } = await this.pool.query<Published>(
      `SELECT ${publishedColumns} FROM strategic_versions WHERE room_id=$1 AND version=$2`,
      [this.id, version],
    );
    const row = rows[0];
    if (!row) throw new Error("Committed checkpoint missing.");
    return row;
  }

  async privateState(
    member: Member,
  ): Promise<{ room: RoomRecord; orders: OwnOrders } | null> {
    const { rows } = await this.pool.query<
      RoomRow & { revision: number; edits: UnitEdit[] }
    >(
      `SELECT ${columns},
      coalesce((SELECT revision FROM strategic_revisions WHERE room_id=r.id AND turn_id=r.turn_id AND member_id=$2), 0) AS revision,
      coalesce((SELECT jsonb_agg(jsonb_build_object('unitId',unit_id,'order',payload) ORDER BY unit_id COLLATE "C") FROM strategic_orders
        WHERE room_id=r.id AND turn_id=r.turn_id AND member_id=$2), '[]') AS edits
      FROM strategic_rooms r WHERE r.id=$1 AND r.generation=$4
      AND EXISTS (SELECT 1 FROM strategic_members m WHERE m.room_id=r.id AND m.id=$2 AND m.epoch=$3 AND m.active)`,
      [this.id, member.id, member.epoch, this.generation],
    );
    const row = rows[0];
    return row
      ? {
          room: roomRecord(row),
          orders: { revision: row.revision, edits: row.edits },
        }
      : null;
  }

  async report(
    member: Member,
    version: number,
    page: number,
  ): Promise<ReportRow[]> {
    const { rows } = await this.pool.query<{ row: ReportRow }>(
      `SELECT p.row FROM strategic_report_rows p
      JOIN strategic_members m ON m.room_id=p.room_id AND m.id=$2 AND m.epoch=$5 AND m.active
      JOIN strategic_rooms r ON r.id=p.room_id AND r.generation=$6 AND p.version <= r.version
      WHERE p.room_id=$1 AND p.version=$3 AND (m.role='GM' OR p.member_id=m.id)
      ORDER BY p.unit_id OFFSET $4 LIMIT ${PAGE_ROWS + 1}`,
      [
        this.id,
        member.id,
        version,
        page * PAGE_ROWS,
        member.epoch,
        this.generation,
      ],
    );
    return rows.map((r) => r.row);
  }

  async exportLatest(): Promise<{
    state: Published;
    report: Uint8Array | null;
    scenario: Scenario;
    pin: string;
  }> {
    const { rows } = await this.pool.query<
      Published & { report: Buffer | null; scenario: Scenario; pin: string }
    >(
      `SELECT v.version,v.checkpoint AS bytes,v.hp_max AS "maxHpMax",v.pool_hash AS hash,v.units,v.hazards,v.actions,v.control,v.raw_report AS report,r.scenario,r.rules_pin AS pin
       FROM strategic_rooms r JOIN strategic_versions v ON v.room_id=r.id AND v.version=r.version WHERE r.id=$1`,
      [this.id],
    );
    const row = rows[0];
    if (!row) throw new Error("No committed checkpoint.");
    const { report, scenario, pin, ...state } = row;
    return {
      state: { ...state, units: state.units as UnitState[] },
      report,
      scenario,
      pin,
    };
  }
}
