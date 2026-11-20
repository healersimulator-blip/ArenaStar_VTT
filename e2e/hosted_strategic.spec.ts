import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  expect,
  test,
  type APIResponse,
  type Page,
  type Route,
} from "@playwright/test";
import {
  STRATEGIC_VIEW_TYPE,
  STRATEGIC_PATCH_TYPE,
  VIEW_PREFIX_BYTES,
  type Baseline,
  type ServerMessage,
} from "../src/core/strategicRoom/protocol";
import { decodeView } from "../src/core/strategicRoom/viewWire";
import {
  generatedScenario,
  type Scenario,
} from "../services/strategic-room/src/scenario";

const exec = promisify(execFile);
const script = resolve("services/strategic-room/dist/server/main.mjs");
const db = process.env.STRATEGIC_TEST_DATABASE_URL;
async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string")
    throw new Error("No local port.");
  return address.port;
}
const viewPath = "/api/strategic/view";
const viewRoute = /\/api\/strategic\/view(?:\?|$)/;

// The monitor and the test both inspect some responses. Chromium drops a response body once its
// request leaves the network log, so read each one once and decode it per caller's baseline.
const bodies = new WeakMap<object, Promise<Buffer>>();
function bodyOf(response: Pick<APIResponse, "body">) {
  let body = bodies.get(response);
  if (!body) {
    body = response.body();
    bodies.set(response, body);
  }
  return body;
}

async function captureView(
  response: Pick<APIResponse, "body" | "headers" | "url">,
  base?: Baseline,
) {
  const body = await bodyOf(response);
  const headers = response.headers();
  const type = headers["content-type"];
  const view = await decodeView(Uint8Array.from(body), type, base);
  const markerBytes =
    type === STRATEGIC_VIEW_TYPE || type === STRATEGIC_PATCH_TYPE
      ? body.readUInt32BE(4)
      : null;
  const tail = markerBytes
    ? body.subarray(VIEW_PREFIX_BYTES + body.readUInt32BE(0))
    : null;
  return {
    view,
    markerBytes,
    tail,
    size: body.byteLength,
    url: response.url(),
    headers,
  };
}
type Capture = Awaited<ReturnType<typeof captureView>>;

function monitor(page: Page) {
  const messages: ServerMessage[] = [];
  const views: Baseline[] = [];
  const waiters: Array<(capture: Capture) => void> = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      messages.push(JSON.parse(String(payload)) as ServerMessage);
    }),
  );
  // Read the body inside the route: a superseded fetch can abort after its headers arrive, and a
  // response event's body is then gone. Fulfilling forwards the original bytes unchanged.
  void page.route(viewRoute, async (route) => {
    let response: APIResponse | undefined;
    try {
      response = await route.fetch();
    } catch {
      await route.abort().catch(() => undefined);
      return;
    }
    if (response.ok()) {
      try {
        const capture = await captureView(response, views.at(-1));
        views.push(capture.view);
        waiters.shift()?.(capture);
      } catch (error) {
        console.error(
          "hosted view capture failed",
          String(error).split("\n")[0],
        );
      }
    }
    await route.fulfill({ response }).catch(() => undefined);
  });
  /** The next view this page fetches; arm it before the action that triggers the fetch. */
  const next = () => new Promise<Capture>((resolve) => waiters.push(resolve));
  return { messages, views, next };
}

async function fixture(scenario?: Scenario) {
  const room = `browser-${randomUUID()}`;
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATABASE_URL: db ?? "",
    STRATEGIC_ROOM: room,
    PORT: String(port),
    STRATEGIC_ORIGINS: origin,
  };
  await exec(process.execPath, [script, "migrate"], { env });
  let output: string;
  if (scenario) {
    const temp = await mkdtemp(join(tmpdir(), "hosted-strategic-"));
    try {
      const file = join(temp, "scenario.json");
      await writeFile(file, JSON.stringify(scenario));
      output = (await exec(process.execPath, [script, "import", file], { env }))
        .stdout;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } else {
    output = (
      await exec(process.execPath, [script, "demo", "2", "5", "mixed"], { env })
    ).stdout;
  }
  const { invites } = JSON.parse(output) as { invites: Record<string, string> };
  let processChild: ChildProcess | undefined;
  const start = async () => {
    processChild = spawn(process.execPath, [script, "serve"], {
      env,
      stdio: "ignore",
    });
    await expect
      .poll(
        async () => {
          try {
            return (
              await fetch(`${origin}/healthz`, {
                signal: AbortSignal.timeout(1000),
              })
            ).status;
          } catch {
            return 0;
          }
        },
        { timeout: 7000 },
      )
      .toBe(200);
  };
  const stop = async () => {
    if (
      !processChild ||
      processChild.exitCode !== null ||
      processChild.signalCode !== null
    )
      return;
    const done = once(processChild, "exit");
    processChild.kill("SIGKILL");
    await done;
  };
  const admit = async (page: Page, slot: string) => {
    const invite = invites[slot];
    if (!invite) throw new Error(`Missing invite for ${slot}`);
    await page.goto(origin);
    await page.getByLabel("One-time invite").fill(invite);
    await page.getByRole("button", { name: "Join room" }).click();
    await expect(
      page.locator('[data-turn="1"][data-phase="orders"]'),
    ).toBeVisible();
  };
  return { origin, start, stop, admit };
}

test("hosted room: nonblocking progress, private receipts, rejoin after crash, report scope and revocation", async ({
  browser,
}) => {
  test.skip(
    !db,
    "set STRATEGIC_TEST_DATABASE_URL and build the hosted service",
  );
  test.setTimeout(65_000);
  const { origin, start, stop, admit } = await fixture();
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext({ reducedMotion: "reduce" }),
    browser.newContext(),
  ]);
  let releaseApply = () => {};
  try {
    await start();
    const pages = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const [gm, blue, red] = pages;
    if (!gm || !blue || !red) throw new Error("Expected three clients");
    const observed = monitor(blue);
    const redObserved = monitor(red);
    await Promise.all([
      admit(gm, "gm"),
      admit(blue, "commander-1"),
      admit(red, "commander-2"),
    ]);
    await expect.poll(() => redObserved.views.length).toBeGreaterThan(0);
    expect((await fetch(`${origin}/api/strategic/view`)).status).toBe(401);
    expect(
      (await fetch(`${origin}/api/strategic/report?version=1`)).status,
    ).toBe(401);
    await blue.getByRole("button", { name: "Center unit" }).click();
    await blue.getByRole("button", { name: "Region detail" }).click();
    await expect
      .poll(async () =>
        Number(await blue.locator("[data-models]").getAttribute("data-models")),
      )
      .toBeGreaterThan(0);
    await blue.getByRole("button", { name: "Draft hold" }).click();
    // A separate company marches east into a stationary opposing rank. The order is legal
    // to submit; only the resolving worker knows its safe prefix. No enemy ID in the report.
    const marcher = observed.views
      .at(-1)
      ?.own.find((u) => u.id === "unit-1-2")?.at;
    if (!marcher) throw Error("Missing company");
    await blue.getByLabel("Assigned unit").selectOption("unit-1-2");
    await blue.getByLabel("March X").fill(String(marcher.x + 20));
    await blue.getByLabel("March Y").fill(String(marcher.y - 22.5));
    await blue.getByRole("button", { name: "Draft march" }).click();
    await blue.getByRole("button", { name: "Submit orders" }).click();
    await expect(blue.locator("[data-revision]")).toHaveText("1");
    expect(redObserved.messages.some((m) => m.kind === "receipt")).toBe(false);
    expect(
      redObserved.views.every(
        (v) =>
          v.orders.edits.length === 0 &&
          v.own.every((u) => u.id.startsWith("unit-2-")),
      ),
    ).toBe(true);
    await red.getByLabel("Assigned unit").selectOption("unit-2-3");
    await red.getByLabel("Visible enemy").selectOption("unit-1-3");
    await red.getByRole("button", { name: "Draft ranged attack" }).click();
    await red.getByRole("button", { name: "Submit orders" }).click();
    await expect(red.locator("[data-revision]")).toHaveText("1");

    // Kill the actual authority after its durable ACK, not the browser or DB.
    await stop();
    await expect(
      blue.getByRole("heading", { name: "Enter the battlefield" }),
    ).toBeVisible();
    await start();
    await expect(blue.locator("[data-revision]")).toHaveText("1");
    await expect(blue.getByText("Accepted: hold (hold)")).toBeVisible();
    await expect(red.locator("[data-revision]")).toHaveText("1");

    // Withhold one post-publication baseline to prove the previous battlefield stays usable.
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    // Withhold one post-publication baseline to prove the previous battlefield stays usable. Unroute
    // only this handler; the monitor's capture route must stay installed for the reload below.
    const withholdApply = async (route: Route) => {
      const response = await route.fetch();
      if (
        response.ok() &&
        (await captureView(response, observed.views.at(-1))).view.head
          .version === 1
      )
        await applyGate;
      await route.fulfill({ response }).catch(() => undefined);
    };
    await blue.route(viewRoute, withholdApply);
    const watch = (page: Page) =>
      page.evaluate(() => {
        const root = document.querySelector("[data-turn-progress]");
        if (!root) throw new Error("Progress status missing");
        const stages: string[] = [];
        const observer = new MutationObserver((records) => {
          for (const record of records)
            if (record.oldValue) stages.push(record.oldValue);
          stages.push(root.getAttribute("data-turn-progress") ?? "missing");
        });
        observer.observe(root, {
          attributes: true,
          attributeFilter: ["data-turn-progress"],
          attributeOldValue: true,
        });
        (window as Window & { testStages?: string[] }).testStages = stages;
      });
    await Promise.all([watch(gm), watch(blue)]);
    await gm.getByRole("button", { name: "Close and resolve" }).click();
    await expect(blue.locator('[data-turn-progress="applying"]')).toHaveText(
      "Applying results…",
    );
    expect(
      await blue
        .locator("[data-turn-progress] .spinner")
        .evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("none");
    await expect(blue.locator('[data-version="0"]')).toBeVisible();
    await expect(blue.getByRole("button", { name: "Zoom in" })).toBeEnabled();
    await blue.getByRole("button", { name: "Zoom in" }).click();
    await expect(
      blue.getByRole("button", { name: "Submit orders" }),
    ).toBeDisabled();
    const stages = (page: Page) =>
      page.evaluate(
        () => (window as Window & { testStages?: string[] }).testStages ?? [],
      );
    expect(await stages(gm)).toEqual(
      expect.arrayContaining(["closing", "resolving"]),
    );
    expect(await stages(blue)).toContain("resolving");
    releaseApply();
    await expect(
      blue.locator('[data-version="1"][data-phase="report"]'),
    ).toBeVisible();
    await expect(blue.locator('[data-turn-progress="idle"]')).toBeEmpty();
    await blue.unroute(viewRoute, withholdApply);

    await stop();
    await start();
    await expect(
      gm.locator('[data-phase="report"][data-version="1"]'),
    ).toBeVisible();
    const restoredCapture = observed.next();
    await blue.reload();
    await expect(
      blue.locator('[data-phase="report"][data-version="1"]'),
    ).toBeVisible();
    const restored = await restoredCapture;
    expect(restored.headers["content-type"]).toBe(STRATEGIC_VIEW_TYPE);
    expect(restored.markerBytes).toBeGreaterThan(0);
    expect(new URL(restored.url).searchParams.has("markersVersion")).toBe(
      false,
    );
    await blue.getByRole("button", { name: "View report" }).click();
    await expect(blue.locator("[data-report-unit]")).toHaveCount(5);
    await expect(blue.locator('[data-report-unit="unit-1-2"]')).toContainText(
      "March blocked",
    );
    await expect(blue.locator('[data-report-unit^="unit-2-"]')).toHaveCount(0);
    const openedCapture = observed.next();
    await gm.getByRole("button", { name: "Open next turn" }).click();
    await expect(
      blue.locator('[data-turn="2"][data-phase="orders"]'),
    ).toBeVisible();
    await expect(blue.locator("[data-revision]")).toHaveText("0");
    const opened = await openedCapture;
    expect(new URL(opened.url).searchParams.get("markersVersion")).toBe("1");
    expect(opened.markerBytes).toBe(0);
    expect(opened.size).toBeLessThan(2048);
    expect(opened.view.markers).toBe(restored.view.markers);
    expect(opened.view.orders).toEqual({ revision: 0, edits: [] });

    // GM roster: names, per-unit control, kick, invites and the media endpoint.
    await gm.getByRole("button", { name: /^Commanders \(/ }).click();
    const roster = gm.locator("[data-hosted-roster]");
    await expect(roster).toBeVisible();
    await expect(roster.locator("[data-roster-count]")).toContainText(
      "2 seats",
    );
    const redRow = roster.locator('[data-member="commander-2"]');
    await expect(redRow).toHaveAttribute("data-online", "true");
    // The roster is GM-only: a player's view never carries it.
    expect(redObserved.views.every((v) => v.members === undefined)).toBe(true);
    const row = roster.locator('[data-member="commander-1"]');
    await row.locator("[data-member-name]").fill("Blue vanguard");
    await row.locator("[data-member-name]").press("Enter");
    await expect(row.locator("[data-member-name]")).toHaveValue(
      "Blue vanguard",
    );
    // A checkbox waits for its controlled state; the roster is server-authoritative, so poll.
    await row.locator('[data-member-unit="unit-1-2"]').click();
    await expect
      .poll(async () =>
        roster.locator('[data-member-unit="unit-1-2"]').isChecked(),
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          await blue.getByLabel("Assigned unit").locator("option").count(),
      )
      .toBe(4);
    // Restore the grant so the rest of the run keeps both blue companies available.
    await row.locator('[data-member-unit="unit-1-2"]').click();
    await expect
      .poll(async () =>
        roster.locator('[data-member-unit="unit-1-2"]').isChecked(),
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          await blue.getByLabel("Assigned unit").locator("option").count(),
      )
      .toBe(5);
    // Kick ends the live session; the same browser resumes the seat (no invite needed).
    await redRow.locator("[data-member-kick]").click();
    await redRow.locator("[data-member-kick-confirm]").click();
    await expect
      .poll(
        () => redObserved.messages.filter((m) => m.kind === "welcome").length,
      )
      .toBeGreaterThan(1);
    // The room is already on turn 2 when the kick lands, so the seat resumes there.
    await expect(
      red.locator('[data-turn="2"][data-phase="orders"]'),
    ).toBeVisible();
    // A claimed seat cannot be re-invited: that would be a takeover.
    await redRow.locator("[data-member-invite-new]").click();
    await expect(redRow.locator("[data-member-invite]")).toHaveCount(0);

    const membersResponse = await fetch(`${origin}${viewPath}`, {
      headers: { Accept: STRATEGIC_VIEW_TYPE },
    });
    expect(membersResponse.status).toBe(401);
    const scene = await fetch(
      `${origin}/api/strategic/scene/${"0".repeat(64)}.webp`,
    );
    expect(scene.status).toBe(404);

    const bearer = [...observed.messages]
      .reverse()
      .find((m) => m.kind === "welcome")?.bearer;
    if (!bearer) throw new Error("No active bearer captured");
    await gm.getByText("Membership", { exact: true }).click();
    await gm.getByLabel("Commander slot").fill("commander-1");
    gm.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await gm.getByRole("button", { name: "Revoke commander" }).click();
    await expect(
      blue.getByRole("status").filter({ hasText: /^Not admitted/ }),
    ).toBeVisible();
    await expect(blue.locator("[data-report-unit]")).toHaveCount(0);
    await expect(blue.getByRole("region", { name: "Battlefield" })).toHaveCount(
      0,
    );
    expect(
      (
        await fetch(`${origin}${viewPath}?markersVersion=1`, {
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept: STRATEGIC_VIEW_TYPE,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/strategic/report?version=1`, {
          headers: { Authorization: `Bearer ${bearer}` },
        })
      ).status,
    ).toBe(401);
    await expect(
      red.locator('[data-turn="2"][data-phase="orders"]'),
    ).toBeVisible();
  } finally {
    releaseApply();
    try {
      await Promise.all(contexts.map((c) => c.close()));
    } finally {
      await stop();
    }
  }
});

/**
 * Frame pacing while the battlefield is actually driven. A pass under `STRATEGIC_FRAME_PROFILE=reference`
 * gates the §4 ≤33 ms p95; the shared sandbox records the same samples without claiming a reference
 * laptop. Intervals over 250 ms mean a hidden/occluded tab, not a slow frame, and are dropped.
 */
const FRAME_BUDGET_MS = 33;

async function startFrameRecorder(page: Page) {
  await page.evaluate(() => {
    const target = window as Window & { hostedFrames?: number[] };
    const intervals: number[] = [];
    target.hostedFrames = intervals;
    let previous: number | null = null;
    let stopped = false;
    (window as Window & { hostedFramesStop?: () => void }).hostedFramesStop =
      () => {
        stopped = true;
      };
    // Main-thread stalls over 50 ms, with the work that caused them where Chromium says.
    const long: Array<{ start: number; duration: number; name: string }> = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.duration > 50)
          long.push({
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            name: (entry as PerformanceEntry & { name: string }).name,
          });
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Not every Chromium build exposes longtask; frames are still recorded.
    }
    (window as Window & { hostedLongTasks?: typeof long }).hostedLongTasks =
      long;
    const stop = target as Window & { hostedFramesStop?: () => void };
    const previousStop = stop.hostedFramesStop;
    stop.hostedFramesStop = () => {
      previousStop?.();
      observer.disconnect();
    };
    const sample = (now: number): void => {
      if (previous !== null) {
        const interval = now - previous;
        if (interval <= 250) intervals.push(interval);
      }
      previous = now;
      if (!stopped) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function stopFrameRecorder(page: Page) {
  return page.evaluate(() => {
    const target = window as Window & {
      hostedFrames?: number[];
      hostedFramesStop?: () => void;
    };
    target.hostedFramesStop?.();
    return {
      frames: target.hostedFrames ?? [],
      longTasks:
        (target as Window & { hostedLongTasks?: unknown[] }).hostedLongTasks ??
        [],
    };
  });
}

/** Drag, wheel-zoom and keyboard-pan the real map; every step schedules the renderer's own frame. */
async function driveBattlefield(page: Page, steps: number) {
  const map = page.getByRole("application", { name: /^Battlefield/ });
  const box = await map.boundingBox();
  if (!box) throw new Error("Battlefield has no layout box");
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await map.focus();
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + (i % 2 ? 18 : -18), cy + 9, { steps: 3 });
    await page.mouse.up();
    await page.mouse.wheel(0, i % 2 ? -100 : 100);
    await page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight");
  }
}

const framePercentile = (samples: readonly number[], fraction: number) =>
  [...samples].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(samples.length * fraction) - 1)
  ] ?? 0;

/** A single browser sample from the applying badge to the updated UI and two frame callbacks. */
async function sampleApply(page: Page) {
  await page.evaluate(() => {
    const phase = document.querySelector("[data-version]");
    const progress = document.querySelector("[data-turn-progress]");
    if (!phase || !progress) throw new Error("Hosted apply indicators missing");
    let started: number | null = null;
    const sample = new Promise<number>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (progress.getAttribute("data-turn-progress") === "applying")
          started ??= performance.now();
        if (phase.getAttribute("data-version") !== "1") return;
        observer.disconnect();
        const start = started;
        if (start === null) {
          reject(new Error("Version applied without an applying indicator"));
          return;
        }
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(performance.now() - start)),
        );
      });
      observer.observe(phase, {
        attributes: true,
        attributeFilter: ["data-version"],
      });
      observer.observe(progress, {
        attributes: true,
        attributeFilter: ["data-turn-progress"],
      });
    });
    (
      window as Window & { hostedApplySample?: Promise<number> }
    ).hostedApplySample = sample;
  });
}

test("hosted room: Chromium round-trips a 50k-model compact view, sharing only faction markers", async ({
  browser,
}, testInfo) => {
  test.skip(
    !db,
    "set STRATEGIC_TEST_DATABASE_URL and build the hosted service",
  );
  test.setTimeout(65_000);
  const scenario = generatedScenario(500, 10, "mixed");
  const hidden = scenario.commanders.at(-1)?.units.at(-1);
  if (!hidden) throw new Error("Hidden fixture unit missing");
  scenario.bounds.maxY += 150;
  hidden.anchor.y = scenario.bounds.maxY - 25;
  hidden.name = "Hidden sentry";
  const { origin, start, stop, admit } = await fixture(scenario);
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  try {
    await start();
    const [gm, blue, ally] = await Promise.all(
      contexts.map((c) => c.newPage()),
    );
    if (!gm || !blue || !ally) throw new Error("Expected three clients");
    const observed = monitor(blue);
    const allyObserved = monitor(ally);
    const gmCapture = monitor(gm).next();
    const blueCapture = observed.next();
    const allyCapture = allyObserved.next();
    await Promise.all([
      admit(gm, "gm"),
      admit(blue, "commander-1"),
      admit(ally, "commander-3"),
    ]);
    const [gmStart, blueStart, allyStart] = await Promise.all([
      gmCapture,
      blueCapture,
      allyCapture,
    ]);
    if (!gmStart || !blueStart || !allyStart)
      throw new Error("Missing baseline capture");
    expect(blueStart.headers["content-type"]).toBe(STRATEGIC_VIEW_TYPE);
    expect(blueStart.headers["content-encoding"]).toBeUndefined();
    expect(blueStart.headers["cache-control"]).toContain("no-store");
    expect(blueStart.markerBytes).toBeGreaterThan(0);
    expect(blueStart.view.markers.length).toBeGreaterThan(2500);
    expect(blueStart.tail).toEqual(allyStart.tail);
    expect(gmStart.view.markers.some((m) => m.id === hidden.id)).toBe(true);
    expect(blueStart.view.markers.some((m) => m.id === hidden.id)).toBe(false);
    expect(blueStart.view.own.every((u) => u.id.startsWith("unit-1-"))).toBe(
      true,
    );
    expect(allyStart.view.own.every((u) => u.id.startsWith("unit-3-"))).toBe(
      true,
    );
    expect(blueStart.view.own).toHaveLength(10);
    expect(allyStart.view.own).toHaveLength(10);

    const bearer = observed.messages.find((m) => m.kind === "welcome")?.bearer;
    if (!bearer) throw new Error("Missing capture of live browser bearer");
    const raw = await fetch(`${origin}${viewPath}`, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
      },
    });
    expect(raw.status).toBe(200);
    expect(await raw.json()).toEqual(blueStart.view);

    await blue.bringToFront();
    await startFrameRecorder(blue);
    await driveBattlefield(blue, 12);
    // Keep the recorder running through a second without input: a full marker redraw per pan step
    // is the cost under test, not pointer-event latency.
    await blue.waitForTimeout(600);
    const panZoom = await stopFrameRecorder(blue);
    const panZoomFrames = panZoom.frames;

    await blue.getByRole("button", { name: "Draft hold" }).click();
    await blue.getByRole("button", { name: "Submit orders" }).click();
    await expect(blue.locator("[data-revision]")).toHaveText("1");
    await startFrameRecorder(blue);
    await sampleApply(blue);
    const resultCaptures = [observed.next(), allyObserved.next()];
    await gm.getByRole("button", { name: "Close and resolve" }).click();
    await Promise.all(
      [blue, ally].map(
        (page) =>
          expect(
            page.locator('[data-version="1"][data-phase="report"]'),
          ).toBeVisible({ timeout: 20000 }), // 50k functional wait, not a latency assertion
      ),
    );
    const [result, allyResult] = await Promise.all(resultCaptures);
    if (!result || !allyResult) throw new Error("Missing result capture");
    expect(result.headers["content-type"]).toBe(STRATEGIC_PATCH_TYPE);
    expect(new URL(result.url).searchParams.get("markersVersion")).toBe("0");
    expect(result.markerBytes).toBeGreaterThan(0);
    expect(result.size).toBe(Number(result.headers["content-length"]));
    expect(result.size).toBeLessThan(128 * 1024);
    expect(result.view.orders.edits.map((edit) => edit.unitId)).toEqual([
      "unit-1-1",
    ]);
    expect(allyResult.view.orders).toEqual({ revision: 0, edits: [] });
    expect(result.tail).toEqual(allyResult.tail);
    expect(result.view.markers.some((m) => m.id === hidden.id)).toBe(false);
    const applyMs = await blue.evaluate(
      () =>
        (window as Window & { hostedApplySample?: Promise<number> })
          .hostedApplySample,
    );
    expect(typeof applyMs).toBe("number");
    const applyRecord = await stopFrameRecorder(blue);
    const applyFrames = applyRecord.frames;

    // Independent complete representation, without giving the server any previous-version hint.
    const full = await fetch(`${origin}${viewPath}`, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: STRATEGIC_VIEW_TYPE,
      },
    });
    expect(full.headers.get("content-type")).toBe(STRATEGIC_VIEW_TYPE);
    expect(
      await decodeView(
        new Uint8Array(await full.arrayBuffer()),
        STRATEGIC_VIEW_TYPE,
      ),
    ).toEqual(result.view);

    // Same marker count and camera work as the pre-turn window, but now on the version-1 baseline:
    // a difference isolates applying the publication from drawing 5,000 markers per frame.
    await startFrameRecorder(blue);
    await driveBattlefield(blue, 12);
    await blue.waitForTimeout(600);
    const settled = await stopFrameRecorder(blue);
    const settledFrames = settled.frames;

    const metrics = {
      fixture: "500x10 mixed",
      chromeApplySampleMs: applyMs,
      resultBodyBytes: result.size,
      settledFrameP95: framePercentile(settledFrames, 0.95),
      settledFrameP99: framePercentile(settledFrames, 0.99),
      settledFrames: settledFrames.length,
      panZoomFrameP95: framePercentile(panZoomFrames, 0.95),
      panZoomFrameP99: framePercentile(panZoomFrames, 0.99),
      panZoomFrames: panZoomFrames.length,
      applyFrameP95: framePercentile(applyFrames, 0.95),
      applyFrameP99: framePercentile(applyFrames, 0.99),
      applyFrameMax: framePercentile(applyFrames, 1),
      applyFrameOver50Ms: applyFrames.filter((v) => v > 50).length,
      applyFrames: applyFrames.length,
      panZoomLongTasks: panZoom.longTasks.length,
      applyLongTasks: applyRecord.longTasks,
      frameBudgetMs: FRAME_BUDGET_MS,
      qualification:
        process.env.STRATEGIC_FRAME_PROFILE === "reference"
          ? "reference-profile"
          : "diagnostic-non-qualifying",
    };
    // The budget is a reference-laptop gate. This sandbox records the numbers either way.
    if (process.env.STRATEGIC_FRAME_PROFILE === "reference") {
      expect(metrics.panZoomFrames).toBeGreaterThan(60);
      expect(metrics.panZoomFrameP95).toBeLessThanOrEqual(FRAME_BUDGET_MS);
      expect(metrics.applyFrameP95).toBeLessThanOrEqual(FRAME_BUDGET_MS);
    }
    await testInfo.attach("compact-view-sample", {
      body: JSON.stringify(metrics),
      contentType: "application/json",
    });
    if (process.env.STRATEGIC_METRICS === "1")
      console.log(JSON.stringify(metrics));
  } finally {
    try {
      await Promise.all(contexts.map((c) => c.close()));
    } finally {
      await stop();
    }
  }
});
