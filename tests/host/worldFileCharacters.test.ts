/**
 * Does a saved world keep its characters whole? A world file must carry every link a
 * character depends on: token → actor, actor → items / effects / spellbook / held charge,
 * token → image (+ derived thumb/mid), combat → combatants → tokens, and the compendium the
 * actor was imported from. This exercises the real pieces (shipped `pf1e-core` package, the
 * spellbook edit ops, the asset pipeline, `exportWorldZip` → `importWorldZip` as a COPY into a
 * fresh OPFS root — the "other machine" case — → `bootHostApp`) and compares what the sheet
 * derives before and after, not just the raw rows.
 */
import "fake-indexeddb/auto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { bootHostApp, DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import { importEntryOp } from "../../src/core/compendium";
import type {
  ActorDocument,
  CombatDocument,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import { exportWorldZip, importWorldZip } from "../../src/host/worldFile";
import { getAsset, openVttDb } from "../../src/storage/idb";
import { MemDirHandle, OpfsAssetStore } from "../../src/storage/opfs";
import { pf1eSheetView } from "../../src/ui/sheets/pf1eSheetModel";
import { pf1eSpellbookEdit, pf1eSpellbookView } from "../../src/ui/sheets/pf1eSpellbook";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec, settle } from "../app/fakes";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The shipped content pack, zipped exactly as `pnpm build:systems` ships it. */
function coreZip(): Uint8Array {
  const dir = join(repoRoot, "systems/pf1e-core");
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(readFileSync(join(dir, "manifest.json"), "utf8")),
  };
  for (const name of readdirSync(join(dir, "packs"))) {
    files[`packs/${name}`] = strToU8(readFileSync(join(dir, "packs", name), "utf8"));
  }
  return zipSync(files);
}

const GM = { id: "gm", role: "GM" as const };

/** A 5th-level wizard with everything a sheet can hold. */
const wizard = (): ActorDocument => ({
  _id: "actor-wiz",
  type: "actor",
  name: "Ezren",
  ownership: { default: 0, "player-1": 3 },
  flags: { core: { img: "" } },
  system: {
    pf1e: {
      size: "Medium",
      hitDice: 5,
      classes: [{ name: "Wizard", level: 5 }],
      abilities: { str: 10, dex: 14, con: 12, int: 18, wis: 13, cha: 8 },
      baseAttack: 2,
      saves: { fort: 1, ref: 1, will: 4 },
      hp: 23,
      hpMax: 31,
      feats: ["Scribe Scroll", "Spell Focus (evocation)", "Toughness", "Dodge"],
      armorClass: { dodge: 1 },
      attacks: [{ name: "quarterstaff", damageDice: "1d6" }],
      spells: {
        keyAbility: "int",
        mode: "prepared",
        casterLevel: 5,
        slotsPerDay: { 0: 4, 1: 4, 2: 3, 3: 2 },
        slotsUsed: { 2: 1 },
        prepared: [
          { name: "Magic Missile", level: 1, components: "V, S" },
          { name: "Magic Missile", level: 1, components: "V, S" },
          { name: "Shield", level: 1, components: "V, S" },
          { name: "Scorching Ray", level: 2, components: "V, S", expended: true },
          { name: "Fireball", level: 3, components: "V, S, M" },
        ],
      },
      heldCharge: { name: "Shocking Grasp", level: 1, damageFormula: "5d6", energyType: "electricity" },
    },
    biography: "Apprenticed in Absalom.",
  },
  items: [
    {
      _id: "item-staff",
      type: "item",
      name: "Quarterstaff",
      ownership: { default: 0 },
      flags: { pf1e: { slot: "weapon", quantity: 1 } },
      system: { pf1e: { weapon: { damageDice: "1d6" }, itemHp: 10, itemHardness: 5 } },
      effects: [],
    },
    {
      _id: "item-cloak",
      type: "item",
      name: "Cloak of Resistance +1",
      ownership: { default: 0 },
      flags: { pf1e: { slot: "shoulders", quantity: 1 } },
      system: { pf1e: { price: 1000 } },
      // Item-embedded effects are inert for the derivation by design (D-112: only actor /
      // combatant effects are read) — they still have to survive the file as data.
      effects: [
        {
          _id: "eff-cloak",
          type: "effect",
          name: "Cloak of Resistance +1",
          ownership: { default: 0 },
          flags: { pf1e: { mods: [{ key: "saves", type: "resistance", value: 1 }] } },
          system: {},
          changes: [],
          disabled: false,
        },
      ],
    },
  ],
  effects: [
    {
      _id: "eff-mage-armor",
      type: "effect",
      name: "Mage Armor",
      ownership: { default: 0 },
      flags: {
        core: { duration: { rounds: 50 } },
        pf1e: { mods: [{ key: "ac", type: "armor", value: 4 }] },
      },
      system: {},
      changes: [],
      disabled: false,
    },
  ],
});

const tokenOf = (id: string, actorId: string, img: string, x: number): TokenDocument => ({
  _id: id,
  type: "token",
  name: id,
  ownership: { default: 0 },
  flags: {},
  system: {},
  x,
  y: 200,
  rotation: 0,
  width: 100,
  height: 100,
  img,
  actorId,
  hidden: false,
  disposition: "friendly",
  vision: true,
  light: { radius: 0, color: "#fff", alpha: 0.5 },
});

describe("world file keeps characters whole (tokens ↔ actors ↔ sheets ↔ images ↔ combat)", () => {
  test("export → import as a copy into a fresh storage root → the same sheets, links and images", async () => {
    const db = await openVttDb();
    const rootA = new MemDirHandle();
    const a = await bootHostApp({ db, root: rootA, codec: new FakeCodec(), simRunner: new InlineSimRunner() });
    const client = a.gm.client;
    const rejected: string[] = [];
    a.gm.bus.on("rejected", (m) => rejected.push(`${m.reason}: ${m.detail}`));

    // ── the content pack the bestiary actor comes from ──
    const core = await a.packages.importZip(coreZip());
    expect(core.ok).toBe(true);
    const bestiary = (await a.packages.compendia()).find((c) => c.pack.name.toLowerCase().includes("bestiary"))?.pack;
    if (!bestiary) throw new Error("pf1e-core bestiary pack not found");
    const cavalry = bestiary.entries.find((e) => e.id === "heavy-cavalry");
    if (!cavalry) throw new Error("heavy-cavalry entry missing");

    // ── actors: one imported from the compendium, one hand-authored caster ──
    client.submit([importEntryOp(bestiary, cavalry, "actor-cav")]);
    client.submit([{ kind: "create", coll: "actors", data: wizard() }]);
    await settle();

    // a spellbook edit through the real sheet flow (spend a 1st-level slot)
    const wizBefore = client.store.get("actors", "actor-wiz") as ActorDocument;
    const spend = pf1eSpellbookEdit(wizBefore, pf1eSheetView(wizBefore).derived, GM, { kind: "spend", level: 1 });
    expect(spend.error).toBeNull();
    client.submit(spend.ops);
    await settle();

    // ── images: a real pipeline import (full + derived thumb/mid, each its own asset) ──
    const portrait = await a.pipeline.importImage(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6]), "ezren.png", "image/png");
    expect(portrait.entry.thumb?.assetId).toBeTruthy();
    expect(portrait.entry.mid?.assetId).toBeTruthy();

    // ── tokens linked to both actors; the caster's token wears the imported image ──
    client.submit([
      { kind: "create", coll: "tokens", parent: { coll: "scenes", id: DEFAULT_SCENE_ID }, data: tokenOf("tok-wiz", "actor-wiz", portrait.hash, 100) },
      { kind: "create", coll: "tokens", parent: { coll: "scenes", id: DEFAULT_SCENE_ID }, data: tokenOf("tok-cav", "actor-cav", "", 400) },
    ]);
    // ── a running encounter that points at both tokens/actors ──
    client.submit([
      {
        kind: "create",
        coll: "combats",
        data: {
          _id: "combat-1",
          type: "combat",
          name: "Bridge",
          ownership: { default: 3 },
          flags: { core: { sceneId: DEFAULT_SCENE_ID }, pf1e: { phase: "rounds", secondsPerRound: 6 } },
          system: {},
          round: 3,
          turn: 1,
          combatants: [
            { _id: "c-wiz", type: "combatant", name: "Ezren", ownership: { default: 3 }, flags: {}, system: {}, tokenId: "tok-wiz", actorId: "actor-wiz", initiative: 17, hidden: false, defeated: false },
            { _id: "c-cav", type: "combatant", name: "Heavy Cavalry", ownership: { default: 3 }, flags: {}, system: {}, tokenId: "tok-cav", actorId: "actor-cav", initiative: 12, hidden: false, defeated: false },
          ],
        } as CombatDocument,
      },
    ]);
    await settle();
    expect(rejected).toEqual([]);

    // ── what the sheets say BEFORE the save ──
    const snapshot = (app: HostApp) => {
      const store = app.gm.client.store;
      const wiz = store.get("actors", "actor-wiz") as ActorDocument;
      const cav = store.get("actors", "actor-cav") as ActorDocument;
      const scene = store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument;
      const combat = store.get("combats", "combat-1") as CombatDocument;
      const wizView = pf1eSheetView(wiz);
      const cavView = pf1eSheetView(cav);
      return {
        wiz,
        cav,
        tokens: scene.tokens.map((t) => ({ id: t._id, actorId: t.actorId, img: t.img })),
        combat,
        wizDerived: {
          ac: wizView.derived.ac, // Mage Armor + deflection applied on read
          saves: wizView.derived.saves, // cloak's resistance bonus applied on read
          hp: wizView.derived.hp,
          abilities: wizView.derived.abilities,
          attacks: wizView.derived.attacks.map((x) => [x.name, x.attackBonus, x.damageDice]),
          effects: wizView.derived.effects.map((e) => e.name),
        },
        cavDerived: { ac: cavView.derived.ac, saves: cavView.derived.saves, baseAttack: cavView.derived.baseAttack },
        spellbook: pf1eSpellbookView(wiz, wizView.derived),
      };
    };
    const before = snapshot(a);
    // sanity: the fixture really has the state we want to see survive
    expect(before.wiz.items.map((i) => i._id)).toEqual(["item-staff", "item-cloak"]);
    expect(before.wiz.items[1]?.effects[0]?._id).toBe("eff-cloak");
    expect(before.wizDerived.effects).toEqual(["Mage Armor"]);
    expect(before.wizDerived.hp).toBe(23);
    expect(before.wizDerived.saves).toEqual({ fort: 2, ref: 3, will: 5 }); // authored + ability mods
    expect(before.wizDerived.ac.flatFooted).toBe(14); // 10 + Mage Armor 4, Dex and dodge denied
    expect(before.spellbook.prepared.map((p) => [p.name, p.slotLevel, p.expended])).toEqual([
      ["Magic Missile", 1, false],
      ["Magic Missile", 1, false],
      ["Shield", 1, false],
      ["Scorching Ray", 2, true],
      ["Fireball", 3, false],
    ]);
    const spent = (level: number) => before.spellbook.ledger.rows.find((r) => r.level === level)?.spent;
    expect(spent(1)).toBe(1); // the spend above landed
    expect(spent(2)).toBe(1); // authored slotsUsed
    expect((before.wiz.system.pf1e as { heldCharge?: { name: string } }).heldCharge?.name).toBe("Shocking Grasp");
    expect(before.tokens).toEqual([
      { id: "tok-wiz", actorId: "actor-wiz", img: portrait.hash },
      { id: "tok-cav", actorId: "actor-cav", img: "" },
    ]);
    expect(before.combat.combatants.map((c) => c.tokenId)).toEqual(["tok-wiz", "tok-cav"]);

    // ── save ──
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId: a.worldId, root: rootA, persister: a.persister })).arrayBuffer(),
    );
    await a.close();

    // ── load on "another machine": copy under a new id, blobs into a fresh OPFS root ──
    const rootB = new MemDirHandle();
    const copied = await importWorldZip({ db, file: archive, root: rootB, mode: "copy", name: "Ezren's table" });
    expect(copied.packages).toEqual(["pf1e-core"]);
    expect(copied.worldId).not.toBe(a.worldId); // a genuinely new world, not the old rows re-read
    const b = await bootHostApp({ db, root: rootB, codec: new FakeCodec(), simRunner: new InlineSimRunner(), worldId: copied.worldId });
    try {
      const after = snapshot(b);

      // documents: byte-for-byte the same actors (items, effects, spellbook, held charge), tokens, combat
      expect(after.wiz).toEqual(before.wiz);
      expect(after.cav).toEqual(before.cav);
      expect(after.tokens).toEqual(before.tokens);
      expect(after.combat).toEqual(before.combat);

      // sheets: the derived numbers (effects and items applied on read) come out identical
      expect(after.wizDerived).toEqual(before.wizDerived);
      expect(after.cavDerived).toEqual(before.cavDerived);
      expect(after.spellbook).toEqual(before.spellbook);

      // links resolve: every token's actor and every combatant's token/actor exist in the copy
      const store = b.gm.client.store;
      for (const t of after.tokens) expect(store.get("actors", t.actorId as never), t.id).toBeDefined();
      for (const c of after.combat.combatants) {
        expect((store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument).tokens.some((t) => t._id === c.tokenId)).toBe(true);
        expect(store.get("actors", c.actorId as never)).toBeDefined();
      }

      // images: the token's image, its thumb and its mid are all served from the copied world
      const full = await b.gm.fetcher.request(portrait.hash, "scene");
      expect([...full]).toEqual([137, 80, 78, 71, 1, 2, 3, 4, 5, 6]);
      const record = await getAsset(db, copied.worldId, portrait.hash);
      expect(record?.thumb?.assetId).toBe(portrait.entry.thumb?.assetId);
      expect(record?.mid?.assetId).toBe(portrait.entry.mid?.assetId);
      const opfsB = await OpfsAssetStore.open(copied.worldId, rootB);
      for (const derivedHash of [record?.thumb?.assetId, record?.mid?.assetId]) {
        expect(derivedHash).toBeTruthy();
        expect(await opfsB?.get(derivedHash as never)).toBeDefined();
      }

      // the compendium the cavalry came from is there too (its source entry can be re-imported)
      const packs = await b.packages.compendia();
      expect(packs.some((c) => c.packageId === "pf1e-core" && c.pack.entries.some((e) => e.id === "heavy-cavalry"))).toBe(true);
      await b.persister.flush();
    } finally {
      await b.close();
    }
  }, 30_000);
});
