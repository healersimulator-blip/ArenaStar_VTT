import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { AppSurface } from "../src/app/e2eHook";
import type { MacroDocument, TokenDocument } from "../src/core/documents";
import type { Op } from "../src/core/ops";
import {
  applySidebarMap,
  entry,
  hostCall,
  manualFragment,
  playerCall,
  solidPng,
  surfaceCallArg,
  waitForSurface,
  wavSilence,
} from "./lib";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test.setTimeout(120_000);
test.use({ actionTimeout: 15_000 });

async function exchangeCodes(host: Page, player: Page, previousAnswer = ""): Promise<string> {
  const offer = player.locator("#offer-out");
  const answerOut = host.locator("#share-out");
  await expect.poll(() => offer.inputValue(), { timeout: 20_000 }).not.toBe("");
  await host.fill("#peer-code", await offer.inputValue());
  await host.click("#code-apply");
  // Reloads can leave the previous answer showing before the host generates a new one.
  await expect
    .poll(
      async () => {
        const answer = await answerOut.inputValue();
        return answer !== previousAnswer && answer !== "";
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const answer = await answerOut.inputValue();
  await player.fill("#answer-input", answer);
  await player.click("#answer-apply");
  await waitForSurface(player, "player");
  return answer;
}

async function startManualJoin(host: Page, player: Page): Promise<string> {
  await host.click("#share");
  const fragment = manualFragment(await host.locator("#invite-link").inputValue());
  await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
  return exchangeCodes(host, player);
}

test("map streams once, caches, and re-joins with no wire chunks on persistent browsers", async ({
  browser,
}, testInfo) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.setInputFiles("#map-input", {
      name: "map.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });
    await applySidebarMap(host);
    await expect.poll(() => hostCall<string | null>(host, "sceneImg")).not.toBeNull();
    const mapHash = await hostCall<string>(host, "sceneImg");
    const firstAnswer = await startManualJoin(host, player);
    await expect.poll(() => playerCall<string>(player, "sceneImg"), { timeout: 30_000 }).toBe(mapHash);
    await expect
      .poll(() => playerCall<number>(player, "assetChunks"), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect.poll(() => surfaceCallArg<boolean>(player, "player", "cacheHas", mapHash)).toBe(true);

    await player.reload();
    await exchangeCodes(host, player, firstAnswer);
    await expect.poll(() => playerCall<string>(player, "sceneImg"), { timeout: 30_000 }).toBe(mapHash);
    // D-082: WebKit's opaque file:// origin doesn't keep Cache Storage across reloads.
    await expect.poll(() => surfaceCallArg<boolean>(player, "player", "cacheHas", mapHash)).toBe(true);
    expect(await playerCall<number>(player, "assetChunks")).toBe(testInfo.project.name === "webkit" ? 1 : 0);
  } finally {
    await hostCtx.close();
    await playerCtx.close();
  }
});

interface MediaFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}
const hashOf = ({ buffer }: MediaFile) => createHash("sha256").update(buffer).digest("hex");
const chunkSize = 32 * 1024;

function drawnMedia(page: Page) {
  return page.evaluate(() => {
    interface Node {
      children: Node[];
      texture?: object;
      getChildByLabel(label: string): Node | null;
    }
    const globals = globalThis as unknown as {
      __canvasStage?: { root: Node; getFxLayer(): { count: number } };
      __playingAttachmentLoops?: () => number;
    };
    const stage = globals.__canvasStage;
    const textures =
      stage?.root.getChildByLabel("tokens")?.children.flatMap((token) => {
        const texture = token.getChildByLabel("tokenArtwork")?.texture;
        return texture ? [texture] : [];
      }) ?? [];
    return {
      portraits: textures.length,
      distinctTextures: new Set(textures).size,
      visuals: stage?.getFxLayer().count ?? 0,
      sounds: globals.__playingAttachmentLoops?.() ?? 0,
    };
  });
}

async function commit(host: Page, ops: Op[]): Promise<void> {
  await host.evaluate(async (encoded) => {
    const client = (globalThis as unknown as { __vttE2E: { app: AppSurface } }).__vttE2E.app.gm.client;
    await client.submitAndWait(JSON.parse(encoded) as Op[]);
  }, JSON.stringify(ops));
}

test("shared token art and attached FX bytes survive a fresh join without being resent", async ({
  browser,
}, testInfo) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage(),
      player = await playerCtx.newPage();
    await player.addInitScript(() => {
      // FX sounds aren't DOM children. Observe successful native playback without mocking it.
      const audio = new Set<HTMLAudioElement>();
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = async function (this: HTMLMediaElement) {
        await play.call(this);
        if (this instanceof HTMLAudioElement && this.loop && this.src.startsWith("blob:")) audio.add(this);
      };
      Object.assign(globalThis, {
        __playingAttachmentLoops: () => [...audio].filter((item) => !item.paused).length,
      });
    });
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.click("#gm-macros");
    await host.locator("[data-macro-fx-tab]").click();
    const wizard = host.locator("[data-fx-wizard]");
    await wizard.locator("[data-fx-share]").check();
    const portrait: MediaFile = {
      name: "portrait.png",
      mimeType: "image/png",
      buffer: solidPng(16, 16, [70, 100, 160]),
    };
    const aura: MediaFile = {
      name: "aura.png",
      mimeType: "image/png",
      buffer: solidPng(16, 16, [100, 70, 220]),
    };
    const sound: MediaFile = {
      name: "aura.wav",
      mimeType: "audio/wav",
      buffer: wavSilence(5),
    };
    const hidden: MediaFile = {
      name: "reserve.png",
      mimeType: "image/png",
      buffer: solidPng(16, 16, [180, 80, 90]),
    };
    const visibleMedia = [portrait, aura, sound];
    for (const file of [...visibleMedia, hidden]) {
      await wizard.locator('input[type="file"]').setInputFiles(file);
      await expect(wizard.getByRole("status").first()).toContainText(`Imported ${file.name}`);
    }
    await host.locator('[data-window="macros"] [data-window-close]').click();

    const sceneId = "scene-1",
      copies = 80;
    const tokens = Array.from({ length: copies + 1 }, (_, i): TokenDocument => ({
      _id: `portrait-${i}`,
      type: "token",
      name: "Guard",
      ownership: { default: 2 },
      flags: {},
      system: {},
      x: 180 + (i % 16) * 100,
      y: 260 + Math.floor(i / 16) * 100,
      width: 64,
      height: 64,
      hidden: i === copies,
      img: hashOf(i === copies ? hidden : portrait),
      rotation: 0,
      disposition: "neutral",
      vision: false,
      light: { radius: 0, color: "#fff", alpha: 0 },
    }));
    const ward: MacroDocument = {
      _id: "cache-ward",
      type: "macro",
      name: "Shared ward",
      ownership: { default: 2 },
      flags: {},
      system: {},
      kind: "sequence",
      command: "",
      sequence: {
        version: 1,
        audience: "scene",
        persistent: true,
        sections: [
          {
            id: "ward-art",
            kind: "image",
            assetId: hashOf(aura),
            at: { kind: "source" },
            follow: true,
            startMs: 0,
            durationMs: 1_000,
          },
          {
            id: "ward-audio",
            kind: "sound",
            assetId: hashOf(sound),
            at: { kind: "source" },
            radius: 1_000,
            startMs: 0,
            durationMs: 5_000,
          },
        ],
      },
    };
    const secret: MacroDocument = {
      ...ward,
      _id: "hidden-ward",
      name: "Hidden ward",
      ownership: { default: 0 },
      sequence: {
        version: 1,
        audience: "scene",
        persistent: true,
        sections: [
          {
            id: "secret-art",
            kind: "image",
            assetId: hashOf(hidden),
            at: { kind: "source" },
            follow: true,
            startMs: 0,
            durationMs: 1_000,
          },
        ],
      },
    };
    await commit(host, [
      ...tokens.map((data): Op => ({
        kind: "create",
        coll: "tokens",
        parent: { coll: "scenes", id: sceneId },
        data,
      })),
      { kind: "create", coll: "macros", data: ward },
      { kind: "create", coll: "macros", data: secret },
    ]);
    await host.evaluate(
      ({ sceneId, runs }) => {
        const client = (globalThis as unknown as { __vttE2E: { app: AppSurface } }).__vttE2E.app.gm.client;
        for (const [macro, source] of runs)
          if (macro && source) client.requestSequence(macro, sceneId, source);
      },
      {
        sceneId,
        runs: [
          [ward._id, "portrait-0"],
          [ward._id, "portrait-1"],
          [secret._id, `portrait-${copies}`],
        ],
      },
    );
    await expect.poll(async () => (await hostCall<unknown[]>(host, "fxInstances")).length).toBe(3);

    const firstAnswer = await startManualJoin(host, player);
    const expected = {
      portraits: copies,
      distinctTextures: 1,
      visuals: 2,
      sounds: 2,
    };
    await expect.poll(() => drawnMedia(player), { timeout: 30_000 }).toEqual(expected);
    const cached = (file: MediaFile) => surfaceCallArg<boolean>(player, "player", "cacheHas", hashOf(file));
    await expect.poll(async () => (await Promise.all(visibleMedia.map(cached))).every(Boolean)).toBe(true);
    expect(await cached(hidden)).toBe(false);
    const coldBytes = visibleMedia.reduce((sum, file) => sum + file.buffer.length, 0);
    const coldChunks = visibleMedia.reduce((sum, file) => sum + Math.ceil(file.buffer.length / chunkSize), 0);
    expect(await playerCall<number>(player, "assetBytes")).toBe(coldBytes);
    expect(await playerCall<number>(player, "assetChunks")).toBe(coldChunks);

    // Real reload: JS objects (including Pixi textures and the LRU) are gone. Only browser
    // storage survives. The host must re-project both persistent attachments before rendering.
    await player.reload();
    await exchangeCodes(host, player, firstAnswer);
    await expect.poll(() => drawnMedia(player), { timeout: 30_000 }).toEqual(expected);
    expect(await cached(hidden)).toBe(false);
    const coldFileOrigin = testInfo.project.name === "webkit"; // D-082
    const bytesBefore = coldFileOrigin ? coldBytes : 0;
    const chunksBefore = coldFileOrigin ? coldChunks : 0;
    expect(await playerCall<number>(player, "assetBytes")).toBe(bytesBefore);
    expect(await playerCall<number>(player, "assetChunks")).toBe(chunksBefore);

    // Replace one token's art with a formerly hidden hash. This is a live grant, not a
    // manifest-wide preload: only the new portrait transfers; both attachments stay put.
    await commit(host, [
      {
        kind: "update",
        ref: {
          coll: "tokens",
          id: "portrait-0",
          parent: { coll: "scenes", id: sceneId },
        },
        diff: { img: hashOf(hidden) },
      },
    ]);
    await expect.poll(() => drawnMedia(player)).toEqual({ ...expected, distinctTextures: 2 });
    expect(await playerCall<number>(player, "assetBytes")).toBe(bytesBefore + hidden.buffer.length);
    expect(await playerCall<number>(player, "assetChunks")).toBe(chunksBefore + 1);
    await expect.poll(() => cached(hidden)).toBe(true);

    // A manifest-only revocation leaves the token document (and the downloaded
    // file) intact but the app must stop using it. The ward's own art is unaffected.
    await host.getByRole("button", { name: "Close session panel" }).click();
    await host.click("#gm-macros");
    await host.locator("[data-macro-fx-tab]").click();
    const rights = wizard.locator("[data-fx-rights]");
    await rights.locator("summary").click();
    await rights.getByRole("combobox").selectOption(hashOf(hidden));
    await rights.locator("[data-fx-rights-share]").uncheck();
    await rights.locator("[data-fx-update-rights]").click();
    await expect(wizard.getByRole("status").first()).toContainText("Media permissions updated");
    await expect.poll(() => drawnMedia(player)).toEqual({ ...expected, portraits: copies - 1 });
    expect(await cached(hidden)).toBe(true); // sharing isn't a remote-erasure guarantee
    expect(await playerCall<number>(player, "assetChunks")).toBe(chunksBefore + 1);
  } finally {
    await hostCtx.close();
    await playerCtx.close();
  }
});
