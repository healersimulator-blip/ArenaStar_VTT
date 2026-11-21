import { randomBytes, randomInt } from "node:crypto";
import { digest, openInvite, sealInvite } from "./invite";
import schema from "../schema.sql?raw";
import pg, { type PoolClient } from "pg";
import {
  PAGE_ROWS,
  reject,
  type Command,
  type HostedChatEntry,
  type OwnOrders,
  type Receipt,
  type ReportRow,
  type RoomOrder,
  type UnitEdit,
} from "../../../src/core/strategicRoom/protocol";
import { turnSeed } from "../../../src/host/turnEngine";
import { MAX_UNITS_PER_COMMANDER, parseScenario, scenarioProjectionDigest, type Scenario, type UnitState } from "./scenario";
import type {
  Control,
  Frozen,
  FrozenOrder,
  LiveRoomState,
  Member,
  MemberRecord,
  Published,
  Result,
  RoomRecord,
} from "./state";

const columns = `turn_id AS "turnId", version, phase, deadline_ms AS "deadlineMs", generation, members_version AS "members"`;
const memberColumns = `id, coalesce(name,id) AS "name", role, faction_id AS "factionId", epoch`;
const publishedColumns =
  'version, checkpoint AS bytes, hp_max AS "maxHpMax", pool_hash AS hash, units, hazards, actions, control, extras';
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
function evaluateHostRollFormula(
  formula: string,
): { formula: string; total: number; breakdown: string; provenance: "host" } | null {
  const m = /^\s*(\d{1,2})d(\d{1,3})\s*(?:([+-])\s*(\d{1,3}))?\s*$/i.exec(formula);
  if (!m) return null;
  const count = Number(m[1]);
  const sides = Number(m[2]);
  if (count < 1 || count > 20 || sides < 2 || sides > 100) return null;
  const sign = m[3] === "-" ? -1 : 1;
  const mod = m[4] ? sign * Number(m[4]) : 0;
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const r = randomInt(1, sides + 1);
    rolls.push(r);
    sum += r;
  }
  const total = sum + mod;
  const modLabel = mod === 0 ? "" : mod > 0 ? ` + ${mod}` : ` - ${Math.abs(mod)}`;
  return {
    formula: `${count}d${sides}${mod === 0 ? "" : mod > 0 ? `+${mod}` : `${mod}`}`,
    total,
    breakdown: `[${rolls.join(", ")}]${modLabel} = ${total}`,
    provenance: "host",
  };
}

export class StaleAuthority extends Error {}
export type CommittedCommand = {
  receipt: Receipt;
  room?: RoomRecord;
  revoked?: string;
  /** A durable allowlist edit, or `null` when the seat returns to its deployment. */
  control?: { memberId: string; units: string[] | null };
  /** Multi-seat durable allowlist updates applied atomically by `roster.assign`. */
  controls?: Control;
  /** Accepted one-time invite codes, returned only to the GM's private receipt. */
  invites?: Record<string, string>;
  /** A live session the edge must drop, without revoking the seat. */
  kicked?: string;
  /** Durable authored allegiance change; authority rebuilds every projected cohort. */
  scenario?: Scenario;
  /** Updated live interactive VTT state (doors, lights, templates, playlist, chat). */
  live?: LiveRoomState;
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
        RoomRow & { scenario: Scenario; key: Buffer; liveState: LiveRoomState | null }
      >(
        `UPDATE strategic_rooms SET generation=generation+1 WHERE id=$1 AND rules_pin=$2 RETURNING ${columns}, scenario, projection_key AS key, live_state AS "liveState"`,
        [this.id, this.pin],
      );
      const row = rows[0];
      if (!row)
        throw new Error(
          "Room not found or resolver build differs from the pinned build.",
        );
      if (this.lease !== lease) throw new StaleAuthority("Room lease lost.");
      this.ownedGeneration = row.generation;
      return {
        room: roomRecord(row),
        scenario: row.scenario,
        key: row.key,
        live: row.liveState ?? {},
      };
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
    const claimedBySeat = new Map<string, Set<string>>();
    for (const row of rows) {
      if (row.role === "PLAYER" && row.controlUnits) {
        claimedBySeat.set(row.id, new Set(row.controlUnits));
      }
    }
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
      const initialDeployed = row.deployed ?? [];
      const activeUnits = row.controlUnits ?? initialDeployed;
      const claimedElsewhere = new Set<string>();
      for (const [seatId, set] of claimedBySeat) {
        if (seatId !== row.id) for (const uid of set) claimedElsewhere.add(uid);
      }
      const deployed = row.controlUnits
        ? [
            ...new Set([
              ...initialDeployed.filter((uid) => !claimedElsewhere.has(uid)),
              ...activeUnits,
            ]),
          ]
        : initialDeployed;
      return {
        id: row.id,
        name: row.name,
        role: row.role,
        factionId: row.factionId,
        // SQL NULL is unrestricted; an empty JSON array is an explicit no-unit allowlist.
        units: activeUnits,
        deployed,
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
    validateDoor?: (wallId: string, door: 0 | 1 | 2) => string | null,
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
      if (
        cmd.kind === "scene.door" ||
        cmd.kind === "scene.light" ||
        cmd.kind === "scene.template" ||
        cmd.kind === "scene.playlist" ||
        cmd.kind === "chat.send" ||
        cmd.kind === "table.roll" ||
        cmd.kind === "macro.exec"
      ) {
        if (
          (cmd.kind === "scene.light" ||
            cmd.kind === "scene.template" ||
            cmd.kind === "scene.playlist") &&
          member.role !== "GM"
        ) {
          return deny("forbidden", "Only the GM may use this scene control.");
        }
        const stateRow = (
          await client.query<{ scenario: Scenario; liveState: LiveRoomState | null }>(
            `SELECT scenario, live_state AS "liveState" FROM strategic_rooms WHERE id=$1 FOR UPDATE`,
            [this.id],
          )
        ).rows[0];
        if (!stateRow) throw new StaleAuthority("Room missing.");
        const live: LiveRoomState = {
          ...(stateRow.liveState ?? {}),
          ...(stateRow.liveState?.doors ? { doors: { ...stateRow.liveState.doors } } : {}),
          ...(stateRow.liveState?.lightHidden
            ? { lightHidden: { ...stateRow.liveState.lightHidden } }
            : {}),
          ...(stateRow.liveState?.templates
            ? { templates: [...stateRow.liveState.templates] }
            : {}),
          ...(stateRow.liveState?.chat ? { chat: [...stateRow.liveState.chat] } : {}),
        };
        const appendChat = (entry: HostedChatEntry) => {
          const list = [...(live.chat ?? []), entry];
          live.chat = list.slice(Math.max(0, list.length - 80));
        };

        if (cmd.kind === "scene.door") {
          const reason = validateDoor
            ? validateDoor(cmd.wallId, cmd.door)
            : member.role === "GM"
              ? null
              : "Door control unavailable.";
          if (reason) return deny("forbidden", reason);
          const doors = live.doors ?? (live.doors = {});
          doors[cmd.wallId] = cmd.door;
        } else if (cmd.kind === "scene.light") {
          if (cmd.darkness !== undefined) live.darkness = cmd.darkness;
          if (cmd.lightId !== undefined && cmd.hidden !== undefined) {
            const exists = (stateRow.scenario.lighting?.lights ?? []).some(
              (l) => l.id === cmd.lightId,
            );
            if (!exists) return deny("invalid_order", "Unknown ambient light.");
            const lightHidden = live.lightHidden ?? (live.lightHidden = {});
            lightHidden[cmd.lightId] = cmd.hidden;
          }
        } else if (cmd.kind === "scene.template") {
          const base = live.templates ?? [...(stateRow.scenario.templates ?? [])];
          if (cmd.op === "delete") {
            live.templates = base.filter((t) => t.id !== cmd.templateId);
          } else if (cmd.template) {
            const tpl = cmd.template;
            const filtered = base.filter((t) => t.id !== tpl.id);
            if (filtered.length >= 32) {
              return deny("invalid_order", "At most 32 measured templates may be active.");
            }
            live.templates = [...filtered, tpl];
          }
        } else if (cmd.kind === "scene.playlist") {
          if (cmd.trackId !== null) {
            const validTrack = (stateRow.scenario.content?.playlists ?? []).some((p) =>
              p.tracks.some((t) => t.id === cmd.trackId),
            );
            if (!validTrack) return deny("invalid_order", "Unknown playlist track.");
          }
          live.activeTrackId = cmd.trackId;
        } else if (cmd.kind === "chat.send") {
          const scope = cmd.scope ?? "public";
          if (scope === "gm" && member.role !== "GM") {
            return deny("forbidden", "Only the GM may post GM-only notes.");
          }
          let roll: HostedChatEntry["roll"];
          if (cmd.rollFormula) {
            const evaluated = evaluateHostRollFormula(cmd.rollFormula);
            if (!evaluated) {
              return deny("invalid_order", "Roll formula must use NdS or NdS+M (e.g. 1d20+6).");
            }
            roll = evaluated;
          }
          appendChat({
            id: `chat-${admittedAt}-${randomBytes(4).toString("hex")}`,
            senderId: member.id,
            senderName: member.name ?? member.id,
            factionId: member.factionId,
            scope,
            text: cmd.text,
            ...(roll ? { roll } : {}),
            createdAt: admittedAt,
          });
        } else if (cmd.kind === "table.roll") {
          const table = (stateRow.scenario.content?.rollTables ?? []).find(
            (t) => t.id === cmd.tableId,
          );
          if (!table) return deny("invalid_order", "Unknown roll table.");
          if (table.visibility === "gm" && member.role !== "GM") {
            return deny("forbidden", "That roll table is GM-only.");
          }
          const maxRoll = table.results.reduce(
            (acc, r) => Math.max(acc, r.range[1]),
            1,
          );
          const minRoll = table.results.reduce(
            (acc, r) => Math.min(acc, r.range[0]),
            maxRoll,
          );
          const pick = randomInt(minRoll, Math.max(minRoll + 1, maxRoll + 1));
          const matched = table.results.find(
            (r) => pick >= r.range[0] && pick <= r.range[1],
          );
          const chosen = matched?.text ?? table.results[0]?.text ?? "No result";
          appendChat({
            id: `table-${admittedAt}-${randomBytes(4).toString("hex")}`,
            senderId: member.id,
            senderName: member.name ?? member.id,
            factionId: member.factionId,
            scope: table.visibility === "gm" ? "gm" : "public",
            text: `${table.name}: ${chosen}`,
            roll: {
              formula: table.formula,
              total: pick,
              breakdown: `[${pick}] -> ${chosen}`,
              provenance: "host",
            },
            createdAt: admittedAt,
          });
        } else if (cmd.kind === "macro.exec") {
          const macro = (stateRow.scenario.content?.macros ?? []).find(
            (m) => m.id === cmd.macroId,
          );
          if (!macro) return deny("invalid_order", "Unknown macro.");
          if (!macro.executable || macro.disabledReason || !macro.action) {
            return deny(
              "invalid_order",
              macro.disabledReason ??
                "Arbitrary script macros are disabled in hosted strategic rooms.",
            );
          }
          if (macro.action.kind === "chat") {
            let roll: HostedChatEntry["roll"];
            if (macro.action.rollFormula) {
              const evaluated = evaluateHostRollFormula(macro.action.rollFormula);
              if (!evaluated) return deny("invalid_order", "Macro roll formula is invalid.");
              roll = evaluated;
            }
            appendChat({
              id: `macro-${admittedAt}-${randomBytes(4).toString("hex")}`,
              senderId: member.id,
              senderName: member.name ?? member.id,
              factionId: member.factionId,
              scope: "public",
              text: `${macro.name}: ${macro.action.text}`,
              ...(roll ? { roll } : {}),
              createdAt: admittedAt,
            });
          } else if (macro.action.kind === "order") {
            if (room.phase !== "orders") {
              return deny("turn_closed", "Order macros can only run while orders are open.");
            }
            if (!cmd.unitId) {
              return deny("invalid_order", "Select a controlled unit before running an order macro.");
            }
            const macroOrder: RoomOrder =
              macro.action.orderKind === "reform"
                ? { kind: "reform" }
                : {
                    kind: "hold",
                    stance: macro.action.orderKind === "defend" ? "defend" : "hold",
                  };
            const reason = validate({ unitId: cmd.unitId, order: macroOrder });
            if (reason) return deny("invalid_order", reason);
            const revisionKey = [this.id, room.turnId, member.id];
            const prevRev =
              (
                await client.query<{ revision: number }>(
                  "SELECT revision FROM strategic_revisions WHERE room_id=$1 AND turn_id=$2 AND member_id=$3",
                  revisionKey,
                )
              ).rows[0]?.revision ?? 0;
            const nextRev = prevRev + 1;
            await client.query(
              "DELETE FROM strategic_orders WHERE room_id=$1 AND turn_id=$2 AND member_id=$3 AND unit_id=$4",
              [...revisionKey, cmd.unitId],
            );
            await client.query(
              "INSERT INTO strategic_orders(room_id,turn_id,member_id,unit_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)",
              [...revisionKey, cmd.unitId, json(macroOrder)],
            );
            await client.query(
              `INSERT INTO strategic_revisions VALUES($1,$2,$3,$4)
               ON CONFLICT (room_id,turn_id,member_id) DO UPDATE SET revision=EXCLUDED.revision`,
              [...revisionKey, nextRev],
            );
            await client.query("UPDATE strategic_rooms SET live_state=$2::jsonb WHERE id=$1", [
              this.id,
              json(live),
            ]);
            return finish({
              receipt: ok(room.turnId, nextRev),
              live,
              room: await this.setMembers(client),
            });
          }
        }
        await client.query("UPDATE strategic_rooms SET live_state=$2::jsonb WHERE id=$1", [
          this.id,
          json(live),
        ]);
        return finish({
          receipt: ok(room.turnId),
          live,
          room: await this.setMembers(client),
        });
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
        if (!found) return deny("invalid_order", "Unknown battlefield unit.");
        const { projection, ...withoutProjection } = candidate;
        const canonical = parseScenario(withoutProjection);
        const next = projection
          ? parseScenario({
              ...canonical,
              projection: {
                ...projection,
                digest: scenarioProjectionDigest(canonical),
              },
            })
          : canonical;
        await client.query("UPDATE strategic_rooms SET scenario=$2::jsonb WHERE id=$1", [this.id, json(next)]);
        // Existing orders were validated against the former friend/enemy graph. Clear them
        // rather than allowing an attack on a new ally to resolve silently.
        await client.query("DELETE FROM strategic_orders WHERE room_id=$1 AND turn_id=$2", [this.id, room.turnId]);
        await client.query("UPDATE strategic_revisions SET revision=revision+1 WHERE room_id=$1 AND turn_id=$2", [this.id, room.turnId]);
        return finish({ receipt: ok(room.turnId), scenario: next, room: await this.setMembers(client) });
      }
      if (cmd.kind === "roster.assign") {
        if (room.phase !== "orders")
          return deny("wrong_phase", "Team and unit assignments can only change while orders are open.");
        const row = (
          await client.query<{ scenario: Scenario }>(
            "SELECT scenario FROM strategic_rooms WHERE id=$1 FOR UPDATE",
            [this.id],
          )
        ).rows[0];
        if (!row) throw new StaleAuthority("Room missing.");
        const factionIds = new Set(row.scenario.factions.map((f) => f.id));
        const allUnits = new Map<string, string>();
        const initialBySeat = new Map<string, string[]>();
        for (const c of row.scenario.commanders) {
          initialBySeat.set(c.id, c.units.map((u) => u.id));
          for (const u of c.units) allUnits.set(u.id, u.factionId ?? c.factionId);
        }
        const memberRows = (
          await client.query<{
            id: string;
            factionId: string | null;
            controlUnits: string[] | null;
          }>(
            `SELECT id, faction_id AS "factionId", control_units AS "controlUnits"
             FROM strategic_members WHERE room_id=$1 AND role='PLAYER' AND active FOR UPDATE`,
            [this.id],
          )
        ).rows;
        const activeById = new Map(memberRows.map((m) => [m.id, m]));
        for (const a of cmd.assignments) {
          if (!activeById.has(a.memberId))
            return deny("forbidden", `No active commander with slot ID ${a.memberId}.`);
          if (a.factionId !== undefined && !factionIds.has(a.factionId))
            return deny("invalid_order", "Unknown battlefield faction.");
          if (a.units !== undefined) {
            if (a.units.length > MAX_UNITS_PER_COMMANDER)
              return deny("invalid_order", `A commander may control at most ${MAX_UNITS_PER_COMMANDER} units.`);
            for (const uid of a.units) {
              if (!allUnits.has(uid))
                return deny("invalid_order", `Unknown battlefield unit ${uid}.`);
            }
          }
        }
        const commanderBySeat = new Map(row.scenario.commanders.map((c) => [c.id, c]));
        const nextFaction = new Map<string, string>();
        const effectiveUnits = new Map<string, string[]>();
        const touchedControl = new Set<string>();
        for (const m of memberRows) {
          const fallbackFaction =
            m.factionId ??
            commanderBySeat.get(m.id)?.factionId ??
            row.scenario.factions[0]?.id ??
            "";
          nextFaction.set(m.id, fallbackFaction);
          effectiveUnits.set(m.id, [...(m.controlUnits ?? initialBySeat.get(m.id) ?? [])]);
        }
        const claimed = new Map<string, string>();
        for (const a of cmd.assignments) {
          if (a.units !== undefined) {
            for (const uid of a.units) claimed.set(uid, a.memberId);
          }
        }
        if (claimed.size > 0) {
          for (const [seatId, list] of effectiveUnits) {
            const filtered = list.filter((uid) => {
              const owner = claimed.get(uid);
              return owner === undefined || owner === seatId;
            });
            if (filtered.length !== list.length) {
              effectiveUnits.set(seatId, filtered);
              touchedControl.add(seatId);
            }
          }
        }
        const touchedFaction = new Set<string>();
        for (const a of cmd.assignments) {
          if (a.factionId !== undefined && a.factionId !== nextFaction.get(a.memberId)) {
            nextFaction.set(a.memberId, a.factionId);
            touchedFaction.add(a.memberId);
          }
          if (a.units !== undefined) {
            effectiveUnits.set(a.memberId, [...a.units]);
            touchedControl.add(a.memberId);
          }
        }
        const nextUnitFaction = new Map(allUnits);
        for (const seatId of new Set([...touchedFaction, ...touchedControl])) {
          const fid = nextFaction.get(seatId);
          if (!fid) continue;
          for (const uid of effectiveUnits.get(seatId) ?? []) {
            nextUnitFaction.set(uid, fid);
          }
        }
        if (new Set(nextUnitFaction.values()).size !== 2) {
          return deny(
            "invalid_order",
            "Both factions must retain at least one unit on the battlefield.",
          );
        }
        const candidate: Scenario = {
          ...row.scenario,
          commanders: row.scenario.commanders.map((commander) => ({
            ...commander,
            units: commander.units.map((unit) => {
              const fid = nextUnitFaction.get(unit.id) ?? unit.factionId ?? commander.factionId;
              return { ...unit, factionId: fid };
            }),
          })),
        };
        const { projection, ...withoutProjection } = candidate;
        const canonical = parseScenario(withoutProjection);
        const next = projection
          ? parseScenario({
              ...canonical,
              projection: {
                ...projection,
                digest: scenarioProjectionDigest(canonical),
              },
            })
          : canonical;
        await client.query(
          "UPDATE strategic_rooms SET scenario=$2::jsonb WHERE id=$1",
          [this.id, json(next)],
        );
        if (touchedFaction.size > 0) {
          const seatIds = [...touchedFaction];
          const factionVals = seatIds.map((seatId) => nextFaction.get(seatId) ?? "");
          await client.query(
            `UPDATE strategic_members AS m SET faction_id=u.fid
             FROM unnest($2::text[], $3::text[]) AS u(id, fid)
             WHERE m.room_id=$1 AND m.id=u.id`,
            [this.id, seatIds, factionVals],
          );
        }
        const controls: Control = {};
        if (touchedControl.size > 0) {
          const seatIds = [...touchedControl];
          const unitJsonVals: string[] = [];
          const pairSeats: string[] = [];
          const pairUnits: string[] = [];
          for (const seatId of seatIds) {
            const units = effectiveUnits.get(seatId) ?? [];
            controls[seatId] = units;
            unitJsonVals.push(json(units));
            for (const uid of units) {
              pairSeats.push(seatId);
              pairUnits.push(uid);
            }
          }
          await client.query(
            `UPDATE strategic_members AS m SET control_units=u.units::jsonb
             FROM unnest($2::text[], $3::text[]) AS u(id, units)
             WHERE m.room_id=$1 AND m.id=u.id`,
            [this.id, seatIds, unitJsonVals],
          );
          await client.query(
            "DELETE FROM strategic_control WHERE room_id=$1 AND member_id=ANY($2::text[])",
            [this.id, seatIds],
          );
          if (pairSeats.length > 0) {
            await client.query(
              `INSERT INTO strategic_control(room_id,member_id,unit_id)
               SELECT $1, m_id, u_id FROM unnest($2::text[], $3::text[]) AS p(m_id, u_id)`,
              [this.id, pairSeats, pairUnits],
            );
          }
        }
        await client.query(
          "DELETE FROM strategic_orders WHERE room_id=$1 AND turn_id=$2",
          [this.id, room.turnId],
        );
        await client.query(
          "UPDATE strategic_revisions SET revision=revision+1 WHERE room_id=$1 AND turn_id=$2",
          [this.id, room.turnId],
        );
        return finish({
          receipt: ok(room.turnId),
          scenario: next,
          ...(Object.keys(controls).length ? { controls } : {}),
          room: await this.setMembers(client),
        });
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
    // Start state, control and scenario are immutable per turn: copy scenario and control at freeze
    // time so later `unit.faction`, `member.update` or `roster.assign` mutations never rewrite past turns.
    const rawControl = await this.currentControl(client);
    const controlSnapshot: Control = Object.fromEntries(
      Object.entries(rawControl).filter(
        (entry): entry is [string, string[]] => entry[1] !== null,
      ),
    );
    await client.query(
      `INSERT INTO strategic_frozen(room_id,turn_id,start_version,rules_pin,seed,orders,revisions,scenario,control,extras)
      VALUES($1,$2,$3,$4,$5,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',unit_id,'memberId',member_id,'order',payload) ORDER BY unit_id COLLATE "C"),'[]')
          FROM strategic_orders WHERE room_id=$1 AND turn_id=$2),
        (SELECT coalesce(jsonb_object_agg(member_id,revision),'{}') FROM strategic_revisions WHERE room_id=$1 AND turn_id=$2),
        (SELECT scenario FROM strategic_rooms WHERE id=$1),
        $6::jsonb,
        (SELECT live_state FROM strategic_rooms WHERE id=$1))`,
      [
        this.id,
        room.turnId,
        room.version,
        this.pin,
        turnSeed(seed, room.turnId),
        json(controlSnapshot),
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
      scenario: unknown;
      control: Control | null;
      extras: LiveRoomState | null;
    }>(
      `SELECT start_version AS start,seed,orders,scenario,control,extras FROM strategic_frozen
      WHERE room_id=$1 AND turn_id=$2 AND rules_pin=$3`,
      [this.id, turnId, this.pin],
    );
    const row = rows[0];
    if (!row) throw new Error("Frozen job missing or incompatible.");
    const startState = await this.version(row.start);
    let frozenScenario = scenario;
    if (row.scenario && typeof row.scenario === "object") {
      const { projection, ...withoutProjection } = row.scenario as Scenario;
      const canonical = parseScenario(withoutProjection);
      frozenScenario = projection
        ? parseScenario({
            ...canonical,
            projection: {
              ...projection,
              digest: scenarioProjectionDigest(canonical),
            },
          })
        : canonical;
    }
    return {
      turnId,
      seed: Number(row.seed),
      orders: row.orders,
      start: row.control ? { ...startState, control: row.control } : startState,
      scenario: frozenScenario,
      ...(row.extras ? { live: row.extras } : {}),
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
        (room_id,version,checkpoint,hp_max,pool_hash,units,raw_report,control,hazards,actions,extras)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
        json(state.extras ?? {}),
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
  ): Promise<{ room: RoomRecord; orders: OwnOrders; factionId: string | null } | null> {
    const { rows } = await this.pool.query<
      RoomRow & { revision: number; edits: UnitEdit[]; factionId: string | null }
    >(
      `SELECT ${columns}, m.faction_id AS "factionId",
      coalesce((SELECT revision FROM strategic_revisions WHERE room_id=r.id AND turn_id=r.turn_id AND member_id=$2), 0) AS revision,
      coalesce((SELECT jsonb_agg(jsonb_build_object('unitId',unit_id,'order',payload) ORDER BY unit_id COLLATE "C") FROM strategic_orders
        WHERE room_id=r.id AND turn_id=r.turn_id AND member_id=$2), '[]') AS edits
      FROM strategic_rooms r
      JOIN strategic_members m ON m.room_id=r.id AND m.id=$2 AND m.epoch=$3 AND m.active
      WHERE r.id=$1 AND r.generation=$4`,
      [this.id, member.id, member.epoch, this.generation],
    );
    const row = rows[0];
    return row
      ? {
          room: roomRecord(row),
          orders: { revision: row.revision, edits: row.edits },
          factionId: row.factionId,
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
    live: LiveRoomState;
  }> {
    const { rows } = await this.pool.query<
      Published & {
        report: Buffer | null;
        scenario: Scenario;
        pin: string;
        liveState: LiveRoomState | null;
      }
    >(
      `SELECT v.version,v.checkpoint AS bytes,v.hp_max AS "maxHpMax",v.pool_hash AS hash,v.units,v.hazards,v.actions,v.control,v.extras,v.raw_report AS report,r.scenario,r.rules_pin AS pin,r.live_state AS "liveState"
       FROM strategic_rooms r JOIN strategic_versions v ON v.room_id=r.id AND v.version=r.version WHERE r.id=$1`,
      [this.id],
    );
    const row = rows[0];
    if (!row) throw new Error("No committed checkpoint.");
    const { report, scenario, pin, liveState, ...state } = row;
    return {
      state: { ...state, units: state.units as UnitState[] },
      report,
      scenario,
      pin,
      live: liveState ?? {},
    };
  }
}
