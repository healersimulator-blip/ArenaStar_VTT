import { expect, test, type Page } from "@playwright/test";
import { entry, hostCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * D-257 (gaps G-43/G-27) — the wall/door/window lifecycle, driven through the rail and the
 * canvas, proving the *engine* answers:
 *
 *   • a wall blocks sight; Alt-click deletes it (sight returns);
 *   • a door is placed **closed** and blocks sight; a click on it opens it and sight returns;
 *     a second click closes it again; a **locked** door ignores the click;
 *   • a window lets sight through while still blocking movement (asserted on the document's
 *     axes here, on `moveSegments` in `tests/canvas/wallKinds.test.ts`).
 *
 * Sight is measured with the app's own vision computer over the live scene (`wallSightProbe`),
 * not by inspecting the document — a document that says "blocks" is not evidence that the
 * polygon changed.
 */

interface WallRead {
  id: string;
  name: string;
  kind: "wall" | "door" | "window";
  c: [number, number, number, number];
  door: number;
  sight: number;
  move: number;
  sound: number;
  light: number;
}

interface Probe {
  wallSegments: number;
  points: number;
  sees: boolean;
}

const bootHost = async (page: Page): Promise<void> => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#status").filter({ hasText: "seq" }).waitFor();
  await expect.poll(() => hostCall<unknown>(page, "camera")).not.toBeNull();
};

const walls = (page: Page): Promise<WallRead[]> => hostCall<WallRead[]>(page, "walls");

const probe = (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) =>
  surfaceCallArg<Probe>(page, "app", "wallSightProbe", { from, to, radius: 500 });

const screenOf = async (page: Page, p: { x: number; y: number }) => {
  const at = await surfaceCallArg<{ x: number; y: number } | null>(page, "app", "screenOf", p);
  if (!at) throw new Error("screenOf returned null");
  return at;
};

const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  const a = await screenOf(page, from);
  const b = await screenOf(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
};

const clickWorld = async (page: Page, p: { x: number; y: number }, modifiers: ("Alt" | "Shift")[] = []) => {
  const at = await screenOf(page, p);
  // the raw mouse API has no `modifiers` option — hold the key around the click instead
  for (const key of modifiers) await page.keyboard.down(key);
  try {
    await page.mouse.click(at.x, at.y);
  } finally {
    for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  }
};

/** The midpoint of a placed wall — where the overlay draws its state dot, and the click target. */
const midOf = (w: WallRead) => ({ x: (w.c[0] + w.c[2]) / 2, y: (w.c[1] + w.c[3]) / 2 });
const only = async (page: Page): Promise<WallRead> => {
  const list = await walls(page);
  if (list.length !== 1) throw new Error(`expected exactly one wall, got ${list.length}`);
  return list[0] as WallRead;
};

/**
 * Find a vertical lane with a clear line of sight on the starter map: a viewer and a target
 * 200 world units apart whose straight line no existing wall crosses. The lanes are grid-aligned
 * so a `corner`-snapped placement drag lands exactly on the numbers used here.
 */
interface Lane {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

async function openLane(page: Page): Promise<Lane> {
  for (let x = 200; x <= 1800; x += 200) {
    for (let y = 300; y <= 1100; y += 200) {
      const from = { x, y };
      const to = { x, y: y + 200 };
      if ((await probe(page, from, to)).sees) return { from, to };
    }
  }
  throw new Error("no open sight lane found on the starter map");
}

test.describe("walls, doors and windows (D-257)", () => {
  test("kinds map to honest documents; doors toggle; windows pass sight; Alt-click deletes", async ({
    page,
  }) => {
    await bootHost(page);
    // The GM Info layer is where the overlay (and the click targets) live.
    await page.locator('[data-canvas-layer="gm"]').click();
    await page.locator('[data-canvas-tool="wall"]').click();
    const base = (await walls(page)).length;

    /** Place one segment across `lane`'s line of sight and return the document it wrote. */
    const place = async (lane: Lane, kind: "wall" | "door" | "window", state?: "closed" | "open" | "locked") => {
      await page.locator(`[data-canvas-wall-kind="${kind}"]`).click();
      if (state) await page.locator(`[data-canvas-door-state="${state}"]`).click();
      const mid = { x: lane.from.x, y: lane.from.y + 100 };
      await drag(page, { x: mid.x - 100, y: mid.y }, { x: mid.x + 100, y: mid.y });
      await expect.poll(async () => (await walls(page)).length).toBe(base + 1);
      return only(page);
    };
    /** Alt-click the segment's dot; the scene returns to its baseline. */
    const remove = async (w: WallRead) => {
      await clickWorld(page, midOf(w), ["Alt"]);
      await expect.poll(async () => (await walls(page)).length).toBe(base);
    };

    // ── 1. a wall blocks sight, and Alt-click removes it ────────────────────────────────
    const lane1 = await openLane(page);
    const placedWall = await place(lane1, "wall");
    expect(placedWall).toMatchObject({
      kind: "wall",
      name: "Wall",
      door: 0,
      sight: 0,
      move: 0,
      sound: 0,
      light: 0,
    });
    expect((await probe(page, lane1.from, lane1.to)).sees).toBe(false);
    await remove(placedWall);
    expect((await probe(page, lane1.from, lane1.to)).sees).toBe(true);

    // ── 2. a window: sight passes, movement does not ────────────────────────────────────
    const lane2 = await openLane(page);
    const placedWindow = await place(lane2, "window");
    expect(placedWindow).toMatchObject({
      kind: "window",
      name: "Window",
      door: 0,
      sight: 2,
      light: 2,
      move: 0,
      sound: 2,
    });
    expect((await probe(page, lane2.from, lane2.to)).sees).toBe(true);
    await remove(placedWindow);

    // ── 3. a door: placed closed, clicked open, clicked closed again ────────────────────
    const lane3 = await openLane(page);
    const door = await place(lane3, "door", "closed");
    expect(door).toMatchObject({
      name: "Door",
      door: 0, // G-43: placed *closed*, not open
      sight: 1,
      move: 1,
      sound: 1,
      light: 1,
    });
    expect((await probe(page, lane3.from, lane3.to)).sees).toBe(false);

    const doorState = async () => (await walls(page)).find((w) => w.kind === "door")?.door;
    await clickWorld(page, midOf(door));
    await expect.poll(doorState).toBe(1);
    expect((await probe(page, lane3.from, lane3.to)).sees).toBe(true);

    await clickWorld(page, midOf(door));
    await expect.poll(doorState).toBe(0);
    expect((await probe(page, lane3.from, lane3.to)).sees).toBe(false);

    await remove(door);

    // ── 4. a locked door ignores the click ─────────────────────────────────────────────
    const lane4 = await openLane(page);
    const locked = await place(lane4, "door", "locked");
    expect(locked.door).toBe(2);
    expect((await probe(page, lane4.from, lane4.to)).sees).toBe(false);
    await clickWorld(page, midOf(locked));
    await page.waitForTimeout(250);
    expect((await walls(page)).find((w) => w.kind === "door")?.door).toBe(2);
    expect((await probe(page, lane4.from, lane4.to)).sees).toBe(false);
    await remove(locked);
  });
});
