import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  PAGE_ROWS,
  reject,
  type Command,
  type OwnOrders,
  type Receipt,
  type ReportRow,
  type StrategicFxCoalescence,
  type UnitEdit,
} from "../src/core/strategicRoom/protocol";
import { turnSeed } from "../src/host/turnEngine";
import { parseScenario, type Scenario } from "../src/core/strategicRoom/scenario";
import { serve } from "../services/strategic-room/src/server";
import { deploy } from "../services/strategic-room/src/scenario";
import type { PostgresRoom } from "../services/strategic-room/src/postgres";
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
} from "../services/strategic-room/src/state";

/**
 * Lightweight in-memory adapter implementing the exact `PostgresRoom` contract consumed by
 * `StrategicAuthority` and `serve()` so full real-Chromium HTTP/WSS/Worker/Canvas/WebGL/WebAudio
 * hosted-room e2e benchmarks run identically in sandboxes without an external PostgreSQL daemon.
 */
class InMemoryStrategicRoomDb {
  readonly id: string;
  readonly pin: string;
  private ownedGeneration: number | null = null;
  private roomState: RoomRecord = {
    turnId: 1,
    version: 0,
    phase: "orders",
    deadlineMs: null,
    generation: 0,
    members: 0,
  };
  private scenarioData: Scenario;
  private projectionKeyBuf = randomBytes(32);
  private liveState: LiveRoomState = {};
  private versions = new Map<number, Published>();
  private reports = new Map<number, Array<ReportRow & { memberId: string }>>();
  private frozenTurns = new Map<
    number,
    {
      start: number;
      seed: number;
      orders: FrozenOrder[];
      scenario: Scenario;
      control: Control;
      live: LiveRoomState;
    }
  >();
  private membersMap = new Map<
    string,
    {
      id: string;
      name: string;
      role: "GM" | "PLAYER";
      factionId: string | null;
      epoch: number;
      active: boolean;
      publicKey: string | null;
      inviteCode: string | null;
      controlUnits: string[] | null;
    }
  >();
  private ordersByTurn = new Map<number, Map<string, Map<string, UnitEdit["order"]>>>();
  private revisionsByTurn = new Map<number, Map<string, number>>();
  private receipts = new Map<string, { digest: string; receipt: Receipt }>();

  constructor(roomId: string, scenario: Scenario, initial: Published) {
    this.id = roomId;
    this.pin = "in-memory-pin";
    this.scenarioData = scenario;
    this.versions.set(0, initial);
  }

  get generation(): number {
    if (this.ownedGeneration === null) throw new Error("Room lease not held.");
    return this.ownedGeneration;
  }

  seedMembers(): Record<string, string> {
    const invites: Record<string, string> = {};
    const all = [
      { id: "gm", name: "Game Master", role: "GM" as const, factionId: null },
      ...this.scenarioData.commanders.map((c) => ({
        id: c.id,
        name: c.name ?? c.id,
        role: "PLAYER" as const,
        factionId: c.factionId,
      })),
    ];
    for (const m of all) {
      const code = `inv-${m.id}-${randomBytes(8).toString("hex")}`;
      invites[m.id] = code;
      this.membersMap.set(m.id, {
        id: m.id,
        name: m.name,
        role: m.role,
        factionId: m.factionId,
        epoch: 1,
        active: true,
        publicKey: null,
        inviteCode: code,
        controlUnits: null,
      });
    }
    return invites;
  }

  setScenarioCoalescence(coalescence: StrategicFxCoalescence): void {
    const next: Scenario = { ...this.scenarioData };
    if (coalescence === "extreme") {
      delete next.fxCoalescence;
    } else {
      next.fxCoalescence = coalescence;
    }
    this.scenarioData = next;
  }

  async acquire(onLost: () => void) {
    void onLost;
    this.roomState = { ...this.roomState, generation: this.roomState.generation + 1 };
    this.ownedGeneration = this.roomState.generation;
    return {
      room: { ...this.roomState },
      scenario: this.scenarioData,
      key: this.projectionKeyBuf,
      live: { ...this.liveState },
    };
  }

  async dispose() {
    this.ownedGeneration = null;
  }

  async version(v: number): Promise<Published> {
    const found = this.versions.get(v);
    if (!found) throw new Error(`Missing version ${v}`);
    return found;
  }

  async liveControl(): Promise<Control> {
    const out: Control = {};
    for (const m of this.membersMap.values()) {
      if (m.role === "PLAYER") out[m.id] = m.controlUnits;
    }
    return out;
  }

  async roster(): Promise<MemberRecord[]> {
    const out: MemberRecord[] = [];
    for (const m of this.membersMap.values()) {
      if (!m.active) continue;
      const deployed =
        this.scenarioData.commanders
          .find((c) => c.id === m.id)
          ?.units.map((u) => u.id) ?? [];
      out.push({
        id: m.id,
        name: m.name,
        role: m.role,
        factionId: m.factionId,
        units: m.controlUnits ?? deployed,
        deployed,
        claimed: m.publicKey !== null,
        invite: m.inviteCode,
      });
    }
    return out;
  }

  async admit(publicKey: string, invite?: string): Promise<Member | null> {
    for (const m of this.membersMap.values()) {
      if (m.active && m.publicKey === publicKey) {
        return { id: m.id, name: m.name, role: m.role, factionId: m.factionId, epoch: m.epoch };
      }
    }
    if (!invite) return null;
    for (const m of this.membersMap.values()) {
      if (m.active && m.publicKey === null && m.inviteCode === invite) {
        m.publicKey = publicKey;
        m.inviteCode = null;
        return { id: m.id, name: m.name, role: m.role, factionId: m.factionId, epoch: m.epoch };
      }
    }
    return null;
  }

  async privateState(
    member: Member,
  ): Promise<{ room: RoomRecord; orders: OwnOrders; factionId: string | null } | null> {
    const m = this.membersMap.get(member.id);
    if (!m || !m.active || m.epoch !== member.epoch) return null;
    const rev = this.revisionsByTurn.get(this.roomState.turnId)?.get(member.id) ?? 0;
    const memberOrders = this.ordersByTurn.get(this.roomState.turnId)?.get(member.id);
    const edits: UnitEdit[] = memberOrders
      ? [...memberOrders.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([unitId, order]) => ({ unitId, order }))
      : [];
    return {
      room: { ...this.roomState },
      orders: { revision: rev, edits },
      factionId: m.factionId,
    };
  }

  private freezeTurn(seed: number): RoomRecord {
    const turnId = this.roomState.turnId;
    const turnOrders = this.ordersByTurn.get(turnId);
    const frozenOrders: FrozenOrder[] = [];
    if (turnOrders) {
      for (const [memberId, unitMap] of turnOrders.entries()) {
        for (const [unitId, order] of unitMap.entries()) {
          if (order !== null) {
            frozenOrders.push({ unitId, memberId, order });
          }
        }
      }
      frozenOrders.sort((a, b) => a.unitId.localeCompare(b.unitId));
    }
    const controlSnap: Control = {};
    for (const m of this.membersMap.values()) {
      if (m.active && m.role === "PLAYER" && m.controlUnits !== null) {
        controlSnap[m.id] = [...m.controlUnits];
      }
    }
    this.frozenTurns.set(turnId, {
      start: this.roomState.version,
      seed: turnSeed(seed, turnId),
      orders: frozenOrders,
      scenario: this.scenarioData,
      control: controlSnap,
      live: { ...this.liveState },
    });
    this.roomState = { ...this.roomState, phase: "resolution", deadlineMs: null };
    return { ...this.roomState };
  }

  async command(
    member: Member,
    cmd: Command,
    admittedAt: number,
    seed: number,
    validate: (edit: UnitEdit) => string | null,
  ) {
    void admittedAt;
    const m = this.membersMap.get(member.id);
    if (!m || !m.active || m.epoch !== member.epoch) {
      return { receipt: reject(cmd.requestId, "forbidden", "Not active.") };
    }
    const rKey = `${member.id}:${cmd.requestId}`;
    const reqHash = createHash("sha256").update(JSON.stringify(cmd)).digest("hex");
    const prevReceipt = this.receipts.get(rKey);
    if (prevReceipt) {
      return {
        receipt:
          prevReceipt.digest === reqHash
            ? prevReceipt.receipt
            : reject(cmd.requestId, "request_reused", "Reused request ID."),
      };
    }
    const save = (reply: { receipt: Receipt; room?: RoomRecord; live?: LiveRoomState }) => {
      this.receipts.set(rKey, { digest: reqHash, receipt: reply.receipt });
      return reply;
    };

    if (cmd.kind === "orders.submit") {
      if (this.roomState.phase !== "orders" || cmd.turnId !== this.roomState.turnId) {
        return save({ receipt: reject(cmd.requestId, "turn_closed", "Turn closed.") });
      }
      const revMap =
        this.revisionsByTurn.get(cmd.turnId) ??
        (() => {
          const map = new Map<string, number>();
          this.revisionsByTurn.set(cmd.turnId, map);
          return map;
        })();
      const curRev = revMap.get(member.id) ?? 0;
      if (cmd.expectedRevision !== curRev) {
        return save({ receipt: reject(cmd.requestId, "stale_revision", "Stale revision.") });
      }
      for (const edit of cmd.unitEdits) {
        const err = validate(edit);
        if (err) return save({ receipt: reject(cmd.requestId, "invalid_order", err) });
      }
      const turnMap =
        this.ordersByTurn.get(cmd.turnId) ??
        (() => {
          const map = new Map<string, Map<string, UnitEdit["order"]>>();
          this.ordersByTurn.set(cmd.turnId, map);
          return map;
        })();
      const unitMap =
        turnMap.get(member.id) ??
        (() => {
          const map = new Map<string, UnitEdit["order"]>();
          turnMap.set(member.id, map);
          return map;
        })();
      for (const edit of cmd.unitEdits) {
        if (edit.order === null) unitMap.delete(edit.unitId);
        else unitMap.set(edit.unitId, edit.order);
      }
      const nextRev = curRev + 1;
      revMap.set(member.id, nextRev);
      return save({
        receipt: {
          kind: "receipt",
          requestId: cmd.requestId,
          status: "accepted",
          turnId: cmd.turnId,
          revision: nextRev,
        },
      });
    }

    if (cmd.kind === "autonomy.configure" && member.role === "GM") {
      this.liveState = {
        ...this.liveState,
        autonomy: {
          ...(this.liveState.autonomy ?? {}),
          ...(cmd.global !== undefined ? { global: cmd.global } : {}),
          ...(cmd.spatialCombat !== undefined ? { spatialCombat: cmd.spatialCombat } : {}),
        },
      };
      this.roomState = { ...this.roomState, members: this.roomState.members + 1 };
      return save({
        receipt: {
          kind: "receipt",
          requestId: cmd.requestId,
          status: "accepted",
          turnId: this.roomState.turnId,
        },
        live: { ...this.liveState },
        room: { ...this.roomState },
      });
    }

    if (member.role !== "GM") {
      return save({ receipt: reject(cmd.requestId, "forbidden", "GM only.") });
    }
    if ("turnId" in cmd && cmd.turnId !== this.roomState.turnId) {
      return save({ receipt: reject(cmd.requestId, "turn_closed", "Wrong turn.") });
    }
    if (cmd.kind === "turn.close" && this.roomState.phase === "orders") {
      const nextRoom = this.freezeTurn(seed);
      return save({
        receipt: {
          kind: "receipt",
          requestId: cmd.requestId,
          status: "accepted",
          turnId: cmd.turnId,
        },
        room: nextRoom,
      });
    }
    if (cmd.kind === "turn.next" && this.roomState.phase === "report") {
      this.roomState = {
        ...this.roomState,
        turnId: this.roomState.turnId + 1,
        phase: "orders",
        deadlineMs: cmd.durationMs === null ? null : Date.now() + cmd.durationMs,
      };
      return save({
        receipt: {
          kind: "receipt",
          requestId: cmd.requestId,
          status: "accepted",
          turnId: this.roomState.turnId,
        },
        room: { ...this.roomState },
      });
    }
    return save({ receipt: reject(cmd.requestId, "wrong_phase", "Unavailable in phase.") });
  }

  async closeDeadline(turnId: number, now: number, seed: number): Promise<RoomRecord | null> {
    if (
      this.roomState.turnId === turnId &&
      this.roomState.phase === "orders" &&
      this.roomState.deadlineMs !== null &&
      now >= this.roomState.deadlineMs
    ) {
      return this.freezeTurn(seed);
    }
    return null;
  }

  async frozen(turnId: number, fallbackScenario: Scenario): Promise<Frozen> {
    const f = this.frozenTurns.get(turnId);
    if (!f) throw new Error(`Missing frozen turn ${turnId}`);
    const startState = await this.version(f.start);
    return {
      turnId,
      seed: f.seed,
      orders: f.orders,
      start: Object.keys(f.control).length ? { ...startState, control: f.control } : startState,
      scenario: f.scenario ?? fallbackScenario,
      ...(Object.keys(f.live).length ? { live: f.live } : {}),
    };
  }

  async publish(
    turnId: number,
    generation: number,
    result: Result,
    control?: Control,
  ): Promise<RoomRecord> {
    if (generation !== this.ownedGeneration || this.roomState.turnId !== turnId) {
      throw new Error("Superseded publication");
    }
    const stored: Published = control ? { ...result.state, control } : result.state;
    this.versions.set(result.state.version, stored);
    this.reports.set(result.state.version, result.rows);
    this.roomState = {
      ...this.roomState,
      version: result.state.version,
      phase: "report",
      deadlineMs: null,
    };
    return { ...this.roomState };
  }

  async pause(turnId: number, generation: number): Promise<RoomRecord | null> {
    if (
      generation === this.ownedGeneration &&
      this.roomState.turnId === turnId &&
      this.roomState.phase === "resolution"
    ) {
      this.roomState = { ...this.roomState, phase: "paused", deadlineMs: null };
      return { ...this.roomState };
    }
    return null;
  }

  getPublishedFxCues(version: number) {
    return this.versions.get(version)?.extras?.fxCues ?? [];
  }

  getFrozenOrders(turnId: number) {
    return this.frozenTurns.get(turnId)?.orders ?? [];
  }

  async report(member: Member, version: number, page: number): Promise<ReportRow[]> {
    const all = this.reports.get(version) ?? [];
    const filtered =
      member.role === "GM" ? all : all.filter((r) => r.memberId === member.id);
    const start = page * PAGE_ROWS;
    return filtered.slice(start, start + PAGE_ROWS + 1).map((row) => ({
      unitId: row.unitId,
      name: row.name,
      before: row.before,
      alive: row.alive,
      lost: row.lost,
      order: row.order,
    }));
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const addr = s.address();
  s.close();
  if (!addr || typeof addr === "string") throw new Error("No free port");
  return addr.port;
}

/**
 * Builds the exact mass-battle VFX scenario requested:
 * - ~315 total models fighting around central battle coordinates `(1000, 1000)`:
 *   - 6 Melee Infantry companies (3 Blue vs 3 Red, 30 models each = 180 melee fighters in direct contact)
 *   - 4 Ranged Archer companies (2 Blue vs 2 Red, 30 models each = 120 archers trading volleys)
 *   - 15 distinct Spellcaster batteries (10 Lightning Bolt casters + 5 Fireball casters = 15 models)
 *     positioned at distinct origins (> 40 ft apart) aiming at distinct targets/octants so ZERO spells coalesce!
 * - Commander 1 & Commander 2 are both seated commanders looking at the exact same `(1000, 1000)` sector.
 */
function buildMassVfxScenario(
  coalescence: StrategicFxCoalescence,
  extraSpellMultiplier = 1,
): {
  scenario: Scenario;
  blueOrdersP1: Array<{ unitName: string; kind: "melee" | "shot" | "lightning" | "fireball"; targetName?: string; aim?: { x: number; y: number } }>;
  blueOrdersP2: Array<{ unitName: string; kind: "melee" | "shot" | "lightning" | "fireball"; targetName?: string; aim?: { x: number; y: number } }>;
  redOrders: Array<{ unitName: string; kind: "melee" | "shot" | "lightning" | "fireball"; targetName?: string; aim?: { x: number; y: number } }>;
} {
  // 3 Blue melee companies (30 models each = 90) face-to-face with 3 Red melee companies (90) around x=995..1005
  // Note: 30 models deploy in 10 files (50 ft tall in Y when facing East/West? Let's space Y by 75 ft so zero overlap!)
  const meleeY = [880, 1000, 1120];
  const archerY = [920, 1080];

  const blueP1Units: Scenario["commanders"][number]["units"] = [];
  const blueP2Units: Scenario["commanders"][number]["units"] = [];
  const redUnits: Scenario["commanders"][number]["units"] = [];

  const blueOrdersP1: Array<{ unitName: string; kind: "melee" | "shot" | "lightning" | "fireball"; targetName?: string; aim?: { x: number; y: number } }> = [];
  const blueOrdersP2: Array<{ unitName: string; kind: "melee" | "shot" | "lightning" | "fireball"; targetName?: string; aim?: { x: number; y: number } }> = [];
  const redOrders: Array<{ unitName: string; kind: "melee" | "shot" | "lightning" | "fireball"; targetName?: string; aim?: { x: number; y: number } }> = [];

  // Melee formations: Blue at x=985, Red at x=1015 (front ranks within melee stride/reach, high HP so fight lasts multiple turns)
  for (let i = 0; i < 3; i++) {
    const y = meleeY[i] ?? 1000;
    const bUnit = {
      id: `b-melee-${i + 1}`,
      name: `Blue Vanguard ${i + 1}`,
      anchor: { x: 980, y },
      strength: 30,
      weapon: "melee" as const,
      stats: { hp: 140, ac: 14, bab: 9, strMod: 4 },
    };
    const rUnit = {
      id: `r-melee-${i + 1}`,
      name: `Red Legion ${i + 1}`,
      anchor: { x: 1020, y },
      strength: 30,
      weapon: "melee" as const,
      stats: { hp: 140, ac: 14, bab: 9, strMod: 4 },
    };
    if (i < 2) {
      blueP1Units.push(bUnit);
      blueOrdersP1.push({ unitName: bUnit.name, kind: "melee", targetName: rUnit.name });
    } else {
      blueP2Units.push(bUnit);
      blueOrdersP2.push({ unitName: bUnit.name, kind: "melee", targetName: rUnit.name });
    }
    redUnits.push(rUnit);
    redOrders.push({ unitName: rUnit.name, kind: "melee", targetName: bUnit.name });
  }

  // Ranged archer formations: Blue at x=870, Red at x=1130 (260 ft apart, trading arrow volleys across the melee line!)
  for (let i = 0; i < 2; i++) {
    const y = archerY[i] ?? 1000;
    const bArch = {
      id: `b-arch-${i + 1}`,
      name: `Blue Longbows ${i + 1}`,
      anchor: { x: 870, y },
      strength: 30,
      weapon: "shot" as const,
      stats: { hp: 90, ac: 14, bab: 8, dexMod: 3, weaponIsRanged: 1, weaponRangeIncrement: 100 },
    };
    const rArch = {
      id: `r-arch-${i + 1}`,
      name: `Red Crossbows ${i + 1}`,
      anchor: { x: 1130, y },
      strength: 30,
      weapon: "shot" as const,
      stats: { hp: 90, ac: 14, bab: 8, dexMod: 3, weaponIsRanged: 1, weaponRangeIncrement: 100 },
    };
    if (i === 0) {
      blueP1Units.push(bArch);
      blueOrdersP1.push({ unitName: bArch.name, kind: "shot", targetName: `Red Legion ${i + 1}` });
    } else {
      blueP2Units.push(bArch);
      blueOrdersP2.push({ unitName: bArch.name, kind: "shot", targetName: `Red Legion ${i + 2}` });
    }
    redUnits.push(rArch);
    redOrders.push({ unitName: rArch.name, kind: "shot", targetName: `Blue Vanguard ${i + 1}` });
  }

  // 10 Lightning Bolt casters per multiplier + 5 Fireball casters per multiplier
  // Placed inside 200 ft vision of the allied front line (x=880..1120, y=820..1180) and spaced >= 42 ft apart
  // with distinct aim points so NONE coalesce AND every cue is visible to both factions!
  const totalLightning = 10 * extraSpellMultiplier;
  for (let i = 0; i < totalLightning; i++) {
    const isRed = i % 3 === 2;
    const ox = isRed ? 1055 + (i % 3) * 32 : 945 - (i % 3) * 32;
    const oy = 840 + i * (320 / Math.max(1, totalLightning - 1));
    const tx = isRed ? ox - 110 : ox + 110;
    const ty = oy + ((i % 3) - 1) * 24;
    const unit = {
      id: `caster-lb-${i + 1}`,
      name: `Stormcaller ${i + 1}`,
      anchor: { x: Math.round(ox), y: Math.round(oy) },
      strength: 1,
      weapon: "shot" as const,
      unitType: "hero" as const,
      stats: { hp: 120, ac: 16 },
      spells: [
        {
          id: "lightning-bolt" as const,
          itemId: `lb-item-${i + 1}`,
          slots: 6,
          casterLevel: 10,
          castingAbilityMod: 5,
        },
      ],
    };
    if (isRed) {
      redUnits.push(unit);
      redOrders.push({ unitName: unit.name, kind: "lightning", aim: { x: Math.round(tx), y: Math.round(ty) } });
    } else if (i % 2 === 0) {
      blueP1Units.push(unit);
      blueOrdersP1.push({ unitName: unit.name, kind: "lightning", aim: { x: Math.round(tx), y: Math.round(ty) } });
    } else {
      blueP2Units.push(unit);
      blueOrdersP2.push({ unitName: unit.name, kind: "lightning", aim: { x: Math.round(tx), y: Math.round(ty) } });
    }
  }

  const totalFireballs = 5 * extraSpellMultiplier;
  for (let i = 0; i < totalFireballs; i++) {
    const isRed = i % 2 === 1;
    const ox = isRed ? 1085 + (i % 2) * 32 : 915 - (i % 2) * 32;
    const oy = 880 + i * (240 / Math.max(1, totalFireballs - 1));
    // Distinct detonation coordinates >= 45 ft apart right across the central battlezone (within 200 ft sight of both armies!)
    const tx = 965 + ((i * 23) % 75);
    const ty = 880 + i * (240 / Math.max(1, totalFireballs - 1));
    const unit = {
      id: `caster-fb-${i + 1}`,
      name: `Pyromancer ${i + 1}`,
      anchor: { x: Math.round(ox), y: Math.round(oy) },
      strength: 1,
      weapon: "shot" as const,
      unitType: "hero" as const,
      stats: { hp: 120, ac: 16 },
      spells: [
        {
          id: "fireball" as const,
          itemId: `fb-item-${i + 1}`,
          slots: 6,
          casterLevel: 10,
          castingAbilityMod: 5,
        },
      ],
    };
    if (isRed) {
      redUnits.push(unit);
      redOrders.push({ unitName: unit.name, kind: "fireball", aim: { x: Math.round(tx), y: Math.round(ty) } });
    } else if (i % 4 === 0) {
      blueP1Units.push(unit);
      blueOrdersP1.push({ unitName: unit.name, kind: "fireball", aim: { x: Math.round(tx), y: Math.round(ty) } });
    } else {
      blueP2Units.push(unit);
      blueOrdersP2.push({ unitName: unit.name, kind: "fireball", aim: { x: Math.round(tx), y: Math.round(ty) } });
    }
  }

  const scenario = parseScenario({
    format: "arenastar-strategic-scenario-v1",
    name: "Mass VFX Stress Battle",
    seed: 20261122,
    ...(coalescence !== "extreme" ? { fxCoalescence: coalescence } : {}),
    bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
    factions: [
      { id: "blue", name: "Azure Coalition", color: "#4da3ff" },
      { id: "red", name: "Crimson Host", color: "#ff6b6b" },
    ],
    commanders: [
      { id: "player-1", name: "Player 1 (Blue North)", factionId: "blue", units: blueP1Units },
      { id: "player-2", name: "Player 2 (Blue South)", factionId: "blue", units: blueP2Units },
      { id: "player-red", name: "Red Warlord", factionId: "red", units: redUnits },
    ],
  });

  return { scenario, blueOrdersP1, blueOrdersP2, redOrders };
}

interface FrameStats {
  frames: number;
  durationMs: number;
  fps: number;
  avgDeltaMs: number;
  p50DeltaMs: number;
  p95DeltaMs: number;
  p99DeltaMs: number;
  maxDeltaMs: number;
  droppedOver33Ms: number;
  droppedOver50Ms: number;
  canvasDrawCalls: number;
  avgCanvasDrawMs: number;
  p95CanvasDrawMs: number;
  maxCanvasDrawMs: number;
}

async function installFrameProfiler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const origClear = proto.clearRect;
    const origRestore = proto.restore;
    type ProfilerState = {
      active: boolean;
      rafTimes: number[];
      drawDurations: number[];
      currentDrawStart: number;
      inMainClear: boolean;
    };
    const state: ProfilerState = {
      active: false,
      rafTimes: [],
      drawDurations: [],
      currentDrawStart: 0,
      inMainClear: false,
    };
    (window as unknown as { __fxPerf?: ProfilerState }).__fxPerf = state;

    // Instrument main battlefield canvas draw pass (`clearRect(0, 0, width, height)` -> end of microtask/frame)
    proto.clearRect = function (x: number, y: number, w: number, h: number) {
      if (state.active && x === 0 && y === 0 && w > 200 && h > 200) {
        const t0 = performance.now();
        state.currentDrawStart = t0;
        state.inMainClear = true;
        queueMicrotask(() => {
          if (state.inMainClear) {
            state.inMainClear = false;
            state.drawDurations.push(performance.now() - state.currentDrawStart);
          }
        });
      }
      return origClear.call(this, x, y, w, h);
    };
    void origRestore;
  });
}

async function measureBurstFrames(page: Page, windowMs: number): Promise<FrameStats> {
  return page.evaluate(async (ms) => {
    const perf = (
      window as unknown as {
        __fxPerf?: {
          active: boolean;
          rafTimes: number[];
          rafCallbackCpuMs: number[];
          drawDurations: number[];
        };
      }
    ).__fxPerf;
    if (!perf) throw new Error("Profiler not installed");
    perf.rafTimes = [];
    perf.rafCallbackCpuMs = [];
    perf.drawDurations = [];
    perf.active = true;

    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        perf.rafTimes.push(now);
        if (now - start >= ms) {
          perf.active = false;
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });

    const times = perf.rafTimes;
    const deltas: number[] = [];
    for (let i = 1; i < times.length; i++) {
      deltas.push((times[i] ?? 0) - (times[i - 1] ?? 0));
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted.length === 0
        ? 0
        : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);

    const totalMs =
      times.length >= 2 ? (times[times.length - 1] ?? 0) - (times[0] ?? 0) : ms;
    const avgDelta =
      deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

    // Prefer Canvas 2D clear->microtask draw durations if recorded, else rAF callback CPU durations
    const rawDraws = perf.drawDurations.length > 0 ? perf.drawDurations : perf.rafCallbackCpuMs;
    const draws = [...rawDraws].sort((a, b) => a - b);
    const avgDraw =
      draws.length > 0 ? draws.reduce((a, b) => a + b, 0) / draws.length : 0;
    const p95Draw =
      draws.length > 0
        ? (draws[Math.min(draws.length - 1, Math.floor(draws.length * 0.95))] ?? 0)
        : 0;
    const maxDraw = draws.length > 0 ? (draws[draws.length - 1] ?? 0) : 0;

    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      frames: deltas.length,
      durationMs: r2(totalMs),
      fps: totalMs > 0 ? r2((deltas.length * 1000) / totalMs) : 0,
      avgDeltaMs: r2(avgDelta),
      p50DeltaMs: r2(pct(0.5)),
      p95DeltaMs: r2(pct(0.95)),
      p99DeltaMs: r2(pct(0.99)),
      maxDeltaMs: r2(sorted[sorted.length - 1] ?? 0),
      droppedOver33Ms: deltas.filter((d) => d > 33.4).length,
      droppedOver50Ms: deltas.filter((d) => d > 50).length,
      canvasDrawCalls: draws.length,
      avgCanvasDrawMs: r2(avgDraw),
      p95CanvasDrawMs: r2(p95Draw),
      maxCanvasDrawMs: r2(maxDraw),
    };
  }, windowMs);
}

async function admitSeat(page: Page, origin: string, invite: string): Promise<void> {
  await page.goto(origin);
  await page.getByLabel("One-time invite").fill(invite);
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page.locator("[data-phase]")).toBeVisible({ timeout: 15_000 });
}

async function focusSameBattleCoordinates(
  page: Page,
  enableRegionDetail: boolean,
): Promise<{ zoomText: string }> {
  // Center on own unit (which puts camera right at the (1000, 1000) central battle line at >= 240% zoom!)
  const centerBtn = page.getByRole("button", { name: "Center unit" });
  if (await centerBtn.isEnabled()) {
    await centerBtn.click();
    // Zoom out one notch so the entire 450x450 ft engagement zone (all 300 models + all 15 uncoalesced spells) fits inside one viewport!
    await page.getByRole("button", { name: "Zoom out" }).click();
  }
  if (enableRegionDetail) {
    const detailBtn = page.getByRole("button", { name: "Region detail" });
    const pressed = await detailBtn.getAttribute("aria-pressed");
    if (pressed !== "true") {
      await detailBtn.click();
    }
  }
  const zoomText = (await page.locator(".scale-pill").textContent()) ?? "";
  return { zoomText: zoomText.trim() };
}

async function draftAndSubmitOrdersUI(
  page: Page,
  orders: Array<{
    unitName: string;
    kind: "melee" | "shot" | "lightning" | "fireball";
    targetName?: string;
    aim?: { x: number; y: number };
  }>,
): Promise<void> {
  // Drive the HostedRoom order UI swiftly for every unit assigned to this commander
  const unitSelect = page.getByLabel("Assigned unit");
  for (const ord of orders) {
    // Match option starting with `${ord.unitName} ·`
    const optVal = await unitSelect.evaluate((sel, prefix) => {
      const s = sel as HTMLSelectElement;
      for (const opt of Array.from(s.options)) {
        if (opt.text.startsWith(prefix + " ·")) return opt.value;
      }
      return "";
    }, ord.unitName);
    expect(optVal).not.toBe("");
    await unitSelect.selectOption(optVal);

    if (ord.kind === "melee" || ord.kind === "shot") {
      const enemySelect = page.getByLabel("Visible enemy");
      await enemySelect.selectOption({ label: ord.targetName ?? "" });
      await page
        .getByRole("button", {
          name: ord.kind === "shot" ? "Draft ranged attack" : "Draft melee attack",
        })
        .click();
    } else {
      await page.getByLabel("March X").fill(String(ord.aim?.x ?? 1000));
      await page.getByLabel("March Y").fill(String(ord.aim?.y ?? 1000));
      const spellId = ord.kind === "lightning" ? "lightning-bolt" : "fireball";
      await page.locator("[data-spell-select]").selectOption(spellId);
      await page.locator("[data-draft-spell]").click();
    }
  }
  await page.getByRole("button", { name: "Submit orders" }).click();
  await expect(page.locator("[data-revision]")).toHaveText("1", { timeout: 10_000 });
  const statusText = await page.getByRole("status").first().textContent().catch(() => "");
  void statusText;
}

test.describe("Playwright Mass-Battle VFX & Spatial Audio Frame-Rate Benchmark", () => {
  test(
    "2+ players view identical coordinates where ~315 models clash/shoot and 15+ distinct uncoalesced spells (10 Lightning Bolts + 5 Fireballs) detonate simultaneously — plus extreme stress sweep to find limits",
    async ({ browser }: { browser: Browser }) => {
      test.setTimeout(240_000);

      // -------------------------------------------------------------------------
      // PART 1: Exact Requested Scenario (315 models + 10 Lightning Bolts + 5 Fireballs, uncoalesced)
      //         with 2 Players + GM simultaneously looking at the same (1000, 1000) coordinates!
      // -------------------------------------------------------------------------
      const { scenario, blueOrdersP1, blueOrdersP2, redOrders } = buildMassVfxScenario(
        "none",
        1,
      );
      const initial = deploy(scenario);
      const memDb = new InMemoryStrategicRoomDb("room-vfx-bench", scenario, initial);
      const invites = memDb.seedMembers();
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;

      const edge = await serve(
        memDb as unknown as PostgresRoom,
        new Set([origin]),
        port,
      );

      const contexts: BrowserContext[] = [];
      const newViewer = async (): Promise<Page> => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        contexts.push(ctx);
        return ctx.newPage();
      };

      try {
        const gmPage = await newViewer();
        const p1Page = await newViewer();
        const p2Page = await newViewer();
        const redPage = await newViewer();

        await Promise.all([
          admitSeat(gmPage, origin, invites["gm"] ?? ""),
          admitSeat(p1Page, origin, invites["player-1"] ?? ""),
          admitSeat(p2Page, origin, invites["player-2"] ?? ""),
          admitSeat(redPage, origin, invites["player-red"] ?? ""),
        ]);

        // Both Player 1 and Player 2 focus on the exact same (1000, 1000) central coordinates
        // with individual soldier Region Detail enabled (>170% zoom, 315 individual round soldier tokens!)
        const p1Cam = await focusSameBattleCoordinates(p1Page, true);
        const p2Cam = await focusSameBattleCoordinates(p2Page, true);

        // Wait for region models to stream into both Player 1 and Player 2
        await pageWaitForModels(p1Page);
        await pageWaitForModels(p2Page);

        await installFrameProfiler(p1Page);
        await installFrameProfiler(p2Page);

        // Measure idle baseline FPS before combat FX burst
        const [idleP1, idleP2] = await Promise.all([
          measureBurstFrames(p1Page, 800),
          measureBurstFrames(p2Page, 800),
        ]);

        // Submit all melee, ranged volley, 10 Lightning Bolt, and 5 Fireball orders across the commanders!
        await draftAndSubmitOrdersUI(p1Page, blueOrdersP1);
        await draftAndSubmitOrdersUI(p2Page, blueOrdersP2);
        await draftAndSubmitOrdersUI(redPage, redOrders);

        // Inspect published FX cues routed over `/api/strategic/view` to Player 1 & Player 2
        const p1ViewCuesPromise = captureNextResolvedFxCues(p1Page);
        const p2ViewCuesPromise = captureNextResolvedFxCues(p2Page);

        // Close & resolve Turn 1 in real Worker thread while measuring both players' live rAF & Canvas 2D draw frame times!
        const p1ViewDone = p1Page.waitForResponse(
          (r) => r.url().includes("/api/strategic/view") && r.status() === 200,
          { timeout: 20_000 },
        );
        const p2ViewDone = p2Page.waitForResponse(
          (r) => r.url().includes("/api/strategic/view") && r.status() === 200,
          { timeout: 20_000 },
        );
        const resolveT0 = performance.now();
        await gmPage.getByRole("button", { name: "Close and resolve" }).click();

        // Wait until `/view` binary response actually lands on both Player 1 & Player 2 so the 1650ms VFX burst is genuinely active!
        await Promise.all([p1ViewDone, p2ViewDone]);
        const wallResolveMs = Math.round((performance.now() - resolveT0) * 10) / 10;
        await p1Page.waitForTimeout(30);

        // Immediately sample the full 1,500ms live VFX + Spatial Audio burst on BOTH Player 1 & Player 2 simultaneously!
        const [burstP1, burstP2] = await Promise.all([
          measureBurstFrames(p1Page, 1500),
          measureBurstFrames(p2Page, 1500),
        ]);

        const pubCues = memDb.getPublishedFxCues(1);
        const cueSummary = {
          totalCues: pubCues.length,
          lightningBolts: pubCues.filter((c) => c.preset === "lightning-bolt").length,
          fireballs: pubCues.filter((c) => c.preset === "fireball").length,
          meleeAndVolley: pubCues.filter((c) => c.preset === "melee" || c.preset === "volley")
            .length,
        };
        void p1ViewCuesPromise;
        void p2ViewCuesPromise;

        console.log(
          "\n=== [BENCHMARK 1: 315 Models + 10 Lightning Bolts + 5 Fireballs (Uncoalesced `none`), 2 Players + GM] ===",
        );
        console.log(
          JSON.stringify(
            {
              zoomP1: p1Cam.zoomText,
              zoomP2: p2Cam.zoomText,
              endToEndTurnResolveMs: wallResolveMs,
              publishedDistinctCues: cueSummary,
              idleBaseline: { player1: idleP1, player2: idleP2 },
              activeVfxBurstSimultaneous: { player1: burstP1, player2: burstP2 },
            },
            null,
            2,
          ),
        );

        // Verify zero unintended coalescing: all 10 Lightning Bolts + all 5 Fireballs + melee & volley cues arrived distinct!
        expect(cueSummary.lightningBolts).toBe(10);
        expect(cueSummary.fireballs).toBe(5);
        expect(cueSummary.meleeAndVolley).toBeGreaterThanOrEqual(6);
        expect(burstP1.frames).toBeGreaterThan(15);
        expect(burstP2.frames).toBeGreaterThan(15);
      } finally {
        for (const ctx of contexts) await ctx.close().catch(() => undefined);
        await edge.close();
      }

      // -------------------------------------------------------------------------
      // PART 2: Limit-Finding Stress Sweep in Real Chromium!
      //   Sweep simultaneous uncoalesced cue counts (30, 75, 160, 320, 600 cues + 300–1,200 models)
      //   across 2 simultaneous player pages to pinpoint exact Canvas 2D + rAF frame-time limits!
      // -------------------------------------------------------------------------
      const stressPageCtx1 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const stressPageCtx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const sp1 = await stressPageCtx1.newPage();
        const sp2 = await stressPageCtx2.newPage();

        const sweepResults = await runDirectBrowserStressSweep(sp1, sp2, browser);
        console.log("\n=== [BENCHMARK 2: Multi-Player Chromium VFX + Model Scaling Limit Sweep] ===");
        console.log(JSON.stringify(sweepResults, null, 2));
        expect(sweepResults.length).toBeGreaterThanOrEqual(4);
      } finally {
        await stressPageCtx1.close().catch(() => undefined);
        await stressPageCtx2.close().catch(() => undefined);
      }
    },
  );
});

async function pageWaitForModels(page: Page): Promise<void> {
  // Give `/api/strategic/region` 300ms to populate individual soldier markers
  await page.waitForTimeout(350);
}

async function captureNextResolvedFxCues(page: Page): Promise<{
  totalCues: number;
  lightningBolts: number;
  fireballs: number;
  meleeAndVolley: number;
  wireBytes: number;
}> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.off("response", handler);
      resolve({ totalCues: -1, lightningBolts: -1, fireballs: -1, meleeAndVolley: -1, wireBytes: 0 });
    }, 8000);
    const handler = async (res: import("@playwright/test").Response) => {
      if (!res.url().includes("/api/strategic/view") || res.status() !== 200) return;
      try {
        const buf = await res.body();
        if (buf.byteLength < 8) return;
        const jsonLen = buf.readUInt32BE(0);
        const meta = JSON.parse(buf.subarray(8, 8 + jsonLen).toString("utf8")) as {
          head?: { version: number; phase: string };
          content?: { fxCues?: Array<{ preset: string; count?: number }> };
        };
        if ((meta.head?.version ?? 0) >= 1 && (meta.content?.fxCues?.length ?? 0) > 0) {
          clearTimeout(timer);
          page.off("response", handler);
          const cues = meta.content?.fxCues ?? [];
          resolve({
            totalCues: cues.length,
            lightningBolts: cues.filter((c) => c.preset === "lightning-bolt").length,
            fireballs: cues.filter((c) => c.preset === "fireball").length,
            meleeAndVolley: cues.filter((c) => c.preset === "melee" || c.preset === "volley")
              .length,
            wireBytes: buf.byteLength,
          });
        }
      } catch {
        /* ignore transient response reads */
      }
    };
    page.on("response", handler);
  });
}

/**
 * Runs controlled multi-tier stress tiers through the real `HostedRoom` + `HostedMap` app in
 * two concurrent Chromium tabs (injecting synthetic resolved `/view` + `/region` payloads with
 * 300 -> 1,000 visible soldier stamps and 25 -> 160 -> 320 -> 640 simultaneous uncoalesced FX cues)
 * to measure the exact hardware/browser ceiling.
 */
async function runDirectBrowserStressSweep(
  p1: Page,
  p2: Page,
  browser: Browser,
): Promise<
  Array<{
    tier: string;
    concurrentPlayers: number;
    modelsInView: number;
    publishedUncoalescedCues: number;
    coalescenceMode: StrategicFxCoalescence;
    player1: FrameStats;
    player2: FrameStats;
  }>
> {
  const tiers: Array<{
    tier: string;
    modelsCount: number;
    lightningCount: number;
    fireballCount: number;
    volleyCount: number;
    meleeCount: number;
    coalescence: StrategicFxCoalescence;
    extraPlayers?: number;
  }> = [
    {
      tier: "T1: 300 models + 15 spells + 10 combat FX (25 cues, coalescence=none, 2 players)",
      modelsCount: 300,
      lightningCount: 10,
      fireballCount: 5,
      volleyCount: 4,
      meleeCount: 6,
      coalescence: "none",
    },
    {
      tier: "T2: 600 models + 60 spells + 40 combat FX (100 cues, coalescence=none, 2 players)",
      modelsCount: 600,
      lightningCount: 40,
      fireballCount: 20,
      volleyCount: 20,
      meleeCount: 20,
      coalescence: "none",
    },
    {
      tier: "T3: 1,000 models + 110 spells + 50 combat FX (160 visual cap, coalescence=none, 2 players)",
      modelsCount: 1000,
      lightningCount: 70,
      fireballCount: 40,
      volleyCount: 25,
      meleeCount: 25,
      coalescence: "none",
    },
    {
      tier: "T4: 1,000 models + 110 spells + 50 combat FX (coalescence=balanced, 2 players)",
      modelsCount: 1000,
      lightningCount: 70,
      fireballCount: 40,
      volleyCount: 25,
      meleeCount: 25,
      coalescence: "balanced",
    },
    {
      tier: "T5: 1,800 models (MAX_REGION_MODELS) + 220 spells + 100 combat FX (320 cues, coalescence=none, 2 players)",
      modelsCount: 1800,
      lightningCount: 140,
      fireballCount: 80,
      volleyCount: 50,
      meleeCount: 50,
      coalescence: "none",
    },
    {
      tier: "T6: 1,800 models (MAX_REGION_MODELS) + 220 spells + 100 combat FX (coalescence=extreme, 2 players)",
      modelsCount: 1800,
      lightningCount: 140,
      fireballCount: 80,
      volleyCount: 50,
      meleeCount: 50,
      coalescence: "extreme",
    },
    {
      tier: "T7: 1,800 models + 220 spells + 100 combat FX (coalescence=none, 4 concurrent players on 2 vCPUs)",
      modelsCount: 1800,
      lightningCount: 140,
      fireballCount: 80,
      volleyCount: 50,
      meleeCount: 50,
      coalescence: "none",
      extraPlayers: 2,
    },
    {
      tier: "T8: 4,000 models (synthetic cap-bypass) + 220 spells + 100 combat FX (coalescence=none, 2 players)",
      modelsCount: 4000,
      lightningCount: 140,
      fireballCount: 80,
      volleyCount: 50,
      meleeCount: 50,
      coalescence: "none",
    },
    {
      tier: "T9: 8,000 models (synthetic cap-bypass) + 220 spells + 100 combat FX (coalescence=none, 2 players)",
      modelsCount: 8000,
      lightningCount: 140,
      fireballCount: 80,
      volleyCount: 50,
      meleeCount: 50,
      coalescence: "none",
    },
    {
      tier: "T10: 15,000 models (synthetic cap-bypass) + 220 spells + 100 combat FX (coalescence=none, 2 players)",
      modelsCount: 15000,
      lightningCount: 140,
      fireballCount: 80,
      volleyCount: 50,
      meleeCount: 50,
      coalescence: "none",
    },
    {
      tier: "T11: 25,000 models (synthetic cap-bypass) + 220 spells + 100 combat FX (coalescence=none, 2 players)",
      modelsCount: 25000,
      lightningCount: 140,
      fireballCount: 80,
      volleyCount: 50,
      meleeCount: 50,
      coalescence: "none",
    },
  ];

  // Spin up a clean room with enough units/models to test up to 1,800 models in view
  const unitsBlue: Scenario["commanders"][number]["units"] = [];
  const unitsRed: Scenario["commanders"][number]["units"] = [];
  for (let i = 0; i < 15; i++) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    unitsBlue.push({
      id: `sb-${i}`,
      name: `Blue Reg ${i}`,
      anchor: { x: 860 + col * 65, y: 860 + row * 90 },
      strength: 60,
      weapon: i % 3 === 0 ? "shot" : "melee",
    });
    unitsRed.push({
      id: `sr-${i}`,
      name: `Red Reg ${i}`,
      anchor: { x: 895 + col * 65, y: 860 + row * 90 },
      strength: 60,
      weapon: i % 3 === 0 ? "shot" : "melee",
    });
  }
  const baseScenario = parseScenario({
    format: "arenastar-strategic-scenario-v1",
    name: "Stress Sweep Room",
    seed: 777,
    fxCoalescence: "none",
    bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
    factions: [
      { id: "blue", name: "Blue", color: "#4da3ff" },
      { id: "red", name: "Red", color: "#ff6b6b" },
    ],
    commanders: [
      { id: "p1", factionId: "blue", units: unitsBlue.slice(0, 5) },
      { id: "p2", factionId: "blue", units: unitsBlue.slice(5, 10) },
      { id: "p3", factionId: "blue", units: unitsBlue.slice(10, 15) },
      { id: "p4", factionId: "red", units: unitsRed },
    ],
  });

  const deployed0 = deploy(baseScenario);
  const db = new InMemoryStrategicRoomDb("room-sweep", baseScenario, deployed0);
  const invites = db.seedMembers();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const edge = await serve(db as unknown as PostgresRoom, new Set([origin]), port);

  const results: Array<{
    tier: string;
    concurrentPlayers: number;
    modelsInView: number;
    publishedUncoalescedCues: number;
    coalescenceMode: StrategicFxCoalescence;
    player1: FrameStats;
    player2: FrameStats;
  }> = [];

  const gmCtx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const gmPage = await gmCtx.newPage();
  const extraCtxs: BrowserContext[] = [];

  try {
    await Promise.all([
      admitSeat(gmPage, origin, invites["gm"] ?? ""),
      admitSeat(p1, origin, invites["p1"] ?? ""),
      admitSeat(p2, origin, invites["p2"] ?? ""),
    ]);

    await focusSameBattleCoordinates(p1, true);
    await focusSameBattleCoordinates(p2, true);
    await pageWaitForModels(p1);
    await pageWaitForModels(p2);
    await installFrameProfiler(p1);
    await installFrameProfiler(p2);

    let extraPages: Page[] = [];
    let synthVer = 0;
    for (const t of tiers) {
      synthVer++;
      if ((t.extraPlayers ?? 0) > 0 && extraPages.length === 0) {
        const c3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const c4 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        extraCtxs.push(c3, c4);
        const p3 = await c3.newPage();
        const p4 = await c4.newPage();
        await Promise.all([
          admitSeat(p3, origin, invites["p3"] ?? ""),
          admitSeat(p4, origin, invites["p4"] ?? ""),
        ]);
        await Promise.all([
          focusSameBattleCoordinates(p3, true),
          focusSameBattleCoordinates(p4, true),
        ]);
        extraPages = [p3, p4];
      } else if ((t.extraPlayers ?? 0) === 0 && extraPages.length > 0) {
        for (const ctx of extraCtxs) await ctx.close().catch(() => undefined);
        extraCtxs.length = 0;
        extraPages = [];
      }

      // Intercept `/api/strategic/view` and `/api/strategic/region` on active pages to feed exact deterministic cue & model density
      const cues = buildSyntheticDistinctCues(
        synthVer,
        t.lightningCount,
        t.fireballCount,
        t.volleyCount,
        t.meleeCount,
      );

      const activePages = [p1, p2, ...extraPages];
      for (const pg of activePages) {
        await installTierRoutes(pg, synthVer, cues, t.coalescence, t.modelsCount);
      }

      db.setScenarioCoalescence(t.coalescence);

      // Advance one real authoritative turn via GM (`Open next turn` if in report, then `Close and resolve`)
      if (synthVer > 1) {
        await gmPage.getByRole("button", { name: "Open next turn" }).click();
        await expect(gmPage.locator('[data-phase="orders"]')).toBeVisible({ timeout: 10_000 });
      }
      const viewPromises = activePages.map((pg) =>
        pg.waitForResponse(
          (r) => r.url().includes("/api/strategic/view") && r.status() === 200,
          { timeout: 15_000 },
        ),
      );
      const regionPromises = activePages.map((pg) =>
        pg.waitForResponse(
          (r) => r.url().includes("/api/strategic/region") && r.status() === 200,
          { timeout: 15_000 },
        ),
      );
      await gmPage.getByRole("button", { name: "Close and resolve" }).click();
      await Promise.all([...viewPromises, ...regionPromises]);
      await p1.waitForTimeout(30);

      const [s1, s2] = await Promise.all([
        measureBurstFrames(p1, 1150),
        measureBurstFrames(p2, 1150),
      ]);

      for (const pg of activePages) {
        await pg.unrouteAll({ behavior: "ignoreErrors" });
      }

      results.push({
        tier: t.tier,
        concurrentPlayers: activePages.length,
        modelsInView: t.modelsCount,
        publishedUncoalescedCues: cues.length,
        coalescenceMode: t.coalescence,
        player1: s1,
        player2: s2,
      });
    }
  } finally {
    for (const ctx of extraCtxs) await ctx.close().catch(() => undefined);
    await gmCtx.close().catch(() => undefined);
    await edge.close();
  }

  return results;
}

function buildSyntheticDistinctCues(
  turnId: number,
  lightning: number,
  fireballs: number,
  volleys: number,
  melees: number,
) {
  const out: Array<Record<string, unknown>> = [];
  const lbCols = Math.max(1, Math.ceil(Math.sqrt(lightning * 1.4)));
  const lbRows = Math.max(1, Math.ceil(lightning / lbCols));
  for (let i = 0; i < lightning; i++) {
    const col = i % lbCols;
    const row = Math.floor(i / lbCols);
    const ang = ((i * 37) % 360) * (Math.PI / 180);
    out.push({
      id: `lb-${turnId}-${i}`,
      turnId,
      preset: "lightning-bolt",
      at: { x: 785 + col * (340 / lbCols), y: 825 + row * (250 / lbRows) },
      dir: { x: Math.cos(ang), y: Math.sin(ang) },
      radius: 120,
      intensity: 1.4,
      soundCue: "thunder",
    });
  }
  const fbCols = Math.max(1, Math.ceil(Math.sqrt(fireballs * 1.4)));
  const fbRows = Math.max(1, Math.ceil(fireballs / fbCols));
  for (let i = 0; i < fireballs; i++) {
    const col = i % fbCols;
    const row = Math.floor(i / fbCols);
    out.push({
      id: `fb-${turnId}-${i}`,
      turnId,
      preset: "fireball",
      at: { x: 790 + col * (330 / fbCols), y: 830 + row * (245 / fbRows) },
      radius: 20,
      intensity: 1.5,
      soundCue: "blast",
    });
  }
  const volCols = Math.max(1, Math.ceil(Math.sqrt(volleys * 1.4)));
  const volRows = Math.max(1, Math.ceil(volleys / volCols));
  for (let i = 0; i < volleys; i++) {
    const col = i % volCols;
    const row = Math.floor(i / volCols);
    const x = 795 + col * (320 / volCols);
    const y = 835 + row * (240 / volRows);
    out.push({
      id: `vol-${turnId}-${i}`,
      turnId,
      preset: "volley",
      from: { x: x - 110, y: y - 20 },
      at: { x, y },
      radius: 18,
      count: 6,
      intensity: 1.2,
      soundCue: "volley",
    });
  }
  const melCols = Math.max(1, Math.ceil(Math.sqrt(melees * 1.4)));
  const melRows = Math.max(1, Math.ceil(melees / melCols));
  for (let i = 0; i < melees; i++) {
    const col = i % melCols;
    const row = Math.floor(i / melCols);
    out.push({
      id: `mel-${turnId}-${i}`,
      turnId,
      preset: "melee",
      at: { x: 800 + col * (310 / melCols), y: 840 + row * (235 / melRows) },
      radius: 14,
      count: 8,
      intensity: 1.1,
      soundCue: "clash",
    });
  }
  return out;
}

async function installTierRoutes(
  page: Page,
  synthVersion: number,
  cues: Array<Record<string, unknown>>,
  coalescence: StrategicFxCoalescence,
  modelsCount: number,
): Promise<void> {
  await page.route(/\/api\/strategic\/view(?:\?|$)/, async (route) => {
    const res = await route.fetch();
    const buf = await res.body();
    const jsonLen = buf.readUInt32BE(0);
    const markerLen = buf.readUInt32BE(4);
    const meta = JSON.parse(buf.subarray(8, 8 + jsonLen).toString("utf8")) as Record<
      string,
      unknown
    >;
    const tail = buf.subarray(8 + jsonLen);

    const head = (meta.head as Record<string, unknown>) ?? {};
    meta.head = { ...head, version: synthVersion, phase: "report" };
    meta.content = {
      ...((meta.content as Record<string, unknown>) ?? {}),
      fxCues: cues,
      ...(coalescence !== "extreme" ? { fxCoalescence: coalescence } : {}),
    };

    const newJson = Buffer.from(JSON.stringify(meta), "utf8");
    const prefix = Buffer.alloc(8 + newJson.byteLength);
    prefix.writeUInt32BE(newJson.byteLength, 0);
    prefix.writeUInt32BE(markerLen, 4);
    newJson.copy(prefix, 8);
    const combined = Buffer.concat([prefix, tail]);

    const rawHeaders = { ...res.headers() };
    delete rawHeaders["content-length"];
    delete rawHeaders["Content-Length"];
    await route.fulfill({
      status: 200,
      headers: rawHeaders,
      body: combined,
    });
  });

  await page.route(/\/api\/strategic\/region(?:\?|$)/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as {
      epoch: string;
      version: number;
      cursor: number;
      enter: Array<{ id: string; unitId: string; x: number; y: number; rotation: number }>;
    };
    const models: Array<{ id: string; unitId: string; x: number; y: number; rotation: number }> = [];
    const cols = Math.max(1, Math.ceil(Math.sqrt(modelsCount * 1.35)));
    const rows = Math.max(1, Math.ceil(modelsCount / cols));
    const stepX = 360 / cols;
    const stepY = 260 / rows;
    for (let i = 0; i < modelsCount; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const isRed = i % 2 === 1;
      models.push({
        id: `m-${synthVersion}-${i}`,
        unitId: isRed ? `sr-${i % 15}` : `sb-${i % 15}`,
        x: 780 + c * stepX,
        y: 820 + r * stepY,
        rotation: isRed ? Math.PI : 0,
      });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        epoch: body.epoch,
        version: synthVersion,
        cursor: synthVersion + 100,
        fromCursor: null,
        truncated: false,
        enter: models,
        update: [],
        leave: [],
      }),
    });
  });
}
