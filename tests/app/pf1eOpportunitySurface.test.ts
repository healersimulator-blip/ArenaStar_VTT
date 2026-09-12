import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { installE2eHook, type AppSurface } from "../../src/app/e2eHook";
import { IDBFactory } from "fake-indexeddb";
import { boot, settle } from "./fakes";
import {
  decideReactor,
  isSettled,
  openReaction,
  opportunityForReactor,
  pendingRows,
} from "../../src/ui/combat/pf1eReactionPrompt";
import { resolveMovementOpportunities } from "../../src/ui/combat/pf1eAooFlow";

/**
 * P06/D-185 — the app surface `e2e/pf1e_opportunity.spec.ts` drives, exercised here against
 * a real booted `HostApp`. `pf1ePlaceTokens` and `pf1eMoveToken` submit **real ops**
 * (`create`/`update` on `tokens` through `gm.client.submit`), and `pf1eOpportunity` resolves
 * the resulting scene through the pure seam, reading each creature's size back off its
 * authored actor document. Same code path as the browser spec minus the bundle.
 *
 * The scene is the tactical convention this codebase already uses: 100 world units per
 * square, 5 ft per square, a token's `x`/`y` is its centre.
 */
async function surface(): Promise<{
  app: Awaited<ReturnType<typeof boot>>;
  s: AppSurface;
}> {
  // A pristine IDB per test: `bootHostApp` without a world id resumes the most recent world.
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  const app = await boot();
  await installE2eHook(app);
  const s = (globalThis as { __vttE2E?: { app: AppSurface | null } }).__vttE2E
    ?.app;
  if (!s) throw new Error("app surface missing");
  return { app, s };
}

type Placed = Array<{ id: string; col: number; row: number; size?: string }>;

async function surfaceWith(tokens: Placed) {
  const booted = await surface();
  const placed = booted.s.pf1ePlaceTokens(tokens);
  expect(placed.ok).toBe(true);
  await settle(6);
  expect(booted.s.tokenCount()).toBe(tokens.length);
  return booted;
}

describe("P06 — the tactical opportunity surface on a real booted host app", () => {
  test("a move lands through the op path, and the next leg's verdict comes from the live scene", async () => {
    const { s } = await surfaceWith([
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);

    // The token really moves: a real `tokens` update op, snapped to the grid, centre first.
    const moved = s.pf1eMoveToken({ tokenId: "goblin", col: 1, row: 0 });
    expect(moved.ok).toBe(true);
    expect(moved.x).toBe(150);
    expect(moved.y).toBe(50);
    await settle(6);
    expect(s.tokenPos()).toEqual({ x: 150, y: 50 });

    // …and the verdict for the *next* leg is read off that new position: (1,0) → (4,0)
    // leaves (1,0), (2,0) and (3,0). The fighter at (3,1) is adjacent to (2,0) and (3,0)
    // but two squares from (1,0), so the queue records (2,0) — the first square left that
    // it threatens, which is where the attack happens.
    const res = s.pf1eOpportunity({
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(res.ok).toBe(true);
    expect(res.refusal).toBeNull();
    expect(res.path).toEqual(["1,0", "2,0", "3,0", "4,0"]);
    expect(res.squaresLeft).toEqual(["1,0", "2,0", "3,0"]);
    expect(res.leftRects).toBe(3);
    expect(res.queued).toEqual([
      {
        reactorId: "fighter",
        provokerId: "goblin",
        kind: "move-out",
        square: { x: 200, y: 0 },
      },
    ]);
    expect(res.reactors[0]?.cell).toBe("2,0");
    expect(res.defaults).toEqual([]); // hostility stated: no assumption reported
  });

  test("the verdict is computed for the move that is about to happen, not the one committed", async () => {
    const { s } = await surfaceWith([
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);
    // Asked before any move: the token is still at (0,0), and the verdict names the walk
    // to (3,0) — which is what lets a caller decide before the Op commits.
    const res = s.pf1eOpportunity({
      moverId: "goblin",
      toCol: 3,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(res.queued).toHaveLength(1);
    expect(s.tokenPos()).toEqual({ x: 50, y: 50 }); // the token never moved
  });

  test("an exhausted ledger refuses, and a withdraw exempts the start square", async () => {
    const { s } = await surfaceWith([
      { id: "wizard", col: 0, row: 0 },
      { id: "west", col: -1, row: 0 },
    ]);

    const normal = s.pf1eOpportunity({
      moverId: "wizard",
      toCol: 2,
      toRow: 0,
      enemiesOf: { wizard: ["west"] },
    });
    expect(normal.queued.map((q) => q.reactorId)).toEqual(["west"]);

    const withdrawing = s.pf1eOpportunity({
      moverId: "wizard",
      toCol: 2,
      toRow: 0,
      withdraw: true,
      enemiesOf: { wizard: ["west"] },
    });
    expect(withdrawing.squaresLeft).toEqual(["1,0"]);
    expect(withdrawing.queued).toEqual([]);

    const spent = s.pf1eOpportunity({
      moverId: "wizard",
      toCol: 2,
      toRow: 0,
      ledgers: { west: { used: 1, max: 1 } },
      enemiesOf: { wizard: ["west"] },
    });
    expect(spent.queued).toEqual([]);
    expect(spent.refused).toEqual([
      { tokenId: "west", reason: "no opportunities left (1/1)" },
    ]);
    expect(spent.reactors[0]?.line).toContain(
      "forgoes the attack of opportunity",
    );
  });

  test("creature size comes from the authored actor document, so reach decides the queue", async () => {
    // The same walk and the same square for both creatures: a 2-square reach reaches (2,0)
    // from (4,0), a Medium creature's 1-square reach does not — so the fixture discriminates
    // on the *authored size*, which the surface reads back off the actor document.
    const walk = { moverId: "goblin", toCol: 3, toRow: 0 } as const;

    const medium = await surfaceWith([
      { id: "goblin", col: 0, row: 0 },
      { id: "guard", col: 4, row: 0, size: "Medium" },
    ]);
    const medRes = medium.s.pf1eOpportunity({
      ...walk,
      enemiesOf: { goblin: ["guard"] },
    });
    expect(medRes.squaresLeft).toEqual(["0,0", "1,0", "2,0"]);
    expect(medRes.queued).toEqual([]);

    const large = await surfaceWith([
      { id: "goblin", col: 0, row: 0 },
      { id: "ogre", col: 4, row: 0, size: "Large" },
    ]);
    const largeRes = large.s.pf1eOpportunity({
      ...walk,
      enemiesOf: { goblin: ["ogre"] },
    });
    expect(largeRes.queued.map((q) => q.reactorId)).toEqual(["ogre"]);
    expect(largeRes.reactors[0]?.cell).toBe("2,0");
  });

  test("a missing mover refuses by name rather than queueing nothing silently", async () => {
    const { s } = await surfaceWith([{ id: "goblin", col: 0, row: 0 }]);
    const res = s.pf1eOpportunity({ moverId: "ghost", toCol: 2, toRow: 0 });
    expect(res.ok).toBe(false);
    expect(res.refusal).toBe('no token "ghost" on this scene');
    expect(res.queued).toEqual([]);
  });
});

/**
 * D-186: an encounter on the scene, with both tokens linked as combatants. Authored here
 * rather than through a surface because the encounter is what the auto-resolution spends
 * against — the surface under test is `pf1eOpportunityResolve`, not encounter creation.
 */
function encounterOps(sceneId: string, tokens: ReadonlyArray<{ id: string }>) {
  return [
    {
      kind: "create" as const,
      coll: "combats" as const,
      data: {
        _id: "combat-1",
        type: "combat" as const,
        name: "Fight",
        ownership: { default: 3 },
        flags: {
          core: { sceneId },
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
        round: 1,
        turn: 0,
        combatants: tokens.map((t, i) => ({
          _id: `c-${t.id}`,
          type: "combatant" as const,
          name: t.id,
          ownership: { default: 3 },
          // `acted: true` on both: nobody is structurally flat-footed, so the defense
          // choice in the resolution comes from the encounter, not from the fixture.
          flags: { pf1e: { acted: true, aooUsed: 0, aooMax: 1 } },
          system: {},
          tokenId: t.id,
          actorId: `a-${t.id}`,
          initiative: 20 - i * 10,
          hidden: false,
          defeated: false,
        })),
      } as unknown as import("../../src/core/documents").CombatDocument,
    },
    {
      kind: "update" as const,
      ref: { coll: "scenes" as const, id: sceneId },
      diff: { "flags.core": { activeCombatId: "combat-1" } },
    },
  ];
}

/** The authored combat stats the auto-resolution needs: a melee line and hit points. */
const FIGHTER_STATS = {
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
      critThreatMin: 20,
      critMultiplier: 2,
    },
  ],
};

const GOBLIN_STATS = {
  abilities: { dex: 14, con: 12 },
  hp: 12,
  hpMax: 12,
  armorClass: { armor: 4 },
};

/** The scene's tokens, as the flow's token→actor lookup expects them. */
function sceneTokens(app: Awaited<ReturnType<typeof boot>>) {
  const scenes = app.gm.client.store.getAll("scenes");
  const scene = scenes.find((s) => s.active) ?? scenes[0] ?? null;
  return scene?.tokens ?? [];
}

/** A combatant's spent-AoO counter, read off the store after its ops echoed. */
function combatantAooUsed(
  app: Awaited<ReturnType<typeof boot>>,
  tokenId: string,
): number | null {
  const combat = app.gm.client.store.getAll("combats")[0] ?? null;
  const combatant =
    combat?.combatants.find((c) => c.tokenId === tokenId) ?? null;
  const flags = combatant?.flags as { pf1e?: { aooUsed?: number } } | undefined;
  return flags?.pf1e?.aooUsed ?? null;
}

describe("P06 — the auto-resolved attack of opportunity on a real booted host app (D-186)", () => {
  test("the pipeline rolls through the host, writes hp, and spends the ledger", async () => {
    const { app, s } = await surfaceWith([
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);
    // Author the two creatures' stats as real ops (the placement surface only authors size).
    app.gm.client.submit([
      {
        kind: "update",
        ref: { coll: "actors", id: "a-fighter" },
        diff: { "system.pf1e": FIGHTER_STATS },
      },
      {
        kind: "update",
        ref: { coll: "actors", id: "a-goblin" },
        diff: { "system.pf1e": GOBLIN_STATS },
      },
    ]);
    const sceneId = s.activeSceneId();
    if (sceneId === null) throw new Error("no active scene");
    app.gm.client.submit(
      encounterOps(sceneId, [{ id: "goblin" }, { id: "fighter" }]),
    );
    await settle(8);

    // The walk (0,0) → (4,0) leaves (0,0)…(3,0); the fighter at (3,1) threatens (2,0).
    const res = await s.pf1eOpportunityResolve({
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(res.needsEncounter).toBe(false);
    expect(res.error).toBeNull();
    expect(res.queued).toEqual([
      {
        reactorId: "fighter",
        provokerId: "goblin",
        kind: "move-out",
        square: { x: 200, y: 0 },
      },
    ]);
    expect(res.entries).toHaveLength(1);
    const entry = res.entries[0];
    expect(entry).toMatchObject({
      reactorId: "fighter",
      provokerId: "goblin",
      attackName: "Longsword — attack of opportunity",
      defenseAc: 16,
      used: 1,
      max: 1,
      ledgerError: null,
    });
    // Real host rolls: the outcome and the damage are not scripted here, so the fixture
    // asserts what the rules fix and not a face — the hit points never rise, and the
    // ledger is written whatever the die said.
    expect(entry?.hpBefore).toBe(12);
    expect(entry?.hpAfter).toBeLessThanOrEqual(12);
    // The damage the card reports is exactly the hit points the write took off — the
    // invariant that makes the two halves of the flow one resolution.
    expect(entry?.damage).toBe((entry?.hpBefore ?? 0) - (entry?.hpAfter ?? 0));
    // The placement surface names its actors "<token id> (actor)", so the line reads
    // with those names; what matters here is that it names both creatures and the budget.
    expect(entry?.line).toContain("fighter (actor)");
    expect(entry?.line).toContain("goblin (actor)");
    expect(entry?.line).toContain("1/1 opportunities this round");

    // The ledger landed as a real op on the encounter document…
    const combat = app.gm.client.store.get("combats", "combat-1");
    const fighterCombatant = combat?.combatants.find(
      (c) => c.tokenId === "fighter",
    );
    expect(
      (fighterCombatant?.flags as { pf1e?: { aooUsed?: number } } | undefined)
        ?.pf1e?.aooUsed,
    ).toBe(1);
    // …and the public card is the sheet's own card, labelled with the opportunity.
    const cards = app.gm.client.store
      .getAll("messages")
      .filter((m) => typeof m.content === "string");
    expect(
      cards.some((m) => String(m.content).includes("attack of opportunity")),
    ).toBe(true);
  });

  test("the manual prompt resolves one reactor at a time, and only that ledger moves (D-187)", async () => {
    const { app, s } = await surfaceWith([
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
      { id: "guard", col: 0, row: 1 },
    ]);
    app.gm.client.submit([
      {
        kind: "update",
        ref: { coll: "actors", id: "a-fighter" },
        diff: { "system.pf1e": FIGHTER_STATS },
      },
      {
        kind: "update",
        ref: { coll: "actors", id: "a-guard" },
        diff: { "system.pf1e": FIGHTER_STATS },
      },
      {
        kind: "update",
        ref: { coll: "actors", id: "a-goblin" },
        diff: { "system.pf1e": GOBLIN_STATS },
      },
    ]);
    const sceneId = s.activeSceneId();
    if (sceneId === null) throw new Error("no active scene");
    app.gm.client.submit(
      encounterOps(sceneId, [
        { id: "goblin" },
        { id: "fighter" },
        { id: "guard" },
      ]),
    );
    await settle(8);

    const verdict = s.pf1eOpportunity({
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["fighter", "guard"] },
    });
    expect(verdict.queued.map((q) => q.reactorId).sort()).toEqual([
      "fighter",
      "guard",
    ]);

    // The prompt holds the move and asks per reactor; `opportunityForReactor` is what one
    // "Strike" answers. The *first* strike must not touch the second creature's budget.
    const pending = openReaction({
      sceneId,
      opportunity: verdict.result,
      combatId: "combat-1",
    });
    const first = await resolveMovementOpportunities(
      app.gm.client,
      app.gm.client.user,
      {
        opportunity: opportunityForReactor(pending, "fighter"),
        combat: app.gm.client.store.get("combats", "combat-1") ?? null,
        actors: app.gm.client.store.getAll("actors"),
        tokens: sceneTokens(app),
      },
    );
    await settle(6);
    expect(first.entries.map((e) => e.reactorId)).toEqual(["fighter"]);
    expect(first.entries[0]?.used).toBe(1);
    expect(combatantAooUsed(app, "fighter")).toBe(1);
    expect(combatantAooUsed(app, "guard")).toBe(0);

    // The second row: its own attack, against the hit points the first one left behind —
    // two real resolutions through the same flow, one prompt.
    const second = await resolveMovementOpportunities(
      app.gm.client,
      app.gm.client.user,
      {
        opportunity: opportunityForReactor(pending, "guard"),
        combat: app.gm.client.store.get("combats", "combat-1") ?? null,
        actors: app.gm.client.store.getAll("actors"),
        tokens: sceneTokens(app),
      },
    );
    await settle(6);
    expect(second.entries.map((e) => e.reactorId)).toEqual(["guard"]);
    expect(combatantAooUsed(app, "guard")).toBe(1);
    expect(second.entries[0]?.hpBefore).toBe(first.entries[0]?.hpAfter);

    // And the state machine settles only when both rows are answered.
    const answered = decideReactor(decideReactor(pending, "fighter"), "guard");
    expect(isSettled(answered)).toBe(true);
    expect(pendingRows(answered)).toEqual([]);
  });

  test("with no encounter there is nothing to spend, and the caller is told", async () => {
    const { s } = await surfaceWith([
      { id: "goblin", col: 0, row: 0 },
      { id: "fighter", col: 3, row: 1 },
    ]);
    const res = await s.pf1eOpportunityResolve({
      moverId: "goblin",
      toCol: 4,
      toRow: 0,
      enemiesOf: { goblin: ["fighter"] },
    });
    expect(res.needsEncounter).toBe(true);
    expect(res.entries).toEqual([]);
    expect(res.skipped[0]?.reason).toContain("no encounter");
  });
});
