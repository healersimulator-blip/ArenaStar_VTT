/** Characterization of the checked-in standalone reference, NOT the production hosted engine. */
import { test, expect } from "@playwright/test";
const url = new URL("../Examples/combat_resolver_5.html", import.meta.url).href;
test.beforeEach(async ({ page }) => {
  await page.goto(url);
  await expect(page.getByText(/^Init error:/)).toHaveCount(0);
});
// The reference owns these globals. Invoke its actual functions on a fresh seeded battle, not a reimplementation.
const prepare = `
    S.rules.baseTouch = true;
    const cfg = buildConfig();
    cfg.armies.forEach((a) => {
      a.units = a.units.slice(0, 1);
      Object.assign(a.units[0], { count: 9, front: 3, spacing: 5, rot: 0, mounted: false });
    });
    const b = createBattle(cfg, 17, true),
      ru = b.units[0];
  `;
test("reference: a casualty advances only its own file; a reform order spends half anchor speed", async ({
  page,
}) => {
  const slots = await page.evaluate(
    `
    (() => {
      ${prepare}
      ru.soldiers[0].dead = true;
      return [3, 4, 6, 7].map((i) => {
        const t = effectiveSlot(ru, ru.soldiers[i]);
        return [t.targetF, t.targetL];
      });
    })();
  `,
  );
  expect(slots).toEqual([
    [0, 0],
    [1, 1],
    [0, 1],
    [1, 2],
  ]);
  const stride = await page.evaluate(
    `
    [false, true].map((reform) => {
      ${prepare}
      b.round = 1;
      ru.cfg.p.spd = 30;
      ru.cfg.reform = reform;
      const { x, y } = ru.anchor;
      ru.cfg.cmd = { type: "move", tx: x + 100, ty: y };
      moveUnits(b, ru.army);
      return Math.hypot(ru.anchor.x - x, ru.anchor.y - y);
    });
  `,
  );
  expect(stride).toEqual([30, 15]);
});
for (const kind of ["blackTentacles", "burningEntanglement"])
  test(`reference: ordered anchor avoids a live ${kind} burst, then crosses its old footprint after expiry`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      `
    [true, false].map((active) => {
      ${prepare}
      b.round = 1;
      ru.cfg.p.spd = 30;
      ru.cfg.reform = false;
      const { x, y } = ru.anchor;
      ru.cfg.cmd = { type: "move", tx: x + 100, ty: y };
      const ar = { shape: "burst", type: ${JSON.stringify(kind)}, active, r: 8, x: x + 30, y };
      b.areas = [ar];
      moveUnits(b, ru.army);
      return {
        inside: inArea(ar, ru.anchor.x, ru.anchor.y),
        steered: Math.abs(ru.anchor.y - y) > 1,
        advanced: ru.anchor.x > x,
      };
    });
  `,
    );
    expect(result).toEqual([
      { inside: false, steered: true, advanced: true },
      { inside: true, steered: false, advanced: true },
    ]);
  });
test("reference: a model skirts a live burst along its traced path, and returns to a previously blocked goal after expiry", async ({
  page,
}) => {
  const observed = await page.evaluate(`
    (() => {
      ${prepare}
      const s = ru.soldiers[0];
      b.soldiers = [s];
      s.x = 30;
      s.y = 50;
      rebuildOcc(b);
      rebuildGrid(b);
      const ar = { shape: "burst", type: "blackTentacles", active: true, r: 8, x: 60, y: 50 };
      b.areas = [ar];
      s.trail = [];
      for (let i = 0; i < 8 && Math.hypot(s.x - 95, s.y - 50) > 2.5; i++)
        moveAvoidingHarm(b, s, 95, 50, 15, null, false);
      const crossed = s.trail.some((p) => inArea(ar, p.x, p.y)),
        arrived = Math.hypot(s.x - 95, s.y - 50) <= 2.5;
      const rim = clampTargetOutOfHarm(b, ar.x + 2, ar.y);
      ar.active = false;
      const released = clampTargetOutOfHarm(b, ar.x + 2, ar.y);
      for (let i = 0; i < 5 && Math.hypot(s.x - released.x, s.y - released.y) > 2.5; i++)
        moveAvoidingHarm(b, s, released.x, released.y, 15, null, false);
      return {
        crossed,
        arrived,
        rimOutside: !inArea(ar, rim.x, rim.y),
        returned: Math.hypot(s.x - released.x, s.y - released.y) <= 2.5,
      };
    })();
  `);
  expect(observed).toEqual({
    crossed: false,
    arrived: true,
    rimOutside: true,
    returned: true,
  });
});

test("reference: a goal at the centre of a live burst clamps outside it", async ({
  page,
}) => {
  const goals = await page.evaluate(
    `
    (() => {
      const ar = { shape: "burst", type: "blackTentacles", active: true, r: 8, x: 60, y: 50 };
      const next = {...ar,x:74,type:"burningEntanglement"};
      return [[ar], [ar,next], [ar,{...next,active:false}]].map(areas=>clampTargetOutOfHarm({areas},60,50));
    })();
  `,
  );
  expect(goals).toEqual([
    { x: 74, y: 50 },
    { x: 88, y: 50 },
    { x: 74, y: 50 },
  ]);
});

test("reference: during an ordered reform the next rank physically occupies the vacated front file", async ({
  page,
}) => {
  const outcome = await page.evaluate<{
    advanced: boolean;
    file: number;
    rank: number;
    promotionGap: number;
  }>(`
    (() => {
      ${prepare}
      const front = ru.soldiers[1],
        promoted = ru.soldiers[4];
      front.dead = true;
      front.hp = 0;
      ru.cfg.reform = true;
      ru.cfg.cmd = { type: "move", tx: ru.anchor.x + 100, ty: ru.anchor.y };
      const prior = { x: promoted.x, y: promoted.y };
      stepRound(b);
      const desired = effectiveSlotPos(b, promoted);
      return {
        advanced: promoted.x > prior.x,
        promotionGap: Math.hypot(promoted.x - desired.x, promoted.y - desired.y),
        file: effectiveSlot(ru, promoted).targetF,
        rank: effectiveSlot(ru, promoted).targetL,
      };
    })();
  `);
  expect(outcome.advanced).toBe(true);
  expect(outcome.file).toBe(1);
  expect(outcome.rank).toBe(0);
  expect(outcome.promotionGap).toBeLessThanOrEqual(2.5);
});

test("reference: steering checks the swept path even when both endpoints are clear", async ({
  page,
}) => {
  const path = await page.evaluate<{
    beganInside: boolean;
    endedInside: boolean;
    crossed: boolean;
    progressed: boolean;
  }>(`
    (() => {
      ${prepare}
      b.round = 1;
      ru.cfg.p.spd = 30;
      ru.cfg.reform = false;
      const { x, y } = ru.anchor;
      ru.cfg.cmd = { type: "move", tx: x + 100, ty: y };
      const ar = {
        shape: "burst",
        type: "burningEntanglement",
        active: true,
        r: 40,
        x: x + 15,
        y: y + 39,
      };
      b.areas = [ar];
      moveUnits(b, ru.army);
      return {
        progressed: ru.anchor.x > x && ru.anchor.y < y,
        beganInside: inArea(ar, x, y),
        endedInside: inArea(ar, ru.anchor.x, ru.anchor.y),
        crossed: Array.from({length: 201}, (_,i)=>inArea(ar, x+(ru.anchor.x-x)*i/200,y+(ru.anchor.y-y)*i/200)).some(Boolean),
      };
    })();
  `);
  expect(path.beganInside).toBe(false);
  expect(path.endedInside).toBe(false);
  expect(path.crossed).toBe(false);
  expect(path.progressed).toBe(true);
});

test("reference: both overhanging files aim down the enemy side only once the lines touch", async ({
  page,
}) => {
  const aims = await page.evaluate(`
    (() => {
      S.rules.baseTouch = true;
      S.rules.aoo = false;
      const run = (gap, file) => {
        const cfg = buildConfig();
        cfg.attackerIdx = 0;
        cfg.armies.forEach((a, i) => {
          a.units = a.units.slice(0, 1);
          Object.assign(a.units[0], {
            count: i ? 6 : 9,
            front: i ? 3 : 9,
            spacing: 5,
            rot: 0,
            beh: "advance",
            chg: false,
            envelop: true,
            ranged: null,
            mounted: false,
          });
        });
        const b = createBattle(cfg, 17, true);
        b.round = 1;
        for (const [i, u] of b.units.entries()) {
          u.anchor = { x: 100 + i * gap, y: 100 };
          u.facing = 0;
          for (const s of u.soldiers) Object.assign(s, effectiveSlotPos(b, s));
        }
        rebuildGrid(b);
        rebuildOcc(b);
        const s = b.units[0].soldiers[file];
        // Observe the actual chosen goal BEFORE collision/weapon-reach stopping; forward unchanged.
        const clamp = clampTargetOutOfHarm;
        let goal = null;
        try {
          clampTargetOutOfHarm = (...args) => {
            goal = clamp(...args);
            return goal;
          };
          soldierTurn(b, s);
        } finally {
          clampTargetOutOfHarm = clamp;
        }
        return goal;
      };
      return [run(35, 0), run(35, 8), run(5, 0), run(5, 8)];
    })();
  `);
  expect(aims).toEqual([
    { x: 100, y: 80 },
    { x: 100, y: 120 },
    { x: 115, y: 92 },
    { x: 115, y: 108 },
  ]);
});
