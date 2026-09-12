import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CombatDocument,
  Json,
  MessageDocument,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import type { PF1eInterrupt } from "../../src/packages/pf1e/interrupts";
import type { PF1eMovementOpportunityResult } from "../../src/packages/pf1e/tacticalOpportunity";
import {
  autoResolveAoosIsAuthored,
  autoResolveAoosOf,
} from "../../src/packages/pf1e/aooSettings";
import type { ResolveFlowClient } from "../../src/ui/sheets/pf1eResolveFlow";
import {
  planHeldMove,
  resolutionLines,
  resolveMovementOpportunities,
  type MovementAooResolutionInput,
} from "../../src/ui/combat/pf1eAooFlow";

const gm = { id: "gm", role: "GM" as const };
const nobody = { id: "nobody", role: "PLAYER" as const };

/** A resolver: an authored longsword, plain stats. */
function fighter(pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: "fighter",
    type: "actor",
    name: "Fighter",
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: {
      pf1e: {
        abilities: { str: 16, dex: 14, con: 14 },
        baseAttack: 6,
        hp: 30,
        hpMax: 30,
        armorClass: { armor: 5 },
        attacks: [
          {
            name: "Longsword",
            damageDice: "1d8",
            damageBonus: 3,
            damageType: "slashing",
            critThreatMin: 19,
            critMultiplier: 2,
          },
        ],
        ...pf1e,
      },
    },
  };
}

/** The provoker: AC 16 (10 + armor 4 + Dex 2), 12 HP, DR 5/magic. */
function goblin(pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: "goblin",
    type: "actor",
    name: "Goblin",
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: {
      pf1e: {
        abilities: { dex: 14, con: 12 },
        hp: 12,
        hpMax: 12,
        armorClass: { armor: 4 },
        dr: 5,
        drBypass: ["magic"],
        ...pf1e,
      },
    },
  };
}

function combatant(
  id: string,
  tokenId: string,
  actorId: string,
  initiative: number,
  pf1e: Record<string, Json> = {},
): Record<string, unknown> {
  return {
    _id: id,
    type: "combatant",
    name: id,
    tokenId,
    actorId,
    initiative,
    hidden: false,
    defeated: false,
    ownership: { default: 3 },
    flags: { pf1e },
    system: {},
  };
}

/**
 * An encounter mid-round: both combatants have acted, so nobody is structurally
 * flat-footed and the defense choice is decided by the fixtures, not by the clock.
 */
function combat(combatants: Array<Record<string, unknown>>): CombatDocument {
  return {
    _id: "combat",
    type: "combat",
    name: "Fight",
    round: 1,
    turn: 0,
    ownership: { default: 3 },
    flags: {
      pf1e: {
        phase: "rounds",
        secondsPerRound: 6,
        surpriseOrder: [],
        surpriseTurn: 0,
        surprised: [],
        ties: [],
        clockSeconds: 0,
        roundRolled: false,
      },
    },
    system: {},
    combatants,
  } as unknown as CombatDocument;
}

const tokens = [
  { _id: "t-fighter", actorId: "fighter" },
  { _id: "t-goblin", actorId: "goblin" },
];

function interrupt(
  sequence: number,
  reactorId: string,
  provokerId = "t-goblin",
): PF1eInterrupt {
  return {
    id: `1:move:${reactorId}:${provokerId}:move-out:${sequence}`,
    kind: "attack-of-opportunity",
    reactorId,
    provokerId,
    actionId: "move-out",
    trigger: { kind: "move-out", left: { x: 200, y: 0 } },
    turn: 1,
    substep: "move",
    sequence,
  };
}

/**
 * The seam's result: the queue the flow resolves, and the reactor lines D-185's report
 * shows (that wording is the seam's — `reactors[].line`).
 */
function opportunity(queued: PF1eInterrupt[]): PF1eMovementOpportunityResult {
  const seen = new Set<string>();
  const reactors = queued.flatMap((q) => {
    if (seen.has(q.reactorId)) return [];
    seen.add(q.reactorId);
    const cell = q.trigger.left;
    const where =
      cell === undefined ? "0,0" : `${cell.x / 100},${cell.y / 100}`;
    return [
      {
        tokenId: q.reactorId,
        cell: where,
        rect: { x: 0, y: 0, size: 100 },
        used: 1,
        max: 1,
        line: `${q.reactorId.replace("t-", "")} may strike goblin as it leaves (${where})`,
      },
    ];
  });
  return {
    ok: true,
    issues: [],
    defaults: [],
    grid: null,
    refusal: null,
    path: [],
    squaresLeft: [],
    leftRects: [],
    reactors,
    refused: [],
    queue: { turn: 1, substep: "move", interrupts: [...queued] },
    queued,
  };
}

/** Fake client: scripted roll totals, real message shapes, recorded submits. */
class FakeClient implements ResolveFlowClient {
  messages: MessageDocument[] = [];
  submitted: Op[][] = [];
  formulas: string[] = [];
  verifiedRolls = 0;
  script: Array<{ die?: number; total: number }> = [];
  private seq = 0;
  readonly store = {
    getAll: (coll: "messages"): readonly unknown[] =>
      coll === "messages" ? this.messages : [],
  };

  roll(formula: string): string {
    this.formulas.push(formula);
    const rollId = `r${this.seq++}`;
    const entry = this.script.shift() ?? { total: 0 };
    this.messages.push(this.record(rollId, formula, entry));
    return rollId;
  }

  async rollVerified(formula: string): Promise<string> {
    this.verifiedRolls += 1;
    return this.roll(formula);
  }

  submit(ops: Op[]): string {
    this.submitted.push(ops);
    return "tx";
  }

  private record(
    rollId: string,
    formula: string,
    entry: { die?: number; total: number },
  ): MessageDocument {
    return {
      _id: `m-${rollId}`,
      type: "message",
      name: formula.slice(0, 40),
      ownership: { default: 1 },
      flags: { core: { rollId } },
      system: {},
      author: "gm",
      content: formula,
      whisper: [],
      roll: {
        formula,
        total: entry.total,
        terms:
          entry.die === undefined
            ? [{ kind: "dice", expr: "1d8", rolls: [4], kept: [4], total: 4 }]
            : [
                {
                  kind: "dice",
                  expr: "1d20",
                  rolls: [entry.die],
                  kept: [entry.die],
                  total: entry.die,
                },
              ],
        seedClient: null,
        seedHost: null,
        commit: null,
      },
      flavor: "",
    };
  }
}

function input(
  queued: PF1eInterrupt[],
  overrides: Partial<MovementAooResolutionInput> = {},
): MovementAooResolutionInput {
  return {
    opportunity: opportunity(queued),
    combat: combat([
      combatant("c-fighter", "t-fighter", "fighter", 20, {
        aooUsed: 0,
        aooMax: 1,
        acted: true,
      }),
      combatant("c-goblin", "t-goblin", "goblin", 10, { acted: true }),
    ]),
    actors: [fighter(), goblin()],
    tokens,
    ...overrides,
  };
}

describe("aooSettings — the auto-resolve world option (D-186)", () => {
  test("defaults to on, is off only when the world says so, and reports authorship", () => {
    expect(autoResolveAoosOf({})).toBe(true);
    expect(autoResolveAoosOf({ autoResolveAoos: true })).toBe(true);
    expect(autoResolveAoosOf({ autoResolveAoos: false })).toBe(false);
    // A non-boolean is not a decision: it reads as the default rather than disabling.
    expect(autoResolveAoosOf({ autoResolveAoos: "no" })).toBe(true);
    expect(autoResolveAoosIsAuthored({})).toBe(false);
    expect(autoResolveAoosIsAuthored({ autoResolveAoos: false })).toBe(true);
  });
});

describe("resolveMovementOpportunities — the auto-resolved attack of opportunity (D-186)", () => {
  test("a hit rolls through the sheet's flow, spends the ledger, and reports its line", async () => {
    const client = new FakeClient();
    // 11 + 9 = 20 vs AC 16 hits; the mundane longsword eats DR 5/magic: 7 − 5 = 2.
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const resolution = await resolveMovementOpportunities(
      client,
      gm,
      input([interrupt(0, "t-fighter")]),
    );
    expect(resolution).toMatchObject({
      needsEncounter: false,
      error: null,
      skipped: [],
      entries: [
        {
          reactorId: "t-fighter",
          provokerId: "t-goblin",
          square: { x: 200, y: 0 },
          combatantId: "c-fighter",
          attackName: "Longsword — attack of opportunity",
          outcome: "hit",
          attackTotal: 20,
          defenseAc: 16,
          damage: 2,
          hpBefore: 12,
          hpAfter: 10,
          used: 1,
          max: 1,
          ledgerError: null,
        },
      ],
    });
    expect(resolution.entries[0]?.line).toBe(
      "Fighter hits Goblin for 2 (20 vs AC 16) — 1/1 opportunities this round",
    );
    // The attack card, the HP write, then the ledger: the target's HP moves before the
    // budget is spent, and the budget is spent once.
    expect(client.submitted).toHaveLength(3);
    expect(client.submitted[0]?.[0]).toMatchObject({ kind: "create" });
    expect(client.submitted[1]?.[0]).toMatchObject({
      kind: "update",
      ref: { coll: "actors", id: "goblin" },
      diff: { "system.pf1e.hp": 10 },
    });
    expect(client.submitted[2]?.[0]).toMatchObject({
      kind: "update",
      ref: { coll: "combats", id: "combat" },
    });
    const ledger = client.submitted[2]?.[0];
    if (ledger?.kind !== "update") throw new Error("expected a ledger update");
    // The panel's own shape: the whole combatant array under one `combats` update.
    const combatants = (
      ledger.diff as { combatants: Array<{ _id: string; flags: unknown }> }
    ).combatants;
    expect(combatants.find((c) => c._id === "c-fighter")?.flags).toMatchObject({
      pf1e: { aooUsed: 1, aooMax: 1 },
    });
    const card = client.submitted[0]?.[0];
    if (card?.kind !== "create") throw new Error("expected a create op");
    const data = card.data as MessageDocument;
    expect(data.content).toContain("hits.");
    expect(data.content).toContain("DR absorbed 5");
  });

  test("a miss still spends the opportunity: reacting is the cost, not connecting", async () => {
    const client = new FakeClient();
    client.script = [{ die: 1, total: 5 }];
    const resolution = await resolveMovementOpportunities(
      client,
      gm,
      input([interrupt(0, "t-fighter")]),
    );
    const entry = resolution.entries[0];
    expect(entry).toMatchObject({
      outcome: "miss",
      damage: 0,
      hpBefore: 12,
      hpAfter: 12,
      used: 1,
      max: 1,
    });
    // The flow recomputes the total from the die face and the derived bonus (1 + 9),
    // which is exactly the number the card shows.
    expect(entry?.line).toBe(
      "Fighter misses Goblin for 0 (10 vs AC 16) — 1/1 opportunities this round",
    );
    // No damage roll on a miss: the attack die, the card, the hp no-op is still written
    // (the flow's own contract) and the ledger.
    expect(client.formulas).toEqual(["1d20 + 9"]);
  });

  test("an exhausted ledger reports the seat's reason and leaves the budget alone", async () => {
    const client = new FakeClient();
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const fixture = input([interrupt(0, "t-fighter")]);
    fixture.combat = combat([
      combatant("c-fighter", "t-fighter", "fighter", 20, {
        aooUsed: 1,
        aooMax: 1,
        acted: true,
      }),
      combatant("c-goblin", "t-goblin", "goblin", 10, { acted: true }),
    ]);
    const resolution = await resolveMovementOpportunities(client, gm, fixture);
    const entry = resolution.entries[0];
    expect(entry?.outcome).toBe("hit");
    expect(entry?.ledgerError).toBe(
      "Attack of opportunity refused: no opportunities left (1/1).",
    );
    expect(entry?.used).toBeNull();
    expect(entry?.line).toContain("the ledger was not written:");
    // The attack still happened — the queue said the reaction was available.
    expect(client.submitted).toHaveLength(2);
  });

  test("a reactor that is not a combatant resolves the attack but cannot spend", async () => {
    const client = new FakeClient();
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const fixture = input([interrupt(0, "t-fighter")]);
    fixture.combat = combat([
      combatant("c-goblin", "t-goblin", "goblin", 10, { acted: true }),
    ]);
    const resolution = await resolveMovementOpportunities(client, gm, fixture);
    expect(resolution.entries[0]?.ledgerError).toBe(
      "the reacting token is not a combatant in this encounter",
    );
    expect(resolution.entries[0]?.used).toBeNull();
  });

  test("no encounter means no auto-resolution, and the caller is told why", async () => {
    const client = new FakeClient();
    const resolution = await resolveMovementOpportunities(
      client,
      gm,
      input([interrupt(0, "t-fighter")], { combat: null }),
    );
    expect(resolution.needsEncounter).toBe(true);
    expect(resolution.entries).toHaveLength(0);
    expect(resolution.skipped).toEqual([
      {
        reactorId: "t-fighter",
        provokerId: "t-goblin",
        reason: "no encounter — the AoO budget is per round and per combatant",
      },
    ]);
    // Nothing was rolled and nothing was submitted: the table keeps the decision.
    expect(client.submitted).toHaveLength(0);
    expect(client.formulas).toEqual([]);
  });

  test("a ranged-only reactor skips the opportunity without spending it", async () => {
    const client = new FakeClient();
    const fixture = input([interrupt(0, "t-fighter")]);
    fixture.actors = [
      fighter({
        attacks: [
          {
            name: "Longbow",
            ranged: true,
            damageDice: "1d8",
            damageBonus: 3,
            damageType: "piercing",
            critThreatMin: 20,
            critMultiplier: 3,
          },
        ],
      }),
      goblin(),
    ];
    const resolution = await resolveMovementOpportunities(client, gm, fixture);
    expect(resolution.entries).toHaveLength(0);
    expect(resolution.skipped[0]?.reason).toContain("no melee attack line");
    expect(client.submitted).toHaveLength(0);
    // The budget is not spent for an attack that was never made.
    expect(client.formulas).toEqual([]);
  });

  test("reactions resolve in initiative order, not the queue's insertion order", async () => {
    const client = new FakeClient();
    client.script = [
      { die: 11, total: 20 },
      { total: 7 },
      { die: 11, total: 20 },
      { total: 7 },
    ];
    const fixture = input([interrupt(0, "t-slow"), interrupt(1, "t-fast")]);
    fixture.tokens = [
      ...tokens,
      { _id: "t-slow", actorId: "slow" },
      { _id: "t-fast", actorId: "fast" },
    ];
    fixture.actors = [
      fighter(),
      goblin(),
      { ...fighter(), _id: "slow", name: "Slow" },
      { ...fighter(), _id: "fast", name: "Fast" },
    ];
    fixture.combat = combat([
      combatant("c-fast", "t-fast", "fast", 20, {
        aooUsed: 0,
        aooMax: 1,
        acted: true,
      }),
      combatant("c-slow", "t-slow", "slow", 5, {
        aooUsed: 0,
        aooMax: 1,
        acted: true,
      }),
      combatant("c-goblin", "t-goblin", "goblin", 10, { acted: true }),
    ]);
    const resolution = await resolveMovementOpportunities(client, gm, fixture);
    expect(resolution.entries.map((e) => e.reactorId)).toEqual([
      "t-fast",
      "t-slow",
    ]);
  });

  test("a provoker that has not acted yet is attacked flat-footed", async () => {
    const client = new FakeClient();
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const fixture = input([interrupt(0, "t-fighter")]);
    fixture.combat = combat([
      combatant("c-fighter", "t-fighter", "fighter", 20, {
        aooUsed: 0,
        aooMax: 1,
        acted: true,
      }),
      // `acted: false` in a running round ⇒ flat-footed (A.1), so AC 14, not 16.
      combatant("c-goblin", "t-goblin", "goblin", 10, { acted: false }),
    ]);
    const resolution = await resolveMovementOpportunities(client, gm, fixture);
    expect(resolution.entries[0]).toMatchObject({
      outcome: "hit",
      defenseAc: 14,
    });
  });

  test("an empty queue resolves nothing at all", async () => {
    const client = new FakeClient();
    const resolution = await resolveMovementOpportunities(
      client,
      gm,
      input([]),
    );
    expect(resolution).toEqual({
      entries: [],
      skipped: [],
      needsEncounter: false,
      error: null,
    });
    expect(client.submitted).toHaveLength(0);
  });

  test("the Verify option routes the rolls through the commit-reveal path", async () => {
    const client = new FakeClient();
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const resolution = await resolveMovementOpportunities(
      client,
      gm,
      input([interrupt(0, "t-fighter")], { verifiable: true }),
    );
    expect(resolution.entries).toHaveLength(1);
    expect(client.verifiedRolls).toBe(2);
  });

  test("a token with no actor document is skipped with its reason, never dropped", async () => {
    const client = new FakeClient();
    const fixture = input([interrupt(0, "t-ghost")]);
    fixture.tokens = [...tokens, { _id: "t-ghost", actorId: null }];
    const resolution = await resolveMovementOpportunities(client, gm, fixture);
    expect(resolution.entries).toHaveLength(0);
    expect(resolution.skipped[0]).toEqual({
      reactorId: "t-ghost",
      provokerId: "t-goblin",
      reason:
        "the reacting token has no actor document to derive an attack from",
    });
    expect(client.submitted).toHaveLength(0);
  });

  test("a resolver without permission still reports the attack it could not write", async () => {
    const client = new FakeClient();
    client.script = [{ die: 11, total: 20 }, { total: 7 }];
    const fixture = input([interrupt(0, "t-fighter")]);
    // A player owns neither the provoker (LIMITED) nor the encounter (LIMITED).
    fixture.actors = [fighter(), { ...goblin(), ownership: { default: 1 } }];
    fixture.combat = {
      ...(fixture.combat as CombatDocument),
      ownership: { default: 1 },
    };
    const resolution = await resolveMovementOpportunities(
      client,
      nobody,
      fixture,
    );
    // The roll and the card are the sheet's own path; a refused HP write is reported
    // rather than swallowed, and the ledger refusal names its own reason.
    expect(resolution.error).not.toBeNull();
    expect(resolution.entries[0]?.hpWriteError).not.toBeNull();
    expect(resolution.entries[0]?.ledgerError).toBe(
      "You cannot update this encounter.",
    );
    const card = client.submitted[0]?.[0];
    if (card?.kind !== "create") throw new Error("expected a create op");
    expect((card.data as MessageDocument).content).toContain(
      "HP write rejected",
    );
  });
});

describe("planHeldMove — who resolves the queue (D-186)", () => {
  test("on with an encounter: the app holds the move and resolves, so nothing is reported yet", () => {
    const plan = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: true,
      hasEncounter: true,
    });
    expect(plan).toEqual({
      mode: "auto",
      autoResolve: true,
      lines: [],
      busyReason: null,
    });
  });

  test("off with an encounter: the move is held and the table is asked (D-187)", () => {
    const plan = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: false,
      hasEncounter: true,
      hostilityAssumed: true,
    });
    // The prompt carries the seam's lines per reactor, so nothing is reported yet.
    expect(plan).toEqual({
      mode: "prompt",
      autoResolve: false,
      lines: [],
      busyReason: null,
    });
  });

  test("off with no encounter: the queue is reported, since nothing could be spent", () => {
    const withAssumption = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: false,
      hasEncounter: false,
      hostilityAssumed: true,
    });
    expect(withAssumption.mode).toBe("report");
    expect(withAssumption.autoResolve).toBe(false);
    expect(withAssumption.lines).toEqual([
      "fighter may strike goblin as it leaves (2,0)",
      "(hostility assumed — tokens without a disposition)",
    ]);
    // With hostility stated the assumption line is absent, never implied.
    const stated = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: false,
      hasEncounter: false,
    });
    expect(stated.lines).toEqual([
      "fighter may strike goblin as it leaves (2,0)",
    ]);
  });

  test("on with no encounter cannot auto-resolve, and says so instead of going quiet", () => {
    const plan = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: true,
      hasEncounter: false,
    });
    expect(plan.mode).toBe("report");
    expect(plan.autoResolve).toBe(false);
    expect(plan.lines).toEqual([
      "fighter may strike goblin as it leaves (2,0)",
      "(no encounter — the AoO budget is per round and per combatant, so these were left to the table)",
    ]);
  });
});

describe("planHeldMove — one decision at a time (D-188)", () => {
  test("a second provoking move while a prompt is open is refused, not silently replaced", () => {
    const plan = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: false,
      hasEncounter: true,
      held: "prompt",
    });
    expect(plan.mode).toBe("busy");
    expect(plan.autoResolve).toBe(false);
    expect(plan.busyReason).toBe(
      "an attack of opportunity is already pending — answer it before another move provokes",
    );
    expect(plan.lines).toEqual([plan.busyReason]);
  });

  test("a second provoking move while an auto-resolution is in flight is refused too", () => {
    const plan = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: true,
      hasEncounter: true,
      held: "resolving",
    });
    expect(plan.mode).toBe("busy");
    expect(plan.busyReason).toBe(
      "an attack of opportunity is already being resolved — try the move again when it is done",
    );
  });

  test("the guard also refuses a would-be auto move while a prompt is open", () => {
    // The world option could have been flipped on between the prompt opening and the second
    // drag; the seam is still busy either way, so the second move is refused.
    const plan = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: true,
      hasEncounter: true,
      held: "prompt",
    });
    expect(plan.mode).toBe("busy");
    expect(plan.busyReason).toContain("already pending");
  });

  test("a move that only reports (no encounter) is not refused while a decision is open", () => {
    // With no encounter to spend against there is nothing to hold or lose, so the move
    // proceeds as a report exactly as before D-188.
    const plan = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: false,
      hasEncounter: false,
      held: "prompt",
    });
    expect(plan.mode).toBe("report");
    expect(plan.busyReason).toBeNull();
  });

  test("an idle seam (no held state) never reports busy", () => {
    const plan = planHeldMove({
      opportunity: opportunity([interrupt(0, "t-fighter")]),
      autoResolve: false,
      hasEncounter: true,
      held: null,
    });
    expect(plan.mode).toBe("prompt");
    expect(plan.busyReason).toBeNull();
  });
});

describe("resolutionLines — what the log shows for a resolved queue (D-186)", () => {
  test("entries, skips and the caller's assumption, in that order", () => {
    const lines = resolutionLines(
      {
        entries: [
          {
            reactorId: "t-fighter",
            provokerId: "t-goblin",
            square: null,
            combatantId: "c-fighter",
            attackName: "Longsword — attack of opportunity",
            outcome: "hit",
            attackTotal: 20,
            defenseAc: 16,
            damage: 2,
            ledgerError: null,
            hpWriteError: null,
            used: 1,
            max: 1,
            hpBefore: 12,
            hpAfter: 10,
            line: "Fighter hits Goblin for 2 (20 vs AC 16) — 1/1 opportunities this round",
          },
        ],
        skipped: [
          {
            reactorId: "t-archer",
            provokerId: "t-goblin",
            reason: "no melee attack line — …",
          },
        ],
        needsEncounter: false,
        error: null,
      },
      { hostilityAssumed: true },
    );
    expect(lines).toEqual([
      "Fighter hits Goblin for 2 (20 vs AC 16) — 1/1 opportunities this round",
      "t-archer forgoes the attack of opportunity — no melee attack line — …",
      "(hostility assumed — tokens without a disposition)",
    ]);
  });
});
